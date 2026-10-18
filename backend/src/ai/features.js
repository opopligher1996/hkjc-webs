// ─────────────────────────────────────────────────────────────────────────────
//  features.js — 特徵工程 (Feature Engineering)
//
//  把 DB 資料轉成 [-1,1] 的「相對特徵」。所有相對化都以「同場其他馬」為基準，
//  實踐《計得精彩》第5章 p153 的「全場估計」原則：不做局部估計。
//
//  對應書中結論的處理：
//  · 負磅必須配 排位體重 + 距離（p77-81）→ weightRel / weightRatioRel
//  · 泥地適應有效，但「死路程」是假的（p82）→ 路程權重刻意低
//  · 檔位要加權平均線平滑（p142-150）→ buildDrawCurve (4-2-1, bandwidth=2)
//  · 賠率用 log(倒數)（p178-186）→ lnOddR
// ─────────────────────────────────────────────────────────────────────────────

const pool = require('../db/pool');
const { adjRatio, recencyWeight, clamp, lbsPerLength } = require('./factorlib');

const CLASS_RANK = {
  '第一班': 5, '第二班': 4, '第三班': 3, '第四班': 2, '第五班': 1,
  '一級': 5, '二級': 4, '三級': 3, '四級': 2, '五級': 1,
  'GRADE1': 5, 'GRADE2': 4, 'GRADE3': 3, 'GRADE4': 2, 'GRADE5': 1,
  'CLASS1': 5, 'CLASS2': 4, 'CLASS3': 3, 'CLASS4': 2, 'CLASS5': 1,
};
const COURSE_RANK = {
  '草地"A+3"': 8, '草地"A+2"': 7, '草地"A+1"': 6, '草地"A"': 5,
  '草地"B+3"': 4.7, '草地"B+2"': 4.3, '草地"B+1"': 4, '草地"B"': 3.7,
  '草地"C+3"': 3.4, '草地"C+2"': 3.1, '草地"C+1"': 2.8, '草地"C"': 2.5,
  '草地"D"': 1.5, '草地"E"': 1,
  '全天候': 3, 'AWT': 3, '全天候跑道': 3,
};
function classRank(c) {
  if (!c) return null;
  const k = String(c).trim();
  if (CLASS_RANK[k] != null) return CLASS_RANK[k];
  if (COURSE_RANK[k] != null) return COURSE_RANK[k];
  const m = k.match(/([A-E])/);
  if (m) return COURSE_RANK[`草地"${m[1]}"`] ?? { A: 5, B: 3.7, C: 2.5, D: 1.5, E: 1 }[m[1]];
  const n = k.match(/([1-5])/);
  if (n) return 6 - parseInt(n[1], 10);
  return null;
}

const dstr = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
const diffDays = (a, b) => Math.round((new Date(dstr(a)) - new Date(dstr(b))) / 86400000);
const num = (v) => (v == null || v === '' ? null : Number(v));

// 同場（或參考集合內）正規化到 [-1,1]
function normalizeInSet(value, refValues) {
  const valid = refValues.filter(v => v != null && isFinite(v));
  if (valid.length < 2 || value == null) return null;
  const lo = Math.min(...valid), hi = Math.max(...valid);
  if (hi === lo) return 0;
  return clamp((value - lo) / (hi - lo) * 2 - 1, -1, 1);
}

// ── 檔位曲線：加權平均線平滑 (bandwidth=2, 4-2-1) ──────────────────────────
// p143-150：平滑消除「5檔特別好、7檔特別差」的隨機噪音
function buildDrawCurve(series) {
  const n = series.length;
  if (!n) return new Map();
  const out = new Map();
  const W = [4, 2, 1];
  for (let i = 0; i < n; i++) {
    let num_ = 0, den = 0;
    for (let k = 0; k < W.length; k++) {
      const j = i - k;
      if (j < 0) break;
      num_ += series[j].adj * W[k];
      den += W[k];
    }
    out.set(series[i].draw, den ? num_ / den : series[i].adj);
  }
  return out;
}

