/**
 * Tests for scrapeHorse HTML parsing via parseHorseHtml()
 * Uses cheerio (already a dependency) to simulate DOM parsing in Node.
 */
const cheerio = require('cheerio');
const { parseHorseHtml } = require('../src/scrapers/parsers');

// ── Minimal mock HTML matching real HKJC horse page structure ──────────────
function buildHorseHtml({
  titleText = '嘉應高昇 (J062)',
  rows = [],
  trainerHref = '/zh-hk/local/information/trainerwinstat?trainerid=HDA',
} = {}) {
  const rowHtml = rows.map(([label, value, href]) => `
    <tr>
      <td>${label}</td>
      <td>:</td>
      <td>${href ? `<a href="${href}">${value}</a>` : value}</td>
    </tr>`).join('');

  return `
    <html><body>
      <table class="horseProfile">
        <tr>
          <td>
            <table><tr>
              <td class="subsubheader"><span class="title_text">${titleText}</span></td>
            </tr></table>
          </td>
          <td valign="top">
            <table class="table_top_right table_eng_text">
              <tbody>${rowHtml}</tbody>
            </table>
          </td>
        </tr>
      </table>
    </body></html>`;
}

const STANDARD_ROWS = [
  ['出生地/馬齡', '紐西蘭 / 5'],
  ['毛色/性別', '棗 / 閹'],
  ['冠-亞-季-總出賽次數*', '20-2-0-22'],
  ['現時評分', '88'],
  ['季初評分', '85'],
  ['父系', 'Savabeel'],
  ['母系', 'High Esteem'],
  ['馬主', '嘉應堂'],
  ['練馬師', '大衛希斯', '/zh-hk/local/information/trainerwinstat?trainerid=HDA'],
];

describe('parseHorseHtml', () => {
  test('extracts horse name by stripping code in parentheses', () => {
    const html = buildHorseHtml({ titleText: '嘉應高昇 (J062)', rows: STANDARD_ROWS });
    const result = parseHorseHtml(cheerio, html);
    expect(result.name_zh).toBe('嘉應高昇');
  });

  test('handles name without trailing code gracefully', () => {
    const html = buildHorseHtml({ titleText: '無括號馬名', rows: [] });
    const result = parseHorseHtml(cheerio, html);
    expect(result.name_zh).toBe('無括號馬名');
  });

  test('parses combined 出生地/馬齡 field', () => {
    const html = buildHorseHtml({ rows: STANDARD_ROWS });
    const result = parseHorseHtml(cheerio, html);
    expect(result.origin).toBe('紐西蘭');
    expect(result.age).toBe(5);
  });

  test('parses combined 毛色/性別 field', () => {
    const html = buildHorseHtml({ rows: STANDARD_ROWS });
    const result = parseHorseHtml(cheerio, html);
    expect(result.color).toBe('棗');
    expect(result.sex).toBe('閹');
  });

  test('parses 冠-亞-季-總出賽次數* (4-number format)', () => {
    const html = buildHorseHtml({ rows: STANDARD_ROWS });
    const result = parseHorseHtml(cheerio, html);
    expect(result.wins).toBe(20);
    expect(result.seconds).toBe(2);
    expect(result.thirds).toBe(0);
    expect(result.total_starts).toBe(22);
  });

  test('parses ratings', () => {
    const html = buildHorseHtml({ rows: STANDARD_ROWS });
    const result = parseHorseHtml(cheerio, html);
    expect(result.current_rating).toBe(88);
    expect(result.season_rating).toBe(85);
  });

  test('parses sire and dam', () => {
    const html = buildHorseHtml({ rows: STANDARD_ROWS });
    const result = parseHorseHtml(cheerio, html);
    expect(result.sire).toBe('Savabeel');
    expect(result.dam).toBe('High Esteem');
  });

  test('extracts trainer ID from trainerwinstat link', () => {
    const html = buildHorseHtml({ rows: STANDARD_ROWS });
    const result = parseHorseHtml(cheerio, html);
    expect(result.trainer_id).toBe('HDA');
  });

  test('returns null trainer_id when no trainerid link present', () => {
    const html = buildHorseHtml({ rows: [['馬主', '無名馬主']] });
    const result = parseHorseHtml(cheerio, html);
    expect(result.trainer_id).toBeNull();
  });

  test('returns empty string for name_zh if title span missing', () => {
    const html = '<html><body><p>no horse here</p></body></html>';
    const result = parseHorseHtml(cheerio, html);
    expect(result.name_zh).toBe('');
  });

  test('handles full-width slash ／ in combined fields', () => {
    const html = buildHorseHtml({
      rows: [
        ['出生地／馬齡', '愛爾蘭 ／ 6'],
        ['毛色／性別', '灰 ／ 牡'],
      ]
    });
    const result = parseHorseHtml(cheerio, html);
    expect(result.origin).toBe('愛爾蘭');
    expect(result.age).toBe(6);
    expect(result.color).toBe('灰');
    expect(result.sex).toBe('牡');
  });

  test('_raw contains all label keys found', () => {
    const html = buildHorseHtml({ rows: STANDARD_ROWS });
    const result = parseHorseHtml(cheerio, html);
    expect(result._raw).toContain('出生地/馬齡');
    expect(result._raw).toContain('練馬師');
  });
});
