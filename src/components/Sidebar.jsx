import { useState } from 'react';
import { STATUSES } from '../hooks/usePresence';
import Icon from './Icons';
import Avatar from './Avatar';
import UserPanel from './UserPanel';

export default function Sidebar({
  profile,
  contacts,
  requests,
  active,
  view,
  peers,
  unread = {},
  rooms = [],
  activeRoom,
  unreadRooms = {},
  myStatus,
  callApi,
  groupCallApi,
  deafened,
  onToggleDeafen,
  onSpkVolume,
  onChangeStatus,
  onProfileChange,
  onSelect,
  onSelectRoom,
  onCreateGroup,
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
        <span className="sb-nav-icon">
          <Icon name="users" size={17} />
        </span>
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
          const n = unread[c.id] ?? 0;
          const cls =
            (active?.id === c.id && view === 'chat' ? 'contact active' : 'contact') +
            (n > 0 ? ' has-unread' : '');
          return (
            <button key={c.id} className={cls} onClick={() => onSelect(c)}>
              <Avatar person={c} color={color} dotClass="up-dot small" />
              <span className="contact-text">
                <span className="contact-name">{c.display_name}</span>
                <span className="contact-sub">{sub}</span>
              </span>
              {n > 0 && <span className="unread-badge">{n > 99 ? '99+' : n}</span>}
            </button>
          );
        })}
      </div>

      <div className="section-label">
        Группы
        <button className="section-add" onClick={onCreateGroup} title="Создать группу">
          <Icon name="plus" size={14} />
        </button>
      </div>

      <div className="contact-list">
        {rooms.length === 0 && <div className="empty">Нет групп. Создайте свою!</div>}
        {rooms
          .filter((r) => r.name.toLowerCase().includes(q.trim().toLowerCase()))
          .map((r) => {
            const n = unreadRooms[r.id] ?? 0;
            const cls =
              (activeRoom?.id === r.id && view === 'room' ? 'contact active' : 'contact') +
              (n > 0 ? ' has-unread' : '');
            return (
              <button key={r.id} className={cls} onClick={() => onSelectRoom(r)}>
                <span className="avatar group-avatar">
                  <Icon name="users" size={16} />
                </span>
                <span className="contact-text">
                  <span className="contact-name">{r.name}</span>
                </span>
                {n > 0 && <span className="unread-badge">{n > 99 ? '99+' : n}</span>}
              </button>
            );
          })}
      </div>

      <UserPanel
        profile={profile}
        myStatus={myStatus}
        callApi={callApi}
        groupCallApi={groupCallApi}
        deafened={deafened}
        onToggleDeafen={onToggleDeafen}
        onSpkVolume={onSpkVolume}
        onChangeStatus={onChangeStatus}
        onProfileChange={onProfileChange}
        onSignOut={onSignOut}
      />
      <div className="sb-version">Scalable Chat v1.2.2</div>
    </aside>
  );
}
