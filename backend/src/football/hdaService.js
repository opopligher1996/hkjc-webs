// ── 主客和分析服務：馬會賽事 ↔ titan007 配對 + 百家初盤批量抓取 ────────────
const { scrapeHkjcMatches } = require('./hkjcFootball');
const { scrapeSchedule } = require('./titanSchedule');
const { scrape1x2, stats: oddsStats } = require('./titan1x2');
const pool = require('../db/pool');

// 簡→繁字元對照（球隊名常用字）
const S2T = {
  '乌': '烏', '兰': '蘭', '纳': '納', '马': '馬', '亚': '亞', '维': '維', '兹': '茲',
  '尔': '爾', '纽': '紐', '伦': '倫', '汉': '漢', '爱': '愛', '华': '華', '莱': '萊',
  '际': '際', '联': '聯', '赛': '賽', '竞': '競', '国': '國', '队': '隊', '罗': '羅',
  '贝': '貝', '达': '達', '谢': '謝', '万': '萬', '兴': '興', '宁': '寧', '场': '場',
  '员': '員', '萨': '薩', '齐': '齊', '韦': '韋', '约': '約', '苏': '蘇', '图': '圖',
  '门': '門', '广': '廣', '东': '東', '矿': '礦', '区': '區', '压': '壓', '夺': '奪',
  '毕': '畢', '尔': '爾', '冯': '馮', '习': '習', '兰': '蘭', '释': '釋', '卫': '衛',
  '卢': '盧', '塔': '塔', '俄': '俄', '塞': '塞', '维亚': '維亞', '顿': '頓',
  '克': '克', '迪': '迪', '尼': '尼', '斯': '斯', '拉': '拉', '雷': '雷',
};
function s2t(s) {
  let out = '';
  for (const ch of s) out += S2T[ch] || ch;
  return out;
}

// HKJC ↔ titan 常見異名（字面唔同但同一隊）
const ALIAS = {
  '烏甸尼斯': '烏迪內斯', '烏迪內斯': '烏甸尼斯',
};

// 學習返嚟嘅映射（team_alias 表快取・定時重載）
let _aliasMap = { at: 0, map: new Map() };
function getAliasMap(pool) {
  if (Date.now() - _aliasMap.at < 10 * 60 * 1000) return _aliasMap.map;
  // 同步場景下直接返現有（buildUpcoming 會先 refresh）
  return _aliasMap.map;
}
async function refreshAliasMap() {
  try {
    const { rows } = await pool.query('SELECT hkjc_name, titan_name FROM team_alias');
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.hkjc_name)) m.set(r.hkjc_name, new Set());
      m.get(r.hkjc_name).add(r.titan_name);
    }
    _aliasMap = { at: Date.now(), map: m };
    return m;
  } catch (_) { return _aliasMap.map; }
}

