const STORAGE_KEY = 'tousiSimState_v1';

const CRYPTO_ID_MAP = {
  BTC: 'bitcoin', ETH: 'ethereum', XRP: 'ripple', ADA: 'cardano',
  SOL: 'solana', DOGE: 'dogecoin', DOT: 'polkadot', LTC: 'litecoin',
  BCH: 'bitcoin-cash', LINK: 'chainlink', MATIC: 'matic-network',
  AVAX: 'avalanche-2', TRX: 'tron', BNB: 'binancecoin', USDT: 'tether',
  USDC: 'usd-coin', SHIB: 'shiba-inu', ATOM: 'cosmos', XLM: 'stellar',
  ETC: 'ethereum-classic',
};

const ASSET_CLASS_LABEL = {
  stock: '株式', fund: '投信/ETF', crypto: '暗号資産', bond: '債券', other: 'その他',
};

let state = null;
let netWorthChart = null;
let allocSymbolChart = null;
let allocClassChart = null;
let currentTradeType = 'buy';

function todayStr() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function formatYen(n) {
  if (!isFinite(n)) n = 0;
  return '¥' + Math.round(n).toLocaleString('ja-JP');
}

function formatPct(n) {
  if (!isFinite(n)) n = 0;
  const sign = n > 0 ? '+' : '';
  return sign + n.toFixed(1) + '%';
}

function signClass(n) {
  return n > 0 ? 'positive' : (n < 0 ? 'negative' : '');
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.hidden = true; }, 2600);
}

function defaultState(initialCash) {
  return {
    version: 1,
    cash: initialCash,
    initialCash: initialCash,
    holdings: [],
    transactions: [],
    priceHistory: {},
    netWorthHistory: [],
    cashAdjustments: [],
    goal: { targetAmount: null, targetDate: null },
    settings: { twelveDataKey: '' },
    cryptoCatalog: null,
    cryptoCatalogAt: null,
    ai: defaultAiState(),
  };
}

function defaultAiState() {
  return {
    running: false,
    tickIntervalSec: 180,
    steps: 0,
    trades: 0,
    closedTrades: 0,
    wins: 0,
    weights: {},
    history: {},
    log: [],
    lastRunAt: null,
  };
}

function migrateState() {
  if (!state.cashAdjustments) state.cashAdjustments = [];
  if (!state.goal) state.goal = { targetAmount: null, targetDate: null };
  if (!state.netWorthHistory) state.netWorthHistory = [];
  if (!state.priceHistory) state.priceHistory = {};
  if (!state.settings) state.settings = { twelveDataKey: '' };
  if (state.cryptoCatalog === undefined) state.cryptoCatalog = null;
  if (state.cryptoCatalogAt === undefined) state.cryptoCatalogAt = null;
  if (!state.ai) state.ai = defaultAiState();
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (e) {
    console.error('failed to load state', e);
    return null;
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------- computed values ----------

function holdingValue(h) {
  return h.quantity * (h.currentPrice || 0);
}

function totalHoldingsValue() {
  return state.holdings.reduce((s, h) => s + holdingValue(h), 0);
}

function totalAssets() {
  return state.cash + totalHoldingsValue();
}

function unrealizedPL() {
  return state.holdings.reduce((s, h) => s + (h.currentPrice - h.avgCost) * h.quantity, 0);
}

function realizedPL() {
  return state.transactions
    .filter(t => t.type === 'sell')
    .reduce((s, t) => s + (t.realizedPL || 0), 0);
}

function totalContributions() {
  return state.initialCash + state.cashAdjustments.reduce((s, c) => s + c.amount, 0);
}

function totalPL() {
  return totalAssets() - totalContributions();
}

function totalPLPct() {
  const c = totalContributions();
  if (c <= 0) return 0;
  return (totalPL() / c) * 100;
}

// ---------- rendering ----------

function render() {
  renderHeader();
  renderDashboard();
  renderHoldings();
  renderTradeForm();
  renderHistory();
  renderGoal();
  renderAiTab();
  document.getElementById('twelveDataKey').value = state.settings.twelveDataKey || '';
  document.getElementById('aiInterval').value = String(state.ai.tickIntervalSec);
}

function renderHeader() {
  document.getElementById('headerTotal').textContent = formatYen(totalAssets());
}

function renderDashboard() {
  document.getElementById('statTotalAssets').textContent = formatYen(totalAssets());
  const plEl = document.getElementById('statTotalPL');
  const pl = totalPL();
  plEl.textContent = `${pl >= 0 ? '+' : ''}${formatYen(pl)} (${formatPct(totalPLPct())})`;
  plEl.className = 'stat-sub ' + signClass(pl);

  document.getElementById('statCash').textContent = formatYen(state.cash);

  const uEl = document.getElementById('statUnrealized');
  const u = unrealizedPL();
  uEl.textContent = formatYen(u);
  uEl.className = 'stat-value ' + signClass(u);

  const rEl = document.getElementById('statRealized');
  const r = realizedPL();
  rEl.textContent = formatYen(r);
  rEl.className = 'stat-value ' + signClass(r);

  renderNetWorthChart();
  renderAllocCharts();
  renderGoalMini();
}

function renderNetWorthChart() {
  const hint = document.getElementById('netWorthHint');
  const ctx = document.getElementById('netWorthChart').getContext('2d');
  const history = [...state.netWorthHistory].sort((a, b) => a.date.localeCompare(b.date));

  if (history.length === 0) {
    hint.textContent = '「今日の資産を記録」を押すと、資産推移グラフに記録されます。';
  } else {
    hint.textContent = `記録件数: ${history.length}件`;
  }

  const labels = history.map(h => h.date);
  const values = history.map(h => h.value);
  const goalTarget = state.goal.targetAmount;

  const datasets = [{
    label: '総資産',
    data: values,
    borderColor: '#2f6fed',
    backgroundColor: 'rgba(47,111,237,0.12)',
    fill: true,
    tension: 0.25,
    pointRadius: 3,
  }];

  if (goalTarget) {
    datasets.push({
      label: '目標金額',
      data: labels.map(() => goalTarget),
      borderColor: '#17825a',
      borderDash: [6, 6],
      pointRadius: 0,
      fill: false,
    });
  }

  if (netWorthChart) netWorthChart.destroy();
  netWorthChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      plugins: { legend: { display: goalTarget ? true : false } },
      scales: {
        y: { ticks: { callback: v => formatYen(v) } },
      },
    },
  });
}

