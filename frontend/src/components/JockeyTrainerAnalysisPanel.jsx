import React, { useState, useEffect } from 'react';
import api from '../api';

// ── Stat Cell Helper ──────────────────────────────────────────────────────────
function StatCell({ stat }) {
  if (!stat || stat.total === 0) return <td style={{ color: '#bbb', textAlign: 'center' }}>-</td>;
  const winRate = stat.total > 0 ? ((stat.win / stat.total) * 100).toFixed(0) : 0;
  return (
    <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
      <span style={{ color: '#888', fontSize: '0.9em' }}>{stat.total}</span>
      {' '}
      <span style={{ color: '#c00', fontWeight: stat.win > 0 ? 700 : 'normal' }}>{stat.win}</span>
      {'-'}
      <span style={{ color: '#c60' }}>{stat.second}</span>
      {'-'}
      <span style={{ color: '#090' }}>{stat.third}</span>
      {'-'}
      <span style={{ color: '#555' }}>{stat.fourth}</span>
      {stat.win > 0 && (
        <span style={{ fontSize: '0.75em', color: '#c00', marginLeft: 3 }}>({winRate}%)</span>
      )}
    </td>
  );
}

// ── Sub-table for jockey or trainer ──────────────────────────────────────────
function AnalysisTable({ title, rows, idKey, nameKey, raceClass, distance }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: '0.85em', fontWeight: 600, color: '#032169', marginBottom: 6 }}>{title}</div>
      <div className="table-wrapper" style={{ overflowX: 'auto' }}>
        <table style={{ fontSize: '0.82em', borderCollapse: 'collapse', minWidth: 560 }}>
          <thead>
            <tr style={{ background: '#eef2ff' }}>
              <th style={{ padding: '4px 8px', border: '1px solid #ccd', textAlign: 'left' }}>馬號</th>
              <th style={{ padding: '4px 8px', border: '1px solid #ccd', textAlign: 'left' }}>馬名</th>
              <th style={{ padding: '4px 8px', border: '1px solid #ccd', textAlign: 'left' }}>ID</th>
              <th style={{ padding: '4px 8px', border: '1px solid #ccd', textAlign: 'left' }}>{nameKey === 'trainerName' ? '練馬師' : '騎師'}</th>
              <th style={{ padding: '4px 8px', border: '1px solid #ccd', textAlign: 'center' }} colSpan={1}>
                近一個月<br /><span style={{ fontSize: '0.8em', fontWeight: 'normal', color: '#666' }}>總/冠-亞-季-殿</span>
              </th>
              <th style={{ padding: '4px 8px', border: '1px solid #ccd', textAlign: 'center' }} colSpan={1}>
                今季同班次{raceClass ? `(${raceClass})` : ''}<br /><span style={{ fontSize: '0.8em', fontWeight: 'normal', color: '#666' }}>總/冠-亞-季-殿</span>
              </th>
              <th style={{ padding: '4px 8px', border: '1px solid #ccd', textAlign: 'center' }} colSpan={1}>
                今季同路程{distance ? `(${distance}米)` : ''}<br /><span style={{ fontSize: '0.8em', fontWeight: 'normal', color: '#666' }}>總/冠-亞-季-殿</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((horse, i) => {
              const stats = idKey === 'jockeyId' ? horse.jockey : horse.trainer;
              const name = idKey === 'jockeyId' ? horse.jockeyId : horse.trainerName;
              const id = idKey === 'jockeyId' ? horse.jockeyId : horse.trainerId;
              return (
                <tr key={i} style={{ borderTop: '1px solid #eee', background: i % 2 === 0 ? '#fff' : '#fafbff' }}>
                  <td style={{ padding: '3px 8px', border: '1px solid #eee', fontWeight: 700 }}>{horse.horseNo}</td>
                  <td style={{ padding: '3px 8px', border: '1px solid #eee', whiteSpace: 'nowrap' }}>{horse.horseName}</td>
                  <td style={{ padding: '3px 8px', border: '1px solid #eee', color: '#666', fontSize: '0.9em' }}>{id || '-'}</td>
                  <td style={{ padding: '3px 8px', border: '1px solid #eee', whiteSpace: 'nowrap' }}>{name || '-'}</td>
                  <StatCell stat={stats?.monthly} />
                  <StatCell stat={stats?.sameClass} />
                  <StatCell stat={stats?.sameDist} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: '0.72em', color: '#999', marginTop: 3 }}>
        格式：總參賽 冠-亞-季-殿，不含今天
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function JockeyTrainerAnalysisPanel({ raceNo, raceDate }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setData(null);
    setError(null);
    setExpanded(false);
  }, [raceDate, raceNo]);

  async function load() {
    if (data) { setExpanded(e => !e); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/racecard/analysis', { params: { date: raceDate, raceno: raceNo } });
      setData(res.data);
      setExpanded(true);
    } catch (e) {
      setError('載入失敗：' + e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h4 style={{ margin: 0 }}>騎師 / 練馬師分析</h4>
        <button className="btn btn-secondary" onClick={load} disabled={loading} style={{ fontSize: '0.85em' }}>
          {loading ? '載入中...' : data ? (expanded ? '收起' : '展開') : '載入分析'}
        </button>
        {error && <span style={{ color: '#cc0000', fontSize: '0.82em' }}>{error}</span>}
      </div>

      {data && expanded && (
        <div style={{ marginTop: 14 }}>
          <AnalysisTable
            title="騎師分析"
            rows={data.horses}
            idKey="jockeyId"
            nameKey="jockeyId"
            raceClass={data.raceClass}
            distance={data.distance}
          />
          <div style={{ borderTop: '1px solid #ddd', paddingTop: 14 }}>
            <AnalysisTable
              title="練馬師分析"
              rows={data.horses}
              idKey="trainerId"
              nameKey="trainerName"
              raceClass={data.raceClass}
              distance={data.distance}
            />
          </div>
        </div>
      )}
    </div>
  );
}
