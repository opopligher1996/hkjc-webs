const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.goto('https://www.whoscored.com/regions/252/tournaments/2/seasons/10743/stages/24533/fixtures/england-premier-league-2025-2026', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 8000));
  const info = await page.evaluate(() => {
    const out = {};
    // 所有 button/a 有 previous/next/date 樣
    out.navs = Array.from(document.querySelectorAll('a, button, span, div'))
      .filter(el => /previous|next|date-config|icon-arrow/i.test((el.className || '') + ' ' + (el.id || '')))
      .slice(0, 10)
      .map(el => ({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 50), txt: (el.innerText || '').trim().slice(0, 20) }));
    // 第一個 match link 嘅祖先鏈
    const a = document.querySelector('a[href*="/matches/"]');
    if (a) {
      const chain = [];
      let el = a;
      for (let i = 0; i < 6 && el; i++) {
        chain.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 40), txt: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 60) });
        el = el.parentElement;
      }
      out.chain = chain;
    }
    // 日期 header（表內）
    out.dateHeaders = Array.from(document.querySelectorAll('th, td, div, span'))
      .filter(el => /^\d{2}[./]\d{2}[./]\d{4}$|^\d{1,2} (Jan|Feb|Aug|Sep|Oct|Nov|Dec)/.test((el.innerText || '').trim()))
      .slice(0, 5).map(el => (el.innerText || '').trim());
    return out;
  });
  console.log(JSON.stringify(info, null, 1).slice(0, 1600));
  await browser.close(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
