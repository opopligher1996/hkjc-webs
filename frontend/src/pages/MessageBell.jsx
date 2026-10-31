import React, { useState, useEffect } from 'react';
import api from '../api';

export default function MessageBell() {
  const [messages, setMessages] = useState([]);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(parseInt(localStorage.getItem('msg_seen') || '0'));

  useEffect(() => {
    let stop = false;
    const load = () => {
      api.get('/messages').then(r => {
        if (!stop) setMessages(r.data.messages || []);
      }).catch(() => {});
    };
    load();
    const iv = setInterval(load, 60000);
    return () => { stop = true; clearInterval(iv); };
  }, []);

  const unread = messages.filter(m => new Date(m.created_at).getTime() > seen).length;

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => { setOpen(!open); if (messages.length) { setSeen(Date.now()); localStorage.setItem('msg_seen', String(Date.now())); } }}
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.1rem', color: '#fff', position: 'relative', padding: '0 4px' }}
        title="訊息"
      >🔔{unread > 0 && <span style={{ position: 'absolute', top: -4, right: -4, background: '#dc3545', color: '#fff', borderRadius: '50%', fontSize: '0.6rem', width: 15, height: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>{unread}</span>}</button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: 30, width: 320, maxHeight: 400, overflowY: 'auto', background: '#fff', borderRadius: 10, boxShadow: '0 8px 30px rgba(0,0,0,0.25)', zIndex: 2000, padding: 12 }}>
          <div style={{ fontWeight: 800, color: '#032169', marginBottom: 8, fontSize: '0.9rem' }}>📣 訊息</div>
          {!messages.length && <div style={{ color: '#999', fontSize: '0.8rem', padding: 8 }}>暫時冇訊息</div>}
          {messages.map(m => (
            <div key={m.id} style={{ borderBottom: '1px solid #eee', padding: '8px 4px' }}>
              <div style={{ fontSize: '0.85rem' }}>{m.message}</div>
              <div style={{ fontSize: '0.68rem', color: '#99a', marginTop: 3 }}>
                {m.from_admin === 'system' ? '' : '管理員 '}· {new Date(m.created_at).toLocaleString('zh-HK')}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
