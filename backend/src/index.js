const express = require('express');
const cors = require('cors');
const { initDb } = require('./db/init');
const scraper = require('./scrapers/hkjc');

const app = express();
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/jockeys', require('./routes/jockeys'));
app.use('/api/trainers', require('./routes/trainers'));
app.use('/api/draw', require('./routes/draw'));
app.use('/api/races', require('./routes/races'));
app.use('/api/horses', require('./routes/horses'));
app.use('/api/coursetime', require('./routes/coursetime'));

// ── SSE helpers ──────────────────────────────────────────────────────────────
// Map of active SSE clients per job type
const sseClients = { jockeys: new Set(), trainers: new Set(), fixtures: new Set(), horses: new Set(), racecard: new Set() };

function broadcast(type, data) {
  const clients = sseClients[type];
  if (!clients) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => {
    try { res.write(msg); } catch (_) {}
  });
}

function sseEndpoint(type) {
  return (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    sseClients[type].add(res);
    req.on('close', () => sseClients[type].delete(res));
  };
}

// SSE streams
app.get('/api/scrape/jockeys/progress', sseEndpoint('jockeys'));
app.get('/api/scrape/trainers/progress', sseEndpoint('trainers'));
app.get('/api/scrape/fixtures/progress', sseEndpoint('fixtures'));
app.get('/api/scrape/horses/progress', sseEndpoint('horses'));

// ── Manual scrape triggers ────────────────────────────────────────────────────
let jockeyScraping = false;
app.post('/api/scrape/jockeys', async (req, res) => {
  if (jockeyScraping) {
    return res.status(409).json({ message: '騎師更新進行中，請稍後' });
  }
  res.json({ message: '騎師資料更新已啟動' });
  jockeyScraping = true;
  broadcast('jockeys', { type: 'started' });
  scraper.runFullJockeyScrape((event) => {
    broadcast('jockeys', event);
  }).then(() => {
    broadcast('jockeys', { type: 'completed' });
  }).catch(err => {
    broadcast('jockeys', { type: 'error', message: err.message });
  }).finally(() => {
    jockeyScraping = false;
  });
});

let trainerScraping = false;
app.post('/api/scrape/trainers', async (req, res) => {
  if (trainerScraping) {
    return res.status(409).json({ message: '練馬師更新進行中，請稍後' });
  }
  res.json({ message: '練馬師資料更新已啟動' });
  trainerScraping = true;
  broadcast('trainers', { type: 'started' });
  scraper.runFullTrainerScrape((event) => {
    broadcast('trainers', event);
  }).then(() => {
    broadcast('trainers', { type: 'completed' });
  }).catch(err => {
    broadcast('trainers', { type: 'error', message: err.message });
  }).finally(() => {
    trainerScraping = false;
  });
});

let fixturesScraping = false;
app.post('/api/scrape/fixtures', async (req, res) => {
  if (fixturesScraping) {
    return res.status(409).json({ message: '賽期表更新進行中，請稍後' });
  }
  res.json({ message: '賽期表更新已啟動' });
  fixturesScraping = true;
  broadcast('fixtures', { type: 'started' });
  scraper.scrapeFixtures().then(() => {
    broadcast('fixtures', { type: 'completed' });
  }).catch(err => {
    broadcast('fixtures', { type: 'error', message: err.message });
  }).finally(() => {
    fixturesScraping = false;
  });
});

app.get('/api/scrape/racecard/progress', sseEndpoint('racecard'));

let racecardScraping = false;
app.post('/api/scrape/racecard', async (req, res) => {
  if (racecardScraping) {
    return res.status(409).json({ message: '排位表更新進行中，請稍後' });
  }
  res.json({ message: '排位表更新已啟動' });
  racecardScraping = true;
  broadcast('racecard', { type: 'started' });
  (async () => {
    try {
      const result = await scraper.scrapeRacecard();
      if (result.raceDate && result.races.length > 0) {
        await scraper.saveRacecard(result.raceDate, result.racecourse, result.races);
        broadcast('racecard', { type: 'completed', raceDate: result.raceDate, racecourse: result.racecourse, races: result.races.length });
      } else {
        broadcast('racecard', { type: 'completed', message: '未找到排位表資料（可能今日無賽事）', races: 0 });
      }
    } catch (err) {
      broadcast('racecard', { type: 'error', message: err.message });
    } finally {
      racecardScraping = false;
    }
  })();
});

app.post('/api/scrape/horse/:horseId', async (req, res) => {
  try {
    const { horseId } = req.params;
    const info = await scraper.scrapeHorse(horseId);
    if (info) {
      await scraper.saveHorse(horseId, info);
      res.json({ message: '馬匹資料已更新', horseId, name: info.name_zh });
    } else {
      res.status(404).json({ message: '未找到馬匹資料' });
    }
  } catch (err) {
    res.status(500).json({ message: '馬匹資料更新失敗：' + err.message });
  }
});

let horseScraping = false;
app.post('/api/scrape/horses', async (req, res) => {
  if (horseScraping) {
    return res.status(409).json({ message: '馬匹資料更新進行中，請稍後' });
  }
  res.json({ message: '馬匹資料全量更新已啟動' });
  horseScraping = true;
  broadcast('horses', { type: 'started' });
  scraper.runFullHorseScrape((event) => {
    broadcast('horses', event);
  }).then(() => {
    broadcast('horses', { type: 'completed' });
  }).catch(err => {
    broadcast('horses', { type: 'error', message: err.message });
  }).finally(() => {
    horseScraping = false;
  });
});

app.post('/api/scrape/coursetime', async (req, res) => {
  try {
    const rows = await scraper.scrapeCourseTime();
    const saved = await scraper.saveCourseTime(rows);
    res.json({ message: `跑道標準時間已更新，共 ${saved} 筆記錄` });
  } catch (err) {
    res.status(500).json({ message: '跑道標準時間更新失敗：' + err.message });
  }
});

// Scrape status
app.get('/api/scrape/status', (req, res) => {
  res.json({
    jockeys: jockeyScraping,
    trainers: trainerScraping,
    fixtures: fixturesScraping,
    horses: horseScraping,
    racecard: racecardScraping,
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;

async function start() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`Backend running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
