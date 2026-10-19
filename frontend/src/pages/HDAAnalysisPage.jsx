import React, { useState, useEffect, useRef } from 'react';
import api from '../api';
import * as XLSX from 'xlsx';

// CV 顏色（綠一致・橙中分歧・紅大分歧）
const cvColor = v => +v > 0.15 ? '#c0392b' : +v > 0.08 ? '#e67e22' : '#1e7e34';
const roiColor = v => v == null ? '#889' : +v > 0 ? '#1e7e34' : '#c0392b';
const pct = v => v == null ? '—' : `${(v * 100).toFixed(2)}%`;
const roiPct = v => v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;

const GREEN = { background: '#d4edda', color: '#155724', fontWeight: 800, borderRadius: 3, padding: '0 3px' };

// 初盤格：賠率 + SD + CV 疊三行（HK33 式）+ 綠格（同場最低）
function OddsStack({ odds, sd, cv, label, hlOdds, hlSd, hlCv }) {
  return (
    <td style={{ padding: '5px 8px', borderRight: '1px solid #e3e9f2', background: '#fbfcfe' }}>
      <div style={{ fontSize: '0.65rem', color: '#889', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: '0.95rem', color: '#032169' }}>
        <span style={hlOdds ? GREEN : { fontWeight: 700 }}>{odds}</span>
      </div>
      <div style={{ fontFamily: 'monospace', fontSize: '0.68rem', color: '#667' }}>
        SD <span style={hlSd ? GREEN : undefined}>{sd}</span>
      </div>
      <div style={{ fontFamily: 'monospace', fontSize: '0.68rem', color: cvColor(cv) }}>
        CV <span style={hlCv ? GREEN : undefined}>{cv}</span>
      </div>
    </td>
  );
}

function PctCell({ v, hl }) {
  return <td style={{ padding: '5px 8px', textAlign: 'center', fontFamily: 'monospace', fontSize: '0.8rem' }}>
    <span style={hl ? GREEN : { color: v > 0 ? '#333' : '#999' }}>{pct(v)}</span>
  </td>;
}
function RoiCell({ v, hl }) {
  return <td style={{ padding: '5px 8px', textAlign: 'center', fontFamily: 'monospace', fontSize: '0.8rem' }}>
    <span style={hl ? GREEN : { color: roiColor(v), fontWeight: 700 }}>{roiPct(v)}</span>
  </td>;
}

const WD = ['日', '一', '二', '三', '四', '五', '六'];

