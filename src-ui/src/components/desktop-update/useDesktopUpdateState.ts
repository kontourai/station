import type { DesktopUpdateState } from '@kontourai/station-contracts/desktop-update';
import { useCallback, useEffect, useState } from 'react';
import {
  readDesktopUpdateState,
  subscribeToDesktopUpdateState,
} from '../../platform/native/desktopUpdate';

export interface DesktopUpdateRead {
  /** Null until the native side answers, and while `enabled` is false. */
  state: DesktopUpdateState | null;
  /** Why the state could not be read; null when it was, or is pending. */
  error: string | null;
  retry: () => void;
}

/**
 * The native desktop update state (#3851), live. Subscribes before pulling
 * the snapshot, and applies an event or snapshot only when its `sequence`
 * is newer than the last one applied, so neither a slow snapshot nor an
 * out-of-order event can roll the state back.
 *
 * Inert when `enabled` is false (web, mobile, or a desktop profile that has
 * not resolved yet). A failed read is reported, never replaced by an
 * invented state.
 */
export function useDesktopUpdateState(enabled: boolean): DesktopUpdateRead {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the read on retry.
  useEffect(() => {
    if (!enabled) {
      setState(null);
      setError(null);
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let applied = -1;
    const apply = (next: DesktopUpdateState) => {
      if (disposed || next.sequence <= applied) return;
      applied = next.sequence;
      setState(next);
    };
    setError(null);
    void (async () => {
      const stop = await subscribeToDesktopUpdateState(apply);
      if (disposed) {
        stop();
        return;
      }
      unlisten = stop;
      apply(await readDesktopUpdateState());
    })().catch((cause: unknown) => {
      if (disposed) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled, attempt]);

  return { state, error, retry };
}
