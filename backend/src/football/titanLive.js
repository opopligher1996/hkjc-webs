// ── titan007 即場數據追蹤器 ─────────────────────────────────────────────────
// 每 30 秒自動刷新 live.titan007.com/detail/{id}sb.htm
// 提取：分鐘、比分、角球（主客）、控球率、射門 → 餵入 predictLive
const puppeteer = require('puppeteer');
const pool = require('../db/pool');

let _browser = null;
async function getPage() {
  if (!_browser) {
    _browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  }
  const page = await _browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setDefaultNavigationTimeout(20000);
  return page;
}
async function closeBrowser() {
  if (_browser) { try { await _browser.close(); } catch (_) {} _browser = null; }
}

// 從 titan007 live 頁提取即場數據
// 比重權威來源：「即時走勢」表最後一行（頁頭比分/分鐘可能係 stale cache）
// 技術統計：限「本场技术统计」之後嘅段落（避開盤口數字）
async function scrapeLiveMatch(titanId, _retry = true) {
  const page = await getPage();
  try {
    await page.setCacheEnabled(false);
    // ?_=timestamp 防 CDN 焗舊版
    await page.goto(`https://live.titan007.com/detail/${titanId}sb.htm?_=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r => setTimeout(r, 3000));
    return await page.evaluate(() => {
      const body = document.body.innerText;
      const title = document.title || '';
      // 1) 走勢行：NN H:A（入球/事件）・中场 H:A
      const rows = [];
      for (const tr of document.querySelectorAll('tr')) {
        const t = (tr.innerText || '').replace(/\s+/g, ' ').trim();
        let m = t.match(/^(\d{1,3})\s+(\d+):(\d+)\s/);
        if (m) { rows.push({ minute: +m[1], hg: +m[2], ag: +m[3], ht: false }); continue; }
        m = t.match(/^中场\s+(\d+):(\d+)\s/);
        if (m) rows.push({ minute: 45, hg: +m[1], ag: +m[2], ht: true });
      }
      const last = rows.length ? rows[rows.length - 1] : null;
      // 2) 頁頭分鐘（有時較新・>100 視為垃圾）→ 取大但夾上限 95
      const headerMinM = body.match(/(\d{1,3})'/);
      let headerMin = headerMinM ? +headerMinM[1] : null;
      if (headerMin != null && headerMin > 100) headerMin = null;
      // 官方時間顯示（#mState）：45'/46'/90+2' — 最權威
      const mStateEl = document.getElementById('mState');
      const mStateTxt = mStateEl ? (mStateEl.textContent || '').trim() : null;
      // 中场/完场 狀態字
      const statePhase = mStateTxt && /[半完]/.test(mStateTxt) ? mStateTxt : null;
      let minute = null;
      if (mStateTxt) {
        const mm = mStateTxt.match(/(\d{1,3})/);
        minute = mm ? +mm[1] : null;
        if (mStateTxt.includes('+')) {
          const plus = mStateTxt.match(/\+(\d{1,2})/);
          if (plus) minute = Math.min(90 + +plus[1], 95);
        }
        if (/中场|中場/.test(mStateTxt)) minute = 45;
        if (/完场|完場/.test(mStateTxt)) minute = 90;
      }
      if (minute == null) minute = last ? Math.max(last.minute, headerMin || 0) : headerMin;
      if (minute != null && minute > 95) minute = 95;
      const score = last ? { hg: last.hg, ag: last.ag } : null;
      // 3) 技術統計（新格式：00049% 控球率 51%000・39 进攻 34・6(3) 射门(射正) 2(0)）
      const statIdx = body.indexOf('本场技术统计');
      const statSec = statIdx >= 0 ? body.slice(statIdx, statIdx + 900) : body;
      const num = (re) => { const m = body.match(re); return m ? { home: +m[1], away: +m[2] } : null; };
      const teams = (() => {
        const tm = title.match(/(.+?)VS(.+?)\(/);
        return tm ? { home: tm[1].trim(), away: tm[2].trim() } : null;
      })();
      return {
        minute,
        score,
        // 結構化統計（.barbox class 精準解析 — 取代粘連 regex）
        corners: (() => {
          // 角球喺 venticons：home/away 各一個 span（順序：主隊排前）
          const icons = [...document.querySelectorAll('[class*="venticons"] span')];
          const c = icons.map(s2 => ({ t: s2.querySelector('img')?.title || '', v: (s2.textContent || '').trim() })).filter(x => x.t === '角球');
          return c.length >= 2 ? { home: +c[0].v || 0, away: +c[1].v || 0 } : null;
        })(),
        possession: null, shots: null, shotsOnTarget: null, dangerousAttacks: null,
        ...(() => {
          const map = {};
          document.querySelectorAll('.barbox').forEach(b => {
            const label = (b.querySelector('.data')?.textContent || '').trim();
            const values = [...b.querySelectorAll('.value')].map(v => (v.textContent || '').trim());
            if (!label || values.length < 2) return;
            map[label] = { left: values[0], right: values[values.length - 1] };
          });
          const pair = (v) => {
            if (!v) return null;
            const l = parseFloat(v.left), r = parseFloat(v.right);
            if (isNaN(l) || isNaN(r)) return null;
            return { home: l, away: r };
          };
          const pos = map['控球率'];
          const sh = map['射门(射正)'];
          const dan = map['危险进攻'];
          const pass = map['传球成功率'];
          return {
            possession: pos ? pair(pos) : null,
            shots: sh ? pair(sh) : null,
            shotsOnTarget: sh ? (() => {
              const l = /\((\d+)\)/.exec(sh.left), r = /\((\d+)\)/.exec(sh.right);
              return l && r ? { home: +l[1], away: +r[1] } : null;
            })() : null,
            dangerousAttacks: dan ? pair(dan) : null,
            passAccuracy: pass ? pair(pass) : null,
          };
        })(),
        teams,
        htScore: (() => {
          const m2 = body.match(/\((\d+)-(\d+)\)\s*\n?\s*(?:半场|半場)?/);
          return m2 ? { hg: +m2[1], ag: +m2[2] } : null;
        })(),
        phase: (() => {
          const ms = document.getElementById('mState');
          const t = ms ? (ms.textContent || '').trim() : '';
          if (/完场|完場/.test(t)) return 'finished';
          if (/中场|中場/.test(t)) return 'halftime';
          if (t) return 'live';
          return last?.ht ? 'halftime' : minute != null ? 'live' : 'unknown';
        })(),
        status: /完场|完賽|FT/.test(title + body.slice(0, 300)) ? 'finished'
          : last?.ht ? 'halftime'
          : minute != null ? 'live' : 'unknown',
      };
    });
  } catch (e) {
    // shared browser 可能攤咗 — 重建後試一次
    try { await page.close(); } catch (_) {}
    if (_retry) {
      await closeBrowser();
      return scrapeLiveMatch(titanId, false);
    }
    throw e;
  } finally {
    try { await page.close(); } catch (_) {}
  }
}

// 搵今日/明日四大聯賽賽事嘅 titan007 ID
//（舊法：live.titan007.com /detail/ 連結 — 頁面改版後已失效）
async function findLiveIds(leagues = ['英超', '美職', 'Major League Soccer']) {
  const page = await getPage();
  try {
    const out = [];
    // 今日 + 聽日兩頁（覆蓋深夜場）・每頁最多試兩次
    for (let d = 0; d <= 1; d++) {
      const dt = new Date(Date.now() + d * 86400000);
      const ymd = dt.toISOString().slice(0, 10).replace(/-/g, '');
      const url = `https://bf.titan007.com/football/Next_${ymd}.htm`;
      let rows = [];
      for (let attempt = 0; attempt < 2 && !rows.length; attempt++) {
        try {
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
          await new Promise(r => setTimeout(r, 3000));
          rows = await page.evaluate(() => {
            const res = [];
            for (const tr of document.querySelectorAll('tr')) {
              const tds = Array.from(tr.querySelectorAll('td'));
              if (tds.length < 9) continue;
              const leagueName = (tds[0]?.innerText || '').trim();
              const timeStr = (tds[1]?.innerText || '').trim();
              const home = (tds[3]?.innerText || '').replace(/\[\d+\]/g, '').replace(/\*/g, '').trim();
              const away = (tds[5]?.innerText || '').replace(/\[\d+\]/g, '').replace(/\*/g, '').trim();
              const lastHtml = tds[tds.length - 1]?.innerHTML || '';
              const m = lastHtml.match(/(?:EuropeOdds|AsianOdds|analysis)\((\d+)\)/);
              if (m && home && away && /\d{1,2}-\d{1,2} \d{2}:\d{2}/.test(timeStr)) {
                res.push({ leagueName, timeStr, home, away, titanId: m[1] });
              }
            }
            return res;
          });
        } catch (_) {
          // 後備：domcontentloaded
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await new Promise(r => setTimeout(r, 5000));
          } catch (_) {}
        }
      }
      for (const r of rows) {
        // 精確聯賽名匹配（避免「西甲」誤中「巴西甲」）
        if (leagues.includes(r.leagueName)) {
          out.push({ titanId: r.titanId, text: `${r.home}VS${r.away}`, leagueName: r.leagueName, timeStr: r.timeStr });
        }
      }
    }
    // 去重
    return [...new Map(out.map(x => [x.titanId, x])).values()];
  } finally {
    await page.close();
  }
}

