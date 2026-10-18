// ── titan007 未來賽程爬取 ─────────────────────────────────────────────────
// bf.titan007.com/football/Next_YYYYMMDD.htm → 英超/德甲/西甲/美職賽事
const puppeteer = require('puppeteer');
const pool = require('../db/pool');

const LEAGUE_NAMES = { EPL: '英超', BUN: '德甲', LAL: '西甲', MLS: '美职业' };

const CN_MAP = {
  '阿森纳': 'Arsenal', '利物浦': 'Liverpool', '切尔西': 'Chelsea', '曼彻斯特城': 'Manchester City',
  '曼城': 'Manchester City', '曼联': 'Manchester United', '曼彻斯特联': 'Manchester United',
  '热刺': 'Tottenham', '托特纳姆热刺': 'Tottenham', '纽卡斯尔': 'Newcastle', '纽卡斯尔联': 'Newcastle',
  '阿斯顿维拉': 'Aston Villa', '布莱顿': 'Brighton', '布伦特福德': 'Brentford',
  '水晶宫': 'Crystal Palace', '埃弗顿': 'Everton', '富勒姆': 'Fulham',
  '诺丁汉森林': 'Nottingham Forest', '西汉姆': 'West Ham', '西汉姆联': 'West Ham',
  '伯恩茅斯': 'Bournemouth', '狼队': 'Wolves', '利兹联': 'Leeds', '伯恩利': 'Burnley',
  '桑德兰': 'Sunderland', '伊普斯维奇': 'Ipswich', '考文垂': 'Coventry', '赫尔城': 'Hull',
  '莱斯特城': 'Leicester', '南安普顿': 'Southampton',
  '皇家马德里': 'Real Madrid', '巴塞罗那': 'Barcelona', '马德里竞技': 'Atletico Madrid',
  '皇家社会': 'Real Sociedad', '毕尔巴鄂竞技': 'Athletic Club', '比利亚雷亚尔': 'Villarreal',
  '皇家贝蒂斯': 'Real Betis', '塞维利亚': 'Sevilla', '瓦伦西亚': 'Valencia',
  '赫罗纳': 'Girona', '塞尔塔': 'Celta Vigo', '奥萨苏纳': 'Osasuna',
  '马洛卡': 'Mallorca', '阿拉维斯': 'Deportivo Alaves', '拉斯帕尔马斯': 'Las Palmas',
  '赫塔菲': 'Getafe', '巴列卡诺': 'Rayo Vallecano', '西班牙人': 'Espanyol',
  '莱加内斯': 'Leganes', '莱万特': 'Levante', '埃尔切': 'Elche',
  '皇家奥维耶多': 'Real Oviedo', '马拉加': 'Malaga', '巴拉多利德': 'Real Valladolid',
  '拉科鲁尼亚': 'Deportivo de A Coruna', '桑坦德竞技': 'Racing Santander', '巴伦西亚': 'Valencia',
  '拜仁慕尼黑': 'Bayern Munich', '多特蒙德': 'Borussia Dortmund', '勒沃库森': 'Bayer Leverkusen',
  'RB莱比锡': 'RB Leipzig', '莱比锡红牛': 'RB Leipzig', '法兰克福': 'Eintracht Frankfurt',
  '沃尔夫斯堡': 'Wolfsburg', '弗赖堡': 'Freiburg', '门兴格拉德巴赫': 'Borussia M.Gladbach',
  '柏林联合': 'Union Berlin', '美因茨': 'Mainz 05', '云达不莱梅': 'Werder Bremen',
  '霍芬海姆': 'Hoffenheim', '奥格斯堡': 'Augsburg', '斯图加特': 'VfB Stuttgart',
  '科隆': 'FC Koln', '圣保利': 'St. Pauli', '汉堡': 'Hamburger SV',
  '帕德博恩': 'Paderborn', '埃弗斯堡': 'Elversberg', '沙尔克04': 'Schalke 04',
  '多伦多FC': 'Toronto FC', 'CF蒙特利尔': 'CF Montreal', '芝加哥火焰': 'Chicago Fire FC',
  '纽约城': 'New York City FC', '亚特兰大联': 'Atlanta United', '辛辛那提': 'FC Cincinnati',
  '夏洛特FC': 'Charlotte FC', '达拉斯FC': 'FC Dallas', '迈阿密国际': 'Inter Miami CF',
  '华盛顿联': 'DC United', '新英格兰革命': 'New England Revolution',
  '西雅图海湾人': 'Seattle Sounders FC', '纽约红牛': 'Red Bull New York',
  '圣地亚哥': 'San Diego FC', '奥兰多城': 'Orlando City', '哥伦布机员': 'Columbus Crew',
  '费城联合': 'Philadelphia Union', '皇家盐湖城': 'Real Salt Lake', '奥斯汀FC': 'Austin FC',
  '纳什威尔SC': 'Nashville SC', '明尼苏达联': 'Minnesota United',
  '休斯敦迪纳摩': 'Houston Dynamo FC', '堪萨斯城竞技': 'Sporting Kansas City',
  '波特兰伐木者': 'Portland Timbers', '科罗拉多急流': 'Colorado Rapids',
  '圣何塞地震': 'San Jose Earthquakes', '洛杉矶FC': 'Los Angeles FC',
  '温哥华白浪': 'Vancouver Whitecaps', '圣路易斯城': 'St. Louis City',
  '洛杉矶银河': 'LA Galaxy',
};

