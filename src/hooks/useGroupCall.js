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
  const [remoteStreams, setRemoteStreams] = useState({}); // peerId -> { stream, videoOn }
  const [participants, setParticipants] = useState([]); // [{ id, name }] из presence
  const [localVideo, setLocalVideo] = useState(null);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [resolution, setResState] = useState('r1080');
  const [fps, setFpsState] = useState(60);
  const [stats, setStats] = useState(null);

  const peersRef = useRef({}); // peerId -> { pc, makingOffer, pendingIce, videoSender }
  const channelRef = useRef(null);
  const micStreamRef = useRef(null);
  const outStreamRef = useRef(null);
  const outTrackRef = useRef(null);
  const videoStreamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const gainRef = useRef(null);
  const resRef = useRef('r1080');
  const fpsRef = useRef(60);
  const mediaRef = useRef(mediaPreset('r1080', 60));
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
    const preset = mediaRef.current;
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

  const createPeer = useCallback(
    (peerId) => {
      const existing = peersRef.current[peerId];
      if (existing) return existing;

      const pc = new RTCPeerConnection(ICE);
      const entry = { pc, makingOffer: false, pendingIce: [], videoSender: null };
      peersRef.current[peerId] = entry;

      // Сразу добавляем свои треки — это запустит onnegotiationneeded
      const aTrack = outTrackRef.current;
      if (aTrack && outStreamRef.current) pc.addTrack(aTrack, outStreamRef.current);
      const vTrack = videoStreamRef.current?.getVideoTracks()[0];
      if (vTrack && videoStreamRef.current) {
        entry.videoSender = pc.addTrack(vTrack, videoStreamRef.current);
        applyBitrate(entry.videoSender, screenOnRef.current);
      }

      pc.onicecandidate = (e) => {
        if (e.candidate) send('ice', { to: peerId, candidate: e.candidate.toJSON() });
      };

      pc.ontrack = (e) => {
        const stream = e.streams[0];
        if (!stream) return;
        setRemoteStreams((m) => ({ ...m, [peerId]: { stream, videoOn: hasLiveVideo(stream) } }));
        const sync = () =>
          setRemoteStreams((m) =>
            m[peerId] ? { ...m, [peerId]: { ...m[peerId], videoOn: hasLiveVideo(stream) } } : m
          );
        e.track.onunmute = sync;
        e.track.onmute = sync;
        e.track.onended = sync;
        stream.onaddtrack = sync;
        stream.onremovetrack = sync;
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
        if (channelRef.current) createPeer(from);
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
    videoStreamRef.current?.getTracks().forEach((t) => t.stop());
    outTrackRef.current?.stop();
    outTrackRef.current = null;
    outStreamRef.current = null;
    gainRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    micStreamRef.current = null;
    videoStreamRef.current = null;
    if (channelRef.current) {
      const ch = channelRef.current;
      channelRef.current = null;
      ch.untrack().catch(() => {});
      supabase.removeChannel(ch);
    }
    setRemoteStreams({});
    setParticipants([]);
    setLocalVideo(null);
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
        const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        if (preferred) audio.deviceId = { ideal: preferred };
        const stream = await navigator.mediaDevices.getUserMedia({ audio });
        micStreamRef.current = stream;
        const startMuted = localStorage.getItem('chat.startMuted') === '1';
        if (startMuted) {
          stream.getAudioTracks().forEach((t) => (t.enabled = false));
          setMicOn(false);
        }

        let outStream = stream;
        try {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
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
        ['hello', 'offer', 'answer', 'ice', 'leave'].forEach((ev) =>
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

  const toggleMic = useCallback(() => {
    const track = outTrackRef.current ?? micStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
  }, []);

  const stopVideo = useCallback(async () => {
    videoStreamRef.current?.getTracks().forEach((t) => t.stop());
    videoStreamRef.current = null;
    for (const entry of Object.values(peersRef.current)) {
      if (entry.videoSender) {
        try {
          await entry.videoSender.replaceTrack(null);
        } catch (_) {}
      }
    }
    setLocalVideo(null);
    setCameraOn(false);
    setScreenOn(false);
    setStats(null);
  }, []);

  const setVideoTrack = useCallback(
    async (track, stream, isScreen) => {
      track.contentHint = 'motion';
      videoStreamRef.current?.getTracks().forEach((t) => t.stop());
      videoStreamRef.current = stream;
      for (const entry of Object.values(peersRef.current)) {
        if (entry.videoSender) {
          await entry.videoSender.replaceTrack(track);
        } else {
          entry.videoSender = entry.pc.addTrack(track, stream);
        }
        await applyBitrate(entry.videoSender, isScreen);
      }
      setLocalVideo(stream);
      track.onended = () => stopVideo();
    },
    [applyBitrate, stopVideo]
  );

  const toggleCamera = useCallback(async () => {
    if (cameraOn) return stopVideo();
    const p = mediaRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: p.width },
          height: { ideal: p.height },
          frameRate: { ideal: p.fps },
        },
      });
      await setVideoTrack(stream.getVideoTracks()[0], stream, false);
      setCameraOn(true);
      setScreenOn(false);
    } catch (e) {
      alert('Камера недоступна: ' + e.message);
    }
  }, [cameraOn, stopVideo, setVideoTrack]);

  const toggleScreen = useCallback(async () => {
    if (screenOn) return stopVideo();
    const p = mediaRef.current;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: p.width },
          height: { ideal: p.height },
          frameRate: { ideal: p.fps },
        },
        audio: true,
      });
      await setVideoTrack(stream.getVideoTracks()[0], stream, true);
      setScreenOn(true);
      setCameraOn(false);
    } catch (e) {
      if (e.name !== 'NotAllowedError') alert('Демонстрация не началась: ' + e.message);
    }
  }, [screenOn, stopVideo, setVideoTrack]);

  const applyMediaPreset = useCallback(
    async (isScreen) => {
      const p = mediaRef.current;
      const track = videoStreamRef.current?.getVideoTracks()[0];
      if (!track) return;
      try {
        await track.applyConstraints({
          width: { ideal: p.width },
          height: { ideal: p.height },
          frameRate: { ideal: p.fps },
        });
      } catch (e) {
        console.warn('Устройство не тянет пресет:', e);
      }
      for (const entry of Object.values(peersRef.current)) {
        await applyBitrate(entry.videoSender, isScreen);
      }
    },
    [applyBitrate]
  );

  const setResolution = useCallback(
    async (key) => {
      resRef.current = key;
      setResState(key);
      mediaRef.current = mediaPreset(key, fpsRef.current);
      await applyMediaPreset(screenOnRef.current);
    },
    [applyMediaPreset]
  );

  const setFps = useCallback(
    async (value) => {
      const n = Number(value) || 60;
      fpsRef.current = n;
      setFpsState(n);
      mediaRef.current = mediaPreset(resRef.current, n);
      await applyMediaPreset(screenOnRef.current);
    },
    [applyMediaPreset]
  );

  // Статистика по своему видео
  useEffect(() => {
    if (!localVideo) return;
    const id = setInterval(() => {
      const s = videoStreamRef.current?.getVideoTracks()[0]?.getSettings();
      if (s) setStats({ w: s.width, h: s.height, fps: Math.round(s.frameRate ?? 0) });
    }, 1000);
    return () => clearInterval(id);
  }, [localVideo]);

  return {
    call,
    participants,
    remoteStreams,
    localVideo,
    micOn,
    cameraOn,
    screenOn,
    resolution,
    fps,
    stats,
    join,
    leave,
    toggleMic,
    setMicGain,
    toggleCamera,
    toggleScreen,
    setResolution,
    setFps,
  };
}
