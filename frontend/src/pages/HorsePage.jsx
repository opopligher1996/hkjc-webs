import React, { useState, useEffect, useRef } from 'react';
import { getHorses, getHorse, scrapeHorse, scrapeHorses } from '../api';

const BASE_URL = '/api';

export default function HorsePage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [horses, setHorses] = useState([]);
  const [selectedHorse, setSelectedHorse] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [fullSyncing, setFullSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(null); // { current, total, name }
  const [error, setError] = useState(null);
  const [searched, setSearched] = useState(false);
  const sseRef = useRef(null);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => { if (sseRef.current) sseRef.current.close(); };
  }, []);

  async function handleSearch(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSearched(true);
    setSelectedHorse(null);
    try {
      const data = await getHorses(searchQuery.trim() || undefined);
      setHorses(data);
    } catch (err) {
      setError('搜尋失敗：' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectHorse(horse) {
    setSelectedHorse(horse);
  }

  async function handleScrapeHorse() {
    if (!selectedHorse) return;
    setScraping(true);
    try {
      await scrapeHorse(selectedHorse.id);
      const updated = await getHorse(selectedHorse.id);
      setSelectedHorse(updated);
    } catch (err) {
      alert('更新失敗：' + err.message);
    } finally {
      setScraping(false);
    }
  }

  async function handleFullSync() {
    if (fullSyncing) return;
    setFullSyncing(true);
    setSyncProgress({ current: 0, total: 0, name: '啟動中...' });

    try {
      await scrapeHorses();
    } catch (err) {
      // 409 means already running — still connect SSE
    }

    // Connect SSE for progress
    if (sseRef.current) sseRef.current.close();
    const sse = new EventSource(`${BASE_URL}/scrape/horses/progress`);
    sseRef.current = sse;

    sse.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'horse_list') {
          setSyncProgress({ current: 0, total: data.total, name: `取得馬匹列表：${data.total} 匹` });
        } else if (data.type === 'horse_start') {
          setSyncProgress({ current: data.current, total: data.total, name: data.horseId });
        } else if (data.type === 'horse_done') {
          setSyncProgress({ current: data.current, total: data.total, name: `${data.horseId} ${data.name || ''}` });
        } else if (data.type === 'completed') {
          setSyncProgress(null);
          setFullSyncing(false);
          sse.close();
          alert('馬匹資料全量更新完成！');
          if (searched) handleSearch({ preventDefault: () => {} });
        } else if (data.type === 'error') {
          setSyncProgress(null);
          setFullSyncing(false);
          sse.close();
          alert('更新失敗：' + data.message);
        }
      } catch (_) {}
    };

    sse.onerror = () => {
      if (fullSyncing) {
        setFullSyncing(false);
        setSyncProgress(null);
        sse.close();
      }
    };
  }

  return (
    <div>
      <h1 className="page-title">馬匹資料</h1>

      <div className="scrape-actions" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <button className="btn btn-success" onClick={handleFullSync} disabled={fullSyncing}>
          {fullSyncing ? '全量更新中...' : '全量 Sync 馬匹'}
        </button>
        {fullSyncing && syncProgress && (
          <span style={{ fontSize: '0.9em', color: '#555' }}>
            {syncProgress.total > 0
              ? `${syncProgress.current} / ${syncProgress.total} — ${syncProgress.name}`
              : syncProgress.name}
          </span>
        )}
      </div>

      <form className="filters" onSubmit={handleSearch}>
        <div className="filter-group">
          <label>搜尋馬匹</label>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="輸入馬名或馬匹 ID（如 HK_2023_J062）"
            style={{ padding: '6px 10px', minWidth: 280, border: '1px solid #ccc', borderRadius: 4 }}
          />
        </div>
        <button className="btn btn-primary" type="submit">搜尋</button>
        <button className="btn btn-secondary" type="button" onClick={() => {
          setSearchQuery(''); setHorses([]); setSearched(false); setSelectedHorse(null);
        }}>重置</button>
      </form>

      {loading && <div className="loading">搜尋中...</div>}
      {error && <div className="error">{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: selectedHorse ? '1fr 1fr' : '1fr', gap: 20 }}>
        {/* Horse list */}
        {searched && !loading && (
          <div className="card">
            <div className="card-title">搜尋結果（{horses.length} 匹）</div>
            {horses.length === 0 ? (
              <div className="empty-state">沒有符合的馬匹。可按「全量 Sync 馬匹」從 HKJC 抓取所有馬匹。</div>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>馬匹 ID</th>
                      <th>馬名</th>
                      <th>性別</th>
                      <th>馬齡</th>
                      <th>現時評分</th>
                      <th>練馬師</th>
                    </tr>
                  </thead>
                  <tbody>
                    {horses.map(h => (
                      <tr
                        key={h.id}
                        onClick={() => handleSelectHorse(h)}
                        style={{ cursor: 'pointer', background: selectedHorse?.id === h.id ? '#e8edf8' : '' }}
                      >
                        <td style={{ fontWeight: 700, color: '#032169' }}>{h.id}</td>
                        <td style={{ textAlign: 'left' }}>{h.name_zh || '-'}</td>
                        <td>{h.sex || '-'}</td>
                        <td>{h.age || '-'}</td>
                        <td>{h.current_rating || '-'}</td>
                        <td>{h.trainer_id || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Horse detail */}
        {selectedHorse && (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="card-title">{selectedHorse.name_zh || selectedHorse.id} 詳細資料</div>
              <button className="btn btn-success" onClick={handleScrapeHorse} disabled={scraping} style={{ fontSize: '0.85em' }}>
                {scraping ? '更新中...' : '從 HKJC 更新'}
              </button>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {[
                  ['馬匹 ID', selectedHorse.id],
                  ['馬名', selectedHorse.name_zh],
                  ['英文名', selectedHorse.name_en],
                  ['出生地', selectedHorse.origin],
                  ['馬齡', selectedHorse.age],
                  ['毛色', selectedHorse.color],
                  ['性別', selectedHorse.sex],
                  ['冠/亞/季', selectedHorse.wins != null ? `${selectedHorse.wins}/${selectedHorse.seconds}/${selectedHorse.thirds}` : '-'],
                  ['總出賽', selectedHorse.total_starts],
                  ['練馬師', selectedHorse.trainer_id],
                  ['馬主', selectedHorse.owner],
                  ['現時評分', selectedHorse.current_rating],
                  ['季初評分', selectedHorse.season_rating],
                  ['父系', selectedHorse.sire],
                  ['母系', selectedHorse.dam],
                ].map(([label, value]) => (
                  <tr key={label} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={{ padding: '6px 8px', color: '#666', width: 100, verticalAlign: 'top' }}>{label}</td>
                    <td style={{ padding: '6px 8px', fontWeight: 500 }}>{value || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
