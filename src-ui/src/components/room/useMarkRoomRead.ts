import {
  type ReadMarkerTarget,
  readMarkerTargetKey,
} from '@kontourai/station-contracts/read-markers';
import { useMarkReadMutation } from '@kontourai/station-sdk';
import { useEffect, useRef, useState } from 'react';

function documentVisible() {
  return (
    typeof document === 'undefined' || document.visibilityState !== 'hidden'
  );
}

/**
 * Marks a room read through `version` while it is on screen (#3075, #4794).
 *
 * `version` is the version of the content actually shown (a Project room's
 * newest displayed message `seq`, from a history read that succeeded; a Task
 * room's `throughSeq`), so the mark can never run ahead of what was displayed. A
 * hidden tab marks nothing until it is visible again. Each version is sent
 * once per target; the server keeps the maximum, so a late or repeated mark
 * is harmless. The mutation invalidates every read-state query, which is
 * what clears the bold in the sidebar.
 */
export function useMarkRoomRead(
  target: ReadMarkerTarget | undefined,
  version: number | undefined,
  enabled = true,
) {
  const { mutate } = useMarkReadMutation();
  const sent = useRef(new Map<string, number>());
  const [visible, setVisible] = useState(documentVisible);
  useEffect(() => {
    const update = () => setVisible(documentVisible());
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const key = target ? readMarkerTargetKey(target) : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the target object is identified by its stable key.
  useEffect(() => {
    if (!enabled || !visible || !target || !key) return;
    if (version === undefined || !Number.isSafeInteger(version) || version <= 0)
      return;
    if ((sent.current.get(key) ?? 0) >= version) return;
    sent.current.set(key, version);
    mutate(
      { target, version },
      {
        // A failed mark is retried by the next version or visit.
        onError: () => {
          if (sent.current.get(key) === version) sent.current.delete(key);
        },
      },
    );
  }, [enabled, visible, key, version, mutate]);
}
