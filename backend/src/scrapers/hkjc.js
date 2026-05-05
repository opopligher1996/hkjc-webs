const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const pool = require('../db/pool');

let browser = null;

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
      ],
    });
  }
  return browser;
}

async function newPage() {
  const b = await getBrowser();
  const page = await b.newPage();
  await page.setDefaultNavigationTimeout(60000);
  await page.setDefaultTimeout(30000);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-HK,zh;q=0.9' });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  return page;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function parseRacecourse(text) {
  const map = { '沙田': 'ST', '跑馬地': 'HV', '從化': 'CGA' };
  for (const [k, v] of Object.entries(map)) {
    if (text.includes(k)) return v;
  }
  return text.trim();
}

function parseTrackType(text) {
  if (text.includes('全天候')) return 'AWT';
  if (text.includes('草地')) return 'TURF';
  return text.trim();
}

// ── Scrape jockey list + stats via intercepting GraphQL response ───────────
// Returns array of { id, name_zh, name_en, ssnStat }
async function scrapeJockeyList() {
  const page = await newPage();
  let jockeyStatData = null;

  page.on('response', async res => {
    if (res.url().includes('info.cld.hkjc.com')) {
      try {
        const body = await res.json();
        if (body.data?.jockeyStat) jockeyStatData = body.data.jockeyStat;
      } catch (_) {}
    }
  });

  try {
    await page.goto(
      'https://racing.hkjc.com/zh-hk/local/info/jockey-ranking?season=Current&view=Numbers&racecourse=ALL',
      { waitUntil: 'networkidle0' }
    );
    await sleep(2000);

    if (!jockeyStatData) {
      console.warn('[Jockey] GraphQL not intercepted, using fallback');
      return getKnownJockeys();
    }

    const knownById = {};
    const knownByName = {};
    for (const k of getKnownJockeys()) {
      knownById[k.id] = k;
      knownByName[k.name_zh] = k;
    }

    const jockeys = jockeyStatData.map(j => {
      const name_zh = j.name_ch;
      // If GraphQL returns a new ID, remap to the known old ID by name
      const known = knownById[j.id] || knownByName[name_zh];
      const id = known ? known.id : j.id;
      return { id, name_zh, name_en: j.name_en, status: j.status, ssnStat: j.ssnStat || [] };
    });

    // Also include any known jockeys not returned by GraphQL (retired/inactive this period)
    const graphqlIds = new Set(jockeys.map(j => j.id));
    for (const k of getKnownJockeys()) {
      if (!graphqlIds.has(k.id)) {
        jockeys.push({ id: k.id, name_zh: k.name_zh, name_en: null, ssnStat: [] });
      }
    }

    console.log(`[Jockey] Found ${jockeys.length} jockeys (GraphQL + known list)`);
    return jockeys;
  } catch (err) {
    console.error('[Jockey] List scrape error:', err.message);
    return getKnownJockeys();
  } finally {
    await page.close();
  }
}

// ── Scrape trainer list + stats via intercepting GraphQL response ──────────
async function scrapeTrainerList() {
  const page = await newPage();
  let trainerStatData = null;

  page.on('response', async res => {
    if (res.url().includes('info.cld.hkjc.com')) {
      try {
        const body = await res.json();
        if (body.data?.trainerStat) trainerStatData = body.data.trainerStat;
      } catch (_) {}
    }
  });

  try {
    await page.goto(
      'https://racing.hkjc.com/zh-hk/local/info/trainer-ranking?season=Current&view=Numbers&racecourse=ALL',
      { waitUntil: 'networkidle0' }
    );
    await sleep(2000);

    if (!trainerStatData) {
      console.warn('[Trainer] GraphQL not intercepted, using fallback');
      return getKnownTrainers();
    }

    const knownById = {};
    const knownByName = {};
    for (const k of getKnownTrainers()) {
      knownById[k.id] = k;
      knownByName[k.name_zh] = k;
    }

    const trainers = trainerStatData.map(t => {
      const name_zh = t.name_ch;
      const known = knownById[t.id] || knownByName[name_zh];
      const id = known ? known.id : t.id;
      return { id, name_zh, name_en: t.name_en, status: t.status, ssnStat: t.ssnStat || [] };
    });

    // Include known trainers not in GraphQL response
    const graphqlIds = new Set(trainers.map(t => t.id));
    for (const k of getKnownTrainers()) {
      if (!graphqlIds.has(k.id)) {
        trainers.push({ id: k.id, name_zh: k.name_zh, name_en: null, ssnStat: [] });
      }
    }

    console.log(`[Trainer] Found ${trainers.length} trainers (GraphQL + known list)`);
    return trainers;
  } catch (err) {
    console.error('[Trainer] List scrape error:', err.message);
    return getKnownTrainers();
  } finally {
    await page.close();
  }
}

// ── Parse past records table (shared logic for jockey & trainer) ───────────
// Table structure:
//   Single-cell rows: date/venue header "DD/MM/YYYY  沙田"
//   Multi-cell rows:  race records
//
// Jockey record cells: [raceNo, finishPos("A/B"), trackClass, distance, going, horseName, draw, rating, trainer, gear, ...]
// Trainer record cells: [raceNo, horseName, finishPos("A/B"), trackClass, distance, going, draw, rating, odds, jockeyName, gear, ...]
function parsePastRecTable(table, type) {
  const records = [];
  let currentDate = null;
  let currentVenue = null;

  table.querySelectorAll('tbody tr').forEach(row => {
    const cells = Array.from(row.querySelectorAll('td'));

    if (cells.length === 1) {
      // Date/venue header row
      const text = cells[0].textContent.trim();
      const dateMatch = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (dateMatch) {
        currentDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
        currentVenue = parseRacecourse(text);
      }
      return;
    }

    if (cells.length < 8 || !currentDate) return;

    const cellText = i => (cells[i]?.textContent || '').trim();

    if (type === 'jockey') {
      // cells: [raceNo, finishPos, trackClass, distance, going, horseName, draw, rating, trainerName, gear, ...]
      const raceNoRaw = cellText(0);
      const raceNo = parseInt(raceNoRaw) || 0;
      if (!raceNo) return;

      const posRaw = cellText(1);  // e.g. "3/14"
      const posMatch = posRaw.match(/^(\d+)\/(\d+)$/);
      const finishPos = posMatch ? parseInt(posMatch[1]) : 0;
      const totalRunners = posMatch ? parseInt(posMatch[2]) : 0;

      const trackClassRaw = cellText(2);
      const trackType = parseTrackType(trackClassRaw);
      const raceClass = trackClassRaw;

      const distance = parseInt(cellText(3).replace(/\D/g, '')) || 0;
      const going = cellText(5);
      const horseName = cellText(6);
      const draw = parseInt(cellText(4)) || 0;  // draw is col 4 (gate number)

      records.push({
        raceDate: currentDate,
        racecourse: currentVenue,
        raceNo,
        horseName,
        draw,
        raceClass,
        trackType,
        distance,
        going,
        finishPos,
        totalRunners,
      });
    } else {
      // trainer: cells: [raceNo, horseName, finishPos, trackClass, distance, going, draw, rating, odds, jockeyName, gear, ...]
      const raceNoRaw = cellText(0);
      const raceNo = parseInt(raceNoRaw) || 0;
      if (!raceNo) return;

      const horseName = cellText(1);
      const posRaw = cellText(2);
      const posMatch = posRaw.match(/^(\d+)\/(\d+)$/);
      const finishPos = posMatch ? parseInt(posMatch[1]) : 0;
      const totalRunners = posMatch ? parseInt(posMatch[2]) : 0;

      const trackClassRaw = cellText(3);
      const trackType = parseTrackType(trackClassRaw);
      const raceClass = trackClassRaw;

      const distance = parseInt(cellText(4).replace(/\D/g, '')) || 0;
      const going = cellText(5);
      const draw = parseInt(cellText(6)) || 0;
      const jockeyName = cellText(9);

      records.push({
        raceDate: currentDate,
        racecourse: currentVenue,
        raceNo,
        horseName,
        draw,
        raceClass,
        trackType,
        distance,
        going,
        finishPos,
        totalRunners,
        jockeyName,
      });
    }
  });

  return records;
}

// ── Scrape jockey past records ─────────────────────────────────────────────
async function scrapeJockeyPastRec(jockeyId, onProgress) {
  const page = await newPage();
  const allRecords = [];
  let pageNum = 1;

  try {
    while (true) {
      const url = `https://racing.hkjc.com/zh-hk/local/information/jockeypastrec?jockeyid=${jockeyId}&season=Current&PageNum=${pageNum}`;
      await page.goto(url, { waitUntil: 'networkidle0' });
      await sleep(500);

      const { records, hasNext } = await page.evaluate((pgNum) => {
        // Table[1] contains the race records
        const tables = document.querySelectorAll('table');
        const table = tables[1];
        if (!table) return { records: [], hasNext: false };

        const records = [];
        let currentDate = null;
        let currentVenue = null;

        const rcMap = { '沙田': 'ST', '跑馬地': 'HV', '從化': 'CGA' };

        table.querySelectorAll('tbody tr').forEach(row => {
          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length === 1) {
            const text = cells[0].textContent.trim();
            const dm = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
            if (dm) {
              currentDate = `${dm[3]}-${dm[2]}-${dm[1]}`;
              for (const [k, v] of Object.entries(rcMap)) {
                if (text.includes(k)) { currentVenue = v; break; }
              }
            }
          } else if (cells.length >= 8 && currentDate) {
            const c = i => (cells[i]?.textContent || '').trim();
            const raceNo = parseInt(c(0)) || 0;
            if (!raceNo) return;
            // Headers: [0]場次 [1]名次 [2]跑道/賽道 [3]途程 [4]賽事班次 [5]場地狀況 [6]馬名 [7]檔位 [8]評分 [9]練馬師 [10]配備 [11]馬匹體重 [12]實際負磅
            const posMatch = c(1).match(/^(\d+)\/(\d+)$/);
            const finishPos = posMatch ? parseInt(posMatch[1]) : 0;
            const totalRunners = posMatch ? parseInt(posMatch[2]) : 0;
            const trackRaw = c(2);  // e.g. 草地"B", 全天候
            const trackType = trackRaw.includes('全天候') ? 'AWT' : 'TURF';
            const distance = parseInt(c(3).replace(/\D/g, '')) || 0;
            const raceClass = c(4);  // race class number e.g. "2", "3"
            const going = c(5);
            const horseName = c(6);
            const draw = parseInt(c(7)) || 0;  // 檔位 (gate/draw)
            const rating = parseInt(c(8)) || null;
            const trainerName = c(9) || null;
            const gear = c(10) || null;
            const horseWeight = parseInt(c(11)) || null;
            const actualWeight = parseInt(c(12)) || null;
            records.push({ raceDate: currentDate, racecourse: currentVenue, raceNo, horseName, draw, raceClass, trackType, distance, going, finishPos, totalRunners, rating, trainerName, gear, horseWeight, actualWeight });
          }
        });

        // Check for next page link
        let hasNext = false;
        document.querySelectorAll('a[href*="PageNum"]').forEach(a => {
          const m = a.href.match(/PageNum=(\d+)/);
          if (m && parseInt(m[1]) === pgNum + 1) hasNext = true;
        });

        return { records, hasNext };
      }, pageNum);

      allRecords.push(...records);
      if (onProgress) onProgress({ jockeyId, pageNum, count: allRecords.length });
      console.log(`[Jockey ${jockeyId}] Page ${pageNum}: ${records.length} records (total: ${allRecords.length})`);

      if (!hasNext || records.length === 0 || pageNum >= 50) break;
      pageNum++;
      await sleep(800);
    }
  } catch (err) {
    console.error(`[Jockey ${jockeyId}] Error:`, err.message);
  } finally {
    await page.close();
  }

  return allRecords;
}

