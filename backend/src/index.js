const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { initDb } = require('./db/init');
const scraper = require('./scrapers/hkjc');
const { setupJobs } = require('./jobs/scheduler');

const app = express();
app.use(cors());
app.use(express.json());

// ── 帳號系統：登入唔使 token・其餘全部 /api/* 都要 ──
const auth = require('./auth');
auth.ensureUsers().catch(e => console.error('[auth] init fail:', e.message));
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: '請輸入用戶名同密碼' });
    const { rows } = await require('./db/pool').query(
      'SELECT id, username, password_hash, role FROM users WHERE username = $1', [username]);
    const u = rows[0];
    if (!u || !auth.verifyPassword(password, u.password_hash)) {
      return res.status(401).json({ error: '用戶名或密碼錯誤' });
    }
    const token = auth.signToken({ uid: u.id, username: u.username, role: u.role });
    res.json({ token, user: { username: u.username, role: u.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/auth/me', auth.authRequired, (req, res) => res.json({ user: req.user }));
app.use('/api', auth.authRequired);

// Routes
app.use('/api/jockeys', require('./routes/jockeys'));
app.use('/api/trainers', require('./routes/trainers'));
app.use('/api/draw', require('./routes/draw'));
app.use('/api/races', require('./routes/races'));
app.use('/api/races', require('./routes/pace'));
app.use('/api/horses', require('./routes/horses'));
app.use('/api/coursetime', require('./routes/coursetime'));
app.use('/api/ai', require('./ai/routes'));

// ── SSE helpers ──────────────────────────────────────────────────────────────
// Map of active SSE clients per job type
const sseClients = { jockeys: new Set(), trainers: new Set(), fixtures: new Set(), horses: new Set(), racecard: new Set() };
// Per-horse workout scrape SSE: horseId → Set<res>
const workoutSseClients = new Map();

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

// ── Horse past records ─────────────────────────────────────────────────────
// GET /api/horses/:id/records  — race_records for this horse (by name_zh)
app.get('/api/horses/:id/records', async (req, res) => {
  try {
    const { id } = req.params;
    const hRes = await pool.query('SELECT name_zh FROM horses WHERE id = $1', [id]);
    if (!hRes.rows.length) return res.status(404).json({ error: 'Horse not found' });
    const name = hRes.rows[0].name_zh;

    const result = await pool.query(
      `SELECT
         TO_CHAR(race_date,'YYYY-MM-DD') AS race_date,
         racecourse, race_no, race_class, track_type, distance, going,
         draw, finish_position, total_runners, jockey_id, trainer_name,
         gear, actual_weight, horse_weight, rating, win_odds,
         margin_to_winner, running_positions, finish_time
       FROM race_records
       WHERE horse_name = $1
       ORDER BY race_date DESC, race_no DESC`,
      [name]
    );
    res.json({ horse_name: name, records: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Horse workout data + analysis ─────────────────────────────────────────
// GET /api/horses/:id/workouts
// ── Helper: parse total time from gallop details ──────────────────────────────
// Details format: "31.8 27.3 (59.1) (田泰安)"  or  "30.0 24.5 23.0 (1.17.5) (潘頓)"
// Returns the first parenthesised segment that looks like a time, or null.
function parseGallopTime(details) {
  if (!details) return null;
  const m = details.match(/\(([\d.]+)\)/);
  return m ? m[1] : null;
}

// ── Helper: count absence streaks between two dates ───────────────────────────
// Returns the total number of calendar days that belong to a gap of >= 2 consecutive
// days with no workout entries, within the half-open interval (startDate, endDate].
function countAbsenceDays(startDateStr, endDateStr, workoutLogs) {
  if (!startDateStr) return null;
  const logDates = new Set(workoutLogs.map(w => w.log_date));
  const start = new Date(startDateStr);
  const end   = new Date(endDateStr);
  let absenceTotal = 0;
  let streak = 0;
  // iterate day by day from day after startDate up to endDate (inclusive)
  for (let d = new Date(start.getTime() + 86400000); d <= end; d = new Date(d.getTime() + 86400000)) {
    const ds = d.toISOString().slice(0, 10);
    if (!logDates.has(ds)) {
      streak++;
    } else {
      if (streak >= 2) absenceTotal += streak;
      streak = 0;
    }
  }
  if (streak >= 2) absenceTotal += streak;
  return absenceTotal;
}

// ── Horse workout analysis ────────────────────────────────────────────────────
// GET /api/horses/:id/workouts
// Uses horse_race_history (multi-season) as the race list and horse_workout_log
// for per-period workout stats.
app.get('/api/horses/:id/workouts', async (req, res) => {
  try {
    const { id } = req.params;
    const hRes = await pool.query('SELECT name_zh FROM horses WHERE id = $1', [id]);
    if (!hRes.rows.length) return res.status(404).json({ error: 'Horse not found' });
    const name = hRes.rows[0].name_zh;

    // All races from full career history (multi-season), oldest first
    const racesRes = await pool.query(
      `SELECT TO_CHAR(race_date,'YYYY-MM-DD') AS race_date,
              racecourse, finish_position
       FROM horse_race_history
       WHERE horse_id = $1
       ORDER BY race_date`,
      [id]
    );
    const races = racesRes.rows;

    // All workout log entries for this horse
    const logsRes = await pool.query(
      `SELECT TO_CHAR(log_date,'YYYY-MM-DD') AS log_date, workout_type, venue, details
       FROM horse_workout_log WHERE horse_id = $1
       ORDER BY log_date`,
      [id]
    );
    const logs = logsRes.rows;

    const hasData = races.length > 0 || logs.length > 0;
    if (!hasData) return res.json({ horse_name: name, has_data: false, races: [] });

    const result = races.map((race, i) => {
      const prevRace = i > 0 ? races[i - 1] : null;
      const prevDate = prevRace ? prevRace.race_date : null;
      const raceDate = race.race_date;

      // Workout entries strictly between prevDate (exclusive) and raceDate (inclusive)
      const period = logs.filter(w =>
        (!prevDate || w.log_date > prevDate) && w.log_date <= raceDate
      );

      const gallops = period.filter(w => w.workout_type === '快操');
      const times   = gallops.map(w => parseGallopTime(w.details)).filter(Boolean);
      const avgTime = times.length
        ? (times.map(t => parseFloat(t)).reduce((a, b) => a + b, 0) / times.length).toFixed(1)
        : null;

      const daysSince = prevDate
        ? Math.round((new Date(raceDate) - new Date(prevDate)) / 86400000)
        : null;

      return {
        race_date:           raceDate,
        racecourse:          race.racecourse,
        finish_position:     race.finish_position,
        days_since_prev:     daysSince,
        gallop_count:        gallops.length,
        avg_gallop_time:     avgTime,
        trotting_count:      period.filter(w => w.workout_type === '踱步').length,
        swimming_count:      period.filter(w => w.workout_type === '游水' || w.workout_type === '馬匹水中步行機').length,
        trial_count:         period.filter(w => w.workout_type === '試閘').length,
        gate_practice_count: period.filter(w => w.workout_type === '彈閘' || (w.details || '').includes('彈閘')).length,
        absence_days:        countAbsenceDays(prevDate, raceDate, period),
      };
    });

    res.json({ horse_name: name, has_data: hasData, races: result.reverse() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Horse workout scrape (trackworkresult + horse profile pages) ──────────────
// SSE progress stream
app.get('/api/horses/:id/workout-progress', (req, res) => {
  const { id } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  if (!workoutSseClients.has(id)) workoutSseClients.set(id, new Set());
  workoutSseClients.get(id).add(res);
  req.on('close', () => { workoutSseClients.get(id)?.delete(res); });
});

function broadcastWorkout(horseId, data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  workoutSseClients.get(horseId)?.forEach(r => { try { r.write(msg); } catch (_) {} });
}

const workoutScrapeActive = new Set();

// POST /api/horses/:id/scrape-workouts
// 1. Scrapes trackworkresult page → saves all workout types to horse_workout_log
// 2. Scrapes horse profile page   → saves full career race results to horse_race_history
app.post('/api/horses/:id/scrape-workouts', async (req, res) => {
  const { id } = req.params;
  if (workoutScrapeActive.has(id)) return res.status(409).json({ message: '晨操抓取進行中' });

  const hRes = await pool.query('SELECT name_zh FROM horses WHERE id = $1', [id]);
  if (!hRes.rows.length) return res.status(404).json({ error: 'Horse not found' });
  const horseName = hRes.rows[0].name_zh;

  res.json({ message: `開始抓取 ${horseName} 晨操及賽績資料` });
  workoutScrapeActive.add(id);

  (async () => {
    try {
      broadcastWorkout(id, { type: 'start', horse: horseName });

      // ── Phase 1: workout log ──────────────────────────────────────────────
      broadcastWorkout(id, { type: 'progress', message: '抓取晨操記錄...' });
      const workoutRows = await scraper.scrapeHorseTrackworkHistory(id);
      let wSaved = 0;
      for (const row of workoutRows) {
        if (row.type === '出賽') continue;
        try {
          await pool.query(
            `INSERT INTO horse_workout_log (horse_id, horse_name, log_date, workout_type, venue, details)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (horse_id, log_date, workout_type, venue) DO UPDATE SET
               details=$6, scraped_at=NOW()`,
            [id, horseName, row.date, row.type, row.venue || '', row.details || '']
          );
          wSaved++;
        } catch (e) {
          console.error(`[scrape-workouts] workout ${row.date} ${row.type}:`, e.message);
        }
      }
      console.log(`[scrape-workouts] ${horseName}: workouts ${wSaved}/${workoutRows.length}`);

      // ── Phase 2: career race history ──────────────────────────────────────
      broadcastWorkout(id, { type: 'progress', message: '抓取歷史賽績...' });
      const raceRows = await scraper.scrapeHorseRaceHistory(id);
      let rSaved = 0;
      for (const row of raceRows) {
        try {
          await pool.query(
            `INSERT INTO horse_race_history
               (horse_id, horse_name, race_date, racecourse, finish_position,
                distance, going, race_class, draw, jockey, odds, weight, gear)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             ON CONFLICT (horse_id, race_date) DO UPDATE SET
               racecourse=$4, finish_position=$5, distance=$6, going=$7,
               race_class=$8, draw=$9, jockey=$10, odds=$11, weight=$12,
               gear=$13, scraped_at=NOW()`,
            [
              id, horseName, row.race_date, row.racecourse, row.finish_position,
              row.distance, row.going, row.race_class, row.draw,
              row.jockey, row.odds, row.weight, row.gear,
            ]
          );
          rSaved++;
        } catch (e) {
          console.error(`[scrape-workouts] race ${row.race_date}:`, e.message);
        }
      }
      console.log(`[scrape-workouts] ${horseName}: races ${rSaved}/${raceRows.length}`);

      broadcastWorkout(id, { type: 'completed', workouts: wSaved, races: rSaved });
    } catch (err) {
      broadcastWorkout(id, { type: 'error', message: err.message });
    } finally {
      workoutScrapeActive.delete(id);
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
    // First get the horse_name from race_sectional_times to use for joining race_records (which lacks horse_id)
    const nameRow = await pool.query(
      `SELECT horse_name FROM race_sectional_times WHERE horse_id LIKE '%_' || $1 LIMIT 1`,
      [shortCode]
    );
    const horseName = nameRow.rows.length > 0 ? nameRow.rows[0].horse_name : null;

    const result = await pool.query(
      `SELECT rst.*, ct.standard_time, ct.split_start_2000, ct.split_2000_1600,
              ct.split_1600_1200, ct.split_1200_800, ct.split_800_400, ct.split_400_finish,
              rfs.fastest_splits,
              rr.race_no AS career_race_no,
              rr.rating AS race_rating
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
       LEFT JOIN (
         SELECT rr2.race_date, rr2.racecourse, rr2.race_no, rr2.rating,
                (rr2.race_no - mn.min_race_no + 1) AS daily_race_no
         FROM race_records rr2
         JOIN (
           SELECT race_date, racecourse, MIN(race_no) AS min_race_no
           FROM race_records
           GROUP BY race_date, racecourse
         ) mn ON mn.race_date = rr2.race_date AND mn.racecourse = rr2.racecourse
         WHERE rr2.horse_name = $3
       ) rr
         ON rr.race_date = rst.race_date
         AND rr.racecourse = rst.racecourse
         AND rr.daily_race_no = rst.race_no
       WHERE rst.horse_id LIKE '%_' || $1
       ORDER BY rst.race_date DESC, rst.race_no DESC
       LIMIT $2`,
      [shortCode, parseInt(limit, 10), horseName]
    );
    // Also fetch season-start rating: first race of current season (season starts ~Sep 1)
    const now = new Date();
    const seasonYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
    const seasonStart = `${seasonYear}-09-01`;
    const seasonRow = await pool.query(
      `SELECT rating FROM race_records
       WHERE horse_name = $1 AND race_date >= $2
       ORDER BY race_date ASC, race_no ASC LIMIT 1`,
      [horseName, seasonStart]
    );
    const seasonStartRating = seasonRow.rows.length > 0 ? seasonRow.rows[0].rating : null;
    res.json({ horseid, races: result.rows, seasonStartRating });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sectional/horse-venue-stats?horseid=&racecourse=&distance=&tracktype=
// Returns all-time stats for a horse at a specific venue+distance combination.
app.get('/api/sectional/horse-venue-stats', async (req, res) => {
  const { horseid, racecourse, distance, tracktype } = req.query;
  if (!horseid) return res.status(400).json({ error: 'horseid required' });
  const shortCode = horseid.includes('_') ? horseid.split('_').pop() : horseid;
  try {
    const conditions = [`horse_id LIKE '%_' || $1`];
    const params = [shortCode];
    if (racecourse) { params.push(racecourse); conditions.push(`racecourse = $${params.length}`); }
    if (distance)   { params.push(parseInt(distance, 10)); conditions.push(`distance = $${params.length}`); }
    if (tracktype)  { params.push(tracktype); conditions.push(`track_type = $${params.length}`); }
    const result = await pool.query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN finish_position = 1 THEN 1 ELSE 0 END) AS win,
         SUM(CASE WHEN finish_position = 2 THEN 1 ELSE 0 END) AS second,
         SUM(CASE WHEN finish_position = 3 THEN 1 ELSE 0 END) AS third,
         SUM(CASE WHEN finish_position <= 3 THEN 1 ELSE 0 END) AS top3,
         MIN(race_date) AS first_race,
         MAX(race_date) AS last_race
       FROM race_records
       WHERE ${conditions.join(' AND ')}`,
      params
    );
    res.json(result.rows[0]);
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

// ── AI Data ───────────────────────────────────────────────────────────────────

// Scrape live gear data from HKJC racecard page for a single race.
// Returns Map<horseName, gearStr> or null on failure.
const _gearScrapeCache = new Map();
async function scrapeRaceGear(date, racecourse, raceNo) {
  const key = `${date}/${racecourse}/${raceNo}`;
  if (_gearScrapeCache.has(key)) return _gearScrapeCache.get(key);

  const dateStr = date.replace(/-/g, '/');
  const url = `https://racing.hkjc.com/zh-hk/local/information/racecard?racedate=${dateStr}&Racecourse=${racecourse}&RaceNo=${raceNo}`;
  try {
    const resp = await axios.get(url, {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'zh-HK,zh;q=0.9',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    const $ = cheerio.load(resp.data);
    const gearMap = {};

    // Find the main horse table: most rows with >= 20 cells
    let mainTable = null, maxRows = 0;
    $('table').each((_, t) => {
      const cnt = $(t).find('tr').filter((_, r) => $(r).find('td').length >= 20).length;
      if (cnt > maxRows) { maxRows = cnt; mainTable = t; }
    });

    if (mainTable) {
      $(mainTable).find('tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length < 23) return;
        const horseNo = parseInt(cells.eq(0).text().trim());
        if (!horseNo || horseNo > 30) return;
        const horseName = cells.eq(3).text().trim();
        const gear = cells.eq(22).text().trim();
        if (horseName) gearMap[horseName] = gear;
      });
    }

    // Cache for 15 minutes
    _gearScrapeCache.set(key, gearMap);
    setTimeout(() => _gearScrapeCache.delete(key), 15 * 60 * 1000);
    return gearMap;
  } catch (e) {
    console.warn(`[scrapeRaceGear] ${key} failed: ${e.message}`);
    return null; // caller falls back to DB
  }
}

// GET /api/ai/gear-changes?date=YYYY-MM-DD
// Returns all horses on that race date with their current gear vs previous race gear.
app.get('/api/ai/gear-changes', async (req, res) => {
  try {
    let { date } = req.query;
    if (!date) {
      const today = new Date().toISOString().slice(0, 10);
      const next = await pool.query(
        `SELECT TO_CHAR(race_date, 'YYYY-MM-DD') AS race_date
         FROM fixtures WHERE race_date >= $1 ORDER BY race_date ASC LIMIT 1`,
        [today]
      );
      date = next.rows.length > 0 ? next.rows[0].race_date : today;
    }

    // ── 1. Query DB for racecard + previous gear ─────────────────────────────
    const result = await pool.query(
      `SELECT
         rc.race_no,
         rc.horse_no,
         rc.horse_name,
         rc.trainer_id,
         rc.trainer_name,
         rc.racecourse      AS racecourse,
         rc.gear            AS db_gear,
         prev.gear          AS prev_gear,
         TO_CHAR(prev.race_date, 'YYYY-MM-DD') AS prev_race_date,
         prev.racecourse    AS prev_racecourse
       FROM racecard rc
       LEFT JOIN LATERAL (
         SELECT gear, race_date, racecourse
         FROM race_records
         WHERE horse_name = rc.horse_name
           AND race_date < rc.race_date
         ORDER BY race_date DESC
         LIMIT 1
       ) prev ON true
       WHERE rc.race_date = $1
       ORDER BY rc.race_no, rc.horse_no`,
      [date]
    );

    // ── 2. Scrape live gear from HKJC website (parallel, one req per race) ───
    const raceKeys = [...new Set(result.rows.map(r => `${r.racecourse}:${r.race_no}`))];
    const scrapedGear = {}; // horse_name → gear string from website
    await Promise.allSettled(
      raceKeys.map(async (rk) => {
        const [rcourse, rno] = rk.split(':');
        const gearMap = await scrapeRaceGear(date, rcourse, parseInt(rno));
        if (gearMap) Object.assign(scrapedGear, gearMap);
      })
    );

    // ── 3. Parse helpers ──────────────────────────────────────────────────────
    // current_gear (HKJC notation): strip removed ('-' suffix) and '1'/'2' suffix
    const parseCurrentGearWorn = (g) => {
      if (!g) return [];
      return g.split(/[/,\s]+/)
        .map(s => s.trim().toUpperCase()).filter(Boolean)
        .filter(t => !t.endsWith('-'))           // exclude removed items
        .map(t => t.replace(/[12]$/, ''))        // strip first/second-time suffix
        .filter(Boolean).sort();
    };
    // prev_gear (race_records): may have HKJC notation stored from previous racecard
    // normalise same way: strip suffixes, exclude removed
    const parsePlainGear = (g) => {
      if (!g) return [];
      return g.split(/[/,\s]+/)
        .map(s => s.trim().toUpperCase()).filter(Boolean)
        .filter(t => !t.endsWith('-'))           // exclude explicitly removed gear
        .map(t => t.replace(/[12]$/, ''))        // strip first/second-time suffix
        .filter(Boolean).sort();
    };

    // ── 4. Build response ─────────────────────────────────────────────────────
    const horses = result.rows.map(r => {
      // Prefer live-scraped gear; fall back to DB value
      const currentGear = (scrapedGear[r.horse_name] !== undefined)
        ? scrapedGear[r.horse_name]
        : (r.db_gear || '');

      const currWorn = parseCurrentGearWorn(currentGear);
      const prevWorn = parsePlainGear(r.prev_gear || '');
      const changed  = JSON.stringify(currWorn) !== JSON.stringify(prevWorn);
      return {
        race_no:         r.race_no,
        horse_no:        r.horse_no,
        horse_name:      r.horse_name,
        trainer_id:      r.trainer_id || '',
        trainer_name:    r.trainer_name || '',
        current_gear:    currentGear,
        prev_gear:       r.prev_gear || '',
        prev_race_date:  r.prev_race_date || null,
        prev_racecourse: r.prev_racecourse || null,
        changed,
      };
    });
    res.json({ date, horses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ai/jockey-changes?date=YYYY-MM-DD
// Returns all horses on that racecard date where the assigned jockey differs from
// their most recent race_records jockey.  Includes per-horse stats with each jockey.
app.get('/api/ai/jockey-changes', async (req, res) => {
  try {
    let { date } = req.query;
    if (!date) {
      const next = await pool.query(
        `SELECT TO_CHAR(race_date,'YYYY-MM-DD') AS race_date
         FROM fixtures WHERE race_date >= $1 ORDER BY race_date ASC LIMIT 1`,
        [new Date().toISOString().slice(0, 10)]
      );
      date = next.rows.length > 0 ? next.rows[0].race_date : new Date().toISOString().slice(0, 10);
    }

    // ── 1. Get racecard + last-race jockey via LATERAL JOIN ──────────────────
    const rcResult = await pool.query(
      `SELECT
         rc.race_no, rc.horse_no, rc.horse_name, rc.draw,
         rc.trainer_id, rc.trainer_name,
         rc.jockey_id   AS new_jockey_id,
         rc.jockey_name AS new_jockey_name_raw,
         prev.jockey_id AS prev_jockey_id,
         TO_CHAR(prev.race_date,'YYYY-MM-DD') AS prev_race_date,
         prev.racecourse AS prev_racecourse
       FROM racecard rc
       LEFT JOIN LATERAL (
         SELECT jockey_id, race_date, racecourse
         FROM race_records
         WHERE horse_name = rc.horse_name
           AND race_date < rc.race_date
         ORDER BY race_date DESC
         LIMIT 1
       ) prev ON true
       WHERE rc.race_date = $1
       ORDER BY rc.race_no, rc.horse_no`,
      [date]
    );

    if (rcResult.rows.length === 0) {
      return res.json({ date, horses: [] });
    }

    // ── 2. Resolve all jockey IDs → display names ────────────────────────────
    const allJockeyIds = [...new Set(
      rcResult.rows.flatMap(r => [r.new_jockey_id, r.prev_jockey_id].filter(Boolean))
    )];
    const jMap = {};
    if (allJockeyIds.length) {
      const jr = await pool.query(
        'SELECT id, name_zh, name_en FROM jockeys WHERE id = ANY($1)', [allJockeyIds]
      );
      for (const j of jr.rows) jMap[j.id] = j.name_zh || j.name_en || j.id;
    }

    // ── 3. Compute per-horse stats for changed horses ────────────────────────
    // Batch: fetch all race_records for horses that changed jockey
    const changedHorses = rcResult.rows.filter(
      r => r.new_jockey_id && r.prev_jockey_id && r.new_jockey_id !== r.prev_jockey_id
    );
    const changedNames = [...new Set(changedHorses.map(r => r.horse_name))];

    const statsMap = {}; // horse_name → { jockey_id → [rows] }
    if (changedNames.length > 0) {
      const sRes = await pool.query(
        `SELECT horse_name, jockey_id, finish_position
         FROM race_records WHERE horse_name = ANY($1)`,
        [changedNames]
      );
      for (const r of sRes.rows) {
        if (!statsMap[r.horse_name]) statsMap[r.horse_name] = {};
        const k = r.jockey_id || '?';
        if (!statsMap[r.horse_name][k]) statsMap[r.horse_name][k] = [];
        statsMap[r.horse_name][k].push(r);
      }
    }

    function calcStats(rows) {
      const total  = rows.length;
      const wins   = rows.filter(r => r.finish_position === 1).length;
      const places = rows.filter(r => r.finish_position <= 3).length;
      return { total, wins, places, win_rate: fmtRate(wins, total), place_rate: fmtRate(places, total) };
    }

    // ── 4. Build final horse list ─────────────────────────────────────────────
    const horses = rcResult.rows.map(r => {
      const changed = !!(r.new_jockey_id && r.prev_jockey_id && r.new_jockey_id !== r.prev_jockey_id);

      // Strip weight claim from raw jockey name (e.g. "周俊樂 (-2)" → "周俊樂")
      const newJockeyName = jMap[r.new_jockey_id] || (r.new_jockey_name_raw || '').replace(/\s*\(.*\)$/, '').trim();
      const prevJockeyName = r.prev_jockey_id ? (jMap[r.prev_jockey_id] || r.prev_jockey_id) : null;

      let stats_new = null, stats_prev = null, stats_overall = null;
      if (changed) {
        const horseRecs = statsMap[r.horse_name] || {};
        const allRows = Object.values(horseRecs).flat();
        stats_new     = calcStats(horseRecs[r.new_jockey_id]  || []);
        stats_prev    = calcStats(horseRecs[r.prev_jockey_id] || []);
        stats_overall = calcStats(allRows);
      }

      return {
        race_no:          r.race_no,
        horse_no:         r.horse_no,
        horse_name:       r.horse_name,
        draw:             r.draw,
        trainer_id:       r.trainer_id || '',
        trainer_name:     r.trainer_name || '',
        new_jockey_id:    r.new_jockey_id || '',
        new_jockey_name:  newJockeyName,
        prev_jockey_id:   r.prev_jockey_id || null,
        prev_jockey_name: prevJockeyName,
        prev_race_date:   r.prev_race_date || null,
        prev_racecourse:  r.prev_racecourse ? (COURSE_MAP[r.prev_racecourse] || r.prev_racecourse) : null,
        changed,
        stats_new,
        stats_prev,
        stats_overall,
      };
    });

    res.json({ date, horses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ai/stats-jockey-handoff?from_id=AA&to_id=PZ
// Returns cross-horse stats for all races where jockey `to_id` took over from `from_id`.
app.get('/api/ai/stats-jockey-handoff', async (req, res) => {
  try {
    const { from_id, to_id } = req.query;
    if (!from_id || !to_id) return res.status(400).json({ error: 'from_id and to_id required' });

    // 1. Resolve jockey display names
    const jRes = await pool.query(
      'SELECT id, name_zh, name_en FROM jockeys WHERE id = ANY($1)',
      [[from_id, to_id]]
    );
    const jMap = {};
    for (const j of jRes.rows) jMap[j.id] = j.name_zh || j.name_en || j.id;

    // 2. CTE: for each horse find the previous jockey via LAG, then filter
    const result = await pool.query(
      `WITH ordered AS (
         SELECT
           horse_name, trainer_name, race_date, race_no, racecourse, finish_position, win_odds, jockey_id,
           LAG(jockey_id) OVER (PARTITION BY horse_name ORDER BY race_date, race_no) AS prev_jockey_id
         FROM race_records
       )
       SELECT
         horse_name, trainer_name,
         TO_CHAR(race_date, 'YYYY-MM-DD') AS race_date,
         race_no, racecourse, finish_position, win_odds
       FROM ordered
       WHERE jockey_id = $1 AND prev_jockey_id = $2
       ORDER BY race_date DESC, race_no`,
      [to_id, from_id]
    );

    const rows = result.rows;
    const total  = rows.length;
    const wins   = rows.filter(r => r.finish_position === 1).length;
    const places = rows.filter(r => r.finish_position <= 3).length;
    const horseSet = [...new Set(rows.map(r => r.horse_name))];

    // 3. Recent 10 records with racecourse mapped to Chinese
    const recent = rows.slice(0, 10).map(r => ({
      horse_name:       r.horse_name,
      trainer_name:     r.trainer_name || '—',
      race_date:        r.race_date,
      race_no:          r.race_no,
      racecourse:       COURSE_MAP[r.racecourse] || r.racecourse || '—',
      finish_position:  r.finish_position,
      win_odds:         r.win_odds != null ? parseFloat(r.win_odds) : null,
    }));

    res.json({
      from_id,
      from_name:   jMap[from_id]  || from_id,
      to_id,
      to_name:     jMap[to_id]    || to_id,
      total,
      wins,
      places,
      win_rate:    fmtRate(wins,   total),
      place_rate:  fmtRate(places, total),
      horse_count: horseSet.length,
      recent,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ai/stats-quick-back?gap_min=7&gap_max=10
// Per-trainer stats for horses that ran back within gap_min–gap_max days.
app.get('/api/ai/stats-quick-back', async (req, res) => {
  try {
    const gapMin = Math.max(1, parseInt(req.query.gap_min) || 7);
    const gapMax = Math.min(30, parseInt(req.query.gap_max) || 10);

    const result = await pool.query(
      `WITH ordered AS (
         SELECT
           horse_name, trainer_name, race_date, race_no, racecourse,
           distance, race_class, going, draw, jockey_id,
           finish_position, win_odds,
           LAG(race_date) OVER (PARTITION BY horse_name ORDER BY race_date, race_no) AS prev_date,
           LAG(finish_position) OVER (PARTITION BY horse_name ORDER BY race_date, race_no) AS prev_finish
         FROM race_records
         WHERE trainer_name IS NOT NULL AND trainer_name <> ''
       ),
       qb AS (
         SELECT *, (race_date - prev_date) AS days_gap
         FROM ordered
         WHERE prev_date IS NOT NULL
           AND (race_date - prev_date) BETWEEN $1 AND $2
       )
       SELECT
         trainer_name,
         COUNT(*)                                           AS quick_backs,
         COUNT(*) FILTER (WHERE finish_position = 1)       AS wins,
         COUNT(*) FILTER (WHERE finish_position <= 3)      AS places,
         ROUND(AVG(days_gap), 1)                           AS avg_days,
         json_agg(
           json_build_object(
             'horse_name',      horse_name,
             'race_date',       TO_CHAR(race_date, 'YYYY-MM-DD'),
             'racecourse',      racecourse,
             'distance',        distance,
             'race_class',      race_class,
             'draw',            draw,
             'jockey_id',       jockey_id,
             'finish_position', finish_position,
             'win_odds',        win_odds,
             'days_gap',        days_gap,
             'prev_finish',     prev_finish
           ) ORDER BY race_date DESC
         ) AS records
       FROM qb
       GROUP BY trainer_name
       ORDER BY quick_backs DESC`,
      [gapMin, gapMax]
    );

    const trainers = result.rows.map(r => ({
      trainer_name: r.trainer_name,
      quick_backs:  parseInt(r.quick_backs),
      wins:         parseInt(r.wins),
      places:       parseInt(r.places),
      win_rate:     fmtRate(parseInt(r.wins),   parseInt(r.quick_backs)),
      place_rate:   fmtRate(parseInt(r.places), parseInt(r.quick_backs)),
      avg_days:     parseFloat(r.avg_days),
      records:      r.records || [],
    }));

    const total = trainers.reduce((s, t) => s + t.quick_backs, 0);
    res.json({ gap_min: gapMin, gap_max: gapMax, total_quick_backs: total, trainers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Each individual gear code change is counted independently.
// Returns an array of stats, one per added/removed code.
app.get('/api/ai/gear-change-trainer-stats', async (req, res) => {
  try {
    const { trainer_name, current_gear = '', prev_gear = '' } = req.query;
    if (!trainer_name) return res.status(400).json({ error: 'trainer_name required' });

    // Gear parser — maps base code → full token for worn/removed
    // "B-/CP1/TT2" → wornMap: {CP:'CP1', TT:'TT2'}, removedMap: {B:'B'}
    // Change detection: compare base codes (XB1→XB = no change)
    // Labelling: use full tokens (B2, CP1, H1) for precise tracking
    const parseGearV2 = (g) => {
      if (!g) return { wornMap: {}, removedMap: {} };
      const wornMap = {}, removedMap = {};
      for (const token of g.split(/[/,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean)) {
        const isRemoved = token.endsWith('-');
        const clean = isRemoved ? token.slice(0, -1) : token;
        const m = clean.match(/^([A-Z]+)/);
        const base = m ? m[1] : clean;
        if (isRemoved) removedMap[base] = clean;
        else wornMap[base] = clean;
      }
      return { wornMap, removedMap };
    };

    const currG = parseGearV2(current_gear);
    const prevG = parseGearV2(prev_gear);
    // Detect changes by base code
    // Added: label with full token (B2, CP1, H1) — specific config matters
    // Removed: label with base code only (V, CP, TT) — config irrelevant once removed
    const added   = Object.keys(currG.wornMap)
      .filter(b => !(b in prevG.wornMap))
      .map(b => currG.wornMap[b]);
    const removed = Object.keys(prevG.wornMap)
      .filter(b => !(b in currG.wornMap));

    // Nothing changed — return empty
    if (!added.length && !removed.length) {
      return res.json({ trainer_name, cutoff: null, stats: [] });
    }

    // Last 3 seasons (2023-24 season starts ~Sep 2023)
    const cutoff = '2023-07-01';

    // Fetch all races for this trainer in the window
    const result = await pool.query(
      `SELECT
         TO_CHAR(race_date, 'YYYY-MM-DD') AS race_date,
         racecourse, race_no, race_class,
         horse_name, finish_position, total_runners, gear
       FROM race_records
       WHERE trainer_name = $1
         AND race_date >= $2
       ORDER BY horse_name, race_date ASC`,
      [trainer_name, cutoff]
    );

    // Group by horse
    const byHorse = {};
    for (const row of result.rows) {
      if (!byHorse[row.horse_name]) byHorse[row.horse_name] = [];
      byHorse[row.horse_name].push(row);
    }

    // Initialise per-code bucket
    // key: "+XB" or "-XB"
    const buckets = {};
    for (const code of added)   buckets[`+${code}`] = { label: `+${code}`, type: 'added',   code, matches: [] };
    for (const code of removed) buckets[`-${code}`] = { label: `-${code}`, type: 'removed', code, matches: [] };

    // Scan all consecutive race pairs
    for (const races of Object.values(byHorse)) {
      for (let i = 1; i < races.length; i++) {
        const curr = races[i];
        const prev = races[i - 1];
        const rCurr = parseGearV2(curr.gear);
        const rPrev = parseGearV2(prev.gear);
        const rAdded   = Object.keys(rCurr.wornMap)
          .filter(b => !(b in rPrev.wornMap))
          .map(b => rCurr.wornMap[b]);
        const rRemoved = Object.keys(rPrev.wornMap)
          .filter(b => !(b in rCurr.wornMap));

        const record = {
          race_date:       curr.race_date,
          racecourse:      curr.racecourse,
          race_no:         curr.race_no,
          race_class:      curr.race_class,
          horse_name:      curr.horse_name,
          finish_position: curr.finish_position,
          total_runners:   curr.total_runners,
          prev_gear:       prev.gear || '',
          curr_gear:       curr.gear || '',
        };

        // Each target code checked independently
        for (const code of added) {
          if (rAdded.includes(code)) buckets[`+${code}`].matches.push(record);
        }
        for (const code of removed) {
          if (rRemoved.includes(code)) buckets[`-${code}`].matches.push(record);
        }
      }
    }

    // Build stats array (removed first, then added — mirrors typical display order)
    const orderedKeys = [
      ...removed.map(c => `-${c}`),
      ...added.map(c => `+${c}`),
    ];

    const stats = orderedKeys.map(key => {
      const b = buckets[key];
      b.matches.sort((a, z) => new Date(z.race_date) - new Date(a.race_date));
      const total  = b.matches.length;
      const wins   = b.matches.filter(m => m.finish_position === 1).length;
      const places = b.matches.filter(m => m.finish_position <= 3).length;
      return {
        label:      b.label,
        type:       b.type,
        code:       b.code,
        total,
        wins,
        places,
        win_rate:   total > 0 ? ((wins   / total) * 100).toFixed(1) + '%' : 'N/A',
        place_rate: total > 0 ? ((places / total) * 100).toFixed(1) + '%' : 'N/A',
        records:    b.matches.slice(0, 30),
      };
    });

    res.json({ trainer_name, cutoff, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stats Search ──────────────────────────────────────────────────────────────
// GET /api/ai/stats-search?q=
// Search horses, trainers, jockeys by name (Chinese or English, partial match).
// Returns up to 20 candidates: [{ type, id, name_zh, name_en }]
app.get('/api/ai/stats-search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !q.trim()) return res.status(400).json({ error: 'q required' });
    const like = `%${q.trim()}%`;
    const result = await pool.query(
      `(SELECT 'horse'   AS type, id, name_zh, name_en FROM horses   WHERE name_zh ILIKE $1 OR name_en ILIKE $1)
       UNION ALL
       (SELECT 'trainer' AS type, id, name_zh, name_en FROM trainers WHERE name_zh ILIKE $1 OR name_en ILIKE $1)
       UNION ALL
       (SELECT 'jockey'  AS type, id, name_zh, name_en FROM jockeys  WHERE name_zh ILIKE $1 OR name_en ILIKE $1)
       LIMIT 20`,
      [like]
    );
    res.json({ candidates: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ai/stats-detail?type=horse|trainer|jockey&id=&name=
//   Optional filters: gear_code=B, venue=ST|HV, distance=1200
// Returns full statistics: overall, by gear code, by racecourse+distance, recent records.
// For horses, match by horse_name (horse_id may be empty in race_records).
app.get('/api/ai/stats-detail', async (req, res) => {
  try {
    const { type, id, name, gear_code, venue, distance } = req.query;
    if (!type || (!id && !name)) return res.status(400).json({ error: 'type and id (or name) required' });

    // Build WHERE clause for race_records
    const conditions = [];
    const params = [];
    let pi = 1;

    if (type === 'horse') {
      conditions.push(`horse_name = $${pi++}`); params.push(name);
    } else if (type === 'trainer') {
      conditions.push(`trainer_id = $${pi++}`); params.push(id);
    } else if (type === 'jockey') {
      conditions.push(`jockey_id = $${pi++}`); params.push(id);
    } else {
      return res.status(400).json({ error: 'type must be horse, trainer, or jockey' });
    }

    if (venue) { conditions.push(`racecourse = $${pi++}`); params.push(venue); }
    if (distance) { conditions.push(`distance = $${pi++}`); params.push(parseInt(distance)); }

    // Fetch all matching race records (no limit — for aggregation)
    const allRows = await pool.query(
      `SELECT TO_CHAR(race_date, 'YYYY-MM-DD') AS race_date,
              racecourse, race_no, race_class, distance, going, track_type,
              horse_name, trainer_name, jockey_id,
              gear, finish_position, total_runners, actual_weight, draw
       FROM race_records
       WHERE ${conditions.join(' AND ')}
       ORDER BY race_date DESC`,
      params
    );

    // Apply gear_code filter in JS (gear field may contain multiple codes)
    const GEAR_CODE_NORM = gear_code ? gear_code.trim().toUpperCase() : null;
    let rows = allRows.rows;
    if (GEAR_CODE_NORM) {
      rows = rows.filter(r => {
        if (!r.gear) return false;
        return r.gear.split(/[/,\s]+/).map(s => s.trim().toUpperCase().replace(/-$/, '')).includes(GEAR_CODE_NORM);
      });
    }

    if (rows.length === 0) {
      return res.json({ type, filters: { gear_code, venue, distance }, overall: null, by_gear: [], by_venue: [], records: [] });
    }

    const COURSE = { ST: '沙田', HV: '跑馬地' };

    // ── Overall stats ─────────────────────────────────────────────────────────
    const total  = rows.length;
    const wins   = rows.filter(r => r.finish_position === 1).length;
    const places = rows.filter(r => r.finish_position <= 3).length;
    const overall = {
      total, wins, places,
      win_rate:   ((wins   / total) * 100).toFixed(1) + '%',
      place_rate: ((places / total) * 100).toFixed(1) + '%',
    };

    // ── By individual gear code ───────────────────────────────────────────────
    const codeMap = {};
    for (const r of rows) {
      if (!r.gear) continue;
      const codes = r.gear.split(/[/,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
      for (const code of codes) {
        if (!codeMap[code]) codeMap[code] = { total: 0, wins: 0, places: 0 };
        codeMap[code].total++;
        if (r.finish_position === 1) codeMap[code].wins++;
        if (r.finish_position <= 3)  codeMap[code].places++;
      }
    }
    const GEAR_LABEL = {
      B: '眼罩(B)', XB: '超大眼罩(XB)', CP: '鼻箍(CP)', TT: '舌帶(TT)',
      E: '耳塞(E)', SR: '翻沙鐵(SR)', BO: '仿製眼罩(BO)', P: '遮耳器(P)',
      PC: '遮耳器(PC)', V: '眼罩(V)',
    };
    const by_gear = Object.entries(codeMap)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([code, s]) => ({
        code,
        label: GEAR_LABEL[code] || code,
        total: s.total,
        wins: s.wins,
        places: s.places,
        win_rate:   ((s.wins   / s.total) * 100).toFixed(1) + '%',
        place_rate: ((s.places / s.total) * 100).toFixed(1) + '%',
      }));

    // ── By racecourse + distance ──────────────────────────────────────────────
    const venueMap = {};
    for (const r of rows) {
      const key = `${r.racecourse}|${r.distance}`;
      if (!venueMap[key]) venueMap[key] = { racecourse: r.racecourse, distance: r.distance, total: 0, wins: 0, places: 0 };
      venueMap[key].total++;
      if (r.finish_position === 1) venueMap[key].wins++;
      if (r.finish_position <= 3)  venueMap[key].places++;
    }
    const by_venue = Object.values(venueMap)
      .sort((a, b) => b.total - a.total)
      .map(v => ({
        racecourse: COURSE[v.racecourse] || v.racecourse,
        distance:   v.distance ? `${v.distance}米` : '—',
        total: v.total,
        wins: v.wins,
        places: v.places,
        win_rate:   ((v.wins   / v.total) * 100).toFixed(1) + '%',
        place_rate: ((v.places / v.total) * 100).toFixed(1) + '%',
      }));

    // ── Recent records (latest 30) ────────────────────────────────────────────
    const records = rows.slice(0, 30).map(r => ({
      race_date:       r.race_date,
      racecourse:      COURSE[r.racecourse] || r.racecourse,
      race_no:         r.race_no,
      race_class:      r.race_class || '—',
      distance:        r.distance ? `${r.distance}米` : '—',
      going:           r.going || '—',
      horse_name:      r.horse_name,
      trainer_name:    r.trainer_name || '—',
      gear:            r.gear || '—',
      finish_position: r.finish_position,
      total_runners:   r.total_runners,
      actual_weight:   r.actual_weight,
    }));

    res.json({ type, filters: { gear_code, venue, distance }, overall, by_gear, by_venue, records });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// COMPLEX STATS ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

const GEAR_LABEL_MAP = {
  B: '眼罩(B)', XB: '超大眼罩(XB)', CP: '鼻箍(CP)', TT: '舌帶(TT)',
  E: '耳塞(E)', SR: '翻沙鐵(SR)', BO: '仿製眼罩(BO)', P: '遮耳器(P)',
  PC: '遮耳器(PC)', V: '眼罩(V)',
};
const COURSE_MAP = { ST: '沙田', HV: '跑馬地' };
function fmtRate(num, den) { return den > 0 ? (num / den * 100).toFixed(1) + '%' : '—'; }
function statsRow(rows) {
  const total  = rows.length;
  const wins   = rows.filter(r => r.finish_position === 1).length;
  const places = rows.filter(r => r.finish_position <= 3).length;
  return { total, wins, places, win_rate: fmtRate(wins, total), place_rate: fmtRate(places, total) };
}

// ── 1. Jockey split: horse performance grouped by jockey + after-change stats ─
// GET /api/ai/stats-jockey-split?horse_name=
app.get('/api/ai/stats-jockey-split', async (req, res) => {
  const { horse_name } = req.query;
  if (!horse_name) return res.status(400).json({ error: 'horse_name required' });
  try {
    // All races for this horse, ordered chronologically
    const allRes = await pool.query(
      `SELECT TO_CHAR(race_date,'YYYY-MM-DD') AS race_date,
              race_no, racecourse, race_class, distance, going,
              jockey_id, gear, finish_position, total_runners, actual_weight
       FROM race_records WHERE horse_name=$1
       ORDER BY race_date ASC, race_no ASC`,
      [horse_name]
    );
    const rows = allRes.rows;
    if (rows.length === 0) return res.json({ horse_name, by_jockey: [], after_change: { total:0, wins:0, places:0, win_rate:'—', place_rate:'—' }, after_change_records: [] });

    // Look up jockey display names
    const jockeyIds = [...new Set(rows.map(r => r.jockey_id).filter(Boolean))];
    const jockeyMap = {};
    if (jockeyIds.length) {
      const jRes = await pool.query('SELECT id, name_zh, name_en FROM jockeys WHERE id = ANY($1)', [jockeyIds]);
      for (const j of jRes.rows) jockeyMap[j.id] = j.name_zh || j.name_en || j.id;
    }

    // Group by jockey
    const jMap = {};
    for (const r of rows) {
      const k = r.jockey_id || '—';
      if (!jMap[k]) jMap[k] = [];
      jMap[k].push(r);
    }
    const by_jockey = Object.entries(jMap)
      .map(([id, rs]) => ({ jockey_id: id, jockey_name: jockeyMap[id] || id, ...statsRow(rs), first_date: rs[0].race_date, last_date: rs[rs.length-1].race_date }))
      .sort((a, b) => b.total - a.total);

    // After-jockey-change races
    const afterRows = [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].jockey_id && rows[i-1].jockey_id && rows[i].jockey_id !== rows[i-1].jockey_id) {
        afterRows.push({ ...rows[i], jockey_name: jockeyMap[rows[i].jockey_id] || rows[i].jockey_id, prev_jockey_name: jockeyMap[rows[i-1].jockey_id] || rows[i-1].jockey_id, racecourse: COURSE_MAP[rows[i].racecourse] || rows[i].racecourse, distance: rows[i].distance ? `${rows[i].distance}米` : '—' });
      }
    }
    const after_change = statsRow(afterRows);
    const after_change_records = afterRows.slice().reverse().slice(0, 20);

    res.json({ horse_name, by_jockey, after_change, after_change_records });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 2. Trainer × Jockey combination stats ────────────────────────────────────
// GET /api/ai/stats-trainer-jockey?trainer_id=&jockey_id=
app.get('/api/ai/stats-trainer-jockey', async (req, res) => {
  const { trainer_id, jockey_id } = req.query;
  if (!trainer_id && !jockey_id) return res.status(400).json({ error: 'trainer_id or jockey_id required' });
  try {
    // Resolve display names
    let trainerName = null, jockeyName = null;
    if (trainer_id) {
      const r = await pool.query('SELECT name_zh, name_en FROM trainers WHERE id=$1', [trainer_id]);
      trainerName = r.rows[0]?.name_zh || r.rows[0]?.name_en || trainer_id;
    }
    if (jockey_id) {
      const r = await pool.query('SELECT name_zh, name_en FROM jockeys WHERE id=$1', [jockey_id]);
      jockeyName = r.rows[0]?.name_zh || r.rows[0]?.name_en || jockey_id;
    }

    if (trainer_id && jockey_id) {
      // Specific combo
      const allRes = await pool.query(
        `SELECT TO_CHAR(race_date,'YYYY-MM-DD') AS race_date,
                racecourse, race_no, race_class, distance, going,
                horse_name, gear, finish_position, total_runners, actual_weight
         FROM race_records WHERE trainer_id=$1 AND jockey_id=$2
         ORDER BY race_date DESC, race_no DESC`,
        [trainer_id, jockey_id]
      );
      const rows = allRes.rows;
      const overall = statsRow(rows);
      const venueMap = {};
      for (const r of rows) {
        const k = `${r.racecourse}|${r.distance}`;
        if (!venueMap[k]) venueMap[k] = { racecourse: COURSE_MAP[r.racecourse]||r.racecourse, distance: r.distance ? `${r.distance}米`:'—', ...{total:0,wins:0,places:0} };
        venueMap[k].total++;
        if (r.finish_position===1) venueMap[k].wins++;
        if (r.finish_position<=3) venueMap[k].places++;
      }
      const by_venue = Object.values(venueMap).map(v => ({ ...v, win_rate: fmtRate(v.wins,v.total), place_rate: fmtRate(v.places,v.total) })).sort((a,b)=>b.total-a.total);
      const records = rows.slice(0,20).map(r => ({ ...r, racecourse: COURSE_MAP[r.racecourse]||r.racecourse, distance: r.distance ? `${r.distance}米`:'—' }));
      return res.json({ mode: 'combo', trainer_id, trainer_name: trainerName, jockey_id, jockey_name: jockeyName, overall, by_venue, records });
    }

    if (trainer_id) {
      // Trainer breakdown by jockey
      const rows = (await pool.query(
        `SELECT jockey_id, COUNT(*)::int AS total,
                SUM(CASE WHEN finish_position=1 THEN 1 ELSE 0 END)::int AS wins,
                SUM(CASE WHEN finish_position<=3 THEN 1 ELSE 0 END)::int AS places
         FROM race_records WHERE trainer_id=$1
         GROUP BY jockey_id ORDER BY total DESC LIMIT 20`,
        [trainer_id]
      )).rows;
      // Resolve jockey names
      const jids = rows.map(r => r.jockey_id).filter(Boolean);
      const jMap = {};
      if (jids.length) {
        const jr = await pool.query('SELECT id, name_zh, name_en FROM jockeys WHERE id = ANY($1)', [jids]);
        for (const j of jr.rows) jMap[j.id] = j.name_zh || j.name_en || j.id;
      }
      const by_jockey = rows.map(r => ({ jockey_id: r.jockey_id, jockey_name: jMap[r.jockey_id]||r.jockey_id, total: r.total, wins: r.wins, places: r.places, win_rate: fmtRate(r.wins, r.total), place_rate: fmtRate(r.places, r.total) }));
      return res.json({ mode: 'trainer_breakdown', trainer_id, trainer_name: trainerName, by_jockey });
    }

    // Jockey breakdown by trainer
    const rows = (await pool.query(
      `SELECT trainer_id, trainer_name, COUNT(*)::int AS total,
              SUM(CASE WHEN finish_position=1 THEN 1 ELSE 0 END)::int AS wins,
              SUM(CASE WHEN finish_position<=3 THEN 1 ELSE 0 END)::int AS places
       FROM race_records WHERE jockey_id=$1
       GROUP BY trainer_id, trainer_name ORDER BY total DESC LIMIT 20`,
      [jockey_id]
    )).rows;
    const by_trainer = rows.map(r => ({ trainer_id: r.trainer_id, trainer_name: r.trainer_name || r.trainer_id, total: r.total, wins: r.wins, places: r.places, win_rate: fmtRate(r.wins, r.total), place_rate: fmtRate(r.places, r.total) }));
    res.json({ mode: 'jockey_breakdown', jockey_id, jockey_name: jockeyName, by_trainer });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 3. Class change performance ───────────────────────────────────────────────
// GET /api/ai/stats-class-change?type=horse|trainer|jockey&id=&name=
app.get('/api/ai/stats-class-change', async (req, res) => {
  const { type, id, name } = req.query;
  if (!type || (!id && !name)) return res.status(400).json({ error: 'type and id/name required' });
  try {
    const cond = type==='horse' ? `horse_name=$1` : type==='trainer' ? `trainer_id=$1` : `jockey_id=$1`;
    const param = type==='horse' ? name : id;
    const rows = (await pool.query(
      `SELECT TO_CHAR(race_date,'YYYY-MM-DD') AS race_date,
              race_no, racecourse, race_class, distance, going,
              horse_name, jockey_id, gear, finish_position, total_runners, actual_weight
       FROM race_records WHERE ${cond}
       ORDER BY race_date ASC, race_no ASC`,
      [param]
    )).rows;

    if (rows.length === 0) return res.json({ type, rows: [], by_direction: [] });

    // Resolve jockey names
    const jids = [...new Set(rows.map(r=>r.jockey_id).filter(Boolean))];
    const jMap = {};
    if (jids.length) {
      const jr = await pool.query('SELECT id, name_zh FROM jockeys WHERE id = ANY($1)', [jids]);
      for (const j of jr.rows) jMap[j.id] = j.name_zh || j.id;
    }

    // Parse class number — handles "Class 4", "class 4", or plain "4"
    function classNum(c) {
      if (!c) return null;
      const m = c.match(/class\s*(\d)/i);
      if (m) return parseInt(m[1]);
      const n = c.match(/^(\d)$/);   // plain single digit: "1"–"5"
      if (n) return parseInt(n[1]);
      return null;
    }

    // Tag each race with direction vs previous
    const tagged = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const prev = i > 0 ? rows[i-1] : null;
      let direction = 'first';
      if (prev) {
        const cn = classNum(r.race_class), pn = classNum(prev.race_class);
        if (cn !== null && pn !== null) {
          if (cn < pn)      direction = 'promoted';   // harder (class number drops)
          else if (cn > pn) direction = 'demoted';    // easier (class number rises)
          else              direction = 'same';
        } else {
          direction = 'other';
        }
      }
      tagged.push({ ...r, direction, jockey_name: jMap[r.jockey_id]||r.jockey_id||'—', racecourse: COURSE_MAP[r.racecourse]||r.racecourse, distance: r.distance?`${r.distance}米`:'—', distance_raw: r.distance });
    }

    const DIR_LABEL = { promoted:'升班後', demoted:'降班後', same:'同班', other:'特殊賽事', first:'首場' };
    const dirMap = {};
    for (const r of tagged) {
      if (!dirMap[r.direction]) dirMap[r.direction] = [];
      dirMap[r.direction].push(r);
    }
    const ORDER = ['promoted','demoted','same','other','first'];
    const by_direction = ORDER.filter(d => dirMap[d]?.length).map(d => ({
      direction: d, label: DIR_LABEL[d], ...statsRow(dirMap[d]),
      records: dirMap[d].slice().reverse().slice(0,10),
    }));

    res.json({ type, name: name||id, by_direction, total_records: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 4. Gear debut stats ───────────────────────────────────────────────────────
// GET /api/ai/stats-gear-debut?horse_name=
app.get('/api/ai/stats-gear-debut', async (req, res) => {
  const { horse_name } = req.query;
  if (!horse_name) return res.status(400).json({ error: 'horse_name required' });
  try {
    const rows = (await pool.query(
      `SELECT TO_CHAR(race_date,'YYYY-MM-DD') AS race_date, race_no,
              racecourse, race_class, distance, going,
              gear, finish_position, total_runners
       FROM race_records WHERE horse_name=$1 AND gear IS NOT NULL AND gear != ''
       ORDER BY race_date ASC, race_no ASC`,
      [horse_name]
    )).rows;

    if (rows.length === 0) return res.json({ horse_name, by_gear: [] });

    // For each individual gear code, find first/all races
    const gearMap = {}; // code → [{race, raceIdx}]
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const codes = r.gear.split(/[\s,/]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
      for (const code of codes) {
        if (!gearMap[code]) gearMap[code] = [];
        gearMap[code].push({ ...r, race_idx: i, racecourse: COURSE_MAP[r.racecourse]||r.racecourse, distance: r.distance?`${r.distance}米`:'—' });
      }
    }

    const by_gear = Object.entries(gearMap)
      .map(([code, rs]) => {
        const debut = rs[0];
        const all   = statsRow(rs);
        const subsequent = statsRow(rs.slice(1));
        return {
          code, label: GEAR_LABEL_MAP[code]||code,
          total: all.total, wins: all.wins, places: all.places,
          win_rate: all.win_rate, place_rate: all.place_rate,
          debut_date: debut.race_date,
          debut_position: debut.finish_position ? `${debut.finish_position}/${debut.total_runners}` : '—',
          debut_won: debut.finish_position === 1,
          sub_total: subsequent.total, sub_wins: subsequent.wins,
          sub_win_rate: subsequent.win_rate,
        };
      })
      .sort((a, b) => b.total - a.total);

    res.json({ horse_name, by_gear });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 5. Streak / recent form ───────────────────────────────────────────────────
// GET /api/ai/stats-streak?type=horse|trainer|jockey&id=&name=
app.get('/api/ai/stats-streak', async (req, res) => {
  const { type, id, name } = req.query;
  if (!type || (!id && !name)) return res.status(400).json({ error: 'type and id/name required' });
  try {
    const cond = type==='horse' ? `horse_name=$1` : type==='trainer' ? `trainer_id=$1` : `jockey_id=$1`;
    const param = type==='horse' ? name : id;
    const rows = (await pool.query(
      `SELECT TO_CHAR(race_date,'YYYY-MM-DD') AS race_date,
              race_no, racecourse, race_class, distance, going,
              horse_name, jockey_id, gear, finish_position, total_runners, actual_weight
       FROM race_records WHERE ${cond}
       ORDER BY race_date DESC, race_no DESC LIMIT 50`,
      [param]
    )).rows;

    if (rows.length === 0) return res.json({ type, recent_form: [], current_streak: null, longest_win_streak: 0, longest_place_streak: 0 });

    // Resolve jockey names
    const jids = [...new Set(rows.map(r=>r.jockey_id).filter(Boolean))];
    const jMap = {};
    if (jids.length) {
      const jr = await pool.query('SELECT id, name_zh FROM jockeys WHERE id = ANY($1)', [jids]);
      for (const j of jr.rows) jMap[j.id] = j.name_zh || j.id;
    }

    // Annotate result symbols (newest first = rows[0])
    const form = rows.map(r => {
      const res = r.finish_position===1 ? 'W' : r.finish_position<=3 ? 'P' : 'L';
      return { ...r, result: res, jockey_name: jMap[r.jockey_id]||r.jockey_id||'—', racecourse: COURSE_MAP[r.racecourse]||r.racecourse, distance: r.distance?`${r.distance}米`:'—' };
    });

    // Current streak (from most recent)
    let curType = null, curLen = 0;
    for (const r of form) {
      if (curType === null) { curType = r.result; curLen = 1; }
      else if (r.result === curType) curLen++;
      else break;
    }
    const STREAK_LABEL = { W: '連勝', P: '連上位', L: '連出位' };
    const current_streak = curType ? { type: curType, label: STREAK_LABEL[curType]||curType, length: curLen } : null;

    // Longest win / place streak (over all records)
    let longestWin = 0, longestPlace = 0, runWin = 0, runPlace = 0;
    for (const r of [...form].reverse()) { // oldest first
      if (r.result==='W') { runWin++; longestWin = Math.max(longestWin, runWin); } else runWin = 0;
      if (r.result!=='L') { runPlace++; longestPlace = Math.max(longestPlace, runPlace); } else runPlace = 0;
    }

    res.json({ type, recent_form: form.slice(0,20), current_streak, longest_win_streak: longestWin, longest_place_streak: longestPlace });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 6. Weight change performance ──────────────────────────────────────────────
// GET /api/ai/stats-weight-change?horse_name=
app.get('/api/ai/stats-weight-change', async (req, res) => {
  const { horse_name } = req.query;
  if (!horse_name) return res.status(400).json({ error: 'horse_name required' });
  try {
    const rows = (await pool.query(
      `SELECT TO_CHAR(race_date,'YYYY-MM-DD') AS race_date, race_no,
              racecourse, race_class, distance, going,
              jockey_id, gear, finish_position, total_runners, actual_weight
       FROM race_records WHERE horse_name=$1 AND actual_weight IS NOT NULL
       ORDER BY race_date ASC, race_no ASC`,
      [horse_name]
    )).rows;

    if (rows.length < 2) return res.json({ horse_name, by_category: [], records: [] });

    // Resolve jockey names
    const jids = [...new Set(rows.map(r=>r.jockey_id).filter(Boolean))];
    const jMap = {};
    if (jids.length) {
      const jr = await pool.query('SELECT id, name_zh FROM jockeys WHERE id = ANY($1)', [jids]);
      for (const j of jr.rows) jMap[j.id] = j.name_zh || j.id;
    }

    // Tag each race with weight diff vs previous
    const tagged = [];
    for (let i = 1; i < rows.length; i++) {
      const diff = rows[i].actual_weight - rows[i-1].actual_weight;
      let category;
      if (diff > 3)       category = 'increase';   // 加磅 >3
      else if (diff < -3) category = 'decrease';   // 減磅 >3
      else                category = 'stable';      // 變化 ≤3磅
      tagged.push({ ...rows[i], weight_diff: diff, category, jockey_name: jMap[rows[i].jockey_id]||rows[i].jockey_id||'—', racecourse: COURSE_MAP[rows[i].racecourse]||rows[i].racecourse, distance: rows[i].distance?`${rows[i].distance}米`:'—' });
    }

    const CAT = { increase: '加磅 >3磅', decrease: '減磅 >3磅', stable: '負磅穩定' };
    const catMap = { increase:[], decrease:[], stable:[] };
    for (const r of tagged) catMap[r.category].push(r);
    const by_category = ['increase','decrease','stable']
      .filter(c => catMap[c].length > 0)
      .map(c => ({ category: c, label: CAT[c], ...statsRow(catMap[c]) }));

    const records = tagged.slice().reverse().slice(0,20).map(r => ({ ...r, weight_diff: r.weight_diff > 0 ? `+${r.weight_diff}` : `${r.weight_diff}` }));

    res.json({ horse_name, by_category, records });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/ai/parse-query
// Extracts entities (trainer/jockey/horse), gear codes, venue, distance from free-text query.
// Returns structured interpretation for user confirmation before executing DB query.
app.post('/api/ai/parse-query', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || !query.trim()) return res.status(400).json({ error: 'query required' });

    const q = query.trim();

    // ── Gear code keyword map ─────────────────────────────────────────────────
    const GEAR_KEYWORDS = [
      { codes: ['XB'], words: ['超大眼罩', 'XB', 'xb'] },
      { codes: ['B'],  words: ['眼罩', 'b眼罩', '戴眼罩', '換眼罩'] },
      { codes: ['CP'], words: ['鼻箍', 'CP', 'cp', '戴鼻箍', '換鼻箍'] },
      { codes: ['TT'], words: ['舌帶', 'TT', 'tt', '綁舌帶'] },
      { codes: ['E'],  words: ['耳塞', 'E塞', '戴耳塞'] },
      { codes: ['SR'], words: ['翻沙鐵', 'SR', 'sr'] },
      { codes: ['P'],  words: ['遮耳器', 'P罩'] },
      { codes: ['BO'], words: ['仿製眼罩', 'BO', 'bo'] },
    ];

    // ── Venue detection ───────────────────────────────────────────────────────
    let venue = null;
    if (/沙田|sha.?tin|ST\b/i.test(q)) venue = 'ST';
    else if (/跑馬地|happy.?valley|HV\b/i.test(q)) venue = 'HV';

    // ── Distance detection ────────────────────────────────────────────────────
    let distance = null;
    const distMatch = q.match(/(\d{3,4})\s*米/);
    if (distMatch) distance = parseInt(distMatch[1]);

    // ── Gear detection ────────────────────────────────────────────────────────
    const gearCodes = [];
    for (const { codes, words } of GEAR_KEYWORDS) {
      if (words.some(w => q.toLowerCase().includes(w.toLowerCase()))) {
        gearCodes.push(...codes);
      }
    }
    // Direct uppercase code match (e.g. standalone B, XB, CP, TT, E, SR)
    const directCodes = q.match(/\b(XB|CP|TT|SR|BO|PC|[BEPV])\b/g);
    if (directCodes) {
      for (const c of directCodes.map(s => s.toUpperCase())) {
        if (!gearCodes.includes(c)) gearCodes.push(c);
      }
    }

    // ── Entity search: tokenise and search DB ────────────────────────────────
    // 1. Split on spaces/punctuation
    const tokens = q.split(/[\s,，、。？！《》「」\(\)（）]+/).filter(t => t.length >= 2);
    // 2. Also add sliding-window substrings of length 2-4 (catches Chinese names
    //    embedded in text without spaces, e.g. "蔡約翰佩戴眼罩的勝率")
    const allSubstrings = new Set([q, ...tokens]);
    for (const seg of [q, ...tokens]) {
      for (let len = 2; len <= 4; len++) {
        for (let i = 0; i <= seg.length - len; i++) {
          allSubstrings.add(seg.slice(i, i + len));
        }
      }
    }
    const like_queries = [...allSubstrings].map(t => `%${t}%`);

    const entityResult = await pool.query(
      `SELECT * FROM (
         SELECT 'trainer' AS type, id, name_zh, name_en FROM trainers
         WHERE name_zh ILIKE ANY($1::text[]) OR name_en ILIKE ANY($1::text[])
         UNION ALL
         SELECT 'jockey', id, name_zh, name_en FROM jockeys
         WHERE name_zh ILIKE ANY($1::text[]) OR name_en ILIKE ANY($1::text[])
         UNION ALL
         SELECT 'horse', id, name_zh, name_en FROM horses
         WHERE name_zh ILIKE ANY($1::text[]) OR name_en ILIKE ANY($1::text[])
       ) t LIMIT 20`,
      [like_queries]
    );

    // ── Post-filter: discard entities matched only by short noise substrings ──
    // Require that the best-matching token covers >= 67% of at least one language form
    // of the entity name (e.g. "組合" (2/4=50%) filtering out "勝之組合" false positive).
    const entities = entityResult.rows.filter(e => {
      const nameZh = (e.name_zh || '').toLowerCase();
      const nameEn = (e.name_en || '').toLowerCase();
      let bestLen = 0;
      for (const sub of allSubstrings) {
        if (sub.length <= bestLen) continue;
        const s = sub.toLowerCase();
        if ((nameZh && nameZh.includes(s)) || (nameEn && nameEn.includes(s))) {
          bestLen = sub.length;
        }
      }
      if (bestLen < 2) return false;
      const zhCov = nameZh.length > 0 ? bestLen / nameZh.length : 0;
      const enCov = nameEn.length > 0 ? bestLen / nameEn.length : 0;
      return Math.max(zhCov, enCov) >= 0.67;
    }).slice(0, 10);

    // ── Query type detection ─────────────────────────────────────────────────
    const QUERY_TYPE_MAP = [
      { type: 'jockey_split',    re: /換騎師|轉騎師|騎師變更|騎師更換|按騎師|騎師分析/ },
      { type: 'trainer_jockey',  re: /組合|合作|配搭|夥伴/ },
      { type: 'class_change',    re: /升班|降班|升降班|升級|降級|換班/ },
      { type: 'gear_debut',      re: /首次|初次|第一次|初戴|首戴|初披/ },
      { type: 'streak',          re: /連贏|連勝|連負|連挫|連續|近況|現況|form/i },
      { type: 'weight_change',   re: /體重|磅差|增重|減重|負磅變化|磅數變/ },
    ];
    let query_type = 'simple';
    for (const { type, re } of QUERY_TYPE_MAP) {
      if (re.test(q)) { query_type = type; break; }
    }
    // trainer_jockey also triggers when entities contain both trainer and jockey
    if (query_type === 'simple') {
      const hasTrainer = entities.some(e => e.type === 'trainer');
      const hasJockey  = entities.some(e => e.type === 'jockey');
      if (hasTrainer && hasJockey) query_type = 'trainer_jockey';
    }

    // ── Ambiguity ─────────────────────────────────────────────────────────────
    // trainer_jockey with exactly 1 trainer + 1 jockey is intentional, not ambiguous
    let ambiguous = entities.length > 1;
    if (query_type === 'trainer_jockey' && ambiguous) {
      const trainers = entities.filter(e => e.type === 'trainer');
      const jockeys  = entities.filter(e => e.type === 'jockey');
      if (trainers.length <= 1 && jockeys.length <= 1) ambiguous = false;
    }

    // ── Build human-readable description ────────────────────────────────────
    const GEAR_LABEL = { B: '眼罩(B)', XB: '超大眼罩(XB)', CP: '鼻箍(CP)', TT: '舌帶(TT)', E: '耳塞(E)', SR: '翻沙鐵(SR)', BO: '仿製眼罩(BO)', P: '遮耳器(P)', PC: '遮耳器(PC)', V: '眼罩(V)' };
    const COURSE = { ST: '沙田', HV: '跑馬地' };
    const TYPE_ZH = { trainer: '練馬師', jockey: '騎師', horse: '馬匹' };
    const QT_LABEL = {
      jockey_split: '換騎師分析', trainer_jockey: '練馬師×騎師組合',
      class_change: '升降班成績', gear_debut: '首次配備成績',
      streak: '連勝/連負近況', weight_change: '體重變化成績',
    };

    const parts = [];
    if (query_type === 'trainer_jockey' && !ambiguous) {
      const t = entities.find(e => e.type === 'trainer');
      const j = entities.find(e => e.type === 'jockey');
      if (t && j) parts.push(`練馬師「${t.name_zh||t.name_en}」× 騎師「${j.name_zh||j.name_en}」`);
      else if (t) parts.push(`練馬師「${t.name_zh||t.name_en}」的合作騎師`);
      else if (j) parts.push(`騎師「${j.name_zh||j.name_en}」的合作練馬師`);
    } else if (entities.length === 1) {
      parts.push(`${TYPE_ZH[entities[0].type]}「${entities[0].name_zh || entities[0].name_en}」`);
    } else if (entities.length > 1) {
      parts.push(`${entities.length} 個相關人員/馬匹`);
    }
    if (query_type !== 'simple') parts.push(QT_LABEL[query_type] || query_type);
    if (gearCodes.length && query_type === 'simple') parts.push(`配備 ${gearCodes.map(c => GEAR_LABEL[c] || c).join('、')}`);
    if (venue) parts.push(COURSE[venue]);
    if (distance) parts.push(`${distance}米`);

    const description = parts.length
      ? `查詢 ${parts.join('，')}`
      : '未能識別具體條件，請嘗試輸入馬匹、練馬師或騎師名稱';

    res.json({
      query: q,
      query_type,
      entities,
      gear_codes: gearCodes,
      venue,
      distance,
      description,
      ambiguous,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// GET /api/sectional/race-followup?date=YYYY-MM-DD&raceno=N
// Returns post-race performance stats for all horses that ran in the specified race.
// For each horse, counts wins/2nds/3rds/losses in race_records after the given date.
app.get('/api/sectional/race-followup', async (req, res) => {
  const { date, raceno } = req.query;
  if (!date || !raceno) return res.status(400).json({ error: 'date and raceno required' });
  const raceNo = parseInt(raceno, 10);
  try {
    // Step 1: get all horses from this race via racecard (preferred) or race_sectional_times
    let horses = [];
    const rcResult = await pool.query(
      `SELECT horse_no, horse_name, horse_id FROM racecard
       WHERE race_date = $1 AND race_no = $2 ORDER BY horse_no`,
      [date, raceNo]
    );
    if (rcResult.rows.length > 0) {
      horses = rcResult.rows.map(r => ({
        horseNo: r.horse_no,
        horseName: r.horse_name,
        horseId: r.horse_id,
      }));
    } else {
      // Fallback: race_sectional_times
      const stResult = await pool.query(
        `SELECT horse_no, horse_name, horse_id FROM race_sectional_times
         WHERE race_date = $1 AND race_no = $2 ORDER BY finish_position`,
        [date, raceNo]
      );
      horses = stResult.rows.map(r => ({
        horseNo: r.horse_no,
        horseName: r.horse_name,
        horseId: r.horse_id,
      }));
    }

    if (horses.length === 0) {
      return res.json({ date, raceNo, horses: [] });
    }

    // Step 2: for each horse, count post-race results from race_records using horse_name
    const horseNames = horses.map(h => h.horseName).filter(Boolean);
    if (horseNames.length === 0) return res.json({ date, raceNo, horses: [] });

    const placeholders = horseNames.map((_, i) => `$${i + 2}`).join(',');
    const statsResult = await pool.query(
      `SELECT horse_name,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE finish_position = 1) AS win,
              COUNT(*) FILTER (WHERE finish_position = 2) AS second,
              COUNT(*) FILTER (WHERE finish_position = 3) AS third,
              COUNT(*) FILTER (WHERE finish_position > 3) AS loss
       FROM race_records
       WHERE race_date > $1 AND horse_name IN (${placeholders})
       GROUP BY horse_name`,
      [date, ...horseNames]
    );

    const statsMap = {};
    for (const row of statsResult.rows) {
      statsMap[row.horse_name] = {
        total: parseInt(row.total),
        win: parseInt(row.win),
        second: parseInt(row.second),
        third: parseInt(row.third),
        loss: parseInt(row.loss),
      };
    }

    const result = horses.map(h => ({
      ...h,
      followup: statsMap[h.horseName] || { total: 0, win: 0, second: 0, third: 0, loss: 0 },
    }));

    res.json({ date, raceNo, horses: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Horse-odds backfill helpers ───────────────────────────────────────────────
// Scrapes HKJC horse-list pages (HK + CH) and returns Map<horseName, horseId>
async function fetchHorseNameIdMap() {
  const fetchMod = await import('node-fetch');
  const fetch = fetchMod.default;
  const map = new Map();
  const HEADERS = {
    'Accept-Language': 'zh-HK,zh;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  try {
    for (const location of ['HK', 'CH']) {
      const url = `https://racing.hkjc.com/zh-hk/local/information/listbylocation?location=${location}`;
      const resp = await fetch(url, { headers: HEADERS });
      const html = await resp.text();
      const $ = cheerio.load(html);
      $('a[href*="horseid="]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/horseid=([A-Z0-9_]+)/i);
        const name = $(el).text().trim();
        if (m && name) map.set(name, m[1]);
      });
    }
  } catch (e) {
    console.error('[fetchHorseNameIdMap] Error:', e.message);
  }
  console.log(`[fetchHorseNameIdMap] ${map.size} horses collected`);
  return map;
}

// Scrapes horse profile page and returns Map<raceNo, winOdds> for current season
async function scrapeHorseOddsMap(horseId) {
  const fetchMod = await import('node-fetch');
  const fetch = fetchMod.default;
  const map = new Map();
  try {
    const url = `https://racing.hkjc.com/zh-hk/local/information/horse?horseid=${encodeURIComponent(horseId)}`;
    const resp = await fetch(url, {
      headers: {
        'Accept-Language': 'zh-HK,zh;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const html = await resp.text();
    const $ = cheerio.load(html);

    // Find the race history table — has .hsubheader cells including 獨贏賠率 at col[12]
    let targetTable = null;
    $('table').each((_, tbl) => {
      const headers = $(tbl).find('td.hsubheader');
      if (headers.length >= 13) {
        const texts = headers.map((_, h) => $(h).text().replace(/\s+/g, '')).get();
        if (texts.some(t => t.includes('獨贏') || t.includes('賠率'))) {
          targetTable = tbl;
          return false; // break
        }
      }
    });
    if (!targetTable) targetTable = $('table.bigborder')[0] || null;
    if (!targetTable) return map;

    $(targetTable).find('tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 13) return;
      const raceNo = parseInt($(tds[0]).text().trim());
      if (!raceNo || raceNo > 9999) return;
      const odds = parseFloat($(tds[12]).text().trim());
      if (!isNaN(odds) && odds > 0) map.set(raceNo, odds);
    });
  } catch (e) {
    console.error(`[scrapeHorseOddsMap ${horseId}] Error:`, e.message);
  }
  return map;
}

// POST /api/backfill/win-odds
// Scrapes HKJC horse profile pages to backfill race_records.win_odds.
// Body (all optional): { dryRun?: bool, batchSize?: number }
app.post('/api/backfill/win-odds', async (req, res) => {
  const { dryRun = false, batchSize = 5 } = req.body || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  try {
    // 1. Horses still missing win_odds
    const { rows: horseRows } = await pool.query(
      `SELECT DISTINCT horse_name FROM race_records WHERE win_odds IS NULL`
    );
    const horseNames = horseRows.map(r => r.horse_name);
    console.log(`[backfill/win-odds] ${horseNames.length} horses with NULL win_odds`);
    if (horseNames.length === 0) return res.json({ message: 'Already complete', updated: 0 });

    // 2. Build name → id map: HKJC list + racecard table
    console.log('[backfill/win-odds] Fetching HKJC horse list…');
    const hkjcMap = await fetchHorseNameIdMap();
    const { rows: rcRows } = await pool.query(
      `SELECT DISTINCT horse_name, horse_id FROM racecard WHERE horse_id IS NOT NULL AND horse_id <> ''`
    );
    const nameIdMap = new Map(hkjcMap);
    for (const row of rcRows) {
      if (!nameIdMap.has(row.horse_name)) nameIdMap.set(row.horse_name, row.horse_id);
    }

    const found    = horseNames.filter(n => nameIdMap.has(n));
    const notFound = horseNames.filter(n => !nameIdMap.has(n));
    console.log(`[backfill/win-odds] resolved ${found.length}/${horseNames.length}; missing: ${notFound.length}`);

    if (dryRun) {
      return res.json({ dryRun: true, total: horseNames.length, found: found.length, notFound: notFound.length, notFoundSample: notFound.slice(0, 20) });
    }

    // 3. Scrape & update in batches of batchSize with 300 ms between batches
    let recordsUpdated = 0;
    let horsesProcessed = 0;

    for (let i = 0; i < found.length; i += batchSize) {
      const batch = found.slice(i, i + batchSize);
      const results = await Promise.allSettled(batch.map(async (horseName) => {
        const horseId = nameIdMap.get(horseName);
        const oddsMap = await scrapeHorseOddsMap(horseId);
        let updated = 0;
        for (const [raceNo, winOdds] of oddsMap) {
          const r = await pool.query(
            `UPDATE race_records SET win_odds = $1 WHERE horse_name = $2 AND race_no = $3 AND win_odds IS NULL`,
            [winOdds, horseName, raceNo]
          );
          updated += r.rowCount;
        }
        return updated;
      }));
      for (const r of results) {
        if (r.status === 'fulfilled') { recordsUpdated += r.value; horsesProcessed++; }
      }
      const pct = Math.round((i + batch.length) / found.length * 100);
      console.log(`[backfill/win-odds] ${i + batch.length}/${found.length} (${pct}%) — records updated: ${recordsUpdated}`);
      if (i + batchSize < found.length) await sleep(300);
    }

    res.json({
      total_horses: horseNames.length,
      found_horses: found.length,
      not_found_horses: notFound.length,
      horses_processed: horsesProcessed,
      records_updated: recordsUpdated,
      not_found_sample: notFound.slice(0, 20),
    });
  } catch (err) {
    console.error('[backfill/win-odds] Fatal:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Batch workout backfill (legacy - scrapes localtrackwork, current meeting only) ──
// POST /api/backfill/workouts?trainer=文家良
// NOTE: localtrackwork only serves current/upcoming meeting data; use /api/backfill/horse-trials instead.
let backfillWorkoutsActive = false;

app.post('/api/backfill/workouts', async (req, res) => {
  res.status(410).json({ message: '此端點已棄用，請改用 POST /api/backfill/horse-trials' });
});

// ── Batch barrier trial backfill ───────────────────────────────────────────────
// POST /api/backfill/horse-trials?trainer=方嘉柏
// Scrapes trackworkresult page for every horse the trainer has raced (from race_records).
// Saves ALL workout types to horse_workout_log + 試閘 entries to horse_trials.
// For horses not in the `horses` table, resolves horse_id from localresults links.
let backfillTrialsActive = false;

app.post('/api/backfill/horse-trials', async (req, res) => {
  const trainer = req.query.trainer || req.body.trainer || '文家良';
  if (backfillTrialsActive) return res.status(409).json({ message: '批量試閘資料抓取進行中' });

  // Step 1: Horses already in horses table
  const inTable = await pool.query(`
    SELECT h.id, h.name_zh
    FROM horses h
    JOIN (SELECT DISTINCT horse_name FROM race_records WHERE trainer_name = $1) r
      ON h.name_zh = r.horse_name
  `, [trainer]);

  // Step 2: Horses NOT in horses table — get one race for each to resolve horse_id
  const missingRes = await pool.query(`
    SELECT DISTINCT ON (horse_name) horse_name, race_date, racecourse, race_no
    FROM race_records
    WHERE trainer_name = $1
      AND horse_name NOT IN (SELECT name_zh FROM horses WHERE name_zh IS NOT NULL)
    ORDER BY horse_name, race_date DESC
  `, [trainer]);

  res.json({
    message: `開始抓取 ${trainer}：${inTable.rows.length} 匹已知 + ${missingRes.rows.length} 匹需解析 = ${inTable.rows.length + missingRes.rows.length} 匹`,
    total: inTable.rows.length + missingRes.rows.length,
  });
  backfillTrialsActive = true;

  (async () => {
    const allHorses = [...inTable.rows];

    // Resolve horse_ids for missing horses via localresults links
    for (const m of missingRes.rows) {
      try {
        const dateStr = m.race_date instanceof Date ? m.race_date.toISOString().slice(0, 10) : String(m.race_date);
        const dateUrl = dateStr.replace(/-/g, '/');
        const rc = m.racecourse || 'ST';
        const url = `https://racing.hkjc.com/zh-hk/local/information/localresults?racedate=${dateUrl}&Racecourse=${rc}&RaceNo=${m.race_no}`;
        const resp = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = require('cheerio').load(resp.data);
        let horseId = null;
        $('div.performance table tbody tr').each((_, tr) => {
          if (horseId) return;
          const link = $(tr).find('td').eq(2).find('a');
          if (link.text().trim() === m.horse_name) {
            const href = link.attr('href') || '';
            const mid = href.match(/horseid=([^&]+)/i);
            horseId = mid ? mid[1] : null;
          }
        });
        if (horseId) {
          allHorses.push({ id: horseId, name_zh: m.horse_name });
          console.log(`[backfill/horse-trials] Resolved ${m.horse_name} → ${horseId}`);
        } else {
          console.warn(`[backfill/horse-trials] Could not resolve horse_id for ${m.horse_name}`);
        }
      } catch (e) {
        console.error(`[backfill/horse-trials] Lookup ${m.horse_name}: ${e.message}`);
      }
    }

    // Step 3: Scrape trackwork history for each horse
    let done = 0, savedLog = 0, savedTrials = 0, skipped = 0;
    for (const horse of allHorses) {
      try {
        const rows = await scraper.scrapeHorseTrackworkHistory(horse.id);
        for (const row of rows) {
          if (row.type === '出賽') continue;
          // Save to horse_workout_log (ALL types)
          try {
            await pool.query(
              `INSERT INTO horse_workout_log (horse_id, horse_name, log_date, workout_type, venue, details)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (horse_id, log_date, workout_type, venue) DO UPDATE SET
                 details=$6, scraped_at=NOW()`,
              [horse.id, horse.name_zh, row.date, row.type, row.venue || '', row.details || '']
            );
            savedLog++;
          } catch (_) {}
          // Also save 試閘 to horse_trials
          if (row.type === '試閘') {
            try {
              await pool.query(
                `INSERT INTO horse_trials (horse_id, horse_name, trial_date, venue, details)
                 VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (horse_id, trial_date) DO UPDATE SET
                   venue=$4, details=$5, scraped_at=NOW()`,
                [horse.id, horse.name_zh, row.date, row.venue, row.details]
              );
              savedTrials++;
            } catch (_) {}
          }
        }
        done++;
        if (done % 10 === 0) {
          console.log(`[backfill/horse-trials] Progress: ${done}/${allHorses.length}, log=${savedLog}, trials=${savedTrials}`);
        }
      } catch (e) {
        skipped++;
        console.error(`[backfill/horse-trials] ${horse.name_zh}: ${e.message}`);
        done++;
      }
    }
    console.log(`[backfill/horse-trials] Done. ${done} horses, ${savedLog} workout rows, ${savedTrials} trial rows, ${skipped} skipped.`);
    backfillTrialsActive = false;
  })();
});

// ── 晨操資料批量更新（高級排位表：賽前試閘 / 騎師親試用）──────────────────
// POST /api/advanced/trackwork  { date, race_no? } → 為該賽馬日（或某場）逐匹抓取
// GET  /api/advanced/trackwork/status → 進度
const trackwork = require('./jobs/trackwork');

app.post('/api/advanced/trackwork', async (req, res) => {
  const { date, race_no } = req.body || {};
  if (!date) return res.status(400).json({ error: '需要 date' });
  try {
    const st = trackwork.getStatus();
    if (st.active) {
      return res.status(409).json({ message: '晨操抓取進行中', state: st });
    }
    const r = await trackwork.start(date, race_no);
    if (!r.total) return res.status(404).json({ error: '該日期沒有排位表馬匹' });
    res.json({ message: `開始抓取 ${date} 晨操紀錄（${r.total} 匹）`, total: r.total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/advanced/trackwork/status', (req, res) => res.json(trackwork.getStatus()));

// ── 分段時間回補（高級排位表：同程最快末段 / 最快末段用）──────────────────
// POST /api/advanced/sectional-backfill { date } → 為該賽馬日馬匹過往出賽補抓
// GET  /api/advanced/sectional-backfill/status → 進度
const sectionalBackfill = require('./jobs/sectional');

app.post('/api/advanced/sectional-backfill', async (req, res) => {
  const { date } = req.body || {};
  if (!date) return res.status(400).json({ error: '需要 date' });
  try {
    const st = sectionalBackfill.getStatus();
    if (st.active) {
      return res.status(409).json({ message: '分段時間回補進行中', state: st });
    }
    const r = await sectionalBackfill.start(date);
    if (!r.total) return res.json({ message: '過往出賽分段時間已齊，無需回補', total: 0 });
    res.json({ message: `開始回補分段時間（${r.total} 場）`, total: r.total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/advanced/sectional-backfill/status', (req, res) => res.json(sectionalBackfill.getStatus()));

// ── 角球分析（WhoScored 抓取 + 回補）────────────────────────────────────────
const cornerScrape = require('./jobs/cornerScrape');
const wsFootball = require('./football/whoscored');

// POST /api/corner/scrape { league: EPL|BUN|LAL, season?: '2025/2026' }
app.post('/api/corner/scrape', async (req, res) => {
  const { league, season } = req.body || {};
  if (!league || !wsFootball.LEAGUES[league]) return res.status(400).json({ error: 'league 要係 EPL/BUN/LAL' });
  try {
    const st = cornerScrape.getStatus();
    if (st.active) return res.status(409).json({ message: '回補進行中', state: st });
    const r = await cornerScrape.start({ league, season: season || undefined });
    if (r.busy) return res.status(409).json(r);
    if (r.error) return res.status(404).json(r);
    res.json({ message: `開始抓 ${league} ${r.season}（${r.total} 場）`, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/corner/scrape/status', (req, res) => res.json(cornerScrape.getStatus()));

// ── 即場自動追蹤 ─────────────────────────────────────────────────────────────
// POST /api/corner/track/start → 自動搵今日英超 → 每 30 秒刷新 titan007 → 即場預測
// GET  /api/corner/track/status → 所有場次最新數據 + 預測
// POST /api/corner/track/stop
const liveTracker = require('./jobs/liveTracker');

app.post('/api/corner/track/start', async (req, res) => {
  try {
    if (liveTracker.getStatus().active) {
      return res.status(409).json({ message: '追蹤進行中', status: liveTracker.getStatus() });
    }
    const r = await liveTracker.start();
    if (r.error) return res.status(404).json(r);
    res.json({ message: `開始追蹤 ${r.total} 場英超（每 30 秒自動更新）`, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/corner/track/status', (req, res) => res.json(liveTracker.getStatus()));

// ── 入球分析 ─────────────────────────────────────────────────────────────────
// GET /api/goals/predict?league=EPL&home=X&away=Y[&minute=&hg=&ag=]
app.get('/api/goals/predict', async (req, res) => {
  const { league, home, away, minute, hg, ag, shotsH, shotsA, possession } = req.query;
  if (!league || !home || !away) return res.status(400).json({ error: '需要 league, home, away' });
  try {
    const entry = await getFit(league);
    if (!entry) return res.status(404).json({ error: '數據不足' });
    const opts = {};
    if (minute != null && minute !== '') { opts.minute = minute; opts.hg = hg || 0; opts.ag = ag || 0; }
    if (shotsH != null && shotsH !== '') opts.shotsH = shotsH;
    if (shotsA != null && shotsA !== '') opts.shotsA = shotsA;
    if (possession != null && possession !== '') opts.possession = possession;
    const r = cornerlib.predictGoals(entry.fit, home, away, opts, 15000);
    if (r.error) return res.status(404).json(r);
    const exp = cornerlib.expGoalsByTeam(entry.fit, home, away, opts);
    r.expHome = exp.home; r.expAway = exp.away;
    r.sample = entry.n;
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/corner/track/stop', (req, res) => {
  liveTracker.stop();
  res.json({ ok: true, message: '已停止追蹤' });
});

// 下一場英超（自動抓取對賽資料）
app.get('/api/corner/next-matches', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT TO_CHAR(match_date,'YYYY-MM-DD') d, home_team, away_team
       FROM football_matches
       WHERE league='EPL' AND match_date >= CURRENT_DATE AND home_corners IS NULL
       ORDER BY d, home_team LIMIT 20`);
    res.json({ matches: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 未來 10 日賽程 + 預測（titan007）────────────────────────────────────────
const { scrapeSchedule } = require('./football/titanSchedule');
let schedCache = { at: 0, data: null };
// ── AI數據：12 條賽馬統計查詢（由上季起）────────────────────────────────────
// 註：race_records.horse_id 全庫為 NULL → 一律用 horse_name 做分組鍵
app.get('/api/ai-data/queries', async (req, res) => {
  try {
    const from = '2024-09-01'; // 前一季（2024/25）起
    const W = `
      WITH base AS (
        SELECT r.*,
          CASE r.race_class WHEN '第一班' THEN 1 WHEN '1' THEN 1 WHEN 'G1' THEN 1
            WHEN '第二班' THEN 2 WHEN '2' THEN 2 WHEN 'G2' THEN 2
            WHEN '第三班' THEN 3 WHEN '3' THEN 3 WHEN 'G3' THEN 3
            WHEN '第四班' THEN 4 WHEN '4' THEN 4
            WHEN '第五班' THEN 5 WHEN '5' THEN 5 END AS class_num
        FROM race_records r
      ),
      w AS (
        SELECT b.*,
          LAG(race_date) OVER win prev_date,
          LAG(racecourse) OVER win prev_course,
          LAG(track_type) OVER win prev_track,
          LAG(distance) OVER win prev_dist,
          LAG(jockey_id) OVER win prev_jockey,
          LAG(finish_position) OVER win prev_pos,
          LAG(trainer_name) OVER win prev_trainer,
          LAG(class_num) OVER win prev_class_num,
          LAG(jockey_id, 2) OVER win prev2_jockey
        FROM base b
        WINDOW win AS (PARTITION BY b.horse_name ORDER BY b.race_date, b.racecourse)
      )`;
    const TRIAL = `EXISTS (SELECT 1 FROM horse_trials t WHERE t.horse_name = w.horse_name AND t.trial_date > w.prev_date AND t.trial_date < w.race_date)`;
    const SEL = `SELECT w.race_date, w.racecourse, w.race_no, w.race_class, w.distance, w.horse_name,
      COALESCE(j.name_zh, w.jockey_id) jockey, w.trainer_name, w.draw, w.actual_weight,
      w.finish_position, w.win_odds,
      w.prev_date, w.prev_course, w.prev_pos, w.prev_dist, w.prev_class_num
      FROM w LEFT JOIN jockeys j ON j.id = w.jockey_id`;

    const defs = [
      { id: 1, title: '沈集成馬匹首次降班並配搭布文', note: '該馬紀錄內首次落班嗰場',
        sql: `${W}, w2 AS (SELECT w.*, MIN(CASE WHEN w.class_num > w.prev_class_num THEN w.race_date END) OVER (PARTITION BY w.horse_name) fd FROM w)
              SELECT w2.race_date, w2.racecourse, w2.race_no, w2.race_class, w2.distance, w2.horse_name,
              COALESCE(j.name_zh, w2.jockey_id) jockey, w2.trainer_name, w2.draw, w2.actual_weight,
              w2.finish_position, w2.win_odds, w2.prev_date, w2.prev_course, w2.prev_pos, w2.prev_dist, w2.prev_class_num
              FROM w2 LEFT JOIN jockeys j ON j.id = w2.jockey_id
              WHERE w2.class_num > w2.prev_class_num AND w2.race_date = w2.fd AND w2.race_date >= $1
                AND w2.trainer_name = '沈集成' AND w2.jockey_id = 'BH' ORDER BY w2.race_date DESC` },
      { id: 2, title: '廖康銘馬匹該馬紀錄內首次由潘頓執韁（排除香港初出）', note: '該馬紀錄內首次由潘頓執韁・該場練馬師廖康銘・非在港初出',
        sql: `${W}, firstpz AS (SELECT horse_name, MIN(race_date) fd FROM race_records WHERE jockey_id='PZ' AND horse_name IS NOT NULL GROUP BY horse_name)
              ${SEL} JOIN firstpz f ON f.horse_name = w.horse_name AND f.fd = w.race_date
              WHERE w.race_date >= $1 AND w.trainer_name='廖康銘' AND w.jockey_id='PZ'
                AND EXISTS (SELECT 1 FROM race_records p WHERE p.horse_name = w.horse_name AND p.race_date < w.race_date)
                ORDER BY w.race_date DESC` },
      { id: 3, title: '馬匹上仗前四・10日內再出換潘頓策騎', note: '上仗任意騎師跑前四・10日內再出嗰場轉潘頓',
        sql: `${W} ${SEL} WHERE w.race_date >= $1 AND w.jockey_id='PZ'
                AND w.prev_jockey IS NOT NULL AND w.prev_jockey <> 'PZ'
                AND w.prev_pos <= 4 AND w.race_date - w.prev_date <= 10 ORDER BY w.race_date DESC` },
      { id: 4, title: '羅富全馬匹 1200米 下場轉跑 1000米', note: '落注場 = 1000米嗰場',
        sql: `${W} ${SEL} WHERE w.race_date >= $1 AND w.trainer_name='羅富全'
                AND w.distance=1000 AND w.prev_dist=1200 ORDER BY w.race_date DESC` },
      { id: 5, title: '潘頓接手霍宏聲馬匹於谷草表現', note: '霍宏聲為騎師 — 上場由霍宏聲執韁・呢場轉潘頓',
        sql: `${W} ${SEL} WHERE w.race_date >= $1 AND w.jockey_id='PZ' AND w.prev_jockey='FEL'
                AND w.racecourse='HV' AND w.track_type='TURF' ORDER BY w.race_date DESC` },
      { id: 6, title: '方嘉柏馬匹田草三甲・下仗轉谷草配何澤堯', note: '落注場 = 谷草嗰場',
        sql: `${W} ${SEL} WHERE w.race_date >= $1 AND w.racecourse='HV' AND w.jockey_id='HCY'
                AND w.prev_trainer='方嘉柏' AND w.prev_course='ST' AND w.prev_pos <= 3 ORDER BY w.race_date DESC` },
      { id: 7, title: '巫偉傑馬匹上名後下仗增程轉跑谷草', note: '落注場 = 谷草增程嗰場',
        sql: `${W} ${SEL} WHERE w.race_date >= $1 AND w.trainer_name='巫偉傑' AND w.racecourse='HV'
                AND w.distance > w.prev_dist AND w.prev_trainer='巫偉傑' AND w.prev_pos <= 3
                AND w.prev_course <> 'HV' ORDER BY w.race_date DESC` },
      { id: 8, title: '潘頓田草 1600米 排1-4檔', note: '⚠ 資料庫未存欄位（C/C+3），暫以全欄位統計',
        sql: `${W} ${SEL} WHERE w.race_date >= $1 AND w.jockey_id='PZ' AND w.racecourse='ST'
                AND w.track_type='TURF' AND w.distance=1600 AND w.draw BETWEEN 1 AND 4 ORDER BY w.race_date DESC` },
      { id: 9, title: '大衛希斯馬匹入前四・下仗換潘頓負磅≤130', note: '上仗唔係潘頓執韁先算「換」',
        sql: `${W} ${SEL} WHERE w.race_date >= $1 AND w.jockey_id='PZ' AND w.actual_weight <= 130
                AND w.prev_trainer='大衛希斯' AND w.prev_pos <= 4
                AND w.prev_jockey IS NOT NULL AND w.prev_jockey <> 'PZ' ORDER BY w.race_date DESC` },
      { id: 10, title: '呂健威馬匹相隔一個月・換何澤堯・賽前有試閘', note: '相隔≥30日・試閘喺兩場之間',
        sql: `${W} ${SEL} WHERE w.race_date >= $1 AND w.trainer_name='呂健威' AND w.jockey_id='HCY'
                AND w.prev_jockey IS NOT NULL AND w.prev_jockey <> 'HCY'
                AND w.race_date - w.prev_date >= 30 AND ${TRIAL} ORDER BY w.race_date DESC` },
      { id: 11, title: '潘頓田草四班1600米・130磅或以下・排1-4檔', note: '⚠ 資料庫未存欄位（C欄），暫以全欄位統計',
        sql: `${W} ${SEL} WHERE w.race_date >= $1 AND w.jockey_id='PZ' AND w.racecourse='ST'
                AND w.track_type='TURF' AND w.distance=1600 AND w.race_class IN ('第四班','4')
                AND w.actual_weight <= 130 AND w.draw BETWEEN 1 AND 4 ORDER BY w.race_date DESC` },
      { id: 12, title: '巫偉傑馬匹上仗三甲・再出抽≤4檔兼賽前有試閘', note: '試閘喺兩場之間',
        sql: `${W} ${SEL} WHERE w.race_date >= $1 AND w.trainer_name='巫偉傑' AND w.draw <= 4
                AND w.prev_trainer='巫偉傑' AND w.prev_pos <= 3 AND ${TRIAL} ORDER BY w.race_date DESC` },
      { id: 13, title: '沈集成馬匹首次升班', note: '該馬紀錄內首次升班嗰場（#1 嘅鏡像訊號）',
        sql: `${W}, w2 AS (SELECT w.*, MIN(CASE WHEN w.class_num < w.prev_class_num THEN w.race_date END) OVER (PARTITION BY w.horse_name) fd FROM w)
              SELECT w2.race_date, w2.racecourse, w2.race_no, w2.race_class, w2.distance, w2.horse_name,
              COALESCE(j.name_zh, w2.jockey_id) jockey, w2.trainer_name, w2.draw, w2.actual_weight,
              w2.finish_position, w2.win_odds, w2.prev_date, w2.prev_course, w2.prev_pos, w2.prev_dist, w2.prev_class_num
              FROM w2 LEFT JOIN jockeys j ON j.id = w2.jockey_id
              WHERE w2.class_num < w2.prev_class_num AND w2.race_date = w2.fd AND w2.race_date >= $1
                AND w2.trainer_name = '沈集成' ORDER BY w2.race_date DESC` },
      { id: 14, title: '谷草1200米轉跑谷草1000米', note: '落注場 = 1000米嗰場',
        sql: `${W} ${SEL} WHERE w.race_date >= $1 AND w.racecourse='HV' AND w.distance=1000
                AND w.prev_course='HV' AND w.prev_dist=1200 ORDER BY w.race_date DESC` },
      { id: 15, title: '布文接手（上場非布文）+負磅≤128', note: '落注場 = 布文嗰場',
        sql: `${W} ${SEL} WHERE w.race_date >= $1 AND w.jockey_id='BH'
                AND w.prev_jockey IS NOT NULL AND w.prev_jockey <> 'BH'
                AND w.actual_weight <= 128 ORDER BY w.race_date DESC` },
      { id: 16, title: '田草三甲・轉谷草同程', note: '落注場 = 谷草同程嗰場',
        sql: `${W} ${SEL} WHERE w.race_date >= $1 AND w.racecourse='HV' AND w.prev_course='ST'
                AND w.prev_dist = w.distance AND w.prev_pos <= 3 ORDER BY w.race_date DESC` },
      { id: 17, title: '潘頓上場贏馬後再出', note: '連勝氣勢訊號',
        sql: `${W} ${SEL} WHERE w.race_date >= $1 AND w.jockey_id='PZ' AND w.prev_jockey='PZ'
                AND w.prev_pos = 1 ORDER BY w.race_date DESC` },
      { id: 18, title: '潘頓田草排1-3檔', note: '#8 擴闊版（不限途程）',
        sql: `${W} ${SEL} WHERE w.race_date >= $1 AND w.jockey_id='PZ' AND w.racecourse='ST'
                AND w.track_type='TURF' AND w.draw BETWEEN 1 AND 3 ORDER BY w.race_date DESC` },
    ];

    const out = [];
    for (const d of defs) {
      try {
        const { rows } = await pool.query(d.sql, [from]);
        const n = rows.length;
        const wins = rows.filter(r => r.finish_position === 1).length;
        const top3 = rows.filter(r => r.finish_position != null && r.finish_position <= 3).length;
        const top4 = rows.filter(r => r.finish_position != null && r.finish_position <= 4).length;
        const withOdds = rows.filter(r => r.win_odds != null);
        const roi = withOdds.length
          ? +(withOdds.reduce((s, r) => s + (r.finish_position === 1 ? +r.win_odds - 1 : -1), 0) / withOdds.length).toFixed(4)
          : null;
        out.push({
          id: d.id, title: d.title, note: d.note, rows,
          summary: { n, wins, top3, top4,
            winRate: n ? +(wins / n).toFixed(4) : null,
            placeRate: n ? +(top3 / n).toFixed(4) : null, roi },
        });
      } catch (e) {
        out.push({ id: d.id, title: d.title, note: d.note, error: e.message.slice(0, 120), rows: [], summary: null });
      }
    }
    res.json({ from, queries: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI數據：下個賽日符合預告（排位表更新後即時反映）────────────────────────
app.get('/api/ai-data/upcoming', async (req, res) => {
  try {
    // 1) 下個賽日 + 該日排位
    const nd = await pool.query(
      'SELECT DISTINCT race_date FROM racecard WHERE race_date >= CURRENT_DATE ORDER BY 1 LIMIT 1');
    if (!nd.rows.length) return res.json({ raceDate: null, matches: [] });
    const raceDate = nd.rows[0].race_date;
    const { rows: entries } = await pool.query(
      `SELECT race_no, race_class, distance, track_type, racecourse, draw, horse_name,
              jockey_id, jockey_name, trainer_name, actual_weight
       FROM racecard WHERE race_date = $1 ORDER BY race_no, draw`, [raceDate]);

    // 2) 每馬歷史（最近 6 場） + 試閘
    const histMap = new Map();
    const trialMap = new Map();
    for (const e of entries) {
      if (!e.horse_name) continue;
      const h = await pool.query(
        `SELECT race_date, racecourse, track_type, distance, jockey_id, finish_position,
                trainer_name, race_class, race_no, win_odds
         FROM race_records WHERE horse_name = $1 ORDER BY race_date DESC, racecourse`,
        [e.horse_name]);
      histMap.set(e.horse_name, h.rows);
      const t = await pool.query(
        'SELECT trial_date FROM horse_trials WHERE horse_name = $1 ORDER BY trial_date DESC LIMIT 5',
        [e.horse_name]);
      trialMap.set(e.horse_name, t.rows);
    }

    const classNum = c => ({ '第一班': 1, '1': 1, 'G1': 1, '第二班': 2, '2': 2, 'G2': 2,
      '第三班': 3, '3': 3, 'G3': 3, '第四班': 4, '4': 4, '第五班': 5, '5': 5 }[c] || null);

    const SIGNALS = [
      { id: 1, title: '沈集成首次降班+布文', test: (e, last, hist) =>
        e.trainer_name === '沈集成' && e.jockey_id === 'BH' && last &&
        classNum(e.race_class) && classNum(last.race_class) &&
        classNum(e.race_class) > classNum(last.race_class) &&
        !hist.some((r, i) => i < hist.length - 1 && classNum(r.race_class) && classNum(hist[i + 1].race_class) && classNum(r.race_class) > classNum(hist[i + 1].race_class)) },
      { id: 2, title: '廖康銘馬匹首次由潘頓執韁（非初出）', test: (e) => {
        const hist = histMap.get(e.horse_name) || [];
        if (!hist.length) return false; // 在港初出 → 排除
        return e.trainer_name === '廖康銘' && e.jockey_id === 'PZ' &&
          !hist.some(r => r.jockey_id === 'PZ');
      } },
      { id: 3, title: '馬匹上仗前四・10日內再出換潘頓', test: (e, last) => {
        if (!last || e.jockey_id !== 'PZ') return false;
        if (!last.jockey_id || last.jockey_id === 'PZ') return false;
        if (!(last.finish_position <= 4)) return false;
        const days = (new Date(raceDate) - new Date(last.race_date)) / 86400000;
        return days <= 10;
      } },
      { id: 4, title: '羅富全 1200→1000', test: (e, last) =>
        e.trainer_name === '羅富全' && e.distance === 1000 && last && last.distance === 1200 },
      { id: 5, title: '潘頓接手霍宏聲馬匹（谷草）', test: (e, last) =>
        e.jockey_id === 'PZ' && last && last.jockey_id === 'FEL' &&
        e.racecourse === 'HV' && e.track_type === 'TURF' },
      { id: 6, title: '方嘉柏田草三甲→谷草何澤堯', test: (e, last) =>
        e.racecourse === 'HV' && e.jockey_id === 'HCY' && last &&
        last.trainer_name === '方嘉柏' && last.racecourse === 'ST' && last.finish_position <= 3 },
      { id: 7, title: '巫偉傑上名增程轉谷草', test: (e, last) =>
        e.trainer_name === '巫偉傑' && e.racecourse === 'HV' && last &&
        last.trainer_name === '巫偉傑' && last.finish_position <= 3 &&
        last.racecourse !== 'HV' && e.distance > last.distance },
      { id: 8, title: '潘頓田草1600米1-4檔', test: (e) =>
        e.jockey_id === 'PZ' && e.racecourse === 'ST' && e.track_type === 'TURF' &&
        e.distance === 1600 && e.draw >= 1 && e.draw <= 4 },
      { id: 9, title: '大衛希斯前四→換潘頓≤130磅', test: (e, last) => {
        if (e.jockey_id !== 'PZ' || +e.actual_weight > 130) return false;
        if (!last || last.trainer_name !== '大衛希斯' || !(last.finish_position <= 4)) return false;
        return last.jockey_id && last.jockey_id !== 'PZ';
      } },
      { id: 10, title: '呂健威隔月+何澤堯+試閘', test: (e, last) => {
        if (!last || e.trainer_name !== '呂健威' || e.jockey_id !== 'HCY') return false;
        if (!last.jockey_id || last.jockey_id === 'HCY') return false;
        const days = (new Date(raceDate) - new Date(last.race_date)) / 86400000;
        if (days < 30) return false;
        return (trialMap.get(e.horse_name) || []).some(t =>
          new Date(t.trial_date) > new Date(last.race_date) && new Date(t.trial_date) < new Date(raceDate));
      } },
      { id: 11, title: '潘頓田草四班1600・≤130磅・1-4檔', test: (e) =>
        e.jockey_id === 'PZ' && e.racecourse === 'ST' && e.track_type === 'TURF' &&
        e.distance === 1600 && ['第四班', '4'].includes(e.race_class) &&
        +e.actual_weight <= 130 && e.draw >= 1 && e.draw <= 4 },
      { id: 12, title: '巫偉傑三甲+≤4檔+試閘', test: (e, last) => {
        if (!last || e.trainer_name !== '巫偉傑' || !(e.draw <= 4)) return false;
        if (last.trainer_name !== '巫偉傑' || !(last.finish_position <= 3)) return false;
        return (trialMap.get(e.horse_name) || []).some(t =>
          new Date(t.trial_date) > new Date(last.race_date) && new Date(t.trial_date) < new Date(raceDate));
      } },
      { id: 13, title: '沈集成首次升班', test: (e, last, hist) => {
        if (!last || e.trainer_name !== '沈集成') return false;
        const cnNow = classNum(e.race_class), cnPrev = classNum(last.race_class);
        if (!cnNow || !cnPrev || !(cnNow < cnPrev)) return false;
        return !hist.some((r, i) => i < hist.length - 1 && classNum(r.race_class) && classNum(hist[i + 1].race_class)
          && classNum(r.race_class) < classNum(hist[i + 1].race_class));
      } },
      { id: 14, title: '谷草1200→1000', test: (e, last) =>
        e.racecourse === 'HV' && e.distance === 1000 && last && last.racecourse === 'HV' && last.distance === 1200 },
      { id: 15, title: '布文接手≤128磅', test: (e, last) =>
        e.jockey_id === 'BH' && last && last.jockey_id && last.jockey_id !== 'BH' && +e.actual_weight <= 128 },
      { id: 16, title: '田草三甲轉谷草同程', test: (e, last) =>
        e.racecourse === 'HV' && last && last.racecourse === 'ST' && last.distance === e.distance && last.finish_position <= 3 },
      { id: 17, title: '潘頓上場贏馬後再出', test: (e, last) =>
        e.jockey_id === 'PZ' && last && last.jockey_id === 'PZ' && last.finish_position === 1 },
      { id: 18, title: '潘頓田草1-3檔', test: (e) =>
        e.jockey_id === 'PZ' && e.racecourse === 'ST' && e.track_type === 'TURF' && e.draw >= 1 && e.draw <= 3 },
    ];

    const matches = [];
    for (const sig of SIGNALS) {
      const hits = [];
      for (const e of entries) {
        const hist = histMap.get(e.horse_name) || [];
        const last = hist[0] || null;
        try { if (sig.test(e, last, hist)) hits.push(e); } catch (_) {}
      }
      if (hits.length) matches.push({ id: sig.id, title: sig.title, entries: hits });
    }
    res.json({ raceDate, total: entries.length, matches });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/corner/schedule', async (req, res) => {
  try {
    if (!schedCache.data || Date.now() - schedCache.at > 30 * 60 * 1000) {
      const ms = await scrapeSchedule(10);
      const fits = {};
      for (const lg of ['EPL', 'BUN', 'LAL', 'MLS']) {
        try { fits[lg] = await getFit(lg); } catch (_) { fits[lg] = null; }
      }
      schedCache = {
        at: Date.now(),
        data: ms.map(m => {
          const o = { ...m };
          const entry = fits[m.league];
          if (entry) {
            try {
              const g = cornerlib.predictGoals(entry.fit, m.home, m.away, {}, 6000);
              if (!g.error) {
                o.expGoals = g.expGoals;
                o.btts = g.btts;
                o.over25 = g.probs ? g.probs['2.5'] : null;
              }
            } catch (_) {}
            try {
              const c = cornerlib.predict(entry.fit, entry.stateMul.m, m.home, m.away, 6000);
              if (!c.error) {
                o.expCorners = c.expCorners;
                o.over95 = c.probs ? c.probs['9.5'] : null;
              }
            } catch (_) {}
          }
          return o;
        }),
      };
    }
    // 顯示名轉繁體（保留 home/away 原名俈 match-detail 用）
    const { tcOne: scTc, refreshTcMap: scRtm } = require('./football/tcNames');
    await scRtm();
    const dataTc = schedCache.data.map(m => ({ ...m, homeTc: scTc(m.home), awayTc: scTc(m.away) }));
    res.json({ count: dataTc.length, matches: dataTc, cachedAt: schedCache.at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 數據覆蓋概覽
app.get('/api/corner/leagues', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT league, season, COUNT(*) matches,
              TO_CHAR(MIN(match_date),'YYYY-MM-DD') from_d,
              TO_CHAR(MAX(match_date),'YYYY-MM-DD') to_d,
              ROUND(AVG(home_corners+away_corners)::numeric,1) avg_corners,
              ROUND(AVG(home_goals+away_goals)::numeric,2) avg_goals
       FROM football_matches GROUP BY 1,2 ORDER BY 1,2 DESC`);
    res.json({ leagues: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 角球模型（time-slicing + game state）─────────────────────────────────────
const cornerlib = require('./football/cornerlib');

// 模型快取（10 分鐘 TTL；有新數據自動失效）
const cornerFitCache = new Map();
async function getFit(league) {
  const hit = cornerFitCache.get(league);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit;
  const data = await cornerlib.loadLeague(league);
  if (!data || data.length < 40) return null;
  const fit = cornerlib.fitModel(data);
  const stateMul = cornerlib.fitStateMultipliers(data);
  const entry = { at: Date.now(), fit, stateMul, teams: fit.teams, n: data.length };
  cornerFitCache.set(league, entry);
  return entry;
}

// 球隊清單
app.get('/api/corner/teams', async (req, res) => {
  const { league } = req.query;
  if (!league) return res.status(400).json({ error: '需要 league' });
  try {
    const { rows } = await pool.query(
      `SELECT team, COUNT(*) matches, SUM(corners)::numeric corners, ROUND(AVG(corners)::numeric,2) avg_c
       FROM (
         SELECT home_team team, home_corners corners FROM football_matches WHERE league=$1 AND home_corners IS NOT NULL
         UNION ALL
         SELECT away_team, away_corners FROM football_matches WHERE league=$1 AND away_corners IS NOT NULL
       ) x GROUP BY team HAVING COUNT(*) >= 3 ORDER BY avg_c DESC`, [league]);
    res.json({ league, teams: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 預測
app.get('/api/corner/predict', async (req, res) => {
  const { league, home, away } = req.query;
  if (!league || !home || !away) return res.status(400).json({ error: '需要 league, home, away' });
  try {
    const entry = await getFit(league);
    if (!entry) return res.status(404).json({ error: '數據不足（起碼 40 場）— 先抓數據' });
    const r = cornerlib.predict(entry.fit, entry.stateMul.m, home, away, 20000);
    if (r.error) return res.status(404).json(r);
    r.stateMultipliers = entry.stateMul.m;
    r.sample = entry.n;
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 單場詳細預測（入球 + 角球合并）─────────────────────────────────────────
app.get('/api/corner/match-detail', async (req, res) => {
  const { league, home, away } = req.query;
  if (!league || !home || !away) return res.status(400).json({ error: '需要 league, home, away' });
  try {
    const entry = await getFit(league);
    if (!entry) return res.status(404).json({ error: '數據不足' });
    const goals = cornerlib.predictGoals(entry.fit, home, away, {}, 20000);
    const corners = cornerlib.predict(entry.fit, entry.stateMul.m, home, away, 20000);
    const gExp = goals.error ? null : cornerlib.expGoalsByTeam(entry.fit, home, away, {});
    const g = goals.error ? null : {
      expGoals: goals.expGoals, expHome: gExp?.home, expAway: gExp?.away,
      probs: goals.probs, btts: goals.btts, dist: goals.dist, sample: goals.sample,
    };
    const c = corners.error ? null : {
      expCorners: corners.expCorners, expHome: corners.expHome, expAway: corners.expAway,
      probs: corners.probs, bySlice: corners.bySlice, dist: corners.dist,
    };
    res.json({ league, home, away, goals: g, corners: c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 主客和分析：百家初盤 + SD/CV ─────────────────────────────────────────────
const { scrape1x2, stats: oddsStats } = require('./football/titan1x2');
const hdaService = require('./football/hdaService');
const hdaDaily = require('./jobs/hdaDaily');
hdaDaily.start();

// GET /api/hda/track-stats — 三色賽事獨立統計（Y黃/G綠/B藍）
app.get('/api/hda/track-stats', async (req, res) => {
  try {
    const agg = await pool.query(
      `SELECT color, COUNT(*) total,
              COUNT(result) settled,
              SUM(CASE WHEN result = side THEN 1 ELSE 0 END) hits
       FROM hda_track GROUP BY color`);
    const { rows: detail } = await pool.query(
      `SELECT t.fb, t.color, t.match_date, t.kickoff, t.home, t.away, t.side, t.odds, t.n, t.rate, t.roi,
              t.result, t.home_goals, t.away_goals, t.settled_at, t.ah_line, t.odds AS ah_odds2,
              t.ah_odds, t.ah_result, t.ah_away_line, t.ah_away_odds, t.league,
              t.odds_h, t.odds_d, t.odds_a, t.sd, t.cv,
              t.sd_h, t.sd_d, t.sd_a, t.cv_h, t.cv_d, t.cv_a,
              t.rate_h, t.rate_d, t.rate_a, t.roi_h, t.roi_d, t.roi_a,
              COALESCE(t.bench_src, CASE WHEN h.fb IS NOT NULL THEN 'HK33' ELSE 'sim' END) AS bench
       FROM hda_track t
       LEFT JOIN hk33_had h ON h.fb = t.fb AND (h.data->>'rateH') IS NOT NULL
       ORDER BY (t.match_date::text || ' ' || COALESCE(t.kickoff, '00:00')) DESC, t.fb DESC LIMIT 1000`);
    const byColor = { Y: null, G: null, B: null };
    for (const r of agg.rows) {
      byColor[r.color] = {
        total: +r.total, settled: +r.settled, hits: +r.hits,
        hitRate: +r.settled ? +(r.hits / r.settled).toFixed(4) : null,
      };
    }
    // 分 benchmark 來源（捕捉時鎖定嘅 bench_src）
    const bench = await pool.query(
      `SELECT color, COALESCE(bench_src, 'sim') AS bench,
         COUNT(*) n, SUM((result = side)::int) hits
       FROM hda_track
       WHERE result IS NOT NULL
       GROUP BY 1, 2`);
    const byBench = {};
    for (const r of bench.rows) {
      byBench[`${r.color}:${r.bench}`] = { n: +r.n, hits: +r.hits, hitRate: +(r.hits / r.n).toFixed(4) };
    }
    // 顯示名轉繁體
    const { tcOne, refreshTcMap } = require('./football/tcNames');
    await refreshTcMap();
    const detailTc = detail.map(r => ({ ...r, home: tcOne(r.home), away: tcOne(r.away) }));
    res.json({ byColor, byBench, matches: detailTc, job: hdaDaily.jobState });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/hda/yellow-stats — 兼容舊名
app.get('/api/hda/yellow-stats', async (req, res) => {
  try { res.redirect('/api/hda/track-stats'); } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/hda/settle — 輕量結算（只結賽果+亞洲盤・唔跑全套）
app.post('/api/hda/settle', async (req, res) => {
  try {
    const settled = await hdaDaily.settleYellows();
    const ah = await hdaDaily.fillAh();
    res.json({ ok: true, settled, ah });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/hda/daily-run — 手動觸發每日更新
app.post('/api/hda/daily-run', async (req, res) => {
  try { res.json(await hdaDaily.runDaily()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/hda/yellow-resettle — 清除並重新結算三色賽果（時間+隊名配對）
app.post('/api/hda/yellow-resettle', async (req, res) => {
  try {
    await pool.query('UPDATE hda_track SET result=NULL, home_goals=NULL, away_goals=NULL, settled_at=NULL');
    const settled = await hdaDaily.settleYellows(true);
    res.json({ ok: true, settled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 歷史初盤回查 ────────────────────────────────────────────────────────────
// ── 歷史統計 Backtest（完全獨立・唔掂 hda_track）────────────────────────────
// 用 had_odds 全部歷史重跑黃/綠檢測
let btCache = { at: 0, data: null };
app.get('/api/hda/backtest-track', async (req, res) => {
  try {
    if (btCache.data && Date.now() - btCache.at < 30 * 60 * 1000) return res.json(btCache.data);
    const { rows } = await pool.query(
      `SELECT titan_id, league_cn, match_date, home_team, away_team,
              open_h, open_d, open_a, sd_h, sd_d, sd_a, cv_h, cv_d, cv_a, result,
              home_goals, away_goals
       FROM had_odds
       WHERE result IS NOT NULL AND open_h IS NOT NULL AND open_d IS NOT NULL AND open_a IS NOT NULL
         AND sd_h IS NOT NULL
       ORDER BY match_date`);
    const TOL = 0.10;
    const R = rows.map(r => ({
      ...r,
      h: +r.open_h, d: +r.open_d, a: +r.open_a,
      sd: [+r.sd_h, +r.sd_d, +r.sd_a], cv: [+r.cv_h, +r.cv_d, +r.cv_a],
    }));
    const yellowMatches = [], greenMatches = [], deepMatches = [];
    for (const m of R) {
      let n = 0, cH = 0, cD = 0, cA = 0;
      for (const x of R) {
        if (Math.abs(x.h - m.h) > m.h * TOL) continue;
        if (Math.abs(x.d - m.d) > m.d * TOL) continue;
        if (Math.abs(x.a - m.a) > m.a * TOL) continue;
        n++;
        if (x.result === 'H') cH++; else if (x.result === 'D') cD++; else cA++;
      }
      if (n < 30) continue;
      const rates = [cH / n, cD / n, cA / n];
      const rois = [rates[0] * m.h - 1, rates[1] * m.d - 1, rates[2] * m.a - 1];
      const y = hdaService.detectYellow(m.h, m.d, m.a, m.sd, m.cv, n, rates, rois);
      const gb = hdaService.detectGreenBlue(m.h, m.d, m.a, m.sd, m.cv, rates, rois, n);
      const base = {
        titan_id: m.titan_id, date: m.match_date, league: m.league_cn,
        home: m.home_team, away: m.away_team, result: m.result,
        home_goals: m.home_goals, away_goals: m.away_goals,
      };
      if (y) yellowMatches.push({ ...base, side: y.side, odds: [m.h, m.d, m.a][y.idx], n, rate: rates[y.idx], roi: rois[y.idx] });
      if (gb.green) greenMatches.push({ ...base, side: gb.green.side, odds: [m.h, m.d, m.a][gb.green.idx], n, rate: rates[gb.green.idx], roi: rois[gb.green.idx] });
      if (gb.deep) deepMatches.push({ ...base, side: gb.deep.side, odds: [m.h, m.d, m.a][gb.deep.idx], n, rate: rates[gb.deep.idx], roi: rois[gb.deep.idx], gap: gb.deep.exp - gb.deep.rate });
    }
    const agg = list => {
      const settled = list.filter(x => x.result);
      const hits = settled.filter(x => x.result === x.side).length;
      const profit = settled.reduce((s, x) => s + (x.result === x.side ? x.odds - 1 : -1), 0);
      return {
        total: list.length, settled: settled.length, hits,
        hitRate: settled.length ? +(hits / settled.length).toFixed(4) : null,
        roi: settled.length ? +(profit / settled.length).toFixed(4) : null,
      };
    };
    const { tcOne: btTc, refreshTcMap: btRtm } = require('./football/tcNames');
    await btRtm();
    const tcList = list => list.map(y => ({ ...y, home: btTc(y.home), away: btTc(y.away) }));
    const data = {
      sample: R.length,
      yellow: agg(yellowMatches), green: agg(greenMatches), deep: agg(deepMatches),
      yellowMatches: tcList(yellowMatches).sort((a, b) => String(b.date).localeCompare(String(a.date))),
      greenMatches: tcList(greenMatches).sort((a, b) => String(b.date).localeCompare(String(a.date))),
      deepMatches: tcList(deepMatches).sort((a, b) => String(b.date).localeCompare(String(a.date))),
    };
    btCache = { at: Date.now(), data };
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/hda/ah — 手動補/改一場嘅馬會亞洲盤 + 重計讓球勝負
app.patch('/api/hda/ah', async (req, res) => {
  const { fb, color, ahLine, ahOdds, ahAwayLine, ahAwayOdds } = req.body || {};
  if (!fb || !ahLine) return res.status(400).json({ error: '需要 fb, ahLine' });
  try {
    const { rows } = await pool.query(
      'SELECT fb, color, side, result, home_goals, away_goals FROM hda_track WHERE fb=$1 AND color=COALESCE($2, color)',
      [fb, color || null]);
    console.log('[hda/ah] SELECT rows:', rows.length, JSON.stringify(rows));
    if (!rows.length) return res.status(404).json({ error: '搵唔到該場' });
    for (const r of rows) {
      const { ahOutcome } = require('./football/hkjcFootball');
      let ahResult = null;
      if (r.result && r.home_goals != null) {
        const line = r.side === 'A' ? (ahAwayLine || ahLine) : ahLine;
        const hg = r.side === 'A' ? r.away_goals : r.home_goals;
        const ag = r.side === 'A' ? r.home_goals : r.away_goals;
        ahResult = ahOutcome(line, hg, ag);
      }
      await pool.query(
        `UPDATE hda_track SET ah_line=$1, ah_odds=$2, ah_away_line=$3, ah_away_odds=$4, ah_result=$5
         WHERE fb=$6 AND color=$7`,
        [ahLine, ahOdds ?? null, ahAwayLine ?? null, ahAwayOdds ?? null, ahResult, fb, r.color],
      ).then(u => console.log('[hda/ah] UPDATE rowCount:', u.rowCount, 'color=', r.color));
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/hda/unmatched — 未配對到 titan 嘅球隊名（outstanding list）
app.get('/api/hda/unmatched', async (req, res) => {
  try {
    const { rows: up } = await pool.query(
      `SELECT DISTINCT home, away, date, leaguecn FROM (
         SELECT home, away, match_date::text date, league AS leaguecn FROM hda_track WHERE titan_id IS NULL
         UNION
         SELECT home_team, away_team, match_date::text, league_cn FROM had_odds WHERE titan_id IS NULL AND odds_src = 'HKJC'
       ) t ORDER BY date DESC LIMIT 50`);
    // 過濾已配到嘅
    const { rows: aliases } = await pool.query('SELECT hkjc_name FROM team_alias');
    const aliasSet = new Set(aliases.map(r => r.hkjc_name));
    const unmatched = [];
    const seen = new Set();
    for (const r of up) {
      for (const team of [r.home, r.away]) {
        if (!team || seen.has(team) || aliasSet.has(team)) continue;
        seen.add(team);
        unmatched.push({ name: team, date: r.date, league: r.leaguecn });
      }
    }
    res.json({ unmatched: unmatched.slice(0, 30) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/hda/alias — 手動加 alias（用戶輸入 titan 譯名）
app.post('/api/hda/alias', async (req, res) => {
  const { hkjc, titan } = req.body || {};
  if (!hkjc || !titan) return res.status(400).json({ error: '需要 hkjc, titan' });
  try {
    await pool.query('INSERT INTO team_alias (hkjc_name, titan_name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [hkjc, titan]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/hda/auto-alias — 自動搜尋 titan007 譯名入 alias
app.post('/api/hda/auto-alias', async (req, res) => {
  try {
    const { autoResolve } = require('./football/autoAlias');
    const results = await autoResolve();
    res.json({ ok: true, resolved: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/hda/green-regression — 綠格回歸實驗（獨立・唔影響主統計）
app.get('/api/hda/green-regression', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT g.*, t.home, t.away, t.match_date, t.kickoff, t.league
       FROM hda_green_regression g
       LEFT JOIN hda_track t ON t.fb = g.fb AND t.color = 'G'
       ORDER BY g.captured_at DESC LIMIT 300`);
    const agg = await pool.query(
      `SELECT regressed, bench, COUNT(*) n,
              SUM(CASE WHEN hit THEN 1 ELSE 0 END) hits,
              ROUND(AVG(open_exp)::numeric, 4) avg_open_exp,
              ROUND(AVG(COALESCE(close_exp, open_exp))::numeric, 4) avg_close_exp
       FROM hda_green_regression WHERE settled_at IS NOT NULL
       GROUP BY regressed, bench`);
    // 歷史回測（507 場）：開盤 vs 收盤隱含・walk-forward 綠格檢測
    let backtest = null;
    try {
      const { rows: R } = await pool.query(
        `SELECT open_h, open_d, open_a, live_h, live_d, live_a,
                sd_h, sd_d, sd_a, cv_h, cv_d, cv_a, result
         FROM had_odds
         WHERE result IS NOT NULL AND open_h IS NOT NULL AND sd_h IS NOT NULL AND live_h IS NOT NULL
         ORDER BY match_date`);
      const TOL = 0.10;
      const H = R.map(r => ({
        o: [+r.open_h, +r.open_d, +r.open_a], l: [+r.live_h, +r.live_d, +r.live_a],
        sd: [+r.sd_h, +r.sd_d, +r.sd_a], cv: [+r.cv_h, +r.cv_d, +r.cv_a], result: r.result,
      }));
      const inv = t => { const s = 1/t[0]+1/t[1]+1/t[2]; return t.map(x => (1/x)/s); };
      const history = [];
      const reg = [], noReg = [];
      for (const m of H) {
        let n = 0, c = [0, 0, 0];
        for (const x of history) {
          if (Math.abs(x.o[0] - m.o[0]) > m.o[0] * TOL) continue;
          if (Math.abs(x.o[1] - m.o[1]) > m.o[1] * TOL) continue;
          if (Math.abs(x.o[2] - m.o[2]) > m.o[2] * TOL) continue;
          n++;
          c['HDA'.indexOf(x.result)]++;
        }
        if (n >= 30) {
          const rates = c.map(x => x / n);
          const rois = rates.map((r, i) => r * m.o[i] - 1);
          const g = hdaService.detectGreenBlue(m.o[0], m.o[1], m.o[2], m.sd, m.cv, rates, rois, n).green;
          if (g) {
            const openExp = inv(m.o)[g.idx], closeExp = inv(m.l)[g.idx];
            const row = { hit: 'HDA'.indexOf(m.result) === g.idx, openExp, closeExp };
            (closeExp < openExp - 0.01 ? reg : noReg).push(row);
          }
        }
        history.push(m);
      }
      const mk = arr => {
        const n = arr.length;
        return {
          n, hits: arr.filter(x => x.hit).length,
          hitRate: n ? +(arr.filter(x => x.hit).length / n).toFixed(4) : null,
          avgOpenExp: +(arr.reduce((s, x) => s + x.openExp, 0) / (n || 1)).toFixed(4),
          avgCloseExp: +(arr.reduce((s, x) => s + x.closeExp, 0) / (n || 1)).toFixed(4),
        };
      };
      backtest = { regressed: mk(reg), noRegressed: mk(noReg), total: reg.length + noReg.length };
    } catch (_) {}
    res.json({ rows, agg: agg.rows, backtest });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/hda/history?from=&to=&q=&limit=
app.get('/api/hda/history', async (req, res) => {
  try {
    const { from, to, q } = req.query;
    const limit = Math.min(+req.query.limit || 300, 5000);
    const conds = ["open_h IS NOT NULL"]; // 顯示所有場次（包未完）
    const params = [];
    if (from) { params.push(from); conds.push(`match_date >= $${params.length}`); }
    if (to) { params.push(to); conds.push(`match_date <= $${params.length}`); }
    if (q) { params.push(`%${q}%`); conds.push(`(home_team ILIKE $${params.length} OR away_team ILIKE $${params.length} OR league ILIKE $${params.length} OR league_cn ILIKE $${params.length})`); }
    const { rows } = await pool.query(
      `SELECT titan_id, league, league_cn, match_date, home_team, away_team, n_books,
              open_h, open_d, open_a, live_h, live_d, live_a,
              sd_h, sd_d, sd_a, cv_h, cv_d, cv_a, home_goals, away_goals, result
       FROM had_odds WHERE ${conds.join(' AND ')}
       ORDER BY match_date DESC, titan_id DESC LIMIT ${limit}`, params);
    // 一次過載入全庫做相似統計（同 backtest 一致・±15%）
    const { rows: pool1 } = await pool.query(
      `SELECT open_h h, open_d d, open_a a, result FROM had_odds
       WHERE result IS NOT NULL AND open_h IS NOT NULL`);
    const TOL = 0.10;
    const withSim = rows.map(m => {
      const h = +m.open_h, d = +m.open_d, a = +m.open_a;
      let n = 0, cH = 0, cD = 0, cA = 0;
      for (const x of pool1) {
        if (Math.abs(x.h - h) > h * TOL) continue;
        if (Math.abs(x.d - d) > d * TOL) continue;
        if (Math.abs(x.a - a) > a * TOL) continue;
        n++;
        if (x.result === 'H') cH++; else if (x.result === 'D') cD++; else cA++;
      }
      const rateH = n ? cH / n : null, rateD = n ? cD / n : null, rateA = n ? cA / n : null;
      return {
        ...m,
        sim: n ? {
          n, rateH, rateD, rateA,
          roiH: rateH * h - 1, roiD: rateD * d - 1, roiA: rateA * a - 1,
        } : null,
      };
    });
    // 顯示名轉繁體
    const { tcOne, refreshTcMap: rtm } = require('./football/tcNames');
    await rtm();
    const withSimTc = withSim.map(m => ({ ...m, home_team: tcOne(m.home_team), away_team: tcOne(m.away_team) }));
    res.json({ count: withSimTc.length, matches: withSimTc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Pattern 統計分析（基於 had_odds 全庫）───────────────────────────────────
// GET /api/hda/patterns
app.get('/api/hda/patterns', async (req, res) => {
  try {
    const SIDE_VIEW = `
      WITH s AS (
        SELECT 'H' side, open_h odds, sd_h sd, cv_h cv, live_h live, result FROM had_odds WHERE result IS NOT NULL AND open_h IS NOT NULL
        UNION ALL SELECT 'D', open_d, sd_d, cv_d, live_d, result FROM had_odds WHERE result IS NOT NULL AND open_d IS NOT NULL
        UNION ALL SELECT 'A', open_a, sd_a, cv_a, live_a, result FROM had_odds WHERE result IS NOT NULL AND open_a IS NOT NULL
      )`;
    const roiExpr = `AVG((result=side)::int * odds) - 1`;

    // 1. 賠率區間 × 主/和/客
    const oddsBands = await pool.query(`${SIDE_VIEW}
      SELECT side,
        CASE WHEN odds<1.3 THEN '1.00-1.30' WHEN odds<1.6 THEN '1.30-1.60' WHEN odds<2.0 THEN '1.60-2.00'
             WHEN odds<2.5 THEN '2.00-2.50' WHEN odds<3.5 THEN '2.50-3.50' WHEN odds<5 THEN '3.50-5.00'
             WHEN odds<8 THEN '5.00-8.00' ELSE '8.00+' END band,
        COUNT(*) n, ROUND(AVG(odds)::numeric,3) avg_odds,
        ROUND(AVG((result=side)::int)::numeric,4) win_rate,
        ROUND(AVG(1.0/odds)::numeric,4) implied,
        ROUND((${roiExpr})::numeric,4) roi
      FROM s GROUP BY 1,2 HAVING COUNT(*) >= 15 ORDER BY 1, MIN(odds)`);

    // 2. CV 離散度區間
    const cvBands = await pool.query(`${SIDE_VIEW}
      SELECT side,
        CASE WHEN cv<0.02 THEN '<2%' WHEN cv<0.04 THEN '2-4%' WHEN cv<0.06 THEN '4-6%'
             WHEN cv<0.08 THEN '6-8%' WHEN cv<0.12 THEN '8-12%' WHEN cv<0.18 THEN '12-18%' ELSE '18%+' END band,
        COUNT(*) n,
        ROUND(AVG(odds)::numeric,3) avg_odds,
        ROUND(AVG((result=side)::int)::numeric,4) win_rate,
        ROUND((${roiExpr})::numeric,4) roi
      FROM s GROUP BY 1,2 HAVING COUNT(*) >= 15 ORDER BY 1, MIN(cv)`);

    // 3. 初盤→即時走勢（跌=資金流入該邊）
    const drift = await pool.query(`${SIDE_VIEW}
      SELECT side,
        CASE WHEN live IS NULL THEN '無' WHEN live < odds*0.97 THEN '跌(受捧)'
             WHEN live > odds*1.03 THEN '升(退熱)' ELSE '平' END drift,
        COUNT(*) n,
        ROUND(AVG(odds)::numeric,3) open_odds,
        ROUND(AVG(live)::numeric,3) live_odds,
        ROUND(AVG((result=side)::int)::numeric,4) win_rate,
        ROUND((${roiExpr})::numeric,4) roi_at_open
      FROM s GROUP BY 1,2 HAVING COUNT(*) >= 15 ORDER BY 1,2`);

    // 4. 全場最大 CV（市場整體分歧度）vs 賽果分佈
    const disp = await pool.query(`
      SELECT
        CASE WHEN GREATEST(cv_h, cv_d, cv_a) < 0.05 THEN '低(<5%)'
             WHEN GREATEST(cv_h, cv_d, cv_a) < 0.08 THEN '中(5-8%)'
             WHEN GREATEST(cv_h, cv_d, cv_a) < 0.12 THEN '高(8-12%)'
             ELSE '極高(12%+)' END band,
        COUNT(*) n,
        ROUND(AVG((result='H')::int)::numeric,4) home_rate,
        ROUND(AVG((result='D')::int)::numeric,4) draw_rate,
        ROUND(AVG((result='A')::int)::numeric,4) away_rate,
        ROUND((AVG((result='H')::int * open_h) - 1)::numeric,4) roi_h,
        ROUND((AVG((result='D')::int * open_d) - 1)::numeric,4) roi_d,
        ROUND((AVG((result='A')::int * open_a) - 1)::numeric,4) roi_a
      FROM had_odds WHERE result IS NOT NULL AND open_h IS NOT NULL
      GROUP BY 1 HAVING COUNT(*) >= 20 ORDER BY MIN(GREATEST(cv_h, cv_d, cv_a))`);

    const { rows: totalRow } = await pool.query('SELECT COUNT(*) c FROM had_odds WHERE result IS NOT NULL');
    res.json({
      sample: +totalRow[0].c,
      oddsBands: oddsBands.rows,
      cvBands: cvBands.rows,
      drift: drift.rows,
      dispersion: disp.rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/hda/upcoming — 馬會全部賽事 + 百家初盤 + 相似賠率統計（HK33 優先）
const hk33Mod = require('./football/hk33');
app.get('/api/hda/upcoming', async (req, res) => {
  try {
    const up = await hdaService.buildUpcoming(req.query.refresh === '1');
    const ids = up.rows.filter(r => r.titanId).map(r => r.titanId);
    let oddsMap = {};
    if (ids.length) {
      const { rows: oddsRows } = await pool.query(
        'SELECT * FROM had_odds WHERE titan_id = ANY($1::bigint[])', [ids]);
      oddsMap = Object.fromEntries(oddsRows.map(r => [r.titan_id, r]));
    }
    // HK33 數據（30 分鐘快取；失敗唔阻斷）
    let hk33Map = {};
    try {
      const hk33 = await hk33Mod.getHk33();
      hk33Map = Object.fromEntries(hk33.rows.map(r => [r.fb, r]));
    } catch (_) {}
    // 已追蹤場次：主表跟返追蹤行嘅 bench_src（確保上下數據一致）
    const { rows: trackedRows } = await pool.query(
      `SELECT fb, bench_src FROM hda_track WHERE fb = ANY($1)`,
      [up.rows.filter(r => r.fb).map(r => r.fb)]);
    const trackedBench = Object.fromEntries(trackedRows.map(r => [r.fb, r.bench_src]));

    const tol = parseFloat(req.query.tol || '0.10');
    const matches = [];
    for (const r of up.rows) {
      const o = r.titanId ? (oddsMap[String(r.titanId)] || null) : null;
      const kRaw = hk33Map[r.fb] || null;
      let sim = null;
      if (o?.open_h) sim = await hdaService.similarStats(+o.open_h, +o.open_d, +o.open_a, tol);
      // 基準選擇：已追蹤 → 跟 bench_src；未追蹤 → HK33（n≥30）優先
      const tb = trackedBench[r.fb];
      let k = null;
      if (tb === 'HK33' && kRaw && kRaw.n >= 30) k = kRaw;
      else if (!tb && kRaw && kRaw.n >= 30) k = kRaw;
      // sim 用唔用：已追蹤且 bench=sim → 用 sim；否則 k 冇先至用
      const useSim = tb === 'sim' || (!k && sim && sim.n >= 30);
      // 三色檢測（HK33 優先・自家 sim 統計後備 — 同前端邏輯一致）
      const vh = o ? +o.open_h : k?.h, vd = o ? +o.open_d : k?.d, va = o ? +o.open_a : k?.a;
      const sdAry = o ? [+o.sd_h, +o.sd_d, +o.sd_a] : (k ? [k.sdH, k.sdD, k.sdA] : null);
      const cvAry = o ? [+o.cv_h, +o.cv_d, +o.cv_a] : (k ? [k.cvH, k.cvD, k.cvA] : null);
      // HK33 基準要 n≥30 先有效（唔夠就跌返 sim — 同捕捉邏輯一致）
      // 基準：k（已按 bench_src 選定）或 sim
      const n = k ? k.n : (useSim && sim ? sim.n : null);
      const rates = k ? [k.rateH, k.rateD, k.rateA] : (useSim && sim ? [sim.rateH, sim.rateD, sim.rateA] : null);
      const rois = k ? [k.roiH, k.roiD, k.roiA] : (useSim && sim ? [sim.roiH, sim.roiD, sim.roiA] : null);
      let yellow = null, green = null, deep = null, white = null, strong = null, deepOld = null, bad = null;
      if (vh != null && sdAry && n != null && rates) {
        yellow = hdaService.detectYellow(vh, vd, va, sdAry, cvAry, n, rates, rois);
        const gb = hdaService.detectGreenBlue(vh, vd, va, sdAry, cvAry, rates, rois, n);
        green = gb.green; deep = gb.deep; strong = gb.strong;
        white = hdaService.detectWhite(vh, vd, va, sdAry, cvAry, rates, n);
      }
      // 舊法深綠：壞基準池 6 條件（只行 titan odds 場）
      if (vh != null && sdAry && o?.open_h) {
        try {
          bad = await hdaService.similarStatsBad(+o.open_h, +o.open_d, +o.open_a, tol);
          if (bad.n >= 30) {
            deepOld = hdaService.detectDeepOld(vh, vd, va, sdAry, cvAry, [bad.rateH, bad.rateD, bad.rateA], [bad.roiH, bad.roiD, bad.roiA], bad.n);
          }
        } catch (_) {}
      }
      matches.push({ ...r, odds: o, sim, hk33: k, yellow, green, deep, strong, white, deepOld, bad: bad?.n ? { n: bad.n, rateH: bad.rateH, rateD: bad.rateD, rateA: bad.rateA, roiH: bad.roiH, roiD: bad.roiD, roiA: bad.roiA } : null });
    }
    // 自動捕捉新嘅黃/綠入庫（summary 即時更新；已存在唔會重寫）
    try { await hdaDaily.captureYellows({ rows: matches }); } catch (_) {}
    res.json({
      count: matches.length,
      withOdds: matches.filter(m => m.odds).length,
      withHk33: matches.filter(m => m.hk33).length,
      tol,
      batch: hdaService.batchState,
      cachedAt: up.at,
      matches,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/hda/scrape-all — 批量抓取全部百家初盤
app.post('/api/hda/scrape-all', async (req, res) => {
  try {
    hdaService.runBatch();
    res.json({ ok: true, batch: hdaService.batchState });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/hda/batch-status — 批量進度
app.get('/api/hda/batch-status', (req, res) => {
  res.json(hdaService.batchState);
});

// GET /api/hda/odds?titanId=X&league=&home=&away= — 抓/快取一場百家初盤
app.get('/api/hda/odds', async (req, res) => {
  const { titanId, league, home, away, match_date, refresh } = req.query;
  if (!titanId) return res.status(400).json({ error: '需要 titanId' });
  try {
    if (!refresh) {
      const { rows } = await pool.query('SELECT * FROM had_odds WHERE titan_id=$1', [+titanId]);
      if (rows.length) return res.json({ cached: true, ...rows[0] });
    }
    const d = await scrape1x2(+titanId);
    if (!d.openAvg) return res.status(404).json({ error: '搵唔到初盘平均值', title: d.title });
    const st = oddsStats(d.openBooks);
    await pool.query(
      `INSERT INTO had_odds (titan_id, league, match_date, home_team, away_team, n_books,
         open_h, open_d, open_a, live_h, live_d, live_a,
         sd_h, sd_d, sd_a, cv_h, cv_d, cv_a, league_cn)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (titan_id) DO UPDATE SET
         n_books=$6, open_h=$7, open_d=$8, open_a=$9, live_h=$10, live_d=$11, live_a=$12,
         sd_h=$13, sd_d=$14, sd_a=$15, cv_h=$16, cv_d=$17, cv_a=$18, league_cn=$19,
         league=COALESCE($2, had_odds.league), match_date=COALESCE($3, had_odds.match_date),
         home_team=COALESCE($4, had_odds.home_team), away_team=COALESCE($5, had_odds.away_team),
         scraped_at=now()`,
      [+titanId, league || null, match_date || null, home || null, away || null,
       st.h.n, d.openAvg.h, d.openAvg.d, d.openAvg.a,
       d.liveAvg?.h ?? null, d.liveAvg?.d ?? null, d.liveAvg?.a ?? null,
       st.h.sd, st.d.sd, st.a.sd, st.h.cv, st.d.cv, st.a.cv, d.leagueCn]);
    const { rows } = await pool.query('SELECT * FROM had_odds WHERE titan_id=$1', [+titanId]);
    res.json({ cached: false, ...rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/hda/history?h=&d=&a=&tol=0.3 — 歷史同賠率場次統計（步驟2）
app.get('/api/hda/history', async (req, res) => {
  const h = parseFloat(req.query.h), d = parseFloat(req.query.d), a = parseFloat(req.query.a);
  const tol = parseFloat(req.query.tol || '0.25'); // 相對容差
  if (!h || !d || !a) return res.status(400).json({ error: '需要 h, d, a' });
  try {
    // 搵歷史 had_odds（有對賽果嘅）— 暫時未有結果 join，先返樣本數
    const { rows } = await pool.query(
      `SELECT COUNT(*) total FROM had_odds WHERE open_h IS NOT NULL`);
    res.json({
      note: '歷史統計準備中：需先批量抓取歷史場次初盤',
      db_total: +rows[0].total,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 角球盤口（馬會初終盤）+ 真實 P/L ────────────────────────────────────────
// POST /api/corner/odds — 入一條盤口紀錄（upsert）
app.post('/api/corner/odds', async (req, res) => {
  const { league, match_date, home_team, away_team, line,
          over_open, under_open, over_close, under_close } = req.body || {};
  if (!league || !match_date || !home_team || !away_team || !line) {
    return res.status(400).json({ error: '需要 league, match_date, home_team, away_team, line' });
  }
  try {
    // 自動對返 DB 入面嘅賽事（match_id）
    const m = await pool.query(
      `SELECT id FROM football_matches
       WHERE league=$1 AND match_date=$2 AND home_team=$3 AND away_team=$4 LIMIT 1`,
      [league, match_date, home_team, away_team]);
    await pool.query(
      `INSERT INTO corner_odds (league, match_date, home_team, away_team, match_id, line,
         over_open, under_open, over_close, under_close)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (league, match_date, home_team, away_team, line) DO UPDATE SET
         match_id=COALESCE($5, corner_odds.match_id),
         over_open=COALESCE($7, corner_odds.over_open), under_open=COALESCE($8, corner_odds.under_open),
         over_close=COALESCE($9, corner_odds.over_close), under_close=COALESCE($10, corner_odds.under_close)`,
      [league, match_date, home_team, away_team, m.rows[0]?.id || null, +line,
       over_open != null ? +over_open : null, under_open != null ? +under_open : null,
       over_close != null ? +over_close : null, under_close != null ? +under_close : null]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/corner/odds?league= — 盤口紀錄清單（連實際角球）
app.get('/api/corner/odds', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.*, m.home_corners, m.away_corners,
              (m.home_corners + m.away_corners) AS actual_corners
       FROM corner_odds o
       LEFT JOIN football_matches m ON m.id = o.match_id
       ${req.query.league ? 'WHERE o.league = $1' : ''}
       ORDER BY o.match_date DESC LIMIT 200`,
      req.query.league ? [req.query.league] : []);
    res.json({ odds: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/corner/odds-pl?league=EPL&threshold=5
// 真實 P/L：每條盤口用「該場之前」嘅數據擬合 → P(大) → 對比終盤賠率 → 落注有 edge 嗰邊
app.get('/api/corner/odds-pl', async (req, res) => {
  const league = req.query.league || 'EPL';
  const threshold = (+req.query.threshold || 5) / 100;   // edge 門檻（0.05）
  try {
    const { rows } = await pool.query(
      `SELECT o.*, TO_CHAR(o.match_date,'YYYY-MM-DD') AS match_date_str,
              (m.home_corners + m.away_corners) AS actual
       FROM corner_odds o
       JOIN football_matches m ON m.id = o.match_id
       WHERE o.league = $1 AND o.over_close IS NOT NULL AND m.home_corners IS NOT NULL
       ORDER BY o.match_date`, [league]);
    if (!rows.length) return res.json({ error: '未有可計嘅盤口（要有 match_id + 終盤 + 已完賽）' });

    const all = await cornerlib.loadLeague(league);
    const bets = [];
    for (const o of rows) {
      const train = all.filter(m => m.d < o.match_date_str);
      if (train.length < 40) continue;
      const fit = cornerlib.fitModel(train);
      const sm = cornerlib.fitStateMultipliers(train).m;
      const p = cornerlib.predict(fit, sm, o.home_team, o.away_team, 8000);
      if (p.error) continue;
      // 由模擬分佈直接計 P(大 line)（支援任何線）
      const line = +o.line;
      let overCount = 0, totalSims = 0;
      for (let t = 0; t < p.dist.length; t++) {
        totalSims += p.dist[t];
        if (t > line) overCount += p.dist[t];
      }
      const pModel = totalSims > 0 ? overCount / totalSims : null;
      if (pModel == null) continue;
      // ── 市場融合：P = w×模型 + (1-w)×Crown 終盤隱含 ──
      const pOver = cornerlib.blendWithMarket(
        pModel, +o.over_close, +o.under_close);
      const edgeOver = pOver * (+o.over_close) - 1;
      const edgeUnder = (1 - pOver) * (+o.under_close) - 1;
      const side = edgeOver >= edgeUnder ? 'over' : 'under';
      const edge = Math.max(edgeOver, edgeUnder);
      if (edge < threshold) continue;
      const odds = side === 'over' ? +o.over_close : +o.under_close;
      const actualOver = o.actual > +o.line;
      const won = side === 'over' ? actualOver : !actualOver;
      bets.push({
        date: o.match_date_str, home: o.home_team, away: o.away_team, line: +o.line,
        side: side === 'over' ? '大' : '細', odds, pOver: +pOver.toFixed(3),
        pModel: +pModel.toFixed(3),
        edge: +(edge * 100).toFixed(1), actual: o.actual,
        result: won ? '贏' : '輸', pl: won ? +(odds - 1).toFixed(2) : -1,
        moveOpen: o.over_open != null ? +((+o.over_close) - (+o.over_open)).toFixed(2) : null,
      });
    }
    const staked = bets.length;
    const ret = bets.reduce((s, b) => s + b.pl, 0);
    res.json({
      league, threshold: threshold * 100, bets: staked,
      roi: staked ? +((ret / staked) * 100).toFixed(1) : null,
      hitRate: staked ? +(bets.filter(b => b.pl > 0).length / staked * 100).toFixed(1) : null,
      detail: bets.slice(-30),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 即場預測：?league&home&away&minute&corners&hg&ag（目前分鐘/角球/比分）
app.get('/api/corner/predict-live', async (req, res) => {
  const { league, home, away } = req.query;
  if (!league || !home || !away) return res.status(400).json({ error: '需要 league, home, away' });
  try {
    const entry = await getFit(league);
    if (!entry) return res.status(404).json({ error: '數據不足' });
    const r = cornerlib.predictLive(entry.fit, entry.stateMul.m, home, away, {
      minute: req.query.minute, corners: req.query.corners,
      hg: req.query.hg, ag: req.query.ag,
      shotsH: req.query.shotsH, shotsA: req.query.shotsA,
      possession: req.query.possession,
     }, 20000);
    if (r.error) return res.status(404).json(r);
    r.sample = entry.n;
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/goals/coverage — 入球盤覆蓋統計
app.get('/api/goals/coverage', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT league, COUNT(*) total, COUNT(match_id) matched,
              ROUND(AVG(over_close)::numeric,2) avg_over,
              ROUND(AVG(under_close)::numeric,2) avg_under
       FROM goal_odds GROUP BY 1 ORDER BY 1`);
    res.json({ coverage: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/goals/backtest?league=EPL
// 入球大細 walk-forward 回測
app.get('/api/goals/backtest', async (req, res) => {
  const league = req.query.league || 'EPL';
  try {
    const all = await cornerlib.loadLeague(league);
    if (!all || all.length < 60) return res.status(404).json({ error: '數據不足' });

    const odds = (await pool.query(
      `SELECT g.*, TO_CHAR(g.match_date,'YYYY-MM-DD') md, m.home_goals + m.away_goals AS actual_goals
       FROM goal_odds g JOIN football_matches m ON m.id = g.match_id
       WHERE g.league = $1 AND g.over_close IS NOT NULL AND m.home_goals IS NOT NULL`,
      [league])).rows;

    const byMonth = new Map();
    for (const m of all) { const k = m.d.slice(0,7); if (!byMonth.has(k)) byMonth.set(k,[]); byMonth.get(k).push(m); }
    const months = [...byMonth.keys()].sort();
    const fits = [];
    for (let mi = 2; mi < months.length; mi++) {
      const train = all.filter(m => m.d < months[mi] + '-01');
      if (train.length < 40) continue;
      fits.push({ fit: cornerlib.fitModel(train), month: months[mi], matches: byMonth.get(months[mi]) });
    }

    let n = 0, modelLL = 0, mktLL = 0, betN = 0, betHit = 0, pl = 0;
    const calBuckets = Array.from({length: 5}, () => ({n:0, over:0, pSum:0}));
    const p70list = [];
    const perMatch = [];

    for (const f of fits) {
      for (const m of f.matches) {
        const o = odds.find(x => x.md === m.d && x.home_team === m.home_team && x.actual_goals != null);
        if (!o) continue;
        const actual = +o.actual_goals;
        const line = parseFloat(String(o.line).trim().split('/')[0]);
        if (!line || isNaN(line)) continue;
        const overOdds = +o.over_close, underOdds = +o.under_close;
        if (!(overOdds > 1) || !(underOdds > 1)) continue;

        const p = cornerlib.predictGoals(f.fit, m.home_team, m.away_team, {}, 3000);
        if (p.error) continue;
        const pOver = p.probs[String(line)];
        if (pOver == null) continue;

        n++;
        const actualOver = actual > line;
        modelLL += -Math.log(Math.max(1e-10, actualOver ? pOver : 1 - pOver));
        const invO = 1/overOdds, invU = 1/underOdds;
        const pMkt = invO / (invO + invU);
        mktLL += -Math.log(Math.max(1e-10, actualOver ? pMkt : 1 - pMkt));

        const bi = Math.min(4, Math.floor(pOver * 5));
        calBuckets[bi].n++; calBuckets[bi].pSum += pOver; if (actualOver) calBuckets[bi].over++;

        const pBlend = 0.15 * pOver + 0.85 * pMkt;
        const edge = Math.max(pBlend * overOdds - 1, (1 - pBlend) * underOdds - 1);
        if (edge >= 0.05) {
          betN++;
          const side = pBlend * overOdds >= (1 - pBlend) * underOdds ? 'over' : 'under';
          const won = side === 'over' ? actualOver : !actualOver;
          if (won) { betHit++; pl += (side === 'over' ? overOdds : underOdds) - 1; }
          else pl -= 1;
        }

        if (pOver >= 0.70) p70list.push({ d: m.d, h: m.home_team, a: m.away_team, line, p: +pOver.toFixed(3), actual, over: actualOver });
        perMatch.push({ d: m.d, h: m.home_team, a: m.away_team, exp: p.expGoals, actual, line, p: +pOver.toFixed(3), over: actualOver });
      }
    }

    const p70overs = p70list.filter(x => x.over).length;
    res.json({
      league, sample: n,
      modelLL: +(modelLL / Math.max(1, n)).toFixed(4),
      marketLL: +(mktLL / Math.max(1, n)).toFixed(4),
      bets: betN,
      roi: betN ? +((pl / betN) * 100).toFixed(1) : null,
      calibration: calBuckets.map((b, i) => ({
        bucket: `${i*20}-${(i+1)*20}%`, n: b.n,
        avgP: b.n ? +(b.pSum / b.n).toFixed(3) : null,
        actualOverRate: b.n ? +(b.over / b.n).toFixed(3) : null,
      })),
      p70: { count: p70list.length, rate: p70list.length ? +((100 * p70overs / p70list.length).toFixed(1)) : null,
             detail: p70list.sort((a,b) => b.p - a.p).slice(0, 20) },
      perMatch: perMatch.slice(-20),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Walk-forward 回測（校準 + 模擬大細命中率）
app.get('/api/corner/backtest', async (req, res) => {
  const { league } = req.query;
  if (!league) return res.status(400).json({ error: '需要 league' });
  try {
    const all = await cornerlib.loadLeague(league);
    if (!all || all.length < 60) return res.status(404).json({ error: '數據不足（起碼 60 場）' });
    // 按月分組
    const byMonth = new Map();
    for (const m of all) {
      const k = m.d.slice(0, 7);
      if (!byMonth.has(k)) byMonth.set(k, []);
      byMonth.get(k).push(m);
    }
    const months = [...byMonth.keys()].sort();
    const perMatch = [];
    let rmseSum = 0, rmseN = 0;
    const calBuckets = Array.from({ length: 5 }, () => ({ n: 0, over: 0, pSum: 0 }));
    let betN = 0, betHit = 0;

    // 每場嘅 Crown 終盤線（由 corner_odds 表攞，冇就用 9.5）
    const crownLines = new Map();
    const clRes = await pool.query(
      `SELECT TO_CHAR(match_date,'YYYY-MM-DD') d, home_team, line
       FROM corner_odds WHERE league = $1 AND over_close IS NOT NULL`, [league]);
    for (const r of clRes.rows) crownLines.set(`${r.d}|${r.home_team}`, +r.line);
    const DEFAULT_LINE = 9.5;

    for (let mi = 2; mi < months.length; mi++) {
      const train = all.filter(m => m.d < months[mi] + '-01');
      if (train.length < 40) continue;
      const fit = cornerlib.fitModel(train);
      const sm = cornerlib.fitStateMultipliers(train).m;
      for (const m of byMonth.get(months[mi])) {
        const actual = m.home_corners + m.away_corners;
        if (actual == null) continue;
        const p = cornerlib.predict(fit, sm, m.home_team, m.away_team, 3000);
        if (p.error) continue;

        // 用 Crown 終盤線（冇就 9.5）
        const line = crownLines.get(`${m.d}|${m.home_team}`) ?? DEFAULT_LINE;
        // 由模擬分佈計 P(大 line)
        let over = 0, total = 0;
        for (let t = 0; t < p.dist.length; t++) { total += p.dist[t]; if (t > line) over += p.dist[t]; }
        const pOver = total > 0 ? over / total : 0.5;

        perMatch.push({ d: m.d, home: m.home_team, away: m.away_team, exp: p.expCorners, actual, line, pLine: +pOver.toFixed(3) });
        rmseSum += (p.expCorners - actual) ** 2; rmseN++;
        // 校準（用 Crown 線嘅 P(大) 五檔）
        const b = Math.min(4, Math.floor(pOver * 5));
        calBuckets[b].n++; calBuckets[b].pSum += pOver;
        if (actual > line) calBuckets[b].over++;
        // 模擬大細
        if (pOver > 0.55) { betN++; if (actual > line) betHit++; }
        else if (pOver < 0.45) { betN++; if (actual < line) betHit++; }
      }
    }
    res.json({
      league, sample: perMatch.length,
      rmse: +(Math.sqrt(rmseSum / Math.max(1, rmseN))).toFixed(3),
      baselineRmse: +(Math.sqrt(perMatch.reduce((s, x) => s + (10.5 - x.actual) ** 2, 0) / Math.max(1, perMatch.length))).toFixed(3),
      avgExp: +(perMatch.reduce((s, x) => s + x.exp, 0) / Math.max(1, perMatch.length)).toFixed(2),
      avgActual: +(perMatch.reduce((s, x) => s + x.actual, 0) / Math.max(1, perMatch.length)).toFixed(2),
      calibration: calBuckets.map((b, i) => ({
        bucket: `${i * 20}-${(i + 1) * 20}%`, n: b.n,
        avgP: b.n ? +(b.pSum / b.n).toFixed(3) : null,
        actualOverRate: b.n ? +(b.over / b.n).toFixed(3) : null,
      })),
      simulatedBet: { n: betN, hitRate: betN ? +(betHit / betN).toFixed(3) : null },
      perMatch: perMatch.slice(-30),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/stats/placed-then-trial?trainer=文家良
// Returns stats on horses that placed (1-3) in a race and then did a barrier trial before their next race.
app.get('/api/stats/placed-then-trial', async (req, res) => {
  const trainer = req.query.trainer || '文家良';
  try {
    const result = await pool.query(`
      WITH ordered AS (
        SELECT horse_name, race_date, finish_position, win_odds,
          LEAD(race_date)          OVER (PARTITION BY horse_name ORDER BY race_date, race_no) AS next_date,
          LEAD(finish_position)    OVER (PARTITION BY horse_name ORDER BY race_date, race_no) AS next_finish,
          LEAD(win_odds)           OVER (PARTITION BY horse_name ORDER BY race_date, race_no) AS next_odds,
          LEAD(race_date - race_date) OVER (PARTITION BY horse_name ORDER BY race_date, race_no) AS gap
        FROM race_records
        WHERE trainer_name = $1
      ),
      placed AS (
        SELECT *, (next_date - race_date) AS days_gap
        FROM ordered
        WHERE finish_position <= 3 AND next_date IS NOT NULL
      ),
      with_trial AS (
        SELECT p.*,
          EXISTS (
            SELECT 1 FROM horse_trials ht
            WHERE ht.horse_name = p.horse_name
              AND ht.trial_date > p.race_date
              AND ht.trial_date < p.next_date
          ) AS had_trial
        FROM placed p
      )
      SELECT
        had_trial,
        COUNT(*)                                              AS 次數,
        COUNT(*) FILTER (WHERE next_finish = 1)               AS 勝出,
        COUNT(*) FILTER (WHERE next_finish <= 3)              AS 位置,
        ROUND(COUNT(*) FILTER (WHERE next_finish = 1)::numeric / COUNT(*) * 100, 1) AS 勝率,
        ROUND(COUNT(*) FILTER (WHERE next_finish <= 3)::numeric / COUNT(*) * 100, 1) AS 位率,
        ROUND(AVG(days_gap), 1)                               AS 平均間隔
      FROM with_trial
      GROUP BY had_trial
      ORDER BY had_trial DESC
    `, [trainer]);

    // Also return raw detail rows
    const detail = await pool.query(`
      WITH ordered AS (
        SELECT horse_name, race_date, race_no, racecourse, jockey_id, finish_position, win_odds,
          LEAD(race_date)       OVER (PARTITION BY horse_name ORDER BY race_date, race_no) AS next_date,
          LEAD(finish_position) OVER (PARTITION BY horse_name ORDER BY race_date, race_no) AS next_finish,
          LEAD(win_odds)        OVER (PARTITION BY horse_name ORDER BY race_date, race_no) AS next_odds
        FROM race_records WHERE trainer_name = $1
      )
      SELECT o.*,
        (o.next_date - o.race_date) AS days_gap,
        (SELECT string_agg(TO_CHAR(ht.trial_date,'YYYY-MM-DD'), ', ' ORDER BY ht.trial_date)
         FROM horse_trials ht
         WHERE ht.horse_name = o.horse_name
           AND ht.trial_date > o.race_date AND ht.trial_date < o.next_date
        ) AS trial_dates
      FROM ordered o
      WHERE o.finish_position <= 3 AND o.next_date IS NOT NULL
      ORDER BY o.race_date DESC
    `, [trainer]);

    res.json({ summary: result.rows, detail: detail.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Batch racecard backfill ────────────────────────────────────────────────────
// POST /api/backfill/racecards
// Scrapes past racecards for all race days in race_records that are missing from
// the racecard table. Uses scrapeRacecardFromResults (axios+cheerio) for past dates.
// Body: { force: false }  — set force:true to re-scrape already-saved dates.
let backfillRacecardsActive = false;

app.post('/api/backfill/racecards', async (req, res) => {
  if (backfillRacecardsActive) return res.status(409).json({ message: '過往排位表批量抓取進行中' });
  const force = req.body?.force === true;

  const missingRes = await pool.query(force
    ? `SELECT DISTINCT race_date, racecourse FROM race_records ORDER BY race_date`
    : `SELECT DISTINCT race_date, racecourse FROM race_records
       WHERE race_date NOT IN (SELECT DISTINCT race_date FROM racecard)
       ORDER BY race_date`
  );

  const days = missingRes.rows;
  res.json({ message: `開始批量抓取 ${days.length} 個賽事日排位表`, total: days.length });
  backfillRacecardsActive = true;

  (async () => {
    let done = 0, saved = 0, skipped = 0;
    for (const day of days) {
      const dateStr = day.race_date instanceof Date
        ? day.race_date.toISOString().slice(0, 10)
        : String(day.race_date);
      const rc = day.racecourse;
      try {
        const result = await scraper.scrapeRacecard(dateStr, rc);
        if (result && result.races && result.races.length > 0) {
          await scraper.saveRacecard(result.raceDate || dateStr, result.racecourse || rc, result.races);
          saved++;
          console.log(`[backfill/racecards] ${dateStr} ${rc}: ${result.races.length} races saved`);
        } else {
          skipped++;
          console.warn(`[backfill/racecards] ${dateStr} ${rc}: no data`);
        }
      } catch (e) {
        skipped++;
        console.error(`[backfill/racecards] ${dateStr} ${rc}: ${e.message}`);
      }
      done++;
      if (done % 10 === 0) {
        console.log(`[backfill/racecards] Progress: ${done}/${days.length} days processed`);
      }
    }
    console.log(`[backfill/racecards] Done. ${done} days, ${saved} saved, ${skipped} skipped.`);
    backfillRacecardsActive = false;
  })();
});

// POST /api/backfill/race-results
// Backfills race_records with historical race results from localresults pages.
// 1. Scrapes HKJC fixture calendar to find all race dates in range
// 2. Scrapes localresults for each race date → saves to race_records
// Body: { start_year: 2020, end_year: 2025 }
let backfillRaceResultsActive = false;
app.post('/api/backfill/race-results', async (req, res) => {
  if (backfillRaceResultsActive) return res.status(409).json({ message: '歷史賽事批量抓取進行中' });
  const startYear = req.body?.start_year || 2020;
  const endYear   = req.body?.end_year   || 2025;

  res.json({ message: `開始抓取 ${startYear}-${endYear} 歷史賽事結果` });
  backfillRaceResultsActive = true;

  (async () => {
    try {
      // Phase 1: Scrape fixtures to find all race dates
      console.log(`[backfill/race-results] Phase 1: Scraping fixtures ${startYear}-${endYear}...`);
      const fixtures = await scraper.scrapeFixturesForRange(startYear, 1, endYear, 8);
      console.log(`[backfill/race-results] Found ${fixtures.length} fixture dates`);

      // Filter out dates already in race_records
      const existingRes = await pool.query(
        `SELECT DISTINCT race_date FROM race_records WHERE race_date < $1`,
        [`${startYear}-09-01`]
      );
      const existingDates = new Set(existingRes.rows.map(r =>
        r.race_date instanceof Date ? r.race_date.toISOString().slice(0, 10) : String(r.race_date)
      ));

      const toScrape = fixtures.filter(f => !existingDates.has(f.date));
      console.log(`[backfill/race-results] ${toScrape.length} dates to scrape (${existingDates.size} already have data)`);

      // Phase 2: Scrape race results for each date
      let done = 0, saved = 0, skipped = 0;
      for (const fx of toScrape) {
        try {
          const result = await scraper.scrapeRaceResults(fx.date, fx.racecourse);
          if (result.races && result.races.length > 0) {
            const cnt = await scraper.saveRaceRecords(fx.date, fx.racecourse, result.races);
            saved += cnt;
          } else {
            skipped++;
          }
        } catch (e) {
          skipped++;
          console.error(`[backfill/race-results] ${fx.date} ${fx.racecourse}: ${e.message}`);
        }
        done++;
        if (done % 10 === 0) {
          console.log(`[backfill/race-results] Progress: ${done}/${toScrape.length} days, ${saved} records saved`);
        }
      }
      console.log(`[backfill/race-results] Done. ${done} days, ${saved} records saved, ${skipped} skipped.`);
    } catch (err) {
      console.error('[backfill/race-results] Fatal error:', err.message);
    } finally {
      backfillRaceResultsActive = false;
    }
  })();
});

// ── Entries (報名表) ───────────────────────────────────────────────────────
app.get('/api/entries', async (req, res) => {
  try {
    let date = req.query.date;
    if (!date) {
      const latest = await pool.query(
        `SELECT DISTINCT meeting_date FROM entries ORDER BY meeting_date DESC LIMIT 1`
      );
      if (!latest.rows.length) return res.json({ races: [], available_dates: [] });
      date = latest.rows[0].meeting_date;
    }

    const rows = await pool.query(
      `SELECT meeting_date, racecourse, race_no, race_class, distance, track_type,
              rating_range, group_no, trainer_name, horse_name, horse_note,
              TO_CHAR(scrape_date,'YYYY-MM-DD') AS scrape_date
       FROM entries WHERE meeting_date = $1
       ORDER BY race_no, trainer_name`,
      [date]
    );

    const datesRes = await pool.query(
      `SELECT DISTINCT meeting_date FROM entries ORDER BY meeting_date`
    );

    const races = {};
    for (const r of rows.rows) {
      if (!races[r.race_no]) {
        races[r.race_no] = {
          race_no: r.race_no, race_class: r.race_class, distance: r.distance,
          track_type: r.track_type, rating_range: r.rating_range,
          group_no: r.group_no, entries: [],
        };
      }
      races[r.race_no].entries.push({
        trainer_name: r.trainer_name, horse_name: r.horse_name, horse_note: r.horse_note,
      });
    }

    res.json({
      meeting_date: date instanceof Date ? date.toISOString().slice(0,10) : String(date),
      racecourse: rows.rows[0]?.racecourse || '',
      scrape_date: rows.rows[0]?.scrape_date || '',
      available_dates: datesRes.rows.map(r =>
        r.meeting_date instanceof Date ? r.meeting_date.toISOString().slice(0, 10) : String(r.meeting_date)
      ),
      races: Object.values(races).sort((a, b) => a.race_no - b.race_no),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scrape/entries', async (req, res) => {
  try {
    const meetings = await scraper.scrapeEntries();
    const saved = await scraper.saveEntries(meetings);
    res.json({ message: `抓取完成`, meetings: meetings.length, saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Hot Favourite Next Race (大熱再出) ──────────────────────────────────────
app.get('/api/ai/hot-fav-next', async (req, res) => {
  try {
    const maxOdds = parseFloat(req.query.max_odds) || 3.0;
    const cutoff = '2023-07-01';

    const result = await pool.query(
      `SELECT
         h.horse_name,
         h.trainer_name,
         TO_CHAR(h.race_date, 'YYYY-MM-DD') AS hot_date,
         h.racecourse  AS hot_racecourse,
         h.race_no     AS hot_race_no,
         h.race_class  AS hot_class,
         h.finish_position AS hot_finish,
         h.total_runners   AS hot_runners,
         h.jockey_id   AS hot_jockey_id,
         j1.name_zh    AS hot_jockey,
         h.win_odds    AS hot_odds,
         TO_CHAR(n.race_date, 'YYYY-MM-DD') AS next_date,
         n.racecourse  AS next_racecourse,
         n.race_no     AS next_race_no,
         n.race_class  AS next_class,
         n.finish_position AS next_finish,
         n.total_runners   AS next_runners,
         n.jockey_id   AS next_jockey_id,
         j2.name_zh    AS next_jockey,
         n.win_odds    AS next_odds,
         n.race_date - h.race_date AS days_gap
       FROM race_records h
       LEFT JOIN LATERAL (
         SELECT *
         FROM race_records r
         WHERE r.horse_name = h.horse_name
           AND r.race_date > h.race_date
         ORDER BY r.race_date ASC
         LIMIT 1
       ) n ON true
       LEFT JOIN jockeys j1 ON j1.canonical_id = h.jockey_id
       LEFT JOIN jockeys j2 ON j2.canonical_id = n.jockey_id
       WHERE h.win_odds IS NOT NULL
         AND h.win_odds <= $1
         AND h.race_date >= $2
       ORDER BY h.race_date DESC`,
      [maxOdds, cutoff]
    );

    const rows = result.rows.filter(r => r.next_date);

    const total = rows.length;
    const wins = rows.filter(r => r.next_finish === 1).length;
    const places = rows.filter(r => r.next_finish <= 3).length;

    const byTrainer = {};
    for (const r of rows) {
      const t = r.trainer_name || '未知';
      if (!byTrainer[t]) byTrainer[t] = { trainer_name: t, records: [] };
      byTrainer[t].records.push(r);
    }

    const trainers = Object.values(byTrainer).map(t => {
      const tot = t.records.length;
      const w = t.records.filter(r => r.next_finish === 1).length;
      const p = t.records.filter(r => r.next_finish <= 3).length;
      return {
        trainer_name: t.trainer_name,
        total: tot,
        wins: w,
        places: p,
        win_rate: tot > 0 ? ((w / tot) * 100).toFixed(1) + '%' : 'N/A',
        place_rate: tot > 0 ? ((p / tot) * 100).toFixed(1) + '%' : 'N/A',
        avg_days: tot > 0 ? Math.round(t.records.reduce((s, r) => s + (r.days_gap || 0), 0) / tot) : 0,
        records: t.records,
      };
    }).sort((a, b) => b.total - a.total);

    res.json({
      max_odds: maxOdds,
      cutoff,
      total,
      wins,
      places,
      win_rate: total > 0 ? ((wins / total) * 100).toFixed(1) + '%' : 'N/A',
      place_rate: total > 0 ? ((places / total) * 100).toFixed(1) + '%' : 'N/A',
      trainers,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Trainer Monthly Stats (練馬師每月表現) ───────────────────────────────────
app.get('/api/ai/trainer-monthly', async (req, res) => {
  try {
    const cutoff = '2023-07-01';
    const result = await pool.query(
      `SELECT
         trainer_name,
         EXTRACT(MONTH FROM race_date)::int AS month,
         CASE
           WHEN EXTRACT(MONTH FROM race_date) >= 8
             THEN EXTRACT(YEAR FROM race_date)::text || '-' || (EXTRACT(YEAR FROM race_date)+1)::text
           ELSE (EXTRACT(YEAR FROM race_date)-1)::text || '-' || EXTRACT(YEAR FROM race_date)::text
         END AS season,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE finish_position = 1) AS wins,
         COUNT(*) FILTER (WHERE finish_position <= 3) AS places
       FROM race_records
       WHERE race_date >= $1
         AND trainer_name IS NOT NULL
       GROUP BY trainer_name, month, season
       ORDER BY trainer_name, month`,
      [cutoff]
    );

    const seasonsSet = new Set();
    const byTrainer = {};
    for (const r of result.rows) {
      seasonsSet.add(r.season);
      if (!byTrainer[r.trainer_name]) {
        byTrainer[r.trainer_name] = {
          trainer_name: r.trainer_name,
          months: {}, total: 0, wins: 0, places: 0,
          bySeason: {},
        };
      }
      const t = byTrainer[r.trainer_name];
      // Aggregated
      if (!t.months[r.month]) t.months[r.month] = { total: 0, wins: 0, places: 0 };
      t.months[r.month].total += parseInt(r.total);
      t.months[r.month].wins += parseInt(r.wins);
      t.months[r.month].places += parseInt(r.places);
      t.total += parseInt(r.total);
      t.wins += parseInt(r.wins);
      t.places += parseInt(r.places);
      // Per season
      if (!t.bySeason[r.season]) t.bySeason[r.season] = { total: 0, wins: 0, places: 0, months: {} };
      t.bySeason[r.season].months[r.month] = {
        total: parseInt(r.total),
        wins: parseInt(r.wins),
        places: parseInt(r.places),
      };
      t.bySeason[r.season].total += parseInt(r.total);
      t.bySeason[r.season].wins += parseInt(r.wins);
      t.bySeason[r.season].places += parseInt(r.places);
    }

    const seasons = [...seasonsSet].sort();
    const trainers = Object.values(byTrainer).map(t => ({
      ...t,
      win_rate: t.total > 0 ? ((t.wins / t.total) * 100).toFixed(1) + '%' : 'N/A',
      place_rate: t.total > 0 ? ((t.places / t.total) * 100).toFixed(1) + '%' : 'N/A',
    })).sort((a, b) => b.total - a.total);

    res.json({ cutoff, seasons, trainers });
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
    setupJobs();
    app.listen(PORT, () => {
      console.log(`Backend running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
