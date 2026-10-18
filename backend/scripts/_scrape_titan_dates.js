// titan007 Crown 角球盤回補（日期法：DB 比賽日 → live.titan007.com 搵 ID → Corner.aspx 抓盤）
const puppeteer = require('puppeteer');
const pool = require('../src/db/pool');

const TEAM_MAP = { /* 同上 */ };
Object.assign(TEAM_MAP, {
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
});

const SEASON = process.argv[2] || '2025-2026';

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setDefaultNavigationTimeout(30000);

  // DB 已有嘅比賽日
  const dates = (await pool.query(`
    SELECT DISTINCT TO_CHAR(match_date,'YYYY-MM-DD') d
    FROM football_matches WHERE league='EPL' AND season=$1
    ORDER BY d`, [SEASON])).rows.map(r => r.d);
  console.log(`${SEASON} 比賽日: ${dates.length} 日`);
  if (!dates.length) { process.exit(0); }

  // 已有嘅盤口（跳過）
  const exist = new Set(
    (await pool.query(`SELECT DISTINCT match_date::text FROM corner_odds WHERE league='EPL'`))
      .rows.map(r => r.d));
  console.log(`已有盤口日期: ${exist.size} 日`);

  let totalSaved = 0, totalIds = 0;

  for (const date of dates) {
    if (exist.has(date)) continue;
    try {
      // live.titan007.com 搵當日英超賽事 ID
      const liveUrl = `https://live.titan007.com/football/${date.replace(/-/g, '-')}.htm`;
      await page.goto(liveUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      await new Promise(r => setTimeout(r, 3000));
      const matchInfo = await page.evaluate(() => {
        const out = [];
        for (const a of document.querySelectorAll('a[href*="Analysis.aspx?id="], a[href*="analysis.aspx?id="]')) {
          const m = (a.getAttribute('href') || '').match(/id=(\d+)/);
          if (m) {
            const row = a.closest('tr');
            const txt = row ? row.innerText.replace(/\s+/g, ' ').trim() : '';
            out.push({ id: +m[1], txt: txt.slice(0, 100) });
          }
        }
        return out;
      });
      // 過濾英超（文字入面有英超 or 我哋知嘅隊名）
      const eplMatches = matchInfo.filter(m => {
        const t = m.txt;
        return /英超|Arsenal|Liverpool|Chelsea|Manches|City|United|Tottenham|Newcastle|Aston|Brighton|Brentford|Crystal|Everton|Fulham|Nottingham|West Ham|Bournem|Wolves|Leeds|Burnley|Sunderland|Ipswich|Coventry|Hull|Leicester|Southampton/i.test(t);
      });
      if (!eplMatches.length) continue;
      console.log(`${date}: ${eplMatches.length} 場英超`);

      // 逐場抓 Corner 頁
      for (const match of eplMatches) {
        try {
          await page.goto(`https://vip.titan007.com/Corner.aspx?id=${match.id}&t=1&l=0`, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await new Promise(r => setTimeout(r, 2000));
          const data = await page.evaluate(() => {
            const title = document.title || '';
            const body = document.body.innerText || '';
            const dm = body.match(/(\d{4})-(\d{2})-(\d{2})/);
            for (const t of document.querySelectorAll('table')) {
              for (const row of t.querySelectorAll('tr')) {
                const cells = Array.from(row.querySelectorAll('td,th')).map(c => (c.innerText || '').trim());
                if (cells[0] === 'Crow*' && cells.length >= 7) {
                  return { title, dateStr: dm ? dm[0] : null, cells };
                }
              }
            }
            return null;
          });
          if (!data || !data.cells) continue;
          const tm = data.title.match(/(.+?)VS(.+?)\(/);
          if (!tm) continue;
          const home = TEAM_MAP[tm[1].trim()] || tm[1].trim();
          const away = TEAM_MAP[tm[2].trim()] || tm[2].trim();
          const toDec = (v) => { const f = parseFloat(v); return f > 0 && f < 1.5 ? +(f + 1).toFixed(2) : f || null; };
          const line = parseFloat(data.cells[5]) || parseFloat(data.cells[2]);
          if (!line) continue;
          const m = await pool.query(
            `SELECT id FROM football_matches WHERE league='EPL' AND match_date=$1 AND home_team=$2 LIMIT 1`,
            [date, home]);
          await pool.query(
            `INSERT INTO corner_odds (league, match_date, home_team, away_team, match_id, titan_id, line,
               over_open, under_open, over_close, under_close)
             VALUES ('EPL', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (league, match_date, home_team, away_team, line) DO UPDATE SET
               over_open=COALESCE($7, corner_odds.over_open), under_open=COALESCE($8, corner_odds.under_open),
               over_close=COALESCE($9, corner_odds.over_close), under_close=COALESCE($10, corner_odds.under_close)`,
            [date, home, away, m.rows[0]?.id || null, match.id, line,
             toDec(data.cells[1]), toDec(data.cells[3]), toDec(data.cells[4]), toDec(data.cells[6])]);
          totalSaved++;
        } catch (_) {}
        await new Promise(r => setTimeout(r, 1200));
      }
      console.log(`  累計: ${totalSaved} 場`);
    } catch (e) {
      console.log(`${date}: ${e.message.slice(0, 50)}`);
    }
  }
  console.log(`\n完成：${totalSaved} 場盤口儲存`);
  await browser.close();
  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
