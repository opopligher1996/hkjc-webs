const express = require('express');
const cors = require('cors');
const { initDb } = require('./db/init');
const scraper = require('./scrapers/hkjc');

const app = express();
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/jockeys', require('./routes/jockeys'));
app.use('/api/trainers', require('./routes/trainers'));
app.use('/api/draw', require('./routes/draw'));
app.use('/api/races', require('./routes/races'));
app.use('/api/horses', require('./routes/horses'));
app.use('/api/coursetime', require('./routes/coursetime'));

// ── SSE helpers ──────────────────────────────────────────────────────────────
// Map of active SSE clients per job type
const sseClients = { jockeys: new Set(), trainers: new Set(), fixtures: new Set(), horses: new Set(), racecard: new Set() };

function broadcast(type, data) {
  const clients = sseClients[type];
  if (!clients) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => {
    try { res.write(msg); } catch (_) {}
  });
}

function sseEndpoint(type) {
  return (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    sseClients[type].add(res);
    req.on('close', () => sseClients[type].delete(res));
  };
}

// SSE streams
app.get('/api/scrape/jockeys/progress', sseEndpoint('jockeys'));
app.get('/api/scrape/trainers/progress', sseEndpoint('trainers'));
app.get('/api/scrape/fixtures/progress', sseEndpoint('fixtures'));
app.get('/api/scrape/horses/progress', sseEndpoint('horses'));

// ── Manual scrape triggers ────────────────────────────────────────────────────
let jockeyScraping = false;
app.post('/api/scrape/jockeys', async (req, res) => {
  if (jockeyScraping) {
    return res.status(409).json({ message: '騎師更新進行中，請稍後' });
  }
  res.json({ message: '騎師資料更新已啟動' });
  jockeyScraping = true;
  broadcast('jockeys', { type: 'started' });
  scraper.runFullJockeyScrape((event) => {
    broadcast('jockeys', event);
  }).then(() => {
    broadcast('jockeys', { type: 'completed' });
  }).catch(err => {
    broadcast('jockeys', { type: 'error', message: err.message });
  }).finally(() => {
    jockeyScraping = false;
  });
});

let trainerScraping = false;
app.post('/api/scrape/trainers', async (req, res) => {
  if (trainerScraping) {
    return res.status(409).json({ message: '練馬師更新進行中，請稍後' });
  }
  res.json({ message: '練馬師資料更新已啟動' });
  trainerScraping = true;
  broadcast('trainers', { type: 'started' });
  scraper.runFullTrainerScrape((event) => {
    broadcast('trainers', event);
  }).then(() => {
    broadcast('trainers', { type: 'completed' });
  }).catch(err => {
    broadcast('trainers', { type: 'error', message: err.message });
  }).finally(() => {
    trainerScraping = false;
  });
});

let fixturesScraping = false;
app.post('/api/scrape/fixtures', async (req, res) => {
  if (fixturesScraping) {
    return res.status(409).json({ message: '賽期表更新進行中，請稍後' });
  }
  res.json({ message: '賽期表更新已啟動' });
  fixturesScraping = true;
  broadcast('fixtures', { type: 'started' });
  scraper.scrapeFixtures().then(() => {
    broadcast('fixtures', { type: 'completed' });
  }).catch(err => {
    broadcast('fixtures', { type: 'error', message: err.message });
  }).finally(() => {
    fixturesScraping = false;
  });
});

app.get('/api/scrape/racecard/progress', sseEndpoint('racecard'));

