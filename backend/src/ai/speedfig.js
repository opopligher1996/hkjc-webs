// ── 港版速度圖（Beyer Speed Figures，按《Picking Winners》第 7-9 章方法論）──
// 核心公式（第 8 章 Kovitz 方法）：
//   每格點數 ppf = 1000 × 0.2 ÷ par秒數（6化郎 par 73s → 2.74 點，同書中 2.8 一致）
//   原始圖數   = (par − 實際時間) ÷ 0.2 × ppf      （0 = 岩岩好班次標準）
// 每日場地偏差 variant（第 7 章）：
//   每日每場計頭馬原始圖數，全日中位數 = 場地快慢 → 每匹馬圖數加返 variant 修正
// 折扣標記（第 9 章）：
//   w2w = 一放到底（每段都第 1）；noPressure = 全場第二近馬距離 ≥ 2 馬位（冇壓力圖數要打折）
const pool = require('../db/pool');

function parseFinish(s) { // "1:10.17" | "58.21" → 秒
  if (!s) return null;
  const m = String(s).trim().match(/^(?:(\d+):)?(\d{1,2})\.(\d{2})$/);
  if (!m) return null;
  return (+m[1] || 0) * 60 + (+m[2]) + (+m[3]) / 100;
}
function parseStandard(s) { // "1.09.30" → 秒
  if (!s) return null;
  const m = String(s).trim().match(/^(\d+)\.(\d{2})\.(\d{2})$/);
  return m ? (+m[1]) * 60 + (+m[2]) + (+m[3]) / 100 : null;
}
// 走位 "4-1 3-2 2-1 1-N" → [{pos, marginL}]（margin "N"=頭馬0）
function parseRun(rp) {
  if (!rp) return [];
  return String(rp).split(/\s+/).filter(Boolean).map(tok => {
    const m = tok.match(/^(\d+)-(.+)$/);
    if (!m) return null;
    const pos = +m[1];
    let marginL = 0;
    if (m[2] === 'N') marginL = 0;
      else if (/^\d+(?:-\d+\/\d+|\/\d+)?$/.test(m[2])) {
        marginL = m[2].split('-').reduce((a, part) => {
          const f = part.split('/');
          return a + (+f[0]) + (f[1] ? (+f[1]) / (+f[2]) : 0);
        }, 0);
      } else return null;
    return { pos, marginL };
  }).filter(Boolean);
}

async function loadPars() {
  const { rows } = await pool.query(
    `SELECT racecourse, distance, race_class, standard_time FROM course_times`);
  const byClass = new Map();
  const anyClass = new Map();
  for (const r of rows) {
    const sec = parseStandard(r.standard_time);
    if (sec == null) continue;
    byClass.set(`${r.racecourse}|${r.distance}|${r.race_class}`, sec);
    const k = `${r.racecourse}|${r.distance}`;
    if (!anyClass.has(k)) anyClass.set(k, []);
    anyClass.get(k).push(sec);
  }
  const median = new Map();
  for (const [k, arr] of anyClass) {
    const s = [...arr].sort((a, b) => a - b);
    median.set(k, s[Math.floor(s.length / 2)]);
  }
  return { byClass, median };
}

