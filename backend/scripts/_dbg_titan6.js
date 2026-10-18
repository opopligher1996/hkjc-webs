const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    // 賽季頁
    await page.goto('https://zq.titan007.com/cn/League/2026-2027/36.html', { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 6000));
    console.log('title:', await page.title());
    // 搵所有輪次嘅賽事連結
    const ids = await page.evaluate(() => {
      const s = new Map();
      for (const a of document.querySelectorAll('a')) {
        const h = a.getAttribute('href') || '';
        const m = h.match(/(?:Analysis|AsianOdds|OverDown|Corner|handicap)\.aspx\?id=(\d+)/i);
        if (m) {
          const id = +m[1];
          if (!s.has(id)) {
            // 搵埋 row 嘅文字（隊名+日期）
            const row = a.closest('tr') || a.closest('div');
            const txt = row ? row.innerText.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
            s.set(id, { id, txt, h: h.slice(0, 60) });
          }
        }
      }
      return [...s.values()].sort((a, b) => a.id - b.id);
    });
    console.log('賽事 ID 總數:', ids.length);
    if (ids.length) {
      console.log('ID 範圍:', ids[0].id, '-', ids[ids.length - 1].id);
      console.log('\n頭 6 場:');
      ids.slice(0, 6).forEach(m => console.log('  id=' + m.id, m.txt));
      console.log('尾 6 場:');
      ids.slice(-6).forEach(m => console.log('  id=' + m.id, m.txt));
    }
  } catch (e) { console.error('FAIL:', e.message); }
  finally { await browser.close(); process.exit(0); }
})();