let racecardScraping = false;
app.post('/api/scrape/racecard', async (req, res) => {
  if (racecardScraping) {
    return res.status(409).json({ message: '排位表更新進行中，請稍後' });
  }
  // Accept optional { date, racecourse } in request body for targeted scrape
  const { date, racecourse } = req.body || {};
  res.json({ message: '排位表更新已啟動' });
  racecardScraping = true;
  broadcast('racecard', { type: 'started' });
  (async () => {
    try {
      const result = await scraper.scrapeRacecard(date || undefined, racecourse || undefined);
      if (result.raceDate && result.races.length > 0) {
        await scraper.saveRacecard(result.raceDate, result.racecourse, result.races);
        broadcast('racecard', { type: 'completed', raceDate: result.raceDate, racecourse: result.racecourse, races: result.races.length });
      } else {
        broadcast('racecard', { type: 'completed', message: '未找到排位表資料（可能此日期無賽事）', races: 0 });
      }
    } catch (err) {
      broadcast('racecard', { type: 'error', message: err.message });
    } finally {
      racecardScraping = false;
    }
  })();
});

app.post('/api/scrape/horse/:horseId', async (req, res) => {
  try {
    const { horseId } = req.params;
    const info = await scraper.scrapeHorse(horseId);
    if (info) {
      await scraper.saveHorse(horseId, info);
      res.json({ message: '馬匹資料已更新', horseId, name: info.name_zh });
    } else {
      res.status(404).json({ message: '未找到馬匹資料' });
    }
  } catch (err) {
    res.status(500).json({ message: '馬匹資料更新失敗：' + err.message });
  }
});

let horseScraping = false;
app.post('/api/scrape/horses', async (req, res) => {
  if (horseScraping) {
    return res.status(409).json({ message: '馬匹資料更新進行中，請稍後' });
  }
  res.json({ message: '馬匹資料全量更新已啟動' });
  horseScraping = true;
  broadcast('horses', { type: 'started' });
  scraper.runFullHorseScrape((event) => {
    broadcast('horses', event);
  }).then(() => {
    broadcast('horses', { type: 'completed' });
  }).catch(err => {
    broadcast('horses', { type: 'error', message: err.message });
  }).finally(() => {
    horseScraping = false;
  });
});

app.post('/api/scrape/coursetime', async (req, res) => {
  try {
    const rows = await scraper.scrapeCourseTime();
    const saved = await scraper.saveCourseTime(rows);
    res.json({ message: `跑道標準時間已更新，共 ${saved} 筆記錄` });
  } catch (err) {
    res.status(500).json({ message: '跑道標準時間更新失敗：' + err.message });
  }
});

// Scrape status
app.get('/api/scrape/status', (req, res) => {
  res.json({
    jockeys: jockeyScraping,
    trainers: trainerScraping,
    fixtures: fixturesScraping,
    horses: horseScraping,
    racecard: racecardScraping,
  });
});

