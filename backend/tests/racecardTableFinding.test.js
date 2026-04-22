/**
 * Tests for racecard table-finding strategy in scrapeRacecard().
 *
 * The relevant logic lives inside page.evaluate() in hkjc.js (browser context),
 * so we replicate it as a pure function here and test it in Node using cheerio
 * to build a DOM-like structure.
 *
 * Strategy (from hkjc.js):
 *   1. Try tables[3]..tables[7]: first table with ≥2 rows having ≥10 cells
 *   2. Fallback: largest table with ≥10-cell rows
 */
const cheerio = require('cheerio');

/**
 * Pure reimplementation of the racecard table-finding logic.
 * Accepts a cheerio root ($) and returns the matched table element or null.
 */
function findRacecardTable($) {
  const tables = $('table').toArray();

  // Strategy 1: tables[3..7], first one with ≥2 rows having ≥10 cells
  let mainTable = null;
  for (let startIdx = 3; startIdx <= 7 && !mainTable; startIdx++) {
    const t = tables[startIdx];
    if (!t) continue;
    const validRows = $(t).find('tbody tr').toArray()
      .filter(r => $(r).find('td').length >= 10);
    if (validRows.length >= 2) mainTable = t;
  }

  // Strategy 2: largest table with ≥10-cell rows
  if (!mainTable) {
    let best = 0;
    for (const t of tables) {
      const cnt = $(t).find('tbody tr').toArray()
        .filter(r => $(r).find('td').length >= 10).length;
      if (cnt > best) { best = cnt; mainTable = t; }
    }
  }

  return mainTable;
}

function makeTable(rows, cellCount) {
  const tds = '<td>x</td>'.repeat(cellCount);
  const trs = '<tr>' + tds + '</tr>\n';
  return `<table><tbody>${trs.repeat(rows)}</tbody></table>`;
}

describe('racecard table-finding strategy', () => {
  test('picks tables[4] when it has ≥2 rows with ≥10 cells', () => {
    // 5 tables: 0-3 have few cells, 4 has 14 rows × 15 cells
    const html = `<html><body>
      ${makeTable(2, 3)}
      ${makeTable(2, 3)}
      ${makeTable(2, 3)}
      ${makeTable(2, 3)}
      ${makeTable(14, 15)}
    </body></html>`;
    const $ = cheerio.load(html);
    const result = findRacecardTable($);
    const tables = $('table').toArray();
    expect(result).toBe(tables[4]);
  });

  test('picks tables[3] if it qualifies before tables[4]', () => {
    const html = `<html><body>
      ${makeTable(2, 3)}
      ${makeTable(2, 3)}
      ${makeTable(2, 3)}
      ${makeTable(5, 12)}
      ${makeTable(10, 15)}
    </body></html>`;
    const $ = cheerio.load(html);
    const result = findRacecardTable($);
    const tables = $('table').toArray();
    expect(result).toBe(tables[3]);
  });

  test('falls back to largest table when none in index 3-7 qualify', () => {
    // Only 2 tables, both small in strategy-1 range, but second is biggest
    const html = `<html><body>
      ${makeTable(1, 3)}
      ${makeTable(10, 12)}
    </body></html>`;
    const $ = cheerio.load(html);
    const result = findRacecardTable($);
    const tables = $('table').toArray();
    expect(result).toBe(tables[1]);
  });

  test('returns null when no tables exist', () => {
    const $ = cheerio.load('<html><body></body></html>');
    const result = findRacecardTable($);
    expect(result).toBeNull();
  });

  test('requires ≥2 valid rows to qualify in strategy-1', () => {
    // tables[3] has only 1 valid row → should not pick it in strategy 1
    // fallback picks tables[3] anyway via strategy 2 (it's the largest)
    const html = `<html><body>
      ${makeTable(2, 3)}
      ${makeTable(2, 3)}
      ${makeTable(2, 3)}
      ${makeTable(1, 12)}
    </body></html>`;
    const $ = cheerio.load(html);
    const tables = $('table').toArray();
    // Strategy 1 skips tables[3] (only 1 valid row)
    // Strategy 2 picks tables[3] (most 10-cell rows = 1, others = 0)
    const result = findRacecardTable($);
    expect(result).toBe(tables[3]);
  });

  test('a table with exactly 2 valid rows qualifies in strategy-1', () => {
    const html = `<html><body>
      ${makeTable(2, 2)}
      ${makeTable(2, 2)}
      ${makeTable(2, 2)}
      ${makeTable(2, 10)}
    </body></html>`;
    const $ = cheerio.load(html);
    const tables = $('table').toArray();
    const result = findRacecardTable($);
    expect(result).toBe(tables[3]);
  });
});
