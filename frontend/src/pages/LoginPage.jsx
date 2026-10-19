import React, { useState } from 'react';
import { login } from '../api';

export default function LoginPage({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async e => {
    e.preventDefault();
    if (!username || !password) return setError('請輸入用戶名同密碼');
    setBusy(true); setError(null);
    try {
      const r = await login(username.trim(), password);
      localStorage.setItem('auth_token', r.token);
      onLogin(r.user);
    } catch (err) {
      setError(err.response?.data?.error || '登入失敗，請再試');
    } finally { setBusy(false); }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(160deg, #032169 0%, #02144a 60%, #010d33 100%)',
      padding: 20,
    }}>
      <form onSubmit={submit} style={{
        background: '#fff', borderRadius: 14, padding: '38px 36px', width: 360,
        boxShadow: '0 18px 60px rgba(0,0,0,.45)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 26 }}>
          <div style={{ fontSize: '2rem', fontWeight: 900, letterSpacing: 2, color: '#032169' }}>
            LEGACY
          </div>
          <div style={{ fontSize: '0.78rem', color: '#889', marginTop: 4 }}>
            賽馬・足球數據分析平台
          </div>
        </div>
        <label style={{ display: 'block', fontSize: '0.8rem', color: '#445', marginBottom: 4 }}>用戶名</label>
        <input
          value={username} onChange={e => setUsername(e.target.value)} autoFocus
          autoComplete="username"
          style={{
            width: '100%', boxSizing: 'border-box', padding: '10px 12px', marginBottom: 14,
            border: '1px solid #ccd5e0', borderRadius: 8, fontSize: '0.95rem', outline: 'none',
          }}
        />
        <label style={{ display: 'block', fontSize: '0.8rem', color: '#445', marginBottom: 4 }}>密碼</label>
        <input
          type="password" value={password} onChange={e => setPassword(e.target.value)}
          autoComplete="current-password"
          style={{
            width: '100%', boxSizing: 'border-box', padding: '10px 12px', marginBottom: 18,
            border: '1px solid #ccd5e0', borderRadius: 8, fontSize: '0.95rem', outline: 'none',
          }}
        />
        {error && (
          <div style={{ color: '#c0392b', fontSize: '0.8rem', marginBottom: 12, textAlign: 'center' }}>
            {error}
          </div>
        )}
        <button type="submit" disabled={busy} style={{
          width: '100%', padding: '11px 0', border: 'none', borderRadius: 8,
          background: busy ? '#7a8bb0' : '#032169', color: '#fff',
          fontSize: '0.95rem', fontWeight: 700, cursor: busy ? 'default' : 'pointer',
        }}>
          {busy ? '登入中…' : '登入'}
        </button>
        <div style={{ textAlign: 'center', marginTop: 18, fontSize: '0.68rem', color: '#aab' }}>
          🔒 私人系統・請勿分享帳號
        </div>
      </form>
    </div>
  );
}
