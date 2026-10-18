// ── 單日步速回測：預測 vs 真實賽果同步速 ──────────────────────────────────
// 用法：docker compose run --rm backend node scripts/backtest_pace_day.js [YYYY-MM-DD]
// 預設 2026-09-27。
// 每場比較：
//   預測（賽前資料）：形勢三級 + 領放候選
//   實際（該場分段）：早段領放馬、末段比（前快後崩程度）、前段逼埋馬數、
//                    頭馬 + 頭馬早段位置（驗證「形勢利邊類」）
const pool = require('../src/db/pool');

const DAY = process.argv[2] || '2026-09-27';
const parseSplit = (s) => { const v = parseFloat(s); return isFinite(v) && v > 5 && v < 80 ? v : null; };
const parsePos = (rp) => String(rp || '').split(/\s+/).filter(Boolean)
  .map(t => { const n = parseInt(t, 10); return n > 0 && n < 25 ? n : null; })
  .filter(v => v != null);
const styleOf = (a) => a <= 2.5 ? '前領' : a <= 4 ? '前速' : a <= 6.5 ? '均速' : '後追';

(async () => {
  // 1. 標準末段
  const std = await pool.query(`SELECT racecourse, distance, split_400_finish FROM course_times`);
  const stdLast = new Map();
  for (const r of std.rows) {
    const v = parseSplit(r.split_400_finish);
    if (v == null) continue;
    const k = `${r.racecourse}|${r.distance}`;
    if (!stdLast.has(k)) stdLast.set(k, []);
    stdLast.get(k).push(v);
  }
  const med = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };

  // 2. 該日每場實際分段
  const dayRes = await pool.query(`
    SELECT race_no, racecourse, distance, horse_name, finish_position,
           seg1::numeric seg1n,
           (CASE WHEN seg6 IS NOT NULL AND seg6<>'' THEN seg6::numeric
                 WHEN seg5 IS NOT NULL AND seg5<>'' THEN seg5::numeric
                 WHEN seg4 IS NOT NULL AND seg4<>'' THEN seg4::numeric
                 WHEN seg3 IS NOT NULL AND seg3<>'' THEN seg3::numeric
                 ELSE seg2::numeric END) lastn,
           running_positions
    FROM race_sectional_times
    WHERE race_date = $1 AND seg1 IS NOT NULL AND seg1 <> ''
    ORDER BY race_no, finish_position NULLS LAST`, [DAY]);
  const races = new Map();
  for (const r of dayRes.rows) {
    if (!races.has(r.race_no)) races.set(r.race_no, { racecourse: r.racecourse, distance: r.distance, rows: [] });
    races.get(r.race_no).rows.push(r);
  }

  // 3. 預測用料（賽前）
  const names = [...new Set(dayRes.rows.map(r => r.horse_name))];
  const pr = await pool.query(`
    SELECT horse_name, TO_CHAR(race_date,'YYYY-MM-DD') d, running_positions rp
    FROM race_sectional_times
    WHERE horse_name = ANY($1) AND race_date < $2
      AND running_positions IS NOT NULL AND running_positions <> ''
    ORDER BY race_date DESC`, [names, DAY]);
  const paceRows = new Map();
  for (const r of pr.rows) {
    if (!paceRows.has(r.horse_name)) paceRows.set(r.horse_name, []);
    paceRows.get(r.horse_name).push(r);
  }

  console.log(`\n═══ ${DAY} 步速回測：預測 vs 真實 ═══`);
  console.log(''.padEnd(118, '─'));

  let cand1Hit = 0, cand3Hit = 0, nRaces = 0, levelHit = 0, levelN = 0;
  const winnerStyles = {};

  for (const [rno, race] of [...races.entries()].sort((a, b) => a[0] - b[0])) {
    const rows = race.rows;
    // ── 預測（用呢場嘅參賽馬，唔係全日名單！）──
    const infos = rows.map(rr => {
      const rws = (paceRows.get(rr.horse_name) || []).slice(0, 8);
      const ps = rws.map(r => parsePos(r.rp)[0]).filter(Boolean);
      if (!ps.length) return null;
      let s = 0, w = 0;
      ps.forEach((v, i) => { const k = Math.pow(0.85, i); s += v * k; w += k; });
      return { nm: rr.horse_name, avg: s / w, style: styleOf(s / w) };
    }).filter(Boolean);
    const nLead = infos.filter(x => x.style === '前領').length;
    const nPress = infos.filter(x => x.style === '前速').length;
    const predLevel = infos.length >= 3
      ? (nLead >= 2 || nLead + nPress >= 5 ? '快' : nLead + nPress <= 1 ? '慢' : '正常')
      : null;
    const cands = [...infos].sort((a, b) => a.avg - b.avg).slice(0, 3).map(x => x.nm);

    // ── 實際 ──
    const seg1s = rows.map(r => ({ nm: r.horse_name, s: +r.seg1n })).sort((a, b) => a.s - b.s);
    const actualLeader = seg1s[0]?.nm;
    const lastArr = stdLast.get(`${race.racecourse}|${race.distance}`);
    const lastStd = lastArr ? med(lastArr) : null;
    const lasts = rows.map(r => +r.lastn).filter(v => isFinite(v));
    const medLast = lasts.sort((a, b) => a - b)[Math.floor(lasts.length / 2)];
    const lastRatio = lastStd ? medLast / lastStd : null;
    const actualLevel = lastRatio == null ? null
      : lastRatio > 1.015 ? '快' : lastRatio < 0.985 ? '慢' : '正常';
    // 前段逼埋：該場首段位置 ≤3 嘅馬數
    const earlyPos = rows.map(r => parsePos(r.running_positions)[0]).filter(Boolean);
    const contested = earlyPos.filter(p => p <= 3).length;
    // 頭馬 + 頭馬早段位置
    const winner = rows.find(r => r.finish_position === 1);
    const winnerEarly = winner ? parsePos(winner.running_positions)[0] : null;
    const winnerStyle = winner ? styleOf(winnerEarly ?? 8) : null;

    nRaces++;
    if (predLevel) { levelN++; if (predLevel === actualLevel) levelHit++; }
    if (actualLeader) {
      if (cands[0] === actualLeader) cand1Hit++;
      if (cands.includes(actualLeader)) cand3Hit++;
    }
    if (winnerStyle) winnerStyles[winnerStyle] = (winnerStyles[winnerStyle] || 0) + 1;

    const mark = predLevel && actualLevel
      ? (predLevel === actualLevel ? '✓' : `✗（預測${predLevel}/實際${actualLevel}）`) : '—';
    console.log(
      `R${String(rno).padStart(2)} ${race.distance}m | 形勢預測:${predLevel || '—'} vs 實際:${actualLevel || '—'} ${mark} | ` +
      `末段比:${lastRatio ? lastRatio.toFixed(3) : '—'} 前段逼埋:${contested}匹 | ` +
      `領放 預測:${cands[0] || '—'} 實際:${actualLeader} ${cands.includes(actualLeader) ? (cands[0] === actualLeader ? '✓' : '③') : '✗'} | ` +
      `勝出:${winner?.horse_name || '—'}（${winnerEarly ?? '?'}位・${winnerStyle}）`
    );
  }

  console.log(''.padEnd(118, '─'));
  console.log(`\n─── 摘要（${nRaces} 場）───`);
  console.log(`形勢等級命中: ${levelHit}/${levelN}`);
  console.log(`領放馬: 首位候選命中 ${cand1Hit}，三甲候選命中 ${cand3Hit} / ${nRaces} 場`);
  console.log(`頭馬跑法分佈:`, JSON.stringify(winnerStyles));
  console.log('\n圖例：✓ 命中 ③ 實際領放馬喺三甲候選內  ✗ 落空');
  console.log('實際形勢量法：末段比 = 全場末段中位數 ÷ 馬會標準末段（>1.015=前快後崩「快」、<0.985=留前鬥後「慢」）');

  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
