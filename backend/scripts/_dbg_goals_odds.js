const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    await page.goto('https://vip.titan007.com/OverDown_n.aspx?id=3003890&l=0', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));
    console.log('title:', await page.title());
    // 搵香港馬會（香港马*）行
    const rows = await page.evaluate(() => {
      const out = [];
      for (const t of document.querySelectorAll('table')) {
        for (const row of t.querySelectorAll('tr')) {
          const cells = Array.from(row.querySelectorAll('td,th')).map(c => (c.innerText || '').trim());
          if (cells.length >= 3 && /香港马|HKJC|Hong Kong/i.test(cells[0])) {
            out.push({ name: cells[0], cells });
          }
        }
      }
      return out;
    });
    if (rows.length) {
      rows.forEach(r => {
        console.log('\n★ 找到:', r.name);
        console.log('  cells:', JSON.stringify(r.cells));
      });
    } else {
      console.log('冇搵到香港馬會 — 列出所有公司:');
      const all = await page.evaluate(() => {
        const s = new Set();
        for (const t of document.querySelectorAll('table')) {
          for (const row of t.querySelectorAll('tr')) {
            const c = row.querySelector('td');
            if (c && c.innerText.trim() && c.innerText.trim() !== '公司' && c.innerText.trim().length < 10) {
              s.add(c.innerText.trim());
            }
          }
        }
        return [...s];
      });
      console.log(all.join(', '));
      // 也 dump 前幾行完整 cells
      const dump = await page.evaluate(() => {
        const out = [];
        for (const t of document.querySelectorAll('table')) {
          for (const row of t.querySelectorAll('tr')) {
            const cells = Array.from(row.querySelectorAll('td,th')).map(c => (c.innerText || '').trim());
            if (cells.length >= 5) out.push(cells);
          }
        }
        return out.slice(0, 12);
      });
      dump.forEach((d, i) => console.log(`  [${i}]`, JSON.stringify(d)));
    }
  } catch (e) { console.error('FAIL:', e.message); }
  finally { await browser.close(); process.exit(0); }
})();
