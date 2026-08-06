import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { STATUSES } from '../hooks/usePresence';
import Icon from './Icons';
import AudioMenu from './AudioMenu';

const initials = (n) => (n || '?').slice(0, 2).toUpperCase();

export default function UserPanel({
  profile,
  myStatus,
  callApi,
  deafened,
  onToggleDeafen,
  onSpkVolume,
  onChangeStatus,
  onProfileChange,
  onSignOut,
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [audioMenu, setAudioMenu] = useState(null); // 'mic' | 'spk' | null
  const [name, setName] = useState(profile.display_name ?? '');
  const [nick, setNick] = useState(profile.username ?? '');
  const [activity, setActivity] = useState(profile.activity ?? '');
  const [selfMuted, setSelfMuted] = useState(() => localStorage.getItem('chat.startMuted') === '1');
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const away = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const saveProfile = async () => {
    const patch = {
      display_name: name.trim() || profile.display_name,
      username: nick.trim() || profile.username,
      activity: activity.trim() || null,
    };
    const { error } = await supabase.from('profiles').update(patch).eq('id', profile.id);
    if (error) {
      alert(
        error.code === '23505'
          ? 'Такой ник уже занят, придумайте другой.'
          : 'Не сохранилось: ' + error.message
      );
      return;
    }
    onProfileChange({ ...profile, ...patch });
    setEditing(false);
  };

  const inCall = !!callApi?.call;
  const muted = inCall ? callApi?.micOn === false : selfMuted;

  const toggleMicBtn = () => {
    if (inCall) {
      callApi?.toggleMic?.();
      return;
    }
    const next = !selfMuted;
    setSelfMuted(next);
    localStorage.setItem('chat.startMuted', next ? '1' : '0');
  };

  const dot = STATUSES[myStatus]?.color ?? '#7a7d8a';

  return (
    <div className="user-panel" ref={boxRef}>
      {audioMenu && (
        <AudioMenu
          kind={audioMenu}
          onClose={() => setAudioMenu(null)}
          onMicVolume={(v) => callApi?.setMicVolume?.(v)}
          onSpkVolume={onSpkVolume}
        />
      )}

      {open && (
        <div className="up-menu" role="dialog">
          <div className="up-banner" />
          <div className="up-top">
            <div className="up-avatar">
              {initials(profile.display_name)}
              <span className="up-dot" style={{ background: dot }} />
            </div>
          </div>

          <div className="up-body">
            {editing ? (
              <>
                <label className="up-field">
                  Отображаемое имя
                  <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
                </label>
                <label className="up-field">
                  Ник (по нему вас добавляют)
                  <input value={nick} onChange={(e) => setNick(e.target.value)} maxLength={24} />
                </label>
                <label className="up-field">
                  Чем занят
                  <input
                    value={activity}
                    onChange={(e) => setActivity(e.target.value)}
                    placeholder="Например: Minecraft"
                    maxLength={48}
                  />
                </label>
                <div className="up-row-btns">
                  <button className="up-item primary" onClick={saveProfile}>
                    Сохранить
                  </button>
                  <button className="up-item" onClick={() => setEditing(false)}>
                    Отмена
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="up-name">{profile.display_name}</div>
                <div className="up-username">{profile.username ?? profile.email?.split('@')[0]}</div>

                {profile.activity && (
                  <div className="up-block">
                    <div className="up-block-label">Играет в</div>
                    <div className="up-activity">
                      <span className="up-game-icon">▸</span>
                      {profile.activity}
                    </div>
                  </div>
                )}

                <button className="up-item" onClick={() => setEditing(true)}>
                  Редактировать профиль
                </button>
              </>
            )}

            <div className="up-block">
              <div className="up-block-label">Статус</div>
              {Object.entries(STATUSES).map(([key, s]) => (
                <button
                  key={key}
                  className={myStatus === key ? 'up-item status active' : 'up-item status'}
                  onClick={() => onChangeStatus(key)}
                >
                  <span className="up-status-dot" style={{ background: s.color }} />
                  {s.label}
                </button>
              ))}
            </div>

            <button className="up-item danger" onClick={onSignOut}>
              Выйти из аккаунта
            </button>
          </div>
        </div>
      )}

      <div className="up-bar-row">
        <button className="up-bar" onClick={() => setOpen((v) => !v)}>
          <span className="avatar">
            {initials(profile.display_name)}
            <span className="up-dot small" style={{ background: dot }} />
          </span>
          <span className="up-bar-text">
            <span className="up-bar-name">{profile.display_name}</span>
            <span className="up-bar-sub">{profile.activity || STATUSES[myStatus]?.label}</span>
          </span>
        </button>

        <div className="up-controls">
          <div className="up-pair">
            <button
              className={muted ? 'up-ctl off' : 'up-ctl'}
              onClick={toggleMicBtn}
              title={muted ? 'Включить микрофон' : 'Выключить микрофон'}
            >
              <Icon name={muted ? 'micOff' : 'mic'} size={18} />
            </button>
            <button
              className="up-chev"
              onClick={() => setAudioMenu(audioMenu === 'mic' ? null : 'mic')}
              title="Настройки микрофона"
            >
              ⌃
            </button>
          </div>

          <div className="up-pair">
            <button
              className={deafened ? 'up-ctl off' : 'up-ctl'}
              onClick={onToggleDeafen}
              title={deafened ? 'Включить звук' : 'Выключить звук'}
            >
              <Icon name={deafened ? 'headOff' : 'head'} size={18} />
            </button>
            <button
              className="up-chev"
              onClick={() => setAudioMenu(audioMenu === 'spk' ? null : 'spk')}
              title="Настройки звука"
            >
              ⌃
            </button>
          </div>

          <button className="up-ctl" onClick={() => setOpen((v) => !v)} title="Настройки">
            <Icon name="gear" size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
