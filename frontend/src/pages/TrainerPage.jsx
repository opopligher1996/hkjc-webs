import React, { useState, useEffect, useRef } from 'react';
import { getTrainers, getTrainerFilters, triggerScrape } from '../api';

export default function TrainerPage() {
  const [trainers, setTrainers] = useState([]);
  const [filters, setFilters] = useState({});
  const [filterOptions, setFilterOptions] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scraping, setScraping] = useState(false);
  const [progress, setProgress] = useState(null);
  const esRef = useRef(null);

  useEffect(() => {
    getTrainerFilters().then(setFilterOptions).catch(() => {});
    return () => esRef.current?.close();
  }, []);

  useEffect(() => {
    loadTrainers();
  }, [filters]);

  async function loadTrainers() {
    setLoading(true);
    setError(null);
    try {
      const data = await getTrainers(filters);
      setTrainers(data);
    } catch (err) {
      setError('載入練馬師資料失敗：' + err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleFilter(key, value) {
    setFilters(prev => {
      const next = { ...prev };
      if (value === '') delete next[key];
      else next[key] = value;
      return next;
    });
  }

  async function handleScrape() {
    setScraping(true);
    setProgress({ message: '啟動中...' });

    try {
      await triggerScrape('trainers');
    } catch (e) {
      alert('啟動失敗：' + e.message);
      setScraping(false);
      setProgress(null);
      return;
    }

    esRef.current?.close();
    const es = new EventSource('/api/scrape/trainers/progress');
    esRef.current = es;

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'trainer_list') {
        setProgress({ message: `找到 ${data.total} 位練馬師，開始抓取記錄...`, current: 0, total: data.total });
      } else if (data.type === 'trainer_start') {
        setProgress({ message: `正在抓取 ${data.name} (${data.current}/${data.total})`, current: data.current, total: data.total });
      } else if (data.type === 'trainer_page') {
        setProgress(prev => ({ ...prev, message: `正在抓取 ${data.trainerId}（第 ${data.pageNum} 頁，共 ${data.count} 筆）`, current: data.current, total: data.total }));
      } else if (data.type === 'trainer_done') {
        setProgress(prev => ({ ...prev, message: `${data.trainerId} 完成（${data.records} 筆），進度 ${data.current}/${data.total}`, current: data.current, total: data.total }));
      } else if (data.type === 'completed') {
        setProgress({ message: '更新完成！' });
        setScraping(false);
        es.close();
        loadTrainers();
      } else if (data.type === 'error') {
        setProgress({ message: '錯誤：' + data.message });
        setScraping(false);
        es.close();
      }
    };

    es.onerror = () => {
      if (scraping) {
        setProgress(prev => prev?.message === '更新完成！' ? prev : { message: '連線中斷' });
        setScraping(false);
      }
      es.close();
    };
  }

  const opts = filterOptions;
  const pct = progress?.total ? Math.round((progress.current / progress.total) * 100) : null;

  return (
    <div>
      <h1 className="page-title">今季練馬師資料</h1>

      <div className="scrape-actions">
        <button className="btn btn-success" onClick={handleScrape} disabled={scraping}>
          {scraping ? '更新中...' : '更新練馬師資料'}
        </button>
        <button className="btn btn-secondary" onClick={loadTrainers} disabled={loading}>刷新</button>
      </div>

      {progress && (
        <div className="scrape-progress">
          <div className="progress-message">{progress.message}</div>
          {pct !== null && (
            <div className="progress-bar-container">
              <div className="progress-bar" style={{ width: `${pct}%` }} />
              <span className="progress-pct">{pct}%</span>
            </div>
          )}
        </div>
      )}

      <div className="filters">
        <div className="filter-group">
          <label>馬場</label>
          <select onChange={e => handleFilter('racecourse', e.target.value)}>
            <option value="">全部馬場</option>
            <option value="ST">沙田</option>
            <option value="HV">跑馬地</option>
            <option value="CHA">從化</option>
          </select>
        </div>

        <div className="filter-group">
          <label>跑道</label>
          <select onChange={e => handleFilter('track_type', e.target.value)}>
            <option value="">全部跑道</option>
            {opts.track_types && opts.track_types.map(t => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label>賽事班次</label>
          <select onChange={e => handleFilter('race_class', e.target.value)}>
            <option value="">全部班次</option>
            {opts.race_classes && opts.race_classes.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label>場地狀況</label>
          <select onChange={e => handleFilter('going', e.target.value)}>
            <option value="">全部狀況</option>
            {opts.goings && opts.goings.map(g => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label>檔位</label>
          <select onChange={e => handleFilter('draw', e.target.value)}>
            <option value="">全部檔位</option>
            {opts.draws && opts.draws.map(d => (
              <option key={d} value={d}>{d}號檔</option>
            ))}
          </select>
        </div>
      </div>

      {loading && <div className="loading">載入中...</div>}
      {error && <div className="error">{error}</div>}

      {!loading && !error && (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th rowSpan="2">練馬師ID</th>
                <th rowSpan="2">練馬師名稱</th>
                <th colSpan="5">近一個月</th>
                <th colSpan="5">今季</th>
              </tr>
              <tr>
                <th>出賽</th>
                <th>冠</th>
                <th>亞</th>
                <th>季</th>
                <th>殿</th>
                <th>出賽</th>
                <th>冠</th>
                <th>亞</th>
                <th>季</th>
                <th>殿</th>
              </tr>
            </thead>
            <tbody>
              {trainers.length === 0 ? (
                <tr><td colSpan="12"><div className="empty-state">暫無數據，請先更新練馬師資料</div></td></tr>
              ) : (
                trainers.map(t => (
                  <tr key={t.id}>
                    <td>{t.id}</td>
                    <td style={{ textAlign: 'left' }}>{t.name_zh || t.id}</td>
                    <td>{t.month_total || 0}</td>
                    <td><span className={t.month_1st > 0 ? 'badge badge-gold' : ''}>{t.month_1st || 0}</span></td>
                    <td>{t.month_2nd || 0}</td>
                    <td>{t.month_3rd || 0}</td>
                    <td>{t.month_4th || 0}</td>
                    <td>{t.season_total || 0}</td>
                    <td><span className={t.season_1st > 0 ? 'badge badge-gold' : ''}>{t.season_1st || 0}</span></td>
                    <td>{t.season_2nd || 0}</td>
                    <td>{t.season_3rd || 0}</td>
                    <td>{t.season_4th || 0}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
