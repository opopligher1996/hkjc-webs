// 香港馬會入球大細 P/L 分析（walk-forward + 市場融合）
const pool = require('../src/db/pool');
const cornerlib = require('../src/football/cornerlib');

(async () => {
  for (const league of ['EPL', 'LAL', 'BUN']) {
    const all = await cornerlib.loadLeague(league);
    if (!all) continue;
    const odds = (await pool.query(
      `SELECT g.*, TO_CHAR(g.match_date,'YYYY-MM-DD') md,
              m.home_goals + m.away_goals AS actual_goals
       FROM goal_odds g
       JOIN football_matches m ON m.id = g.match_id
       WHERE g.league = $1 AND g.over_close IS NOT NULL AND m.home_goals IS NOT NULL`,
      [league])).rows;
    console.log(`\n═══ ${league}（${odds.length} 場 HKJC 入球盤）═══`);
    if (!odds.length) continue;

    // Walk-forward
    const byMonth = new Map();
    for (const m of all) { const k = m.d.slice(0,7); if (!byMonth.has(k)) byMonth.set(k,[]); byMonth.get(k).push(m); }
    const months = [...byMonth.keys()].sort();
    const fits = [];
    for (let mi = 2; mi < months.length; mi++) {
      const train = all.filter(m => m.d < months[mi] + '-01');
      if (train.length < 40) continue;
      fits.push({ fit: cornerlib.fitModel(train), month: months[mi], matches: byMonth.get(months[mi]) });
    }

    // 分析（純模型 + 市場融合 w=0.15）
    let n = 0, modelLL = 0, mktLL = 0;
    let betN5 = 0, betHit5 = 0, pl5 = 0;
    let calBuckets = Array.from({length: 5}, () => ({n:0, over:0, pSum:0}));
    let p70list = [];

    for (const f of fits) {
      for (const m of f.matches) {
        const o = odds.find(x => x.md === m.d && x.home_team === m.home_team && x.actual_goals != null);
        if (!o) continue;
        const actual = +o.actual_goals;
        // 解析盤口線（例 "2.5" 或 "3/3.5"）
        const lineStr = String(o.line).trim();
        const line = parseFloat(lineStr.split('/')[0]);
        if (!line || isNaN(line)) continue;
        const overOdds = +o.over_close, underOdds = +o.under_close;
        if (!(overOdds > 1) || !(underOdds > 1)) continue;

        const p = cornerlib.predictGoals(f.fit, m.home_team, m.away_team, {}, 3000);
        if (p.error) continue;
        const pOver = p.probs[String(line)];
        if (pOver == null) continue;

        n++;
        const actualOver = actual > line;
        modelLL += -Math.log(Math.max(1e-10, actualOver ? pOver : 1 - pOver));
        // 市場隱含
        const invO = 1/overOdds, invU = 1/underOdds;
        const pMkt = invO / (invO + invU);
        mktLL += -Math.log(Math.max(1e-10, actualOver ? pMkt : 1 - pMkt));

        // 校準（模型概率）
        const pct = Math.floor(pOver * 100 / 20) * 20;
        if (calBuckets[pct/20]) { calBuckets[pct/20].n++; calBuckets[pct/20].pSum += pOver; if (actualOver) calBuckets[pct/20].over++; }

        // 市場融合
        const pBlend = 0.15 * pOver + 0.85 * pMkt;
        const eOver = pBlend * overOdds - 1;
        const eUnder = (1 - pBlend) * underOdds - 1;
        const edge = Math.max(eOver, eUnder);
        if (edge >= 0.05) {
          betN5++;
          const side = eOver >= eUnder ? 'over' : 'under';
          const won = side === 'over' ? actualOver : !actualOver;
          if (won) { betHit5++; pl5 += (side === 'over' ? overOdds : underOdds) - 1; }
          else pl5 -= 1;
        }

        if (pOver >= 0.70) p70list.push({ d: m.d, h: m.home_team, a: m.away_team, line, p: +pOver.toFixed(3), actual, over: actualOver });
      }
    }

    console.log(`有效預測: ${n}`);
    if (!n) continue;
    console.log(`模型 log-loss: ${(modelLL/n).toFixed(4)} | 市場: ${(mktLL/n).toFixed(4)} | 差: ${((modelLL-mktLL)/n).toFixed(4)}`);
    console.log(`模擬落注（edge≥5%）: ${betN5} 注 | 命中率: ${betN5 ? (100*betHit5/betN5).toFixed(1) : '-'}% | ROI: ${betN5 ? ((100*pl5/betN5)>0?'+':'')+(100*pl5/betN5).toFixed(1) : '-'}%`);

    console.log('\n校準（P(大終盤) vs 實際開大率）:');
    for (const b of calBuckets) {
      if (b.n < 5) continue;
      console.log(`  ${((b.pSum/b.n)*100).toFixed(0)}% → 實際 ${(100*b.over/b.n).toFixed(1)}% (${b.n})`);
    }

    if (p70list.length) {
      const overs = p70list.filter(x=>x.over).length;
      console.log(`\nP(大) ≥ 70%: ${p70list.length} 場 → 開大 ${overs}/${p70list.length} = ${(100*overs/p70list.length).toFixed(1)}%`);
    }
  }
  await pool.end(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