// 全部賽事圖數（由 race_sectional_times）
// 回傳 [{ d, course, dist, cls, going, variant, horses: [{ nm, fig, w2w, noPressure, finish }] }]
async function buildFigures() {
  const { rows } = await pool.query(`
    SELECT TO_CHAR(race_date,'YYYY-MM-DD') d, racecourse, race_no, distance, race_class, going,
           horse_name, finish_position, finish_time, running_positions
    FROM race_sectional_times
    WHERE finish_time IS NOT NULL AND finish_time <> '' AND finish_position IS NOT NULL
    ORDER BY race_date, race_no, finish_position`);
  const pars = await loadPars();

  const racesMap = new Map();
  for (const r of rows) {
    const k = `${r.d}|${r.racecourse}|${r.race_no}`;
    if (!racesMap.has(k)) racesMap.set(k, {
      d: r.d, course: r.racecourse, race_no: r.race_no, dist: +r.distance, race_class: r.race_class || '',
      going: r.going || '', horses: [],
    });
    racesMap.get(k).horses.push(r);
  }

  // 每場：par、ppf、頭馬原始圖數
  const races = [...racesMap.values()];
  for (const race of races) {
    const par = pars.byClass.get(`${race.course}|${race.dist}|${race.race_class}`)
      ?? pars.median.get(`${race.course}|${race.dist}`);
    race.par = par;
    if (par == null) continue;
    race.ppf = 1000 * 0.2 / par;
    const winner = race.horses.find(h => h.finish_position === 1);
    race.rawWinnerFig = winner ? (par - parseFinish(winner.finish_time)) / 0.2 * race.ppf : null;
  }

  // 每日 variant：同場同日全部場次嘅頭馬原始圖數中位數（≥4 場先有效）
  const byDay = new Map();
  for (const race of races) {
    if (race.rawWinnerFig == null) continue;
    const k = `${race.d}|${race.course}`;
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(race.rawWinnerFig);
  }
  for (const race of races) {
    const arr = byDay.get(`${race.d}|${race.course}`) || [];
    race.variant = arr.length >= 4
      ? -arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)]
      : 0;
  }

  // 每匹馬圖數 + 折扣標記
  const out = [];
  for (const race of races) {
    if (race.par == null) continue;
    // 每段第二近距離（壓力偵測）
    const runLists = race.horses.map(h => parseRun(h.running_positions));
    const nSec = Math.max(...runLists.map(l => l.length), 0);
    const minGap = new Array(nSec).fill(Infinity);
    for (const l of runLists) {
      l.forEach((s, i) => {
        if (s.pos === 2 && s.marginL < minGap[i]) minGap[i] = s.marginL;
      });
    }
    race.horses = race.horses.map((h, i) => {
      const run = runLists[i];
      const led = run.length > 0 && run.every(s => s.pos === 1);
      const noPressure = led && minGap.every(g => g >= 2);
      return {
        nm: h.horse_name,
        fig: +((race.par - parseFinish(h.finish_time)) / 0.2 * race.ppf + race.variant).toFixed(1),
        w2w: led,
        noPressure: !!noPressure,
        finish: h.finish_position,
      };
    });
    out.push(race);
  }
  return out;
}

// 賽前圖數往績（新→舊，加權 0.85^i）
function figAt(figuresByHorse, name, beforeDate, lastN = 6) {
  const rows = (figuresByHorse.get(name) || []).filter(r => r.d < beforeDate).slice(0, lastN);
  if (!rows.length) return null;
  let s = 0, w = 0;
  rows.forEach((r, i) => { const k = Math.pow(0.85, i); s += r.fig * k; w += k; });
  return {
    fig: s / w,
    n: rows.length,
    best: Math.max(...rows.map(r => r.fig)),
    sd: Math.sqrt(rows.reduce((a, r) => a + (r.fig - s / w) ** 2, 0) / rows.length),
    discountRows: rows.filter(r => r.w2w && r.noPressure).length,
    last: rows[0],
  };
}

// 賽前圖數歷史（新→舊）— 供 ai/features.js 用
async function getFigureHistory(names, beforeDate) {
  const figs = await buildFigures();
  const set = new Set(names);
  const m = new Map();
  for (const race of figs) {
    if (race.d >= beforeDate) continue;
    for (const h of race.horses) {
      if (!set.has(h.nm)) continue;
      if (!m.has(h.nm)) m.set(h.nm, []);
      m.get(h.nm).unshift({ d: race.d, fig: h.fig, w2w: h.w2w, noPressure: h.noPressure }); // 新→舊
    }
  }
  return m;
}

module.exports = { buildFigures, getFigureHistory, figAt, parseFinish, parseStandard };
