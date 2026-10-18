// ─────────────────────────────────────────────────────────────────────────────
//  factorlib.js — 選馬因素庫 (Factor Library)
//
//  設計原則源自《計得精彩 / Precision》
//  1. 每個因素輸出「馬位」(lengths) 單位，並指定該因素的「最大影響幅度」(比重)
//     — 避免次要因素喧賓奪主 (第5章 p160)
//  2. 必須做「全場估計」：所有因素都以「相對同場其他馬」定位
//     — 有全班次高低/對手強度等全場性因素 (第5章 p153)
//  3. 變數要轉化：賠率→倒數→log；出賽次數→√Runs、√Runs×√Day (p178-186)
//  4. 警惕共線性：賠率 vs 騎師 (p186)
// ─────────────────────────────────────────────────────────────────────────────

// 數學工具 ────────────────────────────────────────────────────────────────────
const erf = (x) => {
  // Abramowitz & Stegun 7.1.26
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
            - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
};
const normCdf = (x, mu = 0, sigma = 1) => 0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2)));
const normPdf = (x, mu = 0, sigma = 1) =>
  Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma)) / (sigma * Math.sqrt(2 * Math.PI));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// 把 raw 映射到 [-1, 1]，再乘上該因素最大影響幅度 → 馬位
const scale = (raw, maxLen) => clamp(raw, -1, 1) * maxLen;

// 市場因素倍率（實驗用）：lnOddR 係全書最強單一變數，但 26 個因素平權時
// 只佔總分 ~10%，令模型喺冷門上嚴重脫離市場。用 MARKET_MULT 放大市場因素，
// 由 scripts/tune_temp.js 掃描揾最啱倍數。
const MARKET_MULT = (() => {
  const v = Number(process.env.MARKET_MULT);
  return Number.isFinite(v) && v > 0 ? v : 12;
})();

// Ainslie (1968) 磅/馬位換算 — 作者指出高估了負磅影響，實際要除以 ~2.4
// <1200m: 4磅=1馬位；1600m: 3磅=1馬位；1800m: 2磅；2000m: 1磅
// 作者實測: 1000m 需 10 磅 = 1 馬位；2000m 需 7 磅 = 1 馬位
function lbsPerLength(distance) {
  if (!distance) return 7;
  if (distance < 1200) return 10;
  if (distance < 1500) return 8;
  if (distance < 1700) return 7;
  if (distance < 1900) return 6;
  return 7;
}

// 調整後比率 (3冠+2亞+1季)/出賽 — 第4章 p139-140
function adjRatio(wins, seconds, thirds, runs) {
  if (!runs) return null;
  return (3 * wins + 2 * seconds + 1 * thirds) / runs;
}

// RRR (recency-weighted rating) — 以 decay 對歷史成績做指數加權
function recencyWeight(daysBack, halfLife = 180) {
  return Math.pow(0.5, daysBack / halfLife);
}

