const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'hkjc',
  user: process.env.DB_USER || 'hkjcadmin',
  password: process.env.DB_PASSWORD || 'hkjc@2024!',
});

module.exports = pool;