// ── 統計聚合：騎師 / 馬師 / 騎練合作 ───────────────────────────────────────
async function loadActorStats(since) {
  const { rows } = await pool.query(
    `SELECT jockey_id, trainer_id, racecourse, distance, track_type,
            finish_position, race_date, draw
     FROM race_records
     WHERE race_date >= $1 AND jockey_id IS NOT NULL`,
    [since]
  );
  const bucket = () => ({
    w: 0, s: 0, t: 0, runs: 0,
    byCourse: new Map(), byDist: new Map(),
    recent: { w: 0, s: 0, t: 0, runs: 0 },
  });
  const bump = (b, fp) => {
    b.runs++;
    if (fp === 1) b.w++; else if (fp === 2) b.s++; else if (fp === 3) b.t++;
  };
  const bumpKey = (m, k, fp) => {
    if (k == null) return;
    if (!m.has(k)) m.set(k, { w: 0, s: 0, t: 0, runs: 0 });
    bump(m.get(k), fp);
  };
  const get = (map, k) => {
    if (!map.has(k)) map.set(k, bucket());
    return map.get(k);
  };

  const jockey = new Map(), trainer = new Map(), jt = new Map();
  const todayStr = dstr(new Date());

  for (const r of rows) {
    const fp = r.finish_position;
    if (!fp) continue;
    const j = get(jockey, r.jockey_id);
    bump(j, fp);
    bumpKey(j.byCourse, r.racecourse, fp);
    bumpKey(j.byDist, r.distance, fp);
    if (diffDays(todayStr, r.race_date) <= 30) bump(j.recent, fp);

    if (r.trainer_id) {
      const t = get(trainer, r.trainer_id);
      bump(t, fp);
      bumpKey(t.byCourse, r.racecourse, fp);
      bumpKey(t.byDist, r.distance, fp);
      const key = `${r.jockey_id}|${r.trainer_id}`;
      if (!jt.has(key)) jt.set(key, { w: 0, s: 0, t: 0, runs: 0 });
      bump(jt.get(key), fp);
    }
  }
  return { jockey, trainer, jt, rows: rows.length };
}

const scoreOf = (b) => (b && b.runs ? adjRatio(b.w, b.s, b.t, b.runs) : null);

// ── 馬匹往績 ────────────────────────────────────────────────────────────────
// 一次過載入全部往績（供 R² 回測做滾動 profile，避免 N+1 query）
async function loadHorseHistory(horseNames, opts = {}) {
  const { since = '2000-01-01' } = opts;
  if (!horseNames.length) return new Map();
  const { rows } = await pool.query(
    `SELECT horse_name, race_date, race_no, racecourse, track_type, distance,
            race_class, finish_position, total_runners, draw,
            horse_weight, actual_weight, rating, gear, win_odds,
            running_positions, jockey_id, trainer_id
     FROM race_records
     WHERE horse_name = ANY($1) AND race_date >= $2
     ORDER BY horse_name, race_date DESC, race_no DESC`,
    [horseNames, since]
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.horse_name)) map.set(r.horse_name, []);
    map.get(r.horse_name).push(r);
  }
  return map;
}

// 由完整往績推出「該場之前」的 profile（嚴格排除 race_date >= beforeDate，避免前視偏差）
function profilesBefore(histMap, beforeDate, maxHistory = 12) {
  const out = new Map();
  for (const [name, rows] of histMap) {
    const hist = rows.filter(r => diffDays(beforeDate, r.race_date) > 0).slice(0, maxHistory);
    if (!hist.length) continue;
    out.set(name, buildProfile(hist));
  }
  return out;
}

