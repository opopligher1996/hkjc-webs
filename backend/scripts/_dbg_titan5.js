const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    // 試比分頁（全部輪次）
    await page.goto('https://zq.titan007.com/cn/League/36.html', { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 5000));
    // 搵「赛程赛果」或者「轮次」導航
    const nav = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('a, select, button')) {
        const t = (el.innerText || el.value || '').trim();
        if (/轮|第\d+|全部|赛果|赛程|2026/i.test(t)) {
          out.push({ tag: el.tagName, t: t.slice(0, 20), h: (el.getAttribute('href') || '').slice(0, 60) });
        }
      }
      return out.slice(0, 15);
    });
    console.log('導航:', JSON.stringify(nav, null, 1).slice(0, 600));

    // 試直接入比分直播嘅英超
    await page.goto('https://live.titan007.com/football/fixture_36.htm', { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 5000));
    console.log('\nfixture title:', await page.title());
    const ids = await page.evaluate(() => {
      const s = new Set();
      for (const a of document.querySelectorAll('a')) {
        const m = (a.getAttribute('href') || '').match(/id=(\d+)/);
        if (m) s.add(+m[1]);
      }
      return [...s].sort((a, b) => a - b);
    });
    console.log('match IDs:', ids.length, '範圍:', ids[0], '-', ids[ids.length - 1]);
    // 分開睇每月
    console.log('頭 10:', ids.slice(0, 10).join(','));
    console.log('尾 10:', ids.slice(-10).join(','));
  } catch (e) { console.error('FAIL:', e.message); }
  finally { await browser.close(); process.exit(0); }
})();
