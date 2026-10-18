// ── HKJC GraphQL 賽果（共用）───────────────────────────────────────────────
// query 有 server-side whitelist：優先截獲官網自己發嘅 request，
// 失敗就用 hkjcQuery.json 入面嘅原文（byte-exact）
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const FALLBACK_QUERY = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'hkjcQuery.json'), 'utf8')).query;

async function fetchHkjcResults(page, startDate, endDate) {
  let query = FALLBACK_QUERY;
  // 重新加載一次頁面，嘗試截獲新鮮 query（有就覆蓋後備）
  let captured = null;
  const handler = r => {
    if (!captured && r.url().includes('graphql') && r.postData()?.includes('matchResult')) {
      captured = JSON.parse(r.postData()).query;
    }
  };
  page.on('request', handler);
  try {
    await page.goto('https://bet.hkjc.com/ch/football/results', { waitUntil: 'networkidle2', timeout: 30000 });
    for (let i = 0; i < 12 && !captured; i++) await new Promise(r => setTimeout(r, 500));
  } catch (_) {}
  finally { page.off('request', handler); }
  if (captured) query = captured;

  const all = [];
  let total = null;
  for (let idx = 1; total == null || idx <= total; idx += 20) {
    const body = JSON.stringify({ query, variables: { startDate, endDate, startIndex: idx, endIndex: idx + 19, teamId: null } });
    const r = await page.evaluate(async (b) => {
      const res = await fetch('https://info.cld.hkjc.com/graphql/base/', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Referer': 'https://bet.hkjc.com/' }, body: b,
      });
      return await res.json();
    }, body);
    if (r.errors?.length) throw new Error(JSON.stringify(r.errors).slice(0, 100));
    const ms = r?.data?.matches || [];
    if (total == null) total = r?.data?.matchNumByDate?.total ?? ms.length;
    all.push(...ms);
    if (!ms.length) break;
  }
  return all.map(m => {
    // results 係事件日誌：resultType 1 = 入球記錄（最後一筆 = 完場比分）
    // resultType 2 = 角球進程・resultType 4 = 角球事件 — 唔係比分！
    const goals = (m.results || []).filter(x => x.resultType === 1);
    const fin = goals.length ? goals.reduce((a, b) => (b.sequence > a.sequence ? b : a)) : null;
    const ko = (m.kickOffTime || '').match(/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    return {
      fb: (m.frontEndId || m.matchNumber || '').replace(/^FB/, '') || null,
      date: ko ? ko[1] : null,
      time: ko ? ko[2] : null,
      home: m.homeTeam?.name_ch || null,
      away: m.awayTeam?.name_ch || null,
      hg: fin ? +fin.homeResult : null,
      ag: fin ? +fin.awayResult : null,
    };
  }).filter(m => m.date && m.time && m.home && m.hg != null);
}

// 開一個備好嘅 page（login-free・只係要 cookie 環境）
async function openResultsPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  return page;
}

module.exports = { fetchHkjcResults, openResultsPage };
