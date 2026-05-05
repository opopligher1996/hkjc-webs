import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';

// ── Helpers ──────────────────────────────────────────────────────────────────
function DeltaCell({ delta }) {
  if (delta === null || delta === undefined) return <td>-</td>;
  const num = parseFloat(delta);
  if (isNaN(num)) return <td>-</td>;
  const color = num < 0 ? '#007700' : num > 0 ? '#cc0000' : '#555';
  const sign = num > 0 ? '+' : '';
  return (
    <td style={{ color, fontWeight: Math.abs(num) >= 0.5 ? 700 : 'normal', whiteSpace: 'nowrap' }}>
      {sign}{num.toFixed(2)}
    </td>
  );
}

function SegCell({ seg }) {
  if (!seg) return <td style={{ color: '#aaa' }}>-</td>;
  return <td style={{ whiteSpace: 'nowrap' }}>{seg}</td>;
}

// ── Day Races Popup ───────────────────────────────────────────────────────────
// Shows all races on a given date with their sectional times vs standard.
// Opened when user clicks a past race row in HorseHistoryRow.
function DayRacesPopup({ date, highlightRaceNo, highlightHorseName, highlightHorseNo, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scraping, setScraping] = useState(false);
  const [scrapeMsg, setScrapeMsg] = useState('');
  const [backfilling, setBackfilling] = useState(false);
  // expandedRaces: Set of raceNos that are expanded. Highlighted race auto-expands.
  const [expandedRaces, setExpandedRaces] = useState(() => new Set([highlightRaceNo]));

  function fetchDay() {
    setLoading(true);
    setError(null);
    api.get('/sectional/day', { params: { date }, timeout: 120000 })
      .then(res => setData(res.data))
      .catch(e => setError('載入失敗：' + e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { fetchDay(); }, [date]);

  // Close on Escape key
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  async function scrapeMissing() {
    if (!data || data.missingRaceNos.length === 0) return;
    setScraping(true);
    setScrapeMsg(`正在抓取 ${data.missingRaceNos.length} 場缺少的分段時間...`);
    try {
      const res = await api.post('/sectional/scrape-day', {
        date,
        racecourse: data.racecourse,
        raceNos: data.missingRaceNos,
      }, { timeout: 120000 });
      const d = res.data;
      setScrapeMsg(`完成：成功 ${d.scraped} 場，共處理 ${d.results.length} 場`);
      // Reload
      await new Promise(r => setTimeout(r, 500));
      fetchDay();
    } catch (e) {
      setScrapeMsg('抓取失敗：' + e.message);
    } finally {
      setScraping(false);
    }
  }

  async function backfillFastestSplits() {
    if (!data) return;
    setBackfilling(true);
    setScrapeMsg('正在補抓各段最快時間...');
    try {
      const res = await api.post('/sectional/backfill-fastest-splits', {
        date,
        racecourse: data.racecourse,
      });
      const d = res.data;
      setScrapeMsg(`補抓完成：成功 ${d.backfilled} 場`);
      await new Promise(r => setTimeout(r, 500));
      fetchDay();
    } catch (e) {
      setScrapeMsg('補抓失敗：' + e.message);
    } finally {
      setBackfilling(false);
    }
  }

  function toggleRace(raceNo) {
    setExpandedRaces(prev => {
      const next = new Set(prev);
      if (next.has(raceNo)) next.delete(raceNo); else next.add(raceNo);
      return next;
    });
  }

  const ALL_SEG_LABELS = ['第1段','第2段','第3段','第4段','第5段','第6段'];

  const dateDisplay = date
    ? new Date(date).toLocaleDateString('zh-HK', { year: 'numeric', month: '2-digit', day: '2-digit' })
    : date;

  const missingCount = data ? data.missingRaceNos.length : 0;
  // Races that have sectional data but no fastest splits
  const missingFastestCount = data
    ? data.races.filter(r => !r.fastestSplits).length
    : 0;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '40px 16px', overflowY: 'auto',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: '#fff', borderRadius: 8, boxShadow: '0 4px 32px rgba(0,0,0,0.25)',
        width: '100%', maxWidth: 900, padding: 24, position: 'relative',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0, color: '#032169' }}>{dateDisplay} 各場分段時間分析</h3>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#555', lineHeight: 1 }}
            aria-label="關閉"
          >✕</button>
        </div>

        {/* Highlighted horse summary card */}
        {!loading && data && highlightHorseName && (() => {
          const highlightRace = data.races.find(r => r.raceNo === highlightRaceNo);
          const horse = highlightRace?.horses.find(h => h.horseNo === highlightHorseNo);
          if (!highlightRace || !horse) return null;
          const segCount = horse.segments.filter(s => s !== null).length;
          const segLabels = ALL_SEG_LABELS.slice(0, segCount);
          const stdSlice = highlightRace.standardSplits.slice(-segCount);
          return (
            <div style={{
              marginBottom: 16, padding: '10px 14px',
              background: '#032169', color: '#fff',
              borderRadius: 6, fontSize: '0.88em',
            }}>
              <div style={{ fontWeight: 700, fontSize: '1em', marginBottom: 6 }}>
                {highlightHorseName} — 第{highlightRaceNo}場
                <span style={{ fontWeight: 400, marginLeft: 12, opacity: 0.85 }}>
                  {highlightRace.raceClass} · {highlightRace.distance}米 · {highlightRace.trackType} · {highlightRace.going}
                </span>
                {horse.finishPosition && (
                  <span style={{ marginLeft: 12, opacity: 0.85 }}>名次: {horse.finishPosition}</span>
                )}
                {horse.finishTime && (
                  <span style={{ marginLeft: 12, opacity: 0.85 }}>完成時間: {horse.finishTime}</span>
                )}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
                {segLabels.map((label, i) => {
                  const seg = horse.segments[i];
                  const delta = horse.deltas[i];
                  const std = stdSlice[i];
                  return (
                    <span key={i} style={{ whiteSpace: 'nowrap' }}>
                      <span style={{ opacity: 0.7 }}>{label}: </span>
                      <strong>{seg || '-'}</strong>
                      {std && <span style={{ opacity: 0.6, marginLeft: 2 }}>({std})</span>}
                      {delta != null && (
                        <span style={{
                          marginLeft: 4, fontWeight: 700,
                          color: delta < 0 ? '#7fffaa' : delta > 0 ? '#ff8080' : '#ccc',
                        }}>
                          {delta > 0 ? '+' : ''}{parseFloat(delta).toFixed(2)}
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* Summary bar + scrape button */}
        {!loading && data && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            marginBottom: 16, padding: '8px 12px',
            background: missingCount > 0 ? '#fff8e1' : '#f0f8f0',
            borderRadius: 6, fontSize: '0.88em',
          }}>
            <span>
              已載入 <strong>{data.scrapedRaceNos.length}</strong> / <strong>{data.totalRaces}</strong> 場
              {missingCount > 0 && (
                <span style={{ color: '#c77700', marginLeft: 8 }}>
                  （第 {data.missingRaceNos.join('、') } 場未抓取）
                </span>
              )}
            </span>
            {missingCount > 0 && (
              <button
                className="btn btn-secondary"
                onClick={scrapeMissing}
                disabled={scraping || backfilling}
                style={{ fontSize: '0.9em' }}
              >
                {scraping ? '抓取中...' : `抓取缺少的 ${missingCount} 場`}
              </button>
            )}
            {missingFastestCount > 0 && missingCount === 0 && (
              <button
                className="btn btn-secondary"
                onClick={backfillFastestSplits}
                disabled={scraping || backfilling}
                style={{ fontSize: '0.9em' }}
              >
                {backfilling ? '補抓中...' : `補抓 ${missingFastestCount} 場最快時間`}
              </button>
            )}
            {scrapeMsg && <span style={{ color: (scraping || backfilling) ? '#555' : '#007700', fontSize: '0.9em' }}>{scrapeMsg}</span>}
          </div>
        )}

        {loading && <div style={{ padding: 20, textAlign: 'center', color: '#888' }}>載入中...</div>}
        {error && <div className="error">{error}</div>}

        {!loading && data && data.races.length === 0 && (
          <div className="empty-state">此日期暫無已抓取的分段時間記錄</div>
        )}

        {!loading && data && data.races.map(race => {
          const segCount = race.horses.length > 0
            ? race.horses[0].segments.filter(s => s !== null).length
            : 0;
          const segLabels = ALL_SEG_LABELS.slice(0, segCount);
          const isHighlighted = race.raceNo === highlightRaceNo;
          const isExpanded = expandedRaces.has(race.raceNo);

          return (
            <div key={race.raceNo} style={{
              marginBottom: 24,
              border: isHighlighted ? '2px solid #032169' : '1px solid #e0e0e0',
              borderRadius: 6,
              overflow: 'hidden',
            }}>
              {/* Race header */}
              <div
                style={{
                  background: isHighlighted ? '#032169' : '#f0f4ff',
                  color: isHighlighted ? '#fff' : '#032169',
                  padding: '6px 12px',
                  fontWeight: 700,
                  display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap',
                  cursor: 'pointer', userSelect: 'none',
                }}
                onClick={() => toggleRace(race.raceNo)}
              >
                <span>{isExpanded ? '▾' : '▸'} 第{race.raceNo}場</span>
                <span style={{ fontWeight: 400, fontSize: '0.9em' }}>
                  {race.racecourse} · {race.raceClass} · {race.distance}米 · {race.trackType} · {race.going}
                </span>
                {race.standardTime && (
                  <span style={{ fontWeight: 400, fontSize: '0.9em' }}>
                    標準時間: {race.standardTime}
                  </span>
                )}
              </div>

              {/* Fastest splits summary (always visible, compact) */}
              {race.fastestSplits && race.fastestSplits.length > 0 && (() => {
                const fs = race.fastestSplits;
                const stdSlice = race.standardSplits.slice(-segCount);
                const fsAligned = fs.slice(-segCount);
                return (
                  <div style={{
                    background: '#eaf3ff', padding: '4px 12px',
                    fontSize: '0.82em', display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap',
                  }}>
                    <span style={{ fontWeight: 700, color: '#032169', marginRight: 6 }}>各段最快:</span>
                    {Array.from({ length: segCount }, (_, i) => {
                      const val = fsAligned[i];
                      const std = stdSlice[i] ? parseFloat(stdSlice[i]) : null;
                      const delta = (val != null && std != null) ? parseFloat((val - std).toFixed(2)) : null;
                      return (
                        <span key={i} style={{ marginRight: 8, whiteSpace: 'nowrap' }}>
                          {segLabels[i]}: <strong style={{ color: '#032169' }}>{val != null ? val.toFixed(2) : '-'}</strong>
                          {delta != null && (
                            <span style={{
                              marginLeft: 3, fontWeight: 600,
                              color: delta < 0 ? '#007700' : delta > 0 ? '#cc0000' : '#555',
                            }}>
                              ({delta > 0 ? '+' : ''}{delta.toFixed(2)})
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                );
              })()}

              {/* Expanded: standard splits row + horses table */}
              {isExpanded && (
                <>
                  {race.standardSplits.length > 0 && segCount > 0 && (
                    <div style={{
                      background: '#f9fbff', padding: '4px 12px',
                      fontSize: '0.8em', color: '#555',
                      display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap',
                    }}>
                      <span style={{ marginRight: 6, fontWeight: 600 }}>標準分段:</span>
                      {race.standardSplits.slice(-segCount).map((v, i) => (
                        <span key={i} style={{ marginRight: 8 }}>{segLabels[i]}: <strong>{v}</strong></span>
                      ))}
                    </div>
                  )}

                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', fontSize: '0.85em', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: '#eef2ff' }}>
                          <th style={{ padding: '4px 8px', textAlign: 'center' }}>名次</th>
                          <th style={{ padding: '4px 8px', textAlign: 'center' }}>馬號</th>
                          <th style={{ padding: '4px 8px', textAlign: 'left' }}>馬名</th>
                          <th style={{ padding: '4px 8px', textAlign: 'center' }}>完成時間</th>
                          {segLabels.map((l, i) => (
                            <React.Fragment key={i}>
                              <th style={{ padding: '4px 8px', textAlign: 'center' }}>{l}</th>
                              <th style={{ padding: '4px 8px', textAlign: 'center', color: '#666', fontSize: '0.85em' }}>差</th>
                            </React.Fragment>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {race.horses.map((h, idx) => (
                          <tr key={idx} style={{ borderTop: '1px solid #eee', background: idx % 2 === 0 ? '#fff' : '#fafafa' }}>
                            <td style={{ padding: '3px 8px', textAlign: 'center', fontWeight: 700 }}>{h.finishPosition ?? '-'}</td>
                            <td style={{ padding: '3px 8px', textAlign: 'center', color: '#032169', fontWeight: 600 }}>{h.horseNo}</td>
                            <td style={{ padding: '3px 8px', whiteSpace: 'nowrap' }}>{h.horseName}</td>
                            <td style={{ padding: '3px 8px', textAlign: 'center' }}>{h.finishTime || '-'}</td>
                            {Array.from({ length: segCount }, (_, i) => (
                              <React.Fragment key={i}>
                                <SegCell seg={h.segments[i]} />
                                <DeltaCell delta={h.deltas[i]} />
                              </React.Fragment>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          );
        })}

        <div style={{ fontSize: '0.78em', color: '#888', marginTop: 8 }}>
          差值: 負數(綠色)=快於標準，正數(紅色)=慢於標準 · 按 Esc 或點擊背景關閉
        </div>
      </div>
    </div>
  );
}

// ── Reference Standard Sectional Times ───────────────────────────────────────
// Shows the course_times benchmark row matching this race's conditions.
function RefSectionalSection({ racecourse, raceClass, distance, trackType }) {
  const [row, setRow] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!racecourse || !distance) { setRow(null); return; }
    setLoading(true);
    api.get('/coursetime')
      .then(res => {
        const all = res.data || [];
        // Match by racecourse + distance + race_class (+ track_type if available)
        let match = all.find(r =>
          r.racecourse === racecourse &&
          parseInt(r.distance) === parseInt(distance) &&
          r.race_class === raceClass &&
          (!trackType || r.track_type === trackType)
        );
        // Fallback: ignore track_type
        if (!match) match = all.find(r =>
          r.racecourse === racecourse &&
          parseInt(r.distance) === parseInt(distance) &&
          r.race_class === raceClass
        );
        setRow(match || null);
      })
      .catch(() => setRow(null))
      .finally(() => setLoading(false));
  }, [racecourse, raceClass, distance, trackType]);

  const ALL_SPLIT_NAMES = ['起點-2000米','2000-1600米','1600-1200米','1200-800米','800-400米','400米-終點'];
  const ALL_SPLIT_KEYS = ['split_start_2000','split_2000_1600','split_1600_1200','split_1200_800','split_800_400','split_400_finish'];

  const splits = row ? ALL_SPLIT_KEYS.map(k => row[k]).filter(v => v !== null && v !== '' && v !== undefined) : [];
  const splitNames = ALL_SPLIT_NAMES.slice(-splits.length);

  if (!racecourse || !distance) return null;

  return (
    <div style={{ marginBottom: 16 }}>
      <h5 style={{ margin: '0 0 6px', color: '#032169' }}>參考分段時間</h5>
      {loading && <div style={{ fontSize: '0.82em', color: '#888' }}>載入中...</div>}
      {!loading && !row && <div style={{ fontSize: '0.82em', color: '#888' }}>暫無此條件的參考分段時間</div>}
      {!loading && row && (
        <div className="table-wrapper" style={{ overflowX: 'auto' }}>
          <table style={{ fontSize: '0.85em', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#eef2ff' }}>
                <th style={{ padding: '4px 10px', border: '1px solid #ccd' }}>馬場</th>
                <th style={{ padding: '4px 10px', border: '1px solid #ccd' }}>途程</th>
                <th style={{ padding: '4px 10px', border: '1px solid #ccd' }}>場地</th>
                <th style={{ padding: '4px 10px', border: '1px solid #ccd' }}>班次</th>
                <th style={{ padding: '4px 10px', border: '1px solid #ccd', fontWeight: 700 }}>標準時間</th>
                {splitNames.map((name, i) => (
                  <th key={i} style={{ padding: '4px 10px', border: '1px solid #ccd', whiteSpace: 'nowrap' }}>{name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ padding: '4px 10px', border: '1px solid #dde' }}>{row.racecourse}</td>
                <td style={{ padding: '4px 10px', border: '1px solid #dde' }}>{row.distance}米</td>
                <td style={{ padding: '4px 10px', border: '1px solid #dde' }}>{row.track_type || '-'}</td>
                <td style={{ padding: '4px 10px', border: '1px solid #dde' }}>{row.race_class}</td>
                <td style={{ padding: '4px 10px', border: '1px solid #dde', fontWeight: 700 }}>{row.standard_time || '-'}</td>
                {splits.map((v, i) => (
                  <td key={i} style={{ padding: '4px 10px', border: '1px solid #dde', textAlign: 'center' }}>{v}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Today's Race Sectional Times ─────────────────────────────────────────────
function TodaySectionalSection({ raceDate, raceNo }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setData(null);
    setError(null);
    setExpanded(false);
  }, [raceDate, raceNo]);

  async function fetchStored() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/sectional', { params: { date: raceDate, raceno: raceNo } });
      setData(res.data);
      setExpanded(res.data.hasData);
      if (!res.data.hasData) setError('暫無今場分段時間，請先按「更新分段時間」');
    } catch (e) {
      setError('載入失敗：' + e.message);
    } finally {
      setLoading(false);
    }
  }

  async function scrapeAndLoad() {
    setScraping(true);
    setError(null);
    try {
      const scrapeRes = await api.post('/sectional/scrape', { date: raceDate, raceno: raceNo });
      if (!scrapeRes.data.success) {
        setError(scrapeRes.data.message || '分段時間未公佈');
        return;
      }
      await fetchStored();
    } catch (e) {
      setError('更新失敗：' + e.message);
    } finally {
      setScraping(false);
    }
  }

  const segCount = data?.horses?.length > 0
    ? data.horses[0].segments.filter(s => s !== null).length
    : 4;
  const segLabels = Array.from({ length: segCount }, (_, i) => `第${i + 1}段`);

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <h5 style={{ margin: 0, color: '#032169' }}>今場分段時間</h5>
        <button className="btn btn-secondary" onClick={scrapeAndLoad} disabled={scraping || loading} style={{ fontSize: '0.82em' }}>
          {scraping ? '更新中...' : '更新分段時間'}
        </button>
        <button className="btn btn-secondary" onClick={fetchStored} disabled={loading || scraping} style={{ fontSize: '0.82em' }}>
          {loading ? '載入中...' : '從資料庫載入'}
        </button>
        {data?.hasData && (
          <button className="btn btn-secondary" onClick={() => setExpanded(e => !e)} style={{ fontSize: '0.82em' }}>
            {expanded ? '收起' : '展開'}
          </button>
        )}
      </div>

      {error && <div className="error" style={{ marginBottom: 8, fontSize: '0.85em' }}>{error}</div>}

      {data?.hasData && expanded && (
        <div>
          <div style={{ fontSize: '0.82em', color: '#555', marginBottom: 6 }}>
            {data.raceClass} · {data.distance}米 · {data.trackType} · {data.going}
          </div>
          <div className="table-wrapper" style={{ overflowX: 'auto' }}>
            <table style={{ minWidth: 500, fontSize: '0.88em' }}>
              <thead>
                <tr>
                  <th>名次</th>
                  <th>馬號</th>
                  <th>馬名</th>
                  <th>完成時間</th>
                  {segLabels.map((l, i) => (
                    <React.Fragment key={i}>
                      <th>{l}</th>
                      <th style={{ color: '#666' }}>差值</th>
                    </React.Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.horses.map(horse => (
                  <tr key={horse.horseNo}>
                    <td style={{ fontWeight: 700 }}>{horse.finishPosition}</td>
                    <td>{horse.horseNo}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{horse.horseName}</td>
                    <td>{horse.finishTime || '-'}</td>
                    {Array.from({ length: segCount }, (_, i) => (
                      <React.Fragment key={i}>
                        <SegCell seg={horse.segments[i]} />
                        <DeltaCell delta={horse.deltas[i]} />
                      </React.Fragment>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: '0.75em', color: '#888', marginTop: 4 }}>
            差值: 負數(綠色)=快於標準，正數(紅色)=慢於標準
          </div>
        </div>
      )}
    </div>
  );
}

// ── Horse History Sectional Times ─────────────────────────────────────────────
function HorseHistoryRow({ horse }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(null);
  const [popup, setPopup] = useState(null); // { date, raceNo }

  const closePopup = useCallback(() => setPopup(null), []);

  async function load() {
    if (data) { setExpanded(e => !e); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/sectional/horse', { params: { horseid: horse.horse_id, limit: 5 } });
      setData(res.data.races || []);
      setExpanded(true);
    } catch (e) {
      setError('載入失敗');
    } finally {
      setLoading(false);
    }
  }

  async function scrapeHistory() {
    setScraping(true);
    setError(null);
    try {
      await api.post('/sectional/scrape-horse', { horsename: horse.horse_name, limit: 5 }, { timeout: 120000 });
      // Reload after scraping
      const res = await api.get('/sectional/horse', { params: { horseid: horse.horse_id, limit: 5 } });
      setData(res.data.races || []);
      setExpanded(true);
    } catch (e) {
      setError('爬取失敗：' + e.message);
    } finally {
      setScraping(false);
    }
  }

  return (
    <div style={{ borderBottom: '1px solid #e8e8e8', paddingBottom: 8, marginBottom: 8 }}>
      {popup && (
        <DayRacesPopup
          date={popup.date}
          highlightRaceNo={popup.raceNo}
          highlightHorseName={popup.horseName}
          highlightHorseNo={popup.horseNo}
          onClose={closePopup}
        />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontWeight: 600, minWidth: 30 }}>{horse.horse_no}</span>
        <span style={{ minWidth: 120 }}>{horse.horse_name}</span>
        <button className="btn btn-secondary" onClick={load} disabled={loading || scraping} style={{ fontSize: '0.78em', padding: '2px 8px' }}>
          {loading ? '...' : data ? (expanded ? '收起' : '展開') : '載入往績分段'}
        </button>
        <button className="btn btn-secondary" onClick={scrapeHistory} disabled={scraping || loading} style={{ fontSize: '0.78em', padding: '2px 8px' }}>
          {scraping ? '爬取中...' : '更新往績分段'}
        </button>
        {error && <span style={{ color: '#cc0000', fontSize: '0.8em' }}>{error}</span>}
      </div>

      {data && expanded && data.length === 0 && (
        <div style={{ fontSize: '0.82em', color: '#888', marginTop: 4, paddingLeft: 30 }}>暫無往績分段時間記錄</div>
      )}

      {data && expanded && data.length > 0 && (() => {
        // Determine max seg count across all races
        const maxSegCount = data.reduce((m, race) => {
          const n = [race.seg1, race.seg2, race.seg3, race.seg4, race.seg5, race.seg6].filter(Boolean).length;
          return Math.max(m, n);
        }, 4);

        // Parse running_positions tokens: "11-4 12-7-1/4 ..." → [{pos, dist}, ...]
        function parseRunningPositions(str) {
          if (!str) return [];
          return str.trim().split(/\s+/).map(token => {
            const dashIdx = token.indexOf('-');
            if (dashIdx === -1) return { pos: token, dist: '' };
            return { pos: token.slice(0, dashIdx), dist: token.slice(dashIdx + 1) };
          });
        }

        // Sub-row label style
        const labelStyle = { padding: '1px 6px', fontSize: '0.8em', color: '#999', whiteSpace: 'nowrap', textAlign: 'right', borderRight: '1px solid #eee' };

        return (
          <div style={{ marginTop: 8, paddingLeft: 10, overflowX: 'auto' }}>
            <table style={{ fontSize: '0.82em', minWidth: 480, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f5f5f5' }}>
                  <th style={{ padding: '2px 6px', textAlign: 'left' }}>日期</th>
                  <th style={{ padding: '2px 6px' }}>馬場</th>
                  <th style={{ padding: '2px 6px' }}>場地</th>
                  <th style={{ padding: '2px 6px' }}>途程</th>
                  <th style={{ padding: '2px 6px' }}>名次</th>
                  <th style={{ padding: '2px 6px' }}>完成</th>
                  <th style={{ padding: '2px 6px', borderRight: '1px solid #eee' }}></th>
                  {Array.from({ length: maxSegCount }, (_, i) => (
                    <th key={i} style={{ padding: '2px 10px', textAlign: 'center', borderLeft: i > 0 ? '1px solid #e0e0e0' : 'none' }}>
                      第{i + 1}段
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((race, idx) => {
                  const segs = [race.seg1, race.seg2, race.seg3, race.seg4, race.seg5, race.seg6];
                  const segCount = segs.filter(Boolean).length;
                  const stdSplits = [
                    race.split_start_2000, race.split_2000_1600,
                    race.split_1600_1200, race.split_1200_800,
                    race.split_800_400, race.split_400_finish
                  ].filter(v => v != null && v !== '');
                  const alignedStd = stdSplits.slice(-segCount);
                  const deltas = segs.map((seg, i) => {
                    if (!seg || !alignedStd[i]) return null;
                    const diff = parseFloat(seg) - parseFloat(alignedStd[i]);
                    return isNaN(diff) ? null : diff.toFixed(2);
                  });
                  // fastest_splits is already aligned to segCount (last N splits)
                  const fastestRaw = Array.isArray(race.fastest_splits) ? race.fastest_splits : [];
                  const fastestAligned = fastestRaw.slice(-segCount);

                  const dateStr = race.race_date
                    ? new Date(race.race_date).toLocaleDateString('zh-HK', { month: '2-digit', day: '2-digit', year: '2-digit' })
                    : '-';
                  const rpTokens = parseRunningPositions(race.running_positions);

                  const clickHandler = () => {
                    const d = race.race_date ? new Date(race.race_date).toISOString().slice(0, 10) : null;
                    if (d) setPopup({ date: d, raceNo: race.race_no, horseName: horse.horse_name, horseNo: race.horse_no });
                  };

                  // 與最快時間差值
                  const fastestDeltas = segs.map((seg, i) => {
                    const fv = fastestAligned[i];
                    if (!seg || fv == null) return null;
                    const diff = parseFloat(seg) - fv;
                    return isNaN(diff) ? null : diff.toFixed(2);
                  });

                  const metaRowSpan = 7; // 7 sub-rows per race
                  const cellBorder = (i) => ({ borderLeft: i > 0 ? '1px solid #e0e0e0' : 'none' });
                  const sepRow = idx < data.length - 1
                    ? <tr key={`sep-${idx}`}><td colSpan={7 + maxSegCount} style={{ borderTop: '2px solid #ccc', padding: 0 }} /></tr>
                    : null;

                  return (
                    <React.Fragment key={idx}>
                      {/* Sub-row 1: 馬匹分段時間 */}
                      <tr style={{ borderTop: idx === 0 ? '1px solid #ddd' : 'none', cursor: 'pointer' }}
                          title="點擊查看當日所有賽事分段時間" onClick={clickHandler}>
                        <td rowSpan={metaRowSpan} style={{ padding: '2px 6px', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>{dateStr}</td>
                        <td rowSpan={metaRowSpan} style={{ padding: '2px 6px', verticalAlign: 'middle' }}>{race.racecourse || '-'}</td>
                        <td rowSpan={metaRowSpan} style={{ padding: '2px 6px', verticalAlign: 'middle' }}>{race.going || '-'}</td>
                        <td rowSpan={metaRowSpan} style={{ padding: '2px 6px', verticalAlign: 'middle' }}>{race.distance ? race.distance + 'm' : '-'}</td>
                        <td rowSpan={metaRowSpan} style={{ padding: '2px 6px', fontWeight: 700, verticalAlign: 'middle' }}>{race.finish_position || '-'}</td>
                        <td rowSpan={metaRowSpan} style={{ padding: '2px 6px', verticalAlign: 'middle' }}>{race.finish_time || '-'}</td>
                        <td style={labelStyle}>時間</td>
                        {Array.from({ length: maxSegCount }, (_, i) => (
                          <td key={i} style={{ padding: '1px 6px', textAlign: 'center', fontWeight: 600, ...cellBorder(i) }}>
                            {segs[i] || '-'}
                          </td>
                        ))}
                      </tr>
                      {/* Sub-row 2: 標準時間 */}
                      <tr style={{ cursor: 'pointer' }} onClick={clickHandler}>
                        <td style={labelStyle}>標準</td>
                        {Array.from({ length: maxSegCount }, (_, i) => (
                          <td key={i} style={{ padding: '1px 6px', textAlign: 'center', color: '#888', fontSize: '0.92em', ...cellBorder(i) }}>
                            {alignedStd[i] || '-'}
                          </td>
                        ))}
                      </tr>
                      {/* Sub-row 3: 與標準時間差值 */}
                      <tr style={{ cursor: 'pointer' }} onClick={clickHandler}>
                        <td style={labelStyle}>與標準差</td>
                        {Array.from({ length: maxSegCount }, (_, i) => {
                          const d = deltas[i];
                          return (
                            <td key={i} style={{
                              padding: '1px 6px', textAlign: 'center', fontSize: '0.92em',
                              fontWeight: d && Math.abs(parseFloat(d)) >= 0.5 ? 700 : 'normal',
                              color: d === null ? '#bbb' : parseFloat(d) < 0 ? '#007700' : parseFloat(d) > 0 ? '#cc0000' : '#555',
                              ...cellBorder(i),
                            }}>
                              {d === null ? '-' : (parseFloat(d) > 0 ? '+' : '') + d}
                            </td>
                          );
                        })}
                      </tr>
                      {/* Sub-row 4: 該場最快分段 */}
                      <tr style={{ cursor: 'pointer' }} onClick={clickHandler}>
                        <td style={labelStyle}>最快</td>
                        {Array.from({ length: maxSegCount }, (_, i) => {
                          const fv = fastestAligned[i];
                          const isHorseFastest = fv != null && segs[i] != null && parseFloat(segs[i]) === fv;
                          return (
                            <td key={i} style={{
                              padding: '1px 6px', textAlign: 'center', fontSize: '0.92em',
                              color: isHorseFastest ? '#005500' : '#1a5fb4',
                              fontWeight: isHorseFastest ? 700 : 'normal',
                              ...cellBorder(i),
                            }}>
                              {fv != null ? fv.toFixed(2) : '-'}
                              {isHorseFastest && <span style={{ fontSize: '0.75em', marginLeft: 2 }}>★</span>}
                            </td>
                          );
                        })}
                      </tr>
                      {/* Sub-row 5: 與最快時間差值 */}
                      <tr style={{ cursor: 'pointer' }} onClick={clickHandler}>
                        <td style={labelStyle}>與最快差</td>
                        {Array.from({ length: maxSegCount }, (_, i) => {
                          const d = fastestDeltas[i];
                          const isHorseFastest = d !== null && parseFloat(d) === 0;
                          return (
                            <td key={i} style={{
                              padding: '1px 6px', textAlign: 'center', fontSize: '0.92em',
                              fontWeight: d && Math.abs(parseFloat(d)) >= 0.5 ? 700 : 'normal',
                              color: d === null ? '#bbb' : isHorseFastest ? '#005500' : parseFloat(d) < 0 ? '#007700' : '#cc0000',
                              ...cellBorder(i),
                            }}>
                              {d === null ? '-' : isHorseFastest ? '★' : (parseFloat(d) > 0 ? '+' : '') + d}
                            </td>
                          );
                        })}
                      </tr>
                      {/* Sub-row 6: 走位 */}
                      <tr style={{ cursor: 'pointer', background: '#fafafa' }} onClick={clickHandler}>
                        <td style={labelStyle}>走位</td>
                        {Array.from({ length: maxSegCount }, (_, i) => {
                          const tok = rpTokens[i];
                          return (
                            <td key={i} style={{ padding: '1px 6px', textAlign: 'center', whiteSpace: 'nowrap', fontWeight: 600, ...cellBorder(i) }}>
                              {tok ? tok.pos : '-'}
                            </td>
                          );
                        })}
                      </tr>
                      {/* Sub-row 7: 與頭馬距離 */}
                      <tr style={{ cursor: 'pointer', background: '#fafafa' }} onClick={clickHandler}>
                        <td style={labelStyle}>距離</td>
                        {Array.from({ length: maxSegCount }, (_, i) => {
                          const tok = rpTokens[i];
                          return (
                            <td key={i} style={{ padding: '1px 6px', textAlign: 'center', whiteSpace: 'nowrap', color: '#666', fontWeight: 600, fontSize: '0.9em', ...cellBorder(i) }}>
                              {tok && tok.dist ? tok.dist : '-'}
                            </td>
                          );
                        })}
                      </tr>
                      {sepRow}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
            <div style={{ fontSize: '0.75em', color: '#666', marginTop: 3 }}>
              差值: 負數(綠色)=快，正數(紅色)=慢 · ★=該場最快 · 點擊任意行可查看當日所有賽事分段時間對比
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────────
export default function SectionalTimesPanel({ raceNo, raceDate, horses, racecourse, raceClass, distance, trackType }) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [raceNo]);

  if (!raceDate) return null;

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h4 style={{ margin: 0 }}>分段時間分析</h4>
        <button className="btn btn-secondary" onClick={() => setExpanded(e => !e)} style={{ fontSize: '0.85em' }}>
          {expanded ? '收起' : '展開'}
        </button>
      </div>

      {expanded && (
        <div style={{ marginTop: 14 }}>
          {/* Reference standard sectional times for this race's conditions */}
          <RefSectionalSection
            racecourse={racecourse}
            raceClass={raceClass}
            distance={distance}
            trackType={trackType}
          />

          {/* Today's race actual sectional times */}
          <TodaySectionalSection raceDate={raceDate} raceNo={raceNo} />

          {/* Per-horse history */}
          {horses && horses.length > 0 && (
            <div>
              <h5 style={{ marginBottom: 10, color: '#032169', borderTop: '1px solid #ddd', paddingTop: 12 }}>
                馬匹往績分段時間（對上5場）
              </h5>
              {horses.filter(h => h.horse_id).map(horse => (
                <HorseHistoryRow key={horse.horse_no || horse.horse_id} horse={horse} />
              ))}
              {horses.every(h => !h.horse_id) && (
                <div className="empty-state">暫無馬匹資料</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
