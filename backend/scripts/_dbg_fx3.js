const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  // 賽季頁搵 fixtures tab
  await page.goto('https://www.whoscored.com/Regions/252/Tournaments/2/Seasons/11141/england-premier-league', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 5000));
  const fx = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a')).find(x => (x.innerText || '').trim() === 'Fixtures');
    return a ? a.getAttribute('href') : null;
  });
  console.log('Fixtures tab:', fx);
  if (!fx) process.exit(0);
  await page.goto('https://www.whoscored.com' + fx, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 8000));
  const info = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/matches/"]'));
    const hrefs = [...new Set(anchors.map(a => a.getAttribute('href')))].slice(0, 8);
    const rows = Array.from(document.querySelectorAll('[class*="Match-module_row"]')).slice(0, 4)
      .map(r => r.innerText.replace(/\s+/g, ' ').slice(0, 80));
    return { nAnchors: anchors.length, hrefs, rows };
  });
  console.log(JSON.stringify(info, null, 1));
  await browser.close(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
