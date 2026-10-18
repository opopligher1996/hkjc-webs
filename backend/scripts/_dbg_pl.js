const pool = require('../src/db/pool');
const cornerlib = require('../src/football/cornerlib');
(async () => {
  const { rows } = await pool.query(`
    SELECT o.*, (m.home_corners + m.away_corners) AS actual
    FROM corner_odds o
    JOIN football_matches m ON m.id = o.match_id
    WHERE o.league = 'EPL' AND o.over_close IS NOT NULL AND m.home_corners IS NOT NULL
    ORDER BY o.match_date LIMIT 5`);
  console.log('有 join 到嘅盤口:', rows.length);
  if (rows.length) {
    console.log('第一條:', JSON.stringify(rows[0]).slice(0, 200));
    const all = await cornerlib.loadLeague('EPL');
    console.log('全部 EPL 賽事:', all.length);
    for (const o of rows.slice(0, 3)) {
      const train = all.filter(m => m.d < o.match_date);
      console.log(`\n${o.home_team} vs ${o.away_team} ${o.match_date}：train=${train.length}`);
      if (train.length < 40) { console.log('  訓練數據不足'); continue; }
      const fit = cornerlib.fitModel(train);
      const sm = cornerlib.fitStateMultipliers(train).m;
      const p = cornerlib.predict(fit, sm, o.home_team, o.away_team, 3000);
      if (p.error) { console.log('  PREDICT ERROR:', p.error); continue; }
      console.log(`  expCorners=${p.expCorners} probs=`, JSON.stringify(p.probs));
      // 計 P(大線)
      const line = +o.line;
      let over = 0, total = 0;
      for (let t = 0; t < p.dist.length; t++) { total += p.dist[t]; if (t > line) over += p.dist[t]; }
      const pOver = total > 0 ? over / total : null;
      console.log(`  線=${line} P(大)=${pOver} over_close=${o.over_close} edge=${pOver * o.over_close - 1}`);
    }
  }
  await pool.end(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
