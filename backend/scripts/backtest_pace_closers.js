// ── 後追王／後勁指數回測（9 月賽績驗證）────────────────────────────────────
// 用法：docker compose run --rm backend node scripts/backtest_pace_closers.js [YYYY-MM]
// 問題：
//   1. 賽前後勁指數 top3（後追王）係咪真係嗰場末段跑得最快？（vs 隨機 25%）
//   2. 賽前 closing_index 能唔能預測實際末段排名？
//   3. 實際形勢快嘅場，係咪真係後勁馬贏多咗？
//   4. 每場買齊後追王 3 匹，計唔計得掂？
const pool = require('../src/db/pool');

const MONTH = process.argv[2] || '2026-09';
const parsePos = (rp) => String(rp || '').split(/\s+/).filter(Boolean)
  .map(t => { const n = parseInt(t, 10); return n > 0 && n < 25 ? n : null; })
  .filter(v => v != null);
const parseSplit = (s) => { const v = parseFloat(s); return isFinite(v) && v > 5 && v < 80 ? v : null; };

(async () => {
  // 1. 全部分段資料（一次過；同時用嚟砌全場末段 + 馬匹往績）
  const all = await pool.query(`
    SELECT TO_CHAR(race_date,'YYYY-MM-DD') d, race_no, racecourse, distance,
           horse_name, finish_position, running_positions,
           seg1::numeric seg1n, seg2::numeric s2, seg3::numeric s3, seg4::numeric s4,
           seg5::numeric s5, seg6::numeric s6
    FROM race_sectional_times
    WHERE seg1 IS NOT NULL AND seg1 <> ''`);
  const lastOf = (r) => r.s6 ?? r.s5 ?? r.s4 ?? r.s3 ?? r.s2 ?? r.seg1n;

  // 全場末段
  const fieldLast = new Map();   // key → [last...]
  const raceRows = new Map();    // key → [{nm, last, early, finish}]
  for (const r of all.rows) {
    const last = lastOf(r);
    const k = `${r.d}|${r.race_no}`;
    if (last == null) continue;
    if (!fieldLast.has(k)) fieldLast.set(k, []);
    fieldLast.get(k).push(+last);
    if (!raceRows.has(k)) raceRows.set(k, []);
    raceRows.get(k).push({ nm: r.horse_name, last: +last, early: parsePos(r.running_positions)[0] ?? null, finish: r.finish_position });
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  // 馬匹往績（新→舊）
  const runsOf = new Map();
  for (const r of all.rows) {
    const last = lastOf(r);
    if (last == null) continue;
    if (!runsOf.has(r.horse_name)) runsOf.set(r.horse_name, []);
    runsOf.get(r.horse_name).push(r);
  }
  // 賽前後勁指數（同 pace.js：中位數÷此馬末段，加權）
  const closingAt = (nm, before) => {
    const rows = (runsOf.get(nm) || []).filter(r => r.d < before).slice(0, 8);
    const idxs = [];
    for (const r of rows) {
      const f = fieldLast.get(`${r.d}|${r.race_no}`);
      if (!f || f.length < 5) continue;
      idxs.push(med(f) / +lastOf(r));
    }
    if (!idxs.length) return { idx: null, n: 0 };
    let s = 0, w = 0;
    idxs.forEach((v, i) => { const k = Math.pow(0.85, i); s += v * k; w += k; });
    return { idx: s / w, n: idxs.length };
  };

  // 2. 標準末段（實際形勢分級用）
  const std = await pool.query(`SELECT racecourse, distance, split_400_finish FROM course_times`);
  const stdLast = new Map();
  for (const r of std.rows) {
    const v = parseSplit(r.split_400_finish);
    if (v == null) continue;
    const k = `${r.racecourse}|${r.distance}`;
    if (!stdLast.has(k)) stdLast.set(k, []);
    stdLast.get(k).push(v);
  }

  // 3. 頭馬賠率
  const odds = await pool.query(`
    SELECT DISTINCT ON (race_date, race_no, horse_name)
      TO_CHAR(race_date,'YYYY-MM-DD') d, race_no, horse_name, win_odds::float8 o
    FROM race_records WHERE finish_position=1`);
  const oddsOf = new Map(odds.rows.map(r => [`${r.d}|${r.race_no}|${r.horse_name}`, r.o]));

  // 4. 逐場（9 月）
  const days = [...new Set(all.rows.filter(r => r.d.startsWith(MONTH)).map(r => r.d))].sort();
  let races = 0;
  let actTop1In3 = 0;        // 實際末段最快馬喺候選內
  let overlapSum = 0;        // 候選 ∩ 實際末段前三，平均重疊
  let corrN = 0, corrSxy = 0, corrSx = 0, corrSy = 0, corrSxx = 0, corrSyy = 0;
  let bets = 0, stake = 0, ret = 0, wins = 0;
  const fastRaces = { n: 0, winnerCloserTop3: 0 };
  const slowRaces = { n: 0, winnerCloserTop3: 0 };
  let winnerLastPctAll = [];

  for (const day of days) {
    const dayRaces = [...raceRows.keys()].filter(k => k.startsWith(day));
    for (const k of dayRaces) {
      const hs = raceRows.get(k);
      if (hs.length < 5) continue;
      const [d, rno] = k.split('|');
      // 賽前後追王
      const scored = hs.map(h => ({ nm: h.nm, ...closingAt(h.nm, d) }))
        .filter(x => x.idx != null && x.n >= 2);
      if (scored.length < 3) continue;
      const cands = scored.sort((a, b) => b.idx - a.idx).slice(0, 3).map(x => x.nm);
      // 實際末段排名
      const byLast = [...hs].sort((a, b) => a.last - b.last);
      const actualTop3 = byLast.slice(0, 3).map(x => x.nm);
      const actualFastest = byLast[0].nm;

      races++;
      if (cands.includes(actualFastest)) actTop1In3++;
      overlapSum += cands.filter(nm => actualTop3.includes(nm)).length;

      // 相關：賽前 idx vs 實際末段排名百分位（每匹）
      for (const h of hs) {
        const pre = scored.find(x => x.nm === h.nm);
        if (!pre) continue;
        const rank = byLast.findIndex(x => x.nm === h.nm) + 1;
        const pct = rank / hs.length;
        corrN++; corrSx += pre.idx; corrSy += pct;
        corrSxx += pre.idx * pre.idx; corrSyy += pct * pct; corrSxy += pre.idx * pct;
      }

      // 頭馬分析 + 賠率
      const winner = hs.find(h => h.finish === 1);
      if (winner) {
        const o = oddsOf.get(`${d}|${rno}|${winner.nm}`);
        bets += 3; stake += 3;
        if (cands.includes(winner.nm)) { wins++; if (o) ret += o; }
        const wRank = byLast.findIndex(x => x.nm === winner.nm) + 1;
        winnerLastPctAll.push(wRank / hs.length);
        // 實際形勢
        const sk = `${all.rows.find(r => `${r.d}|${r.race_no}` === k).racecourse}|${all.rows.find(r => `${r.d}|${r.race_no}` === k).distance}`;
        const sl = stdLast.get(sk);
        if (sl) {
          const ratio = med(hs.map(h => h.last)) / med(sl);
          const bucket = ratio > 1.015 ? fastRaces : ratio < 0.985 ? slowRaces : null;
          if (bucket) {
            bucket.n++;
            if (wRank <= 3) bucket.winnerCloserTop3++;
          }
        }
      }
    }
  }

  // 皮爾森相關
  const cov = corrSxy / corrN - (corrSx / corrN) * (corrSy / corrN);
  const vx = corrSxx / corrN - (corrSx / corrN) ** 2;
  const vy = corrSyy / corrN - (corrSy / corrN) ** 2;
  const r = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : NaN;
  winnerLastPctAll.sort((a, b) => a - b);

  console.log(`\n═══ ${MONTH} 後追王／後勁指數回測（${races} 場）═══`);
  console.log(`實際末段最快馬喺三甲後追候選內: ${actTop1In3}/${races}（${(100 * actTop1In3 / races).toFixed(0)}%；隨機 ≈25%）`);
  console.log(`候選 ∩ 實際末段前三 平均重疊: ${(overlapSum / races).toFixed(2)} 匹（隨機 ≈0.75）`);
  console.log(`賽前後勁指數 vs 實際末段排名 相關 r = ${r.toFixed(3)}（n=${corrN}；負數=指數高啲實際排前啲）`);
  console.log(`頭馬末段排名中位數: 前${Math.round(winnerLastPctAll[Math.floor(winnerLastPctAll.length / 2)] * 100)}%`);
  console.log(`\n實際形勢快嘅場: ${fastRaces.n} 場，頭馬末段前三快佔 ${(100 * fastRaces.winnerCloserTop3 / Math.max(1, fastRaces.n)).toFixed(0)}%`);
  console.log(`實際形勢慢嘅場: ${slowRaces.n} 場，頭馬末段前三快佔 ${(100 * slowRaces.winnerCloserTop3 / Math.max(1, slowRaces.n)).toFixed(0)}%`);
  console.log(`\n每場買齊後追王三甲（$1 獨贏）：${bets} 注中 ${wins}，回報 ${ret.toFixed(1)} / 本金 ${stake} → 每蚊 ${((ret - stake) / stake).toFixed(3)}`);

  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
