const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    await page.goto('https://bf.titan007.com/football/Next_20261006.htm', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 6000));
    console.log('title:', await page.title());
    const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 1000));
    console.log('body:', body);
    // 搵賽事行
    const matches = await page.evaluate(() => {
      const out = [];
      for (const tr of document.querySelectorAll('tr')) {
        const tds = Array.from(tr.querySelectorAll('td'));
        if (tds.length >= 5) {
          const txt = tds.map(td => td.innerText.trim()).filter(Boolean);
          if (txt.length >= 3) out.push(txt.join(' | ').slice(0, 120));
        }
      }
      return out.slice(0, 15);
    });
    console.log('\n賽事行:');
    matches.forEach((m, i) => console.log(`  [${i}]`, m));
    // 搵 ID
    const ids = await page.evaluate(() => {
      const s = new Set();
      for (const a of document.querySelectorAll('a[href*="/detail/"], a[href*="Analysis"]')) {
        const m = (a.getAttribute('href') || '').match(/id=(\d+)/);
        if (m) s.add(m[1]);
      }
      return [...s];
    });
    console.log('\nmatch IDs:', ids.length, ids.slice(0, 8));
  } catch (e) { console.error('FAIL:', e.message); }
  finally { await browser.close(); process.exit(0); }
})();
