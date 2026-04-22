const { scrapeJockeyPastRec, saveJockeyRecords } = require('./src/scrapers/hkjc');
const pool = require('./src/db/pool');

async function main() {
  const records = await scrapeJockeyPastRec('PZ', null);
  console.log(`PZ scraped: ${records.length}`);
  const saved = await saveJockeyRecords('PZ', records);
  console.log(`PZ saved: ${saved}`);
  const check = await pool.query(`SELECT COUNT(*) FROM race_records WHERE jockey_id=$1`,['PZ']);
  console.log(`PZ DB: ${check.rows[0].count}`);
  
  // Also check if any other jockey's records got affected
  const total = await pool.query(`SELECT COUNT(*) FROM race_records`);
  console.log(`Total records: ${total.rows[0].count}`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
