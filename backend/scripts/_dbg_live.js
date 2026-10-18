const titanLive = require('../src/football/titanLive');
(async () => {
  const ids = await titanLive.findLiveIds(['英超', '美職', '美职业', '德甲', '西甲', 'Bundesliga', 'La Liga', 'Major League Soccer', 'MLS']);
  console.log('搵到:', ids.length, '場');
  ids.slice(0, 8).forEach(m => console.log(' ', m.titanId, '|', m.leagueName, '|', m.timeStr, '|', m.text));
  // 試 scrape 一場
  if (ids.length) {
    const d = await titanLive.scrapeLiveMatch(ids[0].titanId);
    console.log('scrape 首場:', JSON.stringify(d).slice(0, 250));
  }
  await titanLive.closeBrowser();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
