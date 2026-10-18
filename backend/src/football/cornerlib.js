// ── 角球模型（time-slicing + game state，按 Gemini 對話規格）────────────────
// 結構：
//   1) 每隊 × 每個 15 分鐘切片：角球攻擊力/防守力（乘法 Poisson，Dixon-Coles 式）
//   2) 入球模型（同結構）→ Monte Carlo 生成比分時間線 → game state 佔比
//   3) Game-state 乘數 m[slice][state]（落後隊多角球 — 由歷史事件實測）
//   4) 模擬 20k 場 → 全場角球分佈 → P(大 7.5–12.5)
const pool = require('../db/pool');

const SLICES = 6;                 // 0-15,15-30,30-45,45-60,60-75,75-90+
const K_SHRINK = 40;              // game state 乘數收縮先驗
// ── 過度離散參數（λ 干擾 σ）──
// 令模擬分佈加闊，修正模型過度自信（P=83% 實際只有 50%）。
// 每次模擬對每隊抽一個 noise = exp(σ×N(0,1))，乘落嗰隊全部切片嘅 λ。
// 等效 Negative Binomial：Var = μ + μ²(e^(σ²)-1)。
// σ=0.20 時對 μ=10：Var ≈ 10 + 100×0.041 ≈ 14.1（過度離散比 1.41）
let SIGMA_LAMBDA = 0.10;
function randn() {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const sliceOf = (m) => Math.min(SLICES - 1, Math.max(0, Math.floor(m / 15)));

// ── 載入數據 ──
async function loadLeague(league, beforeDate) {
  const matches = (await pool.query(
    `SELECT id, match_date::text d, home_team, away_team, home_goals, away_goals, home_corners, away_corners
     FROM football_matches
     WHERE league = $1 AND home_corners IS NOT NULL
       ${beforeDate ? 'AND match_date < $2' : ''}
     ORDER BY match_date`, beforeDate ? [league, beforeDate] : [league])).rows;
  if (!matches.length) return null;
  const ids = matches.map(m => m.id);
  const events = (await pool.query(
    `SELECT match_id, minute, is_home, event_type FROM football_match_events
     WHERE match_id = ANY($1) AND event_type IN ('corner','goal')`, [ids])).rows;
  const byMatch = new Map();
  for (const e of events) {
    if (!byMatch.has(e.match_id)) byMatch.set(e.match_id, { corners: [], goals: [] });
    const b = byMatch.get(e.match_id);
    if (e.event_type === 'corner') b.corners.push({ m: e.minute, h: e.is_home });
    else b.goals.push({ m: e.minute, h: e.is_home });
  }
  return matches.map(m => ({
    ...m, ...(byMatch.get(m.id) || { corners: [], goals: [] }),
  }));
}

// ── 擬合：隊伍切片攻防 × 入球模型 ──
function fitModel(data) {
  const teams = new Set();
  data.forEach(m => { teams.add(m.home_team); teams.add(m.away_team); });
  const teamList = [...teams];
  const T = new Map(teamList.map(t => [t, t]));

  // 初始化
  const cAtt = new Map(teamList.map(t => [t, Array(SLICES).fill(1)]));   // 角球攻
  const cDef = new Map(teamList.map(t => [t, Array(SLICES).fill(1)]));   // 角球守
  const gAtt = new Map(teamList.map(t => [t, Array(SLICES).fill(1)]));
  const gDef = new Map(teamList.map(t => [t, Array(SLICES).fill(1)]));
  // 聯賽基準（每切片主/客）
  const cBase = { h: Array(SLICES).fill(0), a: Array(SLICES).fill(0) };
  const gBase = { h: Array(SLICES).fill(0), a: Array(SLICES).fill(0) };
  const nH = data.length, nA = data.length;

  // 角球/入球基準率
  data.forEach(m => {
    m.corners.forEach(c => { const s = sliceOf(c.m); cBase[c.h ? 'h' : 'a'][s]++; });
    m.goals.forEach(g => { const s = sliceOf(g.m); gBase[g.h ? 'h' : 'a'][s]++; });
  });
  for (let s = 0; s < SLICES; s++) {
    cBase.h[s] = Math.max(0.02, cBase.h[s] / nH); cBase.a[s] = Math.max(0.02, cBase.a[s] / nA);
    gBase.h[s] = Math.max(0.01, gBase.h[s] / nH); gBase.a[s] = Math.max(0.01, gBase.a[s] / nA);
  }

  // 乘法更新（20 輪收斂）
  for (let iter = 0; iter < 20; iter++) {
    const cAttAcc = new Map(teamList.map(t => [t, Array(SLICES).fill(0)]));
    const cAttExp = new Map(teamList.map(t => [t, Array(SLICES).fill(0)]));
    const cDefAcc = new Map(teamList.map(t => [t, Array(SLICES).fill(0)]));
    const cDefExp = new Map(teamList.map(t => [t, Array(SLICES).fill(0)]));
    const gAttAcc = new Map(teamList.map(t => [t, Array(SLICES).fill(0)]));
    const gAttExp = new Map(teamList.map(t => [t, Array(SLICES).fill(0)]));
    const gDefAcc = new Map(teamList.map(t => [t, Array(SLICES).fill(0)]));
    const gDefExp = new Map(teamList.map(t => [t, Array(SLICES).fill(0)]));

    data.forEach(m => {
      const H = m.home_team, A = m.away_team;
      for (let s = 0; s < SLICES; s++) {
        // 期望值
        const ehC = cBase.h[s] * cAtt.get(H)[s] * cDef.get(A)[s];
        const eaC = cBase.a[s] * cAtt.get(A)[s] * cDef.get(H)[s];
        const ehG = gBase.h[s] * gAtt.get(H)[s] * gDef.get(A)[s];
        const eaG = gBase.a[s] * gAtt.get(A)[s] * gDef.get(H)[s];
        // 實際
        const ahC = m.corners.filter(c => c.h && sliceOf(c.m) === s).length;
        const aaC = m.corners.filter(c => !c.h && sliceOf(c.m) === s).length;
        const ahG = m.goals.filter(g => g.h && sliceOf(g.m) === s).length;
        const aaG = m.goals.filter(g => !g.h && sliceOf(g.m) === s).length;
        cAttAcc.get(H)[s] += ahC; cAttExp.get(H)[s] += ehC;
        cAttAcc.get(A)[s] += aaC; cAttExp.get(A)[s] += eaC;
        cDefAcc.get(A)[s] += ahC; cDefExp.get(A)[s] += ehC;
        cDefAcc.get(H)[s] += aaC; cDefExp.get(H)[s] += eaC;
        gAttAcc.get(H)[s] += ahG; gAttExp.get(H)[s] += ehG;
        gAttAcc.get(A)[s] += aaG; gAttExp.get(A)[s] += eaG;
        gDefAcc.get(A)[s] += ahG; gDefExp.get(A)[s] += ehG;
        gDefAcc.get(H)[s] += aaG; gDefExp.get(H)[s] += eaG;
      }
    });
    const upd = (map, acc, exp) => {
      for (const [t, arr] of map) for (let s = 0; s < SLICES; s++) {
        if (exp.get(t)[s] > 1e-6) {
          arr[s] = arr[s] * ((acc.get(t)[s] + 0.5) / (exp.get(t)[s] + 0.5));  // +0.5 收縮
          arr[s] = Math.min(2.8, Math.max(0.2, arr[s]));
        }
      }
    };
    upd(cAtt, cAttAcc, cAttExp); upd(cDef, cDefAcc, cDefExp);
    upd(gAtt, gAttAcc, gAttExp); upd(gDef, gDefAcc, gDefExp);
  }

  // 每隊場數（predict 時做收縮加權）
  const games = new Map(teamList.map(t => [t, 0]));
  data.forEach(m => { games.set(m.home_team, games.get(m.home_team) + 1); games.set(m.away_team, games.get(m.away_team) + 1); });
  return { teams: teamList, cBase, gBase, cAtt, cDef, gAtt, gDef, games, n: data.length };
}

// ── Game state 乘數 m[slice][state]（-1 落後 / 0 平 / +1 領先，球隊視角）──
function fitStateMultipliers(data) {
  const cnt = Array.from({ length: SLICES }, () => ({ '-1': 0, '0': 0, '1': 0 }));
  const exp = Array.from({ length: SLICES }, () => ({ '-1': 0, '0': 0, '1': 0 }));
  data.forEach(m => {
    // 每個 slice 每隊嘅 state（由入球時間線計）
    for (const side of [true, false]) {
      let hg = 0, ag = 0, prevMin = 0;
      const goals = [...m.goals].sort((a, b) => a.m - b.m);
      const stateAt = (min) => {
        const my = side ? hg : ag, opp = side ? ag : hg;
        return my > opp ? 1 : my < opp ? -1 : 0;
      };
      // slice 佔比：用 15 分鐘內 state 變化時點分段
      for (let s = 0; s < SLICES; s++) {
        const from = s * 15, to = from + 15;
        let cursor = from;
        const changes = goals.filter(g => g.m > from && g.m <= to).map(g => g.m);
        const pts = [...new Set(changes)].sort((a, b) => a - b);
        for (const pt of [...pts, to]) {
          const dur = pt - cursor;
          if (dur > 0) {
            // 用 cursor 時點嘅 state；角球歸屬呢段
            const st = stateAt(Math.max(0, cursor - 0.1));
            const cornersHere = m.corners.filter(c =>
              (c.h === side) && c.m > cursor && c.m <= pt && sliceOf(c.m) === s).length;
            exp[s][st] += dur / 15;
            cnt[s][st] += cornersHere;
            cursor = pt;
          }
          // 更新比分
          goals.filter(g => Math.abs(g.m - pt) < 1e-9).forEach(g => {
            if (g.h) hg++; else ag++;
          });
        }
      }
    }
  });
  // 乘數（收縮）：m = (cnt/exp) / (Σcnt/Σexp)，log 空間壓向 1
  const m = [];
  for (let s = 0; s < SLICES; s++) {
    const row = {};
    const totC = cnt[s][-1] + cnt[s][0] + cnt[s][1];
    const totE = exp[s][-1] + exp[s][0] + exp[s][1];
    const base = totE > 0 ? totC / totE : 1;
    for (const st of [-1, 0, 1]) {
      const n = exp[s][st] * base;                    // 期望角球數（等效樣本）
      const rate = exp[s][st] > 0 ? cnt[s][st] / exp[s][st] : base;
      const shrunk = (rate * n + base * K_SHRINK) / (n + K_SHRINK);
      row[st] = Math.min(2.5, Math.max(0.4, shrunk / (base || 1)));
    }
    m.push(row);
  }
  return { m, cnt, exp };
}

// ── 預測：Monte Carlo ──
function poisson(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function predict(fit, stateMul, home, away, nSims = 20000) {
  const missing = [];
  if (!fit.cAtt.has(home)) missing.push(home);
  if (!fit.cAtt.has(away)) missing.push(away);
  if (missing.length) return { error: '球隊唔喺數據庫', missing };

  const cLH = [], cLA = [], gLH = [], gLA = [];   // 每切片 λ
  for (let s = 0; s < SLICES; s++) {
    cLH.push(fit.cBase.h[s] * fit.cAtt.get(home)[s] * fit.cDef.get(away)[s]);
    cLA.push(fit.cBase.a[s] * fit.cAtt.get(away)[s] * fit.cDef.get(home)[s]);
    gLH.push(fit.gBase.h[s] * fit.gAtt.get(home)[s] * fit.gDef.get(away)[s]);
    gLA.push(fit.gBase.a[s] * fit.gAtt.get(away)[s] * fit.gDef.get(home)[s]);
  }

  // ── 收縮：細樣本球隊拉返聯賽平均（避免過度自信）＋ λ 上限 ──
  const gH = fit.games.get(home) || 0, gA = fit.games.get(away) || 0;
  const w = Math.min(gH, gA) / (Math.min(gH, gA) + 6);      // 6 場半收縮
  const clampL = (v) => Math.min(3.5, Math.max(0.05, v));
  for (let s = 0; s < SLICES; s++) {
    const baseH = (fit.cBase.h[s] + fit.cBase.a[s]) / 2;
    cLH[s] = clampL(baseH + w * (cLH[s] - baseH));
    cLA[s] = clampL(baseH + w * (cLA[s] - baseH));
    gLH[s] = Math.min(1.8, Math.max(0.02, gLH[s]));
    gLA[s] = Math.min(1.8, Math.max(0.02, gLA[s]));
  }

  // 強度調節（實證：強隊落後角球率 +43%）— kH/kA 俾 state 乘數用
  const leagueAvg = cLH.reduce((a, b) => a + b, 0) / 2 + cLA.reduce((a, b) => a + b, 0) / 2;
  const kH = strengthK(cLH.reduce((a, b) => a + b, 0), leagueAvg);
  const kA = strengthK(cLA.reduce((a, b) => a + b, 0), leagueAvg);

  const totals = new Float64Array(60);             // 0..59 角球直方圖
  let sumH = 0, sumA = 0;
  const stateCornerSum = Array.from({ length: SLICES }, () => ({ '-1': 0, '0': 0, '1': 0 }));

  for (let sim = 0; sim < nSims; sim++) {
    // ── λ 干擾：每隊每次模擬抽一個 noise（保持切片間相關性）──
    const noiseH = Math.exp(SIGMA_LAMBDA * randn());
    const noiseA = Math.exp(SIGMA_LAMBDA * randn());
    // 1) 入球時間（每切片入面隨機分佈分鐘）
    const goals = [];
    for (let s = 0; s < SLICES; s++) {
      for (let i = poisson(gLH[s]); i > 0; i--) goals.push({ m: s * 15 + Math.random() * 15, h: true });
      for (let i = poisson(gLA[s]); i > 0; i--) goals.push({ m: s * 15 + Math.random() * 15, h: false });
    }
    goals.sort((a, b) => a.m - b.m);
    // 2) 每隊每切片 state 佔比
    const occ = (side) => {
      const out = Array.from({ length: SLICES }, () => ({ '-1': 0, '0': 0, '1': 0 }));
      let hg = 0, ag = 0, gi = 0;
      for (let s = 0; s < SLICES; s++) {
        const from = s * 15, to = from + 15;
        let cursor = from;
        while (gi < goals.length && goals[gi].m < to) {
          const pt = goals[gi].m;
          const my = side ? hg : ag, opp = side ? ag : hg;
          const st = my > opp ? 1 : my < opp ? -1 : 0;
          out[s][st] += (pt - cursor) / 15;
          while (gi < goals.length && Math.abs(goals[gi].m - pt) < 1e-9) {
            if (goals[gi].h) hg++; else ag++; gi++;
          }
          cursor = pt;
        }
        const my = side ? hg : ag, opp = side ? ag : hg;
        const st = my > opp ? 1 : my < opp ? -1 : 0;
        out[s][st] += (to - cursor) / 15;
      }
      return out;
    };
    const occH = occ(true), occA = occ(false);
    // 3) 角球 ~ Poisson(λ × Σ occ×m)
    let ch = 0, ca = 0;
    for (let s = 0; s < SLICES; s++) {
      let lh = 0, la = 0;
      for (const st of [-1, 0, 1]) {
        lh += occH[s][st] * stateMulTeam(stateMul, s, st, kH);
        la += occA[s][st] * stateMulTeam(stateMul, s, st, kA);
      }
      const kh = poisson(cLH[s] * lh * noiseH);
      const ka = poisson(cLA[s] * la * noiseA);
      ch += kh; ca += ka;
      for (const st of [-1, 0, 1]) {
        stateCornerSum[s][st] += (occH[s][st] * kh * lh / (lh || 1)) + (occA[s][st] * ka * la / (la || 1));
      }
    }
    const t = ch + ca;
    totals[Math.min(59, t)]++;
    sumH += ch; sumA += ca;
  }

  // 大細概率
  const probs = {};
  for (const line of [7.5, 8.5, 9.5, 10.5, 11.5, 12.5]) {
    let over = 0;
    for (let t = 0; t < 60; t++) if (t > line) over += totals[t];
    probs[line] = +(over / nSims).toFixed(3);
  }
  let mean = 0;
  for (let t = 0; t < 60; t++) mean += t * totals[t];
  mean /= nSims;

  // 切片分佈（每場期望角球）
  const bySlice = [];
  for (let s = 0; s < SLICES; s++) {
    bySlice.push({
      slice: `${s * 15}-${s * 15 + 15}`,
      home: +(cLH[s] * [stateMul[s][-1], stateMul[s][0], stateMul[s][1]].reduce((a, b) => a + b, 0) / 3).toFixed(2),
      away: +(cLA[s] * [stateMul[s][-1], stateMul[s][0], stateMul[s][1]].reduce((a, b) => a + b, 0) / 3).toFixed(2),
    });
  }

  return {
    home, away, nSims, sample: fit.n,
    expCorners: +(mean).toFixed(2),
    expHome: +(sumH / nSims).toFixed(2),
    expAway: +(sumA / nSims).toFixed(2),
    probs, bySlice, dist: Array.from(totals).slice(0, 26),
  };
}

// ── 強度調節嘅 state 乘數（810 場實證：強隊落後 2.85 vs 弱隊落後 2.00 角球/場）──
// k ∈ [0.4, 1.6]：強隊落後效應放大、弱隊收細；領先效應反向對稱
function strengthK(expTeam, leagueAvg) {
  if (!leagueAvg) return 1;
  const ratio = expTeam / leagueAvg;                    // 1 = 聯盟平均
  return Math.max(0.4, Math.min(1.6, 0.5 + ratio * 0.5)); // ratio 1.2→1.1, 1.4→1.2… 較保守
}
function stateMulTeam(m, s, st, k) {
  if (st === 0) return m[s][0];
  const base = m[s][0];
  if (st === -1) return base + (m[s][-1] - base) * k;          // 落後 × k
  return base + (m[s][1] - base) * (2 - k);                    // 領先 × (2-k)
}

// ── 即場預測：條件模擬（目前分鐘 + 目前角球 + 目前比分）──
// 模擬剩返時間嘅入球 → state → 剩返角球 → 總數 = 目前 + 剩返
function predictLive(fit, stateMul, home, away, opts, nSims = 20000) {
  if (!fit.cAtt.has(home) || !fit.cAtt.has(away)) return { error: '球隊唔喺數據庫' };
  const { minute = 0, corners = 0, hg = 0, ag = 0,
          shotsH = null, shotsA = null, possession = null } = opts || {};
  const M = Math.max(0, Math.min(90, +minute || 0));
  const C = Math.max(0, +corners || 0);

  // ── Dominance ratio（即場攻勢修正）──
  // 用實際射門 + 控球 vs「預期」嘅比率，調整剩返角球 λ。
  // 預期射門 = 12 × (M/90)；預期控球 = 50%。
  // dominance = (實際射門/預期)^0.6 × (實際控球/預期)^0.4，夾喺 [0.3, 3.0]
  let domH = 1, domA = 1;
  const expShots = Math.max(0.5, 12 * M / 90);
  if (shotsH != null || possession != null) {
    const sH = shotsH != null ? Math.max(0, +shotsH) : expShots;         // 冇入就當正常
    const sA = shotsA != null ? Math.max(0, +shotsA) : expShots;
    const pH = possession != null ? Math.max(10, Math.min(90, +possession)) : 50;
    const pA = 100 - pH;
    const shotRH = Math.pow(sH / expShots, 0.6);
    const shotRA = Math.pow(sA / expShots, 0.6);
    const possRH = Math.pow(pH / 50, 0.4);
    const possRA = Math.pow(pA / 50, 0.4);
    domH = Math.max(0.3, Math.min(3.0, shotRH * possRH));
    domA = Math.max(0.3, Math.min(3.0, shotRA * possRA));
  }

  // 基礎 λ（同 predict：收縮 + 上限）
  const w = Math.min(fit.games.get(home) || 0, fit.games.get(away) || 0);
  const wgt = w / (w + 6);
  const clampL = (v) => Math.min(3.5, Math.max(0.05, v));
  const cLH = [], cLA = [], gLH = [], gLA = [], frac = [];
  for (let s = 0; s < SLICES; s++) {
    const baseH = (fit.cBase.h[s] + fit.cBase.a[s]) / 2;
    let lh = clampL(baseH + wgt * (fit.cBase.h[s] * fit.cAtt.get(home)[s] * fit.cDef.get(away)[s] - baseH));
    let la = clampL(baseH + wgt * (fit.cBase.a[s] * fit.cAtt.get(away)[s] * fit.cDef.get(home)[s] - baseH));
    const end = (s + 1) * 15;
    const from = s * 15;
    const f = Math.max(0, Math.min(1, (end - Math.max(M, from)) / 15));   // 呢片剩返幾多
    frac.push(f);
    cLH.push(lh * f * domH); cLA.push(la * f * domA);
    gLH.push(Math.min(1.8, Math.max(0.02, fit.gBase.h[s] * fit.gAtt.get(home)[s] * fit.gDef.get(away)[s])) * f);
    gLA.push(Math.min(1.8, Math.max(0.02, fit.gBase.a[s] * fit.gAtt.get(away)[s] * fit.gDef.get(home)[s])) * f);
  }
  // 強度調節（同 predict）
  const leagueAvg2 = cLH.reduce((a, b) => a + b, 0) / 2 + cLA.reduce((a, b) => a + b, 0) / 2;
  const kH = strengthK(cLH.reduce((a, b) => a + b, 0), leagueAvg2);
  const kA = strengthK(cLA.reduce((a, b) => a + b, 0), leagueAvg2);

  const totals = new Float64Array(60);
  let sumH = C * 0.5, sumA = C * 0.5;   // 目前角球主客分佈未知，各半
  for (let sim = 0; sim < nSims; sim++) {
    // λ 干擾（同 predict：保持切片間相關性）
    const noiseH = Math.exp(SIGMA_LAMBDA * randn());
    const noiseA = Math.exp(SIGMA_LAMBDA * randn());
    const goals = [];
    for (let s = 0; s < SLICES; s++) {
      if (frac[s] <= 0) continue;
      for (let i = poisson(gLH[s]); i > 0; i--) goals.push({ m: Math.max(M, s * 15) + Math.random() * (frac[s] * 15), h: true });
      for (let i = poisson(gLA[s]); i > 0; i--) goals.push({ m: Math.max(M, s * 15) + Math.random() * (frac[s] * 15), h: false });
    }
    goals.sort((a, b) => a.m - b.m);
    // state 佔比（由目前比分起）
    const occ = (side) => {
      const out = Array.from({ length: SLICES }, () => ({ '-1': 0, '0': 0, '1': 0 }));
      let h = +hg || 0, a = +ag || 0, gi = 0;
      for (let s = 0; s < SLICES; s++) {
        if (frac[s] <= 0) continue;
        const from = Math.max(M, s * 15), to = s * 15 + frac[s] * 15;
        let cursor = from;
        while (gi < goals.length && goals[gi].m < to) {
          const pt = goals[gi].m;
          const my = side ? h : a, opp = side ? a : h;
          out[s][my > opp ? 1 : my < opp ? -1 : 0] += (pt - cursor) / 15;
          while (gi < goals.length && Math.abs(goals[gi].m - pt) < 1e-9) { if (goals[gi].h) h++; else a++; gi++; }
          cursor = pt;
        }
        const my = side ? h : a, opp = side ? a : h;
        out[s][my > opp ? 1 : my < opp ? -1 : 0] += (to - cursor) / 15;
      }
      return out;
    };
    const occH = occ(true), occA = occ(false);
    let extra = 0;
    for (let s = 0; s < SLICES; s++) {
      if (frac[s] <= 0) continue;
      let lh = 0, la = 0;
      for (const st of [-1, 0, 1]) { lh += occH[s][st] * stateMulTeam(stateMul, s, st, kH); la += occA[s][st] * stateMulTeam(stateMul, s, st, kA); }
      // λ 用「每完整切片」率 × 剩返比例
      extra += poisson((cLH[s] / frac[s]) * lh * frac[s] * noiseH) + poisson((cLA[s] / frac[s]) * la * frac[s] * noiseA);
    }
    const t = C + extra;
    totals[Math.min(59, t)]++;
    sumH += 0; sumA += 0;
  }
  // 動態盤口線：以期望角球為中心 ±2.5（例：期望 5.76 → 中心 5.5 → 線 3.5–8.5）
  let mean = 0;
  for (let t = 0; t < 60; t++) mean += t * totals[t];
  mean /= nSims;
  const center = Math.floor(mean) + 0.5;
  const liveLines = [];
  for (let i = -2; i <= 3; i++) {
    const l = +(center + i).toFixed(1);
    if (l >= 0.5) liveLines.push(l);
  }
  const probs = {};
  for (const line of liveLines) {
    let over = 0;
    for (let t = 0; t < 60; t++) if (t > line) over += totals[t];
    probs[line] = +(over / nSims).toFixed(3);
  }
  return {
    home, away, live: true, minute: M, currentCorners: C, score: `${hg}-${ag}`,
    nSims, expCorners: +mean.toFixed(2), expRemaining: +(mean - C).toFixed(2),
    probs, lines: liveLines, dist: Array.from(totals).slice(0, 26),
    dominance: { home: +domH.toFixed(2), away: +domA.toFixed(2) },
    inputs: { shotsH, shotsA, possession },
  };
}

// ── 市場融合（同賽馬 blendWithMarket 同一概念）────────────────────────────
// P_final = w × P_model + (1-w) × P_market（Crown 終盤隱含概率）
// BLEND_W 由 tune_blend_corners.js 掃描擬合（預計 0.2-0.3）
let BLEND_W = 0.15;

function blendWithMarket(pOverModel, overOdds, underOdds, w = BLEND_W) {
  if (!overOdds || !underOdds || overOdds <= 1 || underOdds <= 1) return pOverModel;
  const invOver = 1 / overOdds;
  const invUnder = 1 / underOdds;
  const sum = invOver + invUnder;
  if (sum <= 0) return pOverModel;
  const pMarket = invOver / sum;   // 市場隱含 P(大)
  return w * pOverModel + (1 - w) * pMarket;
}

// ── 入球預測（利用已有嘅入球模擬 → 輸出入球總數分佈）────────────────────
// 入球 λ 已在 predict()/predictLive() 內計算同模擬，呢度獨立輸出
const GOAL_LINES = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5];

function predictGoals(fit, home, away, opts = {}, nSims = 20000) {
  if (!fit.gAtt.has(home) || !fit.gAtt.has(away)) return { error: '球隊唔喺數據庫' };
  const { minute = 0, hg = 0, ag = 0, shotsH = null, shotsA = null, possession = null } = opts || {};
  const M = Math.max(0, Math.min(90, +minute || 0));

  // Dominance ratio（同角球：射門+控球 → 調整入球 λ）
  let domH = 1, domA = 1;
  const expShots = Math.max(0.5, 12 * M / 90);
  if (shotsH != null || possession != null) {
    const sH = shotsH != null ? Math.max(0, +shotsH) : expShots;
    const sA = shotsA != null ? Math.max(0, +shotsA) : expShots;
    const pH = possession != null ? Math.max(10, Math.min(90, +possession)) : 50;
    const pA = 100 - pH;
    domH = Math.max(0.3, Math.min(3.0, Math.pow(sH / expShots, 0.5) * Math.pow(pH / 50, 0.3)));
    domA = Math.max(0.3, Math.min(3.0, Math.pow(sA / expShots, 0.5) * Math.pow(pA / 50, 0.3)));
  }

  const w = Math.min(fit.games.get(home) || 0, fit.games.get(away) || 0);
  const wgt = w / (w + 6);
  const gLH = [], gLA = [];
  for (let s = 0; s < SLICES; s++) {
    let end = (s + 1) * 15, from = s * 15;
    let f = M > 0 ? Math.max(0, Math.min(1, (end - Math.max(M, from)) / 15)) : 1;
    if (f <= 0) { gLH.push(0); gLA.push(0); continue; }
    const baseH = (fit.gBase.h[s] + fit.gBase.a[s]) / 2;
    let lh = Math.min(1.8, Math.max(0.02, fit.gBase.h[s] * fit.gAtt.get(home)[s] * fit.gDef.get(away)[s]));
    let la = Math.min(1.8, Math.max(0.02, fit.gBase.a[s] * fit.gAtt.get(away)[s] * fit.gDef.get(home)[s]));
    gLH.push(lh * f * domH); gLA.push(la * f * domA);
  }

  const totals = new Float64Array(16);
  for (let sim = 0; sim < nSims; sim++) {
    const noise = Math.exp(0.12 * randn());
    let g = (+hg || 0) + (+ag || 0);
    for (let s = 0; s < SLICES; s++) {
      g += poisson(gLH[s] * noise) + poisson(gLA[s] * noise);
    }
    totals[Math.min(15, g)]++;
  }

  const probs = {};
  for (const line of GOAL_LINES) {
    let over = 0;
    for (let t = 0; t < 16; t++) if (t > line) over += totals[t];
    probs[line] = +(over / nSims).toFixed(3);
  }
  let mean = 0;
  for (let t = 0; t < 16; t++) mean += t * totals[t];
  mean /= nSims;

  // BTTS（兩隊都有入球）— 簡化計法：用主客 λ 獨立 Poisson
  const expH = gLH.reduce((a, b) => a + b, 0);
  const expA = gLA.reduce((a, b) => a + b, 0);
  const pH = (+hg || 0) > 0 ? 1 : (1 - Math.exp(-expH));
  const pA = (+ag || 0) > 0 ? 1 : (1 - Math.exp(-expA));
  const btts = +(pH * pA).toFixed(3);

  return {
    home, away, nSims, live: M > 0, minute: M,
    currentGoals: (+hg || 0) + (+ag || 0),
    expGoals: +mean.toFixed(2),
    expHome: null, expAway: null,
    probs, btts,
    lines: GOAL_LINES,
    dist: Array.from(totals).slice(0, 10),
  };
}

// 計主客期望（用 λ 直接算，唔使模擬）
function expGoalsByTeam(fit, home, away, opts = {}) {
  const { minute = 0 } = opts;
  const M = Math.max(0, Math.min(90, +minute || 0));
  let eh = 0, ea = 0;
  for (let s = 0; s < SLICES; s++) {
    const end = (s + 1) * 15, from = s * 15;
    const f = M > 0 ? Math.max(0, Math.min(1, (end - Math.max(M, from)) / 15)) : 1;
    if (f <= 0) continue;
    eh += Math.min(1.8, Math.max(0.02, fit.gBase.h[s] * fit.gAtt.get(home)[s] * fit.gDef.get(away)[s])) * f;
    ea += Math.min(1.8, Math.max(0.02, fit.gBase.a[s] * fit.gAtt.get(away)[s] * fit.gDef.get(home)[s])) * f;
  }
  return { home: +eh.toFixed(2), away: +ea.toFixed(2) };
}

module.exports = { loadLeague, fitModel, fitStateMultipliers, predict, predictLive,
  sliceOf, SLICES, SIGMA_LAMBDA, setSigma, BLEND_W, blendWithMarket,
  predictGoals, expGoalsByTeam, GOAL_LINES };
let _sigmaBackup = null;
function setSigma(v) { /* runtime 覆蓋用 */ const m = module.exports; if (v != null) { _sigmaBackup = SIGMA_LAMBDA; SIGMA_LAMBDA = v; } }
