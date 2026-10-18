import React, { useState, useEffect, useRef, useCallback } from 'react';
import api from '../api';
import UpcomingMatches from '../components/UpcomingMatches';

const LEAGUES = [
  { key: 'EPL', name: '英超' },
  { key: 'BUN', name: '德甲' },
  { key: 'LAL', name: '西甲' },
];
const GOAL_LINES = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5];

export default function GoalAnalysisPage() {
  const [tab, setTab] = useState('track');
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
          <h1 className="ai-title">入球分析</h1>
          <p className="ai-sub">
            全場入球大細模型 — 每隊按 6 個 15 分鐘切片擬合入球攻防力，
            Monte Carlo 模擬 → P(大/細 0.5-5.5) + BTTS。共用角球模型嘅 game state 基建。
          </p>
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
      {tab === 'live' && <LiveTab league={league} teams={teams} onLeagueChange={setLeague} />}
      {tab === 'predict' && <PredictTab league={league} teams={teams} onLeagueChange={setLeague} />}
      {tab === 'backtest' && <BacktestTab league={league} setLeague={setLeague} />}
      {tab === 'data' && <DataTab />}
    </div>
  );
}

// ── 自動追蹤（共用 corner liveTracker，顯示入球預測）──
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
    } catch (e) { setError(e.response?.data?.message || e.message); }
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
        {active && <button className="ai-btn ai-btn-ghost" onClick={stopTracking}>停止</button>}
        {status?.lastUpdate && (
          <span className="ai-muted" style={{ fontSize: '0.8rem' }}>
            最後更新 {new Date(status.lastUpdate).toLocaleTimeString('zh-HK')}（每 30 秒）
          </span>
        )}
      </div>
      {error && <div className="ai-error">{error}</div>}

      {!active && !matches.length && !error && (
        <div className="ai-empty" style={{ padding: 30 }}>
          自動搵今日英超/美職/德甲/西甲即場賽事 → 每 30 秒 titan007 刷新比分/角球/控球/射門 → 同時預測入球大細
        </div>
      )}

      {matches.map((m, idx) => (
        <div key={m.titanId} className="ai-card" style={{ marginTop: idx === 0 ? 12 : 10, border: m.data?.status === 'live' ? '2px solid #1e7e34' : '1px solid #dde3ea' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="ai-badge" style={{ fontWeight: 700 }}>{m.home} vs {m.away}</span>
              <span className="ai-badge">{m.league}</span>
              {m.data?.minute != null && <span className="ai-badge" style={{ background: '#1e7e34', color: '#fff', fontWeight: 800 }}>{m.data.minute}'</span>}
              {m.data?.score && (
                <span style={{ fontSize: '1.2rem', fontWeight: 800, color: '#032169' }}>
                  {m.data.score.hg} - {m.data.score.ag}
                </span>
              )}
              {m.data?.corners && <span className="ai-badge">🚩 {m.data.corners.home}-{m.data.corners.away}</span>}
              {m.data?.possession && (
                <span className="ai-badge">📊 {m.data.possession.home ?? m.data.possession}%-{(m.data.possession.away ?? (100 - m.data.possession))}%</span>
              )}
              {m.data?.shots && (
                <span className="ai-badge">🎯 {m.data.shots.home}-{m.data.shots.away}</span>
              )}
              {m.data?.status === 'finished' && <span className="ai-badge" style={{ background: '#999' }}>完場</span>}
            </div>
            {m.goalPrediction && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', color: '#556' }}>期望入球</span>
                <span style={{ fontSize: '1.6rem', fontWeight: 900, color: '#032169' }}>
                  {m.goalPrediction.expGoals?.toFixed(2)}
                </span>
                {m.goalPrediction.btts != null && (
                  <span className="ai-tag">BTTS {(m.goalPrediction.btts * 100).toFixed(0)}%</span>
                )}
              </div>
            )}
          </div>

          {m.goalPrediction?.probs && (
            <div className="ai-r2-grid" style={{ marginTop: 10 }}>
              {Object.entries(m.goalPrediction.probs).map(([l, p]) => (
                <div className="ai-r2-box" key={l} style={{ padding: '4px 8px' }}>
                  <span className="ai-muted" style={{ fontSize: '0.7rem' }}>大 {l}</span>
                  <span style={{ fontSize: '1rem', fontWeight: 800, color: p > 0.55 ? '#1e7e34' : p < 0.45 ? '#c0392b' : '#032169' }}>
                    {(p * 100).toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      <UpcomingMatches />
    </div>
  );
}

// ── 回測 tab ──
function BacktestTab({ league, setLeague }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const run = async () => {
    setLoading(true); setError(null);
    try {
      const r = await api.get('/goals/backtest', { params: { league }, timeout: 600000 });
      if (r.data.error) setError(r.data.error); else setData(r.data);
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { run(); }, [league]);

  return (
    <div>
      <div className="ai-card">
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.8rem', color: '#556' }}>
            聯賽
            <select className="ai-date" value={league} onChange={e => setLeague(e.target.value)}>
              {LEAGUES.map(l => <option key={l.key} value={l.key}>{l.name}</option>)}
            </select>
          </label>
          <button className="ai-btn" onClick={run} disabled={loading}>
            {loading ? '回測中…' : '執行回測'}
          </button>
        </div>
      </div>

      {error && <div className="ai-error">{error}</div>}
      {loading && <div className="ai-empty">回測中（walk-forward）…</div>}

      {data && !loading && (
        <>
          <div className="ai-r2-grid" style={{ marginTop: 14 }}>
            <div className="ai-r2-box">
              <span className="ai-muted">樣本</span>
              <span className="ai-r2-num">{data.sample}</span>
              <span className="ai-muted">場</span>
            </div>
            <div className="ai-r2-box">
              <span className="ai-muted">模型 log-loss</span>
              <span className="ai-r2-num">{data.modelLL}</span>
            </div>
            <div className="ai-r2-box">
              <span className="ai-muted">市場 log-loss</span>
              <span className="ai-r2-num">{data.marketLL}</span>
              <span className="ai-muted">{data.modelLL > data.marketLL ? '模型較弱' : '模型較強'}</span>
            </div>
            <div className="ai-r2-box">
              <span className="ai-muted">模擬 ROI</span>
              <span className="ai-r2-num" style={{ color: data.roi > 0 ? '#1e7e34' : '#c0392b' }}>
                {data.roi != null ? (data.roi > 0 ? '+' : '') + data.roi + '%' : '-'}
              </span>
              <span className="ai-muted">{data.bets} 注（edge≥5%）</span>
            </div>
          </div>

          <div className="ai-card" style={{ marginTop: 14 }}>
            <h4>校準（P(大終盤) vs 實際開大率）</h4>
            <table className="ai-table">
              <thead><tr><th>預測概率檔</th><th className="ai-num">場次</th><th className="ai-num">平均P</th><th className="ai-num">實際開大率</th></tr></thead>
              <tbody>
                {data.calibration.map((c, i) => (
                  <tr key={i}>
                    <td>{c.bucket}</td>
                    <td className="ai-num">{c.n}</td>
                    <td className="ai-num">{c.avgP ?? '-'}</td>
                    <td className="ai-num" style={{ fontWeight: 700 }}>{c.actualOverRate ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.p70 && data.p70.count > 0 && (
            <div className="ai-card" style={{ border: '1px solid #d4af37' }}>
              <h4>P(大終盤) ≥ 70%</h4>
              <div className="ai-r2-grid">
                <div className="ai-r2-box"><span className="ai-muted">場次</span><span className="ai-r2-num">{data.p70.count}</span></div>
                <div className="ai-r2-box"><span className="ai-muted">開大率</span><span className="ai-r2-num">{data.p70.rate}%</span></div>
              </div>
              {data.p70.detail && data.p70.detail.length > 0 && (
                <div style={{ marginTop: 10, maxHeight: 200, overflowY: 'auto' }}>
                  <table className="ai-table">
                    <thead><tr><th>日期</th><th>賽事</th><th className="ai-num">線</th><th className="ai-num">P</th><th className="ai-num">實際</th><th>結果</th></tr></thead>
                    <tbody>
                      {data.p70.detail.map((m, i) => (
                        <tr key={i}>
                          <td className="ai-mono">{m.d}</td>
                          <td>{m.h} vs {m.a}</td>
                          <td className="ai-num">{m.line}</td>
                          <td className="ai-num">{(m.p * 100).toFixed(0)}%</td>
                          <td className="ai-num" style={{ fontWeight: 700 }}>{m.actual}</td>
                          <td style={{ color: m.over ? '#1e7e34' : '#c0392b', fontWeight: 700 }}>{m.over ? '大' : '細'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {data.perMatch && data.perMatch.length > 0 && (
            <div className="ai-card">
              <h4>最近 20 場預測 vs 實際</h4>
              <div style={{ maxHeight: 250, overflowY: 'auto' }}>
                <table className="ai-table">
                  <thead><tr><th>日期</th><th>主隊</th><th>客隊</th><th className="ai-num">預測</th><th className="ai-num">實際</th><th className="ai-num">線</th><th className="ai-num">P(大)</th><th>結果</th></tr></thead>
                  <tbody>
                    {data.perMatch.map((m, i) => (
                      <tr key={i}>
                        <td className="ai-mono">{m.d}</td>
                        <td>{m.h}</td>
                        <td>{m.a}</td>
                        <td className="ai-num">{m.exp}</td>
                        <td className="ai-num" style={{ fontWeight: 700 }}>{m.actual}</td>
                        <td className="ai-num">{m.line}</td>
                        <td className="ai-num">{(m.p * 100).toFixed(0)}%</td>
                        <td style={{ color: m.over ? '#1e7e34' : '#c0392b', fontWeight: 700 }}>{m.over ? '大' : '細'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── 即場手動 ──
function LiveTab({ league, teams, onLeagueChange }) {
  const [home, setHome] = useState('');
  const [away, setAway] = useState('');
  const [minute, setMinute] = useState(0);
  const [hg, setHg] = useState(0);
  const [ag, setAg] = useState(0);
  const [shotsH, setShotsH] = useState(0);
  const [shotsA, setShotsA] = useState(0);
  const [possession, setPossession] = useState('');
  const [overOdds, setOverOdds] = useState('');
  const [underOdds, setUnderOdds] = useState('');
  const [line, setLine] = useState('2.5');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const run = useCallback(async () => {
    if (!home || !away) return;
    setLoading(true); setError(null);
    try {
      const params = { league, home, away, minute, hg, ag };
      if (shotsH > 0 || shotsA > 0) { params.shotsH = shotsH; params.shotsA = shotsA; }
      if (possession !== '' && +possession >= 10 && +possession <= 90) params.possession = possession;
      const r = await api.get('/goals/predict', { params, timeout: 60000 });
      if (r.data.error) setError(r.data.error); else setResult(r.data);
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setLoading(false); }
  }, [league, home, away, minute, hg, ag, shotsH, shotsA, possession]);

  useEffect(() => { if (home && away) run(); }, [minute, hg, ag, shotsH, shotsA, possession, home, away]);

  const btn = (label, onClick, color = '#032169') => (
    <button onClick={onClick} style={{ background: color, color: '#fff', border: 'none', borderRadius: 5,
      padding: '6px 12px', fontSize: '0.85rem', fontWeight: 700, cursor: 'pointer', minWidth: 34 }}>{label}</button>
  );

  const edge = (() => {
    if (!result || !overOdds || !underOdds) return null;
    const pOver = result.probs[String(line)];
    if (pOver == null) return null;
    const o = +overOdds, u = +underOdds;
    if (!(o > 1) || !(u > 1)) return null;
    const eOver = pOver * o - 1;
    const eUnder = (1 - pOver) * u - 1;
    const side = eOver >= eUnder ? '大' : '細';
    const e = Math.max(eOver, eUnder);
    return { side, edge: e };
  })();

  return (
    <div>
      {!home || !away ? (
        <div className="ai-card">
          <h4>即場入球 — 先揀場次</h4>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.8rem', color: '#556' }}>
              聯賽
              <select className="ai-date" value={league} onChange={e => { setHome(''); setAway(''); setResult(null); onLeagueChange(e.target.value); }} style={{ minWidth: 120 }}>
                {LEAGUES.map(l => <option key={l.key} value={l.key}>{l.name}</option>)}
              </select>
            </label>
            <TeamSelect label="主隊" value={home} onChange={setHome} teams={teams} />
            <TeamSelect label="客隊" value={away} onChange={setAway} teams={teams} />
          </div>
        </div>
      ) : (
        <>
          <div className="ai-card" style={{ border: '2px solid #032169', padding: 14 }}>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: '0.7rem', color: '#888' }}>⏱ 分鐘</span>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  {btn('−', () => setMinute(m => Math.max(0, m - 1)), '#555')}
                  <input type="number" value={minute} onChange={e => setMinute(Math.min(95, Math.max(0, +e.target.value || 0)))}
                    style={{ width: 60, textAlign: 'center', fontSize: '1.2rem', fontWeight: 800, padding: '4px 2px', border: '2px solid #032169', borderRadius: 6 }} />
                  {btn('+', () => setMinute(m => Math.min(95, m + 1)))}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: '0.7rem', color: '#888' }}>⚽ 比分</span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                    <span style={{ fontSize: '1.5rem', fontWeight: 800, color: '#032169', minWidth: 36, textAlign: 'center' }}>{hg}</span>
                    {btn('+', () => setHg(h => h + 1), '#1e7e34')}
                  </div>
                  <span style={{ fontSize: '1rem', color: '#999' }}>-</span>
                  <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                    <span style={{ fontSize: '1.5rem', fontWeight: 800, color: '#e67e22', minWidth: 36, textAlign: 'center' }}>{ag}</span>
                    {btn('+', () => setAg(a => a + 1), '#c0392b')}
                  </div>
                 </div>
               </div>

              {/* 射門 + 控球（入球 dominance） */}
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center',
                marginTop: 10, paddingTop: 10, borderTop: '1px dashed #ccd3dc' }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <span style={{ fontSize: '0.7rem', color: '#888', fontWeight: 600 }}>🎯 射門</span>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    {btn('+', () => setShotsH(s => s + 1), '#032169')}
                    <span style={{ fontSize: '1.2rem', fontWeight: 800, color: '#032169', minWidth: 36, textAlign: 'center' }}>{shotsH}</span>
                  </div>
                  <span style={{ color: '#999' }}>-</span>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    {btn('+', () => setShotsA(s => s + 1), '#e67e22')}
                    <span style={{ fontSize: '1.2rem', fontWeight: 800, color: '#e67e22', minWidth: 36, textAlign: 'center' }}>{shotsA}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: '0.7rem', color: '#888', fontWeight: 600 }}>📊 控球</span>
                  <input type="number" min="10" max="90" placeholder="50" value={possession}
                    onChange={e => setPossession(e.target.value)}
                    style={{ width: 52, textAlign: 'center', fontSize: '1rem', fontWeight: 700, padding: '3px 2px', border: '1px solid #ccc', borderRadius: 5 }} />
                  <span style={{ fontSize: '0.72rem', color: '#888' }}>% 主</span>
                </div>
              </div>

              {/* 盤口 */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 8, justifyContent: 'center' }}>
                <label style={{ fontSize: '0.75rem', color: '#556' }}>線
                  <select className="ai-date" value={line} onChange={e => setLine(e.target.value)} style={{ width: 66, marginLeft: 4 }}>
                    {GOAL_LINES.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                </label>
                <NumInput label="大" value={overOdds} onChange={setOverOdds} placeholder="1.85" />
                <NumInput label="細" value={underOdds} onChange={setUnderOdds} placeholder="1.95" />
              </div>
            </div>
          </div>

          <button className="ai-btn" onClick={() => { setHome(''); setAway(''); setResult(null); }} style={{ marginTop: 8 }}>揀過第二場</button>
          {error && <div className="ai-error">{error}</div>}
          {loading && <div className="ai-empty">計算中…</div>}

          {result && !loading && (
            <div className="ai-verdict" style={{ marginTop: 10, borderLeft: `5px solid ${edge && edge.edge >= 0.05 ? '#1e7e34' : '#032169'}` }}>
              <div className="ai-verdict-title">
                {result.minute > 0 && (
                  <span style={{ background: '#fff6d6', color: '#8a6d00', borderRadius: 4, padding: '2px 10px', marginRight: 8, fontWeight: 700 }}>
                    {result.minute}' 比分 {hg}-{ag}
                  </span>
                )}
                {result.home} vs {result.away}
                <span style={{ marginLeft: 12, color: '#032169' }}>期望 <b style={{ fontSize: '1.2rem' }}>{result.expGoals}</b> 球</span>
                <span className="ai-muted" style={{ marginLeft: 8 }}>BTTS {(result.btts * 100).toFixed(0)}%</span>
              </div>
              <div className="ai-r2-grid" style={{ marginTop: 10 }}>
                {GOAL_LINES.filter(l => +l >= hg + ag).map(l => {
                  const p = result.probs[String(l)];
                  if (p == null) return null;
                  return (
                    <div className="ai-r2-box" key={l} style={{
                      border: String(l) === line ? '2px solid #032169' : undefined, padding: '4px 8px' }}>
                      <span className="ai-muted" style={{ fontSize: '0.7rem' }}>大 {l}</span>
                      <span style={{ fontSize: '1rem', fontWeight: 800, color: p > 0.55 ? '#1e7e34' : p < 0.45 ? '#c0392b' : '#032169' }}>
                        {(p * 100).toFixed(0)}%
                      </span>
                    </div>
                  );
                })}
              </div>
              {edge && (
                <div style={{ marginTop: 10, fontSize: '0.9rem', display: 'flex', gap: 16, alignItems: 'center' }}>
                  <b>建議：</b>
                  <span style={{ color: edge.edge >= 0.05 ? '#1e7e34' : '#999', fontWeight: 700, fontSize: '1.1rem' }}>
                    {edge.edge >= 0.05 ? `${edge.side} ${line}` : '唔落'}
                  </span>
                  <span style={{ color: edge.edge > 0 ? '#1e7e34' : '#c0392b' }}>
                    edge {(edge.edge * 100).toFixed(1)}%
                  </span>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── 賽前預測 ──
function PredictTab({ league, teams, onLeagueChange }) {
  const [home, setHome] = useState('');
  const [away, setAway] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [overOdds, setOverOdds] = useState('');
  const [underOdds, setUnderOdds] = useState('');
  const [line, setLine] = useState('2.5');

  const run = async () => {
    if (!home || !away || home === away) { setError('揀兩隊唔同嘅球隊'); return; }
    setLoading(true); setError(null); setResult(null);
    try {
      const r = await api.get('/goals/predict', { params: { league, home, away }, timeout: 60000 });
      if (r.data.error) setError(r.data.error); else setResult(r.data);
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setLoading(false); }
  };

  return (
    <div>
      <div className="ai-card">
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.8rem', color: '#556' }}>
            聯賽
            <select className="ai-date" value={league} onChange={e => { setHome(''); setAway(''); setResult(null); onLeagueChange(e.target.value); }} style={{ minWidth: 120 }}>
              {LEAGUES.map(l => <option key={l.key} value={l.key}>{l.name}</option>)}
            </select>
          </label>
          <TeamSelect label="主隊" value={home} onChange={setHome} teams={teams} />
          <TeamSelect label="客隊" value={away} onChange={setAway} teams={teams} />
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
                期望入球 <b style={{ fontSize: '1.3rem' }}>{result.expGoals}</b>
              </span>
              <span className="ai-muted" style={{ marginLeft: 12, fontSize: '0.85rem' }}>
                （主 {result.expHome} + 客 {result.expAway}｜BTTS {((result.btts || 0) * 100).toFixed(0)}%）
              </span>
            </div>
            <div className="ai-r2-grid" style={{ marginTop: 10 }}>
              {GOAL_LINES.map(l => {
                const p = result.probs[String(l)];
                if (p == null) return null;
                return (
                  <div className="ai-r2-box" key={l}>
                    <span className="ai-muted">大 {l}</span>
                    <span className="ai-r2-num" style={{ color: p > 0.55 ? '#1e7e34' : p < 0.45 ? '#c0392b' : '#032169' }}>
                      {(p * 100).toFixed(1)}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="ai-card" style={{ border: '1px solid #ccd3dc' }}>
            <h4>盤口對碰</h4>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ fontSize: '0.8rem', color: '#556' }}>線
                <select className="ai-date" value={line} onChange={e => setLine(e.target.value)} style={{ width: 70, marginLeft: 6 }}>
                  {GOAL_LINES.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </label>
              <NumInput label="大賠率" value={overOdds} onChange={setOverOdds} placeholder="1.85" />
              <NumInput label="細賠率" value={underOdds} onChange={setUnderOdds} placeholder="1.95" />
            </div>
            {result.probs[String(line)] != null && overOdds && underOdds && (
              <div style={{ marginTop: 10, fontSize: '0.9rem' }}>
                <b>大 {line} @ {overOdds}：</b>
                <span style={{ color: result.probs[String(line)] * +overOdds - 1 > 0.05 ? '#1e7e34' : '#c0392b', fontWeight: 700 }}>
                  edge {((result.probs[String(line)] * +overOdds - 1) * 100).toFixed(1)}%
                </span>
                {' ｜ '}
                <b>細 @ {underOdds}：</b>
                <span style={{ color: (1 - result.probs[String(line)]) * +underOdds - 1 > 0.05 ? '#1e7e34' : '#c0392b', fontWeight: 700 }}>
                  edge {(((1 - result.probs[String(line)]) * +underOdds - 1) * 100).toFixed(1)}%
                </span>
              </div>
            )}
          </div>

          <div className="ai-card">
            <h4>入球總數分佈</h4>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 80, marginTop: 8 }}>
              {result.dist.map((n, t) => {
                const max = Math.max(...result.dist);
                return (
                  <div key={t} title={`${t} 球：${((n / result.nSims) * 100).toFixed(1)}%`}
                    style={{ width: 28, height: `${(n / max) * 78}%`,
                      background: t > +line ? '#1e7e34' : '#c0392b', opacity: 0.85, borderRadius: 3 }}>
                    <div style={{ textAlign: 'center', fontSize: '0.7rem', color: '#888', marginTop: -18 }}>{n > max * 0.05 ? t : ''}</div>
                  </div>
                );
              })}
            </div>
            <div className="ai-muted" style={{ fontSize: '0.75rem' }}>綠 = 大 {line}｜紅 = 細 {line}</div>
          </div>
        </>
      )}
    </div>
  );
}

// ── 數據狀態 tab ──
function DataTab() {
  const [leagues, setLeagues] = useState([]);
  const [goalOdds, setGoalOdds] = useState([]);
  const [status, setStatus] = useState(null);

  const load = async () => {
    try {
      const [l, gc] = await Promise.all([
        api.get('/corner/leagues'),
        api.get('/goals/coverage', { timeout: 15000 }).catch(() => null),
      ]);
      setLeagues(l.data.leagues || []);
      if (gc && gc.data && gc.data.coverage) setGoalOdds(gc.data.coverage);
    } catch (_) {}
  };
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  return (
    <div>
      <div className="ai-card">
        <h4>數據覆蓋（場均入球 + 場均角球）</h4>
        <table className="ai-table">
          <thead><tr>
            <th>聯賽</th><th>賽季</th><th className="ai-num">場數</th>
            <th className="ai-num">場均入球</th><th className="ai-num">場均角球</th>
            <th>日期</th><th>完整度</th>
          </tr></thead>
          <tbody>
            {leagues.map(l => {
              // 每個聯賽嘅預期場數：英超/西甲 380（20隊）、德甲 306（18隊）、美職 ~400
              const expected = l.league === 'MLS' ? 400 : l.league === 'BUN' ? 306 : 380;
              const pct = Math.min(100, Math.round(+l.matches / expected * 100));
              const isPartial = +l.matches < expected * 0.8;
              return (
                <tr key={`${l.league}-${l.season}`} style={isPartial ? { background: '#fff8e1' } : undefined}>
                  <td>{l.league}</td>
                  <td>{l.season}</td>
                  <td className="ai-num" style={{ fontWeight: 700 }}>{l.matches}</td>
                  <td className="ai-num" style={{ fontWeight: 700, color: '#032169' }}>{l.avg_goals ?? '-'}</td>
                  <td className="ai-num">{l.avg_corners ?? '-'}</td>
                  <td className="ai-mono" style={{ fontSize: '0.72rem' }}>{l.from_d} → {l.to_d}</td>
                  <td>
                    {isPartial ? (
                      <span style={{ color: '#e67e22', fontWeight: 700, fontSize: '0.75rem' }} title={`預期 ~${expected} 場，實際 ${l.matches} 場`}>
                        ⚠ {pct}%
                      </span>
                    ) : (
                      <span style={{ color: '#1e7e34', fontSize: '0.75rem' }}>{pct}%</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="ai-muted" style={{ fontSize: '0.75rem', marginTop: 6 }}>
          ⚠ = 賽季數據唔完整（低於預期 80%），模型評分可能唔夠穩。
          <br />
          <b>數據缺口：</b>
          <br />
          ・德甲 2024/25：整季冇數據（重新抓取中）
          <br />
          ・美職 2025：只剩後賽 20 場（已隱藏美職分析）
        </div>
      </div>

      <div className="ai-card">
        <h4>HKJC 入球盤覆蓋</h4>
        <table className="ai-table">
          <thead><tr><th>聯賽</th><th className="ai-num">盤口場數</th><th className="ai-num">已連結</th><th className="ai-num">場均大賠率</th><th className="ai-num">場均細賠率</th></tr></thead>
          <tbody>
            {goalOdds.map(o => (
              <tr key={o.league}>
                <td>{o.league}</td>
                <td className="ai-num" style={{ fontWeight: 700 }}>{o.total}</td>
                <td className="ai-num" style={{ color: o.matched < o.total * 0.6 ? '#e67e22' : '#1e7e34' }}>{o.matched}</td>
                <td className="ai-num">{o.avg_over}</td>
                <td className="ai-num">{o.avg_under}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="ai-muted" style={{ fontSize: '0.78rem', marginTop: 6 }}>
          HKJC 入球盤（初終盤）由 titan007 OverDown_n.aspx 抓取。
          「已連結」= 對上 WhoScored 賽事數據（有入球時間/角球）嘅場次。
          未連結嘅場次通常係 WhoScored 未更新嘅新近比賽。
        </div>
      </div>

      <div className="ai-card">
        <h4>模型說明</h4>
        <ul className="ai-list">
          <li><b>數據</b> — WhoScored Opta 事件流（入球時間 + 角球 + 走位），2,394 場（四聯賽三季）。</li>
          <li><b>球隊評分</b> — 每隊 × 6 個 15 分鐘切片嘅入球攻擊力/防守力（乘法 Poisson）。</li>
          <li><b>Dominance</b> — 即場射門 + 控球 → 調整剩返入球 λ（同角球共用邏輯）。</li>
          <li><b>模擬</b> — Monte Carlo → 全場入球分佈 → P(大 0.5-5.5) + BTTS。</li>
          <li><b>回測</b> — walk-forward（每月重擬合）+ HKJC 入球盤真實 P/L。</li>
        </ul>
      </div>
    </div>
  );
}

function TeamSelect({ label, value, onChange, teams }) {  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.8rem', color: '#556' }}>
      {label}
      <select className="ai-date" value={value} onChange={e => onChange(e.target.value)} style={{ minWidth: 180 }}>
        <option value="">—</option>
        {teams.map(t => <option key={t.team} value={t.team}>{t.team}</option>)}
      </select>
    </label>
  );
}

function NumInput({ label, value, onChange, placeholder }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: '0.75rem', color: '#556' }}>
      {label}
      <input type="number" step="0.01" className="ai-date" value={value}
        onChange={e => onChange(e.target.value)} placeholder={placeholder} style={{ width: 75 }} />
    </label>
  );
}
