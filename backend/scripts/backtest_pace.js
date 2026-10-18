// ── 步速分析回測 ──────────────────────────────────────────────────────────
// 用 2026 年 9 月賽期（有賽果 + 每場分段）驗證步速預測：
//   預測 = 只用賽前資料（馬匹過往走位 → 跑法 → 同場分佈 → 步速等級）
//   實際 = 該場分段時間：頭馬（首段最快）首段 vs 馬會標準時間
//          （無標準分段嘅路程用經驗中位數做基準）
// 執行：docker compose run --rm backend node scripts/backtest_pace.js
const pool = require('../src/db/pool');

// ── 同 pace.js 一致嘅跑法邏輯 ──
function parsePositions(rp) {
  if (!rp) return [];
  return String(rp).split(/\s+/).filter(Boolean)
    .map(t => { const n = parseInt(t, 10); return n > 0 && n < 25 ? n : null; })
    .filter(v => v != null);
}
function styleOf(avg) {
  if (avg <= 2.5) return '前領';
  if (avg <= 4.0) return '前速';
  if (avg <= 6.5) return '均速';
  return '後追';
}
function predictLevel(known) {
  const nLead = known.filter(s => s === '前領').length;
  const nPress = known.filter(s => s === '前速').length;
  if (known.length < 3) return null;
  if (nLead >= 2 || nLead + nPress >= 5) return '快';
  if (nLead + nPress <= 1) return '慢';
  return '正常';
}

// 標準時間 "1.09.30" / "0.56.40" → 秒
function parseStd(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d+)\.(\d{2})\.(\d{2})$/);
  return m ? +m[1] * 60 + +m[2] + +m[3] / 100 : null;
}