// ── Scrape trainer past records ────────────────────────────────────────────
async function scrapeTrainerPastRec(trainerId, onProgress) {
  const page = await newPage();
  const allRecords = [];
  let pageNum = 1;

  try {
    while (true) {
      const url = `https://racing.hkjc.com/zh-hk/local/information/trainerpastrec?trainerid=${trainerId}&season=Current&PageNum=${pageNum}`;
      await page.goto(url, { waitUntil: 'networkidle0' });
      await sleep(500);

      const { records, hasNext } = await page.evaluate((pgNum) => {
        const tables = document.querySelectorAll('table');
        const table = tables[1];
        if (!table) return { records: [], hasNext: false };

        const records = [];
        let currentDate = null;
        let currentVenue = null;
        const rcMap = { '沙田': 'ST', '跑馬地': 'HV', '從化': 'CGA' };

        table.querySelectorAll('tbody tr').forEach(row => {
          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length === 1) {
            const text = cells[0].textContent.trim();
            const dm = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
            if (dm) {
              currentDate = `${dm[3]}-${dm[2]}-${dm[1]}`;
              for (const [k, v] of Object.entries(rcMap)) {
                if (text.includes(k)) { currentVenue = v; break; }
              }
            }
          } else if (cells.length >= 8 && currentDate) {
            const c = i => (cells[i]?.textContent || '').trim();
            const raceNo = parseInt(c(0)) || 0;
            if (!raceNo) return;
            // [0]raceNo [1]horseName [2]finish/field [3]trackClass [4]dist [5]going [6]draw [7]rating [8]odds [9]jockeyName [10]gear [11]horseWeight [12]actualWeight
            const horseName = c(1);
            const posMatch = c(2).match(/^(\d+)\/(\d+)$/);
            const finishPos = posMatch ? parseInt(posMatch[1]) : 0;
            const totalRunners = posMatch ? parseInt(posMatch[2]) : 0;
            const trackClassRaw = c(3);
            const trackType = trackClassRaw.includes('全天候') ? 'AWT' : 'TURF';
            const distance = parseInt(c(4).replace(/\D/g, '')) || 0;
            const going = c(5);
            const draw = parseInt(c(6)) || 0;
            const rating = parseInt(c(7)) || null;
            const jockeyName = c(9) || null;
            const gear = c(10) || null;
            const horseWeight = parseInt(c(11)) || null;
            const actualWeight = parseInt(c(12)) || null;
            records.push({ raceDate: currentDate, racecourse: currentVenue, raceNo, horseName, draw, raceClass: trackClassRaw, trackType, distance, going, finishPos, totalRunners, jockeyName, rating, gear, horseWeight, actualWeight });
          }
        });

        let hasNext = false;
        document.querySelectorAll('a[href*="PageNum"]').forEach(a => {
          const m = a.href.match(/PageNum=(\d+)/);
          if (m && parseInt(m[1]) === pgNum + 1) hasNext = true;
        });

        return { records, hasNext };
      }, pageNum);

      allRecords.push(...records);
      if (onProgress) onProgress({ trainerId, pageNum, count: allRecords.length });
      console.log(`[Trainer ${trainerId}] Page ${pageNum}: ${records.length} records (total: ${allRecords.length})`);

      if (!hasNext || records.length === 0 || pageNum >= 50) break;
      pageNum++;
      await sleep(800);
    }
  } catch (err) {
    console.error(`[Trainer ${trainerId}] Error:`, err.message);
  } finally {
    await page.close();
  }

  return allRecords;
}

// ── Scrape fixtures ────────────────────────────────────────────────────────
async function scrapeFixtures() {
  const page = await newPage();
  const fixtures = [];

  try {
    const now = new Date();
    for (let offset = -1; offset <= 3; offset++) {
      const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      // HKJC fixture page requires zero-padded month (e.g. "04" not "4")
      const paddedMonth = String(month).padStart(2, '0');

      await page.goto(
        `https://racing.hkjc.com/zh-hk/local/information/fixture?calyear=${year}&calmonth=${paddedMonth}`,
        { waitUntil: 'networkidle2', timeout: 20000 }
      );
      await sleep(1000);

      // The fixture calendar uses td.calendar cells for race days.
      // Each cell has a day number in span.f_fs14 and racecourse icons in img[alt].
      // ST/HV/CGA are in the first img alt after the day span.
      const monthFixtures = await page.evaluate((y, pm) => {
        const found = [];
        document.querySelectorAll('td.calendar').forEach(td => {
          const daySpan = td.querySelector('span.f_fl.f_fs14, span.f_fs14');
          if (!daySpan) return;
          const day = parseInt(daySpan.textContent.trim(), 10);
          if (!day || isNaN(day)) return;

          // Determine racecourse from first img alt (ST, HV, CGA)
          let racecourse = 'ST';
          const imgs = td.querySelectorAll('img');
          for (const img of imgs) {
            const alt = (img.alt || '').toUpperCase();
            if (alt === 'ST' || alt === 'HV' || alt === 'CGA') {
              racecourse = alt;
              break;
            }
          }

          const paddedDay = String(day).padStart(2, '0');
          const dateStr = `${y}-${pm}-${paddedDay}`;
          found.push({ date: dateStr, racecourse });
        });
        return found;
      }, year, paddedMonth);

      monthFixtures.forEach(f => fixtures.push(f));
      console.log(`[Fixtures] ${year}/${paddedMonth}: found ${monthFixtures.length} dates`);
      await sleep(500);
    }
  } catch (err) {
    console.error('[Fixtures] Error:', err.message);
  } finally {
    await page.close();
  }

  // Deduplicate and save
  const seen = new Set();
  const unique = fixtures.filter(f => {
    if (!f.date || seen.has(f.date)) return false;
    seen.add(f.date);
    return true;
  });

  for (const f of unique) {
    try {
      await pool.query(
        `INSERT INTO fixtures (race_date, racecourse, season) VALUES ($1, $2, 'Current')
         ON CONFLICT (race_date) DO UPDATE SET racecourse = $2`,
        [f.date, f.racecourse]
      );
    } catch (e) {
      console.error('Fixture insert error:', e.message);
    }
  }

  console.log(`[Fixtures] Saved ${unique.length} fixtures`);
  return unique;
}

// ── Past Results Racecard Scraper ─────────────────────────────────────────
// Scrapes past race results from HKJC localresults page.
// URL: https://racing.hkjc.com/zh-hk/local/information/localresults?racedate=YYYY/MM/DD&Racecourse=HV&RaceNo=N
//
// Returns same structure as scrapeRacecard: { raceDate, racecourse, races: [...] }

async function scrapeRacecardFromResults(raceDate, racecourse) {
  const raceDateUrl = raceDate.replace(/-/g, '/');
  const allRaces = [];

  for (let raceNo = 1; raceNo <= 12; raceNo++) {
    const url = `https://racing.hkjc.com/zh-hk/local/information/localresults?racedate=${raceDateUrl}&Racecourse=${racecourse}&RaceNo=${raceNo}`;
    try {
      const response = await axios.get(url, { timeout: 15000 });
      const $ = cheerio.load(response.data);

      // Check if page has data
      const perfTable = $('div.performance table tbody');
      if (!perfTable.length || perfTable.find('tr').length === 0) {
        console.log(`[RacecardResults] Race ${raceNo}: no data, stopping`);
        break;
      }

      // ── Race header ──────────────────────────────────────────────────────
      let raceClass = '', distance = 0, trackType = '';
      const raceTabRows = $('div.race_tab table tbody tr');
      raceTabRows.each((_, tr) => {
        const cells = $(tr).find('td');
        const cell0 = cells.eq(0).text().trim();
        // e.g. "第五班 - 1200米 - (40-0)"
        const classM = cell0.match(/第[一二三四五六七八九十]\s*班|國際[一二三四五]\s*級|Group\s*\d/);
        if (classM) raceClass = classM[0].replace(/\s/g, '');
        const distM = cell0.match(/(\d{3,4})\s*米/);
        if (distM) distance = parseInt(distM[1]);
        // e.g. "草地 - "B" 賽道" or "全天候跑道"
        const trackCell = cells.eq(2).text().trim();
        if (trackCell.includes('草地')) trackType = 'TURF';
        else if (trackCell.includes('全天候') || trackCell.includes('泥地')) trackType = 'AWT';
      });

      // ── Horse rows ───────────────────────────────────────────────────────
      const horses = [];
      perfTable.find('tr').each((_, tr) => {
        const tds = $(tr).find('td');
        if (tds.length < 8) return;

        const horseNoText = tds.eq(1).text().trim();
        const horseNo = parseInt(horseNoText) || 0;
        if (!horseNo) return; // skip header/summary rows

        // Horse name & ID from link href e.g. "?horseid=HK_2023_J304"
        const horseLink = tds.eq(2).find('a');
        const horseName = horseLink.text().trim() || tds.eq(2).text().trim();
        const horseHref = horseLink.attr('href') || '';
        const horseIdM = horseHref.match(/horseid=([^&]+)/i);
        // horse_id stored as short code e.g. "J304" — extract last segment after "_"
        const horseIdFull = horseIdM ? horseIdM[1] : '';
        const horseId = horseIdFull.split('_').pop();

        // Jockey — td[3] has jockeyid in href
        const jockeyLink = tds.eq(3).find('a');
        const jockeyName = jockeyLink.text().trim() || tds.eq(3).text().trim();
        const jockeyHref = jockeyLink.attr('href') || '';
        const jockeyIdM = jockeyHref.match(/jockeyid=([^&]+)/i);
        const jockeyId = jockeyIdM ? jockeyIdM[1] : '';

        // Trainer — td[4] has trainerid in href
        const trainerLink = tds.eq(4).find('a');
        const trainerName = trainerLink.text().trim() || tds.eq(4).text().trim();
        const trainerHref = trainerLink.attr('href') || '';
        const trainerIdM = trainerHref.match(/trainerid=([^&]+)/i);
        const trainerId = trainerIdM ? trainerIdM[1] : '';

        const actualWeightText = tds.eq(5).text().trim();
        const actualWeight = parseFloat(actualWeightText) || null;

        const declaredWeightText = tds.eq(6).text().trim();
        const declaredWeight = parseInt(declaredWeightText) || null;

        const drawText = tds.eq(7).text().trim();
        const draw = parseInt(drawText) || 0;

        horses.push({
          horse_no: horseNo,
          horse_name: horseName,
          horse_id: horseId,
          actual_weight: actualWeight,
          jockey_name: jockeyName,
          jockey_id: jockeyId,
          draw: draw,
          trainer_name: trainerName,
          trainer_id: trainerId,
          rating: null,
          rating_change: '',
          declared_weight: declaredWeight,
          gear: '',
          recent_form: '',
        });
      });

      if (horses.length === 0) {
        console.log(`[RacecardResults] Race ${raceNo}: no horses parsed, stopping`);
        break;
      }

      allRaces.push({
        race_no: raceNo,
        race_class: raceClass,
        distance,
        track_type: trackType,
        going: '',
        horses,
      });
      console.log(`[RacecardResults] Race ${raceNo}: ${horses.length} horses`);
    } catch (err) {
      console.error(`[RacecardResults] Race ${raceNo} error:`, err.message);
      break;
    }
    await sleep(300);
  }

  return { raceDate, racecourse, races: allRaces };
}

