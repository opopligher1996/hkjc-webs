// ── 港版速度圖回測 ─────────────────────────────────────────────────────────
// 用法：docker compose run --rm backend node scripts/backtest_speedfig.js [YYYY-MM]
// 驗證：
//   1. 賽前圖數 vs 實際名次相關（field-normalized）
//   2. softmax(圖數) log-loss vs 市場 log-loss（k 掃描）
//   3. 最高圖數馬勝出率 / P&L
//   4. 第 9 章折扣規則：一放到底冇壓力嘅圖數係咪高估？
const pool = require('../src/db/pool');
const { buildFigures, figAt } = require('../src/ai/speedfig');

const MONTH = process.argv[2] || '2026-09';

(async () => {
  console.log('計算全部圖數（1,196 場）…');
  const figures = await buildFigures();
  const byHorse = new Map();
  for (const race of figures) {
    for (const h of race.horses) {
      if (!byHorse.has(h.nm)) byHorse.set(h.nm, []);
      byHorse.get(h.nm).push({ d: race.d, fig: h.fig, w2w: h.w2w, noPressure: h.noPressure });
    }
  }
  console.log(`圖數賽事: ${figures.length} 場，馬匹: ${byHorse.size} 匹\n`);

  // 測試賽事（要有市場賠率）
  const oddsRes = await pool.query(`
    SELECT DISTINCT ON (race_date, race_no, horse_name)
      TO_CHAR(race_date,'YYYY-MM-DD') d, race_no, horse_name, win_odds::float8 o
    FROM race_records
    WHERE TO_CHAR(race_date,'YYYY-MM') = $1 AND win_odds IS NOT NULL`, [MONTH]);
  const oddsOf = new Map(oddsRes.rows.map(r => [`${r.d}|${r.race_no}|${r.horse_name}`, r.o]));

  const testRaces = figures.filter(r => r.d.startsWith(MONTH));
  console.log(`測試月份 ${MONTH}: ${testRaces.length} 場（有賠率先計 log-loss）\n`);

  let corrN = 0, sxy = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
  let topWins = 0, topPl = 0, racesWithFig = 0;
  let bets = 0, stake = 0, ret = 0, wins = 0;
  const results = [];   // 逐場 log-loss（唔同 k）
  const KS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.5];
  let mktLL = 0, mktN = 0;
  // 折扣驗證
  let w2wNext = [], normNext = [];

  for (const race of testRaces) {
    const pre = race.horses.map(h => ({ nm: h.nm, f: figAt(byHorse, h.nm, race.d), finish: h.finish }));
    const withF = pre.filter(x => x.f && x.f.n >= 2);
    if (withF.length < 4) continue;
    racesWithFig++;

    // 相關：field-normalized 圖數 vs 名次百分位
    const figs = withF.map(x => x.f.fig);
    const lo = Math.min(...figs), hi = Math.max(...figs);
    const nAll = withF.length;
    for (const x of withF) {
      const z = hi > lo ? (x.f.fig - lo) / (hi - lo) : 0.5;
      const order = withF.slice().sort((a, b) => a.finish - b.finish).findIndex(w => w.nm === x.nm) + 1;
      const pct = order / nAll;
      corrN++; sx += z; sy += pct; sxx += z * z; syy += pct * pct; sxy += z * pct;
    }

    // 最高圖數馬
    const sorted = [...withF].sort((a, b) => b.f.fig - a.f.fig);
    const top = sorted[0];
    if (top.finish === 1) topWins++;
    if (top.finish <= 3) topPl++;
    const o = oddsOf.get(`${race.d}|${race.race_no}|${top.nm}`);
    if (o) { bets++; stake++; ret += top.finish === 1 ? o : 0; if (top.finish === 1) wins++; }

    // log-loss（市場 + softmax 各 k）
    const wi = race.horses.findIndex(h => h.finish === 1);
    const winnerNm = race.horses[wi]?.nm;
    if (winnerNm != null) {
      const inv = race.horses.map(h => {
        const o = oddsOf.get(`${race.d}|${race.race_no}|${h.nm}`);
        return o ? 1 / o : null;
      });
      const sum = inv.reduce((a, b) => a + (b || 0), 0);
      if (sum > 0.5 && sum < 3) {
        const pw = inv[wi] / sum;
        if (pw > 0) { mktLL += -Math.log(pw); mktN++; }
      }
      // softmax over withF
      for (const k of KS) {
        const ex = withF.map(x => Math.exp(k * x.f.fig));
        const s = ex.reduce((a, b) => a + b, 0);
        const p = ex[withF.findIndex(x => x.nm === winnerNm)] / s;
        (results.find(r => r.k === k) || results.push({ k, ll: 0, n: 0 }), results[results.length - 1]);
      }
      // 簡化：直接累積
      for (const r of results) {
        const ex = withF.map(x => Math.exp(r.k * x.f.fig));
        const s = ex.reduce((a, b) => a + b, 0);
        const idx = withF.findIndex(x => x.nm === winnerNm);
        r.ll += -Math.log(Math.max(1e-12, ex[idx] / s));
        r.n++;
      }
    }

    // 折扣規則：上一仗 w2w+noPressure 嘅圖數 → 今仗表現
    for (const x of withF) {
      const lastFig = x.f.last;
      if (!lastFig) continue;
      const curFig = race.horses.find(h => h.nm === x.nm)?.fig;
      if (curFig == null) continue;
      const delta = curFig - lastFig.fig;
      if (lastFig.w2w && lastFig.noPressure) w2wNext.push(delta);
      else if (!lastFig.w2w) normNext.push(delta);
    }
  }

  const cov = sxy / corrN - (sx / corrN) * (sy / corrN);
  const vx = sxx / corrN - (sx / corrN) ** 2;
  const vy = syy / corrN - (sy / corrN) ** 2;
  const r = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : NaN;
  const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

  console.log('═══ 港版速度圖回測 ═══');
  console.log(`有足夠圖數往績嘅場次: ${racesWithFig}`);
  console.log(`賽前圖數 vs 名次百分位 相關 r = ${r.toFixed(3)}（n=${corrN}；負=圖數高跑得前）`);
  console.log(`最高圖數馬: 勝出 ${topWins}/${racesWithFig}（${(100 * topWins / racesWithFig).toFixed(0)}%），三甲 ${(100 * topPl / racesWithFig).toFixed(0)}%`);
  console.log(`獨贏 P/L: ${bets} 注中 ${wins}，回報 ${ret.toFixed(1)}/本金 ${stake} → 每蚊 ${((ret - stake) / Math.max(1, stake)).toFixed(3)}`);
  console.log(`\nlog-loss（越細越好）:`);
  console.log(`  市場:            ${(mktLL / mktN).toFixed(4)}（n=${mktN}）`);
  for (const rr of results) console.log(`  圖數 k=${rr.k}:  ${(rr.ll / Math.max(1, rr.n)).toFixed(4)}`);
  console.log(`\n第 9 章折扣規則驗證（下一仗圖數 − 上一仗圖數）:`);
  console.log(`  一放到底冇壓力圖數（n=${w2wNext.length}）: 平均 ${mean(w2wNext).toFixed(2)}`);
  console.log(`  正常圖數（n=${normNext.length}）:           平均 ${mean(normNext).toFixed(2)}`);
  console.log('  （前者更負 = Beyer 講嘅「冇壓力圖數高估」成立）');

  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
