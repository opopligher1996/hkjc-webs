const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    await page.goto('https://vip.titan007.com/Corner.aspx?id=3003890&t=1&l=0', { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 6000));
    console.log('title:', await page.title());
    const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 800));
    console.log('body:', body);
    // 搵表格
    const tables = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table')).map((t, i) => ({
        idx: i, rows: t.rows.length,
        sample: t.innerText.replace(/\s+/g, ' ').slice(0, 200),
      })));
    console.log('\ntables:', tables.length);
    tables.slice(0, 6).forEach(t => console.log(`  [${t.rows}行]`, t.sample));
  } catch (e) { console.error('FAIL:', e.message); }
  finally { await browser.close(); process.exit(0); }
})();
