import React, { useState, useEffect } from 'react';
import api from '../api';

function TrackworkTable({ horses }) {
  if (!horses || horses.length === 0) return <div className="empty-state">無資料</div>;
  return (
    <div className="table-wrapper" style={{ overflowX: 'auto' }}>
      <table style={{ minWidth: 700, fontSize: '0.88em' }}>
        <thead>
          <tr>
            <th>馬號</th>
            <th>馬名</th>
            <th>練馬師</th>
            <th>近績</th>
            <th>試閘</th>
            <th>快操</th>
            <th>踱步</th>
            <th>游泳</th>
            <th>跑步機</th>
            <th>水中步行機</th>
            <th>休歇</th>
          </tr>
        </thead>
        <tbody>
          {horses.map((h, i) => (
            <tr key={i}>
              <td style={{ fontWeight: 700, color: '#032169' }}>{h.horseNo || '-'}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{h.horseName || '-'}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{h.trainer || '-'}</td>
              <td style={{ fontSize: '0.85em' }}>{h.recentForm || '-'}</td>
              <td>{h.barrierTrial || '-'}</td>
              <td>{h.gallop || '-'}</td>
              <td>{h.trotting || '-'}</td>
              <td>{h.swimming || '-'}</td>
              <td>{h.treadmill || '-'}</td>
              <td>{h.aquaWalker || '-'}</td>
              <td>{h.spelling || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function TrackworkPanel({ raceNo, raceDate, racecourse }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setData(null);
    setError(null);
    setExpanded(false);
  }, [raceNo, raceDate]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/trackwork', {
        params: { date: raceDate, racecourse: racecourse || 'ST', raceno: raceNo },
      });
      setData(res.data);
      setExpanded(true);
    } catch (e) {
      setError('載入失敗：' + e.message);
    } finally {
      setLoading(false);
    }
  }

  const declared = data && data.declared ? data.declared : [];
  const reserves = data && data.reserves ? data.reserves : [];
  const hasData = declared.length > 0 || reserves.length > 0;

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h4 style={{ margin: 0 }}>晨操資料</h4>
        <button className="btn btn-secondary" onClick={load} disabled={loading} style={{ fontSize: '0.85em' }}>
          {loading ? '載入中...' : '載入晨操資料'}
        </button>
        {data && (
          <button className="btn btn-secondary" onClick={() => setExpanded(e => !e)} style={{ fontSize: '0.85em' }}>
            {expanded ? '收起' : '展開'}
          </button>
        )}
      </div>

      {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}

      {data && expanded && (
        <div style={{ marginTop: 12 }}>
          {!hasData ? (
            <div className="empty-state">此場次暫無晨操資料</div>
          ) : (
            <>
              {declared.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <h5 style={{ margin: '0 0 6px', color: '#032169' }}>正式出賽馬匹</h5>
                  <TrackworkTable horses={declared} />
                </div>
              )}
              {reserves.length > 0 && (
                <div>
                  <h5 style={{ margin: '0 0 6px', color: '#555' }}>後備馬匹</h5>
                  <TrackworkTable horses={reserves} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
