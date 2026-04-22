import React, { useState, useEffect } from 'react';
import { getCourseTime, getCourseRecords, scrapeCourseTime } from '../api';

const RACECOURSES = [
  { value: 'ALL', label: '所有馬場' },
  { value: 'ST', label: '沙田' },
  { value: 'HV', label: '跑馬地' },
];

const rcLabel = rc => rc === 'ST' ? '沙田' : rc === 'HV' ? '跑馬地' : rc === 'CGA' ? '從化' : rc;
const ttLabel = tt => tt === 'TURF' ? '草地' : tt === 'AWT' ? '全天候' : tt;

export default function CourseTimePage() {
  const [courseTimes, setCourseTimes] = useState([]);
  const [courseRecords, setCourseRecords] = useState([]);
  const [racecourse, setRacecourse] = useState('ALL');
  const [loading, setLoading] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const params = racecourse !== 'ALL' ? { racecourse } : {};
      const [times, records] = await Promise.all([
        getCourseTime(params),
        getCourseRecords(params),
      ]);
      setCourseTimes(times);
      setCourseRecords(records);
    } catch (err) {
      setError('載入失敗：' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleScrape() {
    setScraping(true);
    try {
      const result = await scrapeCourseTime();
      alert(result.message || '已更新');
      loadData();
    } catch (err) {
      alert('更新失敗：' + err.message);
    } finally {
      setScraping(false);
    }
  }

  // Table 1: 跑道標準時間 — racecourse / distance / race_class / standard_time
  // Grouped by racecourse + track_type
  const table1Groups = {};
  for (const row of courseTimes) {
    const key = `${row.racecourse}_${row.track_type}`;
    if (!table1Groups[key]) table1Groups[key] = { racecourse: row.racecourse, trackType: row.track_type, rows: [] };
    table1Groups[key].rows.push(row);
  }

  // Table 2: 參考分段時間 — same data but with split columns
  // Same grouping as table 1 but only rows that have any split time
  const table2Groups = {};
  for (const row of courseTimes) {
    const hasSplit = row.split_start_2000 || row.split_2000_1600 || row.split_1600_1200 ||
      row.split_1200_800 || row.split_800_400 || row.split_400_finish;
    if (!hasSplit) continue;
    const key = `${row.racecourse}_${row.track_type}`;
    if (!table2Groups[key]) table2Groups[key] = { racecourse: row.racecourse, trackType: row.track_type, rows: [] };
    table2Groups[key].rows.push(row);
  }

  // Table 3: 紀錄時間
  const table3Groups = {};
  for (const row of courseRecords) {
    const key = `${row.racecourse}_${row.track_type}`;
    if (!table3Groups[key]) table3Groups[key] = { racecourse: row.racecourse, trackType: row.track_type, rows: [] };
    table3Groups[key].rows.push(row);
  }

  const isEmpty = courseTimes.length === 0 && courseRecords.length === 0;

  return (
    <div>
      <h1 className="page-title">跑道標準時間</h1>

      <div className="scrape-actions">
        <button className="btn btn-success" onClick={handleScrape} disabled={scraping}>
          {scraping ? '更新中...' : '從 HKJC 更新'}
        </button>
      </div>

      <div className="filters" style={{ marginBottom: 16 }}>
        <div className="filter-group">
          <label>馬場</label>
          <select value={racecourse} onChange={e => setRacecourse(e.target.value)}>
            {RACECOURSES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <button className="btn btn-primary" onClick={loadData}>篩選</button>
      </div>

      {loading && <div className="loading">載入中...</div>}
      {error && <div className="error">{error}</div>}

      {!loading && !error && isEmpty && (
        <div className="empty-state card">暫無資料。請點擊「從 HKJC 更新」抓取標準時間。</div>
      )}

      {/* Table 1: 跑道標準時間 */}
      {Object.values(table1Groups).length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="card-title" style={{ fontSize: '1.1em', marginBottom: 12 }}>表一：跑道標準時間</div>
          {Object.values(table1Groups).map(group => (
            <div key={`${group.racecourse}_${group.trackType}`} style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 600, marginBottom: 6, color: '#032169' }}>
                {rcLabel(group.racecourse)} {ttLabel(group.trackType)}
              </div>
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>途程 (米)</th>
                      <th>班次</th>
                      <th>標準時間</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((row, i) => (
                      <tr key={i}>
                        <td style={{ fontWeight: 700 }}>{row.distance}</td>
                        <td>{row.race_class || '-'}</td>
                        <td style={{ fontFamily: 'monospace' }}>{row.standard_time || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Table 2: 參考分段時間 */}
      {Object.values(table2Groups).length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="card-title" style={{ fontSize: '1.1em', marginBottom: 12 }}>表二：參考分段時間</div>
          {Object.values(table2Groups).map(group => (
            <div key={`${group.racecourse}_${group.trackType}`} style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 600, marginBottom: 6, color: '#032169' }}>
                {rcLabel(group.racecourse)} {ttLabel(group.trackType)}
              </div>
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>途程</th>
                      <th>班次</th>
                      <th>標準時間</th>
                      <th>起點-2000米</th>
                      <th>2000-1600米</th>
                      <th>1600-1200米</th>
                      <th>1200-800米</th>
                      <th>800-400米</th>
                      <th>400米-終點</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((row, i) => (
                      <tr key={i}>
                        <td style={{ fontWeight: 700 }}>{row.distance}</td>
                        <td>{row.race_class || '-'}</td>
                        <td style={{ fontFamily: 'monospace' }}>{row.standard_time || '-'}</td>
                        <td style={{ fontFamily: 'monospace' }}>{row.split_start_2000 || '-'}</td>
                        <td style={{ fontFamily: 'monospace' }}>{row.split_2000_1600 || '-'}</td>
                        <td style={{ fontFamily: 'monospace' }}>{row.split_1600_1200 || '-'}</td>
                        <td style={{ fontFamily: 'monospace' }}>{row.split_1200_800 || '-'}</td>
                        <td style={{ fontFamily: 'monospace' }}>{row.split_800_400 || '-'}</td>
                        <td style={{ fontFamily: 'monospace' }}>{row.split_400_finish || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Table 3: 所有紀錄時間（只包括勝出頭馬）*/}
      {Object.values(table3Groups).length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="card-title" style={{ fontSize: '1.1em', marginBottom: 12 }}>表三：所有紀錄時間（只包括勝出頭馬）</div>
          {Object.values(table3Groups).map(group => (
            <div key={`${group.racecourse}_${group.trackType}`} style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 600, marginBottom: 6, color: '#032169' }}>
                {rcLabel(group.racecourse)} {ttLabel(group.trackType)}
              </div>
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>途程</th>
                      <th>班次</th>
                      <th>馬名</th>
                      <th>時間</th>
                      <th>負磅 (磅)</th>
                      <th>日期</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((row, i) => (
                      <tr key={i}>
                        <td style={{ fontWeight: 700 }}>{row.distance}</td>
                        <td>{row.race_class || '-'}</td>
                        <td>{row.horse_name || '-'}</td>
                        <td style={{ fontFamily: 'monospace' }}>{row.record_time || '-'}</td>
                        <td>{row.weight || '-'}</td>
                        <td>{row.record_date ? row.record_date.slice(0, 10) : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
