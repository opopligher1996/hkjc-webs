const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    // 2025/26 賽季頁
    await page.goto('https://zq.titan007.com/cn/League/2025-2026/36.html', { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 6000));
    console.log('title:', await page.title());
    // 賽事連結
    const ids = await page.evaluate(() => {
      const s = new Map();
      for (const a of document.querySelectorAll('a')) {
        const h = a.getAttribute('href') || '';
        const m = h.match(/(?:Analysis|AsianOdds|OverDown|Corner|handicap)\.aspx\?id=(\d+)/i);
        if (m) {
          const id = +m[1];
          const row = a.closest('tr') || a.closest('div');
          const txt = row ? row.innerText.replace(/\s+/g, ' ').trim().slice(0, 70) : '';
          if (!s.has(id)) s.set(id, { id, txt });
        }
      }
      return [...s.values()].sort((a, b) => a.id - b.id);
    });
    console.log('2025/26 賽事 ID:', ids.length);
    if (ids.length) {
      console.log('範圍:', ids[0].id, '-', ids[ids.length - 1].id);
      ids.slice(0, 5).forEach(m => console.log(' ', m.id, m.txt));
    }
    // 搵輪次導航（塞上一輪）
    const roundNav = await page.evaluate(() => {
      const sel = document.querySelector('select');
      if (sel) return { nOpts: sel.options.length, vals: Array.from(sel.options).map(o => o.value || o.innerText.trim()).slice(0, 5) };
      return null;
    });
    console.log('輪次導航:', JSON.stringify(roundNav));
  } catch (e) { console.error('FAIL:', e.message); }
  finally { await browser.close(); process.exit(0); }
})();
