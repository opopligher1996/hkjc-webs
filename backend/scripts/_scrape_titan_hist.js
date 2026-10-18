// titan007 Crown 角球初終盤 — 回補 2024/25 + 2025/26 英超
// 用法：docker compose run --rm backend node scripts/_scrape_titan_hist.js [startId] [endId]
// 2025/26 賽季 ID 範圍要探索（2026/27 由 3003849 起，2025/26 應該喺更早嘅區間）
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
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setDefaultNavigationTimeout(30000);

  // 探索 ID 範圍：由 3003849（2026/27 最早）向下掃
  // 2025/26 有 380 場 + 2024/25 有 380 場 = 760 場 → 每場 ID 唔一定連續（有其他聯賽穿插）
  // 策略：batch 掃，batch 內用 binary 搵英超，batch 之間跳
  const START = parseInt(process.argv[2]) || 3003800;
  const END = parseInt(process.argv[3]) || (START - 3000);   // 預設向下掃 3000 個 ID
  let saved = 0, checked = 0, nonEPL = 0, noData = 0;

  console.log(`掃描範圍: ${START} → ${END}（${START - END} 個 ID）\n`);

  for (let id = START; id >= END; id--) {
    checked++;
    try {
      await page.goto(`https://vip.titan007.com/Corner.aspx?id=${id}&t=1&l=0`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await new Promise(r => setTimeout(r, 2500));
      const data = await page.evaluate(() => {
        const title = document.title || '';
        const body = document.body.innerText || '';
        const dm = body.match(/(\d{4})-(\d{2})-(\d{2})\s+\d{2}:\d{2}/);
        const dateStr = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null;
        for (const t of document.querySelectorAll('table')) {
          for (const row of t.querySelectorAll('tr')) {
            const cells = Array.from(row.querySelectorAll('td,th')).map(c => (c.innerText || '').trim());
            if (cells[0] === 'Crow*' && cells.length >= 7) {
              return { title, dateStr, cells };
            }
          }
        }
        return { title, dateStr, cells: null };
      });

      if (!data.title.includes('英超')) { nonEPL++; continue; }
      if (!data.cells || !data.dateStr) { noData++; continue; }

      const overOpen = parseFloat(data.cells[1]) || null;
      const lineOpen = parseFloat(data.cells[2]) || null;
      const underOpen = parseFloat(data.cells[3]) || null;
      const overClose = parseFloat(data.cells[4]) || null;
      const lineClose = parseFloat(data.cells[5]) || null;
      const underClose = parseFloat(data.cells[6]) || null;

      const tm = data.title.match(/(.+?)VS(.+?)\(/);
      if (!tm) continue;
      const home = TEAM_MAP[tm[1].trim()] || tm[1].trim();
      const away = TEAM_MAP[tm[2].trim()] || tm[2].trim();

      // 馬來盤 → decimal（+1）
      const toDec = (v) => v != null && v > 0 && v < 1.5 ? +(v + 1).toFixed(2) : v;

      const line = lineClose || lineOpen;
      if (!line) continue;

      // 對返 DB
      const m = await pool.query(
        `SELECT id FROM football_matches WHERE league='EPL' AND match_date=$1 AND home_team=$2 LIMIT 1`,
        [data.dateStr, home]);
      const matchId = m.rows[0]?.id || null;

      await pool.query(
        `INSERT INTO corner_odds (league, match_date, home_team, away_team, match_id, titan_id, line,
           over_open, under_open, over_close, under_close)
         VALUES ('EPL', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (league, match_date, home_team, away_team, line) DO UPDATE SET
           over_open=COALESCE($7, corner_odds.over_open), under_open=COALESCE($8, corner_odds.under_open),
           over_close=COALESCE($9, corner_odds.over_close), under_close=COALESCE($10, corner_odds.under_close),
           match_id=COALESCE($4, corner_odds.match_id)`,
        [data.dateStr, home, away, matchId, id, line,
         toDec(overOpen), toDec(underOpen), toDec(overClose), toDec(underClose)]);
      saved++;
      if (saved % 20 === 0) console.log(`  進度: ${saved} 場儲存（${checked} 個 ID 掃過）`);
    } catch (e) {
      // timeout / 導航錯誤 — 唔阻斷
    }
    if (checked % 100 === 0) console.log(`  [${checked}] saved=${saved} nonEPL=${nonEPL} noData=${noData}`);
  }

  console.log(`\n完成：${checked} 個 ID（${nonEPL} 非英超，${noData} 冇數據）→ 儲存 ${saved} 場盤口`);
  await browser.close();
  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
