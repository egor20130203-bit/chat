import { useState } from 'react';
import Icon from './Icons';
import { downloadChunked } from '../lib/bigfiles';

const prettySize = (b) => {
  if (!b) return '';
  if (b < 1024) return b + ' Б';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' КБ';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' МБ';
  return (b / 1073741824).toFixed(2) + ' ГБ';
};

// Карточка файла. Обычный файл — просто ссылка; большой (chunked) — склеивается при скачивании.
export default function FileAttachment({ url, name, size, type }) {
  const isChunked = type?.startsWith('chunked:');
  const [progress, setProgress] = useState(null); // null | 0..100

  const onClick = async (e) => {
    if (!isChunked) return; // обычная ссылка — пусть открывается
    e.preventDefault();
    if (progress !== null) return;
    setProgress(0);
    try {
      await downloadChunked(url, setProgress);
    } catch (err) {
      alert('Файл не скачался: ' + err.message);
    }
    setProgress(null);
  };

  return (
    <a
      className={progress !== null ? 'msg-file downloading' : 'msg-file'}
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={onClick}
      title={isChunked ? 'Большой файл — скачается и соберётся автоматически' : name}
    >
      <span className="msg-file-icon">
        <Icon name="download" size={18} />
      </span>
      <span className="msg-file-info">
        <span className="msg-file-name">{name}</span>
        <span className="msg-file-size">
          {prettySize(size)}
          {progress !== null ? ` · ${progress}%` : ''}
        </span>
        {progress !== null && (
          <span className="file-progress">
            <i style={{ width: progress + '%' }} />
          </span>
        )}
      </span>
    </a>
  );
}
