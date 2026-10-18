// ── 即場自動追蹤 job ───────────────────────────────────────────────────────
// 自動搵今日英超賽事 → 每 30 秒刷新 titan007 live 頁 → 提取全部即場數據
// → 餵入 predictLive → 前端直接攞最新預測（唔使人手入任何嘢）
const pool = require('../db/pool');
const titanLive = require('../football/titanLive');
const cornerlib = require('../football/cornerlib');

const state = {
  active: false,
  matches: [],       // [{ titanId, home, away, league, data: null, prediction: null }]
  lastUpdate: null,
  error: null,
};

let _interval = null;

async function start() {
  if (state.active) return { busy: true };
  state.active = true;
  state.error = null;
  state.matches = [];

  try {
    // 1) 搵今日 + 聽日四大聯賽賽事（簡體聯賽名精確匹配）
    const liveIds = await titanLive.findLiveIds(['英超', '德甲', '西甲', '美职业']);
    console.log(`[liveTracker] 搵到 ${liveIds.length} 場即場（英超+美職+德甲+西甲）`);
    if (!liveIds.length) {
      state.error = '今日冇英超/美職即場賽事';
      state.active = false;
      return { error: state.error };
    }

    // 2) 初始化每場（聯賽由 leagueName 判）
    for (const m of liveIds) {
      const lg = m.leagueName || '';
      const league = lg === '美职业' ? 'MLS' : lg === '德甲' ? 'BUN' : lg === '西甲' ? 'LAL' : 'EPL';
      state.matches.push({
        titanId: m.titanId,
        home: titanLive.mapTeam(m.text.split(/VS|vs/)[0]?.trim()),
        away: titanLive.mapTeam(m.text.split(/VS|vs/)[1]?.trim()),
        league,
        data: null,
        prediction: null,
      });
    }

    // 3) 立即刷新一次
    await refresh();

    // 4) 每 30 秒自動刷新
    _interval = setInterval(refresh, 30000);

    return { total: state.matches.length };
  } catch (e) {
    state.error = e.message;
    state.active = false;
    return { error: e.message };
  }
}

function stop() {
  if (_interval) clearInterval(_interval);
  _interval = null;
  state.active = false;
  titanLive.closeBrowser();
}

async function refresh() {
  if (!state.active) return;
  try {
    // 每場獨立刷新
    for (const m of state.matches) {
      if (m.data?.status === 'finished') continue;
      const data = await titanLive.scrapeLiveMatch(m.titanId);
      if (!data || data.minute == null) continue;
      m.data = data;

      // 更新隊名（首次）
      if (data.teams && !m.home) {
        m.home = titanLive.mapTeam(data.teams.home);
        m.away = titanLive.mapTeam(data.teams.away);
      }

      // 自動預測（按聯賽獨立擬合）— 角球 + 入球
      // 角球：開場頭幾分鐘統計區未必有數 → 當 0 角球照計
      const liveOpts = {
        minute: data.minute,
        hg: data.score?.hg || 0,
        ag: data.score?.ag || 0,
        shotsH: data.shots?.home ?? null,
        shotsA: data.shots?.away ?? null,
        possession: data.possession?.home ?? null,
      };
      if (data.minute > 0) {
        try {
          const fitEntry = await getFit(m.league || 'EPL');
          if (fitEntry) {
            const totalCorners = (data.corners?.home || 0) + (data.corners?.away || 0);
            const pred = cornerlib.predictLive(
              fitEntry.fit, fitEntry.stateMul.m,
              m.home, m.away,
              { ...liveOpts, corners: totalCorners },
              10000
            );
            if (!pred.error) m.prediction = pred;
          }
        } catch (_) { /* 預測失敗唔阻斷追蹤 */ }
      }
      if (data.minute > 0) {
        try {
          const fitEntry = await getFit(m.league || 'EPL');
          if (fitEntry) {
            const gp = cornerlib.predictGoals(fitEntry.fit, m.home, m.away, liveOpts, 10000);
            if (!gp.error) m.goalPrediction = gp;
          }
        } catch (_) { /* 預測失敗唔阻斷追蹤 */ }
      }
    }
    // 完場賽事唔再顯示
    state.matches = state.matches.filter(m => m.data?.status !== 'finished');
    state.lastUpdate = new Date().toISOString();
  } catch (e) {
    state.error = e.message;
  }
}

// fit 快取（同 /api/corner/predict 共用邏輯）
const _fitCache = new Map();
async function getFit(league) {
  const hit = _fitCache.get(league);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit;
  const data = await cornerlib.loadLeague(league);
  if (!data || data.length < 40) return null;
  const fit = cornerlib.fitModel(data);
  const stateMul = cornerlib.fitStateMultipliers(data);
  const entry = { at: Date.now(), fit, stateMul, n: data.length };
  _fitCache.set(league, entry);
  return entry;
}

function getStatus() {
  const { tcOne } = require('../football/tcNames');
  return {
    active: state.active,
    lastUpdate: state.lastUpdate,
    error: state.error,
    matches: state.matches.map(m => ({
      titanId: m.titanId,
      home: tcOne(m.home),
      away: tcOne(m.away),
      league: m.league,
      data: m.data,
      prediction: m.prediction ? {
        expCorners: m.prediction.expCorners,
        expRemaining: m.prediction.expRemaining,
        lines: m.prediction.lines,
        probs: m.prediction.probs,
        dominance: m.prediction.dominance,
      } : null,
      goalPrediction: m.goalPrediction ? {
        expGoals: m.goalPrediction.expGoals,
        probs: m.goalPrediction.probs,
        btts: m.goalPrediction.btts,
      } : null,
    })),
  };
}

module.exports = { start, stop, getStatus };