// ── 因素定義表 ────────────────────────────────────────────────────────────────
// maxLength = 該因素在最有利 vs 最不利情況下，最多可產生多少馬位差距
// group     = UI 分組
// bookRef   = 書中出處（用於頁面顯示）
const FACTORS = [
  // ── 組 1：馬匹本身實力 ────────────────────────────────────────────────────
  {
    key: 'class', label: '班次', group: '馬匹實力', maxLength: 6, bookRef: 'p67-68 班次分析',
    desc: '馬匹所處班次層級。須按評分區間修正，不能單看班次標籤。',
  },
  {
    key: 'rating', label: '現時評分', group: '馬匹實力', maxLength: 6, bookRef: 'p28 選馬因素',
    desc: '馬會官方評分，已包含班次/負磅平衡，係全場實力基準。',
  },
  {
    key: 'ratingChange', label: '評分走勢', group: '馬匹實力', maxLength: 2, bookRef: 'p28 選馬因素',
    desc: '近期升評代表進步，降評代表退步。',
  },
  {
    key: 'form', label: '近績形', group: '馬匹實力', maxLength: 5, bookRef: 'p60-63 名次/勝負距離分析',
    desc: '日數加權名次 (recency-weighted rank)，路程/場地不合的賽績剔除。',
  },
  {
    key: 'age', label: '馬齡', group: '馬匹實力', maxLength: 2, bookRef: 'p78-81 負磅/分齡磅',
    desc: '年輕馬進步空間大但未成熟；需配合分齡磅表理解。',
  },
  {
    key: 'firstRun', label: '首次出賽', group: '馬匹實力', maxLength: 4, bookRef: 'p95 血統第3點',
    desc: '初出馬靠血統+晨操，往績無參考價值。負向調整。',
  },
  {
    key: 'longRest', label: '休賽日', group: '馬匹實力', maxLength: 3, bookRef: 'p178 LongRest',
    desc: '長時間休息 (>90日) 狀態下滑；短時間 (<14日) 未回氣。',
  },
  {
    key: 'recentStreak', label: '連續名次走勢', group: '馬匹實力', maxLength: 2, bookRef: 'p64-66 往績特徵',
    desc: '近期名次逐場遞改善/遞差異的趨勢。',
  },

  // ── 組 2：負磅（作者：必須配馬體重 + 距離）────────────────────────────────
  {
    key: 'weight', label: '負磅', group: '負磅/體重', maxLength: 4, bookRef: 'p77-81 負磅',
    desc: '作者實測影響遠小於外界認為。以 Ainslie 換算再打折，並考慮距離。',
  },
  {
    key: 'weightRatio', label: '負磅/馬體重比', group: '負磅/體重', maxLength: 4, bookRef: 'p78 WeightRatio',
    desc: '馬體重越輕，加磅殺傷力越大。作者研究中最關鍵的負磅衍生變數。',
  },
  {
    key: 'horseWeight', label: '排位體重', group: '負磅/體重', maxLength: 3, bookRef: 'p78 HorseWeight',
    desc: '體重大跌 (>20磅) 通常代表狀態回落或馬主讓重。',
  },
  {
    key: 'weightChange', label: '體重變化', group: '負磅/體重', maxLength: 2, bookRef: 'p64 往績特徵',
    desc: '較上仗體重變動方向。',
  },

  // ── 組 3：騎師/馬師（作者：預測力高於馬匹自身近績）────────────────────
  {
    key: 'jockey', label: '騎師實力', group: '騎師/馬師', maxLength: 6, bookRef: 'p86-90 騎師因素',
    desc: '調整後上名率 + 當日狀態。作者強調騎師的場地/路程/走位特性比馬匹同程成績更有預測力。',
  },
  {
    key: 'jockeyForm', label: '騎師近期狀態', group: '騎師/馬師', maxLength: 3, bookRef: 'p104 公對騎師的估計',
    desc: '近 30 日騎師表現 vs 其長期水準的偏離。',
  },
  {
    key: 'jockeyCourse', label: '騎師場地/路程適應', group: '騎師/馬師', maxLength: 3, bookRef: 'p86 騎師分析',
    desc: '該騎師在同馬場/同路程的調整後比率。',
  },
  {
    key: 'trainer', label: '馬師實力', group: '騎師/馬師', maxLength: 5, bookRef: 'p89-90 馬師分析',
    desc: '馬師流動性低，研究一次可用一年，比騎師更值得深挖。',
  },
  {
    key: 'jockeyTrainer', label: '騎練合作', group: '騎師/馬師', maxLength: 3, bookRef: 'p178 JTrainP',
    desc: '該騎師配該馬師的合作成績。',
  },

  // ── 組 4：排位/場地/形勢 ──────────────────────────────────────────────────
  {
    key: 'draw', label: '檔位', group: '排位/形勢', maxLength: 4, bookRef: 'p115-116 公對排位影響',
    desc: '內檔通常有利。已用加權平均線平滑 (bandwidth=2, 4-2-1) 去除隨機噪音。',
  },
  {
    key: 'distance', label: '路程適應', group: '排位/形勢', maxLength: 4, bookRef: 'p82 距離適應性',
    desc: '作者研究：馬匹「死路程」是假的，但真實的距離適應仍有統計意義（小幅）。',
  },
  {
    key: 'trackGoing', label: '場地/泥草適應', group: '排位/形勢', maxLength: 4, bookRef: 'p82 泥地成績',
    desc: '作者唯一證實有預測力的「馬匹特徵」：泥地馬跑草地會大打折扣。',
  },
  {
    key: 'classMove', label: '升降班', group: '排位/形勢', maxLength: 3, bookRef: 'p67 班次分析',
    desc: '升班/降班。降班加磅跑屬有利訊號。',
  },
  {
    key: 'gear', label: '配備變動', group: '排位/形勢', maxLength: 3, bookRef: 'p28-29 配備變動',
    desc: '初戴眼罩/holm/iron 等。需用數據驗證方向與幅度。',
  },
  {
    key: 'stableMove', label: '轉馬房', group: '排位/形勢', maxLength: 3, bookRef: 'p115 轉倉馬',
    desc: '轉倉初出 vs 已轉倉復出。',
  },
  {
    key: 'pace', label: '走位前置度', group: '排位/形勢', maxLength: 2, bookRef: 'p54-56 段速分析',
    desc: '近 8 仗首段走位加權平均（真實走位，取自分段時間），同場正規化：+1 = 全場最前置。',
  },
  {
    key: 'horseWeightTrend', label: '步速契合度', group: '排位/形勢', maxLength: 3, bookRef: 'p57-59 反勢',
    desc: '此馬跑法（前領/前速/均速/後追）與同場預計步速嘅契合度：快步速利後追、慢步速利前領。',
  },
  {
    key: 'closing', label: '後勁指數', group: '排位/形勢', maxLength: 4, bookRef: 'p54-56 段速分析',
    desc: '近 8 仗末段時間 vs 全場中位數（加權平均），同場正規化：+1 = 全場末段最勁。2026-09 回測 r=-0.288（p<0.001），全庫最強單因素。',
  },
  {
    key: 'speedfig', label: '速度圖數', group: '馬匹實力', maxLength: 5, bookRef: 'Beyer 第7-9章',
    desc: '港版 Beyer 速度圖：每仗時間 vs 馬會班次標準（含每日場地偏差修正），近 6 仗加權，同場正規化。2026-09 回測 r=-0.163（p<0.01）。',
  },

  // ── 組 5：市場資訊（最強單一因素，但要防共線）─────────────────────────────
  {
    key: 'market', label: '市場預期 (LnOddR)', group: '市場資訊', maxLength: 10, bookRef: 'p178-186 LnOddR',
    desc: 'log(1/賠率)。全書最強單一變數。⚠️ 與騎師實力高度共線，兩者同時用需留意。',
  },
];

