const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.goto('https://www.whoscored.com/Regions/252/Tournaments/2/England-Premier-League', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 8000));
  console.log('title:', await page.title());
  console.log('url:', page.url());
  const info = await page.evaluate(() => {
    const sels = Array.from(document.querySelectorAll('select'));
    return {
      nSelects: sels.length,
      selectInfo: sels.slice(0, 6).map(s => ({
        id: s.id, cls: (s.className || '').slice(0, 40),
        nOpts: s.options.length,
        firstOpts: Array.from(s.options).slice(0, 3).map(o => (o.innerText || '').trim().slice(0, 24)),
        firstVal: s.options[0] ? (s.value || '').slice(0, 80) : null,
      })),
    };
  });
  console.log(JSON.stringify(info, null, 1));
  await browser.close(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
