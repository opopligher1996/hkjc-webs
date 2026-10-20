// ── 盤口軌跡追蹤：每 2 小時 snapshot pending 深綠格嘅賠率/盤口 ──
// 驗證「中段升盤・尾水返轉頭 → 開出」假設
const cron = require('node-cron');
const pool = require('../db/pool');

const running = { busy: false, last: 0, runs: 0, rows: 0 };

async function snapshotPending() {
  if (running.busy) return { skipped: true };
  if (Date.now() - running.last < 90 * 60 * 1000) return { skipped: true }; // 1.5h 內唔重複
  running.busy = true;
  let inserted = 0;
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

    // 3) titan 即時平均（逐場）— src='titan'
    const { scrape1x2 } = require('../football/titan1x2');
    for (const p of pending) {
      if (!p.titan_id) continue;
      try {
        const d = await scrape1x2(p.titan_id);
        if (d?.liveAvg?.h) {
          await pool.query(
            `INSERT INTO hda_odds_snap (fb, titan_id, src, h, d, a)
             VALUES ($1,$2,'titan',$3,$4,$5)`,
            [p.fb, p.titan_id, d.liveAvg.h, d.liveAvg.d, d.liveAvg.a]);
          inserted++;
        }
      } catch (_) {}
    }
    running.runs++;
    running.rows += inserted;
    return { ok: true, matches: pending.length, inserted };
  } catch (e) {
    return { error: e.message };
  } finally {
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
