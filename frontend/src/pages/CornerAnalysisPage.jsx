import React, { useState, useEffect, useRef, useCallback } from 'react';
import api from '../api';
import UpcomingMatches from '../components/UpcomingMatches';

const LEAGUES = [
  { key: 'EPL', name: '英超' },
  { key: 'MLS', name: '美職' },
  { key: 'BUN', name: '德甲' },
  { key: 'LAL', name: '西甲' },
];
const LINES = [7.5, 8.5, 9.5, 10.5, 11.5, 12.5];

// ── 快速即場面板 ────────────────────────────────────────────────────────────
// 設計原則：3 秒內完成任何更新 → 即時顯示新預測 + edge
// 用法：揀好隊 → 入盤口 → 比賽開始 → 每次角球/入球/分鐘變 → 撳按鈕即重算
function QuickLivePanel({ league, teams }) {
  const [home, setHome] = useState('');
  const [away, setAway] = useState('');
  const [minute, setMinute] = useState(0);
  const [corners, setCorners] = useState(0);
  const [hg, setHg] = useState(0);
  const [ag, setAg] = useState(0);
  const [shotsH, setShotsH] = useState(0);
  const [shotsA, setShotsA] = useState(0);
  const [possession, setPossession] = useState('');
  const [oddsLine, setOddsLine] = useState('9.5');
  const [overOdds, setOverOdds] = useState('');
  const [underOdds, setUnderOdds] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const debounceRef = useRef(null);
  const minuteRef = useRef(null);

  // 自動重算（debounce 400ms — 撳完按鈕即刻觸發）
  const recalc = useCallback(() => {
    if (!home || !away || home === away) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true); setError(null);
      try {
        const params = { league, home, away, minute, corners, hg, ag };
        if (shotsH > 0 || shotsA > 0) { params.shotsH = shotsH; params.shotsA = shotsA; }
        if (possession !== '' && +possession >= 10 && +possession <= 90) params.possession = possession;
        const r = await api.get('/corner/predict-live', { params, timeout: 30000 });
        if (r.data.error) setError(r.data.error);
        else setResult(r.data);
      } catch (e) { setError(e.response?.data?.error || e.message); }
      finally { setLoading(false); }
    }, 400);
  }, [league, home, away, minute, corners, hg, ag, shotsH, shotsA, possession]);

  // 任何狀態變 → 自動重算
  useEffect(() => { if (home && away) recalc(); }, [minute, corners, hg, ag, shotsH, shotsA, possession]);
  useEffect(() => { if (home && away) recalc(); }, [home, away]);

  // 分鐘自動 +1 計時器（每分鐘自動更新）
  const [timerOn, setTimerOn] = useState(false);
  useEffect(() => {
    if (!timerOn) return;
    const t = setInterval(() => setMinute(m => Math.min(95, m + 1)), 60000);
    return () => clearInterval(t);
  }, [timerOn]);

  // Edge 計算
  const edge = (() => {
    if (!result || !overOdds || !underOdds) return null;
    const line = +oddsLine;
    // 由動態線入面搾返對應線嘅概率
    let pOver = null;
    if (result.lines) {
      const k = result.lines.indexOf(line);
      if (k >= 0) pOver = result.probs[String(line)];
    }
    if (pOver == null && result.dist) {
      let over = 0, total = 0;
      for (let t = 0; t < result.dist.length; t++) { total += result.dist[t]; if (t > line) over += pOver = result.dist[t]; }
      pOver = total > 0 ? pOver / total : null;
    }
    if (pOver == null) return null;
    const o = +overOdds, u = +underOdds;
    if (!(o > 1) || !(u > 1)) return null;
    // 市場融合
    const invO = 1 / o, invU = 1 / u;
    const pMkt = invO / (invO + invU);
    const pBlend = 0.15 * pOver + 0.85 * pMkt;
    const eOver = pBlend * o - 1;
    const eUnder = (1 - pBlend) * u - 1;
    const side = eOver >= eUnder ? '大' : '細';
    const e = Math.max(eOver, eUnder);
    const odds = side === '大' ? o : u;
    const p = side === '大' ? pBlend : 1 - pBlend;
    return { side, edge: e, odds, p, kelly: e > 0 ? (e / (odds - 1)) * 0.25 : 0 };
  })();

  const btn = (label, onClick, color = '#032169', size = 'normal') => (
    <button
      onClick={onClick}
      style={{
        background: color, color: '#fff', border: 'none', borderRadius: 6,
        padding: size === 'big' ? '12px 20px' : '6px 12px',
        fontSize: size === 'big' ? '1.2rem' : '0.85rem',
        fontWeight: 700, cursor: 'pointer', minWidth: size === 'big' ? 56 : 36,
      }}
    >{label}</button>
  );

  const statBox = (label, value, color = '#032169') => (
    <div style={{ textAlign: 'center', minWidth: 60 }}>
      <div style={{ fontSize: '0.7rem', color: '#888' }}>{label}</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 800, color, lineHeight: 1.2 }}>{value}</div>
    </div>
  );

  // 揀隊階段
  if (!home || !away) {
    return (
      <div className="ai-card">
        <h4>即場捕捉 — 先揀場次</h4>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.8rem', color: '#556' }}>
            主隊
            <select className="ai-date" value={home} onChange={e => setHome(e.target.value)} style={{ minWidth: 180 }}>
              <option value="">—</option>
              {teams.map(t => <option key={t.team} value={t.team}>{t.team}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.8rem', color: '#556' }}>
            客隊
            <select className="ai-date" value={away} onChange={e => setAway(e.target.value)} style={{ minWidth: 180 }}>
              <option value="">—</option>
              {teams.map(t => <option key={t.team} value={t.team}>{t.team}</option>)}
            </select>
          </label>
        </div>
      </div>
    );
  }

  // 比賽進行中 — 快速操作面板
  return (
    <div>
      {/* 場次 header */}
      <div className="ai-race-head" style={{ marginBottom: 10 }}>
        <span className="ai-badge" style={{ background: '#fff6d6', color: '#8a6d00', fontWeight: 700 }}>
          {home} vs {away}
        </span>
        <button className="ai-fp-btn" onClick={() => { setHome(''); setAway(''); setResult(null); }}>
          揀過第二場
        </button>
      </div>

      {/* ── 核心控制區（一畫面晒晒）── */}
      <div className="ai-card" style={{ border: '2px solid #032169', padding: 14 }}>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center' }}>

          {/* 分鐘 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: '0.7rem', color: '#888' }}>⏱ 分鐘</span>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {btn('−', () => setMinute(m => Math.max(0, m - 1)), '#555')}
              <input
                ref={minuteRef}
                type="number" value={minute}
                onChange={e => setMinute(Math.min(95, Math.max(0, +e.target.value || 0)))}
                onKeyDown={e => { if (e.key === 'Enter') minuteRef.current?.blur(); }}
                style={{ width: 60, textAlign: 'center', fontSize: '1.3rem', fontWeight: 800, padding: '4px 2px', border: '2px solid #032169', borderRadius: 6 }}
              />
              {btn('+', () => setMinute(m => Math.min(95, m + 1)))}
            </div>
            <button
              onClick={() => setTimerOn(t => !t)}
              style={{ fontSize: '0.65rem', padding: '2px 8px', background: timerOn ? '#1e7e34' : '#ccc', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer' }}
            >{timerOn ? '● 自動計時中' : '▶ 自動計時'}</button>
          </div>

          {/* 角球 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: '0.7rem', color: '#888' }}>🚩 角球</span>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {btn('−', () => setCorners(c => Math.max(0, c - 1)), '#555')}
              <div style={{ fontSize: '2rem', fontWeight: 900, color: '#032169', minWidth: 56, textAlign: 'center' }}>{corners}</div>
              {btn('+1', () => setCorners(c => c + 1), '#d4af37', 'big')}
            </div>
          </div>

          {/* 比分 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: '0.7rem', color: '#888' }}>⚽ 比分</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                {statBox(home.slice(0, 3), hg)}
                {btn('+', () => setHg(h => h + 1), '#1e7e34')}
              </div>
              <span style={{ fontSize: '1.2rem', color: '#999' }}>-</span>
              <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                {statBox(away.slice(0, 3), ag)}
                {btn('+', () => setAg(a => a + 1), '#c0392b')}
              </div>
            </div>
          </div>
        </div>

        {/* ── 射門 + 控球（攻勢修正）── */}
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center',
          marginTop: 10, paddingTop: 10, borderTop: '1px dashed #ccd3dc' }}>
          {/* 射門 */}
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <span style={{ fontSize: '0.7rem', color: '#888', fontWeight: 600 }}>🎯 射門</span>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {btn('+', () => setShotsH(s => s + 1), '#032169')}
              <div style={{ textAlign: 'center', minWidth: 40 }}>
                <div style={{ fontSize: '0.6rem', color: '#888' }}>{home.slice(0, 3)}</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#032169' }}>{shotsH}</div>
              </div>
              {btn('−', () => setShotsH(s => Math.max(0, s - 1)), '#555')}
            </div>
            <span style={{ color: '#999' }}>-</span>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {btn('+', () => setShotsA(s => s + 1), '#e67e22')}
              <div style={{ textAlign: 'center', minWidth: 40 }}>
                <div style={{ fontSize: '0.6rem', color: '#888' }}>{away.slice(0, 3)}</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#e67e22' }}>{shotsA}</div>
              </div>
              {btn('−', () => setShotsA(s => Math.max(0, s - 1)), '#555')}
            </div>
          </div>

          {/* 控球 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: '0.7rem', color: '#888', fontWeight: 600 }}>📊 控球</span>
            <input
              type="number" min="10" max="90" placeholder="50"
              value={possession}
              onChange={e => setPossession(e.target.value)}
              style={{ width: 56, textAlign: 'center', fontSize: '1.1rem', fontWeight: 700,
                padding: '3px 2px', border: '1px solid #ccc', borderRadius: 5 }}
            />
            <span style={{ fontSize: '0.75rem', color: '#888' }}>% 主隊</span>
            {possession !== '' && (
              <span style={{ fontSize: '0.75rem', color: '#555' }}>({100 - (+possession || 50)}% 客)</span>
            )}
          </div>

          {/* Dominance 顯示 */}
          {result?.dominance && (shotsH > 0 || shotsA > 0 || possession !== '') && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', background: '#f0f4ff', padding: '4px 12px', borderRadius: 6 }}>
              <span style={{ fontSize: '0.7rem', color: '#556' }}>攻勢修正</span>
              <span style={{ fontWeight: 700, color: result.dominance.home >= 1.2 ? '#1e7e34' : result.dominance.home <= 0.8 ? '#c0392b' : '#555' }}>
                {home.slice(0, 3)} ×{result.dominance.home}
              </span>
              <span style={{ fontWeight: 700, color: result.dominance.away >= 1.2 ? '#1e7e34' : result.dominance.away <= 0.8 ? '#c0392b' : '#555' }}>
                {away.slice(0, 3)} ×{result.dominance.away}
              </span>
            </div>
          )}
        </div>

        {/* 盤口輸入 */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12, paddingTop: 10, borderTop: '1px dashed #ccd3dc' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: '0.72rem', color: '#556' }}>
            盤口線
            <select className="ai-date" value={oddsLine} onChange={e => setOddsLine(e.target.value)} style={{ width: 70 }}>
              {(result?.lines || LINES).map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: '0.72rem', color: '#556' }}>
            大賠率
            <input type="number" step="0.01" className="ai-date" value={overOdds}
              onChange={e => setOverOdds(e.target.value)} placeholder="1.85" style={{ width: 80 }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: '0.72rem', color: '#556' }}>
            細賠率
            <input type="number" step="0.01" className="ai-date" value={underOdds}
              onChange={e => setUnderOdds(e.target.value)} placeholder="1.95" style={{ width: 80 }} />
          </label>
        </div>
      </div>

      {/* 結果 */}
      {loading && <div className="ai-empty" style={{ padding: 14 }}>計算中…</div>}
      {error && <div className="ai-error">{error}</div>}

      {result && !loading && (
        <div className="ai-verdict" style={{
          borderLeft: `5px solid ${edge && edge.edge >= 0.05 ? (edge.side === '大' ? '#1e7e34' : '#c0392b') : '#ccc'}`,
          marginTop: 10,
        }}>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center' }}>
            {statBox('最終期望', result.expCorners)}
            {statBox('剩返', `+${result.expRemaining}`, '#d4af37')}
            {statBox(`P(大 ${oddsLine})`,
              result.probs[String(oddsLine)] != null
                ? (result.probs[String(oddsLine)] * 100).toFixed(0) + '%'
                : '-')}
            {edge && edge.edge >= 0.05 && (
              <>
                <div style={{ textAlign: 'center', padding: '6px 16px', borderRadius: 8,
                  background: edge.side === '大' ? '#1e7e34' : '#c0392b', color: '#fff' }}>
                  <div style={{ fontSize: '0.7rem' }}>建議</div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 900 }}>{edge.side} @ {edge.odds.toFixed(2)}</div>
                </div>
                {statBox('Edge', (edge.edge * 100).toFixed(1) + '%', edge.edge > 0 ? '#1e7e34' : '#c0392b')}
                {statBox('¼ Kelly', (edge.kelly * 100).toFixed(1) + '%', '#032169')}
              </>
            )}
            {edge && edge.edge < 0.05 && (
                <div style={{ color: '#999', fontSize: '0.9rem', fontWeight: 600 }}>{'— 唔落（edge < 5%）'}</div>
            )}
          </div>

          {/* 動態線概率 */}
          <div className="ai-r2-grid" style={{ marginTop: 10 }}>
            {(result.lines || []).map(l => {
              const p = result.probs[String(l)];
              if (p == null) return null;
              return (
                <div className="ai-r2-box" key={l} style={{
                  border: +oddsLine === l ? '2px solid #032169' : undefined,
                  padding: '6px 8px',
                }}>
                  <span className="ai-muted" style={{ fontSize: '0.7rem' }}>大 {l}</span>
                  <span style={{ fontSize: '1.1rem', fontWeight: 800,
                    color: p > 0.55 ? '#1e7e34' : p < 0.45 ? '#c0392b' : '#032169' }}>
                    {(p * 100).toFixed(0)}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 自動追蹤 tab（titan007 即場數據 → 自動預測）──
function AutoTrackTab() {
  const [status, setStatus] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);

  const load = async () => {
    try {
      const r = await api.get('/corner/track/status', { timeout: 10000 });
      setStatus(r.data);
    } catch (_) {}
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const startTracking = async () => {
    setStarting(true); setError(null);
    try {
      const r = await api.post('/corner/track/start', {}, { timeout: 60000 });
      if (r.data.error) setError(r.data.error);
      load();
    } catch (e) { setError(e.response?.data?.message || e.response?.data?.error || e.message); }
    finally { setStarting(false); }
  };

  const stopTracking = async () => {
    try { await api.post('/corner/track/stop', {}, { timeout: 10000 }); load(); } catch (_) {}
  };

  const active = status?.active;
  const matches = status?.matches || [];

  return (
    <div>
      <div className="ai-card" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button className="ai-btn" onClick={startTracking} disabled={starting || active}>
          {starting ? '搵賽事中…' : active ? '追蹤中' : '▶ 開始自動追蹤'}
        </button>
        {active && (
          <button className="ai-btn ai-btn-ghost" onClick={stopTracking}>停止</button>
        )}
        {status?.lastUpdate && (
          <span className="ai-muted" style={{ fontSize: '0.8rem' }}>
            最後更新 {new Date(status.lastUpdate).toLocaleTimeString('zh-HK')}（每 30 秒）
          </span>
        )}
      </div>

      {error && <div className="ai-error">{error}</div>}

      {!active && !matches.length && !error && (
        <div className="ai-empty" style={{ padding: 30 }}>
          撳「開始自動追蹤」→ 自動搵今日英超即場賽事 → 每 30 秒從 titan007 刷新
          比分/角球/控球/射門 → 自動預測角球大細
        </div>
      )}

      {matches.map((m, idx) => (
        <div key={m.titanId} className="ai-card" style={{ marginTop: idx === 0 ? 12 : 10, border: m.data?.status === 'live' ? '2px solid #1e7e34' : '1px solid #dde3ea' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="ai-badge" style={{ fontWeight: 700, fontSize: '0.9rem' }}>
                {m.home} vs {m.away}
              </span>
              {m.data?.minute != null && (
                <span className="ai-badge" style={{ background: '#1e7e34', color: '#fff', fontWeight: 800 }}>
                  {m.data.minute}'
                </span>
              )}
              {m.data?.score && (
                <span style={{ fontSize: '1.2rem', fontWeight: 800, color: '#032169' }}>
                  {m.data.score.hg} - {m.data.score.ag}
                </span>
              )}
              {m.data?.corners && (
                <span className="ai-badge">🚩 {m.data.corners.home}-{m.data.corners.away}</span>
              )}
              {m.data?.possession && (
                <span className="ai-badge">📊 {m.data.possession.home ?? m.data.possession}%-{(m.data.possession.away ?? (100 - m.data.possession))}%</span>
              )}
              {m.data?.shots && (
                <span className="ai-badge">🎯 {m.data.shots.home}-{m.data.shots.away}</span>
              )}
              {m.data?.status === 'finished' && <span className="ai-badge" style={{ background: '#999' }}>完場</span>}
            </div>
            {m.prediction && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', color: '#556' }}>期望角球</span>
                <span style={{ fontSize: '1.6rem', fontWeight: 900, color: '#032169' }}>
                  {m.prediction.expCorners}
                </span>
                {m.prediction.dominance && (
                  <span className="ai-tag">×{m.prediction.dominance.home}/×{m.prediction.dominance.away}</span>
                )}
              </div>
            )}
          </div>

          {m.prediction?.probs && m.prediction?.lines && (
            <div className="ai-r2-grid" style={{ marginTop: 10 }}>
              {m.prediction.lines.map(l => {
                const p = m.prediction.probs[String(l)];
                if (p == null) return null;
                return (
                  <div className="ai-r2-box" key={l} style={{ padding: '4px 8px' }}>
                    <span className="ai-muted" style={{ fontSize: '0.7rem' }}>大 {l}</span>
                    <span style={{ fontSize: '1rem', fontWeight: 800, color: p > 0.55 ? '#1e7e34' : p < 0.45 ? '#c0392b' : '#032169' }}>
                      {(p * 100).toFixed(0)}%
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}

      <UpcomingMatches />
    </div>
  );
}

// ── 賽前預測 tab ────────────────────────────────────────────────────────────
function PredictTab({ league, teams }) {
  const [home, setHome] = useState('');
  const [away, setAway] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const run = async () => {
    if (!home || !away || home === away) { setError('揀兩隊唔同嘅球隊'); return; }
    setLoading(true); setError(null); setResult(null);
    try {
      const r = await api.get('/corner/predict', { params: { league, home, away }, timeout: 120000 });
      if (r.data.error) setError(r.data.error); else setResult(r.data);
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setLoading(false); }
  };

  return (
    <div>
      <div className="ai-card">
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.8rem', color: '#556' }}>
            主隊
            <select className="ai-date" value={home} onChange={e => setHome(e.target.value)} style={{ minWidth: 180 }}>
              <option value="">—</option>
              {teams.map(t => <option key={t.team} value={t.team}>{t.team}（場均 {t.avg_c}）</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.8rem', color: '#556' }}>
            客隊
            <select className="ai-date" value={away} onChange={e => setAway(e.target.value)} style={{ minWidth: 180 }}>
              <option value="">—</option>
              {teams.map(t => <option key={t.team} value={t.team}>{t.team}（場均 {t.avg_c}）</option>)}
            </select>
          </label>
          <button className="ai-btn" onClick={run} disabled={loading || !home || !away}>
            {loading ? '模擬中…' : '預測'}
          </button>
        </div>
      </div>

      {error && <div className="ai-error">{error}</div>}

      {result && (
        <>
          <div className="ai-verdict" style={{ borderLeft: '5px solid #032169' }}>
            <div className="ai-verdict-title" style={{ fontSize: '1.1rem' }}>
              {result.home} vs {result.away}
              <span style={{ marginLeft: 12, color: '#032169' }}>
                期望角球 <b style={{ fontSize: '1.3rem' }}>{result.expCorners}</b>
              </span>
              <span className="ai-muted" style={{ marginLeft: 12, fontSize: '0.85rem' }}>
                （主 {result.expHome} + 客 {result.expAway}｜樣本 {result.sample} 場）
              </span>
            </div>
            <div className="ai-r2-grid" style={{ marginTop: 10 }}>
              {LINES.map(line => {
                const p = result.probs[line];
                if (p == null) return null;
                const pick = p > 0.55 ? '大' : p < 0.45 ? '細' : '';
                return (
                  <div className="ai-r2-box" key={line} style={{ border: pick ? `1px solid ${pick === '大' ? '#1e7e34' : '#c0392b'}` : undefined }}>
                    <span className="ai-muted">大 {line}</span>
                    <span className="ai-r2-num" style={{ color: p > 0.55 ? '#1e7e34' : p < 0.45 ? '#c0392b' : '#032169' }}>
                      {(p * 100).toFixed(1)}%
                    </span>
                    {pick && <span style={{ fontSize: '0.75rem', color: pick === '大' ? '#1e7e34' : '#c0392b', fontWeight: 700 }}>建議 {pick}</span>}
                  </div>
                );
              })}
            </div>
          </div>

          {result.bySlice && (
            <div className="ai-cards">
              <div className="ai-card">
                <h4>切片分佈（每 15 分鐘期望角球）</h4>
                {result.bySlice.map(s => (
                  <div key={s.slice} className="ai-card-row" style={{ display: 'grid', gridTemplateColumns: '60px 1fr 40px 1fr 40px', gap: 8, alignItems: 'center' }}>
                    <span className="ai-muted" style={{ fontSize: '0.78rem' }}>{s.slice}'</span>
                    <div className="ai-bar"><div className="ai-bar-fill" style={{ width: `${Math.min(100, s.home * 60)}%`, background: '#032169' }} /></div>
                    <span className="ai-num">{s.home}</span>
                    <div className="ai-bar"><div className="ai-bar-fill" style={{ width: `${Math.min(100, s.away * 60)}%`, background: '#e67e22' }} /></div>
                    <span className="ai-num">{s.away}</span>
                  </div>
                ))}
                <div className="ai-muted" style={{ fontSize: '0.75rem', marginTop: 6 }}>左：主隊（藍）｜右：客隊（橙）</div>
              </div>

              {result.stateMultipliers && (
                <div className="ai-card">
                  <h4>Game State 乘數</h4>
                  {result.stateMultipliers.map((row, i) => (
                    <div key={i} className="ai-card-row" style={{ display: 'grid', gridTemplateColumns: '60px 1fr 1fr 1fr', gap: 8, fontSize: '0.82rem' }}>
                      <span className="ai-muted">{i * 15}-{i * 15 + 15}'</span>
                      <span style={{ color: '#c0392b' }}>落後 ×{row[-1]?.toFixed(2)}</span>
                      <span style={{ color: '#555' }}>平手 ×{row[0]?.toFixed(2)}</span>
                      <span style={{ color: '#1e7e34' }}>領先 ×{row[1]?.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── 主頁 ────────────────────────────────────────────────────────────────────
export default function CornerAnalysisPage() {
  const [tab, setTab] = useState('live');
  const [league, setLeague] = useState('EPL');
  const [teams, setTeams] = useState([]);

  useEffect(() => {
    api.get('/corner/teams', { params: { league }, timeout: 30000 })
      .then(r => setTeams(r.data.teams || []))
      .catch(() => {});
  }, [league]);

  return (
    <div className="ai-page">
      <div className="ai-head">
        <div>
          <h1 className="ai-title">分析角球</h1>
          <p className="ai-sub">
            即場角球大細 — 揀好場次 → 角球/入球/分鐘一撳即重算 → 盤口對碰顯示 edge + Kelly
          </p>
        </div>
        <div className="ai-head-right">
          <select className="ai-date" value={league} onChange={e => setLeague(e.target.value)}>
            {LEAGUES.map(l => <option key={l.key} value={l.key}>{l.name}</option>)}
          </select>
        </div>
      </div>

      <div className="ai-tabs">
        {[
          { key: 'track', label: '📡 自動追蹤' },
          { key: 'live', label: '⚡ 即場手動' },
          { key: 'predict', label: '賽前預測' },
          { key: 'backtest', label: '回測' },
          { key: 'data', label: '數據狀態' },
        ].map(t => (
          <button key={t.key} className={`ai-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'track' && <AutoTrackTab />}
      {tab === 'predict' && <PredictTab league={league} teams={teams} />}
      {tab === 'live' && <QuickLivePanel league={league} teams={teams} />}
      {tab === 'backtest' && <BacktestTab league={league} setLeague={setLeague} />}
      {tab === 'data' && <DataTab />}
    </div>
  );
}

// ── 回測 tab（簡化，沿用之前邏輯）──
function BacktestTab({ league, setLeague }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [pl, setPl] = useState(null);

  const run = async () => {
    setLoading(true); setError(null); setPl(null);
    try {
      const [bt, plr] = await Promise.all([
        api.get('/corner/backtest', { params: { league }, timeout: 300000 }),
        api.get('/corner/odds-pl', { params: { league, threshold: 5 }, timeout: 300000 }).catch(() => null),
      ]);
      if (bt.data.error) setError(bt.data.error); else setData(bt.data);
      if (plr && plr.data && !plr.data.error) setPl(plr.data);
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setLoading(false); }
  };

  return (
    <div>
      <div className="ai-card">
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.8rem', color: '#556' }}>
            聯賽
            <select className="ai-date" value={league} onChange={e => { setLeague(e.target.value); }}>
              {LEAGUES.map(l => <option key={l.key} value={l.key}>{l.name}</option>)}
            </select>
          </label>
          <button className="ai-btn" onClick={run} disabled={loading}>
            {loading ? '回測中（walk-forward）…' : '執行回測'}
          </button>
        </div>
        <div className="ai-muted" style={{ fontSize: '0.78rem', marginTop: 6 }}>
          Walk-forward：每月用之前所有數據重新擬合 → 預測該月每場
        </div>
      </div>

      {error && <div className="ai-error">{error}</div>}
      {loading && <div className="ai-empty">回測中…</div>}

      {data && !loading && (
        <>
          <div className="ai-r2-grid" style={{ marginTop: 14 }}>
            <div className="ai-r2-box">
              <span className="ai-muted">樣本</span>
              <span className="ai-r2-num">{data.sample}</span>
              <span className="ai-muted">場（walk-forward）</span>
            </div>
            <div className="ai-r2-box">
              <span className="ai-muted">RMSE</span>
              <span className="ai-r2-num">{data.rmse}</span>
              <span className="ai-muted">基準（全估10.5）{data.baselineRmse}</span>
            </div>
            <div className="ai-r2-box">
              <span className="ai-muted">平均預測 vs 實際</span>
              <span className="ai-r2-num">{data.avgExp} / {data.avgActual}</span>
              <span className="ai-muted">角球</span>
            </div>
            <div className="ai-r2-box">
              <span className="ai-muted">模擬大細命中率</span>
              <span className="ai-r2-num">{data.simulatedBet.hitRate != null ? `${data.simulatedBet.hitRate}%` : '-'}</span>
              <span className="ai-muted">{data.simulatedBet.n} 注</span>
            </div>
          </div>

          {/* 校準表 */}
          <div className="ai-card" style={{ marginTop: 14 }}>
            <h4>校準（用 Crown 終盤線計 P(大)）</h4>
            <table className="ai-table">
              <thead><tr><th>預測概率檔</th><th className="ai-num">場次</th><th className="ai-num">平均預測 P</th><th className="ai-num">實際大出率</th></tr></thead>
              <tbody>
                {data.calibration.map(c => (
                  <tr key={c.bucket}>
                    <td>{c.bucket}</td>
                    <td className="ai-num">{c.n}</td>
                    <td className="ai-num">{c.avgP ?? '-'}</td>
                    <td className="ai-num" style={{ fontWeight: 700 }}>{c.actualOverRate ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="ai-muted" style={{ fontSize: '0.75rem', marginTop: 6 }}>
              校準好 = 「平均預測 P」同「實際大出率」貼近
            </div>
          </div>

          {/* Crown 真實 P/L */}
          {pl && (
            <div className="ai-card" style={{ border: '1px solid #d4af37' }}>
              <h4>Crown 真實 P/L（edge ≥ {pl.threshold}%・市場融合 w=0.15）</h4>
              <div className="ai-r2-grid">
                <div className="ai-r2-box"><span className="ai-muted">投注</span><span className="ai-r2-num">{pl.bets}</span></div>
                <div className="ai-r2-box"><span className="ai-muted">命中率</span><span className="ai-r2-num">{pl.hitRate}%</span></div>
                <div className="ai-r2-box"><span className="ai-muted">ROI</span><span className="ai-r2-num" style={{ color: pl.roi > 0 ? '#1e7e34' : '#c0392b' }}>{pl.roi}%</span></div>
              </div>
              {pl.detail && pl.detail.length > 0 && (
                <div style={{ marginTop: 10, maxHeight: 300, overflowY: 'auto' }}>
                  <table className="ai-table">
                    <thead><tr><th>日期</th><th>主隊</th><th>客隊</th><th className="ai-num">線</th><th>落</th><th className="ai-num">@賠率</th><th className="ai-num">模型P</th><th className="ai-num">BlendP</th><th className="ai-num">edge</th><th className="ai-num">實際</th><th>結果</th></tr></thead>
                    <tbody>
                      {pl.detail.map((b, i) => (
                        <tr key={i}>
                          <td className="ai-mono">{b.date}</td>
                          <td>{b.home.slice(0, 12)}</td>
                          <td>{b.away.slice(0, 10)}</td>
                          <td className="ai-num">{b.line}</td>
                          <td style={{ fontWeight: 700, color: b.side === '大' ? '#1e7e34' : '#c0392b' }}>{b.side}</td>
                          <td className="ai-num">{b.odds?.toFixed(2)}</td>
                          <td className="ai-num">{b.pModel != null ? (b.pModel * 100).toFixed(0) + '%' : '-'}</td>
                          <td className="ai-num">{(b.pOver * 100).toFixed(0)}%</td>
                          <td className="ai-num">+{b.edge}%</td>
                          <td className="ai-num" style={{ fontWeight: 700 }}>{b.actual}</td>
                          <td style={{ color: b.result === '贏' ? '#1e7e34' : '#c0392b', fontWeight: 700 }}>{b.result}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* 最近 30 場 */}
          <div className="ai-card">
            <h4>最近 30 場預測 vs 實際</h4>
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
              <table className="ai-table">
                <thead><tr><th>日期</th><th>主隊</th><th>客隊</th><th className="ai-num">預測</th><th className="ai-num">實際</th><th className="ai-num">終盤</th><th className="ai-num">P(大終盤)</th><th className="ai-num">結果</th></tr></thead>
                <tbody>
                  {data.perMatch.map((m, i) => (
                    <tr key={i}>
                      <td className="ai-mono">{m.d}</td>
                      <td>{m.home}</td>
                      <td>{m.away}</td>
                      <td className="ai-num">{m.exp}</td>
                      <td className="ai-num" style={{ fontWeight: 700 }}>{m.actual}</td>
                      <td className="ai-num" style={{ color: '#d4af37', fontWeight: 700 }}>{m.line}</td>
                      <td className="ai-num">{m.pLine != null ? (m.pLine * 100).toFixed(0) + '%' : '-'}</td>
                      <td className="ai-num" style={{ color: m.actual > m.line ? '#1e7e34' : '#c0392b', fontWeight: 700 }}>{m.actual > m.line ? '大' : '細'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── 數據狀態 tab ──
function DataTab() {
  const [leagues, setLeagues] = useState([]);
  const [status, setStatus] = useState(null);

  const load = async () => {
    try {
      const [l, s] = await Promise.all([
        api.get('/corner/leagues'),
        api.get('/corner/scrape/status', { timeout: 10000 }),
      ]);
      setLeagues(l.data.leagues || []);
      setStatus(s.data);
    } catch (_) {}
  };
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  const scrape = async (lg) => {
    try { await api.post('/corner/scrape', { league: lg }, { timeout: 15000 }); load(); } catch (_) {}
  };

  return (
    <div>
      <div className="ai-card">
        <h4>數據覆蓋</h4>
        <table className="ai-table">
          <thead><tr><th>聯賽</th><th>賽季</th><th className="ai-num">場數</th><th>日期</th><th className="ai-num">場均角球</th></tr></thead>
          <tbody>
            {leagues.map(l => (
              <tr key={`${l.league}-${l.season}`}>
                <td>{l.league}</td><td>{l.season}</td>
                <td className="ai-num" style={{ fontWeight: 700 }}>{l.matches}</td>
                <td className="ai-mono">{l.from_d} → {l.to_d}</td>
                <td className="ai-num">{l.avg_corners}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ai-card">
        <h4>抓取 WhoScored</h4>
        <div style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
          {LEAGUES.map(l => (
            <button key={l.key} className="ai-btn" disabled={status?.active} onClick={() => scrape(l.key)}>抓 {l.name}</button>
          ))}
        </div>
        {status?.active && <div style={{ fontWeight: 700, color: '#032169' }}>{status.done}/{status.total}</div>}
      </div>
      <div className="ai-card">
        <h4>Crown 盤口庫</h4>
        <div className="ai-muted" style={{ fontSize: '0.8rem' }}>
          792 場初終盤已入庫（三季）・titan007 抓取器：<code>docker compose run --rm backend node scripts/_scrape_titan_v2.js &lt;startId&gt; &lt;endId&gt;</code>
        </div>
      </div>
    </div>
  );
}
