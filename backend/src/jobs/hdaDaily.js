// ── 主客和分析每日 job ─────────────────────────────────────────────────────
// 每日 04:05（香港時間）：
//   1. 強制刷新 HK33（新場入庫・舊數據不動）
//   2. 刷新馬會賽事 + titan 配對 → 批量抓新場初盤
//   3. 捕捉黃格賽事入 hda_track（首次記錄・不取代）
//   4. 結算已完場賽事賽果（HKJC GraphQL・fb 直接對）
const puppeteer = require('puppeteer');
const pool = require('../db/pool');
const { buildUpcoming, runBatch, getMergedView, nameSim } = require('../football/hdaService');
const { getHk33 } = require('../football/hk33');

const jobState = { lastRun: null, lastResult: null, running: false };

// ── HKJC GraphQL 賽果（共用模組：捕獲 query・hardcode 後備）──
const { fetchHkjcResults, openResultsPage } = require('../football/hkjcGraphql');

async function fetchHkjcResultsByNames(daysBack = 10) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await openResultsPage(browser);
    const today = new Date();
    const s = new Date(today.getTime() - daysBack * 86400000).toISOString().slice(0, 10);
    const e = today.toISOString().slice(0, 10);
    return await fetchHkjcResults(page, s, e);
  } finally {
    await browser.close();
  }
}

// 填馬會亞洲盤（hdc 頁・只補空位）+ 結算讓球勝負（追蹤邊角度）
const { scrapeHkjcAh, ahOutcome } = require('../football/hkjcFootball');
async function fillAh() {
  let filled = 0;
  try {
    const ahList = await scrapeHkjcAh();
    const byFb = new Map(ahList.map(a => [a.fb, a]));
    const { rows: pending } = await pool.query('SELECT fb, side, ah_line, ah_away_line, result, home_goals, away_goals FROM hda_track');
    for (const p of pending) {
      const a = byFb.get(p.fb);
      // 1) 補讓球線/賠率（未完場仲喺 hdc 頁嘅先有）
      if (a?.homeLine && (!p.ah_line || !p.ah_away_line)) {
        await pool.query(
          `UPDATE hda_track SET ah_line=COALESCE(ah_line,$1), ah_odds=COALESCE(ah_odds,$2),
             ah_away_line=COALESCE(ah_away_line,$3), ah_away_odds=COALESCE(ah_away_odds,$4)
           WHERE fb=$5`,
          [a.homeLine, a.homeOdds ?? null, a.awayLine ?? null, a.awayOdds ?? null, p.fb]);
        p.ah_line = p.ah_line || a.homeLine;
        p.ah_away_line = p.ah_away_line || a.awayLine;
        filled++;
      }
      // 2) 讓球勝負（追蹤邊角度）：H 用主隊線・A 用客隊線
      if (p.result && p.home_goals != null) {
        let r = null;
        if (p.side === 'H' && p.ah_line) r = ahOutcome(p.ah_line, p.home_goals, p.away_goals);
        else if (p.side === 'A' && (p.ah_away_line || p.ah_line)) r = ahOutcome(p.ah_away_line || invertLine(p.ah_line), p.away_goals, p.home_goals);
        if (r) await pool.query('UPDATE hda_track SET ah_result=$1 WHERE fb=$2', [r, p.fb]);
      }
    }
    // 3) 由 HK33 庫補聯賽名（只補空位）
    await pool.query(`
      UPDATE hda_track t SET league = (h.data->>'league')
      FROM hk33_had h
      WHERE t.fb = h.fb AND (t.league IS NULL OR t.league = '') AND h.data->>'league' IS NOT NULL`);
  } catch (_) {}
  return filled;
}

// 線反轉（主隊線 → 客隊線角度）：0/+0.5 → 0/-0.5
function invertLine(line) {
  return line.split('/').map(c => {
    const v = parseFloat(c);
    return v === 0 ? '0' : (v > 0 ? String(-v) : '+' + Math.abs(v));
  }).join('/');
}

