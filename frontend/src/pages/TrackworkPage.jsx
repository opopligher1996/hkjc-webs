import React, { useState } from 'react';
import api from '../api';

const TRACKWORK_LABELS = {
  barrierTrial: '試閘',
  gallop: '快操',
  trotting: '踱步',
  swimming: '游泳',
  treadmill: '跑步機',
  aquaWalker: '水中步行機',
  spelling: '休歇',
};

const TRACKWORK_KEYS = Object.keys(TRACKWORK_LABELS);

function TrackworkBadge({ value }) {
  if (!value || value === '-') return <span style={{ color: '#bbb' }}>—</span>;
  return <span style={{ fontWeight: 500, color: '#032169' }}>{value}</span>;
}

function HorseTrackworkCard({ entry }) {
  const { date, racecourse, raceNo, found, trackwork, error } = entry;

  const rcLabel = { ST: '沙田', HV: '跑馬地', CGA: '從化' }[racecourse] || racecourse;
  const headerStyle = {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '8px 12px',
    background: '#f0f4ff',
    borderRadius: 6,
    marginBottom: 8,
    flexWrap: 'wrap',
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={headerStyle}>
        <span style={{ fontWeight: 700, color: '#032169', fontSize: '1em' }}>
          {date}
        </span>
        <span style={{ background: '#032169', color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: '0.85em' }}>
          {rcLabel}
        </span>
        <span style={{ color: '#555', fontSize: '0.9em' }}>第 {raceNo} 場</span>
        {!found && !error && (
          <span style={{ color: '#999', fontSize: '0.85em', marginLeft: 'auto' }}>此場次無該馬匹晨操記錄</span>
        )}
        {error && (
          <span style={{ color: '#c00', fontSize: '0.85em', marginLeft: 'auto' }}>載入失敗：{error}</span>
        )}
      </div>

      {found && trackwork && (
        <div className="table-wrapper" style={{ overflowX: 'auto' }}>
          <table style={{ minWidth: 580, fontSize: '0.9em' }}>
            <thead>
              <tr>
                <th>馬名</th>
                <th>練馬師</th>
                <th>近績</th>
                {TRACKWORK_KEYS.map(k => (
                  <th key={k}>{TRACKWORK_LABELS[k]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{trackwork.horseName || '-'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{trackwork.trainer || '-'}</td>
                <td style={{ fontSize: '0.85em', color: '#555' }}>{trackwork.recentForm || '-'}</td>
                {TRACKWORK_KEYS.map(k => (
                  <td key={k}><TrackworkBadge value={trackwork[k]} /></td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function TrackworkPage() {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(5);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSearch(e) {
    e.preventDefault();
    const name = query.trim();
    if (!name) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.get('/trackwork/horse', {
        params: { name, limit },
        timeout: 120000,
      });
      setResult(res.data);
    } catch (err) {
      setError('搜尋失敗：' + (err.response?.data?.error || err.message));
    } finally {
      setLoading(false);
    }
  }

  const foundCount = result?.races?.filter(r => r.found).length ?? 0;

  return (
    <div>
      <h1 className="page-title">馬匹晨操表現</h1>

      <form className="filters" onSubmit={handleSearch}>
        <div className="filter-group">
          <label>馬名</label>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="輸入馬名（例如：大力士）"
            style={{ padding: '6px 10px', minWidth: 220, border: '1px solid #ccc', borderRadius: 4 }}
          />
        </div>
        <div className="filter-group">
          <label>查閱場數</label>
          <select
            value={limit}
            onChange={e => setLimit(Number(e.target.value))}
            style={{ padding: '6px 8px', border: '1px solid #ccc', borderRadius: 4 }}
          >
            {[1, 2, 3, 5, 8, 10].map(n => (
              <option key={n} value={n}>{n} 場</option>
            ))}
          </select>
        </div>
        <button className="btn btn-primary" type="submit" disabled={loading || !query.trim()}>
          {loading ? '搜尋中...' : '搜尋'}
        </button>
        <button
          className="btn btn-secondary"
          type="button"
          onClick={() => { setQuery(''); setResult(null); setError(null); }}
          disabled={loading}
        >
          重置
        </button>
      </form>

      {loading && (
        <div className="loading" style={{ marginTop: 16 }}>
          正在從 HKJC 爬取晨操資料，請稍候（每場約需 5-10 秒）...
        </div>
      )}

      {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}

      {result && !loading && (
        <div style={{ marginTop: 16 }}>
          <div style={{ marginBottom: 12, color: '#555', fontSize: '0.95em' }}>
            馬匹：<strong style={{ color: '#032169' }}>{result.name}</strong>
            {result.message && <span style={{ marginLeft: 12, color: '#999' }}>{result.message}</span>}
            {result.races?.length > 0 && (
              <span style={{ marginLeft: 12 }}>
                共找到 <strong>{result.races.length}</strong> 場排位記錄，
                其中 <strong>{foundCount}</strong> 場有晨操資料
              </span>
            )}
          </div>

          {result.races?.length === 0 ? (
            <div className="card">
              <div className="empty-state">未找到該馬匹的排位記錄，請確認馬名是否正確。</div>
            </div>
          ) : (
            result.races.map((entry, i) => (
              <HorseTrackworkCard key={i} entry={entry} />
            ))
          )}
        </div>
      )}

      {!result && !loading && (
        <div className="card" style={{ marginTop: 16, color: '#888', textAlign: 'center', padding: 32 }}>
          <div style={{ fontSize: '1.1em', marginBottom: 8 }}>輸入馬名以搜尋晨操表現</div>
          <div style={{ fontSize: '0.9em' }}>
            系統會從排位表記錄中找出該馬匹的近期賽事，並即時爬取 HKJC 晨操資料。
          </div>
        </div>
      )}
    </div>
  );
}
