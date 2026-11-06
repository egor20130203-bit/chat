// Аватарка: фото, если загружено, иначе инициалы. Опционально — точка статуса.
const initials = (n) => (n || '?').slice(0, 2).toUpperCase();

export default function Avatar({ person, className = 'avatar', color, dotClass = 'up-dot' }) {
  return (
    <span className={className}>
      {person?.avatar_url ? <img src={person.avatar_url} alt="" /> : initials(person?.display_name)}
      {color && <span className={dotClass} style={{ background: color }} />}
    </span>
  );
}
