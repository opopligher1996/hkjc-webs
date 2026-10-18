// titan007 逐輪收集英超賽事 ID → 抓 Crown 角球初終盤
// 用法：docker compose run --rm backend node scripts/_scrape_titan_rounds.js [season] [rounds]
const puppeteer = require('puppeteer');
const pool = require('../src/db/pool');

const TEAM_MAP = {
  '阿森纳': 'Arsenal', '利物浦': 'Liverpool', '切尔西': 'Chelsea', '曼城': 'Manchester City',
  '曼彻斯特城': 'Manchester City', '曼联': 'Manchester United', '曼彻斯特联': 'Manchester United',
  '热刺': 'Tottenham', '托特纳姆热刺': 'Tottenham', '纽卡斯尔': 'Newcastle', '纽卡斯尔联': 'Newcastle',
  '阿斯顿维拉': 'Aston Villa', '布莱顿': 'Brighton', '布伦特福德': 'Brentford',
  '水晶宫': 'Crystal Palace', '埃弗顿': 'Everton', '富勒姆': 'Fulham',
  '诺丁汉森林': 'Nottingham Forest', '西汉姆': 'West Ham', '西汉姆联': 'West Ham',
  '伯恩茅斯': 'Bournemouth', '狼队': 'Wolves', '伍尔弗汉普顿': 'Wolves',
  '利兹联': 'Leeds', '利兹': 'Leeds', '伯恩利': 'Burnley', '桑德兰': 'Sunderland',
  '伊普斯维奇': 'Ipswich', '考文垂': 'Coventry', '赫尔城': 'Hull', '莱斯特城': 'Leicester',
  '南安普顿': 'Southampton',
};

const SEASON = process.argv[2] || '2025-2026';
const MAX_ROUNDS = parseInt(process.argv[3]) || 38;

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setDefaultNavigationTimeout(30000);

  // ── Phase 1：逐輪收集 match ID ──
  console.log(`\n═══ Phase 1：收集 ${SEASON} 賽事 ID ═══`);
  const url = `https://zq.titan007.com/cn/League/${SEASON}/36.html`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 5000));

  // 搵輪次 select
  const roundSelInfo = await page.evaluate(() => {
    for (const sel of document.querySelectorAll('select')) {
      const opts = Array.from(sel.options).map(o => o.innerText.trim());
      if (opts.some(o => /第\d+轮/.test(o))) return { idx: [...document.querySelectorAll('select')].indexOf(sel), nOpts: sel.options.length };
    }
    return null;
  });
  console.log('輪次 select:', roundSelInfo);

  const allIds = new Map();
  const harvest = async () => {
    const ids = await page.evaluate(() => {
      const s = new Map();
      for (const a of document.querySelectorAll('a')) {
        const h = a.getAttribute('href') || '';
        const m = h.match(/id=(\d+)/);
        if (m) {
          const row = a.closest('tr') || a.closest('div');
          const txt = row ? row.innerText.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
          if (!s.has(+m[1])) s.set(+m[1], txt);
        }
      }
      return s;
    });
    ids.forEach((v, k) => { if (!allIds.has(k)) allIds.set(k, v); });
  };

  if (roundSelInfo) {
    const selects = await page.$$('select');
    const sel = selects[roundSelInfo.idx];
    const nRounds = Math.min(roundSelInfo.nOpts, MAX_ROUNDS);
    for (let ri = 0; ri < nRounds; ri++) {
      try {
        await page.select(sel, sel.options[ri].value);
        await new Promise(r => setTimeout(r, 4000));
        await harvest();
        if ((ri + 1) % 5 === 0) console.log(`  輪 ${ri + 1}/${nRounds}：累計 ${allIds.size} 個 ID`);
      } catch (_) {}
    }
  } else {
    await harvest();
  }
  console.log(`收集到 ${allIds.size} 個賽事 ID`);

  // ── Phase 2：逐場抓 Crown 角球盤 ──
  console.log(`\n═══ Phase 2：抓 Crown 角球盤（${allIds.size} 場）═══`);
  let saved = 0, failed = 0;
  const sortedIds = [...allIds.keys()].sort((a, b) => b - a);
  for (const id of sortedIds) {
    try {
      await page.goto(`https://vip.titan007.com/Corner.aspx?id=${id}&t=1&l=0`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await new Promise(r => setTimeout(r, 2500));
      const data = await page.evaluate(() => {
        const body = document.body.innerText || '';
        const dm = body.match(/(\d{4})-(\d{2})-(\d{2})\s+\d{2}:\d{2}/);
        for (const t of document.querySelectorAll('table')) {
          for (const row of t.querySelectorAll('tr')) {
            const cells = Array.from(row.querySelectorAll('td,th')).map(c => (c.innerText || '').trim());
            if (cells[0] === 'Crow*' && cells.length >= 7) {
              const title = document.title || '';
              return { title, dateStr: dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null, cells };
            }
          }
        }
        return null;
      });
      if (!data || !data.cells || !data.dateStr) { failed++; continue; }
      const tm = data.title.match(/(.+?)VS(.+?)\(/);
      if (!tm) { failed++; continue; }
      const home = TEAM_MAP[tm[1].trim()] || tm[1].trim();
      const away = TEAM_MAP[tm[2].trim()] || tm[2].trim();
      const toDec = (v) => { const f = parseFloat(v); return f > 0 && f < 1.5 ? +(f + 1).toFixed(2) : f || null; };
      const line = parseFloat(data.cells[5]) || parseFloat(data.cells[2]);
      if (!line) { failed++; continue; }
      const m = await pool.query(
        `SELECT id FROM football_matches WHERE league='EPL' AND match_date=$1 AND home_team=$2 LIMIT 1`,
        [data.dateStr, home]);
      await pool.query(
        `INSERT INTO corner_odds (league, match_date, home_team, away_team, match_id, titan_id, line,
           over_open, under_open, over_close, under_close)
         VALUES ('EPL', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (league, match_date, home_team, away_team, line) DO UPDATE SET
           over_open=COALESCE($7, corner_odds.over_open), under_open=COALESCE($8, corner_odds.under_open),
           over_close=COALESCE($9, corner_odds.over_close), under_close=COALESCE($10, corner_odds.under_close)`,
        [data.dateStr, home, away, m.rows[0]?.id || null, id, line,
         toDec(data.cells[1]), toDec(data.cells[3]), toDec(data.cells[4]), toDec(data.cells[6])]);
      saved++;
    } catch (e) { failed++; }
    if ((saved + failed) % 50 === 0) console.log(`  進度: ${saved + failed}/${allIds.size}（存 ${saved}）`);
  }
  console.log(`\n完成：${saved} 場儲存，${failed} 失敗`);
  await browser.close();
  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
