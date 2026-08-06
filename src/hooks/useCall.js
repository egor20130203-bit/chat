import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

export const QUALITY = {
  hd60: { label: '720p 60', width: 1280, height: 720, fps: 60, bitrate: 4_000_000 },
  fhd120: { label: 'Full HD 120', width: 1920, height: 1080, fps: 120, bitrate: 12_000_000 },
  qhd90: { label: '2K 90', width: 2560, height: 1440, fps: 90, bitrate: 18_000_000 },
  uhd60: { label: '4K 60', width: 3840, height: 2160, fps: 60, bitrate: 32_000_000 },
};

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
  const [remoteStream, setRemoteStream] = useState(null);
  const [localVideo, setLocalVideo] = useState(null);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [quality, setQualityState] = useState('fhd120');
  const [stats, setStats] = useState(null);
  const [remoteVideoOn, setRemoteVideoOn] = useState(false);

  const pcRef = useRef(null);
  const inboxRef = useRef(null);
  const outboxRef = useRef({});
  const micStreamRef = useRef(null);
  const videoStreamRef = useRef(null);
  const videoSenderRef = useRef(null);
  const pendingOfferRef = useRef(null);
  const pendingIceRef = useRef([]);
  const makingOfferRef = useRef(false);
  const acceptedRef = useRef(false);
  const peerRef = useRef(null);
  const qualityRef = useRef('fhd120');
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
    videoStreamRef.current?.getTracks().forEach((t) => t.stop());
    outTrackRef.current?.stop();
    outTrackRef.current = null;
    gainRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    gainRef.current = null;
    micStreamRef.current = null;
    videoStreamRef.current = null;
    videoSenderRef.current = null;
    pendingOfferRef.current = null;
    pendingIceRef.current = [];
    acceptedRef.current = false;
    makingOfferRef.current = false;
    peerRef.current = null;
    setRemoteStream(null);
    setRemoteVideoOn(false);
    setLocalVideo(null);
    setCameraOn(false);
    setScreenOn(false);
    setMicOn(true);
    setStats(null);
    setCall(null);
  }, []);

  const applyBitrate = useCallback(async (sender, isScreen) => {
    if (!sender) return;
    const preset = QUALITY[qualityRef.current];
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

  // ---------- соединение ----------
  const createPeer = useCallback(
    (peerId) => {
      const pc = new RTCPeerConnection(ICE);
      peerRef.current = peerId;

      pc.onicecandidate = (e) => {
        if (e.candidate) sendTo(peerId, 'ice', { candidate: e.candidate.toJSON() });
      };

      pc.ontrack = (e) => {
        const stream = e.streams[0];
        setRemoteStream(stream);
        const sync = () =>
          setRemoteVideoOn(stream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted));
        sync();
        e.track.onunmute = sync;
        e.track.onmute = sync;
        e.track.onended = sync;
        stream.onaddtrack = sync;
        stream.onremovetrack = sync;
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
    [sendTo, cleanup]
  );

  const addMic = useCallback(async (pc) => {
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

    // Пропускаем микрофон через регулятор громкости
    let outStream = stream;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      const saved = parseFloat(localStorage.getItem('chat.micVolume') ?? '1');
      gain.gain.value = Number.isFinite(saved) ? saved : 1;
      const dest = ctx.createMediaStreamDestination();
      src.connect(gain).connect(dest);
      audioCtxRef.current = ctx;
      gainRef.current = gain;
      outStream = dest.stream;
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
    localStorage.setItem('chat.micVolume', String(value));
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
    if (videoSenderRef.current) {
      try {
        await videoSenderRef.current.replaceTrack(null);
      } catch (_) {}
    }
    setLocalVideo(null);
    setCameraOn(false);
    setScreenOn(false);
    setStats(null);
  }, []);

  const setVideoTrack = useCallback(
    async (track, stream, isScreen) => {
      const pc = pcRef.current;
      if (!pc) return;
      track.contentHint = 'motion';
      videoStreamRef.current?.getTracks().forEach((t) => t.stop());
      videoStreamRef.current = stream;

      if (videoSenderRef.current) {
        await videoSenderRef.current.replaceTrack(track);
      } else {
        videoSenderRef.current = pc.addTrack(track, stream);
      }
      await applyBitrate(videoSenderRef.current, isScreen);
      setLocalVideo(stream);
      track.onended = () => stopVideo();
    },
    [applyBitrate, stopVideo]
  );

  const toggleCamera = useCallback(async () => {
    if (cameraOn) return stopVideo();
    const p = QUALITY[qualityRef.current];
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
    const p = QUALITY[qualityRef.current];
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

  const setQuality = useCallback(
    async (key) => {
      qualityRef.current = key;
      setQualityState(key);
      const p = QUALITY[key];
      const track = videoStreamRef.current?.getVideoTracks()[0];
      if (track) {
        try {
          await track.applyConstraints({
            width: { ideal: p.width },
            height: { ideal: p.height },
            frameRate: { ideal: p.fps },
          });
        } catch (e) {
          console.warn('Устройство не тянет пресет:', e);
        }
        await applyBitrate(videoSenderRef.current, screenOn);
      }
    },
    [applyBitrate, screenOn]
  );

  useEffect(() => {
    if (!localVideo) return;
    const id = setInterval(() => {
      const s = videoStreamRef.current?.getVideoTracks()[0]?.getSettings();
      if (s) setStats({ w: s.width, h: s.height, fps: Math.round(s.frameRate ?? 0) });
    }, 1000);
    return () => clearInterval(id);
  }, [localVideo]);

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
    const events = ['ring', 'accepted', 'busy', 'offer', 'answer', 'ice', 'hangup'];
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
    remoteVideoOn,
    localVideo,
    micOn,
    cameraOn,
    screenOn,
    quality,
    stats,
    startCall,
    acceptCall,
    endCall,
    toggleMic,
    setMicGain,
    toggleCamera,
    toggleScreen,
    setQuality,
  };
}