// 記住一個成功配對（學習）
async function learnAlias(hkjcName, titanName) {
  if (!hkjcName || !titanName || hkjcName === titanName) return;
  try {
    await pool.query('INSERT INTO team_alias (hkjc_name, titan_name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [hkjcName, titanName]);
  } catch (_) {}
}

// 名稱相似度（0-1）— team_alias 學習表優先
function nameSim(a, b) {
  const known = _aliasMap.map.get(a);
  if (known && known.has(b)) return 1;
  const known2 = _aliasMap.map.get(b);
  if (known2 && known2.has(a)) return 1;
  const x = s2t(ALIAS[a] || a), y = s2t(ALIAS[b] || b);
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85;
  const setA = new Set(x), setB = new Set(y);
  let inter = 0;
  for (const c of setA) if (setB.has(c)) inter++;
  return inter / Math.max(setA.size, setB.size);
}

// ── 快取 ──
let upcomingCache = { at: 0, rows: [] };
const SCHED_TTL = 20 * 60 * 1000;

async function buildUpcoming(force = false) {
  if (!force && upcomingCache.rows.length && Date.now() - upcomingCache.at < SCHED_TTL) {
    return upcomingCache;
  }
  await refreshAliasMap(); // 學習表先 refresh
  const [hkjc, titan] = await Promise.all([
    scrapeHkjcMatches(),
    scrapeSchedule(10, { all: true }),
  ]);
  // titan 按 date 分組（時間用 ±10 分鐘容差匹配）
  const byDate = new Map();
  for (const t of titan) {
    if (!t.titanId) continue;
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date).push(t);
  }
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const rows = [];
  let unmatched = 0;
  for (const h of hkjc) {
    const dayMatches = byDate.get(h.date) || [];
    const hMin = toMin(h.time);
    // 同日 ±10 分鐘 + 名稱相似度
    let best = null, bestSim = 0;
    for (const t of dayMatches) {
      const tMin = toMin(t.time);
      if (Math.abs(tMin - hMin) > 10) continue;
      const sim = (nameSim(h.home, t.homeCn) + nameSim(h.away, t.awayCn)) / 2;
      if (sim > bestSim) { bestSim = sim; best = t; }
    }
    if (bestSim >= 0.5 && best) {
      // 成功配對 → 學習隊名映射（之後回查唔使再煩）
      learnAlias(h.home, best.homeCn);
      learnAlias(h.away, best.awayCn);
    } else {
      unmatched++;
    }
    rows.push({
      ...h,
      titanId: bestSim >= 0.5 ? best.titanId : null,
      leagueCn: best ? best.leagueName : null,
      titanAh: best ? best.titanAh : null,
      matchScore: +bestSim.toFixed(2),
    });
  }
  if (unmatched) console.log(`[buildUpcoming] ${unmatched} 場未配到 titan`);
  upcomingCache = { at: Date.now(), rows };
  return upcomingCache;
}

// ── 批量抓取百家初盤 ──
const batchState = { running: false, done: 0, total: 0, startedAt: null, finishedAt: null, errors: 0 };

async function scrapeOne(titanId, meta) {
  const d = await scrape1x2(titanId);
  if (!d.openAvg) throw new Error('無初盘平均值');
  const st = oddsStats(d.openBooks);
  // 賽果：meta 有就用（來自 Over 頁），否則用 oddslist 頁首
  const hg = meta?.homeGoals ?? d.homeGoals;
  const ag = meta?.awayGoals ?? d.awayGoals;
  const result = hg != null ? (hg > ag ? 'H' : hg === ag ? 'D' : 'A') : null;
  await pool.query(
    `INSERT INTO had_odds (titan_id, league, match_date, home_team, away_team, n_books,
       open_h, open_d, open_a, live_h, live_d, live_a,
       sd_h, sd_d, sd_a, cv_h, cv_d, cv_a, league_cn, home_goals, away_goals, result)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     ON CONFLICT (titan_id) DO UPDATE SET
       -- 只補空位：已有嘅賠率絕不取代・SD/CV/n_books 空位可補
       home_goals=COALESCE(EXCLUDED.home_goals, had_odds.home_goals),
       away_goals=COALESCE(EXCLUDED.away_goals, had_odds.away_goals),
       result=COALESCE(EXCLUDED.result, had_odds.result),
       sd_h=COALESCE(had_odds.sd_h, EXCLUDED.sd_h),
       sd_d=COALESCE(had_odds.sd_d, EXCLUDED.sd_d),
       sd_a=COALESCE(had_odds.sd_a, EXCLUDED.sd_a),
       cv_h=COALESCE(had_odds.cv_h, EXCLUDED.cv_h),
       cv_d=COALESCE(had_odds.cv_d, EXCLUDED.cv_d),
       cv_a=COALESCE(had_odds.cv_a, EXCLUDED.cv_a),
       n_books=CASE WHEN EXCLUDED.n_books > had_odds.n_books THEN EXCLUDED.n_books ELSE had_odds.n_books END,
       league=COALESCE(had_odds.league, EXCLUDED.league),
       match_date=COALESCE(had_odds.match_date, EXCLUDED.match_date),
       home_team=COALESCE(had_odds.home_team, EXCLUDED.home_team),
       away_team=COALESCE(had_odds.away_team, EXCLUDED.away_team)`,
    [titanId, meta?.league || null, meta?.date || null, meta?.home || null, meta?.away || null,
     st.h.n, d.openAvg.h, d.openAvg.d, d.openAvg.a,
     d.liveAvg?.h ?? null, d.liveAvg?.d ?? null, d.liveAvg?.a ?? null,
     st.h.sd, st.d.sd, st.a.sd, st.h.cv, st.d.cv, st.a.cv, d.leagueCn || meta?.leagueCn || null,
     hg, ag, result]);
}

