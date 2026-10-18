// ── 步速分析 Pace Analysis ──────────────────────────────────────────────────
// 用每匹馬過往分段時間嘅「走位」（race_sectional_times.running_positions，
// 格式如「4-1 3-2 2-1 1-N」= 每段位置-落後距離）推算跑法，
// 再按同場跑法分佈預測該場步速形勢。
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { getFigureHistory } = require('../ai/speedfig');

// 走位字串 → 各段位置陣列，例如 "14-6-1/4 14-8-1/2 2-N" → [14, 14, 2]
function parsePositions(rp) {
  if (!rp) return [];
  return String(rp)
    .split(/\s+/)
    .filter(Boolean)
    .map(tok => {
      const n = parseInt(tok, 10);
      return Number.isFinite(n) && n > 0 && n < 25 ? n : null;
    })
    .filter(v => v != null);
}

// 加權平均（新仗權重高）：0.8^i
function weightedAvg(arr) {
  if (!arr.length) return null;
  let sum = 0, w = 0;
  arr.forEach((v, i) => {
    const weight = Math.pow(0.8, i);
    sum += v * weight;
    w += weight;
  });
  return sum / w;
}

function styleOf(earlyAvg) {
  if (earlyAvg == null) return null;
  if (earlyAvg <= 2.5) return '前領';
  if (earlyAvg <= 4.0) return '前速';
  if (earlyAvg <= 6.5) return '均速';
  return '後追';
}

