import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { STATUSES } from '../hooks/usePresence';
import Icon from './Icons';
import Avatar from './Avatar';
import CallPanel from './CallPanel';

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

// Частые эмодзи — лёгкий пикер без сторонних библиотек
const EMOJI_STR =
  '😀😃😄😁😆😅😂🤣😊😇🙂😉😍😘😜🤪😎🤩🥳😏😒🙄😬😴🤤😷🤒🤕🤢🤮🥵🥶😱😨😰😥😓🤗🤔🤭🤫🤥😶😐😑😯😦😧😮😲🥱😵🤯😤😡😠🤬😈👿💀💩🤡👍👎👏🙌🙏🤝💪✌️👌🤟❤️🧡💛💚💙💜🖤🤍💔❣️💕💖💯🔥✨🎉🎊🎈🎁🏆⚽🎮🎲🎯🚀🌙⭐☀️🌈☕🍕🍔🍿🎂🍩🍪🥛🍺';
const EMOJI = [...new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(EMOJI_STR)].map(
  (s) => s.segment
);

// Мини-форматирование: **жирный**, *курсив*, `код`, ссылки
function renderRich(text) {
  const nodes = [];
  let rest = String(text ?? '');
  let key = 0;
  const push = (t) => t && nodes.push(t);
  while (rest) {
    let m = rest.match(/^(https?:\/\/[^\s]+)/);
    if (m) {
      nodes.push(
        <a key={key++} href={m[1]} target="_blank" rel="noreferrer">
          {m[1]}
        </a>
      );
      rest = rest.slice(m[1].length);
      continue;
    }
    m = rest.match(/^\*\*([^*]+)\*\*/);
    if (m) {
      nodes.push(<strong key={key++}>{m[1]}</strong>);
      rest = rest.slice(m[0].length);
      continue;
    }
    m = rest.match(/^\*([^*]+)\*/);
    if (m) {
      nodes.push(<em key={key++}>{m[1]}</em>);
      rest = rest.slice(m[0].length);
      continue;
    }
    m = rest.match(/^`([^`]+)`/);
    if (m) {
      nodes.push(<code key={key++}>{m[1]}</code>);
      rest = rest.slice(m[0].length);
      continue;
    }
    const next = rest.search(/https?:\/\/|\*\*[^*]|\*[^*]|`[^`]/);
    if (next === -1) {
      push(rest);
      break;
    }
    if (next === 0) {
      push(rest[0]);
      rest = rest.slice(1);
      continue;
    }
    push(rest.slice(0, next));
    rest = rest.slice(next);
  }
  return nodes;
}

export default function ChatWindow({ profile, contact, peers, onCall, callActive, callApi, callPeerName, deafened, volume }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [showProfile, setShowProfile] = useState(true);
  const [uploading, setUploading] = useState(null);
  const [typingName, setTypingName] = useState(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [search, setSearch] = useState('');
  const [searchOn, setSearchOn] = useState(false);
  const bottomRef = useRef(null);
  const fileRef = useRef(null);
  const inputRef = useRef(null);
  const chanRef = useRef(null);
  const typingSentRef = useRef(0);
  const typingTimerRef = useRef(null);

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
        .order('created_at', { ascending: false })
        .limit(300);
      // Берём последние 300, а показываем в хронологическом порядке
      if (alive) setMessages((data ?? []).reverse());
    })();

    const ch = supabase
      .channel(`msg_${[profile.id, contact.id].sort().join('_')}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, ({ new: row }) => {
        const mine = row.sender_id === profile.id && row.recipient_id === contact.id;
        const theirs = row.sender_id === contact.id && row.recipient_id === profile.id;
        if (mine || theirs) setMessages((m) => (m.some((x) => x.id === row.id) ? m : [...m, row]));
        if (theirs) {
          localStorage.setItem(`chat.read.${contact.id}`, new Date().toISOString());
          setTypingName(null);
        }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, ({ new: row }) => {
        setMessages((m) => m.map((x) => (x.id === row.id ? { ...x, ...row } : x)));
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, ({ old: row }) => {
        if (row?.id) setMessages((m) => m.filter((x) => x.id !== row.id));
      })
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        if (payload?.from !== contact.id) return;
        setTypingName(contact.display_name);
        clearTimeout(typingTimerRef.current);
        typingTimerRef.current = setTimeout(() => setTypingName(null), 4000);
      })
      .subscribe();
    chanRef.current = ch;

    // Отмечаем чат прочитанным
    localStorage.setItem(`chat.read.${contact.id}`, new Date().toISOString());

    return () => {
      alive = false;
      chanRef.current = null;
      supabase.removeChannel(ch);
    };
  }, [contact, profile.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async (bodyOverride) => {
    const body = (bodyOverride ?? text).trim();
    if (!body || !contact) return;
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

  // Шлём «печатает…», не чаще раза в 2,5 секунды
  const onType = (value) => {
    setText(value);
    const now = Date.now();
    if (now - typingSentRef.current < 2500) return;
    typingSentRef.current = now;
    chanRef.current?.send({ type: 'broadcast', event: 'typing', payload: { from: profile.id } });
  };

  const insertEmoji = (e) => {
    const el = inputRef.current;
    if (!el) return setText((t) => t + e);
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + e + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + e.length, start + e.length);
    });
  };

  const startEdit = (m) => {
    setEditingId(m.id);
    setEditText(m.content);
  };

  const saveEdit = async () => {
    const body = editText.trim();
    if (!body || !editingId) return setEditingId(null);
    const { error } = await supabase
      .from('messages')
      .update({ content: body, edited_at: new Date().toISOString() })
      .eq('id', editingId);
    if (error) {
      alert('Не удалось изменить: ' + error.message);
      return;
    }
    setMessages((m) =>
      m.map((x) => (x.id === editingId ? { ...x, content: body, edited_at: new Date().toISOString() } : x))
    );
    setEditingId(null);
  };

  const removeMessage = async (id) => {
    if (!confirm('Удалить сообщение?')) return;
    const { error } = await supabase.from('messages').delete().eq('id', id);
    if (error) {
      alert('Не удалось удалить: ' + error.message);
      return;
    }
    setMessages((m) => m.filter((x) => x.id !== id));
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

  const query = search.trim().toLowerCase();
  const hitCount = query ? messages.filter((m) => m.content?.toLowerCase().includes(query)).length : 0;

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
          <Avatar person={contact} color={color} dotClass="up-dot small" />
          <span className="chat-title">{contact.display_name}</span>
          {p?.activity && <span className="chat-activity">{p.activity}</span>}

          <span className="chat-head-actions">
            {searchOn && (
              <span className="chat-search">
                <Icon name="search" size={15} />
                <input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Поиск по чату"
                />
                {query && <span className="search-count">{hitCount}</span>}
              </span>
            )}
            <button
              className={searchOn ? 'hd-btn active' : 'hd-btn'}
              onClick={() => {
                setSearchOn((v) => !v);
                setSearch('');
              }}
              title="Поиск по сообщениям"
            >
              <Icon name="search" />
            </button>
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
            <span className="intro-avatar">
              {contact.avatar_url ? <img src={contact.avatar_url} alt="" /> : (contact.display_name || '?').slice(0, 2).toUpperCase()}
            </span>
            <div className="intro-name">{contact.display_name}</div>
            <div className="intro-nick">{nick}</div>
            <div className="intro-text">
              Это начало истории ваших личных сообщений с <b>{contact.display_name}</b>.
            </div>
          </div>

          {groups.map((g, gi) => {
            const first = g.items[0];
            const mine = g.sender === profile.id;
            const author = mine ? profile : contact;
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
                  <Avatar person={author} />
                  <div className="msg-body">
                    <div className="msg-meta">
                      <span className={mine ? 'msg-author me' : 'msg-author'}>{author.display_name}</span>
                      <span className="msg-time">{timeOf(first.created_at)}</span>
                    </div>
                    {g.items.map((m) => {
                      const isHit = query && m.content?.toLowerCase().includes(query);
                      return (
                        <div key={m.id} className={isHit ? 'msg-line search-hit' : 'msg-line'}>
                          {m.sender_id === profile.id && (
                            <span className="msg-actions">
                              <button className="msg-act" onClick={() => startEdit(m)} title="Изменить">
                                <Icon name="edit" size={16} />
                              </button>
                              <button className="msg-act danger" onClick={() => removeMessage(m.id)} title="Удалить">
                                <Icon name="trash" size={16} />
                              </button>
                            </span>
                          )}
                          {editingId === m.id ? (
                            <input
                              className="msg-edit-input"
                              autoFocus
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') saveEdit();
                                if (e.key === 'Escape') setEditingId(null);
                              }}
                            />
                          ) : (
                            <>
                              {renderRich(m.content)}
                              {m.edited_at && <span className="msg-edited">(изм.)</span>}
                            </>
                          )}
                          {m.attachment_url &&
                            (m.attachment_type?.startsWith('image/') ? (
                              <a href={m.attachment_url} target="_blank" rel="noreferrer">
                                <img className="msg-image" src={m.attachment_url} alt={m.attachment_name} />
                              </a>
                            ) : (
                              <a className="msg-file" href={m.attachment_url} target="_blank" rel="noreferrer">
                                <span className="msg-file-icon">
                                  <Icon name="download" size={18} />
                                </span>
                                <span>
                                  <span className="msg-file-name">{m.attachment_name}</span>
                                  <span className="msg-file-size">{prettySize(m.attachment_size)}</span>
                                </span>
                              </a>
                            ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        <div className="typing">
          {typingName && (
            <>
              <span className="typing-dots"><i /><i /><i /></span>
              <b>{typingName}</b>&nbsp;печатает…
            </>
          )}
        </div>

        {uploading && <div className="upload-bar">Отправляем «{uploading}»…</div>}

        <div className="composer">
          {emojiOpen && (
            <div className="emoji-pop">
              {EMOJI.map((e) => (
                <button key={e} onClick={() => insertEmoji(e)}>
                  {e}
                </button>
              ))}
            </div>
          )}
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
            ref={inputRef}
            value={text}
            onChange={(e) => onType(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
            onFocus={() => setEmojiOpen(false)}
            placeholder={`Написать @${contact.display_name}`}
          />
          <button
            className={emojiOpen ? 'cp-emoji active' : 'cp-emoji'}
            onClick={() => setEmojiOpen((v) => !v)}
            title="Эмодзи"
          >
            <Icon name="emoji" />
          </button>
          <button className="cp-send" onClick={() => sendMessage()} title="Отправить">
            <Icon name="send" />
          </button>
        </div>
      </main>

      {showProfile && (
        <aside className="profile-pane">
          <div className="pp-banner" />
          <div className="pp-top">
            <span className="pp-avatar">
              {contact.avatar_url ? <img src={contact.avatar_url} alt="" /> : (contact.display_name || '?').slice(0, 2).toUpperCase()}
              <span className="up-dot" style={{ background: color }} />
            </span>
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
