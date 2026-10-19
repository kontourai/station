import type { DesktopUpdateState } from '@kontourai/station-contracts/desktop-update';
import { useEffect, useState } from 'react';
import {
  readDesktopUpdateState,
  subscribeToDesktopUpdateState,
} from '../../platform/native/desktopUpdate';

/**
 * The native desktop update state (#3851), live. Subscribes before pulling
 * the snapshot so a transition between the two calls is never lost, and a
 * transition that lands while the pull is in flight wins over that pull.
 *
 * Inert (null) when `enabled` is false — web, mobile, or a desktop profile
 * that has not resolved yet — and null until the native side answers. A
 * failed read leaves it null: no state is ever invented here.
 */
export function useDesktopUpdateState(
  enabled: boolean,
): DesktopUpdateState | null {
  const [state, setState] = useState<DesktopUpdateState | null>(null);

  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let eventVersion = 0;
    void (async () => {
      const stop = await subscribeToDesktopUpdateState((next) => {
        eventVersion += 1;
        if (!disposed) setState(next);
      });
      if (disposed) {
        stop();
        return;
      }
      unlisten = stop;
      const versionBeforePull = eventVersion;
      const snapshot = await readDesktopUpdateState();
      if (!disposed && eventVersion === versionBeforePull) setState(snapshot);
    })().catch((error: unknown) => {
      console.debug('station: desktop update state unavailable', error);
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled]);

  return state;
}