// ── Scrape racecard ────────────────────────────────────────────────────────
// Scrapes the HKJC racecard for a specific date/racecourse/raceNo
// Column indices confirmed from analysis:
// [0]馬匹編號 [1]6次近績 [2]綵衣(skip) [3]馬名 [4]烙號(horseId) [5]負磅
// [6]騎師 [7]可能超磅 [8]檔位 [9]練馬師 [10]國際評分 [11]評分
// [12]評分+/- [13]排位體重 [14]排位體重+/- [15]最佳時間 [16]馬齡
// [17]分齡讓磅 [18]性別 [19]今季獎金 [20]優先參賽 [21]上賽距今日數
// [22]配備 [23]馬主 [24]父系 [25]母系 [26]進口類別
// scrapeRacecard(raceDate?, racecourse?)
// If raceDate+racecourse are provided, scrape that specific date directly.
// Otherwise load the HKJC racecard index page to auto-detect the current race day.
async function scrapeRacecard(raceDate, racecourse) {
  const today = new Date().toISOString().split('T')[0];

  if (raceDate && racecourse) {
    // For past race dates, use the results page scraper
    if (raceDate < today) {
      console.log(`[Racecard] Past date ${raceDate} — using results page scraper`);
      return scrapeRacecardFromResults(raceDate, racecourse);
    }
  }

  // ── Future/current date: use Puppeteer HTML scraper ──────────────────────
  const page = await newPage();
  try {
    let totalRaces = 0;

    if (raceDate && racecourse) {
      // ── Targeted scrape: skip index page, detect total races from Race 1 page ──
      console.log(`[Racecard] Targeted scrape: ${raceDate} ${racecourse}`);
      const raceDateForUrl = raceDate.replace(/-/g, '/');
      const race1Url = `https://racing.hkjc.com/zh-hk/local/information/racecard?racedate=${raceDateForUrl}&Racecourse=${racecourse}&RaceNo=1`;
      await page.goto(race1Url, { waitUntil: 'networkidle0' });
      await sleep(2000);

      // Don't try to detect total races from the page — HKJC uses JS navigation for tabs,
      // so href-based detection is unreliable. Use a safe maximum and rely on early-break logic.
      totalRaces = 12;
      console.log(`[Racecard] Using max ${totalRaces} races for ${raceDate} ${racecourse}`);
    } else {
      // ── Auto-detect: load index page to find current race day ──
      await page.goto(
        'https://racing.hkjc.com/zh-hk/local/information/racecard',
        { waitUntil: 'networkidle0' }
      );
      await sleep(2000);

      const pageInfo = await page.evaluate(() => {
        const url = window.location.href;
        const urlDateMatch = url.match(/racedate=(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
        let raceDate = urlDateMatch ? `${urlDateMatch[1]}-${urlDateMatch[2]}-${urlDateMatch[3]}` : null;
        if (!raceDate) {
          const dm = document.body.innerText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
          if (dm) raceDate = `${dm[1]}-${String(dm[2]).padStart(2, '0')}-${String(dm[3]).padStart(2, '0')}`;
        }
        if (!raceDate) {
          const dm = document.body.innerText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
          if (dm) raceDate = `${dm[3]}-${dm[2]}-${dm[1]}`;
        }
        let racecourse = 'ST';
        const text = document.body.innerText;
        if (text.includes('跑馬地')) racecourse = 'HV';
        else if (text.includes('從化')) racecourse = 'CGA';
        const raceLinks = new Set();
        document.querySelectorAll('a[href*="RaceNo"], a[href*="raceno"], a').forEach(a => {
          const m = (a.href || '').match(/[Rr]ace[Nn]o=(\d+)/);
          if (m) raceLinks.add(parseInt(m[1]));
        });
        document.querySelectorAll('[class*="tab"], [class*="race-no"], [class*="raceNo"]').forEach(el => {
          const m = el.textContent.trim().match(/^(\d+)$/);
          if (m && parseInt(m[1]) <= 12) raceLinks.add(parseInt(m[1]));
        });
        return { raceDate, racecourse, totalRaces: raceLinks.size > 0 ? Math.max(...raceLinks) : 0 };
      });

      console.log(`[Racecard] Page info:`, pageInfo);
      raceDate = pageInfo.raceDate || new Date().toISOString().split('T')[0];
      racecourse = pageInfo.racecourse;
      totalRaces = pageInfo.totalRaces || 10;
    }

    console.log(`[Racecard] Date: ${raceDate}, Racecourse: ${racecourse}, Total races: ${totalRaces}`);

    const allRaces = [];

    // Scrape each race
    const raceDateForUrl = raceDate.replace(/-/g, '/');
    for (let raceNo = 1; raceNo <= totalRaces; raceNo++) {
      const url = `https://racing.hkjc.com/zh-hk/local/information/racecard?racedate=${raceDateForUrl}&Racecourse=${racecourse}&RaceNo=${raceNo}`;
      try {
        await page.goto(url, { waitUntil: 'networkidle0' });
        // Wait for the starter table to appear (JS-rendered content)
        try {
          await page.waitForSelector('table.starter, table', { timeout: 10000 });
        } catch (_) { /* table may not exist for this race number */ }
        await sleep(1000);

        const raceData = await page.evaluate((rNo) => {
          const tables = Array.from(document.querySelectorAll('table'));

          // The starter table has class containing "starter"
          let mainTable = tables.find(t => t.className.includes('starter'));

          // Fallback: find table with most rows having ≥20 cells (the full 27-column layout)
          if (!mainTable) {
            let best = 0;
            for (const t of tables) {
              const cnt = Array.from(t.querySelectorAll('tr')).filter(r => r.querySelectorAll('td').length >= 20).length;
              if (cnt > best) { best = cnt; mainTable = t; }
            }
          }

          // Second fallback: ≥10 cells
          if (!mainTable) {
            let best = 0;
            for (const t of tables) {
              const cnt = Array.from(t.querySelectorAll('tbody tr, tr')).filter(r => r.querySelectorAll('td').length >= 10).length;
              if (cnt > best) { best = cnt; mainTable = t; }
            }
          }

          if (!mainTable) return null;

          // ── Race info from body text ───────────────────────────────────────
          const pageText = document.body.innerText;

          // Distance
          let distance = 0;
          const distMatch = pageText.match(/(\d{3,4})\s*米/);
          if (distMatch) distance = parseInt(distMatch[1]);

          // Track type
          let trackType = '';
          if (pageText.includes('全天候')) trackType = 'AWT';
          else if (pageText.includes('草地')) trackType = 'TURF';

          // Race class — e.g. "第四班", "第三班", "國際一級"
          let raceClass = '';
          const classMatch = pageText.match(/第\s*[一二三四五六七八]\s*班|國際[一二三四五]\s*級|頭馬班|Group\s*\d/);
          if (classMatch) raceClass = classMatch[0].replace(/\s/g, '');

          // Going — e.g. "好地", "好/快", "快地"
          let going = '';
          const goingMatch = pageText.match(/跑道狀況[：:]\s*(\S+)/);
          if (goingMatch) going = goingMatch[1];

          // ── Horse rows ─────────────────────────────────────────────────────
          const horses = [];
          const rows = Array.from(mainTable.querySelectorAll('tr'));
          rows.forEach(row => {
            const cells = Array.from(row.querySelectorAll('td'));
            if (cells.length < 10) return;

            const c = i => (cells[i]?.textContent || '').trim();
            const horseNo = parseInt(c(0));
            if (!horseNo || horseNo > 30) return; // skip header rows

            // horse_id: full ID from horse name link (cell[3])
            // e.g. href="...horse?horseid=HK_2025_L133" → "HK_2025_L133"
            let horseId = '';
            const horseLink = cells[3]?.querySelector('a');
            if (horseLink) {
              const m = (horseLink.href || '').match(/horseid=([A-Z0-9_]+)/i);
              if (m) horseId = m[1];
            }
            // Fallback: use short code from cell[4] (烙號)
            if (!horseId) horseId = c(4).replace(/\s/g, '');

            // jockey_id from cell[6]
            let jockeyId = '';
            const jockeyLink = cells[6]?.querySelector('a');
            if (jockeyLink) {
              const m = (jockeyLink.href || '').match(/jockeyid=([A-Za-z]+)/i);
              if (m) jockeyId = m[1].toUpperCase();
            }
            if (!jockeyId) jockeyId = c(6);

            // trainer_id from cell[9]
            let trainerId = '';
            const trainerLink = cells[9]?.querySelector('a');
            if (trainerLink) {
              const m = (trainerLink.href || '').match(/trainerid=([A-Za-z]+)/i);
              if (m) trainerId = m[1].toUpperCase();
            }
            if (!trainerId) trainerId = c(9);

            horses.push({
              horse_no:        horseNo,
              recent_form:     c(1),
              horse_name:      c(3),
              horse_id:        horseId,
              actual_weight:   parseFloat(c(5)) || null,
              jockey_name:     c(6),
              jockey_id:       jockeyId,
              draw:            parseInt(c(8)) || 0,
              trainer_name:    c(9),
              trainer_id:      trainerId,
              rating:          parseInt(c(11)) || null,
              rating_change:   c(12),
              declared_weight: parseInt(c(13)) || null,
              gear:            c(22),
            });
          });

          return { raceClass, distance, trackType, going, horses };
        }, raceNo);

        if (raceData && raceData.horses.length > 0) {
          allRaces.push({
            race_no: raceNo,
            race_class: raceData.raceClass,
            distance: raceData.distance,
            track_type: raceData.trackType,
            going: raceData.going,
            horses: raceData.horses,
          });
          console.log(`[Racecard] Race ${raceNo}: ${raceData.horses.length} horses`);
        } else {
          console.log(`[Racecard] Race ${raceNo}: no data, stopping`);
          if (raceNo > 1) break; // If race 1 has data but later ones don't, stop
          if (raceNo === 1) break; // No race 1 data means no races today
        }
      } catch (err) {
        console.error(`[Racecard] Race ${raceNo} error:`, err.message);
      }
      await sleep(800);
    }

    return { raceDate, racecourse, races: allRaces };
  } catch (err) {
    console.error('[Racecard] Error:', err.message);
    return { raceDate: null, racecourse: 'ST', races: [] };
  } finally {
    await page.close();
  }
}

// ── Database helpers ───────────────────────────────────────────────────────
async function saveJockeys(jockeys) {
  // Upsert all jockeys with canonical_id = their own id (old IDs are authoritative)
  for (const j of jockeys) {
    await pool.query(
      `INSERT INTO jockeys (id, name_zh, name_en, canonical_id, updated_at) VALUES ($1, $2, $3, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET name_zh = $2, name_en = COALESCE($3, jockeys.name_en), canonical_id = $1, updated_at = NOW()`,
      [j.id, j.name_zh, j.name_en || null]
    );
  }
  // No deletion of old IDs — all known IDs are kept
}

async function saveTrainers(trainers) {
  // Upsert all trainers; old IDs are authoritative
  for (const t of trainers) {
    await pool.query(
      `INSERT INTO trainers (id, name_zh, name_en, canonical_id, updated_at) VALUES ($1, $2, $3, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET name_zh = $2, name_en = COALESCE($3, trainers.name_en), canonical_id = $1, updated_at = NOW()`,
      [t.id, t.name_zh, t.name_en || null]
    );
  }
}

async function saveJockeyRecords(jockeyId, records) {
  let saved = 0;
  for (const r of records) {
    try {
      // Use a unique horse_no surrogate: raceNo * 1000 + draw (draw is gate number 1-20)
      const horseNo = r.raceNo * 1000 + (r.draw || 0);
      await pool.query(
        `INSERT INTO race_records
           (race_date, racecourse, race_no, race_class, track_type, distance, going, horse_no, draw,
            finish_position, total_runners, jockey_id, horse_name, rating, trainer_name, gear, horse_weight, actual_weight)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (race_date, racecourse, race_no, horse_no) DO UPDATE SET
           finish_position=$10, total_runners=$11, jockey_id=$12, race_class=$4, track_type=$5,
           distance=$6, going=$7, draw=$9, horse_name=$13, rating=$14, trainer_name=$15,
           gear=$16, horse_weight=$17, actual_weight=$18`,
        [r.raceDate, r.racecourse, r.raceNo, r.raceClass, r.trackType,
         r.distance, r.going, horseNo, r.draw,
         r.finishPos, r.totalRunners, jockeyId, r.horseName,
         r.rating, r.trainerName, r.gear, r.horseWeight, r.actualWeight]
      );
      saved++;
    } catch (e) {
      console.error(`[saveJockeyRecords] Error saving record:`, e.message, JSON.stringify(r));
    }
  }
  return saved;
}

async function saveTrainerRecords(trainerId, records) {
  let saved = 0;
  for (const r of records) {
    try {
      const horseNo = r.raceNo * 1000 + (r.draw || 0);
      await pool.query(
        `INSERT INTO race_records
           (race_date, racecourse, race_no, race_class, track_type, distance, going, horse_no, draw,
            finish_position, total_runners, trainer_id, horse_name, rating, gear, horse_weight, actual_weight)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (race_date, racecourse, race_no, horse_no) DO UPDATE SET
           finish_position=$10, total_runners=$11, trainer_id=$12, race_class=$4, track_type=$5,
           distance=$6, going=$7, draw=$9, horse_name=$13, rating=$14,
           gear=$15, horse_weight=$16, actual_weight=$17`,
        [r.raceDate, r.racecourse, r.raceNo, r.raceClass, r.trackType,
         r.distance, r.going, horseNo, r.draw,
         r.finishPos, r.totalRunners, trainerId, r.horseName,
         r.rating, r.gear, r.horseWeight, r.actualWeight]
      );
      saved++;
    } catch (e) {
      // ignore
    }
  }
  return saved;
}

async function saveRacecard(raceDate, racecourse, races) {
  await pool.query(`DELETE FROM racecard WHERE race_date = $1`, [raceDate]);
  let saved = 0;
  for (const race of races) {
    for (const h of race.horses) {
      try {
        await pool.query(
          `INSERT INTO racecard
             (race_date, racecourse, race_no, race_class, distance, track_type, going,
              horse_no, horse_id, draw, horse_name, recent_form,
              jockey_id, jockey_name, trainer_id, trainer_name,
              actual_weight, rating, rating_change, declared_weight, gear, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW())
           ON CONFLICT (race_date, race_no, horse_no) DO UPDATE SET
             racecourse=$2, race_class=$4, distance=$5, track_type=$6, going=$7,
             horse_id=$9, draw=$10, horse_name=$11, recent_form=$12,
             jockey_id=$13, jockey_name=$14, trainer_id=$15, trainer_name=$16,
             actual_weight=$17, rating=$18, rating_change=$19, declared_weight=$20, gear=$21,
             updated_at=NOW()`,
          [raceDate, racecourse || 'ST', race.race_no, race.race_class, race.distance,
           race.track_type, race.going,
           h.horse_no, h.horse_id || null, h.draw, h.horse_name, h.recent_form || null,
           h.jockey_id || null, h.jockey_name || null, h.trainer_id || null, h.trainer_name || null,
           h.actual_weight || null, h.rating || null, h.rating_change || null,
           h.declared_weight || null, h.gear || null]
        );
        saved++;
      } catch (e) {
        console.error('[saveRacecard] Error:', e.message);
      }
    }
  }
  return saved;
}

// ── Full scrape orchestrators ──────────────────────────────────────────────
async function runFullJockeyScrape(onProgress) {
  const jockeys = await scrapeJockeyList();
  await saveJockeys(jockeys);
  if (onProgress) onProgress({ type: 'jockey_list', total: jockeys.length });

  for (let i = 0; i < jockeys.length; i++) {
    const j = jockeys[i];
    if (onProgress) onProgress({ type: 'jockey_start', jockeyId: j.id, name: j.name_zh, current: i + 1, total: jockeys.length });
    const records = await scrapeJockeyPastRec(j.id, (p) => {
      if (onProgress) onProgress({ type: 'jockey_page', jockeyId: j.id, pageNum: p.pageNum, count: p.count, current: i + 1, total: jockeys.length });
    });
    await saveJockeyRecords(j.id, records);
    if (onProgress) onProgress({ type: 'jockey_done', jockeyId: j.id, records: records.length, current: i + 1, total: jockeys.length });
    await sleep(500);
  }

  console.log('[runFullJockeyScrape] Done');
}

async function runFullHorseScrape(onProgress) {
  const ids = await scrapeHorseList();
  if (onProgress) onProgress({ type: 'horse_list', total: ids.length });
  console.log(`[runFullHorseScrape] ${ids.length} horses to scrape`);

  for (let i = 0; i < ids.length; i++) {
    const horseId = ids[i];
    if (onProgress) onProgress({ type: 'horse_start', horseId, current: i + 1, total: ids.length });
    const info = await scrapeHorse(horseId);
    if (info) {
      await saveHorse(horseId, info);
    }
    if (onProgress) onProgress({ type: 'horse_done', horseId, name: info?.name_zh || '', current: i + 1, total: ids.length });
    await sleep(600);
  }

  console.log('[runFullHorseScrape] Done');
}

async function runFullTrainerScrape(onProgress) {
  const trainers = await scrapeTrainerList();
  await saveTrainers(trainers);
  if (onProgress) onProgress({ type: 'trainer_list', total: trainers.length });

  for (let i = 0; i < trainers.length; i++) {
    const t = trainers[i];
    if (onProgress) onProgress({ type: 'trainer_start', trainerId: t.id, name: t.name_zh, current: i + 1, total: trainers.length });
    const records = await scrapeTrainerPastRec(t.id, (p) => {
      if (onProgress) onProgress({ type: 'trainer_page', trainerId: t.id, pageNum: p.pageNum, count: p.count, current: i + 1, total: trainers.length });
    });
    await saveTrainerRecords(t.id, records);
    if (onProgress) onProgress({ type: 'trainer_done', trainerId: t.id, records: records.length, current: i + 1, total: trainers.length });
    await sleep(500);
  }

  console.log('[runFullTrainerScrape] Done');
}

// ── Fallback data ──────────────────────────────────────────────────────────
// These are the canonical OLD IDs used by jockeypastrec/trainerpastrec URLs.
// GraphQL may return different IDs; we always remap back to these for scraping.
function getKnownJockeys() {
  return [
    { id: 'PZ',  name_zh: '潘頓' },
    { id: 'BH',  name_zh: '布文' },
    { id: 'AA',  name_zh: '艾兆禮' },
    { id: 'CJE', name_zh: '周俊樂' },
    { id: 'TEK', name_zh: '田泰安' },
    { id: 'BHW', name_zh: '班德禮' },
    { id: 'FEL', name_zh: '霍宏聲' },
    { id: 'HCY', name_zh: '何澤堯' },
    { id: 'OJM', name_zh: '奧爾民' },
    { id: 'BA',  name_zh: '巴度' },
    { id: 'HEL', name_zh: '希威森' },
    { id: 'PMF', name_zh: '潘明輝' },
    { id: 'LDE', name_zh: '梁家俊' },
    { id: 'CCY', name_zh: '鍾易禮' },
    { id: 'WEC', name_zh: '黃智弘' },
    { id: 'YML', name_zh: '楊明綸' },
    { id: 'MOJ', name_zh: '莫雷拉' },
    { id: 'AVB', name_zh: '艾道拿' },
    { id: 'BA',  name_zh: '巴度' },
    { id: 'BAM', name_zh: '巴米高' },
    { id: 'BEP', name_zh: '布浩榮' },
    { id: 'BUW', name_zh: '布宜學' },
    { id: 'CJR', name_zh: '高力德' },
    { id: 'CML', name_zh: '蔡明紹' },
    { id: 'DC',  name_zh: '杜滿樂' },
    { id: 'DHA', name_zh: '杜苑欣' },
    { id: 'DMK', name_zh: '董明朗' },
    { id: 'DSS', name_zh: '杜奕航' },
    { id: 'FEL', name_zh: '霍宏聲' },
    { id: 'GM',  name_zh: '紀仁安' },
    { id: 'GRA', name_zh: '葛納' },
    { id: 'HAA', name_zh: '賀銘年' },
    { id: 'KAY', name_zh: '川田將雅' },
    { id: 'KRM', name_zh: '金美琪' },
    { id: 'KRW', name_zh: '金誠剛' },
    { id: 'LC',  name_zh: '李慕華' },
    { id: 'MAU', name_zh: '毛雲龍' },
    { id: 'MDB', name_zh: '麥文堅' },
    { id: 'MCJ', name_zh: '麥道朗' },
    { id: 'MHT', name_zh: '巫顯東' },
    { id: 'MIK', name_zh: '三浦皇成' },
    { id: 'MOD', name_zh: '莫艾誠' },
    { id: 'MR',  name_zh: '莫雅' },
    { id: 'MTA', name_zh: '馬昆' },
    { id: 'PA',  name_zh: '貝知仁' },
    { id: 'PDF', name_zh: '潘大衛' },
    { id: 'RIC', name_zh: '黎鑑明' },
    { id: 'RU',  name_zh: '李寶利' },
    { id: 'SC',  name_zh: '蘇銘倫' },
    { id: 'WC',  name_zh: '韋紀力' },
    { id: 'WCV', name_zh: '黃俊' },
    { id: 'WJH', name_zh: '黃智弘' },
    { id: 'WPN', name_zh: '黃寶妮' },
    { id: 'YHY', name_zh: '袁幸堯' },
    { id: 'YKA', name_zh: '橫山和生' },
    { id: 'ZM',  name_zh: '薛凱華' },
    { id: 'LFC', name_zh: '梁熙' },
    { id: 'LKH', name_zh: '梁家俊' },
  ].filter((v, i, a) => a.findIndex(x => x.id === v.id) === i); // deduplicate
}

function getKnownTrainers() {
  return [
    { id: 'FC',  name_zh: '方嘉柏' },
    { id: 'SCS', name_zh: '沈集成' },
    { id: 'LKW', name_zh: '呂健威' },
    { id: 'MKL', name_zh: '文家良' },
    { id: 'SJJ', name_zh: '蔡約翰' },
    { id: 'CAS', name_zh: '告東尼' },
    { id: 'LFC', name_zh: '羅富全' },
    { id: 'HDA', name_zh: '大衛希斯' },
    { id: 'NPC', name_zh: '伍鵬志' },
    { id: 'SWY', name_zh: '蘇偉賢' },
    { id: 'RW',  name_zh: '黎昭昇' },
    { id: 'YCH', name_zh: '葉楚航' },
    { id: 'TKH', name_zh: '丁冠豪' },
    { id: 'CCW', name_zh: '鄭俊偉' },
    { id: 'NM',  name_zh: '苗禮德' },
    { id: 'GRA', name_zh: '告魯斯' },
    { id: 'DWC', name_zh: '方志平' },
    { id: 'WDJ', name_zh: '韋達' },
    { id: 'OSP', name_zh: '奧時寶' },
    { id: 'HAP', name_zh: '賀賢' },
    { id: 'YTP', name_zh: '游達榮' },
    { id: 'MA',  name_zh: '萬兆祺' },
    { id: 'LH',  name_zh: '林師賢' },
    { id: 'KW',  name_zh: '桂福特' },
    { id: 'PPT', name_zh: '普雷斯頓' },
  ];
}

// ── Scrape horse list from listbylocation ─────────────────────────────────
// Returns array of horse IDs from both HK and CH locations
async function scrapeHorseList() {
  const fetchMod = await import('node-fetch');
  const fetch = fetchMod.default;
  const cheerio = require('cheerio');
  const allIds = [];

  try {
    for (const location of ['HK', 'CH']) {
      const url = `https://racing.hkjc.com/zh-hk/local/information/listbylocation?location=${location}`;
      const resp = await fetch(url, {
        headers: {
          'Accept-Language': 'zh-HK,zh;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      const html = await resp.text();
      const $ = cheerio.load(html);
      const ids = [];
      $('a[href*="horseid="]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/horseid=([A-Z0-9_]+)/i);
        if (m) ids.push(m[1]);
      });
      const unique = [...new Set(ids)];
      console.log(`[HorseList] Location ${location}: ${unique.length} horses`);
      allIds.push(...unique);
    }
  } catch (err) {
    console.error('[HorseList] Error:', err.message);
  }

  return [...new Set(allIds)];
}

// ── Scrape horse info ──────────────────────────────────────────────────────
// Uses node-fetch + cheerio (no Puppeteer) — the page is server-rendered HTML.
// Page: https://racing.hkjc.com/zh-hk/local/information/horse?horseid=HK_2023_J062
async function scrapeHorse(horseId) {
  try {
    const fetchMod = await import('node-fetch');
    const fetch = fetchMod.default;
    const cheerio = require('cheerio');

    const url = `https://racing.hkjc.com/zh-hk/local/information/horse?horseid=${encodeURIComponent(horseId)}`;
    const resp = await fetch(url, {
      headers: {
        'Accept-Language': 'zh-HK,zh;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const html = await resp.text();

    const { parseHorseHtml } = require('./parsers');
    const info = parseHorseHtml(cheerio, html);

    console.log(`[Horse ${horseId}] Scraped: ${info.name_zh || '(no name)'}, keys: ${info._raw?.join(',')}`);
    const { _raw, ...cleanInfo } = info;
    return { horseId, ...cleanInfo };
  } catch (err) {
    console.error(`[Horse ${horseId}] Error:`, err.message);
    return null;
  }
}

// ── Scrape horse performance (往績) ────────────────────────────────────────
async function scrapeHorsePerformance(horseId) {
  const page = await newPage();
  const allRecords = [];
  let pageNum = 1;

  try {
    while (true) {
      const url = `https://racing.hkjc.com/racing/information/Chinese/Horse/Performance.aspx?HorseId=${horseId}&Season=Current&PageNum=${pageNum}`;
      await page.goto(url, { waitUntil: 'networkidle0' });
      await sleep(500);

      const { records, hasNext } = await page.evaluate((pgNum) => {
        const tables = document.querySelectorAll('table');
        const table = tables[1];
        if (!table) return { records: [], hasNext: false };

        const records = [];
        let currentDate = null;
        let currentVenue = null;
        const rcMap = { '沙田': 'ST', '跑馬地': 'HV', '從化': 'CGA' };

        table.querySelectorAll('tbody tr').forEach(row => {
          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length === 1) {
            const text = cells[0].textContent.trim();
            const dm = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
            if (dm) {
              currentDate = `${dm[3]}-${dm[2]}-${dm[1]}`;
              for (const [k, v] of Object.entries(rcMap)) {
                if (text.includes(k)) { currentVenue = v; break; }
              }
            }
          } else if (cells.length >= 6 && currentDate) {
            const c = i => (cells[i]?.textContent || '').trim();
            const raceNo = parseInt(c(0)) || 0;
            if (!raceNo) return;

            const posMatch = c(1).match(/^(\d+)\/(\d+)$/);
            const finishPos = posMatch ? parseInt(posMatch[1]) : 0;
            const totalRunners = posMatch ? parseInt(posMatch[2]) : 0;

            // Performance columns (approximate):
            // [0]場次 [1]名次 [2]跑道/賽道 [3]途程 [4]場地狀況 [5]頭馬距離
            // [6]沿途走位 [7]完成時間 [8]騎師 [9]負磅 [10]檔位 [11]評分 [12]配備
            const trackRaw = c(2);
            const trackType = trackRaw.includes('全天候') ? 'AWT' : 'TURF';
            const distance = parseInt(c(3).replace(/\D/g, '')) || 0;
            const going = c(4);
            const marginToWinner = c(5);
            const runningPositions = c(6);
            const finishTime = c(7);
            const draw = parseInt(c(10)) || 0;

            records.push({
              raceDate: currentDate,
              racecourse: currentVenue,
              raceNo,
              finishPos,
              totalRunners,
              trackType,
              distance,
              going,
              marginToWinner,
              runningPositions,
              finishTime,
              draw,
            });
          }
        });

        let hasNext = false;
        document.querySelectorAll('a[href*="PageNum"]').forEach(a => {
          const m = a.href.match(/PageNum=(\d+)/);
          if (m && parseInt(m[1]) === pgNum + 1) hasNext = true;
        });

        return { records, hasNext };
      }, pageNum);

      allRecords.push(...records);
      if (!hasNext || records.length === 0 || pageNum >= 20) break;
      pageNum++;
      await sleep(500);
    }
  } catch (err) {
    console.error(`[HorsePerf ${horseId}] Error:`, err.message);
  } finally {
    await page.close();
  }

  return allRecords;
}

// ── Save horse to DB ───────────────────────────────────────────────────────
async function saveHorse(horseId, info) {
  try {
    await pool.query(
      `INSERT INTO horses
         (id, name_zh, origin, age, color, sex, wins, seconds, thirds, total_starts,
          trainer_id, owner, current_rating, season_rating, sire, dam, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
       ON CONFLICT (id) DO UPDATE SET
         name_zh=$2, origin=$3, age=$4, color=$5, sex=$6, wins=$7, seconds=$8, thirds=$9,
         total_starts=$10, trainer_id=$11, owner=$12, current_rating=$13, season_rating=$14,
         sire=$15, dam=$16, updated_at=NOW()`,
      [horseId, info.name_zh || null, info.origin || null, info.age || null,
       info.color || null, info.sex || null, info.wins || null, info.seconds || null,
       info.thirds || null, info.total_starts || null, info.trainer_id || null,
       info.owner || null, info.current_rating || null, info.season_rating || null,
       info.sire || null, info.dam || null]
    );
  } catch (e) {
    console.error(`[saveHorse ${horseId}] Error:`, e.message);
  }
}

// ── Scrape course standard times ───────────────────────────────────────────
// Page: https://racing.hkjc.com/zh-hk/local/page/racing-course-time
// Architecture: Next.js App Router — all data in ONE self.__next_f.push([1,"..."]) script tag at bottom
//
// JSON structure (top-level keys after parsing):
//   standardSectionalData.children[i]          → section (anchor = "StandardSectionalST|HV|STAW")
//     .children[j].distance.value              → distance e.g. "1000"
//     .children[j].children[k]                 → class entry
//       .class.targetItem.optionValue.value     → class code e.g. "Class1"
//       .class.targetItem.displayLabel.value    → display label e.g. "第一班"
//       .standardTimes.value                    → standard time e.g. "1.08.45"
//       .start2000M.value                       → split start-2000m
//       .start201600M.value                     → split 2000-1600m
//       .start161200M.value                     → split 1600-1200m
//       .start12800M.value                      → split 1200-800m
//       .start8400M.value                       → split 800-400m
//       .start400M.value                        → split 400m-finish
//
//   classRecordData.children[i]                 → section (anchor = "ClassRecord")
//     .children[j].distance.value              → distance
//     .children[j].children[k]                 → record entry
//       .class.value                            → class number e.g. "1"
//       .horseName.value                        → horse name
//       .time.value                             → record time
//       .weight.value                           → weight (lbs)
//       .date.dateValue                         → Unix ms timestamp
//
// Returns { courseTimes: [...], courseRecords: [...] }
async function scrapeCourseTime() {
  let html;
  try {
    const fetchMod = await import('node-fetch');
    const fetch = fetchMod.default;
    const resp = await fetch('https://racing.hkjc.com/zh-hk/local/page/racing-course-time', {
      headers: {
        'Accept-Language': 'zh-HK,zh;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    html = await resp.text();
  } catch (err) {
    console.error('[CourseTime] Fetch error:', err.message);
    return { courseTimes: [], courseRecords: [] };
  }

  // Extract ALL self.__next_f.push([1, "..."]) payload chunks and concatenate them.
  // Next.js RSC pages emit multiple push calls; the data chunk may not be the first one.
  const pushRe = /self\.__next_f\.push\(\s*\[1\s*,\s*"([\s\S]*?)"\s*\]\s*\)/g;
  let payloadStr = '';
  let pushMatch;
  let foundAny = false;
  while ((pushMatch = pushRe.exec(html)) !== null) {
    foundAny = true;
    try {
      payloadStr += JSON.parse(`"${pushMatch[1]}"`);
    } catch (_) {
      payloadStr += pushMatch[1];
    }
    payloadStr += '\n';
  }
  if (!foundAny) {
    console.error('[CourseTime] Could not find __next_f.push in HTML');
    return { courseTimes: [], courseRecords: [] };
  }

  // The payload is a series of RSC lines like "0:...\n1a:[...]\n..."
  // We need to find the line(s) that contain the actual page data object
  // Look for a line that has "sectionalData" or "classRecordData"
  let pageData = null;

  // Helper to find a key anywhere in an object/array tree (recurses into arrays too)
  function findKey(obj, key) {
    if (!obj || typeof obj !== 'object') return null;
    if (!Array.isArray(obj) && obj[key] !== undefined) return obj;
    for (const v of Object.values(obj)) {
      const found = findKey(v, key);
      if (found) return found;
    }
    return null;
  }

  // Split by RSC line format: "<hex>:<json>"
  const lines = payloadStr.split('\n');
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const jsonPart = line.slice(colonIdx + 1).trim();
    if (!jsonPart.startsWith('{') && !jsonPart.startsWith('[')) continue;
    try {
      const parsed = JSON.parse(jsonPart);
      if (parsed && typeof parsed === 'object') {
        // Walk the object/array tree looking for sectionalData
        const found = findKey(parsed, 'sectionalData');
        if (found) {
          pageData = found;
          break;
        }
      }
    } catch (_) {}
  }

  if (!pageData) {
    console.error('[CourseTime] Could not find sectionalData in RSC payload');
    return { courseTimes: [], courseRecords: [] };
  }

  // Anchor → racecourse + trackType
  function anchorToRacecourse(anchor) {
    if (!anchor) return null;
    if (anchor.includes('STAW')) return { racecourse: 'ST', trackType: 'AWT' };
    if (anchor.includes('HV')) return { racecourse: 'HV', trackType: 'TURF' };
    if (anchor.includes('ST')) return { racecourse: 'ST', trackType: 'TURF' };
    return null;
  }

  const courseTimes = [];
  const courseRecords = [];

  // ── Parse sectionalData ───────────────────────────────────────────────────
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

        const splitStart2000 = cls.start2000M?.value || null;
        const split20001600 = cls.start201600M?.value || null;
        const split16001200 = cls.start161200M?.value || null;
        const split12008000 = cls.start12800M?.value || null;
        const split8004000 = cls.start8400M?.value || null;
        const split400Finish = cls.start400M?.value || null;

        courseTimes.push({
          section: anchor,
          racecourse: rc.racecourse,
          trackType: rc.trackType,
          distance,
          raceClass: classLabel || classCode,
          standardTime,
          splitStart2000: splitStart2000 || null,
          split20001600: split20001600 || null,
          split16001200: split16001200 || null,
          split12008000: split12008000 || null,
          split8004000: split8004000 || null,
          split400Finish: split400Finish || null,
        });
      }
    }
  }

  // ── Parse classRecordData ─────────────────────────────────────────────────
  const recData = pageData.classRecordData || {};
  for (const section of (recData.children || [])) {
    const displayTitle = section.displayTitle?.value || '';
    // Determine racecourse from displayTitle (Chinese): 沙田草地/沙田全天候/跑馬地
    let rc;
    if (displayTitle.includes('跑馬地')) {
      rc = { racecourse: 'HV', trackType: 'TURF' };
    } else if (displayTitle.includes('全天候')) {
      rc = { racecourse: 'ST', trackType: 'AWT' };
    } else {
      rc = { racecourse: 'ST', trackType: 'TURF' };
    }

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
          courseRecords.push({
            racecourse: rc.racecourse,
            trackType: rc.trackType,
            distance,
            raceClass,
            horseName,
            recordTime,
            weight,
            recordDate,
          });
        }
      }
    }
  }

  console.log(`[CourseTime] Parsed ${courseTimes.length} course times, ${courseRecords.length} course records`);
  return { courseTimes, courseRecords };
}

async function saveCourseTime({ courseTimes = [], courseRecords = [] }) {
  let saved = 0;

  for (const r of courseTimes) {
    try {
      await pool.query(
        `INSERT INTO course_times
           (section, racecourse, track_type, distance, race_class, standard_time,
            split_start_2000, split_2000_1600, split_1600_1200, split_1200_800, split_800_400, split_400_finish, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
         ON CONFLICT (section, racecourse, distance, race_class) DO UPDATE SET
           track_type=$3, standard_time=$6,
           split_start_2000=$7, split_2000_1600=$8, split_1600_1200=$9,
           split_1200_800=$10, split_800_400=$11, split_400_finish=$12, updated_at=NOW()`,
        [r.section, r.racecourse, r.trackType, r.distance, r.raceClass, r.standardTime,
         r.splitStart2000 || null, r.split20001600 || null, r.split16001200 || null,
         r.split12008000 || null, r.split8004000 || null, r.split400Finish || null]
      );
      saved++;
    } catch (e) {
      console.error('[saveCourseTime] course_times error:', e.message, JSON.stringify(r));
    }
  }

  for (const r of courseRecords) {
    try {
      await pool.query(
        `INSERT INTO course_records
           (racecourse, track_type, distance, race_class, horse_name, record_time, weight, record_date, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (racecourse, distance, race_class) DO UPDATE SET
           track_type=$2, horse_name=$5, record_time=$6, weight=$7, record_date=$8, updated_at=NOW()`,
        [r.racecourse, r.trackType, r.distance, r.raceClass, r.horseName,
         r.recordTime, r.weight || null, r.recordDate || null]
      );
      saved++;
    } catch (e) {
      console.error('[saveCourseTime] course_records error:', e.message, JSON.stringify(r));
    }
  }

  return saved;
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

// ── Scrape WindTracker ─────────────────────────────────────────────────────
// Returns { lastUpdate, racecourse, going, trackIndex, temperature, humidity, rainfall, soilMoisture, positions }
// positions: array of { position, direction, speed, gust }
async function scrapeWindTracker() {
  const page = await newPage();
  try {
    await page.goto('https://racing.hkjc.com/zh-hk/local/info/windtracker', {
      waitUntil: 'networkidle0', timeout: 30000
    });
    await sleep(3000);

    return await page.evaluate(() => {
      // Last update
      const lastUpdateEl = document.querySelector('.m_lastUpdate, [class*="lastUpdate"], [class*="last_update"]');
      const lastUpdate = lastUpdateEl ? lastUpdateEl.innerText.trim() : '';

      // Race info (date, going, track index)
      const raceInfoEl = document.querySelector('.m_raceInfo, [class*="raceInfo"]');
      const raceInfoText = raceInfoEl ? raceInfoEl.innerText.trim() : document.body.innerText.match(/夜賽.*?(?:\n|$)/)?.[0] || '';

      // Going & track index
      const goingEl = document.querySelector('[class*="going"], [class*="Going"]');
      const going = goingEl ? goingEl.innerText.trim() : '';

      const trackIndexEl = document.querySelector('[class*="trackIndex"], [class*="trackindex"], [class*="degree"]');
      const trackIndex = trackIndexEl ? trackIndexEl.innerText.trim() : '';

      // Weather data
      const tempEl = document.querySelector('[class*="temperature"], [class*="temp"]');
      const temperature = tempEl ? tempEl.innerText.trim() : '';

      const humidityEl = document.querySelector('[class*="humidity"]');
      const humidity = humidityEl ? humidityEl.innerText.trim() : '';

      const soilEl = document.querySelector('[class*="soil"]');
      const soilMoisture = soilEl ? soilEl.innerText.trim() : '';

      // Wind position data: each windValueItem has direction + speed (m_wind1) + gust (m_wind2)
      const positions = Array.from(document.querySelectorAll('.windValueItem')).map((item, idx) => {
        const wind1 = item.querySelector('.m_wind1');
        const wind2 = item.querySelector('.m_wind2');
        const dirEl = wind1 ? wind1.querySelector('.windValue p:first-child') : null;
        const speedEl = wind1 ? wind1.querySelector('.windValue p:last-child') : null;
        const gustEl = wind2 ? wind2.querySelector('p') : null;
        // position label from parent track wrapper
        const trackWrapper = item.closest('[class*="position"], [class*="posi"]');
        const posClass = trackWrapper ? trackWrapper.className : '';
        return {
          index: idx + 1,
          posClass,
          direction: dirEl ? dirEl.innerText.trim() : '',
          speed: speedEl ? speedEl.innerText.trim() : '',
          gust: gustEl ? gustEl.innerText.trim() : '',
        };
      });

      // Get the full container text for fallback display
      const container = document.querySelector('.m_windTrackerContainer');
      const fullText = container ? container.innerText : '';

      // Going from body text
      const bodyText = document.body.innerText;
      const goingMatch = bodyText.match(/場地\s+([\u4e00-\u9fff\s]+)/);
      const goingText = goingMatch ? goingMatch[1].trim() : '';

      // Track index (度地儀指數)
      const trackIndexMatch = bodyText.match(/度地儀指數[\s\S]*?([\d.]+)/);
      const trackIndexVal = trackIndexMatch ? trackIndexMatch[1] : '';

      // Temperature
      const tempMatch = bodyText.match(/([\d.]+)°C/);
      const temperatureVal = tempMatch ? tempMatch[1] + '°C' : '';

      // Humidity
      const humidityMatch = bodyText.match(/相對濕度[\s\S]*?([\d.]+%)/);
      const humidityVal = humidityMatch ? humidityMatch[1] : '';

      // Soil moisture
      const soilMatch = bodyText.match(/土壤濕度[\s\S]*?([\d.]+%)/);
      const soilVal = soilMatch ? soilMatch[1] : '';

      // Rainfall
      const rainfallMatch = bodyText.match(/總雨量[\s\S]*?([\d.]+毫米)/);
      const rainfallVal = rainfallMatch ? rainfallMatch[1] : '';

      // Last update
      const lastUpdateMatch = bodyText.match(/最後更新[：:]\s*([\d/\s:]+)/);
      const lastUpdateVal = lastUpdateMatch ? lastUpdateMatch[1].trim() : '';

      // Race info line
      const raceInfoMatch = bodyText.match(/(夜賽|日賽)\s+\d+場賽事.*?(?:\n|$)/);
      const raceInfoVal = raceInfoMatch ? raceInfoMatch[0].trim() : '';

      return {
        lastUpdate: lastUpdateVal,
        raceInfo: raceInfoVal,
        going: goingText,
        trackIndex: trackIndexVal,
        temperature: temperatureVal,
        humidity: humidityVal,
        rainfall: rainfallVal,
        soilMoisture: soilVal,
        positions,
        fullText,
      };
    });
  } finally {
    await page.close();
  }
}

// ── Scrape Draw for a specific race ──────────────────────────────────────────
// Returns array of { draw, totalRaces, win, place2, place3, place4, winRate, quinellaRate, placeRate, top4Rate }
// for the matching race identified by raceNo on today's draw page
async function scrapeDrawForRace(raceNo) {
  const page = await newPage();
  try {
    await page.goto('https://racing.hkjc.com/zh-hk/local/information/draw', {
      waitUntil: 'networkidle0', timeout: 30000
    });
    await sleep(2000);

    return await page.evaluate((targetRaceNo) => {
      // The draw page uses a single table with thead rows acting as section dividers.
      // We walk ALL rows in the table (thead + tbody combined via table.rows) to correctly
      // slice the data rows that belong to the target race section.
      const tables = document.querySelectorAll('table.table_bd');
      let result = null;

      tables.forEach(table => {
        if (result) return; // already found

        // Collect all rows in document order
        const allRows = Array.from(table.rows);

        // Find the row index of the target race header and the next race header
        let startIdx = -1;
        let endIdx = allRows.length;

        for (let i = 0; i < allRows.length; i++) {
          const tr = allRows[i];
          if (!tr.id || !tr.id.startsWith('race')) continue;
          const raceNum = parseInt(tr.id.replace('race', ''), 10);
          if (raceNum === targetRaceNo) {
            startIdx = i;
          } else if (startIdx !== -1) {
            // This is the next race header — stop here
            endIdx = i;
            break;
          }
        }

        if (startIdx === -1) return; // target race not in this table

        const headerTr = allRows[startIdx];
        const headerText = headerTr.querySelector('td') ? headerTr.querySelector('td').innerText.trim() : '';

        // Data rows are between startIdx+1 and endIdx (exclusive)
        const dataRows = allRows.slice(startIdx + 1, endIdx);
        const drawData = [];
        let favText = '';

        dataRows.forEach(tr => {
          const cells = tr.querySelectorAll('td');
          if (cells.length >= 9) {
            const draw = parseInt(cells[0].innerText.trim(), 10);
            if (!isNaN(draw) && draw > 0) {
              drawData.push({
                draw,
                totalRaces: parseInt(cells[1].innerText.trim(), 10) || 0,
                win: parseInt(cells[2].innerText.trim(), 10) || 0,
                place2: parseInt(cells[3].innerText.trim(), 10) || 0,
                place3: parseInt(cells[4].innerText.trim(), 10) || 0,
                place4: parseInt(cells[5].innerText.trim(), 10) || 0,
                winRate: cells[6].innerText.trim(),
                quinellaRate: cells[7].innerText.trim(),
                placeRate: cells[8].innerText.trim(),
                top4Rate: cells[9] ? cells[9].innerText.trim() : '',
              });
            } else if (cells[0].innerText.trim() === '' || isNaN(draw)) {
              // Could be a summary/favorite row
              const rowText = tr.innerText.trim();
              if (rowText) favText = rowText;
            }
          }
        });

        result = { raceNo: targetRaceNo, headerText, drawData, favText };
      });

      return result;
    }, raceNo);
  } finally {
    await page.close();
  }
}

// ── Scrape SpeedGuide for a specific race ────────────────────────────────────
// Returns { raceNo, lastUpdate, horses: [ { horseNo, horseName, draw, requiredEnergy, pastRaces, bestEnergy, sameCourseBest, fitnessRating, speedEstimate, estimateDiff } ] }
async function scrapeSpeedGuide(raceNo) {
  const page = await newPage();
  try {
    await page.goto(
      `https://racing.hkjc.com/zh-hk/local/info/speedpro/speedguide?raceno=${raceNo}`,
      { waitUntil: 'networkidle0', timeout: 30000 }
    );
    await sleep(3000);

    return await page.evaluate((targetRaceNo) => {
      // Last update
      const bodyText = document.body.innerText;
      const lastUpdateMatch = bodyText.match(/最後更新時間[：:]\s*([\d\-\s:AMP]+)/i);
      const lastUpdate = lastUpdateMatch ? lastUpdateMatch[1].trim() : '';

      // The main data table: table.datatable
      const table = document.querySelector('table.datatable');
      if (!table) return { raceNo: targetRaceNo, lastUpdate, horses: [] };

      const horses = [];
      const rows = table.querySelectorAll('tbody tr');
      rows.forEach(tr => {
        const cells = tr.querySelectorAll('td');
        if (cells.length < 13) return;
        const horseNo = cells[0].innerText.trim();
        const horseName = cells[1].innerText.trim();
        const draw = cells[2].innerText.trim();
        const requiredEnergy = cells[3].innerText.trim();
        // cells[4..8] = past 5 races (energy + course + going info)
        const pastRaces = [4,5,6,7,8].map(i => cells[i] ? cells[i].innerText.trim().replace(/\s+/g, ' ') : '');
        const bestEnergy = cells[9] ? cells[9].innerText.trim() : '';
        const sameCourseBest = cells[10] ? cells[10].innerText.trim() : '';
        // Fitness rating icon (formGuide class)
        const fitnessEl = cells[11] ? cells[11].querySelector('img') : null;
        const fitnessSrc = fitnessEl ? fitnessEl.src : '';
        let fitnessRating = '';
        if (fitnessSrc.includes('formGuide_3up')) fitnessRating = '↑↑↑';
        else if (fitnessSrc.includes('formGuide_2up')) fitnessRating = '↑↑';
        else if (fitnessSrc.includes('formGuide_1up') || fitnessSrc.includes('1up')) fitnessRating = '↑';
        else if (fitnessSrc.includes('thumb_down') || fitnessSrc.includes('thumbdown')) fitnessRating = '↓';
        else fitnessRating = cells[11] ? cells[11].innerText.trim() : '';

        const speedEstimate = cells[12] ? cells[12].innerText.trim() : '';
        const estimateDiff = cells[13] ? cells[13].innerText.trim() : '';

        if (horseNo && horseName) {
          horses.push({ horseNo, horseName, draw, requiredEnergy, pastRaces, bestEnergy, sameCourseBest, fitnessRating, speedEstimate, estimateDiff });
        }
      });

      // Map image
      const mapImg = document.querySelector('img.speedguide-map');
      const mapImageUrl = mapImg ? mapImg.src : '';

      return { raceNo: targetRaceNo, lastUpdate, mapImageUrl, horses };
    }, raceNo);
  } finally {
    await page.close();
  }
}

// ── Scrape sectional times for a race ─────────────────────────────────────
// URL format: /displaysectionaltime?racedate=DD/MM/YYYY&RaceNo=N
// raceDate should be in YYYY-MM-DD or DD/MM/YYYY format
// Returns { raceDate, racecourse, raceNo, raceClass, distance, trackType, going,
//           raceSplits: [string], cumulativeTimes: [string],
//           horses: [ { finishPosition, horseNo, horseName, horseId, finishTime,
//                       segments: [{ seg, runningPos, gap, times:[string] }] } ] }
async function scrapeSectionalTime(raceDate, raceNo) {
  // Normalise date to DD/MM/YYYY for URL
  let ddmmyyyy;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raceDate)) {
    const [y, m, d] = raceDate.split('-');
    ddmmyyyy = `${d}/${m}/${y}`;
  } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(raceDate)) {
    ddmmyyyy = raceDate;
  } else if (/^\d{4}\/\d{2}\/\d{2}$/.test(raceDate)) {
    const [y, m, d] = raceDate.split('/');
    ddmmyyyy = `${d}/${m}/${y}`;
  } else {
    throw new Error(`scrapeSectionalTime: unrecognised raceDate format: ${raceDate}`);
  }

  const page = await newPage();
  try {
    const url = `https://racing.hkjc.com/zh-hk/local/information/displaysectionaltime?racedate=${encodeURIComponent(ddmmyyyy)}&RaceNo=${raceNo}`;
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    await sleep(2000);

    return await page.evaluate((targetRaceNo, ddmmyyyy) => {
      const bodyText = document.body.innerText;

      // Check if data is available
      if (bodyText.includes('將於稍後公佈') || bodyText.includes('沒有相關資料')) {
        return { error: 'no_data', raceNo: targetRaceNo };
      }

      // ── Race info from body text ──────────────────────────────────────────
      // e.g. "第 1 場 第五班 - 1650米 - (40-0) - 全天候跑道 - 好地"
      // or   "第 9 場 第三班 - 1200米 - (80-60) - 草地 - "B" 賽道 - 好地至快地"
      let raceClass = '', distance = 0, trackType = '', going = '';
      // e.g. "第 1 場 第五班 - 1650米 - (40-0) - 全天候跑道 - 好地"
      // e.g. "第 9 場 第三班 - 1200米 - (80-60) - 草地 - "B" 賽道 - 好地至快地"
      const raceHeaderMatch = bodyText.match(/第\s*\d+\s*場\s+(.+?)\s+-\s+(\d+)米\s+-\s+\([^)]+\)\s+-\s+([^\n\-]+?)(?:\s+-[^\n]+?)?\s+-\s+([^\n]+)/);
      if (raceHeaderMatch) {
        raceClass = raceHeaderMatch[1].trim();
        distance = parseInt(raceHeaderMatch[2], 10);
        const trackRaw = raceHeaderMatch[3].trim();
        trackType = trackRaw.includes('全天候') ? 'AWT' : 'TURF';
        going = raceHeaderMatch[4].replace(/\s*\n.*/s, '').trim();
      }

      // Racecourse from page header: "賽事日期: DD/MM/YYYY, 沙田" or "跑馬地"
      let racecourse = '';
      const rcMatch = bodyText.match(/賽事日期[：:][^\n,，]+[,，]\s*(沙田|跑馬地|從化)/);
      if (rcMatch) {
        const rcMap = { '沙田': 'ST', '跑馬地': 'HV', '從化': 'CGA' };
        racecourse = rcMap[rcMatch[1]] || rcMatch[1];
      }

      // ── Table[2]: race-level cumulative times and splits ──────────────────
      const tables = Array.from(document.querySelectorAll('table'));
      const summaryTable = tables.find(t => t.className.includes('f_fl') && t.className.includes('f_tac'));
      const cumulativeTimes = [];
      const raceSplits = [];
      if (summaryTable) {
        const rows = summaryTable.querySelectorAll('tr');
        if (rows[0]) {
          Array.from(rows[0].querySelectorAll('td')).forEach(td => {
            const t = td.innerText.trim();
            const m = t.match(/\(([^)]+)\)/);
            if (m) cumulativeTimes.push(m[1]);
          });
        }
        if (rows[1]) {
          Array.from(rows[1].querySelectorAll('td')).forEach(td => {
            const t = td.innerText.trim();
            if (t && t !== '分段時間:') {
              // May contain multiple numbers (e.g. "23.79 12.06 11.73")
              t.split(/\s+/).forEach(part => {
                if (/^\d+\.\d+$/.test(part)) raceSplits.push(part);
              });
            }
          });
        }
      }

      // ── Table[3]: per-horse data ──────────────────────────────────────────
      const raceTable = tables.find(t => t.className.includes('race_table'));
      const horses = [];
      if (raceTable) {
        // rows[0] = header, rows[1] = "分段時間", rows[2] = segment labels, rows[3+] = data
        const rows = Array.from(raceTable.querySelectorAll('tr'));

        rows.slice(3).forEach(tr => {
          const cells = Array.from(tr.querySelectorAll('td'));
          if (cells.length < 4) return;

          const finishPosition = parseInt(cells[0].innerText.trim(), 10);
          if (isNaN(finishPosition)) return;

          const horseNo = parseInt(cells[1].innerText.trim(), 10);
          const horseNameRaw = cells[2].innerText.trim();
          // Extract horse ID from brackets: e.g. "大利好運 (H234)" → horseName="大利好運", codeStr="H234"
          const nameMatch = horseNameRaw.match(/^(.+?)\s*\(([A-Z]\d+)\)$/);
          const horseName = nameMatch ? nameMatch[1].trim() : horseNameRaw;
          const horseCode = nameMatch ? nameMatch[2] : '';
          // horse_id will be resolved server-side using raceDate year
          const finishTime = cells[cells.length - 1].innerText.trim();

          // Segment cells: cells[3] to cells[cells.length-2] (6 segment columns)
          const segments = [];
          for (let i = 3; i < cells.length - 1; i++) {
            const cellText = cells[i].innerText.trim();
            if (!cellText) { segments.push(null); continue; }

            // Cell format: "{pos}{gap} {time1} {time2?} {time3?}"
            // e.g. "4 2-3/4 23.49" or "52-3/4 23.79 11.94 11.85" or "1 N 23.56 11.81 11.75"
            const parts = cellText.split(/\s+/);
            const times = [];
            let runningPos = '';
            let gap = '';
            let parsingTimes = false;

            for (const part of parts) {
              if (/^\d+\.\d+$/.test(part)) {
                parsingTimes = true;
                times.push(part);
              } else if (!parsingTimes) {
                // Position/gap parts (could be "1", "3/4", "2-3/4", "N", "H", numbers)
                if (/^\d+$/.test(part) && !runningPos) {
                  runningPos = part;
                } else {
                  gap += (gap ? ' ' : '') + part;
                }
              }
            }

            segments.push({
              seg: i - 2,
              runningPos,
              gap,
              times,
            });
          }

          horses.push({ finishPosition, horseNo, horseName, horseCode, finishTime, segments });
        });
      }

      return {
        raceDate: ddmmyyyy,
        racecourse,
        raceNo: targetRaceNo,
        raceClass,
        distance,
        trackType,
        going,
        cumulativeTimes,
        raceSplits,
        horses,
      };
    }, raceNo, ddmmyyyy);

  } finally {
    await page.close();
  }
}

