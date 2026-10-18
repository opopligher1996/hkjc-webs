const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.goto('https://www.whoscored.com/regions/252/tournaments/2/seasons/11141/stages/25544/fixtures/england-premier-league-2026-2027', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 7000));
  // 撳 previous（第一粒 dayChangeBtn）
  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button[class*="dayChangeBtn"]'));
    console.log('btns:', btns.length);
    if (btns[0]) { btns[0].click(); return true; }
    return false;
  });
  console.log('clicked prev:', clicked);
  await new Promise(r => setTimeout(r, 6000));
  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[class*="Match-module_row"]')).slice(0, 6)
      .map(r => r.innerText.replace(/\s+/g, ' ').slice(0, 90)));
  console.log('撳完 prev 之後 rows:');
  rows.forEach(r => console.log(' ', r));
  await browser.close(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