async function captureYellows(view) {
  let added = 0;
  const COLORS = [
    { key: 'yellow', code: 'Y' },
    { key: 'green', code: 'G' },
    { key: 'deep', code: 'D' },
    { key: 'strong', code: 'S' },
    { key: 'white', code: 'W' },
    { key: 'awayHot', code: 'F' },
  ];
  for (const m of view.rows) {
    const o = m.odds, k0 = m.hk33, sim = m.sim;
    if (!k0 && !o) continue;
    // HK33 基準要 n≥30 先有效（同檢測邏輯一致）
    const k = k0 && k0.n >= 30 ? k0 : null;
    if (!k && !o) continue; // k 過濾後都可能 null（HK33 n<30 + 冇 titan odds）
    const oddsArr = o ? [+o.open_h, +o.open_d, +o.open_a] : [k.h, k.d, k.a];
    const sdArr = o ? [+o.sd_h, +o.sd_d, +o.sd_a] : [k.sdH, k.sdD, k.sdA];
    const cvArr = o ? [+o.cv_h, +o.cv_d, +o.cv_a] : [k.cvH, k.cvD, k.cvA];
    // n/rate/roi：有效 HK33 優先・sim 後備
    const n = k ? k.n : (sim?.n ?? null);
    const rateArr = k ? [k.rateH, k.rateD, k.rateA] : (sim && sim.n >= 30 ? [sim.rateH, sim.rateD, sim.rateA] : null);
    const roiArr = k ? [k.roiH, k.roiD, k.roiA] : (sim && sim.n >= 30 ? [sim.roiH, sim.roiD, sim.roiA] : null);
    for (const c of COLORS) {
      // 深綠：乾淨 deep 或 舊法 deepOld（壞池優先）— m.deep 為 null 唔可以跳
      let hit = c.code === 'D' ? (m.deepOld || m.deep) : m[c.key];
      if (!hit) continue;
      // ✈️ 客熱門：△高zone（客賠≥1.65）＋ 同場有深綠主隊訊號 → 兩訊號矛盾，唔入 F
      if (c.code === 'F' && m.awayHot && (m.deepOld || m.deep)) {
        const va = m.odds ? +m.odds.open_a : null;
        if (va != null && va >= 1.65) continue;
      }
      const i = hit.idx;
      // 舊計法深綠/客熱門用壞池 n/rate/roi・其他用 HK33/sim
      const isBad = (c.code === 'D' && m.deepOld && hit === m.deepOld) || (c.code === 'F' && m.awayHot);
      const useN = isBad ? (m.bad?.n ?? null) : n;
      const useRateArr = isBad
        ? (m.bad && m.bad.n >= 30 ? [m.bad.rateH, m.bad.rateD, m.bad.rateA] : null)
        : rateArr;
      const useRoiArr = isBad
        ? (m.bad && m.bad.n >= 30 ? [m.bad.roiH, m.bad.roiD, m.bad.roiA] : null)
        : roiArr;
      const r = await pool.query(
        `INSERT INTO hda_track (fb, color, titan_id, match_date, kickoff, home, away, side,
           odds, sd, cv, n, rate, roi, league, bench_src,
           odds_h, odds_d, odds_a, sd_h, sd_d, sd_a, cv_h, cv_d, cv_a,
           rate_h, rate_d, rate_a, roi_h, roi_d, roi_a)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
           $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
         ON CONFLICT (fb, color) DO UPDATE SET
           -- 只補空位：已有數據絕不取代
           titan_id=COALESCE(hda_track.titan_id, EXCLUDED.titan_id),
           n=COALESCE(hda_track.n, EXCLUDED.n),
           rate=COALESCE(hda_track.rate, EXCLUDED.rate),
           roi=COALESCE(hda_track.roi, EXCLUDED.roi),
           league=COALESCE(hda_track.league, EXCLUDED.league),
           odds_h=COALESCE(hda_track.odds_h, EXCLUDED.odds_h),
           odds_d=COALESCE(hda_track.odds_d, EXCLUDED.odds_d),
           odds_a=COALESCE(hda_track.odds_a, EXCLUDED.odds_a),
           rate_h=COALESCE(hda_track.rate_h, EXCLUDED.rate_h),
           rate_d=COALESCE(hda_track.rate_d, EXCLUDED.rate_d),
           rate_a=COALESCE(hda_track.rate_a, EXCLUDED.rate_a),
           roi_h=COALESCE(hda_track.roi_h, EXCLUDED.roi_h),
           roi_d=COALESCE(hda_track.roi_d, EXCLUDED.roi_d),
           roi_a=COALESCE(hda_track.roi_a, EXCLUDED.roi_a)`,
          [m.fb, c.code, m.titanId || null, m.date, m.time, m.home, m.away, hit.side,
          oddsArr[i], sdArr[i], cvArr[i], useN, useRateArr?.[i] ?? null, useRoiArr?.[i] ?? null,
          m.hk33?.league || m.leagueCn || null, isBad ? 'bad' : (m.hk33 ? 'HK33' : 'sim'),
          // 三邊齊全
          oddsArr[0], oddsArr[1], oddsArr[2],
          sdArr[0], sdArr[1], sdArr[2],
          cvArr[0], cvArr[1], cvArr[2],
          useRateArr?.[0] ?? null, useRateArr?.[1] ?? null, useRateArr?.[2] ?? null,
          useRoiArr?.[0] ?? null, useRoiArr?.[1] ?? null, useRoiArr?.[2] ?? null]);
      added += r.rowCount;
       // 深綠格回歸實驗（獨立表・只記錄深綠格 = gap≥13pp）
       if (c.code === 'D') {
        const invSum = 1 / oddsArr[0] + 1 / oddsArr[1] + 1 / oddsArr[2];
        const openExp = (1 / oddsArr[i]) / invSum;
        const rateV = rateArr?.[i] ?? null;
        await pool.query(
          `INSERT INTO hda_green_regression (fb, titan_id, side, open_odds, open_exp, gap, bench)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (fb) DO NOTHING`,
          [m.fb, m.titanId || null, hit.side, oddsArr[i], +openExp.toFixed(4),
           rateV != null ? +(openExp - rateV).toFixed(4) : null,
           m.hk33 ? 'HK33' : 'sim']);
      }
    }
  }
  return added;
}

