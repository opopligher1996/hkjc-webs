const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.goto('https://www.whoscored.com/regions/252/tournaments/2/seasons/11141/stages/25544/fixtures/england-premier-league-2026-2027', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 7000));
  await page.evaluate(() => { document.querySelectorAll('button[class*="dayChangeBtn"]')[0].click(); });
  await new Promise(r => setTimeout(r, 6000));
  const info = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/matches/"]'));
    let withRow = 0, withFT = 0, samples = [];
    for (const a of anchors) {
      const row = a.closest('[class*="Match-module_row"]');
      if (row) {
        withRow++;
        const txt = row.innerText.replace(/\s+/g, ' ').trim();
        if (/FT/.test(txt)) { withFT++; if (samples.length < 3) samples.push({ href: (a.getAttribute('href')||'').slice(0, 60), txt: txt.slice(0, 70) }); }
      }
    }
    return { nAnchors: anchors.length, withRow, withFT, samples };
  });
  console.log(JSON.stringify(info, null, 1));
  await browser.close(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
