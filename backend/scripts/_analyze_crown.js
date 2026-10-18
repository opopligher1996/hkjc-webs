const pool = require('../src/db/pool');
const cornerlib = require('../src/football/cornerlib');
(async () => {
  for (const league of ['LAL', 'BUN']) {
    const all = await cornerlib.loadLeague(league);
    if (!all) { console.log(league, '冇數據'); continue; }
    const odds = (await pool.query(
      `SELECT o.*, TO_CHAR(o.match_date,'YYYY-MM-DD') md, (m.home_corners + m.away_corners) actual
      FROM corner_odds o JOIN football_matches m ON m.id = o.match_id
      WHERE o.league = $1 AND o.over_close IS NOT NULL AND m.home_corners IS NOT NULL`,
      [league])).rows;
    console.log(`\n═══ ${league}（${all.length} WhoScored + ${odds.length} Crown）═══`);
    if (!odds.length) continue;
    const byMonth = new Map();
    for (const m of all) { const k = m.d.slice(0,7); if (!byMonth.has(k)) byMonth.set(k,[]); byMonth.get(k).push(m); }
    const months = [...byMonth.keys()].sort();
    const fits = [];
    for (let mi = 2; mi < months.length; mi++) {
      const train = all.filter(m => m.d < months[mi] + '-01');
      if (train.length < 40) continue;
      fits.push({ fit: cornerlib.fitModel(train), sm: cornerlib.fitStateMultipliers(train).m, month: months[mi], matches: byMonth.get(months[mi]) });
    }
    const buckets = {};
    for (let th = 50; th <= 85; th += 5) buckets[th] = { n: 0, over: 0 };
    const p70list = [];
    for (const f of fits) {
      for (const m of f.matches) {
        const actual = (m.home_corners||0)+(m.away_corners||0);
        const o = odds.find(x => x.md === m.d && x.home_team === m.home_team && x.actual != null);
        if (!o) continue;
        const line = +o.line;
        const p = cornerlib.predict(f.fit, f.sm, m.home_team, m.away_team, 3000);
        if (p.error) continue;
        let over=0, total=0;
        for (let t=0; t<p.dist.length; t++) { total+=p.dist[t]; if(t>line) over+=p.dist[t]; }
        const pOver = total>0 ? over/total : null;
        if (pOver==null) continue;
        const actualOver = actual > line;
        const pct = Math.floor(pOver*100/5)*5;
        if (buckets[pct]) { buckets[pct].n++; if (actualOver) buckets[pct].over++; }
        if (pOver >= 0.70) p70list.push({ d:m.d, h:m.home_team, a:m.away_team, line, p:+pOver.toFixed(3), actual, over:actualOver });
      }
    }
    console.log('P(大終盤)    場次   實際開大率');
    console.log('─'.repeat(40));
    for (const th of Object.keys(buckets).sort((a,b)=>b-a)) {
      const b = buckets[th]; if (b.n < 3) continue;
      console.log(String(th+'-'+(+th+5)+'%').padEnd(12), String(b.n).padStart(4), ((100*b.over/b.n).toFixed(1)+'%').padStart(8));
    }
    console.log(`\nP ≥ 70%: ${p70list.length} 場`);
    const overs = p70list.filter(x=>x.over).length;
    if (p70list.length) {
      console.log(`實際開大: ${overs}/${p70list.length} = ${(100*overs/p70list.length).toFixed(1)}%`);
      p70list.sort((a,b)=>b.p-a.p).forEach(x=>console.log(' ',x.d,x.h.slice(0,12).padEnd(12),'vs',x.a.slice(0,10).padEnd(10),'線'+x.line,'P='+(x.p*100).toFixed(0)+'%','實際'+x.actual,x.over?'✓大':'✗細'));
    }
  }
  await pool.end(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
