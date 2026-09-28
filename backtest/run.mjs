// Weekly backtest: replays the last 90 days of hourly crypto prices through
// the same strategies the live Worker trades with (worker/src/strategies.js),
// picks the best settings on the first 60 days, and checks them on the last
// 30 days they never saw. The new settings only replace the current ones if
// they also did at least as well on those unseen 30 days -- a guard against
// settings that merely memorized the past.
//
// Output: backtest/results/config.json, which the Worker pulls from GitHub.
// Run locally with `node backtest/run.mjs` (COINGECKO_API_KEY optional).

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import {
  BAR_MS, MIN_BARS, FEE_RATES, STRATEGY_KEYS, PARAM_GRID, ENSEMBLE_GRID, DEFAULT_CONFIG,
  strategyVote, strategyVotes, strategyWeights, ensembleScore, updateScores, decide, sameParams,
} from '../worker/src/strategies.js';

const WORKER_URL = process.env.WORKER_URL || 'https://tousi-ai-worker.rtsuki1030.workers.dev';
const CG_KEY = process.env.COINGECKO_API_KEY || '';
const RESULTS_DIR = new URL('./results/', import.meta.url);
const CONFIG_FILE = new URL('./config.json', RESULTS_DIR);
const HISTORY_FILE = new URL('./history.jsonl', RESULTS_DIR);
const DAYS = 90;
const TOP_N = 20;
const MAX_COINS = 30;
const FEE = FEE_RATES.crypto;
// Stablecoins and wrapped/staked copies of other coins add nothing to learn from.
const SKIP_ID = /usd|tether|dai$|wrapped|staked|steth|weth|wbtc|cbbtc|bridged|restaked|binance-peg/;
// The keyless public API throttles to a few calls a minute in practice.
const PACE_MS = CG_KEY ? 2500 : 15000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function coingecko(path) {
  const headers = { 'User-Agent': 'tousi-backtest/1.0', accept: 'application/json' };
  if (CG_KEY) headers['x-cg-demo-api-key'] = CG_KEY;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://api.coingecko.com/api/v3${path}`, { headers });
    if (res.status === 429) { console.log('  rate limited, waiting 60s'); await sleep(60000); continue; }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`${path}: still rate limited`);
}

async function loadCurrentConfig() {
  try { return JSON.parse(await readFile(CONFIG_FILE, 'utf8')); } catch (e) { return DEFAULT_CONFIG; }
}

async function pickCoins() {
  const coins = [];
  const seen = new Set();
  const add = (symbol, id) => {
    if (!id || seen.has(id) || coins.length >= MAX_COINS) return;
    seen.add(id);
    coins.push({ symbol: symbol.toUpperCase(), id });
  };
  // Coins the live AI is holding or watching come first.
  try {
    const state = await (await fetch(`${WORKER_URL}/api/state`)).json();
    Object.entries(state.cryptoIds || {}).forEach(([symbol, id]) => add(symbol, id));
  } catch (e) { console.log('could not read live state:', e.message); }
  const markets = await coingecko('/coins/markets?vs_currency=jpy&order=market_cap_desc&per_page=50&page=1');
  markets.filter(m => !SKIP_ID.test(m.id)).slice(0, TOP_N).forEach(m => add(m.symbol, m.id));
  return coins;
}

async function loadSeries(coins) {
  const series = [];
  for (const coin of coins) {
    await sleep(PACE_MS);
    try {
      const data = await coingecko(`/coins/${encodeURIComponent(coin.id)}/market_chart?vs_currency=jpy&days=${DAYS}`);
      const byHour = new Map();
      (data.prices || []).forEach(([t, p]) => { if (p > 0) byHour.set(Math.floor(t / BAR_MS), p); });
      const hours = [...byHour.keys()].sort((a, b) => a - b);
      if (hours.length < MIN_BARS + 48) { console.log(`  ${coin.symbol}: not enough history, skipped`); continue; }
      const lo = Math.min(...byHour.values()), hi = Math.max(...byHour.values());
      if (hi / lo < 1.03) { console.log(`  ${coin.symbol}: price barely moves (stablecoin?), skipped`); continue; }
      series.push({ ...coin, byHour, firstHour: hours[0], lastHour: hours[hours.length - 1] });
      console.log(`  ${coin.symbol}: ${hours.length} hourly bars`);
    } catch (e) {
      console.log(`  ${coin.symbol}: ${e.message}`);
    }
  }
  return series;
}

// Put every coin on one shared hourly clock, carrying the last price forward over gaps.
function alignSeries(series) {
  const h0 = Math.min(...series.map(s => s.firstHour));
  const h1 = Math.max(...series.map(s => s.lastHour));
  const T = h1 - h0 + 1;
  const coins = series.map(s => {
    const off = s.firstHour - h0;
    const c = new Float64Array(T - off);
    let last = s.byHour.get(s.firstHour);
    for (let i = 0; i < c.length; i++) {
      const p = s.byHour.get(s.firstHour + i);
      if (p != null) last = p;
      c[i] = last;
    }
    return { symbol: s.symbol, id: s.id, off, c };
  });
  return { coins, T, h0 };
}

