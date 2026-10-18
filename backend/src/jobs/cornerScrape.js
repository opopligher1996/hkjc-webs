// 角球數據回補 job（WhoScored 抓取）
// start({league, seasonLabel}) → 逐月 fixtures → 逐場事件 → DB
// 狀態記憶體追蹤（同 trackwork/sectional 模式）
const ws = require('../football/whoscored');
const pool = require('../db/pool');

const state = {
  active: false, league: null, season: null,
  total: 0, done: 0, saved: 0, failed: 0,
  current: null, finishedAt: null, log: [],
};

function pushLog(msg) {
  state.log.push(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
  if (state.log.length > 30) state.log.shift();
}

async function start({ league, season }) {
  if (state.active) return { busy: true };
  const seasons = await ws.getSeasons(league);
  const target = season
    ? seasons.find(s => s.label === season || s.season === season)
    : seasons[0]; // 最新賽季
  if (!target) return { error: '找不到賽季' };

  Object.assign(state, {
    active: true, league, season: target.label,
    total: 0, done: 0, saved: 0, failed: 0, current: null, finishedAt: null, log: [],
  });
  pushLog(`${league} ${target.label} 開始（season ${target.seasonId} / stage ${target.stageId}）`);

  (async () => {
    try {
      // 已有嘅賽事（跳過）
      const exist = new Set(
        (await pool.query(`SELECT id FROM football_matches WHERE league=$1 AND season=$2`,
          [league, target.season])).rows.map(r => String(r.id)));
      const fixtures = await ws.getFixtures(league, target);
      pushLog(`fixtures 搵到 ${fixtures.length} 場（已有 ${exist.size}）`);
      // 只抓已完成（FT）嘅賽事 — 未開賽嘅冇事件，省時間
      const todo = fixtures.filter(f => !exist.has(String(f.id)) && f.ft);
      state.total = todo.length;

      // 逐場抓（有日期 + 有比分 = 已完成）
      for (const f of todo) {
        state.current = `${f.date} ${f.homeSlug} vs ${f.awaySlug}`;
        try {
          const ev = await ws.scrapeMatch(f.url);
          if (ev && ev.corners && ev.corners.length + ev.goals.length > 0) {
            const home = f.homeSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            const away = f.awaySlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            const n = await ws.saveMatch(
              { id: f.id, league, season: target.season, date: f.date, home, away }, ev);
            state.saved++;
            pushLog(`✓ ${f.date} ${home} ${ev.goals.filter(g => g.isHome).length}-${ev.goals.filter(g => !g.isHome).length} ${away}（角球 ${ev.corners.length}，事件 ${n}）`);
          } else {
            state.failed++;
            pushLog(`✗ ${f.date} ${f.homeSlug}：冇事件數據`);
          }
          await ws.sleep(1500 + Math.random() * 1000);
        } catch (e) {
          state.failed++;
          pushLog(`✗ ${f.homeSlug}：${e.message.slice(0, 60)}`);
          await ws.sleep(3000);
        }
        state.done++;
      }
      pushLog(`完成：${state.saved} 場儲存，${state.failed} 失敗`);
    } catch (e) {
      pushLog(`FATAL: ${e.message}`);
    } finally {
      state.active = false;
      state.current = null;
      state.finishedAt = new Date().toISOString();
      await ws.closeBrowser();
    }
  })();

  return { total: state.total, season: target.label };
}

function getStatus() { return { ...state }; }

module.exports = { start, getStatus };
