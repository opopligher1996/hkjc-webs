const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// GET /api/coursetime - get course times (分段時間), optionally filtered
router.get('/', async (req, res) => {
  try {
    const { racecourse } = req.query;
    let conditions = [];
    let params = [];
    let idx = 1;

    if (racecourse && racecourse !== 'ALL') {
      conditions.push(`racecourse = $${idx++}`);
      params.push(racecourse);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `SELECT * FROM course_times ${where} ORDER BY racecourse, track_type, distance, race_class`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/coursetime/records - get course records (紀錄時間)
router.get('/records', async (req, res) => {
  try {
    const { racecourse } = req.query;
    let conditions = [];
    let params = [];
    let idx = 1;

    if (racecourse && racecourse !== 'ALL') {
      conditions.push(`racecourse = $${idx++}`);
      params.push(racecourse);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `SELECT * FROM course_records ${where} ORDER BY racecourse, track_type, distance, race_class`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