const FACTOR_MAP = Object.fromEntries(FACTORS.map(f => [f.key, f]));
const FACTOR_GROUPS = [...new Set(FACTORS.map(f => f.group))];

// 因素 key（對外 API 用）→ features.js 特徵 key（/r2 logistic 訓練用）
// 與 scoreHorse 內 add(key, F.xxx) 一一對應
const FACTOR_TO_FEATURE = {
  class: 'classRel', rating: 'ratingRel', ratingChange: 'ratingTrend',
  form: 'formRel', age: 'ageScore', firstRun: 'firstRun',
  longRest: 'restScore', recentStreak: 'streakRel',
  weight: 'weightRel', weightRatio: 'weightRatioRel',
  horseWeight: 'declaredWeightRel', weightChange: 'declaredWeightDiffRel',
  jockey: 'jockeyRel', jockeyForm: 'jockeyFormRel', jockeyCourse: 'jockeyCourseRel',
  trainer: 'trainerRel', jockeyTrainer: 'jtRel',
  draw: 'drawRel', distance: 'distRel', trackGoing: 'goingRel',
  classMove: 'classMoveRel', gear: 'gearRel', stableMove: 'stableRel',
  pace: 'paceRel', horseWeightTrend: 'paceBiasRel', market: 'marketRel', closing: 'closingRel',
  speedfig: 'speedFigRel',
};

