// titan007 香港馬會入球盤（OverDown_n.aspx）— 用已知 titan_id 掃描
// 用法：docker compose run --rm backend node scripts/_scrape_hkjc_goals.js [startId] [endId]
const puppeteer = require('puppeteer');
const pool = require('../src/db/pool');
const TEAM_MAP = require('../src/football/titanLive').TEAM_MAP || {};

(async () => {
  const START = parseInt(process.argv[2]);
  const END = parseInt(process.argv[3]);
  if (!START || !END) { console.log('用法: _scrape_hkjc_goals.js <startId> <endId>'); process.exit(1); }
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setDefaultNavigationTimeout(20000);

  let saved = 0, skipped = 0, failed = 0;
  console.log(`掃描: ${START} → ${END}`);

  for (let id = START; id >= END; id--) {
    try {
      // 跳過已有
      const exists = await pool.query('SELECT 1 FROM goal_odds WHERE titan_id = $1 LIMIT 1', [id]);
      if (exists.rows.length) { skipped++; continue; }

      await page.goto(`https://vip.titan007.com/OverDown_n.aspx?id=${id}&l=0`, { waitUntil: 'networkidle2', timeout: 18000 });
      await new Promise(r => setTimeout(r, 2000));
      const data = await page.evaluate(() => {
        const title = document.title || '';
        const body = document.body.innerText || '';
        const dm = body.match(/(\d{4})-(\d{2})-(\d{2})\s+\d{2}:\d{2}/);
        const dateStr = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null;
        // 搵香港马*
        for (const t of document.querySelectorAll('table')) {
          for (const row of t.querySelectorAll('tr')) {
            const cells = Array.from(row.querySelectorAll('td')).map(c => (c.innerText || '').trim());
            if (cells.some(c => c.includes('香港马'))) {
              return { title, dateStr, cells };
            }
          }
        }
        return { title, dateStr, cells: null };
      });

      // 判斷聯賽
      const isEPL = /英超/.test(data.title);
      const isLAL = /西甲/.test(data.title);
      const isBUN = /德甲/.test(data.title);
      const isMLS = /MLS|美職|职业大联盟/.test(data.title);
      if (!isEPL && !isLAL && !isBUN && !isMLS) { failed++; continue; }
      if (!data.cells || !data.dateStr) { failed++; continue; }

      // 解析：cells[3]=大初, cells[4]=線初, cells[5]=細初, cells[9]=大終, cells[10]=線終, cells[11]=細終
      const overOpen = parseFloat(data.cells[3]) || null;
      const lineOpen = data.cells[4] || null;
      const underOpen = parseFloat(data.cells[5]) || null;
      const overClose = parseFloat(data.cells[9]) || null;
      const lineClose = data.cells[10] || null;
      const underClose = parseFloat(data.cells[11]) || null;

      if (!lineClose && !lineOpen) { failed++; continue; }

      // 隊名由 title
      const tm = data.title.match(/(.+?)VS(.+?)\(/);
      if (!tm) { failed++; continue; }
      const homeCN = tm[1].trim(), awayCN = tm[2].trim();

      // 用 DB 已有嘅 titan corner_odds 隊名（已轉英文）
      const existing = await pool.query(
        'SELECT home_team, away_team, match_id FROM corner_odds WHERE titan_id = $1 LIMIT 1', [id]);
      let home = existing.rows[0]?.home_team;
      let away = existing.rows[0]?.away_team;
      let matchId = existing.rows[0]?.match_id;
      if (!home) {
        // fallback：mapTeam
        home = mapTeam(homeCN);
        away = mapTeam(awayCN);
      }

      const league = isEPL ? 'EPL' : isLAL ? 'LAL' : isBUN ? 'BUN' : 'MLS';
      const toDec = (v) => { const f = parseFloat(v); return f > 0 && f < 1.5 ? +(f + 1).toFixed(2) : f || null; };
      const line = lineClose || lineOpen;

      await pool.query(
        `INSERT INTO goal_odds (league, match_date, home_team, away_team, match_id, titan_id, line,
           over_open, under_open, over_close, under_close)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (league, match_date, home_team, away_team, line) DO UPDATE SET
           over_open=COALESCE($8, goal_odds.over_open), under_open=COALESCE($9, goal_odds.under_open),
           over_close=COALESCE($10, goal_odds.over_close), under_close=COALESCE($11, goal_odds.under_close),
           match_id=COALESCE($5, goal_odds.match_id)`,
        [league, data.dateStr, home, away, matchId, id, line,
         toDec(overOpen), toDec(underOpen), toDec(overClose), toDec(underClose)]);
      saved++;
      if (saved % 50 === 0) console.log(`  [${saved}] 掃過 ${START - id}`);
    } catch (e) { failed++; }
  }
  console.log(`完成：存 ${saved}・跳 ${skipped}・敗 ${failed}`);
  await browser.close(); await pool.end(); process.exit(0);

  function mapTeam(cn) {
    for (const [k, v] of Object.entries(TEAM_MAP)) { if (cn.includes(k)) return v; }
    return cn;
  }
})().catch(e => { console.error(e); process.exit(1); });