// ── 相似賠率歷史統計（HK33 式）──────────────────────────────────────────────
// 搵歷史場次：H/D/A 三項賠率全部喺 ±tol 之內 → 開出比率 + 回報率
async function similarStats(h, d, a, tol = 0.10) {
  const { rows } = await pool.query(
    `SELECT result FROM had_odds
     WHERE result IS NOT NULL
       AND open_h BETWEEN $1::numeric*(1-$4::numeric) AND $1::numeric*(1+$4::numeric)
       AND open_d BETWEEN $2::numeric*(1-$4::numeric) AND $2::numeric*(1+$4::numeric)
       AND open_a BETWEEN $3::numeric*(1-$4::numeric) AND $3::numeric*(1+$4::numeric)`,
    [h, d, a, tol]);
  const n = rows.length;
  if (!n) return { n: 0, rateH: 0, rateD: 0, rateA: 0, roiH: null, roiD: null, roiA: null };
  const cH = rows.filter(r => r.result === 'H').length;
  const cD = rows.filter(r => r.result === 'D').length;
  const cA = rows.filter(r => r.result === 'A').length;
  const rH = cH / n, rD = cD / n, rA = cA / n;
  return {
    n,
    rateH: +rH.toFixed(4), rateD: +rD.toFixed(4), rateA: +rA.toFixed(4),
    roiH: +(rH * h - 1).toFixed(4), roiD: +(rD * d - 1).toFixed(4), roiA: +(rA * a - 1).toFixed(4),
  };
}

async function runBatch() {
  if (batchState.running) return;
  const { rows } = await buildUpcoming();
  const targets = rows.filter(r => r.titanId);
  const { rows: existing } = await pool.query('SELECT titan_id FROM had_odds');
  const have = new Set(existing.map(r => r.titan_id));

  // titan 冇配到嘅場 → 抄馬會 HAD 賠率入庫（odds_src='HKJC'・單莊冇 SD/CV）
  const { rows: existingHk } = await pool.query(
    "SELECT match_date::text || '|' || home_team || '|' || away_team AS k FROM had_odds WHERE odds_src = 'HKJC'");
  const haveHk = new Set(existingHk.map(r => r.k));
  let hkIns = 0;
  for (const r of rows) {
    if (r.titanId || !r.hadH || !r.hadD || !r.hadA) continue;
    const key = `${r.date}|${r.home}|${r.away}`;
    if (haveHk.has(key)) continue;
    try {
      await pool.query(
        `INSERT INTO had_odds (titan_id, league, match_date, home_team, away_team, n_books,
           open_h, open_d, open_a, live_h, live_d, live_a, odds_src, league_cn)
         VALUES (NULL, NULL, $1, $2, $3, 1, $4, $5, $6, $4, $5, $6, 'HKJC', NULL)
         ON CONFLICT DO NOTHING`,
        [r.date, r.home, r.away, r.hadH, r.hadD, r.hadA]);
      haveHk.add(key);
      hkIns++;
    } catch (_) {}
  }
  if (hkIns) console.log(`[runBatch] HKJC-only 賠率 +${hkIns}`);

  const todo = targets.filter(r => !have.has(String(r.titanId)));
  batchState.running = true;
  batchState.done = 0;
  batchState.total = todo.length;
  batchState.errors = 0;
  batchState.startedAt = Date.now();
  if (!todo.length) { batchState.finishedAt = Date.now(); batchState.running = false; return; }

  const CONC = 3;
  const queue = [...todo];
  const workers = Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const m = queue.shift();
      if (!m) break;
      try { await scrapeOne(m.titanId, m); }
      catch (_) { batchState.errors++; }
      batchState.done++;
    }
  });
  await Promise.all(workers);
  batchState.running = false;
  batchState.finishedAt = Date.now();
}