// ── L1 評分引擎 ──────────────────────────────────────────────────────────────
// input: 每匹馬的 feature bundle (見 ai/routes.js buildFeatureBundle)
// opts.enabled: Set<factorKey> — 因素剔選；唔喺 set 入面嘅因素計 0 分
//               並喺 parts 標 disabled: true（前端灰顯）
// 輸出: { total, parts: [{key,label,score,maxLength,raw,detail,disabled?}] }
function scoreHorse(F, opts) {
  const parts = [];
  const enabled = opts && opts.enabled instanceof Set ? opts.enabled : null;
  const add = (key, raw, detail) => {
    const def = FACTOR_MAP[key];
    if (!def) return;
    if (enabled && !enabled.has(key)) {
      parts.push({ key, label: def.label, score: 0, maxLength: def.maxLength, raw: null, detail: '已剔選略過', disabled: true });
      return;
    }
    if (raw == null || !isFinite(raw)) {
      parts.push({ key, label: def.label, score: 0, maxLength: def.maxLength, raw: null, detail: detail || '數據不足' });
      return;
    }
    const score = scale(raw, def.maxLength * (key === 'market' ? MARKET_MULT : 1));
    parts.push({ key, label: def.label, score: +score.toFixed(2), maxLength: def.maxLength, raw: +raw.toFixed(3), detail });
  };

  // features.js 已把所有特徵轉成 [-1,1]（含全場正規化），scoreHorse 只需
  // 按各因素 maxLength 縮放成「馬位」。此處不再做二次運算，避免雙重加權。
  // 「全場性」因素（班次/評分/近績/檔位/賠率/騎師）已由 features.js 以
  // 同場正規化完成，符合《計得精彩》p153「全場估計」原則。
  add('class', F.classRel, F.classLabel);
  add('rating', F.ratingRel, F.ratingLabel);
  add('ratingChange', F.ratingTrend, F.ratingTrendLabel);
  add('form', F.formRel, F.formLabel);
  add('age', F.ageScore, F.ageLabel);
  add('firstRun', F.firstRun, F.firstRun < 0 ? '首次出賽（無往績）' : '已有往績');
  add('longRest', F.restScore, F.restLabel);
  add('recentStreak', F.streakRel, F.streakLabel);

  add('weight', F.weightRel, F.weightLabel);
  add('weightRatio', F.weightRatioRel, F.weightRatioLabel);
  add('horseWeight', F.declaredWeightRel, F.declaredWeightLabel);
  add('weightChange', F.declaredWeightDiffRel, F.declaredWeightDiffLabel);

  add('jockey', F.jockeyRel, F.jockeyLabel);
  add('jockeyForm', F.jockeyFormRel, F.jockeyFormLabel);
  add('jockeyCourse', F.jockeyCourseRel, F.jockeyCourseLabel);
  add('trainer', F.trainerRel, F.trainerLabel);
  add('jockeyTrainer', F.jtRel, F.jtLabel);

  add('draw', F.drawRel, F.drawLabel);
  add('distance', F.distRel, F.distLabel);
  add('trackGoing', F.goingRel, F.goingLabel);
  add('classMove', F.classMoveRel, F.classMoveLabel);
  add('gear', F.gearRel, F.gearLabel);
  add('stableMove', F.stableRel, F.stableLabel);
  add('pace', F.paceRel, F.paceLabel);
  add('closing', F.closingRel, F.closingLabel);
  add('speedfig', F.speedFigRel, F.speedFigLabel);
  add('horseWeightTrend', F.paceBiasRel, F.paceBiasLabel);

  add('market', F.marketRel,
    F.lnOddR != null ? `賠率 ${F.odds}（LnOddR ${F.lnOddR.toFixed(3)}）` : null);

  const total = parts.reduce((s, p) => s + p.score, 0);
  return { total: +total.toFixed(2), parts };
}

// ── L2 機會率引擎：正態分布 ─────────────────────────────────────────────────
// 第5章：總分 → 正態分布 → 勝出機會率
// 假設每匹馬表現 ~ N(μ_i, σ_i)，機會率為其密度佔全場的比例（以數值積分）
// μ = 該馬總分；σ = 穩定性（標準差）。σ 大 = 爆發力強 = 對勝出率有正面貢獻
// ── L2 機會率引擎：正態分布 ─────────────────────────────────────────────────
// 《計得精彩》第5-6章：每匹馬表現 ~ N(μ_i, σ_i)
//   μ = 該馬因素總分（經溫度校準）
//   σ = 估計不確定性（見 calibrateSigmas）
// 勝出率 = ∫ f_i(x) · Π_{j≠i} P(V_j ≤ x) dx = P(V_i 為全場最大)
function winProbabilities(horses, k = SIGMA_K) {
  const n = horses.length;
  if (n === 0) return [];
  const mus = horses.map(h => h.total);
  const sigmas = calibrateSigmas(mus, horses.map(h => horseUncertainty(h)), k);
  const out = horses.map(() => 0);

  const GRID = 500;
  const sMax = Math.max(...sigmas);
  const lo = Math.min(...mus) - 5 * sMax;
  const hi = Math.max(...mus) + 5 * sMax;
  const step = (hi - lo) / GRID;

  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let g = 0; g <= GRID; g++) {
      const x = lo + g * step;
      let p = normPdf(x, mus[i], sigmas[i]);
      if (p <= 0) continue;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        p *= normCdf(x, mus[j], sigmas[j]);
      }
      acc += p * step;
    }
    out[i] = acc;
  }
  const s = out.reduce((a, b) => a + b, 0) || 1;
  return out.map(p => +(p / s).toFixed(6));
}