const PALETTE = ['#2f6fed', '#17825a', '#f2994a', '#d1373f', '#9b59b6', '#00b8d9', '#ffb020', '#6b7280', '#e84393', '#00a86b'];

function renderAllocCharts() {
  const symCtx = document.getElementById('allocSymbolChart').getContext('2d');
  const clsCtx = document.getElementById('allocClassChart').getContext('2d');

  const symLabels = [];
  const symValues = [];
  state.holdings.forEach(h => {
    const v = holdingValue(h);
    if (v > 0) { symLabels.push(h.symbol); symValues.push(v); }
  });
  if (state.cash > 0) { symLabels.push('現金'); symValues.push(state.cash); }

  const clsMap = {};
  state.holdings.forEach(h => {
    const v = holdingValue(h);
    clsMap[h.assetClass] = (clsMap[h.assetClass] || 0) + v;
  });
  if (state.cash > 0) clsMap['cash'] = (clsMap['cash'] || 0) + state.cash;
  const clsLabels = Object.keys(clsMap).map(k => k === 'cash' ? '現金' : ASSET_CLASS_LABEL[k] || k);
  const clsValues = Object.values(clsMap);

  if (allocSymbolChart) allocSymbolChart.destroy();
  if (allocClassChart) allocClassChart.destroy();

  const opts = {
    responsive: true,
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
      tooltip: { callbacks: { label: ctx => `${ctx.label}: ${formatYen(ctx.raw)}` } },
    },
  };

  allocSymbolChart = new Chart(symCtx, {
    type: 'doughnut',
    data: {
      labels: symLabels.length ? symLabels : ['データなし'],
      datasets: [{ data: symValues.length ? symValues : [1], backgroundColor: PALETTE }],
    },
    options: opts,
  });

  allocClassChart = new Chart(clsCtx, {
    type: 'doughnut',
    data: {
      labels: clsLabels.length ? clsLabels : ['データなし'],
      datasets: [{ data: clsValues.length ? clsValues : [1], backgroundColor: PALETTE }],
    },
    options: opts,
  });
}

function renderGoalMini() {
  const card = document.getElementById('goalMiniCard');
  if (!state.goal.targetAmount) { card.hidden = true; return; }
  card.hidden = false;
  const pct = Math.min(100, (totalAssets() / state.goal.targetAmount) * 100);
  document.getElementById('goalMiniFill').style.width = pct.toFixed(1) + '%';
  document.getElementById('goalMiniText').textContent =
    `${formatYen(totalAssets())} / ${formatYen(state.goal.targetAmount)}（${pct.toFixed(1)}%）`;
}

