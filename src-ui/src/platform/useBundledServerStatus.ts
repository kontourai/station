/**
 * useBundledServerStatus — reactive view of the desktop-selected Station
 * sidecar or attached service through the native bridge.
 *
 * Desktop shells are the single source of truth for the selected sidecar or
 * attached service's liveness: the browser never health-probes the loopback
 * base.
 * This hook starts its native subscription before pulling the authoritative
 * snapshot. That closes the pull-before-listen gap for an external CLI, tray,
 * crash, or recovery transition. A transition that arrives while the pull is
 * in flight wins over its now-stale snapshot.
 *
 * On web/mobile — or whenever `enabled` is false — the hook is inert and returns
 * null. The subscription is disposed on unmount (or when `enabled` flips off).
 */
import { useEffect, useState } from 'react';
import { nativePlatformPromise } from './native';
import type { BundledServerStatus } from './native/types';

export function useBundledServerStatus(
  enabled: boolean,
): BundledServerStatus | null {
  const [status, setStatus] = useState<BundledServerStatus | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }
    let disposed = false;
    let disposeSubscription: (() => void) | undefined;
    void nativePlatformPromise
      .then(async (adapter) => {
        if (disposed) return;
        let eventVersion = 0;
        const subscription = adapter.subscribeToBundledServerStatus((next) => {
          eventVersion += 1;
          setStatus(next);
        });
        disposeSubscription = () => subscription.dispose();
        // Subscribe before pulling: an external lifecycle action may happen
        // between either call. Never let a slow pull overwrite that event.
        const versionBeforePull = eventVersion;
        const snapshot = await adapter.getBundledServerStatus();
        if (disposed) return;
        if (snapshot.status === 'ok' && eventVersion === versionBeforePull) {
          setStatus(snapshot.value);
        }
      })
      .catch(() => {
        // Adapter init failure leaves status null; the gate falls through to
        // its existing reachability logic rather than blocking on a phantom
        // service.
      });
    return () => {
      disposed = true;
      disposeSubscription?.();
    };
  }, [enabled]);

  return status;
}

/**
 * Ask the native host to start its configured durable service.
 * The service bridge drives the resulting phase transitions, which arrive through
 * `useBundledServerStatus`; the boolean only reports whether the request
 * reached the host, so the recovery screen can tell the user when it didn't.
 */
export async function restartBundledServer(): Promise<boolean> {
  try {
    const adapter = await nativePlatformPromise;
    const result = await adapter.restartBundledServer();
    return result.status === 'ok';
  } catch {
    return false;
  }
}
