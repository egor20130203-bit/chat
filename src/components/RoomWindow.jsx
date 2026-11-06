import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { STATUSES } from '../hooks/usePresence';
import Icon from './Icons';
import Avatar from './Avatar';
import GroupCallPanel from './GroupCallPanel';
import Lightbox from './Lightbox';
import FileAttachment from './FileAttachment';
import { uploadAttachment } from '../lib/bigfiles';

const timeOf = (ts) =>
  new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

const dayOf = (ts) =>
  new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

const MAX_FILE_MB = 50;

const prettySize = (b) => {
  if (!b) return '';
  if (b < 1024) return b + ' Б';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' КБ';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' МБ';
  return (b / 1073741824).toFixed(2) + ' ГБ';
};

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

export default function RoomWindow({ profile, room, peers, groupCallApi, deafened, volume }) {
  const [messages, setMessages] = useState([]);
  const [members, setMembers] = useState([]); // профили участников
  const [text, setText] = useState('');
  const [showMembers, setShowMembers] = useState(true);
  const [uploading, setUploading] = useState(null); // { name, pct } | null
  const [viewer, setViewer] = useState(null); // { url, name } | null
  const [typingNames, setTypingNames] = useState({}); // userId -> name
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [search, setSearch] = useState('');
  const [searchOn, setSearchOn] = useState(false);
  const [callPeersCount, setCallPeersCount] = useState(0);
  const bottomRef = useRef(null);
  const fileRef = useRef(null);
  const inputRef = useRef(null);
  const chanRef = useRef(null);
  const typingSentRef = useRef(0);
  const typingTimersRef = useRef({});
  const membersRef = useRef([]);
  useEffect(() => {
    membersRef.current = members;
  }, [members]);

  const memberMap = useMemo(() => {
    const m = { [profile.id]: profile };
    members.forEach((p) => (m[p.id] = p));
    return m;
  }, [members, profile]);

  // ---------- участники ----------
  useEffect(() => {
    if (!room) return;
    let alive = true;
    const load = async () => {
      const { data } = await supabase
        .from('room_members')
        .select('user_id, profiles(id, display_name, email, username, avatar_url)')
        .eq('room_id', room.id);
      if (alive) setMembers((data ?? []).map((r) => r.profiles).filter(Boolean));
    };
    load();
    const ch = supabase
      .channel(`room_members_${room.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'room_members', filter: `room_id=eq.${room.id}` },
        load
      )
      .subscribe();
    return () => {
      alive = false;
      supabase.removeChannel(ch);
    };
  }, [room]);

  // ---------- сообщения + «печатает…» ----------
  useEffect(() => {
    if (!room) return;
    let alive = true;
    setTypingNames({});

    (async () => {
      const { data } = await supabase
        .from('room_messages')
        .select('*')
        .eq('room_id', room.id)
        .order('created_at', { ascending: false })
        .limit(300);
      if (alive) setMessages((data ?? []).reverse());
    })();

    const ch = supabase
      .channel(`room_${room.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'room_messages', filter: `room_id=eq.${room.id}` },
        ({ new: row }) => {
          setMessages((m) => (m.some((x) => x.id === row.id) ? m : [...m, row]));
          setTypingNames((t) => {
            if (!t[row.sender_id]) return t;
            const next = { ...t };
            delete next[row.sender_id];
            return next;
          });
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'room_messages', filter: `room_id=eq.${room.id}` },
        ({ new: row }) => setMessages((m) => m.map((x) => (x.id === row.id ? { ...x, ...row } : x)))
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'room_messages', filter: `room_id=eq.${room.id}` },
        ({ old: row }) => {
          if (row?.id) setMessages((m) => m.filter((x) => x.id !== row.id));
        }
      )
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        if (!payload || payload.from === profile.id) return;
        const author =
          membersRef.current.find((x) => x.id === payload.from)?.display_name ??
          payload.name ??
          'Кто-то';
        setTypingNames((t) => ({ ...t, [payload.from]: author }));
        clearTimeout(typingTimersRef.current[payload.from]);
        typingTimersRef.current[payload.from] = setTimeout(
          () =>
            setTypingNames((t) => {
              const next = { ...t };
              delete next[payload.from];
              return next;
            }),
          4000
        );
      })
      .subscribe();
    chanRef.current = ch;

    return () => {
      alive = false;
      chanRef.current = null;
      Object.values(typingTimersRef.current).forEach(clearTimeout);
      typingTimersRef.current = {};
      supabase.removeChannel(ch);
    };
  }, [room, profile.id]);

  // ---------- пассивный датчик «идёт звонок» (presence канала звонка) ----------
  useEffect(() => {
    if (!room) return;
    const ch = supabase.channel(`rtc_room_${room.id}`, {
      config: { presence: { key: `peek_${profile.id}` } },
    });
    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState();
      setCallPeersCount(Object.keys(state).filter((k) => !k.startsWith('peek_')).length);
    });
    ch.subscribe();
    return () => supabase.removeChannel(ch);
  }, [room, profile.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async () => {
    const body = text.trim();
    if (!body || !room) return;
    setText('');
    const { data, error } = await supabase
      .from('room_messages')
      .insert({ room_id: room.id, sender_id: profile.id, content: body })
      .select()
      .single();
    if (error) {
      alert('Сообщение не отправилось: ' + error.message);
      return;
    }
    setMessages((m) => (m.some((x) => x.id === data.id) ? m : [...m, data]));
  };

  const onType = (value) => {
    setText(value);
    const now = Date.now();
    if (now - typingSentRef.current < 2500) return;
    typingSentRef.current = now;
    chanRef.current?.send({
      type: 'broadcast',
      event: 'typing',
      payload: { from: profile.id, name: profile.display_name },
    });
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
      .from('room_messages')
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
    const { error } = await supabase.from('room_messages').delete().eq('id', id);
    if (error) {
      alert('Не удалось удалить: ' + error.message);
      return;
    }
    setMessages((m) => m.filter((x) => x.id !== id));
  };

  const sendFile = async (file) => {
    if (!file) return;
    setUploading({ name: file.name, pct: 0 });
    try {
      const att = await uploadAttachment(profile.id, file, (pct) =>
        setUploading({ name: file.name, pct })
      );

      const { data, error } = await supabase
        .from('room_messages')
        .insert({
          room_id: room.id,
          sender_id: profile.id,
          content: '',
          attachment_url: att.url,
          attachment_name: att.name,
          attachment_size: att.size,
          attachment_type: att.type,
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

  if (!room) {
    return (
      <main className="chat empty-state">
        <div>
          <h2>Выберите группу</h2>
          <p className="muted">Слева список. Нет групп — создайте свою кнопкой «+».</p>
        </div>
      </main>
    );
  }

  const inThisCall = groupCallApi?.call?.roomId === room.id;
  const inOtherCall = !!groupCallApi?.call && !inThisCall;
  const typingList = Object.values(typingNames);

  return (
    <div className="chat-wrap">
      <main className="chat">
        <header className="chat-head">
          <span className="chat-group-icon">
            <Icon name="users" size={18} />
          </span>
          <span className="chat-title">{room.name}</span>
          <span className="chat-activity">{members.length} участн.</span>

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
            <button
              className="hd-btn"
              onClick={() => groupCallApi.join(room.id)}
              disabled={inThisCall || inOtherCall}
              title={inOtherCall ? 'Вы уже в другом звонке' : 'Голосовой звонок'}
            >
              <Icon name="phone" />
            </button>
            <button
              className={showMembers ? 'hd-btn active' : 'hd-btn'}
              onClick={() => setShowMembers((v) => !v)}
              title="Участники"
            >
              <Icon name="users" />
            </button>
          </span>
        </header>

        {!inThisCall && callPeersCount > 0 && (
          <div className="call-banner">
            <Icon name="phone" size={16} />
            Идёт голосовой звонок · {callPeersCount} участн.
            <button onClick={() => groupCallApi.join(room.id)} disabled={inOtherCall}>
              Присоединиться
            </button>
          </div>
        )}

        {inThisCall && (
          <GroupCallPanel
            callApi={groupCallApi}
            myProfile={profile}
            memberMap={memberMap}
            deafened={deafened}
            volume={volume}
          />
        )}

        <div className="messages">
          <div className="intro">
            <span className="intro-avatar">
              <Icon name="users" size={28} />
            </span>
            <div className="intro-name">{room.name}</div>
            <div className="intro-text">Это начало истории группы <b>{room.name}</b>.</div>
          </div>

          {groups.map((g, gi) => {
            const first = g.items[0];
            const mine = g.sender === profile.id;
            const author = memberMap[g.sender] ?? { display_name: 'Участник' };
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
                              <img
                                className="msg-image"
                                src={m.attachment_url}
                                alt={m.attachment_name}
                                onClick={() => setViewer({ url: m.attachment_url, name: m.attachment_name })}
                              />
                            ) : (
                              <FileAttachment
                                url={m.attachment_url}
                                name={m.attachment_name}
                                size={m.attachment_size}
                                type={m.attachment_type}
                              />
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
          {typingList.length > 0 && (
            <>
              <span className="typing-dots"><i /><i /><i /></span>
              <b>{typingList.join(', ')}</b>&nbsp;{typingList.length > 1 ? 'печатают…' : 'печатает…'}
            </>
          )}
        </div>

        {uploading && (
          <div className="upload-bar">
            Отправляем «{uploading.name}»…{uploading.pct > 0 ? ` ${uploading.pct}%` : ''}
          </div>
        )}

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
            placeholder={`Написать в ${room.name}`}
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

      {showMembers && (
        <aside className="profile-pane">
          <div className="pp-body">
            <div className="pp-label">Участники — {members.length}</div>            <div className="member-list">
              {[profile, ...members.filter((m) => m.id !== profile.id)].map((m) => {
                const p = peers?.[m.id];
                const color = p ? STATUSES[p.status]?.color ?? '#7a7d8a' : '#7a7d8a';
                return (
                  <div key={m.id} className="member-row">
                    <Avatar person={m} color={m.id === profile.id || p ? color : undefined} dotClass="up-dot small" />
                    <span className="member-name">
                      {m.display_name}
                      {m.id === room.owner_id && <span className="member-crown" title="Владелец">♛</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </aside>
      )}

      {viewer && <Lightbox src={viewer.url} name={viewer.name} onClose={() => setViewer(null)} />}
    </div>
  );
}