router.get('/pace', async (req, res) => {
  try {
    let { date, race_no } = req.query;
    if (!date) {
      const today = new Date().toISOString().split('T')[0];
      const next = await pool.query(
        `SELECT TO_CHAR(race_date,'YYYY-MM-DD') AS d FROM racecard
         WHERE race_date >= $1 ORDER BY race_date ASC LIMIT 1`, [today]
      );
      date = next.rows.length ? next.rows[0].d : today;
    }

    const params = [date];
    let filter = '';
    if (race_no) { params.push(parseInt(race_no, 10)); filter = `AND rc.race_no = $${params.length}`; }

    const rcRes = await pool.query(
      `SELECT rc.race_no, rc.racecourse, rc.race_class, rc.distance, rc.track_type, rc.going,
              rc.horse_no, rc.horse_name, rc.draw, rc.jockey_name, rc.trainer_name
       FROM racecard rc
       WHERE rc.race_date = $1 ${filter}
       ORDER BY rc.race_no, rc.horse_no`,
      params
    );
    if (!rcRes.rows.length) return res.json({ date, races: [] });

    // 該批馬嘅過往分段紀錄（走位 + 分段時間）
    const names = [...new Set(rcRes.rows.map(r => r.horse_name).filter(Boolean))];
    const sectRes = names.length ? await pool.query(
      `SELECT horse_name, TO_CHAR(race_date,'YYYY-MM-DD') AS d, race_no, distance,
              finish_position, running_positions,
              seg1, seg2, seg3, seg4, seg5, seg6
       FROM race_sectional_times
       WHERE horse_name = ANY($1) AND race_date::text < $2
       ORDER BY horse_name, race_date DESC`,
      [names, date]
    ) : { rows: [] };

    // 每場「全場」末段（計後勁用）— 必須攞嗰啲賽事嘅全部馬，
    // 唔可以齋用我哋參賽馬嘅行（以前咁搞令 field>=5 幾乎永遠 fail，後勁樣本得 0-1 仗）
    const lastSegOf = (r) => {
      const segs = [r.seg1, r.seg2, r.seg3, r.seg4, r.seg5, r.seg6]
        .map(v => (v == null || v === '' ? null : parseFloat(v)))
        .filter(v => v != null && isFinite(v));
      return segs.length ? segs[segs.length - 1] : null;
    };
    const raceFieldLast = new Map(); // `${d}|${rno}` → 該場全部馬嘅末段
    const runKeys = [...new Set(sectRes.rows.map(r => `${r.d}|${r.race_no}`))];
    if (runKeys.length) {
      const ds = [...new Set(runKeys.map(k => k.split('|')[0]))];
      const nos = [...new Set(runKeys.map(k => Number(k.split('|')[1])))];
      const fRes = await pool.query(
        `SELECT TO_CHAR(race_date,'YYYY-MM-DD') AS d, race_no,
                seg1, seg2, seg3, seg4, seg5, seg6
         FROM race_sectional_times
         WHERE race_date::text = ANY($1) AND race_no = ANY($2)`,
        [ds, nos]
      );
      for (const r of fRes.rows) {
        const ls = lastSegOf(r);
        if (ls == null) continue;
        const k = `${r.d}|${r.race_no}`;
        if (!raceFieldLast.has(k)) raceFieldLast.set(k, []);
        raceFieldLast.get(k).push(ls);
      }
    }

    const byHorse = new Map();
    for (const r of sectRes.rows) {
      if (!byHorse.has(r.horse_name)) byHorse.set(r.horse_name, []);
      byHorse.get(r.horse_name).push(r);
    }

    // Beyer 速度圖數（近 6 仗加權，賽前）— 豐富步速分析：圖數 × 跑法 × 後勁
    const figRows = await getFigureHistory(names, date);

    // 逐場构建
    const racesMap = new Map();
    for (const rc of rcRes.rows) {
      if (!racesMap.has(rc.race_no)) {
        racesMap.set(rc.race_no, {
          race_no: rc.race_no, racecourse: rc.racecourse, race_class: rc.race_class,
          distance: rc.distance, track_type: rc.track_type, going: rc.going,
          horses: [],
        });
      }
      const runs = byHorse.get(rc.horse_name) || [];

      const earlyPositions = [];   // 新→舊
      const styleRuns = [];        // 每仗跑法標籤
      let lastRunEarly = null;
      let lastRunFinish = null;
      let lastRunDate = null;
      // ── 後勁分析（同樣重視）：逐仗記錄 ──
      const closingIdx = [];       // 全場末段中位數 ÷ 此馬末段（>1 = 快過全場）
      const closingPct = [];       // 此馬末段喺該仗嘅排名百分位（0=最快）
      let bestClosing = null;      // 最勁嗰仗 { value, date, last }
      let closingRuns = 0, closingWins = 0; // 有幾多仗快過全場

      runs.slice(0, 8).forEach((r, i) => {
        const pos = parsePositions(r.running_positions);
        if (!pos.length) return;
        const early = pos[0];
        earlyPositions.push(early);
        styleRuns.push(styleOf(early));
        if (i === 0) {
          lastRunEarly = early;
          lastRunFinish = r.finish_position;
          lastRunDate = r.d;
        }
        // 後勁：此馬末段 vs 全場（用中位數，唔受極端值影響）
        const ls = lastSegOf(r);
        const field = raceFieldLast.get(`${r.d}|${r.race_no}`);
        if (ls != null && field && field.length >= 5) {
          const sorted = [...field].sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)];
          const idx = median / ls;
          closingIdx.push(idx);
          // 排名百分位（0 = 全場末段最快）
          const rank = sorted.filter(v => v < ls).length + 1;
          closingPct.push(rank / sorted.length);
          closingRuns++;
          if (idx > 1) closingWins++;
          if (!bestClosing || idx > bestClosing.value) {
            bestClosing = { value: +idx.toFixed(3), date: r.d, last: ls };
          }
        }
      });

      const earlyAvg = weightedAvg(earlyPositions);
      racesMap.get(rc.race_no).horses.push({
        horse_no: rc.horse_no,
        horse_name: rc.horse_name,
        draw: rc.draw,
        jockey_name: rc.jockey_name,
        trainer_name: rc.trainer_name,
        runs_used: earlyPositions.length,
        early_avg: earlyAvg != null ? +earlyAvg.toFixed(2) : null,
        early_positions: earlyPositions.slice(0, 6),
        style_runs: styleRuns.slice(0, 6),
        style: styleOf(earlyAvg),
        last_run_early: lastRunEarly,
        last_run_finish: lastRunFinish,
        last_run_date: lastRunDate,
        // ── 後勁指標（新仗權重高，同走位計法一致）──
        closing_index: closingIdx.length ? +weightedAvg(closingIdx).toFixed(3) : null,
        closing_pct: closingPct.length ? +weightedAvg(closingPct).toFixed(3) : null,
        closing_best: bestClosing,
        closing_consistency: closingRuns >= 2 ? +(closingWins / closingRuns).toFixed(2) : null,
        closing_runs: closingRuns,
      });

      // ── 速度圖數（Beyer）：近 6 仗加權（新仗重），附最佳 + 冇壓力放頭警示 ──
      const figs = (figRows.get(rc.horse_name) || []).slice(0, 6);
      if (figs.length) {
        let s = 0, w = 0;
        figs.forEach((r, i) => { const k = Math.pow(0.85, i); s += r.fig * k; w += k; });
        racesMap.get(rc.race_no).horses[racesMap.get(rc.race_no).horses.length - 1].speed_fig = {
          fig: +(s / w).toFixed(1),
          best: +Math.max(...figs.map(r => r.fig)).toFixed(1),
          n: figs.length,
          w2w: figs.filter(r => r.w2w && r.noPressure).length,
        };
      }
    }

    // 每場步速形勢（三級制；重點係領放馬同跑法分佈 — 2026-09 回測顯示
    // 等級預測訊號有限，但領放馬命中 29% vs 隨機 9%，有實證訊號）
    const races = [...racesMap.values()].map((race) => {
      const known = race.horses.filter(h => h.style);
      const leaders = known.filter(h => h.style === '前領');
      const pressers = known.filter(h => h.style === '前速');

      let level, note, favours;
      if (leaders.length >= 2 || leaders.length + pressers.length >= 5) {
        level = '快';
        favours = '均速/後追';
        note = '多匹前置馬角逐領放，前段有機會互相消耗 — 留意後上馬。';
      } else if (leaders.length + pressers.length <= 1) {
        level = '慢';
        favours = '前領/前速';
        note = '欠典型前置馬，料有一匹從容放頭 — 留意前置馬佔先機。（注意：回測顯示冇前領馬嘅場實際前段未必慢）';
      } else {
        level = '正常';
        favours = '形勢平均';
        note = '前置馬數量一般，步速預計正常，形勢大致公平。';
      }

      // 預計領放馬：早段平均位最細（平手時內檔先）
      const byEarly = [...known].sort((a, b) =>
        (a.early_avg - b.early_avg) || ((a.draw ?? 99) - (b.draw ?? 99)));
      const projectedLeader = byEarly[0] || null;

      // 後追候選：後勁指數最高三匹（起碼 2 仗後勁樣本）— 形勢快時佢哋著數
      const byClosing = race.horses
        .filter(h => h.closing_index != null && h.closing_runs >= 2)
        .sort((a, b) => b.closing_index - a.closing_index);
      const closerCandidates = byClosing.slice(0, 3).map(h => h.horse_name);

      // 圖數王：速度圖數最高三匹（整體能力基準）
      const byFig = race.horses
        .filter(h => h.speed_fig && h.speed_fig.n >= 2)
        .sort((a, b) => b.speed_fig.fig - a.speed_fig.fig);
      const figCandidates = byFig.slice(0, 3).map(h => h.horse_name);

      const styleCounts = { '前領': 0, '前速': 0, '均速': 0, '後追': 0, '無資料': 0 };
      for (const h of race.horses) styleCounts[h.style || '無資料']++;

      return {
        ...race,
        pace: {
          level,
          note,
          favours,
          leaders: leaders.map(h => h.horse_name),
          projected_leader: projectedLeader ? projectedLeader.horse_name : null,
          // 領放候選（早段平均位最細三匹，回測命中 75% vs 隨機 25%）
          leader_candidates: byEarly.slice(0, 3).map(h => h.horse_name),
          // 後追候選（後勁指數最高三匹 — 形勢快嘅場佢哋最著數）
          closer_candidates: closerCandidates,
          // 圖數王（速度圖數最高三匹 — 整體能力基準）
          fig_candidates: figCandidates,
          style_counts: styleCounts,
          with_data: known.length,
          total: race.horses.length,
        },
        horses: [...race.horses].sort((a, b) => (a.early_avg ?? 99) - (b.early_avg ?? 99)),
      };
    }).sort((a, b) => a.race_no - b.race_no);

    res.json({ date, races });
  } catch (err) {
    console.error('[races/pace]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
