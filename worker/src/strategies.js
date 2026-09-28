// Trading strategies shared by the live Worker and the weekly backtest
// (backtest/run.mjs), so the settings the backtest tunes are exactly the
// ones that trade.
//
// Every strategy looks at hourly closing prices and casts a vote:
// +1 (price should rise -> hold it), -1 (should fall -> stay out), 0 (no view).
// The ensemble weights each strategy by how well its votes have predicted
// the next hour's move (multiplicative weights / Hedge), and a "cash"
// pseudo-strategy that never votes sits at a fixed score of 0 -- so when
// every real strategy is doing worse than doing nothing, the ensemble's
// conviction shrinks and it stops opening positions.

export const BAR_MS = 60 * 60 * 1000;
export const MAX_BARS = 240; // 10 days of hourly bars
export const FEE_RATES = { crypto: 0.0015, stock: 0.001 }; // fee + spread, per side

export const STRATEGY_KEYS = ['momentum', 'maCross', 'rsi', 'bollinger', 'breakout'];

export const STRATEGY_INFO = {
  momentum: { name: 'モメンタム', kind: '順張り', desc: 'n時間前より上がっていれば買い' },
  maCross: { name: '移動平均クロス', kind: '順張り', desc: '短期平均が長期平均より上なら買い' },
  rsi: { name: 'RSI', kind: '逆張り', desc: '売られすぎで買い・買われすぎで売り' },
  bollinger: { name: 'ボリンジャーバンド', kind: '逆張り', desc: '平均から大きく下に外れたら買い' },
  breakout: { name: 'ブレイクアウト', kind: '順張り', desc: '直近の高値を更新したら買い' },
};

export const PARAM_GRID = {
  momentum: [{ n: 6 }, { n: 12 }, { n: 24 }, { n: 48 }],
  maCross: [{ fast: 6, slow: 24 }, { fast: 12, slow: 48 }, { fast: 24, slow: 72 }, { fast: 24, slow: 120 }],
  rsi: [{ period: 14, low: 25, high: 65 }, { period: 14, low: 30, high: 70 }, { period: 14, low: 35, high: 60 }, { period: 24, low: 30, high: 70 }],
  bollinger: [{ period: 20, k: 1.5 }, { period: 20, k: 2 }, { period: 48, k: 1.5 }, { period: 48, k: 2 }],
  breakout: [{ n: 24 }, { n: 48 }, { n: 72 }],
};

export const ENSEMBLE_GRID = {
  entry: [0.15, 0.25, 0.35],
  exit: [-0.15, -0.05, 0.05],
  stopLoss: [0.05, 0.08, 0.12],
  takeProfit: [0.1, 0.15, 0.25, 10],
};

export const DEFAULT_CONFIG = {
  source: 'default',
  generatedAt: null,
  params: {
    momentum: { n: 24 },
    maCross: { fast: 12, slow: 48 },
    rsi: { period: 14, low: 30, high: 70 },
    bollinger: { period: 20, k: 2 },
    breakout: { n: 48 },
  },
  ensemble: { entry: 0.25, exit: -0.05, stopLoss: 0.08, takeProfit: 0.15, positionFraction: 0.1 },
  learning: { decay: 0.9995, eta: 4 },
  priorScores: {},
  report: null,
};

// Bars needed before every strategy in PARAM_GRID can vote, plus one more
// so the previous bar's votes can be scored against what happened next.
export const MIN_BARS = 122;

function mean(c, end, n) {
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) s += c[i];
  return s / n;
}

// Votes using closes[0..end] only (end = index of the latest completed bar).
function voteMomentum(c, end, { n }) {
  if (end - n < 0) return 0;
  const roc = c[end] / c[end - n] - 1;
  return roc > 0.002 ? 1 : roc < -0.002 ? -1 : 0;
}

function voteMaCross(c, end, { fast, slow }) {
  if (end + 1 < slow) return 0;
  return mean(c, end, fast) > mean(c, end, slow) ? 1 : -1;
}

function voteRsi(c, end, { period, low, high }) {
  if (end - period < 0) return 0;
  let gain = 0, loss = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const d = c[i] - c[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  const rsi = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  return rsi < low ? 1 : rsi > high ? -1 : 0;
}

function voteBollinger(c, end, { period, k }) {
  if (end + 1 < period) return 0;
  const m = mean(c, end, period);
  let v = 0;
  for (let i = end - period + 1; i <= end; i++) v += (c[i] - m) ** 2;
  const sd = Math.sqrt(v / period);
  if (sd === 0) return 0;
  const z = (c[end] - m) / sd;
  return z < -k ? 1 : z > k ? -1 : 0;
}

function voteBreakout(c, end, { n }) {
  if (end - n < 0) return 0;
  let hi = -Infinity, lo = Infinity;
  for (let i = end - n; i < end; i++) { if (c[i] > hi) hi = c[i]; if (c[i] < lo) lo = c[i]; }
  return c[end] > hi ? 1 : c[end] < lo ? -1 : 0;
}

const VOTERS = { momentum: voteMomentum, maCross: voteMaCross, rsi: voteRsi, bollinger: voteBollinger, breakout: voteBreakout };

export function strategyVote(key, closes, end, params) {
  return VOTERS[key](closes, end, params);
}

export function strategyVotes(closes, end, params) {
  const out = {};
  STRATEGY_KEYS.forEach(k => { out[k] = VOTERS[k](closes, end, params[k]); });
  return out;
}

export function strategyWeights(scores, eta) {
  const raw = {};
  let total = 1; // the cash pseudo-strategy: score 0 -> exp(0) = 1
  STRATEGY_KEYS.forEach(k => {
    const s = Math.max(-20, Math.min(20, eta * (scores[k] || 0)));
    raw[k] = Math.exp(s);
    total += raw[k];
  });
  const weights = {};
  STRATEGY_KEYS.forEach(k => { weights[k] = raw[k] / total; });
  weights.cash = 1 / total;
  return weights;
}

export function ensembleScore(votes, weights) {
  return STRATEGY_KEYS.reduce((s, k) => s + weights[k] * (votes[k] || 0), 0);
}

// Credit each strategy with vote * realized return of the bar that followed.
export function updateScores(scores, votes, ret, decay) {
  STRATEGY_KEYS.forEach(k => { scores[k] = (scores[k] || 0) * decay + (votes[k] || 0) * ret; });
}

// `score` is null between hourly bars: only stop-loss / take-profit apply then.
export function decide({ score, held, price, avgCost, ensemble }) {
  if (held) {
    const change = price / avgCost - 1;
    if (change <= -ensemble.stopLoss) return { action: 'sell', reason: 'stopLoss', change };
    if (change >= ensemble.takeProfit) return { action: 'sell', reason: 'takeProfit', change };
    if (score != null && score <= ensemble.exit) return { action: 'sell', reason: 'signal', change };
    return { action: 'hold' };
  }
  if (score != null && score >= ensemble.entry) return { action: 'buy', reason: 'signal' };
  return { action: 'hold' };
}

export function sameParams(a, b) {
  return JSON.stringify(a || {}) === JSON.stringify(b || {});
}
