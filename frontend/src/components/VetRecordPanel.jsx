import React, { useState, useEffect } from 'react';
import api from '../api';

export default function VetRecordPanel({ raceNo, raceDate, racecourse }) {
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
      const res = await api.get('/vetrecord', {
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

  const records = data && data.records ? data.records : [];

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h4 style={{ margin: 0 }}>獸醫傷患紀錄</h4>
        <button className="btn btn-secondary" onClick={load} disabled={loading} style={{ fontSize: '0.85em' }}>
          {loading ? '載入中...' : '載入傷患紀錄'}
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
          {records.length === 0 ? (
            <div className="empty-state">此場次暫無獸醫傷患紀錄</div>
          ) : (
            <div className="table-wrapper" style={{ overflowX: 'auto' }}>
              <table style={{ minWidth: 400 }}>
                <thead>
                  <tr>
                    <th>馬號</th>
                    <th>馬名</th>
                    <th>傷患詳情</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 700, color: '#032169' }}>{r.horseNo || '-'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.horseName || '-'}</td>
                      <td style={{ fontSize: '0.9em' }}>{r.details || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
