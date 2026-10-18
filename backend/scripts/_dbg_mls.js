const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    await page.goto('https://www.whoscored.com/Regions/233/Tournaments/85/USA-Major-League-Soccer', { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 8000));
    console.log('title:', await page.title());
    console.log('url:', page.url());
    const seasons = await page.evaluate(() => {
      const out = [];
      for (const sel of document.querySelectorAll('select')) {
        const opts = Array.from(sel.options);
        if (opts.some(o => /20[12]\d/.test(o.innerText))) {
          return { id: sel.id, nOpts: opts.length,
            opts: opts.slice(0, 5).map(o => ({ v: (o.value||'').slice(0, 80), t: o.innerText.trim() })) };
        }
      }
      return null;
    });
    console.log('賽季 select:', JSON.stringify(seasons, null, 1));
  } catch (e) { console.error('FAIL:', e.message); }
  finally { await browser.close(); process.exit(0); }
})();
