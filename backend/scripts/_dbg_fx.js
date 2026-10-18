const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.goto('https://www.whoscored.com/Regions/252/Tournaments/2/Seasons/10743/england-premier-league', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 5000));
  const fx = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a')).find(x => (x.innerText || '').trim() === 'Fixtures');
    return a ? a.getAttribute('href') : null;
  });
  console.log('Fixtures tab:', fx);
  await page.goto('https://www.whoscored.com' + fx, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 8000));
  // select 清單（搵月份 dropdown）
  const sels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('select')).map(s => ({
      id: s.id, n: s.options.length,
      opts: Array.from(s.options).slice(0, 4).map(o => ({ v: (o.value||'').slice(0,50), t: (o.innerText||'').trim().slice(0,20) })),
    })));
  console.log('\nselects:', JSON.stringify(sels, null, 1).slice(0, 900));
  // match 連結 row 原文
  const rows = await page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/matches/"]')) {
      const row = a.closest('tr') || a.closest('div');
      if (row && out.length < 5) out.push(row.innerText.replace(/\s+/g, ' | ').slice(0, 150));
    }
    return out;
  });
  console.log('\nmatch rows 原文:');
  rows.forEach(r => console.log(' ', r));
  await browser.close(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