// ── 位置機會率：正態分布法（第6章 p198-200，作者否定 Harville）──────────
// P(i 入前 k) = ∫ f_i(v) · P(至多 k-1 匹其他馬快過 v) dv
// 所有 i 的總和 = k，因此用 k 作正規化（不是 1）。
function placeProbabilities(horses, placeTo, k = SIGMA_K) {
  const n = horses.length;
  if (n === 0) return [];
  const kp = Math.min(placeTo, n);
  const mus = horses.map(h => h.total);
  const sigmas = calibrateSigmas(mus, horses.map(h => horseUncertainty(h)), k);
  const out = horses.map(() => 0);

  const GRID = 500;
  const sMax = Math.max(...sigmas);
  const lo = Math.min(...mus) - 5 * sMax;
  const hi = Math.max(...mus) + 5 * sMax;
  const step = (hi - lo) / GRID;

  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let g = 0; g <= GRID; g++) {
      const v = lo + g * step;
      const f = normPdf(v, mus[i], sigmas[i]);
      if (f <= 0) continue;
      const probs = [];
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        probs.push(1 - normCdf(v, mus[j], sigmas[j]));
      }
      acc += f * poissonBinomialCdf(probs, kp - 1) * step;
    }
    out[i] = acc;
  }
  const s = out.reduce((a, b) => a + b, 0) || 1;
  return out.map(p => +(p * kp / s).toFixed(6));
}

// 資料不足度 [0,1]：往績越少 → 估計越不確定
function horseUncertainty(h) {
  const runs = h.runs;
  if (runs == null || !isFinite(runs)) return 0.5;
  if (runs <= 1) return 1;
  if (runs >= 12) return 0;
  return Math.max(0, Math.min(1, (12 - runs) / 11));
}

// ── 市場融合 ────────────────────────────────────────────────────────────────
// 後測（scripts/tune_temp.js，350 場配對檢定）：
//   · 純模型最佳 log-loss 2.0110 / R² 0.450 / 頭名命中 30.3%
//   · 純市場          log-loss 1.9937 / R² 0.466
//   · 混合 w=0.3       log-loss 1.9892，但 mean - 2se 未 > 0（z≈0.96）→ 未達顯著
// 所以機率用 w=0.3 融合市場（三組 MARKET_MULT 掃描都穩定揀中 w=0.3），
// 同時向用戶誠實標示「未有統計證據顯示模型跑贏市場」。
const MODEL_BLEND_W = 0.3;

// p = w·p_model + (1-w)·p_market（1/odds 正規化）。冇賠率嘅馬只用模型，
// 最後整體重新正規化到總和 = 1。
function blendWithMarket(pModel, oddsArr, w = MODEL_BLEND_W) {
  const n = pModel.length;
  if (!n || !(w > 0)) return pModel;
  const inv = oddsArr.map(o => (o ? 1 / o : null));
  const known = inv.filter(v => v != null);
  if (!known.length) return pModel;
  const s = known.reduce((a, b) => a + b, 0) || 1;
  const out = pModel.map((p, i) => (inv[i] == null ? p : w * p + (1 - w) * (inv[i] / s)));
  const t = out.reduce((a, b) => a + b, 0) || 1;
  return out.map(v => +(v / t).toFixed(6));
}

