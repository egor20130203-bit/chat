import { useEffect } from 'react';
import Icon from './Icons';

// Просмотр фото внутри приложения: клик — закрыть, Esc — закрыть
export default function Lightbox({ src, name, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="lightbox" onClick={onClose}>
      <img src={src} alt={name || ''} onClick={(e) => e.stopPropagation()} />
      <div className="lb-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lb-name">{name}</span>
        <a className="lb-btn" href={src} download={name} target="_blank" rel="noreferrer" title="Скачать">
          <Icon name="download" />
        </a>
        <button className="lb-btn" onClick={onClose} title="Закрыть">
          <Icon name="close" />
        </button>
      </div>
    </div>
  );
}
