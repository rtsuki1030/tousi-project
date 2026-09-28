// Server-side AI trading worker.
//
// Runs independently of any browser tab: GitHub Actions calls /api/run-now
// every 15 minutes (Cloudflare's own cron is kept as a backup trigger). Each
// tick fetches real prices, folds them into hourly bars, lets several
// strategies vote (worker/src/strategies.js), learns which strategies have
// been right, trades on the weighted vote, and persists everything to KV.
// Strategy settings come from the weekly backtest (backtest/run.mjs), which
// commits them to the repo; the Worker pulls that file from GitHub.

import {
  BAR_MS, MAX_BARS, MIN_BARS, FEE_RATES, STRATEGY_INFO, DEFAULT_CONFIG,
  strategyVotes, strategyWeights, ensembleScore, updateScores, decide, sameParams,
} from './strategies.js';

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

function defaultStrategyState() {
  return { config: DEFAULT_CONFIG, scores: {}, signals: {}, configCheckedAt: null };
}

function defaultState() {
  return {
    engineVersion: 2,
    cash: INITIAL_CASH,
    initialCash: INITIAL_CASH,
    holdings: [], // {symbol, name, assetClass, quantity, avgCost, currentPrice}
    transactions: [], // {date, t, type, symbol, quantity, price, amount, fee, realizedPL}
    equityHistory: [{ t: Date.now(), value: INITIAL_CASH }],
    steps: 0,
    trades: 0,
    closedTrades: 0,
    wins: 0,
    bars: {}, // symbol -> {hour, closes[]}: hourly closes, last one still forming
    strategy: defaultStrategyState(),
    symbolScores: {}, // symbol -> {score, n}: how well the ensemble has read it lately, over n bars
    seedTried: {}, // symbol -> step of the last history download attempt
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
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return defaultState(); }
  const state = { ...defaultState(), ...parsed };
  state.strategy = { ...defaultStrategyState(), ...parsed.strategy };
  if (parsed.engineVersion !== 2) {
    // v1 kept 30 raw ticks per symbol and one momentum rule; the holdings,
    // cash and trade record carry over, the old learning state does not.
    delete state.history;
    delete state.weights;
    state.engineVersion = 2;
    pushLog(state, '売買エンジンを更新しました（複数戦略＋学習）。保有銘柄と資金はそのまま引き継ぎます。');
  }
  return state;
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

// ---------- hourly bars ----------

// The price APIs return ~10 significant digits; 7 is plenty and keeps the
// stored state small.
function roundPrice(p) {
  return Number(p.toPrecision(7));
}

// Records the latest price into the symbol's forming hourly bar. When the
// hour has rolled over, returns the closes of the bars completed so far
// (the moment the strategies get to vote), otherwise null.
function recordPrice(state, symbol, assetClass, price) {
  const hour = Math.floor(Date.now() / BAR_MS);
  const p = roundPrice(price);
  const b = state.bars[symbol];
  if (!b) { state.bars[symbol] = { hour, closes: [p] }; return null; }
  if (hour === b.hour) { b.closes[b.closes.length - 1] = p; return null; }
  // An unchanged stock quote after the hour rolls over means the market is closed.
  if (assetClass === 'stock' && p === b.closes[b.closes.length - 1]) return null;
  const completed = b.closes.slice();
  b.closes.push(p);
  b.hour = hour;
  if (b.closes.length > MAX_BARS) b.closes.splice(0, b.closes.length - MAX_BARS);
  return completed;
}

function hourlyBarsFromPoints(points) {
  const byHour = new Map();
  (points || []).forEach(([t, p]) => { if (p > 0) byHour.set(Math.floor(t / BAR_MS), p); });
  const hours = [...byHour.keys()].sort((a, b) => a - b);
  if (hours.length === 0) return null;
  const closes = [];
  let last = byHour.get(hours[0]);
  for (let h = hours[0]; h <= hours[hours.length - 1]; h++) {
    if (byHour.has(h)) last = byHour.get(h);
    closes.push(roundPrice(last));
  }
  return { hour: hours[hours.length - 1], closes: closes.slice(-MAX_BARS) };
}

async function seedCryptoBars(id, apiKey) {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=jpy&days=10`;
    const res = await fetch(url, { headers: coingeckoHeaders(apiKey) });
    if (!res.ok) { console.log('crypto history fetch failed', id, res.status); return null; }
    return hourlyBarsFromPoints((await res.json()).prices);
  } catch (e) {
    console.log('crypto history fetch threw', id, String(e));
    return null;
  }
}

async function seedStockBars(symbol, key, fxCache) {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1h&outputsize=${MAX_BARS}&apikey=${encodeURIComponent(key)}`;
    const data = await (await fetch(url)).json();
    if (data.status === 'error' || !Array.isArray(data.values)) { console.log('stock history fetch failed', symbol, JSON.stringify(data).slice(0, 200)); return null; }
    const fx = await getFxRateToJpy(data.meta?.currency || 'USD', key, fxCache);
    if (fx == null) return null;
    const closes = data.values.map(v => parseFloat(v.close)).filter(p => isFinite(p) && p > 0).reverse().map(p => roundPrice(p * fx));
    return closes.length ? { hour: Math.floor(Date.now() / BAR_MS), closes } : null;
  } catch (e) {
    console.log('stock history fetch threw', symbol, String(e));
    return null;
  }
}

