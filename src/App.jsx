import { useCallback, useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import { desktop } from './lib/desktop';
import { useCall } from './hooks/useCall';
import { usePresence } from './hooks/usePresence';
import Auth from './components/Auth';
import Sidebar from './components/Sidebar';
import ChatWindow from './components/ChatWindow';
import FriendsView from './components/FriendsView';

export default function App() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [requests, setRequests] = useState([]);
  const [outgoing, setOutgoing] = useState([]);
  const [unread, setUnread] = useState({});
  const [active, setActive] = useState(null);
  const [view, setView] = useState('friends');
  const [deafened, setDeafened] = useState(false);
  const [spkVolume, setSpkVolume] = useState(
    () => Number(localStorage.getItem('chat.spkVolume') ?? 100)
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const loadProfile = useCallback(async (userId) => {
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (data) {
      setProfile(data);
      return;
    }
    // Профиля нет (например, не сработал триггер) — создаём сами
    const { data: u } = await supabase.auth.getUser();
    const email = u?.user?.email ?? '';
    const display =
      u?.user?.user_metadata?.full_name ?? u?.user?.user_metadata?.name ?? email.split('@')[0] ?? 'user';
    const { data: created } = await supabase
      .from('profiles')
      .insert({ id: userId, email, display_name: display })
      .select()
      .maybeSingle();
    if (created) setProfile(created);
  }, []);

  const loadContacts = useCallback(async () => {
    if (!session?.user) return;
    const me = session.user.id;

    const { data: mine } = await supabase
      .from('contacts')
      .select('id, contact_id, status, profiles!contacts_contact_id_fkey(id, display_name, email, username)')
      .eq('user_id', me);

    const { data: incoming } = await supabase
      .from('contacts')
      .select('id, user_id, status, profiles!contacts_user_id_fkey(id, display_name, email, username)')
      .eq('contact_id', me)
      .eq('status', 'pending');

    const rows = mine ?? [];
    const acceptedIds = new Set(rows.filter((r) => r.status === 'accepted').map((r) => r.contact_id));

    setContacts(rows.filter((r) => r.status === 'accepted' && r.profiles).map((r) => ({ ...r.profiles, rowId: r.id })));
    setOutgoing(rows.filter((r) => r.status === 'pending' && r.profiles).map((r) => ({ ...r.profiles, rowId: r.id })));
    setRequests(
      (incoming ?? [])
        .filter((r) => r.profiles && !acceptedIds.has(r.user_id))
        .map((r) => ({ ...r.profiles, rowId: r.id }))
    );
  }, [session]);

  useEffect(() => {
    if (session?.user) {
      loadProfile(session.user.id);
      loadContacts();
    } else {
      setProfile(null);
      setContacts([]);
      setActive(null);
    }
  }, [session, loadProfile, loadContacts]);

  // Заявки и новые друзья появляются без обновления страницы
  useEffect(() => {
    if (!session?.user) return;
    const ch = supabase
      .channel('contacts_watch')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contacts' }, loadContacts)
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [session, loadContacts]);

  // Входящие сообщения: считаем непрочитанные и показываем уведомления
  useEffect(() => {
    if (!session?.user) return;
    const me = session.user.id;
    const ch = supabase
      .channel('inbox_watch')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, ({ new: row }) => {
        if (row.recipient_id !== me || row.sender_id === me) return;
        const chatOpen = view === 'chat' && active?.id === row.sender_id;
        if (chatOpen) return;
        setUnread((u) => ({ ...u, [row.sender_id]: (u[row.sender_id] ?? 0) + 1 }));
        const from = contacts.find((c) => c.id === row.sender_id);
        const title = from?.display_name ?? 'Новое сообщение';
        const body = row.content || `📎 ${row.attachment_name ?? 'Файл'}`;
        if (desktop?.notify) desktop.notify(title, body);
        else if ('Notification' in window) {
          if (Notification.permission === 'granted') new Notification(title, { body });
          else if (Notification.permission === 'default') Notification.requestPermission();
        }
      })
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [session, contacts, active, view]);

  const callApi = useCall(session?.user?.id ?? null);
  const { peers, myShownStatus, changeStatus } = usePresence(
    session?.user?.id ?? null,
    profile?.activity ?? null
  );

  // Говорим десктопному приложению, идёт ли звонок:
  // без звонка свёрнутое окно засыпает и не ест FPS в играх
  useEffect(() => {
    desktop?.setInCall?.(!!callApi.call);
  }, [callApi.call]);

  const openChat = (c) => {
    setActive(c);
    setView('chat');
    // Открыли переписку — сбрасываем счётчик непрочитанных
    setUnread((u) => (u[c.id] ? { ...u, [c.id]: 0 } : u));
  };

  const peerName = contacts.find((c) => c.id === callApi.call?.peerId)?.display_name ?? 'Собеседник';

  // При звонке сразу открываем переписку с этим человеком
  useEffect(() => {
    const id = callApi.call?.peerId;
    if (!id) return;
    const c = contacts.find((x) => x.id === id);
    if (c) {
      setActive(c);
      setView('chat');
    }
  }, [callApi.call?.peerId, contacts]);

  if (loading) return <div className="boot">Загрузка…</div>;
  if (!session) return <Auth />;
  if (!profile) return <div className="boot">Готовим профиль…</div>;

  return (
    <div className="app">
      <Sidebar
        profile={profile}
        contacts={contacts}
        requests={requests}
        active={active}
        view={view}
        peers={peers}
        unread={unread}
        myStatus={myShownStatus}
        callApi={callApi}
        deafened={deafened}
        onToggleDeafen={() => setDeafened((v) => !v)}
        onSpkVolume={setSpkVolume}
        onChangeStatus={changeStatus}
        onProfileChange={setProfile}
        onSelect={openChat}
        onOpenFriends={() => setView('friends')}
        onSignOut={() => supabase.auth.signOut()}
      />

      {view === 'friends' ? (
        <FriendsView
          profile={profile}
          contacts={contacts}
          requests={requests}
          outgoing={outgoing}
          peers={peers}
          onRefresh={loadContacts}
          onOpenChat={openChat}
          onCall={(c) => callApi.startCall(c.id)}
        />
      ) : (
        <ChatWindow
          profile={profile}
          contact={active}
          peers={peers}
          onCall={(c) => callApi.startCall(c.id)}
          callActive={!!callApi.call}
          callApi={callApi}
          callPeerName={peerName}
          deafened={deafened}
          volume={spkVolume}
        />
      )}

    </div>
  );
}
