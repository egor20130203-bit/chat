import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { STATUSES } from '../hooks/usePresence';
import Icon from './Icons';
import CallPanel from './CallPanel';

const initials = (n) => (n || '?').slice(0, 2).toUpperCase();

const timeOf = (ts) =>
  new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

const dayOf = (ts) =>
  new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

// Больше 50 МБ бесплатный тариф Supabase не принимает — см. README
const MAX_FILE_MB = 50;

const prettySize = (b) => {
  if (!b) return '';
  if (b < 1024) return b + ' Б';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' КБ';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' МБ';
  return (b / 1073741824).toFixed(2) + ' ГБ';
};

export default function ChatWindow({ profile, contact, peers, onCall, callActive, callApi, callPeerName, deafened, volume }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [showProfile, setShowProfile] = useState(true);
  const [uploading, setUploading] = useState(null);
  const bottomRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!contact) return;
    let alive = true;

    (async () => {
      const { data } = await supabase
        .from('messages')
        .select('*')
        .or(
          `and(sender_id.eq.${profile.id},recipient_id.eq.${contact.id}),` +
            `and(sender_id.eq.${contact.id},recipient_id.eq.${profile.id})`
        )
        .order('created_at', { ascending: true })
        .limit(300);
      if (alive) setMessages(data ?? []);
    })();

    const ch = supabase
      .channel(`msg_${[profile.id, contact.id].sort().join('_')}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, ({ new: row }) => {
        const mine = row.sender_id === profile.id && row.recipient_id === contact.id;
        const theirs = row.sender_id === contact.id && row.recipient_id === profile.id;
        if (mine || theirs) setMessages((m) => (m.some((x) => x.id === row.id) ? m : [...m, row]));
      })
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(ch);
    };
  }, [contact, profile.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    const { data, error } = await supabase
      .from('messages')
      .insert({ sender_id: profile.id, recipient_id: contact.id, content: body })
      .select()
      .single();
    if (error) {
      alert('Сообщение не отправилось: ' + error.message);
      return;
    }
    setMessages((m) => (m.some((x) => x.id === data.id) ? m : [...m, data]));
  };

  const sendFile = async (file) => {
    if (!file) return;
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      alert(`Файл слишком большой: ${prettySize(file.size)}. Максимум ${MAX_FILE_MB} МБ.`);
      return;
    }
    setUploading(file.name);
    try {
      const safe = file.name.replace(/[^\w.\-]+/g, '_');
      const path = `${profile.id}/${Date.now()}_${safe}`;
      const { error: upErr } = await supabase.storage
        .from('attachments')
        .upload(path, file, { cacheControl: '3600', upsert: false });
      if (upErr) throw upErr;

      const { data: pub } = supabase.storage.from('attachments').getPublicUrl(path);

      const { data, error } = await supabase
        .from('messages')
        .insert({
          sender_id: profile.id,
          recipient_id: contact.id,
          content: '',
          attachment_url: pub.publicUrl,
          attachment_name: file.name,
          attachment_size: file.size,
          attachment_type: file.type,
        })
        .select()
        .single();
      if (error) throw error;
      setMessages((m) => (m.some((x) => x.id === data.id) ? m : [...m, data]));
    } catch (e) {
      alert('Файл не отправился: ' + e.message);
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // Группировка: подряд идущие сообщения одного автора в пределах 7 минут
  const groups = useMemo(() => {
    const out = [];
    messages.forEach((m) => {
      const last = out[out.length - 1];
      const sameDay = last && dayOf(last.items[0].created_at) === dayOf(m.created_at);
      const close =
        last && new Date(m.created_at) - new Date(last.items[last.items.length - 1].created_at) < 7 * 60000;
      if (last && last.sender === m.sender_id && sameDay && close) last.items.push(m);
      else out.push({ sender: m.sender_id, items: [m] });
    });
    return out;
  }, [messages]);

  if (!contact) {
    return (
      <main className="chat empty-state">
        <div>
          <h2>Выберите собеседника</h2>
          <p className="muted">Слева список. Нет никого — добавьте друга по нику.</p>
        </div>
      </main>
    );
  }

  const p = peers?.[contact.id];
  const color = p ? STATUSES[p.status]?.color ?? '#7a7d8a' : '#7a7d8a';
  const nick = contact.username ?? contact.email?.split('@')[0];

  return (
    <div className="chat-wrap">
      <main className="chat">
        <header className="chat-head">
          <span className="avatar">
            {initials(contact.display_name)}
            <span className="up-dot small" style={{ background: color }} />
          </span>
          <span className="chat-title">{contact.display_name}</span>
          {p?.activity && <span className="chat-activity">{p.activity}</span>}

          <span className="chat-head-actions">
            <button className="hd-btn" onClick={() => onCall(contact)} disabled={callActive} title="Позвонить">
              <Icon name="phone" />
            </button>
            <button className="hd-btn" onClick={() => onCall(contact)} disabled={callActive} title="Видеозвонок">
              <Icon name="video" />
            </button>
            <button
              className={showProfile ? 'hd-btn active' : 'hd-btn'}
              onClick={() => setShowProfile((v) => !v)}
              title="Профиль"
            >
              <Icon name="person" />
            </button>
          </span>
        </header>

        {callApi?.call && (
          <CallPanel
            callApi={callApi}
            peerName={callPeerName}
            myName={profile.display_name}
            deafened={deafened}
            volume={volume}
          />
        )}

        <div className="messages">
          <div className="intro">
            <div className="intro-avatar">{initials(contact.display_name)}</div>
            <div className="intro-name">{contact.display_name}</div>
            <div className="intro-nick">{nick}</div>
            <div className="intro-text">
              Это начало истории ваших личных сообщений с <b>{contact.display_name}</b>.
            </div>
          </div>

          {groups.map((g, gi) => {
            const first = g.items[0];
            const mine = g.sender === profile.id;
            const author = mine ? profile.display_name : contact.display_name;
            const prev = groups[gi - 1];
            const newDay = !prev || dayOf(prev.items[0].created_at) !== dayOf(first.created_at);
            return (
              <div key={first.id}>
                {newDay && (
                  <div className="day-sep">
                    <span>{dayOf(first.created_at)}</span>
                  </div>
                )}
                <div className="msg-group">
                  <span className="avatar">{initials(author)}</span>
                  <div className="msg-body">
                    <div className="msg-meta">
                      <span className={mine ? 'msg-author me' : 'msg-author'}>{author}</span>
                      <span className="msg-time">{timeOf(first.created_at)}</span>
                    </div>
                    {g.items.map((m) => (
                      <div key={m.id} className="msg-line">
                        {m.content}
                        {m.attachment_url &&
                          (m.attachment_type?.startsWith('image/') ? (
                            <a href={m.attachment_url} target="_blank" rel="noreferrer">
                              <img className="msg-image" src={m.attachment_url} alt={m.attachment_name} />
                            </a>
                          ) : (
                            <a className="msg-file" href={m.attachment_url} target="_blank" rel="noreferrer">
                              <span className="msg-file-icon">⬇</span>
                              <span>
                                <span className="msg-file-name">{m.attachment_name}</span>
                                <span className="msg-file-size">{prettySize(m.attachment_size)}</span>
                              </span>
                            </a>
                          ))}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {uploading && <div className="upload-bar">Отправляем «{uploading}»…</div>}

        <div className="composer">
          <input
            ref={fileRef}
            type="file"
            hidden
            onChange={(e) => sendFile(e.target.files?.[0])}
          />
          <button
            className="cp-plus"
            onClick={() => fileRef.current?.click()}
            disabled={!!uploading}
            title="Прикрепить файл или фото"
          >
            <Icon name="plus" />
          </button>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
            placeholder={`Написать @${contact.display_name}`}
          />
          <button className="cp-send" onClick={sendMessage} title="Отправить">
            <Icon name="send" />
          </button>
        </div>
      </main>

      {showProfile && (
        <aside className="profile-pane">
          <div className="pp-banner" />
          <div className="pp-top">
            <div className="pp-avatar">
              {initials(contact.display_name)}
              <span className="up-dot" style={{ background: color }} />
            </div>
          </div>
          <div className="pp-body">
            <div className="pp-name">{contact.display_name}</div>
            <div className="pp-nick">{nick}</div>

            {p?.activity && (
              <div className="pp-block">
                <div className="pp-label">Играет в</div>
                <div className="pp-game">
                  <span className="pp-game-icon">▸</span>
                  {p.activity}
                </div>
              </div>
            )}

            <div className="pp-block">
              <div className="pp-label">Статус</div>
              <div className="pp-status">
                <span className="up-status-dot" style={{ background: color }} />
                {p ? STATUSES[p.status]?.label : 'Не в сети'}
              </div>
            </div>

            <button className="pp-call" onClick={() => onCall(contact)} disabled={callActive}>
              Позвонить
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}
