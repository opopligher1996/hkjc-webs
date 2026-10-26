import React, { useState, useEffect, useRef } from 'react';
import {
  getNextRace, getFixtures, getAdvancedRacecard,
  updateAdvancedTrackwork, getAdvancedTrackworkStatus, updateDeclaredWeight,
  startSectionalBackfill, getSectionalBackfillStatus,
} from '../api';
import api from '../api';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import * as XLSX from 'xlsx';

const MONTHS = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];

const fmtDiff = (v) => {
  if (v == null) return null;
  return v > 0 ? `+${v}` : `${v}`;
};

const diffColor = (v, invert = false) => {
  if (v == null || v === 0) return '#999';
  const up = invert ? v < 0 : v > 0;
  return up ? '#c0392b' : '#1e7e34';
};

const YesNo = ({ val, yes = '✓', no = '✗' }) => {
  if (val === null || val === undefined) return <span style={{ color: '#bbb' }}>-</span>;
  return <span style={{ color: val ? '#1e7e34' : '#c0392b', fontWeight: 700 }}>{val ? yes : no}</span>;
};

const WPL = ({ stat }) => {
  if (!stat) return <span style={{ color: '#bbb' }}>-</span>;
  return (
    <span>
      <span style={{ color: '#1e7e34', fontWeight: 700 }}>{stat.wins}勝</span>
      <span style={{ color: '#e67e22' }}> {stat.places}上名</span>
      <span style={{ color: '#c0392b' }}> {stat.losses}負</span>
      <span style={{ color: '#999', fontSize: '0.82em' }}> ({stat.total})</span>
    </span>
  );
};

// 排位體重儲存格：點擊即場編輯，Enter/失焦儲存，Esc 取消
function WeightCell({ value, diff, horse, ctx }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const inputRef = useRef(null);

  const startEdit = () => {
    if (saving) return;
    setVal(value ?? '');
    setErr(null);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 30);
  };

  const save = async () => {
    const num = val === '' ? null : Number(val);
    if (num !== null && (!Number.isFinite(num) || num < 700 || num > 1500)) {
      setErr('700-1500');
      return;
    }
    if (num === (value ?? null)) { setEditing(false); return; }
    setSaving(true);
    setErr(null);
    try {
      await updateDeclaredWeight(ctx.date, ctx.raceNo, horse.horse_no, num);
      setEditing(false);
      ctx.reloadSilent();
    } catch (e) {
      setErr(e.response?.data?.error || '失敗');
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="number"
          value={val}
          disabled={saving}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') setEditing(false);
          }}
          onBlur={save}
          style={{ width: 58, padding: '1px 4px', fontSize: '0.78rem' }}
          placeholder="磅數"
        />
        {saving && <span style={{ color: '#888', fontSize: '0.7rem' }}>存…</span>}
        {err && <span style={{ color: '#c0392b', fontSize: '0.7rem' }} title="儲存失敗">{err}</span>}
      </span>
    );
  }

  return (
    <span
      onClick={startEdit}
      title="點擊更新排位體重"
      style={{ cursor: 'pointer', borderBottom: '1px dashed #b8c4d8', paddingBottom: 1 }}
    >
      {value ?? <span style={{ color: '#e67e22' }}>＋</span>}
      {value != null && diff != null && (
        <span style={{ color: diffColor(diff), fontSize: '0.82em', marginLeft: 3 }}>
          ({fmtDiff(diff)})
        </span>
      )}
    </span>
  );
}

