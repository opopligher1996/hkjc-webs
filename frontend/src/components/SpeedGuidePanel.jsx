import React, { useState, useEffect } from 'react';
import api from '../api';

export default function SpeedGuidePanel({ raceNo }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setData(null);
    setError(null);
    setExpanded(false);
  }, [raceNo]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/speedguide', { params: { raceno: raceNo } });
      setData(res.data);
      setExpanded(true);
    } catch (e) {
      setError('載入失敗：' + e.message);
    } finally {
      setLoading(false);
    }
  }

  function fitnessLabel(rating) {
    if (rating === '↑↑↑') return { label: rating, color: '#007700' };
    if (rating === '↑↑') return { label: rating, color: '#009900' };
    if (rating === '↑') return { label: rating, color: '#44aa44' };
    if (rating === '↓') return { label: rating, color: '#cc0000' };
    return { label: rating || '-', color: 'inherit' };
  }

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h4 style={{ margin: 0 }}>步速形勢分析（速勢走位圖）</h4>
        <button className="btn btn-secondary" onClick={load} disabled={loading} style={{ fontSize: '0.85em' }}>
          {loading ? '載入中...' : '載入速勢數據'}
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
          {data.lastUpdate && (
            <div style={{ fontSize: '0.85em', color: '#888', marginBottom: 8 }}>
              最後更新: {data.lastUpdate}
            </div>
          )}

          {data.mapImageUrl && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: '0.85em', color: '#555', marginBottom: 4 }}>速勢走位圖</div>
              <img
                src={data.mapImageUrl}
                alt="速勢走位圖"
                style={{ maxWidth: '100%', border: '1px solid #ddd', borderRadius: 4 }}
              />
            </div>
          )}

          {data.horses && data.horses.length > 0 ? (
            <div className="table-wrapper" style={{ overflowX: 'auto' }}>
              <table style={{ minWidth: 800 }}>
                <thead>
                  <tr>
                    <th>馬號</th>
                    <th>馬名</th>
                    <th>檔位</th>
                    <th>所需能量</th>
                    <th>上次賽事</th>
                    <th>最佳能量</th>
                    <th>同程最佳</th>
                    <th>狀態</th>
                    <th>速勢評估</th>
                    <th>相差</th>
                  </tr>
                </thead>
                <tbody>
                  {data.horses.map((h, i) => {
                    const fit = fitnessLabel(h.fitnessRating);
                    const diff = parseFloat(h.estimateDiff);
                    const diffColor = !isNaN(diff) ? (diff > 0 ? '#007700' : diff < 0 ? '#cc0000' : 'inherit') : 'inherit';
                    return (
                      <tr key={i}>
                        <td style={{ fontWeight: 700, color: '#032169' }}>{h.horseNo}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{h.horseName}</td>
                        <td style={{ fontWeight: 700 }}>{h.draw}</td>
                        <td style={{ fontWeight: 600 }}>{h.requiredEnergy}</td>
                        <td style={{ fontSize: '0.8em', whiteSpace: 'pre-wrap' }}>
                          {h.pastRaces && h.pastRaces[4] ? h.pastRaces[4] : '-'}
                        </td>
                        <td>{h.bestEnergy || '-'}</td>
                        <td>{h.sameCourseBest || '-'}</td>
                        <td style={{ color: fit.color, fontWeight: 700, fontSize: '1.1em' }}>{fit.label}</td>
                        <td style={{ fontWeight: 600 }}>{h.speedEstimate || '-'}</td>
                        <td style={{ color: diffColor, fontWeight: 600 }}>{h.estimateDiff || '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">暫無速勢數據（可能賽前一天中午才發佈）</div>
          )}
        </div>
      )}
    </div>
  );
}
