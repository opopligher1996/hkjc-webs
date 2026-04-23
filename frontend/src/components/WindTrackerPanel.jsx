import React, { useState, useEffect } from 'react';
import api from '../api';

export default function WindTrackerPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/windtracker');
      setData(res.data);
      setExpanded(true);
    } catch (e) {
      setError('載入失敗：' + e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h3 style={{ margin: 0 }}>天氣及跑道狀況</h3>
        <button className="btn btn-secondary" onClick={load} disabled={loading} style={{ fontSize: '0.85em' }}>
          {loading ? '載入中...' : '更新天氣資料'}
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
          {/* Info row */}
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12, fontSize: '0.9em', color: '#444' }}>
            {data.raceInfo && <span>📋 {data.raceInfo}</span>}
            {data.going && <span>🌿 場地: {data.going}</span>}
            {data.trackIndex && <span>📊 度地儀指數: {data.trackIndex}</span>}
            {data.temperature && <span>🌡 {data.temperature}</span>}
            {data.humidity && <span>💧 濕度: {data.humidity}</span>}
            {data.rainfall && <span>🌧 雨量: {data.rainfall}</span>}
            {data.soilMoisture && <span>🪨 土壤濕度: {data.soilMoisture}</span>}
            {data.lastUpdate && <span style={{ color: '#888' }}>更新: {data.lastUpdate}</span>}
          </div>

          {/* Wind positions table */}
          {data.positions && data.positions.length > 0 && (
            <div className="table-wrapper" style={{ overflowX: 'auto' }}>
              <table style={{ minWidth: 400 }}>
                <thead>
                  <tr>
                    <th>位置</th>
                    <th>風向</th>
                    <th>風速</th>
                    <th>陣風</th>
                  </tr>
                </thead>
                <tbody>
                  {data.positions.map((p, i) => (
                    <tr key={i}>
                      <td>{p.index}</td>
                      <td>{p.direction || '-'}</td>
                      <td>{p.speed || '-'}</td>
                      <td>{p.gust || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Fallback: show full text if no structured positions */}
          {(!data.positions || data.positions.length === 0) && data.fullText && (
            <pre style={{ fontSize: '0.8em', whiteSpace: 'pre-wrap', background: '#f5f5f5', padding: 8, borderRadius: 4 }}>
              {data.fullText}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
