const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.goto('https://www.whoscored.com/matches/1903409/live/england-premier-league-2025-2026-brentford-west-ham', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 8000));
  const html = await page.content();
  console.log('title:', await page.title());
  console.log('"events":[ 出現次數:', (html.match(/"events":\[/g) || []).length);
  console.log('CornerAwarded 出現:', (html.match(/CornerAwarded/g) || []).length);
  console.log('startTime:', (html.match(/"startTime":"[^"]+"/g) || []).slice(0, 2));
  console.log('homeTeam:', (html.match(/"homeTeam":\{"teamId":\d+/g) || []).slice(0, 2));
  // 用同一個 extractor 攞 events
  const idx = html.indexOf('"events":[');
  const start = idx + 9;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const ev = JSON.parse(html.slice(start, end + 1));
  console.log('\n事件總數:', ev.length);
  const byType = {};
  ev.forEach(e => { const t = e.type && e.type.displayName; byType[t] = (byType[t] || 0) + 1; });
  console.log('type 分佈:', JSON.stringify(byType));
  const corners = ev.filter(e => e.type && e.type.displayName === 'CornerAwarded');
  console.log('\n頭 4 個 CornerAwarded 原始 JSON:');
  corners.slice(0, 4).forEach(c => console.log(' ', JSON.stringify(c).slice(0, 260)));
  const goals = ev.filter(e => e.type && /goal/i.test(e.type.displayName));
  console.log('\nGoal 相關事件:');
  goals.forEach(g => console.log(' ', g.minute, g.type.displayName, 'teamId', g.teamId, 'satisfied', g.satisfiedEventList && JSON.stringify(g.satisfiedEventList).slice(0, 60)));
  await browser.close(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
