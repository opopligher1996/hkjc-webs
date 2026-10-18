// ── 球隊名 → 繁體顯示名轉換 ────────────────────────────────────────────────
// 鏈：英文名 →(CN_MAP 反轉)→ titan簡體名 →(team_alias)→ HKJC繁體名
// DB/模型照用原名・呢個只係 API 回應嘅顯示層轉換
const pool = require('../db/pool');

let _tcMap = { at: 0, map: new Map() }; // titan名(simplified) → hkjc繁體

async function refreshTcMap() {
  if (Date.now() - _tcMap.at < 10 * 60 * 1000) return _tcMap.map;
  try {
    const { rows } = await pool.query('SELECT titan_name, hkjc_name FROM team_alias');
    const m = new Map();
    const isCjk = s => /[\u4e00-\u9fff]/.test(s || '');
    for (const r of rows) {
      const cur = m.get(r.titan_name);
      // 一個 titan 名可能對多個 HKJC 名：中文名優先過英文名
      if (cur == null || (!isCjk(cur) && isCjk(r.hkjc_name))) m.set(r.titan_name, r.hkjc_name);
    }
    _tcMap = { at: Date.now(), map: m };
  } catch (_) {}
  return _tcMap.map;
}

const CN_MAP = require('./titanSchedule').CN_MAP || {};
// 英文 → titan簡體（CN_MAP 反轉）
const EN2CN = new Map(Object.entries(CN_MAP).map(([cn, en]) => [en, cn]));

function tcOne(name) {
  if (!name || typeof name !== 'string') return name;
  // 已經係繁體（含繁體字或 HKJC 名）→ 原樣
  const m = _tcMap.map;
  if (!m.size) return name;
  // 1) 直接係 titan 名
  if (m.has(name)) return m.get(name);
  // 2) 英文名 → titan 名 → 繁體
  const cn = EN2CN.get(name);
  if (cn && m.has(cn)) return m.get(cn);
  // 3) 名入面帶住簡體字 — 嘗試 includes 匹配 alias key？太危險，直接返
  return name;
}

async function tcNames(names) {
  await refreshTcMap();
  return names;
}

module.exports = { tcOne, refreshTcMap };
