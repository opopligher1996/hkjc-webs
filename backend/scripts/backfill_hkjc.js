// ── HAD 歷史回填（馬會口徑）：HKJC GraphQL 賽果 ↔ titan007 配對 → 百家初盤 ──
// 用法：docker compose run --rm backend node scripts/backfill_hkjc.js [daysBack]
//   daysBack 預設 90（最多可以逐 31 日窗口查詢）
const puppeteer = require('puppeteer');
const pool = require('../src/db/pool');
const { scrapeOne, nameSim } = require('../src/football/hdaService');

// ── Phase 1: HKJC GraphQL 賽果（截獲官網原裝 query・逐頁攞）──
// 注意：listener 一定要喺 goto 之前装，先截到官網自己發嘅 query（whitelist 用）
async function openResultsPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  let origQuery = null;
  page.on('request', r => {
    if (!origQuery && r.url().includes('graphql') && r.postData()?.includes('matchResult')) {
      origQuery = JSON.parse(r.postData()).query;
    }
  });
  await page.goto('https://bet.hkjc.com/ch/football/results', { waitUntil: 'networkidle2', timeout: 30000 });
  for (let i = 0; i < 30 && !origQuery; i++) await new Promise(r => setTimeout(r, 500));
  return { page, query: origQuery };
}

async function gqlCall(page, query, vars) {
  const body = JSON.stringify({ query, variables: vars });
  return await page.evaluate(async (b) => {
    const r = await fetch('https://info.cld.hkjc.com/graphql/base/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Referer': 'https://bet.hkjc.com/' },
      body: b,
    });
    return await r.json();
  }, body);
}

async function fetchHkjcResults(page, query, startDate, endDate) {
  const PAGE = 20; // server 限制一次最多 ~20 場
  const all = [];
  let total = null;
  for (let idx = 1; total == null || idx <= total; idx += PAGE) {
    const r = await gqlCall(page, query, { startDate, endDate, startIndex: idx, endIndex: idx + PAGE - 1, teamId: null });
    if (r.errors?.length) throw new Error(JSON.stringify(r.errors).slice(0, 80));
    const ms = r?.data?.matches || [];
    if (total == null) total = r?.data?.matchNumByDate?.total ?? ms.length;
    all.push(...ms);
    if (!ms.length) break;
  }
  return all.map(m => {
    const ko = m.kickOffTime || '';
    const dm = ko.match(/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    const res = (m.results || [])[0];
    return {
      fb: m.frontEndId || m.matchNumber,
      date: dm ? dm[1] : (m.matchDate || '').slice(0, 10),
      time: dm ? dm[2] : null,
      home: m.homeTeam?.name_ch,
      away: m.awayTeam?.name_ch,
      leagueCh: m.tournament?.name_ch,
      hg: res ? +res.homeResult : null,
      ag: res ? +res.awayResult : null,
    };
  }).filter(m => m.date && m.time && m.home && m.away && m.hg != null);
}

// ── Phase 2: titan Over 頁掃描（全聯賽・完場）──
async function scrapeOverDay(page, dt) {
  const ymd = dt.toISOString().slice(0, 10).replace(/-/g, '');
  // 傳 primitive 入 evaluate（Date 會被序列化成 string）
  const pageDay = +dt.toISOString().slice(8, 10);
  const pageMs = dt.getTime();
  try {
    await page.goto(`https://bf.titan007.com/football/Over_${ymd}.htm`, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3500));
    return await page.evaluate((pd, pms) => {
      const out = [];
      for (const tr of document.querySelectorAll('tr')) {
        const tds = Array.from(tr.querySelectorAll('td'));
        if (tds.length < 9) continue;
        const timeStr = (tds[1]?.innerText || '').trim(); // "3日11:00"
        const home = (tds[3]?.innerText || '').replace(/\[\d+\]/g, '').replace(/\*/g, '').trim();
        const score = (tds[4]?.innerText || '').trim();
        const away = (tds[5]?.innerText || '').replace(/\[\d+\]/g, '').replace(/\*/g, '').trim();
        const leagueName = (tds[0]?.innerText || '').trim();
        const lastHtml = tds[tds.length - 1]?.innerHTML || '';
        const im = lastHtml.match(/(?:EuropeOdds|AsianOdds|analysis)\((\d+)\)/);
        const sm = score.match(/^(\d+)-(\d+)$/);
        const tm = timeStr.match(/^(\d{1,2})日(\d{2}:\d{2})$/);
        if (!im || !sm || !tm) continue;
        // 跨日：深夜場屬於頁面日期第二日
        const day = +tm[1];
        let ms = pms;
        if (day !== pd) ms = pms + 86400000;
        const d = new Date(ms);
        if (d.getUTCDate() !== day) continue; // 仲係對唔上就跳過
        out.push({
          titanId: +im[1],
          date: d.toISOString().slice(0, 10),
          time: tm[2],
          homeCn: home, awayCn: away,
          leagueName, hg: +sm[1], ag: +sm[2],
        });
      }
      return out;
    }, pageDay, pageMs);
  } catch (_) { return []; }
}

