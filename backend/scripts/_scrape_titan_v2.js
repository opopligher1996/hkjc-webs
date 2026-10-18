// titan007 Crown 角球回補 — 已知最後一輪 ID 向下掃
// 用法：docker compose run --rm backend node scripts/_scrape_titan_v2.js <startId> <endId> <seasonLabel>
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

(async () => {
  const START = parseInt(process.argv[2]);
  const END = parseInt(process.argv[3]);
  if (!START || !END) { console.log('用法: node _scrape_titan_v2.js <startId> <endId>'); process.exit(1); }
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setDefaultNavigationTimeout(25000);

  let saved = 0, nonEPL = 0, noData = 0;
  console.log(`掃描: ${START} → ${END}（${START - END} 個 ID）`);

  for (let id = START; id >= END; id--) {
    try {
      await page.goto(`https://vip.titan007.com/Corner.aspx?id=${id}&l=0`, { waitUntil: 'domcontentloaded', timeout: 18000 });
      await new Promise(r => setTimeout(r, 1800));
      const data = await page.evaluate(() => {
        const title = document.title || '';
        const body = document.body.innerText || '';
        const dm = body.match(/(\d{4})-(\d{2})-(\d{2})\s+\d{2}:\d{2}/);
        for (const t of document.querySelectorAll('table')) {
          for (const row of t.querySelectorAll('tr')) {
            const cells = Array.from(row.querySelectorAll('td,th')).map(c => (c.innerText || '').trim());
            if (cells[0] === 'Crow*' && cells.length >= 7) return { title, dateStr: dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null, cells };
          }
        }
        return null;
      });
      if (!data || !data.title.includes('英超')) { nonEPL++; continue; }
      if (!data.cells || !data.dateStr) { noData++; continue; }
      const tm = data.title.match(/(.+?)VS(.+?)\(/);
      if (!tm) { noData++; continue; }
      const home = TEAM_MAP[tm[1].trim()] || tm[1].trim();
      const away = TEAM_MAP[tm[2].trim()] || tm[2].trim();
      const toDec = (v) => { const f = parseFloat(v); return f > 0 && f < 1.5 ? +(f + 1).toFixed(2) : f || null; };
      const line = parseFloat(data.cells[5]) || parseFloat(data.cells[2]);
      if (!line) { noData++; continue; }
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
    } catch (e) { noData++; }
    if ((saved + nonEPL + noData) % 100 === 0) console.log(`  [${saved + nonEPL + noData}] 存=${saved} 非英超=${nonEPL}`);
  }
  console.log(`完成：存 ${saved}・非英超 ${nonEPL}・冇數據 ${noData}`);
  await browser.close();
  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
