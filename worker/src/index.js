// Server-side AI trading worker.
//
// Runs independently of any browser tab: a Cloudflare Cron Trigger fires
// this Worker's `scheduled` handler every 5 minutes, which fetches real
// prices, runs the same momentum + adaptive-weight decision engine as the
// browser app, executes trades, and persists everything to Workers KV.
// The `fetch` handler exposes a read-only JSON status endpoint the static
// site polls to display progress -- there is no write endpoint, since the
// whole point is that nothing here waits on a person.

const CRYPTO_ID_MAP = {
  BTC: 'bitcoin', ETH: 'ethereum', XRP: 'ripple', ADA: 'cardano',
  SOL: 'solana', DOGE: 'dogecoin', DOT: 'polkadot', LTC: 'litecoin',
  BCH: 'bitcoin-cash', LINK: 'chainlink', MATIC: 'matic-network', POL: 'matic-network',
  AVAX: 'avalanche-2', TRX: 'tron', BNB: 'binancecoin', USDT: 'tether',
  USDC: 'usd-coin', SHIB: 'shiba-inu', ATOM: 'cosmos', XLM: 'stellar',
  ETC: 'ethereum-classic',
};

const CURATED_STOCK_POOL = [
  { symbol: 'AAPL', name: 'Apple' }, { symbol: 'MSFT', name: 'Microsoft' }, { symbol: 'GOOGL', name: 'Alphabet' },
  { symbol: 'AMZN', name: 'Amazon' }, { symbol: 'NVDA', name: 'NVIDIA' }, { symbol: 'META', name: 'Meta' },
  { symbol: 'TSLA', name: 'Tesla' }, { symbol: 'JPM', name: 'JPMorgan Chase' }, { symbol: 'V', name: 'Visa' },
  { symbol: 'JNJ', name: 'Johnson & Johnson' }, { symbol: 'WMT', name: 'Walmart' }, { symbol: 'PG', name: 'Procter & Gamble' },
  { symbol: 'MA', name: 'Mastercard' }, { symbol: 'HD', name: 'Home Depot' }, { symbol: 'DIS', name: 'Disney' },
  { symbol: 'KO', name: 'Coca-Cola' }, { symbol: 'PEP', name: 'PepsiCo' }, { symbol: 'NFLX', name: 'Netflix' },
  { symbol: 'ADBE', name: 'Adobe' }, { symbol: 'CRM', name: 'Salesforce' }, { symbol: 'INTC', name: 'Intel' },
  { symbol: 'AMD', name: 'AMD' }, { symbol: 'CSCO', name: 'Cisco' }, { symbol: 'ORCL', name: 'Oracle' },
  { symbol: 'IBM', name: 'IBM' }, { symbol: 'PYPL', name: 'PayPal' }, { symbol: 'NKE', name: 'Nike' },
  { symbol: 'MCD', name: "McDonald's" }, { symbol: 'COST', name: 'Costco' }, { symbol: 'ABT', name: 'Abbott' },
  { symbol: 'AVGO', name: 'Broadcom' }, { symbol: 'TXN', name: 'Texas Instruments' }, { symbol: 'QCOM', name: 'Qualcomm' },
  { symbol: 'HON', name: 'Honeywell' }, { symbol: 'UNH', name: 'UnitedHealth' }, { symbol: 'XOM', name: 'ExxonMobil' },
  { symbol: 'CVX', name: 'Chevron' }, { symbol: 'BA', name: 'Boeing' }, { symbol: 'GE', name: 'GE Aerospace' },
  { symbol: 'UBER', name: 'Uber' }, { symbol: 'SBUX', name: 'Starbucks' },
];

