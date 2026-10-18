const ws = require('../src/football/whoscored');
const pool = require('../src/db/pool');
(async () => {
  console.log('1) getSeasons LAL...');
  const seasons = await ws.getSeasons('LAL');
  console.log('賽季:', seasons.length);
  seasons.slice(0, 3).forEach(s => console.log(' ', s.label, s.seasonId, s.seasonUrl?.slice(-60)));
  
  const target = seasons.find(s => s.label === '2026/2027') || seasons[0];
  console.log('\n2) getFixtures LAL', target.label);
  const fx = await ws.getFixtures('LAL', target);
  console.log('fixtures:', fx.length);
  fx.slice(0, 3).forEach(f => console.log(' ', f.homeSlug, 'vs', f.awaySlug, 'ft=' + f.ft));
  
  await ws.closeBrowser(); await pool.end(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
