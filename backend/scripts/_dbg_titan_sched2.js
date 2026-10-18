const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    // 10月10日（週六）應有英超
    await page.goto('https://bf.titan007.com/football/Next_20261010.htm', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 6000));
    console.log('title:', await page.title());
    // 搵英超/德甲/西甲/美職賽事
    const eplMatches = await page.evaluate(() => {
      const out = [];
      for (const tr of document.querySelectorAll('tr')) {
        const txt = tr.innerText.replace(/\s+/g, ' ').trim();
        if (/英超|英格蘭超級|德甲|德國甲|西甲|西班牙甲|美職|MLS|Major League/i.test(txt) && txt.includes('10-')) {
          // 搵 ID
          const as = tr.querySelectorAll('a');
          let id = null;
          for (const a of as) {
            const m = (a.getAttribute('href') || '').match(/id=(\d+)/);
            if (m) { id = m[1]; break; }
          }
          out.push({ text: txt.slice(0, 100), id });
        }
      }
      return out;
    });
    console.log('\n四大聯賽賽事:', eplMatches.length);
    eplMatches.forEach((m, i) => console.log(`  [${i}]`, m.id ? `id=${m.id}` : 'no-id', '|', m.text));
  } catch (e) { console.error('FAIL:', e.message); }
  finally { await browser.close(); process.exit(0); }
})();
