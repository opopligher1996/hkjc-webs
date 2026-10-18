// ── WhoScored 抓取器（足球角球分析用）───────────────────────────────────────
// 管道：聯賽頁 → 賽季下拉（seasons/stages）→ fixtures 頁逐月 → 每場賽事頁
// 內嵌 Opta 事件流（CornerAwarded / Goal，含分鐘 + teamId + 上下半場）。
// 反爬：Incapsula 擋 curl，但真 Chromium（Puppeteer）+ 住宅 IP 過到（已 spike 驗證）。
const puppeteer = require('puppeteer');
const pool = require('../db/pool');

const LEAGUES = {
  EPL: { region: 252, tournament: 2, slug: 'england-premier-league', name: '英超' },
  BUN: { region: 81, tournament: 3, slug: 'germany-bundesliga', name: '德甲' },
  LAL: { region: 206, tournament: 4, slug: 'spain-laliga', name: '西甲' },
  MLS: { region: 233, tournament: 85, slug: 'usa-major-league-soccer', name: '美職' },
};

let _browser = null;
let _page = null;
async function getPage() {
  if (_page) return _page;
  _browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  _page = await _browser.newPage();
  await _page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await _page.setDefaultNavigationTimeout(60000);
  await _page.setDefaultTimeout(45000);
  return _page;
}
async function closeBrowser() {
  if (_browser) { try { await _browser.close(); } catch (_) {} _browser = null; _page = null; }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 聯賽頁 → 賽季清單 [{season, stage, label, url}]（含重試）
async function getSeasons(leagueKey) {
  const L = LEAGUES[leagueKey];
  const page = await getPage();
  let options = [];
  for (let attempt = 0; attempt < 3 && !options.length; attempt++) {
    await page.goto(`https://www.whoscored.com/Regions/${L.region}/Tournaments/${L.tournament}/${L.slug}`, {
      waitUntil: 'networkidle2',
    });
    await sleep(attempt === 0 ? 5000 : 9000); // 畀 Incapsula 挑戰完成
    options = await page.evaluate(() => {
      const out = [];
      for (const o of document.querySelectorAll('select option')) {
        const v = o.value || '';
        if ((/20[12]\d\s*\/\s*20[12]\d/.test((o.innerText || '').trim()) || /^20[12]\d$/.test((o.innerText || '').trim())) && /\/seasons\//i.test(v)) {
          out.push({ v, t: (o.innerText || '').trim() });
        }
      }
      return out;
    });
  }
  return options.map(o => {
    const m = o.v.match(/\/seasons\/(\d+)/i);
    return {
      label: o.t.replace(/\s+/g, ''),           // 2025/2026
      season: o.t.includes('/') ? o.t.replace('/', '-') : o.t.trim(),  // 2026-2027 或 2026（美職）
      seasonId: m ? +m[1] : null,
      seasonUrl: 'https://www.whoscored.com' + o.v,
    };
  }).filter(s => s.seasonId);
}

// 賽季 → fixtures 完整清單（搵 Fixtures tab 攞 stage → 逐月 harvest）
async function getFixtures(leagueKey, seasonObj) {
  const L = LEAGUES[leagueKey];
  const page = await getPage();
  // 1. 賽季頁搵 Fixtures tab（含 stageId）
  await page.goto(seasonObj.seasonUrl, { waitUntil: 'networkidle2' });
  await sleep(5000);
  let fxTab = null;
  for (let a = 0; a < 3 && !fxTab; a++) {
    const tabs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a'))
        .map(a => ({ h: a.getAttribute('href') || '', t: (a.innerText || '').trim() }))
        .filter(x => x.t === 'Fixtures' || /fixtures/i.test(x.h)));
    fxTab = tabs[0] || null;
    if (!fxTab) await sleep(7000);
  }
  if (!fxTab) throw new Error('搵唔到 Fixtures tab');
  const fxUrl = fxTab.h.startsWith('http') ? fxTab.h : 'https://www.whoscored.com' + fxTab.h;

  // （getFixtures 續）去 fixtures 頁 + 箭嘴逐格 harvest
  await page.goto(fxUrl, { waitUntil: 'networkidle2' });
  await sleep(7000);

  const harvest = async () => page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/matches/"]')) {
      const h = a.getAttribute('href') || '';
      const m = h.match(/^\/matches\/(\d+)\/(?:live|show|preview|report)\/([a-z0-9-]+)$/);
      if (!m) continue;
      // home/away slug 由 URL（剔走聯賽+年份前綴）
      const slugParts = m[2].replace(/^[a-z-]+-\d{4}-\d{4}-/, '');
      const [hs, ...rest] = slugParts.split('-');
      const as = rest.join('-');
      // 比分由 Match-module_row（格式：FT 3 1 Leeds Burnley …）
      let row = a.closest('[class*="Match-module_row"]');
      const txt = row ? row.innerText.replace(/\s+/g, ' ').trim() : '';
      const sc = txt.match(/(?:FT|FT-Pen)\s+(\d+)\s+(\d+)/) || txt.match(/^(\d+)\s+(\d+)\s+\S+/);
      if (hs && as) out.push({
        id: +m[1],
        url: 'https://www.whoscored.com' + h,
        homeSlug: hs, awaySlug: as,
        ft: /FT/.test(txt),
        hg: sc ? +sc[1] : null, ag: sc ? +sc[2] : null,
      });
    }
    return out;
  });

  // 箭嘴導航：先撳 prev（過去賽季由季初起 / 現役賽季由當前週行返轉頭），
  // 行到盡再 next —— 兩種賽季狀態都啱
  const all = new Map();
  const merge = (list) => list.forEach(x => all.set(x.id, x));
  merge(await harvest());
  const clickBtn = (idx) => page.evaluate((i) => {
    const btns = Array.from(document.querySelectorAll('button[class*="dayChangeBtn"]'));
    if (!btns[i]) return false;
    btns[i].click();
    return true;
  }, idx);
  for (const dir of [0, 1]) {
    for (let step = 0; step < 60; step++) {
      const before = all.size;
      let ok = false;
      try { ok = await clickBtn(dir); } catch (_) {}
      if (!ok) break;
      await sleep(4500);
      try { merge(await harvest()); } catch (_) {}
      if (all.size === before && step > 2) break;   // 冇新場 = 行到盡
    }
  }
  return [...all.values()];
}

