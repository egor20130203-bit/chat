import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

export const RESOLUTIONS = {
  r720: { label: '720p', width: 1280, height: 720 },
  r1080: { label: '1080p', width: 1920, height: 1080 },
  r1440: { label: '1440p (2K)', width: 2560, height: 1440 },
  r2160: { label: '2160p (4K)', width: 3840, height: 2160 },
};
export const FPS_OPTIONS = [30, 60, 90, 120];

// Битрейт под разрешение и fps — так считают Discord-подобные приложения
export function bitrateFor(width, height, fps) {
  const raw = Math.round((width * height * fps * 0.1) / 100_000) * 100_000;
  return Math.min(Math.max(raw, 600_000), 40_000_000);
}

export function mediaPreset(resKey, fps) {
  const r = RESOLUTIONS[resKey] ?? RESOLUTIONS.r1080;
  return { width: r.width, height: r.height, fps, bitrate: bitrateFor(r.width, r.height, fps) };
}

const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
};

const userChannel = (id) => `rtc_user_${id}`;

// Короткий гудок — чтобы звонок было слышно, а не только видно
function makeBeeper() {
  let ctx = null;
  let timer = null;
  const beep = (freq, len) => {
    try {
      ctx = ctx ?? new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.value = 0.06;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + len);
    } catch (_) {}
  };
  return {
    start(freq = 620, every = 2200, len = 0.55) {
      this.stop();
      beep(freq, len);
      timer = setInterval(() => beep(freq, len), every);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export function useCall(myId) {
  const [call, setCall] = useState(null); // { peerId, status: 'outgoing' | 'incoming' | 'active' }
  const [remoteStream, setRemoteStream] = useState(null); // объединённый звук собеседника
  const [remoteCam, setRemoteCam] = useState(null); // видеопоток чужой камеры
  const [remoteScreen, setRemoteScreen] = useState(null); // видеопоток чужой демки
  const [remoteCamOn, setRemoteCamOn] = useState(false);
  const [remoteScreenOn, setRemoteScreenOn] = useState(false);
  const [localCam, setLocalCam] = useState(null);
  const [localScreen, setLocalScreen] = useState(null);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [camRes, setCamResState] = useState(localStorage.getItem('chat.camRes') || 'r720');
  const [camFps, setCamFpsState] = useState(Number(localStorage.getItem('chat.camFps')) || 30);
  const [scrRes, setScrResState] = useState(localStorage.getItem('chat.scrRes') || 'r1080');
  const [scrFps, setScrFpsState] = useState(Number(localStorage.getItem('chat.scrFps')) || 60);
  const [stats, setStats] = useState(null); // { cam: {...}|null, screen: {...}|null }

  const pcRef = useRef(null);
  const inboxRef = useRef(null);
  const outboxRef = useRef({});
  const micStreamRef = useRef(null);
  const camStreamRef = useRef(null); // своя камера
  const scrStreamRef = useRef(null); // своя демонстрация
  const camSenderRef = useRef(null);
  const scrSenderRef = useRef(null);
  const pendingOfferRef = useRef(null);
  const pendingIceRef = useRef([]);
  const makingOfferRef = useRef(false);
  const acceptedRef = useRef(false);
  const peerRef = useRef(null);
  // Пресеты качества запоминаются отдельно для камеры и демонстрации
  const camMediaRef = useRef({
    ...mediaPreset(localStorage.getItem('chat.camRes') || 'r720', Number(localStorage.getItem('chat.camFps')) || 30),
    key: localStorage.getItem('chat.camRes') || 'r720',
  });
  const scrMediaRef = useRef({
    ...mediaPreset(localStorage.getItem('chat.scrRes') || 'r1080', Number(localStorage.getItem('chat.scrFps')) || 60),
    key: localStorage.getItem('chat.scrRes') || 'r1080',
  });
  // Входящие треки: звук — в общий поток, видео — по контейнерам камеры и демки.
  // Иначе включение видео затирает поток с голосом и собеседник «немеет».
  const remoteAudioRef = useRef(null);
  const remoteCamRef = useRef(null);
  const remoteScrRef = useRef(null);
  const kindMapRef = useRef({}); // streamId -> 'cam' | 'screen' (из сигнала media)
  const videoTracksRef = useRef([]); // { track, streamId, which }
  const audioCtxRef = useRef(null);
  const gainRef = useRef(null);
  const outTrackRef = useRef(null);
  const beeperRef = useRef(makeBeeper());
  const ringTimerRef = useRef(null);

  // ---------- отправка сигналов ----------
  const peerChannel = useCallback(async (peerId) => {
    let entry = outboxRef.current[peerId];
    if (!entry) {
      const channel = supabase.channel(userChannel(peerId), {
        config: { broadcast: { self: false, ack: true } },
      });
      const ready = new Promise((resolve) => {
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') resolve(true);
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') resolve(false);
        });
      });
      entry = { channel, ready };
      outboxRef.current[peerId] = entry;
    }
    await entry.ready;
    return entry.channel;
  }, []);

  const sendTo = useCallback(
    async (peerId, event, data = {}) => {
      try {
        const ch = await peerChannel(peerId);
        const res = await ch.send({ type: 'broadcast', event, payload: { from: myId, to: peerId, ...data } });
        console.log('[звонок] отправлено', event, '->', peerId, res);
      } catch (e) {
        console.error('Сигнал не ушёл:', event, e);
      }
    },
    [myId, peerChannel]
  );

  // ---------- завершение ----------
  const cleanup = useCallback(() => {
    beeperRef.current.stop();
    if (ringTimerRef.current) {
      clearInterval(ringTimerRef.current);
      ringTimerRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.onnegotiationneeded = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    camStreamRef.current?.getTracks().forEach((t) => t.stop());
    scrStreamRef.current?.getTracks().forEach((t) => t.stop());
    outTrackRef.current?.stop();
    outTrackRef.current = null;
    gainRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    micStreamRef.current = null;
    camStreamRef.current = null;
    scrStreamRef.current = null;
    camSenderRef.current = null;
    scrSenderRef.current = null;
    pendingOfferRef.current = null;
    pendingIceRef.current = [];
    acceptedRef.current = false;
    makingOfferRef.current = false;
    peerRef.current = null;
    remoteAudioRef.current = null;
    remoteCamRef.current = null;
    remoteScrRef.current = null;
    kindMapRef.current = {};
    videoTracksRef.current = [];
    setRemoteStream(null);
    setRemoteCam(null);
    setRemoteScreen(null);
    setRemoteCamOn(false);
    setRemoteScreenOn(false);
    setLocalCam(null);
    setLocalScreen(null);
    setCameraOn(false);
    setScreenOn(false);
    setMicOn(true);
    setStats(null);
    setCall(null);
  }, []);

  const applyBitrate = useCallback(async (sender, isScreen) => {
    if (!sender) return;
    const preset = (isScreen ? scrMediaRef : camMediaRef).current;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = preset.bitrate;
      params.encodings[0].maxFramerate = preset.fps;
      params.degradationPreference = isScreen ? 'maintain-framerate' : 'balanced';
      await sender.setParameters(params);
    } catch (e) {
      console.warn('Битрейт не применился:', e);
    }
  }, []);

  // ---------- раскладка чужих видеотреков: камера и демка — раздельно ----------
  const hasLive = (s) =>
    !!s && s.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted);

  const syncRemoteVideo = () => {
    setRemoteCamOn(hasLive(remoteCamRef.current));
    setRemoteScreenOn(hasLive(remoteScrRef.current));
  };

  const placeVideoTrack = (rec) => {
    const ref = rec.which === 'screen' ? remoteScrRef : remoteCamRef;
    if (!ref.current) ref.current = new MediaStream();
    if (!ref.current.getTracks().includes(rec.track)) ref.current.addTrack(rec.track);
    if (rec.which === 'screen') setRemoteScreen(ref.current);
    else setRemoteCam(ref.current);
    syncRemoteVideo();
  };

  // Сигнал media расставляет уже пришедшие треки по местам
  const reclassify = () => {
    for (const rec of videoTracksRef.current) {
      const want = kindMapRef.current[rec.streamId];
      if (!want || want === rec.which) continue;
      try {
        remoteCamRef.current?.removeTrack(rec.track);
        remoteScrRef.current?.removeTrack(rec.track);
      } catch (_) {}
      rec.which = want;
      placeVideoTrack(rec);
    }
    syncRemoteVideo();
  };

  // Сообщаем собеседнику, какой поток — камера, а какой — демонстрация
  const sendMediaSignal = useCallback(() => {
    const peerId = peerRef.current;
    if (!peerId) return;
    sendTo(peerId, 'media', {
      cam: camStreamRef.current?.id ?? null,
      screen: scrStreamRef.current?.id ?? null,
    });
  }, [sendTo]);

  // ---------- соединение ----------
  const createPeer = useCallback(
    (peerId) => {
      const pc = new RTCPeerConnection(ICE);
      peerRef.current = peerId;

      // Если камера/демка уже включены — сразу добавляем их треки
      const camTrack = camStreamRef.current?.getVideoTracks()[0];
      if (camTrack) {
        camSenderRef.current = pc.addTrack(camTrack, camStreamRef.current);
        applyBitrate(camSenderRef.current, false);
      }
      const scrTrack = scrStreamRef.current?.getVideoTracks()[0];
      if (scrTrack) {
        scrSenderRef.current = pc.addTrack(scrTrack, scrStreamRef.current);
        applyBitrate(scrSenderRef.current, true);
      }

      pc.onicecandidate = (e) => {
        if (e.candidate) sendTo(peerId, 'ice', { candidate: e.candidate.toJSON() });
      };

      pc.ontrack = (e) => {
        const streamId = e.streams[0]?.id ?? '';
        if (e.track.kind === 'audio') {
          // Голос — в общий звуковой поток
          if (!remoteAudioRef.current) remoteAudioRef.current = new MediaStream();
          const a = remoteAudioRef.current;
          if (!a.getTracks().includes(e.track)) a.addTrack(e.track);
          setRemoteStream(a);
          e.track.onended = () => {
            try {
              a.removeTrack(e.track);
            } catch (_) {}
          };
          return;
        }
        // Видео: камера или демка? Если сигнал media ещё не пришёл —
        // ставим в свободный слот, потом reclassify расставит по местам
        let which = kindMapRef.current[streamId];
        if (!which) {
          const camBusy = hasLive(remoteCamRef.current);
          const scrBusy = hasLive(remoteScrRef.current);
          which = camBusy && !scrBusy ? 'screen' : !camBusy && scrBusy ? 'cam' : 'screen';
        }
        const rec = { track: e.track, streamId, which };
        videoTracksRef.current.push(rec);
        placeVideoTrack(rec);
        e.track.onunmute = syncRemoteVideo;
        e.track.onmute = syncRemoteVideo;
        e.track.onended = () => {
          try {
            remoteCamRef.current?.removeTrack(e.track);
            remoteScrRef.current?.removeTrack(e.track);
          } catch (_) {}
          syncRemoteVideo();
        };
      };

      pc.onnegotiationneeded = async () => {
        try {
          makingOfferRef.current = true;
          await pc.setLocalDescription();
          await sendTo(peerId, 'offer', { sdp: pc.localDescription.toJSON() });
        } catch (e) {
          console.error('Не удалось создать offer:', e);
        } finally {
          makingOfferRef.current = false;
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          beeperRef.current.stop();
          setCall((c) => (c ? { ...c, status: 'active' } : c));
        }
        if (pc.connectionState === 'failed') cleanup();
      };

      pcRef.current = pc;
      return pc;
    },
    [sendTo, cleanup, applyBitrate]
  );

  const addMic = useCallback(async (pc) => {
    const preferred = localStorage.getItem('chat.mic');
    // Если индикатор выяснил, что обработка звука глушит микрофон — работаем без неё
    const raw = localStorage.getItem('chat.audioProcessing') === 'off';
    const audio = raw
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    // Строгий выбор устройства: «ideal» WebView2 игнорирует и берёт микрофон по умолчанию
    let stream;
    if (preferred) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { ...audio, deviceId: { exact: preferred } },
        });
      } catch (_) {
        stream = await navigator.mediaDevices.getUserMedia({ audio });
      }
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio });
    }
    micStreamRef.current = stream;
    const startMuted = localStorage.getItem('chat.startMuted') === '1';
    if (startMuted) {
      stream.getAudioTracks().forEach((t) => (t.enabled = false));
      setMicOn(false);
    }

    // Пропускаем микрофон через регулятор громкости.
    // Если звуковой движок спит (бывает в WebView2) — шлём микрофон напрямую, голос важнее регулировки.
    let outStream = stream;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      await ctx.resume?.().catch(() => {});
      if (ctx.state !== 'running') throw new Error('аудиоконтекст спит');
      const src = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      // В настройках громкость хранится в процентах (0–200), здесь нужен множитель
      const saved = parseFloat(localStorage.getItem('chat.micVolume') ?? '100');
      gain.gain.value = Number.isFinite(saved) ? saved / 100 : 1;
      const dest = ctx.createMediaStreamDestination();
      src.connect(gain).connect(dest);
      audioCtxRef.current = ctx;
      gainRef.current = gain;
      outStream = dest.stream;
      outTrackRef.current = dest.stream.getAudioTracks()[0] ?? null;
    } catch (e) {
      console.warn('Регулятор громкости недоступен, шлём микрофон напрямую:', e);
    }

    outStream.getAudioTracks().forEach((t) => pc.addTrack(t, outStream));
  }, []);

  const drainIce = useCallback(async (pc) => {
    for (const c of pendingIceRef.current) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c));
      } catch (e) {
        console.warn('ice:', e);
      }
    }
    pendingIceRef.current = [];
  }, []);

  const answerOffer = useCallback(
    async (from, sdp) => {
      const pc = pcRef.current;
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await drainIce(pc);
      await pc.setLocalDescription();
      await sendTo(from, 'answer', { sdp: pc.localDescription.toJSON() });
    },
    [sendTo, drainIce]
  );

  // ---------- действия пользователя ----------
  const startCall = useCallback(
    async (peerId) => {
      if (call) return;
      try {
        setCall({ peerId, status: 'outgoing' });
        beeperRef.current.start(480, 3000, 0.9);
        await sendTo(peerId, 'ring');
        // Повторяем вызов — на случай, если канал собеседника ещё не поднялся
        let tries = 0;
        ringTimerRef.current = setInterval(() => {
          if (++tries > 12 || acceptedRef.current) {
            clearInterval(ringTimerRef.current);
            ringTimerRef.current = null;
            return;
          }
          sendTo(peerId, 'ring');
        }, 1500);
        const pc = createPeer(peerId);
        await addMic(pc);
      } catch (e) {
        alert('Микрофон недоступен: ' + e.message);
        cleanup();
      }
    },
    [call, sendTo, createPeer, addMic, cleanup]
  );

  const acceptCall = useCallback(async () => {
    const from = call?.peerId;
    if (!from) return;
    beeperRef.current.stop();
    acceptedRef.current = true;
    try {
      const pc = createPeer(from);
      await addMic(pc);
      await sendTo(from, 'accepted');
      if (pendingOfferRef.current) {
        const sdp = pendingOfferRef.current;
        pendingOfferRef.current = null;
        await answerOffer(from, sdp);
      }
      setCall({ peerId: from, status: 'active' });
    } catch (e) {
      alert('Не удалось принять звонок: ' + e.message);
      sendTo(from, 'hangup');
      cleanup();
    }
  }, [call, createPeer, addMic, sendTo, answerOffer, cleanup]);

  const endCall = useCallback(() => {
    const peerId = call?.peerId ?? peerRef.current;
    if (peerId) sendTo(peerId, 'hangup');
    cleanup();
  }, [call, sendTo, cleanup]);

  const setMicGain = useCallback((value) => {
    // value — множитель (0–2), в настройках храним проценты (0–200)
    localStorage.setItem('chat.micVolume', String(Math.round(value * 100)));
    if (gainRef.current) gainRef.current.gain.value = value;
  }, []);

  // Горячая смена микрофона прямо во время звонка
  const setMicDevice = useCallback(async (deviceId) => {
    localStorage.setItem('chat.mic', deviceId ?? '');
    if (!pcRef.current) return; // вне звонка — применится при старте следующего
    try {
      const oldTrack = outTrackRef.current ?? micStreamRef.current?.getAudioTracks()[0];
      const wasEnabled = oldTrack ? oldTrack.enabled : true;

      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      outTrackRef.current?.stop();
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
      gainRef.current = null;

      const raw = localStorage.getItem('chat.audioProcessing') === 'off';
      const audio = raw
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      let stream;
      if (deviceId) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { ...audio, deviceId: { exact: deviceId } },
          });
        } catch (_) {
          stream = await navigator.mediaDevices.getUserMedia({ audio });
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio });
      }
      micStreamRef.current = stream;

      let outStream = stream;
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        await ctx.resume?.().catch(() => {});
        if (ctx.state !== 'running') throw new Error('аудиоконтекст спит');
        const src = ctx.createMediaStreamSource(stream);
        const gain = ctx.createGain();
        const saved = parseFloat(localStorage.getItem('chat.micVolume') ?? '100');
        gain.gain.value = Number.isFinite(saved) ? saved / 100 : 1;
        const dest = ctx.createMediaStreamDestination();
        src.connect(gain).connect(dest);
        audioCtxRef.current = ctx;
        gainRef.current = gain;
        outStream = dest.stream;
      } catch (e) {
        console.warn('Регулятор громкости недоступен, шлём микрофон напрямую:', e);
      }

      const newTrack = outStream.getAudioTracks()[0];
      if (!newTrack) return;
      newTrack.enabled = wasEnabled;
      outTrackRef.current = newTrack;

      const sender = pcRef.current?.getSenders().find((s) => s.track?.kind === 'audio');
      if (sender) await sender.replaceTrack(newTrack);
      setMicOn(wasEnabled);
    } catch (e) {
      alert('Не удалось переключить микрофон: ' + e.message);
    }
  }, []);

  const toggleMic = useCallback(() => {
    const track = outTrackRef.current ?? micStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
  }, []);

  // Камера и демонстрация — два независимых потока, работают одновременно
  const stopCamera = useCallback(async () => {
    camStreamRef.current?.getTracks().forEach((t) => t.stop());
    camStreamRef.current = null;
    if (camSenderRef.current) {
      try {
        await camSenderRef.current.replaceTrack(null);
      } catch (_) {}
    }
    setLocalCam(null);
    setCameraOn(false);
    sendMediaSignal();
  }, [sendMediaSignal]);

  const stopScreen = useCallback(async () => {
    scrStreamRef.current?.getTracks().forEach((t) => t.stop());
    scrStreamRef.current = null;
    if (scrSenderRef.current) {
      try {
        await scrSenderRef.current.replaceTrack(null);
      } catch (_) {}
    }
    setLocalScreen(null);
    setScreenOn(false);
    sendMediaSignal();
  }, [sendMediaSignal]);

  const toggleCamera = useCallback(async () => {
    if (cameraOn) return stopCamera();
    const p = camMediaRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: p.width },
          height: { ideal: p.height },
          frameRate: { ideal: p.fps },
        },
      });
      const track = stream.getVideoTracks()[0];
      track.contentHint = 'motion';
      camStreamRef.current = stream;
      const pc = pcRef.current;
      if (pc) {
        if (camSenderRef.current) await camSenderRef.current.replaceTrack(track);
        else camSenderRef.current = pc.addTrack(track, stream);
        await applyBitrate(camSenderRef.current, false);
      }
      track.onended = () => stopCamera();
      setLocalCam(stream);
      setCameraOn(true);
      sendMediaSignal();
    } catch (e) {
      alert('Камера недоступна: ' + e.message);
    }
  }, [cameraOn, stopCamera, applyBitrate, sendMediaSignal]);

  const toggleScreen = useCallback(async () => {
    if (screenOn) return stopScreen();
    const p = scrMediaRef.current;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: p.width },
          height: { ideal: p.height },
          frameRate: { ideal: p.fps },
        },
        audio: true,
      });
      const track = stream.getVideoTracks()[0];
      track.contentHint = 'motion';
      scrStreamRef.current = stream;
      const pc = pcRef.current;
      if (pc) {
        if (scrSenderRef.current) await scrSenderRef.current.replaceTrack(track);
        else scrSenderRef.current = pc.addTrack(track, stream);
        await applyBitrate(scrSenderRef.current, true);
      }
      track.onended = () => stopScreen();
      setLocalScreen(stream);
      setScreenOn(true);
      sendMediaSignal();
    } catch (e) {
      if (e.name !== 'NotAllowedError') alert('Демонстрация не началась: ' + e.message);
    }
  }, [screenOn, stopScreen, applyBitrate, sendMediaSignal]);

  // Смена качества камеры или демки — отдельно и на лету
  const setQuality = useCallback(
    async (target, { res, fps: fpsValue }) => {
      const ref = target === 'screen' ? scrMediaRef : camMediaRef;
      const key = res ?? ref.current.key;
      const f = Number(fpsValue) || ref.current.fps;
      ref.current = { ...mediaPreset(key, f), key };
      localStorage.setItem(target === 'screen' ? 'chat.scrRes' : 'chat.camRes', key);
      localStorage.setItem(target === 'screen' ? 'chat.scrFps' : 'chat.camFps', String(f));
      if (target === 'screen') {
        setScrResState(key);
        setScrFpsState(f);
      } else {
        setCamResState(key);
        setCamFpsState(f);
      }
      // Если источник жив — применяем к текущему треку
      const stream = target === 'screen' ? scrStreamRef.current : camStreamRef.current;
      const sender = target === 'screen' ? scrSenderRef.current : camSenderRef.current;
      const track = stream?.getVideoTracks()[0];
      if (!track) return;
      try {
        await track.applyConstraints({
          width: { ideal: ref.current.width },
          height: { ideal: ref.current.height },
          frameRate: { ideal: ref.current.fps },
        });
      } catch (e) {
        console.warn('Устройство не тянет пресет:', e);
      }
      await applyBitrate(sender, target === 'screen');
    },
    [applyBitrate]
  );

  useEffect(() => {
    if (!localCam && !localScreen) {
      setStats(null);
      return;
    }
    const grab = (ref) => {
      const s = ref.current?.getVideoTracks()[0]?.getSettings();
      return s ? { w: s.width, h: s.height, fps: Math.round(s.frameRate ?? 0) } : null;
    };
    const id = setInterval(() => {
      setStats({ cam: grab(camStreamRef), screen: grab(scrStreamRef) });
    }, 1000);
    return () => clearInterval(id);
  }, [localCam, localScreen]);

  // ---------- приём сигналов ----------
  const handleSignal = useCallback(
    async (event, payload) => {
      console.log('[звонок] получено', event, payload);
      if (!payload || payload.to !== myId || payload.from === myId) return;
      const from = payload.from;
      const pc = pcRef.current;

      if (event === 'ring') {
        if (call?.peerId === from) return; // это повтор того же вызова
        if (pcRef.current || call) {
          sendTo(from, 'busy');
          return;
        }
        beeperRef.current.start(660, 2200, 0.5);
        setCall({ peerId: from, status: 'incoming' });
        return;
      }

      if (event === 'accepted') {
        acceptedRef.current = true;
        if (ringTimerRef.current) {
          clearInterval(ringTimerRef.current);
          ringTimerRef.current = null;
        }
        beeperRef.current.stop();
        setCall((c) => (c ? { ...c, status: 'active' } : c));
        return;
      }

      if (event === 'busy') {
        alert('Собеседник уже разговаривает.');
        cleanup();
        return;
      }

      if (event === 'offer') {
        if (!pc) {
          pendingOfferRef.current = payload.sdp;
          return;
        }
        const polite = String(myId) > String(from);
        const collision = makingOfferRef.current || pc.signalingState !== 'stable';
        if (collision && !polite) return;
        try {
          // Вежливая сторона откатывает свой оффер при одновременном звонке
          if (collision) await pc.setLocalDescription({ type: 'rollback' });
          await answerOffer(from, payload.sdp);
        } catch (e) {
          console.error('offer:', e);
        }
        return;
      }

      if (event === 'answer' && pc) {
        try {
          if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            await drainIce(pc);
          }
        } catch (e) {
          console.error('answer:', e);
        }
        return;
      }

      if (event === 'ice') {
        if (!pc || !pc.remoteDescription) {
          pendingIceRef.current.push(payload.candidate);
          return;
        }
        try {
          await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } catch (e) {
          console.warn('ice:', e);
        }
        return;
      }

      if (event === 'hangup') cleanup();

      // Собеседник сообщил, какой его поток — камера, а какой — демонстрация
      if (event === 'media') {
        const m = {};
        if (payload.cam) m[payload.cam] = 'cam';
        if (payload.screen) m[payload.screen] = 'screen';
        kindMapRef.current = m;
        reclassify();
        return;
      }
    },
    [myId, call, sendTo, answerOffer, drainIce, cleanup]
  );

  const handlerRef = useRef(handleSignal);
  useEffect(() => {
    handlerRef.current = handleSignal;
  }, [handleSignal]);

  // Свой личный канал — сюда приходят все сигналы
  useEffect(() => {
    if (!myId) return;
    const events = ['ring', 'accepted', 'busy', 'offer', 'answer', 'ice', 'hangup', 'media'];
    const ch = supabase.channel(userChannel(myId), { config: { broadcast: { self: false } } });
    events.forEach((ev) =>
      ch.on('broadcast', { event: ev }, ({ payload }) => handlerRef.current(ev, payload))
    );
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') console.log('Готов принимать звонки');
    });
    inboxRef.current = ch;

    return () => {
      supabase.removeChannel(ch);
      inboxRef.current = null;
      Object.values(outboxRef.current).forEach((e) => supabase.removeChannel(e.channel));
      outboxRef.current = {};
    };
  }, [myId]);

  return {
    call,
    remoteStream,
    remoteCam,
    remoteScreen,
    remoteCamOn,
    remoteScreenOn,
    localCam,
    localScreen,
    micOn,
    cameraOn,
    screenOn,
    camRes,
    camFps,
    scrRes,
    scrFps,
    stats,
    startCall,
    acceptCall,
    endCall,
    toggleMic,
    setMicGain,
    setMicDevice,
    toggleCamera,
    toggleScreen,
    setQuality,
  };
}