(async () => {
  const daysBack = parseInt(process.argv[2]) || 90;
  console.log(`回填馬會賽果 ${daysBack} 日`);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const orp = await openResultsPage(browser);
  const gqlPage = orp.page;
  let hkjcQuery = orp.query;
  // 後備：hardcode 原文 query（byte-exact・有 whitelist）
  if (!hkjcQuery) {
    const fs = require('fs');
    hkjcQuery = JSON.parse(fs.readFileSync('/app/src/football/hkjcQuery.json', 'utf8')).query;
    console.log('⚠ 用 hardcode query 後備');
  }
  // 等頁面自己啲請求完全初始化（cookies/auth）先開始 fetch
  await new Promise(r => setTimeout(r, 8000));

  // Phase 1: 逐 ≤31 日窗口攞 HKJC 賽果（server 限制：窗口最多 31 日）
  const hkjcAll = [];
  const today = new Date();
  for (let end = daysBack; end > 0; end -= 31) {
    const startOff = Math.max(end - 30, 0); // 31 日 inclusive
    const s = new Date(today.getTime() - end * 86400000).toISOString().slice(0, 10);
    const e = new Date(today.getTime() - startOff * 86400000).toISOString().slice(0, 10);
    try {
      const ms = await fetchHkjcResults(gqlPage, hkjcQuery, s, e);
      hkjcAll.push(...ms);
      console.log(`HKJC ${s}~${e}: ${ms.length} 場`);
    } catch (err) { console.log(`HKJC ${s}~${e} FAIL: ${err.message.slice(0, 60)}`); }
  }
  const seen = new Set();
  const hkjc = hkjcAll.filter(m => { const k = `${m.date}|${m.time}|${m.home}`; if (seen.has(k)) return false; seen.add(k); return true; });
  console.log(`HKJC 總數（有賽果）: ${hkjc.length}`);

  // Phase 2: titan Over 掃描
  const titanAll = [];
  const overPage = await browser.newPage();
  await overPage.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  for (let d = daysBack; d >= 1; d--) {
    const dt = new Date(today.getTime() - d * 86400000);
    const ms = await scrapeOverDay(overPage, dt);
    titanAll.push(...ms);
    process.stdout.write(`\rtitan 掃描 ${daysBack - d + 1}/${daysBack} 日（${titanAll.length} 場）`);
  }
  console.log('');

  // Phase 3: 配對
  const bySlot = new Map();
  for (const t of titanAll) {
    const key = `${t.date}|${t.time}`;
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key).push(t);
  }
  const matched = [];
  for (const h of hkjc) {
    const slot = bySlot.get(`${h.date}|${h.time}`) || [];
    let best = null, bestSim = 0;
    for (const t of slot) {
      const sim = (nameSim(h.home, t.homeCn) + nameSim(h.away, t.awayCn)) / 2;
      if (sim > bestSim) { bestSim = sim; best = t; }
    }
    if (best && bestSim >= 0.5) {
      matched.push({ ...h, titanId: best.titanId, leagueCn: best.leagueName, sim: +bestSim.toFixed(2) });
    }
  }
  console.log(`配對成功: ${matched.length}/${hkjc.length}`);

  // Phase 4: 剔除已有（有齊 odds+result）→ 抓 1x2
  const { rows: existing } = await pool.query('SELECT titan_id, open_h, result FROM had_odds');
  const exMap = new Map(existing.map(r => [String(r.titan_id), r]));
  const todo = matched.filter(m => {
    const ex = exMap.get(String(m.titanId));
    return !ex || !ex.open_h || !ex.result;
  });
  console.log(`要抓: ${todo.length} 場`);

  let done = 0, fail = 0;
  const queue = [...todo];
  await Promise.all([0, 1, 2].map(async () => {
    while (queue.length) {
      const m = queue.shift();
      if (!m) break;
      try {
        await scrapeOne(m.titanId, {
          league: null, date: m.date, home: m.home, away: m.away,
          leagueCn: m.leagueCh || m.leagueCn, homeGoals: m.hg, awayGoals: m.ag,
        });
      } catch (_) { fail++; }
      done++;
      if (done % 20 === 0) console.log(`  進度 ${done}/${todo.length}（失敗 ${fail}）`);
    }
  }));
  console.log(`完成：${done}（失敗 ${fail}）`);
  const { rows: cnt } = await pool.query("SELECT COUNT(*) c, COUNT(result) r FROM had_odds");
  console.log(`had_odds 總數 ${cnt[0].c}・有賽果 ${cnt[0].r}`);
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
