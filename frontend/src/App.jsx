import React, { useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import JockeyPage from './pages/JockeyPage';
import TrainerPage from './pages/TrainerPage';
import DrawPage from './pages/DrawPage';
import RacecardPage from './pages/RacecardPage';
import AdvancedRacecardPage from './pages/AdvancedRacecardPage';
import HorsePage from './pages/HorsePage';
import CourseTimePage from './pages/CourseTimePage';
import AiDataPage from './pages/AiDataPage';
import AiAnalysisPage from './pages/AiAnalysisPage';
import PaceAnalysisPage from './pages/PaceAnalysisPage';
import AnalysisPage from './pages/AnalysisPage';
import CornerAnalysisPage from './pages/CornerAnalysisPage';
import GoalAnalysisPage from './pages/GoalAnalysisPage';
import HDAAnalysisPage from './pages/HDAAnalysisPage';
import EntriesPage from './pages/EntriesPage';
import LoginPage from './pages/LoginPage';
import UserAdminPage from './pages/UserAdminPage';
import MessageBell from './pages/MessageBell';
import HDAUserPage from './pages/HDAUserPage';
import { getMe } from './api';

const RACING_LINKS = [
  { to: '/entries', label: '報名表' },
  { to: '/racecard', label: '本地排位表' },
  { to: '/advanced-racecard', label: '高級排位表' },
  { to: '/ai-data', label: '數據庫' },
  { to: '/jockeys', label: '騎師資料' },
  { to: '/trainers', label: '練馬師資料' },
  { to: '/draw', label: '檔位搜尋' },
  { to: '/horses', label: '馬匹資料' },
  { to: '/coursetime', label: '跑道標準時間' },
  { to: '/pace', label: '步速分析' },
  { to: '/ai-analysis', label: 'AI 分析' },
  { to: '/analysis', label: '分析' },
];

const FOOTBALL_LINKS = [
  { to: '/corner', label: '分析角球' },
  { to: '/goals', label: '入球分析' },
  { to: '/hda', label: '主客和分析' },
  { to: '/hda-user', label: '主客和分析（用戶版）' },
];
const ADMIN_LINKS = [
  { to: '/users', label: '後台・用戶管理' },
];

export default function App() {
  const [section, setSection] = useState('football');
  // 帳號系統：undefined = 驗證中・null = 未登入
  const [user, setUser] = useState(undefined);
  React.useEffect(() => {
    const t = localStorage.getItem('auth_token');
    if (!t) return setUser(null);
    getMe().then(r => setUser(r.user)).catch(() => setUser(null));
  }, []);
  const logout = () => {
    localStorage.removeItem('auth_token');
    setUser(null);
  };
  const links = section === 'racing' ? RACING_LINKS : FOOTBALL_LINKS;
  const barColor = section === 'racing' ? '#032169' : '#145a23';

  if (user === undefined) {
    return <div style={{ minHeight: '100vh', background: '#032169', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.9rem' }}>驗證中…</div>;
  }
  if (!user) return <LoginPage onLogin={setUser} />;

  return (
    <BrowserRouter>
      <div className="app">
        <header style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
          {/* 上層：品牌 + 分區切換 */}
          <nav style={{
            display: 'flex',
            alignItems: 'center',
            gap: 0,
            background: '#0d1b3e',
            padding: '0 20px',
            height: 44,
            minWidth: 'fit-content',
          }}>
            <a className="nav-brand" href="/" style={{
              color: '#fff',
              fontSize: '1.05rem',
              fontWeight: 800,
              textDecoration: 'none',
              letterSpacing: 2,
              marginRight: 16,
              whiteSpace: 'nowrap',
            }}>LEGACY.ai</a>

            <div style={{ display: 'flex', gap: 2, height: '100%' }}>
              <button
                onClick={() => setSection('racing')}
                style={{
                  padding: '0 18px',
                  fontSize: '0.8rem',
                  fontWeight: 700,
                  border: 'none',
                  cursor: 'pointer',
                  background: section === 'racing' ? '#032169' : 'transparent',
                  color: section === 'racing' ? '#fff' : 'rgba(255,255,255,0.5)',
                  borderBottom: section === 'racing' ? '2px solid #5b9bd5' : '2px solid transparent',
                  transition: 'all 0.15s',
                }}
              >🐎 賽馬資訊</button>
              <button
                onClick={() => setSection('football')}
                style={{
                  padding: '0 18px',
                  fontSize: '0.8rem',
                  fontWeight: 700,
                  border: 'none',
                  cursor: 'pointer',
                  background: section === 'football' ? '#145a23' : 'transparent',
                  color: section === 'football' ? '#fff' : 'rgba(255,255,255,0.5)',
                  borderBottom: section === 'football' ? '2px solid #4caf50' : '2px solid transparent',
                  transition: 'all 0.15s',
                }}
              >⚽ 足球資訊</button>
            </div>

            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
              <MessageBell />
              <span style={{ color: 'rgba(255,255,255,0.65)', fontSize: '0.75rem' }}>
                👤 {user.username}{user.role === 'admin' ? '（admin）' : ''}
              </span>
              <button
                onClick={logout}
                style={{
                  padding: '4px 12px', fontSize: '0.72rem', fontWeight: 700,
                  border: '1px solid rgba(255,255,255,0.35)', borderRadius: 6,
                  background: 'transparent', color: 'rgba(255,255,255,0.85)', cursor: 'pointer',
                }}
              >登出</button>
            </div>
          </nav>

          {/* 下層：功能連結 */}
          <nav style={{
            display: 'flex',
            alignItems: 'center',
            background: barColor,
            padding: '0 12px',
            height: 38,
            minWidth: 'fit-content',
            overflowX: 'auto',
          }}>
            {user.role === 'admin' && section === 'football' && ADMIN_LINKS.map(l => (
              <NavLink key={l.to} to={l.to} style={({ isActive }) => ({ padding: '0 12px', fontSize: '0.78rem', fontWeight: 700, color: isActive ? '#ffd700' : 'rgba(255,255,255,0.6)', textDecoration: 'none', whiteSpace: 'nowrap' })}>{l.label}</NavLink>
            ))}
            {links.map(l => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                onClick={() => setSection(/^\/(corner|goals|hda)/.test(l.to) ? 'football' : 'racing')}
                style={({ isActive }) => ({
                  color: isActive ? '#fff' : 'rgba(255,255,255,0.65)',
                  textDecoration: 'none',
                  padding: '0 14px',
                  fontSize: '0.82rem',
                  fontWeight: isActive ? 700 : 400,
                  height: 38,
                  lineHeight: '38px',
                  whiteSpace: 'nowrap',
                  borderRadius: 0,
                  background: isActive ? 'rgba(255,255,255,0.12)' : 'transparent',
                  borderBottom: isActive ? '2px solid #fff' : '2px solid transparent',
                  transition: 'all 0.15s',
                })}
              >{l.label}</NavLink>
            ))}
          </nav>
        </header>

        <main className="main-content">
          <Routes>
            <Route path="/" element={<HDAAnalysisPage />} />
            <Route path="/jockeys" element={<JockeyPage />} />
            <Route path="/trainers" element={<TrainerPage />} />
            <Route path="/draw" element={<DrawPage />} />
            <Route path="/racecard" element={<RacecardPage />} />
            <Route path="/advanced-racecard" element={<AdvancedRacecardPage />} />
            <Route path="/entries" element={<EntriesPage />} />
            <Route path="/horses" element={<HorsePage />} />
            <Route path="/coursetime" element={<CourseTimePage />} />
            <Route path="/ai-data" element={<AiDataPage />} />
            <Route path="/pace" element={<PaceAnalysisPage />} />
            <Route path="/ai-analysis" element={<AiAnalysisPage />} />
            <Route path="/analysis" element={<AnalysisPage />} />
            <Route path="/corner" element={<CornerAnalysisPage />} />
            <Route path="/goals" element={<GoalAnalysisPage />} />
            <Route path="/hda" element={<HDAAnalysisPage />} />
            <Route path="/hda-user" element={<HDAUserPage />} />
            {user.role === "admin" && <Route path="/users" element={<UserAdminPage user={user} />} />}
          </Routes>
        </main>

        <footer style={{ background: '#0d1b3e', color: 'rgba(255,255,255,0.5)', padding: '10px 24px', textAlign: 'center', fontSize: '0.75rem' }}>
          數據來源來自上帝
        </footer>
      </div>
    </BrowserRouter>
  );
}
