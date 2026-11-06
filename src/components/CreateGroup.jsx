import { useState } from 'react';
import Icon from './Icons';
import Avatar from './Avatar';

export default function CreateGroup({ contacts, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const toggle = (id) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async () => {
    const n = name.trim();
    if (!n) return alert('Придумайте название группы');
    if (picked.size === 0) return alert('Выберите хотя бы одного друга');
    setBusy(true);
    try {
      await onCreate(n, [...picked]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Создать группу</h3>
          <button className="hd-btn" onClick={onClose} title="Закрыть">
            <Icon name="close" />
          </button>
        </div>

        <label className="modal-label">
          Название группы
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например: Катка в CS2"
            maxLength={60}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </label>

        <div className="modal-label">Участники ({picked.size} выбрано)</div>
        <div className="cg-list">
          {contacts.length === 0 && <div className="empty">Сначала добавьте друзей.</div>}
          {contacts.map((c) => (
            <button
              key={c.id}
              className={picked.has(c.id) ? 'cg-row picked' : 'cg-row'}
              onClick={() => toggle(c.id)}
            >
              <Avatar person={c} />
              <span className="member-name">{c.display_name}</span>
              <span className="cg-check">{picked.has(c.id) && <Icon name="check" size={16} />}</span>
            </button>
          ))}
        </div>

        <button className="modal-submit" onClick={submit} disabled={busy}>
          {busy ? 'Создаём…' : 'Создать группу'}
        </button>
      </div>
    </div>
  );
}
