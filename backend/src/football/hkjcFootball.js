// ── 香港賽馬會足球賽事爬取（主客和賠率）──────────────────────────────────
// bet.hkjc.com/ch/football/home — 全部受注賽事（繁體中文隊名 + FB編號 + HAD賠率）
const puppeteer = require('puppeteer');

async function scrapeHkjcMatches() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    await page.goto('https://bet.hkjc.com/ch/football/home', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 8000));
    // 撳「顯示更多」+ 碌容器・直至冇新場次
    for (let i = 0; i < 10; i++) {
      const prev = await page.evaluate(() => (document.body.innerText.match(/FB\d{3,}/g) || []).length);
      // 碌容器到最底（觸發 infinite scroll）
      await page.evaluate(() => {
        let best = null;
        for (const el of document.querySelectorAll('div')) {
          const s = getComputedStyle(el);
          if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 100) {
            if (!best || el.scrollHeight > best.scrollHeight) best = el;
          }
        }
        if (best) best.scrollTop = best.scrollHeight;
        window.scrollTo(0, document.body.scrollHeight);
      });
      await new Promise(r => setTimeout(r, 2000));
      // 撳「顯示更多」
      try { await page.click('.FBMatchListLoadMoreButton', { timeout: 3000 }); }
      catch (_) { /* 按鈕唔喺度 */ }
      await new Promise(r => setTimeout(r, 5000));
      const now = await page.evaluate(() => (document.body.innerText.match(/FB\d{3,}/g) || []).length);
      if (now === prev) break;
    }
    const rows = await page.evaluate(() => {
      const out = [];
      const walk = (el) => {
        const kids = el.children;
        if (kids.length === 0) return;
        // 葉節點附近有 FB 編號嘅容器
        const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (/^FB\d{3,}/.test(txt) || /\d{2}\/\d{2}\/\d{4} \d{2}:\d{2} FB\d{3,}/.test(txt)) {
          if (txt.length < 260) out.push(txt);
        }
        for (const k of kids) walk(k);
      };
      walk(document.body);
      return out;
    });
    // 解析：DD/MM/YYYY HH:MM FBxxxx 主 客 [比分垃圾] H D A
    const matches = [];
    for (const r of rows) {
      const m = r.match(/(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2}) (FB\d+) (.+)/);
      if (!m) continue;
      const date = `${m[3]}-${m[2]}-${m[1]}`;
      const time = m[4];
      const fb = m[5];
      const rest = m[6].trim();
      // 尾三個小數 = HAD 賠率
      const odds = rest.match(/(\d+\.\d{2})\s+(\d+\.\d{2})\s+(\d+\.\d{2})\s*$/);
      let hadH = null, hadD = null, hadA = null, names = rest;
      if (odds) {
        hadH = +odds[1]; hadD = +odds[2]; hadA = +odds[3];
        names = rest.slice(0, rest.indexOf(odds[1])).trim();
      }
      // 移除比分/狀態垃圾（數字、x(x:x)、上半/下半/完場/UEtv/YT 等）
      names = names
        .replace(/\b\d+\(\d+:\d+\)\b/g, '')
        .replace(/\b(上半|下半|完場|中場|待開|延期|取消)\b/g, '')
        .replace(/\b(UEtv|YT|YT\d*|NOW\d+|C+|Lev|ViuTV)\b/g, '')
        .replace(/\b\d+\b/g, ' ')
        .replace(/\s+/g, ' ').trim();
      // 頭兩個非空 token = 主/客
      const parts = names.split(' ').filter(Boolean);
      if (parts.length < 2) continue;
      const home = parts[0], away = parts[1];
      matches.push({ fb, date, time, home, away, hadH, hadD, hadA });
    }
    // 去重（walk 可能重複收集）
    const seen = new Set();
    return matches.filter(m => {
      if (seen.has(m.fb)) return false;
      seen.add(m.fb); return true;
    });
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeHkjcMatches };

