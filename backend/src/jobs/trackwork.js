// 晨操資料批量更新（高級排位表：賽前試閘 / 騎師親試用）
// 抓取 trackworkresult 頁面 → horse_workout_log（全部類別）+ horse_trials（試閘）
const pool = require('../db/pool');
const scraper = require('../scrapers/hkjc');

const state = {
  active: false, date: null, total: 0, done: 0,
  savedLog: 0, savedTrials: 0, current: null, finishedAt: null,
};

async function saveTrackworkForHorse(h) {
  const rows = await scraper.scrapeHorseTrackworkHistory(h.horse_id);
  let saved = 0;
  for (const row of rows) {
    if (row.type === '出賽') continue; // 出賽紀錄由 race_records 負責
    try {
      await pool.query(
        `INSERT INTO horse_workout_log (horse_id, horse_name, log_date, workout_type, venue, details)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (horse_id, log_date, workout_type, venue) DO UPDATE SET
           details=$6, scraped_at=NOW()`,
        [h.horse_id, h.horse_name, row.date, row.type, row.venue || '', row.details || '']
      );
      state.savedLog++;
      saved++;
    } catch (_) { /* 個別行失敗唔阻斷 */ }
    if (row.type === '試閘') {
      try {
        await pool.query(
          `INSERT INTO horse_trials (horse_id, horse_name, trial_date, venue, details)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (horse_id, trial_date) DO UPDATE SET
             venue=$4, details=$5, scraped_at=NOW()`,
          [h.horse_id, h.horse_name, row.date, row.venue, row.details]
        );
        state.savedTrials++;
      } catch (_) {}
    }
  }
  return saved;
}

// 啟動一次批量抓取。race_no 可選：只抓該場。
// 回傳 { total }；如果已經有任務進行中，回傳 { busy: true }
async function start(date, raceNo = null) {
  if (state.active) return { busy: true };

  const params = [date];
  let filter = '';
  if (raceNo != null && raceNo !== '') {
    params.push(parseInt(raceNo, 10));
    filter = `AND race_no = $${params.length}`;
  }
  const rc = await pool.query(
    `SELECT DISTINCT horse_id, horse_name FROM racecard
     WHERE race_date = $1 AND horse_id IS NOT NULL ${filter}`,
    params
  );
  if (!rc.rows.length) return { total: 0 };

  Object.assign(state, {
    active: true, date, total: rc.rows.length, done: 0,
    savedLog: 0, savedTrials: 0, current: null, finishedAt: null,
  });

  (async () => {
    for (const h of rc.rows) {
      try {
        state.current = h.horse_name;
        await saveTrackworkForHorse(h);
      } catch (e) {
        console.error(`[trackwork] ${h.horse_name}: ${e.message}`);
      }
      state.done++;
    }
    state.active = false;
    state.current = null;
    state.finishedAt = new Date().toISOString();
    console.log(`[trackwork] ${date} 完成：${state.done} 匹，log=${state.savedLog}，trials=${state.savedTrials}`);
  })();

  return { total: rc.rows.length };
}

function getStatus() { return { ...state }; }

module.exports = { start, getStatus };
