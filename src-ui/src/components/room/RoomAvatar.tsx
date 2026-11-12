import type { CSSProperties } from 'react';
import './RoomAvatar.css';

const PERSON_INKS = [
  'var(--k-active)',
  'var(--k-caution)',
  'var(--k-positive)',
  'var(--k-brand)',
];

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (
    words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => word[0])
          .join('')
      : name.trim().slice(0, 2)
  ).toUpperCase();
}

/**
 * A room participant's mark. People are circles tinted by a stable hash of
 * their name; agents are rounded squares in the brand color, so the two read
 * apart before the "Agent" badge does.
 */
export function RoomAvatar({
  name,
  agent = false,
}: {
  name: string;
  agent?: boolean;
}) {
  const hash = [...name].reduce(
    (value, char) => (value * 31 + char.charCodeAt(0)) >>> 0,
    0,
  );
  return (
    <span
      className={`task-room-avatar ${agent ? 'task-room-avatar--agent' : 'task-room-avatar--person'}`}
      style={
        {
          '--room-avatar-ink': PERSON_INKS[hash % PERSON_INKS.length],
        } as CSSProperties
      }
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