// A symbol the strategies can't read yet (new to the watchlist, or right
// after the v2 upgrade) gets its recent hourly history downloaded instead of
// waiting days to collect it. Capped per tick to stay inside free API limits.
const CRYPTO_SEEDS_PER_TICK = 3;
const SEED_RETRY_TICKS = 4;

async function seedMissingBars(state, universe, catalog, env, fetchStocks, fxCache) {
  const needs = u => !(state.bars[u.symbol]?.closes.length > MIN_BARS) &&
    state.steps - (state.seedTried[u.symbol] ?? -Infinity) >= SEED_RETRY_TICKS;

  const cryptoTodo = universe.filter(u => u.assetClass === 'crypto' && needs(u)).slice(0, CRYPTO_SEEDS_PER_TICK);
  for (const u of cryptoTodo) {
    state.seedTried[u.symbol] = state.steps;
    const id = resolveCryptoId(u.symbol, catalog);
    const bars = id ? await seedCryptoBars(id, env.COINGECKO_API_KEY) : null;
    if (bars) state.bars[u.symbol] = bars;
  }

  if (!fetchStocks || !env.TWELVE_DATA_KEY) return;
  const stock = universe.find(u => u.assetClass === 'stock' && !isJapaneseStockSymbol(u.symbol) && needs(u));
  if (!stock) return;
  state.seedTried[stock.symbol] = state.steps;
  const bars = await seedStockBars(stock.symbol, env.TWELVE_DATA_KEY, fxCache);
  if (bars) state.bars[stock.symbol] = bars;
  await sleep(8000); // Twelve Data free plan: 8 requests per minute
}

// ---------- strategy settings from the weekly backtest ----------

const STRATEGY_CONFIG_URL = 'https://raw.githubusercontent.com/rtsuki1030/tousi-project/main/backtest/results/config.json';
const STRATEGY_CONFIG_CHECK_MS = 6 * 60 * 60 * 1000;

async function refreshStrategyConfig(state) {
  const s = state.strategy;
  if (s.configCheckedAt && Date.now() - s.configCheckedAt < STRATEGY_CONFIG_CHECK_MS) return;
  s.configCheckedAt = Date.now();
  try {
    const res = await fetch(STRATEGY_CONFIG_URL);
    if (!res.ok) return; // 404 until the first backtest result is committed
    const cfg = await res.json();
    if (!cfg.params || !cfg.ensemble || cfg.generatedAt === s.config.generatedAt) return;
    if (!sameParams(cfg.params, s.config.params)) {
      // Scores earned under different strategy settings don't carry over;
      // start from what the backtest learned with the new ones.
      s.scores = { ...(cfg.priorScores || {}) };
    }
    if (cfg.adoptedAt && cfg.adoptedAt !== s.config.adoptedAt) {
      pushLog(state, 'バックテストで選ばれた新しい戦略設定に切り替えました');
    }
    s.config = cfg;
  } catch (e) {
    console.log('strategy config fetch failed', String(e));
  }
}