function renderHoldings() {
  const body = document.getElementById('holdingsBody');
  const empty = document.getElementById('holdingsEmpty');
  body.innerHTML = '';
  if (state.holdings.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  state.holdings.forEach(h => {
    const value = holdingValue(h);
    const pl = (h.currentPrice - h.avgCost) * h.quantity;
    const plPct = h.avgCost > 0 ? ((h.currentPrice - h.avgCost) / h.avgCost) * 100 : 0;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(h.symbol)}</strong>${h.name ? `<br><span class="hint">${escapeHtml(h.name)}</span>` : ''}</td>
      <td>${ASSET_CLASS_LABEL[h.assetClass] || h.assetClass}</td>
      <td>${h.quantity.toLocaleString('ja-JP')}</td>
      <td>${formatYen(h.avgCost)}</td>
      <td><input type="number" class="price-input" data-id="${h.id}" value="${h.currentPrice}" min="0" step="any" style="width:100px"></td>
      <td>${formatYen(value)}</td>
      <td class="${signClass(pl)}">${formatYen(pl)}<br><span class="hint">${formatPct(plPct)}</span></td>
      <td></td>
    `;
    body.appendChild(tr);
  });

  body.querySelectorAll('.price-input').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      const price = parseFloat(e.target.value);
      if (isNaN(price) || price < 0) return;
      updateHoldingPrice(id, price);
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function updateHoldingPrice(id, price) {
  const h = state.holdings.find(x => x.id === id);
  if (!h) return;
  h.currentPrice = price;
  pushPriceHistory(h.symbol, price);
  saveState();
  render();
  showToast(`${h.symbol} の価格を更新しました`);
}

function pushPriceHistory(symbol, price) {
  if (!state.priceHistory[symbol]) state.priceHistory[symbol] = [];
  const today = todayStr();
  const arr = state.priceHistory[symbol];
  const existingIdx = arr.findIndex(p => p.date === today);
  if (existingIdx >= 0) arr[existingIdx].price = price;
  else arr.push({ date: today, price });
}

function renderTradeForm() {
  const symbolList = document.getElementById('symbolList');
  symbolList.innerHTML = state.holdings.map(h => `<option value="${escapeHtml(h.symbol)}">`).join('');

  const sellSelect = document.getElementById('tSymbolSelect');
  sellSelect.innerHTML = state.holdings.map(h =>
    `<option value="${escapeHtml(h.symbol)}">${escapeHtml(h.symbol)}（保有: ${h.quantity.toLocaleString('ja-JP')}）</option>`
  ).join('');

  document.getElementById('tDate').value = document.getElementById('tDate').value || todayStr();
  updateTradeSummary();
}

function updateTradeSummary() {
  const qty = parseFloat(document.getElementById('tQty').value) || 0;
  const price = parseFloat(document.getElementById('tPrice').value) || 0;
  const amount = qty * price;
  const summaryEl = document.getElementById('tradeSummary');

  if (currentTradeType === 'buy') {
    const after = state.cash - amount;
    summaryEl.textContent = `合計金額: ${formatYen(amount)}　→ 購入後の現金残高: ${formatYen(after)}`;
  } else {
    const after = state.cash + amount;
    summaryEl.textContent = `合計金額: ${formatYen(amount)}　→ 売却後の現金残高: ${formatYen(after)}`;
  }
}

function renderHistory() {
  const body = document.getElementById('historyBody');
  const empty = document.getElementById('historyEmpty');
  const filter = document.getElementById('historyFilter').value;

  let list = [...state.transactions].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  if (filter !== 'all') list = list.filter(t => t.type === filter);

  body.innerHTML = '';
  if (list.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  list.forEach(t => {
    const tr = document.createElement('tr');
    const plCell = t.type === 'sell'
      ? `<td class="${signClass(t.realizedPL)}">${formatYen(t.realizedPL)}</td>`
      : `<td>-</td>`;
    tr.innerHTML = `
      <td>${t.date}</td>
      <td>${t.type === 'buy' ? '買い' : '売り'}${t.source === 'ai' ? '<span class="badge-ai">🤖 AI</span>' : ''}</td>
      <td>${escapeHtml(t.symbol)}</td>
      <td>${t.quantity.toLocaleString('ja-JP')}</td>
      <td>${formatYen(t.price)}</td>
      <td>${formatYen(t.amount)}</td>
      ${plCell}
      <td><button class="icon-btn" data-id="${t.id}" title="削除して取り消す">✕</button></td>
    `;
    body.appendChild(tr);
  });

  body.querySelectorAll('.icon-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteTransaction(btn.dataset.id));
  });
}

function deleteTransaction(id) {
  const t = state.transactions.find(x => x.id === id);
  if (!t) return;
  if (!confirm(`${t.date} の ${t.symbol} ${t.type === 'buy' ? '買い' : '売り'}取引を取り消しますか？\n（この操作は現金・保有数量を巻き戻します）`)) return;

  const h = state.holdings.find(x => x.symbol === t.symbol);
  if (t.type === 'buy') {
    state.cash += t.amount;
    if (h) {
      const newQty = h.quantity - t.quantity;
      if (newQty <= 0) {
        state.holdings = state.holdings.filter(x => x.id !== h.id);
      } else {
        const totalCostBefore = h.avgCost * h.quantity;
        const remainingCost = totalCostBefore - t.amount;
        h.quantity = newQty;
        h.avgCost = remainingCost / newQty;
      }
    }
  } else {
    state.cash -= t.amount;
    if (h) {
      h.quantity += t.quantity;
    } else {
      state.holdings.push({
        id: uid(), symbol: t.symbol, name: t.name || '', assetClass: t.assetClass || 'other',
        quantity: t.quantity, avgCost: t.price, currentPrice: t.price,
      });
    }
  }
  state.transactions = state.transactions.filter(x => x.id !== id);
  saveState();
  render();
  showToast('取引を取り消しました');
}

function renderGoal() {
  document.getElementById('gTarget').value = state.goal.targetAmount || '';
  document.getElementById('gDate').value = state.goal.targetDate || '';

  const detailCard = document.getElementById('goalDetailCard');
  if (!state.goal.targetAmount) { detailCard.hidden = true; return; }
  detailCard.hidden = false;

  const current = totalAssets();
  const target = state.goal.targetAmount;
  const pct = Math.min(100, (current / target) * 100);
  document.getElementById('goalDetailFill').style.width = pct.toFixed(1) + '%';
  document.getElementById('goalDetailText').textContent = `達成率 ${pct.toFixed(1)}%`;
  document.getElementById('goalCurrent').textContent = formatYen(current);
  document.getElementById('goalRemaining').textContent = formatYen(Math.max(0, target - current));

  const monthlyEl = document.getElementById('goalMonthly');
  if (state.goal.targetDate) {
    const now = new Date();
    const end = new Date(state.goal.targetDate);
    const months = Math.max(1, (end.getFullYear() - now.getFullYear()) * 12 + (end.getMonth() - now.getMonth()));
    const remaining = Math.max(0, target - current);
    monthlyEl.textContent = remaining > 0 ? formatYen(remaining / months) + ' /月' : '達成済み🎉';
  } else {
    monthlyEl.textContent = '目標日未設定';
  }
}

// ---------- trading logic ----------

function doBuy({ symbol, name, assetClass, quantity, price, date, source }) {
  const amount = quantity * price;
  if (amount > state.cash + 1e-6) {
    return { ok: false, msg: `現金残高が不足しています（残高: ${formatYen(state.cash)}）` };
  }
  state.cash -= amount;

  let h = state.holdings.find(x => x.symbol.toUpperCase() === symbol.toUpperCase());
  if (h) {
    const totalCost = h.avgCost * h.quantity + amount;
    h.quantity += quantity;
    h.avgCost = totalCost / h.quantity;
    h.currentPrice = price;
    if (name) h.name = name;
  } else {
    h = { id: uid(), symbol, name: name || '', assetClass, quantity, avgCost: price, currentPrice: price };
    state.holdings.push(h);
  }
  pushPriceHistory(symbol, price);

  state.transactions.push({
    id: uid(), date, type: 'buy', symbol, name: name || '', assetClass,
    quantity, price, amount, realizedPL: null, source: source || 'user',
  });

  saveState();
  return { ok: true };
}

function doSell({ symbol, quantity, price, date, source }) {
  const h = state.holdings.find(x => x.symbol.toUpperCase() === symbol.toUpperCase());
  if (!h) return { ok: false, msg: '保有していない銘柄です' };
  if (quantity > h.quantity + 1e-9) return { ok: false, msg: `保有数量（${h.quantity}）を超えています` };

  const amount = quantity * price;
  const realized = (price - h.avgCost) * quantity;

  state.cash += amount;
  h.quantity -= quantity;
  h.currentPrice = price;
  if (h.quantity <= 1e-9) {
    state.holdings = state.holdings.filter(x => x.id !== h.id);
  }
  pushPriceHistory(symbol, price);

  state.transactions.push({
    id: uid(), date, type: 'sell', symbol, name: h.name, assetClass: h.assetClass,
    quantity, price, amount, realizedPL: realized, source: source || 'user',
  });

  saveState();
  return { ok: true };
}

// ---------- crypto auto price fetch ----------

const CRYPTO_CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

async function fetchCryptoCatalog() {
  const pages = [1, 2, 3, 4, 5, 6, 7, 8];
  const map = {};
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=jpy&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`;
    try {
      const res = await fetch(url);
      if (!res.ok) break;
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      rows.forEach(r => {
        const sym = (r.symbol || '').toUpperCase();
        if (sym && !map[sym]) map[sym] = r.id; // first hit = highest market cap (list is sorted desc)
      });
    } catch (e) {
      break;
    }
    if (i < pages.length - 1) await sleep(2500); // stay well under CoinGecko's public rate limit
  }
  return map;
}

function resolveCryptoId(symbol) {
  const upper = symbol.toUpperCase();
  if (state.cryptoCatalog && state.cryptoCatalog[upper]) return state.cryptoCatalog[upper];
  return CRYPTO_ID_MAP[upper] || null;
}

let catalogRefreshInFlight = false;

function maybeRefreshCryptoCatalogInBackground() {
  const catalogAge = state.cryptoCatalogAt ? Date.now() - state.cryptoCatalogAt : Infinity;
  if (catalogRefreshInFlight || (state.cryptoCatalog && catalogAge <= CRYPTO_CATALOG_MAX_AGE_MS)) return;
  catalogRefreshInFlight = true;
  fetchCryptoCatalog()
    .then(map => {
      if (Object.keys(map).length > 0) {
        state.cryptoCatalog = map;
        state.cryptoCatalogAt = Date.now();
        saveState();
      }
    })
    .catch(() => { /* keep using the hardcoded fallback map */ })
    .finally(() => { catalogRefreshInFlight = false; });
}

async function fetchCryptoPrices(silent) {
  maybeRefreshCryptoCatalogInBackground(); // never blocks this call; fills in over time

  const cryptoHoldings = state.holdings.filter(h => h.assetClass === 'crypto');
  if (cryptoHoldings.length === 0) {
    if (!silent) showToast('暗号資産の保有銘柄がありません');
    return { updated: 0, attempted: 0 };
  }
  const idPairs = cryptoHoldings
    .map(h => ({ h, id: resolveCryptoId(h.symbol) }))
    .filter(x => x.id);

  if (idPairs.length === 0) {
    if (!silent) showToast('対応する暗号資産の銘柄コードが見つかりません');
    return { updated: 0, attempted: 0 };
  }

  const ids = [...new Set(idPairs.map(x => x.id))].join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=jpy`;

  if (!silent) showToast('価格を取得中...');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    let updated = 0;
    idPairs.forEach(({ h, id }) => {
      const price = data[id]?.jpy;
      if (typeof price === 'number') {
        h.currentPrice = price;
        pushPriceHistory(h.symbol, price);
        pushAiHistory(h.symbol, price);
        updated++;
      }
    });
    saveState();
    render();
    if (!silent) showToast(updated > 0 ? `${updated}件の価格を更新しました` : '価格を取得できませんでした');
    return { updated, attempted: idPairs.length };
  } catch (e) {
    console.error(e);
    if (!silent) showToast('自動取得に失敗しました。手動で価格を入力してください。');
    return { updated: 0, attempted: idPairs.length, error: true };
  }
}

// ---------- stock auto price fetch (Twelve Data) ----------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Japanese exchange codes are 4-digit numbers (e.g. 7203). Real-time data for
// the Tokyo Stock Exchange requires a paid plan on every provider we checked
// (Twelve Data, FCS API, and JPX's own official feed all gate it behind a
// paid tier) -- so those stay manual-entry only. Everything else (AAPL,
// TSLA, ...) is fetched from Twelve Data, which is free for US exchanges.
function isJapaneseStockSymbol(symbol) {
  return /^\d{4}$/.test(symbol.trim());
}

async function fetchOneStockPrice(h) {
  if (isJapaneseStockSymbol(h.symbol)) {
    return { ok: false, reason: 'jp_manual_only' };
  }
  const key = (state.settings.twelveDataKey || '').trim();
  if (!key) return { ok: false, reason: 'no_key_twelvedata' };
  try {
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(h.symbol)}&apikey=${encodeURIComponent(key)}`;
    const res = await fetch(url);
    const data = await res.json();
    const price = parseFloat(data.close ?? data.price);
    if (data.status !== 'error' && isFinite(price) && price > 0) return { ok: true, price };
    console.warn(`Twelve Data: ${h.symbol} - ${data.message}`);
    return { ok: false, reason: 'api_error' };
  } catch (e) {
    console.error(e);
    return { ok: false, reason: 'network' };
  }
}

