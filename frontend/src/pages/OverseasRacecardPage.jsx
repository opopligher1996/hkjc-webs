import React, { useState, useRef } from 'react';

const BASE_URL = 'https://bet.hkjc.com/ch/racing/home';

// Today in YYYY-MM-DD
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export default function OverseasRacecardPage() {
  const [date, setDate] = useState(todayStr());
  const [meeting, setMeeting] = useState('S1');
  const [race, setRace] = useState(1);
  const [iframeError, setIframeError] = useState(false);
  const iframeRef = useRef(null);

  const iframeUrl = `${BASE_URL}/${date}/${meeting}/${race}`;

  function handleLoad() {
    setIframeError(false);
  }

  function handleError() {
    setIframeError(true);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)', padding: '0 0 0 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', background: '#f5f7fa', borderBottom: '1px solid #dde', flexWrap: 'wrap' }}>
        <h1 className="page-title" style={{ margin: 0, fontSize: '1.2rem' }}>海外排位表</h1>

        <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>日期：
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            style={{ marginLeft: 4, padding: '3px 6px', borderRadius: 4, border: '1px solid #ccc', fontSize: '0.85rem' }}
          />
        </label>

        <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>場次編號：
          <input
            type="text"
            value={meeting}
            onChange={e => setMeeting(e.target.value.toUpperCase())}
            placeholder="e.g. S1"
            style={{ marginLeft: 4, width: 60, padding: '3px 6px', borderRadius: 4, border: '1px solid #ccc', fontSize: '0.85rem' }}
          />
        </label>

        <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>場次：
          <input
            type="number"
            min={1}
            max={20}
            value={race}
            onChange={e => setRace(Number(e.target.value))}
            style={{ marginLeft: 4, width: 55, padding: '3px 6px', borderRadius: 4, border: '1px solid #ccc', fontSize: '0.85rem' }}
          />
        </label>

        <a
          href={iframeUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ marginLeft: 'auto', fontSize: '0.82rem', color: '#032169', textDecoration: 'underline' }}
        >
          在新分頁開啟
        </a>
      </div>

      {iframeError && (
        <div style={{ padding: '16px', background: '#fff3cd', color: '#856404', fontSize: '0.9rem', textAlign: 'center' }}>
          無法載入頁面。請嘗試
          <a href={iframeUrl} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 4, color: '#032169', fontWeight: 600 }}>
            在新分頁開啟
          </a>
          。
        </div>
      )}

      <iframe
        ref={iframeRef}
        src={iframeUrl}
        title="海外排位表"
        onLoad={handleLoad}
        onError={handleError}
        style={{
          flex: 1,
          width: '100%',
          border: 'none',
          display: 'block',
        }}
        allowFullScreen
      />
    </div>
  );
}
