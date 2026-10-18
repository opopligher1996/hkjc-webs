const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

const {
  FACTORS, FACTOR_MAP, FACTOR_GROUPS, FACTOR_TO_FEATURE, scoreHorse,
  winProbabilities, placeProbabilities,
  fairOdds, evValue, r2Test, clamp, adjRatio, SIGMA_K,
  blendWithMarket, MODEL_BLEND_W,
} = require('../ai/factorlib');
const {
  loadActorStats, loadHorseProfiles, loadHorseHistory, profilesBefore,
  buildRaceFeatures, buildDrawCurve,
  scoreOf, classRank, dstr, diffDays, num,
} = require('../ai/features');
const { trainWeights, applyWeights, validateR2 } = require('../ai/backtest');
const { getFigureHistory } = require('../ai/speedfig');

const dstrFn = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
const numOrNull = (v) => (v == null || v === '' ? null : Number(v));
const seasonStartFor = (dateStr) => {
  const d = new Date(dateStr);
  const y = d.getUTCMonth() >= 8 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-09-01`;
};

// 因素剔選：'a,b,c' → Set。只認 FACTORS 入面嘅 key；
// 空字串 / 全部無效 / 全選（26 個）→ null（即全部啟用，同舊行為）
function parseFactorSelection(str) {
  if (typeof str !== 'string' || !str.trim()) return null;
  const keys = [...new Set(str.split(',').map(s => s.trim()).filter(k => FACTOR_MAP[k]))];
  if (!keys.length || keys.length >= FACTORS.length) return null;
  return new Set(keys);
}

// ── 檔位曲線：從歷史 race_records 計算（加權平均線平滑）──────────────────
async function computeDrawCurve(since) {
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
      .map(([draw, b]) => ({ draw, adj: adjRatio(b.w, b.s, b.t, b.runs) }));
    if (series.length < 4) continue;
    out.set(key, buildDrawCurve(series));
  }
  return out;
}

// 段速/步速特徵：馬匹在同馬場+同路程+同場地的平均完成名次（相對化到 [-1,1]）
// 注意：race_sectional_times 只有 56 場，樣本極少，所以此因素權重刻意最低，
//       並在 features.js 以 null 標示「數據不足」而非亂填。
// ── 走位紀錄（race_sectional_times.running_positions）──────────────────────
// 回傳 Map<horse_name, [{ d, rp }]>（新→舊），供 buildRaceFeatures 推算走位偏好。
// features.js 會按每場 race date 過濾（杜絕前視偏差）。
async function loadPaceRows(names) {
  if (!names || !names.length) return { paceRows: new Map(), fieldLast: new Map() };
  const { rows } = await pool.query(
    `SELECT horse_name, TO_CHAR(race_date,'YYYY-MM-DD') AS d, race_no AS rno,
            running_positions AS rp,
            seg1::numeric AS s1, seg2::numeric AS s2, seg3::numeric AS s3,
            seg4::numeric AS s4, seg5::numeric AS s5, seg6::numeric AS s6
     FROM race_sectional_times
     WHERE horse_name = ANY($1) AND running_positions IS NOT NULL AND running_positions <> ''
     ORDER BY race_date DESC`,
    [names]
  );
  const paceRows = new Map();
  const lastOf = (r) => r.s6 ?? r.s5 ?? r.s4 ?? r.s3 ?? r.s2 ?? r.s1;
  const runKeys = new Set();
  for (const r of rows) {
    if (!paceRows.has(r.horse_name)) paceRows.set(r.horse_name, []);
    paceRows.get(r.horse_name).push({ d: r.d, rno: r.rno, rp: r.rp, last: lastOf(r) != null ? +lastOf(r) : null });
    runKeys.add(`${r.d}|${r.rno}`);
  }
  // 呢啲賽事嘅「全部馬」末段（後勁指數分母 — 用唔齊全場會令樣本得 0-1 仗）
  const fieldLast = new Map();
  if (runKeys.size) {
    const ds = [...new Set([...runKeys].map(k => k.split('|')[0]))];
    const nos = [...new Set([...runKeys].map(k => Number(k.split('|')[1])))];
    const fRes = await pool.query(
      `SELECT TO_CHAR(race_date,'YYYY-MM-DD') AS d, race_no,
              seg1::numeric AS s1, seg2::numeric AS s2, seg3::numeric AS s3,
              seg4::numeric AS s4, seg5::numeric AS s5, seg6::numeric AS s6
       FROM race_sectional_times
       WHERE race_date::text = ANY($1) AND race_no = ANY($2)`,
      [ds, nos]
    );
    for (const r of fRes.rows) {
      const last = r.s6 ?? r.s5 ?? r.s4 ?? r.s3 ?? r.s2 ?? r.s1;
      if (last == null) continue;
      const k = `${r.d}|${r.race_no}`;
      if (!fieldLast.has(k)) fieldLast.set(k, []);
      fieldLast.get(k).push(+last);
    }
  }
  return { paceRows, fieldLast };
}

// ── GET /api/ai/factors ─────────────────────────────────────────────────────
// 因素庫定義（供前端顯示 + 權重調校 UI）
router.get('/factors', async (req, res) => {
  try {
    res.json({
      groups: FACTOR_GROUPS,
      factors: FACTORS.map(f => ({
        key: f.key, label: f.label, group: f.group,
        maxLength: f.maxLength, bookRef: f.bookRef, desc: f.desc,
      })),
      benchmark: {
        marketR2: 0.151726,
        marketR2Recent: 0.167331,
        threshold: 0.17,
        note: '《計得精彩》第5章 p190-192：要 R² > 0.17 才有長期盈利。公賠率基準 0.152 (1996-2001) / 0.167 (2003-04)。',
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/ai/analyze?date=YYYY-MM-DD&race_no=N&factors=a,b,c ──────────────
// factors：剔選後要啟用嘅因素 key（逗號分隔）。缺省 = 全部啟用。
// 只認 FACTORS 入面嘅 key；空 / 全部無效 / 全選 → 視為全部啟用。
router.get('/analyze', async (req, res) => {
  try {
    let { date, race_no } = req.query;

    // 因素剔選
    const enabledSet = parseFactorSelection(req.query.factors);

    if (!date) {
      const today = new Date().toISOString().split('T')[0];
      const next = await pool.query(
        `SELECT TO_CHAR(race_date,'YYYY-MM-DD') AS race_date FROM fixtures
         WHERE race_date >= $1 ORDER BY race_date ASC LIMIT 1`,
        [today]
      );
      date = next.rows.length ? next.rows[0].race_date : today;
    }

    // 1. 賽事資料
    const params = [date];
    let raceFilter = '';
    if (race_no) { params.push(parseInt(race_no)); raceFilter = `AND rc.race_no = $${params.length}`; }
    const rcRes = await pool.query(
      `SELECT rc.*, h.age AS horse_age, h.sex AS horse_sex,
              h.sire, h.dam, h.origin,
              en.horse_note, hrh.odds
       FROM racecard rc
       LEFT JOIN horses h ON h.id = rc.horse_id
       LEFT JOIN LATERAL (
         SELECT horse_note FROM entries e
         WHERE e.meeting_date = rc.race_date
           AND e.race_no = rc.race_no
           AND e.horse_name = rc.horse_name
         LIMIT 1
       ) en ON TRUE
       LEFT JOIN LATERAL (
         SELECT rr.win_odds AS odds FROM race_records rr
         WHERE rr.race_date = rc.race_date
           AND rr.horse_name = rc.horse_name
           AND rr.win_odds IS NOT NULL
         ORDER BY rr.win_odds LIMIT 1
       ) hrh ON TRUE
       WHERE rc.race_date = $1 ${raceFilter}
       ORDER BY rc.race_no, rc.horse_no`,
      params
    );
    const rows = rcRes.rows;
    if (!rows.length) {
      return res.json({ date, races: [], message: '該日期沒有排位表資料' });
    }

    const sstart = seasonStartFor(date);
    const statsSince = `${new Date(date).getUTCFullYear() - 3}-09-01`;

    // 2. 共享統計
    const [stats, drawCurves, names] = await Promise.all([
      loadActorStats(statsSince),
      computeDrawCurve(statsSince),
      Promise.resolve([...new Set(rows.map(r => r.horse_name).filter(Boolean))]),
    ]);
    const [profiles, paceData] = await Promise.all([
      loadHorseProfiles(names, date),
      loadPaceRows(names),
    ]);
    const { paceRows, fieldLast } = paceData;
    const figureRows = await getFigureHistory(names, date); // 港版速度圖（Beyer）

    // 3. 逐場構建
    const raceMap = new Map();
    for (const r of rows) {
      const key = r.race_no;
      if (!raceMap.has(key)) raceMap.set(key, {
        race_no: r.race_no, racecourse: r.racecourse, race_class: r.race_class,
        distance: r.distance, track_type: r.track_type, going: r.going,
        horses: [],
      });
      raceMap.get(key).horses.push(r);
    }

    const racesOut = [];
    for (const race of raceMap.values()) {
      const horses = race.horses.map(h => ({
        ...h,
        age: h.horse_age,
        odds: h.odds ? Number(h.odds) : null,
      }));
      const dkey = `${race.racecourse}|${race.distance}|${race.track_type}`;
      const built = buildRaceFeatures(
        { ...race, date, horses },
        { stats, profiles, date, drawCurve: drawCurves.get(dkey) || new Map(), paceRows, fieldLast, figureRows }
      );

      const scored = built.map((b, i) => {
        const h = horses[i];
        const s = scoreHorse({ ...b.features, ...b.labels }, { enabled: enabledSet });
        return {
          horse_no: h.horse_no, horse_name: h.horse_name, horse_id: h.horse_id,
          draw: h.draw, jockey_name: h.jockey_name, jockey_id: h.jockey_id,
          trainer_name: h.trainer_name, trainer_id: h.trainer_id,
          actual_weight: numOrNull(h.actual_weight),
          rating: h.rating,
          declared_weight: h.declared_weight,
          gear: h.gear, recent_form: h.recent_form, rating_change: h.rating_change,
          age: h.age, sex: h.horse_sex, sire: h.sire, dam: h.dam, origin: h.origin,
          odds: h.odds, horse_note: h.horse_note,
          total: s.total,
          sigma: b.profile?.sigma || 5,
          parts: s.parts,
          runs: b.profile?.runs || 0,
        };
      });

      const winProbs = blendWithMarket(
        winProbabilities(scored), scored.map(s => s.odds)
      );
      const placeProbs = placeProbabilities(scored, 3);

      // 模型排名（1 = 最高機會率），供 valueGrade 作防長冷門護欄
      const modelRank = new Array(scored.length).fill(0);
      winProbs
        .map((p, i) => ({ p, i }))
        .sort((a, b) => b.p - a.p)
        .forEach((x, pos) => { modelRank[x.i] = pos + 1; });

      const enriched = scored.map((s, i) => {
        const p = winProbs[i];
        const fair = fairOdds(p);
        const marketP = s.odds ? 0.82 / s.odds : null;
        return {
          ...s,
          win_prob: p,
          place3_prob: placeProbs[i],
          fair_odds: fair ? +fair.toFixed(2) : null,
          market_prob: marketP ? +marketP.toFixed(4) : null,
          edge: marketP ? +(p - marketP).toFixed(4) : null,
          ev: s.odds ? +evValue(p, s.odds).toFixed(4) : null,
          model_rank: modelRank[i],
          value_grade: valueGrade(p, s.odds, marketP, modelRank[i]),
        };
      }).sort((a, b) => b.win_prob - a.win_prob);

      racesOut.push({
        race_no: race.race_no, racecourse: race.racecourse,
        race_class: race.race_class, distance: race.distance,
        track_type: race.track_type, going: race.going,
        runners: horses.length,
        hasOdds: horses.some(h => h.odds),
        drawCurveSize: (drawCurves.get(dkey) || new Map()).size,
        horses: enriched,
      });
    }

    racesOut.sort((a, b) => a.race_no - b.race_no);
    res.json({
      date, sstart,
      races: racesOut,
      // 因素剔選回显：null = 全部 26 個啟用
      factorSelection: enabledSet ? {
        enabled: [...enabledSet],
        disabled: FACTORS.map(f => f.key).filter(k => !enabledSet.has(k)),
      } : null,
      calibration: {
        sigmaK: SIGMA_K,
        blendW: MODEL_BLEND_W,
        fitted_by: 'scripts/tune_temp.js（350 場配對 log-loss 擬合）',
        // 後測結論要誠實顯示，唔可以扮模型好過市場
        backtest: {
          modelOnly: { logLoss: 2.0110, r2: 0.4505, topHit: 0.303 },
          marketOnly: { logLoss: 1.9937, r2: 0.4656, topHit: 0.300 },
          blended: { logLoss: 1.9892, w: 0.3 },
          significance: '配對檢定 z≈0.96（mean 0.0045，se 0.0047）→ 未達顯著',
        },
        verdict: '後測（350 場、市場因素倍率 12、SIGMA_K 1.25）：模型 R² 0.450、'
          + '頭名命中 30.3%，明顯優於隨機；但純市場 log-loss 1.9937 仍低於模型 2.0110。'
          + '混合 w=0.3 得 1.9892，配對檢定未達顯著（z≈0.96），即係未有統計證據話模型跑贏市場。'
          + '所以機率係「模型 + 市場」融合，價值評級已加長冷門防護；'
          + '建議以「因子拆解」及「排名參考」為主要用途。',
        marketBenchmark: { r2_bookScale: 0.151726, r2_recentBook: 0.167331, threshold: 0.17 },
      },
    });
  } catch (err) {
    console.error('[ai/analyze]', err);
    res.status(500).json({ error: err.message });
  }
});

// 價值評級
// 後測（scripts/tune_temp.js，350 場）結論：模型 log-loss 未顯著優於公賠率
// （配對檢定 z≈0.96，見 /api/ai/r2 同首頁後測結論）。所以評級以 edge
// （模型機率 − 市場機率）為主，唔用絕對 EV —— 絕對 EV 充斥 18% 莊水，
// 馬馬都會係負數，冇資訊量。另加三重防護避免長冷門偏誤 (longshot bias)：
//   1. marketP 下限 — 排除超長冷門
//   2. modelRank 上限 — 模型自己都要排得前
//   3. edge 下限 — 分歧要夠大先有價值
function valueGrade(p, odds, marketP, modelRank) {
  if (!odds || !marketP) return null;
  const ev = p * (odds - 1) - (1 - p);
  const edge = p - marketP;
  if (edge > 0.06 && marketP >= 0.06 && modelRank <= 5) {
    return { label: 'A級', color: '#d4af37', ev, edge };
  }
  if (edge > 0.04 && marketP >= 0.06 && modelRank <= 7) {
    return { label: 'B級', color: '#28a745', ev, edge };
  }
  if (edge > 0.025 && marketP >= 0.05 && modelRank <= 9) {
    return { label: 'C級', color: '#007bff', ev, edge };
  }
  if (edge < -0.06) return { label: '不值', color: '#999', ev, edge };
  if (ev > 0 && (marketP < 0.06 || modelRank > 9)) {
    return { label: '冷門疑慮', color: '#b58900', ev, edge };
  }
  return { label: '中性', color: '#666', ev, edge };
}


// ── GET /api/ai/r2?train_from=&train_to=&test_from=&test_to=&factors=a,b,c ──
// R² 驗證：嚴格分離訓練/測試集（作者 p192 告誡：不可同一組數據同時做
// parameter estimate 和 R² test）。factors 同 /analyze 一樣做因素剔選。
router.get('/r2', async (req, res) => {
  try {
    // 因素剔選 → logistic 訓練用嘅特徵 key
    const enabledSet = parseFactorSelection(req.query.factors);
    const trainKeys = enabledSet
      ? [...enabledSet].map(k => FACTOR_TO_FEATURE[k]).filter(Boolean)
      : null;
    // 0. 由資料推斷預設日期範圍：測試集 = 最近 4 個月，訓練集 = 之前全部
    const rangeRes = await pool.query(
      `SELECT TO_CHAR(MIN(race_date),'YYYY-MM-DD') AS min_d,
              TO_CHAR(MAX(race_date),'YYYY-MM-DD') AS max_d,
              COUNT(DISTINCT (race_date, race_no, racecourse)) AS n
       FROM race_records
       WHERE finish_position IS NOT NULL AND jockey_id IS NOT NULL`
    );
    const range = rangeRes.rows[0] || {};
    if (!range.min_d || !range.n) {
      return res.json({ error: 'race_records 沒有足夠的完成賽果資料' });
    }
    const maxDate = range.max_d;
    const testTo = req.query.test_to || maxDate;
    const testFrom = req.query.test_from || minusMonths(testTo, 4);
    const trainTo = req.query.train_to || minusDays(testFrom, 1);
    const trainFrom = req.query.train_from || range.min_d;
    const limit = parseInt(req.query.limit) || 500;

    // 1. 載入訓練 + 測試場次
    const loadRaces = async (from, to, max) => {
      const { rows } = await pool.query(
        `SELECT race_date, race_no, racecourse, race_class, distance, track_type,
                horse_name, finish_position, total_runners,
                draw, horse_weight, actual_weight, rating, gear, win_odds,
                jockey_id, trainer_id, running_positions
         FROM race_records
         WHERE race_date BETWEEN $1 AND $2 AND finish_position IS NOT NULL
           AND jockey_id IS NOT NULL
         ORDER BY race_date, race_no
         LIMIT $3`,
        [from, to, max * 16]
      );
      const byRace = new Map();
      for (const r of rows) {
        const key = `${dstrFn(r.race_date)}|${r.race_no}|${r.racecourse}`;
        if (!byRace.has(key)) {
          byRace.set(key, {
            date: dstrFn(r.race_date), raceNo: r.race_no, racecourse: r.racecourse,
            race_class: r.race_class, distance: r.distance, track_type: r.track_type,
            horses: [],
          });
        }
        byRace.get(key).horses.push(r);
      }
      return [...byRace.values()]
        .filter(r => r.horses.length >= 6 && r.horses.some(h => h.finish_position === 1))
        .slice(0, max);
    };

    const [trainRacesRaw, testRacesRaw] = await Promise.all([
      loadRaces(trainFrom, trainTo, 600),
      loadRaces(testFrom, testTo, limit),
    ]);

    if (!trainRacesRaw.length || !testRacesRaw.length) {
      return res.json({
        error: '訓練或測試集場次不足',
        trainRaces: trainRacesRaw.length, testRaces: testRacesRaw.length,
        dataRange: { min: range.min_d, max: range.max_d },
        ranges: { trainFrom, trainTo, testFrom, testTo },
      });
    }

    // 2. 為兩組比賽構建特徵
    //    往績一次過載入，之後每場用 profilesBefore() 取「該場之前」的紀錄，
    //    避免 N+1 query，同時嚴格排除前視偏差。
    const buildAll = async (races) => {
      const names = [...new Set(races.flatMap(r => r.horses.map(h => h.horse_name)))];
      const statsSince = `${+races[0].date.slice(0, 4) - 3}-09-01`;
      const [stats, drawCurves, histMap, paceDataAll, figureRowsAll] = await Promise.all([
        loadActorStats(statsSince),
        computeDrawCurve(statsSince),
        loadHorseHistory(names, { since: statsSince }),
        loadPaceRows(names),
        getFigureHistory(names, races[races.length - 1].date),
      ]);
      const out = [];
      const sorted = [...races].sort((a, b) =>
        (a.date + String(a.raceNo).padStart(2, '0')).localeCompare(b.date + String(b.raceNo).padStart(2, '0')));
      for (const race of sorted) {
        const profiles = profilesBefore(histMap, race.date, 12);
        const dkey = `${race.racecourse}|${race.distance}|${race.track_type}`;
        const horses = race.horses.map(h => ({
          ...h,
          odds: h.win_odds != null ? Number(h.win_odds) : null,
          age: null,
        }));
        const built = buildRaceFeatures(
          { ...race, horses },
          { stats, profiles, drawCurve: drawCurves.get(dkey) || new Map(),
            paceRows: paceDataAll.paceRows, fieldLast: paceDataAll.fieldLast,
            figureRows: figureRowsAll }
        );
        out.push({
          date: race.date, raceNo: race.raceNo, runners: race.horses.length,
          horses: built.map((b, i) => ({
            name: horses[i].horse_name,
            finish: horses[i].finish_position,
            odds: horses[i].odds,
            sigma: b.profile?.sigma || 5,
            runs: b.profile?.runs || 0,
            ...b.features,
          })),
        });
      }
      return out;
    };

    const [trainRaces, testRaces] = await Promise.all([buildAll(trainRacesRaw), buildAll(testRacesRaw)]);

    // 3. 訓練權重（logistic + L2）；有因素剔選時只訓練選中嘅特徵
    const model = trainWeights(trainRaces, {
      epochs: 200, lr: 0.4, l2: 0.02,
      ...(trainKeys && trainKeys.length ? { keys: trainKeys } : {}),
    });

    // 4. R² 驗證
    const result = await validateR2(testRaces, model, 3);

    // 5. 權重排序
    const ranked = Object.entries(model.weights)
      .map(([k, v]) => ({ factor: k, weight: v, abs: Math.abs(v) }))
      .sort((a, b) => b.abs - a.abs);

    res.json({
      // 口徑說明：r2 欄位係作者 p190 嘅 ln(R²) = mean(ln(P̂/(1/匹數)))，
      // 門檻 0.17 亦係呢個空間；skillRatio = exp(r2) 係「冠軍機會率係隨機幾多倍」。
      metric: {
        name: 'ln(R²)', formula: 'mean( ln( P̂ / (1/匹數) ) )', bookRef: 'p190',
        threshold: 0.17, thresholdRef: 'p191',
        skillRatioNote: 'exp(ln(R²)) = 幾何平均下冠軍機會率相對於隨機的倍數',
      },
      dataRange: { min: range.min_d, max: range.max_d, totalRaces: +range.n },
      train: { from: trainFrom, to: trainTo, races: trainRaces.length, samples: model.samples, epochs: model.iterations },
      test:  { from: testFrom, to: testTo, races: testRaces.length },
      intercept: model.intercept,
      factorKeysUsed: model.factorKeys || null,   // 今次訓練實際用嘅特徵（因素剔選後）
      r2: result.model,
      marketR2: result.market,          // 同口徑（總和=1），與模型可直接比較
      marketRawR2: result.marketRaw,    // 書中 0.82/odds 口徑，對照 0.17 門檻
      placeR2: result.place,
      threshold: result.threshold,
      marketBenchmark: result.marketBenchmark,
      verdict: verdict(result.model.r2, result.market.r2, result.marketRaw.r2),
      weights: ranked,
      perRace: result.perRace,
    });
  } catch (err) {
    console.error('[ai/r2]', err);
    res.status(500).json({ error: err.message });
  }
});

function minusDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function minusMonths(dateStr, n) {
  const d = new Date(dateStr);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

// R² 判讀。兩個口徑要分清：
//  · model / marketNorm：全部正規化到總和=1，兩者同口徑可直接比較
//  · marketRaw：書中 0.82/odds 口徑，用來對照 p191 的 0.17 門檻
function verdict(modelR2, marketNorm, marketRaw) {
  if (modelR2 == null) return { level: 'none', msg: 'R² 無法計算（樣本不足）。' };

  const n = marketNorm == null ? '—' : marketNorm;
  const raw = marketRaw == null ? '—' : marketRaw;
  const beats = marketNorm != null && modelR2 > marketNorm;

  if (beats) {
    return {
      level: 'good',
      msg: `模型 R² = ${modelR2} 已高於同口徑公賠率 R² = ${n}（公賠率書中口徑 R² = ${raw}，門檻 0.17）。`
        + '模型在測試集上跑贏市場，具備進一步研究的價值。',
    };
  }
  if (marketNorm != null && modelR2 >= 0.17) {
    return {
      level: 'fair',
      msg: `模型 R² = ${modelR2}，高於書中 0.17 門檻，但同口徑公賠率 R² = ${n} 更高（書中口徑 ${raw}）。`
        + '模型有預測訊號，但未能跑贏市場，價值判斷須保守。',
    };
  }
  return {
    level: 'poor',
    msg: `模型 R² = ${modelR2}（同口徑公賠率 R² = ${n}，書中口徑 ${raw}，門檻 0.17）。`
      + '模型未達門檻且未跑贏市場，結果只宜作因子拆解與排名參考。',
  };
}

// ── GET /api/ai/factor-weights?season= ────────────────────────────────────
// 某個條件組合下各因素的實際貢獻（用於驗證權重是否合理）
router.get('/factor-weights', async (req, res) => {
  try {
    const { racecourse, distance, track_type, race_class } = req.query;
    const sstart = req.query.since || `${new Date().getUTCFullYear() - 2}-09-01`;

    const params = [sstart];
    const conds = ['race_date >= $1', 'finish_position IS NOT NULL'];
    if (racecourse) { params.push(racecourse); conds.push(`racecourse = $${params.length}`); }
    if (distance)   { params.push(parseInt(distance)); conds.push(`distance = $${params.length}`); }
    if (track_type) { params.push(track_type); conds.push(`track_type = $${params.length}`); }
    if (race_class) { params.push(race_class); conds.push(`race_class = $${params.length}`); }

    const { rows } = await pool.query(
      `SELECT draw, finish_position, jockey_id, trainer_id
       FROM race_records WHERE ${conds.join(' AND ')}`,
      params
    );
    if (!rows.length) return res.json({ error: '無數據' });

    const g = (key) => {
      const m = new Map();
      for (const r of rows) {
        const k = r[key];
        if (!k) continue;
        if (!m.has(k)) m.set(k, { w: 0, s: 0, t: 0, runs: 0 });
        const b = m.get(k);
        b.runs++;
        if (r.finish_position === 1) b.w++;
        else if (r.finish_position === 2) b.s++;
        else if (r.finish_position === 3) b.t++;
      }
      return m;
    };
    const drawMap = g('draw'), jMap = g('jockey_id'), tMap = g('trainer_id');
    const fmt = (m, key) => [...m.entries()]
      .filter(([, b]) => b.runs >= 8)
      .map(([k, b]) => ({ id: k, runs: b.runs, adj: +(adjRatio(b.w, b.s, b.t, b.runs) * 100).toFixed(2) }))
      .sort((a, b) => b.adj - a.adj);

    res.json({
      conditions: { since: sstart, racecourse, distance, track_type, race_class },
      totalRaces: rows.length,
      draw: fmt(drawMap, 'draw'),
      jockey: fmt(jMap, 'jockey_id').slice(0, 20),
      trainer: fmt(tMap, 'trainer_id').slice(0, 20),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