async function fetchStockPrices(silent) {
  const stockHoldings = state.holdings.filter(h => h.assetClass === 'stock' || h.assetClass === 'fund');
  if (stockHoldings.length === 0) {
    if (!silent) showToast('株式・投信の保有銘柄がありません');
    return { updated: 0, attempted: 0 };
  }
  if (!state.settings.twelveDataKey && !state.settings.fcsApiKey) {
    if (!silent) showToast('設定タブでTwelve DataのAPIキーを登録してください（米国株など向け）');
    return { updated: 0, attempted: 0 };
  }

  if (!silent) showToast(`${stockHoldings.length}銘柄の価格を取得中...`);
  let updated = 0;
  let skippedJp = 0;
  for (let i = 0; i < stockHoldings.length; i++) {
    const h = stockHoldings[i];
    const result = await fetchOneStockPrice(h);
    if (result.ok) {
      h.currentPrice = result.price;
      pushPriceHistory(h.symbol, result.price);
      pushAiHistory(h.symbol, result.price);
      updated++;
    } else if (result.reason === 'jp_manual_only') {
      skippedJp++;
    }
    if (i < stockHoldings.length - 1) await sleep(8000); // respect free-tier rate limits
  }
  saveState();
  render();
  if (!silent) {
    if (updated > 0) {
      showToast(`${updated}/${stockHoldings.length}銘柄の価格を更新しました`);
    } else if (skippedJp === stockHoldings.length) {
      showToast('日本株（4桁コード）は無料APIでは取得できません。手動入力してください。');
    } else {
      showToast('価格を取得できませんでした（APIキーや銘柄コードを確認してください）');
    }
  }
  return { updated, attempted: stockHoldings.length - skippedJp };
}