// ── 合併視圖（endpoint 同每日 job 共用）────────────────────────────────────
function detectYellow(vh, vd, va, sdAry, cvAry, n, rates, rois) {
  if (n == null || n < 30) return null;
  // SD/CV 空或零 → 唔夠數據做「三項最低」判斷・跳過
  if (!sdAry || sdAry.some(x => x == null || x === 0)) return null;
  if (!cvAry || cvAry.some(x => x == null || x === 0)) return null;
  const eq = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;
  const odds = [vh, vd, va];
  const minO = Math.min(...odds), minS = Math.min(...sdAry), minC = Math.min(...cvAry);
  for (let i = 0; i < 3; i++) {
    if (eq(odds[i], minO) && eq(sdAry[i], minS) && eq(cvAry[i], minC)
      && rates[i] != null && rates[i] >= 0.5 && rois[i] != null && rois[i] < 0) {
      return { idx: i, side: 'HDA'[i] };
    }
  }
  return null;
}

// 綠格檢測（場數 ≥30 前置）：
//   該邊賠率+SD+CV 三項全場最低 + 預計開出>歷史開出 + 對方兩邊預計開出<歷史開出 + 回報<-10%
//   深綠（D）= 綠格 + gap（預計−歷史）≥ 13pp（Q4 大分歧子集）
function detectGreenBlue(vh, vd, va, sdAry, cvAry, rates, rois, n) {
  if (rates == null || rates.some(r => r == null)) return { green: null, blue: null, deep: null };
  if (n == null || n < 30) return { green: null, blue: null, deep: null };
  // SD/CV 空或零 → 唔夠數據做「三項最低」判斷・跳過
  if (!sdAry || sdAry.some(x => x == null || x === 0)) return { green: null, blue: null, deep: null };
  if (!cvAry || cvAry.some(x => x == null || x === 0)) return { green: null, blue: null, deep: null };
  const eq = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;
  const inv = [1 / vh, 1 / vd, 1 / va];
  const s = inv[0] + inv[1] + inv[2];
  const exp = inv.map(x => x / s);
  const minS = Math.min(...sdAry), minC = Math.min(...cvAry);
  const minO = Math.min(vh, vd, va);
  let green = null, deep = null, strong = null;
  for (let i = 0; i < 3; i++) {
    if (!green && exp[i] > rates[i] && rois[i] != null && rois[i] < -0.10
      && eq([vh, vd, va][i], minO) && eq(sdAry[i], minS) && eq(cvAry[i], minC)
      && [0, 1, 2].filter(j => j !== i).every(j => exp[j] < rates[j])) {
      green = { idx: i, side: 'HDA'[i], exp: exp[i], rate: rates[i] };
      if (exp[i] - rates[i] >= 0.13) deep = { idx: i, side: 'HDA'[i], exp: exp[i], rate: rates[i] };
      if ([vh, vd, va][i] <= 1.60) strong = { idx: i, side: 'HDA'[i], exp: exp[i], rate: rates[i] };
    }
  }
  return { green, blue: null, deep, strong };
}

// ── 舊法深綠（壞基準池）：複製舊時代 gap 計算環境驗證 83.9% ──
// 純壞池（HKJC 壞波膽時期）— 唔溝真實賽果，保持「錯計法」原貌
async function similarStatsBad(h, d, a, tol = 0.10) {
  const { rows } = await pool.query(
    `SELECT b.bad_result result, o.open_h h, o.open_d d, o.open_a a
     FROM had_odds_bad b JOIN had_odds o ON o.titan_id = b.titan_id
     WHERE b.bad_result IS NOT NULL AND o.open_h IS NOT NULL`);
  let n = 0, cH = 0, cD = 0, cA = 0, pH = 0, pD = 0, pA = 0;
  for (const r of rows) {
    if (Math.abs(+r.h - h) > h * tol) continue;
    if (Math.abs(+r.d - d) > d * tol) continue;
    if (Math.abs(+r.a - a) > a * tol) continue;
    n++;
    if (r.result === 'H') { cH++; pH += +r.h - 1; } else pH -= 1;
    if (r.result === 'D') { cD++; pD += +r.d - 1; } else pD -= 1;
    if (r.result === 'A') { cA++; pA += +r.a - 1; } else pA -= 1;
  }
  if (!n) return { n: 0 };
  const rateH = cH / n, rateD = cD / n, rateA = cA / n;
  return { n, rateH, rateD, rateA, roiH: pH / n, roiD: pD / n, roiA: pA / n };
}

