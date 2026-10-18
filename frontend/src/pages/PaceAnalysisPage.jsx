import React, { useState, useEffect } from 'react';
import { getFixtures, getNextRace, getPaceAnalysis } from '../api';

const STYLE_META = {
  '前領': { color: '#c0392b', bg: '#fdecea' },
  '前速': { color: '#e67e22', bg: '#fef3e2' },
  '均速': { color: '#032169', bg: '#eef2fa' },
  '後追': { color: '#1e7e34', bg: '#eaf6ec' },
};

// 三級制（回測顯示等級預測訊號有限，重點在領放馬同跑法分佈）
const PACE_META = {
  '快': { color: '#c0392b', icon: '▲' },
  '正常': { color: '#032169', icon: '—' },
  '慢': { color: '#1e7e34', icon: '▼' },
};

export default function PaceAnalysisPage() {
  const [fixtures, setFixtures] = useState([]);
  const [selectedDate, setSelectedDate] = useState('');
  const [data, setData] = useState(null);
  const [selectedRace, setSelectedRace] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sortBy, setSortBy] = useState('early'); // early=按前置 | closing=按後勁

  // 排序：前置（早段平均位細先）、後勁（指數大先）或圖數（高先）
  function sortedHorses(race) {
    if (sortBy === 'closing') {
      return [...race.horses].sort((a, b) => (b.closing_index ?? -1) - (a.closing_index ?? -1));
    }
    if (sortBy === 'fig') {
      return [...race.horses].sort((a, b) => ((b.speed_fig?.fig) ?? -99) - ((a.speed_fig?.fig) ?? -99));
    }
    return [...race.horses].sort((a, b) => (a.early_avg ?? 99) - (b.early_avg ?? 99));
  }

  useEffect(() => { loadInitial(); }, []);

  async function loadInitial() {
    try {
      const [nextRace, fixtureList] = await Promise.all([getNextRace(), getFixtures()]);
      setFixtures(fixtureList);
      const defaultDate = nextRace?.race_date || fixtureList[0]?.race_date;
      if (defaultDate) {
        setSelectedDate(defaultDate);
        await loadPace(defaultDate);
      } else {
        setError('暫無賽期資料');
        setLoading(false);
      }
    } catch (e) {
      setError('載入失敗：' + e.message);
      setLoading(false);
    }
  }

  async function loadPace(date) {
    setLoading(true);
    setError(null);
    try {
      const d = await getPaceAnalysis(date);
      setData(d);
      setSelectedRace(d.races?.[0]?.race_no ?? null);
    } catch (e) {
      setError('載入步速分析失敗：' + e.message);
    } finally {
      setLoading(false);
    }
  }

  function handleDateChange(e) {
    const d = e.target.value;
    setSelectedDate(d);
    loadPace(d);
  }

  const race = data?.races?.find(r => r.race_no === selectedRace);

  return (
    <div className="ai-page">
      <div className="ai-head">
        <div>
          <h1 className="ai-title">步速分析</h1>
          <p className="ai-sub">
            根據每匹參賽馬過往分段時間嘅走位推算跑法（前領／前速／均速／後追），
            再按同場跑法分佈預測該場步速形勢。走位資料來自 race_sectional_times（每段位置-落後距離）。
          </p>
        </div>
        <div className="ai-head-right">
          <select className="ai-date" value={selectedDate} onChange={handleDateChange}>
            {fixtures.length === 0 && selectedDate && <option value={selectedDate}>{selectedDate}</option>}
            {fixtures.map(f => (
              <option key={f.race_date} value={f.race_date}>
                {f.race_date} ({f.racecourse || 'ST'})
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading && <div className="ai-empty">載入步速分析中…</div>}
      {error && <div className="ai-error">{error}</div>}

      {!loading && !error && data && data.races?.length > 0 && (
        <>
          <div className="ai-race-tabs">
            {data.races.map(r => (
              <button
                key={r.race_no}
                className={`ai-race-tab ${r.race_no === selectedRace ? 'active' : ''}`}
                onClick={() => setSelectedRace(r.race_no)}
              >
                第 {r.race_no} 場
                <span className="ai-race-tab-sub">
                  {PACE_META[r.pace.level]?.icon} {r.pace.level}
                </span>
              </button>
            ))}
          </div>

          {race && (
            <>
              <div className="ai-race-head">
                <span className="ai-badge">{race.racecourse}</span>
                <span className="ai-badge">{race.race_class}</span>
                <span className="ai-badge">{race.distance}m</span>
                <span className="ai-badge">{race.track_type === 'AWT' ? '全天候' : '草地'}</span>
                {race.going && <span className="ai-badge">{race.going}</span>}
                <span className="ai-badge">{race.horses.length} 匹</span>
                <span style={{ flex: 1 }} />
                <button
                  className="ai-fp-btn"
                  onClick={() => setSortBy(s => (s === 'early' ? 'closing' : s === 'closing' ? 'fig' : 'early'))}
                  title="切換表格排序"
                >
                  排序：{sortBy === 'early' ? '前置優先' : sortBy === 'closing' ? '後勁優先' : '圖數優先'}
                </button>
              </div>

              <div className="ai-verdict" style={{ borderLeft: `5px solid ${PACE_META[race.pace.level]?.color}` }}>
                {/* 主打一：預計領放（回測三甲命中 75% vs 隨機 25%） */}
                <div className="ai-verdict-title" style={{ fontSize: '1.05rem' }}>
                  預計領放：
                  {race.pace.leader_candidates?.length ? (
                    race.pace.leader_candidates.map((nm, i) => (
                      <span key={nm} style={{
                        display: 'inline-block', marginLeft: 8, fontWeight: 700,
                        color: i === 0 ? '#c0392b' : '#555',
                        background: i === 0 ? '#fdecea' : '#f5f5f5',
                        borderRadius: 4, padding: '2px 10px',
                      }}>
                        {i + 1}. {nm}
                      </span>
                    ))
                  ) : <span className="ai-muted">初出馬為主，難估</span>}
                </div>

                {/* 主打二：後追候選（後勁指數最高三匹 — 形勢快最著數） */}
                <div className="ai-verdict-title" style={{ fontSize: '1.05rem', marginTop: 6 }}>
                  後追王：
                  {race.pace.closer_candidates?.length ? (
                    race.pace.closer_candidates.map((nm, i) => {
                      const h = race.horses.find(x => x.horse_name === nm);
                      return (
                        <span key={nm} style={{
                          display: 'inline-block', marginLeft: 8, fontWeight: 700,
                          color: i === 0 ? '#1e7e34' : '#555',
                          background: i === 0 ? '#eaf6ec' : '#f5f5f5',
                          borderRadius: 4, padding: '2px 10px',
                        }} title={h ? `後勁指數 ${h.closing_index}｜平均末段前 ${(h.closing_pct * 100).toFixed(0)}%｜${(h.closing_consistency * 100).toFixed(0)}% 仗快過全場` : ''}>
                          {i + 1}. {nm}
                          {h && <span style={{ fontWeight: 400, fontSize: '0.78em', marginLeft: 4 }}>{h.closing_index}</span>}
                        </span>
                      );
                    })
                  ) : <span className="ai-muted">後勁樣本不足</span>}
                  {race.pace.level === '快' && race.pace.closer_candidates?.length > 0 && (
                    <span style={{ color: '#1e7e34', fontSize: '0.82em', marginLeft: 8 }}>← 形勢快，後上馬最著數</span>
                  )}
                </div>

                {/* 主打三：圖數王（Beyer 速度圖數最高三匹 — 整體能力基準） */}
                <div className="ai-verdict-title" style={{ fontSize: '1.05rem', marginTop: 6 }}>
                  圖數王：
                  {race.pace.fig_candidates?.length ? (
                    race.pace.fig_candidates.map((nm, i) => {
                      const h = race.horses.find(x => x.horse_name === nm);
                      return (
                        <span key={nm} style={{
                          display: 'inline-block', marginLeft: 8, fontWeight: 700,
                          color: i === 0 ? '#032169' : '#555',
                          background: i === 0 ? '#eef2fa' : '#f5f5f5',
                          borderRadius: 4, padding: '2px 10px',
                        }} title={h ? `近 ${h.speed_fig.n} 仗加權圖數｜最佳 ${h.speed_fig.best}${h.speed_fig.w2w ? `｜${h.speed_fig.w2w} 仗冇壓力放頭（圖數或高估）` : ''}` : ''}>
                          {i + 1}. {nm}
                          {h && <span style={{ fontWeight: 400, fontSize: '0.78em', marginLeft: 4 }}>{h.speed_fig.fig}</span>}
                        </span>
                      );
                    })
                  ) : <span className="ai-muted">圖數樣本不足</span>}
                </div>

                {/* 跑法分佈 bar */}
                {race.pace.style_counts && (
                  <div style={{ margin: '10px 0 8px' }}>
                    <div style={{ display: 'flex', height: 18, borderRadius: 4, overflow: 'hidden', maxWidth: 520 }}>
                      {['前領', '前速', '均速', '後追', '無資料'].map(s => {
                        const n = race.pace.style_counts[s] || 0;
                        if (!n) return null;
                        return (
                          <div key={s} title={`${s} ${n} 匹`} style={{
                            width: `${(n / race.horses.length) * 100}%`,
                            background: s === '無資料' ? '#ccc' : STYLE_META[s].color,
                            color: '#fff', fontSize: '0.7rem',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}>{n}</div>
                        );
                      })}
                    </div>
                    <div style={{ fontSize: '0.76rem', color: '#666', marginTop: 3 }}>
                      {['前領', '前速', '均速', '後追'].map(s => (
                        <span key={s} style={{ marginRight: 10 }}>
                          <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: STYLE_META[s].color, marginRight: 3 }} />
                          {s} {race.pace.style_counts?.[s] || 0}
                        </span>
                      ))}
                      <span className="ai-muted">無資料 {race.pace.style_counts?.['無資料'] || 0}</span>
                    </div>
                  </div>
                )}

                {/* 次要：步速形勢（弱化處理） */}
                <div style={{ fontSize: '0.84rem', color: '#555' }}>
                  <span style={{
                    color: PACE_META[race.pace.level]?.color, fontWeight: 600,
                    border: `1px solid ${PACE_META[race.pace.level]?.color}`, borderRadius: 3,
                    padding: '1px 7px', marginRight: 8,
                  }}>
                    {PACE_META[race.pace.level]?.icon} 形勢{race.pace.level}
                  </span>
                  {race.pace.note}
                </div>
                {race.pace.leaders?.length > 0 && (
                  <div style={{ fontSize: '0.78rem', color: '#888', marginTop: 4 }}>
                    前領馬：{race.pace.leaders.join('、')}（共 {race.pace.leaders.length} 匹）
                  </div>
                )}
              </div>

              <div className="ai-table-wrap">
                <table className="ai-table">
                  <thead>
                     <tr>
                       <th className="ai-num">#</th>
                      <th className="ai-num">馬號</th>
                       <th>馬名</th>
                       <th>檔</th>
                       <th>騎師</th>
                       <th>跑法</th>
                       <th className="ai-num">早段平均位</th>
                       <th>近仗早段位置（新→舊）</th>
                       <th className="ai-num">上仗早段</th>
                      <th className="ai-num">上仗名次</th>
                      <th className="ai-num">速度圖數</th>
                      <th className="ai-num">最佳圖數</th>
                      <th className="ai-num">後勁指數</th>
                       <th className="ai-num">末段排名</th>
                       <th className="ai-num">最佳後勁</th>
                       <th className="ai-num">穩定性</th>
                       <th className="ai-num">樣本</th>
                     </tr>
                   </thead>
                   <tbody>
                     {sortedHorses(race).map((h, i) => {
                       const sm = h.style ? STYLE_META[h.style] : null;
                       const cand = race.pace.leader_candidates?.indexOf(h.horse_name) ?? -1;
                       const closer = race.pace.closer_candidates?.indexOf(h.horse_name) ?? -1;
                       return (
                        <tr key={h.horse_name} className={cand === 0 || (sortBy === 'closing' && closer === 0) ? 'ai-top' : ''}>
                           <td className="ai-num ai-muted">{i + 1}</td>
                           <td className="ai-num" style={{ fontWeight: 700, color: '#032169' }}>{h.horse_no ?? '-'}</td>
                           <td>
                             <div className="ai-horse">
                               <span className="ai-horse-name">{h.horse_name}</span>
                               {cand >= 0 && (
                                 <span className="ai-tag" style={{ background: cand === 0 ? '#fdecea' : '#f5f5f5', color: cand === 0 ? '#c0392b' : '#666', fontWeight: 700 }}>
                                   領放 {cand + 1}
                                 </span>
                               )}
                               {closer >= 0 && (
                                 <span className="ai-tag" style={{ background: closer === 0 ? '#eaf6ec' : '#f5f5f5', color: closer === 0 ? '#1e7e34' : '#666', fontWeight: 700 }}>
                                   後追 {closer + 1}
                                 </span>
                               )}
                             </div>
                           </td>
                          <td className="ai-num">{h.draw ?? '-'}</td>
                          <td className="ai-small">{h.jockey_name || '-'}</td>
                          <td>
                            {h.style ? (
                              <span style={{
                                background: sm.bg, color: sm.color, fontWeight: 700,
                                borderRadius: 3, padding: '2px 8px', fontSize: '0.78rem',
                              }}>{h.style}</span>
                            ) : <span className="ai-muted">—</span>}
                          </td>
                          <td className="ai-num" style={{ fontWeight: 700, color: h.early_avg != null && h.early_avg <= 2.5 ? '#c0392b' : '#333' }}>
                            {h.early_avg ?? '-'}
                          </td>
                          <td className="ai-num ai-mono">
                            {h.early_positions.length ? h.early_positions.map(p => (
                              <span key={Math.random()} style={{
                                display: 'inline-block', minWidth: 22, marginRight: 3,
                                background: p <= 2 ? '#fdecea' : p <= 4 ? '#fef3e2' : p <= 6 ? '#eef2fa' : '#eaf6ec',
                                color: p <= 2 ? '#c0392b' : p <= 4 ? '#e67e22' : p <= 6 ? '#032169' : '#1e7e34',
                                borderRadius: 3, padding: '1px 4px',
                              }}>{p}</span>
                            )) : <span className="ai-muted">—</span>}
                          </td>
                          <td className="ai-num">{h.last_run_early ?? '-'}</td>
                          <td className="ai-num" style={{ fontWeight: 700, color: h.last_run_finish === 1 ? '#1e7e34' : h.last_run_finish <= 3 ? '#e67e22' : '#333' }}>
                            {h.last_run_finish ?? '-'}
                          </td>
                          <td className="ai-num" style={{ fontWeight: 700, color: h.speed_fig ? '#032169' : '#999' }}
                            title={h.speed_fig ? `近 ${h.speed_fig.n} 仗加權（新仗重）${h.speed_fig.w2w ? `｜⚠ ${h.speed_fig.w2w} 仗冇壓力放頭（Beyer：圖數或高估）` : ''}` : ''}>
                            {h.speed_fig ? h.speed_fig.fig : '-'}
                            {h.speed_fig?.w2w ? <span style={{ color: '#b8860b' }}>⚠</span> : null}
                          </td>
                          <td className="ai-num" style={{ color: h.speed_fig ? '#555' : '#999' }}
                            title={h.speed_fig ? '歷史最好一仗圖數' : ''}>
                            {h.speed_fig ? h.speed_fig.best : '-'}
                          </td>
                          <td className="ai-num" style={{ fontWeight: 700, color: h.closing_index > 1.03 ? '#1e7e34' : h.closing_index > 1 ? '#2e7d32' : h.closing_index < 0.97 ? '#c0392b' : '#333' }}
                            title={h.closing_index != null ? '全場末段中位數 ÷ 此馬末段（加權平均）' : ''}>
                            {h.closing_index ?? '-'}
                          </td>
                          <td className="ai-num" style={{ color: h.closing_pct != null && h.closing_pct <= 0.3 ? '#1e7e34' : h.closing_pct != null && h.closing_pct >= 0.7 ? '#c0392b' : '#333' }}
                            title={h.closing_pct != null ? '此馬末段喺該仗嘅排名百分位（加權平均，0%=最快）' : ''}>
                            {h.closing_pct != null ? `前${Math.round(h.closing_pct * 100)}%` : '-'}
                          </td>
                          <td className="ai-num"
                            title={h.closing_best ? `${h.closing_best.date} 末段 ${h.closing_best.last}s（指數 ${h.closing_best.value}）` : ''}>
                            {h.closing_best ? h.closing_best.value : '-'}
                          </td>
                          <td className="ai-num" style={{ color: h.closing_consistency != null && h.closing_consistency >= 0.7 ? '#1e7e34' : '#555' }}
                            title={h.closing_consistency != null ? `${Math.round(h.closing_consistency * 100)}% 嘅仗末段快過全場中位數` : ''}>
                            {h.closing_consistency != null ? `${Math.round(h.closing_consistency * 100)}%` : '-'}
                          </td>
                          <td className="ai-num ai-muted">{h.closing_runs || h.runs_used || '-'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="ai-card" style={{ marginTop: 14 }}>
                <h4>計法說明</h4>
                <ul className="ai-list">
                  <li><b>跑法</b> — 按近 8 仗每段走位嘅「早段位置」（第一個分段位置）加權平均（新仗權重高）：≤2.5 前領、≤4 前速、≤6.5 均速、其餘後追。</li>
                  <li><b>領放候選</b> — 早段平均位最細三匹（平手時內檔優先）。2026 年 9 月 56 場回測：首位命中 29%，遠高於隨機（約 9%）。</li>
                  <li><b>形勢三級</b>（快/正常/慢）— 按前領+前速馬數量分級。<b>僅供參考</b>：回測顯示等級與實際步速相關性未達統計顯著（尤其「冇前領馬」嘅場實際前段未必慢），重心應放在領放候選同跑法分佈。</li>
                  <li><b>後勁指數</b> — 每仗「全場末段中位數 ÷ 此馬末段」，近 8 仗加權平均（新仗重）。&gt;1.03（綠）= 持續快過全場；&lt;0.97（紅）= 末段偏弱。</li>
                  <li><b>末段排名</b> — 每仗此馬末段喺全場嘅排名百分位（加權平均），「前30%」或以內 = 真後勁馬。</li>
                  <li><b>最佳後勁／穩定性</b> — 歷史最勁一仗指數（懸停睇日期同末段時間）；幾多 % 嘅仗快過全場中位數（≥70% 綠）。</li>
                  <li><b>後追王</b> — 後勁指數最高三匹（最少 2 仗樣本）。形勢「快」嘅場後上馬最著數；形勢「慢」就前置馬佔先。</li>
                  <li><b>速度圖數</b> — 港版 Beyer 圖數：每仗時間 vs 馬會班次標準（含每日場地偏差修正），近 6 仗加權（新仗重）。0 = 岩岩好標準，正數快過標準。⚠ = 有仗一放到底冇壓力（第 9 章折扣：圖數或高估）。</li>
                  <li><b>圖數王</b> — 圖數最高三匹（整體能力基準）。配合跑法用：圖數高 + 前領 = 放頭贏馬候選；圖數高 + 後追 = 後上殺手。</li>
                  <li>預設按早段平均位排序；可切換「後勁優先」／「圖數優先」。</li>
                </ul>
              </div>
            </>
          )}
        </>
      )}

      {!loading && !error && data && !data.races?.length && (
        <div className="ai-empty">此日期暫無排位表資料</div>
      )}
    </div>
  );
}
