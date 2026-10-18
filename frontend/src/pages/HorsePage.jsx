import React, { useState, useEffect, useRef } from 'react';
import api from '../api';

const BASE_URL = '/api';
const COURSE_MAP = { ST: '沙田', HV: '跑馬地', CGA: '從化' };
const TH = ({ children, left }) => (
  <th style={{ padding: '4px 8px', textAlign: left ? 'left' : 'center', fontWeight: 600,
    color: '#032169', borderBottom: '1px solid #c0cce8', whiteSpace: 'nowrap',
    background: '#e8eef8', fontSize: '0.78rem' }}>
    {children}
  </th>
);
const TD = ({ children, left, bold, color }) => (
  <td style={{ padding: '4px 8px', textAlign: left ? 'left' : 'center',
    fontWeight: bold ? 700 : 400, color: color || '#333', fontSize: '0.78rem',
    whiteSpace: 'nowrap' }}>
    {children ?? '—'}
  </td>
);

// ── Past race records table ────────────────────────────────────────────────
function HorseRecords({ horseId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    setData(null); setErr(null);
    if (!horseId) return;
    setLoading(true);
    api.get(`/horses/${horseId}/records`)
      .then(r => setData(r.data))
      .catch(e => setErr(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [horseId]);

  if (!horseId) return null;
  if (loading) return <div style={{ padding: 12, color: '#999', fontSize: '0.85rem' }}>載入過往賽績...</div>;
  if (err)     return <div style={{ padding: 12, color: '#dc3545', fontSize: '0.85rem' }}>{err}</div>;
  if (!data)   return null;

  const records = data.records || [];

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-title">過往賽績（{records.length} 場）</div>
      {records.length === 0 ? (
        <div className="empty-state">暫無賽績記錄</div>
      ) : (
        <div className="table-wrapper">
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.78rem' }}>
            <thead>
              <tr>
                <TH>日期</TH>
                <TH>馬場</TH>
                <TH>途程</TH>
                <TH>跑道</TH>
                <TH>班次</TH>
                <TH>場地</TH>
                <TH>檔位</TH>
                <TH>騎師</TH>
                <TH left>配備</TH>
                <TH>負磅</TH>
                <TH>評分</TH>
                <TH>賠率</TH>
                <TH>名次</TH>
                <TH>距離</TH>
                <TH left>沿途位置</TH>
                <TH>完成時間</TH>
              </tr>
            </thead>
            <tbody>
              {records.map((r, i) => {
                const isWin   = r.finish_position === 1;
                const isPlace = r.finish_position <= 3;
                const posColor = isWin ? '#28a745' : isPlace ? '#007bff' : '#333';
                return (
                  <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#f7f9ff' }}>
                    <TD>{r.race_date}</TD>
                    <TD>{COURSE_MAP[r.racecourse] || r.racecourse}</TD>
                    <TD>{r.distance ? `${r.distance}M` : '—'}</TD>
                    <TD>{r.track_type === 'AWT' ? '全天候' : '草地'}</TD>
                    <TD left>{r.race_class}</TD>
                    <TD>{r.going}</TD>
                    <TD>{r.draw}</TD>
                    <TD>{r.jockey_id}</TD>
                    <TD left>{r.gear || '—'}</TD>
                    <TD>{r.actual_weight}</TD>
                    <TD>{r.rating}</TD>
                    <TD color="#555">{r.win_odds != null ? r.win_odds : '—'}</TD>
                    <TD bold color={posColor}>
                      {r.finish_position != null
                        ? `${r.finish_position}${r.total_runners ? `/${r.total_runners}` : ''}`
                        : '—'}
                    </TD>
                    <TD>{r.margin_to_winner}</TD>
                    <TD left>{r.running_positions}</TD>
                    <TD>{r.finish_time}</TD>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Shared workout table ──────────────────────────────────────────────────
function WorkoutTable({ rows }) {
  if (!rows.length) return <div style={{ color: '#999', fontSize: '0.82rem', padding: '8px 0' }}>沒有紀錄</div>;
  return (
    <div className="table-wrapper">
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.78rem' }}>
        <thead>
          <tr>
            <TH>日期</TH>
            <TH>馬場</TH>
            <TH>名次</TH>
            <TH>相隔天數</TH>
            <TH>快操</TH>
            <TH>快操均時</TH>
            <TH>踱步</TH>
            <TH>游水</TH>
            <TH>試閘</TH>
            <TH>彈閘</TH>
            <TH>缺課</TH>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const isWin   = r.finish_position === 1;
            const isPlace = r.finish_position <= 3;
            const posColor = isWin ? '#28a745' : isPlace ? '#007bff' : '#666';
            return (
              <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#f7f9ff' }}>
                <TD>{r.race_date}</TD>
                <TD>{COURSE_MAP[r.racecourse] || r.racecourse}</TD>
                <TD bold color={posColor}>{r.finish_position ?? '—'}</TD>
                <TD color={r.days_since_prev == null ? '#bbb' : r.days_since_prev >= 60 ? '#dc3545' : '#333'}>
                  {r.days_since_prev ?? '—'}
                </TD>
                <TD bold color={r.gallop_count > 0 ? '#032169' : '#bbb'}>
                  {r.gallop_count > 0 ? r.gallop_count : '—'}
                </TD>
                <TD color={r.avg_gallop_time ? '#032169' : '#bbb'}>
                  {r.avg_gallop_time ?? '—'}
                </TD>
                <TD color={r.trotting_count > 0 ? '#333' : '#bbb'}>
                  {r.trotting_count > 0 ? r.trotting_count : '—'}
                </TD>
                <TD color={r.swimming_count > 0 ? '#0077cc' : '#bbb'}>
                  {r.swimming_count > 0 ? r.swimming_count : '—'}
                </TD>
                <TD color={r.trial_count > 0 ? '#e67e00' : '#bbb'}>
                  {r.trial_count > 0 ? r.trial_count : '—'}
                </TD>
                <TD color={r.gate_practice_count > 0 ? '#8e44ad' : '#bbb'}>
                  {r.gate_practice_count > 0 ? r.gate_practice_count : '—'}
                </TD>
                <TD color={r.absence_days > 0 ? '#dc3545' : '#bbb'}>
                  {r.absence_days != null ? (r.absence_days > 0 ? r.absence_days : '—') : '—'}
                </TD>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SectionTitle({ label, count }) {
  return (
    <div style={{
      fontSize: '0.82rem', fontWeight: 700, color: '#032169',
      borderLeft: '3px solid #032169', paddingLeft: 8,
      marginBottom: 8, marginTop: 18,
    }}>
      {label} <span style={{ fontWeight: 400, color: '#888' }}>({count}場)</span>
    </div>
  );
}

// ── Morning workout analysis panel ────────────────────────────────────────
function HorseWorkouts({ horseId, horseName }) {
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(false);
  const [err, setErr]             = useState(null);
  const [scraping, setScraping]   = useState(false);
  const [scrapeMsg, setScrapeMsg] = useState(null);
  const sseRef = useRef(null);

  useEffect(() => {
    setData(null); setErr(null); setScrapeMsg(null); setScraping(false);
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
    if (!horseId) return;
    loadWorkouts();
  }, [horseId]);

  useEffect(() => () => { sseRef.current?.close(); }, []);

  function loadWorkouts() {
    setLoading(true);
    api.get(`/horses/${horseId}/workouts`)
      .then(r => setData(r.data))
      .catch(e => setErr(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }

  function startScrape() {
    if (scraping) return;
    setScraping(true);
    setScrapeMsg('啟動中...');

    api.post(`/horses/${horseId}/scrape-workouts`).catch(() => {});

    if (sseRef.current) sseRef.current.close();
    const sse = new EventSource(`${BASE_URL}/horses/${horseId}/workout-progress`);
    sseRef.current = sse;

    sse.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === 'start') {
          setScrapeMsg('抓取中...');
        } else if (d.type === 'progress') {
          setScrapeMsg(d.message || '抓取中...');
        } else if (d.type === 'completed') {
          setScraping(false);
          setScrapeMsg(null);
          sse.close();
          loadWorkouts();
        } else if (d.type === 'error') {
          setScraping(false);
          setScrapeMsg(null);
          setErr(d.message);
          sse.close();
        }
      } catch (_) {}
    };
    sse.onerror = () => { setScraping(false); setScrapeMsg(null); sse.close(); };
  }

  if (!horseId) return null;

  const races   = data?.races || [];
  const hasData = data?.has_data;

  // Part 1 — placed races (finish ≤ 3), most recent first
  const placedRaces  = races.filter(r => r.finish_position != null && r.finish_position <= 3);
  // Part 2 — last 10 races regardless of position
  const recentRaces  = races.slice(0, 10);

  // Summary stat boxes
  const totalGallops  = races.reduce((s, r) => s + (r.gallop_count || 0), 0);
  const totalTrials   = races.reduce((s, r) => s + (r.trial_count || 0), 0);
  const totalTrotting = races.reduce((s, r) => s + (r.trotting_count || 0), 0);
  const totalSwim     = races.reduce((s, r) => s + (r.swimming_count || 0), 0);

  const racesWithGallop    = races.filter(r => r.gallop_count > 0);
  const racesWithoutGallop = races.filter(r => r.gallop_count === 0);
  const winRate = arr => arr.length ? (arr.filter(r => r.finish_position === 1).length / arr.length * 100).toFixed(1) + '%' : '—';
  const plcRate = arr => arr.length ? (arr.filter(r => r.finish_position <= 3).length / arr.length * 100).toFixed(1) + '%' : '—';

  const statBox = (label, value) => (
    <div style={{ background: '#f0f4ff', borderRadius: 6, padding: '8px 14px', minWidth: 90, textAlign: 'center' }}>
      <div style={{ fontSize: '0.72rem', color: '#666', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#032169' }}>{value}</div>
    </div>
  );

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="card-title" style={{ marginBottom: 0 }}>分析晨操</div>
        <button
          className="btn btn-primary"
          style={{ fontSize: '0.8rem', padding: '4px 12px' }}
          onClick={startScrape}
          disabled={scraping || loading}
        >
          {scraping ? '抓取中...' : hasData ? '重新抓取' : '抓取晨操資料'}
        </button>
      </div>

      {scraping && scrapeMsg && (
        <div style={{ fontSize: '0.82rem', color: '#555', marginBottom: 10 }}>{scrapeMsg}</div>
      )}

      {loading && <div style={{ color: '#999', fontSize: '0.85rem' }}>載入中...</div>}
      {err && <div style={{ color: '#dc3545', fontSize: '0.85rem' }}>{err}</div>}

      {!loading && !hasData && !scraping && (
        <div className="empty-state">尚未抓取晨操資料，點擊「抓取晨操資料」開始。</div>
      )}

      {hasData && races.length > 0 && (
        <>
          {/* Summary stats */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
            {statBox('總場次', races.length)}
            {statBox('快操次數', totalGallops)}
            {statBox('試閘次數', totalTrials)}
            {statBox('踱步次數', totalTrotting)}
            {statBox('游水次數', totalSwim)}
          </div>

          {/* Gallop correlation */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 6, fontSize: '0.82rem' }}>
            <div style={{ background: '#efffef', borderRadius: 5, padding: '6px 12px' }}>
              <strong>有快操 ({racesWithGallop.length}場)：</strong>
              勝率 <strong style={{ color: '#28a745' }}>{winRate(racesWithGallop)}</strong>
              ／位率 <strong style={{ color: '#007bff' }}>{plcRate(racesWithGallop)}</strong>
            </div>
            <div style={{ background: '#fff8ee', borderRadius: 5, padding: '6px 12px' }}>
              <strong>無快操 ({racesWithoutGallop.length}場)：</strong>
              勝率 <strong style={{ color: '#28a745' }}>{winRate(racesWithoutGallop)}</strong>
              ／位率 <strong style={{ color: '#007bff' }}>{plcRate(racesWithoutGallop)}</strong>
            </div>
          </div>

          {/* Part 1 — placed races */}
          <SectionTitle label="過往上名場次" count={placedRaces.length} />
          <WorkoutTable rows={placedRaces} />

          {/* Divider */}
          <div style={{ borderTop: '1px solid #e0e4ef', margin: '18px 0 0' }} />

          {/* Part 2 — recent races */}
          <SectionTitle label="最近場次" count={recentRaces.length} />
          <WorkoutTable rows={recentRaces} />
        </>
      )}
    </div>
  );
}

export default function HorsePage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [horses, setHorses]           = useState([]);
  const [selectedHorse, setSelectedHorse] = useState(null);
  const [loading, setLoading]         = useState(false);
  const [scraping, setScraping]       = useState(false);
  const [fullSyncing, setFullSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(null);
  const [error, setError]             = useState(null);
  const [searched, setSearched]       = useState(false);
  const sseRef = useRef(null);

  useEffect(() => () => { sseRef.current?.close(); }, []);

  async function handleSearch(e) {
    e.preventDefault();
    setLoading(true); setError(null); setSearched(true); setSelectedHorse(null);
    try {
      const res = await api.get('/horses', { params: searchQuery.trim() ? { q: searchQuery.trim() } : {} });
      setHorses(res.data);
    } catch (err) {
      setError('搜尋失敗：' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleScrapeHorse() {
    if (!selectedHorse) return;
    setScraping(true);
    try {
      await api.post(`/scrape/horse/${selectedHorse.id}`);
      const res = await api.get(`/horses/${selectedHorse.id}`);
      setSelectedHorse(res.data);
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
    try { await api.post('/scrape/horses'); } catch (_) {}

    if (sseRef.current) sseRef.current.close();
    const sse = new EventSource(`${BASE_URL}/scrape/horses/progress`);
    sseRef.current = sse;
    sse.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === 'horse_list')  setSyncProgress({ current: 0, total: d.total, name: `取得馬匹列表：${d.total} 匹` });
        else if (d.type === 'horse_start') setSyncProgress({ current: d.current, total: d.total, name: d.horseId });
        else if (d.type === 'horse_done')  setSyncProgress({ current: d.current, total: d.total, name: `${d.horseId} ${d.name || ''}` });
        else if (d.type === 'completed') {
          setSyncProgress(null); setFullSyncing(false); sse.close();
          alert('馬匹資料全量更新完成！');
          if (searched) handleSearch({ preventDefault: () => {} });
        } else if (d.type === 'error') {
          setSyncProgress(null); setFullSyncing(false); sse.close();
          alert('更新失敗：' + d.message);
        }
      } catch (_) {}
    };
    sse.onerror = () => { if (fullSyncing) { setFullSyncing(false); setSyncProgress(null); sse.close(); } };
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
      {error   && <div className="error">{error}</div>}

      {/* Top section: list + detail side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: selectedHorse ? '1fr 1fr' : '1fr', gap: 20 }}>
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
                      <th>馬匹 ID</th><th>馬名</th><th>性別</th>
                      <th>馬齡</th><th>現時評分</th><th>練馬師</th>
                    </tr>
                  </thead>
                  <tbody>
                    {horses.map(h => (
                      <tr key={h.id}
                        onClick={() => setSelectedHorse(h)}
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
                  ['馬匹 ID',   selectedHorse.id],
                  ['馬名',      selectedHorse.name_zh],
                  ['英文名',    selectedHorse.name_en],
                  ['出生地',    selectedHorse.origin],
                  ['馬齡',      selectedHorse.age],
                  ['毛色',      selectedHorse.color],
                  ['性別',      selectedHorse.sex],
                  ['冠/亞/季',  selectedHorse.wins != null ? `${selectedHorse.wins}/${selectedHorse.seconds}/${selectedHorse.thirds}` : '-'],
                  ['總出賽',    selectedHorse.total_starts],
                  ['練馬師',    selectedHorse.trainer_id],
                  ['馬主',      selectedHorse.owner],
                  ['現時評分',  selectedHorse.current_rating],
                  ['季初評分',  selectedHorse.season_rating],
                  ['父系',      selectedHorse.sire],
                  ['母系',      selectedHorse.dam],
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

      {/* Full-width panels below */}
      {selectedHorse && (
        <>
          <HorseRecords horseId={selectedHorse.id} />
          <HorseWorkouts horseId={selectedHorse.id} horseName={selectedHorse.name_zh} />
        </>
      )}
    </div>
  );
}
