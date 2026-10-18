// 角球模型回測（walk-forward）：docker compose run --rm backend node scripts/backtest_corners.js [EPL]
const cornerlib = require('../src/football/cornerlib');
const league = process.argv[2] || 'EPL';
(async () => {
  const all = await cornerlib.loadLeague(league);
  if (!all || all.length < 60) { console.log('數據不足:', all ? all.length : 0); process.exit(0); }
  console.log(`\n═══ ${league} 角球模型 walk-forward 回測（${all.length} 場）═══`);
  const byMonth = new Map();
  for (const m of all) {
    const k = m.d.slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(m);
  }
  const months = [...byMonth.keys()].sort();
  const LINE = 9.5;
  let rmseS = 0, n = 0, baseS = 0;
  const cal = Array.from({ length: 5 }, () => ({ n: 0, pSum: 0, over: 0 }));
  let betN = 0, betHit = 0;
  let stateMulLatest = null, stateCntExp = null;

  for (let mi = 2; mi < months.length; mi++) {
    const train = all.filter(m => m.d < months[mi] + '-01');
    if (train.length < 40) continue;
    const fit = cornerlib.fitModel(train);
    const sm = cornerlib.fitStateMultipliers(train);
    stateMulLatest = sm.m; stateCntExp = { cnt: sm.cnt, exp: sm.exp };
    for (const m of byMonth.get(months[mi])) {
      const actual = (m.home_corners || 0) + (m.away_corners || 0);
      const p = cornerlib.predict(fit, sm.m, m.home_team, m.away_team, 3000);
      if (p.error) continue;
      rmseS += (p.expCorners - actual) ** 2; baseS += (10.5 - actual) ** 2; n++;
      const b = Math.min(4, Math.floor(p.probs[LINE] * 5));
      cal[b].n++; cal[b].pSum += p.probs[LINE];
      if (actual > LINE) cal[b].over++;
      if (p.probs[LINE] > 0.55) { betN++; if (actual > LINE) betHit++; }
      else if (p.probs[LINE] < 0.45) { betN++; if (actual < LINE) betHit++; }
    }
  }
  console.log(`測試場次: ${n}`);
  console.log(`RMSE: ${Math.sqrt(rmseS / n).toFixed(3)}（基準全估10.5: ${Math.sqrt(baseS / n).toFixed(3)}）`);
  console.log(`\n校準（大 ${LINE}）: 預測檔 | 場次 | 平均P | 實際大出率`);
  cal.forEach((c, i) => {
    if (!c.n) return;
    console.log(`  ${(i * 20)}-${(i + 1) * 20}%  ${String(c.n).padStart(4)}  ${(c.pSum / c.n).toFixed(3)}  ${(c.over / c.n).toFixed(3)}`);
  });
  console.log(`\n模擬大細（P>0.55 搵大 / P<0.45 搵細）: ${betHit}/${betN} = ${betN ? (100 * betHit / betN).toFixed(1) : 0}%`);
  if (stateCntExp) {
    console.log("\n75-90' 原始角球率（每隊每切片單位）: 落後 / 平手 / 領先");
    const c5 = stateCntExp.cnt[5], e5 = stateCntExp.exp[5];
    for (const st of ['-1', '0', '1']) {
      const rate = e5[st] > 0 ? c5[st] / e5[st] : 0;
      console.log(`  state ${st}: ${rate.toFixed(3)} 角球/切片（樣本 ${e5[st].toFixed(1)} 切片單位，共 ${c5[st]} 個角球）`);
    }
  }
  if (stateMulLatest) {
    console.log('\n最新 game state 乘數（落後/平/領先）:');
    stateMulLatest.forEach((m, i) =>
      console.log(`  ${i * 15}-${i * 15 + 15}'  ${m[-1].toFixed(2)} / ${m[0].toFixed(2)} / ${m[1].toFixed(2)}`));
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
