// ── titan007 百家歐賠（1x2 主客和）─────────────────────────────────────────
// https://1x2.titan007.com/oddslist/{id}_2.htm
// 主表預設即時盤；切換「初」篩選後 = 各公司初盤
// 頁底「初盘平均值」= 主/和/客初盤平均（直接抄）
const puppeteer = require('puppeteer');

// 由 tr cells 抽統計行（初盘平均值 / 即时平均值）
function parseAvgRow(cells, label) {
  const flat = cells.map(c => c.replace(/\s/g, ''));
  const idx = flat.findIndex(c => c.replace(/\s/g, '') === label);
  if (idx < 0) return null;
  const nums = [];
  for (let i = idx + 1; i < cells.length && nums.length < 3; i++) {
    const m = (cells[i] || '').trim().match(/^\d+\.\d+$/);
    if (m) nums.push(+m[1]);
  }
  if (nums.length < 3) return null;
  return { h: nums[0], d: nums[1], a: nums[2] };
}

// 抽公司行（cells[2-4] = 賠率）
function parseBookRows(doc) {
  const books = [];
  for (const t of doc.querySelectorAll('table')) {
    for (const tr of t.querySelectorAll('tr')) {
      const cells = Array.from(tr.querySelectorAll('td')).map(c => (c.innerText || '').trim());
      if (cells.length < 8) continue;
      const hasTime = /\d{2}-\d{2} \d{2}:\d{2}/.test(cells[cells.length - 2] || '');
      const name = cells[1] || '';
      if (!hasTime || !name || /平均|最高|最低|注：/.test(name)) continue;
      const h = parseFloat(cells[2]), d = parseFloat(cells[3]), a = parseFloat(cells[4]);
      if (h >= 1.01 && d >= 1.01 && a >= 1.01 && h < 500 && d < 500 && a < 500) {
        books.push({ name, h, d, a });
      }
    }
  }
  return books;
}

async function scrape1x2(titanId) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    await page.goto(`https://1x2.titan007.com/oddslist/${titanId}_2.htm`, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));
    const title = await page.title();

    // 底部統計 + 即時公司行
    const init = await page.evaluate(() => {
      let openAvg = null, liveAvg = null;
      const grab = (label) => {
        for (const t of document.querySelectorAll('table')) {
          for (const tr of t.querySelectorAll('tr')) {
            const cells = Array.from(tr.querySelectorAll('td')).map(c => (c.innerText || '').trim());
            if (cells.some(c => c.replace(/\s/g, '') === label)) return cells;
          }
        }
        return null;
      };
      const oc = grab('初盘平均值');
      const lc = grab('即时平均值');
      const parse = (cells, label) => {
        if (!cells) return null;
        const idx = cells.findIndex(c => c.replace(/\s/g, '') === label);
        const nums = [];
        for (let i = idx + 1; i < cells.length && nums.length < 3; i++) {
          if (/^\d+\.\d+$/.test(cells[i].trim())) nums.push(+cells[i].trim());
        }
        return nums.length === 3 ? { h: nums[0], d: nums[1], a: nums[2] } : null;
      };
      if (oc) openAvg = parse(oc, '初盘平均值');
      if (lc) liveAvg = parse(lc, '即时平均值');
      return { openAvg, liveAvg };
    });
    const liveBooks = await page.evaluate(() => {
      const books = [];
      for (const t of document.querySelectorAll('table')) {
        for (const tr of t.querySelectorAll('tr')) {
          const cells = Array.from(tr.querySelectorAll('td')).map(c => (c.innerText || '').trim());
          if (cells.length < 8) continue;
          const hasTime = /\d{2}-\d{2} \d{2}:\d{2}/.test(cells[cells.length - 2] || '');
          const name = cells[1] || '';
          if (!hasTime || !name || /平均|最高|最低|注：/.test(name)) continue;
          const h = parseFloat(cells[2]), d = parseFloat(cells[3]), a = parseFloat(cells[4]);
          if (h >= 1.01 && d >= 1.01 && a >= 1.01 && h < 500 && d < 500 && a < 500) {
            books.push({ name, h, d, a });
          }
        }
      }
      return books;
    });

    // 切換「初」→ 各公司初盤
    let openBooks = [];
    const switched = await page.evaluate(() => {
      for (const s of document.querySelectorAll('select')) {
        for (const o of s.options) {
          if (o.text.trim() === '初') { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; }
        }
      }
      return false;
    });
    if (switched) {
      await new Promise(r => setTimeout(r, 3000));
      openBooks = await page.evaluate(() => {
        const books = [];
        for (const t of document.querySelectorAll('table')) {
          for (const tr of t.querySelectorAll('tr')) {
            const cells = Array.from(tr.querySelectorAll('td')).map(c => (c.innerText || '').trim());
            if (cells.length < 8) continue;
            const hasTime = /\d{2}-\d{2} \d{2}:\d{2}/.test(cells[cells.length - 2] || '');
            const name = cells[1] || '';
            if (!hasTime || !name || /平均|最高|最低|注：/.test(name)) continue;
            const h = parseFloat(cells[2]), d = parseFloat(cells[3]), a = parseFloat(cells[4]);
            if (h >= 1.01 && d >= 1.01 && a >= 1.01 && h < 500 && d < 500 && a < 500) {
              books.push({ name, h, d, a });
            }
          }
        }
        return books;
      });
    }

    const tm = title.match(/(.+?)VS(.+?)\(/);
    const lg = title.match(/\((\d{4}(?:-\d{4})?)赛季(.+?)\)/);
    // 頁首有賽果：「… 3 完 (0-1) 2 客隊 …」→ 主3客2
    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 1200));
    const scoreM = pageText.match(/(\d+)\s*完\s*\(\d+[:-]\d+\)\s*(\d+)/);
    const homeGoals = scoreM ? +scoreM[1] : null;
    const awayGoals = scoreM ? +scoreM[2] : null;
    const result = homeGoals == null ? null : (homeGoals > awayGoals ? 'H' : homeGoals === awayGoals ? 'D' : 'A');
    return {
      titanId,
      title,
      home: tm ? tm[1].trim() : null,
      away: tm ? tm[2].trim() : null,
      leagueCn: lg ? lg[2].trim() : null,
      homeGoals, awayGoals, result,
      openAvg: init.openAvg,   // ★ 初盘平均值（直接抄）
      liveAvg: init.liveAvg,
      openBooks,               // ★ 各公司初盤（計 SD/CV 用）
      liveBooks,
    };
  } finally {
    await browser.close();
  }
}

// SD / CV（總體標準差）
function stats(books) {
  const stat = key => {
    const xs = books.map(b => b[key]).filter(x => x > 1.001 && x < 500);
    if (xs.length < 2) return { n: xs.length, mean: null, sd: null, cv: null };
    const n = xs.length;
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const varr = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const sd = Math.sqrt(varr);
    return { n, mean: +mean.toFixed(3), sd: +sd.toFixed(4), cv: +(sd / mean).toFixed(4) };
  };
  return { h: stat('h'), d: stat('d'), a: stat('a') };
}

module.exports = { scrape1x2, stats };
