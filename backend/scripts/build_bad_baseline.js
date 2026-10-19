// ── 重建「壞基準」池：HKJC GraphQL 壞波膽 → had_odds_bad ──
// 目的：複製舊深綠格時代嘅 gap 計算環境（10月前壞賽果 + 10月起真實賽果）
// 用法：docker compose run --rm backend node scripts/build_bad_baseline.js
const puppeteer = require('puppeteer');
const pool = require('../src/db/pool');
const { nameSim } = require('../src/football/hdaService');

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

(async () => {
  // 1. 攞 had_odds 10月前有 titan_id 嘅場（要配壞賽果嘅目標）
  const { rows: targets } = await pool.query(
    `SELECT titan_id, match_date::text d, home_team, away_team
     FROM had_odds WHERE match_date < '2026-10-01' AND titan_id IS NOT NULL`);
  console.log('目標（10月前 titan 場）:', targets.length);

  await pool.query(`CREATE TABLE IF NOT EXISTS had_odds_bad (
    titan_id bigint PRIMARY KEY,
    bad_hg int, bad_ag int, bad_result char(1),
    match_date date, home_team text, away_team text)`);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const orp = await openResultsPage(browser);
  let query = orp.query;
  if (!query) {
    const fs = require('fs');
    query = JSON.parse(fs.readFileSync('/app/src/football/hkjcQuery.json', 'utf8')).query;
    console.log('⚠ 用 hardcode query 後備');
  }
  await new Promise(r => setTimeout(r, 8000));

  // 2. 逐 31 日窗口攞 HKJC 壞賽果（10月前 95 日 → 10月1日）
  const today = new Date();
  const hkjcAll = [];
  for (let end = 95; end > 0; end -= 31) {
    const startOff = Math.max(end - 30, 0);
    const s = new Date(today.getTime() - end * 86400000).toISOString().slice(0, 10);
    const e = new Date(today.getTime() - startOff * 86400000).toISOString().slice(0, 10);
    // 只要 10月前
    if (s >= '2026-10-01') continue;
    try {
      const PAGE = 20;
      let total = null;
      for (let idx = 1; total == null || idx <= total; idx += PAGE) {
        const r = await gqlCall(orp.page, query, { startDate: s, endDate: e, startIndex: idx, endIndex: idx + PAGE - 1, teamId: null });
        const ms = r?.data?.matches || [];
        if (total == null) total = r?.data?.matchNumByDate?.total ?? ms.length;
        if (!ms.length) break;
        for (const m of ms) {
          const ko = m.kickOffTime || '';
          const dm = ko.match(/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
          const res = (m.results || [])[0];
          if (!dm || !res) continue;
          hkjcAll.push({ date: dm[1], time: dm[2], home: m.homeTeam?.name_ch, away: m.awayTeam?.name_ch,
            hg: +res.homeResult, ag: +res.awayResult });
        }
        if (idx + PAGE > total) break;
      }
      console.log(`HKJC ${s}~${e}: 累積 ${hkjcAll.length}`);
    } catch (err) { console.log(`HKJC ${s}~${e} FAIL: ${err.message.slice(0, 60)}`); }
  }
  console.log('HKJC 壞賽果總數:', hkjcAll.length);

  // 3. 配對：日期 ±1 + nameSim（had_odds 冇 kickoff 欄）
  const byDate = new Map();
  for (const h of hkjcAll) {
    if (!byDate.has(h.date)) byDate.set(h.date, []);
    byDate.get(h.date).push(h);
  }
  let matched = 0;
  for (const t of targets) {
    const td = new Date(t.d + 'T12:00:00Z').getTime();
    let best = null, bestSim = 0;
    for (let off = -1; off <= 1; off++) {
      const key = new Date(td + off * 86400000).toISOString().slice(0, 10);
      for (const h of (byDate.get(key) || [])) {
        const sim = (nameSim(t.home_team, h.home) + nameSim(t.away_team, h.away)) / 2;
        if (sim > bestSim) { bestSim = sim; best = h; }
      }
    }
    if (best && bestSim >= 0.6) {
      const badResult = best.hg > best.ag ? 'H' : best.hg === best.ag ? 'D' : 'A';
      await pool.query(
        `INSERT INTO had_odds_bad (titan_id, bad_hg, bad_ag, bad_result, match_date, home_team, away_team)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (titan_id) DO NOTHING`,
        [t.titan_id, best.hg, best.ag, badResult, t.d, t.home_team, t.away_team]);
      matched++;
    }
  }
  console.log(`壞基準池建成：${matched} 場（配對率 ${(100*matched/targets.length).toFixed(0)}%）`);
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
