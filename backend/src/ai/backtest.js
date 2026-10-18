// ─────────────────────────────────────────────────────────────────────────────
//  backtest.js — 模型回測 + R² 驗證
//
//  借用《計得精彩》第5章 p190-192 的 R² test 與第5章 p192 的告誡：
//  「測試 R² 時，不可以用一組數據同時做 parameter estimates 和 R² test」
//  故本模組嚴格分離：train 集估計比重，test 集計算 R²。
//
//  R² 公式（作者 p190）：
//    ln(R²) = mean( ln( P̂_win / (1/runners) ) )
//  公賠率基準 = 0.82 / odds；門檻 p191：0.151726 (1996-2001)、0.167331 (2003-04)
//  作者結論：要 > 0.17 才有長期盈利。
// ─────────────────────────────────────────────────────────────────────────────

const pool = require('../db/pool');
const {
  scoreHorse, winProbabilities, placeProbabilities, r2Test, clamp, adjRatio,
  blendWithMarket,
} = require('./factorlib');

// 馬季起點：9 月 1 日
function seasonStart(dateStr) {
  const d = new Date(dateStr);
  const y = d.getUTCMonth() >= 8 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-09-01`;
}

// ── 訓練：在 train 期間學出「因素比重」──────────────────────────────────────
// 用簡單的 logistic 座標下降 (Cox-like)。目標：最大化 R²（作者框架內的
// 最高似然近似），同時對系數做 L2 正則避免過擬合 (p186 警告 overfit)。
function trainWeights(trainRaces, opts = {}) {
  const { epochs = 120, lr = 0.35, l2 = 0.02, keys = null } = opts;
  const factorKeys = keys || [
    'classRel', 'ratingRel', 'ratingTrend', 'formRel', 'ageScore', 'firstRun',
    'restScore', 'streakRel', 'weightRel', 'weightRatioRel', 'declaredWeightRel',
    'declaredWeightDiffRel', 'jockeyRel', 'jockeyFormRel', 'jockeyCourseRel',
    'trainerRel', 'jtRel', 'drawRel', 'distRel', 'goingRel', 'classMoveRel',
    'gearRel', 'stableRel', 'paceRel', 'paceBiasRel', 'closingRel', 'speedFigRel', 'marketRel',
  ];

  // 展開成 (features, label) 樣本
  const X = [];
  const y = [];
  for (const race of trainRaces) {
    for (const h of race.horses) {
      const x = factorKeys.map(k => (h[k] == null || !isFinite(h[k])) ? 0 : h[k]);
      X.push(x);
      y.push(h.finish === 1 ? 1 : 0);
    }
  }
  if (!X.length) return { weights: {}, intercept: 0, iterations: 0, samples: 0, factorKeys };

  // 類別特徵做 one-hot (第一維)
  const D = factorKeys.length + 1;
  const XX = X.map(row => [1, ...row]); // 加 intercept

  const w = new Array(D).fill(0);
  w[0] = 0; // intercept

  const sigmoid = (z) => 1 / (1 + Math.exp(-z));
  const n = XX.length;

  for (let ep = 0; ep < epochs; ep++) {
    const grad = new Array(D).fill(0);
    for (let i = 0; i < n; i++) {
      let z = 0;
      for (let j = 0; j < D; j++) z += w[j] * XX[i][j];
      const p = sigmoid(z);
      const err = y[i] - p;
      for (let j = 0; j < D; j++) grad[j] += err * XX[i][j];
    }
    for (let j = 0; j < D; j++) {
      let g = grad[j] / n;
      if (j > 0) g += l2 * w[j];
      w[j] += lr * g;
    }
  }

  const weights = {};
  factorKeys.forEach((k, idx) => { weights[k] = +w[idx + 1].toFixed(4); });
  return { weights, intercept: +w[0].toFixed(4), iterations: epochs, samples: n, factorKeys };
}

// ── 推論：套用權重產生總分 ─────────────────────────────────────────────────
function applyWeights(race, model) {
  const w = model.weights;
  const keys = model.factorKeys;
  return race.horses.map(h => {
    let z = model.intercept;
    for (let i = 0; i < keys.length; i++) {
      const v = h[keys[i]];
      if (v == null || !isFinite(v)) continue;
      z += w[keys[i]] * v;
    }
    return z;
  });
}

// ── 主流程：R² 驗證 ─────────────────────────────────────────────────────────
// samplesProvider: async (dateStr) => race objects
async function validateR2(races, model, placeTo = 3) {
  const winSamples = [];
  const placeSamples = [];
  const perRace = [];

  for (const race of races) {
    if (!race.horses || race.horses.length < 4) continue;
    const totals = applyWeights(race, model);
    const scored = race.horses.map((h, i) => ({
      total: totals[i],
      runs: h.runs || 0,
      sigma: h.sigma || 5,
      finish: h.finish,
      name: h.name,
      odds: h.odds,
    }));
    const probs = blendWithMarket(winProbabilities(scored), scored.map(x => x.odds));
    const winnerIdx = race.horses.findIndex(h => h.finish === 1);
    if (winnerIdx < 0) continue;
    winSamples.push({ runners: race.horses.length, winnerProb: probs[winnerIdx] });

    // 位置 R²：冠軍必然入前3（結果=1），問題只係模型畀咗幾多機會佢入位
    const places = placeProbabilities(scored, placeTo);
    placeSamples.push({ runners: race.horses.length, winnerProb: places[winnerIdx] });

    perRace.push({
      date: race.date, raceNo: race.raceNo,
      runners: race.horses.length,
      winner: race.horses[winnerIdx].name,
      modelProb: +probs[winnerIdx].toFixed(4),
      marketProb: race.horses[winnerIdx].odds
        ? +(0.82 / race.horses[winnerIdx].odds).toFixed(4) : null,
    });
  }

  const modelR2 = r2Test(winSamples);

  // ── 公賠率基準：要同時用兩種口徑 ──
  //  (a) 書中口徑 0.82/odds（未正規化）→ 對應 p190-191 的 0.152/0.167/0.17
  //  (b) 正規化後 1/odds（總和=1）→ 與模型 R² 同一口徑，先係公平比較
  const marketSamplesRaw = [];
  const marketSamplesNorm = [];
  for (const race of races) {
    if (!race.horses || race.horses.length < 4) continue;
    const winnerIdx = race.horses.findIndex(h => h.finish === 1);
    if (winnerIdx < 0) continue;
    const o = race.horses[winnerIdx].odds;
    if (!o || o <= 1) continue;
    marketSamplesRaw.push({ runners: race.horses.length, winnerProb: 0.82 / o });
    const inv = race.horses.map(h => (h.odds ? 1 / h.odds : 0));
    const sum = inv.reduce((a, b) => a + b, 0) || 1;
    marketSamplesNorm.push({ runners: race.horses.length, winnerProb: inv[winnerIdx] / sum });
  }

  return {
    model: modelR2,
    marketRaw: r2Test(marketSamplesRaw),   // 書中口徑，對照 0.17 門檻
    market: r2Test(marketSamplesNorm),     // 同口徑對照模型
    place: r2Test(placeSamples),
    threshold: 0.17,
    marketBenchmark: 0.151726,
    perRace: perRace.slice(0, 50),
  };
}

// ── 建立訓練/測試 race objects（由 ai/routes.js 供數據）────────────────────
// race = { date, raceNo, horses: [{ name, finish, odds, features: {key: value} }] }
module.exports = { trainWeights, applyWeights, validateR2, seasonStart };
