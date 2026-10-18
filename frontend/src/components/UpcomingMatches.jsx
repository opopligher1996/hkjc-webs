import React, { useState, useEffect } from 'react';
import api from '../api';

// ── 大細概率條 ──
function ProbBar({ line, p }) {
  const over = p, under = 1 - p;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem' }}>
      <span style={{ minWidth: 36, fontFamily: 'monospace', fontWeight: 700, textAlign: 'center', background: '#eef3fa', borderRadius: 4, padding: '2px 4px' }}>{line}</span>
      <div style={{ flex: 1, display: 'flex', height: 18, borderRadius: 4, overflow: 'hidden', background: '#f0f2f5' }}>
        <div style={{ width: `${under * 100}%`, background: '#5d7a9d', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: '0.7rem' }}>
          {under >= 0.18 ? `細 ${(under * 100).toFixed(0)}%` : ''}
        </div>
        <div style={{ width: `${over * 100}%`, background: over > 0.55 ? '#1e7e34' : over < 0.45 ? '#c0392b' : '#032169', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: '0.7rem' }}>
          {over >= 0.18 ? `大 ${(over * 100).toFixed(0)}%` : ''}
        </div>
      </div>
    </div>
  );
}

// ── 單場詳細面板 ──
function MatchDetail({ league, home, away, titanLine }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get('/corner/match-detail', { params: { league, home, away }, timeout: 60000 })
      .then(r => { if (alive) setD(r.data); })
      .catch(e => { if (alive) setErr(e.response?.data?.error || e.message); });
    return () => { alive = false; };
  }, [league, home, away]);

  if (err) return <div className="ai-error" style={{ marginTop: 8 }}>{err}</div>;
  if (!d) return <div className="ai-muted" style={{ padding: 10 }}>模擬中…</div>;

  const g = d.goals, c = d.corners;
  // titan 盤線轉數字（"2.5/3" → 2.75）
  const tl = titanLine ? titanLine.split('/').reduce((a, b) => a + parseFloat(b), 0) / titanLine.split('/').length : null;

  return (
    <div style={{ marginTop: 10, padding: 12, background: '#f7f9fc', borderRadius: 8, border: '1px solid #e3e9f2' }}>
      {/* 入球 */}
      {g && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 8 }}>
            <span style={{ fontWeight: 800, color: '#032169' }}>⚽ 入球分析</span>
            <span>期望 <b style={{ fontSize: '1.3rem' }}>{g.expGoals?.toFixed(2)}</b></span>
            {g.expHome != null && <span className="ai-muted">主 {g.expHome.toFixed(2)} / 客 {g.expAway.toFixed(2)}</span>}
            <span>BTTS <b>{(g.btts * 100).toFixed(0)}%</b></span>
            {tl && (
              <span className="ai-badge" title="與 titan007 盤線對比">
                盤 {titanLine} → {g.expGoals > tl + 0.25 ? '看好大' : g.expGoals < tl - 0.25 ? '看好細' : '接近盤口'}
              </span>
            )}
            {g.sample && <span className="ai-muted" style={{ fontSize: '0.75rem' }}>（樣本 {g.sample} 場）</span>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 6 }}>
            {Object.entries(g.probs).map(([l, p]) => <ProbBar key={l} line={l} p={p} />)}
          </div>
        </div>
      )}
      {/* 角球 */}
      {c && (
        <div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 8 }}>
            <span style={{ fontWeight: 800, color: '#032169' }}>🚩 角球分析</span>
            <span>期望 <b style={{ fontSize: '1.3rem' }}>{c.expCorners?.toFixed(1)}</b></span>
            {c.expHome != null && <span className="ai-muted">主 {c.expHome.toFixed(1)} / 客 {c.expAway.toFixed(1)}</span>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 6 }}>
            {Object.entries(c.probs).map(([l, p]) => <ProbBar key={l} line={l} p={p} />)}
          </div>
          {c.bySlice && (
            <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
              {Object.entries(c.bySlice).map(([s, v]) => {
                const val = typeof v === 'object' ? ((v.home ?? 0) + (v.away ?? 0)) : (v ?? 0);
                const max = Math.max(...Object.values(c.bySlice).map(x => typeof x === 'object' ? ((x.home ?? 0) + (x.away ?? 0)) : (x ?? 0)), 0.01);
                const lo = s * 15, hi = +s * 15 + 15;
                return (
                  <div key={s} title={`${lo}-${hi} 分鐘：期望 ${val.toFixed(2)} 角球`} style={{ textAlign: 'center', fontSize: '0.7rem' }}>
                    <div style={{ width: 34, height: 44, background: '#eef3fa', borderRadius: 4, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                      <div style={{ width: '80%', height: `${(val / max) * 100}%`, background: '#032169', borderRadius: '3px 3px 0 0' }} />
                    </div>
                    <span className="ai-muted">{lo}-{hi}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {!g && !c && <div className="ai-muted">該隊未有足夠數據</div>}
    </div>
  );
}

// 未來十日四大聯賽賽程 + 角球/入球預測（titan007）
export default function UpcomingMatches() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [openKey, setOpenKey] = useState(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await api.get('/corner/schedule', { timeout: 300000 });
      if (r.data.error) setError(r.data.error); else setData(r.data);
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const lgName = { EPL: '英超', BUN: '德甲', LAL: '西甲', MLS: '美職' };
  const byDate = {};
  (data?.matches || []).forEach(m => { (byDate[m.date] = byDate[m.date] || []).push(m); });

  return (
    <div className="ai-card" style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <h4 style={{ margin: 0 }}>📅 未來十日賽程及預測（英超/德甲/西甲/美職）</h4>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {data?.cachedAt && (
            <span className="ai-muted" style={{ fontSize: '0.75rem' }}>
              更新於 {new Date(data.cachedAt).toLocaleTimeString('zh-HK')}
            </span>
          )}
          <button className="ai-btn ai-btn-ghost" onClick={load} disabled={loading}>
            {loading ? '爬取中…' : '↻ 刷新'}
          </button>
        </div>
      </div>
      {error && <div className="ai-error">{error}</div>}
      {loading && !data && <div className="ai-empty" style={{ padding: 20 }}>緊去 titan007 爬取未來十日賽程（約 1 分鐘）…</div>}
      {data && !data.matches.length && <div className="ai-empty" style={{ padding: 20 }}>未來十日冇四大聯賽賽事</div>}
      {Object.entries(byDate).map(([d, ms]) => (
        <div key={d} style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 700, color: '#032169', marginBottom: 6 }}>
            {new Date(d + 'T12:00:00').toLocaleDateString('zh-HK', { month: 'numeric', day: 'numeric', weekday: 'short' })}
          </div>
          {ms.map((m, i) => {
            const key = `${m.date}|${m.home}|${m.away}`;
            const open = openKey === key;
            return (
              <div key={key} style={{ borderBottom: '1px solid #eef1f5' }}>
                <div
                  onClick={() => setOpenKey(open ? null : key)}
                  style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '6px 8px', fontSize: '0.85rem', cursor: 'pointer', background: open ? '#eef3fa' : 'transparent', borderRadius: open ? '6px 6px 0 0' : 0 }}
                >
                  <span style={{ color: '#032169', fontWeight: 700, minWidth: 14 }}>{open ? '▾' : '▸'}</span>
                  <span className="ai-badge" style={{ minWidth: 44, textAlign: 'center' }}>{lgName[m.league] || m.league}</span>
                  <span style={{ minWidth: 66, fontFamily: 'monospace' }}>{m.time.split(' ')[1] || m.time}</span>
                  <span style={{ fontWeight: 600, flex: 1, minWidth: 220 }}>{m.homeTc || m.home} <span className="ai-muted">vs</span> {m.awayTc || m.away}</span>
                  {m.titanLine && <span className="ai-badge" title="titan007 入球線">盤 {m.titanLine}</span>}
                  {m.expGoals != null && (
                    <span title="模型期望入球">
                      ⚽ <b>{m.expGoals.toFixed(2)}</b>
                    </span>
                  )}
                  {m.expCorners != null && (
                    <span title="模型期望角球">
                      🚩 <b>{m.expCorners.toFixed(1)}</b>
                    </span>
                  )}
                  {!m.expGoals && !m.expCorners && <span className="ai-muted">未有數據</span>}
                </div>
                {open && <MatchDetail league={m.league} home={m.home} away={m.away} titanLine={m.titanLine} />}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
