const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Get all jockeys with stats, grouped by canonical_id
router.get('/', async (req, res) => {
  try {
    const { racecourse, track_type, race_class, going, draw } = req.query;

    let conditions = [];
    let params = [];
    let idx = 1;

    if (racecourse) { conditions.push(`r.racecourse = $${idx++}`); params.push(racecourse); }
    if (track_type) { conditions.push(`r.track_type = $${idx++}`); params.push(track_type); }
    if (race_class) { conditions.push(`r.race_class = $${idx++}`); params.push(race_class); }
    if (going) { conditions.push(`r.going = $${idx++}`); params.push(going); }
    if (draw) { conditions.push(`r.draw = $${idx++}`); params.push(parseInt(draw)); }

    const whereClause = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';

    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
    const oneMonthAgoStr = oneMonthAgo.toISOString().split('T')[0];

    // Join race_records via ALL aliases (j2), group by canonical_id
    // canonical jockey info comes from the row where id = canonical_id
    const query = `
      SELECT
        j.canonical_id AS id,
        j.name_zh,
        COUNT(CASE WHEN r.race_date >= $${idx} ${whereClause} THEN 1 END) AS month_total,
        COUNT(CASE WHEN r.race_date >= $${idx} AND r.finish_position = 1 ${whereClause} THEN 1 END) AS month_1st,
        COUNT(CASE WHEN r.race_date >= $${idx} AND r.finish_position = 2 ${whereClause} THEN 1 END) AS month_2nd,
        COUNT(CASE WHEN r.race_date >= $${idx} AND r.finish_position = 3 ${whereClause} THEN 1 END) AS month_3rd,
        COUNT(CASE WHEN r.race_date >= $${idx} AND r.finish_position = 4 ${whereClause} THEN 1 END) AS month_4th,
        COUNT(CASE WHEN r.race_date IS NOT NULL ${whereClause} THEN 1 END) AS season_total,
        COUNT(CASE WHEN r.finish_position = 1 ${whereClause} THEN 1 END) AS season_1st,
        COUNT(CASE WHEN r.finish_position = 2 ${whereClause} THEN 1 END) AS season_2nd,
        COUNT(CASE WHEN r.finish_position = 3 ${whereClause} THEN 1 END) AS season_3rd,
        COUNT(CASE WHEN r.finish_position = 4 ${whereClause} THEN 1 END) AS season_4th
      FROM (
        -- One row per canonical jockey, using the name from the canonical ID row
        SELECT DISTINCT ON (canonical_id)
          canonical_id, name_zh
        FROM jockeys
        ORDER BY canonical_id, (CASE WHEN id = canonical_id THEN 0 ELSE 1 END)
      ) j
      LEFT JOIN race_records r ON r.jockey_id IN (
        SELECT id FROM jockeys WHERE canonical_id = j.canonical_id
      )
      GROUP BY j.canonical_id, j.name_zh
      ORDER BY season_1st DESC, season_total DESC
    `;

    params.push(oneMonthAgoStr);
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get filter options
router.get('/filters', async (req, res) => {
  try {
    const [racecourses, track_types, race_classes, goings, draws] = await Promise.all([
      pool.query(`SELECT DISTINCT racecourse FROM race_records WHERE racecourse IS NOT NULL AND racecourse != '' ORDER BY racecourse`),
      pool.query(`SELECT DISTINCT track_type FROM race_records WHERE track_type IS NOT NULL AND track_type != '' ORDER BY track_type`),
      pool.query(`SELECT DISTINCT race_class FROM race_records WHERE race_class IS NOT NULL AND race_class != '' AND race_class NOT LIKE '%草地%' AND race_class != '全天候' ORDER BY race_class`),
      pool.query(`SELECT DISTINCT going FROM race_records WHERE going IS NOT NULL AND going != '' ORDER BY going`),
      pool.query(`SELECT DISTINCT draw FROM race_records WHERE draw IS NOT NULL AND draw > 0 ORDER BY draw`),
    ]);
    res.json({
      racecourses: racecourses.rows.map(r => r.racecourse),
      track_types: track_types.rows.map(r => r.track_type),
      race_classes: race_classes.rows.map(r => r.race_class),
      goings: goings.rows.map(r => r.going),
      draws: draws.rows.map(r => r.draw),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
