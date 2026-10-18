import React from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import JockeyPage from './pages/JockeyPage';
import TrainerPage from './pages/TrainerPage';
import DrawPage from './pages/DrawPage';
import RacecardPage from './pages/RacecardPage';
import AdvancedRacecardPage from './pages/AdvancedRacecardPage';
import OverseasRacecardPage from './pages/OverseasRacecardPage';
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

export default function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <nav className="nav">
          <a className="nav-brand" href="/">LEGACY</a>
          <ul className="nav-links">
            <li><NavLink to="/" end>騎師資料</NavLink></li>
            <li><NavLink to="/trainers">練馬師資料</NavLink></li>
            <li><NavLink to="/draw">檔位搜尋</NavLink></li>
            <li><NavLink to="/racecard">本地排位表</NavLink></li>
            <li><NavLink to="/advanced-racecard">高級排位表</NavLink></li>
            <li><NavLink to="/overseas-racecard">海外排位表</NavLink></li>
            <li><NavLink to="/entries">報名表</NavLink></li>
            <li><NavLink to="/horses">馬匹資料</NavLink></li>
            <li><NavLink to="/coursetime">跑道標準時間</NavLink></li>
            <li><NavLink to="/ai-data">數據庫</NavLink></li>
            <li><NavLink to="/pace">步速分析</NavLink></li>
            <li><NavLink to="/ai-analysis">AI分析</NavLink></li>
            <li><NavLink to="/analysis">分析</NavLink></li>
            <li><NavLink to="/corner">分析角球</NavLink></li>
            <li><NavLink to="/goals">入球分析</NavLink></li>
            <li><NavLink to="/hda">主客和分析</NavLink></li>
          </ul>
        </nav>

        <main className="main-content">
          <Routes>
            <Route path="/" element={<JockeyPage />} />
            <Route path="/trainers" element={<TrainerPage />} />
            <Route path="/draw" element={<DrawPage />} />
            <Route path="/racecard" element={<RacecardPage />} />
            <Route path="/advanced-racecard" element={<AdvancedRacecardPage />} />
            <Route path="/overseas-racecard" element={<OverseasRacecardPage />} />
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
          </Routes>
        </main>

        <footer style={{ background: '#032169', color: 'rgba(255,255,255,0.7)', padding: '12px 24px', textAlign: 'center', fontSize: '0.8rem' }}>
          數據來源：香港賽馬會 racing.hkjc.com
        </footer>
      </div>
    </BrowserRouter>
  );
}