const STATE_KEY = 'ai_state_v1';
const CRYPTO_CATALOG_KEY = 'crypto_catalog_v1';
const CRYPTO_CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const INITIAL_CASH = 1000000;
const AI_DISCOVERY_EVERY_N_TICKS = 3;
// Twelve Data's free plan caps out at 800 requests/day. At a 15-minute tick
// (96 ticks/day) fetching every stock symbol every tick would burn through
// that budget by mid-morning, so stocks are only refreshed on every 3rd tick.
const STOCK_FETCH_EVERY_N_TICKS = 3;
const AI_DISCOVERY_TOP_CRYPTO = 150;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function defaultState() {
  return {
    cash: INITIAL_CASH,
    initialCash: INITIAL_CASH,
    holdings: [], // {symbol, name, assetClass, quantity, avgCost, currentPrice}
    transactions: [], // {date, type, symbol, quantity, price, amount, realizedPL}
    equityHistory: [{ t: Date.now(), value: INITIAL_CASH }],
    steps: 0,
    trades: 0,
    closedTrades: 0,
    wins: 0,
    weights: {},
    history: {}, // symbol -> [{t, price}]
    log: [], // {t, note}
    lastRunAt: null,
    watchlist: [
      { symbol: 'BTC', name: 'ビットコイン', assetClass: 'crypto', pinned: false, addedAtStep: 0 },
      { symbol: 'ETH', name: 'イーサリアム', assetClass: 'crypto', pinned: false, addedAtStep: 0 },
    ],
    cryptoWatchCap: 8,
    stockWatchCap: 4,
  };
}

async function loadState(env) {
  const raw = await env.AI_KV.get(STATE_KEY);
  if (!raw) return defaultState();
  try {
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed };
  } catch (e) {
    return defaultState();
  }
}

