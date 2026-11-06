import { useEffect, useRef, useState } from 'react';
import { RESOLUTIONS, FPS_OPTIONS } from '../hooks/useCall';

const initials = (n) => (n || '?').slice(0, 2).toUpperCase();

const PATHS = {
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zm7 10a7 7 0 0 1-6 6.92V22h-2v-3.08A7 7 0 0 1 5 12h2a5 5 0 0 0 10 0h2z',
  micOff:
    'M3.28 2 2 3.28l5 5V12a5 5 0 0 0 7.55 4.28l1.45 1.45A6.94 6.94 0 0 1 13 18.92V22h-2v-3.08A7 7 0 0 1 5 12h2a5 5 0 0 0 .1 1l13.62 8.72L22 20.72 3.28 2zM15 11.72V5a3 3 0 0 0-5.9-.72L15 11.72z',
  cam: 'M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z',
  camOff:
    'M3.28 2 2 3.28 3.72 5H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12c.2 0 .38-.06.54-.16L20.72 22 22 20.72 3.28 2zM17 10.5l4-4v11l-1.3-1.3L17 13.5v-3z',
  screen:
    'M3 4h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-7v2h3v2H7v-2h3v-2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v9h16V6H4z',
  end: 'M12 9c-1.6 0-3.15.25-4.6.7v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.98.98 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .27-.11.52-.29.7l-2.48 2.46c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 0 0-2.67-1.85.996.996 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z',
  expand: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
};

const Icon = ({ name }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
    <path d={PATHS[name]} />
  </svg>
);

// Звук одного участника — отдельный элемент, так надёжнее
function RemoteAudio({ stream, deafened, volume }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream ?? null;
    if (!stream) return;
    const id = localStorage.getItem('chat.spk');
    if (id && typeof el.setSinkId === 'function') {
      el.setSinkId(id).catch(() => {
        // Устройство пропало — забываем его, звук пойдёт через стандартное
        localStorage.removeItem('chat.spk');
      });
    }
    el.muted = !!deafened;
    el.volume = Math.min(1, Math.max(0, volume / 100));
    el.play().catch(() => {});
  }, [stream, deafened, volume]);

  return <audio ref={ref} autoPlay playsInline />;
}

// Видео одного участника
function RemoteVideo({ stream, className }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream ?? null;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted className={className} />;
}

export default function GroupCallPanel({ callApi, myProfile, memberMap = {}, deafened, volume = 100 }) {
  const {
    participants,
    remoteStreams,
    localVideo,
    micOn,
    cameraOn,
    screenOn,
    resolution,
    fps,
    stats,
    leave,
    toggleMic,
    toggleCamera,
    toggleScreen,
    setResolution,
    setFps,
  } = callApi;

  const localRef = useRef(null);
  useEffect(() => {
    if (localRef.current) localRef.current.srcObject = localVideo ?? null;
  }, [localVideo]);

  const myId = myProfile.id;
  const others = participants.filter((p) => p.id !== myId);
  const nameOf = (p) => memberMap[p.id]?.display_name ?? p.name ?? 'Участник';
  const avatarOf = (p) => memberMap[p.id]?.avatar_url ?? p.avatar_url ?? null;

  const hasVideo = localVideo || others.some((p) => remoteStreams[p.id]?.videoOn);
  // Пресеты показывают качество активного источника: демка приоритетнее камеры
  const qualityTitle = screenOn ? 'Качество демонстрации' : 'Качество камеры';

  // Фуллскрин плитки: кнопка в углу или двойной клик по видео (как в Discord)
  const fsTile = (e) => {
    const tile = e.currentTarget.closest('.dc-tile');
    if (!tile) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else tile.requestFullscreen().catch(() => {});
  };

  return (
    <div className={hasVideo ? 'dc-panel tall' : 'dc-panel'}>
      {/* По аудио-элементу на каждого участника */}
      {others.map((p) =>
        remoteStreams[p.id]?.stream ? (
          <RemoteAudio key={p.id} stream={remoteStreams[p.id].stream} deafened={deafened} volume={volume} />
        ) : null
      )}

      <div className="dc-grid">
        {/* Я */}
        <div className={localVideo ? 'dc-tile video' : 'dc-tile'} onDoubleClick={localVideo ? fsTile : undefined}>
          {localVideo ? (
            <>
              <video
                ref={localRef}
                autoPlay
                playsInline
                muted
                className={screenOn ? 'dc-video' : 'dc-video mirrored'}
              />
              <button className="dc-fs" onClick={fsTile} title="На весь экран">
                <Icon name="expand" />
              </button>
              {stats && (
                <div className="dc-stat">
                  {stats.w}×{stats.h} · {stats.fps} fps
                </div>
              )}
            </>
          ) : (
            <div className="dc-avatar self">
              {myProfile.avatar_url ? <img src={myProfile.avatar_url} alt="" /> : initials(myProfile.display_name)}
            </div>
          )}
          <div className={localVideo ? 'dc-nametag' : 'dc-tile-name'}>{myProfile.display_name} (вы)</div>
        </div>

        {/* Остальные участники */}
        {others.map((p) => {
          const rs = remoteStreams[p.id];
          const av = avatarOf(p);
          const videoOn = !!rs?.videoOn;
          return (
            <div
              className={videoOn ? 'dc-tile video' : 'dc-tile'}
              key={p.id}
              onDoubleClick={videoOn ? fsTile : undefined}
            >
              {videoOn ? (
                <>
                  <RemoteVideo stream={rs.stream} className="dc-video" />
                  <button className="dc-fs" onClick={fsTile} title="На весь экран">
                    <Icon name="expand" />
                  </button>
                </>
              ) : (
                <div className="dc-avatar">{av ? <img src={av} alt="" /> : initials(nameOf(p))}</div>
              )}
              <div className={videoOn ? 'dc-nametag' : 'dc-tile-name'}>{nameOf(p)}</div>
            </div>
          );
        })}
      </div>

      <div className="dc-pill">
        <button className={micOn ? 'dc-btn' : 'dc-btn off'} onClick={toggleMic} title="Микрофон">
          <Icon name={micOn ? 'mic' : 'micOff'} />
        </button>
        <button
          className={cameraOn ? 'dc-btn on' : 'dc-btn'}
          onClick={toggleCamera}
          title="Камера"
        >
          <Icon name={cameraOn ? 'cam' : 'camOff'} />
        </button>
        <button
          className={screenOn ? 'dc-btn on' : 'dc-btn'}
          onClick={toggleScreen}
          title="Демонстрация экрана"
        >
          <Icon name="screen" />
        </button>
        <select
          className="dc-quality"
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          title={qualityTitle}
        >
          {Object.entries(RESOLUTIONS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
        <select
          className="dc-quality"
          value={fps}
          onChange={(e) => setFps(e.target.value)}
          title={qualityTitle + ' — кадры в секунду'}
        >
          {FPS_OPTIONS.map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
        <button className="dc-btn hangup" onClick={leave} title="Покинуть звонок">
          <Icon name="end" />
        </button>
      </div>
    </div>
  );
}
