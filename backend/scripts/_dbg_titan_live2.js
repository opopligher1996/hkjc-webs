const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    await page.goto('https://live.titan007.com/detail/3092299sb.htm', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));
    const data = await page.evaluate(() => {
      const body = document.body.innerText;
      // 搵所有統計欄
      const stats = {};
      const patterns = {
        corners: /(\d+)角球(\d+)/,
        possession: /(\d+)%控球率(\d+)%/,
        htCorners: /(\d+)半场角球(\d+)/,
        htPossession: /(\d+)%半场控球率(\d+)%/,
        shots: /(\d+)射门(\d+)/,
        shotsOnTarget: /(\d+)射正(\d+)/,
        dangerousAttacks: /(\d+)危险进攻(\d+)/,
        attacks: /(\d+)进攻(\d+)/,
        yellowCards: /(\d+)黄牌(\d+)/,
        redCards: /(\d+)红牌(\d+)/,
        fouls: /(\d+)犯规(\d+)/,
        offsides: /(\d+)越位(\d+)/,
        cornersTimeline: /第(\d+)个角球\s*(\d+)'/g,
      };
      for (const [key, re] of Object.entries(patterns)) {
        if (key === 'cornersTimeline') {
          const times = [];
          let m;
          while ((m = re.exec(body)) !== null) times.push({ nth: +m[1], minute: +m[2] });
          stats[key] = times;
        } else {
          const m = body.match(re);
          if (m) stats[key] = { home: +m[1], away: +m[2] };
        }
      }
      // 分鐘
      const timeMatch = body.match(/(\d+)'|\((\d+)-(\d+)\)/);
      const minMatch = body.match(/(\d+)'/);
      stats.minute = minMatch ? +minMatch[1] : null;
      // 比分
      const scoreMatch = body.match(/\((\d+)-(\d+)\)/);
      stats.score = scoreMatch ? { hg: +scoreMatch[1], ag: +scoreMatch[2] } : null;
      return stats;
    });
    console.log('★ 即場數據提取:', JSON.stringify(data, null, 2));
  } catch (e) { console.error('FAIL:', e.message); }
  finally { await browser.close(); process.exit(0); }
})();
