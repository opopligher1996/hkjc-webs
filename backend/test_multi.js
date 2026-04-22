const { scrapeJockeyPastRec, saveJockeyRecords } = require('./src/scrapers/hkjc');
const pool = require('./src/db/pool');

async function main() {
  const ids = ['PZ','BH','TEK'];
  for (const id of ids) {
    const records = await scrapeJockeyPastRec(id, null);
    console.log(`${id}: scraped ${records.length} records`);
    const saved = await saveJockeyRecords(id, records);
    console.log(`${id}: saved ${saved}`);
    const check = await pool.query(`SELECT COUNT(*) FROM race_records WHERE jockey_id=$1`,[id]);
    console.log(`${id}: DB count = ${check.rows[0].count}`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