// 舊名保留向後兼容
async function findEplLiveIds() { return findLiveIds(['英超']); }

// 中文隊名 → WhoScored 英文名
const TEAM_MAP = {
  // 英超
  '阿森纳': 'Arsenal', '利物浦': 'Liverpool', '切尔西': 'Chelsea', '曼城': 'Manchester City',
  '曼彻斯特城': 'Manchester City', '曼联': 'Manchester United', '曼彻斯特联': 'Manchester United',
  '热刺': 'Tottenham', '托特纳姆热刺': 'Tottenham', '纽卡斯尔': 'Newcastle', '纽卡斯尔联': 'Newcastle',
  '阿斯顿维拉': 'Aston Villa', '布莱顿': 'Brighton', '布伦特福德': 'Brentford',
  '水晶宫': 'Crystal Palace', '埃弗顿': 'Everton', '富勒姆': 'Fulham',
  '诺丁汉森林': 'Nottingham Forest', '西汉姆': 'West Ham', '西汉姆联': 'West Ham',
  '伯恩茅斯': 'Bournemouth', '狼队': 'Wolves', '伍尔弗汉普顿': 'Wolves',
  '利兹联': 'Leeds', '利兹': 'Leeds', '伯恩利': 'Burnley', '桑德兰': 'Sunderland',
  '伊普斯维奇': 'Ipswich', '考文垂': 'Coventry', '赫尔城': 'Hull', '莱斯特城': 'Leicester',
  '南安普顿': 'Southampton',
  // 美職（WhoScored 全名）
  '亚特兰大联': 'Atlanta United', '夏洛特FC': 'Charlotte FC', '芝加哥火焰': 'Chicago Fire FC',
  '辛辛那提FC': 'FC Cincinnati', '科罗拉多急流': 'Colorado Rapids', '哥伦布机员': 'Columbus Crew',
  '达拉斯FC': 'FC Dallas', '华盛顿联': 'DC United', '休斯敦迪纳摩': 'Houston Dynamo FC',
  '堪萨斯城竞技': 'Sporting Kansas City', '洛杉矶银河': 'LA Galaxy', '洛杉矶FC': 'Los Angeles FC',
  '迈阿密国际': 'Inter Miami CF', '明尼苏达联': 'Minnesota United', '蒙特利尔CF': 'CF Montreal',
  '纳什维尔SC': 'Nashville SC', '新英格兰革命': 'New England Revolution', '纽约城FC': 'New York City FC',
  '纽约红牛': 'New York Red Bulls', '奥兰多城': 'Orlando City SC', '费城联合': 'Philadelphia Union',
  '波特兰伐木者': 'Portland Timbers', '皇家盐湖城': 'Real Salt Lake', '圣何塞地震': 'San Jose Earthquakes',
  '西雅图海湾人': 'Seattle Sounders FC', '圣路易斯城': 'St. Louis City', '多伦多FC': 'Toronto FC',
  '温哥华白帽': 'Vancouver Whitecaps', '奥斯汀FC': 'Austin FC', '圣迭戈FC': 'San Diego FC',
  // 德甲
  '拜仁慕尼黑': 'Bayern Munich', '多特蒙德': 'Borussia Dortmund', '勒沃库森': 'Bayer Leverkusen',
  'RB莱比锡': 'RB Leipzig', '莱比锡红牛': 'RB Leipzig', '法兰克福': 'Eintracht Frankfurt',
  '沃尔夫斯堡': 'Wolfsburg', '弗赖堡': 'Freiburg', '门兴格拉德巴赫': 'Borussia M.Gladbach',
  '柏林联合': 'Union Berlin', '美因茨': 'Mainz 05', '云达不莱梅': 'Werder Bremen',
  '霍芬海姆': 'Hoffenheim', '奥格斯堡': 'Augsburg', '斯图加特': 'VfB Stuttgart',
  '科隆': 'FC Koln', '波鸿': 'Bochum', '海登海姆': 'FC Heidenheim',
  '达姆施塔特': 'Darmstadt', '圣保利': 'St Pauli', '汉堡': 'Hamburger SV',
  '柏林赫塔': 'Hertha Berlin', '沙尔克04': 'Schalke 04',
  // 西甲
  '皇家马德里': 'Real Madrid', '巴塞罗那': 'Barcelona', '马德里竞技': 'Atletico Madrid',
  '皇家社会': 'Real Sociedad', '毕尔巴鄂竞技': 'Athletic Bilbao', '比利亚雷亚尔': 'Villarreal',
  '皇家贝蒂斯': 'Real Betis', '塞维利亚': 'Sevilla', '瓦伦西亚': 'Valencia',
  '赫罗纳': 'Girona', '塞尔塔': 'Celta Vigo', '奥萨苏纳': 'Osasuna',
  '马洛卡': 'Mallorca', '阿拉维斯': 'Alaves', '拉斯帕尔马斯': 'Las Palmas',
  '加的斯': 'Cadiz', '格拉纳达': 'Granada', '赫塔费': 'Getafe',
  '巴列卡诺': 'Rayo Vallecano', '西班牙人': 'Espanyol', '莱加内斯': 'Leganes',
  '巴拉多利德': 'Valladolid', '莱万特': 'Levante', '埃尔切': 'Elche',
  '阿拉维斯': 'Alaves', '奥维耶多': 'Oviedo', '莱里达': 'Lleida',
};
const mapTeam = (cn) => {
  for (const [k, v] of Object.entries(TEAM_MAP)) {
    if (cn && cn.includes(k)) return v;
  }
  // fallback：titanSchedule 嘅全量 mapping（德甲/西甲/MLS 齊）
  const sched = require('./titanSchedule');
  if (cn && sched.mapTeam && cn !== sched.mapTeam(cn)) return sched.mapTeam(cn);
  return cn;
};

module.exports = { scrapeLiveMatch, findEplLiveIds, findLiveIds, closeBrowser, mapTeam };
