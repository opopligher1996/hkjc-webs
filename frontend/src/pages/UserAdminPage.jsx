import React, { useState, useEffect } from 'react';
import api from '../api';

export default function UserAdminPage({ user }) {
  const [users, setUsers] = useState([]);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState(null);
  const [nu, setNu] = useState({ username: '', password: '', role: 'user' });
  const [msgTarget, setMsgTarget] = useState('all');
  const [msgText, setMsgText] = useState('');

  const load = async () => {
    try {
      const r = await api.get('/users');
      setUsers(r.data.users || []);
    } catch (e) { setError(e.response?.data?.error || e.message); }
  };
  useEffect(() => { load(); }, []);

  const addUser = async () => {
    setError(null);
    try {
      await api.post('/users', nu);
      setNu({ username: '', password: '', role: 'user' });
      setMsg('✓ 用戶已新增');
      load();
    } catch (e) { setError(e.response?.data?.error || e.message); }
  };

  const delUser = async (id, username) => {
    if (!confirm('刪除用戶 ' + username + '？')) return;
    try { await api.delete('/users/' + id); load(); } catch (e) { setError(e.response?.data?.error || e.message); }
  };

  const sendMsg = async () => {
    setError(null);
    try {
      await api.post('/users/' + msgTarget + '/message', { message: msgText });
      setMsg('✓ 訊息已發送');
      setMsgText('');
    } catch (e) { setError(e.response?.data?.error || e.message); }
  };

  return (
    <div>
      <h1 className="page-title">後台・用戶管理</h1>
      {msg && <div style={{ background: '#d4edda', color: '#155724', padding: '8px 12px', borderRadius: 6, marginBottom: 10 }}>{msg}</div>}
      {error && <div style={{ background: '#f8d7da', color: '#721c24', padding: '8px 12px', borderRadius: 6, marginBottom: 10 }}>{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>➕ 新增用戶</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input placeholder="用戶名" value={nu.username} onChange={e => setNu({ ...nu, username: e.target.value })} style={{ padding: '8px 10px', border: '1px solid #ccd5e0', borderRadius: 6 }} />
          <input placeholder="密碼（≥6位）" type="password" value={nu.password} onChange={e => setNu({ ...nu, password: e.target.value })} style={{ padding: '8px 10px', border: '1px solid #ccd5e0', borderRadius: 6 }} />
          <select value={nu.role} onChange={e => setNu({ ...nu, role: e.target.value })} style={{ padding: '8px 10px', border: '1px solid #ccd5e0', borderRadius: 6 }}>
            <option value="user">用戶</option>
            <option value="admin">Admin</option>
          </select>
          <button className="btn btn-success" onClick={addUser}>新增</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>📣 發送訊息</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={msgTarget} onChange={e => setMsgTarget(e.target.value)} style={{ padding: '8px 10px', border: '1px solid #ccd5e0', borderRadius: 6 }}>
            <option value="all">📢 全部用戶（廣播）</option>
            {users.map(u => <option key={u.id} value={u.id}>👤 {u.username}</option>)}
          </select>
          <input placeholder="訊息內容" value={msgText} onChange={e => setMsgText(e.target.value)} style={{ flex: 1, minWidth: 200, padding: '8px 10px', border: '1px solid #ccd5e0', borderRadius: 6 }} />
          <button className="btn btn-success" onClick={sendMsg} disabled={!msgText}>發送</button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>👥 用戶列表（{users.length}）</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr style={{ background: '#f0f4ff', textAlign: 'left' }}>
              <th style={{ padding: '8px 10px' }}>ID</th>
              <th style={{ padding: '8px 10px' }}>用戶名</th>
              <th style={{ padding: '8px 10px' }}>角色</th>
              <th style={{ padding: '8px 10px' }}>建立日期</th>
              <th style={{ padding: '8px 10px' }}></th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '8px 10px' }}>{u.id}</td>
                <td style={{ padding: '8px 10px', fontWeight: 700 }}>{u.username}</td>
                <td style={{ padding: '8px 10px' }}>{u.role === 'admin' ? '🔑 admin' : '用戶'}</td>
                <td style={{ padding: '8px 10px', color: '#888' }}>{String(u.created_at || '').slice(0, 10)}</td>
                <td style={{ padding: '8px 10px' }}>
                  {u.username !== user.username && (
                    <button onClick={() => delUser(u.id, u.username)} style={{ background: '#dc3545', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 10px', cursor: 'pointer' }}>刪除</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
