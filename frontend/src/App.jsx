import React from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import JockeyPage from './pages/JockeyPage';
import TrainerPage from './pages/TrainerPage';
import DrawPage from './pages/DrawPage';
import RacecardPage from './pages/RacecardPage';
import HorsePage from './pages/HorsePage';
import CourseTimePage from './pages/CourseTimePage';
import TrackworkPage from './pages/TrackworkPage';

export default function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <nav className="nav">
          <a className="nav-brand" href="/">HKJC 賽馬資訊</a>
          <ul className="nav-links">
            <li><NavLink to="/" end>騎師資料</NavLink></li>
            <li><NavLink to="/trainers">練馬師資料</NavLink></li>
            <li><NavLink to="/draw">檔位搜尋</NavLink></li>
            <li><NavLink to="/racecard">排位表</NavLink></li>
            <li><NavLink to="/horses">馬匹資料</NavLink></li>
            <li><NavLink to="/coursetime">跑道標準時間</NavLink></li>
            <li><NavLink to="/trackwork">馬匹晨操</NavLink></li>
          </ul>
        </nav>

        <main className="main-content">
          <Routes>
            <Route path="/" element={<JockeyPage />} />
            <Route path="/trainers" element={<TrainerPage />} />
            <Route path="/draw" element={<DrawPage />} />
            <Route path="/racecard" element={<RacecardPage />} />
            <Route path="/horses" element={<HorsePage />} />
            <Route path="/coursetime" element={<CourseTimePage />} />
            <Route path="/trackwork" element={<TrackworkPage />} />
          </Routes>
        </main>

        <footer style={{ background: '#032169', color: 'rgba(255,255,255,0.7)', padding: '12px 24px', textAlign: 'center', fontSize: '0.8rem' }}>
          數據來源：香港賽馬會 racing.hkjc.com
        </footer>
      </div>
    </BrowserRouter>
  );
}