// ── 馬會讓球（亞洲盤）hdc 頁 ──────────────────────────────────────────────
// bet.hkjc.com/ch/football/hdc — 每場：主隊讓球線+賠率・客隊讓球線+賠率
const JUNK = /^(上半|下半|暫停受注|按此顯示其他即場投注種類|讓球現已暫停受注|完場|中場|待開|延期|取消|-+|OAH|MTS|HTA|UEtv|YT|NOW\d*|\d+|\d+\(\d+:\d+\)|.+女足.*杯)$/;
async function scrapeHkjcAh() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    await page.goto('https://bet.hkjc.com/ch/football/hdc', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 6000));
    // 撳「顯示更多」+ 碌容器・同 scrapeHkjcMatches 一樣加強版
    for (let i = 0; i < 10; i++) {
      const prev = await page.evaluate(() => (document.body.innerText.match(/FB\d{3,}/g) || []).length);
      // 碌容器到最底
      await page.evaluate(() => {
        let best = null;
        for (const el of document.querySelectorAll('div')) {
          const s = getComputedStyle(el);
          if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 100) {
            if (!best || el.scrollHeight > best.scrollHeight) best = el;
          }
        }
        if (best) best.scrollTop = best.scrollHeight;
        window.scrollTo(0, document.body.scrollHeight);
      });
      await new Promise(r => setTimeout(r, 2000));
      // 撳「顯示更多」
      try { await page.click('.FBMatchListLoadMoreButton', { timeout: 3000 }); }
      catch (_) { /* 按鈕唔喺度 */ }
      await new Promise(r => setTimeout(r, 5000));
      const now = await page.evaluate(() => (document.body.innerText.match(/FB\d{3,}/g) || []).length);
      if (now === prev) break;
    }
    await new Promise(r => setTimeout(r, 3000));
    const body = await page.evaluate(() => document.body.innerText);
    // 按 FB 段切
    const out = [];
    const re = /FB(\d{3,5})/g;
    let m;
    const marks = [];
    while ((m = re.exec(body)) !== null) marks.push({ fb: 'FB' + m[1], start: m.index });
    for (let i = 0; i < marks.length; i++) {
      const seg = body.slice(marks[i].start + marks[i].fb.length, marks[i + 1]?.start ?? body.length);
      // 搵兩組 [線] 賠率
      const tokens = seg.split(/\n|\s{2,}/).map(t => t.trim()).filter(Boolean);
      let line1 = null, odds1 = null, line2 = null, odds2 = null;
      for (let j = 0; j < tokens.length; j++) {
        const t = tokens[j];
        if (/^\[[+-]?\d+(?:[\/.][+-]?\d+)*\]$/.test(t)) {
          if (line1 == null) {
            line1 = t.slice(1, -1);
            const nx = tokens[j + 1];
            odds1 = /^\d+\.\d{2}$/.test(nx) ? +nx : (nx === '---' ? null : odds1);
          } else if (line2 == null) {
            line2 = t.slice(1, -1);
            const nx = tokens[j + 1];
            odds2 = /^\d+\.\d{2}$/.test(nx) ? +nx : (nx === '---' ? null : odds2);
          }
        }
      }
      // 隊名：線之前嘅非垃圾 token 頭兩個
      const nameTokens = [];
      for (const t of tokens) {
        if (/^\[/.test(t)) break;
        if (JUNK.test(t)) continue;
        nameTokens.push(t);
      }
      if (!line1 && !line2) continue; // 冇讓球盤
      out.push({
        fb: marks[i].fb,
        home: nameTokens[0] || null,
        away: nameTokens[1] || null,
        homeLine: line1, homeOdds: odds1,
        awayLine: line2, awayOdds: odds2,
      });
    }
    return out;
  } finally {
    await browser.close();
  }
}

// 讓球勝負（主隊角度）：勝/半勝/走/半負/負
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

module.exports.scrapeHkjcAh = scrapeHkjcAh;
module.exports.ahOutcome = ahOutcome;
