// 分段時間回補（高級排位表：同程最快末段 / 最快末段用）
// 為某賽馬日排位表內馬匹嘅過往出賽賽事，逐場補抓 displaysectionaltime。
// 關鍵：displaysectionaltime 用「meeting 場次號碼」（1..N），而
// race_records.race_no 係偏移號碼 — 已驗證可用
//   meeting_no = race_no - MIN(race_no of that date) + 1
// 換算（見 2026-09-23/16 對照測試）。
const pool = require('../db/pool');
const scraper = require('../scrapers/hkjc');

const state = {
  active: false, date: null, total: 0, done: 0,
  savedRaces: 0, current: null, finishedAt: null,
};

const dstr = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// 收集要補抓嘅 (date, meetingNo) 清單：排位表馬匹最近 N 仗
async function collectTargets(date, perHorseRuns = 10) {
  const horses = await pool.query(
    `SELECT DISTINCT horse_name FROM racecard WHERE race_date = $1 AND horse_name IS NOT NULL`,
    [date]
  );
  const names = horses.rows.map(r => r.horse_name);
  if (!names.length) return [];

  const past = await pool.query(
    `SELECT DISTINCT race_date FROM (
       SELECT race_date, horse_name,
              ROW_NUMBER() OVER (PARTITION BY horse_name ORDER BY race_date DESC) AS rn
       FROM race_records
       WHERE horse_name = ANY($1) AND race_date < $2 AND finish_position IS NOT NULL
     ) t WHERE rn <= $3 ORDER BY race_date DESC`,
    [names, date, perHorseRuns]
  );
  const dates = past.rows.map(r => dstr(r.race_date));

  const targets = [];
  for (const d of dates) {
    // 該日每場：偏移 race_no → meeting 號碼
    const rr = await pool.query(
      `SELECT race_no FROM race_records WHERE race_date = $1 GROUP BY race_no ORDER BY race_no`,
      [d]
    );
    if (!rr.rows.length) continue;
    const minNo = rr.rows[0].race_no;
    const exist = new Set(
      (await pool.query(
        `SELECT DISTINCT race_no FROM race_sectional_times WHERE race_date = $1`, [d]
      )).rows.map(r => r.race_no)
    );
    for (const row of rr.rows) {
      const meetingNo = row.race_no - minNo + 1;
      if (meetingNo < 1 || meetingNo > 14) continue; // 防雜訊
      if (exist.has(meetingNo)) continue;
      targets.push({ date: d, meetingNo });
    }
  }
  return targets;
}

async function start(date) {
  if (state.active) return { busy: true };

  const targets = await collectTargets(date);
  if (!targets.length) return { total: 0 };

  Object.assign(state, {
    active: true, date, total: targets.length, done: 0,
    savedRaces: 0, current: null, finishedAt: null,
  });

  (async () => {
    for (const t of targets) {
      try {
        state.current = `${t.date} R${t.meetingNo}`;
        const data = await scraper.scrapeSectionalTime(t.date, t.meetingNo);
        if (data && !data.error) {
          await scraper.saveSectionalTime(data);
          state.savedRaces++;
        }
      } catch (e) {
        console.error(`[sectional-backfill] ${t.date} R${t.meetingNo}: ${e.message}`);
      }
      state.done++;
    }
    state.active = false;
    state.current = null;
    state.finishedAt = new Date().toISOString();
    console.log(`[sectional-backfill] ${date} 完成：${state.done} 場，儲存 ${state.savedRaces} 場`);
  })();

  return { total: targets.length };
}

function getStatus() { return { ...state }; }

module.exports = { start, getStatus };
