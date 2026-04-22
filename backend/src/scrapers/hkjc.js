const puppeteer = require('puppeteer');
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

// ── Scrape racecard ────────────────────────────────────────────────────────
// Scrapes the HKJC racecard for a specific date/racecourse/raceNo
// Column indices confirmed from analysis:
// [0]馬匹編號 [1]6次近績 [2]綵衣(skip) [3]馬名 [4]烙號(horseId) [5]負磅
// [6]騎師 [7]可能超磅 [8]檔位 [9]練馬師 [10]國際評分 [11]評分
// [12]評分+/- [13]排位體重 [14]排位體重+/- [15]最佳時間 [16]馬齡
// [17]分齡讓磅 [18]性別 [19]今季獎金 [20]優先參賽 [21]上賽距今日數
// [22]配備 [23]馬主 [24]父系 [25]母系 [26]進口類別
async function scrapeRacecard() {
  const page = await newPage();
  try {
    // First load the racecard index page to get the race date and racecourse
    await page.goto(
      'https://racing.hkjc.com/zh-hk/local/information/racecard',
      { waitUntil: 'networkidle0' }
    );
    await sleep(2000);

    // Extract the current race date and racecourse from the page URL or content
    const pageInfo = await page.evaluate(() => {
      // Look for date in URL or page content
      const url = window.location.href;
      const urlDateMatch = url.match(/racedate=(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
      let raceDate = urlDateMatch ? `${urlDateMatch[1]}-${urlDateMatch[2]}-${urlDateMatch[3]}` : null;

      // Try to find date in page
      if (!raceDate) {
        const allText = document.body.innerText;
        const dm = allText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
        if (dm) raceDate = `${dm[1]}-${String(dm[2]).padStart(2, '0')}-${String(dm[3]).padStart(2, '0')}`;
      }
      if (!raceDate) {
        const dm = document.body.innerText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (dm) raceDate = `${dm[3]}-${dm[2]}-${dm[1]}`;
      }

      // Try to find racecourse from page
      let racecourse = 'ST';
      const text = document.body.innerText;
      if (text.includes('跑馬地')) racecourse = 'HV';
      else if (text.includes('從化')) racecourse = 'CGA';

      // Find total number of races - look for race links
      const raceLinks = new Set();
      document.querySelectorAll('a[href*="RaceNo"], a[href*="raceno"]').forEach(a => {
        const m = (a.href || '').match(/[Rr]ace[Nn]o=(\d+)/);
        if (m) raceLinks.add(parseInt(m[1]));
      });

      // Also try tab buttons or race number elements
      document.querySelectorAll('[class*="tab"], [class*="race-no"], [class*="raceNo"]').forEach(el => {
        const m = el.textContent.trim().match(/^(\d+)$/);
        if (m && parseInt(m[1]) <= 12) raceLinks.add(parseInt(m[1]));
      });

      const maxRace = raceLinks.size > 0 ? Math.max(...raceLinks) : 0;

      return { raceDate, racecourse, totalRaces: maxRace };
    });

    console.log(`[Racecard] Page info:`, pageInfo);

    // If we couldn't determine date or race count, try the URL params
    let { raceDate, racecourse, totalRaces } = pageInfo;

    if (!raceDate) {
      raceDate = new Date().toISOString().split('T')[0];
    }

    // If totalRaces is still 0, try to detect from the page directly
    if (totalRaces === 0) {
      // Try to get race count from a known racecard URL structure
      const races = await page.evaluate(() => {
        // Look for a dropdown or tab structure listing races
        const opts = document.querySelectorAll('select option, [role="tab"], .race-tab, .f_tabItem');
        const found = new Set();
        opts.forEach(el => {
          const m = el.textContent.trim().match(/第\s*(\d+)\s*場/) || el.textContent.trim().match(/^(\d+)$/);
          if (m && parseInt(m[1]) <= 15) found.add(parseInt(m[1]));
        });
        return found.size;
      });
      totalRaces = races || 10; // fallback to 10 if unknown
    }

    if (totalRaces === 0) totalRaces = 10;

    console.log(`[Racecard] Date: ${raceDate}, Racecourse: ${racecourse}, Total races: ${totalRaces}`);

    const allRaces = [];

    // Scrape each race
    const raceDateForUrl = raceDate.replace(/-/g, '/');
    for (let raceNo = 1; raceNo <= totalRaces; raceNo++) {
      const url = `https://racing.hkjc.com/zh-hk/local/information/racecard?racedate=${raceDateForUrl}&Racecourse=${racecourse}&RaceNo=${raceNo}`;
      try {
        await page.goto(url, { waitUntil: 'networkidle0' });
        await sleep(1000);

        const raceData = await page.evaluate((rNo) => {
          const tables = Array.from(document.querySelectorAll('table'));

          // Strategy 1: find table whose rows contain horse number links or have 20+ columns
          let mainTable = null;

          // Try tables[4] first (5th table, known position on HKJC racecard)
          // but verify it has horse data (≥5 rows with ≥10 cells)
          for (let startIdx = 3; startIdx <= 7 && !mainTable; startIdx++) {
            const t = tables[startIdx];
            if (!t) continue;
            const rows = Array.from(t.querySelectorAll('tbody tr'));
            const validRows = rows.filter(r => r.querySelectorAll('td').length >= 10);
            if (validRows.length >= 2) { mainTable = t; }
          }

          // Strategy 2: largest table with rows having ≥10 cells
          if (!mainTable) {
            let best = 0;
            for (const t of tables) {
              const cnt = Array.from(t.querySelectorAll('tbody tr')).filter(r => r.querySelectorAll('td').length >= 10).length;
              if (cnt > best) { best = cnt; mainTable = t; }
            }
          }

          if (!mainTable) return null;

          // Extract race info from page header
          let raceClass = '';
          let distance = 0;
          let trackType = '';
          let going = '';

          // Look for race info in the page
          const pageText = document.body.innerText;
          const distMatch = pageText.match(/(\d{4})\s*米/);
          if (distMatch) distance = parseInt(distMatch[1]);
          if (pageText.includes('全天候')) trackType = 'AWT';
          else if (pageText.includes('草地')) trackType = 'TURF';

          // Try to extract race class from headings
          const headings = document.querySelectorAll('h1, h2, h3, .f_title, [class*="title"]');
          headings.forEach(h => {
            const t = h.textContent;
            const cm = t.match(/第\s*(\d+)\s*班/) || t.match(/班次\s*[:：]\s*(\d+)/);
            if (cm) raceClass = cm[1];
          });

          const horses = [];
          mainTable.querySelectorAll('tbody tr').forEach(row => {
            const cells = Array.from(row.querySelectorAll('td'));
            if (cells.length < 10) return;

            const c = i => (cells[i]?.textContent || '').trim();
            const horseNo = parseInt(c(0));
            if (!horseNo || horseNo > 20) return;

            // Extract horse ID from link in cell [4]
            let horseId = '';
            const horseLink = cells[4]?.querySelector('a');
            if (horseLink) {
              const m = (horseLink.href || '').match(/horseid=([A-Z]\d+)/i);
              if (m) horseId = m[1].toUpperCase();
            }
            if (!horseId) horseId = c(4).replace(/\s/g, '');

            // Extract jockey ID from link in cell [6]
            let jockeyId = '';
            const jockeyLink = cells[6]?.querySelector('a');
            if (jockeyLink) {
              const m = (jockeyLink.href || '').match(/jockeyid=([A-Z]+)/i);
              if (m) jockeyId = m[1].toUpperCase();
            }

            // Extract trainer ID from link in cell [9]
            let trainerId = '';
            const trainerLink = cells[9]?.querySelector('a');
            if (trainerLink) {
              const m = (trainerLink.href || '').match(/trainerid=([A-Z]+)/i);
              if (m) trainerId = m[1].toUpperCase();
            }

            horses.push({
              horse_no: horseNo,
              recent_form: c(1),
              horse_name: c(3),
              horse_id: horseId,
              actual_weight: parseFloat(c(5)) || null,
              jockey_name: c(6),
              jockey_id: jockeyId,
              draw: parseInt(c(8)) || 0,
              trainer_name: c(9),
              trainer_id: trainerId,
              rating: parseInt(c(11)) || null,
              rating_change: c(12),
              declared_weight: parseInt(c(13)) || null,
              gear: c(22),
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
};