// ── σ 校準 ────────────────────────────────────────────────────────────────
// 《計得精彩》p198：σ 是「估計值的不確定性」，不是馬匹名次波動本身
// （名次波動已由近績 factor 反映，再放進分佈會重複計算）。
//   σ_i = SIGMA_K × std(all μ) × (0.85 + 0.30 × 資料不足度)
// 資料不足度由往績場數決定：出賽越少 → 估計越不確定 → σ 越寬。
//
// 重要修訂：σ 必須同 μ 落喺同一個尺度。舊做法係 σ 由 rawMus 計算、μ 卻被
// applyTemp 收縮，令有效銳度被 TEMP 鎖死喺 1/temp，分佈永遠過平（29/1 馬
// 都判 11%）。而家 μ 直接用總分原尺度，只有 SIGMA_K 一個可辨識嘅銳度參數，
// 由 scripts/tune_temp.js 以 log-loss 擬合。
const SIGMA_K = 1.25;
function calibrateSigmas(mus, uncertainties, k = SIGMA_K) {
  const n = mus.length;
  if (!n) return [];
  const mean = mus.reduce((a, b) => a + b, 0) / n;
  const varr = mus.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  const sigmaField = Math.sqrt(varr);
  const base = sigmaField > 1e-6 ? sigmaField : 5;
  const kk = k > 0 ? k : SIGMA_K;
  return (uncertainties || []).map(u => {
    const t = (u == null || !isFinite(u)) ? 0.5 : Math.max(0, Math.min(1, u));
    return kk * base * (0.85 + 0.30 * t);
  });
}


// ── Poisson-binomial CDF：k 個獨立（各自機率不同）伯努利試驗 ≤ limit 次成功 ──
function poissonBinomialCdf(probs, limit) {
  const dp = [1];
  const cap = Math.max(0, limit);
  for (const p of probs) {
    const nd = new Array(dp.length + 1).fill(0);
    for (let g = 0; g < dp.length; g++) {
      nd[g] += dp[g] * (1 - p);
      nd[g + 1] += dp[g] * p;
    }
    // 次數只增不減，故 > limit+1 的桶永不影響 ≤ limit 的答案，可安全截斷
    const up = Math.min(nd.length - 1, cap + 1);
    dp.length = up + 1;
    for (let g = 0; g <= up; g++) dp[g] = nd[g];
  }
  let sum = 0;
  for (let g = 0; g <= cap && g < dp.length; g++) sum += dp[g] || 0;
  return sum;
}

// ── 應值賠率 & 期望值 ──────────────────────────────────────────────────────
// 作者公式：公估計機會率 = 1/賠率 × 0.82（p103）
function fairOdds(p) { return p > 0 ? 1 / p : null; }
function evValue(p, odds) { return odds ? p * (odds - 1) - (1 - p) : null; }

// ── R² test（第5章 p190-192）────────────────────────────────────────────────
// ln(R²) = mean( ln( estimatedProb / randomProb ) )
// 門檻：HKJC 公賠率 R² ≈ 0.152-0.167；作者認為要 > 0.17 才有盈利
function r2Test(samples) {
  if (!samples.length) return { r2: null, n: 0 };
  let sum = 0, used = 0;
  for (const s of samples) {
    if (!s.runners || !(s.winnerProb > 0)) continue;
    sum += Math.log(s.winnerProb / (1 / s.runners));
    used++;
  }
  if (!used) return { r2: null, skillRatio: null, n: 0 };
  const ln = sum / used;
  // r2 = ln(R²)（作者 p190 公式本身嘅值，門檻 0.17 就係呢個空間）。
  // skillRatio = exp(r2) = 幾何平均嚟講，冠軍獲派嘅機會率係「隨機」嘅幾多倍，
  // 純粹俾用戶容易理解，唔係統計學意義嘅 R²。
  return { r2: +ln.toFixed(6), skillRatio: +Math.exp(ln).toFixed(3), n: used };
}

module.exports = {
  FACTORS, FACTOR_MAP, FACTOR_GROUPS, FACTOR_TO_FEATURE,
  scoreHorse, winProbabilities, placeProbabilities,
  fairOdds, evValue, r2Test,
  normCdf, normPdf, erf, clamp, scale,
  adjRatio, recencyWeight, lbsPerLength, poissonBinomialCdf,
  calibrateSigmas, SIGMA_K, horseUncertainty,
  blendWithMarket, MODEL_BLEND_W,
};
