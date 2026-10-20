// 補移欄：逐馬匹頁紀錄表 → 賽道("C+3"等) → race_records.rail
// 一個馬匹頁覆蓋多個賽日・聰明揀馬減少請求
const puppeteer = require('puppeteer');
const pool = require('/app/src/db/pool');

const railOf = cell => {
  // 跑馬地草地"C+3" / 沙田草地"A" / 沙田全天候(冇欄)
  const m = cell.match(/"([A-C]\+?\d*)"/);
  if (m) return m[1];
  if (cell.includes('全天候')) return 'NA'; // 田泥冇移欄
  return null;
};
const courseOf = cell => cell.includes('跑馬地') ? 'HV' : cell.includes('沙田') ? 'ST' : null;
const trackOf = cell => cell.includes('草地') ? 'TURF' : cell.includes('全天候') ? 'AWT' : null;

(async () => {
  // 需補組合
  const { rows: combos } = await pool.query(
    `SELECT DISTINCT race_date, racecourse, track_type FROM race_records
     WHERE rail IS NULL AND track_type IS NOT NULL ORDER BY race_date DESC`);
  const fmt = d => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
  const need = new Set(combos.map(c => `${fmt(c.race_date)}|${c.racecourse}|${c.track_type}`));
  console.log('需補組合:', need.size);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();

  let filled = 0, horses = 0;
  const scrapedHorses = new Set();

  while (need.size && horses < 600) {
    // 揀一隻馬：覆蓋最多未補組合嘅馬（簡化：攞任一未補組合入面出賽最多嘅馬）
    const key = [...need][0];
    const [d, c, t] = key.split('|');
    const { rows: cand } = await pool.query(
      `SELECT horse_name, COUNT(*) n FROM race_records
       WHERE race_date = $1 AND racecourse = $2 AND track_type = $3 AND horse_name IS NOT NULL
       GROUP BY 1 ORDER BY n DESC LIMIT 12`, [d, c, t]);
    const horse = cand.find(h => !scrapedHorses.has(h.horse_name));
    if (!horse) { need.delete(key); continue; }
    scrapedHorses.add(horse.horse_name);
    horses++;

    try {
      // 馬匹頁要 HorseNo — horses 表有冇？用搜尋 URL：horse?HorseNo= 要編號
      // 我哋 horses 表有 horse_id？
      const { rows: hr } = await pool.query('SELECT id FROM horses WHERE name_zh = $1 LIMIT 1', [horse.horse_name]);
      let url = null;
      if (hr[0]?.id) {
        // id 格式 HK_2024_K298 → URL 要 K298
        const no = hr[0].id.split('_').pop();
        url = 'https://racing.hkjc.com/zh-hk/local/information/horse?HorseNo=' + no;
      }
      if (!url) { need.delete(key); continue; }

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(r => setTimeout(r, 800));
      const rowsData = await page.evaluate(() => {
        const out = [];
        for (const tr of document.querySelectorAll('tr')) {
          const tds = Array.from(tr.querySelectorAll('td')).map(td => (td.innerText || '').trim());
          // 搵「場地+賽道」格：跑馬地草地"C+3" 格式
          const cell = tds.find(t => /(跑馬地|沙田)(草地|全天候)/.test(t));
          if (!cell) continue;
          const dateCell = tds.find(t => /^\d{2}\/\d{2}\/\d{2}$/.test(t));
          if (!dateCell) continue;
          out.push({ dateCell, cell });
        }
        return out;
      });

      let pageFilled = 0;
      for (const r of rowsData) {
        const [dd, mm, yy] = r.dateCell.split('/').map(Number);
        const date = `20${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
        const course = courseOf(r.cell), track = trackOf(r.cell), rail = railOf(r.cell);
        if (!course || !track || !rail) continue;
        const k = `${date}|${course}|${track}`;
        if (!need.has(k)) continue;
        const rg = await pool.query(
          `UPDATE race_records SET rail = $1 WHERE race_date = $2 AND racecourse = $3 AND track_type = $4 AND rail IS NULL`,
          [rail, date, course, track]);
        if (rg.rowCount) pageFilled += rg.rowCount;
        need.delete(k);
        filled++;
      }
      if (horses % 20 === 0) console.log('  馬匹', horses, '・已補組合', filled, '・剩', need.size);
      if (!rowsData.length) { /* 呢隻馬冇料・繼續 */ }
    } catch (_) {}
    // 如果頭個 key 已被呢隻馬覆蓋咗就自然循環落去
  }
  console.log(`完成：${horses} 隻馬・填咗 ${filled} 個組合・剩低 ${need.size}`);
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
