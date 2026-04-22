const { scrapeJockeyPastRec, saveJockeyRecords } = require('./src/scrapers/hkjc');

async function main() {
  console.log('Scraping PZ page 1 only...');
  const records = await scrapeJockeyPastRec('PZ', null);
  console.log(`Got ${records.length} records, sample:`, JSON.stringify(records[0]));
  const saved = await saveJockeyRecords('PZ', records.slice(0, 5));
  console.log(`Saved: ${saved}`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