// ---------- trading ----------

function pushLog(state, note) {
  state.log.push({ t: Date.now(), note });
  if (state.log.length > 80) state.log.shift();
}

function doBuy(state, { symbol, name, assetClass, quantity, price }) {
  const fee = quantity * price * (FEE_RATES[assetClass] || 0);
  const amount = quantity * price + fee;
  if (amount > state.cash + 1e-6) return false;
  state.cash -= amount;
  const h = state.holdings.find(x => x.symbol === symbol);
  if (h) {
    const totalCost = h.avgCost * h.quantity + amount;
    h.quantity += quantity;
    h.avgCost = totalCost / h.quantity;
    h.currentPrice = price;
  } else {
    // avgCost includes the purchase fee, so stop-loss / take-profit and
    // realized P&L are measured against what the position really cost.
    state.holdings.push({ symbol, name, assetClass, quantity, avgCost: amount / quantity, currentPrice: price });
  }
  state.transactions.push({ date: todayStr(), t: Date.now(), type: 'buy', symbol, quantity, price, amount, fee, realizedPL: null });
  if (state.transactions.length > 200) state.transactions.shift();
  return true;
}

function doSell(state, { symbol, quantity, price }) {
  const h = state.holdings.find(x => x.symbol === symbol);
  if (!h || quantity > h.quantity + 1e-9) return { ok: false };
  const fee = quantity * price * (FEE_RATES[h.assetClass] || 0);
  const amount = quantity * price - fee;
  const realized = amount - h.avgCost * quantity;
  state.cash += amount;
  h.quantity -= quantity;
  h.currentPrice = price;
  if (h.quantity <= 1e-9) state.holdings = state.holdings.filter(x => x.symbol !== symbol);
  state.transactions.push({ date: todayStr(), t: Date.now(), type: 'sell', symbol, quantity, price, amount, fee, realizedPL: realized });
  if (state.transactions.length > 200) state.transactions.shift();
  return { ok: true, realized };
}

function totalAssets(state) {
  return state.cash + state.holdings.reduce((s, h) => s + h.quantity * h.currentPrice, 0);
}

// Pegged coins never move, so there is nothing for the strategies to trade.
const STABLECOIN_SYMBOLS = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'USDE', 'USDS', 'PYUSD', 'TUSD', 'BUSD', 'USD1', 'USDD', 'RLUSD', 'USDTB', 'USDF', 'USDG', 'GHO', 'FRAX', 'EURC']);
// A symbol is judged only after the ensemble has read it for a day of hourly bars.
const WATCH_MIN_SCORED_BARS = 24;

// Less than 2% between the 10-day high and low: a pegged or fund-like token.
function barelyMoves(bars) {
  if (!bars || bars.closes.length <= MIN_BARS) return false;
  return Math.max(...bars.closes) / Math.min(...bars.closes) < 1.02;
}

