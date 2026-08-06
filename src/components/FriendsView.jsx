import { useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { STATUSES } from '../hooks/usePresence';

const initials = (n) => (n || '?').slice(0, 2).toUpperCase();

export default function FriendsView({ profile, contacts, requests, outgoing, peers, onRefresh, onOpenChat, onCall }) {
  const [tab, setTab] = useState('online');
  const [nick, setNick] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const online = useMemo(
    () => contacts.filter((c) => peers?.[c.id] && peers[c.id].status !== 'invisible'),
    [contacts, peers]
  );

  const addFriend = async () => {
    const target = nick.trim();
    if (!target) return;
    setBusy(true);
    setMsg(null);
    try {
      const { data: found, error } = await supabase
        .from('profiles')
        .select('id, display_name, username')
        .ilike('username', target)
        .maybeSingle();
      if (error) throw error;
      if (!found) {
        setMsg({ bad: true, text: 'Хм, такого ника нет. Проверьте написание.' });
        return;
      }
      if (found.id === profile.id) {
        setMsg({ bad: true, text: 'Это вы. Добавьте кого-нибудь другого.' });
        return;
      }
      const { error: insErr } = await supabase
        .from('contacts')
        .insert({ user_id: profile.id, contact_id: found.id, status: 'pending' });
      if (insErr) {
        setMsg({
          bad: true,
          text: insErr.code === '23505' ? 'Заявка этому человеку уже отправлена.' : insErr.message,
        });
        return;
      }
      setMsg({ bad: false, text: `Заявка отправлена — ${found.display_name}` });
      setNick('');
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const accept = async (r) => {
    await supabase.from('contacts').update({ status: 'accepted' }).eq('id', r.rowId);
    await supabase.from('contacts').insert({ user_id: profile.id, contact_id: r.id, status: 'accepted' });
    onRefresh();
  };

  const remove = async (rowId) => {
    await supabase.from('contacts').delete().eq('id', rowId);
    onRefresh();
  };

  const Row = ({ person, sub, children }) => {
    const p = peers?.[person.id];
    const color = p ? STATUSES[p.status]?.color ?? '#7a7d8a' : '#7a7d8a';
    return (
      <div className="fr-row">
        <span className="avatar big">
          {initials(person.display_name)}
          <span className="up-dot small" style={{ background: color }} />
        </span>
        <span className="fr-text">
          <span className="fr-name">{person.display_name}</span>
          <span className="fr-sub">{sub}</span>
        </span>
        <span className="fr-actions">{children}</span>
      </div>
    );
  };

  const statusText = (id) => {
    const p = peers?.[id];
    if (!p) return 'Не в сети';
    return p.activity ? `Играет в ${p.activity}` : STATUSES[p.status]?.label ?? 'В сети';
  };

  const tabs = [
    { key: 'online', label: 'В сети', count: online.length },
    { key: 'all', label: 'Все', count: contacts.length },
    { key: 'pending', label: 'Ожидание', count: requests.length + outgoing.length },
  ];

  return (
    <main className="friends">
      <header className="fr-head">
        <span className="fr-title">Друзья</span>
        <span className="fr-sep" />
        {tabs.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? 'fr-tab active' : 'fr-tab'}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.count > 0 && <span className="fr-badge">{t.count}</span>}
          </button>
        ))}
        <button
          className={tab === 'add' ? 'fr-add-btn active' : 'fr-add-btn'}
          onClick={() => setTab('add')}
        >
          Добавить в друзья
        </button>
      </header>

      <div className="fr-body">
        {tab === 'add' && (
          <div className="fr-add">
            <h2>Добавить в друзья</h2>
            <p className="muted">Здесь можно добавить друга по нику.</p>
            <div className={msg ? (msg.bad ? 'fr-input bad' : 'fr-input good') : 'fr-input'}>
              <input
                value={nick}
                onChange={(e) => {
                  setNick(e.target.value);
                  setMsg(null);
                }}
                onKeyDown={(e) => e.key === 'Enter' && addFriend()}
                placeholder="Введите ник пользователя"
              />
              <button disabled={busy || !nick.trim()} onClick={addFriend}>
                Отправить заявку
              </button>
            </div>
            {msg && <div className={msg.bad ? 'fr-msg bad' : 'fr-msg good'}>{msg.text}</div>}
            <div className="fr-own-nick">
              Ваш ник: <b>{profile.username ?? profile.email?.split('@')[0]}</b> — скажите его друзьям,
              чтобы они смогли вас найти.
            </div>
          </div>
        )}

        {tab === 'online' && (
          <>
            <div className="fr-label">Сейчас в сети — {online.length}</div>
            {online.length === 0 && <div className="empty">Пока никого нет в сети.</div>}
            {online.map((c) => (
              <Row key={c.id} person={c} sub={statusText(c.id)}>
                <button className="fr-icon" onClick={() => onOpenChat(c)} title="Написать">
                  ✉
                </button>
                <button className="fr-icon" onClick={() => onCall(c)} title="Позвонить">
                  ✆
                </button>
              </Row>
            ))}
          </>
        )}

        {tab === 'all' && (
          <>
            <div className="fr-label">Все друзья — {contacts.length}</div>
            {contacts.length === 0 && <div className="empty">Список пуст. Добавьте кого-нибудь по нику.</div>}
            {contacts.map((c) => (
              <Row key={c.id} person={c} sub={statusText(c.id)}>
                <button className="fr-icon" onClick={() => onOpenChat(c)} title="Написать">
                  ✉
                </button>
                <button className="fr-icon" onClick={() => onCall(c)} title="Позвонить">
                  ✆
                </button>
                <button className="fr-icon danger" onClick={() => remove(c.rowId)} title="Удалить">
                  ✕
                </button>
              </Row>
            ))}
          </>
        )}

        {tab === 'pending' && (
          <>
            <div className="fr-label">Входящие заявки — {requests.length}</div>
            {requests.length === 0 && <div className="empty">Входящих заявок нет.</div>}
            {requests.map((r) => (
              <Row key={r.rowId} person={r} sub="Хочет добавить вас в друзья">
                <button className="fr-icon ok" onClick={() => accept(r)} title="Принять">
                  ✓
                </button>
                <button className="fr-icon danger" onClick={() => remove(r.rowId)} title="Отклонить">
                  ✕
                </button>
              </Row>
            ))}

            <div className="fr-label">Отправленные — {outgoing.length}</div>
            {outgoing.length === 0 && <div className="empty">Отправленных заявок нет.</div>}
            {outgoing.map((r) => (
              <Row key={r.rowId} person={r} sub="Ожидает подтверждения">
                <button className="fr-icon danger" onClick={() => remove(r.rowId)} title="Отменить">
                  ✕
                </button>
              </Row>
            ))}
          </>
        )}
      </div>
    </main>
  );
}
