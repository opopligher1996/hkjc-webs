const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

  // 昨日（Oct 3）
  const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  console.log('日期:', yday);
  const url1 = `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${yday}`;
  await page.goto(url1, { waitUntil: 'networkidle2', timeout: 15000 });
  const raw = await page.evaluate(() => document.body.innerText);
  try {
    const sched = JSON.parse(raw);
    const all = sched.events || [];
    console.log(`昨日賽事: ${all.length} 場`);
    // 揀一場有統計嘅
    const finished = all.filter(e => e.status?.type === 'finished');
    console.log(`已完成: ${finished.length}`);
    if (finished.length > 0) {
      const ev = finished[0];
      console.log(`樣本: ${ev.homeTeam?.name} vs ${ev.awayTeam?.name} (${ev.homeScore?.current}-${ev.awayScore?.current}) id=${ev.id} status=${ev.status?.description}`);
      // 統計
      const url2 = `https://api.sofascore.com/api/v1/event/${ev.id}/statistics`;
      await page.goto(url2, { waitUntil: 'networkidle2', timeout: 15000 });
      const statsText = await page.evaluate(() => document.body.innerText);
      const stats = JSON.parse(statsText);
      console.log('\n★ 統計:');
      for (const group of (stats.statistics || [])) {
        for (const item of group.statisticsItems || []) {
          console.log(`  ${item.name}: ${item.home ?? '-'} - ${item.away ?? '-'}`);
        }
      }
    }
  } catch (e) {
    console.log('JSON parse fail:', raw.slice(0, 200));
  }
  await browser.close(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
