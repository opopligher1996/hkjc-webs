// 直接抓 titan007 驗證兩場比賽嘅 Crown 數據
const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  for (const id of [3003889, 3003895]) {
    await page.goto(`https://vip.titan007.com/Corner.aspx?id=${id}&l=0`, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));
    const data = await page.evaluate(() => {
      const title = document.title || '';
      const tables = Array.from(document.querySelectorAll('table'));
      let crowRow = null;
      for (const t of tables) {
        for (const row of t.querySelectorAll('tr')) {
          const cells = Array.from(row.querySelectorAll('td,th')).map(c => (c.innerText || '').trim());
          if (cells[0] === 'Crow*') { crowRow = cells; break; }
        }
        if (crowRow) break;
      }
      return { title, crowRow };
    });
    console.log(`\nID ${id}: ${data.title.slice(0, 50)}`);
    if (data.crowRow) {
      console.log('  Crow* 原始 cells:', JSON.stringify(data.crowRow));
      console.log('  初盤: 大', data.crowRow[1], '線', data.crowRow[2], '細', data.crowRow[3]);
      console.log('  終盤: 大', data.crowRow[4], '線', data.crowRow[5], '細', data.crowRow[6]);
    } else {
      console.log('  搵唔到 Crow* 行');
    }
  }
  await browser.close(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