// One strategy trading one coin on its own: in on +1, out on -1, fees on each switch.
function standaloneLogReturn(coin, key, params, t0, t1) {
  let inPos = false, lr = 0;
  const from = Math.max(t0, coin.off + MIN_BARS);
  for (let t = from; t < t1; t++) {
    const i = t - coin.off;
    const v = strategyVote(key, coin.c, i, params);
    if (v === 1 && !inPos) { inPos = true; lr += Math.log(1 - FEE); }
    else if (v === -1 && inPos) { inPos = false; lr += Math.log(1 - FEE); }
    if (inPos) lr += Math.log(coin.c[i + 1] / coin.c[i]);
  }
  return lr;
}

function meanStandalone(coins, key, params, t0, t1) {
  const usable = coins.filter(c => c.off + MIN_BARS < t1 - 24);
  const total = usable.reduce((s, c) => s + standaloneLogReturn(c, key, params, t0, t1), 0);
  return usable.length ? Math.exp(total / usable.length) - 1 : 0;
}

// Runs the online learning exactly as the live Worker does bar by bar, and
// records each coin's ensemble score at every hour (NaN = not enough data).
function ensembleTimeline(coins, T, params, learning) {
  const scores = {};
  const timeline = coins.map(() => new Float64Array(T).fill(NaN));
  const prevVotes = coins.map(() => null);
  for (let t = 0; t < T; t++) {
    const votesNow = coins.map(coin => {
      const i = t - coin.off;
      return i >= MIN_BARS - 1 && i < coin.c.length ? strategyVotes(coin.c, i, params) : null;
    });
    coins.forEach((coin, ci) => {
      const i = t - coin.off;
      if (i >= MIN_BARS && i < coin.c.length && prevVotes[ci]) {
        updateScores(scores, prevVotes[ci], coin.c[i] / coin.c[i - 1] - 1, learning.decay);
      }
    });
    const weights = strategyWeights(scores, learning.eta);
    coins.forEach((coin, ci) => {
      const i = t - coin.off;
      if (i >= MIN_BARS && votesNow[ci]) timeline[ci][t] = ensembleScore(votesNow[ci], weights);
    });
    votesNow.forEach((v, ci) => { prevVotes[ci] = v; });
  }
  return { timeline, finalScores: scores };
}

function simulate(coins, timeline, ensemble, t0, t1) {
  let cash = 1, peak = 1, maxDD = 0, trades = 0, closed = 0, wins = 0;
  const pos = new Map();
  const price = (ci, t) => { const i = t - coins[ci].off; return i >= 0 ? coins[ci].c[Math.min(i, coins[ci].c.length - 1)] : NaN; };
  const equityAt = t => cash + [...pos].reduce((s, [ci, p]) => s + p.qty * price(ci, t), 0);
  for (let t = t0; t <= t1; t++) {
    for (const [ci, p] of [...pos]) {
      const px = price(ci, t);
      const s = timeline[ci][t];
      const d = decide({ score: Number.isNaN(s) ? null : s, held: true, price: px, avgCost: p.avg, ensemble });
      if (d.action === 'sell') {
        cash += p.qty * px * (1 - FEE);
        if (px * (1 - FEE) > p.avg) wins++;
        closed++; trades++;
        pos.delete(ci);
      }
    }
    const equity = equityAt(t);
    const candidates = coins.map((_, ci) => ci)
      .filter(ci => !pos.has(ci) && !Number.isNaN(timeline[ci][t]))
      .filter(ci => decide({ score: timeline[ci][t], held: false, ensemble }).action === 'buy')
      .sort((a, b) => timeline[b][t] - timeline[a][t]);
    for (const ci of candidates) {
      const budget = Math.min(ensemble.positionFraction * equity, cash);
      if (budget < 0.01 * equity) break;
      const px = price(ci, t);
      pos.set(ci, { qty: budget / (px * (1 + FEE)), avg: px * (1 + FEE) });
      cash -= budget;
      trades++;
    }
    const after = equityAt(t);
    peak = Math.max(peak, after);
    maxDD = Math.max(maxDD, 1 - after / peak);
  }
  const ret = equityAt(t1) - 1;
  return { ret, maxDD, trades, winRate: closed ? wins / closed : null, objective: ret - 0.5 * maxDD };
}

function buyAndHold(coins, t0, t1) {
  const live = coins.filter(c => t0 - c.off >= 0);
  let peak = 1, maxDD = 0, ret = 0;
  for (let t = t0; t <= t1; t++) {
    const v = live.reduce((s, c) => s + c.c[Math.min(t - c.off, c.c.length - 1)] / c.c[t0 - c.off], 0) / live.length * (1 - FEE) * (1 - FEE);
    peak = Math.max(peak, v);
    maxDD = Math.max(maxDD, 1 - v / peak);
    ret = v - 1;
  }
  return { ret, maxDD };
}