const COLUMNS = [
  { key: 'horse_no', label: '馬號', width: 44, sticky: 0 },
  { key: 'horse_name', label: '馬名', width: 100, left: true, sticky: 44 },
  {
    key: 'class_move', label: '升降班', width: 60,
    render: (v) => v
      ? <span style={{ color: v === '升班' ? '#1e7e34' : v === '降班' ? '#c0392b' : '#888', fontWeight: v === '同班' ? 400 : 700 }}>{v}</span>
      : <span style={{ color: '#bbb' }}>-</span>,
  },
  {
    key: 'ace', label: '皇牌', width: 46,
    render: (v, h) => v
      ? <span style={{ color: '#b8860b', fontWeight: 700 }} title={h.note_marker || ''}>皇牌</span>
      : <span style={{ color: '#bbb' }}>-</span>,
  },
  {
    key: 'protected_right', label: '保護權', width: 50,
    render: (v, h) => v
      ? <span style={{ color: '#8e44ad', fontWeight: 700 }} title={h.note_marker || ''}>保護</span>
      : <span style={{ color: '#bbb' }}>-</span>,
  },
  {
    key: 'gear', label: '配備變動', width: 84,
    render: (v, h, openGear) => {
      const changed = h.gear_changed;
      const clickable = changed && h.current_gear;
      return (
        <span
          onClick={clickable ? () => openGear(h) : undefined}
          style={{
            cursor: clickable ? 'pointer' : 'default',
            color: changed ? '#b8860b' : '#777',
            fontWeight: changed ? 700 : 400,
            textDecoration: clickable ? 'underline' : 'none',
            fontSize: '0.82em',
            whiteSpace: 'nowrap',
          }}
          title={clickable ? `點擊查看馬房統計：${h.current_gear} vs ${h.prev_gear || '-'}` : (h.prev_gear ? `上次：${h.prev_gear}` : '首次出賽/無上仗紀錄')}
        >
          {changed ? (h.current_gear ? `變動` : '變動') : (h.current_gear || '-')}
        </span>
      );
    },
  },
  { key: 'draw', label: '檔位', width: 44 },
  { key: 'jockey_name', label: '騎師', width: 76, left: true,
    render: (v, h, openGear, ctx) => {
      const changed = h.prev_jockey && v && h.prev_jockey !== v;
      return changed
        ? <span
            onClick={() => ctx && ctx.openJockeyChange && ctx.openJockeyChange(h)}
            style={{ cursor: 'pointer', color: '#b8860b', fontWeight: 700, textDecoration: 'underline', fontSize: '0.82em' }}
            title={`換騎師：${h.prev_jockey} → ${v}・點擊睇接手統計`}
          >{v} <span style={{ color: '#c0392b' }}>⇄</span></span>
        : (v || <span style={{ color: '#bbb' }}>-</span>);
    },
  },
  {
    key: 'weight', label: '負磅', width: 74,
    render: (v, h) => (
      <span>
        {v ?? '-'}
        {h.weight_diff != null && (
          <span style={{ color: diffColor(h.weight_diff), fontSize: '0.82em', display: 'inline-block', marginLeft: 3 }}>
            ({fmtDiff(h.weight_diff)})
          </span>
        )}
      </span>
    ),
  },
  { key: 'trainer_name', label: '練馬師', width: 76 },
  {
    key: 'stable_move', label: '轉馬房初出', width: 70,
    render: (v) => v
      ? <span style={{ color: '#c0392b', fontWeight: 700 }}>{v}</span>
      : <span style={{ color: '#bbb' }}>-</span>,
  },
  {
    key: 'rating', label: '評分', width: 70,
    render: (v, h) => (
      <span>
        {v ?? '-'}
        {h.rating_change != null && h.rating_change !== '' && h.rating_change !== '0' && (
          <span style={{ color: diffColor(parseInt(h.rating_change) || 0), fontSize: '0.82em', marginLeft: 3 }}>
            ({h.rating_change})
          </span>
        )}
      </span>
    ),
  },
  { key: 'age', label: '歲數', width: 44 },
  {
    key: 'declared_weight', label: '排位體重', width: 96,
    render: (v, h, openGear, ctx) => (
      <WeightCell value={v} diff={h.declared_weight_diff} horse={h} ctx={ctx} />
    ),
  },
  {
    key: 'prev_pos', label: '上仗名次', width: 62,
    render: (v, h) => v == null
      ? <span style={{ color: '#bbb' }}>首出</span>
      : <span style={{ fontWeight: 700, color: v === 1 ? '#1e7e34' : v <= 3 ? '#e67e22' : (v > 6 ? '#999' : '#333') }}>
          {v}{h.prev_runners ? `/${h.prev_runners}` : ''}
        </span>,
  },
  { key: 'prev_jockey', label: '上仗騎師', width: 76 },
  {
    key: 'prev_ground', label: '上仗場地', width: 56,
    render: (v) => v
      ? <span style={{ fontWeight: 600, color: v === '泥地' ? '#8B4513' : v === '谷草' ? '#1e7e34' : '#032169' }}>{v}</span>
      : <span style={{ color: '#bbb' }}>-</span>,
  },
  {
    key: 'prev_distance', label: '上仗路程', width: 56,
    render: (v) => v ? `${v}m` : <span style={{ color: '#bbb' }}>-</span>,
  },
  {
    key: 'dist_change', label: '增/減程', width: 62,
    render: (v) => {
      if (v == null) return <span style={{ color: '#bbb' }}>-</span>;
      if (v === 0) return <span style={{ color: '#888' }}>同程</span>;
      return <span style={{ color: v > 0 ? '#1e7e34' : '#c0392b', fontWeight: 700 }}>{v > 0 ? `＋${v}` : v}</span>;
    },
  },
  {
    key: 'fastest_final_same', label: '同場同程最快末段', width: 104,
    render: (v) => v
      ? (
        <span
          style={{ fontWeight: 700, color: '#032169' }}
          title={`${v.date} ${v.course} ${v.dist}m 末段 ${v.time.toFixed(2)}${v.pos != null ? `（該仗第 ${v.pos} 名）` : ''}${v.rank != null ? `，末段 ${v.rank}/${v.runners}` : ''}\n同馬場同路程歷史最快末段`}
        >
          {v.time.toFixed(2)}{v.rank != null ? ` (${v.rank}/${v.runners})` : ''}
        </span>
      )
      : <span style={{ color: '#bbb' }}>—</span>,
  },
  {
    key: 'fastest_final', label: '最快末段', width: 88,
    render: (v) => v
      ? (
        <span
          style={{ fontWeight: 700, color: '#1e7e34' }}
          title={`${v.date} ${v.course} ${v.dist}m 末段 ${v.time.toFixed(2)}${v.pos != null ? `（該仗第 ${v.pos} 名）` : ''}${v.rank != null ? `，末段 ${v.rank}/${v.runners}` : ''}\n歷史（任何路程）最快末段`}
        >
          {v.time.toFixed(2)}{v.rank != null ? ` (${v.rank}/${v.runners})` : ''}
        </span>
      )
      : <span style={{ color: '#bbb' }}>—</span>,
  },
  {
    key: 'prev_odds', label: '上仗賠率', width: 62,
    render: (v) => v == null ? <span style={{ color: '#bbb' }}>-</span> : v,
  },
  {
    key: 'prev_fav', label: '上仗大熱', width: 62,
    render: (v) => <YesNo val={v} />,
  },
  {
    key: 'trial', label: '賽前試閘', width: 74,
    render: (v) => v
      ? (
        <a
          href={v.link} target="_blank" rel="noreferrer"
          style={{ color: '#8e44ad', fontWeight: 600 }}
          title={`${v.date}（距今仗 ${v.days} 日）${v.count > 1 ? `，期間共 ${v.count} 次試閘` : ''}\n${v.details}`}
        >
          {v.days}日前{v.count > 1 ? ` ×${v.count}` : ''}
        </a>
      )
      : <span style={{ color: '#bbb' }}>-</span>,
  },
  {
    key: 'jockey_rode', label: '騎師親試', width: 74,
    render: (v) => {
      if (v == null) return <span style={{ color: '#bbb' }}>-</span>;
      if (v === false) return <span style={{ color: '#c0392b', fontWeight: 700 }} title="有晨操紀錄，但今仗騎師冇親自操過">✗</span>;
      return (
        <a
          href={v.link} target="_blank" rel="noreferrer"
          style={{ color: '#1e7e34', fontWeight: 600 }}
          title={`${v.type} ${v.date}（距今仗 ${v.days} 日）\n${v.details}`}
        >
          {v.days}日前
        </a>
      );
    },
  },
  {
    key: 'first_ride', label: '首度策騎', width: 62,
    render: (v) => <YesNo val={v} />,
  },
  {
    key: 'vd_all', label: '同場同程歷季', width: 96,
    render: (v) => <WPL stat={v} />,
  },
  {
    key: 'vd_season', label: '同場同程今季', width: 96,
    render: (v) => <WPL stat={v} />,
  },
  {
    key: 'jt_season', label: '騎練今季合作', width: 96,
    render: (v, h, openGear, ctx) => v
      ? (
        <span
          style={{ cursor: 'pointer', borderBottom: '1px dotted #99a8c4' }}
          title="點擊查看騎練今季合作詳細數據"
          onClick={() => ctx.openJt({
            jockey_id: h.jockey_id, jockey_name: h.jockey_name,
            trainer_id: h.trainer_id, trainer_name: h.trainer_name,
            scope: 'season',
          })}
        >
          <span style={{ fontWeight: 700, color: '#032169' }}>{v.wins}勝</span>
          <span>/{v.total}</span>
          {v.total > 0 && <span style={{ color: '#888', fontSize: '0.82em' }}> ({((v.wins / v.total) * 100).toFixed(0)}%/{((v.places / v.total) * 100).toFixed(0)}%)</span>}
        </span>
      )
      : <span style={{ color: '#bbb' }}>-</span>,
  },
  {
    key: 'jt_all', label: '騎練近三季合作', width: 100,
    render: (v, h, openGear, ctx) => v
      ? (
        <span
          style={{ cursor: 'pointer', borderBottom: '1px dotted #99a8c4' }}
          title="點擊查看騎練近三季合作詳細數據"
          onClick={() => ctx.openJt({
            jockey_id: h.jockey_id, jockey_name: h.jockey_name,
            trainer_id: h.trainer_id, trainer_name: h.trainer_name,
            scope: 'all',
          })}
        >
          <span style={{ fontWeight: 700, color: '#8e44ad' }}>{v.wins}勝</span>
          <span>/{v.total}</span>
          {v.total > 0 && <span style={{ color: '#888', fontSize: '0.82em' }}> ({((v.wins / v.total) * 100).toFixed(0)}%/{((v.places / v.total) * 100).toFixed(0)}%)</span>}
        </span>
      )
      : <span style={{ color: '#bbb' }}>-</span>,
  },
];


