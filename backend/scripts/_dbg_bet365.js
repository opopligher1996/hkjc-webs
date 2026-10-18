const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  const xhrs = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (res.status === 200 && !/\.(css|js|png|gif|woff|svg|jpg|ico)/.test(url) && !url.includes('google')) {
      try {
        const body = await res.text();
        if (body && body.length > 100) {
          xhrs.push({ url: url.slice(0, 140), len: body.length, sample: body.slice(0, 200) });
        }
      } catch (_) {}
    }
  });
  try {
    await page.goto('https://www.bet365.com/#/IP/EV151394071212C1', { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 10000));
    console.log('title:', await page.title());
    console.log('url:', page.url().slice(0, 100));
    // 體育數據
    const stats = await page.evaluate(() => {
      const body = document.body.innerText;
      return body.replace(/\s+/g, ' ').slice(0, 600);
    });
    console.log('body 頭 600 字:', stats);
    console.log('\nXHR:', xhrs.length);
    xhrs.slice(0, 8).forEach(x => console.log(` [${x.len}]`, x.url, '\n  ', x.sample.slice(0, 120)));
  } catch (e) { console.error('FAIL:', e.message); }
  finally { await browser.close(); process.exit(0); }
})();