function round(obj) {
  return JSON.parse(JSON.stringify(obj, (k, v) => (typeof v === 'number' ? +v.toPrecision(6) : v)));
}

async function main() {
  const current = await loadCurrentConfig();
  console.log(`current settings: ${current.source} (${current.generatedAt || 'never backtested'})`);

  console.log('choosing coins...');
  const picked = await pickCoins();
  console.log(`loading ${DAYS} days of hourly prices for ${picked.length} coins...`);
  const series = await loadSeries(picked);
  if (series.length < 5) throw new Error(`only ${series.length} coins loaded; not enough to backtest`);
  const { coins, T, h0 } = alignSeries(series);
  const trainEnd = Math.floor(T * 2 / 3);
  const start = Math.min(...coins.map(c => c.off)) + MIN_BARS;
  const iso = t => new Date((h0 + t) * BAR_MS).toISOString();
  console.log(`train ${iso(start)} .. ${iso(trainEnd)}, test .. ${iso(T - 1)}`);

  console.log('tuning each strategy on the training period...');
  const params = {};
  const strategies = STRATEGY_KEYS.map(key => {
    let best = null;
    PARAM_GRID[key].forEach(p => {
      const r = meanStandalone(coins, key, p, start, trainEnd);
      if (!best || r > best.r) best = { p, r };
    });
    params[key] = best.p;
    const testRet = meanStandalone(coins, key, best.p, trainEnd, T - 1);
    console.log(`  ${key}: ${JSON.stringify(best.p)} train ${(best.r * 100).toFixed(2)}% test ${(testRet * 100).toFixed(2)}%`);
    return { key, params: best.p, trainRet: best.r, testRet };
  });

  console.log('tuning buy/sell thresholds on the training period...');
  const learning = DEFAULT_CONFIG.learning;
  const { timeline, finalScores } = ensembleTimeline(coins, T, params, learning);
  let bestEnsemble = null;
  for (const entry of ENSEMBLE_GRID.entry)
    for (const exit of ENSEMBLE_GRID.exit)
      for (const stopLoss of ENSEMBLE_GRID.stopLoss)
        for (const takeProfit of ENSEMBLE_GRID.takeProfit) {
          const ensemble = { entry, exit, stopLoss, takeProfit, positionFraction: DEFAULT_CONFIG.ensemble.positionFraction };
          const r = simulate(coins, timeline, ensemble, start, trainEnd);
          if (!bestEnsemble || r.objective > bestEnsemble.r.objective) bestEnsemble = { ensemble, r };
        }
  console.log(`  best: ${JSON.stringify(bestEnsemble.ensemble)}`);

  console.log('checking on the unseen test period...');
  const chosenTest = simulate(coins, timeline, bestEnsemble.ensemble, trainEnd, T - 1);
  const currentRun = sameParams(current.params, params) ? { timeline } : ensembleTimeline(coins, T, current.params, current.learning || learning);
  const currentTest = simulate(coins, currentRun.timeline, current.ensemble, trainEnd, T - 1);
  const hold = buyAndHold(coins, trainEnd, T - 1);
  const adopted = chosenTest.objective >= currentTest.objective;
  const pct = x => `${(x * 100).toFixed(2)}%`;
  console.log(`  new settings:     ${pct(chosenTest.ret)} (max drawdown ${pct(chosenTest.maxDD)})`);
  console.log(`  current settings: ${pct(currentTest.ret)} (max drawdown ${pct(currentTest.maxDD)})`);
  console.log(`  buy & hold:       ${pct(hold.ret)} (max drawdown ${pct(hold.maxDD)})`);
  console.log(adopted ? 'adopting the new settings' : 'keeping the current settings (new ones did worse on unseen data)');

  const now = new Date().toISOString();
  const report = round({
    generatedAt: now,
    adopted,
    dataFrom: iso(start), trainEnd: iso(trainEnd), dataTo: iso(T - 1),
    coins: coins.map(c => c.symbol),
    train: { chosen: bestEnsemble.r },
    test: { chosen: chosenTest, previous: currentTest, buyHold: hold },
    strategies,
  });
  const next = adopted
    ? { source: 'backtest', generatedAt: now, adoptedAt: now, params, ensemble: bestEnsemble.ensemble, learning, priorScores: round(finalScores), report }
    : { ...current, generatedAt: now, report };

  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n');
  await appendFile(HISTORY_FILE, JSON.stringify({
    at: now, adopted, coins: coins.length,
    testNew: report.test.chosen.ret, testPrev: report.test.previous.ret, testHold: report.test.buyHold.ret,
  }) + '\n');
  console.log('wrote backtest/results/config.json');
}

main().catch(e => { console.error(e); process.exit(1); });
