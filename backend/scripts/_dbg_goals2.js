const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    await page.goto('https://vip.titan007.com/OverDown_n.aspx?id=3003890&l=0', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));
    // 搵所有公司名 + 香港马
    const info = await page.evaluate(() => {
      const companies = [];
      for (const t of document.querySelectorAll('table')) {
        for (const row of t.querySelectorAll('tr')) {
          const first = row.querySelector('td');
          if (!first) continue;
          const txt = first.innerText.trim();
          if (txt && txt.length < 15 && /封|平| Crow|36|香港|HK|澳门|澳|bet|易胜|Inter|William|伟德|明陽|Pinnacle/i.test(txt)) {
            const all = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
            companies.push({ name: txt, cells: all });
          }
        }
      }
      // 也搵有冇「香港」嘅文字
      const bodyHas = document.body.innerText.includes('香港');
      return { companies, bodyHas, bodySearch: document.body.innerText.match(/香港[^\n]{0,30}/g) };
    });
    console.log('body 有「香港」:', info.bodyHas);
    if (info.bodySearch) info.bodySearch.slice(0, 3).forEach(x => console.log('  found:', x));
    console.log('\n公司:', info.companies.length);
    info.companies.forEach(c => console.log(' ', c.name, '→', JSON.stringify(c.cells).slice(0, 200)));
  } catch (e) { console.error('FAIL:', e.message); }
  finally { await browser.close(); process.exit(0); }
})();
