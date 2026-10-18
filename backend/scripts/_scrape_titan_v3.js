// titan007 Crown 角球盤 — 正確解析（cells[7-9] = 終盤）
// 用法：docker compose run --rm backend node scripts/_scrape_titan_v3.js <startId> <endId>
const puppeteer = require('puppeteer');
const pool = require('../src/db/pool');

const TEAM_MAP = {
  // 英超
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
  // 美職
  '亚特兰大联': 'Atlanta United', '夏洛特FC': 'Charlotte', '芝加哥火焰': 'Chicago Fire',
  '辛辛那提FC': 'Cincinnati', '科罗拉多急流': 'Colorado Rapids', '哥伦布机员': 'Columbus Crew',
  '达拉斯FC': 'Dallas', '华盛顿联': 'DC United', '休斯敦迪纳摩': 'Houston Dynamo',
  '堪萨斯城竞技': 'Kansas City', '洛杉矶银河': 'LA Galaxy', '洛杉矶FC': 'Los Angeles',
  '迈阿密国际': 'Inter Miami', '明尼苏达联': 'Minnesota United', '蒙特利尔CF': 'Montreal',
  '纳什维尔SC': 'Nashville', '新英格兰革命': 'New England', '纽约城FC': 'New York City',
  '纽约红牛': 'New York Red Bulls', '奥兰多城': 'Orlando City', '费城联合': 'Philadelphia',
  '波特兰伐木者': 'Portland Timbers', '皇家盐湖城': 'Salt Lake', '圣何塞地震': 'San Jose',
  '西雅图海湾人': 'Seattle Sounders', '圣路易斯城': 'St. Louis', '多伦多FC': 'Toronto',
  '温哥华白帽': 'Vancouver', '奥斯汀FC': 'Austin', '圣迭戈FC': 'San Diego',
};

(async () => {
  const START = parseInt(process.argv[2]);
  const END = parseInt(process.argv[3]);
  if (!START || !END) { console.log('用法: node _scrape_titan_v3.js <startId> <endId>'); process.exit(1); }
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setDefaultNavigationTimeout(25000);

  let saved = 0, nonEPL = 0, noData = 0;
  console.log(`掃描: ${START} → ${END}`);

  for (let id = START; id >= END; id--) {
    try {
      await page.goto(`https://vip.titan007.com/Corner.aspx?id=${id}&l=0`, { waitUntil: 'networkidle2', timeout: 20000 });
      await new Promise(r => setTimeout(r, 2500));
      const data = await page.evaluate(() => {
        const title = document.title || '';
        const body = document.body.innerText || '';
        const dm = body.match(/(\d{4})-(\d{2})-(\d{2})\s+\d{2}:\d{2}/);
        const dateStr = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : (body.match(/\d{4}-\d{2}-\d{2}/) || [null])[0];
        for (const t of document.querySelectorAll('table')) {
          for (const row of t.querySelectorAll('tr')) {
            const cells = Array.from(row.querySelectorAll('td,th')).map(c => (c.innerText || '').trim());
            if (cells[0] !== 'Crow*') continue;
            // 結構：[Crow*, 初大, 初線, 初細, 中大, 中線, 中細, 終大, 終線, 終細, 详]
            // 終盤 = cells[7-9]（10+ cells）；fallback cells[4-6]（8 cells 舊格式）
            const n = cells.length;
            if (n >= 10) {
              return { title, dateStr, cells, fmt: 'v2',
                openOver: cells[1], openLine: cells[2], openUnder: cells[3],
                closeOver: cells[7], closeLine: cells[8], closeUnder: cells[9] };
            } else if (n >= 8) {
              return { title, dateStr, cells, fmt: 'v1',
                openOver: cells[1], openLine: cells[2], openUnder: cells[3],
                closeOver: cells[4], closeLine: cells[5], closeUnder: cells[6] };
            }
          }
        }
        return null;
      });
      const isMLS = data && /美職|职业大联盟|MLS/i.test(data.title);
      const isBUN = data && /德甲|Bundesliga/i.test(data.title);
      const isLAL = data && /西甲|La Liga| Laliga/i.test(data.title);
      const leagueCode = isMLS ? 'MLS' : isBUN ? 'BUN' : isLAL ? 'LAL' : 'EPL';
      if (!data || (!data.title.includes('英超') && !isMLS && !isBUN && !isLAL)) { nonEPL++; continue; }
      if (!data.closeLine || !data.dateStr) { noData++; continue; }
      const tm = data.title.match(/(.+?)VS(.+?)\(/);
      if (!tm) { noData++; continue; }
      const home = TEAM_MAP[tm[1].trim()] || tm[1].trim();
      const away = TEAM_MAP[tm[2].trim()] || tm[2].trim();
      // HK 盤 → decimal（+1）
      const toDec = (v) => { const f = parseFloat(v); return f > 0 && f < 1.5 ? +(f + 1).toFixed(2) : f || null; };
      const line = parseFloat(data.closeLine) || parseFloat(data.openLine);
      if (!line) { noData++; continue; }
      const m = await pool.query(
        `SELECT id FROM football_matches WHERE league=$2 AND match_date=$1 AND home_team=$3 LIMIT 1`,
        [data.dateStr, leagueCode, home]);
      await pool.query(
        `INSERT INTO corner_odds (league, match_date, home_team, away_team, match_id, titan_id, line,
           over_open, under_open, over_close, under_close)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (league, match_date, home_team, away_team, line) DO UPDATE SET
           over_open=COALESCE($8, corner_odds.over_open), under_open=COALESCE($9, corner_odds.under_open),
           over_close=COALESCE($10, corner_odds.over_close), under_close=COALESCE($11, corner_odds.under_close),
           match_id=COALESCE($5, corner_odds.match_id)`,
        [leagueCode, data.dateStr, home, away, m.rows[0]?.id || null, id, line,
         toDec(data.openOver), toDec(data.openUnder), toDec(data.closeOver), toDec(data.closeUnder)]);
      saved++;
    } catch (e) { noData++; }
    if ((saved + nonEPL + noData) % 100 === 0) console.log(`  [${saved + nonEPL + noData}] 存=${saved}`);
  }
  console.log(`完成：存 ${saved}・非英超 ${nonEPL}・其他 ${noData}`);
  await browser.close();
  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