// 結算：時間 + 隊名配對（frontEndId 係空字串會錯配，唔再用 fb 直配）
async function settleYellows(force = false) {
  const { rows: pending } = await pool.query(
    'SELECT fb, match_date, kickoff, home, away FROM hda_track' +
    (force ? '' : ' WHERE result IS NULL'));
  if (!pending.length) return 0;
  const results = await fetchHkjcResultsByNames(10);
  const { nameSim } = require('../football/hdaService');
  let settled = 0;
  for (const p of pending) {
    // 時間一致 + 隊名相似（日期容許 ±1 日・titan UTC 日期同 HKJC HK 日期可能差一日）
    let best = null, bestSim = 0;
    for (const r of results) {
      if (r.time !== p.kickoff) continue;
      const dd = Math.abs(new Date(r.date) - new Date(p.match_date)) / 86400000;
      if (dd > 1.5) continue;
      const sim = (nameSim(p.home, r.home) + nameSim(p.away, r.away)) / 2;
      if (sim > bestSim) { bestSim = sim; best = r; }
    }
    if (best && bestSim >= 0.7) {
      const result = best.hg > best.ag ? 'H' : best.hg === best.ag ? 'D' : 'A';
      await pool.query(
        `UPDATE hda_track SET result=$1, home_goals=$2, away_goals=$3, settled_at=now() WHERE fb=$4`,
        [result, best.hg, best.ag, p.fb]);
      settled++;
    }
  }
  // 後備：HKJC 冇結果嘅 → 用 titan oddslist 頁首比分
  const { rows: still } = await pool.query(
    `SELECT fb, titan_id FROM hda_track WHERE result IS NULL AND titan_id IS NOT NULL`);
  const { scrape1x2 } = require('../football/titan1x2');
  for (const s of still) {
    try {
      const d = await scrape1x2(s.titan_id);
      if (d.result) {
        await pool.query(
          `UPDATE hda_track SET result=$1, home_goals=$2, away_goals=$3, settled_at=now() WHERE fb=$4`,
          [d.result, d.homeGoals, d.awayGoals, s.fb]);
        settled++;
      }
    } catch (_) {}
  }
  // 綠格回歸實驗：已完場 → 撈收盤價（titan 即時平均=收盤）+ 判定回歸
  await settleGreenRegression();
  return settled;
}

async function settleGreenRegression() {
  const { rows } = await pool.query(
    `SELECT g.fb, COALESCE(g.titan_id, t.titan_id) titan_id, g.side, g.open_exp
     FROM hda_green_regression g
     JOIN hda_track t ON t.fb = g.fb AND t.color = 'G'
     WHERE g.settled_at IS NULL AND t.result IS NOT NULL`);
  if (!rows.length) return;
  const { scrape1x2 } = require('../football/titan1x2');
  for (const r of rows) {
    if (!r.titan_id) continue;
    try {
      const d = await scrape1x2(r.titan_id);
      const { rows: tr } = await pool.query(
        'SELECT result FROM hda_track WHERE fb=$1 AND color=$2', [r.fb, 'G']);
      const result = tr[0]?.result;
      if (!d.liveAvg || !result) continue;
      const inv = 1/d.liveAvg.h + 1/d.liveAvg.d + 1/d.liveAvg.a;
      const idx = 'HDA'.indexOf(r.side);
      const closeExp = (1 / [d.liveAvg.h, d.liveAvg.d, d.liveAvg.a][idx]) / inv;
      // 回歸 = 收盤隱含低過開盤隱含 1pp 以上（市場向歷史方向修正）
      const regressed = closeExp < (+r.open_exp - 0.01);
      await pool.query(
        `UPDATE hda_green_regression
         SET close_odds=$1, close_exp=$2, regressed=$3, result=$4, hit=$5, settled_at=now(), titan_id=$7
         WHERE fb=$6`,
        [[d.liveAvg.h, d.liveAvg.d, d.liveAvg.a][idx], +closeExp.toFixed(4), regressed,
         result, result === r.side, r.fb, r.titan_id]);
    } catch (_) {}
  }
}

