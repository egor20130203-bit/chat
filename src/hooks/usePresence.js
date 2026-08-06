import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

export const STATUSES = {
  online: { label: 'В сети', color: '#3ba55d' },
  idle: { label: 'Не на месте', color: '#e3a53c' },
  dnd: { label: 'Не беспокоить', color: '#d8404b' },
  invisible: { label: 'Невидимый', color: '#7a7d8a' },
};

const IDLE_AFTER = 5 * 60 * 1000; // 5 минут без действий — «не на месте»

export function usePresence(myId, activity) {
  const [peers, setPeers] = useState({}); // { userId: { status, activity } }
  const [status, setStatus] = useState(() => localStorage.getItem('chat.status') || 'online');
  const [away, setAway] = useState(false);

  const channelRef = useRef(null);
  const idleTimerRef = useRef(null);
  const stateRef = useRef({ status, activity, away });

  stateRef.current = { status, activity, away };

  const push = useCallback(async () => {
    const ch = channelRef.current;
    if (!ch) return;
    const { status: s, activity: a, away: aw } = stateRef.current;
    const shown = s === 'invisible' ? 'invisible' : aw && s === 'online' ? 'idle' : s;
    await ch.track({ status: shown, activity: a || null, at: Date.now() });
  }, []);

  // Отслеживаем бездействие
  useEffect(() => {
    const wake = () => {
      if (stateRef.current.away) {
        setAway(false);
      }
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => setAway(true), IDLE_AFTER);
    };
    const events = ['mousemove', 'keydown', 'mousedown', 'wheel', 'touchstart', 'focus'];
    events.forEach((e) => window.addEventListener(e, wake, { passive: true }));
    wake();
    return () => {
      events.forEach((e) => window.removeEventListener(e, wake));
      clearTimeout(idleTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!myId) return;
    const ch = supabase.channel('presence_lobby', { config: { presence: { key: myId } } });

    const sync = () => {
      const raw = ch.presenceState();
      const flat = {};
      Object.entries(raw).forEach(([id, entries]) => {
        const latest = entries[entries.length - 1];
        if (latest && latest.status !== 'invisible') {
          flat[id] = { status: latest.status, activity: latest.activity };
        }
      });
      setPeers(flat);
    };

    ch.on('presence', { event: 'sync' }, sync);
    ch.on('presence', { event: 'join' }, sync);
    ch.on('presence', { event: 'leave' }, sync);

    ch.subscribe(async (s) => {
      if (s === 'SUBSCRIBED') {
        channelRef.current = ch;
        await push();
      }
    });

    return () => {
      supabase.removeChannel(ch);
      channelRef.current = null;
    };
  }, [myId, push]);

  useEffect(() => {
    push();
  }, [status, activity, away, push]);

  const changeStatus = useCallback((next) => {
    localStorage.setItem('chat.status', next);
    setStatus(next);
  }, []);

  const myShownStatus = status === 'invisible' ? 'invisible' : away && status === 'online' ? 'idle' : status;

  return { peers, status, myShownStatus, changeStatus };
}
