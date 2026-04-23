const pool = require('./pool');

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS jockeys (
        id VARCHAR(20) PRIMARY KEY,
        name_zh VARCHAR(100),
        name_en VARCHAR(100),
        canonical_id VARCHAR(20),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS trainers (
        id VARCHAR(20) PRIMARY KEY,
        name_zh VARCHAR(100),
        name_en VARCHAR(100),
        canonical_id VARCHAR(20),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS race_records (
        id SERIAL PRIMARY KEY,
        race_date DATE NOT NULL,
        racecourse VARCHAR(10),
        race_no INTEGER,
        race_class VARCHAR(20),
        track_type VARCHAR(20),
        distance INTEGER,
        going VARCHAR(20),
        horse_no INTEGER,
        draw INTEGER,
        finish_position INTEGER,
        total_runners INTEGER,
        jockey_id VARCHAR(20),
        trainer_id VARCHAR(20),
        trainer_name VARCHAR(100),
        horse_name VARCHAR(100),
        rating INTEGER,
        gear VARCHAR(50),
        horse_weight INTEGER,
        actual_weight INTEGER,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(race_date, racecourse, race_no, horse_no)
      );

      CREATE TABLE IF NOT EXISTS fixtures (
        id SERIAL PRIMARY KEY,
        race_date DATE NOT NULL UNIQUE,
        racecourse VARCHAR(10),
        season VARCHAR(20),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS racecard (
        id SERIAL PRIMARY KEY,
        race_date DATE NOT NULL,
        racecourse VARCHAR(10),
        race_no INTEGER,
        race_class VARCHAR(50),
        distance INTEGER,
        track_type VARCHAR(20),
        going VARCHAR(20),
        horse_no INTEGER,
        horse_id VARCHAR(20),
        draw INTEGER,
        horse_name VARCHAR(100),
        recent_form VARCHAR(20),
        jockey_id VARCHAR(20),
        jockey_name VARCHAR(100),
        trainer_id VARCHAR(20),
        trainer_name VARCHAR(100),
        actual_weight NUMERIC(5,1),
        rating INTEGER,
        rating_change VARCHAR(10),
        declared_weight INTEGER,
        gear VARCHAR(100),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(race_date, race_no, horse_no)
      );

      CREATE TABLE IF NOT EXISTS horses (
        id VARCHAR(20) PRIMARY KEY,
        name_zh VARCHAR(100),
        name_en VARCHAR(100),
        origin VARCHAR(50),
        age INTEGER,
        color VARCHAR(50),
        sex VARCHAR(20),
        wins INTEGER DEFAULT 0,
        seconds INTEGER DEFAULT 0,
        thirds INTEGER DEFAULT 0,
        total_starts INTEGER DEFAULT 0,
        trainer_id VARCHAR(20),
        owner VARCHAR(200),
        current_rating INTEGER,
        season_rating INTEGER,
        sire VARCHAR(100),
        dam VARCHAR(100),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS course_times (
        id SERIAL PRIMARY KEY,
        section VARCHAR(20) NOT NULL,
        racecourse VARCHAR(10) NOT NULL,
        track_type VARCHAR(20),
        distance INTEGER NOT NULL,
        race_class VARCHAR(50),
        standard_time VARCHAR(20),
        split_start_2000 VARCHAR(20),
        split_2000_1600 VARCHAR(20),
        split_1600_1200 VARCHAR(20),
        split_1200_800 VARCHAR(20),
        split_800_400 VARCHAR(20),
        split_400_finish VARCHAR(20),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(section, racecourse, distance, race_class)
      );

      CREATE TABLE IF NOT EXISTS course_records (
        id SERIAL PRIMARY KEY,
        racecourse VARCHAR(10) NOT NULL,
        track_type VARCHAR(20),
        distance INTEGER NOT NULL,
        race_class VARCHAR(50),
        horse_name VARCHAR(100),
        record_time VARCHAR(20),
        weight INTEGER,
        record_date DATE,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(racecourse, distance, race_class)
      );

      CREATE INDEX IF NOT EXISTS idx_race_records_jockey ON race_records(jockey_id);
      CREATE INDEX IF NOT EXISTS idx_race_records_trainer ON race_records(trainer_id);
      CREATE INDEX IF NOT EXISTS idx_race_records_date ON race_records(race_date);
      CREATE INDEX IF NOT EXISTS idx_race_records_racecourse ON race_records(racecourse);
      CREATE INDEX IF NOT EXISTS idx_race_records_track ON race_records(track_type);
      CREATE INDEX IF NOT EXISTS idx_race_records_distance ON race_records(distance);
      CREATE INDEX IF NOT EXISTS idx_race_records_going ON race_records(going);
      CREATE INDEX IF NOT EXISTS idx_race_records_class ON race_records(race_class);
      CREATE INDEX IF NOT EXISTS idx_race_records_draw ON race_records(draw);

      CREATE TABLE IF NOT EXISTS sensor_readings (
        id SERIAL PRIMARY KEY,
        temperature NUMERIC(5,2) NOT NULL,
        humidity NUMERIC(5,2) NOT NULL,
        recorded_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_sensor_readings_recorded_at ON sensor_readings(recorded_at DESC);
    `);
    console.log('Database initialized successfully');

    // Migrate: add new columns to race_records if not already present
    const migrations = [
      `ALTER TABLE race_records ADD COLUMN IF NOT EXISTS total_runners INTEGER`,
      `ALTER TABLE race_records ADD COLUMN IF NOT EXISTS trainer_name VARCHAR(100)`,
      `ALTER TABLE race_records ADD COLUMN IF NOT EXISTS rating INTEGER`,
      `ALTER TABLE race_records ADD COLUMN IF NOT EXISTS gear VARCHAR(50)`,
      `ALTER TABLE race_records ADD COLUMN IF NOT EXISTS horse_weight INTEGER`,
      `ALTER TABLE race_records ADD COLUMN IF NOT EXISTS actual_weight INTEGER`,
      `ALTER TABLE jockeys ADD COLUMN IF NOT EXISTS canonical_id VARCHAR(20)`,
      `ALTER TABLE trainers ADD COLUMN IF NOT EXISTS canonical_id VARCHAR(20)`,
      // Backfill canonical_id = id for existing rows
      `UPDATE jockeys SET canonical_id = id WHERE canonical_id IS NULL`,
      `UPDATE trainers SET canonical_id = id WHERE canonical_id IS NULL`,
      // race_records new columns for horse performance data
      `ALTER TABLE race_records ADD COLUMN IF NOT EXISTS margin_to_winner VARCHAR(20)`,
      `ALTER TABLE race_records ADD COLUMN IF NOT EXISTS running_positions VARCHAR(100)`,
      `ALTER TABLE race_records ADD COLUMN IF NOT EXISTS finish_time VARCHAR(20)`,
      `ALTER TABLE race_records ADD COLUMN IF NOT EXISTS horse_id VARCHAR(20)`,
      // racecard new columns
      `ALTER TABLE racecard ADD COLUMN IF NOT EXISTS racecourse VARCHAR(10)`,
      `ALTER TABLE racecard ADD COLUMN IF NOT EXISTS horse_id VARCHAR(20)`,
      `ALTER TABLE racecard ADD COLUMN IF NOT EXISTS recent_form VARCHAR(20)`,
      `ALTER TABLE racecard ADD COLUMN IF NOT EXISTS jockey_name VARCHAR(100)`,
      `ALTER TABLE racecard ADD COLUMN IF NOT EXISTS trainer_id VARCHAR(20)`,
      `ALTER TABLE racecard ADD COLUMN IF NOT EXISTS trainer_name VARCHAR(100)`,
      `ALTER TABLE racecard ADD COLUMN IF NOT EXISTS actual_weight NUMERIC(5,1)`,
      `ALTER TABLE racecard ADD COLUMN IF NOT EXISTS rating_change VARCHAR(10)`,
      `ALTER TABLE racecard ADD COLUMN IF NOT EXISTS declared_weight INTEGER`,
      `ALTER TABLE racecard ADD COLUMN IF NOT EXISTS gear VARCHAR(100)`,
      // Drop old course_times structure if it exists with wrong schema and recreate via IF NOT EXISTS above
      `ALTER TABLE course_times ADD COLUMN IF NOT EXISTS section VARCHAR(20)`,
      `ALTER TABLE course_times ADD COLUMN IF NOT EXISTS race_class VARCHAR(50)`,
      `ALTER TABLE course_times ADD COLUMN IF NOT EXISTS split_start_2000 VARCHAR(20)`,
      `ALTER TABLE course_times ADD COLUMN IF NOT EXISTS split_2000_1600 VARCHAR(20)`,
      `ALTER TABLE course_times ADD COLUMN IF NOT EXISTS split_1600_1200 VARCHAR(20)`,
      `ALTER TABLE course_times ADD COLUMN IF NOT EXISTS split_1200_800 VARCHAR(20)`,
      `ALTER TABLE course_times ADD COLUMN IF NOT EXISTS split_800_400 VARCHAR(20)`,
      `ALTER TABLE course_times ADD COLUMN IF NOT EXISTS split_400_finish VARCHAR(20)`,
      // Fix course_times unique constraint: drop old wrong constraint, add correct one
      `DO $$ BEGIN
         IF EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname = 'course_times_racecourse_distance_course_going_key'
         ) THEN
           ALTER TABLE course_times DROP CONSTRAINT course_times_racecourse_distance_course_going_key;
         END IF;
       END $$`,
      `DO $$ BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname = 'course_times_unique'
         ) THEN
           ALTER TABLE course_times ADD CONSTRAINT course_times_unique UNIQUE (section, racecourse, distance, race_class);
         END IF;
       END $$`,
      // race_sectional_times: stores per-horse sectional times scraped from displaysectionaltime page
      `CREATE TABLE IF NOT EXISTS race_sectional_times (
         id SERIAL PRIMARY KEY,
         race_date DATE NOT NULL,
         racecourse VARCHAR(10),
         race_no INTEGER NOT NULL,
         race_class VARCHAR(50),
         distance INTEGER,
         track_type VARCHAR(20),
         going VARCHAR(50),
         finish_position INTEGER,
         horse_no INTEGER NOT NULL,
         horse_id VARCHAR(20),
         horse_name VARCHAR(100),
         finish_time VARCHAR(20),
         seg1 VARCHAR(20),
         seg2 VARCHAR(20),
         seg3 VARCHAR(20),
         seg4 VARCHAR(20),
         seg5 VARCHAR(20),
         seg6 VARCHAR(20),
         cumulative_times JSONB,
         running_positions VARCHAR(200),
         scraped_at TIMESTAMP DEFAULT NOW(),
         UNIQUE (race_date, race_no, horse_no)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_rst_race_date ON race_sectional_times(race_date)`,
      `CREATE INDEX IF NOT EXISTS idx_rst_horse_id ON race_sectional_times(horse_id)`,
      `CREATE INDEX IF NOT EXISTS idx_rst_horse_no_date ON race_sectional_times(horse_no, race_date DESC)`,
    ];
    for (const sql of migrations) {
      await client.query(sql);
    }
    console.log('Migrations applied successfully');
  } finally {
    client.release();
  }
}

module.exports = { initDb };
