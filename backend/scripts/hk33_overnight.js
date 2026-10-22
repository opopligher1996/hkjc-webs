// ── HK33 隔夜大熱統計：爬走勢歷史 → 開飛日 19:00 最低賠率馬 → 最終名次 ──
const puppeteer = require('puppeteer');
const pool = require('../src/db/pool');
const SID = process.env.HK33_SID || 'mfouglpl6ncl063lsvkebd87rt';

const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

async function scrapeRace(page, date, course, raceNo) {
  const url = `https://horse.hk33.com/analysis/jc-wp-trends-history?date=${date}&race=${raceNo}&type=w`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await new Promise(r => setTimeout(r, 3500));
  return await page.evaluate(() => {
    for (const t of document.querySelectorAll('table')) {
      const txt = t.innerText || '';
      if (!txt.includes('名次') || !txt.includes('獨贏')) continue;
      const rows = Array.from(t.rows).map(tr => Array.from(tr.cells).map(c => (c.innerText || '').trim().replace(/\s+/g, '')));
      const header = {};
      rows.forEach((r, i) => { if (r[0] === '馬名') header.name = i; if (r[0] === '名次') header.pos = i; if (r[0] === '獨贏') header.win = i; });
      if (header.name == null) continue;
      const names = rows[header.name].slice(1).filter(x => x);
      const positions = header.pos != null ? rows[header.pos].slice(1) : [];
      const finalOdds = header.win != null ? rows[header.win].slice(1) : [];
      const timeline = [];
      for (const r of rows) {
        if (/^\d{1,2}:\d{2}$/.test(r[0])) timeline.push([r[0], r.slice(1)]);
      }
      return { names, positions, finalOdds, timeline };
    }
    return null;
  });
}

function pick1900(timeline) {
  if (!timeline.length) return null;
  // 第一個「19:00-19:59」段（開飛當晚）最早嗰行
  for (const [t, odds] of timeline) {
    const m = toMin(t);
    if (m >= 19 * 60 && m < 20 * 60) return { t, odds };
  }
  // fallback：頭一行
  return { t: timeline[0][0], odds: timeline[0][1] };
}

(async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS hk33_overnight_fav (
    race_date date, racecourse text, race_no int,
    horse text, odds_1900 numeric, odds_final numeric, finish int,
    snap_time text, PRIMARY KEY (race_date, racecourse, race_no))`);

  // 賽日列表 + 每場跑道（跳過田泥）
  const { rows: meetings } = await pool.query(
    `SELECT DISTINCT race_date, racecourse FROM race_records
     WHERE race_date >= '2024-09-01' AND racecourse IN ('ST','HV')
     ORDER BY race_date`);
  console.log('賽日:', meetings.length);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const pages = await Promise.all([browser.newPage(), browser.newPage()]);
  for (const p of pages) {
    await p.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await p.setCookie(
      { name: 'PHPSESSID', value: SID, domain: '.hk33.com', path: '/' },
      { name: 'i_am_18_or_over', value: '1', domain: '.hk33.com', path: '/' },
    );
  }

  let done = 0, saved = 0, empty = 0;
  const queue = [...meetings];
  const results = [];
  const worker = async (page) => {
    while (queue.length) {
      const m = queue.shift();
      if (!m) break;
      const date = m.race_date.toISOString().slice(0, 10);
      // 已完成嘅賽日跳過
      const { rows: ex } = await pool.query(
        `SELECT COUNT(*) n FROM hk33_overnight_fav WHERE race_date = $1 AND racecourse = $2`, [date, m.racecourse]);
      if (+ex[0].n > 0) { done++; continue; }
      // 呢日草場次（跳過田泥）
      const { rows: races } = await pool.query(
        `SELECT DISTINCT race_no, track_type FROM race_records WHERE race_date = $1 AND racecourse = $2 ORDER BY race_no`,
        [date, m.racecourse]);
      const turfRaces = races.filter(r => r.track_type !== 'AWT').map(r => r.race_no);
      let got = 0;
      for (const rn of turfRaces) {
        try {
          const d = await scrapeRace(page, date, m.racecourse, rn);
          if (!d || !d.names.length) continue;
          const ov = pick1900(d.timeline);
          if (!ov) continue;
          // 19:00 嗰行最低賠率馬
          let bi = -1, bv = Infinity;
          ov.odds.forEach((o, i) => {
            if (i >= d.names.length) return;
            const v = parseFloat(o);
            if (v > 1 && v < bv) { bv = v; bi = i; }
          });
          if (bi < 0) continue;
          const finish = parseInt(d.positions[bi]) || null;
          const oddsFinal = parseFloat(d.finalOdds[bi]) || null;
          await pool.query(
            `INSERT INTO hk33_overnight_fav VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (race_date, racecourse, race_no) DO NOTHING`,
            [date, m.racecourse, rn, d.names[bi], bv, oddsFinal, finish, ov.t]);
          got++; saved++;
        } catch (_) {}
      }
      if (!got) empty++;
      done++;
      if (done % 10 === 0) console.log(`進度 ${done}/${meetings.length}・已存 ${saved} 場・空頁 ${empty}`);
      results.push(`${date} ${m.racecourse}: ${got}場`);
    }
  };
  await Promise.all(pages.map(worker));
  console.log(`完成：${done} 賽日・${saved} 場入庫・${empty} 個賽日冇數據`);
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
