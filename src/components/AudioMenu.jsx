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

  // Живой индикатор уровня микрофона — показывает, слышит ли выбранное устройство
  useEffect(() => {
    if (!isMic) return;
    if (devices.length > 0 && !devices[0].label) return; // нет доступа — нечего мерить
    let stop = false;
    let ctx, stream, raf;
    (async () => {
      try {
        const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        if (device) audio.deviceId = { ideal: device };
        stream = await navigator.mediaDevices.getUserMedia({ audio });
        if (stop) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        await ctx.resume?.().catch(() => {});
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser();
        an.fftSize = 256;
        src.connect(an);
        const data = new Uint8Array(an.frequencyBinCount);
        const loop = () => {
          if (stop) return;
          an.getByteTimeDomainData(data);
          let peak = 0;
          for (let i = 0; i < data.length; i++) {
            const v = Math.abs(data[i] - 128) / 128;
            if (v > peak) peak = v;
          }
          setLevel(Math.min(100, Math.round(peak * 150)));
          raf = requestAnimationFrame(loop);
        };
        loop();
      } catch (_) {}
    })();
    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
    };
  }, [isMic, device, devices]);

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
          <div className="am-meter">
            <i style={{ width: level + '%' }} />
          </div>
          <div className="am-meter-hint">
            {level > 3 ? '✅ Микрофон работает' : 'Полоска не двигается — выбери другое устройство выше'}
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
