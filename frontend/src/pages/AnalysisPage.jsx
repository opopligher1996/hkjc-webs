import React, { useState, useEffect } from 'react';
import { getNextRace, getRacecard, getFixtures } from '../api';

const WEIGHT_FIELDS = [
  { key: 'lnOddR', label: 'LnOddR (賠率對數)', step: 0.1 },
  { key: 'runs', label: 'Runs (出賽次數)', step: 0.01 },
  { key: 'jw', label: 'JW (實際負磅)', step: 0.01 },
  { key: 'jwd', label: 'JWD (負磅x途程)', step: 0.0001 },
  { key: 'wratio', label: 'WRatio (負重比例)', step: 0.5 },
  { key: 'wratiod', label: 'WRatioD (比例x途程)', step: 0.001 },
  { key: 'oldearly', label: 'OldEarly (老馬頻密)', step: 0.1 },
  { key: 'barno', label: 'BarNo (檔位)', step: 0.01 },
  { key: 'pastpos', label: 'PastPos (上仗名次)', step: 0.1 },
];

const DEFAULT_WEIGHTS = {
  lnOddR: 1.5, runs: 0.02, jw: -0.05, jwd: -0.0001, wratio: -15.0,
  wratiod: -0.002, oldearly: -2.5, barno: -0.15, pastpos: -0.3,
};

const ROW_FIELDS = [
  { key: 'no', label: '馬號\n(No.)' },
  { key: 'barno', label: '檔位\n(BarNo)' },
  { key: 'odd', label: '獨贏賠率\n(Odd)', step: 0.1 },
  { key: 'jw', label: '實際負磅\n(JW)' },
  { key: 'hw', label: '馬匹體重\n(HW)' },
  { key: 'pastpos', label: '上仗名次\n(PastPos)' },
  { key: 'runs', label: '出賽次數\n(Runs)' },
  { key: 'day', label: '久休日數\n(Day)' },
  { key: 'distance', label: '途程\n(Distance)' },
];

function calcScore(row, W) {
  const v = {};
  ROW_FIELDS.forEach(({ key }) => { v[key] = parseFloat(row[key]) || 0; });
  if (v.odd <= 0 || v.hw <= 0) return null;

  const lnOddR = Math.log(1 / v.odd);
  const wratio = v.jw / v.hw;
  const jwd = v.jw * v.distance;
  const wratiod = wratio * v.distance;
  const oldearly = (v.runs >= 30 && v.day <= 10) ? 1 : 0;

  return (
    (lnOddR * W.lnOddR) +
    (v.runs * W.runs) +
    (v.jw * W.jw) +
    (jwd * W.jwd) +
    (wratio * W.wratio) +
    (wratiod * W.wratiod) +
    (oldearly * W.oldearly) +
    (v.barno * W.barno) +
    (v.pastpos * W.pastpos)
  );
}

// 從近績字串（如 "8/5/3/1"）取最近一仗名次
function parseLastPos(recentForm) {
  const m = String(recentForm || '').match(/^\s*(\d+)/);
  return m ? parseInt(m[1]) : '';
}