// 舊法深綠檢測：原裝 6 條件，但 rate/roi 用壞池
function detectDeepOld(vh, vd, va, sdAry, cvAry, rates, rois, n) {
  if (rates == null || rates.some(r => r == null)) return null;
  if (n == null || n < 30) return null;
  if (!sdAry || sdAry.some(x => x == null || x === 0)) return null;
  if (!cvAry || cvAry.some(x => x == null || x === 0)) return null;
  const eq = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;
  const odds = [vh, vd, va];
  const inv = odds.map(x => 1 / x);
  const s = inv[0] + inv[1] + inv[2];
  const exp = inv.map(x => x / s);
  const minS = Math.min(...sdAry), minC = Math.min(...cvAry);
  const minO = Math.min(...odds);
  for (let i = 0; i < 3; i++) {
    if (exp[i] > rates[i] && rois[i] != null && rois[i] < -0.10
      && eq(odds[i], minO) && eq(sdAry[i], minS) && eq(cvAry[i], minC)
      && [0, 1, 2].filter(j => j !== i).every(j => exp[j] < rates[j])
      && exp[i] - rates[i] >= 0.13) {
      return { idx: i, side: 'HDA'[i], exp: exp[i], rate: rates[i] };
    }
  }
  return null;
}

// 白格（價值熱門）檢測：賠+SD+CV 三項全場最低（合一）+ 賠率 ≤2.0
//   + gap（預計−歷史）≤ -5pp（市場定價低過歷史 = 價值）+ n>30
//   乾淨數據回測：n=196・開出 70.9%（預計 62.9%）・ROI +4.3%
function detectWhite(vh, vd, va, sdAry, cvAry, rates, n) {
  if (rates == null || rates.some(r => r == null)) return null;
  if (n == null || n < 30) return null;
  if (!sdAry || sdAry.some(x => x == null || x === 0)) return null;
  if (!cvAry || cvAry.some(x => x == null || x === 0)) return null;
  const eq = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;
  const odds = [vh, vd, va];
  const inv = odds.map(x => 1 / x);
  const s = inv[0] + inv[1] + inv[2];
  const exp = inv.map(x => x / s);
  const minS = Math.min(...sdAry), minC = Math.min(...cvAry);
  const minO = Math.min(...odds);
  for (let i = 0; i < 3; i++) {
    if (eq(odds[i], minO) && eq(sdAry[i], minS) && eq(cvAry[i], minC)
      && odds[i] <= 2.0 && (exp[i] - rates[i]) <= -0.05) {
      return { idx: i, side: 'HDA'[i], exp: exp[i], rate: rates[i] };
    }
  }
  return null;
}

// ✈️ 客熱門：合一客隊（任何賠率）+ 深綠六條件（壞池）
// 乾淨回測 zone 內 80%・實戰 12/12（含 ◎○△ 三區）
function detectAwayHot(vh, vd, va, sdAry, cvAry, rates, rois, n) {
  if (rates == null || rates.some(r => r == null)) return null;
  if (n == null || n < 30) return null;
  if (!sdAry || sdAry.some(x => x == null || x === 0)) return null;
  if (!cvAry || cvAry.some(x => x == null || x === 0)) return null;
  if (!(va < vh && va < vd)) return null;                      // 客賠最低
  if (!(sdAry[2] <= sdAry[0] && sdAry[2] <= sdAry[1])) return null;
  if (!(cvAry[2] <= cvAry[0] && cvAry[2] <= cvAry[1])) return null;
  const inv = 1/vh + 1/vd + 1/va;
  const exp = [vh, vd, va].map(x => (1/x) / inv);
  if (!(exp[2] > rates[2])) return null;                       // gap>0
  if (!(exp[2] - rates[2] >= 0.13)) return null;               // gap≥13pp
  if (!(rois[2] < -0.10)) return null;
  if (!(exp[0] < rates[0] && exp[1] < rates[1])) return null;  // 對手壓制
  return { idx: 2, side: 'A', exp: exp[2], rate: rates[2] };
}

