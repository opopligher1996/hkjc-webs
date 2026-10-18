const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    // 試英超積分/賽果頁搵賽事連結
    for (const url of [
      'https://vip.titan007.com/League/46.html',
      'https://vip.titan007.com/Schedule/46.html',
      'https://vip.titan007.com/',
    ]) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 5000));
      const title = await page.title();
      console.log(url.slice(24, 60), '→', title.slice(0, 60));
      // 搵 Corner.aspx 連結
      const cornerLinks = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href*="Corner.aspx"], a[href*="Corner.aspx?id="]'))
          .map(a => ({ h: a.getAttribute('href'), t: (a.innerText || '').trim().slice(0, 40) }))
          .slice(0, 10));
      if (cornerLinks.length) {
        console.log('  Corner 連結:', cornerLinks.length);
        cornerLinks.forEach(l => console.log('  ', l.t, l.h));
        break;
      }
      // 搵賽事連結（Analysis 或類似）
      const matchLinks = await page.evaluate(() => {
        const out = [];
        for (const a of document.querySelectorAll('a')) {
          const h = a.getAttribute('href') || '';
          if (/id=\d+/.test(h) && /Analysis|Corner|Odds/i.test(h)) {
            out.push({ h: h.slice(0, 80), t: (a.innerText || '').trim().slice(0, 30) });
          }
        }
        return [...new Map(out.map(x => [x.h, x])).values()].slice(0, 10);
      });
      if (matchLinks.length) {
        console.log('  賽事連結:', matchLinks.length);
        matchLinks.forEach(l => console.log('  ', l.t, l.h));
        break;
      }
    }
  } catch (e) { console.error('FAIL:', e.message); }
  finally { await browser.close(); process.exit(0); }
})();
