// ── HK33 百家平均初盤及歷史相似賠率（會員頁）───────────────────────────────
// goal.hk33.com/analysis/init-odds-returns — 登入後直接攞成個表
const puppeteer = require('puppeteer');

const EMAIL = process.env.HK33_EMAIL || '';
const PASSWORD = process.env.HK33_PASSWORD || '';

async function loginFlow(page) {
  await page.goto('https://goal.hk33.com/', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2500));
  // 年齡閘
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('div')) {
      const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
      if (own.includes('本人已年滿十八歲')) { el.click(); break; }
    }
  });
  await new Promise(r => setTimeout(r, 2000));
  // 登入
  await page.goto('https://www.hk33.com/user/login-register', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2500));
  await page.type('input[name=email_or_username]', EMAIL, { delay: 20 });
  await page.type('input[name=password]', PASSWORD, { delay: 20 });
  await new Promise(r => setTimeout(r, 600));
  const h = await page.evaluateHandle(() => {
    for (const el of document.querySelectorAll('div, span, a, button')) {
      if ((el.innerText || '').trim() === '登入戶口') return el;
    }
    return null;
  });
  const el = h.asElement();
  if (el) {
    const box = await el.boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await new Promise(r => setTimeout(r, 5000));
}

// 解析一行（17 td 結構）
function parseCells(cells) {
  if (cells.length < 15) return null;
  const fbM = (cells[0] || '').trim().match(/^[一二三四五六日]\s*(\d{3,5})$/);
  if (!fbM) return null;
  if (!/^\d{2}\/\d{2} \d{2}:\d{2}$/.test((cells[1] || '').trim())) return null;
  const split3 = s => (s || '').split(/[\/\n]/).map(x => parseFloat(x.trim()));
  const [h, sdH, cvH] = split3(cells[5]);
  const [d, sdD, cvD] = split3(cells[6]);
  const [a, sdA, cvA] = split3(cells[7]);
  const p = s => parseFloat(String(s || '0').replace('%', '')) / 100;
  if (![h, d, a].every(x => x > 1)) return null;
  return {
    fb: 'FB' + fbM[1],
    time: cells[1].trim(),
    league: (cells[2] || '').trim(),
    home: (cells[3] || '').trim(),
    away: (cells[4] || '').trim(),
    h, sdH, cvH, d, sdD, cvD, a, sdA, cvA,
    n: parseInt(cells[8]) || 0,
    rateH: p(cells[9]), rateD: p(cells[10]), rateA: p(cells[11]),
    roiH: p(cells[12]), roiD: p(cells[13]), roiA: p(cells[14]),
  };
}

async function scrapeHk33() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    await loginFlow(page);
    await page.goto('https://goal.hk33.com/analysis/init-odds-returns', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 6000));
    if (/會員專享|登入/.test(await page.title()) || (await page.evaluate(() => document.body.innerText)).includes('會員專享')) {
      throw new Error('登入失敗');
    }
    const rows = await page.evaluate(() => {
      const out = [];
      for (const tr of document.querySelectorAll('tr')) {
        const cells = Array.from(tr.querySelectorAll('td')).map(c => (c.innerText || '').trim());
        if (cells.length >= 15) out.push(cells);
      }
      return out;
    });
    const matches = [];
    const seen = new Set();
    for (const cells of rows) {
      const m = parseCells(cells);
      if (m && !seen.has(m.fb)) { seen.add(m.fb); matches.push(m); }
    }
    return matches;
  } finally {
    await browser.close();
  }
}

// 快取：DB 永久保存・首次抓取後唔會取代（新 FB 先入庫）
// 記憶體快取 30 分鐘（只為發現新賽事；舊數據由 DB 提供）
let memCache = { at: 0, fbs: [] };
const pool = require('../db/pool');

async function getHk33(force = false) {
  if (!force && memCache.fbs.length && Date.now() - memCache.at < 30 * 60 * 1000) {
    const { rows } = await pool.query('SELECT data FROM hk33_had');
    return { rows: rows.map(r => r.data), at: memCache.at };
  }
  const fresh = await scrapeHk33();
  // 淨係入庫新 FB（已存在嘅絕不改動）
  for (const m of fresh) {
    await pool.query(
      'INSERT INTO hk33_had (fb, data) VALUES ($1, $2) ON CONFLICT (fb) DO NOTHING',
      [m.fb, JSON.stringify(m)]);
  }
  const { rows } = await pool.query('SELECT data FROM hk33_had');
  memCache = { at: Date.now(), fbs: rows.map(r => r.data.fb) };
  return { rows: rows.map(r => r.data), at: memCache.at };
}

module.exports = { getHk33 };