async function loadHorseProfiles(horseNames, beforeDate, opts = {}) {
  const { maxHistory = 12 } = opts;
  if (!horseNames.length) return new Map();
  const { rows } = await pool.query(
    `SELECT horse_name, race_date, race_no, racecourse, track_type, distance,
            race_class, finish_position, total_runners, draw,
            horse_weight, actual_weight, rating, gear, win_odds,
            running_positions, jockey_id, trainer_id
     FROM race_records
     WHERE horse_name = ANY($1) AND race_date < $2
     ORDER BY horse_name, race_date DESC, race_no DESC`,
    [horseNames, beforeDate]
  );
  const byHorse = new Map();
  for (const r of rows) {
    if (!byHorse.has(r.horse_name)) byHorse.set(r.horse_name, []);
    const arr = byHorse.get(r.horse_name);
    if (arr.length < maxHistory) arr.push(r);
  }
  const out = new Map();
  for (const [name, hist] of byHorse) out.set(name, buildProfile(hist));
  return out;
}

function buildProfile(hist) {
  if (!hist || !hist.length) return null;
  const latest = hist[0];

  // 近績：日數加權平均名次（越細越好）
  const ranks = hist.filter(r => r.finish_position).map(r => r.finish_position);
  let rrr = null;
  if (ranks.length >= 2) {
    let s = 0, d = 0;
    hist.forEach((r, i) => {
      if (!r.finish_position) return;
      const w = recencyWeight(diffDays(latest.race_date, r.race_date), 180);
      s += r.finish_position * w;
      d += w;
    });
    rrr = d ? s / d : null;
  }

  // 穩定性 σ：名次標準差 → 馬位，設底/上限避免過度自信
  let sigma = null;
  if (ranks.length >= 3) {
    const m = ranks.reduce((a, b) => a + b, 0) / ranks.length;
    const sd = Math.sqrt(ranks.reduce((a, b) => a + (b - m) ** 2, 0) / (ranks.length - 1));
    sigma = clamp(1.2 + sd * 0.45, 1.5, 6);
  }

  // 走勢：最近 3 場名次趨勢
  const recent3 = hist.slice(0, 3).map(r => r.finish_position).filter(Boolean);
  const streak = recent3.length >= 2
    ? clamp((recent3[recent3.length - 1] - recent3[0]) / 4, -1, 1)
    : null;

  // 走位偏好：由 running_positions 首段位置
  let paceBias = null;
  const rp = hist.filter(r => r.running_positions).slice(0, 5);
  let lead = 0, cnt = 0;
  for (const r of rp) {
    const first = String(r.running_positions).trim().split(/[\s,]+/)[0];
    const n = parseInt(first, 10);
    if (isFinite(n)) { lead += n; cnt++; }
  }
  if (cnt >= 2) paceBias = clamp((3 - lead / cnt) / 4, -1, 1);

  return {
    runs: hist.length,
    latestDate: latest.race_date,
    restDays: diffDays(new Date(), latest.race_date),
    rrr, sigma, streak, paceBias,
    lastFinish: latest.finish_position,
    lastRating: latest.rating,
    lastActualWeight: latest.actual_weight != null ? Number(latest.actual_weight) : null,
    lastHorseWeight: latest.horse_weight,
    lastDraw: latest.draw,
    lastCourse: latest.racecourse,
    lastTrack: latest.track_type,
    lastDistance: latest.distance,
    lastClass: latest.race_class,
    lastGear: latest.gear,
    lastJockey: latest.jockey_id,
    lastTrainer: latest.trainer_id,
    hist,
  };
}