// ── Save sectional times to DB ─────────────────────────────────────────────
async function saveSectionalTime(data) {
  if (!data || data.error) {
    console.warn('[saveSectionalTime] No data or error:', data?.error);
    return 0;
  }

  // Normalise raceDate to YYYY-MM-DD for DB
  let dbDate;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(data.raceDate)) {
    const [d, m, y] = data.raceDate.split('/');
    dbDate = `${y}-${m}-${d}`;
  } else {
    dbDate = data.raceDate;
  }

  // Derive the season year from raceDate for building horse_id
  // HKJC season starts in September; if month < 9, year is current year's season start
  const year = parseInt(dbDate.split('-')[0], 10);
  const month = parseInt(dbDate.split('-')[1], 10);
  const seasonYear = month >= 9 ? year : year - 1;

  let saved = 0;
  for (const horse of data.horses) {
    const segs = horse.segments.filter(s => s !== null);
    const getTime = (idx) => {
      const seg = horse.segments[idx];
      if (!seg || !seg.times || seg.times.length === 0) return null;
      // Return the first (segment total) time in the cell
      return seg.times[0];
    };
    // Segment sub-times (200m splits within a 400m segment) stored in later items
    // We store the primary segment time only in seg1-seg6
    const horseId = horse.horseCode ? `HK_${seasonYear}_${horse.horseCode}` : null;

    try {
      await pool.query(
        `INSERT INTO race_sectional_times
           (race_date, racecourse, race_no, race_class, distance, track_type, going,
            finish_position, horse_no, horse_id, horse_name, finish_time,
            seg1, seg2, seg3, seg4, seg5, seg6, cumulative_times, running_positions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (race_date, race_no, horse_no) DO UPDATE SET
           racecourse=$2, race_class=$4, distance=$5, track_type=$6, going=$7,
           finish_position=$8, horse_id=$10, horse_name=$11, finish_time=$12,
           seg1=$13, seg2=$14, seg3=$15, seg4=$16, seg5=$17, seg6=$18,
           cumulative_times=$19, running_positions=$20, scraped_at=NOW()`,
        [
          dbDate,
          data.racecourse || null,
          data.raceNo,
          data.raceClass || null,
          data.distance || null,
          data.trackType || null,
          data.going || null,
          horse.finishPosition,
          horse.horseNo,
          horseId,
          horse.horseName,
          horse.finishTime || null,
          getTime(0), getTime(1), getTime(2), getTime(3), getTime(4), getTime(5),
          JSON.stringify(data.cumulativeTimes),
          segs.map(s => `${s.runningPos}${s.gap ? '-' + s.gap : ''}`).join(' ') || null,
        ]
      );
      saved++;
    } catch (e) {
      console.error(`[saveSectionalTime] Error saving horse ${horse.horseNo}:`, e.message);
    }
  }
  console.log(`[saveSectionalTime] Saved ${saved}/${data.horses.length} horses for ${dbDate} R${data.raceNo}`);
  return saved;
}

