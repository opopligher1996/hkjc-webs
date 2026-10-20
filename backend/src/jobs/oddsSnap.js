// ── 盤口軌跡追蹤：每 2 小時 snapshot pending 深綠格嘅賠率/盤口 ──
// 驗證「中段升盤・尾水返轉頭 → 開出」假設
const cron = require('node-cron');
const pool = require('../db/pool');

const running = { busy: false, last: 0, runs: 0, rows: 0 };

async function snapshotPending(opts = {}) {
  if (running.busy) return { skipped: true };
  // 手動 force 跳過 1.5h 防重・cron 用預設 guard
  if (!opts.force && Date.now() - running.last < 90 * 60 * 1000) return { skipped: true };
  running.busy = true;
  let inserted = 0;
  let browser3 = null;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS hda_odds_snap (
      id SERIAL PRIMARY KEY,
      fb TEXT NOT NULL,
      titan_id BIGINT,
      snap_at TIMESTAMPTZ DEFAULT now(),
      src TEXT,
      h NUMERIC, d NUMERIC, a NUMERIC,
      ah_line TEXT, ah_odds NUMERIC
    )`);
    // pending 深綠格（未完場・有 fb）
    const { rows: pending } = await pool.query(
      `SELECT fb, titan_id, home FROM hda_track WHERE color='D' AND result IS NULL ORDER BY match_date, kickoff`);
    if (!pending.length) return { ok: true, matches: 0, inserted: 0 };
    // 獨立 browser page 跑 titan 走勢（唔同 HKJC scraper 用嘅）
    const puppeteer = require('puppeteer');
    browser3 = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page3 = await browser3.newPage();
    const fbSet = new Set(pending.map(p => p.fb));

    // 1) HKJC HAD 賠率（一次過成個列表）
    let hadMap = {};
    try {
      const { scrapeHkjcMatches } = require('../football/hkjcFootball');
      const list = await scrapeHkjcMatches();
      hadMap = Object.fromEntries(list.filter(m => fbSet.has(m.fb)).map(m => [m.fb, m]));
    } catch (_) {}

    // 2) HKJC 讓球盤口（一次過）
    let ahMap = {};
    try {
      const { scrapeHkjcAh } = require('../football/hkjcFootball');
      const list = await scrapeHkjcAh();
      for (const m of (list || [])) {
        if (fbSet.has(m.fb)) ahMap[m.fb] = m;
      }
    } catch (_) {}

    // 合併入庫（src='hkjc'：HAD + AH 線）
    for (const p of pending) {
      const had = hadMap[p.fb], ah = ahMap[p.fb];
      if (!had && !ah) continue;
      await pool.query(
        `INSERT INTO hda_odds_snap (fb, titan_id, src, h, d, a, ah_line, ah_odds)
         VALUES ($1,$2,'hkjc',$3,$4,$5,$6,$7)`,
        [p.fb, p.titan_id || null,
         had?.hadH ?? null, had?.hadD ?? null, had?.hadA ?? null,
         ah?.homeLine ?? null, ah?.homeOdds ?? null]);
      inserted++;
    }

    // 3) titan 每間主流莊完整走勢（OddsHistory・由初盤計 — 同歷史回測同一口徑）
    //    每次重抓：先刪舊 hist 再插全新（歷史細・等冪）
    const { scrape1x2 } = require('../football/titan1x2');
    let histPts = 0;
    for (const p of pending) {
      if (!p.titan_id) continue;
      try {
        await page3.goto('https://1x2.titan007.com/oddslist/' + p.titan_id + '_2.htm', { waitUntil: 'domcontentloaded', timeout: 40000 });
        await new Promise(r => setTimeout(r, 2000));
        const books = await page3.evaluate(() => {
          const out = [];
          for (const tr of document.querySelectorAll('tr[id^=oddstr_]')) {
            const mainstream = !!tr.querySelector('img[src="/images/z.png"]');
            const nameEl = tr.querySelector('td:nth-child(2)');
            const name = nameEl ? nameEl.textContent.replace(/\*.*$/, '').trim() : '?';
            const oc = tr.querySelector('td[onclick]')?.getAttribute('onclick') || '';
            const um = oc.match(/OddsHistory\('([^']+)'\)/);
            if (um) out.push({ name, mainstream, url: um[1].replace(/&amp;/g, '&') });
          }
          return out;
        });
        const use = (books.filter(b => b.mainstream).slice(0, 10)).length
          ? books.filter(b => b.mainstream).slice(0, 10) : books.slice(0, 8);
        if (!use.length) continue;
        // 重抓：刪呢場舊 hist
        await pool.query(`DELETE FROM hda_odds_snap WHERE fb = $1 AND src = 'hist'`, [p.fb]);
        const year = new Date().getFullYear();
        for (const b of use) {
          try {
            await page3.goto('https://1x2.titan007.com' + b.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 700));
            const txt = await page3.evaluate(() => document.body.innerText);
            const re = /^(\d+\.\d{2})\s+(\d+\.\d{2})\s+(\d+\.\d{2})\s+.*?(\d{2}-\d{2} \d{2}:\d{2})(\(初盘\))?$/;
            for (const line of txt.split('\n')) {
              const mm = line.trim().match(re);
              if (!mm) continue;
              const ts = new Date(year + '-' + mm[4] + ':00+08:00');
              if (isNaN(ts)) continue;
              await pool.query(
                `INSERT INTO hda_odds_snap (fb, titan_id, snap_at, src, h, d, a, company)
                 VALUES ($1,$2,$3,'hist',$4,$5,$6,$7)`,
                [p.fb, p.titan_id, ts.toISOString(), mm[1], mm[2], mm[3], b.name]);
              histPts++;
            }
          } catch (_) {}
        }
      } catch (_) {}
    }
    running.runs++;
    running.rows += inserted + histPts;
    return { ok: true, matches: pending.length, inserted, histPts };
  } catch (e) {
    return { error: e.message };
  } finally {
    if (browser3) await browser3.close().catch(() => {});
    running.busy = false;
    running.last = Date.now();
  }
}

function start() {
  cron.schedule('0 */2 * * *', () => {
    snapshotPending().catch(e => console.error('[oddsSnap]', e.message));
  });
  console.log('[oddsSnap] 盤口軌跡追蹤已排程: 每 2 小時');
}

module.exports = { start, snapshotPending, state: running };
