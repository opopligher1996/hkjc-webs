/**
 * Pure parsing helpers extracted from hkjc.js for unit-testability.
 * No Puppeteer, no DB, no network dependencies.
 */

// ── parseHorseHtml ──────────────────────────────────────────────────────────
// Given the raw HTML of a horse profile page, returns the same object shape
// that scrapeHorse() would return (minus the horseId wrapper).
// Uses cheerio-compatible selectors so it can be called in Node tests.
function parseHorseHtml(cheerio, html) {
  const $ = cheerio.load(html);

  // ── Horse name ─────────────────────────────────────────────────────────────
  let name_zh = '';
  const titleSpan = $('td.subsubheader span.title_text').first();
  if (titleSpan.length) {
    name_zh = titleSpan.text().trim().replace(/\s*\([^)]+\)\s*$/, '').trim();
  }

  // ── Collect label→value pairs from table.table_top_right ──────────────────
  const data = {};
  const links = {};
  $('table.table_top_right tr').each((_, row) => {
    const cells = $(row).find('td').toArray();
    if (cells.length < 2) return;
    let labelCell, valueCell;
    if (cells.length >= 3 && $(cells[1]).text().trim() === ':') {
      labelCell = cells[0]; valueCell = cells[2];
    } else {
      labelCell = cells[0]; valueCell = cells[1];
    }
    const label = $(labelCell).text().trim().replace(/\s+/g, '');
    const value = $(valueCell).text().trim();
    if (label) {
      data[label] = value;
      const a = $(valueCell).find('a').first();
      if (a.length) links[label] = a.attr('href') || '';
    }
  });

  // ── Trainer ID ─────────────────────────────────────────────────────────────
  let trainerId = null;
  const trainerLink = links['練馬師'] || links['練馬師:'] || '';
  const trainerM = trainerLink.match(/trainerid=([^&\s]+)/i);
  if (trainerM) trainerId = trainerM[1];
  if (!trainerId) {
    const a = $('table.horseProfile a[href*="trainerid"]').first();
    if (a.length) {
      const m = (a.attr('href') || '').match(/trainerid=([^&\s]+)/i);
      if (m) trainerId = m[1];
    }
  }

  // ── Combined fields ────────────────────────────────────────────────────────
  const originAge = data['出生地/馬齡'] || data['出生地／馬齡'] || '';
  const originAgeM = originAge.match(/^(.+?)\s*[\/／]\s*(\d+)$/);
  const origin = originAgeM ? originAgeM[1].trim() : (data['出生地'] || '');
  const age = originAgeM ? parseInt(originAgeM[2]) : (parseInt(data['馬齡'] || '') || null);

  const colorSex = data['毛色/性別'] || data['毛色／性別'] || '';
  const colorSexM = colorSex.match(/^(.+?)\s*[\/／]\s*(.+)$/);
  const color = colorSexM ? colorSexM[1].trim() : (data['毛色'] || '');
  const sex = colorSexM ? colorSexM[2].trim() : (data['性別'] || '');

  const winsText = data['冠-亞-季-總出賽次數*'] || data['冠/亞/季/總出賽'] || data['冠/亞/季'] || '';
  const winsM = winsText.match(/(\d+)[\-\/](\d+)[\-\/](\d+)[\-\/]?(\d+)?/);
  const wins = winsM ? parseInt(winsM[1]) : null;
  const seconds = winsM ? parseInt(winsM[2]) : null;
  const thirds = winsM ? parseInt(winsM[3]) : null;
  const totalStarts = winsM && winsM[4] ? parseInt(winsM[4]) : (parseInt(data['總出賽'] || '') || null);

  const currentRating = parseInt(data['現時評分'] || '') || null;
  const seasonRating = parseInt(data['季初評分'] || '') || null;
  const owner = data['馬主'] || '';
  const sire = data['父系'] || data['父'] || '';
  const dam = data['母系'] || data['母'] || '';

  return {
    name_zh,
    origin,
    age,
    color,
    sex,
    wins,
    seconds,
    thirds,
    total_starts: totalStarts,
    trainer_id: trainerId,
    owner,
    current_rating: currentRating,
    season_rating: seasonRating,
    sire,
    dam,
    _raw: Object.keys(data),
  };
}

