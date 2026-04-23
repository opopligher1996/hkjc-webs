import React, { useState, useEffect } from 'react';
import api from '../api';

export default function DrawPanel({ raceNo }) {
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
      const res = await api.get('/draw/live', { params: { raceno: raceNo } });
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
        <h4 style={{ margin: 0 }}>檔位分析</h4>
        <button className="btn btn-secondary" onClick={load} disabled={loading} style={{ fontSize: '0.85em' }}>
          {loading ? '載入中...' : '載入檔位統計'}
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
          {data.headerText && (
            <div style={{ fontWeight: 600, marginBottom: 8, fontSize: '0.9em', color: '#032169' }}>
              {data.headerText}
            </div>
          )}

          {data.drawData && data.drawData.length > 0 ? (
            <div className="table-wrapper" style={{ overflowX: 'auto' }}>
              <table style={{ minWidth: 520 }}>
                <thead>
                  <tr>
                    <th>檔位</th>
                    <th>出賽次數</th>
                    <th>冠</th>
                    <th>亞</th>
                    <th>季</th>
                    <th>殿</th>
                    <th>勝出率%</th>
                    <th>入Q率%</th>
                    <th>上名率%</th>
                    <th>前4名率%</th>
                  </tr>
                </thead>
                <tbody>
                  {data.drawData.map(row => (
                    <tr key={row.draw}>
                      <td style={{ fontWeight: 700 }}>{row.draw}</td>
                      <td>{row.totalRaces}</td>
                      <td>{row.win}</td>
                      <td>{row.place2}</td>
                      <td>{row.place3}</td>
                      <td>{row.place4}</td>
                      <td style={{
                        fontWeight: parseFloat(row.winRate) >= 15 ? 700 : 'normal',
                        color: parseFloat(row.winRate) >= 15 ? '#007700' : 'inherit'
                      }}>{row.winRate}</td>
                      <td>{row.quinellaRate}</td>
                      <td>{row.placeRate}</td>
                      <td>{row.top4Rate}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">暫無檔位統計數據</div>
          )}

          {data.favText && (
            <div style={{ marginTop: 8, fontSize: '0.85em', color: '#555' }}>大熱門: {data.favText}</div>
          )}
        </div>
      )}
    </div>
  );
}