export default function HDAAnalysisPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const [ystats, setYstats] = useState(null);
  const timerRef = useRef(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await api.get('/hda/upcoming', { timeout: 400000 });
      if (r.data.error) setError(r.data.error); else setData(r.data);
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setLoading(false); }
  };

  const exportExcel = () => {
    const matches = data?.matches || [];
    if (!matches.length) return;
    const inv = o => { const h=+o.open_h, d=+o.open_d, a=+o.open_a; const s=1/h+1/d+1/a; return [(1/h)/s,(1/d)/s,(1/a)/s]; };
    const aoa = [[
      '日期','時間','賽事類別','主隊','客隊',
      '主賠率','和賠率','客賠率','主SD','和SD','客SD','主CV','和CV','客CV',
      '預計主%','預計和%','預計客%',
      '場數','開出主%','開出和%','開出客%','回報主%','回報和%','回報客%',
      '馬會HAD主','馬會HAD和','馬會HAD客',
      '黃格','綠格','深綠','強綠','白格','紫格候選',
    ]];
    for (const m of matches) {
      const o = m.odds;
      const k = m.hk33;
      const rates = k ? [k.rateH, k.rateD, k.rateA] : (m.sim ? [m.sim.rateH, m.sim.rateD, m.sim.rateA] : null);
      const rois = k ? [k.roiH, k.roiD, k.roiA] : (m.sim ? [m.sim.roiH, m.sim.roiD, m.sim.roiA] : null);
      const n = k ? k.n : (m.sim ? m.sim.n : null);
      const vh = o ? +o.open_h : (k ? k.h : null);
      const vd = o ? +o.open_d : (k ? k.d : null);
      const va = o ? +o.open_a : (k ? k.a : null);
      const exp = (vh && vd && va) ? inv({open_h: vh, open_d: vd, open_a: va}) : null;
      aoa.push([
        m.date, m.time, m.leagueCn || '', m.home, m.away,
        vh, vd, va,
        o ? +o.sd_h : (k ? k.sdH : ''), o ? +o.sd_d : (k ? k.sdD : ''), o ? +o.sd_a : (k ? k.sdA : ''),
        o ? +o.cv_h : (k ? k.cvH : ''), o ? +o.cv_d : (k ? k.cvD : ''), o ? +o.cv_a : (k ? k.cvA : ''),
        exp ? +(exp[0]*100).toFixed(1) : '', exp ? +(exp[1]*100).toFixed(1) : '', exp ? +(exp[2]*100).toFixed(1) : '',
        n ?? '',
        rates ? +(rates[0]*100).toFixed(0) : '', rates ? +(rates[1]*100).toFixed(0) : '', rates ? +(rates[2]*100).toFixed(0) : '',
        rois ? +(rois[0]*100).toFixed(1) : '', rois ? +(rois[1]*100).toFixed(1) : '', rois ? +(rois[2]*100).toFixed(1) : '',
        m.hadH, m.hadD, m.hadA,
        m.yellow ? '🟨' : '', m.green ? '🟩' : '', (m.deep || m.deepOld) ? '🟢' : '', m.strong ? '💚' : '', m.white ? '⚪' : '', (vh && vh <= 1.6) ? '🟪' : '',
      ]);
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, '馬會未來十日');
    XLSX.writeFile(wb, `主客和_馬會未來十日_${new Date().toISOString().slice(0,10)}.xlsx`);
  };

  const loadYstats = async () => {
    try {
      const r = await api.get('/hda/track-stats', { timeout: 30000 });
      setYstats(r.data);
      // 有已完場但未結算嘅賽事 → 觸發輕量結算再重撈
      const now = Date.now();
      const stale = (r.data.matches || []).some(m => {
        if (m.result || !m.match_date || !m.kickoff) return false;
        const t = new Date(`${String(m.match_date).slice(0, 10)}T${m.kickoff}:00+08:00`).getTime();
        return t < now - 3 * 3600000; // 開賽咗 3 個鐘以上
      });
      if (stale) {
        api.post('/hda/settle', {}, { timeout: 300000 })
          .then(() => api.get('/hda/track-stats', { timeout: 30000 }))
          .then(r2 => setYstats(r2.data))
          .catch(() => {});
      }
    } catch (_) {}
  };

  const runDaily = async () => {
    setStarting(true);
    try { await api.post('/hda/daily-run', {}, { timeout: 600000 }); await Promise.all([load(), loadYstats()]); } catch (_) {}
    setStarting(false);
  };

  const startBatch = async () => {
    setStarting(true);
    try { await api.post('/hda/scrape-all', {}, { timeout: 30000 }); } catch (_) {}
    setStarting(false);
  };

  useEffect(() => { load(); loadYstats(); }, []);
  useEffect(() => {
    if (data?.batch?.running) timerRef.current = setTimeout(load, 8000);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [data]);

  const b = data?.batch;
  const matches = data?.matches || [];
  const [tab, setTab] = useState('upcoming');
  const [ahEdit, setAhEdit] = useState(null);

  const th = { padding: '7px 8px', background: '#032169', color: '#fff', fontSize: '0.72rem', fontWeight: 700, textAlign: 'center', borderRight: '1px solid rgba(255,255,255,0.15)', whiteSpace: 'nowrap' };

  return (
    <div className="ai-page">
      <div className="ai-head">
        <div>
          <h1 className="ai-title">主客和分析</h1>
          <p className="ai-sub" style={{ textTransform: 'none' }}>
            WORLD MEAN INITIAL ODDS AND HISTORICAL SIMILAR ODDS — 百家平均初盤及歷史相似賠率
          </p>
        </div>
      </div>

      <div className="ai-tabs" style={{ marginBottom: 12 }}>
        {[
          { key: 'upcoming', label: '📅 未來賽事' },
          { key: 'history', label: '📚 歷史回查' },
          { key: 'patterns', label: '📊 Pattern 分析' },
        ].map(t => (
          <button key={t.key} className={`ai-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'history' && <HistoryTab />}
      {tab === 'patterns' && <PatternsTab />}

      {tab === 'upcoming' && (<>

      <div className="ai-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h4 style={{ margin: 0 }}>
          📅 馬會未來十日賽事（{data ? `${data.count} 場・HK33 ${data.withHk33} 場・自抓 ${data.withOdds} 場` : '載入中'}）
        </h4>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {b?.running ? (
            <span style={{ fontSize: '0.8rem', color: '#032169', fontWeight: 700 }}>⏳ 批量抓取 {b.done}/{b.total}</span>
          ) : null}
          <button className="ai-btn ai-btn-ghost" onClick={exportExcel} disabled={!data || !data.matches?.length}>📥 Excel</button>
          <button className="ai-btn ai-btn-ghost" onClick={startBatch} disabled={starting || b?.running}>
            {b?.running ? '抓取中…' : '💰 批量抓取初盤'}
          </button>
          <button className="ai-btn ai-btn-ghost" onClick={runDaily} disabled={starting || b?.running}>
            {starting ? '更新中…' : '🔄 每日更新'}
          </button>
          <button className="ai-btn ai-btn-ghost" onClick={load} disabled={loading}>
            {loading ? '刷新中…' : '↻ 刷新'}
          </button>
        </div>
      </div>

      {/* 三色獨立統計 */}
      <div className="ai-card" style={{ marginTop: 10, background: '#fdfdfd', border: '1px solid #d8dee8' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h4 style={{ margin: 0 }}>🎨 顏色賽事獨立統計 — 追蹤邊真正開出%</h4>
          {ystats?.job?.lastRun && (
            <span className="ai-muted" style={{ fontSize: '0.72rem' }}>
              每日 04:05 自動更新・上次 {new Date(ystats.job.lastRun).toLocaleString('zh-HK')}・{ystats.job.lastResult}
            </span>
          )}
        </div>
        {ystats ? (
          <>
            <div className="ai-muted" style={{ fontSize: '0.72rem', marginTop: 4 }}>
              🟨 黃 = 三項最低+比率≥50%+回報&lt;0%+場數≥30｜🟩 綠 = 三項最低+預計&gt;歷史+對方兩邊預計&lt;歷史+回報&lt;-10%+場數≥30｜🟢 深綠 = 綠格 + gap≥13pp（gap用舊基準池計・舊計法繼續累積統計）｜💚 強綠 = 綠格 + 賠率≤1.60｜⚪ 白 = 三項最低+賠率≤2.0+預計比歷史低5pp+（市場睇低=價值熱門）+場數&gt;30｜🟪 紫 = 主≤1.6+客收盤受捧3%+→買客（完場後按收盤價入庫）
              {ystats.byBench && Object.keys(ystats.byBench).length > 0 && (
                <span>｜開出率分組：{Object.entries(ystats.byBench).map(([k, v]) =>
                  `${{ 'Y:HK33': '黃·HK33', 'Y:sim': '黃·sim', 'G:HK33': '綠·HK33', 'G:sim': '綠·sim' }[k] || k} ${(v.hitRate * 100).toFixed(0)}%(${v.n})`).join('・')}</span>
              )}
            </div>
            <TrackTable color="Y" name="🟨 黃格賽事" bg="#fffbe6" border="#e6d47e" stats={ystats.byColor?.Y} matches={ystats.matches.filter(m => m.color === 'Y')} onAhEdit={setAhEdit} simpleRoiFilter />
            <TrackTable color="G" name="🟩 綠格賽事" bg="#f0f9f1" border="#b7dfc0" stats={ystats.byColor?.G} matches={ystats.matches.filter(m => m.color === 'G')} fade onAhEdit={setAhEdit} />
            <TrackTable color="D" name="🟢 深綠格賽事" bg="#dcefdd" border="#5cb85c" stats={ystats.byColor?.D} matches={ystats.matches.filter(m => m.color === 'D')} fade gapFilter onAhEdit={setAhEdit} qualityMarks />
            <TrackTable color="S" name="💚 強綠格賽事" bg="#e0f2e9" border="#3fa376" stats={ystats.byColor?.S} matches={ystats.matches.filter(m => m.color === 'S')} fade onAhEdit={setAhEdit} />
            <TrackTable color="W" name="⚪ 白格賽事" bg="#e8f2fc" border="#5a9fd8" stats={ystats.byColor?.W} matches={ystats.matches.filter(m => m.color === 'W')} fade onAhEdit={setAhEdit} />
            <TrackTable color="P" name="🟪 紫格賽事（主≤1.6+客收盤受捧3%+ → 買客）" bg="#f3eefa" border="#9b7fd4" stats={ystats.byColor?.P} matches={ystats.matches.filter(m => m.color === 'P')} onAhEdit={setAhEdit} />
            <BacktestTable />
            <GreenRegression />
            <UnmatchedTeams />
          </>
        ) : (
          <div className="ai-muted" style={{ marginTop: 6, fontSize: '0.8rem' }}>載入中…</div>
        )}
      </div>

      {error && <div className="ai-error">{error}</div>}
      {loading && !data && <div className="ai-empty" style={{ padding: 20 }}>爬取馬會賽事 + titan007 賽程中（約 1 分鐘）…</div>}

      <div className="ai-card" style={{ marginTop: 10, overflowX: 'auto', padding: 0 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', minWidth: 1180 }}>
          <thead>
            <tr>
              <th style={th} rowSpan={2}>球賽編號</th>
              <th style={th} rowSpan={2}>開賽時間</th>
              <th style={th} rowSpan={2}>賽事類別</th>
              <th style={th} rowSpan={2}>主隊</th>
              <th style={th} rowSpan={2}>客隊</th>
              <th style={{ ...th }} colSpan={3}>百家平均初盤</th>
              <th style={th} colSpan={3}>預計開出比率</th>
              <th style={th} rowSpan={2}>場數</th>
              <th style={th} colSpan={3}>開出比率</th>
              <th style={th} colSpan={3}>回報率</th>
            </tr>
            <tr>
              <th style={th}>主</th><th style={th}>和</th><th style={th}>客</th>
              <th style={th}>主</th><th style={th}>和</th><th style={th}>客</th>
              <th style={th}>主</th><th style={th}>和</th><th style={th}>客</th>
              <th style={th}>主</th><th style={th}>和</th><th style={th}>客</th>
            </tr>
          </thead>
          <tbody>
            {matches.map((m, i) => {
              const d = new Date(m.date + 'T12:00:00');
              const o = m.odds;
              // HK33 數據優先（有齊 場數/開出比率/回報率）；否則用自己嘅 sim
              // HK33 基準 n≥30 先有效（同後端捕捉邏輯一致）
              const k = m.hk33 && m.hk33.n >= 30 ? m.hk33 : null;
              // 顯示用嘅三個來源值（odds 優先，fallback HK33）
              const vh = o ? +o.open_h : k?.h, vd = o ? +o.open_d : k?.d, va = o ? +o.open_a : k?.a;
              const sdAry = o ? [+o.sd_h, +o.sd_d, +o.sd_a] : (k ? [k.sdH, k.sdD, k.sdA] : null);
              const cvAry = o ? [+o.cv_h, +o.cv_d, +o.cv_a] : (k ? [k.cvH, k.cvD, k.cvA] : null);
              const n = k ? k.n : (m.sim ? m.sim.n : null);
              const rateH = k ? k.rateH : m.sim?.rateH;
              const rateD = k ? k.rateD : m.sim?.rateD;
              const rateA = k ? k.rateA : m.sim?.rateA;
              const roiH = k ? k.roiH : m.sim?.roiH;
              const roiD = k ? k.roiD : m.sim?.roiD;
              const roiA = k ? k.roiA : m.sim?.roiA;
              const hasStats = k || (m.sim && m.sim.n > 0);
              // 綠格計算：同場最低（賠率/SD/CV）・最高（開出比率/回報率）
              const minOf = xs => (xs ? Math.min(...xs) : null);
              const maxOf = xs => (xs ? Math.max(...xs) : null);
              const minOdds = [vh, vd, va].filter(x => x != null);
              const minOddsV = minOdds.length ? Math.min(...minOdds) : null;
              const minSdV = minOf(sdAry), minCvV = minOf(cvAry);
              const rates = [rateH, rateD, rateA].filter(x => x != null);
              const maxRateV = rates.length ? Math.max(...rates) : null;
              const rois = [roiH, roiD, roiA].filter(x => x != null && x > 0);
              const maxRoiV = rois.length ? Math.max(...rois) : null; // 全部 ≤0 唔標綠
              const eq = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;
              const hasOdds = vh != null;
              // 全行黃格：某一邊（主/和/客）同時 — 賠率+SD+CV 三項全場最低・開出比率 ≥50%・回報率 <0%・場數 ≥30
              const sideData = [
                { odds: vh, sd: sdAry?.[0], cv: cvAry?.[0], rate: rateH, roi: roiH },
                { odds: vd, sd: sdAry?.[1], cv: cvAry?.[1], rate: rateD, roi: roiD },
                { odds: va, sd: sdAry?.[2], cv: cvAry?.[2], rate: rateA, roi: roiA },
              ];
              const yellow = n != null && n >= 30 && sideData.some(s =>
                s.odds != null && eq(s.odds, minOddsV) && s.sd != null && eq(s.sd, minSdV) && s.cv != null && eq(s.cv, minCvV) &&
                s.rate != null && s.rate >= 0.5 && s.roi != null && s.roi < 0);
              // 綠：賠率/SD/CV 三項最低 + 預計>歷史 + 對方兩邊預計<歷史 + 回報<-10% + 場數≥30
              const invSum = [vh, vd, va].filter(x => x != null).reduce((a, b) => a + 1 / b, 0);
              const expRates = [vh, vd, va].map(x => (x != null && invSum > 0 ? (1 / x) / invSum : null));
              const green = sdAry && k && n != null && n >= 30 && [0, 1, 2].some(i =>
                expRates[i] != null && rates[i] != null && expRates[i] > rates[i]
                && rois[i] != null && rois[i] < -0.10
                && eq([vh, vd, va][i], minOddsV) && eq(sdAry[i], minSdV) && eq(cvAry[i], minCvV)
                && [0, 1, 2].filter(j => j !== i).every(j => expRates[j] != null && rates[j] != null && expRates[j] < rates[j]));
              // 深綠：綠格 + gap ≥13pp
              const deepClient = green && [0, 1, 2].some(i =>
                expRates[i] != null && rates[i] != null && (expRates[i] - rates[i]) >= 0.13
                && eq([vh, vd, va][i], minOddsV) && eq(sdAry[i], minSdV) && eq(cvAry[i], minCvV));
              // 白格：三項最低 + 賠率≤2.0 + gap ≤ -5pp（市場睇低）・用後端計好嘅 m.white
              const white = m.white;
              // 強綠：綠格 + 賠率≤1.60・用後端計好嘅 m.strong
              const strong = m.strong;
              // 深綠：合併新舊計法（乾淨 deep 或 舊法 deepOld 都算）
              const deep = deepClient || m.deep || m.deepOld;
              const rowBg = white ? '#dceefc' : deep ? '#a8d5aa' : strong ? '#c8e8d5' : yellow ? '#fff3cd' : green ? '#d4edda' : (i % 2 ? '#f8fafd' : '#fff');
              const rowBorder = white ? '2px solid #1e7fd6' : deep ? '2px solid #1e7e34' : strong ? '2px solid #2e9e6b' : yellow ? '2px solid #e6b800' : green ? '2px solid #28a745' : 'none';
              return (
                <tr key={m.fb} style={{ background: rowBg, outline: rowBorder }}>
                  <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', fontWeight: 700, color: '#032169' }}>
                    {WD[d.getDay()]} {m.fb.replace('FB', '')}
                    {white && <span title="白格（價值熱門：市場睇低5pp+）">⚪</span>}
                    {strong && !deep && <span title="強綠格（綠格+賠率≤1.60）">💚</span>}
                    {green && <span title={deep ? '深綠格' : '綠格'}>{deep ? '🟢' : '🟩'}</span>}
                    {vh != null && vh <= 1.6 && <span title="紫格候選（主大熱・臨場睇客賠有冇跌3%+）">🟪</span>}
                  </td>
                  <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
                    {`${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${m.time}`}
                  </td>
                  <td style={{ padding: '6px 8px', fontSize: '0.75rem', color: '#556', whiteSpace: 'nowrap' }}>{m.leagueCn || k?.league || '—'}</td>
                  <td style={{ padding: '6px 8px', fontWeight: 600 }}>{m.home}</td>
                  <td style={{ padding: '6px 8px', fontWeight: 600 }}>{m.away}</td>
                  {hasOdds ? (
                    <>
                      <OddsStack label="主" odds={vh} sd={sdAry?.[0]} cv={cvAry?.[0]}
                        hlOdds={eq(vh, minOddsV)} hlSd={eq(sdAry?.[0], minSdV)} hlCv={eq(cvAry?.[0], minCvV)} />
                      <OddsStack label="和" odds={vd} sd={sdAry?.[1]} cv={cvAry?.[1]}
                        hlOdds={eq(vd, minOddsV)} hlSd={eq(sdAry?.[1], minSdV)} hlCv={eq(cvAry?.[1], minCvV)} />
                      <OddsStack label="客" odds={va} sd={sdAry?.[2]} cv={cvAry?.[2]}
                        hlOdds={eq(va, minOddsV)} hlSd={eq(sdAry?.[2], minSdV)} hlCv={eq(cvAry?.[2], minCvV)} />
                      {/* 預計開出比率 = (1/賠率) / Σ(1/三項賠率) */}
                      {[vh, vd, va].map((x, idx) => {
                        const invSum = 1 / vh + 1 / vd + 1 / va;
                        const e = (1 / x) / invSum;
                        return (
                          <td key={idx} style={{ padding: '5px 8px', textAlign: 'center', fontFamily: 'monospace', fontSize: '0.8rem', background: '#fbfcfe', borderRight: '1px solid #e3e9f2' }}>
                            {(e * 100).toFixed(1)}%
                          </td>
                        );
                      })}
                    </>
                  ) : (
                    <td colSpan={6} style={{ padding: '6px 8px', textAlign: 'center', color: '#99a', fontSize: '0.75rem' }}>
                      {m.titanId ? '待批量抓取' : '未有數據'}
                    </td>
                  )}
                  <td style={{ padding: '6px 8px', textAlign: 'center', fontFamily: 'monospace' }}>
                    <span style={n != null && n >= 30 ? GREEN : { fontWeight: 700 }}>{n != null ? n : '—'}</span>
                    {k && <span title="HK33 數據" style={{ fontSize: '0.6rem', color: '#e67e22', marginLeft: 3 }}>H</span>}
                  </td>
                  {hasStats ? (
                    <>
                      <PctCell v={rateH} hl={eq(rateH, maxRateV)} />
                      <PctCell v={rateD} hl={eq(rateD, maxRateV)} />
                      <PctCell v={rateA} hl={eq(rateA, maxRateV)} />
                      <RoiCell v={roiH} hl={eq(roiH, maxRoiV)} />
                      <RoiCell v={roiD} hl={eq(roiD, maxRoiV)} />
                      <RoiCell v={roiA} hl={eq(roiA, maxRoiV)} />
                    </>
                  ) : (
                    <td colSpan={6} style={{ padding: '6px 8px', textAlign: 'center', color: '#99a' }}>—</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="ai-muted" style={{ fontSize: '0.75rem', marginTop: 8, padding: '0 4px' }}>
        🟩 綠格：同場賠率最低・SD 最低・CV 最低・場數 ≥30・開出比率最高・回報率最高（全部 ≤0 唔標）。
        🟨 全行黃：某一邊賠率+SD+CV 三項最低 ✓ 開出 ≥50% ✓ 回報 &lt;0% ✓ 場數 ≥30 ✓。
        🟢 全行淺綠：某一邊賠率/SD/CV 三項全場最低 ✓ 預計開出 &gt; 歷史開出 ✓ 對方兩邊預計開出 &lt; 歷史開出 ✓ 回報 &lt;-10% ✓ 場數 ≥30 ✓。
        預計開出 = (1/賠率) ÷ Σ(1/三項賠率)。回報率 = 開出比率 × 初盤賠率 − 1。H 標記 = HK33 數據。已爬取數據不會重新抓取或取代。
      </div>
      </>)}

      {/* 馬會亞洲盤手動編輯 Modal */}
      {ahEdit && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setAhEdit(null)}
        >
          <div
            style={{ background: '#fff', borderRadius: 10, padding: 24, minWidth: 320, boxShadow: '0 8px 30px rgba(0,0,0,0.3)' }}
            onClick={e => e.stopPropagation()}
          >
            <h4 style={{ margin: '0 0 16px', color: '#032169' }}>✎ 馬會亞洲盤</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={{ fontSize: '0.8rem', color: '#556' }}>讓球盤口
                <select
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid #ccd5e0', borderRadius: 6, fontSize: '0.9rem', marginTop: 4 }}
                  value={ahEdit.line}
                  onChange={e => setAhEdit({ ...ahEdit, line: e.target.value })}
                >
                  <option value="">— 揀盤口 —</option>
                  {['-3','-2.5/-3','-2/-2.5','-2','-1.5/-2','-1/-1.5','-1','-0.5/-1','0/-0.5','-0.5','0','+0.5','0/+0.5','+0.5/+1','+1','+1/+1.5','+1.5','+1.5/+2','+2','+2/+2.5','+2.5','+2.5/+3','+3'].map(l => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: '0.8rem', color: '#556' }}>賠率
                <input
                  type="number" step="0.01" min="1" max="10" placeholder="例：1.89"
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid #ccd5e0', borderRadius: 6, fontSize: '0.9rem', marginTop: 4 }}
                  value={ahEdit.odds}
                  onChange={e => setAhEdit({ ...ahEdit, odds: e.target.value })}
                />
              </label>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
                <button className="ai-btn ai-btn-ghost" onClick={() => setAhEdit(null)}>取消</button>
                <button
                  className="ai-btn"
                  disabled={!ahEdit.line}
                  onClick={async () => {
                    try {
                      await api.patch('/hda/ah', {
                        fb: ahEdit.fb, color: ahEdit.color,
                        ahLine: ahEdit.line, ahOdds: ahEdit.odds ? +ahEdit.odds : null,
                      }, { timeout: 30000 });
                      setAhEdit(null);
                      window.location.reload();
                    } catch (e) { alert('儲存失敗: ' + (e.response?.data?.error || e.message)); }
                  }}
                >
                  儲存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 歷史回查 tab ──
function HistoryTab() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = { limit: 5000 };
      if (q) params.q = q;
      if (from) params.from = from;
      if (to) params.to = to;
      const r = await api.get('/hda/history', { params, timeout: 60000 });
      setRows(r.data.matches || []);
    } catch (_) { setRows([]); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const exportExcel = () => {
    if (!rows || !rows.length) return;
    const aoa = [[
      '日期', '賽事類別', '主隊', '客隊',
      '主賠率', '和賠率', '客賠率',
      '主SD', '和SD', '客SD', '主CV', '和CV', '客CV',
      '預計主%', '預計和%', '預計客%',
      '場數', '開出主%', '開出和%', '開出客%', '回報主%', '回報和%', '回報客%',
      '即時主', '即時和', '即時客',
      '賽果', '主入球', '客入球', '中',
    ]];
    for (const r of rows) {
      const vh = +r.open_h, vd = +r.open_d, va = +r.open_a;
      const inv = 1/vh + 1/vd + 1/va;
      const s = r.sim;
      const f2 = v => v != null ? +(+v).toFixed(4) : '';
      aoa.push([
        String(r.match_date).slice(0, 10), r.league_cn || r.league || '', r.home_team, r.away_team,
        vh, vd, va,
        +r.sd_h, +r.sd_d, +r.sd_a, +r.cv_h, +r.cv_d, +r.cv_a,
        +((1/vh)/inv * 100).toFixed(1), +((1/vd)/inv * 100).toFixed(1), +((1/va)/inv * 100).toFixed(1),
        s ? s.n : '',
        s ? +(s.rateH * 100).toFixed(1) : '', s ? +(s.rateD * 100).toFixed(1) : '', s ? +(s.rateA * 100).toFixed(1) : '',
        s ? +(s.roiH * 100).toFixed(1) : '', s ? +(s.roiD * 100).toFixed(1) : '', s ? +(s.roiA * 100).toFixed(1) : '',
        +r.live_h, +r.live_d, +r.live_a,
        { H: '主', D: '和', A: '客' }[r.result] || '',
        r.home_goals, r.away_goals,
        r.result,
      ]);
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, '歷史回查');
    XLSX.writeFile(wb, `主客和歷史回查_${from || 'all'}_${to || new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const td = { padding: '4px 6px', borderBottom: '1px solid #eef1f5', fontSize: '0.75rem' };
  const td2 = { padding: '4px 6px', borderBottom: '1px solid #eef1f5', fontSize: '0.78rem' };
  const th2 = { padding: '5px 8px', fontSize: '0.7rem', textAlign: 'center', borderRight: '1px solid rgba(255,255,255,0.15)', whiteSpace: 'nowrap' };

  return (
    <div>
      <div className="ai-card" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label style={{ fontSize: '0.8rem', color: '#556' }}>由
          <input type="date" className="ai-date" value={from} onChange={e => setFrom(e.target.value)} />
        </label>
        <label style={{ fontSize: '0.8rem', color: '#556' }}>至
          <input type="date" className="ai-date" value={to} onChange={e => setTo(e.target.value)} />
        </label>
        <input className="ai-input" style={{ padding: '6px 10px', border: '1px solid #ccd', borderRadius: 6, minWidth: 180 }}
          placeholder="球隊／聯賽搜尋…" value={q} onChange={e => setQ(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && load()} />
        <button className="ai-btn" onClick={load} disabled={loading}>{loading ? '搜尋中…' : '🔍 搜尋'}</button>
        <button className="ai-btn ai-btn-ghost" onClick={exportExcel} disabled={!rows || !rows.length}>📥 Excel</button>
        <span className="ai-muted" style={{ fontSize: '0.75rem' }}>{rows ? `${rows.length} 場` : ''}</span>
      </div>
      <div className="ai-card" style={{ marginTop: 10, overflowX: 'auto', padding: 0 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', minWidth: 1280 }}>
          <thead>
            <tr style={{ background: '#032169', color: '#fff', fontSize: '0.7rem' }}>
              <th style={th2}>日期</th><th style={th2}>賽事類別</th><th style={th2}>主隊</th><th style={th2}>客隊</th>
              <th style={{...th2}} colSpan={3}>百家初盤</th>
              <th style={{...th2}} colSpan={3}>預計開出</th>
              <th style={th2}>場數</th>
              <th style={{...th2}} colSpan={3}>開出比率</th>
              <th style={{...th2}} colSpan={3}>回報率</th>
              <th style={th2}>賽果</th><th style={th2}>中</th>
            </tr>
            <tr style={{ background: '#032169', color: '#fff', fontSize: '0.7rem' }}>
              <th colSpan={4}></th>
              <th style={th2}>主</th><th style={th2}>和</th><th style={th2}>客</th>
              <th style={th2}>主</th><th style={th2}>和</th><th style={th2}>客</th>
              <th></th>
              <th style={th2}>主</th><th style={th2}>和</th><th style={th2}>客</th>
              <th style={th2}>主</th><th style={th2}>和</th><th style={th2}>客</th>
              <th colSpan={2}></th>
            </tr>
          </thead>
          <tbody>
            {(rows || []).map((r, i) => {
              const vh = +r.open_h, vd = +r.open_d, va = +r.open_a;
              const sdAry = [+r.sd_h, +r.sd_d, +r.sd_a], cvAry = [+r.cv_h, +r.cv_d, +r.cv_a];
              const eq = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;
              const minO = Math.min(vh, vd, va), minS = Math.min(...sdAry), minC = Math.min(...cvAry);
              const invSum = 1/vh + 1/vd + 1/va;
              const expR = [vh, vd, va].map(x => (1/x)/invSum);
              const s = r.sim;
              const rates = s ? [s.rateH, s.rateD, s.rateA] : null;
              const rois = s ? [s.roiH, s.roiD, s.roiA] : null;
              const maxRate = rates ? Math.max(...rates) : null;
              const posRois = rois ? rois.filter(x => x > 0) : [];
              const maxRoi = posRois.length ? Math.max(...posRois) : null;
              const resIdx = r.result ? 'HDA'.indexOf(r.result) : -1;
              return (
                <tr key={r.titan_id} style={{ background: i % 2 ? '#f8fafd' : '#fff' }}>
                  <td style={td2}>{String(r.match_date).slice(5, 10)}</td>
                  <td style={{ ...td2, color: '#556', fontSize: '0.72rem' }}>{r.league_cn || r.league || '—'}</td>
                  <td style={{ ...td2, fontWeight: 600 }}>{r.home_team}</td>
                  <td style={{ ...td2, fontWeight: 600 }}>{r.away_team}</td>
                  <OddsStack label="主" odds={vh} sd={sdAry[0]} cv={cvAry[0]} hlOdds={eq(vh, minO)} hlSd={eq(sdAry[0], minS)} hlCv={eq(cvAry[0], minC)} />
                  <OddsStack label="和" odds={vd} sd={sdAry[1]} cv={cvAry[1]} hlOdds={eq(vd, minO)} hlSd={eq(sdAry[1], minS)} hlCv={eq(cvAry[1], minC)} />
                  <OddsStack label="客" odds={va} sd={sdAry[2]} cv={cvAry[2]} hlOdds={eq(va, minO)} hlSd={eq(sdAry[2], minS)} hlCv={eq(cvAry[2], minC)} />
                  {expR.map((e, j) => (
                    <td key={j} style={{ ...td2, textAlign: 'center', fontFamily: 'monospace', background: '#fbfcfe' }}>{(e * 100).toFixed(1)}%</td>
                  ))}
                  <td style={{ ...td2, textAlign: 'center', fontWeight: 700 }}>
                    <span style={s && s.n >= 30 ? GREEN : undefined}>{s ? s.n : '—'}</span>
                  </td>
                  {s ? (
                    <>
                      <PctCell v={rates[0]} hl={eq(rates[0], maxRate)} />
                      <PctCell v={rates[1]} hl={eq(rates[1], maxRate)} />
                      <PctCell v={rates[2]} hl={eq(rates[2], maxRate)} />
                      <RoiCell v={rois[0]} hl={eq(rois[0], maxRoi)} />
                      <RoiCell v={rois[1]} hl={eq(rois[1], maxRoi)} />
                      <RoiCell v={rois[2]} hl={eq(rois[2], maxRoi)} />
                    </>
                  ) : <td colSpan={6} style={{ ...td2, textAlign: 'center', color: '#99a' }}>—</td>}
                  <td style={{ ...td2, fontWeight: 700 }}>{r.home_goals}-{r.away_goals}（{{ H: '主', D: '和', A: '客' }[r.result]}）</td>
                  <td style={td2}>{[0, 1, 2].map(j => resIdx === j ? '✅' : '').join('')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows && <div className="ai-empty" style={{ padding: 20 }}>載入中…</div>}
        {rows && !rows.length && <div className="ai-empty" style={{ padding: 20 }}>搵唔到符合條件嘅賽事</div>}
      </div>
    </div>
  );
}

// ── Pattern 分析 tab ──
function PatternsTab() {
  const [d, setD] = useState(null);

  useEffect(() => {
    api.get('/hda/patterns', { timeout: 120000 }).then(r => setD(r.data)).catch(() => setD({ error: true }));
  }, []);

  if (!d) return <div className="ai-empty" style={{ padding: 30 }}>分析中（2,000+ 場統計）…</div>;
  if (d.error) return <div className="ai-error">分析失敗</div>;

  const th = { padding: '5px 8px', background: '#032169', color: '#fff', fontSize: '0.7rem', textAlign: 'left' };
  const td = { padding: '4px 8px', borderBottom: '1px solid #eef1f5', fontSize: '0.78rem' };
  const SIDE = { H: '主', D: '和', A: '客' };
  const roiStyle = v => ({ color: +v > 0.03 ? '#155724' : +v < -0.1 ? '#c0392b' : '#333', fontWeight: +v > 0.03 || +v < -0.1 ? 800 : 400, background: +v > 0.03 ? '#d4edda' : undefined });
  const pct = v => v == null ? '—' : `${(v * 100).toFixed(1)}%`;

  const Section = ({ title, note, rows, cols }) => (
    <div className="ai-card" style={{ marginTop: 10, overflowX: 'auto' }}>
      <h4 style={{ margin: '0 0 4px' }}>{title}</h4>
      <div className="ai-muted" style={{ fontSize: '0.72rem', marginBottom: 6 }}>{note}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
        <thead><tr>{cols.map(c => <th key={c.k} style={th}>{c.t}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => <tr key={i} style={{ background: i % 2 ? '#f8fafd' : '#fff' }}>
            {cols.map(c => <td key={c.k} style={{ ...td, ...(c.roi ? roiStyle(r[c.k]) : {}), ...(c.mono ? { fontFamily: 'monospace' } : {}) }}>
              {c.fmt ? c.fmt(r[c.k]) : r[c.k]}
            </td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      <div className="ai-card">
        <h4 style={{ margin: 0 }}>📊 初盤數據 Pattern 統計</h4>
        <div className="ai-muted" style={{ fontSize: '0.78rem', marginTop: 4 }}>
          基於 <b>{d.sample}</b> 場已完場賽事（馬會口徑・百家平均初盤）。
          ROI = 負注該邊於初盤賠率嘅模擬回報。綠 = 正回報訊號。
        </div>
      </div>

      <Section title="① 賠率區間 × 回報" note="熱門 vs 冷門嘅長期回報差異（留意主隊大冷門區間）"
        rows={d.oddsBands} cols={[
          { k: 'side', t: '邊', fmt: v => SIDE[v] },
          { k: 'band', t: '賠率區間' },
          { k: 'n', t: '場數', mono: true },
          { k: 'avg_odds', t: '平均賠率', mono: true },
          { k: 'win_rate', t: '實際贏率', mono: true, fmt: pct },
          { k: 'implied', t: '隱含機率', mono: true, fmt: pct },
          { k: 'roi', t: 'ROI@初盤', mono: true, roi: true, fmt: pct },
        ]} />

      <Section title="② 離散系數 CV 區間 × 回報" note="該邊百家分歧度 vs 該邊開出率"
        rows={d.cvBands} cols={[
          { k: 'side', t: '邊', fmt: v => SIDE[v] },
          { k: 'band', t: 'CV 區間' },
          { k: 'n', t: '場數', mono: true },
          { k: 'avg_odds', t: '平均賠率', mono: true },
          { k: 'win_rate', t: '實際贏率', mono: true, fmt: pct },
          { k: 'roi', t: 'ROI@初盤', mono: true, roi: true, fmt: pct },
        ]} />

      <Section title="③ 初盤→即時走勢 × 回報" note="跌(受捧)=賠率跌逾3%（資金流入）・ROI 以初盤價買入計"
        rows={d.drift} cols={[
          { k: 'side', t: '邊', fmt: v => SIDE[v] },
          { k: 'drift', t: '走勢' },
          { k: 'n', t: '場數', mono: true },
          { k: 'open_odds', t: '初盤', mono: true },
          { k: 'live_odds', t: '即時', mono: true },
          { k: 'win_rate', t: '實際贏率', mono: true, fmt: pct },
          { k: 'roi_at_open', t: 'ROI@初盤', mono: true, roi: true, fmt: pct },
        ]} />

      <Section title="④ 全場最大 CV（市場整體分歧度）× 賽果分佈" note="市場越唔一致，和波／冷門率有冇升？"
        rows={d.dispersion} cols={[
          { k: 'band', t: '分歧度' },
          { k: 'n', t: '場數', mono: true },
          { k: 'home_rate', t: '主勝率', mono: true, fmt: pct },
          { k: 'draw_rate', t: '和率', mono: true, fmt: pct },
          { k: 'away_rate', t: '客勝率', mono: true, fmt: pct },
          { k: 'roi_h', t: 'ROI 主', mono: true, roi: true, fmt: pct },
          { k: 'roi_d', t: 'ROI 和', mono: true, roi: true, fmt: pct },
          { k: 'roi_a', t: 'ROI 客', mono: true, roi: true, fmt: pct },
        ]} />
    </div>
  );
}

// ── 單色追蹤表（黃/綠各自獨立）──
// 撳一下先揭開嘅遮蔽文字（預設星星・防止俾人見到）
function Masked({ children }) {
  const [show, setShow] = useState(false);
  return (
    <span
      onClick={e => { e.stopPropagation(); setShow(s => !s); }}
      style={{ cursor: 'pointer', userSelect: 'none' }}
      title={show ? '撳一下遮蔽' : '撳一下顯示'}
    >
      {show ? children : <span style={{ color: '#b9c2d0', letterSpacing: 2 }}>★★★</span>}
    </span>
  );
}

function TrackTable({ name, bg, border, stats, matches, fade, gapFilter, onAhEdit, simpleRoiFilter, qualityMarks }) {
  const [rateF, setRateF] = useState('all');
  const [roiF, setRoiF] = useState('all');
  const [gapF, setGapF] = useState('all');
  const [oddsF, setOddsF] = useState('all');
  const [openFb, setOpenFb] = useState(null);
  const [hideNums, setHideNums] = useState(false);
  const td = { padding: '3px 6px', borderBottom: '1px solid #eee' };
  // 過濾：開出比率 / 回報率 / gap / 賠率（深綠格專用）
  const calcGap = y => {
    if (y.odds_h && y.odds_d && y.odds_a && y.rate != null) {
      const inv = 1/+y.odds_h + 1/+y.odds_d + 1/+y.odds_a;
      const sideIdx = 'HDA'.indexOf(y.side);
      const exp = (1/[+y.odds_h, +y.odds_d, +y.odds_a][sideIdx]) / inv;
      return exp - +y.rate;
    }
    return null;
  };
  const filtered = matches.filter(y => {
    if (gapFilter && gapF !== 'all') {
      const g = calcGap(y);
      if (g == null) return false;
      if (gapF === '10-13' && !(g >= 0.10 && g < 0.13)) return false;
      if (gapF === '13-16' && !(g >= 0.13 && g < 0.16)) return false;
      if (gapF === '16-20' && !(g >= 0.16 && g < 0.20)) return false;
      if (gapF === '20+' && !(g >= 0.20)) return false;
    }
    if (gapFilter && oddsF !== 'all') {
      if (y.odds == null) return false;
      const o = +y.odds;
      if (oddsF === 'le150' && !(o <= 1.50)) return false;
      if (oddsF === '150-165' && !(o > 1.50 && o <= 1.65)) return false;
      if (oddsF === '165-180' && !(o > 1.65 && o <= 1.80)) return false;
      if (oddsF === '180-200' && !(o > 1.80 && o <= 2.00)) return false;
      if (oddsF === 'gt200' && !(o > 2.00)) return false;
    }
    if (rateF !== 'all' || roiF !== 'all') {
      if (y.rate == null || y.roi == null) return false;
    }
    if (rateF !== 'all') {
      const r = y.rate * 100;
      if (rateF === '20-30' && !(r >= 20 && r < 30)) return false;
      if (rateF === '30-40' && !(r >= 30 && r < 40)) return false;
      if (rateF === '40+' && !(r >= 40)) return false;
    }
    if (roiF !== 'all') {
      if (simpleRoiFilter) {
        if (roiF === 'lt10' && !(y.roi < -0.10)) return false;
        if (roiF === 'gt10' && !(y.roi >= -0.10)) return false;
      } else {
        if (roiF === 'lt10' && !(y.roi > -0.10)) return false;
        if (roiF === '10-20' && !(y.roi <= -0.10 && y.roi > -0.20)) return false;
        if (roiF === '20-30' && !(y.roi <= -0.20 && y.roi > -0.30)) return false;
        if (roiF === 'gt30' && !(y.roi <= -0.30)) return false;
      }
    }
    return true;
  });
  // 統計跟過濾即時重算（按 benchmark 來源分開・唔溝埋）
  const settled = filtered.filter(y => y.result);
  const hits = settled.filter(y => y.result === y.side).length;
  const s = {
    total: filtered.length, settled: settled.length, hits,
    hitRate: settled.length ? hits / settled.length : null,
  };
  const selStyle = { padding: '3px 6px', borderRadius: 4, border: '1px solid #ccd5e0', fontSize: '0.72rem', background: '#fff' };
  return (
    <details style={{ marginTop: 10, background: bg, border: `1px solid ${border}`, borderRadius: 8, padding: '8px 10px' }}>
      <summary style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, listStyle: 'none' }}>
        <b style={{ fontSize: '0.9rem' }}>{name}（{filtered.length} 場）</b>
          <span style={{ fontSize: '0.8rem', color: '#445' }}>
          已完 <b>{s.settled}</b>・開出 <b>{s.hits}</b>｜開出率 <b style={{ color: s.hitRate >= 0.5 ? '#155724' : '#c0392b' }}>{s.hitRate != null ? `${(s.hitRate * 100).toFixed(1)}%` : '—'}</b>
           <span className="ai-muted" style={{ fontSize: '0.7rem', marginLeft: 6 }}>▸ 撳開睇逐場</span>
           <button
             onClick={e => { e.stopPropagation(); setHideNums(!hideNums); }}
             style={{
               fontSize: '0.65rem', padding: '1px 8px', marginLeft: 8,
               border: '1px solid #b8c4d8', borderRadius: 4, background: hideNums ? '#e8eef8' : '#fff',
               cursor: 'pointer', color: hideNums ? '#032169' : '#889',
             }}
           >{hideNums ? '🔓 顯示' : '🔒 隱藏'}</button>
        </span>
      </summary>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        <label style={{ fontSize: '0.72rem', color: '#556' }}>開出比率
          <select style={selStyle} value={rateF} onChange={e => setRateF(e.target.value)}>
            <option value="all">全部</option>
            <option value="20-30">20-30%</option>
            <option value="30-40">30-40%</option>
            <option value="40+">40%以上</option>
           </select>
         </label>
          {gapFilter && (
            <>
              <label style={{ fontSize: '0.72rem', color: '#556' }}>賠率
                <select style={selStyle} value={oddsF} onChange={e => setOddsF(e.target.value)}>
                  <option value="all">全部</option>
                  <option value="le150">≤1.50</option>
                  <option value="150-165">1.50-1.65</option>
                  <option value="165-180">1.65-1.80</option>
                  <option value="180-200">1.80-2.00</option>
                  <option value="gt200">&gt;2.00</option>
                </select>
              </label>
              <label style={{ fontSize: '0.72rem', color: '#556' }}>分歧度
                <select style={selStyle} value={gapF} onChange={e => setGapF(e.target.value)}>
                  <option value="all">全部</option>
                  <option value="10-13">10-13pp</option>
                  <option value="13-16">13-16pp</option>
                  <option value="16-20">16-20pp</option>
                  <option value="20+">20pp以上</option>
                </select>
              </label>
            </>
          )}
          <label style={{ fontSize: '0.72rem', color: '#556' }}>回報率
            <select style={selStyle} value={roiF} onChange={e => setRoiF(e.target.value)}>
              <option value="all">全部</option>
              {simpleRoiFilter ? (
                <>
                  <option value="lt10">&lt;-10%</option>
                  <option value="gt10">&gt;-10%</option>
                </>
              ) : (
                <>
                  <option value="lt10">&lt;-10%</option>
                  <option value="10-20">-10% 至 -20%</option>
                  <option value="20-30">-20% 至 -30%</option>
                  <option value="gt30">&gt;-30%</option>
                </>
              )}
            </select>
          </label>
       </div>
      {filtered.length > 0 ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem', marginTop: 6 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#667' }}>
              <th style={td}>日期</th><th style={td}>賽事類別</th><th style={td}>賽事</th>
              <th style={td}>邊</th><th style={td}>賠率</th>
              <th style={td}>場數</th><th style={td}>開出比率</th>
              <th style={td}>回報率</th>
              {gapFilter && <th style={td}>gap</th>}
              {gapFilter && <th style={td}>對手比</th>}
              <th style={td}>結果</th>
              <th style={td}>中</th>
              <th style={td}>馬會亞洲盤</th>
              <th style={td}>讓球勝負</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(y => (
              <React.Fragment key={y.fb}>
              <tr
                style={{ borderBottom: '1px solid rgba(0,0,0,0.06)', cursor: 'pointer' }}
                onClick={() => setOpenFb(openFb === y.fb ? null : y.fb)}
              >
                <td style={td}>{openFb === y.fb ? '▾' : '▸'} {y.match_date?.slice(5, 10)} {y.kickoff}</td>
                <td style={{ ...td, color: '#556', fontSize: '0.7rem' }}>{y.league || '—'}</td>
                <td style={td}>
                  {y.home} vs {y.away}
                  {qualityMarks && (() => {
                    const hasN = y.n != null && y.n >= 100;
                    let hasGap = false;
                    if (y.odds_h && y.rate != null) {
                      const inv = 1/+y.odds_h + 1/+y.odds_d + 1/+y.odds_a;
                      const sideIdx = 'HDA'.indexOf(y.side);
                      const gap = (1/[+y.odds_h, +y.odds_d, +y.odds_a][sideIdx]) / inv - +y.rate;
                      hasGap = gap >= 0.16;
                    }
                    return (
                      <span style={{ marginLeft: 4 }}>
                        {hasN && (
                          <span title="相似樣本 ≥100" style={{ fontSize: '0.65rem', background: '#d4edda', color: '#155724', borderRadius: 3, padding: '0 4px', fontWeight: 700, marginRight: 2 }}>n≥100 ✓</span>
                        )}
                        {hasGap && (
                          <span title="分歧度 ≥16pp" style={{ fontSize: '0.65rem', background: '#c8e6c9', color: '#1b5e20', borderRadius: 3, padding: '0 4px', fontWeight: 700 }}>gap≥16 ✓</span>
                        )}
                      </span>
                    );
                  })()}
                </td>
                <td style={{ ...td, fontWeight: 700 }}>{{ H: '主', D: '和', A: '客' }[y.side]}</td>
                <td style={{ ...td, fontFamily: 'monospace' }}>{y.odds}</td>
                <td style={{ ...td, fontFamily: 'monospace' }}>
                  {hideNums ? <span style={{ color: '#b9c2d0', letterSpacing: 1 }}>★★★</span>
                    : <span style={y.n >= 30 ? GREEN : undefined}>{y.n ?? '—'}</span>}
                </td>
                <td style={{ ...td, fontFamily: 'monospace' }}>
                  {hideNums ? <span style={{ color: '#b9c2d0', letterSpacing: 1 }}>★★★</span>
                    : (y.rate != null ? `${(y.rate * 100).toFixed(0)}%` : '—')}
                </td>
                <td style={{ ...td, fontFamily: 'monospace', fontWeight: 700 }}>
                  {hideNums ? <span style={{ color: '#b9c2d0', letterSpacing: 1 }}>★★★</span>
                    : <span style={y.roi != null && y.roi > 0 ? { color: '#1e7e34' } : { color: '#c0392b' }}>
                        {y.roi != null ? `${(y.roi * 100).toFixed(1)}%` : '—'}
                      </span>}
                </td>
                {gapFilter && (() => {
                  if (hideNums) {
                    return (
                      <>
                        <td style={td}><span style={{ color: '#b9c2d0', letterSpacing: 1 }}>★★★</span></td>
                        <td style={td}><span style={{ color: '#b9c2d0', letterSpacing: 1 }}>★★★</span></td>
                      </>
                    );
                  }
                  let gap = null, oppRatio = null;
                  if (y.odds_h && y.rate != null) {
                    const inv = 1/+y.odds_h + 1/+y.odds_d + 1/+y.odds_a;
                    const sideIdx = 'HDA'.indexOf(y.side);
                    const betOdds = [+y.odds_h, +y.odds_d, +y.odds_a][sideIdx];
                    gap = (1/betOdds) / inv - +y.rate;
                    const oppOdds = Math.min(...[+y.odds_h, +y.odds_d, +y.odds_a].filter((_, j) => j !== sideIdx));
                    oppRatio = oppOdds / betOdds;
                  }
                  return (
                    <>
                      <td style={{ ...td, fontFamily: 'monospace', fontWeight: 700,
                        color: gap != null && gap >= 0.16 ? '#1b5e20' : gap != null && gap >= 0.13 ? '#155724' : '#889' }}>
                        {gap != null ? (gap * 100).toFixed(1) + 'pp' : '—'}
                      </td>
                      <td style={{ ...td, fontFamily: 'monospace',
                        color: oppRatio != null && oppRatio > 2.2 ? '#c0392b' : oppRatio != null && oppRatio <= 2.2 ? '#1e7e34' : '#889',
                        fontWeight: oppRatio != null && oppRatio > 2.2 ? 800 : 400 }}>
                        {oppRatio != null ? oppRatio.toFixed(2) : '—'}
                      </td>
                    </>
                  );
                })()}
                <td style={td}>{y.result ? `${y.home_goals}-${y.away_goals}（${{ H: '主', D: '和', A: '客' }[y.result]}）` : '未完'}</td>
                <td style={td}>{y.result ? (y.result === y.side ? '✅' : '❌') : ''}</td>
                <td
                  style={{ ...td, fontFamily: 'monospace', cursor: 'pointer' }}
                  title="撳一下手動補/改亞洲盤"
                  onClick={() => onAhEdit && onAhEdit({ fb: y.fb, color: y.color, line: y.ah_line || '', odds: y.ah_odds || '', side: y.side })}
                >
                  {(() => {
                    const line = y.side === 'A' ? (y.ah_away_line || (y.ah_line ? `↔${y.ah_line}` : null)) : y.ah_line;
                    const odds = y.side === 'A' ? y.ah_away_odds : y.ah_odds;
                    if (!line) return <span className="ai-muted" style={{ textDecoration: 'underline dotted' }}>NA ✎</span>;
                    return <span>[{line}]{odds != null ? ` @${odds}` : ''}{y.side === 'A' && !y.ah_away_line ? '（主線反轉）' : ''}</span>;
                  })()}
                </td>
                <td style={{ ...td, fontWeight: 800, color: y.ah_result === '勝' || y.ah_result === '半勝' ? '#155724' : y.ah_result === '負' || y.ah_result === '半負' ? '#c0392b' : '#667' }}>
                  {y.ah_result || (y.ah_line ? (y.result ? '—' : '') : 'NA')}
                </td>
              </tr>
              {openFb === y.fb && (() => {
                const sideIdx = 'HDA'.indexOf(y.side);
                const odds3 = [+y.odds_h, +y.odds_d, +y.odds_a];
                const sd3 = [+y.sd_h, +y.sd_d, +y.sd_a];
                const cv3 = [+y.cv_h, +y.cv_d, +y.cv_a];
                const rate3 = [y.rate_h != null ? +y.rate_h : null, y.rate_d != null ? +y.rate_d : null, y.rate_a != null ? +y.rate_a : null];
                const roi3 = [y.roi_h != null ? +y.roi_h : null, y.roi_d != null ? +y.roi_d : null, y.roi_a != null ? +y.roi_a : null];
                const hasAll = odds3.every(x => x > 1);
                const invSum = hasAll ? 1/odds3[0] + 1/odds3[1] + 1/odds3[2] : 0;
                const exp3 = hasAll ? odds3.map(x => (1/x) / invSum) : [null, null, null];
                const eq = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;
                const minO = hasAll ? Math.min(...odds3) : null;
                const minS = sd3.some(x => x > 0) ? Math.min(...sd3) : null;
                const minC = cv3.some(x => x > 0) ? Math.min(...cv3) : null;
                const maxRate = rate3.some(x => x != null) ? Math.max(...rate3.filter(x => x != null)) : null;
                const posRoi = roi3.filter(x => x != null && x > 0);
                const maxRoi = posRoi.length ? Math.max(...posRoi) : null;
                const eTh = { padding: '5px 8px', background: '#032169', color: '#fff', fontSize: '0.68rem', fontWeight: 700, textAlign: 'center', whiteSpace: 'nowrap' };
                return (
                <tr>
                  <td colSpan={gapFilter ? 14 : 12} style={{ padding: '8px 12px', background: '#f4f7ff', borderBottom: '2px solid #c8d4ea' }}>
                    <div style={{ fontSize: '0.7rem', color: '#889', marginBottom: 6 }}>📊 該場完整主客和數據</div>
                    <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', minWidth: 1200 }}>
                      <thead>
                        <tr>
                          <th style={eTh} colSpan={3}>百家平均初盤</th>
                          <th style={eTh} colSpan={3}>預計開出比率</th>
                          <th style={eTh} rowSpan={2}>場數</th>
                          <th style={eTh} colSpan={3}>開出比率</th>
                          <th style={eTh} colSpan={3}>回報率</th>
                        </tr>
                        <tr>
                          <th style={eTh}>主</th><th style={eTh}>和</th><th style={eTh}>客</th>
                          <th style={eTh}>主</th><th style={eTh}>和</th><th style={eTh}>客</th>
                          <th style={eTh}>主</th><th style={eTh}>和</th><th style={eTh}>客</th>
                          <th style={eTh}>主</th><th style={eTh}>和</th><th style={eTh}>客</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr style={{ background: '#fff' }}>
                          {hasAll ? odds3.map((x, j) => (
                            <OddsStack key={j} label={{ 0: '主', 1: '和', 2: '客' }[j]}
                              odds={x} sd={sd3[j]} cv={cv3[j]}
                              hlOdds={eq(x, minO)} hlSd={eq(sd3[j], minS)} hlCv={eq(cv3[j], minC)} />
                          )) : <td colSpan={3} style={{ textAlign: 'center', color: '#99a' }}>未有數據</td>}
                          {hasAll ? exp3.map((e, j) => (
                            <td key={j} style={{ padding: '5px 8px', textAlign: 'center', fontFamily: 'monospace', fontSize: '0.78rem', background: '#fbfcfe', borderRight: '1px solid #e3e9f2' }}>
                              {(e * 100).toFixed(1)}%
                            </td>
                          )) : <td colSpan={3} style={{ textAlign: 'center', color: '#99a' }}>—</td>}
                          <td style={{ padding: '5px 8px', textAlign: 'center', fontWeight: 700, fontFamily: 'monospace' }}>
                            <span style={y.n >= 30 ? GREEN : undefined}>{y.n ?? '—'}</span>
                          </td>
                          {rate3.some(x => x != null) ? rate3.map((r, j) => (
                            <PctCell key={j} v={r} hl={eq(r, maxRate)} />
                          )) : <td colSpan={3} style={{ textAlign: 'center', color: '#99a' }}>—</td>}
                          {roi3.some(x => x != null) ? roi3.map((r, j) => (
                            <RoiCell key={j} v={r} hl={eq(r, maxRoi)} />
                          )) : <td colSpan={3} style={{ textAlign: 'center', color: '#99a' }}>—</td>}
                        </tr>
                      </tbody>
                    </table>
                    </div>
                    <div className="ai-muted" style={{ fontSize: '0.68rem', marginTop: 6 }}>
                      場數：{y.n ?? '—'}・基準：{y.bench === 'HK33' ? 'HK33' : '007自計'}（{y.bench_src === 'HK33' ? 'HK33' : 'sim'}）・追蹤邊：{{ H: '主', D: '和', A: '客' }[y.side]}
                      {y.ah_line && `｜亞洲盤：[${y.ah_line}] @${y.ah_odds ?? '—'} → 讓球${y.ah_result || '待計'}`}
                    </div>
                  </td>
                </tr>
                );
              })()}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="ai-muted" style={{ fontSize: '0.8rem', marginTop: 6 }}>暫時冇捕捉到賽事</div>
      )}
    </details>
  );
}

// ── 歷史統計 Backtest（獨立・唔掂現有 hda_track 統計）──
function BacktestTable() {
  const [d, setD] = useState(null);
  useEffect(() => {
    api.get('/hda/backtest-track', { timeout: 180000 }).then(r => setD(r.data)).catch(() => setD({ error: true }));
  }, []);
  if (!d) return <div className="ai-muted" style={{ marginTop: 10, fontSize: '0.8rem', padding: 10 }}>📚 歷史統計計算中（全庫 backtest）…</div>;
  if (d.error) return <div className="ai-error" style={{ marginTop: 10 }}>歷史統計失敗</div>;

  const td = { padding: '3px 6px', borderBottom: '1px solid #eee' };
  const Rows = ({ list, label }) => {
    const a = d[label];
    return (
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: '0.85rem' }}>
          <b>{list === d.yellowMatches ? '🟨 黃格' : list === d.greenMatches ? '🟩 綠格' : '🟢 深綠格（gap≥13pp）'}</b>
          ｜符合 <b>{a.total}</b> 場｜中 <b style={{ color: '#155724' }}>{a.hits}</b>
          ｜開出率 <b style={{ color: a.hitRate >= 0.5 ? '#155724' : '#c0392b' }}>{a.hitRate != null ? `${(a.hitRate * 100).toFixed(1)}%` : '—'}</b>
          ｜模擬 ROI（每場一注@初盤）<b style={{ color: a.roi > 0 ? '#155724' : '#c0392b' }}>{a.roi != null ? `${(a.roi * 100).toFixed(1)}%` : '—'}</b>
        </div>
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.75rem', color: '#556' }}>逐場（{list.length}）</summary>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.72rem', marginTop: 4 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#667' }}>
                <th style={td}>日期</th><th style={td}>賽事類別</th><th style={td}>賽事</th>
                <th style={td}>邊</th><th style={td}>賠率</th><th style={td}>場數</th>
                <th style={td}>開出比率</th><th style={td}>回報率</th><th style={td}>結果</th><th style={td}>中</th>
              </tr>
            </thead>
            <tbody>
              {list.map((y, i) => (
                <tr key={y.titan_id}>
                  <td style={td}>{String(y.date).slice(5, 10)}</td>
                  <td style={{ ...td, color: '#556', fontSize: '0.68rem' }}>{y.league || '—'}</td>
                  <td style={td}>{y.home} vs {y.away}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{{ H: '主', D: '和', A: '客' }[y.side]}</td>
                  <td style={{ ...td, fontFamily: 'monospace' }}>{y.odds}</td>
                  <td style={{ ...td, fontFamily: 'monospace' }}>{y.n}</td>
                  <td style={{ ...td, fontFamily: 'monospace' }}>{(y.rate * 100).toFixed(0)}%</td>
                  <td style={{ ...td, fontFamily: 'monospace', color: y.roi > 0 ? '#1e7e34' : '#c0392b' }}>{(y.roi * 100).toFixed(1)}%</td>
                  <td style={td}>{y.home_goals != null ? `${y.home_goals}-${y.away_goals}（${{ H: '主勝', D: '和', A: '客勝' }[y.result]}）` : '—'}</td>
                  <td style={td}>{y.result === y.side ? '✅' : '❌'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>
    );
  };
  return (
    <div style={{ marginTop: 12, background: '#f7f8fa', border: '1px dashed #aab4c4', borderRadius: 8, padding: 10 }}>
      <b style={{ fontSize: '0.9rem' }}>📚 歷史統計（Backtest）</b>
      <span className="ai-muted" style={{ fontSize: '0.72rem', marginLeft: 10 }}>
        用已儲存嘅 {d.sample} 場歷史賽事（連賽果）重跑黃/綠檢測 — 與上方即時統計完全獨立
      </span>
      <Rows list={d.yellowMatches} label="yellow" />
      <Rows list={d.greenMatches} label="green" />
      <Rows list={d.deepMatches} label="deep" />
    </div>
  );
}

// ── 深綠格回歸實驗（獨立・唔影響主統計）──
function GreenRegression() {
  const [d, setD] = useState(null);
  useEffect(() => {
    api.get('/hda/green-regression', { timeout: 60000 }).then(r => setD(r.data)).catch(() => setD({ error: true }));
  }, []);
  if (!d) return <div className="ai-muted" style={{ marginTop: 10, fontSize: '0.8rem', padding: 10 }}>🧪 深綠格回歸實驗載入中…</div>;
  if (d.error) return <div className="ai-error" style={{ marginTop: 10 }}>回歸實驗載入失敗</div>;
  const td = { padding: '3px 6px', borderBottom: '1px solid #eee' };
  return (
    <div style={{ marginTop: 12, background: '#f4f0fa', border: '1px dashed #9b8ec4', borderRadius: 8, padding: 10 }}>
      <b style={{ fontSize: '0.9rem' }}>🧪 深綠格回歸實驗</b>
      <span className="ai-muted" style={{ fontSize: '0.72rem', marginLeft: 10 }}>
        捕捉時記開盤隱含%・完場攞收盤隱含% — 回歸 = 收盤跌逾 1pp。獨立表，唔影響主統計。
      </span>
      {d.backtest && (
        <div style={{ marginTop: 8, background: '#fff', border: '1px dashed #d5c9ec', borderRadius: 6, padding: 8 }}>
          <b style={{ fontSize: '0.8rem' }}>📜 歷史回測（{d.backtest.total} 場・007自計基準 — 與 live HK33 基準唔同源，僅供參考）</b>
          <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap', fontSize: '0.78rem' }}>
            {[['有回歸', d.backtest.regressed, '#fdecea'], ['冇回歸', d.backtest.noRegressed, '#d4edda']].map(([label, s, bg]) => (
              <span key={label} style={{ padding: '3px 10px', borderRadius: 6, background: bg }}>
                <b>{label}</b>｜n={s.n}｜開出 <b>{(s.hitRate * 100).toFixed(1)}%</b>
                ｜隱含 {(s.avgOpenExp * 100).toFixed(1)}% → {(s.avgCloseExp * 100).toFixed(1)}%
              </span>
            ))}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap', fontSize: '0.85rem', alignItems: 'center' }}>
        <b style={{ fontSize: '0.82rem' }}>🔴 即時累積（正式結論以此為準）</b>
        {d.agg.map(a => (
          <span key={String(a.regressed) + a.bench} style={{ padding: '4px 10px', borderRadius: 6, background: a.regressed ? '#d4edda' : '#fdecea' }}>
            <b>{a.regressed ? '有回歸' : '冇回歸'}·{a.bench}</b>｜n={a.n}｜開出 <b>{(a.hits / a.n * 100).toFixed(1)}%</b>
            ｜隱含 {(+a.avg_open_exp * 100).toFixed(1)}% → {(+a.avg_close_exp * 100).toFixed(1)}%
          </span>
        ))}
        {(() => {
          const settled = d.agg.reduce((s, a) => s + a.n, 0);
          const target = 60;
          return (
            <span className="ai-muted" style={{ fontSize: '0.75rem' }}>
              已結算 {settled}／目標 ~{target} 場（{Math.min(Math.round(settled / target * 100), 100)}%）・每日 04:05 自動累積
            </span>
          );
        })()}
      </div>
      {d.rows.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.75rem', color: '#556' }}>逐場（{d.rows.length}）</summary>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.72rem', marginTop: 4 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#667' }}>
                <th style={td}>日期</th><th style={td}>賽事</th><th style={td}>邊</th>
                <th style={td}>開盤賠率</th><th style={td}>開盤隱含</th><th style={td}>收盤隱含</th>
                <th style={td}>gap</th><th style={td}>回歸</th><th style={td}>結果</th><th style={td}>中</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map(y => (
                <tr key={y.fb}>
                  <td style={td}>{String(y.match_date || '').slice(5, 10)}</td>
                  <td style={td}>{y.home || '?'} vs {y.away || '?'}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{{ H: '主', D: '和', A: '客' }[y.side]}</td>
                  <td style={{ ...td, fontFamily: 'monospace' }}>{y.open_odds}</td>
                  <td style={{ ...td, fontFamily: 'monospace' }}>{y.open_exp != null ? `${(y.open_exp * 100).toFixed(1)}%` : '—'}</td>
                  <td style={{ ...td, fontFamily: 'monospace' }}>{y.close_exp != null ? `${(y.close_exp * 100).toFixed(1)}%` : '未完'}</td>
                  <td style={{ ...td, fontFamily: 'monospace' }}>{y.gap != null ? `${(y.gap * 100).toFixed(1)}pp` : '—'}</td>
                  <td style={td}>{y.regressed == null ? '' : y.regressed ? '✅' : '✗'}</td>
                  <td style={td}>{y.result ? ({ H: '主勝', D: '和', A: '客勝' }[y.result]) : '未完'}</td>
                  <td style={td}>{y.hit == null ? '' : y.hit ? '✅' : '❌'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

// ── Outstanding 球隊名表（未配到 titan・等用戶手動輸入譯名）──
function UnmatchedTeams() {
  const [data, setData] = useState(null);
  const [inputs, setInputs] = useState({});
  const [saving, setSaving] = useState(null);
  const [autoRun, setAutoRun] = useState(false);

  const load = async () => {
    try {
      const r = await api.get('/hda/unmatched', { timeout: 60000 });
      setData(r.data);
      setInputs({});
    } catch (_) { setData({ unmatched: [] }); }
  };

  useEffect(() => { load(); }, []);

  const save = async (hkjc) => {
    const titan = inputs[hkjc];
    if (!titan || !titan.trim()) return;
    setSaving(hkjc);
    try {
      await api.post('/hda/alias', { hkjc, titan: titan.trim() }, { timeout: 15000 });
      // 從列表移除
      setData(prev => ({ unmatched: prev.unmatched.filter(u => u.name !== hkjc) }));
    } catch (e) { alert('儲存失敗: ' + (e.response?.data?.error || e.message)); }
    finally { setSaving(null); }
  };

  if (!data) return null;
  if (!data.unmatched.length) return null;

  return (
    <div style={{ marginTop: 12, background: '#fff8f0', border: '1px dashed #d4a76a', borderRadius: 8, padding: 10 }}>
      <b style={{ fontSize: '0.85rem', color: '#856404' }}>⚠ 未配對球隊名（{data.unmatched.length}）</b>
      <button
        style={{ fontSize: '0.7rem', padding: '2px 10px', marginLeft: 8, border: '1px solid #c8a44e', borderRadius: 4, background: autoRun ? '#f0e6d0' : '#fff', cursor: 'pointer', color: '#856404' }}
        onClick={async () => {
          setAutoRun(true);
          try {
            const r = await api.post('/hda/auto-alias', {}, { timeout: 300000 });
            if (r.data.error) { alert('失敗: ' + r.data.error); }
            else { load(); }
          } catch (e) { alert('失敗: ' + e.message); }
          finally { setAutoRun(false); }
        }}
        disabled={autoRun}
      >
        {autoRun ? '搜尋中…' : '🔍 自動配對'}
      </button>
      <span className="ai-muted" style={{ fontSize: '0.7rem', marginLeft: 8 }}>
        輸入 titan007 譯名後下次刷新自動配對・輸入一次永久生效
      </span>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))', gap: 6 }}>
        {data.unmatched.map(u => (
          <div key={u.name} style={{ display: 'flex', gap: 6, alignItems: 'center', background: '#fff', borderRadius: 6, padding: '4px 8px', border: '1px solid #e8dcc8' }}>
            <span style={{ fontSize: '0.78rem', fontWeight: 600, minWidth: 110, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {u.name}
            </span>
            <span className="ai-muted" style={{ fontSize: '0.65rem', minWidth: 55 }}>{(u.league || '').slice(0, 6)}</span>
            <input
              style={{ flex: 1, padding: '3px 6px', border: '1px solid #ccd5e0', borderRadius: 4, fontSize: '0.78rem' }}
              placeholder="titan007 譯名…"
              value={inputs[u.name] || ''}
              onChange={e => setInputs(prev => ({ ...prev, [u.name]: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && save(u.name)}
            />
            <button
              style={{ fontSize: '0.7rem', padding: '2px 8px', border: '1px solid #c8d4ea', borderRadius: 4, background: saving === u.name ? '#e8eef8' : '#fff', cursor: 'pointer' }}
              onClick={() => save(u.name)}
              disabled={saving === u.name || !(inputs[u.name] || '').trim()}
            >
              {saving === u.name ? '…' : '✓'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
