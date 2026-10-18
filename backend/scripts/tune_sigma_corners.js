// 掃描 SIGMA_LAMBDA — 揾最佳過度離散參數（校準 + log-loss）
// 用法：docker compose run --rm backend node scripts/tune_sigma_corners.js
const pool = require('../src/db/pool');
const cornerlib = require('../src/football/cornerlib');
const { loadLeague, fitModel, fitStateMultipliers, predict } = cornerlib;

(async () => {
  const all = await loadLeague('EPL');
  if (!all || all.length < 60) { console.log('數據不足'); process.exit(0); }

  // Walk-forward：按月 split
  const byMonth = new Map();
  for (const m of all) {
    const k = m.d.slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(m);
  }
  const months = [...byMonth.keys()].sort();
  const testMatches = [];
  const fits = [];   // 每月一個 { fit, sm, matches }

  for (let mi = 2; mi < months.length; mi++) {
    const train = all.filter(m => m.d < months[mi] + '-01');
    if (train.length < 40) continue;
    const fit = fitModel(train);
    const sm = fitStateMultipliers(train).m;
    fits.push({ fit, sm, month: months[mi], matches: byMonth.get(months[mi]) });
  }
  console.log(`測試月份: ${fits.length}，測試場次: ${fits.reduce((s, f) => s + f.matches.length, 0)}`);

  // 獲取 Crown 線嘅實際盤口（用終盤線做測試）
  const odds = (await pool.query(`
    SELECT o.*, TO_CHAR(o.match_date,'YYYY-MM-DD') md, (m.home_corners + m.away_corners) actual
    FROM corner_odds o
    JOIN football_matches m ON m.id = o.match_id
    WHERE o.league='EPL' AND o.over_close IS NOT NULL AND m.home_corners IS NOT NULL`)).rows;

  console.log(`有盤口嘅場次: ${odds.length}`);

  const SIGMAS = [0.00, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50];

  console.log('\nσ      log-loss   P(大)@5%命中率   P(大)@5%ROI   校準(60-80%檔實際)   投注@5%');
  console.log('─'.repeat(90));

  for (const sigma of SIGMAS) {
    // 覆蓋 SIGMA_LAMBDA
    const origModule = require.cache[require.resolve('../src/football/cornerlib')];
    origModule.exports.SIGMA_LAMBDA = sigma;

    let llSum = 0, llN = 0;
    let hit5 = 0, n5 = 0, pl5 = 0;
    let calHi = { n: 0, over: 0 };
    let calLo = { n: 0, over: 0 };

    for (const f of fits) {
      for (const m of f.matches) {
        const actual = (m.home_corners || 0) + (m.away_corners || 0);
        if (actual == null) continue;
        // 揾對應盤口（有終盤嘅）
        const o = odds.find(x => x.md === m.d && x.home_team === m.home_team && x.actual != null);
        const line = o ? +o.line : 9.5;
        const overOdds = o ? +o.over_close : 1.90;
        const underOdds = o ? +o.under_close : 1.90;

        const p = predict(f.fit, f.sm, m.home_team, m.away_team, 2000);
        if (p.error) continue;

        // P(大 line) 由 dist 計
        let over = 0, total = 0;
        for (let t = 0; t < p.dist.length; t++) { total += p.dist[t]; if (t > line) over += p.dist[t]; }
        const pOver = total > 0 ? over / total : 0.5;
        if (pOver <= 0 || pOver >= 1) continue;

        // Log-loss（用實際盤口線）
        const pActual = actual > line ? pOver : 1 - pOver;
        llSum += -Math.log(Math.max(1e-10, pActual));
        llN++;

        // 校準
        if (pOver > 0.6 && pOver <= 0.8) { calHi.n++; if (actual > line) calHi.over++; }
        if (pOver > 0.2 && pOver <= 0.4) { calLo.n++; if (actual > line) calLo.over++; }

        // 模擬落注 edge ≥ 5%
        const eOver = pOver * overOdds - 1;
        const eUnder = (1 - pOver) * underOdds - 1;
        const edge = Math.max(eOver, eUnder);
        if (edge >= 0.05) {
          n5++;
          const side = eOver >= eUnder ? 'over' : 'under';
          const won = side === 'over' ? actual > line : actual < line;
          if (won) { hit5++; pl5 += (side === 'over' ? overOdds : underOdds) - 1; }
          else pl5 -= 1;
        }
      }
    }

    const ll = llN ? (llSum / llN).toFixed(4) : '-';
    const hitRate = n5 ? (100 * hit5 / n5).toFixed(1) + '%' : '-';
    const roi = n5 ? ((100 * pl5 / n5) > 0 ? '+' : '') + (100 * pl5 / n5).toFixed(1) + '%' : '-';
    const calHiRate = calHi.n ? (100 * calHi.over / calHi.n).toFixed(1) + '%' : '-';
    console.log(
      String(sigma).padEnd(7),
      ll.padEnd(11),
      hitRate.padEnd(15),
      roi.padEnd(14),
      calHiRate.padEnd(22),
      String(n5)
    );
  }

  // 還原
  origModule.exports.SIGMA_LAMBDA = 0.20;
  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