// ── Scrape Vet Record for a specific race ─────────────────────────────────────
// URL: /zh-hk/local/information/veterinaryrecord?racedate=DD/MM/YYYY&Racecourse=ST&RaceNo=N
// Returns array of vet record entries, or [] if no data
async function scrapeVetRecord(raceDate, racecourse, raceNo) {
  // Normalise date to DD/MM/YYYY
  let ddmmyyyy;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raceDate)) {
    const [y, m, d] = raceDate.split('-');
    ddmmyyyy = `${d}/${m}/${y}`;
  } else {
    ddmmyyyy = raceDate;
  }
  const rc = (racecourse || 'ST').toUpperCase();
  const url = `https://racing.hkjc.com/zh-hk/local/information/veterinaryrecord?racedate=${encodeURIComponent(ddmmyyyy)}&Racecourse=${rc}&RaceNo=${raceNo}`;

  const page = await newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    await sleep(2000);

    return await page.evaluate(() => {
      // Check for no-data message
      const errorEl = document.querySelector('#errorContainer');
      if (errorEl && errorEl.innerText && errorEl.innerText.includes('沒有相關資料')) {
        return [];
      }

      const records = [];
      // Find all tables with class table_bd
      const tables = document.querySelectorAll('table.table_bd');
      tables.forEach(table => {
        const rows = table.querySelectorAll('tbody tr');
        rows.forEach(tr => {
          const cells = tr.querySelectorAll('td');
          if (cells.length < 2) return;
          const entry = {};
          cells.forEach((td, i) => {
            entry[`col${i}`] = td.innerText.trim();
          });
          // Try to extract horse number and name from first columns
          if (cells.length >= 3) {
            entry.horseNo = cells[0].innerText.trim();
            entry.horseName = cells[1].innerText.trim();
            entry.details = Array.from(cells).slice(2).map(c => c.innerText.trim()).join(' | ');
          }
          if (entry.horseNo || entry.horseName) records.push(entry);
        });
      });

      // If no table_bd found, try commContent paragraphs
      if (records.length === 0) {
        const content = document.querySelector('#innerContent .commContent');
        if (content) {
          // Try to parse any table inside
          const allRows = content.querySelectorAll('tr');
          allRows.forEach(tr => {
            const cells = tr.querySelectorAll('td');
            if (cells.length < 2) return;
            const entry = {
              horseNo: cells[0].innerText.trim(),
              horseName: cells[1].innerText.trim(),
              details: Array.from(cells).slice(2).map(c => c.innerText.trim()).join(' | '),
            };
            if (entry.horseNo || entry.horseName) records.push(entry);
          });
        }
      }

      return records;
    });
  } finally {
    await page.close();
  }
}

