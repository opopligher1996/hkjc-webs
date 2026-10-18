const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    // 主頁搵英超賽程
    await page.goto('https://vip.titan007.com/', { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 5000));
    // 搵「英超」連結
    const eplLink = await page.evaluate(() => {
      for (const a of document.querySelectorAll('a')) {
        const t = (a.innerText || '').trim();
        if (t === '英超' || t === '英 超' || /英超/.test(t)) {
          return { h: a.getAttribute('href') || '', t };
        }
      }
      return null;
    });
    console.log('英超連結:', eplLink);
    if (eplLink) {
      const url = eplLink.h.startsWith('http') ? eplLink.h : 'https://vip.titan007.com' + eplLink.h;
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
      await new Promise(r => setTimeout(r, 5000));
      console.log('英超頁 title:', await page.title());
      // 搵已完成賽事連結
      const matchLinks = await page.evaluate(() => {
        const out = [];
        for (const a of document.querySelectorAll('a[href*="id="]')) {
          const h = a.getAttribute('href') || '';
          const m = h.match(/id=(\d+)/);
          if (m) out.push({ id: +m[1], h: h.slice(0, 80), t: (a.innerText || '').trim().slice(0, 40) });
        }
        return [...new Map(out.map(x => [x.id, x])).values()].slice(0, 15);
      });
      console.log('賽事連結:', matchLinks.length);
      matchLinks.forEach(l => console.log('  id=' + l.id, l.t, l.h));
    }
    // 也試下 live.titan007.com
    await page.goto('https://live.titan007.com/', { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 5000));
    console.log('\nlive 頁 title:', await page.title());
    const liveEpl = await page.evaluate(() => {
      for (const a of document.querySelectorAll('a')) {
        if (/英超/.test(a.innerText || '')) return { h: a.getAttribute('href'), t: a.innerText.trim() };
      }
      return null;
    });
    console.log('live 英超:', liveEpl);
  } catch (e) { console.error('FAIL:', e.message); }
  finally { await browser.close(); process.exit(0); }
})();
