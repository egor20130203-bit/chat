import { useEffect, useRef, useState } from 'react';
import Icon from './Icons';

// Всплывающее меню у стрелочки: выбор устройства, громкость, проверка микрофона и звука
export default function AudioMenu({ kind, onClose, onMicVolume, onSpkVolume, onMicDevice }) {
  const isMic = kind === 'mic';
  const [devices, setDevices] = useState([]);
  const [device, setDevice] = useState(
    () => localStorage.getItem(isMic ? 'chat.mic' : 'chat.spk') || ''
  );
  const [volume, setVolume] = useState(() =>
    Number(localStorage.getItem(isMic ? 'chat.micVolume' : 'chat.spkVolume') ?? 100)
  );
  const [level, setLevel] = useState(0);
  const [meterErr, setMeterErr] = useState(null);
  const [retry, setRetry] = useState(0);
  const [captureLabel, setCaptureLabel] = useState('');
  const [meterMode, setMeterMode] = useState('');
  const boxRef = useRef(null);

  useEffect(() => {
    const away = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) onClose();
    };
    const esc = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  const load = async () => {
    const list = await navigator.mediaDevices.enumerateDevices();
    setDevices(list.filter((d) => d.kind === (isMic ? 'audioinput' : 'audiooutput')));
  };

  useEffect(() => {
    load();
  }, []);

  // Живой индикатор уровня микрофона — показывает, слышит ли выбранное устройство.
  // Если 4 секунды тишина — сам переключается между режимами «с обработкой» и «без»
  // (на некоторых системах шумодав глушит микрофон в ноль) и запоминает рабочий.
  useEffect(() => {
    if (!isMic) return;
    if (devices.length > 0 && !devices[0].label) return; // нет доступа — нечего мерить
    let stop = false;
    let session = 0;
    let ctx, stream, raf;
    const cleanupRun = () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
      stream = null;
      ctx = null;
    };

    const start = async (mode) => {
      const my = ++session;
      setMeterErr(null);
      setMeterMode(mode === 'raw' ? 'без обработки' : 'с обработкой');
      const audio =
        mode === 'raw'
          ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      if (device) audio.deviceId = { ideal: device };
      const st = await navigator.mediaDevices.getUserMedia({ audio });
      if (stop || my !== session) {
        st.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = st;
      setCaptureLabel(st.getAudioTracks()[0]?.label ?? '');
      const cx = new (window.AudioContext || window.webkitAudioContext)();
      await cx.resume?.().catch(() => {});
      if (cx.state !== 'running') {
        cx.close().catch(() => {});
        throw new Error('звуковой движок спит — кликни по полоске');
      }
      ctx = cx;
      const src = cx.createMediaStreamSource(st);
      const an = cx.createAnalyser();
      an.fftSize = 256;
      src.connect(an);
      const data = new Uint8Array(an.frequencyBinCount);
      const startedAt = Date.now();
      let heardSomething = false;
      const loop = () => {
        if (stop || my !== session) return;
        an.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        const lvl = Math.min(100, Math.round(peak * 150));
        setLevel(lvl);
        if (lvl > 4) {
          heardSomething = true;
          // Этот режим работает — запоминаем его для звонков
          localStorage.setItem('chat.audioProcessing', mode === 'raw' ? 'off' : 'on');
        }
        if (!heardSomething && Date.now() - startedAt > 4000) {
          cleanupRun();
          start(mode === 'raw' ? 'processed' : 'raw').catch((e) =>
            setMeterErr(e.message ?? String(e))
          );
          return;
        }
        raf = requestAnimationFrame(loop);
      };
      loop();
    };

    start(localStorage.getItem('chat.audioProcessing') === 'off' ? 'raw' : 'processed').catch(
      (e) => setMeterErr(e.message ?? String(e))
    );

    return () => {
      stop = true;
      session++;
      cleanupRun();
    };
  }, [isMic, device, devices, retry]);

  const askAccess = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      await load();
    } catch (e) {
      alert('Доступ к микрофону не выдан: ' + e.message);
    }
  };

  // Тестовый сигнал через выбранное устройство вывода
  const testSound = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      ctx.resume?.().catch(() => {});
      const id = localStorage.getItem('chat.spk');
      if (id && typeof ctx.setSinkId === 'function') ctx.setSinkId(id).catch(() => {});
      const notes = [523, 659, 784];
      notes.forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f;
        g.gain.value = 0.08;
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + i * 0.18);
        o.stop(ctx.currentTime + i * 0.18 + 0.16);
      });
      setTimeout(() => ctx.close().catch(() => {}), 1400);
    } catch (e) {
      alert('Звук не заиграл: ' + e.message);
    }
  };

  const pickDevice = (id) => {
    setDevice(id);
    localStorage.setItem(isMic ? 'chat.mic' : 'chat.spk', id);
    if (isMic) onMicDevice?.(id); // переключаем на лету, даже в звонке
  };

  const changeVolume = (v) => {
    setVolume(v);
    localStorage.setItem(isMic ? 'chat.micVolume' : 'chat.spkVolume', String(v));
    if (isMic) onMicVolume?.(v);
    else onSpkVolume?.(v);
  };

  const noLabels = devices.length > 0 && !devices[0].label;

  return (
    <div className="am-menu" ref={boxRef} role="dialog">
      <div className="am-section">
        <div className="am-title">{isMic ? 'Устройство ввода' : 'Устройство вывода'}</div>
        {noLabels ? (
          <button className="am-grant" onClick={askAccess}>
            Показать устройства
          </button>
        ) : (
          <select value={device} onChange={(e) => pickDevice(e.target.value)}>
            <option value="">По умолчанию</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || (isMic ? 'Микрофон' : 'Наушники')}
              </option>
            ))}
          </select>
        )}
      </div>

      {isMic && !noLabels && (
        <div className="am-section">
          <div className="am-title">Проверка микрофона — скажи что-нибудь</div>
          <div className="am-meter" onClick={() => setRetry((r) => r + 1)} style={{ cursor: 'pointer' }}>
            <i style={{ width: level + '%' }} />
          </div>
          {captureLabel && <div className="am-meter-hint">Захватываю: {captureLabel}</div>}
          <div className="am-meter-hint">
            {meterErr
              ? `⚠️ ${meterErr}`
              : level > 3
                ? '✅ Микрофон работает'
                : `Полоска не двигается — пробую разные режимы (${meterMode})…`}
          </div>
        </div>
      )}

      {!isMic && (
        <div className="am-section">
          <button className="am-grant" onClick={testSound}>
            🔊 Проверить звук
          </button>
          <div className="am-meter-hint">Не слышно сигнал — выбери другое устройство выше</div>
        </div>
      )}

      <div className="am-section">
        <div className="am-title">{isMic ? 'Громкость микрофона' : 'Громкость звука'}</div>
        <div className="am-slider">
          <input
            type="range"
            min="0"
            max={isMic ? 200 : 100}
            value={volume}
            onChange={(e) => changeVolume(Number(e.target.value))}
          />
          <span className="am-value">{volume}%</span>
        </div>
      </div>

      <div className="am-hint">
        <Icon name="gear" size={14} />
        {isMic
          ? 'Устройство переключается сразу, даже в звонке'
          : 'Громкость меняется сразу'}
      </div>
    </div>
  );
}