// ── parseCourseTimePayload ──────────────────────────────────────────────────
// Given the raw RSC payload string (after JSON.parse unescape), returns
// { courseTimes, courseRecords } using the same logic as scrapeCourseTime().
function parseCourseTimePayload(payloadStr) {
  function findKey(obj, key) {
    if (!obj || typeof obj !== 'object') return null;
    if (!Array.isArray(obj) && obj[key] !== undefined) return obj;
    for (const v of Object.values(obj)) {
      const found = findKey(v, key);
      if (found) return found;
    }
    return null;
  }

  function anchorToRacecourse(anchor) {
    if (!anchor) return null;
    if (anchor.includes('STAW')) return { racecourse: 'ST', trackType: 'AWT' };
    if (anchor.includes('HV')) return { racecourse: 'HV', trackType: 'TURF' };
    if (anchor.includes('ST')) return { racecourse: 'ST', trackType: 'TURF' };
    return null;
  }

  let pageData = null;
  const lines = payloadStr.split('\n');
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const jsonPart = line.slice(colonIdx + 1).trim();
    if (!jsonPart.startsWith('{') && !jsonPart.startsWith('[')) continue;
    try {
      const parsed = JSON.parse(jsonPart);
      if (parsed && typeof parsed === 'object') {
        const found = findKey(parsed, 'sectionalData');
        if (found) { pageData = found; break; }
      }
    } catch (_) {}
  }

  if (!pageData) return { courseTimes: [], courseRecords: [] };

  const courseTimes = [];
  const sectData = pageData.sectionalData || {};
  for (const section of (sectData.children || [])) {
    const anchor = section.anchor?.value || '';
    const rc = anchorToRacecourse(anchor);
    if (!rc) continue;
    for (const distBlock of (section.children || [])) {
      const distance = parseInt(distBlock.distance?.value || '') || 0;
      if (!distance) continue;
      for (const cls of (distBlock.children || [])) {
        const classCode = cls.class?.targetItem?.optionValue?.value || '';
        const classLabel = cls.class?.targetItem?.displayLabel?.value || classCode;
        const standardTime = cls.standardTimes?.value || '';
        if (!standardTime || standardTime === '-') continue;
        courseTimes.push({
          section: anchor,
          racecourse: rc.racecourse,
          trackType: rc.trackType,
          distance,
          raceClass: classLabel || classCode,
          standardTime,
          splitStart2000: cls.start2000M?.value || null,
          split20001600: cls.start201600M?.value || null,
          split16001200: cls.start161200M?.value || null,
          split12008000: cls.start12800M?.value || null,
          split8004000: cls.start8400M?.value || null,
          split400Finish: cls.start400M?.value || null,
        });
      }
    }
  }

  const courseRecords = [];
  const recData = pageData.classRecordData || {};
  for (const section of (recData.children || [])) {
    const displayTitle = section.displayTitle?.value || '';
    let rc;
    if (displayTitle.includes('跑馬地')) rc = { racecourse: 'HV', trackType: 'TURF' };
    else if (displayTitle.includes('全天候')) rc = { racecourse: 'ST', trackType: 'AWT' };
    else rc = { racecourse: 'ST', trackType: 'TURF' };

    for (const distBlock of (section.children || [])) {
      const distance = parseInt(distBlock.distance?.value || '') || 0;
      if (!distance) continue;
      for (const cls of (distBlock.children || [])) {
        const raceClass = cls.class?.value || '';
        const horseName = cls.horseName?.value || '';
        const recordTime = cls.time?.value || '';
        const weight = cls.weight?.value || null;
        const dateMs = cls.date?.dateValue || null;
        const recordDate = dateMs ? new Date(Number(dateMs)).toISOString().split('T')[0] : null;
        if (horseName || recordTime) {
          courseRecords.push({ racecourse: rc.racecourse, trackType: rc.trackType, distance, raceClass, horseName, recordTime, weight, recordDate });
        }
      }
    }
  }

  return { courseTimes, courseRecords };
}

module.exports = { parseHorseHtml, parseCourseTimePayload };
