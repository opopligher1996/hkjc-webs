const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Get next race date
router.get('/next', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await pool.query(
      `SELECT id, TO_CHAR(race_date, 'YYYY-MM-DD') AS race_date, racecourse, season, created_at
       FROM fixtures WHERE race_date >= $1 ORDER BY race_date ASC LIMIT 1`,
      [today]
    );
    if (result.rows.length === 0) {
      return res.json({ race_date: null, racecourse: null });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all fixtures
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, TO_CHAR(race_date, 'YYYY-MM-DD') AS race_date, racecourse, season, created_at
       FROM fixtures ORDER BY race_date DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get racecard for a specific date
router.get('/racecard', async (req, res) => {
  try {
    const { date } = req.query;
    let targetDate = date;

    if (!targetDate) {
      const today = new Date().toISOString().split('T')[0];
      const next = await pool.query(
        `SELECT TO_CHAR(race_date, 'YYYY-MM-DD') AS race_date FROM fixtures WHERE race_date >= $1 ORDER BY race_date ASC LIMIT 1`,
        [today]
      );
      targetDate = next.rows.length > 0 ? next.rows[0].race_date : today;
    }

    const result = await pool.query(
      `SELECT r.*, j.name_zh as jockey_name, t.name_zh as trainer_name
       FROM racecard r
       LEFT JOIN jockeys j ON r.jockey_id = j.id
       LEFT JOIN trainers t ON r.trainer_id = t.id
       WHERE r.race_date = $1
       ORDER BY r.race_no, r.horse_no`,
      [targetDate]
    );

    // Group by race number
    const races = {};
    for (const row of result.rows) {
      if (!races[row.race_no]) {
        races[row.race_no] = {
          race_no: row.race_no,
          racecourse: row.racecourse,
          race_class: row.race_class,
          distance: row.distance,
          track_type: row.track_type,
          going: row.going,
          horses: [],
        };
      }
      races[row.race_no].horses.push(row);
    }

    res.json({
      date: targetDate,
      races: Object.values(races).sort((a, b) => a.race_no - b.race_no),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