// ---------- AI auto-trading (real prices, real portfolio) ----------
// Manages symbols you already hold. Each tick it refreshes real prices,
// then uses a moving-average momentum signal scaled by a per-symbol
// "weight" that adapts based on whether that signal predicted the next
// price move correctly -- a simple adaptive rule, not a trained model or
// a call to Claude itself.

let aiTimer = null;
let aiTickRunning = false;

function pushAiHistory(symbol, price) {
  if (!state.ai.history[symbol]) state.ai.history[symbol] = [];
  const arr = state.ai.history[symbol];
  arr.push({ t: Date.now(), price });
  if (arr.length > 30) arr.shift();
}

function avgLast(arr, n) {
  if (arr.length < n) return null;
  const slice = arr.slice(-n);
  return slice.reduce((s, v) => s + v.price, 0) / slice.length;
}

async function aiTick() {
  if (aiTickRunning) return;
  aiTickRunning = true;
  try {
    await aiTickInner();
  } finally {
    aiTickRunning = false;
  }
}

async function aiTickInner() {
  const ai = state.ai;
  ai.steps++;
  ai.lastRunAt = Date.now();

  const cryptoResult = await fetchCryptoPrices(true);
  const stockResult = await fetchStockPrices(true);
  const attempted = cryptoResult.attempted + stockResult.attempted;

  if (attempted === 0) {
    pushAiLog('価格取得の対象銘柄がありません（保有銘柄を増やすか、Twelve DataのAPIキーを設定してください）');
    saveState();
    renderAiTab();
    return;
  }

  const managed = state.holdings.filter(h => h.assetClass === 'crypto' || h.assetClass === 'stock' || h.assetClass === 'fund');
  const lr = 0.5;

  managed.forEach(h => {
    const hist = ai.history[h.symbol];
    if (!hist || hist.length < 4) return; // not enough data yet

    const shortMA = avgLast(hist, 2);
    const longMA = avgLast(hist, 4);
    if (shortMA == null || longMA == null || longMA <= 0) return;
    const momentum = (shortMA - longMA) / longMA;

    const prevDecision = ai.weights['_last_' + h.symbol];
    if (prevDecision) {
      const realizedReturn = (h.currentPrice - prevDecision.priceAtDecision) / prevDecision.priceAtDecision;
      const agreement = Math.sign(prevDecision.momentum) * Math.sign(realizedReturn);
      const w = ai.weights[h.symbol] || 0;
      const newW = Math.max(-3, Math.min(3, w + lr * agreement * Math.abs(realizedReturn) * 30));
      ai.weights[h.symbol] = newW;
    }

    const weight = ai.weights[h.symbol] || 0;
    const score = momentum * (1 + weight);

    let action = 'hold';
    if (score > 0.006) action = 'buy';
    else if (score < -0.006 && h.quantity > 0) action = 'sell';

    if (action === 'buy') {
      const budget = Math.min(state.cash * 0.15, state.cash);
      const qty = h.assetClass === 'crypto' ? (budget > 0 ? +(budget / h.currentPrice).toFixed(6) : 0) : Math.floor(budget / h.currentPrice);
      if (qty > 0) {
        const result = doBuy({ symbol: h.symbol, name: h.name, assetClass: h.assetClass, quantity: qty, price: h.currentPrice, date: todayStr(), source: 'ai' });
        if (result.ok) {
          ai.trades++;
          pushAiLog(`買い: ${h.symbol} ${qty} @ ${formatYen(h.currentPrice)}（モメンタム${formatPct(momentum * 100)} / 信頼度${weight.toFixed(2)}）`);
        }
      }
    } else if (action === 'sell') {
      const won = h.currentPrice > h.avgCost;
      const result = doSell({ symbol: h.symbol, quantity: h.quantity, price: h.currentPrice, date: todayStr(), source: 'ai' });
      if (result.ok) {
        ai.trades++;
        ai.closedTrades++;
        if (won) ai.wins++;
        pushAiLog(`売り: ${h.symbol}（${won ? '含み益で決済' : '含み損で決済'} / 信頼度${weight.toFixed(2)}）`);
      }
    }

    ai.weights['_last_' + h.symbol] = { momentum, priceAtDecision: h.currentPrice };
  });

  saveState();
  render();
}

