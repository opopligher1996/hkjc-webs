import React, { useState, useEffect, useRef } from 'react';
import { getNextRace, getRacecard, getFixtures, triggerScrape } from '../api';
import WindTrackerPanel from '../components/WindTrackerPanel';
import DrawPanel from '../components/DrawPanel';
import SpeedGuidePanel from '../components/SpeedGuidePanel';
import SectionalTimesPanel from '../components/SectionalTimesPanel';
import JockeyTrainerAnalysisPanel from '../components/JockeyTrainerAnalysisPanel';
import VetRecordPanel from '../components/VetRecordPanel';

const BASE_URL = '/api';

export default function RacecardPage() {
  const [raceData, setRaceData] = useState(null);
  const [fixtures, setFixtures] = useState([]);
  const [selectedDate, setSelectedDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scraping, setScraping] = useState(false);
  const [scrapeMsg, setScrapeMsg] = useState('');
  const [selectedRace, setSelectedRace] = useState(null);
  const sseRef = useRef(null);

  useEffect(() => {
    loadInitial();
    return () => { if (sseRef.current) sseRef.current.close(); };
  }, []);

  async function loadInitial() {
    try {
      const [nextRace, fixtureList] = await Promise.all([
        getNextRace(),
        getFixtures(),
      ]);
      setFixtures(fixtureList);
      // Backend now returns race_date as 'YYYY-MM-DD' string — use directly
      const defaultDate =
        (nextRace && nextRace.race_date) ||
        (fixtureList.length > 0 ? fixtureList[0].race_date : null);
      if (defaultDate) {
        setSelectedDate(defaultDate);
        loadRacecard(defaultDate);
      } else {
        setLoading(false);
      }
    } catch (err) {
      setError('載入失敗：' + err.message);
      setLoading(false);
    }
  }

  async function loadRacecard(date) {
    setLoading(true);
    setError(null);
    try {
      const data = await getRacecard(date);
      setRaceData(data);
      if (data.races && data.races.length > 0) {
        setSelectedRace(data.races[0].race_no);
      }
    } catch (err) {
      setError('載入排位表失敗：' + err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleDateChange(e) {
    const date = e.target.value;
    setSelectedDate(date);
    loadRacecard(date);
  }

  async function handleScrapeRacecard() {
    if (scraping) return;
    setScraping(true);
    setScrapeMsg('正在啟動...');

    // Derive racecourse from fixtures list for the selected date
    const fixture = fixtures.find(f => f.race_date === selectedDate);
    const racecourse = fixture?.racecourse || 'ST';

    try {
      await triggerScrape('racecard', { date: selectedDate, racecourse });
    } catch (e) {
      // 409 = already running, or timeout — proceed to SSE anyway
    }

    // Connect SSE for progress
    if (sseRef.current) sseRef.current.close();
    const sse = new EventSource(`${BASE_URL}/scrape/racecard/progress`);
    sseRef.current = sse;

    sse.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'started') {
          setScrapeMsg('排位表抓取中，請稍候...');
        } else if (data.type === 'completed') {
          setScraping(false);
          setScrapeMsg('');
          sse.close();
          if (data.races > 0) {
            alert(`排位表已更新：${data.raceDate} ${data.racecourse}，共 ${data.races} 場`);
          } else {
            alert(data.message || '排位表更新完成');
          }
          if (selectedDate) loadRacecard(selectedDate);
        } else if (data.type === 'error') {
          setScraping(false);
          setScrapeMsg('');
          sse.close();
          alert('排位表更新失敗：' + data.message);
        }
      } catch (_) {}
    };

    sse.onerror = () => {
      setScraping(false);
      setScrapeMsg('');
      sse.close();
    };
  }

  async function handleScrapeFixtures() {
    setScraping(true);
    try {
      await triggerScrape('fixtures');
      alert('賽期表更新已啟動（在後台進行）');
    } catch (e) {
      alert('失敗：' + e.message);
    } finally {
      setScraping(false);
    }
  }

  const currentRace = raceData?.races?.find(r => r.race_no === selectedRace);

  return (
    <div>
      <h1 className="page-title">排位表</h1>

      {/* 天氣及跑道狀況 — 頁面最上方 */}
      <WindTrackerPanel />

      <div className="scrape-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn btn-success" onClick={handleScrapeRacecard} disabled={scraping}>
          {scraping ? '更新中...' : '更新排位表'}
        </button>
        <button className="btn btn-secondary" onClick={handleScrapeFixtures} disabled={scraping}>
          更新賽期表
        </button>
        {scraping && scrapeMsg && (
          <span style={{ fontSize: '0.9em', color: '#555' }}>{scrapeMsg}</span>
        )}
      </div>

      <div className="filters">
        <div className="filter-group">
          <label>選擇賽事日期</label>
          <select value={selectedDate} onChange={handleDateChange}>
            {fixtures.length === 0 && selectedDate && (
              <option value={selectedDate}>{selectedDate}</option>
            )}
            {fixtures.map(f => (
              <option key={f.race_date} value={f.race_date}>
                {f.race_date} ({f.racecourse || 'ST'})
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading && <div className="loading">載入排位表中...</div>}
      {error && <div className="error">{error}</div>}

      {!loading && !error && raceData && (
        <>
          <div className="card">
            <div className="card-title">賽事日期：{raceData.date}</div>
            {raceData.races && raceData.races.length > 0 ? (
              <>
                <div className="tab-bar">
                  {raceData.races.map(race => (
                    <button
                      key={race.race_no}
                      className={`tab ${selectedRace === race.race_no ? 'active' : ''}`}
                      onClick={() => setSelectedRace(race.race_no)}
                    >
                      第{race.race_no}場
                    </button>
                  ))}
                </div>

                {currentRace && (
                  <>
                    <div className="race-info">
                      <span>第 {currentRace.race_no} 場</span>
                      {currentRace.race_class && <span>{currentRace.race_class}</span>}
                      {currentRace.distance && <span>{currentRace.distance}米</span>}
                      {currentRace.track_type && <span>{currentRace.track_type}</span>}
                      {currentRace.going && <span>場地：{currentRace.going}</span>}
                      <a
                        href={`https://racing.hkjc.com/zh-hk/local/information/racecard?racedate=${selectedDate}&Racecourse=${currentRace.racecourse || 'ST'}&RaceNo=${currentRace.race_no}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-secondary"
                        style={{ fontSize: '0.82em', padding: '2px 10px', textDecoration: 'none', marginLeft: 8 }}
                      >
                        HKJC 官網
                      </a>
                    </div>

                    <div className="table-wrapper" style={{ overflowX: 'auto' }}>
                      <table style={{ minWidth: 900 }}>
                        <thead>
                          <tr>
                            <th>馬號</th>
                            <th>近績</th>
                            <th>馬名</th>
                            <th>負磅</th>
                            <th>騎師</th>
                            <th>檔位</th>
                            <th>配備</th>
                            <th>練馬師</th>
                            <th>評分</th>
                            <th>評分+/-</th>
                            <th>排位體重</th>
                          </tr>
                        </thead>
                        <tbody>
                          {currentRace.horses.map(h => (
                            <tr key={h.horse_no}>
                              <td style={{ fontWeight: 700, color: '#032169' }}>{h.horse_no}</td>
                              <td style={{ fontFamily: 'monospace', letterSpacing: 1 }}>{h.recent_form || '-'}</td>
                              <td style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>{h.horse_name}</td>
                              <td>{h.actual_weight || '-'}</td>
                              <td>{h.jockey_name || h.jockey_id || '-'}</td>
                              <td style={{ fontWeight: 700 }}>{h.draw || '-'}</td>
                              <td style={{ fontSize: '0.85em' }}>{h.gear || '-'}</td>
                              <td>{h.trainer_name || h.trainer_id || '-'}</td>
                              <td>{h.rating || '-'}</td>
                              <td style={{
                                color: h.rating_change && h.rating_change.startsWith('+') ? '#007700'
                                  : h.rating_change && h.rating_change.startsWith('-') ? '#cc0000'
                                  : 'inherit'
                              }}>
                                {h.rating_change || '-'}
                              </td>
                              <td>{h.declared_weight || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* 檔位分析 */}
                    <DrawPanel raceNo={currentRace.race_no} />

                    {/* 步速形勢分析 */}
                    <SpeedGuidePanel raceNo={currentRace.race_no} />

                    {/* 分段時間分析 */}
                    <SectionalTimesPanel
                      raceNo={currentRace.race_no}
                      raceDate={selectedDate}
                      horses={currentRace.horses}
                      racecourse={currentRace.racecourse}
                      raceClass={currentRace.race_class}
                      distance={currentRace.distance}
                      trackType={currentRace.track_type}
                    />

                    {/* 騎師 / 練馬師分析 */}
                    <JockeyTrainerAnalysisPanel
                      raceNo={currentRace.race_no}
                      raceDate={selectedDate}
                    />

                    {/* 獸醫傷患紀錄 */}
                    <VetRecordPanel
                      raceNo={currentRace.race_no}
                      raceDate={selectedDate}
                      racecourse={currentRace.racecourse}
                    />

                  </>
                )}
              </>
            ) : (
              <div className="empty-state">
                此日期暫無排位表數據。<br />
                請點擊「更新排位表」按鈕抓取最新資料。
              </div>
            )}
          </div>
        </>
      )}

      {!loading && !error && !raceData && (
        <div className="card">
          <div className="empty-state">
            暫無賽事數據。請先更新賽期表，然後選擇賽事日期並更新排位表。
          </div>
        </div>
      )}
    </div>
  );
}