// ── Scrape Trackwork for a specific race ──────────────────────────────────────
// URL: /zh-hk/local/information/localtrackwork?racedate=DD/MM/YYYY&Racecourse=ST&RaceNo=N
// Returns { declared: [...], reserves: [...] } each entry has:
//   horseNo, horseName, trainer, recentForm, barrierTrial, gallop, trotting, swimming, treadmill, aquaWalker, spelling
async function scrapeTrackwork(raceDate, racecourse, raceNo) {
  let ddmmyyyy;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raceDate)) {
    const [y, m, d] = raceDate.split('-');
    ddmmyyyy = `${d}/${m}/${y}`;
  } else {
    ddmmyyyy = raceDate;
  }
  const rc = (racecourse || 'ST').toUpperCase();
  const url = `https://racing.hkjc.com/zh-hk/local/information/localtrackwork?racedate=${encodeURIComponent(ddmmyyyy)}&Racecourse=${rc}&RaceNo=${raceNo}`;

  const page = await newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    await sleep(2000);

    return await page.evaluate(() => {
      // Check for no-data message
      const bodyText = document.body.innerText;
      if (bodyText.includes('沒有相關資料')) {
        return { declared: [], reserves: [] };
      }

      function parseTable(table) {
        if (!table) return [];
        const horses = [];
        const rows = table.querySelectorAll('tbody tr');
        rows.forEach(tr => {
          // Skip header rows
          if (tr.querySelector('th') || tr.classList.contains('bg_blue')) return;
          const cells = tr.querySelectorAll('td');
          if (cells.length < 2) return;

          const col0 = cells[0] ? cells[0].innerText.trim() : '';
          const col1 = cells[1] ? cells[1].innerText.trim() : '';
          if (!col0 && !col1) return;

          // col1 contains horse name link, trainer, and recent form
          const horseNameEl = cells[1] ? cells[1].querySelector('a') : null;
          const horseName = horseNameEl ? horseNameEl.innerText.trim() : col1.split('\n')[0].trim();
          const lines = col1.split('\n').map(l => l.trim()).filter(Boolean);
          const trainer = lines.length > 1 ? lines[1] : '';
          const recentForm = lines.length > 2 ? lines.slice(2).join(' ') : '';

          const getCell = cls => {
            const el = tr.querySelector(`td.${cls}`);
            return el ? el.innerText.trim() : '';
          };

          horses.push({
            horseNo: col0,
            horseName,
            trainer,
            recentForm,
            barrierTrial: getCell('BarrierTrial'),
            gallop: getCell('Gallop'),
            trotting: getCell('Trotting'),
            swimming: getCell('Swimming'),
            treadmill: getCell('Treadmill'),
            aquaWalker: getCell('AquaWalker'),
            spelling: getCell('Spelling'),
          });
        });
        return horses;
      }

      const containers = document.querySelectorAll('div.trackwork_content');
      const declared = containers[0] ? parseTable(containers[0].querySelector('table.table_bd')) : [];
      const reserves = containers[1] ? parseTable(containers[1].querySelector('table.table_bd')) : [];

      return { declared, reserves };
    });
  } finally {
    await page.close();
  }
}

