import { useCallback, useEffect, useRef, useState } from 'react';

const PREFIX = 'station-room-draft:';
const MAX_DRAFT_LENGTH = 64_000;

function read(key: string | undefined) {
  if (!key) return '';
  try {
    return window.sessionStorage.getItem(PREFIX + key) ?? '';
  } catch {
    return '';
  }
}

/**
 * The unsent text of one room or thread, kept for this tab so it survives
 * switching rooms and reloading. `key` must name the Station, the room and
 * the thread; without a key the draft lives in memory only.
 */
export function useRoomDraft(key: string | undefined) {
  const [draft, setDraftState] = useState(() => read(key));
  const loaded = useRef(key);
  // A different room reads its own draft instead of carrying this one over.
  useEffect(() => {
    if (loaded.current === key) return;
    loaded.current = key;
    setDraftState(read(key));
  }, [key]);
  const setDraft = useCallback(
    (value: string | ((current: string) => string)) => {
      setDraftState((current) => {
        const next = typeof value === 'function' ? value(current) : value;
        if (key)
          try {
            if (next && next.length <= MAX_DRAFT_LENGTH)
              window.sessionStorage.setItem(PREFIX + key, next);
            else window.sessionStorage.removeItem(PREFIX + key);
          } catch {
            // Storage refused: the draft stays in memory for this view.
          }
        return next;
      });
    },
    [key],
  );
  return [loaded.current === key ? draft : read(key), setDraft] as const;
}