async function saveState(env, state) {
  await env.AI_KV.put(STATE_KEY, JSON.stringify(state));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- crypto pricing (CoinGecko) ----------

async function loadCryptoCatalog(env) {
  const raw = await env.AI_KV.get(CRYPTO_CATALOG_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// CoinGecko returns 403 for requests without a descriptive User-Agent --
// Workers' fetch() doesn't set one by default the way a browser does.
// A free Demo API key (x-cg-demo-api-key) gets its own rate-limit bucket
// instead of sharing Cloudflare's heavily-throttled anonymous IP pool --
// set COINGECKO_API_KEY via `wrangler secret put` to enable it.
function coingeckoHeaders(apiKey) {
  const headers = { 'User-Agent': 'tousi-ai-worker/1.0 (personal investment simulator)' };
  if (apiKey) headers['x-cg-demo-api-key'] = apiKey;
  return headers;
}

async function refreshCryptoCatalogIfStale(env) {
  const cached = await loadCryptoCatalog(env);
  if (cached && Date.now() - cached.at < CRYPTO_CATALOG_MAX_AGE_MS) return cached.map;

  const headers = coingeckoHeaders(env.COINGECKO_API_KEY);
  const map = {};
  for (let page = 1; page <= 8; page++) {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=jpy&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`;
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) break;
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      rows.forEach(r => {
        const sym = (r.symbol || '').toUpperCase();
        if (sym && !map[sym]) map[sym] = r.id;
      });
    } catch (e) { break; }
    if (page < 8) await sleep(1500);
  }
  if (Object.keys(map).length > 0) {
    await env.AI_KV.put(CRYPTO_CATALOG_KEY, JSON.stringify({ map, at: Date.now() }));
    return map;
  }
  return cached ? cached.map : {};
}

function resolveCryptoId(symbol, catalog) {
  const upper = symbol.toUpperCase();
  if (catalog && catalog[upper]) return catalog[upper];
  return CRYPTO_ID_MAP[upper] || null;
}

async function fetchCryptoPrices(symbols, catalog, apiKey) {
  const idPairs = [...new Set(symbols)]
    .map(symbol => ({ symbol, id: resolveCryptoId(symbol, catalog) }))
    .filter(x => x.id);
  if (idPairs.length === 0) return {};
  const ids = [...new Set(idPairs.map(x => x.id))].join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=jpy`;
  try {
    const res = await fetch(url, { headers: coingeckoHeaders(apiKey) });
    if (!res.ok) { console.log('crypto price fetch failed', res.status, await res.text()); return {}; }
    const data = await res.json();
    const out = {};
    idPairs.forEach(({ symbol, id }) => {
      const price = data[id]?.jpy;
      if (typeof price === 'number') out[symbol] = price;
    });
    return out;
  } catch (e) {
    console.log('crypto price fetch threw', String(e));
    return {};
  }
}

// ---------- stock pricing (Twelve Data, USD->JPY converted) ----------

function isJapaneseStockSymbol(symbol) {
  return /^\d{4}$/.test(symbol.trim());
}

async function getFxRateToJpy(currency, key, fxCache) {
  if (currency === 'JPY') return 1;
  if (fxCache[currency]) return fxCache[currency];
  try {
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(currency)}/JPY&apikey=${encodeURIComponent(key)}`;
    const res = await fetch(url);
    const data = await res.json();
    const rate = parseFloat(data.close ?? data.price);
    if (data.status === 'error' || !isFinite(rate) || rate <= 0) return null;
    fxCache[currency] = rate;
    return rate;
  } catch (e) {
    return null;
  }
}

async function fetchStockPrices(symbols, key, fxCache) {
  const out = {};
  if (!key) return out;
  const uniqueSymbols = [...new Set(symbols)].filter(s => !isJapaneseStockSymbol(s));
  for (let i = 0; i < uniqueSymbols.length; i++) {
    const symbol = uniqueSymbols[i];
    try {
      const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`;
      const res = await fetch(url);
      const data = await res.json();
      const rawPrice = parseFloat(data.close ?? data.price);
      if (data.status !== 'error' && isFinite(rawPrice) && rawPrice > 0) {
        const currency = data.currency || 'USD';
        const fxRate = await getFxRateToJpy(currency, key, fxCache);
        if (fxRate != null) out[symbol] = rawPrice * fxRate;
        else console.log('fx rate fetch failed for', currency);
      } else {
        console.log('stock price fetch failed', symbol, JSON.stringify(data));
      }
    } catch (e) { console.log('stock price fetch threw', symbol, String(e)); }
    if (i < uniqueSymbols.length - 1) await sleep(8000);
  }
  return out;
}

// ---------- trading ----------

function pushHistory(state, symbol, price) {
  if (!state.history[symbol]) state.history[symbol] = [];
  const arr = state.history[symbol];
  arr.push({ t: Date.now(), price });
  if (arr.length > 30) arr.shift();
}

function avgLast(arr, n) {
  if (arr.length < n) return null;
  const slice = arr.slice(-n);
  return slice.reduce((s, v) => s + v.price, 0) / slice.length;
}

function pushLog(state, note) {
  state.log.push({ t: Date.now(), note });
  if (state.log.length > 80) state.log.shift();
}

function doBuy(state, { symbol, name, assetClass, quantity, price }) {
  const amount = quantity * price;
  if (amount > state.cash + 1e-6) return false;
  state.cash -= amount;
  let h = state.holdings.find(x => x.symbol === symbol);
  if (h) {
    const totalCost = h.avgCost * h.quantity + amount;
    h.quantity += quantity;
    h.avgCost = totalCost / h.quantity;
    h.currentPrice = price;
  } else {
    state.holdings.push({ symbol, name, assetClass, quantity, avgCost: price, currentPrice: price });
  }
  state.transactions.push({ date: todayStr(), t: Date.now(), type: 'buy', symbol, quantity, price, amount, realizedPL: null });
  if (state.transactions.length > 200) state.transactions.shift();
  return true;
}

function doSell(state, { symbol, quantity, price }) {
  const h = state.holdings.find(x => x.symbol === symbol);
  if (!h || quantity > h.quantity + 1e-9) return { ok: false };
  const amount = quantity * price;
  const realized = (price - h.avgCost) * quantity;
  state.cash += amount;
  h.quantity -= quantity;
  h.currentPrice = price;
  if (h.quantity <= 1e-9) state.holdings = state.holdings.filter(x => x.symbol !== symbol);
  state.transactions.push({ date: todayStr(), t: Date.now(), type: 'sell', symbol, quantity, price, amount, realizedPL: realized });
  if (state.transactions.length > 200) state.transactions.shift();
  return { ok: true, realized };
}

function totalAssets(state) {
  return state.cash + state.holdings.reduce((s, h) => s + h.quantity * h.currentPrice, 0);
}

function autoDiscover(state, catalog) {
  if (state.steps % AI_DISCOVERY_EVERY_N_TICKS !== 0) return;
  const heldSymbols = new Set(state.holdings.map(h => h.symbol));

  const prunable = state.watchlist.filter(w =>
    !w.pinned && !heldSymbols.has(w.symbol) &&
    (state.steps - w.addedAtStep) >= AI_DISCOVERY_EVERY_N_TICKS &&
    (state.weights[w.symbol] || 0) <= -0.3
  );
  if (prunable.length > 0) {
    const gone = prunable[Math.floor(Math.random() * prunable.length)];
    state.watchlist = state.watchlist.filter(w => w.symbol !== gone.symbol);
    pushLog(state, `ウォッチリストから除外（信頼度が低い）: ${gone.symbol}`);
  }

  const excluded = new Set([...heldSymbols, ...state.watchlist.map(w => w.symbol)]);

  const cryptoCount = state.watchlist.filter(w => w.assetClass === 'crypto' && !heldSymbols.has(w.symbol)).length;
  if (cryptoCount < state.cryptoWatchCap && catalog) {
    const pool = Object.keys(catalog).slice(0, AI_DISCOVERY_TOP_CRYPTO).filter(s => !excluded.has(s));
    if (pool.length > 0) {
      const symbol = pool[Math.floor(Math.random() * pool.length)];
      state.watchlist.push({ symbol, name: symbol, assetClass: 'crypto', pinned: false, addedAtStep: state.steps });
      excluded.add(symbol);
      pushLog(state, `ウォッチリストに追加（自動探索・暗号資産）: ${symbol}`);
    }
  }

  const stockCount = state.watchlist.filter(w => w.assetClass === 'stock' && !heldSymbols.has(w.symbol)).length;
  if (stockCount < state.stockWatchCap) {
    const pool = CURATED_STOCK_POOL.filter(p => !excluded.has(p.symbol));
    if (pool.length > 0) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      state.watchlist.push({ symbol: pick.symbol, name: pick.name, assetClass: 'stock', pinned: false, addedAtStep: state.steps });
      pushLog(state, `ウォッチリストに追加（自動探索・株式）: ${pick.symbol}`);
    }
  }
}

async function runAiTick(env) {
  const state = await loadState(env);
  const twelveDataKey = env.TWELVE_DATA_KEY || '';

  state.steps++;
  state.lastRunAt = Date.now();

  const catalog = await refreshCryptoCatalogIfStale(env);
  autoDiscover(state, catalog);

  const bySymbol = {};
  state.watchlist.forEach(w => { bySymbol[w.symbol] = w; });
  state.holdings.forEach(h => { bySymbol[h.symbol] = h; });
  const universe = Object.values(bySymbol);

  const cryptoSymbols = universe.filter(x => x.assetClass === 'crypto').map(x => x.symbol);
  const stockSymbols = universe.filter(x => x.assetClass === 'stock').map(x => x.symbol);

  const cryptoPrices = cryptoSymbols.length ? await fetchCryptoPrices(cryptoSymbols, catalog, env.COINGECKO_API_KEY) : {};
  const fxCache = {};
  const shouldFetchStocks = state.steps % STOCK_FETCH_EVERY_N_TICKS === 0;
  const stockPrices = (stockSymbols.length && shouldFetchStocks) ? await fetchStockPrices(stockSymbols, twelveDataKey, fxCache) : {};
  const allPrices = { ...cryptoPrices, ...stockPrices };

  Object.entries(allPrices).forEach(([symbol, price]) => {
    pushHistory(state, symbol, price);
    const h = state.holdings.find(x => x.symbol === symbol);
    if (h) h.currentPrice = price;
  });

  if (Object.keys(allPrices).length === 0) {
    pushLog(state, '価格を取得できませんでした（APIキー未設定、またはネットワークエラー）');
    await saveState(env, state);
    return state;
  }

  const lr = 0.5;
  universe.forEach(u => {
    const symbol = u.symbol;
    const hist = state.history[symbol];
    if (!hist || hist.length < 4) return;
    const currentPrice = hist[hist.length - 1].price;
    const h = state.holdings.find(x => x.symbol === symbol);

    const shortMA = avgLast(hist, 2);
    const longMA = avgLast(hist, 4);
    if (shortMA == null || longMA == null || longMA <= 0) return;
    const momentum = (shortMA - longMA) / longMA;

    const prevDecision = state.weights['_last_' + symbol];
    if (prevDecision) {
      const realizedReturn = (currentPrice - prevDecision.priceAtDecision) / prevDecision.priceAtDecision;
      const agreement = Math.sign(prevDecision.momentum) * Math.sign(realizedReturn);
      const w = state.weights[symbol] || 0;
      state.weights[symbol] = Math.max(-3, Math.min(3, w + lr * agreement * Math.abs(realizedReturn) * 30));
    }

    const weight = state.weights[symbol] || 0;
    const score = momentum * (1 + weight);

    let action = 'hold';
    if (score > 0.006) action = 'buy';
    else if (score < -0.006 && h && h.quantity > 0) action = 'sell';

    if (action === 'buy') {
      const budget = Math.min(state.cash * 0.15, state.cash);
      const qty = u.assetClass === 'crypto' ? (budget > 0 ? +(budget / currentPrice).toFixed(6) : 0) : Math.floor(budget / currentPrice);
      if (qty > 0) {
        const isNew = !h;
        if (doBuy(state, { symbol, name: u.name, assetClass: u.assetClass, quantity: qty, price: currentPrice })) {
          state.trades++;
          pushLog(state, `${isNew ? '新規購入' : '買い'}: ${symbol} ${qty} @ ¥${Math.round(currentPrice).toLocaleString('ja-JP')}（モメンタム${(momentum * 100).toFixed(1)}% / 信頼度${weight.toFixed(2)}）`);
        }
      }
    } else if (action === 'sell' && h) {
      const won = currentPrice > h.avgCost;
      const result = doSell(state, { symbol, quantity: h.quantity, price: currentPrice });
      if (result.ok) {
        state.trades++;
        state.closedTrades++;
        if (won) state.wins++;
        pushLog(state, `売り: ${symbol}（${won ? '含み益で決済' : '含み損で決済'} / 信頼度${weight.toFixed(2)}）`);
      }
    }

    state.weights['_last_' + symbol] = { momentum, priceAtDecision: currentPrice };
  });

  state.equityHistory.push({ t: Date.now(), value: totalAssets(state) });
  if (state.equityHistory.length > 500) state.equityHistory.shift();

  await saveState(env, state);
  return state;
}

// ---------- daily P&L report (Discord) ----------

// Stores the total-assets snapshot taken at the last report, so each report's
// "today" figure is the change since the previous one rather than since start.
const DAILY_REPORT_KEY = 'daily_report_v1';
const DAILY_REPORT_CRON = '0 12 * * *'; // 21:00 JST
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function jstDateStr(ms = Date.now()) {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function yen(n) {
  return `¥${Math.round(n).toLocaleString('ja-JP')}`;
}

function signedYen(n) {
  const r = Math.round(n);
  return `${r > 0 ? '+' : r < 0 ? '-' : '±'}${yen(Math.abs(r))}`;
}

function pct(n) {
  return `${n > 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;
}

function buildDailyReport(state, prev) {
  const now = Date.now();
  const total = totalAssets(state);
  const baseValue = prev ? prev.value : state.initialCash;
  const sinceAt = prev ? prev.at : 0;
  const dayChange = total - baseValue;
  const cumChange = total - state.initialCash;

  const periodTx = state.transactions.filter(tx => tx.t && tx.t > sinceAt);
  const buys = periodTx.filter(tx => tx.type === 'buy').length;
  const sells = periodTx.filter(tx => tx.type === 'sell');
  const realized = sells.reduce((s, tx) => s + (tx.realizedPL || 0), 0);

  const holdingLines = state.holdings
    .map(h => {
      const value = h.quantity * h.currentPrice;
      const unrealized = (h.currentPrice - h.avgCost) * h.quantity;
      return { line: `${h.symbol}  ${yen(value)}（含み ${signedYen(unrealized)}）`, value };
    })
    .sort((a, b) => b.value - a.value)
    .map(x => x.line);
  let holdingsText = holdingLines.length ? holdingLines.join('\n') : '（保有なし）';
  if (holdingsText.length > 1000) holdingsText = holdingsText.slice(0, 990) + '\n…';

  const winRate = state.closedTrades > 0 ? `${Math.round((state.wins / state.closedTrades) * 100)}%` : '—';
  const color = dayChange > 0 ? 0x2e9e5b : dayChange < 0 ? 0xd64545 : 0x888888;

  return {
    total,
    embed: {
      title: `📊 AI運用 日次収支レポート（${jstDateStr(now)}）`,
      color,
      fields: [
        { name: '総資産', value: yen(total), inline: true },
        { name: '本日の損益', value: `${signedYen(dayChange)}（${pct(baseValue > 0 ? dayChange / baseValue : 0)}）`, inline: true },
        { name: '累計損益', value: `${signedYen(cumChange)}（${pct(cumChange / state.initialCash)}）`, inline: true },
        { name: '本日の取引', value: `買い ${buys}件 / 売り ${sells.length}件\n確定損益 ${signedYen(realized)}`, inline: true },
        { name: '現金', value: yen(state.cash), inline: true },
        { name: '通算勝率', value: `${winRate}（決済${state.closedTrades}件）`, inline: true },
        { name: '保有銘柄', value: holdingsText },
      ],
      footer: { text: prev ? `前回レポート（${jstDateStr(prev.at)}）からの変化` : '初回レポート：運用開始からの変化' },
      timestamp: new Date(now).toISOString(),
    },
  };
}

// Sends at most one report per JST day, so a late or duplicated trigger
// (GitHub Actions + a revived Cloudflare cron) can't spam the channel.
// `dryRun` returns the payload without sending or recording anything.
async function sendDailyReport(env, { dryRun = false } = {}) {
  const today = jstDateStr();
  let prev = null;
  try { prev = JSON.parse(await env.AI_KV.get(DAILY_REPORT_KEY) || 'null'); } catch (e) { prev = null; }
  if (!dryRun && prev && prev.date === today) return { ok: true, skipped: 'already sent today' };

  const state = await loadState(env);
  const { total, embed } = buildDailyReport(state, prev);
  if (dryRun) return { ok: true, dryRun: true, embed };

  if (!env.DISCORD_WEBHOOK_URL) return { ok: false, error: 'DISCORD_WEBHOOK_URL is not set' };
  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '投資AIレポート', embeds: [embed] }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.log('discord webhook failed', res.status, body);
    return { ok: false, error: `discord ${res.status}` };
  }
  await env.AI_KV.put(DAILY_REPORT_KEY, JSON.stringify({ date: today, value: total, at: Date.now() }));
  return { ok: true, sent: today };
}

// ---------- HTTP status endpoint ----------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    if (url.pathname === '/api/state') {
      const state = await loadState(env);
      // Lets the status page pull price charts straight from CoinGecko.
      const catalog = (await loadCryptoCatalog(env))?.map || null;
      const cryptoIds = {};
      state.holdings.filter(h => h.assetClass === 'crypto').forEach(h => {
        const id = resolveCryptoId(h.symbol, catalog);
        if (id) cryptoIds[h.symbol] = id;
      });
      return jsonResponse({
        cryptoIds,
        cash: state.cash,
        initialCash: state.initialCash,
        totalAssets: totalAssets(state),
        holdings: state.holdings,
        transactions: state.transactions.slice(-30).reverse(),
        equityHistory: state.equityHistory,
        steps: state.steps,
        trades: state.trades,
        closedTrades: state.closedTrades,
        wins: state.wins,
        weights: Object.fromEntries(Object.entries(state.weights).filter(([k]) => !k.startsWith('_last_'))),
        watchlist: state.watchlist,
        log: state.log.slice(-40).reverse(),
        lastRunAt: state.lastRunAt,
        hasStockKey: !!env.TWELVE_DATA_KEY,
      });
    }

    if (url.pathname === '/api/run-now') {
      // manual trigger for testing; safe to call anytime, just runs one tick early
      const state = await runAiTick(env);
      return jsonResponse({ ok: true, steps: state.steps });
    }

    if (url.pathname === '/api/daily-report') {
      // ?dry=1 previews the report without posting to Discord
      const result = await sendDailyReport(env, { dryRun: url.searchParams.get('dry') === '1' });
      return jsonResponse(result, result.ok ? 200 : 500);
    }

    return new Response('tousi-ai-worker: see /api/state', { headers: CORS_HEADERS });
  },

  async scheduled(event, env, ctx) {
    if (event.cron === DAILY_REPORT_CRON) ctx.waitUntil(sendDailyReport(env));
    else ctx.waitUntil(runAiTick(env));
  },
};
