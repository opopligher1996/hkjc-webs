const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    await page.goto('https://www.whoscored.com/Regions/206/Tournaments/4/Spain-LaLiga', { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 6000));
    console.log('title:', await page.title());
    // 搵 Fixtures tab
    const fx = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('a')).find(x => (x.innerText || '').trim() === 'Fixtures');
      return a ? a.getAttribute('href') : null;
    });
    console.log('Fixtures tab:', fx);
    if (fx) {
      await page.goto('https://www.whoscored.com' + fx, { waitUntil: 'networkidle2', timeout: 45000 });
      await new Promise(r => setTimeout(r, 8000));
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href*="/matches/"]'))
          .map(a => a.getAttribute('href'))
          .filter(Boolean).slice(0, 5));
      console.log('match 連結:', links.length, links.slice(0, 3));
      // 檢查 dayChangeBtn
      const btns = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button[class*="dayChangeBtn"]')).length);
      console.log('dayChangeBtn 數量:', btns);
      // 檢查 select#seasons 值
      const sel = await page.evaluate(() => {
        const s = document.querySelector('select#seasons');
        return s ? { val: s.value.slice(0, 80) } : null;
      });
      console.log('當前賽季:', JSON.stringify(sel));
    }
  } catch (e) { console.error('FAIL:', e.message); }
  finally { await browser.close(); process.exit(0); }
})();
