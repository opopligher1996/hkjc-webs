const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    // 入 2025/26 最後一輪嘅 Corner 頁
    await page.goto('https://vip.titan007.com/Corner.aspx?id=2789503&t=1&l=0', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));
    console.log('title:', await page.title());
    // 搵「上一場/下一場」或者其他英超賽事連結
    const nav = await page.evaluate(() => {
      const out = [];
      for (const a of document.querySelectorAll('a')) {
        const h = a.getAttribute('href') || '';
        const t = (a.innerText || '').trim();
        if (/id=\d+/.test(h) && (/上一|上一场|prev|next|下一|下一场|英超/.test(t) || /Analysis|Corner/.test(h))) {
          out.push({ h: h.slice(0, 80), t: t.slice(0, 40) });
        }
      }
      return [...new Map(out.map(x => [x.h, x])).values()].slice(0, 10);
    });
    console.log('導航連結:', JSON.stringify(nav, null, 1).slice(0, 600));
    // 頁面上有冇「本輪賽事」？
    const roundLinks = await page.evaluate(() => {
      const out = [];
      for (const a of document.querySelectorAll('a')) {
        const h = a.getAttribute('href') || '';
        const t = (a.innerText || '').trim();
        if (/id=\d+/.test(h) && /VS|vs/.test(t)) out.push({ h: h.slice(0, 60), t: t.slice(0, 50) });
      }
      return [...new Map(out.map(x => [x.h, x])).values()].slice(0, 15);
    });
    console.log('同輪賽事:', roundLinks.length);
    roundLinks.forEach(l => console.log(' ', l.t, l.h));
  } catch (e) { console.error('FAIL:', e.message); }
  finally { await browser.close(); process.exit(0); }
})();
