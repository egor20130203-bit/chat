import { useEffect, useRef, useState } from 'react';
import Icon from './Icons';

// Всплывающее меню у стрелочки: выбор устройства и громкость
export default function AudioMenu({ kind, onClose, onMicVolume, onSpkVolume }) {
  const isMic = kind === 'mic';
  const [devices, setDevices] = useState([]);
  const [device, setDevice] = useState(
    () => localStorage.getItem(isMic ? 'chat.mic' : 'chat.spk') || ''
  );
  const [volume, setVolume] = useState(() =>
    Number(localStorage.getItem(isMic ? 'chat.micVolume' : 'chat.spkVolume')) || 100
  );
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

  const askAccess = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      await load();
    } catch (e) {
      alert('Доступ к микрофону не выдан: ' + e.message);
    }
  };

  const pickDevice = (id) => {
    setDevice(id);
    localStorage.setItem(isMic ? 'chat.mic' : 'chat.spk', id);
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
          ? 'Устройство применится к следующему звонку'
          : 'Громкость меняется сразу'}
      </div>
    </div>
  );
}
