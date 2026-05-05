const cron = require('node-cron');
const scraper = require('../scrapers/hkjc');
const pool = require('../db/pool');

// ── helpers ───────────────────────────────────────────────────────────────────

function log(job, msg) {
  console.log(`[scheduler][${job}] ${new Date().toISOString()} ${msg}`);
}

function err(job, msg, e) {
  console.error(`[scheduler][${job}] ${new Date().toISOString()} ${msg}`, e?.message || e);
}

/**
 * Returns the nearest upcoming race date and racecourse from the fixtures table.
 * "Upcoming" means today or later (in case the race is today but not yet run).
 */
async function getNextRaceDay() {
  const result = await pool.query(
    `SELECT TO_CHAR(race_date, 'YYYY-MM-DD') AS race_date, racecourse
     FROM fixtures
     WHERE race_date >= CURRENT_DATE
     ORDER BY race_date
     LIMIT 1`
  );
  if (result.rows.length === 0) return null;
  return result.rows[0]; // { race_date, racecourse }
}

// ── Job implementations ───────────────────────────────────────────────────────

async function jobJockeys() {
  log('jockeys', '開始更新騎師資料');
  try {
    await scraper.runFullJockeyScrape(() => {});
    log('jockeys', '騎師資料更新完成');
  } catch (e) {
    err('jockeys', '騎師資料更新失敗', e);
  }
}

async function jobTrainers() {
  log('trainers', '開始更新練馬師資料');
  try {
    await scraper.runFullTrainerScrape(() => {});
    log('trainers', '練馬師資料更新完成');
  } catch (e) {
    err('trainers', '練馬師資料更新失敗', e);
  }
}

async function jobHorses() {
  log('horses', '開始全量 Sync 馬匹');
  try {
    await scraper.runFullHorseScrape(() => {});
    log('horses', '馬匹全量 Sync 完成');
  } catch (e) {
    err('horses', '馬匹全量 Sync 失敗', e);
  }
}

async function jobSectional() {
  log('sectional', '開始更新最近賽事分段時間');
  try {
    const next = await getNextRaceDay();
    if (!next) {
      log('sectional', '未找到最近賽事日期，跳過');
      return;
    }
    const { race_date: date, racecourse } = next;
    log('sectional', `目標: ${date} ${racecourse}`);

    // Determine race numbers from racecard, else scrape from localresults
    let targetRaceNos;
    const rcResult = await pool.query(
      `SELECT DISTINCT race_no FROM racecard WHERE race_date = $1 ORDER BY race_no`,
      [date]
    );
    if (rcResult.rows.length > 0) {
      targetRaceNos = rcResult.rows.map(r => r.race_no);
    } else {
      const totalRaces = await scraper.scrapeRaceCountFromLocalResults(date, racecourse);
      if (totalRaces) {
        targetRaceNos = Array.from({ length: totalRaces }, (_, i) => i + 1);
      } else {
        log('sectional', `無法取得 ${date} 場次資料，跳過`);
        return;
      }
    }
    log('sectional', `共 ${targetRaceNos.length} 場: [${targetRaceNos.join(',')}]`);

    // Identify already-scraped sectional times
    const existResult = await pool.query(
      `SELECT DISTINCT race_no FROM race_sectional_times WHERE race_date = $1`, [date]
    );
    const alreadyScraped = new Set(existResult.rows.map(r => r.race_no));
    const toScrape = targetRaceNos.filter(rno => !alreadyScraped.has(rno));

    // Identify races missing fastest splits
    const fsResult = await pool.query(
      `SELECT DISTINCT race_no FROM race_fastest_splits WHERE race_date = $1`, [date]
    );
    const hasFastestSplits = new Set(fsResult.rows.map(r => r.race_no));
    const needFastestSplits = Array.from(alreadyScraped).filter(rno => !hasFastestSplits.has(rno));

    // Backfill fastest splits for already-scraped races
    for (const raceNo of needFastestSplits) {
      try {
        await scraper.saveLocalResults(date, racecourse, raceNo);
        log('sectional', `補抓最快分段 R${raceNo} 完成`);
      } catch (e) {
        err('sectional', `補抓最快分段 R${raceNo} 失敗`, e);
      }
    }

    // Scrape new sectional times + fastest splits, one race at a time
    for (const raceNo of toScrape) {
      // Scrape sectional times (Puppeteer — may be slow, no timeout issues in backend)
      try {
        const data = await scraper.scrapeSectionalTime(date, raceNo);
        if (data && !data.error) {
          await scraper.saveSectionalTime(data);
          log('sectional', `R${raceNo} 分段時間已儲存`);
        } else {
          log('sectional', `R${raceNo} 分段時間未公佈，跳過`);
        }
      } catch (e) {
        err('sectional', `R${raceNo} 分段時間爬取失敗`, e);
      }
      // Scrape fastest splits (axios+cheerio — fast)
      try {
        await scraper.saveLocalResults(date, racecourse, raceNo);
        log('sectional', `R${raceNo} 最快分段已儲存`);
      } catch (e) {
        err('sectional', `R${raceNo} 最快分段爬取失敗`, e);
      }
    }

    log('sectional', `分段時間更新完成 (新抓: ${toScrape.length}, 補抓最快: ${needFastestSplits.length})`);
  } catch (e) {
    err('sectional', '分段時間更新失敗', e);
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setupJobs() {
  // All times are Hong Kong Time (UTC+8)
  // node-cron cron format: second(optional) minute hour day month weekday

  // 01:00 HKT — 更新騎師資料
  cron.schedule('0 1 * * *', jobJockeys, { timezone: 'Asia/Hong_Kong' });
  log('setup', '騎師自動更新已排程: 每日 01:00 HKT');

  // 02:00 HKT — 更新練馬師資料
  cron.schedule('0 2 * * *', jobTrainers, { timezone: 'Asia/Hong_Kong' });
  log('setup', '練馬師自動更新已排程: 每日 02:00 HKT');

  // 03:00 HKT — 全量 Sync 馬匹
  cron.schedule('0 3 * * *', jobHorses, { timezone: 'Asia/Hong_Kong' });
  log('setup', '馬匹全量 Sync 已排程: 每日 03:00 HKT');

  // 04:00 HKT — 更新最近賽事分段時間
  cron.schedule('0 4 * * *', jobSectional, { timezone: 'Asia/Hong_Kong' });
  log('setup', '分段時間自動更新已排程: 每日 04:00 HKT');
}

module.exports = { setupJobs };
