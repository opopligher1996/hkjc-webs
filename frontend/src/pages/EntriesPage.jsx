import React, { useState, useEffect } from 'react';
import api from '../api';

export default function EntriesPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [selectedDate, setSelectedDate] = useState('');
  const [scraping, setScraping] = useState(false);

  useEffect(() => { loadEntries(); }, []);

  async function loadEntries(date) {
    setLoading(true);
    setErr(null);
    try {
      const url = date ? `/entries?date=${date}` : '/entries';
      const r = await api.get(url);
      setData(r.data);
      if (r.data.meeting_date) setSelectedDate(r.data.meeting_date);
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleScrape() {
    setScraping(true);
    try {
      await api.post('/scrape/entries');
      await loadEntries(selectedDate);
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    } finally {
      setScraping(false);
    }
  }

  const races = data?.races || [];
  const dates = data?.available_dates || [];

  return (
    <div>
      <h1 className="page-title">報名表</h1>

      <div className="scrape-actions" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <button className="btn btn-success" onClick={handleScrape} disabled={scraping}>
          {scraping ? '抓取中...' : '更新報名表'}
        </button>
        {dates.length > 0 && (
          <div className="filter-group" style={{ marginBottom: 0 }}>
            <select
              value={selectedDate}
              onChange={(e) => { setSelectedDate(e.target.value); loadEntries(e.target.value); }}
            >
              {dates.map(d => (
                <option key={d} value={d}>{d} ({data?.racecourse || ''})</option>
              ))}
            </select>
          </div>
        )}
        {data?.scrape_date && (
          <span style={{ fontSize: '0.85em', color: '#888' }}>最後更新：{data.scrape_date}</span>
        )}
      </div>

      {loading && <div className="loading">載入中...</div>}
      {err && <div className="error">{err}</div>}

      {!loading && !err && races.length === 0 && (
        <div className="card">
          <div className="empty-state">尚無報名表資料，請點擊「更新報名表」抓取。</div>
        </div>
      )}

      {!loading && !err && races.length > 0 && (
        <>
          <div className="card">
            <div className="card-title">
              {data?.meeting_date} {data?.racecourse === 'ST' ? '沙田' : data?.racecourse === 'HV' ? '跑馬地' : data?.racecourse}
            </div>
            <div className="tab-bar">
              {races.map(race => (
                <button
                  key={race.race_no}
                  className="tab"
                  onClick={() => {
                    document.getElementById(`entries-race-${race.race_no}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  第{race.race_no}場
                </button>
              ))}
            </div>
          </div>

          {races.map(race => (
            <div key={race.race_no} id={`entries-race-${race.race_no}`} className="card" style={{ marginTop: 12 }}>
              <div className="card-title">
                第{race.race_no}場 — {race.race_class}班 {race.distance ? race.distance + '米' : ''} {race.track_type === 'TURF' ? '草地' : race.track_type === 'AWT' ? '泥地' : ''}
                {race.rating_range && <span style={{ fontWeight: 400, fontSize: '0.85em', color: '#666' }}> 評分{race.rating_range}</span>}
                {race.group_no > 0 && <span style={{ fontWeight: 400, fontSize: '0.85em', color: '#666' }}> 第{race.group_no}組</span>}
              </div>
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 40 }}>備註</th>
                      <th>練馬師</th>
                      <th>馬名</th>
                    </tr>
                  </thead>
                  <tbody>
                    {race.entries.map((e, i) => (
                      <tr key={i}>
                        <td style={{ textAlign: 'center', fontWeight: 700, color: e.horse_note ? '#e67e00' : '#ccc' }}>
                          {e.horse_note || '-'}
                        </td>
                        <td>{e.trainer_name}</td>
                        <td style={{ fontWeight: 500 }}>{e.horse_name}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
