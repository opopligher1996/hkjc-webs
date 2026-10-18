import React, { useState, useEffect, useMemo } from 'react';
import { getAiAnalyze, getAiFactors, getAiR2 } from '../api';

const pct = (v, d = 1) => (v == null ? '-' : `${(v * 100).toFixed(d)}%`);
const sign = (v, d = 2) => (v == null ? '-' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`);

const TABS = [
  { key: 'picks', label: '選馬推薦' },
  { key: 'factors', label: '因素拆解' },
  { key: 'r2', label: 'R² 模型驗證' },
  { key: 'method', label: '方法論' },
];

// ── 選馬推薦 ────────────────────────────────────────────────────────────────
function PicksTab({ data }) {
  const [raceNo, setRaceNo] = useState(null);
  const race = useMemo(
    () => data.races.find(r => r.race_no === raceNo) || data.races[0],
    [data.races, raceNo]
  );
  if (!race) return <Empty />;
  const calib = data.calibration;

  return (
    <div>
      {calib && (
        <div className="ai-evidence" role="note">
          <div className="ai-evidence-title">後測結論（誠實標示）</div>
          <div className="ai-evidence-body">{calib.verdict}</div>
          {calib.backtest && (
            <div className="ai-evidence-stats">
              <span>模型 R² {calib.backtest.modelOnly.r2} · log-loss {calib.backtest.modelOnly.logLoss}</span>
              <span>市場 R² {calib.backtest.marketOnly.r2} · log-loss {calib.backtest.marketOnly.logLoss}</span>
              <span>融合 w={calib.backtest.blended.w} log-loss {calib.backtest.blended.logLoss}</span>
              <span>{calib.backtest.significance}</span>
            </div>
          )}
          <div className="ai-evidence-meta">
            銳度 SIGMA_K={calib.sigmaK} · 市場融合 w={calib.blendW} · {calib.fitted_by}
            {calib.marketBenchmark
              ? ` · 書中門檻 R² > ${calib.marketBenchmark.threshold}（公賠率基準 ${calib.marketBenchmark.r2_bookScale}）`
              : ''}
            → 完整驗證見「R² 模型驗證」分頁
          </div>
        </div>
      )}

      <div className="ai-race-tabs">
        {data.races.map(r => (
          <button
            key={r.race_no}
            className={`ai-race-tab ${r.race_no === race.race_no ? 'active' : ''}`}
            onClick={() => setRaceNo(r.race_no)}
          >
            第 {r.race_no} 場
            <span className="ai-race-tab-sub">{r.racecourse} {r.distance}m</span>
          </button>
        ))}
      </div>

      <div className="ai-race-head">
        <span className="ai-badge">{race.racecourse}</span>
        <span className="ai-badge">{race.race_class}</span>
        <span className="ai-badge">{race.distance}m</span>
        <span className="ai-badge">{race.track_type}</span>
        {race.going && <span className="ai-badge">{race.going}</span>}
        <span className="ai-badge">{race.runners} 匹</span>
        {race.leadWin != null && (
          <span className="ai-muted" style={{ fontSize: '0.8rem' }}>
            放頭馬勝出率 {pct(race.leadWin, 1)}
          </span>
        )}
      </div>

      <div className="ai-table-wrap">
        <table className="ai-table">
          <thead>
            <tr>
              <th className="ai-num">#</th>
              <th>馬名</th>
              <th>檔</th>
              <th>騎/練</th>
              <th>負磅</th>
              <th>評分</th>
              <th>賠率</th>
              <th className="ai-num">總分</th>
              <th className="ai-num">勝出率</th>
              <th className="ai-num">三甲率</th>
              <th className="ai-num">平均賠率</th>
              <th className="ai-num">優勢</th>
              <th className="ai-num">EV</th>
              <th>評級</th>
            </tr>
          </thead>
          <tbody>
            {race.horses.map((h, i) => (
              <tr key={h.horse_id || `${h.horse_no}`} className={h.value_grade?.label === 'A級' ? 'ai-top' : ''}>
                <td className="ai-num ai-muted">{i + 1}</td>
                <td>
                  <div className="ai-horse">
                    <span className="ai-horse-name">{h.horse_name}</span>
                    {h.sire && <span className="ai-horse-sub">/{h.sire}</span>}
                    {h.runs === 0 && <span className="ai-tag-warn">初出</span>}
                    {h.horse_note && <span className="ai-tag">{h.horse_note}</span>}
                  </div>
                </td>
                <td className="ai-num">{h.draw ?? '-'}</td>
                <td className="ai-small">
                  {h.jockey_name || '-'}
                  <br />
                  <span className="ai-muted">{h.trainer_name || '-'}</span>
                </td>
                <td className="ai-num">
                  {h.actual_weight ?? '-'}
                  {h.age != null && <span className="ai-muted">/{h.age}歲</span>}
                </td>
                <td className="ai-num">{h.rating ?? '-'}</td>
                <td className="ai-num">{h.odds ?? '-'}</td>
                <td className="ai-num">
                  <span className={h.total >= 0 ? 'ai-pos' : 'ai-neg'}>{sign(h.total)}</span>
                </td>
                <td className="ai-num">
                  <div className="ai-bar-wrap">
                    <span className="ai-num-txt">{pct(h.win_prob)}</span>
                    <div className="ai-bar">
                      <div className="ai-bar-fill" style={{ width: `${Math.min(100, h.win_prob * 100 * 2.5)}%` }} />
                    </div>
                  </div>
                </td>
                <td className="ai-num">{pct(h.place3_prob)}</td>
                <td className="ai-num ai-muted">{h.fair_odds ?? '-'}</td>
                <td className={`ai-num ${h.edge > 0 ? 'ai-pos' : h.edge < 0 ? 'ai-neg' : 'ai-muted'}`}>
                  {h.edge == null ? '-' : pct(h.edge)}
                </td>
                <td className={`ai-num ${h.ev > 0 ? 'ai-pos' : h.ev < 0 ? 'ai-neg' : 'ai-muted'}`}>
                  {h.ev == null ? '-' : h.ev.toFixed(3)}
                </td>
                <td>
                  {h.value_grade && (
                    <span className="ai-grade" style={{ background: h.value_grade.color }}>
                      {h.value_grade.label}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <BestPicks race={race} />
    </div>
  );
}

function BestPicks({ race }) {
  const value = race.horses.filter(h => h.value_grade && ['A級', 'B級'].includes(h.value_grade.label));
  const top = race.horses.slice(0, 3);
  return (
    <div className="ai-cards">
      <div className="ai-card">
        <h4>三甲人選</h4>
        {top.map((h, i) => (
          <div key={h.horse_id || h.horse_no} className="ai-card-row">
            <span className="ai-rank">{i + 1}</span>
            <span className="ai-card-name">{h.horse_name}</span>
            <span className="ai-muted">{h.jockey_name}</span>
            <span className="ai-pos">{pct(h.win_prob)}</span>
            <span className="ai-muted">三甲 {pct(h.place3_prob)}</span>
          </div>
        ))}
      </div>
      <div className="ai-card">
        <h4>值得留意（vs 市場）</h4>
        {value.length === 0 && <div className="ai-muted">本場沒有明顯價值盤</div>}
        {value.slice(0, 5).map(h => (
          <div key={h.horse_id || h.horse_no} className="ai-card-row">
            <span className="ai-grade" style={{ background: h.value_grade.color }}>{h.value_grade.label}</span>
            <span className="ai-card-name">{h.horse_name}</span>
            <span>賠率 {h.odds}</span>
            <span className="ai-pos">EV {h.ev.toFixed(3)}</span>
            <span className="ai-muted">優於市場 {pct(h.edge)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 因素拆解 ────────────────────────────────────────────────────────────────
function FactorsTab({ data, factors }) {
  const [raceNo, setRaceNo] = useState(null);
  const [horseId, setHorseId] = useState(null);
  const race = useMemo(
    () => data.races.find(r => r.race_no === raceNo) || data.races[0] || null,
    [data.races, raceNo]
  );
  const horse = useMemo(() => {
    if (!race) return null;
    return race.horses.find(h => h.horse_id === horseId) || race.horses[0] || null;
  }, [race, horseId]);

  const byGroup = useMemo(() => {
    const m = new Map();
    for (const f of factors) {
      if (!m.has(f.group)) m.set(f.group, []);
      m.get(f.group).push(f);
    }
    return m;
  }, [factors]);

  if (!race || !horse) return <Empty />;

  return (
    <div>
      <div className="ai-race-tabs">
        {data.races.map(r => (
          <button key={r.race_no} className={`ai-race-tab ${r.race_no === race.race_no ? 'active' : ''}`}
            onClick={() => { setRaceNo(r.race_no); setHorseId(null); }}>
            第 {r.race_no} 場
          </button>
        ))}
      </div>

      <div className="ai-horse-picker">
        {race.horses.map(h => (
          <button key={h.horse_id || h.horse_no}
            className={`ai-chip ${h.horse_id === horse.horse_id ? 'active' : ''}`}
            onClick={() => setHorseId(h.horse_id)}>
            {h.horse_no} {h.horse_name}
            <span className="ai-chip-sub">{sign(h.total)}</span>
          </button>
        ))}
      </div>

      <div className="ai-horse-summary">
        <div><b>{horse.horse_name}</b> · 總分 <span className={horse.total >= 0 ? 'ai-pos' : 'ai-neg'}>{sign(horse.total)}</span></div>
        <div className="ai-muted">
          勝出率 {pct(horse.win_prob)} · 三甲率 {pct(horse.place3_prob)} · 標準差 σ={horse.sigma} · 往績 {horse.runs} 場
        </div>
      </div>

      {[...byGroup.entries()].map(([group, list]) => (
        <div key={group} className="ai-group">
          <h3 className="ai-group-title">{group}</h3>
          {list.map(f => {
            const p = horse.parts.find(x => x.key === f.key);
            if (!p) return null;
            const ratio = p.maxLength ? p.score / p.maxLength : 0;
            return (
              <div key={f.key} className={`ai-factor ${p.disabled ? 'disabled' : ''}`}>
                <div className="ai-factor-head" title={f.desc}>
                  <span className="ai-factor-label">{f.label}</span>
                  <span className="ai-factor-score">{p.disabled ? '—' : sign(p.score)}{!p.disabled && <span className="ai-muted">/{p.maxLength}</span>}</span>
                </div>
                <div className="ai-factor-bar">
                  <div className="ai-factor-center" />
                  <div className={`ai-factor-fill ${p.score >= 0 ? 'pos' : 'neg'}`}
                    style={{
                      left: p.score >= 0 ? '50%' : `${50 + ratio * 50}%`,
                      width: `${Math.abs(ratio) * 50}%`,
                    }} />
                </div>
                <div className="ai-factor-detail">
                  {p.disabled
                    ? <span className="ai-tag"> 已剔選 — 此因素不計分</span>
                    : <>
                        {p.detail || '—'}
                        {p.raw == null && <span className="ai-tag-warn"> 數據不足</span>}
                      </>}
                  <span className="ai-factor-ref">{f.bookRef}</span>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── R² 驗證 ─────────────────────────────────────────────────────────────────
function R2Tab({ factorSel, factorTotal }) {
  const [state, setState] = useState({ loading: false, data: null, error: null, form: {} });
  const run = async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const data = await getAiR2({
        ...state.form,
        ...(factorSel ? { factors: [...factorSel].join(',') } : {}),
      });
      if (data.error) setState(s => ({ ...s, loading: false, error: data.error }));
      else setState(s => ({ ...s, loading: false, data }));
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: e.message }));
    }
  };

  const d = state.data;
  return (
    <div>
      <div className="ai-card">
        <h4>ln(R²) 測試（訓練集 / 測試集嚴格分離）</h4>
        <p className="ai-muted" style={{ fontSize: '0.85rem', margin: '4px 0 12px' }}>
          《計得精彩》第5章：模型必須與公賠率基準比較。指標為
          ln(R²) = mean( ln( P̂ / (1/匹數) ) )（p190），公賠率 ≈ 0.152 (1996-2001) /
          0.167 (2003-04)，作者結論要 &gt; 0.17 才有長期盈利（p191）。
          訓練／測試日期留空會自動按資料推斷：測試集 = 最近 4 個月，訓練集 = 之前所有資料
          （p192 告誡不可用同一組數據同時做 parameter estimate 同 R² test）。
        </p>
        <div className="ai-form">
          <label>訓練開始 <input type="date" value={state.form.train_from || ''} onChange={e => setState(s => ({ ...s, form: { ...s.form, train_from: e.target.value } }))} /></label>
          <label>訓練結束 <input type="date" value={state.form.train_to || ''} onChange={e => setState(s => ({ ...s, form: { ...s.form, train_to: e.target.value } }))} /></label>
          <label>測試開始 <input type="date" value={state.form.test_from || ''} onChange={e => setState(s => ({ ...s, form: { ...s.form, test_from: e.target.value } }))} /></label>
          <label>測試結束 <input type="date" value={state.form.test_to || ''} onChange={e => setState(s => ({ ...s, form: { ...s.form, test_to: e.target.value } }))} /></label>
          <button className="ai-btn" onClick={run} disabled={state.loading}>
            {state.loading ? '計算中…' : '執行驗證'}
          </button>
        </div>
        <div className="ai-muted" style={{ fontSize: '0.8rem' }}>
          測試集最多 800 場，運算需時較長。
          {factorSel
            ? ` 目前套用因素剔選：${factorSel.size}/${factorTotal} 個因素（只訓練及驗證選中嘅因素）。`
            : ' 目前使用全部因素（可在上方「因素剔選」調整後重跑）。'}
        </div>
      </div>

      {state.error && <div className="ai-error">{state.error}</div>}

      {d && (
        <>
          <div className={`ai-verdict ${d.verdict.level}`}>
            <div className="ai-verdict-title">{d.verdict.msg}</div>
            <div className="ai-r2-grid">
              <div className="ai-r2-box">
                <span className="ai-muted">模型 ln(R²)</span>
                <span className="ai-r2-num">{d.r2?.r2 ?? '-'}</span>
                <span className="ai-muted">相當於冠軍獲派隨機的 {d.r2?.skillRatio ?? '-'} 倍 · {d.r2?.n ?? 0} 場</span>
              </div>
              <div className="ai-r2-box">
                <span className="ai-muted">公賠率 ln(R²)（同口徑）</span>
                <span className="ai-r2-num">{d.marketR2?.r2 ?? '-'}</span>
                <span className="ai-muted">冠軍獲派隨機的 {d.marketR2?.skillRatio ?? '-'} 倍 · {d.marketR2?.n ?? 0} 場</span>
              </div>
              <div className="ai-r2-box">
                <span className="ai-muted">公賠率 0.82/odds 口徑</span>
                <span className="ai-r2-num">{d.marketRawR2?.r2 ?? '-'}</span>
                <span className="ai-muted">書中 p191 用呢個口徑 · {d.marketRawR2?.n ?? 0} 場</span>
              </div>
              <div className="ai-r2-box">
                <span className="ai-muted">盈利門檻</span>
                <span className="ai-r2-num">0.17</span>
                <span className="ai-muted">《計得精彩》p191</span>
              </div>
              <div className="ai-r2-box">
                <span className="ai-muted">訓練場次</span>
                <span className="ai-r2-num">{d.train.races}</span>
                <span className="ai-muted">{d.train.samples} 樣本 / {d.train.epochs} 輪</span>
              </div>
              <div className="ai-r2-box">
                <span className="ai-muted">測試場次</span>
                <span className="ai-r2-num">{d.test.races}</span>
                <span className="ai-muted">{d.test.from} → {d.test.to}</span>
              </div>
            </div>
          </div>

          <div className="ai-card">
            <h4>學到的因素權重（絕對值排序）</h4>
            <table className="ai-table">
              <thead><tr><th>因素</th><th className="ai-num">權重</th><th className="ai-num">方向</th></tr></thead>
              <tbody>
                {d.weights.map(w => (
                  <tr key={w.factor}>
                    <td className="ai-mono">{w.factor}</td>
                    <td className="ai-num">{w.weight}</td>
                    <td className={`ai-num ${w.weight > 0 ? 'ai-pos' : 'ai-neg'}`}>
                      {w.weight > 0 ? '正' : '負'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="ai-card">
            <h4>逐場結果（最近 {d.perRace.length} 場）</h4>
            <div className="ai-table-wrap">
              <table className="ai-table">
                <thead>
                  <tr>
                    <th>日期</th><th className="ai-num">場</th><th className="ai-num">匹數</th>
                    <th>勝出馬</th><th className="ai-num">模型機會率</th><th className="ai-num">公賠率機會率</th>
                  </tr>
                </thead>
                <tbody>
                  {d.perRace.map((p, i) => (
                    <tr key={i}>
                      <td className="ai-mono">{p.date}</td>
                      <td className="ai-num">{p.raceNo}</td>
                      <td className="ai-num">{p.runners}</td>
                      <td>{p.winner}</td>
                      <td className="ai-num">{p.modelProb}</td>
                      <td className="ai-num ai-muted">{p.marketProb ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── 方法論 ──────────────────────────────────────────────────────────────────
function MethodTab({ factors, bench }) {
  return (
    <div>
      <div className="ai-card">
        <h4>《計得精彩》核心方法</h4>
        <ul className="ai-list">
          <li><b>因素用馬位（lengths）計量</b> — 每個因素指定最大影響幅度，避免次要因素喧賓奪主。</li>
          <li><b>全場估計</b> — 所有因素以同場其他馬為基準相對定位（p153）。</li>
          <li><b>變數轉化</b> — 賠率取 log(倒數)；出賽次數取 √Runs、√Runs×√Day（p178-186）。</li>
          <li><b>警惕共線</b> — 賠率與騎師實力高度相關（p186），本模型兩者並用並在頁面標示。</li>
          <li><b>負磅不可單獨放大</b> — 必須配合馬體重與距離（p77-81）。</li>
          <li><b>檔位要平滑</b> — 用加權平均線 (4-2-1, bandwidth=2) 去除隨機噪音（p142-150）。</li>
          <li><b>路程／場地適應幅度小</b> — 作者指出「死路程」是假的；泥地適應是唯一證實有效的馬匹特徵（p82）。</li>
          <li><b>血統只在前 3 場有用</b>（p95）。</li>
          <li><b>正態分布求機會率</b> — μ = 總分，σ = 歷史表現波動（p198-200），不直接用 score/total。</li>
          <li><b>ln(R²) 驗證</b> — ln(R²) = mean( ln( P̂ / (1/匹數) ) )（p190），門檻 0.17（p191）；結果同公賠率同口徑比較。</li>
        </ul>
      </div>

      <div className="ai-card">
        <h4>因素庫（共 {factors.length} 項）</h4>
        <div className="ai-table-wrap">
          <table className="ai-table">
            <thead>
              <tr><th>分組</th><th>因素</th><th className="ai-num">最大馬位</th><th>說明</th><th>出處</th></tr>
            </thead>
            <tbody>
              {factors.map(f => (
                <tr key={f.key}>
                  <td>{f.group}</td>
                  <td><b>{f.label}</b></td>
                  <td className="ai-num">{f.maxLength}</td>
                  <td className="ai-small">{f.desc}</td>
                  <td className="ai-mono ai-small">{f.bookRef}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {bench && (
        <div className="ai-card">
          <h4>驗證門檻</h4>
          <p className="ai-muted">{bench.note}</p>
        </div>
      )}

      <div className="ai-card">
        <h4>已知限制</h4>
        <ul className="ai-list">
          <li>本系統是<b>統計評分模型</b>，不是機器學習黑盒 — 每一分都可以追溯到具體因素。</li>
          <li>資料庫的 race_records 未有完成時間／走位／頭馬距離，所以蹄速與走位分析只能用有限 sectionals。</li>
          <li>配備變動方向與幅度需用數據驗證，目前用保守的先驗（眼罩類偏負面）。</li>
          <li>未計入場次全包、每注金額、騎師罰停等非統計因素。</li>
          <li>任何預測都不保證盈利，落注需自行負責。</li>
        </ul>
      </div>
    </div>
  );
}

const Empty = () => <div className="ai-empty">暫無資料</div>;

// ── 因素剔選面板 ────────────────────────────────────────────────────────────
function FactorPicker({ factors, enabled, onToggle, onAll, onClose }) {
  const allKeys = factors.map(f => f.key);
  const active = enabled || new Set(allKeys);
  const count = enabled ? enabled.size : allKeys.length;
  const groups = [];
  for (const f of factors) {
    let g = groups.find(x => x.name === f.group);
    if (!g) { g = { name: f.group, items: [] }; groups.push(g); }
    g.items.push(f);
  }
  return (
    <div className="ai-fp">
      <div className="ai-fp-head">
        <b>因素剔選</b>
        <span className="ai-muted">{count}/{allKeys.length} 啟用 — 剔走嘅因素計 0 分，總分、機率同評級即時重算</span>
        <span className="ai-fp-spacer" />
        <button className="ai-fp-btn" onClick={onAll}>全部啟用</button>
        <button className="ai-fp-btn" onClick={onClose}>收起</button>
      </div>
      {groups.map(g => (
        <div key={g.name} className="ai-fp-group">
          <div className="ai-fp-group-name">{g.name}</div>
          <div className="ai-fp-chips">
            {g.items.map(f => (
              <button key={f.key} title={f.desc}
                className={`ai-fp-chip ${active.has(f.key) ? 'on' : 'off'}`}
                onClick={() => onToggle(f.key)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 主頁 ────────────────────────────────────────────────────────────────────
export default function AiAnalysisPage() {
  const [tab, setTab] = useState('picks');
  const [date, setDate] = useState('');
  const [analyze, setAnalyze] = useState({ loading: false, data: null, error: null });
  const [factors, setFactors] = useState([]);
  const [bench, setBench] = useState(null);
  // 因素剔選：null = 全部啟用；Set = 只有 set 內嘅因素計分（存 localStorage）
  const [enabled, setEnabled] = useState(() => {
    try {
      const raw = localStorage.getItem('aiFactorSel');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) return new Set(arr);
      }
    } catch { /* ignore */ }
    return null;
  });
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    getAiFactors().then(d => { setFactors(d.factors || []); setBench(d.benchmark); }).catch(() => {});
  }, []);

  const load = async (d, sel) => {
    const s = sel === undefined ? enabled : sel;
    setAnalyze(s2 => ({ ...s2, loading: true, error: null }));
    try {
      const data = await getAiAnalyze({
        ...(d ? { date: d } : {}),
        ...(s ? { factors: [...s].join(',') } : {}),
      });
      setAnalyze({ loading: false, data, error: null });
      if (data.date) setDate(data.date);
    } catch (e) {
      setAnalyze({ loading: false, data: null, error: e.message });
    }
  };

  useEffect(() => { load(); }, []);

  const persistSel = (s) => {
    try {
      if (s) localStorage.setItem('aiFactorSel', JSON.stringify([...s]));
      else localStorage.removeItem('aiFactorSel');
    } catch { /* ignore */ }
  };

  const applySel = (next) => {
    setEnabled(next);
    persistSel(next);
    load(date, next);
  };

  const toggleFactor = (key) => {
    const allKeys = factors.map(f => f.key);
    if (!allKeys.length) return;
    const base = enabled || new Set(allKeys);
    const next = new Set(base);
    if (next.has(key)) {
      if (next.size <= 1) return;            // 至少保留一個因素
      next.delete(key);
    } else {
      next.add(key);
    }
    applySel(next.size >= allKeys.length ? null : next);   // 全選 = null
  };

  const enabledCount = enabled ? enabled.size : factors.length;

  return (
    <div className="ai-page">
      <div className="ai-head">
        <div>
          <h1 className="ai-title">AI 分析</h1>
          <p className="ai-sub">
            按《計得精彩 — Statistical and Mathematical Methods in Horse Racing》方法建立的
            因素評分 + 正態分布機會率模型。所有分數可追溯至具體因素。
          </p>
        </div>
        <div className="ai-head-right">
          <input type="date" className="ai-date" value={date} onChange={e => setDate(e.target.value)} />
          <button className="ai-btn" onClick={() => load(date)} disabled={analyze.loading}>
            {analyze.loading ? '分析中…' : '分析'}
          </button>
          <button
            className={`ai-btn ai-btn-ghost ${enabled ? 'is-partial' : ''}`}
            onClick={() => setShowPicker(v => !v)}
            title="剔選要參與評分嘅因素"
          >
            因素剔選{factors.length ? `（${enabledCount}/${factors.length}）` : ''}
          </button>
        </div>
      </div>

      {showPicker && (
        <FactorPicker
          factors={factors}
          enabled={enabled}
          onToggle={toggleFactor}
          onAll={() => applySel(null)}
          onClose={() => setShowPicker(false)}
        />
      )}

      <div className="ai-tabs">
        {TABS.map(t => (
          <button key={t.key} className={`ai-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {analyze.error && <div className="ai-error">{analyze.error}</div>}
      {analyze.loading && <div className="ai-empty">載入中，首次分析需計算歷史統計…</div>}
      {!analyze.loading && !analyze.error && (
        <>
          {tab === 'picks' && analyze.data && (analyze.data.races?.length
            ? <PicksTab data={analyze.data} />
            : <div className="ai-empty">{analyze.data.message || '該日期沒有排位表資料'}</div>)}
          {tab === 'factors' && analyze.data && analyze.data.races?.length && <FactorsTab data={analyze.data} factors={factors} />}
          {tab === 'r2' && <R2Tab factorSel={enabled} factorTotal={factors.length || 26} />}
          {tab === 'method' && <MethodTab factors={factors} bench={bench} />}
        </>
      )}
    </div>
  );
}
