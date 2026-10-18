const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    await page.goto('https://zq.titan007.com/cn/League/36.html', { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 6000));
    console.log('title:', await page.title());
    // 搵賽果/賽程連結
    const tabs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a')).map(a => ({
        h: (a.getAttribute('href') || '').slice(0, 80), t: (a.innerText || '').trim().slice(0, 20),
      })).filter(x => /賽果|赛果|賽程|赛程|Result|Fixture|比分|分析/i.test(x.t) || /League\/36/.test(x.h)).slice(0, 12));
    console.log('tabs:', JSON.stringify(tabs, null, 1));
    // 搵賽事 ID
    const matchIds = await page.evaluate(() => {
      const out = new Set();
      for (const a of document.querySelectorAll('a')) {
        const h = a.getAttribute('href') || '';
        const m = h.match(/(?:Analysis|Corner|Odds|Match)\.aspx\?id=(\d+)/i) || h.match(/id=(\d+)/);
        if (m) out.add({ id: +m[1], h: h.slice(0, 70), t: (a.innerText || '').trim().slice(0, 35) });
      }
      return [...out].slice(0, 15);
    });
    console.log('match IDs:', matchIds.length);
    matchIds.forEach(m => console.log('  id=' + m.id, m.t, m.h));
  } catch (e) { console.error('FAIL:', e.message); }
  finally { await browser.close(); process.exit(0); }
})();
