const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

  // 1) 今日賽事
  const today = new Date().toISOString().slice(0, 10);
  const url1 = `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${today}`;
  await page.goto(url1, { waitUntil: 'networkidle2', timeout: 15000 });
  const sched = JSON.parse(await page.evaluate(() => document.body.innerText));
  const events = (sched.events || []).filter(e => e.tournament?.category?.name === 'England' || e.status?.type === 'finished');
  console.log(`今日賽事: ${sched.events?.length || 0} 場（England: ${events.length}）`);
  if (events.length > 0) {
    const ev = events[0];
    console.log(`樣本: ${ev.homeTeam?.name} vs ${ev.awayTeam?.name} (${ev.homeScore?.current}-${ev.awayScore?.current}) id=${ev.id}`);
    // 2) 詳細統計
    const url2 = `https://api.sofascore.com/api/v1/event/${ev.id}/statistics`;
    await page.goto(url2, { waitUntil: 'networkidle2', timeout: 15000 });
    const statsText = await page.evaluate(() => document.body.innerText);
    const stats = JSON.parse(statsText);
    console.log('\n★ 統計數據:');
    for (const group of (stats.statistics || [])) {
      if (group.groupName === 'Team statistics') {
        for (const item of group.statisticsItems || []) {
          console.log(`  ${item.name}: ${item.home} - ${item.away}`);
        }
      }
    }
  }
  // 3) 角球專門
  console.log('\n--- 有冇角球數據？ ---');
  if (events.length > 0) {
    const ev = events[0];
    const url3 = `https://api.sofascore.com/api/v1/event/${ev.id}/corners`;
    try {
      await page.goto(url3, { waitUntil: 'networkidle2', timeout: 10000 });
      const cornersText = await page.evaluate(() => document.body.innerText);
      console.log('corners endpoint:', cornersText.slice(0, 300));
    } catch (e) { console.log('corners endpoint fail:', e.message.slice(0, 50)); }
  }
  await browser.close(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
