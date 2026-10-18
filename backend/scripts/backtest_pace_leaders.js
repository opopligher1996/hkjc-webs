// ── 領放候選 → 放頭贏馬 規律驗證（跨賽日）─────────────────────────────────
// 用法：docker compose run --rm backend node scripts/backtest_pace_leaders.js [YYYY-MM] [YYYY-MM]
// 預設 2026-09。
// 核心問題：三甲領放候選名單係咪穩定網住「放頭贏馬」（實際早段領放 + 贏頭馬）？
const pool = require('../src/db/pool');

const FROM = process.argv[2] || '2026-09';
const TO = process.argv[3] || FROM;
const parsePos = (rp) => String(rp || '').split(/\s+/).filter(Boolean)
  .map(t => { const n = parseInt(t, 10); return n > 0 && n < 25 ? n : null; })
  .filter(v => v != null);
const styleOf = (a) => a <= 2.5 ? '前領' : a <= 4 ? '前速' : a <= 6.5 ? '均速' : '後追';

(async () => {
  const days = (await pool.query(`
    SELECT DISTINCT TO_CHAR(race_date,'YYYY-MM-DD') d FROM race_sectional_times
    WHERE TO_CHAR(race_date,'YYYY-MM') BETWEEN $1 AND $2
    ORDER BY 1`, [FROM, TO])).rows.map(r => r.d);

  // 所有相關馬嘅賽前走位（一次過載入，按日期過濾）
  const namesRes = await pool.query(`
    SELECT DISTINCT horse_name FROM race_sectional_times
    WHERE TO_CHAR(race_date,'YYYY-MM') BETWEEN $1 AND $2`, [FROM, TO]);
  const names = namesRes.rows.map(r => r.horse_name);
  const pr = await pool.query(`
    SELECT horse_name, TO_CHAR(race_date,'YYYY-MM-DD') d, running_positions rp
    FROM race_sectional_times
    WHERE horse_name = ANY($1) AND running_positions IS NOT NULL AND running_positions <> ''
    ORDER BY race_date DESC`, [names]);
  const paceRows = new Map();
  for (const r of pr.rows) {
    if (!paceRows.has(r.horse_name)) paceRows.set(r.horse_name, []);
    paceRows.get(r.horse_name).push(r);
  }
  const earlyAvgOf = (nm, before) => {
    const rows = (paceRows.get(nm) || []).filter(r => r.d < before).slice(0, 8);
    const ps = rows.map(r => parsePos(r.rp)[0]).filter(Boolean);
    if (!ps.length) return null;
    let s = 0, w = 0;
    ps.forEach((v, i) => { const k = Math.pow(0.85, i); s += v * k; w += k; });
    return s / w;
  };

  // 逐日逐場
  let races = 0, leaderIn3 = 0, cand1Hit = 0;
  let wireToWire = 0, wireIn3 = 0;
  let winnerIn3 = 0, winnerIn1 = 0;
  const byDay = [];

  for (const day of days) {
    const rows = (await pool.query(`
      SELECT race_no, horse_name, finish_position, seg1::numeric seg1n, running_positions
      FROM race_sectional_times
      WHERE race_date = $1 AND seg1 IS NOT NULL AND seg1 <> ''
      ORDER BY race_no`, [day])).rows;
    const byRace = new Map();
    for (const r of rows) {
      if (!byRace.has(r.race_no)) byRace.set(r.race_no, []);
      byRace.get(r.race_no).push(r);
    }
    let dRaces = 0, dWire = 0, dWireIn3 = 0, dLeaderIn3 = 0;
    for (const [rno, hs] of byRace) {
      // 三甲候選（賽前早段均位最細 3 匹）
      const infos = hs.map(h => ({ nm: h.horse_name, avg: earlyAvgOf(h.horse_name, day) }))
        .filter(x => x.avg != null).sort((a, b) => a.avg - b.avg);
      if (infos.length < 3) continue;
      const cands = infos.slice(0, 3).map(x => x.nm);

      const actualLeader = [...hs].sort((a, b) => a.seg1n - b.seg1n)[0].horse_name;
      const winner = hs.find(h => h.finish_position === 1) || null;
      const winnerEarly = winner ? parsePos(winner.running_positions)[0] : null;

      races++; dRaces++;
      if (cands.includes(actualLeader)) { leaderIn3++; dLeaderIn3++; }
      if (cands[0] === actualLeader) cand1Hit++;
      if (winner) {
        if (cands.includes(winner.horse_name)) winnerIn3++;
        if (cands[0] === winner.horse_name) winnerIn1++;
        if (winnerEarly === 1) {                     // 放頭贏
          wireToWire++; dWire++;
          if (cands.includes(winner.horse_name)) { wireIn3++; dWireIn3++; }
        }
      }
    }
    byDay.push({ day, dRaces, dWire, dWireIn3, dLeaderIn3 });
  }

  console.log(`\n═══ ${FROM}~${TO} 領放候選規律驗證（${days.length} 個賽日，${races} 場）═══`);
  console.log('─'.repeat(76));
  console.log('賽日       場數  實際領放喺三甲內  放頭贏馬  放頭贏馬喺三甲內');
  for (const d of byDay) {
    console.log(`${d.day}  ${String(d.dRaces).padStart(4)}  ${String(d.dLeaderIn3).padStart(12)}      ${String(d.dWire).padStart(6)}  ${String(d.dWireIn3).padStart(12)}`);
  }
  console.log('─'.repeat(76));
  console.log(`\n─── 總結（${races} 場）───`);
  console.log(`實際領放馬喺三甲候選內: ${leaderIn3}/${races}（${(100 * leaderIn3 / races).toFixed(0)}%；隨機 ≈ ${'25'}%）`);
  console.log(`首位候選命中實際領放:  ${cand1Hit}/${races}（${(100 * cand1Hit / races).toFixed(0)}%；隨機 ≈ 8%）`);
  console.log(`放頭贏馬（早段第1位兼勝出）: ${wireToWire} 場`);
  console.log(`  → 其中喺三甲候選內: ${wireIn3}/${wireToWire}（${(100 * wireIn3 / Math.max(1, wireToWire)).toFixed(0)}%）`);
  console.log(`所有頭馬喺三甲候選內: ${winnerIn3}/${races}（${(100 * winnerIn3 / races).toFixed(0)}%）`);
  console.log(`所有頭馬 = 首位候選:   ${winnerIn1}/${races}（${(100 * winnerIn1 / races).toFixed(0)}%）`);

  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
