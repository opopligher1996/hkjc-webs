// ── 自動 alias：用 titan007 搜尋 HKJC 隊名 → 抓簡體譯名 ──────────────────
const puppeteer = require('puppeteer');
const pool = require('../db/pool');

async function searchTitanName(browser, keyword) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    await page.goto(`https://ba2.titan007.com/homepage/multisearch?keyword=${encodeURIComponent(keyword)}`, {
      waitUntil: 'networkidle2', timeout: 20000,
    });
    await new Promise(r => setTimeout(r, 4000));
    const teams = await page.evaluate(() => {
      // 直接從 body 文字解析：搜尋結果球隊名區域
      const body = document.body.innerText;
      const secMatch = body.match(/的球队\s*\d+\s*个\s*\n*更多\s*\n([\s\S]*?)(?:搜索到|人气球吧|$)/);
      if (!secMatch) return [];
      // 按行拆・過濾中文名
      return secMatch[1].split(/\n+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2 && t.length <= 15 && /^[\u4e00-\u9fff\w\s()A-Z]+$/.test(t)
          && !/更多|搜索|球队|球员|用户|热门|解锁|NBA|关注/.test(t));
    });
    return teams.map(name => ({ name }));
  } finally {
    await page.close();
  }
}

// 對所有 outstanding 隊名自動搜尋 + 入 alias
async function autoResolve() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const results = [];
  try {
    // 攞 outstanding（同 /api/hda/unmatched 邏輯一致）
    const { rows: up } = await pool.query(
      `SELECT DISTINCT home, away FROM (
         SELECT home, away FROM hda_track WHERE titan_id IS NULL
         UNION
         SELECT home_team, away_team FROM had_odds WHERE titan_id IS NULL AND odds_src = 'HKJC'
       ) t LIMIT 30`);
    const { rows: aliases } = await pool.query('SELECT hkjc_name FROM team_alias');
    const aliasSet = new Set(aliases.map(r => r.hkjc_name));
    const seen = new Set();
    const todo = [];
    for (const r of up) {
      for (const team of [r.home, r.away]) {
        if (!team || seen.has(team) || aliasSet.has(team)) continue;
        seen.add(team);
        todo.push(team);
      }
    }

    for (const hkjcName of todo.slice(0, 20)) {
      try {
        const found = await searchTitanName(browser, hkjcName);
        if (found.length > 0) {
          // 偏好成年隊：剔走 U17/U18/U20/U21/B隊/女足
          const senior = found.filter(f => !/U1[789]|U2[01]|B队|女足|青年/.test(f.name));
          const best = (senior.length ? senior : found)[0].name;
          await pool.query('INSERT INTO team_alias (hkjc_name, titan_name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [hkjcName, best]);
          results.push({ hkjc: hkjcName, titan: best, ok: true });
        } else {
          results.push({ hkjc: hkjcName, titan: null, ok: false });
        }
      } catch (e) {
        results.push({ hkjc: hkjcName, titan: null, ok: false, error: e.message.slice(0, 50) });
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}

module.exports = { autoResolve, searchTitanName };