function autoDiscover(state, catalog) {
  if (state.steps % AI_DISCOVERY_EVERY_N_TICKS !== 0) return;
  const heldSymbols = new Set(state.holdings.map(h => h.symbol));

  const removable = state.watchlist.filter(w => !w.pinned && !heldSymbols.has(w.symbol));
  const flat = removable.filter(w => STABLECOIN_SYMBOLS.has(w.symbol) || barelyMoves(state.bars[w.symbol]));
  const misread = removable.filter(w => {
    const s = state.symbolScores[w.symbol];
    return s && s.n >= WATCH_MIN_SCORED_BARS && s.score < 0;
  });
  if (flat.length > 0) {
    state.watchlist = state.watchlist.filter(w => !flat.includes(w));
    pushLog(state, `ウォッチリストから除外（値動きがほとんどない）: ${flat.map(w => w.symbol).join(', ')}`);
  } else if (misread.length > 0) {
    const gone = misread[Math.floor(Math.random() * misread.length)];
    state.watchlist = state.watchlist.filter(w => w.symbol !== gone.symbol);
    pushLog(state, `ウォッチリストから除外（戦略の読みが外れ続けた）: ${gone.symbol}`);
  }

  const excluded = new Set([...heldSymbols, ...state.watchlist.map(w => w.symbol), ...STABLECOIN_SYMBOLS]);

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

function pruneBySymbol(obj, keep) {
  Object.keys(obj).forEach(k => { if (!keep.has(k)) delete obj[k]; });
}

function formatYenPrice(p) {
  return `¥${p.toLocaleString('ja-JP', { maximumFractionDigits: p >= 1000 ? 0 : p >= 1 ? 2 : 6 })}`;
}

const SELL_REASON = {
  stopLoss: d => `損切り（取得単価比 ${(d.change * 100).toFixed(1)}%）`,
  takeProfit: d => `利確（取得単価比 +${(d.change * 100).toFixed(1)}%）`,
  signal: (d, score) => `シグナル悪化（合議スコア ${score.toFixed(2)}）`,
};

async function runAiTick(env) {
  const state = await loadState(env);
  const twelveDataKey = env.TWELVE_DATA_KEY || '';

  state.steps++;
  state.lastRunAt = Date.now();

  await refreshStrategyConfig(state);
  const config = state.strategy.config;
  const ensemble = { ...DEFAULT_CONFIG.ensemble, ...config.ensemble };
  const learning = { ...DEFAULT_CONFIG.learning, ...config.learning };

  const catalog = await refreshCryptoCatalogIfStale(env);
  autoDiscover(state, catalog);

  const bySymbol = {};
  state.watchlist.forEach(w => { bySymbol[w.symbol] = w; });
  state.holdings.forEach(h => { bySymbol[h.symbol] = h; });
  const universe = Object.values(bySymbol);
  const inUniverse = new Set(Object.keys(bySymbol));
  [state.bars, state.strategy.signals, state.symbolScores, state.seedTried].forEach(o => pruneBySymbol(o, inUniverse));

  const fxCache = {};
  const shouldFetchStocks = state.steps % STOCK_FETCH_EVERY_N_TICKS === 0;
  const cryptoSymbols = universe.filter(x => x.assetClass === 'crypto').map(x => x.symbol);
  const stockSymbols = universe.filter(x => x.assetClass === 'stock').map(x => x.symbol);
  const cryptoPrices = cryptoSymbols.length ? await fetchCryptoPrices(cryptoSymbols, catalog, env.COINGECKO_API_KEY) : {};
  const stockPrices = (stockSymbols.length && shouldFetchStocks) ? await fetchStockPrices(stockSymbols, twelveDataKey, fxCache) : {};
  const allPrices = { ...cryptoPrices, ...stockPrices };
  // History downloads come after the price fetch so they can only ever use
  // up rate-limit budget the prices didn't need.
  await seedMissingBars(state, universe, catalog, env, shouldFetchStocks, fxCache);

  if (Object.keys(allPrices).length === 0) {
    pushLog(state, '価格を取得できませんでした（APIキー未設定、またはネットワークエラー）');
    await saveState(env, state);
    return state;
  }

  const newBars = [];
  Object.entries(allPrices).forEach(([symbol, price]) => {
    const h = state.holdings.find(x => x.symbol === symbol);
    if (h) h.currentPrice = price;
    const completed = recordPrice(state, symbol, bySymbol[symbol].assetClass, price);
    if (completed && completed.length > MIN_BARS) newBars.push({ symbol, completed });
  });

  // Learn first: credit each strategy's vote on the previous bar with what
  // the price actually did next. Then vote on the bar that just completed.
  newBars.forEach(({ symbol, completed }) => {
    const n = completed.length;
    const ret = completed[n - 1] / completed[n - 2] - 1;
    updateScores(state.strategy.scores, strategyVotes(completed, n - 2, config.params), ret, learning.decay);
    const prev = state.strategy.signals[symbol];
    if (prev) {
      const s = state.symbolScores[symbol] || { score: 0, n: 0 };
      state.symbolScores[symbol] = { score: s.score * 0.98 + prev.score * ret, n: s.n + 1 };
    }
  });
  const weights = strategyWeights(state.strategy.scores, learning.eta);
  const scoreBySymbol = {};
  newBars.forEach(({ symbol, completed }) => {
    const votes = strategyVotes(completed, completed.length - 1, config.params);
    const score = ensembleScore(votes, weights);
    scoreBySymbol[symbol] = score;
    state.strategy.signals[symbol] = { t: Date.now(), score, votes };
  });

  // Exits run every tick (stop-loss / take-profit don't wait for the hour);
  // signal exits and entries only when a fresh hourly vote exists.
  for (const h of [...state.holdings]) {
    if (allPrices[h.symbol] == null) continue;
    const score = scoreBySymbol[h.symbol] ?? null;
    const d = decide({ score, held: true, price: h.currentPrice, avgCost: h.avgCost, ensemble });
    if (d.action !== 'sell') continue;
    const result = doSell(state, { symbol: h.symbol, quantity: h.quantity, price: h.currentPrice });
    if (!result.ok) continue;
    state.trades++;
    state.closedTrades++;
    if (result.realized > 0) state.wins++;
    pushLog(state, `売り: ${h.symbol} ${SELL_REASON[d.reason](d, score)} 確定損益 ${result.realized >= 0 ? '+' : '-'}¥${Math.round(Math.abs(result.realized)).toLocaleString('ja-JP')}`);
  }

  const equity = totalAssets(state);
  const candidates = Object.entries(scoreBySymbol)
    .filter(([symbol]) => !state.holdings.some(h => h.symbol === symbol))
    .filter(([, score]) => decide({ score, held: false, ensemble }).action === 'buy')
    .sort((a, b) => b[1] - a[1]);
  for (const [symbol, score] of candidates) {
    const budget = Math.min(ensemble.positionFraction * equity, state.cash);
    if (budget < 0.01 * equity) break;
    const u = bySymbol[symbol];
    const price = allPrices[symbol];
    const perUnit = price * (1 + (FEE_RATES[u.assetClass] || 0));
    const qty = u.assetClass === 'crypto' ? Math.floor((budget / perUnit) * 1e6) / 1e6 : Math.floor(budget / perUnit);
    if (qty <= 0) continue;
    if (!doBuy(state, { symbol, name: u.name, assetClass: u.assetClass, quantity: qty, price })) continue;
    state.trades++;
    const agree = Object.entries(state.strategy.signals[symbol].votes)
      .filter(([, v]) => v > 0).map(([k]) => STRATEGY_INFO[k].name).join('・');
    pushLog(state, `新規購入: ${symbol} ${qty} @ ${formatYenPrice(price)}（合議スコア ${score.toFixed(2)} / 買い票: ${agree || 'なし'}）`);
  }

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
      // Lets the status page pull price charts straight from CoinGecko, and
      // tells the weekly backtest which coins the AI is trading.
      const catalog = (await loadCryptoCatalog(env))?.map || null;
      const cryptoIds = {};
      [...state.holdings, ...state.watchlist].filter(h => h.assetClass === 'crypto').forEach(h => {
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
        strategy: {
          info: STRATEGY_INFO,
          weights: strategyWeights(state.strategy.scores, (state.strategy.config.learning || DEFAULT_CONFIG.learning).eta),
          scores: state.strategy.scores,
          signals: state.strategy.signals,
          config: {
            source: state.strategy.config.source,
            generatedAt: state.strategy.config.generatedAt,
            adoptedAt: state.strategy.config.adoptedAt || null,
            params: state.strategy.config.params,
            ensemble: state.strategy.config.ensemble,
          },
          report: state.strategy.config.report,
        },
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
