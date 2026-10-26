const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Get next race date
router.get('/next', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await pool.query(
      `SELECT id, TO_CHAR(race_date, 'YYYY-MM-DD') AS race_date, racecourse, season, created_at
       FROM fixtures WHERE race_date >= $1 ORDER BY race_date ASC LIMIT 1`,
      [today]
    );
    if (result.rows.length === 0) {
      return res.json({ race_date: null, racecourse: null });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all fixtures
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, TO_CHAR(race_date, 'YYYY-MM-DD') AS race_date, racecourse, season, created_at
       FROM fixtures ORDER BY race_date DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get racecard for a specific date
router.get('/racecard', async (req, res) => {
  try {
    const { date } = req.query;
    let targetDate = date;

    if (!targetDate) {
      const today = new Date().toISOString().split('T')[0];
      const next = await pool.query(
        `SELECT TO_CHAR(race_date, 'YYYY-MM-DD') AS race_date FROM fixtures WHERE race_date >= $1 ORDER BY race_date ASC LIMIT 1`,
        [today]
      );
      targetDate = next.rows.length > 0 ? next.rows[0].race_date : today;
    }

    const result = await pool.query(
      `SELECT r.*, j.name_zh as jockey_name, t.name_zh as trainer_name
       FROM racecard r
       LEFT JOIN jockeys j ON r.jockey_id = j.id
       LEFT JOIN trainers t ON r.trainer_id = t.id
       WHERE r.race_date = $1
       ORDER BY r.race_no, r.horse_no`,
      [targetDate]
    );

    // Group by race number
    const races = {};
    for (const row of result.rows) {
      if (!races[row.race_no]) {
        races[row.race_no] = {
          race_no: row.race_no,
          racecourse: row.racecourse,
          race_class: row.race_class,
          distance: row.distance,
          track_type: row.track_type,
          going: row.going,
          horses: [],
        };
      }
      races[row.race_no].horses.push(row);
    }

    res.json({
      date: targetDate,
      races: Object.values(races).sort((a, b) => a.race_no - b.race_no),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Advanced racecard ────────────────────────────────────────────────────────
// GET /api/races/advanced?date=YYYY-MM-DD
// Returns racecards enriched with derived analytics columns for the 高級排位表 page.

// 班次 → 等級數字（細 = 高班）。
// racecard 用「第N班」，但 race_records 混雜用 '1'..'5'、'G1'..'G3'、
// '3R'/'4R'（限制班）、'GRIFFIN'（新馬）、甚至「草地"A"」等雜訊標籤，
// 直接用 CLASS_ORDER 對唔上 → 以前好多馬顯示唔到升降班。
const CLASS_RANK_ADV = {
  '精英班': 0, '第一班': 1, '第二班': 2, '第三班': 3, '第四班': 4, '第五班': 5,
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5,
  'G1': 0, 'G2': 0, 'G3': 0,
  '國際一級賽': 0, '國際二級賽': 0, '國際三級賽': 0, '一級賽': 0, '二級賽': 0, '三級賽': 0,
  '3R': 3, '4R': 4,       // 限制班：按番數字班次
  '4YO': 1,               // 四歲系列（如打吡）視作高班
  'GRIFFIN': 6, '新馬賽': 6, '處女馬賽': 6,
};
function classRankAdv(c) {
  if (c == null) return null;
  const k = String(c).trim();
  if (CLASS_RANK_ADV[k] != null) return CLASS_RANK_ADV[k];
  const m = k.match(/第?([1-5])班/);
  if (m) return parseInt(m[1], 10);
  return null; // 「草地"A"」等雜訊
}

function seasonStartFor(dateStr) {
  const [y, m] = String(dateStr).split('-').map(Number);
  return m >= 9 ? `${y}-09-01` : `${y - 1}-09-01`;
}

function dateOf(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function diffDays(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return Math.round((da - db) / 86400000);
}

function parseGearTokens(g) {
  if (!g) return [];
  return g.split(/[/,\s]+/)
    .map(s => s.trim().toUpperCase()).filter(Boolean)
    .filter(t => !t.endsWith('-'))
    .map(t => t.replace(/[12]$/, ''))
    .filter(Boolean).sort();
}

router.get('/advanced', async (req, res) => {
  try {
    let date = req.query.date;
    if (!date) {
      const today = new Date().toISOString().split('T')[0];
      const next = await pool.query(
        `SELECT TO_CHAR(race_date, 'YYYY-MM-DD') AS race_date FROM fixtures WHERE race_date >= $1 ORDER BY race_date ASC LIMIT 1`,
        [today]
      );
      date = next.rows.length > 0 ? next.rows[0].race_date : today;
    }
    const sstart = seasonStartFor(date);

    // 1. Racecard of the target date
    const rcResult = await pool.query(
      `SELECT rc.*, h.age AS horse_age
       FROM racecard rc
       LEFT JOIN horses h ON h.id = rc.horse_id
       WHERE rc.race_date = $1
       ORDER BY rc.race_no, rc.horse_no`,
      [date]
    );
    const rcRows = rcResult.rows;
    if (rcRows.length === 0) return res.json({ date, races: [] });

    const names      = [...new Set(rcRows.map(r => r.horse_name).filter(Boolean))];
    const horseIds   = [...new Set(rcRows.map(r => r.horse_id).filter(Boolean))];
    const trainerIds = [...new Set(rcRows.map(r => r.trainer_id).filter(Boolean))];
    const jockeyIds  = [...new Set(rcRows.map(r => r.jockey_id).filter(Boolean))];

    // 2. Entries notes（皇牌/保護權）— 只按馬名配對，唔按 race_no！
    //    報名表早幾日抓，場次編排同最終排位表唔同（例：神衝萬里報名 R3，
    //    最終排 R11）→ 按 race_no 配對會 miss 大部分。符號圖例：
    //    + 皇牌（王牌）、* 保護權（優先出賽）、R 後備、數字 練馬師優先次序。
    //    同一馬多次抓取 → DISTINCT ON 取最新一次。
    const entResult = await pool.query(
      `SELECT DISTINCT ON (horse_name) horse_name, horse_note
       FROM entries WHERE meeting_date = $1
       ORDER BY horse_name, scrape_date DESC, id DESC`,
      [date]
    );
    const noteMap = new Map();
    for (const e of entResult.rows) noteMap.set(e.horse_name, e.horse_note || '');

    // 3. Full career history of these horses (before the target date)
    const histResult = names.length
      ? await pool.query(
          `SELECT rr.race_date, rr.race_no, rr.horse_name, rr.racecourse, rr.track_type, rr.distance, rr.race_class,
                  rr.finish_position, rr.total_runners, rr.jockey_id, rr.trainer_id, rr.trainer_name,
                  rr.actual_weight, rr.horse_weight, rr.rating, rr.win_odds, rr.gear,
                  j.name_zh AS prev_jockey_name
           FROM race_records rr
           LEFT JOIN jockeys j ON j.id = rr.jockey_id
           WHERE rr.horse_name = ANY($1) AND rr.race_date < $2
           ORDER BY rr.race_date DESC, rr.race_no DESC`,
          [names, date]
        )
      : { rows: [] };

    const byHorse = {};
    for (const r of histResult.rows) {
      if (!byHorse[r.horse_name]) byHorse[r.horse_name] = [];
      byHorse[r.horse_name].push(r);
    }
    const prevOf = {};
    for (const [nm, rows] of Object.entries(byHorse)) prevOf[nm] = rows[0];

    // 3b. 過往排位表班次 — race_records.race_class 成日被「草地"A"」等污染，
    //     而歷史 racecard 有正宗「第N班」，用嚟做升降班 fallback
    const rcClassOf = new Map(); // horse_name → 最近一次有效班次
    if (names.length) {
      const rcH = await pool.query(
        `SELECT horse_name, race_class FROM racecard
         WHERE horse_name = ANY($1) AND race_date < $2 AND race_class LIKE '第%班'
         ORDER BY race_date DESC`,
        [names, date]
      );
      for (const r of rcH.rows) {
        if (!rcClassOf.has(r.horse_name)) rcClassOf.set(r.horse_name, r.race_class);
      }
    }

    // 4. Same-season jockey + trainer cooperation
    const jtMap = new Map();
    if (trainerIds.length && jockeyIds.length) {
      const jtResult = await pool.query(
        `SELECT trainer_id, jockey_id,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE finish_position = 1) AS wins,
                COUNT(*) FILTER (WHERE finish_position <= 3) AS places
         FROM race_records
         WHERE race_date >= $1 AND trainer_id = ANY($2) AND jockey_id = ANY($3)
         GROUP BY trainer_id, jockey_id`,
        [sstart, trainerIds, jockeyIds]
      );
      for (const r of jtResult.rows) jtMap.set(`${r.trainer_id}|${r.jockey_id}`, r);
    }

    // 4b. 騎練近三季合作（由 sstart 起倒推三季，例如 2026-10 → 自 2024-09-01）
    const since3 = `${Number(sstart.slice(0, 4)) - 2}-09-01`;
    const jtAllMap = new Map();
    if (trainerIds.length && jockeyIds.length) {
      const jtAllResult = await pool.query(
        `SELECT trainer_id, jockey_id,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE finish_position = 1) AS wins,
                COUNT(*) FILTER (WHERE finish_position <= 3) AS places
         FROM race_records
         WHERE race_date >= $1 AND trainer_id = ANY($2) AND jockey_id = ANY($3)
         GROUP BY trainer_id, jockey_id`,
        [since3, trainerIds, jockeyIds]
      );
      for (const r of jtAllResult.rows) jtAllMap.set(`${r.trainer_id}|${r.jockey_id}`, r);
    }

    // 5. 分段時間（同場同程最快末段 / 最快末段）— 每匹馬歷史每一仗嘅末段時間
    //    末段 = seg1..seg6 最後一個非空值（秒）
    const sectHist = new Map(); // horse_name → [{ d, course, dist, last, pos, rno }]
    const sectDates = new Set();
    if (names.length) {
      const sectRes = await pool.query(
        `SELECT horse_name, TO_CHAR(race_date,'YYYY-MM-DD') AS d, racecourse, distance,
                race_no, finish_position, seg1, seg2, seg3, seg4, seg5, seg6
         FROM race_sectional_times
         WHERE horse_name = ANY($1) AND race_date < $2`,
        [names, date]
      );
      for (const r of sectRes.rows) {
        const segs = [r.seg1, r.seg2, r.seg3, r.seg4, r.seg5, r.seg6]
          .map(v => (v == null || v === '' ? null : parseFloat(v)))
          .filter(v => v != null && isFinite(v));
        if (!segs.length) continue;
        if (!sectHist.has(r.horse_name)) sectHist.set(r.horse_name, []);
        sectHist.get(r.horse_name).push({
          d: r.d, course: r.racecourse, dist: r.distance, rno: r.race_no,
          last: segs[segs.length - 1], pos: r.finish_position,
        });
        sectDates.add(r.d);
      }
    }

    // 5b. 每場全部馬嘅末段（計「該場末段排第幾 / 該場馬匹數量」用）
    const raceLastSeg = new Map(); // `${d}|${rno}` → 該場所有末段時間（升序）
    if (sectDates.size) {
      const allRes = await pool.query(
        `SELECT TO_CHAR(race_date,'YYYY-MM-DD') AS d, race_no,
                CASE WHEN COALESCE(NULLIF(seg6,''),NULLIF(seg5,''),NULLIF(seg4,''),
                                        NULLIF(seg3,''),NULLIF(seg2,''),NULLIF(seg1,'')) ~ '^\\d+(\\.\\d+)?$'
                     THEN COALESCE(NULLIF(seg6,''),NULLIF(seg5,''),NULLIF(seg4,''),
                                   NULLIF(seg3,''),NULLIF(seg2,''),NULLIF(seg1,''))::float8
                END AS last_seg
         FROM race_sectional_times
         WHERE race_date::text = ANY($1)`,
        [[...sectDates]]
      );
      for (const r of allRes.rows) {
        if (r.last_seg == null) continue;
        const k = `${r.d}|${r.race_no}`;
        if (!raceLastSeg.has(k)) raceLastSeg.set(k, []);
        raceLastSeg.get(k).push(r.last_seg);
      }
      for (const arr of raceLastSeg.values()) arr.sort((a, b) => a - b);
    }
    const segRank = (d, rno, last) => {
      const arr = raceLastSeg.get(`${d}|${rno}`);
      if (!arr || !arr.length || last == null) return null;
      return { rank: arr.filter(x => x < last).length + 1, runners: arr.length };
    };

    // 7. Barrier trials + recent workout log
    const trialsOf   = {};
    const wlByHorse  = {};
    const allTrials  = [];
    if (horseIds.length) {
      const trResult = await pool.query(
        `SELECT horse_id, trial_date, details FROM horse_trials WHERE horse_id = ANY($1) AND trial_date < $2 ORDER BY trial_date DESC`,
        [horseIds, date]
      );
      allTrials.push(...trResult.rows);
      for (const t of trResult.rows) {
        if (!trialsOf[t.horse_id]) trialsOf[t.horse_id] = t;
      }
      const wResult = await pool.query(
        `SELECT horse_id, log_date, workout_type, details FROM horse_workout_log
         WHERE horse_id = ANY($1) AND log_date >= $2::date - 60 AND log_date < $3
         ORDER BY log_date DESC`,
        [horseIds, date, date]
      );
      for (const w of wResult.rows) {
        if (!wlByHorse[w.horse_id]) wlByHorse[w.horse_id] = [];
        wlByHorse[w.horse_id].push(w);
      }
    }

    // 8. 上仗大熱 — 上仗嗰場「全場」（該場全部出賽馬，唔止排位表馬匹）
    //    嘅最低賠率。兩個之前嘅 bug：
    //    (a) 舊 code 只用排位表馬匹嘅賠率計最低 → 真正大熱唔喺排位表時會錯
    //    (b) win_odds 係 numeric → pg 回傳字串，字串比較係字典序（"10"<"9"）
    const prevRaceKeys = [...new Set(rcRows.map(r => {
      const p = prevOf[r.horse_name];
      return p && p.win_odds != null ? `${dateOf(p.race_date)}|${p.race_no}` : null;
    }).filter(Boolean))];
    const favByRace = new Map(); // `${d}|${race_no}` → 全場最低賠率（Number）
    if (prevRaceKeys.length) {
      const favDates = [...new Set(prevRaceKeys.map(k => k.split('|')[0]))];
      const favNos = [...new Set(prevRaceKeys.map(k => Number(k.split('|')[1])))];
      const favRes = await pool.query(
        `SELECT TO_CHAR(race_date,'YYYY-MM-DD') AS d, race_no, MIN(win_odds)::float8 AS min_odds
         FROM race_records
         WHERE race_date::text = ANY($1) AND race_no = ANY($2) AND win_odds IS NOT NULL
         GROUP BY 1, 2`,
        [favDates, favNos]
      );
      for (const r of favRes.rows) favByRace.set(`${r.d}|${r.race_no}`, r.min_odds);
    }

    // 9. Build enriched rows
    const racesByIdx = new Map();
    for (const rc of rcRows) {
      const p        = prevOf[rc.horse_name];
      const prevDate = dateOf(p?.race_date);
      const history  = byHorse[rc.horse_name] || [];

      const currGearTokens = parseGearTokens(rc.gear);
      const prevGearTokens = p ? parseGearTokens(p.gear) : [];

      // 升降班：今仗 vs 上仗班次等級（rank 細 = 高班 → 細咗即係升班）。
      // 基準：race_records 最近一次有效班次；冇嘅話用歷史 racecard 嘅「第N班」
      const currRank = classRankAdv(rc.race_class);
      const prevClass = history.find(r => classRankAdv(r.race_class) != null)?.race_class
        ?? rcClassOf.get(rc.horse_name)
        ?? null;
      const prevRank = classRankAdv(prevClass);
      let classMove = null;
      if (currRank != null && prevRank != null) {
        classMove = currRank < prevRank ? '升班' : currRank > prevRank ? '降班' : '同班';
      }

      const weightDiff      = (rc.actual_weight != null && p?.actual_weight != null) ? rc.actual_weight - p.actual_weight : null;
      const declaredWtDiff  = (rc.declared_weight != null && p?.horse_weight != null) ? rc.declared_weight - p.horse_weight : null;

      let stableMove = null;
      if (rc.trainer_id && p?.trainer_id && rc.trainer_id !== p.trainer_id) {
        const ranWithTrainer = history.some(r => r.trainer_id === rc.trainer_id);
        stableMove = ranWithTrainer ? '已轉倉' : '轉倉初出';
      }

      const distChange = (rc.distance && p?.distance) ? rc.distance - p.distance : null;

      // 最快末段（歷史所有仗）／同場同程最快末段（同馬場同路程）
      let fastestFinal = null;
      let fastestFinalSame = null;
      for (const s of (sectHist.get(rc.horse_name) || [])) {
        if (!fastestFinal || s.last < fastestFinal.last) fastestFinal = s;
        if (
          s.course === rc.racecourse && s.dist === rc.distance &&
          (!fastestFinalSame || s.last < fastestFinalSame.last)
        ) fastestFinalSame = s;
      }
      const withRank = (s) => s
        ? {
            time: +s.last.toFixed(2), date: s.d, pos: s.pos, course: s.course, dist: s.dist,
            ...(segRank(s.d, s.rno, s.last) || {}),
          }
        : null;
      const fastestFinalOut = withRank(fastestFinal);
      const fastestFinalSameOut = withRank(fastestFinalSame);

      // 上仗大熱：上仗賠率 == 該場全場最低賠率（數值比較，非字串）
      let prevFav = null;
      if (p?.win_odds != null && prevDate) {
        const fk = `${prevDate}|${p.race_no}`;
        const minOdds = favByRace.get(fk);
        if (minOdds != null && isFinite(minOdds)) {
          prevFav = Math.abs(parseFloat(p.win_odds) - minOdds) < 1e-9;
        }
      }

      // 賽前試閘：上次出賽之後、今仗之前（嚴格區間），顯示最近一次
      // 距出賽日幾多日 + 晨操紀錄連結
      let trial = null;
      if (rc.horse_id) {
        const cands = [];
        for (const t of allTrials) {
          if (t.horse_id !== rc.horse_id) continue;
          const td = dateOf(t.trial_date);
          if (td >= date) continue;                    // 必須喺今仗之前
          if (prevDate && td <= prevDate) continue;    // 必須喺上次出賽之後
          cands.push({ date: td, days: diffDays(date, td), details: t.details || '', venue: t.venue || '', src: 'trial' });
        }
        for (const w of (wlByHorse[rc.horse_id] || [])) {
          if (w.workout_type !== '試閘') continue;
          const wd = dateOf(w.log_date);
          if (wd >= date) continue;
          if (prevDate && wd <= prevDate) continue;
          cands.push({ date: wd, days: diffDays(date, wd), details: w.details || '', venue: w.venue || '', src: 'workout' });
        }
        cands.sort((a, b) => b.date.localeCompare(a.date));
        if (cands.length) {
          trial = {
            ...cands[0],
            count: cands.length,
            link: `https://racing.hkjc.com/zh-hk/local/information/trackworkresult?horseid=${rc.horse_id}`,
          };
        }
      }

      // 騎師親試：今仗騎師最近一次喺晨操/試閘親自策騎呢匹馬
      // （晨操詳情括號內係騎者名，例如「第4組 (潘頓) 1050M…」或「29.2 26.5 (55.7) (潘明輝)」）
      let jockeyRode = null; // null=無資料 / false=有紀錄但騎師冇親試 / object=最近一次
      if (rc.horse_id && rc.jockey_name) {
        const rows = [];
        for (const w of (wlByHorse[rc.horse_id] || [])) {
          const d = (w.details || '');
          if (!d.includes(rc.jockey_name)) continue;
          const wd = dateOf(w.log_date);
          if (wd >= date) continue;
          rows.push({ date: wd, days: diffDays(date, wd), type: w.workout_type, details: d });
        }
        for (const t of allTrials) {
          if (t.horse_id !== rc.horse_id) continue;
          const d = (t.details || '');
          if (!d.includes(rc.jockey_name)) continue;
          const td = dateOf(t.trial_date);
          if (td >= date) continue;
          rows.push({ date: td, days: diffDays(date, td), type: '試閘', details: d });
        }
        rows.sort((a, b) => b.date.localeCompare(a.date));
        jockeyRode = rows.length
          ? {
              ...rows[0],
              count: rows.length,
              link: `https://racing.hkjc.com/zh-hk/local/information/trackworkresult?horseid=${rc.horse_id}`,
            }
          : false;
      }

      // 騎師是否第一次騎此馬
      let firstRide = null;
      if (rc.jockey_id && history.length > 0) {
        firstRide = !history.some(r => r.jockey_id === rc.jockey_id);
      }

      // 同場同程（歷季 / 今季）
      const accumulate = (r, s) => {
        s.total++;
        if (r.finish_position === 1) s.wins++;
        if (r.finish_position != null && r.finish_position <= 3) s.places++;
        if (r.finish_position != null && r.finish_position > 3) s.losses++;
      };
      const vdAll    = { total: 0, wins: 0, places: 0, losses: 0 };
      const vdSeason = { total: 0, wins: 0, places: 0, losses: 0 };
      for (const r of history) {
        if (r.racecourse === rc.racecourse && (r.track_type || null) === (rc.track_type || null) && r.distance === rc.distance) {
          accumulate(r, vdAll);
          if (dateOf(r.race_date) >= sstart) accumulate(r, vdSeason);
        }
      }

      // 騎練今季合作
      const jtRow = jtMap.get(`${rc.trainer_id}|${rc.jockey_id}`);
      const jtSeason = jtRow ? { total: jtRow.total, wins: jtRow.wins, places: jtRow.places } : null;
      const jtAllRow = jtAllMap.get(`${rc.trainer_id}|${rc.jockey_id}`);
      const jtAll = jtAllRow ? { total: jtAllRow.total, wins: jtAllRow.wins, places: jtAllRow.places } : null;

      // 上仗場地：田草 / 谷草 / 泥地（全天候）
      let prevGround = null;
      if (p) {
        if (p.track_type === 'AWT') prevGround = '泥地';
        else prevGround = p.racecourse === 'HV' ? '谷草' : '田草';
      }

      const note = noteMap.get(rc.horse_name) || '';

      const horse = {
        horse_no: rc.horse_no,
        horse_name: rc.horse_name,
        horse_id: rc.horse_id,
        draw: rc.draw,
        jockey_id: rc.jockey_id,
        jockey_name: rc.jockey_name,
        trainer_id: rc.trainer_id,
        trainer_name: rc.trainer_name,
        current_gear: rc.gear || '',
        prev_gear: p?.gear || '',
        gear_changed: JSON.stringify(currGearTokens) !== JSON.stringify(prevGearTokens),
        class_move: classMove,
        // 報名表符號（HKJC 圖例）：+ 王牌（皇牌）、* 優先出賽（保護權）、
        // R 後備、數字 = 練馬師優先次序。以前誤將 R 當保護權。
        ace: note.includes('+'),
        protected_right: note.includes('*'),
        note_marker: note,
        weight: rc.actual_weight,
        weight_diff: weightDiff,
        rating: rc.rating,
        rating_change: rc.rating_change,
        age: rc.horse_age,
        declared_weight: rc.declared_weight,
        declared_weight_diff: declaredWtDiff,
        stable_move: stableMove,
        prev_pos: p?.finish_position ?? null,
        prev_runners: p?.total_runners ?? null,
        prev_jockey: p?.prev_jockey_name || p?.jockey_id || null,
        prev_jockey_id: p?.jockey_id || null,
        prev_ground: prevGround,
        prev_distance: p?.distance ?? null,
        prev_race_date: prevDate,
        dist_change: distChange,
        fastest_final: fastestFinalOut,
        fastest_final_same: fastestFinalSameOut,
        prev_odds: p?.win_odds ?? null,
        prev_fav: prevFav,
        trial: trial,
        jockey_rode: jockeyRode,
        first_ride: firstRide,
        vd_all: vdAll.total ? vdAll : null,
        vd_season: vdSeason.total ? vdSeason : null,
        jt_season: jtSeason,
        jt_all: jtAll,
        recent_form: rc.recent_form,
      };

      const key = `${rc.race_no}`;
      let race = racesByIdx.get(key);
      if (!race) {
        race = {
          race_no: rc.race_no,
          racecourse: rc.racecourse,
          race_class: rc.race_class,
          distance: rc.distance,
          track_type: rc.track_type,
          going: rc.going,
          horses: [],
        };
        racesByIdx.set(key, race);
      }
      race.horses.push(horse);
    }

    const races = [...racesByIdx.values()].sort((a, b) => a.race_no - b.race_no);
    res.json({ date, sstart, races });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/races/advanced/jt?jockey_id=&trainer_id=&since= ──────────────────
// 騎練合作詳情（高級排位表「騎練今季合作」彈窗用）：
// 該組合自 since 起全部出賽紀錄 + 摘要
router.get('/advanced/jt', async (req, res) => {
  try {
    const { jockey_id, trainer_id } = req.query;
    if (!jockey_id || !trainer_id) {
      return res.status(400).json({ error: '需要 jockey_id 及 trainer_id' });
    }
    const since = req.query.since || seasonStartFor(new Date().toISOString().slice(0, 10));

    const namesRes = await pool.query(
      `SELECT j.name_zh AS jockey_name, t.name_zh AS trainer_name
       FROM jockeys j, trainers t WHERE j.id = $1 AND t.id = $2`,
      [jockey_id, trainer_id]
    );

    const rec = await pool.query(
      `SELECT TO_CHAR(rr.race_date,'YYYY-MM-DD') AS race_date, rr.racecourse, rr.race_no,
              rr.race_class, rr.distance, rr.horse_name, rr.finish_position,
              rr.total_runners, rr.win_odds
       FROM race_records rr
       WHERE rr.jockey_id = $1 AND rr.trainer_id = $2
         AND rr.race_date >= $3 AND rr.finish_position IS NOT NULL
       ORDER BY rr.race_date DESC, rr.race_no DESC
       LIMIT 300`,
      [jockey_id, trainer_id, since]
    );
    const rows = rec.rows;
    const summary = {
      total: rows.length,
      wins: rows.filter(r => r.finish_position === 1).length,
      seconds: rows.filter(r => r.finish_position === 2).length,
      thirds: rows.filter(r => r.finish_position === 3).length,
      places: rows.filter(r => r.finish_position <= 3).length,
    };
    res.json({
      jockey_id, trainer_id, since,
      jockey_name: namesRes.rows[0]?.jockey_name || jockey_id,
      trainer_name: namesRes.rows[0]?.trainer_name || trainer_id,
      summary, records: rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/races/advanced/weight ──────────────────────────────────────────
// 手動更新排位體重（排位表抓取時未必有，可喺高級排位表逐匹補）
router.patch('/advanced/weight', async (req, res) => {
  try {
    const { date, race_no, horse_no, declared_weight } = req.body || {};
    if (!date || race_no == null || horse_no == null) {
      return res.status(400).json({ error: '需要 date、race_no、horse_no' });
    }
    if (declared_weight != null && (typeof declared_weight !== 'number' || declared_weight < 700 || declared_weight > 1500)) {
      return res.status(400).json({ error: '排位體重必須係 700-1500 之間嘅數字（磅）' });
    }
    const r = await pool.query(
      `UPDATE racecard SET declared_weight = $4, updated_at = NOW()
       WHERE race_date = $1 AND race_no = $2 AND horse_no = $3
       RETURNING horse_name, declared_weight`,
      [date, race_no, horse_no, declared_weight]
    );
    if (!r.rows.length) return res.status(404).json({ error: '找不到該排位表紀錄' });
    res.json({ ok: true, ...r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