// ── 換騎師統計彈窗（含同練馬師數據）──
function JockeyChangeModal({ horse, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.get('/ai/stats-jockey-handoff', {
      params: {
        from_id: horse.prev_jockey_id || '',
        to_id: horse.jockey_id || '',
        trainer: horse.trainer_name || '',
      },
    })
      .then(r => { if (!cancelled) { setData(r.data); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [horse]);

  const StatLine = ({ label, d, color }) => (
    <span style={{ fontSize: '0.85rem' }}>
      {label}：<strong style={{ color }}>{d && d.total > 0 ? `${d.win_rate}（${d.wins}/${d.total}）` : '冇記錄'}</strong>
      <span style={{ color: '#888', marginLeft: 6 }}>{d && d.total > 0 ? `位率 ${d.place_rate}` : ''}</span>
    </span>
  );
  const RecentTable = ({ recent }) => (
    <table style={{ borderCollapse: 'collapse', fontSize: '0.8rem', marginTop: 6, minWidth: 420 }}>
      <thead>
        <tr style={{ background: '#e8eef8' }}>
          {['日期','場次','馬名','馬場','賠率','名次'].map(h => (
            <th key={h} style={{ padding: '3px 8px', textAlign: h === '馬名' ? 'left' : 'center', color: '#032169', borderBottom: '1px solid #c0cce8' }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {recent.map((r, i) => {
          const isWin = r.finish_position === 1;
          const isPlace = r.finish_position <= 3;
          return (
            <tr key={i} style={{ background: i % 2 ? '#f0f4ff' : '#fff' }}>
              <td style={{ padding: '3px 8px', textAlign: 'center' }}>{r.race_date}</td>
              <td style={{ padding: '3px 8px', textAlign: 'center' }}>R{r.race_no}</td>
              <td style={{ padding: '3px 8px' }}>{r.horse_name}</td>
              <td style={{ padding: '3px 8px', textAlign: 'center' }}>{r.racecourse}</td>
              <td style={{ padding: '3px 8px', textAlign: 'center', color: '#888' }}>{r.win_odds != null ? r.win_odds : '—'}</td>
              <td style={{ padding: '3px 8px', textAlign: 'center', fontWeight: isWin ? 700 : 400, color: isWin ? '#28a745' : isPlace ? '#007bff' : '#333' }}>{r.finish_position ?? '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <div onClick={onClose} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '60px 20px', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, maxWidth: 860, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,0.3)', padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, color: '#032169', fontSize: '1.05rem' }}>
            換騎師統計<span style={{ fontWeight: 400, color: '#888', fontSize: '0.85rem', marginLeft: 8 }}>{horse.horse_name}・{horse.trainer_name}</span>
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '1.3rem', cursor: 'pointer', color: '#666', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ background: '#fffbe6', border: '1px solid #e6d47e', borderRadius: 6, padding: '8px 12px', marginBottom: 14, fontSize: '0.95rem' }}>
          <b>{horse.prev_jockey}</b> <span style={{ color: '#c0392b', fontWeight: 900 }}>⇄</span> <b>{horse.jockey_name}</b>
          <span style={{ color: '#888', marginLeft: 10, fontSize: '0.85rem' }}>上仗：{horse.prev_race_date || '—'} {horse.prev_pos ? horse.prev_pos + '位' : ''}</span>
        </div>
        {loading && <div style={{ color: '#999', padding: 10 }}>載入中…</div>}
        {error && <div style={{ color: '#dc3545', padding: 10 }}>{error}</div>}
        {data && (
          <>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 14 }}>
              <StatLine label="全部接手" d={data} color="#032169" />
              {data.same_trainer && data.same_trainer.total > 0 && (
                <StatLine label={`同馬房（${horse.trainer_name}）`} d={data.same_trainer} color="#145a23" />
              )}
            </div>
            {data.recent && data.recent.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700, fontSize: '0.85rem', color: '#032169', marginBottom: 4 }}>近期接手記錄</div>
                <RecentTable recent={data.recent} />
              </div>
            )}
            {data.same_trainer && data.same_trainer.recent && data.same_trainer.recent.length > 0 && (
              <div>
                <div style={{ fontWeight: 700, fontSize: '0.85rem', color: '#145a23', marginBottom: 4 }}>同馬房接手記錄（{horse.trainer_name}）</div>
                <RecentTable recent={data.same_trainer.recent} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function GearStatsModal({ horse, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.get('/ai/gear-change-trainer-stats', {
      params: {
        trainer_name: horse.trainer_name,
        current_gear: horse.current_gear,
        prev_gear: horse.prev_gear,
      },
    })
      .then(r => { if (!cancelled) { setData(r.data); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [horse]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.45)', zIndex: 1000,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '60px 20px', overflowY: 'auto',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 10, maxWidth: 860, width: '100%',
          boxShadow: '0 10px 40px rgba(0,0,0,0.3)', padding: 20,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, color: '#032169', fontSize: '1.05rem' }}>
            馬房同配備變動統計<span style={{ fontWeight: 400, color: '#888', fontSize: '0.85rem', marginLeft: 8 }}>{horse.trainer_name}</span>
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '1.3rem', cursor: 'pointer', color: '#666', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: '0.85rem', color: '#555', marginBottom: 12, background: '#f6f8ff', padding: '8px 12px', borderRadius: 6 }}>
          {horse.horse_name}：<b>{horse.current_gear || '-'}</b>（今仗） vs <b>{horse.prev_gear || '首次出賽'}</b>（上仗）
        </div>

        {loading && <div style={{ color: '#888', padding: '20px 0', textAlign: 'center' }}>載入馬房統計...</div>}
        {error && <div style={{ color: '#dc3545', padding: '12px', background: '#fff5f5', borderRadius: 6 }}>{error}</div>}
        {!loading && !error && (!data?.stats?.length) && (
          <div style={{ color: '#999', padding: '16px 0', textAlign: 'center' }}>
            {data?.trainer_name ? '此馬房近三季無相應配備變動記錄' : '未能取得統計'}
          </div>
        )}
        {!loading && data?.stats?.map(stat => (
          <div key={stat.label} style={{ border: '1px solid #e8eef8', borderRadius: 8, marginBottom: 12, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: stat.type === 'added' ? '#fffbe6' : '#f0f4ff', borderBottom: '1px solid #eee' }}>
              <span style={{ fontWeight: 800, fontSize: '0.95rem', color: stat.type === 'added' ? '#b8860b' : '#c0392b' }}>{stat.label}</span>
              <span style={{ color: '#555', fontSize: '0.85rem' }}>共 {stat.total} 次</span>
              <span style={{ color: '#1e7e34', fontSize: '0.85rem' }}>勝 {stat.wins}（{stat.win_rate}）</span>
              <span style={{ color: '#e67e22', fontSize: '0.85rem' }}>上名 {stat.places}（{stat.place_rate}）</span>
            </div>
            {stat.records.length > 0 && (
              <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
                  <thead>
                    <tr>
                      {['日期', '場次', '組別', '馬名', '配備前', '配備後', '名次'].map(hh => (
                        <th key={hh} style={{ padding: '3px 8px', textAlign: 'left', color: '#555', background: '#f5f5f5', borderBottom: '1px solid #ddd' }}>{hh}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {stat.records.map((r, i) => (
                      <tr key={i} style={{ background: r.finish_position === 1 ? '#f0fff4' : r.finish_position <= 3 ? '#fff8e1' : '#fff', borderBottom: '1px solid #f0f0f0' }}>
                        <td style={{ padding: '3px 8px' }}>{r.race_date}</td>
                        <td style={{ padding: '3px 8px' }}>第{r.race_no}場 {r.racecourse}</td>
                        <td style={{ padding: '3px 8px' }}>{r.race_class || '—'}</td>
                        <td style={{ padding: '3px 8px' }}>{r.horse_name}</td>
                        <td style={{ padding: '3px 8px', color: '#888' }}>{r.prev_gear || '—'}</td>
                        <td style={{ padding: '3px 8px', color: '#888' }}>{r.curr_gear || '—'}</td>
                        <td style={{ padding: '3px 8px', fontWeight: 700, color: r.finish_position === 1 ? '#1e7e34' : r.finish_position <= 3 ? '#e67e22' : '#333' }}>
                          {r.finish_position ?? '—'}{r.total_runners ? `/${r.total_runners}` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// 騎練合作詳情彈窗（scope: 'season' 今季 / 'all' 近三季）
function JTModal({ info, seasonSince, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const isAll = info.scope === 'all';
  // 近三季 = 今季起倒推三季（sstart 年份 − 2 嘅 9 月 1 日）
  const since = isAll
    ? (seasonSince ? `${Number(seasonSince.slice(0, 4)) - 2}-09-01` : '2024-09-01')
    : (seasonSince || '2024-09-01');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get('/races/advanced/jt', {
      params: { jockey_id: info.jockey_id, trainer_id: info.trainer_id, since },
    })
      .then(r => { if (!cancelled) { setData(r.data); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [info, since]);

  const s = data?.summary;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.45)', zIndex: 1000,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '60px 20px', overflowY: 'auto',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 10, maxWidth: 720, width: '100%',
          boxShadow: '0 10px 40px rgba(0,0,0,0.3)', padding: 20,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, color: '#032169', fontSize: '1.05rem' }}>
            騎練{isAll ? '近三季' : '今季'}合作詳細數據
            <span style={{ fontWeight: 400, color: '#888', fontSize: '0.85rem', marginLeft: 8 }}>
              {info.jockey_name} × {info.trainer_name}（{isAll ? `近三季自 ${since}` : `${since?.slice(0, 4)}季起`}{data?.summary ? `，共 ${data.summary.total} 次` : ''}）
            </span>
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '1.3rem', cursor: 'pointer', color: '#666', lineHeight: 1 }}>×</button>
        </div>

        {loading && <div style={{ color: '#888', padding: '20px 0', textAlign: 'center' }}>載入中...</div>}
        {error && <div style={{ color: '#dc3545', padding: '12px', background: '#fff5f5', borderRadius: 6 }}>{error}</div>}

        {!loading && !error && s && (
          <>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', background: '#f6f8ff', padding: '10px 14px', borderRadius: 6, marginBottom: 12, fontSize: '0.9rem' }}>
              <span>共 <b>{s.total}</b> 次</span>
              <span style={{ color: '#1e7e34', fontWeight: 700 }}>{s.wins} 冠</span>
              <span style={{ color: '#e67e22', fontWeight: 700 }}>{s.seconds} 亞</span>
              <span style={{ color: '#b8860b', fontWeight: 700 }}>{s.thirds} 季</span>
              <span>三甲率 <b>{s.total ? ((s.places / s.total) * 100).toFixed(1) : 0}%</b></span>
              <span>勝率 <b>{s.total ? ((s.wins / s.total) * 100).toFixed(1) : 0}%</b></span>
            </div>

            {data.records.length === 0 && (
              <div style={{ color: '#999', padding: '16px 0', textAlign: 'center' }}>今季暫無合作紀錄</div>
            )}

            {data.records.length > 0 && (
              <div style={{ maxHeight: 380, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                  <thead>
                    <tr>
                      {['日期', '場', '班/路程', '馬名', '名次', '賠率'].map(hh => (
                        <th key={hh} style={{ padding: '5px 8px', textAlign: 'left', color: '#fff', background: '#032169', position: 'sticky', top: 0 }}>{hh}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.records.map((r, i) => (
                      <tr key={i} style={{ background: r.finish_position === 1 ? '#f0fff4' : r.finish_position <= 3 ? '#fff8e1' : i % 2 ? '#fafbff' : '#fff', borderBottom: '1px solid #f0f0f0' }}>
                        <td style={{ padding: '4px 8px' }}>{r.race_date}</td>
                        <td style={{ padding: '4px 8px' }}>{r.racecourse}</td>
                        <td style={{ padding: '4px 8px', color: '#666' }}>{r.race_class || '—'} / {r.distance}m</td>
                        <td style={{ padding: '4px 8px', fontWeight: 600 }}>{r.horse_name}</td>
                        <td style={{ padding: '4px 8px', fontWeight: 700, color: r.finish_position === 1 ? '#1e7e34' : r.finish_position <= 3 ? '#e67e22' : '#333' }}>
                          {r.finish_position}{r.total_runners ? `/${r.total_runners}` : ''}
                        </td>
                        <td style={{ padding: '4px 8px', color: '#666' }}>{r.win_odds ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── PDF 匯出 ──────────────────────────────────────────────────────────────
// 每場一頁（A4 橫向）：將該場完整表格以 html2canvas 截圖放入 jsPDF，
// 中文由瀏覽器渲染，唔需要嵌入字型。
const pdfVal = (h, key) => {
  const v = h[key];
  const dash = '-';
  switch (key) {
    case 'class_move': return v || dash;
    case 'ace': return v ? '皇牌' : dash;
    case 'protected_right': return v ? '保護' : dash;
    case 'gear': return `${h.current_gear || dash}${h.gear_changed ? ' ★' : ''}`;
    case 'draw':
    case 'age':
    case 'jockey_name':
    case 'trainer_name':
    case 'stable_move':
    case 'prev_jockey':
      return v ?? dash;
    case 'weight':
      return `${v ?? dash}${h.weight_diff != null ? ` (${h.weight_diff > 0 ? '+' : ''}${h.weight_diff})` : ''}`;
    case 'rating':
      return `${v ?? dash}${h.rating_change != null && h.rating_change !== '' && h.rating_change !== '0' ? ` (${h.rating_change})` : ''}`;
    case 'declared_weight':
      return `${v ?? dash}${h.declared_weight_diff != null ? ` (${h.declared_weight_diff > 0 ? '+' : ''}${h.declared_weight_diff})` : ''}`;
    case 'prev_pos':
      return v == null ? '首出' : `${v}${h.prev_runners ? `/${h.prev_runners}` : ''}`;
    case 'prev_ground': return v || dash;
    case 'prev_distance': return v != null ? `${v}m` : dash;
    case 'dist_change':
      if (v == null) return dash;
      if (v === 0) return '同程';
      return v > 0 ? `＋${v}` : `${v}`;
    case 'fastest_final_same':
    case 'fastest_final':
      return v ? `${v.time.toFixed(2)}${v.rank != null ? ` (${v.rank}/${v.runners})` : ''}` : dash;
    case 'prev_odds': return v ?? dash;
    case 'prev_fav':
      return v == null ? dash : (v ? '是' : '否');
    case 'trial':
      return v ? `${v.days}日前${v.count > 1 ? ` ×${v.count}` : ''}` : dash;
    case 'jockey_rode':
      if (v == null) return dash;
      if (v === false) return '✗';
      return `${v.days}日前`;
    case 'first_ride':
      return v == null ? dash : (v ? '是' : '否');
    case 'vd_all':
    case 'vd_season':
      return v ? `${v.wins}勝${v.places}位${v.losses}負 (${v.total})` : dash;
    case 'jt_season':
    case 'jt_all':
      return v ? `${v.wins}勝/${v.total}` : dash;
    default:
      return v == null ? dash : String(v);
  }
};

// PDF 欄位分組：26 欄一張表太闊（縮到 A4 之後字太細兼有機會被裁），
// 拆成兩組，每組都重複馬號/馬名，每組一頁 → 字大一倍、內容全部見到。
const PDF_GROUPS = [
  {
    title: '基本／負磅',
    keys: [
      'horse_no', 'horse_name', 'class_move', 'ace', 'protected_right', 'gear',
      'draw', 'jockey_name', 'trainer_name', 'stable_move', 'weight', 'rating',
      'age', 'declared_weight',
    ],
  },
  {
    title: '上仗／末段／統計',
    keys: [
      'horse_no', 'horse_name', 'prev_pos', 'prev_jockey', 'prev_ground',
      'prev_distance', 'dist_change', 'fastest_final_same', 'fastest_final',
      'prev_odds', 'prev_fav', 'trial', 'jockey_rode', 'first_ride',
      'vd_all', 'vd_season', 'jt_season', 'jt_all',
    ],
  },
];

function buildRacePDFHtml(race, date, group) {
  const track = race.track_type === 'TURF' ? '草地' : race.track_type === 'AWT' ? '全天候' : (race.track_type || '');
  const head =
    `高級排位表 ${date} · 第 ${race.race_no} 場 · ${race.race_class || ''} · ` +
    `${race.racecourse || ''} ${race.distance}米 · ${track}${race.going ? ` · ${race.going}` : ''} · ${race.horses.length} 匹 · ${group.title}`;
  const cols = COLUMNS.filter(c => group.keys.includes(c.key));
  const ths = cols.map(c => `<th>${c.label}</th>`).join('');
  const trs = race.horses
    .map(h => `<tr>${cols.map(c => `<td class="${c.left ? 'l' : 'c'}">${pdfVal(h, c.key)}</td>`).join('')}</tr>`)
    .join('');
  return `
  <style>
    .rc { font: 700 30px/1.4 "PingFang TC","Microsoft JhengHei",sans-serif; color:#032169;
          padding: 12px 10px 14px; white-space: nowrap; }
    table { border-collapse: collapse; font: 26px/1.35 "PingFang TC","Microsoft JhengHei",sans-serif; }
    th { background:#032169; color:#fff; padding: 10px 14px; white-space:nowrap; font-weight:600; }
    td { border: 1px solid #dfe5ee; padding: 9px 14px; white-space:nowrap; }
    td.l { text-align:left; } td.c { text-align:center; }
    tbody tr:nth-child(even) { background:#f6f8ff; }
  </style>
  <div class="rc">${head}</div>
  <table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}

async function exportAdvancedPDF(raceData, scope, selectedRace) {
  const races = scope === 'race'
    ? raceData.races.filter(r => r.race_no === selectedRace)
    : raceData.races;
  if (!races.length) throw new Error('沒有可匯出的場次');

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const W = 297, H = 210;

  // 隱藏容器（畫面外）逐場逐欄組渲染 → 截圖 → 加一頁。
  // 關鍵：唔鎖死容器闊度，用 scrollWidth 量返實際內容闊，
  // 避免 nowrap 表格超出固定闊度而被 html2canvas 裁走右邊。
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-20000px;top:0;background:#fff;';
  document.body.appendChild(holder);

  try {
    let first = true;
    for (const race of races) {
      for (const group of PDF_GROUPS) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:inline-block;background:#fff;padding:8px;';
        wrap.innerHTML = buildRacePDFHtml(race, raceData.date, group);
        holder.appendChild(wrap);
        await new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok)));
        // 量實際闊度，確保截圖涵蓋全部欄位
        const realW = Math.max(wrap.scrollWidth, wrap.offsetWidth);
        const realH = Math.max(wrap.scrollHeight, wrap.offsetHeight);
        wrap.style.width = `${realW}px`;
        wrap.style.height = `${realH}px`;
        await new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok)));

        const canvas = await html2canvas(wrap, { scale: 2, backgroundColor: '#ffffff' });
        holder.removeChild(wrap);
        if (!first) doc.addPage();
        first = false;

        let iw = W - 8;
        let ih = iw * canvas.height / canvas.width;
        if (ih > H - 8) { ih = H - 8; iw = ih * canvas.width / canvas.height; }
        doc.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', (W - iw) / 2, (H - ih) / 2, iw, ih);
      }
    }
  } finally {
    document.body.removeChild(holder);
  }

  doc.save(`高級排位表_${raceData.date}${scope === 'race' ? `_第${selectedRace}場` : ''}.pdf`);
}

// ── Excel 匯出（SheetJS）──────────────────────────────────────────────────
// 本場 = 一個 sheet；全日 = 每場一個 sheet（sheet 名：第1場、第2場…）
function exportAdvancedExcel(raceData, scope, selectedRace) {
  const races = scope === 'race'
    ? raceData.races.filter(r => r.race_no === selectedRace)
    : raceData.races;
  if (!races.length) throw new Error('沒有可匯出的場次');

  const wb = XLSX.utils.book_new();
  const header = COLUMNS.map(c => c.label);

  for (const race of races) {
    const aoa = [
      [`高級排位表 ${raceData.date} 第 ${race.race_no} 場 ${race.race_class || ''} ${race.racecourse || ''} ${race.distance}米 ${race.horses.length} 匹`],
      [],
      header,
      ...race.horses.map(h => COLUMNS.map(c => pdfVal(h, c.key))),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = COLUMNS.map(c => ({ wch: Math.max(6, Math.ceil(c.width / 8)) }));
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }];
    XLSX.utils.book_append_sheet(wb, ws, `第${race.race_no}場`);
  }

  XLSX.writeFile(wb, `高級排位表_${raceData.date}${scope === 'race' ? `_第${selectedRace}場` : ''}.xlsx`);
}

export default function AdvancedRacecardPage() {
  const [fixtures, setFixtures] = useState([]);
  const [selectedDate, setSelectedDate] = useState('');
  const [raceData, setRaceData] = useState(null);
  const [selectedRace, setSelectedRace] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [gearModal, setGearModal] = useState(null);
  const [jockeyChangeModal, setJockeyChangeModal] = useState(null);
  const [jtModal, setJtModal] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  function handleExport(scope, format) {
    if (!raceData?.races?.length || pdfBusy) return;
    setPdfBusy(true);
    setError(null);
    Promise.resolve()
      .then(() => (format === 'pdf'
        ? exportAdvancedPDF(raceData, scope, selectedRace)
        : exportAdvancedExcel(raceData, scope, selectedRace)))
      .catch(e => setError(`${format === 'pdf' ? 'PDF' : 'Excel'} 產生失敗：` + e.message))
      .finally(() => setPdfBusy(false));
  }

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
      setError('載入高級排位表失敗：' + err.message);
      setLoading(false);
    }
  }

  async function loadRacecard(date, opts = {}) {
    if (!opts.silent) { setLoading(true); setError(null); }
    try {
      const data = await getAdvancedRacecard(date);
      setRaceData(data);
      setSelectedRace(prev =>
        data.races?.some(r => r.race_no === prev) ? prev : (data.races?.[0]?.race_no ?? null)
      );
    } catch (err) {
      if (!opts.silent) setError('載入高級排位表失敗：' + err.message);
    } finally {
      if (!opts.silent) setLoading(false);
    }
  }

  function handleDateChange(e) {
    const date = e.target.value;
    setSelectedDate(date);
    loadRacecard(date);
  }

  // ── 晨操紀錄批量更新（賽前試閘 / 騎師親試）──
  const [tw, setTw] = useState(null);

  useEffect(() => {
    getAdvancedTrackworkStatus().then(setTw).catch(() => {});
  }, []);

  // 進行中每 3 秒輪詢；完成後寧靜刷新排位表
  useEffect(() => {
    if (!tw?.active) return undefined;
    const t = setInterval(async () => {
      try {
        const s = await getAdvancedTrackworkStatus();
        setTw(s);
        if (!s.active) loadRacecard(s.date || selectedDate, { silent: true });
      } catch (_) { /* 忽略單次失敗 */ }
    }, 3000);
    return () => clearInterval(t);
  }, [tw && tw.active]);

  // ── 分段時間回補（同程最快末段 / 最快末段）──
  const [sb, setSb] = useState(null);

  useEffect(() => {
    getSectionalBackfillStatus().then(setSb).catch(() => {});
  }, []);

  useEffect(() => {
    if (!sb?.active) return undefined;
    const t = setInterval(async () => {
      try {
        const s = await getSectionalBackfillStatus();
        setSb(s);
        if (!s.active) loadRacecard(s.date || selectedDate, { silent: true });
      } catch (_) { /* 忽略單次失敗 */ }
    }, 5000);
    return () => clearInterval(t);
  }, [sb && sb.active]);

  async function startSectional() {
    setError(null);
    try {
      const r = await startSectionalBackfill(selectedDate);
      if (!r.total) {
        setError(null);
        loadRacecard(selectedDate, { silent: true });
        return;
      }
      setSb(await getSectionalBackfillStatus());
    } catch (e) {
      const msg = e.response?.data?.message || e.response?.data?.error || e.message;
      setError('分段時間回補啟動失敗：' + msg);
    }
  }

  async function startTrackwork(allDay) {
    setError(null);
    try {
      await updateAdvancedTrackwork(selectedDate, allDay ? null : selectedRace);
      setTw(await getAdvancedTrackworkStatus());
    } catch (e) {
      const msg = e.response?.data?.message || e.response?.data?.error || e.message;
      setError('晨操抓取啟動失敗：' + msg);
    }
  }

  const currentRace = raceData?.races?.find(r => r.race_no === selectedRace);

  return (
    <div>
      <h1 className="page-title">高級排位表</h1>

      <div className="filters">
        <div className="filter-group">
          <label>選擇賽事日期</label>
          <select value={selectedDate} onChange={handleDateChange}>
            {fixtures.length === 0 && selectedDate && <option value={selectedDate}>{selectedDate}</option>}
            {fixtures.map(f => (
              <option key={f.race_date} value={f.race_date}>
                {f.race_date} ({f.racecourse || 'ST'})
              </option>
            ))}
          </select>
        </div>
        <div style={{ alignSelf: 'center', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn"
            onClick={() => handleExport('race', 'pdf')}
            disabled={pdfBusy || !currentRace}
            title="輸出目前顯示嗰場為 PDF（A4 橫向，每場分兩欄組、每組一頁）"
          >
            {pdfBusy ? '產生中…' : '輸出本場 PDF'}
          </button>
          <button
            className="btn"
            onClick={() => handleExport('day', 'pdf')}
            disabled={pdfBusy || !raceData?.races?.length}
            title="輸出全日所有場次為 PDF"
          >
            {pdfBusy ? '…' : '輸出全日 PDF'}
          </button>
          <button
            className="btn"
            onClick={() => handleExport('race', 'excel')}
            disabled={pdfBusy || !currentRace}
            title="輸出目前顯示嗰場為 Excel（.xlsx）"
          >
            輸出本場 Excel
          </button>
          <button
            className="btn"
            onClick={() => handleExport('day', 'excel')}
            disabled={pdfBusy || !raceData?.races?.length}
            title="輸出全日所有場次為 Excel（每場一個工作表）"
          >
            輸出全日 Excel
          </button>
        </div>
        <div style={{ alignSelf: 'center', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn"
            onClick={() => startTrackwork(false)}
            disabled={tw?.active || !selectedRace}
            title={`只抓取第 ${selectedRace ?? '-'} 場馬匹嘅晨操紀錄`}
          >
            {tw?.active ? '抓取中…' : '更新本場晨操'}
          </button>
          <button
            className="btn"
            onClick={() => startTrackwork(true)}
            disabled={tw?.active}
            title="抓取全日排位表馬匹嘅晨操紀錄（約 3-5 分鐘）"
          >
            更新全日晨操
          </button>
          <button
            className="btn"
            onClick={startSectional}
            disabled={sb?.active}
            title="補抓排位表馬匹過往出賽嘅分段時間（計最快末段用，約 10-30 分鐘）"
          >
            {sb?.active ? '回補中…' : '補抓分段時間'}
          </button>
          {sb?.active && (
            <span style={{ fontSize: '0.8rem', color: '#032169' }}>
              {sb.done}/{sb.total} 場 · {sb.current || ''}
            </span>
          )}
          {tw?.active && (
            <span style={{ fontSize: '0.8rem', color: '#032169' }}>
              {tw.done}/{tw.total} · {tw.current || ''}
            </span>
          )}
          {!tw?.active && tw?.finishedAt && tw.date === selectedDate && (
            <span style={{ fontSize: '0.78rem', color: '#888' }} title={`上次完成：${tw.finishedAt}`}>
              晨操已更新（{tw.total} 匹）
            </span>
          )}
        </div>
        <div style={{ alignSelf: 'center', fontSize: '0.82rem', color: '#888' }}>
          點擊「配備變動」文字可查看同馬房同配備變動統計；點擊排位體重可即場更新
        </div>
      </div>

      {loading && <div className="loading">載入高級排位表中...</div>}
      {error && <div className="error">{error}</div>}

      {!loading && !error && raceData && (
        <>
          <div className="race-info" style={{ marginBottom: 12 }}>
            <span>賽事日期：{raceData.date}</span>
            {raceData.sstart && <span>今季起：{raceData.sstart}</span>}
          </div>
          {raceData.races && raceData.races.length > 0 ? (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="tab-bar" style={{ padding: '0 12px', marginBottom: 0 }}>
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
                <div style={{ padding: '12px 16px' }}>
                  <div className="race-info">
                    <span>第 {currentRace.race_no} 場</span>
                    {currentRace.race_class && <span>{currentRace.race_class}</span>}
                    {currentRace.distance && <span>{currentRace.distance}米</span>}
                    {currentRace.track_type && <span>{currentRace.track_type === 'TURF' ? '草地' : '全天候'}</span>}
                    {currentRace.going && <span>場地：{currentRace.going}</span>}
                    <span>{currentRace.horses.length} 匹</span>
                  </div>

                  <div className="table-wrapper">
                    <table style={{ minWidth: 2400 }}>
                      <thead>
                        <tr>
                          {COLUMNS.map(c => (
                            <th
                              key={c.key}
                              className={c.sticky != null ? 'adv-stick adv-stick-w44' : undefined}
                              style={{
                                minWidth: c.width,
                                whiteSpace: 'nowrap',
                                ...(c.sticky != null ? { left: c.sticky } : null),
                              }}
                            >
                              {c.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {currentRace.horses.map((h, idx) => (
                          <tr key={`${h.race_no}-${h.horse_no}`}>
                            {COLUMNS.map(c => (
                              <td
                                key={c.key}
                                className={c.sticky != null ? `adv-stick${c.key === 'horse_name' ? ' adv-stick-r' : ''}` : undefined}
                                style={{
                                  whiteSpace: 'nowrap', fontSize: '0.78rem',
                                  textAlign: c.left ? 'left' : 'center',
                                  ...(c.sticky != null ? { left: c.sticky } : null),
                                  ...(c.key === 'horse_no' ? { fontWeight: 700, color: '#032169' } : {}),
                                }}
                              >
                                {c.render
                                  ? c.render(h[c.key], h, setGearModal, {
                                      date: raceData.date,
                                      raceNo: currentRace.race_no,
                                      reloadSilent: () => loadRacecard(raceData.date, { silent: true }),
                                      openJt: setJtModal,
                                      openJockeyChange: setJockeyChangeModal,
                                    })
                                  : (h[c.key] ?? <span style={{ color: '#bbb' }}>-</span>)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="card"><div className="empty-state">此日期暫無排位表數據。</div></div>
          )}
        </>
      )}

      {gearModal && <GearStatsModal horse={gearModal} onClose={() => setGearModal(null)} />}
      {jockeyChangeModal && <JockeyChangeModal horse={jockeyChangeModal} onClose={() => setJockeyChangeModal(null)} />}
      {jtModal && (
        <JTModal info={jtModal} seasonSince={raceData?.sstart} onClose={() => setJtModal(null)} />
      )}
    </div>
  );
}