// had_odds 補賽果：未結 + 14 日內 → 由 titan oddslist 頁首攞比分
async function settleHadOdds() {
  const { rows } = await pool.query(
    `SELECT titan_id FROM had_odds
     WHERE result IS NULL AND match_date >= CURRENT_DATE - 14 AND match_date < CURRENT_DATE AND titan_id IS NOT NULL`);
  let settled = 0;
  for (const r of rows) {
    try {
      const { scrape1x2 } = require('../football/titan1x2');
      const d = await scrape1x2(r.titan_id);
      if (d.result) {
        await pool.query('UPDATE had_odds SET home_goals=$1, away_goals=$2, result=$3 WHERE titan_id=$4 AND result IS NULL',
          [d.homeGoals, d.awayGoals, d.result, r.titan_id]);
        settled++;
      }
    } catch (_) {}
  }
  // 後備：HKJC-only 行（冇 titan_id）→ GraphQL 時間+隊名配對
  const { rows: noId } = await pool.query(
    `SELECT id, match_date::text d, 'x' kickoff, home_team, away_team FROM had_odds
     WHERE result IS NULL AND match_date >= CURRENT_DATE - 14 AND match_date < CURRENT_DATE AND titan_id IS NULL`);
  if (noId.length) {
    const results = await fetchHkjcResultsByNames(10);
    for (const p of noId) {
      let best = null, bestSim = 0;
      for (const r of results) {
        const dd = Math.abs(new Date(r.date) - new Date(p.d)) / 86400000;
        if (dd > 1.5) continue;
        const sim = (nameSim(p.home_team, r.home) + nameSim(p.away_team, r.away)) / 2;
        if (sim > bestSim) { bestSim = sim; best = r; }
      }
      if (best && bestSim >= 0.9) {
        const result = best.hg > best.ag ? 'H' : best.hg === best.ag ? 'D' : 'A';
        await pool.query('UPDATE had_odds SET home_goals=$1, away_goals=$2, result=$3 WHERE id=$4',
          [best.hg, best.ag, result, p.id]);
        settled++;
      }
    }
  }
  return settled;
}