function pushAiLog(note) {
  state.ai.log.push({ t: Date.now(), note });
  if (state.ai.log.length > 60) state.ai.log.shift();
}

function startAi() {
  if (aiTimer) return;
  state.ai.running = true;
  aiTimer = setInterval(aiTick, state.ai.tickIntervalSec * 1000);
  saveState();
  renderAiTab();
  aiTick();
}

function stopAi() {
  if (aiTimer) { clearInterval(aiTimer); aiTimer = null; }
  state.ai.running = false;
  saveState();
  renderAiTab();
}

function renderAiTab() {
  const ai = state.ai;
  document.getElementById('aiRunLabel').textContent = ai.running ? '🟢 自動運転中' : '● 停止中';
  document.getElementById('aiSteps').textContent = ai.steps.toLocaleString('ja-JP');
  document.getElementById('aiTrades').textContent = ai.trades.toLocaleString('ja-JP');
  document.getElementById('aiWinRate').textContent = ai.closedTrades > 0 ? ((ai.wins / ai.closedTrades) * 100).toFixed(1) + '%' : '-';
  document.getElementById('aiLastRun').textContent = ai.lastRunAt ? new Date(ai.lastRunAt).toLocaleTimeString('ja-JP') : '-';

  const managed = state.holdings.filter(h => h.assetClass === 'crypto' || h.assetClass === 'stock' || h.assetClass === 'fund');
  const body = document.getElementById('aiAssetsBody');
  const empty = document.getElementById('aiAssetsEmpty');
  body.innerHTML = '';
  if (managed.length === 0) {
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    managed.forEach(h => {
      const weight = ai.weights[h.symbol] || 0;
      const weightPct = ((weight + 3) / 6) * 100;
      const last = ai.weights['_last_' + h.symbol];
      const lastAction = last ? (last.momentum > 0.006 ? 'buy' : last.momentum < -0.006 ? 'sell' : 'hold') : 'hold';
      const badgeClass = lastAction === 'buy' ? 'badge-buy' : lastAction === 'sell' ? 'badge-sell' : 'badge-hold';
      const badgeLabel = lastAction === 'buy' ? '買い' : lastAction === 'sell' ? '売り' : '様子見';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHtml(h.symbol)}</strong></td>
        <td>${formatYen(h.currentPrice)}</td>
        <td>${h.quantity.toLocaleString('ja-JP')}</td>
        <td><div class="weight-track"><div class="weight-fill" style="left:${weightPct}%;background:${weight >= 0 ? 'var(--green)' : 'var(--red)'}"></div></div></td>
        <td><span class="badge ${badgeClass}">${badgeLabel}</span></td>
      `;
      body.appendChild(tr);
    });
  }

  const logList = document.getElementById('aiLog');
  const logEmpty = document.getElementById('aiLogEmpty');
  const entries = [...ai.log].reverse().slice(0, 40);
  logList.innerHTML = entries.map(e => `<li><span class="log-meta">${new Date(e.t).toLocaleTimeString('ja-JP')}</span> ${escapeHtml(e.note)}</li>`).join('');
  logEmpty.style.display = entries.length ? 'none' : 'block';
}

function setupAiActions() {
  document.getElementById('btnAiStart').addEventListener('click', startAi);
  document.getElementById('btnAiStop').addEventListener('click', stopAi);
  document.getElementById('btnAiStep').addEventListener('click', aiTick);
  document.getElementById('aiInterval').addEventListener('change', (e) => {
    state.ai.tickIntervalSec = parseInt(e.target.value, 10);
    saveState();
    if (aiTimer) { clearInterval(aiTimer); aiTimer = setInterval(aiTick, state.ai.tickIntervalSec * 1000); }
  });
  document.getElementById('btnAiReset').addEventListener('click', () => {
    if (!confirm('AIの学習内容（信頼度・ログ）をリセットします。保有銘柄や取引履歴は変わりません。よろしいですか？')) return;
    stopAi();
    state.ai = defaultAiState();
    saveState();
    renderAiTab();
    showToast('AIの学習状態をリセットしました');
  });
}

function setupApiKeyForm() {
  document.getElementById('apiKeyForm').addEventListener('submit', (e) => {
    e.preventDefault();
    state.settings.twelveDataKey = document.getElementById('twelveDataKey').value.trim();
    saveState();
    showToast('APIキーを保存しました');
  });
}

// ---------- events ----------

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      render();
    });
  });
}

function setupTradeForm() {
  document.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTradeType = btn.dataset.type;
      const isBuy = currentTradeType === 'buy';
      document.getElementById('rowSymbolBuy').hidden = !isBuy;
      document.getElementById('rowSymbolSell').hidden = isBuy;
      document.getElementById('rowName').hidden = !isBuy;
      document.getElementById('rowClass').hidden = !isBuy;
      document.getElementById('tradeSubmitBtn').textContent = isBuy ? '買いを記録する' : '売りを記録する';
      updateTradeSummary();
    });
  });

  ['tQty', 'tPrice'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateTradeSummary);
  });

  document.getElementById('tSymbol').addEventListener('change', (e) => {
    const sym = e.target.value.trim();
    const h = state.holdings.find(x => x.symbol.toUpperCase() === sym.toUpperCase());
    if (h) {
      document.getElementById('tName').value = h.name || '';
      document.getElementById('tClass').value = h.assetClass;
    }
  });

  document.getElementById('tradeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const msgEl = document.getElementById('tradeMsg');
    msgEl.textContent = '';
    msgEl.className = 'form-msg';

    const quantity = parseFloat(document.getElementById('tQty').value);
    const price = parseFloat(document.getElementById('tPrice').value);
    const date = document.getElementById('tDate').value || todayStr();

    if (!quantity || quantity <= 0) { msgEl.textContent = '数量を正しく入力してください'; msgEl.classList.add('error'); return; }
    if (!price || price <= 0) { msgEl.textContent = '単価を正しく入力してください'; msgEl.classList.add('error'); return; }

    let result;
    if (currentTradeType === 'buy') {
      const symbol = document.getElementById('tSymbol').value.trim();
      if (!symbol) { msgEl.textContent = '銘柄コードを入力してください'; msgEl.classList.add('error'); return; }
      const name = document.getElementById('tName').value.trim();
      const assetClass = document.getElementById('tClass').value;
      result = doBuy({ symbol, name, assetClass, quantity, price, date });
    } else {
      const symbol = document.getElementById('tSymbolSelect').value;
      if (!symbol) { msgEl.textContent = '保有銘柄がありません'; msgEl.classList.add('error'); return; }
      result = doSell({ symbol, quantity, price, date });
    }

    if (!result.ok) {
      msgEl.textContent = result.msg;
      msgEl.classList.add('error');
      return;
    }

    msgEl.textContent = '記録しました';
    msgEl.classList.add('success');
    document.getElementById('tQty').value = '';
    document.getElementById('tPrice').value = '';
    document.getElementById('tSymbol').value = '';
    document.getElementById('tName').value = '';
    render();
  });
}

function setupGoalForm() {
  document.getElementById('goalForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const target = parseFloat(document.getElementById('gTarget').value);
    const date = document.getElementById('gDate').value;
    state.goal.targetAmount = target > 0 ? target : null;
    state.goal.targetDate = date || null;
    saveState();
    render();
    showToast('目標を保存しました');
  });
}

function setupCashForm() {
  document.getElementById('cashForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const amount = parseFloat(document.getElementById('cashAmount').value);
    const note = document.getElementById('cashNote').value.trim();
    if (!amount) return;
    state.cash += amount;
    state.cashAdjustments.push({ id: uid(), date: todayStr(), amount, note });
    saveState();
    document.getElementById('cashAmount').value = '';
    document.getElementById('cashNote').value = '';
    render();
    showToast('現金残高を更新しました');
  });
}

function setupDashboardActions() {
  document.getElementById('btnRecordSnapshot').addEventListener('click', () => {
    const today = todayStr();
    const value = totalAssets();
    const idx = state.netWorthHistory.findIndex(h => h.date === today);
    if (idx >= 0) state.netWorthHistory[idx].value = value;
    else state.netWorthHistory.push({ date: today, value });
    saveState();
    render();
    showToast('本日の資産を記録しました');
  });
}

function setupHoldingsActions() {
  document.getElementById('btnRefreshCrypto').addEventListener('click', () => fetchCryptoPrices(false));
  document.getElementById('btnRefreshStocks').addEventListener('click', () => fetchStockPrices(false));
}

function setupHistoryActions() {
  document.getElementById('historyFilter').addEventListener('change', renderHistory);
}

function setupSettingsActions() {
  document.getElementById('btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tousi-sim-backup-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  document.getElementById('btnImport').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(reader.result);
        if (!imported || typeof imported !== 'object' || !Array.isArray(imported.holdings)) {
          throw new Error('invalid format');
        }
        if (!confirm('現在のデータを上書きしてインポートします。よろしいですか？')) return;
        state = imported;
        saveState();
        render();
        showToast('データをインポートしました');
      } catch (err) {
        alert('インポートに失敗しました。ファイル形式を確認してください。');
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  });

  document.getElementById('btnReset').addEventListener('click', () => {
    if (!confirm('すべてのデータを削除します。この操作は取り消せません。よろしいですか？')) return;
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });
}

function setupModal() {
  document.getElementById('btnStartSetup').addEventListener('click', () => {
    const initCash = parseFloat(document.getElementById('initCash').value) || 0;
    state = defaultState(initCash);
    saveState();
    document.getElementById('setupModal').hidden = true;
    render();
  });
}

function init() {
  const loaded = loadState();
  setupTabs();
  setupTradeForm();
  setupGoalForm();
  setupCashForm();
  setupDashboardActions();
  setupHoldingsActions();
  setupHistoryActions();
  setupSettingsActions();
  setupModal();
  setupAiActions();
  setupApiKeyForm();

  if (loaded) {
    state = loaded;
    migrateState();
    render();
    if (state.ai.running) startAi();
  } else {
    document.getElementById('setupModal').hidden = false;
  }
}

document.addEventListener('DOMContentLoaded', init);
