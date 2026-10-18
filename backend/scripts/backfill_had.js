// ── HAD 歷史回填：掃 Over_ 頁完場賽事 → 抓百家初盤 + 賽果 ─────────────────
// 用法：docker compose run --rm backend node scripts/backfill_had.js [daysBack] [leagues]
//   daysBack 預設 30；leagues 預設 EPL,BUN,LAL,MLS
const puppeteer = require('puppeteer');
const pool = require('../src/db/pool');
const { scrapeOne } = require('../src/football/hdaService');

const LEAGUE_NAMES = { EPL: '英超', BUN: '德甲', LAL: '西甲', MLS: '美职业' };
const LEAGUE_CODE = { '英超': 'EPL', '德甲': 'BUN', '西甲': 'LAL', '美职业': 'MLS' };

// 掃一頁 Over_YYYYMMDD.htm → 完場賽事（titanId + 賽果）
async function scrapeOverPage(page, ymd, wantLeagues) {
  try {
    await page.goto(`https://bf.titan007.com/football/Over_${ymd}.htm`, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3500));
    return await page.evaluate((wl) => {
      const out = [];
      for (const tr of document.querySelectorAll('tr')) {
        const tds = Array.from(tr.querySelectorAll('td'));
        if (tds.length < 9) continue;
        const leagueName = (tds[0]?.innerText || '').trim();
        const timeStr = (tds[1]?.innerText || '').trim();
        const home = (tds[3]?.innerText || '').replace(/\[\d+\]/g, '').replace(/\*/g, '').trim();
        const score = (tds[4]?.innerText || '').trim();
        const away = (tds[5]?.innerText || '').replace(/\[\d+\]/g, '').replace(/\*/g, '').trim();
        const lastHtml = tds[tds.length - 1]?.innerHTML || '';
        const m = lastHtml.match(/(?:EuropeOdds|AsianOdds|analysis)\((\d+)\)/);
        if (!m) continue;
        const sm = score.match(/^(\d+)-(\d+)$/);
        if (!sm) continue; // 未完場/冇比分
        if (!wl.includes(leagueName)) continue;
        out.push({ titanId: +m[1], leagueName, home, away, hg: +sm[1], ag: +sm[2] });
      }
      return out;
    }, wantLeagues);
  } catch (_) { return []; }
}

(async () => {
  const daysBack = parseInt(process.argv[2]) || 30;
  const leagueKeys = (process.argv[3] || 'EPL,BUN,LAL,MLS').split(',');
  const wantLeagues = leagueKeys.map(k => LEAGUE_NAMES[k]).filter(Boolean);
  console.log(`回填 ${daysBack} 日・聯賽: ${wantLeagues.join('/')}`);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const listPage = await browser.newPage();
  await listPage.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // 收集晒所有目標場次
  const all = [];
  for (let d = 1; d <= daysBack; d++) {
    const dt = new Date(Date.now() - d * 86400000);
    const ymd = dt.toISOString().slice(0, 10).replace(/-/g, '');
    const ms = await scrapeOverPage(listPage, ymd, wantLeagues);
    for (const m of ms) all.push({ ...m, date: dt.toISOString().slice(0, 10) });
    process.stdout.write(`\r掃描 ${d}/${daysBack} 日・累積 ${all.length} 場`);
  }
  console.log('');

  // 剔除已有
  const { rows: existing } = await pool.query('SELECT titan_id FROM had_odds');
  const have = new Set(existing.map(r => String(r.titan_id)));
  const todo = all.filter(m => !have.has(String(m.titanId)));
  console.log(`目標 ${all.length} 場・已有所 ${have.size} 場・要抓 ${todo.length} 場`);

  // 3 並行抓 1x2
  let done = 0, fail = 0;
  const queue = [...todo];
  const oddsPages = [];
  for (let i = 0; i < 3; i++) {
    const p = await browser.newPage();
    await p.setUserAgent('Mozilla/5.0');
    oddsPages.push(p);
  }
  await Promise.all(oddsPages.map(async () => {
    while (queue.length) {
      const m = queue.shift();
      if (!m) break;
      try {
        await scrapeOne(m.titanId, { league: LEAGUE_CODE[m.leagueName], date: m.date, home: m.home, away: m.away, leagueCn: m.leagueName });
      } catch (_) { fail++; }
      done++;
      if (done % 10 === 0) console.log(`  進度 ${done}/${todo.length}（失敗 ${fail}）`);
    }
  }));
  console.log(`完成：${done} 場（失敗 ${fail}）`);
  const { rows: cnt } = await pool.query("SELECT COUNT(*) c, COUNT(result) r FROM had_odds");
  console.log(`had_odds 總數 ${cnt[0].c}・有賽果 ${cnt[0].r}`);
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
