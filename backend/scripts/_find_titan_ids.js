// 找西甲/德甲各賽季嘅 titan007 match ID 範圍
const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  const urls = [
    { name: 'LAL 26/27', url: 'https://zq.titan007.com/cn/League/2026-2027/31.html' },
    { name: 'LAL 25/26', url: 'https://zq.titan007.com/cn/League/2025-2026/31.html' },
    { name: 'LAL 24/25', url: 'https://zq.titan007.com/cn/League/2024-2025/31.html' },
    { name: 'BUN 26/27', url: 'https://zq.titan007.com/cn/League/2026-2027/8.html' },
    { name: 'BUN 25/26', url: 'https://zq.titan007.com/cn/League/2025-2026/8.html' },
    { name: 'BUN 24/25', url: 'https://zq.titan007.com/cn/League/2024-2025/8.html' },
  ];
  for (const u of urls) {
    try {
      await page.goto(u.url, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 5000));
      const ids = await page.evaluate(() => {
        const s = new Set();
        for (const a of document.querySelectorAll('a')) {
          const h = a.getAttribute('href') || '';
          const m = h.match(/id=(\d+)/);
          if (m) s.add(+m[1]);
        }
        return [...s].sort((a, b) => b - a);
      });
      console.log(`${u.name}: ${ids.length} 個 ID，最新=${ids[0] ?? '-'}，最舊=${ids[ids.length-1] ?? '-'}`);
    } catch (e) { console.log(`${u.name}: FAIL ${e.message.slice(0, 50)}`); }
  }
  await browser.close(); process.exit(0);
})();