// 平衡括號提取頁面內嵌 "events":[...] JSON
function extractEventsJson(html) {
  const idx = html.indexOf('"events":[');
  if (idx < 0) return null;
  const start = idx + '"events":'.length;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

// 一場賽事 → { meta, corners[], goals[] }
async function scrapeMatch(matchUrl) {
  const page = await getPage();
  await page.goto(matchUrl, { waitUntil: 'networkidle2' });
  await sleep(6000);
  const html = await page.content();
  const title = await page.title();
  const events = extractEventsJson(html);
  if (!events || !events.length) return { error: 'no_events', title };

  // 比賽日期
  const sm = html.match(/"startTime":"(\d{4}-\d{2}-\d{2})T/);
  const date = sm ? sm[1] : null;

  // ── 主客 + 比分：title 係權威（Leeds 3-1 Burnley - Premier League 2025/2026 Live）──
  // 事件流入球唔齊（penalty/own goal 另計），FT 比分由 title 攞
  const tm = title.match(/^(.+?)\s+(\d+)\s*[-:]\s*(\d+)\s+(.+?)\s+-\s+/);
  const homeName = tm ? tm[1].trim() : null;
  const awayName = tm ? tm[4].trim() : null;
  const ftHg = tm ? +tm[2] : null;
  const ftAg = tm ? +tm[3] : null;

  // teamId → 主/客：頁首球隊連結（a[href*="/teams/{id}"]，第一個=主隊）
  const teamLinks = await page.evaluate(() => {
    const seen = new Map();
    for (const a of document.querySelectorAll('a[href*="/teams/"]')) {
      const m = (a.getAttribute('href') || '').match(/\/teams\/(\d+)\//);
      if (m && !seen.has(+m[1])) seen.set(+m[1], (a.innerText || '').trim().slice(0, 50));
      if (seen.size >= 2) break;
    }
    return [...seen.entries()];
  });
  const homeTeamId = teamLinks[0] ? teamLinks[0][0] : null;
  const awayTeamId = teamLinks[1] ? teamLinks[1][0] : null;

  // 角球：只計進攻方（outcomeType=1 Successful）；防守方嗰條係鏡像（成對同分鐘）
  // 入球：事件只做時間軸（game state 用），比分以 title 為準
  const corners = [], goals = [], reds = [];
  for (const e of events) {
    const t = e.type && e.type.displayName;
    const minute = e.expandedMinute != null ? e.expandedMinute : e.minute;
    const isHome = homeTeamId != null ? e.teamId === homeTeamId : null;
    const period = e.period && e.period.displayName;
    if (t === 'CornerAwarded' && e.outcomeType && e.outcomeType.value === 1) {
      corners.push({ minute, teamId: e.teamId, isHome, period, sid: e.id });
    } else if (t === 'Goal') {
      // Own goal（烏龍球）：計入對方 — state 時間軸先啱
      const own = /OwnGoal/i.test(JSON.stringify(e.qualifiers || []));
      const scoreForHome = own ? (e.teamId !== homeTeamId) : (e.teamId === homeTeamId);
      goals.push({ minute, teamId: e.teamId, isHome: scoreForHome, period, sid: e.id, own });
    } else if (t === 'Card' && /red/i.test(JSON.stringify(e.qualifiers || []))) {
      reds.push({ minute, teamId: e.teamId, isHome, period, sid: e.id });
    }
  }
  return {
    homeTeamId, awayTeamId, date,
    homeName, awayName, ftHg, ftAg,
    corners, goals, reds,
    nEvents: events.length, title,
  };
}

// 儲存一場（match row + events）
async function saveMatch(meta, ev) {
  // 比分用 title FT（權威 — 事件流入球唔齊）；角球由事件計（只計進攻方）
  const hg = ev.ftHg != null ? ev.ftHg : ev.goals.filter(g => g.isHome).length;
  const ag = ev.ftAg != null ? ev.ftAg : ev.goals.filter(g => !g.isHome).length;
  const home = ev.homeName || meta.home;
  const away = ev.awayName || meta.away;
  await pool.query(
    `INSERT INTO football_matches (id, league, season, match_date, home_team, away_team,
       home_team_id, away_team_id, home_goals, away_goals, home_corners, away_corners, scraped_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
     ON CONFLICT (id) DO UPDATE SET
       match_date=COALESCE($4, football_matches.match_date),
       home_team=$5, away_team=$6, home_team_id=$7, away_team_id=$8,
       home_goals=$9, away_goals=$10, home_corners=$11, away_corners=$12, scraped_at=NOW()`,
    [meta.id, meta.league, meta.season, ev.date || meta.date || null, home, away,
     ev.homeTeamId, ev.awayTeamId, hg, ag,
     ev.corners.filter(c => c.isHome).length, ev.corners.filter(c => !c.isHome).length]
  );
  await pool.query(`DELETE FROM football_match_events WHERE match_id = $1`, [meta.id]);
  const rows = [
    ...ev.corners.map(c => ({ ...c, type: 'corner' })),
    ...ev.goals.map(c => ({ ...c, type: 'goal' })),
    ...ev.reds.map(c => ({ ...c, type: 'red' })),
  ];
  for (const r of rows) {
    await pool.query(
      `INSERT INTO football_match_events (match_id, source_event_id, minute, expanded_minute, team_id, is_home, event_type, period)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (match_id, source_event_id) DO NOTHING`,
      [meta.id, r.sid != null ? r.sid : null, r.minute ?? 0, r.minute ?? 0, r.teamId ?? null,
       r.isHome ?? null, r.type, r.period || null]
    );
  }
  return rows.length;
}

module.exports = { LEAGUES, getSeasons, getFixtures, scrapeMatch, saveMatch, closeBrowser, getPage, sleep };
