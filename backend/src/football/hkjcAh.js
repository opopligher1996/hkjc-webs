// ── 馬會讓球（亞洲盤）— GraphQL 分頁迴圈 ──────────────────────────────────
const puppeteer = require('puppeteer');

async function scrapeHkjcAh() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    // 開 hdc 頁建立 session
    await page.goto('https://bet.hkjc.com/ch/football/hdc', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));

    // 攔截原版 matchList URL 作模板
    let tmplUrl = null;
    // 已經載入咗 — 由 page 歷史攔截唔到・直接構造
    // 用 page.evaluate fetch 分頁循環
    const all = await page.evaluate(async () => {
      const query = `query matchList($startIndex:Int$endIndex:Int$startDate:String$endDate:String$matchIds:[String]$tournIds:[String]$fbOddsTypes:[FBOddsType]!$fbOddsTypesM:[FBOddsType]!$inplayOnly:Boolean$featuredMatchesOnly:Boolean$frontEndIds:[String]$earlySettlementOnly:Boolean$showAllMatch:Boolean){matches(startIndex:$startIndex endIndex:$endIndex startDate:$startDate endDate:$endDate matchIds:$matchIds tournIds:$tournIds fbOddsTypes:$fbOddsTypesM inplayOnly:$inplayOnly featuredMatchesOnly:$featuredMatchesOnly frontEndIds:$frontEndIds earlySettlementOnly:$earlySettlementOnly showAllMatch:$showAllMatch){id frontEndId matchDate kickOffTime status homeTeam{id name_ch} awayTeam{id name_ch} tournament{name_ch} foPools(fbOddsTypes:$fbOddsTypes){id status oddsType name_ch lines{lineId status condition main combinations{combId str status currentOdds selections{selId str name_ch}}}}}}`;
      const results = [];
      const PAGE = 60;
      for (let start = 1; start <= 500; start += PAGE) {
        const body = JSON.stringify({
          query,
          variables: {
            fbOddsTypes: ['HDC'], fbOddsTypesM: ['HDC'],
            featuredMatchesOnly: false, startDate: null, endDate: null,
            tournIds: null, matchIds: null,
            startIndex: start, endIndex: start + PAGE - 1,
            frontEndIds: null, earlySettlementOnly: false, showAllMatch: false,
          },
        });
        const r = await fetch('https://info.cld.hkjc.com/graphql/base-get/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Referer': 'https://bet.hkjc.com/' },
          body,
        });
        const j = await r.json();
        const ms = j?.data?.matches || [];
        if (!ms.length) break;
        results.push(...ms);
        if (ms.length < PAGE) break; // 最後一頁
      }
      return results;
    });

    const out = [];
    for (const m of all) {
      if (!m.foPools || !m.foPools.length) continue;
      const pool = m.foPools[0];
      if (!pool.lines || !pool.lines.length) continue;
      const line = pool.lines.find(l => l.main) || pool.lines[0];
      if (!line.combinations) continue;
      let homeLine = null, homeOdds = null, awayLine = null, awayOdds = null;
      // condition = 讓球線（主隊角度，如 "0.0/-0.5"）
      const cond = line.condition || null;
      for (const comb of line.combinations) {
        const sel = comb.selections?.[0]?.str || '';
        if (sel === 'H') { homeLine = cond; homeOdds = +comb.currentOdds || null; }
        else if (sel === 'A') { awayLine = cond; awayOdds = +comb.currentOdds || null; }
      }
      if (!homeLine && !awayLine) continue;
      out.push({
        fb: m.frontEndId,
        home: m.homeTeam?.name_ch || '',
        away: m.awayTeam?.name_ch || '',
        homeLine, homeOdds, awayLine, awayOdds,
      });
    }
    return out;
  } finally {
    await browser.close();
  }
}

// 讓球勝負（角度）：勝/半勝/走/半負/負
function ahOutcome(line, hg, ag) {
  const comps = line.split('/').map(s => parseFloat(s));
  const res = comps.map(c => {
    const adj = hg - ag + c;
    return Math.abs(adj) < 1e-9 ? 0 : adj > 0 ? 1 : -1;
  });
  if (res.length === 1) {
    return res[0] === 1 ? '勝' : res[0] === 0 ? '走' : '負';
  }
  const [a, b] = res;
  if (a === 1 && b === 1) return '勝';
  if (a + b === 1) return '半勝';
  if (a === 0 && b === 0) return '走';
  if (a + b === -1) return '半負';
  if (a === -1 && b === -1) return '負';
  return '走';
}

module.exports = { scrapeHkjcAh, ahOutcome };