function mapTeam(cn) {
  const clean = cn.replace(/\[\d+\]/g, '').replace(/\*/g, '').trim();
  for (const [k, v] of Object.entries(CN_MAP)) { if (clean.includes(k)) return v; }
  return clean;
}

async function scrapeSchedule(days = 10, { all = false } = {}) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page1 = await browser.newPage();
  const page2 = await browser.newPage();
  for (const p of [page1, page2]) {
    await p.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  }
  const out = [];

  const scrapeDay = async (page, dt) => {
    const ymd = dt.toISOString().slice(0, 10).replace(/-/g, '');
    const url = `https://bf.titan007.com/football/Next_${ymd}.htm`;
    const extract = () => page.evaluate(() => {
      const rows = [];
      for (const tr of document.querySelectorAll('tr')) {
        const tds = Array.from(tr.querySelectorAll('td'));
        if (tds.length < 9) continue;
        const leagueName = (tds[0]?.innerText || '').trim();
        const timeStr = (tds[1]?.innerText || '').trim();
        const home = (tds[3]?.innerText || '').trim();
        const away = (tds[5]?.innerText || '').trim();
        const ahLine = (tds[7]?.innerText || '').replace('*', '').trim();
        const goalLine = (tds[8]?.innerText || '').trim();
        let titanId = null;
        const lastHtml = tds[tds.length - 1]?.innerHTML || '';
        const m = lastHtml.match(/(?:EuropeOdds|AsianOdds|analysis)\((\d+)\)/);
        if (m) titanId = +m[1];
        if (home && away && /\d{1,2}-\d{1,2} \d{2}:\d{2}/.test(timeStr)) {
          rows.push({ leagueName, timeStr, home, away, ahLine, goalLine, titanId });
        }
      }
      return rows;
    });
    // 有數據先算成功（呢啲頁一定有幾百行）・最多 3 次
    let matches = [];
    for (let attempt = 0; attempt < 3 && !matches.length; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3500));
        matches = await extract();
      } catch (_) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await new Promise(r => setTimeout(r, 6000));
          matches = await extract();
        } catch (_) {}
      }
    }
    if (!matches.length) return [];

    const dayMatches = [];
      for (const m of matches) {
        // 行內自帶日期（跨日清晨場）；否則用頁面日期
        const dm = m.timeStr.match(/(\d{1,2})-(\d{1,2}) (\d{2}:\d{2})/);
        let date = dt.toISOString().slice(0, 10);
        if (dm) date = `${dt.getUTCFullYear()}-${dm[1].padStart(2, '0')}-${dm[2].padStart(2, '0')}`;
        const cleaned = {
          leagueName: m.leagueName,
          league: null,
          date,
          time: dm ? dm[3] : m.timeStr.trim(),
          homeCn: m.home.replace(/\[[^\]]*\]/g, '').replace(/\*/g, '').trim(),
          awayCn: m.away.replace(/\[[^\]]*\]/g, '').replace(/\*/g, '').trim(),
          titanAh: m.ahLine || null,
          titanLine: m.goalLine || null,
          titanId: m.titanId,
        };
        if (all) {
          dayMatches.push(cleaned);
        } else {
          for (const [code, name] of Object.entries(LEAGUE_NAMES)) {
            if (m.leagueName === name) {
              dayMatches.push({ ...cleaned, league: code, home: mapTeam(m.home), away: mapTeam(m.away) });
              break;
            }
          }
        }
      }
      return dayMatches;
  };

  try {
    const today = new Date();
    // 由尋日開始掃（覆蓋翌日清晨場：titan Next 頁結構 = 當日 + 翌日早朝）
    const dates = Array.from({ length: days + 1 }, (_, d) => new Date(today.getTime() + (d - 1) * 86400000));
    const odd = dates.filter((_, i) => i % 2 === 0);
    const even = dates.filter((_, i) => i % 2 === 1);
    const [r1, r2] = await Promise.all([
      (async () => { const acc = []; for (const d of odd) acc.push(...await scrapeDay(page1, d)); return acc; })(),
      (async () => { const acc = []; for (const d of even) acc.push(...await scrapeDay(page2, d)); return acc; })(),
    ]);
    out.push(...r1, ...r2);
    out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  } finally {
    await browser.close();
  }
  return out;
}

module.exports = { scrapeSchedule, mapTeam, CN_MAP };
