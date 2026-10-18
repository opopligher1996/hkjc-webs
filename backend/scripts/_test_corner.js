const ws = require('../src/football/whoscored');
const pool = require('../src/db/pool');
(async () => {
  console.log('1) 賽季清單…');
  const seasons = await ws.getSeasons('EPL');
  seasons.slice(0, 3).forEach(s => console.log('  ', s.label, 'season', s.seasonId, 'stage', s.stageId));
  console.log('  賽季數:', seasons.length); seasons.slice(0,3).forEach(x=>console.log('   ',x.label,x.seasonId));
  const target = seasons.find(s => s.label === '2025/2026');
  console.log('\n2) fixtures（2025/2026）…');
  const fx = await ws.getFixtures('EPL', target);
  console.log('  總場數:', fx.length);
  const done = fx.filter(f => f.ft);
  console.log('  有比分:', done.length);
  done.slice(0, 3).forEach(f => console.log('  ', f.homeSlug, f.hg, '-', f.ag, f.awaySlug, 'id', f.id));
  console.log('\n3) 抓 2 場事件…');
  for (const f of done.slice(0, 2)) {
    const ev = await ws.scrapeMatch(f.url);
    if (ev.error) { console.log('  ✗', ev.error, ev.title); continue; }
    console.log(`  ${f.homeSlug} ${ev.goals.filter(g=>g.isHome).length}-${ev.goals.filter(g=>!g.isHome).length} ${f.awaySlug} | 角球 ${ev.corners.length} 隻（主 ${ev.corners.filter(c=>c.isHome).length}）| 事件 ${ev.nEvents}`);
    console.log('    角球分鐘:', ev.corners.map(c => `${c.minute}'${c.isHome ? 'H' : 'A'}`).join(' '));
    console.log('    入球:', ev.goals.map(g => `${g.minute}'${g.isHome ? 'H' : 'A'}`).join(' '));
    const home = f.homeSlug.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
    const away = f.awaySlug.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
    const n = await ws.saveMatch({ id: f.id, league: 'EPL', season: '2025-2026', date: f.date, home, away }, ev);
    console.log('    已存 DB（事件行:', n, '）');
  }
  const cnt = await pool.query('SELECT COUNT(*) c, SUM(home_corners+away_corners) corners FROM football_matches');
  console.log('\nDB:', JSON.stringify(cnt.rows[0]));
  await ws.closeBrowser(); await pool.end(); process.exit(0);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