// 紫格捕捉：完場後掃 主≤1.6 場次 → 攞收盤價 → 客跌≥3% 就入庫
const { scrape1x2 } = require('../football/titan1x2');
async function capturePurples() {
  let added = 0;
  try {
    const { rows } = await pool.query(
      `SELECT h.titan_id, h.league, h.league_cn, h.match_date, h.home_team, h.away_team,
              h.open_h, h.open_a, h.result, h.home_goals, h.away_goals
       FROM had_odds h
       WHERE h.result IS NOT NULL AND h.open_h IS NOT NULL
         AND h.open_h <= 1.60
         AND h.match_date >= CURRENT_DATE - 7
         AND NOT EXISTS (SELECT 1 FROM hda_track t WHERE t.titan_id = h.titan_id AND t.color = 'P')`);
    for (const r of rows) {
      try {
        const d = await scrape1x2(r.titan_id);
        if (!d.liveAvg) continue;
        // 收盤客價比初盤跌 ≥3% → 紫格
        if (d.liveAvg.a < (+r.open_a) * 0.97) {
          const fb = 'T' + r.titan_id;
          await pool.query(
            `INSERT INTO hda_track (fb, color, titan_id, match_date, kickoff, home, away, side, odds, league, result, home_goals, away_goals, settled_at)
             VALUES ($1,'P',$2,$3,'',$4,$5,'A',$6,$7,$8,$9,$10,now())
             ON CONFLICT (fb, color) DO NOTHING`,
            [fb, r.titan_id, r.match_date, r.home_team, r.away_team, +r.open_a,
             r.league_cn || r.league || null, r.result, r.home_goals, r.away_goals]);
          added++;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return added;
}

async function runDaily() {
  if (jobState.running) return { skipped: true };
  jobState.running = true;
  const log = [];
  try {
    // 1. HK33 強制刷新（新場入庫）
    try { const hk = await getHk33(true); log.push(`HK33 ${hk.rows.length} 場`); }
    catch (e) { log.push(`HK33 FAIL: ${e.message.slice(0, 40)}`); }
    // 2. 馬會賽事刷新 + 新場初盤
    await buildUpcoming(true);
    await runBatch();
    log.push(`batch done=${global.__hdaBatchDone ?? ''}`);
    // 3. 黃格捕捉
    const view = await getMergedView();
    const added = await captureYellows(view);
    log.push(`黃格 +${added}`);
    // 4. 賽果結算
    const sy = await settleYellows();
    log.push(`黃格結算 ${sy}`);
    const sh = await settleHadOdds();
    log.push(`had_odds 補賽果 ${sh}`);
    // 5. 馬會亞洲盤（補線 + 計讓球勝負）
    const fa = await fillAh();
    log.push(`亞洲盤 +${fa}`);
    // 6. 紫格捕捉（收盤客受捧）
    const pu = await capturePurples();
    log.push(`紫格 +${pu}`);
    // 7. 補漏：近 3 日馬會賽事有冇未入 had_odds
    try {
      const gaps = await checkGaps(3);
      log.push(`補漏 ${gaps}`);
    } catch (e) { log.push(`補漏 FAIL: ${e.message.slice(0, 30)}`); }
    jobState.lastRun = Date.now();
    jobState.lastResult = log.join('・');
    return { ok: true, log };
  } catch (e) {
    jobState.lastResult = 'FAIL: ' + e.message.slice(0, 100);
    return { ok: false, error: e.message };
  } finally {
    jobState.running = false;
  }
}

// 補漏：檢查近 N 日馬會賽事有冇未入 had_odds（唯讀報告）
async function checkGaps(daysBack = 3) {
  const results = await fetchHkjcResultsByNames(daysBack);
  const { rows: existing } = await pool.query(
    `SELECT match_date::text d, home_team, away_team FROM had_odds WHERE match_date >= CURRENT_DATE - ($1 || ' days')::interval`,
    [daysBack]);
  const existSet = new Set(existing.map(r => `${r.d}|${r.home_team}|${r.away_team}`));
  const { nameSim } = require('../football/hdaService');
  let missing = 0;
  for (const r of results) {
    const found = existSet.has(`${r.date}|${r.home}|${r.away}`) ||
      existing.some(e => e.d === r.date &&
        (nameSim(e.home_team, r.home) + nameSim(e.away_team, r.away)) / 2 >= 0.7);
    if (!found) missing++;
  }
  if (missing > 0) {
    console.log(`[hdaDaily] ⚠ ${missing} 場馬會賽事未入 had_odds（近 ${daysBack} 日）`);
  }
  return missing === 0 ? '✓ 0 漏' : `⚠ ${missing} 漏`;
}

// 排程：香港時間 04:05-04:20 之間行一次
let lastRunDate = null;
function start() {
  const tick = async () => {
    try {
      const now = new Date();
      const hkHour = (now.getUTCHours() + 8) % 24;
      const hkMin = now.getUTCMinutes();
      const today = now.toISOString().slice(0, 10);
      if (hkHour === 4 && hkMin >= 5 && hkMin < 20 && lastRunDate !== today) {
        lastRunDate = today;
        console.log('[hdaDaily] 04:05 自動更新開始');
        runDaily();
      }
    } catch (_) {}
  };
  setInterval(tick, 60 * 1000);

  // 啟動補跑：如果上次跑超過 20 小時前（或從未跑過）→ 即刻補跑
  // 確保容器重啟後唔會錯過每日數據
  setTimeout(async () => {
    try {
      const lastRun = jobState.lastRun || 0;
      const hoursSince = (Date.now() - lastRun) / 3600000;
      if (!lastRun || hoursSince > 20) {
        console.log(`[hdaDaily] 啟動補跑（上次: ${lastRun ? new Date(lastRun).toLocaleString('zh-HK') : '從未'}・${hoursSince.toFixed(1)} 小時前）`);
        await runDaily();
      } else {
        console.log(`[hdaDaily] 上次跑於 ${new Date(lastRun).toLocaleString('zh-HK')}（${hoursSince.toFixed(1)} 小時前）・唔使補跑`);
      }
    } catch (e) {
      console.error('[hdaDaily] 啟動補跑失敗:', e.message);
    }
  }, 15 * 1000); // 等 15 秒俾 DB 同其他服務 ready

  tick();
}

module.exports = { start, runDaily, jobState, settleYellows, captureYellows, fillAh, capturePurples };
