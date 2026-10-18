// 銳度校準：用 log-loss（proper scoring rule）選定 SIGMA_K，並同時掃描
// 模型/市場混合權重 W。比較公賠率同模型喺真實結果上嘅 log-loss。
// 執行：docker compose run --rm backend node scripts/tune_temp.js [場數]
// 環境變數 NO_MARKET=1 → 攞走市場因素，測其餘 25 個因素有無獨立訊號。
const path = require('path');
const pool = require('../src/db/pool');
const { scoreHorse, winProbabilities, r2Test } = require('../src/ai/factorlib');
const {
  loadActorStats, buildRaceFeatures,
} = require('../src/ai/features');

function logLoss(probs, winnerIdx) {
  const p = Math.max(1e-9, Math.min(1 - 1e-9, probs[winnerIdx]));
  return -Math.log(p);
}

(async () => {
  const N = parseInt(process.argv[2]) || 400;

  const { rows: meta } = await pool.query(
    `SELECT MIN(race_date)::text AS lo, MAX(race_date)::text AS hi FROM race_records WHERE win_odds IS NOT NULL`
  );
  console.log('資料範圍:', meta[0].lo, '→', meta[0].hi);

  const { rows } = await pool.query(
    `SELECT race_date, race_no, racecourse, race_class, distance, track_type,
            horse_name, finish_position, total_runners, draw, horse_weight,
            actual_weight, rating, gear, win_odds, jockey_id, trainer_id
     FROM race_records
     WHERE win_odds IS NOT NULL AND finish_position IS NOT NULL AND jockey_id IS NOT NULL
     ORDER BY race_date DESC, racecourse, race_no
     LIMIT $1`,
    [N * 16]
  );

  const byRace = new Map();
  for (const r of rows) {
    const key = `${r.race_date.toISOString().slice(0, 10)}|${r.race_no}|${r.racecourse}`;
    if (!byRace.has(key)) byRace.set(key, {
      date: r.race_date.toISOString().slice(0, 10),
      raceNo: r.race_no, racecourse: r.racecourse, race_class: r.race_class,
      distance: r.distance, track_type: r.track_type, horses: [],
    });
    byRace.get(key).horses.push(r);
  }
  const races = [...byRace.values()]
    .filter(r => r.horses.length >= 6 && r.horses.some(h => h.finish_position === 1)
              && r.horses.every(h => h.win_odds != null))
    .slice(0, N);

  console.log('可用場次:', races.length);

  const dates = races.map(r => r.date);
  const statsSince = `${Math.min(...dates.map(d => +d.slice(0, 4))) - 1}-09-01`;
  const names = [...new Set(races.flatMap(r => r.horses.map(h => h.horse_name)))];
  const [stats, drawCurves] = await Promise.all([
    loadActorStats(statsSince), computeDrawCurve2(statsSince),
  ]);
  const { loadHorseHistory, profilesBefore } = require('../src/ai/features');
  const histMap = await loadHorseHistory(names, { since: statsSince });

  // 先用 TEMP=1 產出每場總分
  const prepared = [];
  for (const race of races) {
    const profiles = profilesBefore(histMap, race.date, 12);
    const dkey = `${race.racecourse}|${race.distance}|${race.track_type}`;
    const horses = race.horses.map(h => ({ ...h, odds: Number(h.win_odds), age: null }));
    const built = buildRaceFeatures(
      { ...race, horses },
      { stats, profiles, drawCurve: drawCurves.get(dkey) || new Map(), paceMap: null }
    );
    const scored = built.map((b, i) => {
      // NO_MARKET=1 → 拿走市場因素，測試「其餘 25 個因素」是否對賠率有獨立訊號
      const feats = { ...b.features };
      if (process.env.NO_MARKET === '1') delete feats.marketRel;
      const s = scoreHorse({ ...feats, ...b.labels });
      return {
        total: s.total,
        runs: b.profile?.runs || 0,
        finish: horses[i].finish_position,
        odds: horses[i].odds,
        name: horses[i].horse_name,
      };
    });
    prepared.push({ race, scored });
  }

  const winnerOf = (scored) => scored.findIndex(s => s.finish === 1);

  // 每場預先算好市場機率（1/odds 正規化）與優勝者索引
  const evRaces = [];
  for (const { scored } of prepared) {
    const wi = winnerOf(scored);
    if (wi < 0) continue;
    const inv = scored.map(b => 1 / b.odds);
    const s = inv.reduce((a, b) => a + b, 0) || 1;
    evRaces.push({ scored, wi, mkt: inv.map(p => p / s) });
  }
  const nRaces = evRaces.length;
  console.log('參與評估場次:', nRaces, ' MARKET_MULT =', process.env.MARKET_MULT || '1');

  // ── 二維掃描：SIGMA_K（銳度）× W（模型佔比）──────────────────────────
  // p = w·p_model + (1-w)·p_market
  // w=0 純市場；w=1 純模型。若最佳 w 落喺 0 同 1 之間，先代表模型
  // 對市場有獨立訊號。winProbabilities 只係函 SIGMA_K，所以每個 K
  // 只計一次，再喺每個 w 上計 log-loss（好平）。
  const SIGMAKS = [1.0, 1.25, 1.5, 1.75, 2.0, 2.5];
  const WS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0];

  console.log('\nSIGMA_K  W     模型logloss   市場logloss   改善      模型R²    頭名命中');
  console.log('─'.repeat(78));
  const results = [];
  for (const k of SIGMAKS) {
    const pmAll = evRaces.map(r => winProbabilities(r.scored, k));
    for (const w of WS) {
      let ml = 0, mkt = 0, hits = 0;
      const winSamples = [];
      for (let i = 0; i < nRaces; i++) {
        const pm = pmAll[i], pk = evRaces[i].mkt, wi = evRaces[i].wi;
        const p = pm.map((v, j) => Math.max(1e-12, w * v + (1 - w) * pk[j]));
        const sum = p.reduce((a, b) => a + b, 0) || 1;
        const pn = p.map(v => v / sum);
        ml += logLoss(pn, wi);
        mkt += logLoss(pk, wi);
        if (pn.indexOf(Math.max(...pn)) === wi) hits++;
        winSamples.push({ runners: evRaces[i].scored.length, winnerProb: pn[wi] });
      }
      results.push({
        k, w, ml: ml / nRaces, mkt: mkt / nRaces,
        r2: r2Test(winSamples).r2, hit: hits / nRaces,
      });
    }
  }
  results.sort((a, b) => a.ml - b.ml);
  for (const r of results.slice(0, 14)) {
    console.log(
      String(r.k).padEnd(8),
      String(r.w).padEnd(6),
      r.ml.toFixed(4).padEnd(14),
      r.mkt.toFixed(4).padEnd(14),
      ((r.mkt - r.ml) >= 0 ? '+' : '') + (r.mkt - r.ml).toFixed(4).padEnd(10),
      String(r.r2).padEnd(9),
      (r.hit * 100).toFixed(1) + '%'
    );
  }

  // 純模型（w=1）各銳度嘅表現，方便睇見銳度點影響
  console.log('\n純模型 (w=1) 銳度掃描：');
  console.log('SIGMA_K   logloss   R²      頭名命中');
  console.log('─'.repeat(50));
  for (const r of results.filter(x => x.w === 1).sort((a, b) => a.k - b.k)) {
    console.log(
      String(r.k).padEnd(10),
      r.ml.toFixed(4).padEnd(10),
      String(r.r2).padEnd(8),
      (r.hit * 100).toFixed(1) + '%'
    );
  }

  const best = results[0];
  const pureModel = results.filter(x => x.w === 1).sort((a, b) => a.ml - b.ml)[0];

  // 配對顯著性檢定：最佳組合 vs 純市場，逐場 log-loss 差嘅均值 ± 標準誤。
  // 只有 mean - 2*se > 0 先可以話「模型真係贏過市場」，否則只係噪音。
  {
    const kBest = best.k, wBest = best.w;
    const diffs = evRaces.map((r, i) => {
      const pm = winProbabilities(r.scored, kBest);
      const pk = r.mkt;
      const p = pm.map((v, j) => Math.max(1e-12, wBest * v + (1 - wBest) * pk[j]));
      const sum = p.reduce((a, b) => a + b, 0) || 1;
      const pn = p.map(v => v / sum);
      return logLoss(pk, r.wi) - logLoss(pn, r.wi);   // 正數 = 組合贏市場
    });
    const n = diffs.length;
    const mean = diffs.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
    const se = sd / Math.sqrt(n);
    console.log('\n【配對檢定】組合 vs 純市場');
    console.log('  mean =', mean.toFixed(5), ' se =', se.toFixed(5),
      ' z =', (mean / se).toFixed(2));
    console.log(mean - 2 * se > 0
      ? '  → 顯著（p<0.05）：模型組合統計上真係贏過市場。'
      : '  → 未達顯著：改善只係噪音，唔應該聲稱跑贏市場。');
  }
  console.log('\n【最佳組合】SIGMA_K =', best.k, ' W =', best.w,
    '\n模型 log-loss', best.ml.toFixed(4), ' vs 純市場', best.mkt.toFixed(4),
    '（差', (best.mkt - best.ml).toFixed(4), '）');
  console.log(best.w > 0 && best.ml < best.mkt - 1e-6
    ? '→ 模型對市場有獨立訊號，可考慮混合。'
    : '→ 模型未有超越市場：機率以市場為準，模型用嚟做因子拆解同排名。');
  console.log('純模型最啱銳度 SIGMA_K =', pureModel.k,
    '(log-loss', pureModel.ml.toFixed(4), ', R²', pureModel.r2, ')');
  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

async function computeDrawCurve2(since) {
  const { buildDrawCurve } = require('../src/ai/features');
  const { adjRatio: ar } = require('../src/ai/factorlib');
  const { rows } = await pool.query(
    `SELECT draw, finish_position, racecourse, distance, track_type
     FROM race_records
     WHERE draw > 0 AND finish_position IS NOT NULL AND race_date >= $1`,
    [since]
  );
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.racecourse}|${r.distance}|${r.track_type}`;
    if (!groups.has(key)) groups.set(key, new Map());
    const m = groups.get(key);
    if (!m.has(r.draw)) m.set(r.draw, { w: 0, s: 0, t: 0, runs: 0 });
    const b = m.get(r.draw);
    b.runs++;
    if (r.finish_position === 1) b.w++;
    else if (r.finish_position === 2) b.s++;
    else if (r.finish_position === 3) b.t++;
  }
  const out = new Map();
  for (const [key, m] of groups) {
    if (m.size < 4) continue;
    const series = [...m.entries()].sort((a, b) => a[0] - b[0])
      .map(([draw, b]) => ({ draw, adj: ar(b.w, b.s, b.t, b.runs) }));
    if (series.length < 4) continue;
    out.set(key, buildDrawCurve(series));
  }
  return out;
}
