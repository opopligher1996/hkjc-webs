import React, { useState, useEffect } from 'react';
import api from '../api';
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

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

// ── helpers ──────────────────────────────────────────────────────────────────

// Parse an HKJC-format gear string (racecard.gear).
// Tokens ending with '-' = explicitly removed; tokens with '1'/'2' suffix = first/second time.
// Returns worn (plain codes, no suffixes) and removed (plain codes).
// e.g. "B-/E1/TT" → { worn: ['E','TT'], removed: ['B'] }
function parseGearFull(g) {
  if (!g) return { worn: [], removed: [] };
  const worn = [], removed = [];
  for (const token of g.split(/[/,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean)) {
    if (token.endsWith('-')) {
      removed.push(token.slice(0, -1)); // strip trailing '-'
    } else {
      worn.push(token.replace(/[12]$/, '')); // strip first/second-time suffix
    }
  }
  return { worn: worn.filter(Boolean).sort(), removed: removed.filter(Boolean).sort() };
}

// Parse a plain gear string (race_records.gear) — may contain HKJC change notation stored from
// previous racecard. Normalise by stripping suffixes and excluding removed gear.
// e.g. "E/B1/TT-" → ['B','E']  (TT- excluded as removed, B1 → B)
function parseGear(g) {
  if (!g) return [];
  return g.split(/[/,\s]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .filter(t => !t.endsWith('-'))        // exclude explicitly removed gear
    .map(t => t.replace(/[12]$/, ''))     // strip first/second-time suffix
    .filter(Boolean)
    .sort();
}

function gearDelta(currentGear, prevGear) {
  // currentGear is HKJC-notation (racecard); prevGear is plain (race_records)
  const { worn: currWorn, removed: explicitRemoved } = parseGearFull(currentGear);
  const prevWorn = parseGear(prevGear);
  const added   = currWorn.filter(x => !prevWorn.includes(x));
  const removed = Array.from(new Set([
    ...explicitRemoved,
    ...prevWorn.filter(x => !currWorn.includes(x)),
  ]));
  return { added, removed };
}

function Tag({ color, children, style }) {
  return (
    <span style={{
      background: color, color: '#fff', borderRadius: 3,
      padding: '1px 6px', fontSize: '0.72rem', fontWeight: 600,
      ...style,
    }}>
      {children}
    </span>
  );
}

function GearChangeBadge({ current, prev }) {
  const { added, removed } = gearDelta(current, prev);
  if (!added.length && !removed.length) return null;
  if (!prev && current) return <Tag color="#28a745">新增</Tag>;
  if (prev && !current) return <Tag color="#dc3545">移除</Tag>;
  return <Tag color="#fd7e14">變動</Tag>;
}

function gearDisplay(gear) {
  if (!gear) return <span style={{ color: '#bbb' }}>—</span>;
  return gear;
}

function deltaLabel(currentGear, prevGear) {
  const { added, removed } = gearDelta(currentGear, prevGear);
  return (
    <span style={{ fontSize: '0.8rem', marginLeft: 4 }}>
      {removed.map(x => <span key={`r${x}`} style={{ color: '#dc3545', marginRight: 2 }}>-{x}</span>)}
      {added.map(x =>   <span key={`a${x}`} style={{ color: '#28a745', marginRight: 2 }}>+{x}</span>)}
    </span>
  );
}

// ── Per-code stat block ───────────────────────────────────────────────────────
function CodeStatBlock({ stat }) {
  const [showAll, setShowAll] = useState(false);
  const isAdded   = stat.type === 'added';
  const color     = isAdded ? '#28a745' : '#dc3545';
  const records   = showAll ? stat.records : stat.records.slice(0, 5);

  return (
    <div style={{ marginBottom: 12, border: `1px solid ${color}30`, borderRadius: 4, overflow: 'hidden' }}>
      {/* Header row */}
      <div style={{ background: `${color}12`, padding: '5px 12px', display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, color, fontSize: '0.9rem' }}>{stat.label}</span>
        <span style={{ fontSize: '0.8rem', color: '#444' }}>
          近三季共 <strong>{stat.total}</strong> 次
        </span>
        {stat.total > 0 ? (
          <>
            <span style={{ fontSize: '0.8rem' }}>
              勝 <strong style={{ color: '#28a745' }}>{stat.wins}</strong>
              <span style={{ color: '#888' }}> ({stat.win_rate})</span>
            </span>
            <span style={{ fontSize: '0.8rem' }}>
              位 <strong style={{ color: '#007bff' }}>{stat.places}</strong>
              <span style={{ color: '#888' }}> ({stat.place_rate})</span>
            </span>
          </>
        ) : (
          <span style={{ fontSize: '0.8rem', color: '#999' }}>無記錄</span>
        )}
      </div>

      {/* Detail table */}
      {stat.total > 0 && (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
            <thead>
              <tr style={{ background: '#f5f5f5' }}>
                {['日期','馬場','場次','組別','馬名','配備前','配備後','名次'].map(h => (
                  <th key={h} style={{ padding: '3px 8px', textAlign: 'left', color: '#555', fontWeight: 600, borderBottom: '1px solid #ddd' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map((r, i) => (
                <tr key={i} style={{
                  background: r.finish_position === 1 ? '#f0fff4' : r.finish_position <= 3 ? '#fff8e1' : '#fff',
                  borderBottom: '1px solid #f0f0f0',
                }}>
                  <td style={dTd}>{r.race_date}</td>
                  <td style={dTd}>{r.racecourse}</td>
                  <td style={dTd}>第{r.race_no}場</td>
                  <td style={dTd}>{r.race_class || '—'}</td>
                  <td style={{ ...dTd, fontWeight: 500 }}>{r.horse_name}</td>
                  <td style={{ ...dTd, color: '#888' }}>{r.prev_gear || '—'}</td>
                  <td style={{ ...dTd, color: '#888' }}>{r.curr_gear || '—'}</td>
                  <td style={{ ...dTd, fontWeight: 700, color: r.finish_position === 1 ? '#28a745' : r.finish_position <= 3 ? '#e67e22' : '#333' }}>
                    {r.finish_position ?? '—'}{r.total_runners ? `/${r.total_runners}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {stat.records.length > 5 && (
            <div style={{ padding: '4px 12px' }}>
              <button
                onClick={() => setShowAll(v => !v)}
                style={{ fontSize: '0.78rem', color: '#032169', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
              >
                {showAll ? '收起' : `顯示全部 ${stat.records.length} 筆`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const dTd = { padding: '3px 8px' };

// ── Trainer stats sub-row ────────────────────────────────────────────────────
function TrainerStatsRow({ horse, colSpan }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.get('/ai/gear-change-trainer-stats', {
      params: {
        trainer_name: horse.trainer_name,
        current_gear: horse.current_gear,
        prev_gear:    horse.prev_gear,
      },
    })
      .then(r => { if (!cancelled) { setData(r.data); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [horse.trainer_name, horse.current_gear, horse.prev_gear]);

  const cell = {
    padding: '12px 16px',
    background: '#f7f9ff',
    borderBottom: '2px solid #dee4f5',
  };

  if (loading) {
    return <tr><td colSpan={colSpan} style={cell}><span style={{ color: '#999', fontSize: '0.8rem' }}>載入馬房統計...</span></td></tr>;
  }

  return (
    <tr>
      <td colSpan={colSpan} style={cell}>
        <div style={{ marginBottom: 8, fontWeight: 700, color: '#032169', fontSize: '0.85rem' }}>
          馬房：{horse.trainer_name}
          {data?.cutoff && <span style={{ fontWeight: 400, color: '#888', fontSize: '0.78rem', marginLeft: 8 }}>（統計自 {data.cutoff}）</span>}
        </div>
        {!data || !data.stats?.length ? (
          <span style={{ color: '#999', fontSize: '0.8rem' }}>近三季無配備變動記錄</span>
        ) : (
          data.stats.map(stat => <CodeStatBlock key={stat.label} stat={stat} />)
        )}
      </td>
    </tr>
  );
}

// ── Main gear changes panel ──────────────────────────────────────────────────
function GearChangesPanel() {
  const [date, setDate]                       = useState('');
  const [data, setData]                       = useState(null);
  const [loading, setLoading]                 = useState(false);
  const [error, setError]                     = useState(null);
  const [, setShowChangedOnly] = useState(true);
  const [expandedHorses, setExpandedHorses]   = useState(new Set());

  useEffect(() => { fetchData(); }, []);

  async function fetchData(d) {
    setLoading(true);
    setError(null);
    setExpandedHorses(new Set());
    try {
      const res = await api.get('/ai/gear-changes', { params: d ? { date: d } : {} });
      setData(res.data);
      setDate(res.data.date);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }

  function toggleHorse(key) {
    setExpandedHorses(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  const horses       = data?.horses || [];
  // 只顯示有配備變動嘅馬匹（冇變動唔顯示）
  const filtered     = horses.filter(h => h.changed);
  const changedCount = filtered.length;

  const byRace = filtered.reduce((acc, h) => {
    if (!acc[h.race_no]) acc[h.race_no] = [];
    acc[h.race_no].push(h);
    return acc;
  }, {});

  const COL = 7;

  return (
    <div style={{ marginBottom: 32 }}>
      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, color: '#032169', fontSize: '1rem' }}>配備變動</h3>
        <input
          type="date" value={date}
          onChange={e => { setDate(e.target.value); if (e.target.value) fetchData(e.target.value); }}
          style={{ padding: '4px 8px', border: '1px solid #ccc', borderRadius: 4, fontSize: '0.9rem' }}
        />
        {data && (
          <span style={{ fontSize: '0.8rem', color: '#666' }}>
            共 <strong>{changedCount}</strong> 匹有配備變動 / {horses.length} 匹
          </span>
        )}
      </div>

      {loading && <div style={{ color: '#666', padding: '20px 0' }}>載入中...</div>}
      {error   && <div style={{ color: '#dc3545', padding: '8px 12px', background: '#fff5f5', borderRadius: 4 }}>{error}</div>}
      {!loading && !error && data && filtered.length === 0 && (
        <div style={{ color: '#999', padding: '20px 0', textAlign: 'center' }}>
          此日期沒有配備變動
        </div>
      )}

      {!loading && !error && Object.entries(byRace).map(([raceNo, raceHorses]) => (
        <div key={raceNo} style={{ marginBottom: 20 }}>
          <div style={{ background: '#032169', color: '#fff', padding: '4px 12px', fontSize: '0.85rem', fontWeight: 600, borderRadius: '4px 4px 0 0' }}>
            第 {raceNo} 場
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ background: '#f0f4ff' }}>
                {['馬號','馬名','練馬師','今次配備','上次配備','上場日期','變動'].map(h => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {raceHorses.map(horse => {
                const key      = `${horse.race_no}-${horse.horse_no}`;
                const expanded = expandedHorses.has(key);
                return (
                  <React.Fragment key={key}>
                    <tr
                      style={{ background: horse.changed ? '#fffbe6' : '#fff', borderBottom: '1px solid #eee', cursor: horse.changed ? 'pointer' : 'default' }}
                      onClick={() => horse.changed && toggleHorse(key)}
                      title={horse.changed ? '點擊查看馬房統計' : ''}
                    >
                      <td style={tdStyle}>{horse.horse_no}</td>
                      <td style={{ ...tdStyle, fontWeight: horse.changed ? 600 : 400 }}>{horse.horse_name}</td>
                      <td style={{ ...tdStyle, color: '#555', fontSize: '0.8rem' }}>{horse.trainer_name || '—'}</td>
                      <td style={tdStyle}>{gearDisplay(horse.current_gear)}</td>
                      <td style={tdStyle}>{gearDisplay(horse.prev_gear)}</td>
                      <td style={{ ...tdStyle, color: '#666', fontSize: '0.8rem' }}>
                        {horse.prev_race_date ? `${horse.prev_race_date} ${horse.prev_racecourse || ''}` : '—'}
                      </td>
                      <td style={tdStyle}>
                        {horse.changed ? (
                          <span>
                            <GearChangeBadge current={horse.current_gear} prev={horse.prev_gear} />
                            {deltaLabel(horse.current_gear, horse.prev_gear)}
                            <span style={{ marginLeft: 6, color: '#032169', fontSize: '0.75rem' }}>
                              {expanded ? ' ▲' : ' ▼ 馬房統計'}
                            </span>
                          </span>
                        ) : (
                          <span style={{ color: '#bbb', fontSize: '0.8rem' }}>不變</span>
                        )}
                      </td>
                    </tr>
                    {horse.changed && expanded && (
                      <TrainerStatsRow horse={horse} colSpan={COL} />
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

// ── Jockey Changes Panel ──────────────────────────────────────────────────────
function StatsBadge({ stats, label, color }) {
  if (!stats || stats.total === 0) return <span style={{ color: '#bbb', fontSize: '0.78rem' }}>—場</span>;
  return (
    <span style={{ fontSize: '0.78rem' }}>
      <span style={{ color, fontWeight: 700 }}>{stats.win_rate}</span>
      <span style={{ color: '#888', marginLeft: 4 }}>({stats.wins}/{stats.total})</span>
    </span>
  );
}

function JockeyHandoffStats({ fromId, toId }) {
  const { data, loading, error } = useStatsFetch(
    '/ai/stats-jockey-handoff', { from_id: fromId, to_id: toId }, [fromId, toId]
  );
  if (loading) return <td colSpan={9} style={{ padding: '10px 14px', color: '#999', fontSize: '0.83rem' }}>載入中...</td>;
  if (error)   return <td colSpan={9} style={{ padding: '10px 14px', color: '#dc3545', fontSize: '0.83rem' }}>{error}</td>;
  if (!data)   return null;
  return (
    <td colSpan={9} style={{ padding: '10px 14px 14px', background: '#f7f9ff' }}>
      {/* Summary */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontWeight: 700, fontSize: '0.78rem', color: '#032169', marginBottom: 6 }}>
          騎師接手統計：{data.from_name} → {data.to_name}
        </div>
        {data.total === 0 ? (
          <div style={{ fontSize: '0.78rem', color: '#999' }}>DB 中暫無此接手記錄</div>
        ) : (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: '0.78rem' }}>
            <span>接手場次：<strong>{data.total}</strong></span>
            <span>涉及馬匹：<strong>{data.horse_count}</strong> 匹</span>
            <span style={{ color: '#28a745' }}>勝率：<strong>{data.win_rate}</strong>（{data.wins}勝）</span>
            <span style={{ color: '#007bff' }}>位率：<strong>{data.place_rate}</strong>（{data.places}位）</span>
          </div>
        )}
      </div>
      {/* Recent records */}
      {data.recent && data.recent.length > 0 && (
        <div>
          <div style={{ fontWeight: 700, fontSize: '0.78rem', color: '#032169', marginBottom: 4 }}>近期接手記錄</div>
          <table style={{ borderCollapse: 'collapse', fontSize: '0.78rem', minWidth: 480 }}>
            <thead>
              <tr style={{ background: '#e8eef8' }}>
                {['日期','場次','馬名','馬場','練馬師','賠率','名次'].map(h => (
                  <th key={h} style={{ padding: '3px 8px', textAlign: (h==='馬名'||h==='練馬師')?'left':'center', fontWeight: 600, color: '#032169', borderBottom: '1px solid #c0cce8', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.recent.map((r, i) => {
                const isWin   = r.finish_position === 1;
                const isPlace = r.finish_position <= 3;
                return (
                  <tr key={i} style={{ background: i%2===0?'#fff':'#f0f4ff' }}>
                    <td style={{ padding: '3px 8px', textAlign: 'center' }}>{r.race_date}</td>
                    <td style={{ padding: '3px 8px', textAlign: 'center' }}>R{r.race_no}</td>
                    <td style={{ padding: '3px 8px' }}>{r.horse_name}</td>
                    <td style={{ padding: '3px 8px', textAlign: 'center' }}>{r.racecourse}</td>
                    <td style={{ padding: '3px 8px', color: '#555' }}>{r.trainer_name || '—'}</td>
                    <td style={{ padding: '3px 8px', textAlign: 'center', color: '#888' }}>
                      {r.win_odds != null ? r.win_odds : '—'}
                    </td>
                    <td style={{ padding: '3px 8px', textAlign: 'center', fontWeight: isWin?700:400, color: isWin?'#28a745':isPlace?'#007bff':'#333' }}>
                      {r.finish_position ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </td>
  );
}

function JockeyChangesPanel() {
  const [date, setDate]             = useState('');
  const [data, setData]             = useState(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState(null);
  const [changedOnly, setChangedOnly] = useState(true);
  const [expanded, setExpanded]     = useState(new Set());

  useEffect(() => { fetchData(); }, []);

  async function fetchData(d) {
    setLoading(true); setError(null); setExpanded(new Set());
    try {
      const res = await api.get('/ai/jockey-changes', { params: d ? { date: d } : {} });
      setData(res.data);
      setDate(res.data.date);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }

  function toggle(key) {
    setExpanded(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }

  const horses       = data?.horses || [];
  const filtered     = changedOnly ? horses.filter(h => h.changed) : horses;
  const changedCount = horses.filter(h => h.changed).length;
  const byRace       = filtered.reduce((acc, h) => { if (!acc[h.race_no]) acc[h.race_no] = []; acc[h.race_no].push(h); return acc; }, {});

  const COLS = 9;

  return (
    <div style={{ marginBottom: 32 }}>
      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, color: '#032169', fontSize: '1rem' }}>換騎師</h3>
        <input type="date" value={date}
          onChange={e => { setDate(e.target.value); if (e.target.value) fetchData(e.target.value); }}
          style={{ padding: '4px 8px', border: '1px solid #ccc', borderRadius: 4, fontSize: '0.9rem' }}
        />
        <label style={{ fontSize: '0.85rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={changedOnly} onChange={e => setChangedOnly(e.target.checked)} />
          只顯示有換騎師
        </label>
        {data && (
          <span style={{ fontSize: '0.8rem', color: '#666' }}>
            共 <strong style={{ color: '#dc3545' }}>{changedCount}</strong> 匹換騎師 / {horses.length} 匹
          </span>
        )}
      </div>

      {loading && <div style={{ color: '#666', padding: '20px 0' }}>載入中...</div>}
      {error   && <div style={{ color: '#dc3545', padding: '8px 12px', background: '#fff5f5', borderRadius: 4 }}>{error}</div>}
      {!loading && !error && data && filtered.length === 0 && (
        <div style={{ color: '#999', padding: '20px 0', textAlign: 'center' }}>
          {changedOnly ? '此日期沒有換騎師' : '此日期暫無排位表數據'}
        </div>
      )}

      {!loading && !error && Object.entries(byRace).map(([raceNo, raceHorses]) => (
        <div key={raceNo} style={{ marginBottom: 20 }}>
          <div style={{ background: '#032169', color: '#fff', padding: '4px 12px', fontSize: '0.85rem', fontWeight: 600, borderRadius: '4px 4px 0 0' }}>
            第 {raceNo} 場
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ background: '#f0f4ff' }}>
                {['馬號','馬名','練馬師','上場騎師','今場騎師','上場記錄','今場勝率','舊騎師勝率','整體勝率'].map(h => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {raceHorses.map(horse => {
                const key = `${horse.race_no}-${horse.horse_no}`;
                const isExp = expanded.has(key);
                return (
                  <React.Fragment key={key}>
                    <tr
                      style={{ background: horse.changed ? '#fff8e1' : '#fff', borderBottom: '1px solid #eee', cursor: horse.changed ? 'pointer' : 'default' }}
                      onClick={() => horse.changed && toggle(key)}
                      title={horse.changed ? '點擊查看按騎師統計' : ''}
                    >
                      <td style={tdStyle}>{horse.horse_no}</td>
                      <td style={{ ...tdStyle, fontWeight: horse.changed ? 700 : 400 }}>{horse.horse_name}</td>
                      <td style={{ ...tdStyle, color: '#555', fontSize: '0.8rem' }}>{horse.trainer_name || '—'}</td>
                      <td style={{ ...tdStyle, color: horse.changed ? '#dc3545' : '#555' }}>
                        {horse.prev_jockey_name || <span style={{ color: '#bbb' }}>首戰</span>}
                      </td>
                      <td style={{ ...tdStyle, color: horse.changed ? '#28a745' : '#555', fontWeight: horse.changed ? 700 : 400 }}>
                        {horse.new_jockey_name}
                        {horse.changed && <span style={{ marginLeft: 6, color: '#032169', fontSize: '0.75rem' }}>{isExp ? '▲' : '▼'}</span>}
                      </td>
                      <td style={{ ...tdStyle, color: '#888', fontSize: '0.78rem' }}>
                        {horse.prev_race_date ? `${horse.prev_race_date}${horse.prev_racecourse ? ' ' + horse.prev_racecourse : ''}` : '—'}
                      </td>
                      <td style={tdStyle}><StatsBadge stats={horse.stats_new}  color="#28a745" /></td>
                      <td style={tdStyle}><StatsBadge stats={horse.stats_prev} color="#555" /></td>
                      <td style={tdStyle}><StatsBadge stats={horse.stats_overall} color="#032169" /></td>
                    </tr>
                    {horse.changed && isExp && (
                      <tr style={{ background: '#f7f9ff', borderBottom: '2px solid #c0cce8' }}>
                        <JockeyHandoffStats fromId={horse.prev_jockey_id} toId={horse.new_jockey_id} />
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

// ── QuickBackPanel ─────────────────────────────────────────────────────────────
const PRESETS = [
  { label: '7天內', min: 5, max: 7 },
  { label: '7-10天', min: 7, max: 10 },
  { label: '10-14天', min: 10, max: 14 },
];
const COURSE_MAP_QB = { ST: '沙田', HV: '跑馬地', CGA: '從化' };

function QuickBackPanel() {
  const [gapMin, setGapMin]   = useState(7);
  const [gapMax, setGapMax]   = useState(10);
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [sortKey, setSortKey]   = useState('quick_backs');
  const [sortAsc, setSortAsc]   = useState(false);

  useEffect(() => { loadData(7, 10); }, []);

  async function loadData(mn, mx) {
    setLoading(true); setError(null); setExpanded(new Set());
    try {
      const res = await api.get('/ai/stats-quick-back', { params: { gap_min: mn, gap_max: mx } });
      setData(res.data);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }

  function applyPreset(p) {
    setGapMin(p.min); setGapMax(p.max); loadData(p.min, p.max);
  }

  function toggleSort(key) {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(false); }
  }

  function toggleRow(name) {
    setExpanded(prev => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });
  }

  const trainers = (data?.trainers || []).slice().sort((a, b) => {
    const v = (x) => typeof x[sortKey] === 'string' ? parseFloat(x[sortKey]) || 0 : (x[sortKey] ?? 0);
    return sortAsc ? v(a) - v(b) : v(b) - v(a);
  });

  const SortTh = ({ label, col, right }) => {
    const active = sortKey === col;
    return (
      <th onClick={() => toggleSort(col)} style={{
        padding: '5px 8px', textAlign: right ? 'right' : 'center', fontWeight: 600,
        color: active ? '#032169' : '#444', borderBottom: '2px solid #c0cce8',
        whiteSpace: 'nowrap', cursor: 'pointer', background: active ? '#dce6f7' : '#e8eef8',
        fontSize: '0.78rem', userSelect: 'none',
      }}>
        {label}{active ? (sortAsc ? ' ▲' : ' ▼') : ''}
      </th>
    );
  };

  const winColor  = r => r === '0.0%' ? '#999' : '#28a745';
  const plcColor  = r => r === '0.0%' ? '#999' : '#007bff';

  return (
    <div style={{ marginBottom: 32 }}>
      {/* Header + presets */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, color: '#032169', fontSize: '1rem' }}>馬房密出表現</h3>
        <div style={{ display: 'flex', gap: 6 }}>
          {PRESETS.map(p => (
            <button key={p.label}
              onClick={() => applyPreset(p)}
              style={{
                padding: '3px 10px', fontSize: '0.8rem', borderRadius: 4, cursor: 'pointer',
                border: '1px solid #c0cce8',
                background: gapMin === p.min && gapMax === p.max ? '#032169' : '#f0f4ff',
                color:      gapMin === p.min && gapMax === p.max ? '#fff'    : '#032169',
                fontWeight: gapMin === p.min && gapMax === p.max ? 700       : 400,
              }}>
              {p.label}
            </button>
          ))}
        </div>
        {/* Custom range */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.82rem', color: '#555' }}>
          自定：
          <input type="number" min={1} max={30} value={gapMin}
            onChange={e => setGapMin(+e.target.value)}
            style={{ width: 42, padding: '2px 4px', border: '1px solid #ccc', borderRadius: 3, fontSize: '0.82rem' }} />
          –
          <input type="number" min={1} max={30} value={gapMax}
            onChange={e => setGapMax(+e.target.value)}
            style={{ width: 42, padding: '2px 4px', border: '1px solid #ccc', borderRadius: 3, fontSize: '0.82rem' }} />
          天
          <button onClick={() => loadData(gapMin, gapMax)}
            style={{ padding: '2px 8px', fontSize: '0.8rem', border: '1px solid #c0cce8',
              borderRadius: 3, background: '#f0f4ff', cursor: 'pointer', color: '#032169' }}>
            查詢
          </button>
        </div>
        {data && (
          <span style={{ fontSize: '0.8rem', color: '#666' }}>
            共 <strong style={{ color: '#032169' }}>{data.total_quick_backs}</strong> 次密出
            ／<strong>{trainers.length}</strong> 個馬房
          </span>
        )}
      </div>

      {loading && <div style={{ color: '#666', padding: '16px 0' }}>載入中...</div>}
      {error   && <div style={{ color: '#dc3545', padding: '8px 12px', background: '#fff5f5', borderRadius: 4 }}>{error}</div>}

      {!loading && !error && data && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.83rem' }}>
            <thead>
              <tr>
                <th style={{ padding: '5px 8px', fontWeight: 600, color: '#444',
                  borderBottom: '2px solid #c0cce8', background: '#e8eef8',
                  fontSize: '0.78rem', whiteSpace: 'nowrap' }}>
                  練馬師
                </th>
                <SortTh label="密出次數" col="quick_backs" />
                <SortTh label="勝出"     col="wins" />
                <SortTh label="位置"     col="places" />
                <SortTh label="勝率"     col="win_rate" />
                <SortTh label="位率"     col="place_rate" />
                <SortTh label="平均間隔" col="avg_days" />
              </tr>
            </thead>
            <tbody>
              {trainers.map((t, i) => {
                const isExp = expanded.has(t.trainer_name);
                const bg    = i % 2 === 0 ? '#fff' : '#f7f9ff';
                return (
                  <React.Fragment key={t.trainer_name}>
                    <tr style={{ background: isExp ? '#edf2ff' : bg, cursor: 'pointer' }}
                        onClick={() => toggleRow(t.trainer_name)}>
                      <td style={{ padding: '5px 10px', fontWeight: 600, color: '#032169',
                        whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: '0.7rem', color: '#888' }}>{isExp ? '▼' : '▶'}</span>
                        {t.trainer_name}
                      </td>
                      <td style={{ padding: '5px 8px', textAlign: 'center', fontWeight: 700 }}>{t.quick_backs}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'center' }}>{t.wins}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'center' }}>{t.places}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'center', fontWeight: 600,
                        color: winColor(t.win_rate) }}>{t.win_rate}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'center', fontWeight: 600,
                        color: plcColor(t.place_rate) }}>{t.place_rate}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'center', color: '#555' }}>
                        {t.avg_days} 天
                      </td>
                    </tr>
                    {isExp && (
                      <tr key={t.trainer_name + '_detail'}>
                        <td colSpan={7} style={{ padding: '8px 16px 14px', background: '#f4f7ff' }}>
                          <table style={{ borderCollapse: 'collapse', fontSize: '0.76rem', width: '100%' }}>
                            <thead>
                              <tr>
                                {['日期','馬場','馬名','班次','途程','檔位','騎師','間隔','上場名次','今場名次','賠率'].map(h => (
                                  <th key={h} style={{
                                    padding: '4px 8px',
                                    textAlign: h === '馬名' ? 'left' : 'center',
                                    fontWeight: 600, color: '#032169',
                                    background: '#dce6f7',
                                    borderBottom: '2px solid #a0b4d8',
                                    whiteSpace: 'nowrap', fontSize: '0.76rem',
                                  }}>
                                    {h}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {t.records.map((r, ri) => {
                                const isWin   = r.finish_position === 1;
                                const isPlace = r.finish_position <= 3;
                                const posColor = isWin ? '#28a745' : isPlace ? '#007bff' : '#555';
                                return (
                                  <tr key={ri} style={{ background: ri % 2 === 0 ? '#fff' : '#f0f5ff' }}>
                                    <td style={{ padding: '3px 7px', textAlign: 'center' }}>{r.race_date}</td>
                                    <td style={{ padding: '3px 7px', textAlign: 'center' }}>{COURSE_MAP_QB[r.racecourse] || r.racecourse}</td>
                                    <td style={{ padding: '3px 7px' }}>{r.horse_name}</td>
                                    <td style={{ padding: '3px 7px', textAlign: 'center' }}>{r.race_class}</td>
                                    <td style={{ padding: '3px 7px', textAlign: 'center' }}>{r.distance ? `${r.distance}M` : '—'}</td>
                                    <td style={{ padding: '3px 7px', textAlign: 'center' }}>{r.draw ?? '—'}</td>
                                    <td style={{ padding: '3px 7px', textAlign: 'center' }}>{r.jockey_id || '—'}</td>
                                    <td style={{ padding: '3px 7px', textAlign: 'center', color: '#e67e00', fontWeight: 600 }}>{r.days_gap}天</td>
                                    <td style={{ padding: '3px 7px', textAlign: 'center', color: '#888' }}>{r.prev_finish ?? '—'}</td>
                                    <td style={{ padding: '3px 7px', textAlign: 'center', fontWeight: isWin ? 700 : 400, color: posColor }}>{r.finish_position ?? '—'}</td>
                                    <td style={{ padding: '3px 7px', textAlign: 'center', color: '#666' }}>{r.win_odds != null ? r.win_odds : '—'}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const thStyle = {
  padding: '6px 10px', textAlign: 'left', fontWeight: 600,
  color: '#032169', borderBottom: '2px solid #032169', whiteSpace: 'nowrap',
};
const tdStyle = { padding: '6px 10px', verticalAlign: 'middle' };

// ── Stats Search Panel ────────────────────────────────────────────────────────
const TYPE_LABEL  = { horse: '馬匹', trainer: '練馬師', jockey: '騎師' };
const TYPE_COLOR  = { horse: { bg: '#e8f5e9', fg: '#2e7d32' }, trainer: { bg: '#e3f2fd', fg: '#1565c0' }, jockey: { bg: '#fff3e0', fg: '#e65100' } };
const GEAR_LABEL  = { B: '眼罩(B)', XB: '超大眼罩(XB)', CP: '鼻箍(CP)', TT: '舌帶(TT)', E: '耳塞(E)', SR: '翻沙鐵(SR)', BO: '仿製眼罩(BO)', P: '遮耳器(P)', PC: '遮耳器(PC)', V: '眼罩(V)' };
const COURSE_LABEL = { ST: '沙田', HV: '跑馬地' };

function StatsTable({ title, columns, rows, highlight }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div style={{ marginBottom: 20 }}>
      {title && <div style={{ fontWeight: 700, color: '#032169', fontSize: '0.88rem', marginBottom: 6 }}>{title}</div>}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
          <thead>
            <tr style={{ background: '#f0f4ff' }}>
              {columns.map(c => (
                <th key={c.key} style={{ padding: '5px 10px', textAlign: c.align || 'left', fontWeight: 600, color: '#032169', borderBottom: '2px solid #032169', whiteSpace: 'nowrap' }}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const isWin   = highlight && row.finish_position === 1;
              const isPlace = highlight && row.finish_position <= 3 && row.finish_position !== 1;
              return (
                <tr key={i} style={{ background: isWin ? '#f0fff4' : isPlace ? '#fff8e1' : i % 2 === 0 ? '#fff' : '#f9f9f9', borderBottom: '1px solid #eee' }}>
                  {columns.map(c => (
                    <td key={c.key} style={{ padding: '5px 10px', verticalAlign: 'middle', textAlign: c.align || 'left', ...(c.bold ? { fontWeight: 600 } : {}) }}>
                      {row[c.key] === null || row[c.key] === undefined
                        ? <span style={{ color: '#bbb' }}>—</span>
                        : c.render ? c.render(row[c.key], row) : String(row[c.key])}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatsDetailPanel({ entity, filters = {}, filterDesc = '', onBack }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null); setLoading(true); setError(null); setShowAll(false);
    api.get('/ai/stats-detail', {
      params: {
        type:      entity.type,
        id:        entity.id,
        name:      entity.name_zh || entity.name_en,
        gear_code: filters.gear_code || undefined,
        venue:     filters.venue    || undefined,
        distance:  filters.distance || undefined,
      },
    })
      .then(r => { if (!cancelled) { setData(r.data); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(e.response?.data?.error || e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [entity, filters.gear_code, filters.venue, filters.distance]);

  const displayName = entity.name_zh || entity.name_en;
  const tc = TYPE_COLOR[entity.type] || { bg: '#f0f4ff', fg: '#032169' };

  const RECORD_COLS = [
    { key: 'race_date',       label: '日期' },
    { key: 'racecourse',      label: '場地' },
    { key: 'race_no',         label: '場次', render: v => `第${v}場` },
    { key: 'race_class',      label: '組別' },
    { key: 'distance',        label: '距離' },
    { key: 'going',           label: '跑道' },
    ...(entity.type !== 'horse' ? [{ key: 'horse_name', label: '馬名' }] : []),
    { key: 'gear',            label: '配備' },
    { key: 'finish_position', label: '名次', align: 'center', bold: true, render: (v, row) => v ? `${v}/${row.total_runners}` : '—' },
    { key: 'actual_weight',   label: '負磅', align: 'right' },
  ];

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <button onClick={onBack} style={{ fontSize: '0.82rem', color: '#032169', background: '#f0f4ff', border: '1px solid #c0cce8', borderRadius: 4, padding: '3px 10px', cursor: 'pointer' }}>
          ← 返回
        </button>
        <span style={{ fontWeight: 700, fontSize: '1rem', color: '#032169' }}>{displayName}</span>
        <span style={{ fontSize: '0.75rem', background: tc.bg, color: tc.fg, borderRadius: 10, padding: '1px 8px' }}>{TYPE_LABEL[entity.type]}</span>
        {filterDesc && <span style={{ fontSize: '0.78rem', color: '#666', background: '#fffbe6', border: '1px solid #ffe082', borderRadius: 4, padding: '2px 8px' }}>{filterDesc}</span>}
      </div>

      {loading && <div style={{ color: '#999', fontSize: '0.85rem' }}>載入統計中...</div>}
      {error   && <div style={{ color: '#dc3545', background: '#fff5f5', padding: '8px 12px', borderRadius: 4, fontSize: '0.85rem' }}>{error}</div>}
      {data && !data.overall && <div style={{ color: '#999', fontSize: '0.85rem' }}>符合條件的賽事記錄為零</div>}

      {data?.overall && (
        <>
          {/* Overall summary */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20, padding: '12px 16px', background: '#f7f9ff', borderRadius: 6, border: '1px solid #dde3f0' }}>
            {[
              { label: '出賽', value: data.overall.total },
              { label: '勝出', value: data.overall.wins,  color: '#28a745' },
              { label: '位',   value: data.overall.places, color: '#007bff' },
              { label: '勝率', value: data.overall.win_rate,   color: '#28a745' },
              { label: '位率', value: data.overall.place_rate, color: '#007bff' },
            ].map(s => (
              <div key={s.label} style={{ textAlign: 'center', minWidth: 60 }}>
                <div style={{ fontSize: '0.72rem', color: '#888' }}>{s.label}</div>
                <div style={{ fontWeight: 700, fontSize: '1.1rem', color: s.color || '#032169' }}>{s.value}</div>
              </div>
            ))}
          </div>

          {/* By gear — only show if no gear_code filter applied */}
          {!filters.gear_code && data.by_gear.length > 0 && (
            <StatsTable title="配備統計" rows={data.by_gear} columns={[
              { key: 'label',      label: '配備' },
              { key: 'total',      label: '出賽', align: 'right' },
              { key: 'wins',       label: '勝出', align: 'right' },
              { key: 'places',     label: '位',   align: 'right' },
              { key: 'win_rate',   label: '勝率', align: 'right' },
              { key: 'place_rate', label: '位率', align: 'right' },
            ]} />
          )}

          {/* By venue/distance — only show if not already fully filtered */}
          {!(filters.venue && filters.distance) && data.by_venue.length > 0 && (
            <StatsTable title="場地距離統計" rows={data.by_venue} columns={[
              { key: 'racecourse',  label: '場地' },
              { key: 'distance',    label: '距離' },
              { key: 'total',       label: '出賽', align: 'right' },
              { key: 'wins',        label: '勝出', align: 'right' },
              { key: 'places',      label: '位',   align: 'right' },
              { key: 'win_rate',    label: '勝率', align: 'right' },
              { key: 'place_rate',  label: '位率', align: 'right' },
            ]} />
          )}

          {/* Recent records */}
          {data.records.length > 0 && (
            <div>
              <div style={{ fontWeight: 700, color: '#032169', fontSize: '0.88rem', marginBottom: 6 }}>
                近期賽事記錄
                <span style={{ fontWeight: 400, color: '#888', fontSize: '0.78rem', marginLeft: 8 }}>（最近 {data.records.length} 場）</span>
              </div>
              <StatsTable columns={RECORD_COLS} rows={showAll ? data.records : data.records.slice(0, 10)} highlight />
              {data.records.length > 10 && (
                <button onClick={() => setShowAll(v => !v)} style={{ fontSize: '0.78rem', color: '#032169', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
                  {showAll ? '收起' : `顯示全部 ${data.records.length} 場`}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Shared panel helper ───────────────────────────────────────────────────────
function useStatsFetch(url, params, deps) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  useEffect(() => {
    let cancelled = false;
    setData(null); setLoading(true); setError(null);
    api.get(url, { params })
      .then(r => { if (!cancelled) { setData(r.data); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(e.response?.data?.error || e.message); setLoading(false); } });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, loading, error };
}

function PanelHeader({ title, subtitle, tag, onBack }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
      <button onClick={onBack} style={{ fontSize: '0.82rem', color: '#032169', background: '#f0f4ff', border: '1px solid #c0cce8', borderRadius: 4, padding: '3px 10px', cursor: 'pointer' }}>← 返回</button>
      <span style={{ fontWeight: 700, fontSize: '1rem', color: '#032169' }}>{title}</span>
      {tag && <span style={{ fontSize: '0.75rem', background: '#e3f2fd', color: '#1565c0', borderRadius: 10, padding: '1px 8px' }}>{tag}</span>}
      {subtitle && <span style={{ fontSize: '0.82rem', color: '#555' }}>{subtitle}</span>}
    </div>
  );
}

function LoadingOrError({ loading, error }) {
  if (loading) return <div style={{ color: '#999', fontSize: '0.85rem' }}>載入中...</div>;
  if (error)   return <div style={{ color: '#dc3545', background: '#fff5f5', padding: '8px 12px', borderRadius: 4, fontSize: '0.85rem' }}>{error}</div>;
  return null;
}

function OverallSummary({ s }) {
  if (!s) return null;
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20, padding: '12px 16px', background: '#f7f9ff', borderRadius: 6, border: '1px solid #dde3f0' }}>
      {[
        { label: '出賽', value: s.total },
        { label: '勝出', value: s.wins,        color: '#28a745' },
        { label: '位',   value: s.places,      color: '#007bff' },
        { label: '勝率', value: s.win_rate,    color: '#28a745' },
        { label: '位率', value: s.place_rate,  color: '#007bff' },
      ].map(({ label, value, color }) => (
        <div key={label} style={{ textAlign: 'center', minWidth: 60 }}>
          <div style={{ fontSize: '0.72rem', color: '#888' }}>{label}</div>
          <div style={{ fontWeight: 700, fontSize: '1.1rem', color: color || '#032169' }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

// ── 1. Jockey-by-horse panel ──────────────────────────────────────────────────
function JockeyByHorsePanel({ entity, onBack }) {
  const { data, loading, error } = useStatsFetch('/ai/stats-jockey-split', { horse_name: entity.name_zh || entity.name_en }, [entity.name_zh, entity.name_en]);
  return (
    <div>
      <PanelHeader title={entity.name_zh || entity.name_en} tag="換騎師分析" onBack={onBack} />
      <LoadingOrError loading={loading} error={error} />
      {data && (
        <>
          <StatsTable title="按騎師統計" rows={data.by_jockey} columns={[
            { key: 'jockey_name',  label: '騎師' },
            { key: 'total',        label: '出賽',  align: 'right' },
            { key: 'wins',         label: '勝出',  align: 'right' },
            { key: 'places',       label: '位',    align: 'right' },
            { key: 'win_rate',     label: '勝率',  align: 'right' },
            { key: 'place_rate',   label: '位率',  align: 'right' },
            { key: 'first_date',   label: '首次',  align: 'right' },
            { key: 'last_date',    label: '最近',  align: 'right' },
          ]} />

          {/* After-jockey-change summary */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, color: '#032169', fontSize: '0.88rem', marginBottom: 8 }}>
              換騎師後首場表現
              <span style={{ fontWeight: 400, color: '#888', fontSize: '0.78rem', marginLeft: 8 }}>（共 {data.after_change.total} 場）</span>
            </div>
            {data.after_change.total === 0
              ? <div style={{ color: '#999', fontSize: '0.85rem' }}>暫無換騎師記錄</div>
              : <OverallSummary s={data.after_change} />
            }
          </div>

          {data.after_change_records.length > 0 && (
            <StatsTable title="換騎師記錄" rows={data.after_change_records} columns={[
              { key: 'race_date',       label: '日期' },
              { key: 'racecourse',      label: '場地' },
              { key: 'race_no',         label: '場次', render: v => `第${v}場` },
              { key: 'race_class',      label: '組別' },
              { key: 'distance',        label: '距離' },
              { key: 'prev_jockey_name',label: '舊騎師' },
              { key: 'jockey_name',     label: '新騎師' },
              { key: 'finish_position', label: '名次', align: 'center', bold: true, render: (v, row) => v ? `${v}/${row.total_runners}` : '—' },
              { key: 'actual_weight',   label: '負磅', align: 'right' },
            ]} highlight />
          )}
        </>
      )}
    </div>
  );
}

// ── 2. Trainer × Jockey panel ─────────────────────────────────────────────────
function TrainerJockeyPanel({ trainer, jockey, onBack }) {
  const params = {};
  if (trainer) params.trainer_id = trainer.id;
  if (jockey)  params.jockey_id  = jockey.id;
  const { data, loading, error } = useStatsFetch('/ai/stats-trainer-jockey', params, [trainer?.id, jockey?.id]);

  const title = trainer && jockey
    ? `${trainer.name_zh||trainer.name_en} × ${jockey.name_zh||jockey.name_en}`
    : trainer ? `${trainer.name_zh||trainer.name_en} 合作騎師`
    : jockey  ? `${jockey.name_zh||jockey.name_en} 合作練馬師` : '組合統計';

  return (
    <div>
      <PanelHeader title={title} tag="練馬師×騎師" onBack={onBack} />
      <LoadingOrError loading={loading} error={error} />
      {data?.mode === 'combo' && (
        <>
          <OverallSummary s={data.overall} />
          <StatsTable title="場地距離統計" rows={data.by_venue} columns={[
            { key: 'racecourse',  label: '場地' },
            { key: 'distance',    label: '距離' },
            { key: 'total',       label: '出賽', align: 'right' },
            { key: 'wins',        label: '勝出', align: 'right' },
            { key: 'places',      label: '位',   align: 'right' },
            { key: 'win_rate',    label: '勝率', align: 'right' },
            { key: 'place_rate',  label: '位率', align: 'right' },
          ]} />
          <StatsTable title="近期賽事記錄" rows={data.records} columns={[
            { key: 'race_date',       label: '日期' },
            { key: 'racecourse',      label: '場地' },
            { key: 'race_no',         label: '場次', render: v => `第${v}場` },
            { key: 'race_class',      label: '組別' },
            { key: 'distance',        label: '距離' },
            { key: 'going',           label: '跑道' },
            { key: 'horse_name',      label: '馬名' },
            { key: 'gear',            label: '配備' },
            { key: 'finish_position', label: '名次', align: 'center', bold: true, render: (v, row) => v ? `${v}/${row.total_runners}` : '—' },
          ]} highlight />
        </>
      )}
      {data?.mode === 'trainer_breakdown' && (
        <StatsTable title={`${data.trainer_name} 合作騎師分析`} rows={data.by_jockey} columns={[
          { key: 'jockey_name', label: '騎師' },
          { key: 'total',       label: '出賽', align: 'right' },
          { key: 'wins',        label: '勝出', align: 'right' },
          { key: 'places',      label: '位',   align: 'right' },
          { key: 'win_rate',    label: '勝率', align: 'right' },
          { key: 'place_rate',  label: '位率', align: 'right' },
        ]} />
      )}
      {data?.mode === 'jockey_breakdown' && (
        <StatsTable title={`${data.jockey_name} 合作練馬師分析`} rows={data.by_trainer} columns={[
          { key: 'trainer_name', label: '練馬師' },
          { key: 'total',        label: '出賽', align: 'right' },
          { key: 'wins',         label: '勝出', align: 'right' },
          { key: 'places',       label: '位',   align: 'right' },
          { key: 'win_rate',     label: '勝率', align: 'right' },
          { key: 'place_rate',   label: '位率', align: 'right' },
        ]} />
      )}
    </div>
  );
}

// ── 3. Class change panel ─────────────────────────────────────────────────────
function ClassChangePanel({ entity, onBack }) {
  const { data, loading, error } = useStatsFetch('/ai/stats-class-change', { type: entity.type, id: entity.id, name: entity.name_zh || entity.name_en }, [entity.id]);
  const DIR_COLOR = { promoted: '#28a745', demoted: '#dc3545', same: '#032169', other: '#888', first: '#888' };
  return (
    <div>
      <PanelHeader title={entity.name_zh || entity.name_en} tag="升降班成績" onBack={onBack} />
      <LoadingOrError loading={loading} error={error} />
      {data?.by_direction.length === 0 && !loading && !error && <div style={{ color: '#999', fontSize: '0.85rem' }}>暫無升降班記錄</div>}
      {data?.by_direction.map(dir => (
        <div key={dir.direction} style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span style={{ fontWeight: 700, color: DIR_COLOR[dir.direction] || '#032169', fontSize: '0.92rem' }}>{dir.label}</span>
            <span style={{ fontSize: '0.8rem', color: '#888' }}>
              {dir.total}場 · 勝率 <strong style={{ color: '#28a745' }}>{dir.win_rate}</strong> · 位率 <strong style={{ color: '#007bff' }}>{dir.place_rate}</strong>
            </span>
          </div>
          {dir.records.length > 0 && (
            <StatsTable rows={dir.records} columns={[
              { key: 'race_date',       label: '日期' },
              { key: 'racecourse',      label: '場地' },
              { key: 'race_no',         label: '場次', render: v => `第${v}場` },
              { key: 'race_class',      label: '班別' },
              { key: 'distance',        label: '距離' },
              { key: 'going',           label: '跑道' },
              { key: 'horse_name',      label: '馬名' },
              { key: 'jockey_name',     label: '騎師' },
              { key: 'finish_position', label: '名次', align: 'center', bold: true, render: (v, row) => v ? `${v}/${row.total_runners}` : '—' },
            ].filter(c => entity.type === 'horse' ? c.key !== 'horse_name' : true)} highlight />
          )}
        </div>
      ))}
    </div>
  );
}

// ── 4. Gear debut panel ───────────────────────────────────────────────────────
function GearDebutPanel({ entity, onBack }) {
  const { data, loading, error } = useStatsFetch('/ai/stats-gear-debut', { horse_name: entity.name_zh || entity.name_en }, [entity.name_zh, entity.name_en]);
  return (
    <div>
      <PanelHeader title={entity.name_zh || entity.name_en} tag="首次配備成績" onBack={onBack} />
      <LoadingOrError loading={loading} error={error} />
      {data?.by_gear.length === 0 && !loading && !error && <div style={{ color: '#999', fontSize: '0.85rem' }}>暫無配備記錄</div>}
      {data?.by_gear.length > 0 && (
        <StatsTable title="各配備首次披甲表現" rows={data.by_gear} columns={[
          { key: 'label',          label: '配備' },
          { key: 'debut_date',     label: '首次日期' },
          { key: 'debut_position', label: '首次名次', align: 'center', bold: true,
            render: (v, row) => <span style={{ color: row.debut_won ? '#28a745' : 'inherit' }}>{v}</span> },
          { key: 'total',          label: '合計出賽', align: 'right' },
          { key: 'wins',           label: '合計勝',  align: 'right' },
          { key: 'win_rate',       label: '合計勝率', align: 'right' },
          { key: 'sub_total',      label: '首次後出賽', align: 'right' },
          { key: 'sub_wins',       label: '首次後勝', align: 'right' },
          { key: 'sub_win_rate',   label: '首次後勝率', align: 'right' },
        ]} />
      )}
    </div>
  );
}

// ── 5. Streak / recent form panel ─────────────────────────────────────────────
const RESULT_STYLE = {
  W: { bg: '#28a745', fg: '#fff', label: '勝' },
  P: { bg: '#007bff', fg: '#fff', label: '位' },
  L: { bg: '#e9ecef', fg: '#555', label: '出' },
};

function StreakPanel({ entity, onBack }) {
  const { data, loading, error } = useStatsFetch('/ai/stats-streak', { type: entity.type, id: entity.id, name: entity.name_zh || entity.name_en }, [entity.id]);
  const STREAK_COLOR = { W: '#28a745', P: '#007bff', L: '#dc3545' };
  return (
    <div>
      <PanelHeader title={entity.name_zh || entity.name_en} tag="連勝/連負近況" onBack={onBack} />
      <LoadingOrError loading={loading} error={error} />
      {data && (
        <>
          {/* Current streak + longest */}
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 16, padding: '12px 16px', background: '#f7f9ff', borderRadius: 6, border: '1px solid #dde3f0' }}>
            {data.current_streak && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.72rem', color: '#888' }}>目前</div>
                <div style={{ fontWeight: 700, fontSize: '1.1rem', color: STREAK_COLOR[data.current_streak.type] || '#032169' }}>
                  {data.current_streak.label} {data.current_streak.length} 場
                </div>
              </div>
            )}
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '0.72rem', color: '#888' }}>最長連勝</div>
              <div style={{ fontWeight: 700, fontSize: '1.1rem', color: '#28a745' }}>{data.longest_win_streak} 場</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '0.72rem', color: '#888' }}>最長連上位</div>
              <div style={{ fontWeight: 700, fontSize: '1.1rem', color: '#007bff' }}>{data.longest_place_streak} 場</div>
            </div>
          </div>

          {/* Recent form row */}
          {data.recent_form.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, color: '#032169', fontSize: '0.82rem', marginBottom: 6 }}>
                近期形態（最舊→最新）
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {[...data.recent_form].reverse().map((r, i) => {
                  const s = RESULT_STYLE[r.result] || RESULT_STYLE.L;
                  return (
                    <div key={i} title={`${r.race_date} 第${r.finish_position}/${r.total_runners}`}
                      style={{ width: 28, height: 28, borderRadius: 4, background: s.bg, color: s.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.72rem', fontWeight: 700, cursor: 'default' }}>
                      {s.label}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Recent records */}
          <StatsTable title="近期賽事記錄" rows={data.recent_form} columns={[
            { key: 'race_date',       label: '日期' },
            { key: 'racecourse',      label: '場地' },
            { key: 'race_no',         label: '場次', render: v => `第${v}場` },
            { key: 'race_class',      label: '組別' },
            { key: 'distance',        label: '距離' },
            { key: 'going',           label: '跑道' },
            { key: 'horse_name',      label: '馬名' },
            { key: 'jockey_name',     label: '騎師' },
            { key: 'gear',            label: '配備' },
            { key: 'finish_position', label: '名次', align: 'center', bold: true, render: (v, row) => v ? `${v}/${row.total_runners}` : '—' },
          ].filter(c => entity.type === 'horse' ? c.key !== 'horse_name' : true)} highlight />
        </>
      )}
    </div>
  );
}

// ── 6. Weight change panel ────────────────────────────────────────────────────
function WeightChangePanel({ entity, onBack }) {
  const { data, loading, error } = useStatsFetch('/ai/stats-weight-change', { horse_name: entity.name_zh || entity.name_en }, [entity.name_zh, entity.name_en]);
  return (
    <div>
      <PanelHeader title={entity.name_zh || entity.name_en} tag="體重變化成績" onBack={onBack} />
      <LoadingOrError loading={loading} error={error} />
      {data && (
        <>
          <StatsTable title="負磅變化統計（與上場比較）" rows={data.by_category} columns={[
            { key: 'label',       label: '分類' },
            { key: 'total',       label: '出賽', align: 'right' },
            { key: 'wins',        label: '勝出', align: 'right' },
            { key: 'places',      label: '位',   align: 'right' },
            { key: 'win_rate',    label: '勝率', align: 'right' },
            { key: 'place_rate',  label: '位率', align: 'right' },
          ]} />
          <StatsTable title="近期賽事記錄（含磅差）" rows={data.records} columns={[
            { key: 'race_date',       label: '日期' },
            { key: 'racecourse',      label: '場地' },
            { key: 'race_no',         label: '場次', render: v => `第${v}場` },
            { key: 'race_class',      label: '組別' },
            { key: 'distance',        label: '距離' },
            { key: 'jockey_name',     label: '騎師' },
            { key: 'actual_weight',   label: '負磅', align: 'right' },
            { key: 'weight_diff',     label: '磅差', align: 'right',
              render: v => <span style={{ color: v && v.startsWith('+') ? '#dc3545' : v && !v.startsWith('+') && v !== '0' ? '#28a745' : '#888' }}>{v}</span> },
            { key: 'finish_position', label: '名次', align: 'center', bold: true, render: (v, row) => v ? `${v}/${row.total_runners}` : '—' },
          ]} highlight />
        </>
      )}
    </div>
  );
}

// ── Stage enum ────────────────────────────────────────────────────────────────
// idle → parsing → confirm → detail
function StatsSearchPanel() {
  const [query, setQuery]       = useState('');
  const [stage, setStage]       = useState('idle');
  const [parsed, setParsed]     = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError]       = useState(null);

  async function handleSubmit(e) {
    e?.preventDefault();
    if (!query.trim()) return;
    setStage('parsing');
    setError(null);
    setParsed(null);
    setSelected(null);
    try {
      const res = await api.post('/ai/parse-query', { query });
      setParsed(res.data);
      setStage('confirm');
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setStage('idle');
    }
  }

  function handleConfirm(entityOverride) {
    const qt = parsed.query_type || 'simple';

    if (qt === 'trainer_jockey') {
      const trainer = parsed.entities.find(e => e.type === 'trainer') || null;
      const jockey  = parsed.entities.find(e => e.type === 'jockey')  || null;
      setSelected({ query_type: qt, trainer, jockey });
    } else {
      const entity = entityOverride || parsed.entities[0];
      const filters = {};
      const filterParts = [];
      if (qt === 'simple') {
        if (parsed.gear_codes?.length === 1) { filters.gear_code = parsed.gear_codes[0]; filterParts.push(GEAR_LABEL[filters.gear_code] || filters.gear_code); }
        if (parsed.venue)    { filters.venue    = parsed.venue;                filterParts.push(COURSE_LABEL[parsed.venue]); }
        if (parsed.distance) { filters.distance = parsed.distance;             filterParts.push(`${parsed.distance}米`); }
      }
      setSelected({ query_type: qt, entity, filters, filterDesc: filterParts.join('・') });
    }
    setStage('detail');
  }

  function handleReset() {
    setStage('idle');
    setParsed(null);
    setSelected(null);
    setError(null);
  }

  function renderDetailPanel() {
    if (!selected) return null;
    const back = () => { setStage('confirm'); setSelected(null); };
    switch (selected.query_type) {
      case 'jockey_split':    return <JockeyByHorsePanel  entity={selected.entity} onBack={back} />;
      case 'trainer_jockey':  return <TrainerJockeyPanel  trainer={selected.trainer} jockey={selected.jockey} onBack={back} />;
      case 'class_change':    return <ClassChangePanel    entity={selected.entity} onBack={back} />;
      case 'gear_debut':      return <GearDebutPanel      entity={selected.entity} onBack={back} />;
      case 'streak':          return <StreakPanel          entity={selected.entity} onBack={back} />;
      case 'weight_change':   return <WeightChangePanel   entity={selected.entity} onBack={back} />;
      default:                return <StatsDetailPanel entity={selected.entity} filters={selected.filters} filterDesc={selected.filterDesc} onBack={back} />;
    }
  }

  const EXAMPLES = [
    '蔡約翰佩戴眼罩的成績',
    '巴度沙田1200米勝率',
    '美麗傳承換騎師後表現',
    '蔡約翰配巴度組合',
    '何澤堯升降班成績',
    '美麗傳承首次配備成績',
    '美麗傳承連勝記錄',
    '美麗傳承體重變化',
  ];

  return (
    <div style={{ marginBottom: 32 }}>
      <h3 style={{ margin: '0 0 12px', color: '#032169', fontSize: '1rem' }}>尋找統計數據</h3>

      {stage !== 'detail' && (
        <>
          <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <input
              type="text"
              value={query}
              onChange={e => { setQuery(e.target.value); if (stage !== 'idle') handleReset(); }}
              placeholder="輸入問題：馬匹名字、換騎師、升降班、組合、近況..."
              style={{ flex: '1 1 340px', minWidth: 0, padding: '7px 10px', border: '1px solid #ccc', borderRadius: 4, fontSize: '0.9rem' }}
            />
            <button type="submit" disabled={stage === 'parsing' || !query.trim()}
              style={{ padding: '7px 20px', background: stage === 'parsing' ? '#aaa' : '#032169', color: '#fff', border: 'none', borderRadius: 4, cursor: stage === 'parsing' ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '0.9rem' }}>
              {stage === 'parsing' ? '分析中...' : '搜尋'}
            </button>
          </form>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {EXAMPLES.map(ex => (
              <button key={ex} onClick={() => { setQuery(ex); handleReset(); }}
                style={{ fontSize: '0.75rem', padding: '2px 9px', background: '#f0f4ff', border: '1px solid #c0cce8', borderRadius: 12, cursor: 'pointer', color: '#032169' }}>
                {ex}
              </button>
            ))}
          </div>
        </>
      )}

      {error && <div style={{ color: '#dc3545', background: '#fff5f5', padding: '8px 12px', borderRadius: 4, fontSize: '0.85rem', marginBottom: 12 }}>{error}</div>}

      {/* Confirmation card */}
      {stage === 'confirm' && parsed && (
        <div style={{ border: '1px solid #c0cce8', borderRadius: 6, padding: '14px 16px', background: '#f7f9ff', marginBottom: 12 }}>
          <div style={{ fontSize: '0.82rem', color: '#555', marginBottom: 10 }}>
            系統理解為：<strong style={{ color: '#032169' }}>{parsed.description}</strong>
          </div>

          {/* Extra filter info for simple queries */}
          {parsed.query_type === 'simple' && parsed.gear_codes?.length > 0 && (
            <div style={{ fontSize: '0.78rem', color: '#666', marginBottom: 6 }}>
              配備：{parsed.gear_codes.map(c => <span key={c} style={{ background: '#e3f2fd', color: '#1565c0', borderRadius: 10, padding: '1px 8px', marginRight: 4 }}>{GEAR_LABEL[c] || c}</span>)}
            </div>
          )}
          {parsed.query_type === 'simple' && parsed.venue    && <div style={{ fontSize: '0.78rem', color: '#666', marginBottom: 4 }}>場地：{COURSE_LABEL[parsed.venue]}</div>}
          {parsed.query_type === 'simple' && parsed.distance && <div style={{ fontSize: '0.78rem', color: '#666', marginBottom: 4 }}>距離：{parsed.distance}米</div>}

          {parsed.entities.length === 0 && (
            <div style={{ color: '#dc3545', fontSize: '0.82rem', marginTop: 8 }}>未能識別馬匹、練馬師或騎師名稱，請嘗試更具體的輸入</div>
          )}

          {/* trainer_jockey: show both together, single confirm */}
          {parsed.query_type === 'trainer_jockey' && !parsed.ambiguous && parsed.entities.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              {parsed.entities.filter(e => e.type === 'trainer').map(e => <EntityChip key={e.id} entity={e} />)}
              {parsed.entities.filter(e => e.type === 'trainer').length > 0 && parsed.entities.filter(e => e.type === 'jockey').length > 0 && (
                <span style={{ color: '#888', fontSize: '0.8rem' }}>×</span>
              )}
              {parsed.entities.filter(e => e.type === 'jockey').map(e => <EntityChip key={e.id} entity={e} />)}
              <button onClick={() => handleConfirm()}
                style={{ padding: '5px 16px', background: '#032169', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem' }}>
                確認查詢
              </button>
            </div>
          )}

          {/* Single entity (non-trainer_jockey or ambiguous not yet resolved) */}
          {parsed.query_type !== 'trainer_jockey' && parsed.entities.length === 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <EntityChip entity={parsed.entities[0]} />
              <button onClick={() => handleConfirm(parsed.entities[0])}
                style={{ padding: '5px 16px', background: '#032169', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem' }}>
                確認查詢
              </button>
            </div>
          )}

          {/* Ambiguous: let user pick */}
          {parsed.ambiguous && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: '0.8rem', color: '#666', marginBottom: 6 }}>找到多個符合結果，請選擇：</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 440 }}>
                {parsed.entities.map(e => (
                  <button key={`${e.type}-${e.id}`} onClick={() => handleConfirm(e)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', background: '#fff', border: '1px solid #dde3f0', borderRadius: 4, cursor: 'pointer', textAlign: 'left' }}>
                    <EntityChip entity={e} />
                    <span style={{ fontWeight: 600, fontSize: '0.88rem' }}>{e.name_zh}</span>
                    {e.name_en && e.name_en !== e.name_zh && <span style={{ fontSize: '0.8rem', color: '#888' }}>{e.name_en}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {stage === 'detail' && renderDetailPanel()}
    </div>
  );
}

function EntityChip({ entity }) {
  const tc = TYPE_COLOR[entity.type] || { bg: '#f0f4ff', fg: '#032169' };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ fontSize: '0.72rem', background: tc.bg, color: tc.fg, borderRadius: 10, padding: '1px 7px', whiteSpace: 'nowrap' }}>
        {TYPE_LABEL[entity.type]}
      </span>
      <span style={{ fontWeight: 600, fontSize: '0.88rem' }}>{entity.name_zh || entity.name_en}</span>
    </span>
  );
}


// ── Hot Favourite Next Race Panel (大熱再出) ──────────────────────────────────
const COURSE_MAP_HF = { ST: '沙田', HV: '跑馬地' };
const ODDS_PRESETS = [
  { label: '≤2.0', val: 2.0 },
  { label: '≤2.5', val: 2.5 },
  { label: '≤3.0', val: 3.0 },
  { label: '≤3.5', val: 3.5 },
  { label: '≤4.0', val: 4.0 },
];
const FINISH_FILTERS = [
  { label: '全部', val: 'all' },
  { label: '頭馬', val: 'win' },
  { label: '上名', val: 'place' },
  { label: '落第', val: 'lost' },
];

function FilterBtns({ value, onChange }) {
  return (
    <span style={{ display: 'inline-flex', gap: 2, marginLeft: 6, verticalAlign: 'middle' }}>
      {FINISH_FILTERS.map(f => (
        <button key={f.val}
          onClick={(e) => { e.stopPropagation(); onChange(f.val); }}
          style={{
            padding: '1px 5px', fontSize: '0.68rem', borderRadius: 3, cursor: 'pointer',
            border: '1px solid #b0c4de',
            background: value === f.val ? '#032169' : '#fff',
            color:      value === f.val ? '#fff'    : '#032169',
            fontWeight: value === f.val ? 700       : 400,
            lineHeight: 1.4,
          }}>
          {f.label}
        </button>
      ))}
    </span>
  );
}

function HotFavNextPanel() {
  const [maxOdds, setMaxOdds] = useState(3.0);
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [sortKey, setSortKey]   = useState('total');
  const [sortAsc, setSortAsc]   = useState(false);
  const [finishFilter, setFinishFilter] = useState('all');
  const [hotFinishFilter, setHotFinishFilter] = useState('all');
  const [nextFinishFilter, setNextFinishFilter] = useState('all');

  useEffect(() => { loadData(3.0); }, []);

  async function loadData(odds) {
    setLoading(true); setError(null); setExpanded(new Set());
    try {
      const res = await api.get('/ai/hot-fav-next', { params: { max_odds: odds } });
      setData(res.data);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }

  function applyPreset(val) {
    setMaxOdds(val); loadData(val);
  }

  function toggleSort(key) {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(false); }
  }

  function toggleRow(name) {
    setExpanded(prev => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });
  }

  const filterRecords = (records) => {
    let fr = records;
    if (hotFinishFilter === 'win') fr = fr.filter(r => r.hot_finish === 1);
    else if (hotFinishFilter === 'place') fr = fr.filter(r => r.hot_finish <= 3);
    else if (hotFinishFilter === 'lost') fr = fr.filter(r => r.hot_finish > 3 || r.hot_finish == null);
    if (nextFinishFilter === 'win') fr = fr.filter(r => r.next_finish === 1);
    else if (nextFinishFilter === 'place') fr = fr.filter(r => r.next_finish <= 3);
    else if (nextFinishFilter === 'lost') fr = fr.filter(r => r.next_finish > 3 || r.next_finish == null);
    return fr;
  };

  const allTrainers = (data?.trainers || []).slice().sort((a, b) => {
    const v = (x) => typeof x[sortKey] === 'string' ? parseFloat(x[sortKey]) || 0 : (x[sortKey] ?? 0);
    return sortAsc ? v(a) - v(b) : v(b) - v(a);
  });

  const trainers = allTrainers.map(t => {
    const fr = filterRecords(t.records);
    const tot = fr.length;
    const w = fr.filter(r => r.next_finish === 1).length;
    const p = fr.filter(r => r.next_finish <= 3).length;
    return {
      ...t,
      records: fr,
      total: tot,
      wins: w,
      places: p,
      win_rate: tot > 0 ? ((w / tot) * 100).toFixed(1) + '%' : 'N/A',
      place_rate: tot > 0 ? ((p / tot) * 100).toFixed(1) + '%' : 'N/A',
      avg_days: tot > 0 ? Math.round(fr.reduce((s, r) => s + (r.days_gap || 0), 0) / tot) : 0,
    };
  }).filter(t => t.total > 0);

  const filteredTotal = trainers.reduce((s, t) => s + t.total, 0);
  const filteredWins = trainers.reduce((s, t) => s + t.wins, 0);
  const filteredPlaces = trainers.reduce((s, t) => s + t.places, 0);

  const SortTh = ({ label, col, right }) => {
    const active = sortKey === col;
    return (
      <th onClick={() => toggleSort(col)} style={{
        padding: '5px 8px', textAlign: right ? 'right' : 'center', fontWeight: 600,
        color: active ? '#032169' : '#444', borderBottom: '2px solid #c0cce8',
        whiteSpace: 'nowrap', cursor: 'pointer', background: active ? '#dce6f7' : '#e8eef8',
        fontSize: '0.78rem', userSelect: 'none',
      }}>
        {label}{active ? (sortAsc ? ' ▲' : ' ▼') : ''}
      </th>
    );
  };

  const winColor = r => r === '0.0%' ? '#999' : '#28a745';
  const plcColor = r => r === '0.0%' ? '#999' : '#007bff';

  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, color: '#032169', fontSize: '1rem' }}>大熱再出表現</h3>
        <div style={{ display: 'flex', gap: 6 }}>
          {ODDS_PRESETS.map(p => (
            <button key={p.label}
              onClick={() => applyPreset(p.val)}
              style={{
                padding: '3px 10px', fontSize: '0.8rem', borderRadius: 4, cursor: 'pointer',
                border: '1px solid #c0cce8',
                background: maxOdds === p.val ? '#032169' : '#f0f4ff',
                color:      maxOdds === p.val ? '#fff'    : '#032169',
                fontWeight: maxOdds === p.val ? 700       : 400,
              }}>
              {p.label}
            </button>
          ))}
        </div>
        {data && (
          <span style={{ fontSize: '0.8rem', color: '#666' }}>
            共 <strong style={{ color: '#032169' }}>{filteredTotal}</strong> 匹大熱再出
            （勝率 <strong style={{ color: winColor(filteredTotal > 0 ? ((filteredWins / filteredTotal) * 100).toFixed(1) + '%' : 'N/A') }}>{filteredTotal > 0 ? ((filteredWins / filteredTotal) * 100).toFixed(1) + '%' : 'N/A'}</strong>
            ・位率 <strong style={{ color: plcColor(filteredTotal > 0 ? ((filteredPlaces / filteredTotal) * 100).toFixed(1) + '%' : 'N/A') }}>{filteredTotal > 0 ? ((filteredPlaces / filteredTotal) * 100).toFixed(1) + '%' : 'N/A'}</strong>）
            ／<strong>{trainers.length}</strong> 個馬房
          </span>
        )}
      </div>

      {loading && <div style={{ color: '#666', padding: '16px 0' }}>載入中...</div>}
      {error   && <div style={{ color: '#dc3545', padding: '8px 12px', background: '#fff5f5', borderRadius: 4 }}>{error}</div>}

      {!loading && !error && data && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.83rem' }}>
            <thead>
              <tr>
                <th style={{ padding: '5px 8px', fontWeight: 600, color: '#444',
                  borderBottom: '2px solid #c0cce8', background: '#e8eef8',
                  fontSize: '0.78rem', whiteSpace: 'nowrap' }}>
                  練馬師
                </th>
                <SortTh label="次數" col="total" />
                <SortTh label="勝出" col="wins" />
                <SortTh label="位置" col="places" />
                <SortTh label="勝率" col="win_rate" />
                <SortTh label="位率" col="place_rate" />
                <SortTh label="平均間隔" col="avg_days" />
              </tr>
            </thead>
            <tbody>
              {trainers.map((t, i) => {
                const isExp = expanded.has(t.trainer_name);
                const bg    = i % 2 === 0 ? '#fff' : '#f7f9ff';
                return (
                  <React.Fragment key={t.trainer_name}>
                    <tr style={{ background: isExp ? '#edf2ff' : bg, cursor: 'pointer' }}
                        onClick={() => toggleRow(t.trainer_name)}>
                      <td style={{ padding: '5px 10px', fontWeight: 600, color: '#032169',
                        whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: '0.7rem', color: '#888' }}>{isExp ? '▼' : '▶'}</span>
                        {t.trainer_name}
                      </td>
                      <td style={{ padding: '5px 8px', textAlign: 'center', fontWeight: 700 }}>{t.total}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'center' }}>{t.wins}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'center' }}>{t.places}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'center', fontWeight: 600, color: winColor(t.win_rate) }}>{t.win_rate}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'center', fontWeight: 600, color: plcColor(t.place_rate) }}>{t.place_rate}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'center', color: '#555' }}>{t.avg_days} 天</td>
                    </tr>
                    {isExp && (
                      <tr key={t.trainer_name + '_detail'}>
                        <td colSpan={7} style={{ padding: '8px 16px 14px', background: '#f4f7ff' }}>
                          <table style={{ borderCollapse: 'collapse', fontSize: '0.76rem', width: '100%' }}>
                            <thead>
                              <tr>
                                <th rowSpan={2} style={hfThStyle}>馬名</th>
                                <th colSpan={6} style={{ ...hfThStyle, background: '#e3f2fd', textAlign: 'center' }}>
                                  大熱當場
                                  <FilterBtns value={hotFinishFilter} onChange={setHotFinishFilter} />
                                </th>
                                <th colSpan={7} style={{ ...hfThStyle, background: '#e8f5e9', textAlign: 'center' }}>
                                  再出下仗
                                  <FilterBtns value={nextFinishFilter} onChange={setNextFinishFilter} />
                                </th>
                              </tr>
                              <tr>
                                <th style={hfThStyle}>日期</th>
                                <th style={hfThStyle}>馬場</th>
                                <th style={hfThStyle}>班次</th>
                                <th style={hfThStyle}>騎師</th>
                                <th style={hfThStyle}>賠率</th>
                                <th style={hfThStyle}>名次</th>
                                <th style={hfThStyle}>日期</th>
                                <th style={hfThStyle}>馬場</th>
                                <th style={hfThStyle}>騎師</th>
                                <th style={hfThStyle}>賠率</th>
                                <th style={hfThStyle}>名次</th>
                                <th style={hfThStyle}>相隔</th>
                              </tr>
                            </thead>
                            <tbody>
                              {t.records.map((r, ri) => {
                                const isWin   = r.next_finish === 1;
                                const isPlace = r.next_finish <= 3;
                                const posColor = isWin ? '#28a745' : isPlace ? '#007bff' : '#555';
                                return (
                                  <tr key={ri} style={{ background: ri % 2 === 0 ? '#fff' : '#f0f5ff' }}>
                                    <td style={hfTdStyle}>{r.horse_name}</td>
                                    <td style={hfTdStyle}>{r.hot_date}</td>
                                    <td style={hfTdStyle}>{COURSE_MAP_HF[r.hot_racecourse] || r.hot_racecourse}</td>
                                    <td style={hfTdStyle}>{r.hot_class || '—'}</td>
                                    <td style={hfTdStyle}>{r.hot_jockey || r.hot_jockey_id || '—'}</td>
                                    <td style={{ ...hfTdStyle, color: '#dc3545', fontWeight: 600 }}>{r.hot_odds}</td>
                                    <td style={hfTdStyle}>{r.hot_finish}/{r.hot_runners}</td>
                                    <td style={hfTdStyle}>{r.next_date}</td>
                                    <td style={hfTdStyle}>{COURSE_MAP_HF[r.next_racecourse] || r.next_racecourse}</td>
                                    <td style={hfTdStyle}>{r.next_jockey || r.next_jockey_id || '—'}</td>
                                    <td style={hfTdStyle}>{r.next_odds != null ? r.next_odds : '—'}</td>
                                    <td style={{ ...hfTdStyle, fontWeight: isWin ? 700 : 400, color: posColor }}>{r.next_finish}/{r.next_runners}</td>
                                    <td style={{ ...hfTdStyle, color: '#e67e00' }}>{r.days_gap}天</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const hfThStyle = {
  padding: '4px 6px', textAlign: 'center', fontWeight: 600, color: '#032169',
  background: '#dce6f7', borderBottom: '2px solid #a0b4d8', whiteSpace: 'nowrap', fontSize: '0.76rem',
};
const hfTdStyle = { padding: '3px 6px', textAlign: 'center', whiteSpace: 'nowrap' };

// ── Trainer Monthly Performance Panel (每月表現圖表) ──────────────────────────
const MONTH_LABELS = ['9月','10月','11月','12月','1月','2月','3月','4月','5月','6月','7月','8月'];
const MONTH_ORDER = [9,10,11,12,1,2,3,4,5,6,7,8];
const METRIC_OPTS = [
  { key: 'total',  label: '出賽次數', color: '#032169' },
  { key: 'wins',   label: '勝出',     color: '#28a745' },
  { key: 'win_rate',  label: '勝率%',  color: '#28a745' },
  { key: 'place_rate', label: '位率%', color: '#007bff' },
];

function TrainerMonthlyPanel() {
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [selectedTrainer, setSelectedTrainer] = useState('');
  const [metric, setMetric]       = useState('win_rate');
  const [viewMode, setViewMode]   = useState('combined');
  const [selectedSeason, setSelectedSeason] = useState('');

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/ai/trainer-monthly');
      setData(res.data);
      if (res.data.trainers.length > 0 && !selectedTrainer) {
        setSelectedTrainer(res.data.trainers[0].trainer_name);
      }
      if (res.data.seasons.length > 0 && !selectedSeason) {
        setSelectedSeason(res.data.seasons[res.data.seasons.length - 1]);
      }
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }

  const trainer = data?.trainers.find(t => t.trainer_name === selectedTrainer);
  const seasons = data?.seasons || [];

  // Top-5 per month: combined or per-season depending on viewMode
  const top5 = React.useMemo(() => {
    if (!data) return null;
    const winTop5 = {}, placeTop5 = {};
    for (const m of MONTH_ORDER) {
      const entries = [];
      for (const t of data.trainers) {
        const md = viewMode === 'combined'
          ? t.months[m]
          : t.bySeason?.[selectedSeason]?.months?.[m];
        if (!md || md.total < 5) continue;
        entries.push({
          name: t.trainer_name,
          wr: +(md.wins / md.total * 100).toFixed(1),
          pr: +(md.places / md.total * 100).toFixed(1),
        });
      }
      winTop5[m] = new Set(entries.sort((a, b) => b.wr - a.wr).slice(0, 5).map(e => e.name));
      placeTop5[m] = new Set(entries.sort((a, b) => b.pr - a.pr).slice(0, 5).map(e => e.name));
    }
    return { winTop5, placeTop5 };
  }, [data, viewMode, selectedSeason]);

  // Build monthData: array of 12, each either { combined } or { bySeason: {season: data} }
  const monthData = React.useMemo(() => {
    if (!trainer) return null;
    const arr = Array(12).fill(null).map((_, i) => {
      const mo = MONTH_ORDER[i];
      // Combined
      const cm = trainer.months[mo];
      const combined = cm ? {
        total: cm.total, wins: cm.wins, places: cm.places,
        win_rate: cm.total > 0 ? +(cm.wins / cm.total * 100).toFixed(1) : 0,
        place_rate: cm.total > 0 ? +(cm.places / cm.total * 100).toFixed(1) : 0,
      } : null;
      // Per season
      const bySeason = {};
      for (const s of seasons) {
        const sm = trainer.bySeason?.[s]?.months?.[mo];
        bySeason[s] = sm ? {
          total: sm.total, wins: sm.wins, places: sm.places,
          win_rate: sm.total > 0 ? +(sm.wins / sm.total * 100).toFixed(1) : 0,
          place_rate: sm.total > 0 ? +(sm.places / sm.total * 100).toFixed(1) : 0,
        } : null;
      }
      return { combined, bySeason };
    });
    return arr;
  }, [trainer, seasons]);

  const chartData = React.useMemo(() => {
    if (!monthData) return null;
    const colors = { total: '#032169', wins: '#28a745', win_rate: '#28a745', place_rate: '#007bff' };
    const source = viewMode === 'combined'
      ? monthData.map(m => m.combined)
      : monthData.map(m => m.bySeason[selectedSeason]);
    return {
      labels: MONTH_LABELS,
      datasets: [{
        label: viewMode === 'bySeason'
          ? `${selectedSeason} ${METRIC_OPTS.find(m => m.key === metric)?.label || ''}`
          : (METRIC_OPTS.find(m => m.key === metric)?.label || metric),
        data: source.map(m => m ? m[metric] : 0),
        backgroundColor: colors[metric] + 'cc',
        borderColor: colors[metric],
        borderWidth: 1, borderRadius: 3,
      }],
    };
  }, [monthData, metric, viewMode, selectedSeason]);

  const chartOptions = {
    responsive: true,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          afterLabel: (ctx) => {
            const md = monthData?.[ctx.dataIndex];
            if (!md) return '';
            const m = viewMode === 'combined' ? md.combined : md.bySeason[selectedSeason];
            if (!m) return '';
            return [`出賽: ${m.total}`, `勝出: ${m.wins} (${m.win_rate}%)`, `位置: ${m.places} (${m.place_rate}%)`];
          },
        },
      },
    },
    scales: {
      y: {
        beginAtZero: true,
        ticks: { font: { size: 11 } },
        title: { display: true, text: METRIC_OPTS.find(m => m.key === metric)?.label || '', font: { size: 12 } },
      },
      x: { ticks: { font: { size: 11 } } },
    },
  };

  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, color: '#032169', fontSize: '1rem' }}>練馬師每月出賽表現</h3>
        {data && (
          <select
            value={selectedTrainer}
            onChange={(e) => setSelectedTrainer(e.target.value)}
            style={{ padding: '4px 8px', border: '1px solid #ccc', borderRadius: 4, fontSize: '0.9rem', minWidth: 160 }}
          >
            {data.trainers.filter(t => t.total >= 50).map(t => (
              <option key={t.trainer_name} value={t.trainer_name}>
                {t.trainer_name}（{t.total}仗 {t.wins}W {t.win_rate}）
              </option>
            ))}
          </select>
        )}
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => setViewMode('combined')}
            style={{
              padding: '3px 10px', fontSize: '0.78rem', borderRadius: 4, cursor: 'pointer',
              border: '1px solid #c0cce8',
              background: viewMode === 'combined' ? '#032169' : '#f0f4ff',
              color: viewMode === 'combined' ? '#fff' : '#032169',
              fontWeight: viewMode === 'combined' ? 700 : 400,
            }}>近三季</button>
          <button onClick={() => setViewMode('bySeason')}
            style={{
              padding: '3px 10px', fontSize: '0.78rem', borderRadius: 4, cursor: 'pointer',
              border: '1px solid #c0cce8',
              background: viewMode === 'bySeason' ? '#032169' : '#f0f4ff',
              color: viewMode === 'bySeason' ? '#fff' : '#032169',
              fontWeight: viewMode === 'bySeason' ? 700 : 400,
            }}>逐季</button>
        </div>
        {viewMode === 'bySeason' && data && (
          <select
            value={selectedSeason}
            onChange={(e) => setSelectedSeason(e.target.value)}
            style={{ padding: '4px 8px', border: '1px solid #ccc', borderRadius: 4, fontSize: '0.9rem' }}
          >
            {data.seasons.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        )}
        <div style={{ display: 'flex', gap: 4 }}>
          {METRIC_OPTS.map(m => (
            <button key={m.key}
              onClick={() => setMetric(m.key)}
              style={{
                padding: '3px 10px', fontSize: '0.78rem', borderRadius: 4, cursor: 'pointer',
                border: '1px solid #c0cce8',
                background: metric === m.key ? '#032169' : '#f0f4ff',
                color:      metric === m.key ? '#fff'    : '#032169',
                fontWeight: metric === m.key ? 700       : 400,
              }}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <div style={{ color: '#666', padding: '16px 0' }}>載入中...</div>}
      {error   && <div style={{ color: '#dc3545', padding: '8px 12px', background: '#fff5f5', borderRadius: 4 }}>{error}</div>}

      {!loading && !error && trainer && monthData && (
        <>
          {/* Overall summary */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16, padding: '10px 16px', background: '#f7f9ff', borderRadius: 6, border: '1px solid #dde3f0' }}>
            {[
              { label: '總出賽', value: trainer.total, color: '#032169' },
              { label: '總勝出', value: trainer.wins,  color: '#28a745' },
              { label: '總位置', value: trainer.places, color: '#007bff' },
              { label: '勝率',   value: trainer.win_rate,   color: '#28a745' },
              { label: '位率',   value: trainer.place_rate, color: '#007bff' },
            ].map(s => (
              <div key={s.label} style={{ textAlign: 'center', minWidth: 50 }}>
                <div style={{ fontSize: '0.72rem', color: '#888' }}>{s.label}</div>
                <div style={{ fontWeight: 700, fontSize: '1.05rem', color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>

          {/* Chart */}
          <div style={{ maxWidth: 800, marginBottom: 16 }}>
            {chartData && <Bar data={chartData} options={chartOptions} />}
          </div>

          {/* Monthly table */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.82rem' }}>
              <thead>
                <tr>
                  <th style={tmTh}>月份</th>
                  <th style={tmTh}>出賽</th>
                  <th style={tmTh}>勝出</th>
                  <th style={tmTh}>位置</th>
                  <th style={tmTh}>勝率</th>
                  <th style={tmTh}>位率</th>
                </tr>
              </thead>
              <tbody>
                {monthData.map((md, i) => {
                  const mo = MONTH_ORDER[i];
                  const isWinTop5 = top5?.winTop5[mo]?.has(selectedTrainer);
                  const isPlaceTop5 = top5?.placeTop5[mo]?.has(selectedTrainer);
                  const m = viewMode === 'combined' ? md.combined : md.bySeason[selectedSeason];
                  if (!m) return (
                    <tr key={i} style={{ background: '#fafafa' }}>
                      <td style={{ ...tmTd, fontWeight: 600, color: '#032169' }}>{MONTH_LABELS[i]}</td>
                      <td style={{ ...tmTd, color: '#ccc' }} colSpan={5}>—</td>
                    </tr>
                  );
                  return (
                    <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#f7f9ff' }}>
                      <td style={{ ...tmTd, fontWeight: 600, color: '#032169' }}>{MONTH_LABELS[i]}</td>
                      <td style={{ ...tmTd, fontWeight: 600 }}>{m.total}</td>
                      <td style={{ ...tmTd, color: m.wins > 0 ? '#28a745' : '#999', fontWeight: m.wins > 0 ? 700 : 400 }}>{m.wins}</td>
                      <td style={{ ...tmTd, color: m.places > 0 ? '#007bff' : '#999' }}>{m.places}</td>
                      <td style={{
                        ...tmTd, fontWeight: 700,
                        background: isWinTop5 ? '#28a74522' : 'inherit',
                        color: isWinTop5 ? '#28a745' : m.win_rate >= 15 ? '#28a745' : m.win_rate >= 8 ? '#555' : '#999',
                      }}>{m.win_rate}%{isWinTop5 && ' ★'}</td>
                      <td style={{
                        ...tmTd, fontWeight: 700,
                        background: isPlaceTop5 ? '#28a74522' : 'inherit',
                        color: isPlaceTop5 ? '#28a745' : m.place_rate >= 35 ? '#007bff' : '#555',
                      }}>{m.place_rate}%{isPlaceTop5 && ' ★'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const tmTh = {
  padding: '5px 10px', textAlign: 'center', fontWeight: 600, color: '#032169',
  background: '#e8eef8', borderBottom: '2px solid #c0cce8', fontSize: '0.78rem', whiteSpace: 'nowrap',
};
const tmTd = { padding: '4px 10px', textAlign: 'center', whiteSpace: 'nowrap' };

// ── AI數據面板：12 條統計查詢 ──
function AiDataPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [upcoming, setUpcoming] = useState(null);
  useEffect(() => {
    api.get('/ai-data/queries', { timeout: 300000 })
      .then(r => setData(r.data))
      .catch(e => setError(e.response?.data?.error || e.message));
    api.get('/ai-data/upcoming', { timeout: 120000 })
      .then(r => setUpcoming(r.data))
      .catch(() => setUpcoming({ raceDate: null, matches: [] }));
  }, []);

  if (error) return (
    <div>
      <h3 style={{ margin: 0, color: '#032169', fontSize: '1rem', marginBottom: 12 }}>AI數據</h3>
      <div style={{ color: '#dc3545', padding: '8px 12px', background: '#fff5f5', borderRadius: 4 }}>{error}</div>
    </div>
  );
  if (!data) return (
    <div>
      <h3 style={{ margin: 0, color: '#032169', fontSize: '1rem', marginBottom: 12 }}>AI數據</h3>
      <div style={{ color: '#666', padding: '20px 0' }}>統計中（70,000 場績掃描）…</div>
    </div>
  );

  const th = { padding: '4px 8px', background: '#e8eef8', borderBottom: '2px solid #c0cce8', fontSize: '0.72rem', textAlign: 'center', whiteSpace: 'nowrap', color: '#032169', fontWeight: 600 };
  const td = { padding: '3px 8px', borderBottom: '1px solid #eef1f5', fontSize: '0.75rem', whiteSpace: 'nowrap' };

  return (
    <div>
      <h3 style={{ margin: 0, color: '#032169', fontSize: '1rem', marginBottom: 4 }}>AI數據</h3>
      <div style={{ fontSize: '0.75rem', color: '#889', marginBottom: 12 }}>由 {data.from} 起（上季至今）・每條可撳開睇逐場細節</div>

      {/* 下個賽日符合預告 */}
      {upcoming && upcoming.raceDate && (
        <div style={{ marginBottom: 14, border: '2px solid #032169', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ background: '#032169', color: '#fff', padding: '6px 12px', fontWeight: 700, fontSize: '0.85rem' }}>
            📅 下個賽日預告（{String(upcoming.raceDate).slice(0, 10)}）— 符合 {upcoming.matches.length} 條訊號
          </div>
          {upcoming.matches.length ? upcoming.matches.map(m => (
            <div key={m.id} style={{ padding: '6px 12px', borderBottom: '1px solid #e5eaf4', background: '#f4f7ff' }}>
              <b style={{ color: '#032169', fontSize: '0.8rem' }}>#{m.id} {m.title}</b>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                {m.entries.map((e, i) => (
                  <span key={i} style={{ background: '#fff', border: '1px solid #c8d4ea', borderRadius: 6, padding: '3px 8px', fontSize: '0.75rem' }}>
                    <b>{e.race_no}場 {e.horse_name}</b>
                    <span style={{ color: '#667' }}>｜{e.jockey_name || e.jockey_id}／{e.trainer_name}｜{e.draw}檔・{e.actual_weight}磅</span>
                  </span>
                ))}
              </div>
            </div>
          )) : (
            <div style={{ padding: '10px 12px', color: '#889', fontSize: '0.8rem' }}>下個賽日（{String(upcoming.raceDate).slice(0, 10)}）暫時冇馬符合 12 條訊號</div>
          )}
        </div>
      )}

      {data.queries.map(q => {
        const s = q.summary;
        return (
          <details key={q.id} style={{ marginBottom: 8, border: '1px solid #d8e0ee', borderRadius: 6, background: '#fbfcfe' }}>
            <summary style={{ cursor: 'pointer', padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <b style={{ color: '#032169', fontSize: '0.85rem' }}>{q.id}. {q.title}</b>
              {s && (
                <span style={{ fontSize: '0.78rem', color: '#445' }}>
                  <b style={{ background: '#032169', color: '#fff', borderRadius: 4, padding: '1px 8px' }}>{s.n}</b> 場
                  ｜冠 <b>{s.wins}</b>（{s.winRate != null ? (s.winRate * 100).toFixed(1) : 0}%）
                  ｜前三 <b>{s.top3}</b>（{s.placeRate != null ? (s.placeRate * 100).toFixed(1) : 0}%）
                  ｜Win ROI <b style={{ color: s.roi > 0 ? '#155724' : '#c0392b' }}>{s.roi != null ? `${(s.roi * 100).toFixed(1)}%` : '—'}</b>
                </span>
              )}
            </summary>
            <div style={{ padding: '0 12px 10px' }}>
              {q.note && <div style={{ fontSize: '0.72rem', color: '#a67c00', background: '#fffbe6', padding: '4px 8px', borderRadius: 4, marginBottom: 6 }}>{q.note}</div>}
              {q.error ? (
                <div style={{ color: '#dc3545', fontSize: '0.78rem' }}>查詢錯誤：{q.error}</div>
              ) : s && s.n > 0 ? (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        {['日期','場','班','途程','馬名','騎師','練馬師','檔','磅','名次','獨贏','上場日期','上場場地','上場名次','上場途程'].map(h => <th key={h} style={th}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {q.rows.map((r, i) => (
                        <tr key={i} style={{ background: r.finish_position === 1 ? '#fffbe6' : i % 2 ? '#fafbfe' : '#fff' }}>
                          <td style={td}>{String(r.race_date).slice(0, 10)}</td>
                          <td style={td}>{r.racecourse}</td>
                          <td style={td}>{r.race_class}</td>
                          <td style={td}>{r.distance}</td>
                          <td style={{ ...td, fontWeight: 600 }}>{r.horse_name}</td>
                          <td style={td}>{r.jockey}</td>
                          <td style={td}>{r.trainer_name}</td>
                          <td style={td}>{r.draw}</td>
                          <td style={td}>{r.actual_weight}</td>
                          <td style={{ ...td, fontWeight: r.finish_position <= 3 ? 800 : 400, color: r.finish_position === 1 ? '#155724' : r.finish_position <= 3 ? '#032169' : '#555' }}>{r.finish_position}</td>
                          <td style={td}>{r.win_odds ?? '—'}</td>
                          <td style={{ ...td, color: '#889' }}>{r.prev_date ? String(r.prev_date).slice(0, 10) : '—'}</td>
                          <td style={{ ...td, color: '#889' }}>{r.prev_course ?? '—'}</td>
                          <td style={{ ...td, color: '#889' }}>{r.prev_pos ?? '—'}</td>
                          <td style={{ ...td, color: '#889' }}>{r.prev_dist ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ color: '#999', fontSize: '0.8rem', padding: '6px 0' }}>符合條件賽事：0 場</div>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function AiDataPage() {
  return (
    <div style={{ padding: '24px', maxWidth: 1200, margin: '0 auto' }}>
      <h2 style={{ color: '#032169', marginBottom: 24, borderBottom: '2px solid #032169', paddingBottom: 8 }}>
        數據庫
      </h2>
      <AiDataPanel />
      <hr style={{ border: 'none', borderTop: '1px solid #dde3f0', margin: '8px 0 24px' }} />
      <GearChangesPanel />
      <hr style={{ border: 'none', borderTop: '1px solid #dde3f0', margin: '8px 0 24px' }} />
      <JockeyChangesPanel />
      <hr style={{ border: 'none', borderTop: '1px solid #dde3f0', margin: '8px 0 24px' }} />
      <QuickBackPanel />
      <hr style={{ border: 'none', borderTop: '1px solid #dde3f0', margin: '8px 0 24px' }} />
      <StatsSearchPanel />
      <hr style={{ border: 'none', borderTop: '1px solid #dde3f0', margin: '8px 0 24px' }} />
      <HotFavNextPanel />
      <hr style={{ border: 'none', borderTop: '1px solid #dde3f0', margin: '8px 0 24px' }} />
      <TrainerMonthlyPanel />
    </div>
  );
}
