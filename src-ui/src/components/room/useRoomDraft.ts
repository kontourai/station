import { useCallback, useEffect, useRef, useState } from 'react';

const PREFIX = 'station-room-draft:';
const MAX_DRAFT_LENGTH = 64_000;

/**
 * The storage key for one room or thread draft. `partition` is the reload
 * partition (`draftRecoveryKey`), never an activation epoch: an epoch changes
 * on every reload, which would orphan the draft. Sending still requires the
 * live authority check. Without a partition the draft lives in memory only.
 */
export function roomDraftKey(
  partition: string | undefined,
  ...identity: readonly (string | undefined)[]
): string | undefined {
  if (!partition || identity.some((part) => !part)) return undefined;
  return JSON.stringify([partition, ...identity]);
}

function readRaw(key: string | undefined) {
  if (!key) return undefined;
  try {
    return window.sessionStorage.getItem(PREFIX + key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeRaw(key: string | undefined, value: string | undefined) {
  if (!key) return;
  try {
    if (value && value.length <= MAX_DRAFT_LENGTH)
      window.sessionStorage.setItem(PREFIX + key, value);
    else window.sessionStorage.removeItem(PREFIX + key);
  } catch {
    // Storage refused: the draft stays in memory for this view.
  }
}

/**
 * A room's unsent draft of any shape, kept for this tab so it survives
 * switching rooms and reloading. `decode` validates what storage returns; a
 * value it rejects reads as `empty`. `isEmpty` decides when to drop the entry.
 */
export function useRoomDraftValue<T>(
  key: string | undefined,
  empty: T,
  codec: {
    encode(value: T): string;
    decode(raw: string): T | undefined;
    isEmpty(value: T): boolean;
  },
) {
  const read = useCallback(
    (from: string | undefined) => {
      const raw = readRaw(from);
      if (raw === undefined) return empty;
      try {
        return codec.decode(raw) ?? empty;
      } catch {
        return empty;
      }
    },
    [codec, empty],
  );
  const [draft, setDraftState] = useState(() => read(key));
  const loaded = useRef(key);
  // A different room reads its own draft instead of carrying this one over.
  useEffect(() => {
    if (loaded.current === key) return;
    loaded.current = key;
    setDraftState(read(key));
  }, [key, read]);
  // A setter belongs to the key it was made for. Called after the view
  // moved to another key (a late acknowledgement from a thread the reader
  // left), it updates that key's own stored draft and leaves the active one
  // alone: the active draft is never written under a retired key (#4855).
  const setDraft = useCallback(
    (value: T | ((current: T) => T)) => {
      const apply = (current: T) =>
        typeof value === 'function'
          ? (value as (current: T) => T)(current)
          : value;
      if (loaded.current !== key) {
        const next = apply(read(key));
        writeRaw(key, codec.isEmpty(next) ? undefined : codec.encode(next));
        return;
      }
      setDraftState((current) => {
        const next = apply(current);
        writeRaw(key, codec.isEmpty(next) ? undefined : codec.encode(next));
        return next;
      });
    },
    [key, codec, read],
  );
  return [loaded.current === key ? draft : read(key), setDraft] as const;
}

const TEXT_CODEC = {
  encode: (value: string) => value,
  decode: (raw: string) => raw,
  isEmpty: (value: string) => !value,
};

/** The unsent text of one room or thread (see `useRoomDraftValue`). */
export function useRoomDraft(key: string | undefined) {
  return useRoomDraftValue(key, '', TEXT_CODEC);
}