/**
 * Scrape the total number of races on a given day from the localresults page nav links.
 * Returns an integer (max RaceNo found in links), or null if unavailable.
 */
async function scrapeRaceCountFromLocalResults(raceDate, racecourse) {
  try {
    const [y, m, d] = raceDate.split('-');
    const dateStr = `${d}/${m}/${y}`;
    const url = `https://racing.hkjc.com/zh-hk/local/information/localresults?racedate=${encodeURIComponent(dateStr)}&Racecourse=${racecourse}&RaceNo=1`;
    const resp = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(resp.data);
    let maxRaceNo = 1;
    $('a[href*="RaceNo="]').each((i, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/RaceNo=(\d+)/);
      if (match) maxRaceNo = Math.max(maxRaceNo, parseInt(match[1]));
    });
    return maxRaceNo;
  } catch (e) {
    console.warn(`scrapeRaceCountFromLocalResults ${raceDate}: ${e.message}`);
    return null;
  }
}

/**
 * Scrape fastest segment times for a single race from the localresults page.
 * Uses axios+cheerio (no Puppeteer needed — page is server-side rendered).
 * Returns an array of numbers e.g. [13.85, 23.44, 24.68, 23.80, 12.28, 11.52]
 */
async function scrapeLocalResults(raceDate, racecourse, raceNo) {
  // raceDate: 'YYYY-MM-DD', convert to 'DD/MM/YYYY'
  const [y, m, d] = raceDate.split('-');
  const dateStr = `${d}/${m}/${y}`;
  const url = `https://racing.hkjc.com/zh-hk/local/information/localresults?racedate=${encodeURIComponent(dateStr)}&Racecourse=${racecourse}&RaceNo=${raceNo}`;
  const resp = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const $ = cheerio.load(resp.data);

  const splits = [];
  // Find the row containing '分段時間'
  $('table tbody tr').each((_, tr) => {
    const cells = $(tr).find('td');
    let labelFound = false;
    cells.each((i, td) => {
      const text = $(td).text().trim();
      if (text.includes('分段時間')) { labelFound = true; return; }
      if (!labelFound) return;
      // Get only the direct text node (not the sub-split div)
      const mainText = $(td).clone().children('div').remove().end().text().trim();
      if (mainText) {
        const val = parseFloat(mainText);
        if (!isNaN(val)) splits.push(val);
      }
    });
  });
  return splits;
}