// ── WindTracker ───────────────────────────────────────────────────────────────
app.get('/api/windtracker', async (req, res) => {
  try {
    const data = await scraper.scrapeWindTracker();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Draw (live scrape for specific race) ─────────────────────────────────────
app.get('/api/draw/live', async (req, res) => {
  const raceNo = parseInt(req.query.raceno, 10);
  if (!raceNo) return res.status(400).json({ error: 'raceno required' });
  try {
    const data = await scraper.scrapeDrawForRace(raceNo);
    res.json(data || { raceNo, drawData: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SpeedGuide ────────────────────────────────────────────────────────────────
app.get('/api/speedguide', async (req, res) => {
  const raceNo = parseInt(req.query.raceno, 10);
  if (!raceNo) return res.status(400).json({ error: 'raceno required' });
  try {
    const data = await scraper.scrapeSpeedGuide(raceNo);
    res.json(data || { raceNo, horses: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sectional Times ───────────────────────────────────────────────────────────
// GET /api/sectional?date=YYYY-MM-DD&raceno=N
// Returns stored sectional times from DB for all horses in a race.
// Also includes comparison delta vs course_times standard.
const pool = require('./db/pool');

app.get('/api/sectional', async (req, res) => {
  const { date, raceno } = req.query;
  if (!date || !raceno) return res.status(400).json({ error: 'date and raceno required' });
  const raceNo = parseInt(raceno, 10);
  try {
    // Fetch sectional times for this race
    const sectResult = await pool.query(
      `SELECT horse_no, horse_id, horse_name, finish_position, finish_time,
              seg1, seg2, seg3, seg4, seg5, seg6, cumulative_times, running_positions,
              race_class, distance, track_type, going, racecourse, race_date
       FROM race_sectional_times
       WHERE race_date = $1 AND race_no = $2
       ORDER BY finish_position`,
      [date, raceNo]
    );

    if (sectResult.rows.length === 0) {
      return res.json({ date, raceNo, horses: [], hasData: false });
    }

    const row0 = sectResult.rows[0];

    // Fetch standard (benchmark) times for matching race conditions
    const stdResult = await pool.query(
      `SELECT section, distance, race_class, standard_time,
              split_start_2000, split_2000_1600, split_1600_1200,
              split_1200_800, split_800_400, split_400_finish
       FROM course_times
       WHERE racecourse = $1 AND distance = $2`,
      [row0.racecourse, row0.distance]
    );

    // Build standard time lookup keyed by race_class (approximate match)
    const stdByClass = {};
    for (const s of stdResult.rows) {
      stdByClass[s.race_class] = s;
    }

    // Pick the best matching standard time row
    const std = stdByClass[row0.race_class] || stdResult.rows[0] || null;

    // Map standard splits to array (positions depend on distance)
    const stdSplits = std ? [
      std.split_start_2000, std.split_2000_1600, std.split_1600_1200,
      std.split_1200_800, std.split_800_400, std.split_400_finish,
    ].filter(v => v !== null && v !== '') : [];

    const horses = sectResult.rows.map(row => {
      const segs = [row.seg1, row.seg2, row.seg3, row.seg4, row.seg5, row.seg6];
      const deltas = segs.map((seg, idx) => {
        if (!seg || !stdSplits[idx]) return null;
        const segNum = parseFloat(seg);
        const stdNum = parseFloat(stdSplits[idx]);
        if (isNaN(segNum) || isNaN(stdNum)) return null;
        return (segNum - stdNum).toFixed(2);
      });
      return {
        horseNo: row.horse_no,
        horseId: row.horse_id,
        horseName: row.horse_name,
        finishPosition: row.finish_position,
        finishTime: row.finish_time,
        segments: segs,
        deltas,
        runningPositions: row.running_positions,
        cumulativeTimes: row.cumulative_times,
      };
    });

    res.json({
      date: row0.race_date,
      raceNo,
      racecourse: row0.racecourse,
      raceClass: row0.race_class,
      distance: row0.distance,
      trackType: row0.track_type,
      going: row0.going,
      standardSplits: stdSplits,
      standardTime: std ? std.standard_time : null,
      horses,
      hasData: true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sectional/day?date=YYYY-MM-DD
// Returns all races on a given date with each horse's sectional times + deltas vs standard.
// Also returns total race count + racecourse from racecard (or localresults as fallback).
app.get('/api/sectional/day', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  try {
    // Get authoritative race list from racecard
    const rcResult = await pool.query(
      `SELECT DISTINCT race_no, racecourse FROM racecard WHERE race_date = $1 ORDER BY race_no`,
      [date]
    );
    let allRaceNos = rcResult.rows.map(r => r.race_no);
    let racecourse = rcResult.rows.length > 0 ? rcResult.rows[0].racecourse : null;

    // Fallback: if racecard has no data, infer from race_sectional_times + localresults
    if (allRaceNos.length === 0) {
      const stResult = await pool.query(
        `SELECT DISTINCT race_no, racecourse FROM race_sectional_times WHERE race_date = $1 ORDER BY race_no`,
        [date]
      );
      if (stResult.rows.length > 0) {
        racecourse = stResult.rows[0].racecourse || 'ST';
        // Scrape total race count from localresults nav links
        const totalRaces = await scraper.scrapeRaceCountFromLocalResults(date, racecourse);
        if (totalRaces) {
          allRaceNos = Array.from({ length: totalRaces }, (_, i) => i + 1);
        } else {
          // Fallback to just what we have scraped
          allRaceNos = stResult.rows.map(r => r.race_no);
        }
      }
    }

    // Get scraped sectional times
    const result = await pool.query(
      `SELECT rst.*,
              ct.standard_time, ct.split_start_2000, ct.split_2000_1600,
              ct.split_1600_1200, ct.split_1200_800, ct.split_800_400, ct.split_400_finish
       FROM race_sectional_times rst
       LEFT JOIN course_times ct
         ON ct.racecourse = rst.racecourse
         AND ct.distance = rst.distance
         AND ct.race_class = rst.race_class
         AND ct.track_type = rst.track_type
       WHERE rst.race_date = $1
       ORDER BY rst.race_no ASC, rst.finish_position ASC`,
      [date]
    );

    // Group scraped data by race_no
    const raceMap = new Map();
    for (const row of result.rows) {
      const rno = row.race_no;
      if (!raceMap.has(rno)) {
        raceMap.set(rno, {
          raceNo: rno,
          racecourse: row.racecourse,
          raceClass: row.race_class,
          distance: row.distance,
          trackType: row.track_type,
          going: row.going,
          standardTime: row.standard_time,
          standardSplits: [
            row.split_start_2000, row.split_2000_1600, row.split_1600_1200,
            row.split_1200_800, row.split_800_400, row.split_400_finish
          ].filter(v => v !== null && v !== undefined && v !== ''),
          horses: [],
        });
      }
      const race = raceMap.get(rno);
      const segs = [row.seg1, row.seg2, row.seg3, row.seg4, row.seg5, row.seg6]
        .map(s => (s && s !== '' ? s : null));
      const nonNullSegs = segs.filter(Boolean);
      const stdSplits = race.standardSplits;
      const alignedStd = stdSplits.slice(-nonNullSegs.length);
      const deltas = segs.map((seg, i) => {
        if (!seg) return null;
        const stdIdx = i - (nonNullSegs.length - alignedStd.length);
        if (stdIdx < 0 || !alignedStd[stdIdx]) return null;
        const diff = parseFloat(seg) - parseFloat(alignedStd[stdIdx]);
        return isNaN(diff) ? null : parseFloat(diff.toFixed(2));
      });
      race.horses.push({
        finishPosition: row.finish_position,
        horseNo: row.horse_no,
        horseName: row.horse_name,
        finishTime: row.finish_time,
        segments: segs,
        deltas,
      });
    }

    const scrapedRaceNos = Array.from(raceMap.keys());
    const missingRaceNos = allRaceNos.filter(rno => !scrapedRaceNos.includes(rno));

    // Attach fastest splits from race_fastest_splits table
    const fsResult = await pool.query(
      `SELECT race_no, fastest_splits FROM race_fastest_splits WHERE race_date = $1`,
      [date]
    );
    const fsMap = new Map(fsResult.rows.map(r => [r.race_no, r.fastest_splits]));
    for (const race of raceMap.values()) {
      race.fastestSplits = fsMap.get(race.raceNo) || null;
    }

    res.json({
      date,
      racecourse,
      totalRaces: allRaceNos.length,
      allRaceNos,
      scrapedRaceNos,
      missingRaceNos,
      races: Array.from(raceMap.values()),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sectional/scrape-day  body: { date, racecourse, raceNos? }
// Scrapes sectional times for all (or specified) races on a given date.
// Uses SSE-style streaming via res.write to report progress.
app.post('/api/sectional/scrape-day', async (req, res) => {
  const { date, racecourse, raceNos } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });

  // Determine which races to scrape
  let targetRaceNos = raceNos;
  if (!targetRaceNos || targetRaceNos.length === 0) {
    // Try racecard first
    const rcResult = await pool.query(
      `SELECT DISTINCT race_no FROM racecard WHERE race_date = $1 ORDER BY race_no`,
      [date]
    );
    if (rcResult.rows.length > 0) {
      targetRaceNos = rcResult.rows.map(r => r.race_no);
    } else {
      // Fallback: scrape total race count from localresults
      const rc = racecourse || 'ST';
      const totalRaces = await scraper.scrapeRaceCountFromLocalResults(date, rc);
      if (totalRaces) {
        targetRaceNos = Array.from({ length: totalRaces }, (_, i) => i + 1);
      } else {
        return res.status(400).json({ error: '無法取得場次資料，請指定 raceNos' });
      }
    }
  }

  // Get already-scraped races to skip (for sectional times)
  const existResult = await pool.query(
    `SELECT DISTINCT race_no FROM race_sectional_times WHERE race_date = $1`,
    [date]
  );
  const alreadyScraped = new Set(existResult.rows.map(r => r.race_no));
  const toScrape = targetRaceNos.filter(rno => !alreadyScraped.has(rno));

  // Also identify races that have sectional data but are missing fastest splits
  const fsResult = await pool.query(
    `SELECT DISTINCT race_no FROM race_fastest_splits WHERE race_date = $1`,
    [date]
  );
  const hasFastestSplits = new Set(fsResult.rows.map(r => r.race_no));
  const needFastestSplits = Array.from(alreadyScraped).filter(rno => !hasFastestSplits.has(rno));

  const results = [];

  // Backfill fastest splits for already-scraped races missing them
  const rc = racecourse || 'ST';
  for (const raceNo of needFastestSplits) {
    try {
      await scraper.saveLocalResults(date, rc, raceNo);
      results.push({ raceNo, success: true, saved: 0, note: 'backfilled fastest splits' });
    } catch (e2) {
      console.warn(`backfill saveLocalResults race ${raceNo}: ${e2.message}`);
    }
  }
  for (const raceNo of toScrape) {
    try {
      const data = await scraper.scrapeSectionalTime(date, raceNo);
      if (data && data.error) {
        results.push({ raceNo, success: false, message: '分段時間未公佈' });
      } else {
        const saved = await scraper.saveSectionalTime(data);
        // Also scrape fastest splits from localresults page
        try {
          await scraper.saveLocalResults(date, rc, raceNo);
        } catch (e2) {
          console.warn(`saveLocalResults race ${raceNo}: ${e2.message}`);
        }
        results.push({ raceNo, success: true, saved });
      }
    } catch (e) {
      results.push({ raceNo, success: false, message: e.message });
    }
  }

  res.json({
    date,
    scraped: results.filter(r => r.success && !r.note).length,
    backfilled: results.filter(r => r.note === 'backfilled fastest splits').length,
    skipped: alreadyScraped.size - needFastestSplits.length,
    total: targetRaceNos.length,
    results,
  });
});

// POST /api/sectional/backfill-fastest-splits  body: { date, racecourse }
// Backfills fastest splits from localresults for all races that have sectional data but no fastest splits.
app.post('/api/sectional/backfill-fastest-splits', async (req, res) => {
  const { date, racecourse } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });
  const rc = racecourse || 'ST';
  try {
    const stResult = await pool.query(
      `SELECT DISTINCT race_no FROM race_sectional_times WHERE race_date = $1 ORDER BY race_no`,
      [date]
    );
    const fsResult = await pool.query(
      `SELECT DISTINCT race_no FROM race_fastest_splits WHERE race_date = $1`,
      [date]
    );
    const hasFastestSplits = new Set(fsResult.rows.map(r => r.race_no));
    const toBackfill = stResult.rows.map(r => r.race_no).filter(rno => !hasFastestSplits.has(rno));

    const results = [];
    for (const raceNo of toBackfill) {
      try {
        const splits = await scraper.saveLocalResults(date, rc, raceNo);
        results.push({ raceNo, success: true, splits });
      } catch (e) {
        results.push({ raceNo, success: false, message: e.message });
      }
    }
    res.json({ date, backfilled: results.filter(r => r.success).length, total: toBackfill.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sectional/horse?horseid=&limit=5
// Returns last N races' sectional times for a horse from race_sectional_times DB.
// horseid can be a full id like "HK_2024_K316" or a short horse code like "K316".
// Always matches by short code (last segment) to handle year-prefix mismatches between tables.
app.get('/api/sectional/horse', async (req, res) => {
  const { horseid, limit = 5 } = req.query;
  if (!horseid) return res.status(400).json({ error: 'horseid required' });
  // Extract short code: "HK_2024_K316" → "K316", "K316" → "K316"
  const shortCode = horseid.includes('_') ? horseid.split('_').pop() : horseid;
  try {
    const result = await pool.query(
      `SELECT rst.*, ct.standard_time, ct.split_start_2000, ct.split_2000_1600,
              ct.split_1600_1200, ct.split_1200_800, ct.split_800_400, ct.split_400_finish,
              rfs.fastest_splits
       FROM race_sectional_times rst
       LEFT JOIN course_times ct
         ON ct.racecourse = rst.racecourse
         AND ct.distance = rst.distance
         AND ct.race_class = rst.race_class
         AND ct.track_type = rst.track_type
       LEFT JOIN race_fastest_splits rfs
         ON rfs.race_date = rst.race_date
         AND rfs.racecourse = rst.racecourse
         AND rfs.race_no = rst.race_no
       WHERE rst.horse_id LIKE '%_' || $1
       ORDER BY rst.race_date DESC, rst.race_no DESC
       LIMIT $2`,
      [shortCode, parseInt(limit, 10)]
    );
    res.json({ horseid, races: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sectional/scrape  body: { date, raceno }
// Triggers live scrape of sectional times for a race and saves to DB
app.post('/api/sectional/scrape', async (req, res) => {
  const { date, raceno } = req.body;
  if (!date || !raceno) return res.status(400).json({ error: 'date and raceno required' });
  const raceNo = parseInt(raceno, 10);
  try {
    const data = await scraper.scrapeSectionalTime(date, raceNo);
    if (data && data.error) {
      return res.json({ success: false, message: '分段時間暫未公佈', raceNo });
    }
    const saved = await scraper.saveSectionalTime(data);
    res.json({ success: true, saved, raceNo, date });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sectional/scrape-horse  body: { horsename, limit }
// Looks up the horse's last N races from race_records and scrapes their sectional times.
app.post('/api/sectional/scrape-horse', async (req, res) => {
  const { horsename, limit = 5 } = req.body;
  if (!horsename) return res.status(400).json({ error: 'horsename required' });
  try {
    // Find last N races for this horse from race_records, computing the daily race number.
    // race_records.race_no is a sequential number across all races.
    // To get the daily race number (1, 2, 3...) we subtract the minimum race_no for that date+racecourse
    // across ALL horses, then add 1.
    const raceRows = await pool.query(
      `SELECT TO_CHAR(rr.race_date, 'YYYY-MM-DD') as race_date, rr.racecourse,
              (rr.race_no - mn.min_race_no + 1) AS daily_race_no
       FROM race_records rr
       JOIN (
         SELECT race_date, racecourse, MIN(race_no) AS min_race_no
         FROM race_records
         GROUP BY race_date, racecourse
       ) mn ON mn.race_date = rr.race_date AND mn.racecourse = rr.racecourse
       WHERE rr.horse_name = $1
       ORDER BY rr.race_date DESC, rr.race_no DESC
       LIMIT $2`,
      [horsename, parseInt(limit, 10)]
    );
    if (raceRows.rows.length === 0) {
      return res.json({ success: true, scraped: 0, message: '未找到往績記錄' });
    }
    let scraped = 0;
    const errors = [];
    for (const row of raceRows.rows) {
      const raceNo = parseInt(row.daily_race_no, 10);
      // Scrape sectional times (Puppeteer)
      try {
        const data = await scraper.scrapeSectionalTime(row.race_date, raceNo);
        if (data && !data.error) {
          await scraper.saveSectionalTime(data);
          scraped++;
        }
      } catch (e) {
        errors.push(`${row.race_date} R${raceNo} sectional: ${e.message}`);
      }
      // Scrape fastest splits (axios+cheerio, fast)
      try {
        await scraper.saveLocalResults(row.race_date, row.racecourse, raceNo);
      } catch (e) {
        errors.push(`${row.race_date} R${raceNo} fastest: ${e.message}`);
      }
    }
    res.json({ success: true, scraped, total: raceRows.rows.length, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/racecard/analysis?date=YYYY-MM-DD&raceno=N
// Returns jockey and trainer performance stats for all horses in a given race.
// Stats: last 30 days overall, this season same class, this season same distance.
app.get('/api/racecard/analysis', async (req, res) => {
  const { date, raceno } = req.query;
  if (!date || !raceno) return res.status(400).json({ error: 'date and raceno required' });
  const raceNo = parseInt(raceno, 10);

  try {
    // Get race info + participants from racecard
    const rcResult = await pool.query(
      `SELECT horse_no, horse_name, jockey_id, trainer_id, trainer_name,
              race_class, distance, track_type, racecourse
       FROM racecard
       WHERE race_date = $1 AND race_no = $2
       ORDER BY horse_no`,
      [date, raceNo]
    );
    if (rcResult.rows.length === 0) return res.json({ jockeys: [], trainers: [] });

    const row0 = rcResult.rows[0];
    const { race_class, distance, racecourse } = row0;

    // Map racecard Chinese class names to race_records numeric/code values
    const classMapping = {
      '第一班': ['1'],
      '第二班': ['2'],
      '第三班': ['3'],
      '第四班': ['4'],
      '第五班': ['5'],
      '新馬賽': ['GRIFFIN', '新馬賽'],
      '分級賽': ['G1', 'G2', 'G3'],
      '4歲馬賽': ['4YO', '4歲馬賽'],
      '限制賽': ['3R', '4R', '限制賽'],
    };
    const mappedClasses = classMapping[race_class] || [race_class];

    // Determine season start: Sep 1 of current season year
    const raceYear = new Date(date).getMonth() >= 8
      ? new Date(date).getFullYear()
      : new Date(date).getFullYear() - 1;
    const seasonStart = `${raceYear}-09-01`;

    // Date 30 days ago
    const thirtyDaysAgo = new Date(date);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().slice(0, 10);

    const jockeyIds = [...new Set(rcResult.rows.map(r => r.jockey_id).filter(Boolean))];
    const trainerIds = [...new Set(rcResult.rows.map(r => r.trainer_id).filter(Boolean))];

    // Helper to build stats query
    const statsQuery = (idField, ids, extraWhere = '') => {
      if (ids.length === 0) return Promise.resolve({ rows: [] });
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      return pool.query(
        `SELECT ${idField},
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE finish_position = 1) AS win,
                COUNT(*) FILTER (WHERE finish_position = 2) AS second,
                COUNT(*) FILTER (WHERE finish_position = 3) AS third,
                COUNT(*) FILTER (WHERE finish_position = 4) AS fourth
         FROM race_records
         WHERE ${idField} IN (${placeholders}) ${extraWhere}
         GROUP BY ${idField}`,
        ids
      );
    };

    // Jockey stats
    const classPlaceholders = mappedClasses.map((_, i) => `$${jockeyIds.length + i + 1}`).join(',');
    const [jMonthly, jClass, jDist] = await Promise.all([
      statsQuery('jockey_id', jockeyIds, `AND race_date >= '${thirtyDaysAgoStr}' AND race_date < '${date}'`),
      jockeyIds.length === 0 ? Promise.resolve({ rows: [] }) : pool.query(
        `SELECT jockey_id,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE finish_position = 1) AS win,
                COUNT(*) FILTER (WHERE finish_position = 2) AS second,
                COUNT(*) FILTER (WHERE finish_position = 3) AS third,
                COUNT(*) FILTER (WHERE finish_position = 4) AS fourth
         FROM race_records
         WHERE jockey_id IN (${jockeyIds.map((_, i) => `$${i + 1}`).join(',')})
           AND race_date >= '${seasonStart}' AND race_date < '${date}'
           AND race_class IN (${mappedClasses.map((_, i) => `$${jockeyIds.length + i + 1}`).join(',')})
         GROUP BY jockey_id`,
        [...jockeyIds, ...mappedClasses]
      ),
      statsQuery('jockey_id', jockeyIds, `AND race_date >= '${seasonStart}' AND race_date < '${date}' AND distance = ${distance}`),
    ]);

    // Trainer stats
    const [tMonthly, tClass, tDist] = await Promise.all([
      statsQuery('trainer_id', trainerIds, `AND race_date >= '${thirtyDaysAgoStr}' AND race_date < '${date}'`),
      trainerIds.length === 0 ? Promise.resolve({ rows: [] }) : pool.query(
        `SELECT trainer_id,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE finish_position = 1) AS win,
                COUNT(*) FILTER (WHERE finish_position = 2) AS second,
                COUNT(*) FILTER (WHERE finish_position = 3) AS third,
                COUNT(*) FILTER (WHERE finish_position = 4) AS fourth
         FROM race_records
         WHERE trainer_id IN (${trainerIds.map((_, i) => `$${i + 1}`).join(',')})
           AND race_date >= '${seasonStart}' AND race_date < '${date}'
           AND race_class IN (${mappedClasses.map((_, i) => `$${trainerIds.length + i + 1}`).join(',')})
         GROUP BY trainer_id`,
        [...trainerIds, ...mappedClasses]
      ),
      statsQuery('trainer_id', trainerIds, `AND race_date >= '${seasonStart}' AND race_date < '${date}' AND distance = ${distance}`),
    ]);

    // Index results by id
    const idx = (rows, idField) => Object.fromEntries(rows.map(r => [r[idField], r]));
    const jM = idx(jMonthly.rows, 'jockey_id');
    const jC = idx(jClass.rows, 'jockey_id');
    const jD = idx(jDist.rows, 'jockey_id');
    const tM = idx(tMonthly.rows, 'trainer_id');
    const tC = idx(tClass.rows, 'trainer_id');
    const tD = idx(tDist.rows, 'trainer_id');

    const fmt = (r) => r ? {
      total: parseInt(r.total), win: parseInt(r.win),
      second: parseInt(r.second), third: parseInt(r.third), fourth: parseInt(r.fourth)
    } : { total: 0, win: 0, second: 0, third: 0, fourth: 0 };

    // Build per-horse result
    const horses = rcResult.rows.map(r => ({
      horseNo: r.horse_no,
      horseName: r.horse_name,
      jockeyId: r.jockey_id,
      trainerId: r.trainer_id,
      trainerName: r.trainer_name,
      jockey: {
        monthly: fmt(jM[r.jockey_id]),
        sameClass: fmt(jC[r.jockey_id]),
        sameDist: fmt(jD[r.jockey_id]),
      },
      trainer: {
        monthly: fmt(tM[r.trainer_id]),
        sameClass: fmt(tC[r.trainer_id]),
        sameDist: fmt(tD[r.trainer_id]),
      },
    }));

    res.json({ raceClass: race_class, distance, racecourse, horses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Vet Record ────────────────────────────────────────────────────────────────
// GET /api/vetrecord?date=YYYY-MM-DD&racecourse=ST&raceno=N
app.get('/api/vetrecord', async (req, res) => {
  const { date, racecourse, raceno } = req.query;
  if (!date || !racecourse || !raceno) return res.status(400).json({ error: 'date, racecourse and raceno required' });
  try {
    const records = await scraper.scrapeVetRecord(date, racecourse, parseInt(raceno, 10));
    res.json({ date, racecourse, raceNo: parseInt(raceno, 10), records: records || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Trackwork ─────────────────────────────────────────────────────────────────
// GET /api/trackwork?date=YYYY-MM-DD&racecourse=ST&raceno=N
app.get('/api/trackwork', async (req, res) => {
  const { date, racecourse, raceno } = req.query;
  if (!date || !racecourse || !raceno) return res.status(400).json({ error: 'date, racecourse and raceno required' });
  try {
    const data = await scraper.scrapeTrackwork(date, racecourse, parseInt(raceno, 10));
    res.json({ date, racecourse, raceNo: parseInt(raceno, 10), ...(data || { declared: [], reserves: [] }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;

async function start() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`Backend running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
