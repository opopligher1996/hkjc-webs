// 掃描 BLEND_W — 揾最佳市場融合權重（log-loss + P/L）
// 用法：docker compose run --rm backend node scripts/tune_blend_corners.js
const pool = require('../src/db/pool');
const cornerlib = require('../src/football/cornerlib');
const { loadLeague, fitModel, fitStateMultipliers, predict, blendWithMarket } = cornerlib;

(async () => {
  const all = await loadLeague('EPL');
  if (!all) { console.log('數據不足'); process.exit(0); }

  const byMonth = new Map();
  for (const m of all) {
    const k = m.d.slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(m);
  }
  const months = [...byMonth.keys()].sort();
  const fits = [];
  for (let mi = 2; mi < months.length; mi++) {
    const train = all.filter(m => m.d < months[mi] + '-01');
    if (train.length < 40) continue;
    const fit = fitModel(train);
    const sm = fitStateMultipliers(train).m;
    fits.push({ fit, sm, month: months[mi], matches: byMonth.get(months[mi]) });
  }

  const odds = (await pool.query(`
    SELECT o.*, TO_CHAR(o.match_date,'YYYY-MM-DD') md, (m.home_corners + m.away_corners) actual
    FROM corner_odds o
    JOIN football_matches m ON m.id = o.match_id
    WHERE o.league='EPL' AND o.over_close IS NOT NULL AND m.home_corners IS NOT NULL`)).rows;
  console.log(`有盤口嘅場次: ${odds.length}`);

  const WS = [0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.7, 1.0];   // w=0 純市場, w=1 純模型
  const THRESHOLDS = [0.03, 0.05, 0.08];

  console.log('\nw      log-loss   | edge≥3%: n    hit%   ROI   | edge≥5%: n    hit%   ROI   | edge≥8%: n    hit%   ROI');
  console.log('─'.repeat(105));

  // 先計好所有場嘅 pModel（模型唔變，只係 blend 權重變）
  const predictions = [];
  for (const f of fits) {
    for (const m of f.matches) {
      const o = odds.find(x => x.md === m.d && x.home_team === m.home_team);
      if (!o || o.actual == null) continue;
      const line = +o.line;
      const overOdds = +o.over_close, underOdds = +o.under_close;
      if (!(overOdds > 1) || !(underOdds > 1)) continue;
      const p = predict(f.fit, f.sm, m.home_team, m.away_team, 3000);
      if (p.error) continue;
      let over = 0, total = 0;
      for (let t = 0; t < p.dist.length; t++) { total += p.dist[t]; if (t > line) over += p.dist[t]; }
      const pModel = total > 0 ? over / total : 0.5;
      if (pModel <= 0 || pModel >= 1) continue;
      const actualOver = o.actual > line;
      predictions.push({ pModel, overOdds, underOdds, actualOver });
    }
  }
  console.log(`有效預測: ${predictions.length}`);

  for (const w of WS) {
    let ll = 0, n = 0;
    const results = THRESHOLDS.map(() => ({ n: 0, hit: 0, pl: 0 }));

    for (const pred of predictions) {
      const pOver = blendWithMarket(pred.pModel, pred.overOdds, pred.underOdds, w);
      if (pOver <= 0 || pOver >= 1) continue;

      // Log-loss
      ll += -Math.log(Math.max(1e-10, pred.actualOver ? pOver : 1 - pOver));
      n++;

      // P/L 各門檻
      const eOver = pOver * pred.overOdds - 1;
      const eUnder = (1 - pOver) * pred.underOdds - 1;
      const edge = Math.max(eOver, eUnder);
      const side = eOver >= eUnder ? 'over' : 'under';
      const odds = side === 'over' ? pred.overOdds : pred.underOdds;
      const won = side === 'over' ? pred.actualOver : !pred.actualOver;

      THRESHOLDS.forEach((th, ti) => {
        if (edge >= th) {
          results[ti].n++;
          if (won) { results[ti].hit++; results[ti].pl += odds - 1; }
          else results[ti].pl -= 1;
        }
      });
    }

    const parts = results.map(r => {
      const hitPct = r.n ? (100 * r.hit / r.n).toFixed(1) : '-';
      const roi = r.n ? ((100 * r.pl / r.n) > 0 ? '+' : '') + (100 * r.pl / r.n).toFixed(1) : '-';
      return `${String(r.n).padStart(4)}  ${hitPct.padStart(5)}%  ${roi.padStart(6)}%`;
    });

    console.log(
      String(w).padEnd(7),
      (ll / Math.max(1, n)).toFixed(4).padEnd(10),
      '|', parts[0], ' |', parts[1], ' |', parts[2]
    );
  }

  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
