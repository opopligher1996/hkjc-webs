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
        if (body && body.length > 50) xhrs.push({ url: url.slice(0, 150), len: body.length, body: body.slice(0, 300) });
      } catch (_) {}
    }
  });
  try {
    await page.goto('https://live.titan007.com/detail/3092299sb.htm', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 8000));
    console.log('title:', await page.title());
    console.log('url:', page.url());
    const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 800));
    console.log('\nbody:', body);
    // 搵統計數據（射門、控球、角球）
    const stats = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('div, span, td')) {
        const t = (el.innerText || '').trim();
        if (/控球|射門|角球| possession|shots|corner/i.test(t) && t.length < 50) {
          out.push(t.replace(/\n/g, ' | '));
        }
      }
      return [...new Set(out)].slice(0, 15);
    });
    console.log('\n統計相關元素:', JSON.stringify(stats, null, 1));
    console.log('\nXHR:', xhrs.length);
    xhrs.slice(0, 6).forEach(x => console.log(` [${x.len}]`, x.url, '\n  ', x.body.slice(0, 150)));
  } catch (e) { console.error('FAIL:', e.message); }
  finally { await browser.close(); process.exit(0); }
})();
