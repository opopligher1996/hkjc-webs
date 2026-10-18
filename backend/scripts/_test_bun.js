const ws = require('../src/football/whoscored');
const pool = require('../src/db/pool');
(async () => {
  console.log('getSeasons BUN...');
  const seasons = await ws.getSeasons('BUN');
  console.log('賽季:', seasons.length);
  seasons.forEach(s => console.log(' ', s.label, s.seasonId, s.seasonUrl?.slice(-60)));
  const target = seasons.find(s => s.label === '2024/2025');
  if (!target) { console.log('搵唔到 2024/2025'); process.exit(0); }
  console.log('\ngetFixtures BUN 2024/2025...');
  const fx = await ws.getFixtures('BUN', target);
  console.log('fixtures:', fx.length);
  const ft = fx.filter(f => f.ft);
  console.log('已完場:', ft.length);
  ft.slice(0, 3).forEach(f => console.log(' ', f.homeSlug, 'vs', f.awaySlug));
  await ws.closeBrowser(); await pool.end(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
