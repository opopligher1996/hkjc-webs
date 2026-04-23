import React, { useState, useEffect } from 'react';
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
      await api.post('/sectional/scrape-horse', { horsename: horse.horse_name, limit: 5 });
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

      {data && expanded && data.length > 0 && (
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
                <th style={{ padding: '2px 6px' }}>沿途走位</th>
                <th style={{ padding: '2px 6px' }}>第1段</th>
                <th style={{ padding: '2px 6px', color: '#666' }}>差</th>
                <th style={{ padding: '2px 6px' }}>第2段</th>
                <th style={{ padding: '2px 6px', color: '#666' }}>差</th>
                <th style={{ padding: '2px 6px' }}>第3段</th>
                <th style={{ padding: '2px 6px', color: '#666' }}>差</th>
                <th style={{ padding: '2px 6px' }}>第4段</th>
                <th style={{ padding: '2px 6px', color: '#666' }}>差</th>
              </tr>
            </thead>
            <tbody>
              {data.map((race, idx) => {
                const segs = [race.seg1, race.seg2, race.seg3, race.seg4];
                const stdSplits = [
                  race.split_start_2000, race.split_2000_1600,
                  race.split_1600_1200, race.split_1200_800,
                  race.split_800_400, race.split_400_finish
                ].filter(v => v);
                // Attempt delta vs standard (stdSplits alignment to segs depends on distance)
                // For simplicity, align last N std splits to segs
                const alignedStd = stdSplits.slice(-segs.filter(Boolean).length);
                const deltas = segs.map((seg, i) => {
                  if (!seg || !alignedStd[i]) return null;
                  const diff = parseFloat(seg) - parseFloat(alignedStd[i]);
                  return isNaN(diff) ? null : diff.toFixed(2);
                });
                const dateStr = race.race_date
                  ? new Date(race.race_date).toLocaleDateString('zh-HK', { month: '2-digit', day: '2-digit', year: '2-digit' })
                  : '-';
                return (
                  <tr key={idx} style={{ borderTop: '1px solid #eee' }}>
                    <td style={{ padding: '2px 6px', whiteSpace: 'nowrap' }}>{dateStr}</td>
                    <td style={{ padding: '2px 6px' }}>{race.racecourse || '-'}</td>
                    <td style={{ padding: '2px 6px' }}>{race.going || '-'}</td>
                    <td style={{ padding: '2px 6px' }}>{race.distance ? race.distance + 'm' : '-'}</td>
                    <td style={{ padding: '2px 6px', fontWeight: 700 }}>{race.finish_position || '-'}</td>
                    <td style={{ padding: '2px 6px' }}>{race.finish_time || '-'}</td>
                    <td style={{ padding: '2px 6px', whiteSpace: 'nowrap', color: '#555', fontStyle: 'italic' }}>{race.running_positions || '-'}</td>
                    {segs.map((seg, i) => (
                      <React.Fragment key={i}>
                        <td style={{ padding: '2px 6px', whiteSpace: 'nowrap' }}>{seg || '-'}</td>
                        <td style={{ padding: '2px 4px', whiteSpace: 'nowrap', fontSize: '0.9em',
                          color: deltas[i] === null ? '#aaa'
                               : parseFloat(deltas[i]) < 0 ? '#007700'
                               : parseFloat(deltas[i]) > 0 ? '#cc0000' : '#555',
                          fontWeight: deltas[i] && Math.abs(parseFloat(deltas[i])) >= 0.5 ? 700 : 'normal'
                        }}>
                          {deltas[i] === null ? '-' : (parseFloat(deltas[i]) > 0 ? '+' : '') + deltas[i]}
                        </td>
                      </React.Fragment>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data[0]?.standard_time && (
            <div style={{ fontSize: '0.75em', color: '#888', marginTop: 3 }}>
              參考標準時間: {data[0].standard_time}
            </div>
          )}
        </div>
      )}
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
