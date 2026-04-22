const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// racecourse_track combined values: STT, STA, HVT, CHT
// STT = ST + TURF, STA = ST + AWT, HVT = HV + TURF, CHT = CGA + TURF
function decodeRacecoursTrack(val) {
  const map = {
    STT: { racecourse: 'ST',  track_type: 'TURF' },
    STA: { racecourse: 'ST',  track_type: 'AWT'  },
    HVT: { racecourse: 'HV',  track_type: 'TURF' },
    CHT: { racecourse: 'CGA', track_type: 'TURF' },
  };
  return map[val] || null;
}

// Season filter: map seasonId (e.g. "2024") to date range
function seasonDateRange(seasonId) {
  if (!seasonId || seasonId === 'ALL') return null;
  const y = parseInt(seasonId);
  // Racing season: Sep 1 of year y to Aug 31 of year y+1
  return { from: `${y}-09-01`, to: `${y + 1}-08-31` };
}

// Draw advance search - returns win rate and place rate by draw
router.get('/search', async (req, res) => {
  try {
    const { season, racecourse_track, course, distance, going } = req.query;

    let conditions = [];
    let params = [];
    let idx = 1;

    // Season filter
    const dateRange = seasonDateRange(season);
    if (dateRange) {
      conditions.push(`race_date BETWEEN $${idx++} AND $${idx++}`);
      params.push(dateRange.from, dateRange.to);
    }

    // Combined racecourse+track_type filter
    if (racecourse_track && racecourse_track !== 'ALL') {
      const decoded = decodeRacecoursTrack(racecourse_track);
      if (decoded) {
        conditions.push(`racecourse = $${idx++}`);
        params.push(decoded.racecourse);
        conditions.push(`track_type = $${idx++}`);
        params.push(decoded.track_type);
      }
    }

    // Course (赛道) filter — stored in race_class field as e.g. "草地\"A\"" or "A", "B"
    if (course && course !== 'ALL') {
      conditions.push(`race_class ILIKE $${idx++}`);
      params.push(`%${course}%`);
    }

    if (distance && distance !== 'ALL') {
      conditions.push(`distance = $${idx++}`);
      params.push(parseInt(distance));
    }
    if (going && going !== 'ALL') {
      conditions.push(`going = $${idx++}`);
      params.push(going);
    }

    // Always exclude draw=0 (invalid)
    conditions.push(`draw > 0`);

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : 'WHERE draw > 0';

    const query = `
      SELECT 
        draw,
        COUNT(*) as total_races,
        COUNT(CASE WHEN finish_position = 1 THEN 1 END) as wins,
        COUNT(CASE WHEN finish_position <= 3 THEN 1 END) as top3,
        COUNT(CASE WHEN finish_position <= 4 THEN 1 END) as top4,
        ROUND(COUNT(CASE WHEN finish_position = 1 THEN 1 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as win_rate,
        ROUND(COUNT(CASE WHEN finish_position <= 3 THEN 1 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as place_rate
      FROM race_records
      ${whereClause}
      GROUP BY draw
      ORDER BY draw
    `;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get available filter options for draw search
router.get('/options', async (req, res) => {
  try {
    const [distances, goings, courses, seasons] = await Promise.all([
      pool.query(`SELECT DISTINCT distance FROM race_records WHERE distance > 0 ORDER BY distance`),
      pool.query(`SELECT DISTINCT going FROM race_records WHERE going IS NOT NULL AND going != '' ORDER BY going`),
      pool.query(`SELECT DISTINCT race_class FROM race_records WHERE race_class IS NOT NULL AND race_class != '' ORDER BY race_class`),
      pool.query(`
        SELECT DISTINCT
          CASE
            WHEN EXTRACT(MONTH FROM race_date) >= 9 THEN EXTRACT(YEAR FROM race_date)::int
            ELSE EXTRACT(YEAR FROM race_date)::int - 1
          END as season_start
        FROM race_records
        WHERE race_date IS NOT NULL
        ORDER BY 1 DESC
      `),
    ]);
    res.json({
      distances: distances.rows.map(r => r.distance),
      goings: goings.rows.map(r => r.going),
      courses: courses.rows.map(r => r.race_class),
      seasons: seasons.rows.map(r => ({
        value: String(r.season_start),
        label: `${r.season_start}/${String(parseInt(r.season_start) + 1).slice(2)}季`,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
