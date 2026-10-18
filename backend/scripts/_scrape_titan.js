// titan007 Crown 角球初終盤抓取器（英超 2026-27）
const puppeteer = require('puppeteer');
const pool = require('../src/db/pool');

// 中文名 → WhoScored 名 mapping
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

  // 已有嘅 corner_odds（跳過）
  const exist = new Set(
    (await pool.query(`SELECT DISTINCT match_id FROM corner_odds WHERE match_id IS NOT NULL`))
      .rows.map(r => String(r.match_id))
  );
  console.log('已有盤口:', exist.size);

  // 由最新 ID 倒掃（英超 2026-27 到目前約 7 輪 ≈ 70 場 → 掃 3003910 往下 120 個）
  const START = 3003910, END = 3003790;
  let saved = 0, checked = 0, nonEPL = 0;

  for (let id = START; id >= END; id--) {
    if (exist.has(String(id))) continue;
    checked++;
    try {
      await page.goto(`https://vip.titan007.com/Corner.aspx?id=${id}&t=1&l=0`, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 4000));
      const data = await page.evaluate(() => {
        const title = document.title || '';
        const body = document.body.innerText || '';
        // 日期喺 body：布伦特福德(主) 英超 2026-09-19 03:00
        const dm = body.match(/(\d{4})-(\d{2})-(\d{2})\s+\d{2}:\d{2}/);
        const dateStr = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null;
        // 搵 Crow* 行
        const tables = Array.from(document.querySelectorAll('table'));
        for (const t of tables) {
          const rows = Array.from(t.querySelectorAll('tr'));
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td,th')).map(c => (c.innerText || '').trim());
            if (cells[0] === 'Crow*' && cells.length >= 7) {
              return { title, dateStr, cells, body: body.slice(0, 200) };
            }
          }
        }
        return { title, dateStr: dateStr || (body.match(/\d{4}-\d{2}-\d{2}/) || [null])[0], cells: null, body: body.slice(0, 200) };
      });
      // 只抓英超
      if (!data.title.includes('英超') && !data.title.includes('Premier League')) {
        nonEPL++; continue;
      }
      if (!data.cells || data.cells.length < 7) {
        console.log(`  id=${id} 冇 Crow* 數據`);
        continue;
      }
      // 解析：初盤 [1]=大賠率 [2]=線 [3]=細賠率 | 終盤 [4]=大賠率 [5]=線 [6]=細賠率
      const overOpen = parseFloat(data.cells[1]) || null;
      const lineOpen = parseFloat(data.cells[2]) || null;
      const underOpen = parseFloat(data.cells[3]) || null;
      const overClose = parseFloat(data.cells[4]) || null;
      const lineClose = parseFloat(data.cells[5]) || null;
      const underClose = parseFloat(data.cells[6]) || null;
      // 由 title 拆隊名+日期
      const tm = data.title.match(/(.+?)VS(.+?)\(/);
      if (!tm) { console.log(`  id=${id} 拆唔到隊名:`, data.title.slice(0, 60)); continue; }
      const homeCN = tm[1].trim(), awayCN = tm[2].trim();
      const home = TEAM_MAP[homeCN] || homeCN;
      const away = TEAM_MAP[awayCN] || awayCN;
      const date = data.dateStr;
      if (!date) { console.log(`  id=${id} 拆唔到日期`); continue; }
      // 對返我哋 DB
      const m = await pool.query(
        `SELECT id FROM football_matches WHERE league='EPL' AND match_date=$1 AND home_team=$2 LIMIT 1`,
        [date, home]);
      const matchId = m.rows[0]?.id || null;
      // 儲（用終盤線；初盤線另存）
      const line = lineClose || lineOpen;
      if (!line) continue;
      await pool.query(
        `INSERT INTO corner_odds (league, match_date, home_team, away_team, match_id, titan_id, line,
           over_open, under_open, over_close, under_close)
         VALUES ('EPL', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (league, match_date, home_team, away_team, line) DO UPDATE SET
           over_open=COALESCE($7, corner_odds.over_open), under_open=COALESCE($8, corner_odds.under_open),
           over_close=COALESCE($9, corner_odds.over_close), under_close=COALESCE($10, corner_odds.under_close)`,
        [date, home, away, matchId, id, line, overOpen, underOpen, overClose, underClose]);
      saved++;
      console.log(`✓ id=${id} ${home} vs ${away} ${date} 線=${line} 初:${overOpen}/${underOpen} 終:${overClose}/${underClose}${matchId ? ' [DB]' : ' [未對上]'}`);
    } catch (e) {
      console.log(`✗ id=${id}: ${e.message.slice(0, 50)}`);
    }
    await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
  }
  console.log(`\n掃完：${checked} 個 ID（${nonEPL} 個非英超）→ 儲存 ${saved} 場盤口`);
  await browser.close();
  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