// ── 一場賽事的特徵構建 ──────────────────────────────────────────────────────
// 回傳 [{ features, labels, detail, profile }]，key 與 factorlib.FACTORS 對應
function buildRaceFeatures(race, opts) {
  const { stats, profiles, drawCurve, paceRows, fieldLast } = opts;
  const horses = race.horses;

  const classRanks = horses.map(h => classRank(h.race_class));
  const ratings = horses.map(h => num(h.rating));
  const lnOddRs = horses.map(h => (h.odds ? Math.log(1 / h.odds) : null));
  const carriedW = horses.map(h => num(h.actual_weight));
  const jockeyScores = horses.map(h => scoreOf(stats.jockey.get(h.jockey_id)));
  const trainerScores = horses.map(h => scoreOf(stats.trainer.get(h.trainer_id)));

  // ── 走位偏好（真實走位：race_sectional_times.running_positions 首段位置）──
  // 每匹馬近 8 仗首段走位加權平均（新仗重），推出跑法；
  // 再按同場跑法分佈預測步速，計每匹馬嘅步速契合度。
  const raceDate = race.date || opts.date || null;
  const paceInfos = horses.map((h) => {
    const rows = ((paceRows && paceRows.get(h.horse_name)) || [])
      .filter(r => !raceDate || r.d < raceDate)
      .slice(0, 8);
    const ps = [];
    for (const r of rows) {
      const p = parseInt(String(r.rp || '').trim().split(/[\s,]+/)[0], 10);
      if (p > 0 && p < 25) ps.push(p);
    }
    if (!ps.length) return null;
    let s = 0, w = 0;
    ps.forEach((v, i) => { const k = Math.pow(0.85, i); s += v * k; w += k; });
    const avg = s / w;
    const style = avg <= 2.5 ? '前領' : avg <= 4 ? '前速' : avg <= 6.5 ? '均速' : '後追';
    return { avg, style, ps, runs: ps.length };
  });
  const fieldAvgs = paceInfos.map(p => (p ? p.avg : null)).filter(v => v != null);

  // ── 後勁指數（每仗末段 vs 全場中位數，加權平均；9 月回測 r=-0.288，全庫最強單因素）──
  const medArr = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const closingIdxs = horses.map((h) => {
    const rows = ((paceRows && paceRows.get(h.horse_name)) || [])
      .filter(r => !raceDate || r.d < raceDate)
      .slice(0, 8);
    const idxs = [];
    for (const r of rows) {
      if (r.last == null) continue;
      const f = fieldLast && fieldLast.get(`${r.d}|${r.rno}`);
      if (!f || f.length < 5) continue;
      idxs.push(medArr(f) / r.last);
    }
    if (!idxs.length) return null;
    let s = 0, w = 0;
    idxs.forEach((v, i) => { const k = Math.pow(0.85, i); s += v * k; w += k; });
    return { idx: s / w, n: idxs.length };
  });
  const closingField = closingIdxs.map(c => (c ? c.idx : null)).filter(v => v != null);

  // ── 速度圖數（Beyer：近 6 仗加權圖數；9 月回測 r=-0.163, p<0.01）──
  const figInfos = horses.map((h) => {
    const rows = ((opts.figureRows && opts.figureRows.get(h.horse_name)) || [])
      .filter(r => !raceDate || r.d < raceDate)
      .slice(0, 6);
    if (!rows.length) return null;
    let s = 0, w = 0;
    rows.forEach((r, i) => { const k = Math.pow(0.85, i); s += r.fig * k; w += k; });
    const fig = s / w;
    return {
      fig, n: rows.length,
      best: Math.max(...rows.map(r => r.fig)),
      w2w: rows.filter(r => r.w2w && r.noPressure).length, // 一放到底冇壓力（第 9 章折扣）
    };
  });
  const figField = figInfos.map(f => (f ? f.fig : null)).filter(v => v != null);

  // 場次步速形勢（三級制，同 /api/races/pace 一致）
  const knownStyles = paceInfos.filter(Boolean);
  const nLead = knownStyles.filter(p => p.style === '前領').length;
  const nPress = knownStyles.filter(p => p.style === '前速').length;
  let paceLevel = null, paceFavours = null;
  if (knownStyles.length >= 3) {
    if (nLead >= 2 || nLead + nPress >= 5) { paceLevel = '快'; paceFavours = '均速/後追'; }
    else if (nLead + nPress <= 1) { paceLevel = '慢'; paceFavours = '前領/前速'; }
    else { paceLevel = '正常'; paceFavours = '形勢平均'; }
  }
  // 跑法 × 場面形勢 → 契合度 [-1,1]（快利後追、慢利前領）
  const PACE_FIT = {
    '快':   { 前領: -0.8, 前速: -0.4, 均速: 0.4, 後追: 0.8 },
    '正常': { 前領: 0.1, 前速: 0.1, 均速: 0.0, 後追: -0.1 },
    '慢':   { 前領: 0.8, 前速: 0.4, 均速: -0.4, 後追: -0.8 },
  };

  return horses.map((h, idx) => {
    const prof = profiles.get(h.horse_name) || null;
    const f = {};      // 特徵值 [-1,1]
    const L = {};      // 人類可讀標籤（供 UI 顯示）
    const age = num(h.age);
    const carried = num(h.actual_weight);
    const declared = num(h.declared_weight);
    const lpl = lbsPerLength(race.distance);

    // ── 1. 班次 ──
    f.classRel = normalizeInSet(classRanks[idx], classRanks);
    L.classLabel = h.race_class ? `${h.race_class}` : null;

    // ── 2. 評分 ──
    f.ratingRel = normalizeInSet(ratings[idx], ratings);
    L.ratingLabel = ratings[idx] != null ? `評分 ${ratings[idx]}` : null;

    // ── 3. 評分走勢（用排位表官方 rating_change，缺則與上仗比較）──
    const off = String(h.rating_change || '').trim();
    if (off) {
      const n = parseInt(off, 10);
      f.ratingTrend = isFinite(n) ? clamp(n / 10, -1, 1) : null;
      L.ratingTrendLabel = `官方 ${off}`;
    } else if (ratings[idx] != null && prof?.lastRating != null) {
      const d = ratings[idx] - prof.lastRating;
      f.ratingTrend = clamp(d / 10, -1, 1);
      L.ratingTrendLabel = `較上仗 ${d > 0 ? '+' : ''}${d}`;
    } else {
      f.ratingTrend = null;
    }

    // ── 4. 近績（RRR）──
    f.formRel = prof?.rrr != null ? clamp(1 - prof.rrr / 8, -1, 1) : null;
    L.formLabel = prof?.rrr != null
      ? `加權平均名次 ${prof.rrr.toFixed(2)}（${prof.runs} 場）`
      : (h.recent_form ? `排位表近績「${h.recent_form}」` : null);

    // ── 5. 馬齡 ──
    f.ageScore = age != null
      ? (age <= 3 ? -0.3 : age <= 4 ? 0.4 : age <= 7 ? 1 : -0.4) : null;
    L.ageLabel = age != null ? `${age} 歲` : null;

    // ── 6. 首次出賽 ──
    f.firstRun = prof ? 0 : -1;

    // ── 7. 休賽日 ──
    if (prof?.restDays != null) {
      const d = prof.restDays;
      f.restScore = d < 14 ? -0.6 : d > 150 ? -0.8 : d > 90 ? -0.3 : 0.8;
      L.restLabel = `上仗後休 ${d} 日`;
    } else f.restScore = null;

    // ── 8. 連續名次走勢 ──
    f.streakRel = prof?.streak ?? null;
    L.streakLabel = prof?.streak != null
      ? `近績走勢 ${prof.streak > 0 ? '改善' : prof.streak < 0 ? '退步' : '持平'}`
      : null;

    // ── 9. 負磅（與上仗比較，用 Ainslie 換算，作者實測影響遠小於外界看法）──
    if (carried != null && prof?.lastActualWeight != null) {
      const d = carried - prof.lastActualWeight;
      f.weightRel = clamp(-d / lpl, -1, 1);
      L.weightLabel = `負磅 ${carried}（較上仗 ${d > 0 ? '+' : ''}${d} 磅，${race.distance}m 約 ${lpl} 磅=1馬位）`;
    } else {
      f.weightRel = carried != null ? normalizeInSet(-carried, carriedW.map(w => -w)) : null;
      L.weightLabel = carried != null ? `負磅 ${carried}（無上仗比較）` : null;
    }

    // ── 10. 負磅/排位體重比 ──
    // 註：書中用「磅肉」(body weight)，本 DB 只有排位體重，故用
    //     負磅/排位體重 作近似，UI 已標明。
    if (carried != null && prof?.lastHorseWeight) {
      const cur = carried / prof.lastHorseWeight;
      f.weightRatioRel = clamp(-(cur - 1) * 2, -1, 1);
      L.weightRatioLabel = `負磅/排位體重 ${cur.toFixed(3)}（上仗 ${prof.lastHorseWeight} 磅）`;
    } else if (carried != null && declared) {
      const cur = carried / declared;
      f.weightRatioRel = clamp(-(cur - 1) * 2, -1, 1);
      L.weightRatioLabel = `負磅/排位體重 ${cur.toFixed(3)}（近似）`;
    } else f.weightRatioRel = null;

    // ── 11. 排位體重 ──
    f.declaredWeightRel = declared != null
      ? (declared < 1050 ? -0.3 : clamp((1150 - declared) / 100, -1, 1)) : null;
    L.declaredWeightLabel = declared != null ? `排位體重 ${declared} 磅` : null;

    // ── 12. 體重變化 ──
    if (declared != null && prof?.lastHorseWeight != null) {
      const d = declared - prof.lastHorseWeight;
      f.declaredWeightDiffRel = clamp(-d / 20, -1, 1);
      L.declaredWeightDiffLabel = `排位體重 ${d > 0 ? '+' : ''}${d} 磅`
        + (d <= -20 ? '（大跌，留意狀態）' : d >= 15 ? '（上升，可能讓重）' : '');
    } else {
      f.declaredWeightDiffRel = null;
    }

    // ── 13. 騎師實力 ──
    f.jockeyRel = normalizeInSet(jockeyScores[idx], jockeyScores);
    const jb = stats.jockey.get(h.jockey_id);
    L.jockeyLabel = jb
      ? `調整後比率 ${(adjRatio(jb.w, jb.s, jb.t, jb.runs) * 100).toFixed(1)}%（${jb.runs} 場）`
      : null;

    // ── 14. 騎師近期狀態（近 30 日 vs 長期）──
    if (jb && jb.runs >= 20 && jb.recent.runs >= 3) {
      const long = adjRatio(jb.w, jb.s, jb.t, jb.runs);
      const rec = adjRatio(jb.recent.w, jb.recent.s, jb.recent.t, jb.recent.runs);
      f.jockeyFormRel = clamp((rec - long) * 0.1, -1, 1);
      L.jockeyFormLabel = `近 30 日 ${(rec * 100).toFixed(1)}% vs 長期 ${(long * 100).toFixed(1)}%`;
    } else f.jockeyFormRel = null;

    // ── 15. 騎師場地/路程適應 ──
    let jc = null, jcRuns = 0, jdRuns = 0;
    if (jb?.byCourse?.get(race.racecourse)?.runs >= 8) {
      const c = jb.byCourse.get(race.racecourse);
      jcRuns = c.runs;
      jc = adjRatio(c.w, c.s, c.t, c.runs);
      const d = jb.byDist.get(race.distance);
      if (d?.runs >= 8) {
        jdRuns = d.runs;
        jc = jc * 0.6 + adjRatio(d.w, d.s, d.t, d.runs) * 0.4;
      }
    }
    f.jockeyCourseRel = jc != null ? clamp((jc - 0.55) * 2.5, -1, 1) : null;
    L.jockeyCourseLabel = jc != null
      ? `${race.racecourse} ${jcRuns} 場${jdRuns ? ` + ${race.distance}m ${jdRuns} 場` : ''}：${(jc * 100).toFixed(1)}%`
      : null;

    // ── 16. 馬師實力 ──
    f.trainerRel = normalizeInSet(trainerScores[idx], trainerScores);
    const tb = stats.trainer.get(h.trainer_id);
    L.trainerLabel = tb
      ? `調整後比率 ${(adjRatio(tb.w, tb.s, tb.t, tb.runs) * 100).toFixed(1)}%（${tb.runs} 場）`
      : null;

    // ── 17. 騎練合作 ──
    const jcPair = stats.jt.get(`${h.jockey_id}|${h.trainer_id}`);
    f.jtRel = jcPair && jcPair.runs >= 5
      ? clamp((adjRatio(jcPair.w, jcPair.s, jcPair.t, jcPair.runs) - 0.55) * 2.5, -1, 1) : null;
    L.jtLabel = jcPair && jcPair.runs >= 5
      ? `合作 ${jcPair.runs} 場，${jcPair.w}勝${jcPair.s}亞${jcPair.t}季`
      : null;

    // ── 18. 檔位（加權平均線平滑後，全場正規化）──
    const dc = drawCurve?.get(h.draw);
    f.drawRel = dc != null ? clamp((dc - 0.55) * 2.5, -1, 1) : null;
    L.drawLabel = dc != null
      ? `${h.draw} 檔，平滑後調整比率 ${(dc * 100).toFixed(1)}%` : null;

    // ── 19. 路程適應（權重刻意低：作者 p82 指出「死路程」是假的）──
    let distScore = null, distN = 0, distAvg = null;
    if (prof?.hist?.length >= 3) {
      const exact = [], near = [];
      for (const r of prof.hist) {
        if (!r.finish_position) continue;
        if (r.distance === race.distance) exact.push(r.finish_position);
        else if (Math.abs((r.distance || 0) - race.distance) <= 200) near.push(r.finish_position);
      }
      const use = exact.length >= 2 ? exact : near;
      if (use.length >= 2) {
        distN = use.length;
        distAvg = use.reduce((a, b) => a + b, 0) / use.length;
        distScore = clamp((6 - distAvg) / 5, -1, 1);
      }
    }
    f.distRel = distScore;
    L.distLabel = distN ? `${race.distance}m 跑過 ${distN} 次，平均第 ${distAvg.toFixed(1)} 名` : null;

    // ── 20. 場地/泥草適應（作者唯一證實有效的馬匹特徵）──
    let goingScore = null, gSame = 0, gSameAvg = null, gOtherAvg = null;
    if (prof?.hist?.length >= 3 && race.track_type) {
      const same = [], other = [];
      for (const r of prof.hist) {
        if (!r.finish_position) continue;
        (r.track_type === race.track_type ? same : other).push(r.finish_position);
      }
      if (same.length >= 2) {
        gSame = same.length;
        gSameAvg = same.reduce((a, b) => a + b, 0) / same.length;
        if (other.length >= 2) {
          gOtherAvg = other.reduce((a, b) => a + b, 0) / other.length;
          goingScore = clamp((gOtherAvg - gSameAvg) / 3, -1, 1);
        } else {
          goingScore = clamp((6 - gSameAvg) / 5, -1, 1);
        }
      }
    }
    f.goingRel = goingScore;
    L.goingLabel = gSame
      ? `${race.track_type} 跑過 ${gSame} 次，平均第 ${gSameAvg.toFixed(1)} 名`
        + (gOtherAvg != null ? `（異場地 ${gOtherAvg.toFixed(1)} 名）` : '')
      : null;

    // ── 21. 升降班 ──
    const cur = classRanks[idx];
    const prev = prof ? classRank(prof.lastClass) : null;
    if (cur != null && prev != null && cur !== prev) {
      f.classMoveRel = (cur - prev) * 0.3;
      L.classMoveLabel = cur > prev ? '升班' : '降班';
    } else { f.classMoveRel = cur != null ? 0 : null; L.classMoveLabel = null; }

    // ── 22. 配備變動 ──
    if (h.gear && prof?.lastGear) {
      const added = gearTokens(h.gear).filter(t => !gearTokens(prof.lastGear).includes(t));
      const removed = gearTokens(prof.lastGear).filter(t => !gearTokens(h.gear).includes(t));
      const negative = added.filter(t => ['EYE', 'HOLM', 'IRONT', 'TONGUE', 'PACING'].includes(t)).length;
      f.gearRel = added.length ? clamp(0.15 - negative * 0.35, -1, 1)
        : (removed.length ? 0.2 : 0);
      L.gearLabel = [
        added.length ? `加 ${added.join('/')}` : null,
        removed.length ? `除 ${removed.join('/')}` : null,
        !added.length && !removed.length ? '配備不變' : null,
      ].filter(Boolean).join('、');
    } else { f.gearRel = null; L.gearLabel = h.gear || null; }

    // ── 23. 轉馬房 ──
    if (h.trainer_id && prof?.lastTrainer && h.trainer_id !== prof.lastTrainer) {
      const settled = prof.hist.some(r => r.trainer_id === h.trainer_id);
      f.stableRel = settled ? 0.2 : -0.6;
      L.stableLabel = settled ? '已轉倉（有合作成績）' : '轉倉初出';
    } else if (h.trainer_id && prof?.lastTrainer) {
      f.stableRel = 0.2;
      L.stableLabel = '留倉';
    } else f.stableRel = null;

    // ── 24. 走位前置度（真實走位同場正規化：+1 = 全場最前）──
    const pi = paceInfos[idx];
    if (pi) {
      f.paceRel = fieldAvgs.length >= 2
        ? clamp(-normalizeInSet(pi.avg, fieldAvgs), -1, 1)
        : 0;
      L.paceLabel = `${pi.style}（近仗首段 ${pi.ps.slice(0, 3).join('、')} 位，加權均位 ${pi.avg.toFixed(1)}）`;
    } else { f.paceRel = null; L.paceLabel = null; }

    // ── 25. 步速契合度（跑法 vs 場面形勢：快利後追、慢利前領）──
    if (pi && paceLevel) {
      f.paceBiasRel = PACE_FIT[paceLevel][pi.style] ?? 0;
      L.paceBiasLabel = `同場形勢${paceLevel}（利${paceFavours}），此馬${pi.style}`;
    } else { f.paceBiasRel = null; L.paceBiasLabel = null; }

    // ── 26. 後勁指數（同場正規化：+1 = 全場末段最勁）──
    const ci = closingIdxs[idx];
    if (ci) {
      f.closingRel = closingField.length >= 2
        ? clamp(normalizeInSet(ci.idx, closingField), -1, 1)
        : 0;
      L.closingLabel = `後勁指數 ${ci.idx.toFixed(3)}（近 ${ci.n} 仗）`;
    } else { f.closingRel = null; L.closingLabel = null; }

    // ── 26b. 速度圖數（Beyer，同場正規化：+1 = 全場圖數最高）──
    const fi = figInfos[idx];
    if (fi) {
      f.speedFigRel = figField.length >= 2
        ? clamp(normalizeInSet(fi.fig, figField), -1, 1)
        : 0;
      L.speedFigLabel = `近 ${fi.n} 仗圖數 ${fi.fig.toFixed(1)}（最佳 ${fi.best.toFixed(1)}）`
        + (fi.w2w ? `，${fi.w2w} 仗冇壓力放頭⚠` : '');
    } else { f.speedFigRel = null; L.speedFigLabel = null; }

    // ── 27. 市場預期 log(1/賠率) ──
    if (h.odds) {
      f.marketRel = normalizeInSet(lnOddRs[idx], lnOddRs);
      L.lnOddR = +Math.log(1 / h.odds).toFixed(4);
    } else { f.marketRel = null; L.lnOddR = null; }

    return {
      features: f,
      labels: { ...L, odds: h.odds },
      detail: { ...L },
      profile: prof,
    };
  });
}

function gearTokens(g) {
  if (!g) return [];
  return String(g).split(/[/,\s]+/).map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .map(t => t.replace(/-.*$/, '').replace(/[12]$/, ''))
    .filter(Boolean)
    .sort();
}

module.exports = {
  loadActorStats, loadHorseProfiles, loadHorseHistory, profilesBefore,
  buildRaceFeatures, buildDrawCurve, buildProfile,
  scoreOf, normalizeInSet, classRank, gearTokens, dstr, diffDays, num,
  CLASS_RANK, COURSE_RANK,
};
