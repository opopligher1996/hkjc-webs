const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// GET /api/horses - list/search horses
router.get('/', async (req, res) => {
  try {
    const { q, limit = 100 } = req.query;
    let query, params;

    if (q) {
      query = `
        SELECT * FROM horses
        WHERE name_zh ILIKE $1 OR name_en ILIKE $1 OR id ILIKE $1
        ORDER BY name_zh
        LIMIT $2
      `;
      params = [`%${q}%`, parseInt(limit)];
    } else {
      query = `SELECT * FROM horses ORDER BY name_zh LIMIT $1`;
      params = [parseInt(limit)];
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/horses/:id - get single horse
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`SELECT * FROM horses WHERE id = $1`, [id.toUpperCase()]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '找不到馬匹' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
