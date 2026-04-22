import React, { useState, useEffect } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Bar } from 'react-chartjs-2';
import { getDrawSearch, getDrawOptions } from '../api';

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

const RACECOURSE_TRACKS = [
  { value: 'ALL', label: '所有馬場-跑道' },
  { value: 'STT', label: '沙田草地' },
  { value: 'STA', label: '沙田全天候' },
  { value: 'HVT', label: '跑馬地草地' },
  { value: 'CHT', label: '從化草地' },
];

// Course options per racecourse_track
const COURSE_OPTIONS = {
  ALL: [],
  STT: ['A', 'A+2', 'A+3', 'B', 'B+2', 'C', 'C+3'],
  STA: [],
  HVT: ['A', 'B', 'C'],
  CHT: [],
};

export default function DrawPage() {
  const [results, setResults] = useState([]);
  const [options, setOptions] = useState({});
  const [filters, setFilters] = useState({
    season: 'ALL',
    racecourse_track: 'ALL',
    course: 'ALL',
    distance: 'ALL',
    going: 'ALL',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    getDrawOptions().then(setOptions).catch(() => {});
  }, []);

  // Reset course when racecourse_track changes
  function handleRacecoursTrackChange(val) {
    setFilters(p => ({ ...p, racecourse_track: val, course: 'ALL' }));
  }

  async function handleSearch() {
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const params = {};
      if (filters.season !== 'ALL') params.season = filters.season;
      if (filters.racecourse_track !== 'ALL') params.racecourse_track = filters.racecourse_track;
      if (filters.course !== 'ALL') params.course = filters.course;
      if (filters.distance !== 'ALL') params.distance = filters.distance;
      if (filters.going !== 'ALL') params.going = filters.going;
      const data = await getDrawSearch(params);
      setResults(data);
    } catch (err) {
      setError('搜尋失敗：' + err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleReset() {
    setFilters({ season: 'ALL', racecourse_track: 'ALL', course: 'ALL', distance: 'ALL', going: 'ALL' });
    setResults([]);
    setSearched(false);
  }

  const courseOptions = COURSE_OPTIONS[filters.racecourse_track] || [];

  // Going labels per track type
  const isAWT = filters.racecourse_track === 'STA';
  const GOING_LABELS = isAWT
    ? { ALL: '全部狀況', AD: '乾地', AW: '濕地' }
    : { ALL: '全部狀況', TG: '好地', TY: '黏地', TS: '軟地' };

  const labels = results.map(r => `${r.draw}號`);

  const winRateData = {
    labels,
    datasets: [{
      label: '勝出率 (%)',
      data: results.map(r => parseFloat(r.win_rate) || 0),
      backgroundColor: 'rgba(3, 33, 105, 0.8)',
    }],
  };

  const placeRateData = {
    labels,
    datasets: [{
      label: '上名率 (%)',
      data: results.map(r => parseFloat(r.place_rate) || 0),
      backgroundColor: 'rgba(200, 100, 0, 0.8)',
    }],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { position: 'top' } },
    scales: {
      y: {
        beginAtZero: true,
        max: 100,
        ticks: { callback: v => v + '%' },
      },
    },
  };

  return (
    <div>
      <h1 className="page-title">檔位進階搜尋</h1>

      <div className="filters">
        {/* 馬季 */}
        <div className="filter-group">
          <label>馬季</label>
          <select value={filters.season} onChange={e => setFilters(p => ({ ...p, season: e.target.value }))}>
            <option value="ALL">所有馬季</option>
            {options.seasons && options.seasons.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        {/* 馬場-跑道 */}
        <div className="filter-group">
          <label>馬場-跑道</label>
          <select value={filters.racecourse_track} onChange={e => handleRacecoursTrackChange(e.target.value)}>
            {RACECOURSE_TRACKS.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>

        {/* 賽道 (only show when applicable) */}
        {courseOptions.length > 0 && (
          <div className="filter-group">
            <label>賽道</label>
            <select value={filters.course} onChange={e => setFilters(p => ({ ...p, course: e.target.value }))}>
              <option value="ALL">所有賽道</option>
              {courseOptions.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        )}

        {/* 途程 */}
        <div className="filter-group">
          <label>途程</label>
          <select value={filters.distance} onChange={e => setFilters(p => ({ ...p, distance: e.target.value }))}>
            <option value="ALL">所有途程</option>
            {options.distances && options.distances.map(d => (
              <option key={d} value={d}>{d}米</option>
            ))}
          </select>
        </div>

        {/* 場地狀況 */}
        <div className="filter-group">
          <label>場地狀況</label>
          <select value={filters.going} onChange={e => setFilters(p => ({ ...p, going: e.target.value }))}>
            <option value="ALL">全部狀況</option>
            {options.goings && options.goings.map(g => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </div>

        <button className="btn btn-primary" onClick={handleSearch}>搜尋</button>
        <button className="btn btn-secondary" onClick={handleReset}>重置</button>
      </div>

      {loading && <div className="loading">搜尋中...</div>}
      {error && <div className="error">{error}</div>}

      {searched && !loading && !error && results.length === 0 && (
        <div className="empty-state card">暫無符合條件的數據</div>
      )}

      {results.length > 0 && (
        <>
          <div className="table-wrapper" style={{ marginBottom: 20 }}>
            <table>
              <thead>
                <tr>
                  <th>檔位</th>
                  <th>總出賽</th>
                  <th>勝出</th>
                  <th>前三名</th>
                  <th>前四名</th>
                  <th>勝出率</th>
                  <th>上名率 (前三)</th>
                </tr>
              </thead>
              <tbody>
                {results.map(r => (
                  <tr key={r.draw}>
                    <td style={{ fontWeight: 700 }}>{r.draw}號</td>
                    <td>{r.total_races}</td>
                    <td>{r.wins}</td>
                    <td>{r.top3}</td>
                    <td>{r.top4}</td>
                    <td>
                      <span style={{ color: parseFloat(r.win_rate) > 15 ? '#007700' : 'inherit', fontWeight: 600 }}>
                        {r.win_rate}%
                      </span>
                    </td>
                    <td>
                      <span style={{ color: parseFloat(r.place_rate) > 40 ? '#007700' : 'inherit', fontWeight: 600 }}>
                        {r.place_rate}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <div className="card">
              <div className="card-title">勝出率條形圖</div>
              <div className="chart-container">
                <Bar data={winRateData} options={chartOptions} />
              </div>
            </div>
            <div className="card">
              <div className="card-title">上名率條形圖 (前三名)</div>
              <div className="chart-container">
                <Bar data={placeRateData} options={chartOptions} />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
