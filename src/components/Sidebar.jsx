import { useState } from 'react';
import { STATUSES } from '../hooks/usePresence';
import UserPanel from './UserPanel';

const initials = (n) => (n || '?').slice(0, 2).toUpperCase();

export default function Sidebar({
  profile,
  contacts,
  requests,
  active,
  view,
  peers,
  myStatus,
  callApi,
  deafened,
  onToggleDeafen,
  onSpkVolume,
  onChangeStatus,
  onProfileChange,
  onSelect,
  onOpenFriends,
  onSignOut,
}) {
  const [q, setQ] = useState('');

  const list = contacts.filter((c) =>
    (c.display_name + ' ' + (c.username ?? '')).toLowerCase().includes(q.trim().toLowerCase())
  );

  return (
    <aside className="sidebar">
      <div className="sb-search">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Найти или начать беседу"
        />
      </div>

      <button
        className={view === 'friends' ? 'sb-nav active' : 'sb-nav'}
        onClick={onOpenFriends}
      >
        <span className="sb-nav-icon">👥</span>
        Друзья
        {requests.length > 0 && <span className="sb-badge">{requests.length}</span>}
      </button>

      <div className="section-label">Личные сообщения</div>

      <div className="contact-list">
        {list.length === 0 && <div className="empty">Пусто. Добавьте друга по нику.</div>}
        {list.map((c) => {
          const p = peers?.[c.id];
          const color = p ? STATUSES[p.status]?.color ?? '#7a7d8a' : '#7a7d8a';
          const sub = p ? (p.activity ? `Играет в ${p.activity}` : STATUSES[p.status]?.label) : 'Не в сети';
          return (
            <button
              key={c.id}
              className={active?.id === c.id && view === 'chat' ? 'contact active' : 'contact'}
              onClick={() => onSelect(c)}
            >
              <span className="avatar">
                {initials(c.display_name)}
                <span className="up-dot small" style={{ background: color }} />
              </span>
              <span className="contact-text">
                <span className="contact-name">{c.display_name}</span>
                <span className="contact-sub">{sub}</span>
              </span>
            </button>
          );
        })}
      </div>

      <UserPanel
        profile={profile}
        myStatus={myStatus}
        callApi={callApi}
        deafened={deafened}
        onToggleDeafen={onToggleDeafen}
        onSpkVolume={onSpkVolume}
        onChangeStatus={onChangeStatus}
        onProfileChange={onProfileChange}
        onSignOut={onSignOut}
      />
    </aside>
  );
}