async function getMergedView(tol = 0.10) {
  const up = await buildUpcoming();
  const ids = up.rows.filter(r => r.titanId).map(r => r.titanId);
  let oddsMap = {};
  if (ids.length) {
    const { rows: oddsRows } = await pool.query('SELECT * FROM had_odds WHERE titan_id = ANY($1::bigint[])', [ids]);
    oddsMap = Object.fromEntries(oddsRows.map(r => [r.titan_id, r]));
  }
  let hk33Map = {};
  try {
    const hk33 = await require('./hk33').getHk33();
    hk33Map = Object.fromEntries(hk33.rows.map(r => [r.fb, r]));
  } catch (_) {}
  const out = [];
  for (const r of up.rows) {
    const o = r.titanId ? (oddsMap[String(r.titanId)] || null) : null;
    const k = hk33Map[r.fb] || null;
    const vh = o ? +o.open_h : k?.h, vd = o ? +o.open_d : k?.d, va = o ? +o.open_a : k?.a;
    const sdAry = o ? [+o.sd_h, +o.sd_d, +o.sd_a] : (k ? [k.sdH, k.sdD, k.sdA] : null);
    const cvAry = o ? [+o.cv_h, +o.cv_d, +o.cv_a] : (k ? [k.cvH, k.cvD, k.cvA] : null);
    // HK33 優先・自家 sim 後備
    // HK33 基準要 n≥30 先有效（唔夠跌返 sim — 同捕捉/主表邏輯一致）
    const kOk = k && k.n >= 30 ? k : null;
    let n = kOk ? kOk.n : null;
    let rates = kOk ? [kOk.rateH, kOk.rateD, kOk.rateA] : null;
    let rois = kOk ? [kOk.roiH, kOk.roiD, kOk.roiA] : null;
    if (!kOk && o?.open_h) {
      try {
        const sim = await similarStats(+o.open_h, +o.open_d, +o.open_a, 0.10);
        if (sim.n) { n = sim.n; rates = [sim.rateH, sim.rateD, sim.rateA]; rois = [sim.roiH, sim.roiD, sim.roiA]; }
      } catch (_) {}
    }
    let yellow = null, green = null, deep = null, white = null, strong = null;
    if (vh != null && sdAry && n != null && rates) {
      yellow = detectYellow(vh, vd, va, sdAry, cvAry, n, rates, rois);
      const gb = detectGreenBlue(vh, vd, va, sdAry, cvAry, rates, rois, n);
      green = gb.green; deep = gb.deep; strong = gb.strong;
      white = detectWhite(vh, vd, va, sdAry, cvAry, rates, n);
    }
    // 舊法深綠：壞基準池 6 條件（只行 titan odds 場）— 每日 job 都要捕捉
    let deepOld = null, bad = null, awayHot = null;
    if (vh != null && sdAry && o?.open_h) {
      try {
        bad = await similarStatsBad(+o.open_h, +o.open_d, +o.open_a, 0.10);
        if (bad.n >= 30) {
          deepOld = detectDeepOld(vh, vd, va, sdAry, cvAry, [bad.rateH, bad.rateD, bad.rateA], [bad.roiH, bad.roiD, bad.roiA], bad.n);
          awayHot = detectAwayHot(vh, vd, va, sdAry, cvAry, [bad.rateH, bad.rateD, bad.rateA], [bad.roiH, bad.roiD, bad.roiA], bad.n);
        }
      } catch (_) {}
    }
    out.push({ ...r, odds: o, hk33: k, yellow, green, deep, strong, white, deepOld, awayHot, bad: bad?.n ? { n: bad.n, rateH: bad.rateH, rateD: bad.rateD, rateA: bad.rateA, roiH: bad.roiH, roiD: bad.roiD, roiA: bad.roiA } : null, sim: (!k && n != null && rates) ? { n, rateH: rates[0], rateD: rates[1], rateA: rates[2], roiH: rois[0], roiD: rois[1], roiA: rois[2] } : null });
  }
  return { rows: out, at: up.at };
}

module.exports = { buildUpcoming, runBatch, batchState, s2t, nameSim, similarStats, similarStatsBad, scrapeOne, getMergedView, detectYellow, detectGreenBlue, detectWhite, detectDeepOld, detectAwayHot, refreshAliasMap, learnAlias };
