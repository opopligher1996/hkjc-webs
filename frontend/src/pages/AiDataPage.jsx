import React, { useState, useEffect } from 'react';
import api from '../api';

const GEAR_LABELS = {
  B:   '眼罩 (B)',
  B1:  '半眼罩 (B1)',
  BO:  '開放型眼罩 (BO)',
  CP:  '遮眼布 (CP)',
  E:   '耳塞 (E)',
  H:   '頭罩 (H)',
  P:   '防咬籠 (P)',
  P1:  '鼻箍 (P1)',
  PC:  '後眼罩 (PC)',
  SR:  '舌帶 (SR)',
  TT:  '束舌帶 (TT)',
  V:   'V 型頸罩 (V)',
  V1:  'V1 頸罩 (V1)',
  XB:  '交叉眼罩 (XB)',
};

function gearDisplay(gear) {
  if (!gear) return <span style={{ color: '#999' }}>—</span>;
  return gear;
}

function GearChangeBadge({ current, prev }) {
  if (current === prev) return null;
  if (!prev && current) return <span style={{ background: '#28a745', color: '#fff', borderRadius: 3, padding: '1px 5px', fontSize: '0.7rem', marginLeft: 4 }}>新增</span>;
  if (prev && !current) return <span style={{ background: '#dc3545', color: '#fff', borderRadius: 3, padding: '1px 5px', fontSize: '0.7rem', marginLeft: 4 }}>移除</span>;
  return <span style={{ background: '#fd7e14', color: '#fff', borderRadius: 3, padding: '1px 5px', fontSize: '0.7rem', marginLeft: 4 }}>變動</span>;
}

function GearChangesPanel() {
  const [date, setDate] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showChangedOnly, setShowChangedOnly] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData(d) {
    setLoading(true);
    setError(null);
    try {
      const params = d ? { date: d } : {};
      const res = await api.get('/ai/gear-changes', { params });
      setData(res.data);
      setDate(res.data.date);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }

  function handleDateChange(e) {
    const d = e.target.value;
    setDate(d);
    if (d) fetchData(d);
  }

  const horses = data?.horses || [];
  const filtered = showChangedOnly ? horses.filter(h => h.changed) : horses;
  const changedCount = horses.filter(h => h.changed).length;

  // Group by race
  const byRace = filtered.reduce((acc, h) => {
    if (!acc[h.race_no]) acc[h.race_no] = [];
    acc[h.race_no].push(h);
    return acc;
  }, {});

  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, color: '#032169', fontSize: '1rem' }}>配備變動</h3>
        <input
          type="date"
          value={date}
          onChange={handleDateChange}
          style={{ padding: '4px 8px', border: '1px solid #ccc', borderRadius: 4, fontSize: '0.9rem' }}
        />
        <label style={{ fontSize: '0.85rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={showChangedOnly}
            onChange={e => setShowChangedOnly(e.target.checked)}
          />
          只顯示有變動
        </label>
        {data && (
          <span style={{ fontSize: '0.8rem', color: '#666' }}>
            共 {changedCount} 匹有配備變動 / {horses.length} 匹
          </span>
        )}
      </div>

      {loading && <div style={{ color: '#666', padding: '20px 0' }}>載入中...</div>}
      {error && <div style={{ color: '#dc3545', padding: '8px 12px', background: '#fff5f5', borderRadius: 4 }}>{error}</div>}

      {!loading && !error && data && filtered.length === 0 && (
        <div style={{ color: '#999', padding: '20px 0', textAlign: 'center' }}>
          {showChangedOnly ? '此日期沒有配備變動' : '此日期暫無排位表數據'}
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
                <th style={th}>馬號</th>
                <th style={th}>馬名</th>
                <th style={th}>今次配備</th>
                <th style={th}>上次配備</th>
                <th style={th}>上場日期</th>
                <th style={th}>狀態</th>
              </tr>
            </thead>
            <tbody>
              {raceHorses.map(h => (
                <tr
                  key={h.horse_no}
                  style={{ background: h.changed ? '#fffbe6' : '#fff', borderBottom: '1px solid #eee' }}
                >
                  <td style={td}>{h.horse_no}</td>
                  <td style={{ ...td, fontWeight: h.changed ? 600 : 400 }}>{h.horse_name}</td>
                  <td style={td}>{gearDisplay(h.current_gear)}</td>
                  <td style={td}>{gearDisplay(h.prev_gear)}</td>
                  <td style={{ ...td, color: '#666', fontSize: '0.8rem' }}>
                    {h.prev_race_date ? `${h.prev_race_date} ${h.prev_racecourse || ''}` : '—'}
                  </td>
                  <td style={td}>
                    {h.changed
                      ? <GearChangeBadge current={h.current_gear} prev={h.prev_gear} />
                      : <span style={{ color: '#999', fontSize: '0.8rem' }}>不變</span>
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

const th = {
  padding: '6px 10px',
  textAlign: 'left',
  fontWeight: 600,
  color: '#032169',
  borderBottom: '2px solid #032169',
  whiteSpace: 'nowrap',
};
const td = {
  padding: '6px 10px',
  verticalAlign: 'middle',
};

export default function AiDataPage() {
  return (
    <div style={{ padding: '24px', maxWidth: 1100, margin: '0 auto' }}>
      <h2 style={{ color: '#032169', marginBottom: 24, borderBottom: '2px solid #032169', paddingBottom: 8 }}>
        AI數據
      </h2>
      <GearChangesPanel />
    </div>
  );
}