(async () => {
  // 1. 馬會標準時間（首段對應：1000/1200→1200-800、1600→1600-1200、2000→2000-1600）
  const stdRes = await pool.query(`SELECT racecourse, distance, race_class,
      standard_time, split_start_2000, split_1200_800, split_1600_1200
    FROM course_times`);
  const std = new Map(); // `${course}|${dist}|${class}` → { first, total }
  const stdAny = new Map(); // `${course}|${dist}` → [{first,total}]
  for (const r of stdRes.rows) {
    const first = r.distance === 1600 || r.distance === 1650
      ? parseStd(r.split_1600_1200)
      : (r.distance === 2000 ? parseStd(r.split_start_2000) : parseStd(r.split_1200_800));
    const rec = { first, total: parseStd(r.standard_time), cls: r.race_class };
    const k1 = `${r.racecourse}|${r.distance}|${r.race_class}`;
    const k2 = `${r.racecourse}|${r.distance}`;
    std.set(k1, rec);
    if (!stdAny.has(k2)) stdAny.set(k2, []);
    stdAny.get(k2).push(rec);
  }

  // 2. 9 月賽期每一場：實際分段（首段最快 = 實際早段領放）
  const racesRes = await pool.query(`
    WITH s AS (
      SELECT race_date, race_no, racecourse, distance, going, horse_name,
             finish_position, seg1::numeric seg1n, finish_time,
             running_positions
      FROM race_sectional_times
      WHERE race_date >= '2026-09-01' AND seg1 IS NOT NULL AND seg1 <> '')
    SELECT race_date, race_no, racecourse, distance,
            (ARRAY_AGG(going ORDER BY going))[1] going,
            MIN(seg1n) leader_seg1,
            COUNT(*) runners,
            (ARRAY_AGG(horse_name ORDER BY seg1n))[1] early_leader,
            (ARRAY_AGG(finish_time ORDER BY finish_position NULLS LAST))[1] winner_time,
            (ARRAY_AGG(horse_name ORDER BY finish_position NULLS LAST))[1] winner
    FROM s GROUP BY 1,2,3,4 ORDER BY race_date, race_no`);
  const testRaces = racesRes.rows;

  // 經驗基準（每 course|dist 嘅 leader_seg1 中位數，leave-one-out）
  const allRes = await pool.query(`
    WITH s AS (
      SELECT race_date, race_no, racecourse, distance, seg1::numeric seg1n
      FROM race_sectional_times WHERE seg1 IS NOT NULL AND seg1 <> '')
    SELECT race_date, race_no, racecourse, distance, MIN(seg1n) l
    FROM s GROUP BY 1,2,3,4`);
  const byCourseDist = new Map();
  for (const r of allRes.rows) {
    const k = `${r.racecourse}|${r.distance}`;
    if (!byCourseDist.has(k)) byCourseDist.set(k, []);
    byCourseDist.get(k).push({ key: `${dateStr(r.race_date)}|${r.race_no}`, l: +r.l });
  }
  function baseline(course, dist, raceKey) {
    const arr = (byCourseDist.get(`${course}|${dist}`) || []).filter(x => x.key !== raceKey).map(x => x.l);
    if (arr.length < 5) return null;
    arr.sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)];
  }
  function dateStr(d) { return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }

  // 3. 每場跑位紀錄（賽前）
  const names = [...new Set(
    (await pool.query(`
      SELECT DISTINCT horse_name FROM racecard
      WHERE race_date >= '2026-09-01' AND race_date < '2026-10-01' AND horse_name IS NOT NULL
      UNION
      SELECT DISTINCT horse_name FROM race_records
      WHERE race_date >= '2026-09-01' AND race_date < '2026-10-01' AND horse_name IS NOT NULL`)).rows.map(r => r.horse_name)
  )];
  const paceRes = await pool.query(`
    SELECT horse_name, TO_CHAR(race_date,'YYYY-MM-DD') d, running_positions rp
    FROM race_sectional_times
    WHERE horse_name = ANY($1) AND running_positions IS NOT NULL AND running_positions <> ''
    ORDER BY race_date DESC`, [names]);
  const paceRows = new Map();
  for (const r of paceRes.rows) {
    if (!paceRows.has(r.horse_name)) paceRows.set(r.horse_name, []);
    paceRows.get(r.horse_name).push(r);
  }

  // 每場參賽馬（racecard 優先，冇就用 race_records）
  const rcRes = await pool.query(`
    SELECT TO_CHAR(race_date,'YYYY-MM-DD') d, race_no, horse_name FROM racecard
    WHERE race_date >= '2026-09-01' AND race_date < '2026-10-01'`);
  const rrRes = await pool.query(`
    SELECT TO_CHAR(race_date,'YYYY-MM-DD') d, race_no, horse_name, race_class FROM race_records
    WHERE race_date >= '2026-09-01' AND race_date < '2026-10-01'`);
  const runnersOf = new Map();
  for (const r of rcRes.rows) {
    const k = `${r.d}|${r.race_no}`;
    if (!runnersOf.has(k)) runnersOf.set(k, []);
    runnersOf.get(k).push(r.horse_name);
  }
  for (const r of rrRes.rows) {
    const k = `${r.d}|${r.race_no}`;
    if (!runnersOf.has(k)) runnersOf.set(k, []);
    runnersOf.get(k).push(r.horse_name);
  }

  // 4. 逐場對比
  const LEVELS = ['快', '正常', '慢'];
  const actualOf = (ratio) => (ratio > 1.015 ? '快' : ratio < 0.985 ? '慢' : '正常');

  console.log(`\n2026年9月賽期步速回測（${testRaces.length} 場）`);
  console.log('預測等級 | 實際（頭馬首段 vs 標準/基準） | 偏差');
  console.log('─'.repeat(88));

  const matrix = {};
  let leaderHit = 0, leaderCnt = 0, exact = 0, off1 = 0;
  const ratiosByLevel = {};

  for (const t of testRaces) {
    const d = dateStr(t.race_date);
    const key = `${d}|${t.race_no}`;
    const names2 = runnersOf.get(key) || [];

    // 預測（賽前走位）
    const infos = names2.map(nm => {
      const rows = (paceRows.get(nm) || []).filter(r => r.d < d).slice(0, 8);
      const ps = [];
      for (const r of rows) {
        const p = parsePositions(r.rp)[0];
        if (p) ps.push(p);
      }
      if (!ps.length) return null;
      let s = 0, w = 0;
      ps.forEach((v, i) => { const k = Math.pow(0.85, i); s += v * k; w += k; });
      const avg = s / w;
      return { nm, avg, style: styleOf(avg) };
    }).filter(Boolean);
    const pred = predictLevel(infos.map(x => x.style));
    const projLeader = infos.length
      ? infos.sort((a, b) => a.avg - b.avg)[0].nm : null;

    // 實際（首段最快 vs 基準）
    const refStd = std.get(`${t.racecourse}|${t.distance}|`) || null;
    let ref = null, refSrc = '';
    const stdList = stdAny.get(`${t.racecourse}|${t.distance}`) || [];
    const stdFirst = stdList.map(x => x.first).filter(Boolean).sort((a, b) => a - b);
    if (stdFirst.length) { ref = stdFirst[Math.floor(stdFirst.length / 2)]; refSrc = '標準'; }
    const emp = baseline(t.racecourse, t.distance, key);
    if (emp != null && (ref == null || Math.abs(emp - t.leader_seg1) < Math.abs(ref - t.leader_seg1))) {
      // 有經驗基準且更貼近（自行車頭段會偏離標準，取兩者中較近係作弊？
      // 唔 — 正確做法：有標準就用標準，冇先用經驗。
    }
    if (ref == null && emp != null) { ref = emp; refSrc = '經驗'; }
    if (ref == null) continue;

    const ratio = +t.leader_seg1 / ref;
    const act = actualOf(ratio);

    if (pred) {
      matrix[pred] = matrix[pred] || {};
      matrix[pred][act] = (matrix[pred][act] || 0) + 1;
      const pi = LEVELS.indexOf(pred), ai = LEVELS.indexOf(act);
      if (pi === ai) exact++;
      else if (Math.abs(pi - ai) === 1) off1++;
      (ratiosByLevel[pred] = ratiosByLevel[pred] || []).push(ratio);
    }
    if (projLeader && t.early_leader) {
      leaderCnt++;
      if (projLeader === t.early_leader) leaderHit++;
    }

    const flag = !pred ? '無預測' : (LEVELS.indexOf(pred) - LEVELS.indexOf(act));
    console.log(
      `${d} R${String(t.race_no).padStart(2)} ${t.racecourse}${String(t.distance).padStart(5)}m ` +
      `${(pred || '—').padEnd(5)} → ${act.padEnd(5)} ` +
      `ratio=${ratio.toFixed(3)}(${refSrc}) ` +
      `領放:${projLeader ? projLeader.slice(0, 4) : '—'}/${t.early_leader ? t.early_leader.slice(0, 4) : '—'}${projLeader === t.early_leader ? '✓' : ''} ` +
      `勝:${t.winner ? t.winner.slice(0, 4) : '—'} ` +
      `${flag === '無預測' ? '' : flag === 0 ? '✓' : (flag > 0 ? `高${flag}` : `低${-flag}`)}`
    );
  }

  // 5. 摘要
  console.log('\n─── 摘要 ───');
  console.log('混淆矩陣（預測 \\ 實際）        ' + LEVELS.map(l => l.padStart(5)).join(''));
  for (const p of LEVELS) {
    console.log('  ' + p.padEnd(6) + (matrix[p] ? LEVELS.map(a => String(matrix[p][a] || 0).padStart(5)).join('') : '    —'));
  }
  const tot = exact + off1 + Object.values(matrix).reduce((s, m) => s + Object.values(m).reduce((x, y) => x + y, 0), 0);
  const nExact = exact;
  const nAll = Object.values(matrix).reduce((s, m) => s + Object.values(m).reduce((x, y) => x + y, 0), 0);
  console.log(`\n等級完全命中: ${exact}/${nAll}（${(100 * exact / Math.max(1, nAll)).toFixed(0)}%），差一級: ${off1}/${nAll}`);
  console.log(`領放馬命中: ${leaderHit}/${leaderCnt}（${(100 * leaderHit / Math.max(1, leaderCnt)).toFixed(0)}%）`);
  for (const lv of LEVELS) {
    const arr = ratiosByLevel[lv];
    if (!arr || !arr.length) continue;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    console.log(`  預測${lv.padEnd(5)} 平均實際首段比率 ${mean.toFixed(3)}（n=${arr.length}）`);
  }

  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
