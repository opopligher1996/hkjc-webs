// 用現有 810 場驗證：(A) 休息日 vs 角球率  (B) 強隊落後 vs 弱隊落後嘅尾段角球率
const pool = require('../src/db/pool');
(async () => {
  const matches = (await pool.query(`
    SELECT id, match_date::text d, home_team, away_team, home_corners, away_corners
    FROM football_matches WHERE league='EPL' ORDER BY match_date`)).rows;
  console.log(`樣本: ${matches.length} 場\n`);

  // ── A. 休息日 ──
  const lastMatch = new Map();
  const restBuckets = {};   // rest days → [corners sum, count]
  for (const m of matches) {
    for (const side of ['home', 'away']) {
      const team = side === 'home' ? m.home_team : m.away_team;
      const corners = side === 'home' ? m.home_corners : m.away_corners;
      const prev = lastMatch.get(team);
      if (prev) {
        const rest = Math.round((new Date(m.d) - new Date(prev)) / 86400000);
        const b = rest <= 3 ? '≤3日' : rest <= 4 ? '4日' : rest <= 5 ? '5日' : rest <= 6 ? '6日' : rest <= 7 ? '7日' : '≥8日';
        if (!restBuckets[b]) restBuckets[b] = { sum: 0, n: 0 };
        restBuckets[b].sum += corners; restBuckets[b].n++;
      }
      lastMatch.set(team, m.d);
    }
  }
  console.log('── A. 休息日 vs 該隊角球數 ──');
  const order = ['≤3日', '4日', '5日', '6日', '7日', '≥8日'];
  for (const b of order) {
    const x = restBuckets[b];
    if (x) console.log(`  休 ${b.padEnd(4)} 場均 ${(x.sum / x.n).toFixed(2)} 角球（n=${x.n}）`);
  }

  // ── B. 強隊 vs 弱隊落後時嘅尾段角球率 ──
  // 強弱 proxy：該隊喺樣本內嘅場均角球（for）
  const teamCornAvg = new Map();
  const cnt = new Map();
  for (const m of matches) {
    for (const side of ['home', 'away']) {
      const team = side === 'home' ? m.home_team : m.away_team;
      const corners = side === 'home' ? m.home_corners : m.away_corners;
      teamCornAvg.set(team, (teamCornAvg.get(team) || 0) + corners);
      cnt.set(team, (cnt.get(team) || 0) + 1);
    }
  }
  const strength = new Map();
  for (const [t, s] of teamCornAvg) strength.set(t, s / cnt.get(t));
  const median = [...strength.values()].sort((a, b) => a - b);
  const med = median[Math.floor(median.length / 2)];

  const events = (await pool.query(`
    SELECT e.match_id, e.minute, e.is_home, e.event_type
    FROM football_match_events e
    JOIN football_matches m ON m.id = e.match_id
    WHERE m.league='EPL' AND e.event_type IN ('corner','goal')`)).rows;
  const byMatch = new Map();
  for (const e of events) {
    if (!byMatch.has(e.match_id)) byMatch.set(e.match_id, []);
    byMatch.get(e.match_id).push(e);
  }
  // 強隊落後/弱隊落後 喺 60-90' 嘅角球率（每隊每場）
  const stat = { strongTrail: { c: 0, n: 0 }, weakTrail: { c: 0, n: 0 }, strongLead: { c: 0, n: 0 }, strongDraw: { c: 0, n: 0 } };
  for (const m of matches) {
    const evs = byMatch.get(m.id) || [];
    const goals = evs.filter(e => e.event_type === 'goal').sort((a, b) => a.minute - b.minute);
    const cornersLate = evs.filter(e => e.event_type === 'corner' && e.minute >= 60);
    for (const side of [true, false]) {
      const team = side ? m.home_team : m.away_team;
      const isStrong = strength.get(team) > med;
      // 60' 時比分
      let h = 0, a = 0;
      for (const g of goals) { if (g.minute > 60) break; if (g.is_home) h++; else a++; }
      const my = side ? h : a, opp = side ? a : h;
      const key = my < opp ? (isStrong ? 'strongTrail' : 'weakTrail') : isStrong && my === opp ? 'strongDraw' : isStrong ? 'strongLead' : null;
      if (!key) continue;
      stat[key].c += cornersLate.filter(c => c.is_home === side).length;
      stat[key].n += 1;   // 每隊每場 0.5 個時段（30 分鐘）
    }
  }
  const per = (x) => (x.n ? (x.c / x.n).toFixed(2) : '-');
  console.log('\n── B. 60-90\' 落後時嘅角球率（強隊 vs 弱隊）──');
  console.log(`  強隊落後（每場）: ${per(stat.strongTrail)} 角球（n=${stat.strongTrail.n}）`);
  console.log(`  弱隊落後（每場）: ${per(stat.weakTrail)} 角球（n=${stat.weakTrail.n}）`);
  console.log(`  對照—強隊平手: ${per(stat.strongDraw)}（n=${stat.strongDraw.n}）`);
  console.log(`  對照—強隊領先: ${per(stat.strongLead)}（n=${stat.strongLead.n}）`);
  await pool.end(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