/**
 * Scrape and save fastest splits for a race into race_fastest_splits table.
 */
async function saveLocalResults(raceDate, racecourse, raceNo) {
  const splits = await scrapeLocalResults(raceDate, racecourse, raceNo);
  if (!splits.length) return splits;
  await pool.query(
    `INSERT INTO race_fastest_splits (race_date, racecourse, race_no, fastest_splits)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (race_date, racecourse, race_no) DO UPDATE SET fastest_splits = $4, scraped_at = NOW()`,
    [raceDate, racecourse, raceNo, JSON.stringify(splits)]
  );
  return splits;
}

module.exports = {
  scrapeJockeyList,
  scrapeJockeyPastRec,
  scrapeTrainerList,
  scrapeTrainerPastRec,
  scrapeFixtures,
  scrapeRacecard,
  scrapeHorseList,
  scrapeHorse,
  scrapeHorsePerformance,
  scrapeCourseTime,
  saveJockeys,
  saveTrainers,
  saveJockeyRecords,
  saveTrainerRecords,
  saveRacecard,
  saveHorse,
  saveCourseTime,
  runFullJockeyScrape,
  runFullTrainerScrape,
  runFullHorseScrape,
  getKnownJockeys,
  getKnownTrainers,
  closeBrowser,
  scrapeWindTracker,
  scrapeDrawForRace,
  scrapeSpeedGuide,
  scrapeSectionalTime,
  saveSectionalTime,
  scrapeVetRecord,
  scrapeTrackwork,
  scrapeLocalResults,
  saveLocalResults,
  scrapeRaceCountFromLocalResults,
};