export default function AnalysisPage() {
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS);
  const [rows, setRows] = useState([]);

  const [fixtures, setFixtures] = useState([]);
  const [selectedDate, setSelectedDate] = useState('');
  const [raceData, setRaceData] = useState(null);
  const [selectedRace, setSelectedRace] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => { loadInitial(); }, []);

  async function loadInitial() {
    try {
      const [nextRace, fixtureList] = await Promise.all([getNextRace(), getFixtures()]);
      setFixtures(fixtureList);
      const defaultDate =
        (nextRace && nextRace.race_date) ||
        (fixtureList.length > 0 ? fixtureList[0].race_date : null);
      if (defaultDate) {
        setSelectedDate(defaultDate);
        await loadRacecard(defaultDate);
      } else {
        setError('暫無賽期資料，請先在「本地排位表」頁面更新賽期表及排位表。');
        setLoading(false);
      }
    } catch (err) {
      setError('載入排位表失敗：' + err.message);
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
        setSelectedRace(String(data.races[0].race_no));
        importRace(data.races[0]);
      } else {
        setRows([]);
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

  function handleImport() {
    const race = raceData?.races?.find(r => String(r.race_no) === String(selectedRace));
    if (!race) return;
    importRace(race);
  }

  function importRace(race) {
    setRows((race.horses || []).map((h) => ({
      name: h.horse_name || '',
      no: h.horse_no,
      barno: h.draw || '',
      odd: '',
      jw: h.actual_weight || 120,
      hw: h.declared_weight || 1100,
      pastpos: parseLastPos(h.recent_form),
      runs: 10,
      day: 21,
      distance: race.distance || 1200,
    })));
  }

  const setWeight = (key, value) => setWeights((w) => ({ ...w, [key]: value }));
  const setCell = (idx, key, value) =>
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, [key]: value } : r)));
  const removeRow = (idx) => setRows((rs) => rs.filter((_, i) => i !== idx));

  return (
    <div style={{ padding: '24px', maxWidth: 1200, margin: '0 auto' }}>
      <style>{`
        .racing-model-container {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          background-color: #fff;
          box-shadow: 0 0 15px rgba(0,0,0,0.05);
          border-radius: 8px;
          padding: 20px;
        }
        .rm-section-title {
          color: #1F4E78;
          border-bottom: 2px solid #1F4E78;
          padding-bottom: 10px;
          margin-bottom: 20px;
        }
        .rm-weights-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: 15px;
          background-color: #f8f9fa;
          padding: 20px;
          border-radius: 8px;
          margin-bottom: 30px;
        }
        .rm-weight-item { display: flex; flex-direction: column; }
        .rm-weight-item label {
          font-size: 0.9em; font-weight: bold; margin-bottom: 5px; color: #495057;
        }
        .rm-weight-item input {
          padding: 8px; border: 1px solid #dee2e6; border-radius: 4px;
        }
        .rm-table-responsive { overflow-x: auto; }
        .rm-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
        .rm-table th, .rm-table td {
          border: 1px solid #dee2e6; padding: 10px; text-align: center;
        }
        .rm-table th {
          background-color: #1F4E78; color: white; font-size: 0.9em; white-space: nowrap;
        }
        .rm-table td input {
          width: 100%; min-width: 60px; padding: 6px; box-sizing: border-box;
          border: 1px solid #ccc; border-radius: 4px; text-align: center;
        }
        .rm-score-cell { font-weight: bold; font-size: 1.1em; transition: background-color 0.3s, color 0.3s; }
        .rm-btn {
          padding: 10px 20px; color: white; border: none; border-radius: 4px;
          cursor: pointer; font-size: 1em; transition: background-color 0.2s; background-color: #1F4E78;
        }
        .rm-btn:hover { background-color: #153a5b; }
        .rm-btn-green { background-color: #28a745; }
        .rm-btn-green:hover { background-color: #1e7e34; }
        .rm-btn:disabled { background-color: #999; cursor: not-allowed; }
        .rm-controls { margin-bottom: 15px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
        .rm-select {
          padding: 8px; border: 1px solid #dee2e6; border-radius: 4px; background: #fff;
        }
      `}</style>

      <h2 style={{ color: '#032169', marginBottom: 24, borderBottom: '2px solid #032169', paddingBottom: 8 }}>
        分析
      </h2>

      <div className="racing-model-container">
        <h3 className="rm-section-title">⚙️ 模型權重設定 (Model Weights)</h3>
        <div className="rm-weights-grid">
          {WEIGHT_FIELDS.map(({ key, label, step }) => (
            <div key={key} className="rm-weight-item">
              <label>{label}</label>
              <input
                type="number"
                value={weights[key]}
                step={step}
                onChange={(e) => setWeight(key, e.target.value)}
              />
            </div>
          ))}
        </div>

        <h3 className="rm-section-title">🏇 賽事數據與預測 (Race Data & Prediction)</h3>
        <div className="rm-controls">
          <select className="rm-select" value={selectedDate} onChange={handleDateChange}>
            {fixtures.length === 0 && selectedDate && (
              <option value={selectedDate}>{selectedDate}</option>
            )}
            {fixtures.map(f => (
              <option key={f.race_date} value={f.race_date}>
                {f.race_date} ({f.racecourse || 'ST'})
              </option>
            ))}
          </select>
          <select
            className="rm-select"
            value={selectedRace}
            onChange={(e) => setSelectedRace(e.target.value)}
          >
            {(raceData?.races || []).map(r => (
              <option key={r.race_no} value={r.race_no}>
                第{r.race_no}場 {r.race_class || ''} {r.distance ? `${r.distance}米` : ''}
              </option>
            ))}
          </select>
          <button className="rm-btn rm-btn-green" onClick={handleImport} disabled={loading || !selectedRace}>
            {loading ? '載入中...' : '🔄 匯入排位表'}
          </button>
          {loading && <span style={{ fontSize: '0.9em', color: '#555' }}>正在載入排位表...</span>}
          {error && <span style={{ fontSize: '0.9em', color: '#dc3545' }}>{error}</span>}
        </div>

        <div className="rm-table-responsive">
          <table className="rm-table">
            <thead>
              <tr>
                <th>馬名<br />(Name)</th>
                {ROW_FIELDS.map(({ key, label }) => (
                  <th key={key} style={{ whiteSpace: 'pre-line' }}>{label}</th>
                ))}
                <th style={{ backgroundColor: '#375623' }}>預測總分<br />(Score)</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={ROW_FIELDS.length + 3} style={{ color: '#999' }}>
                    暫無數據，請選擇日期及場次後按「匯入排位表」。
                  </td>
                </tr>
              )}
              {rows.map((row, idx) => {
                const score = calcScore(row, weights);
                const scoreStyle = score == null
                  ? { background: 'transparent' }
                  : score > 0
                    ? {
                        background: `rgba(40, 167, 69, ${Math.min(score / 5, 0.5)})`,
                        color: '#00561b',
                      }
                    : {
                        background: `rgba(220, 53, 69, ${Math.min(Math.abs(score) / 5, 0.5)})`,
                        color: '#721c24',
                      };
                return (
                  <tr key={idx}>
                    <td style={{ whiteSpace: 'nowrap', fontSize: '0.85em' }}>{row.name || '-'}</td>
                    {ROW_FIELDS.map(({ key, step }) => (
                      <td key={key}>
                        <input
                          type="number"
                          step={step}
                          value={row[key]}
                          onChange={(e) => setCell(idx, key, e.target.value)}
                        />
                      </td>
                    ))}
                    <td className="rm-score-cell" style={scoreStyle}>
                      {score == null ? '-' : score.toFixed(2)}
                    </td>
                    <td>
                      <button
                        onClick={() => removeRow(idx)}
                        style={{ color: 'red', cursor: 'pointer', background: 'none', border: 'none', fontWeight: 'bold' }}
                      >
                        刪除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
