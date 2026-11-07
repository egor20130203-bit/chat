import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { mediaPreset } from './useCall';

const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
};

const roomChannel = (id) => `rtc_room_${id}`;

const hasLiveVideo = (stream) =>
  !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted);

// Групповой звонок: mesh-схема — каждый соединён с каждым напрямую.
// Новый участник шлёт hello, остальные отвечают ему offer'ами.
export function useGroupCall(myId, myName) {
  const [call, setCall] = useState(null); // { roomId, status: 'active' }
  // peerId -> { audio, cam, screen, camOn, screenOn }
  const [remoteStreams, setRemoteStreams] = useState({});
  const [participants, setParticipants] = useState([]); // [{ id, name }] из presence
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

  // peerId -> { pc, makingOffer, pendingIce, camSender, scrSender,
  //             audioC, camC, scrC, kindMap, vTracks }
  const peersRef = useRef({});
  const channelRef = useRef(null);
  const micStreamRef = useRef(null);
  const outStreamRef = useRef(null);
  const outTrackRef = useRef(null);
  const camStreamRef = useRef(null); // своя камера
  const scrStreamRef = useRef(null); // своя демонстрация
  const audioCtxRef = useRef(null);
  const gainRef = useRef(null);
  // Пресеты качества запоминаются отдельно для камеры и демонстрации
  const camMediaRef = useRef({
    ...mediaPreset(localStorage.getItem('chat.camRes') || 'r720', Number(localStorage.getItem('chat.camFps')) || 30),
    key: localStorage.getItem('chat.camRes') || 'r720',
  });
  const scrMediaRef = useRef({
    ...mediaPreset(localStorage.getItem('chat.scrRes') || 'r1080', Number(localStorage.getItem('chat.scrFps')) || 60),
    key: localStorage.getItem('chat.scrRes') || 'r1080',
  });
  const myNameRef = useRef(myName);
  useEffect(() => {
    myNameRef.current = myName;
  }, [myName]);

  const send = useCallback(
    async (event, payload = {}) => {
      const ch = channelRef.current;
      if (!ch) return;
      try {
        await ch.send({ type: 'broadcast', event, payload: { from: myId, ...payload } });
      } catch (e) {
        console.error('Сигнал не ушёл:', event, e);
      }
    },
    [myId]
  );

  const closePeer = useCallback((peerId) => {
    const entry = peersRef.current[peerId];
    if (entry) {
      try {
        entry.pc.onicecandidate = null;
        entry.pc.ontrack = null;
        entry.pc.onnegotiationneeded = null;
        entry.pc.close();
      } catch (_) {}
      delete peersRef.current[peerId];
    }
    setRemoteStreams((m) => {
      if (!m[peerId]) return m;
      const next = { ...m };
      delete next[peerId];
      return next;
    });
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

  // ---------- раскладка видео участника: камера и демка — раздельно ----------
  const syncPeerVideo = (peerId, entry) => {
    setRemoteStreams((m) =>
      m[peerId]
        ? {
            ...m,
            [peerId]: {
              ...m[peerId],
              cam: entry.camC ?? null,
              screen: entry.scrC ?? null,
              camOn: hasLiveVideo(entry.camC),
              screenOn: hasLiveVideo(entry.scrC),
            },
          }
        : m
    );
  };

  const placePeerVideo = (peerId, entry, rec) => {
    if (rec.which === 'screen') {
      if (!entry.scrC) entry.scrC = new MediaStream();
      if (!entry.scrC.getTracks().includes(rec.track)) entry.scrC.addTrack(rec.track);
    } else {
      if (!entry.camC) entry.camC = new MediaStream();
      if (!entry.camC.getTracks().includes(rec.track)) entry.camC.addTrack(rec.track);
    }
    syncPeerVideo(peerId, entry);
  };

  // Сигнал media от участника: какой его поток — камера, а какой — демка
  const reclassifyPeer = (peerId, entry) => {
    for (const rec of entry.vTracks) {
      const want = entry.kindMap[rec.streamId];
      if (!want || want === rec.which) continue;
      try {
        entry.camC?.removeTrack(rec.track);
        entry.scrC?.removeTrack(rec.track);
      } catch (_) {}
      rec.which = want;
      placePeerVideo(peerId, entry, rec);
    }
    syncPeerVideo(peerId, entry);
  };

  const createPeer = useCallback(
    (peerId) => {
      const existing = peersRef.current[peerId];
      if (existing) return existing;

      const pc = new RTCPeerConnection(ICE);
      const entry = {
        pc,
        makingOffer: false,
        pendingIce: [],
        camSender: null,
        scrSender: null,
        audioC: null, // объединённый звук участника
        camC: null, // контейнер его камеры
        scrC: null, // контейнер его демонстрации
        kindMap: {}, // streamId -> 'cam' | 'screen' (из сигнала media)
        vTracks: [], // { track, streamId, which }
      };
      peersRef.current[peerId] = entry;

      // Сразу добавляем свои треки — это запустит onnegotiationneeded
      const aTrack = outTrackRef.current;
      if (aTrack && outStreamRef.current) pc.addTrack(aTrack, outStreamRef.current);
      const camTrack = camStreamRef.current?.getVideoTracks()[0];
      if (camTrack) {
        entry.camSender = pc.addTrack(camTrack, camStreamRef.current);
        applyBitrate(entry.camSender, false);
      }
      const scrTrack = scrStreamRef.current?.getVideoTracks()[0];
      if (scrTrack) {
        entry.scrSender = pc.addTrack(scrTrack, scrStreamRef.current);
        applyBitrate(entry.scrSender, true);
      }

      pc.onicecandidate = (e) => {
        if (e.candidate) send('ice', { to: peerId, candidate: e.candidate.toJSON() });
      };

      pc.ontrack = (e) => {
        const streamId = e.streams[0]?.id ?? '';
        if (e.track.kind === 'audio') {
          // Голос — в общий звуковой поток участника
          if (!entry.audioC) entry.audioC = new MediaStream();
          const a = entry.audioC;
          if (!a.getTracks().includes(e.track)) a.addTrack(e.track);
          setRemoteStreams((m) =>
            m[peerId]
              ? { ...m, [peerId]: { ...m[peerId], audio: a } }
              : { ...m, [peerId]: { audio: a, cam: null, screen: null, camOn: false, screenOn: false } }
          );
          e.track.onended = () => {
            try {
              a.removeTrack(e.track);
            } catch (_) {}
          };
          return;
        }
        // Видео: камера или демка? Если сигнал media ещё не пришёл —
        // ставим в свободный слот, потом media расставит по местам
        let which = entry.kindMap[streamId];
        if (!which) {
          const camBusy = hasLiveVideo(entry.camC);
          const scrBusy = hasLiveVideo(entry.scrC);
          which = camBusy && !scrBusy ? 'screen' : !camBusy && scrBusy ? 'cam' : 'screen';
        }
        const rec = { track: e.track, streamId, which };
        entry.vTracks.push(rec);
        placePeerVideo(peerId, entry, rec);
        e.track.onunmute = () => syncPeerVideo(peerId, entry);
        e.track.onmute = () => syncPeerVideo(peerId, entry);
        e.track.onended = () => {
          try {
            entry.camC?.removeTrack(e.track);
            entry.scrC?.removeTrack(e.track);
          } catch (_) {}
          syncPeerVideo(peerId, entry);
        };
      };

      pc.onnegotiationneeded = async () => {
        try {
          entry.makingOffer = true;
          await pc.setLocalDescription();
          await send('offer', { to: peerId, sdp: pc.localDescription.toJSON() });
        } catch (e) {
          console.error('Не удалось создать offer:', e);
        } finally {
          entry.makingOffer = false;
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
          try {
            pc.restartIce();
          } catch (_) {}
        }
      };

      return entry;
    },
    [send, applyBitrate]
  );

  const screenOnRef = useRef(false);
  useEffect(() => {
    screenOnRef.current = screenOn;
  }, [screenOn]);

  const drainIce = async (entry) => {
    for (const c of entry.pendingIce) {
      try {
        await entry.pc.addIceCandidate(new RTCIceCandidate(c));
      } catch (e) {
        console.warn('ice:', e);
      }
    }
    entry.pendingIce = [];
  };

  // ---------- приём сигналов ----------
  const handleSignal = useCallback(
    async (event, payload) => {
      if (!payload || payload.from === myId) return;
      if (payload.to && payload.to !== myId) return; // hello/leave — всем, остальное — адресно
      const from = payload.from;

      if (event === 'hello') {
        // Новый участник зашёл в звонок — создаём соединение, оффер уйдёт сам
        if (channelRef.current) {
          createPeer(from);
          // Сообщаем новичку, какой наш поток — камера, а какой — демка
          send('media', {
            cam: camStreamRef.current?.id ?? null,
            screen: scrStreamRef.current?.id ?? null,
          });
        }
        return;
      }

      if (event === 'offer') {
        const entry = createPeer(from);
        const pc = entry.pc;
        const polite = String(myId) > String(from);
        const collision = entry.makingOffer || pc.signalingState !== 'stable';
        if (collision && !polite) return;
        try {
          if (collision) await pc.setLocalDescription({ type: 'rollback' });
          await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          await drainIce(entry);
          await pc.setLocalDescription();
          await send('answer', { to: from, sdp: pc.localDescription.toJSON() });
        } catch (e) {
          console.error('offer:', e);
        }
        return;
      }

      if (event === 'answer') {
        const entry = peersRef.current[from];
        if (!entry) return;
        try {
          if (entry.pc.signalingState === 'have-local-offer') {
            await entry.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            await drainIce(entry);
          }
        } catch (e) {
          console.error('answer:', e);
        }
        return;
      }

      if (event === 'ice') {
        const entry = peersRef.current[from];
        if (!entry || !entry.pc.remoteDescription) {
          if (entry) entry.pendingIce.push(payload.candidate);
          return;
        }
        try {
          await entry.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } catch (e) {
          console.warn('ice:', e);
        }
        return;
      }

      if (event === 'leave') closePeer(from);

      // Участник сообщил, какой его поток — камера, а какой — демонстрация
      if (event === 'media') {
        const entry = peersRef.current[from];
        if (!entry) return;
        const m = {};
        if (payload.cam) m[payload.cam] = 'cam';
        if (payload.screen) m[payload.screen] = 'screen';
        entry.kindMap = m;
        reclassifyPeer(from, entry);
        return;
      }
    },
    [myId, createPeer, closePeer, send]
  );

  const handlerRef = useRef(handleSignal);
  useEffect(() => {
    handlerRef.current = handleSignal;
  }, [handleSignal]);

  // ---------- завершение ----------
  const cleanup = useCallback(() => {
    Object.keys(peersRef.current).forEach(closePeer);
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    camStreamRef.current?.getTracks().forEach((t) => t.stop());
    scrStreamRef.current?.getTracks().forEach((t) => t.stop());
    outTrackRef.current?.stop();
    outTrackRef.current = null;
    outStreamRef.current = null;
    gainRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    micStreamRef.current = null;
    camStreamRef.current = null;
    scrStreamRef.current = null;
    if (channelRef.current) {
      const ch = channelRef.current;
      channelRef.current = null;
      ch.untrack().catch(() => {});
      supabase.removeChannel(ch);
    }
    setRemoteStreams({});
    setParticipants([]);
    setLocalCam(null);
    setLocalScreen(null);
    setCameraOn(false);
    setScreenOn(false);
    setMicOn(true);
    setStats(null);
    setCall(null);
  }, [closePeer]);

  // Рвём звонок при закрытии приложения
  useEffect(() => {
    const onUnload = () => {
      if (channelRef.current) send('leave');
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [send]);

  // ---------- вход в звонок ----------
  const join = useCallback(
    async (roomId) => {
      if (call) return;
      try {
        // Микрофон через регулятор громкости — как в личном звонке
        const preferred = localStorage.getItem('chat.mic');
        const raw = localStorage.getItem('chat.audioProcessing') === 'off';
        const audio = raw
          ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
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
          outTrackRef.current = dest.stream.getAudioTracks()[0] ?? null;
        } catch (e) {
          console.warn('Регулятор громкости недоступен, шлём микрофон напрямую:', e);
          outTrackRef.current = stream.getAudioTracks()[0] ?? null;
        }
        outStreamRef.current = outStream;

        const ch = supabase.channel(roomChannel(roomId), {
          config: { broadcast: { self: false }, presence: { key: myId } },
        });
        ['hello', 'offer', 'answer', 'ice', 'leave', 'media'].forEach((ev) =>
          ch.on('broadcast', { event: ev }, ({ payload }) => handlerRef.current(ev, payload))
        );
        ch.on('presence', { event: 'sync' }, () => {
          const state = ch.presenceState();
          const list = Object.entries(state).map(([id, metas]) => ({ id, ...(metas?.[0] ?? {}) }));
          setParticipants(list);
          // Кто-то отвалился без leave — закрываем соединение
          const ids = new Set(list.map((p) => p.id));
          Object.keys(peersRef.current).forEach((pid) => {
            if (!ids.has(pid)) closePeer(pid);
          });
        });

        await new Promise((resolve) => {
          ch.subscribe((status) => {
            if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')
              resolve();
          });
        });
        channelRef.current = ch;
        setCall({ roomId, status: 'active' });
        await ch.track({ name: myNameRef.current });
        await send('hello');
      } catch (e) {
        alert('Не удалось войти в звонок: ' + e.message);
        cleanup();
      }
    },
    [call, myId, send, cleanup, closePeer]
  );

  const leave = useCallback(() => {
    send('leave');
    cleanup();
  }, [send, cleanup]);

  // ---------- управление ----------
  const setMicGain = useCallback((value) => {
    localStorage.setItem('chat.micVolume', String(Math.round(value * 100)));
    if (gainRef.current) gainRef.current.gain.value = value;
  }, []);

  // Горячая смена микрофона прямо во время звонка (для всех участников)
  const setMicDevice = useCallback(async (deviceId) => {
    localStorage.setItem('chat.mic', deviceId ?? '');
    if (!channelRef.current) return; // вне звонка — применится при входе
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

      for (const entry of Object.values(peersRef.current)) {
        const sender = entry.pc.getSenders().find((s) => s.track?.kind === 'audio');
        if (sender) {
          try {
            await sender.replaceTrack(newTrack);
          } catch (_) {}
        }
      }
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

  // Сообщаем всем участникам, какой наш поток — камера, а какой — демка
  const sendMediaSignal = useCallback(() => {
    if (!channelRef.current) return;
    send('media', {
      cam: camStreamRef.current?.id ?? null,
      screen: scrStreamRef.current?.id ?? null,
    });
  }, [send]);

  // Камера и демонстрация — два независимых потока, работают одновременно
  const stopCamera = useCallback(async () => {
    camStreamRef.current?.getTracks().forEach((t) => t.stop());
    camStreamRef.current = null;
    for (const entry of Object.values(peersRef.current)) {
      if (entry.camSender) {
        try {
          await entry.camSender.replaceTrack(null);
        } catch (_) {}
      }
    }
    setLocalCam(null);
    setCameraOn(false);
    sendMediaSignal();
  }, [sendMediaSignal]);

  const stopScreen = useCallback(async () => {
    scrStreamRef.current?.getTracks().forEach((t) => t.stop());
    scrStreamRef.current = null;
    for (const entry of Object.values(peersRef.current)) {
      if (entry.scrSender) {
        try {
          await entry.scrSender.replaceTrack(null);
        } catch (_) {}
      }
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
      for (const entry of Object.values(peersRef.current)) {
        if (entry.camSender) await entry.camSender.replaceTrack(track);
        else entry.camSender = entry.pc.addTrack(track, stream);
        await applyBitrate(entry.camSender, false);
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
      for (const entry of Object.values(peersRef.current)) {
        if (entry.scrSender) await entry.scrSender.replaceTrack(track);
        else entry.scrSender = entry.pc.addTrack(track, stream);
        await applyBitrate(entry.scrSender, true);
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
      const senderKey = target === 'screen' ? 'scrSender' : 'camSender';
      const track = stream?.getVideoTracks()[0];
      if (track) {
        try {
          await track.applyConstraints({
            width: { ideal: ref.current.width },
            height: { ideal: ref.current.height },
            frameRate: { ideal: ref.current.fps },
          });
        } catch (e) {
          console.warn('Устройство не тянет пресет:', e);
        }
      }
      for (const entry of Object.values(peersRef.current)) {
        await applyBitrate(entry[senderKey], target === 'screen');
      }
    },
    [applyBitrate]
  );

  // Статистика по своим видео
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

  return {
    call,
    participants,
    remoteStreams,
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
    join,
    leave,
    toggleMic,
    setMicGain,
    setMicDevice,
    toggleCamera,
    toggleScreen,
    setQuality,
  };
}
