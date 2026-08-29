import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  type ConnectionHealthCheckResult,
  ConnectionHealthCoordinator,
  type ConnectionHealthCoordinatorOptions,
} from '../core/ConnectionHealthCoordinator';
import type { ConnectionFailureReason, ConnectionStatus } from '../core/types';
import { useConnections } from './ConnectionsContext';

export interface UseConnectionStatusOptions {
  /** Function that returns a Promise<boolean> indicating server health */
  checkHealth: (url: string, credential?: string) => Promise<boolean>;
  probeEndpoint?: (
    url: string,
    credential: string | undefined,
    expectedEnvironmentId: string | null,
    signal: AbortSignal,
  ) => Promise<ConnectionHealthCheckResult>;
  /** Healthy poll interval in ms (default: 10_000). Failures use bounded backoff. */
  pollInterval?: number;
}

export interface ConnectionStatusResult {
  status: ConnectionStatus;
  checking: boolean;
  reason: ConnectionFailureReason | null;
  /** Consecutive completed probes with this exact failure reason. */
  failureStreak: number;
  /**
   * True when the coordinator is `blocked` on a terminal failure (currently
   * `authentication-failed`) and has stopped its automatic retry ladder —
   * station#1094 R2/R4. `status` stays `'error'` either way; use this to
   * render a distinct "blocked — credential required" affordance instead of
   * a generic reconnecting spinner. Resumes automatically once the saved
   * credential changes, `recheck()` is called, or the browser regains
   * network.
   */
  blocked: boolean;
  /** Recent sustained-failure windows, local to this device/browser session. */
  failureWindows: ReadonlyArray<{
    start: string;
    end: string;
    reason: ConnectionFailureReason;
  }>;
  recheck: () => void;
}

interface RegistryEntry {
  coordinator: ConnectionHealthCoordinator;
  refs: number;
  subscribe: (listener: () => void) => () => void;
}

const registry = new Map<string, RegistryEntry>();

function registryEntry(
  key: string,
  options: ConnectionHealthCoordinatorOptions,
): RegistryEntry {
  const existing = registry.get(key);
  if (existing) {
    existing.coordinator.updateOptions(options);
    return existing;
  }
  const coordinator = new ConnectionHealthCoordinator(options);
  const entry: RegistryEntry = {
    coordinator,
    refs: 0,
    subscribe: (listener) => {
      entry.refs += 1;
      const unsubscribe = coordinator.subscribe(listener);
      return () => {
        unsubscribe();
        entry.refs -= 1;
        if (entry.refs === 0 && registry.get(key) === entry) {
          registry.delete(key);
        }
      };
    },
  };
  registry.set(key, entry);
  return entry;
}

export function useConnectionStatus({
  checkHealth,
  probeEndpoint,
  pollInterval = 10_000,
}: UseConnectionStatusOptions): ConnectionStatusResult {
  const {
    apiBase,
    activeConnection,
    credentialProvider,
    recordEndpointSuccess,
    recordEndpointFailure,
    credentialAuthorityGeneration,
    nativeShell,
  } = useConnections();
  const key = activeConnection?.id ?? `default:${apiBase}`;
  const entry = useMemo(
    () =>
      registryEntry(key, {
        endpoints: () => [],
        compatibility: () => ({ clientProtocol: 'https:', online: true }),
        check: async () => false,
      }),
    [key],
  );
  entry.coordinator.updateOptions({
    endpoints: () => {
      const selected = activeConnection?.selectedEndpointId;
      return (
        activeConnection?.endpoints ??
        (apiBase
          ? [
              {
                endpointVersion: 1 as const,
                id: `endpoint:manual:${encodeURIComponent(apiBase)}`,
                url: apiBase,
                kind: 'manual' as const,
                priority: 100,
              },
            ]
          : [])
      ).map((endpoint) => ({
        ...endpoint,
        priority: endpoint.id === selected ? -1 : endpoint.priority,
      }));
    },
    compatibility: () => ({
      // A native shell page (e.g. Tauri's `tauri://localhost`) is neither
      // `http:` nor a real `https:` web origin — asserting `https:` for any
      // non-`http:` protocol misclassified every native release build as a
      // secure page and rejected plain-HTTP stations as mixed-content before
      // any probe (station#1286). `window.isSecureContext` is NOT the right
      // discriminator here: `tauri://localhost` IS a secure context, so it
      // can't distinguish a native shell from a genuine HTTPS page.
      clientProtocol: nativeShell
        ? 'native:'
        : typeof window !== 'undefined' && window.location.protocol === 'http:'
          ? 'http:'
          : 'https:',
      // navigator.onLine reports link-layer state, not reachability. Mobile
      // WebViews can report false while a tailnet/VPN route is healthy, so it
      // may wake a probe (the `online` listener below) but must never block it.
      online: true,
    }),
    check: (endpoint, signal) =>
      probeEndpoint
        ? probeEndpoint(
            endpoint.url,
            credentialProvider.getCredential(),
            activeConnection?.environmentId ?? null,
            signal,
          )
        : checkHealth(endpoint.url, credentialProvider.getCredential()),
    onSuccess: (endpoint, result) => {
      if (!activeConnection) return;
      recordEndpointSuccess(
        activeConnection.id,
        endpoint.url,
        undefined,
        result.bootId,
      );
    },
    onFailure: (reason) => {
      if (activeConnection) recordEndpointFailure(activeConnection.id, reason);
    },
    pollIntervalMs: pollInterval,
    baseRetryMs: Math.min(500, pollInterval),
  });

  const snapshot = useSyncExternalStore(
    entry.subscribe,
    entry.coordinator.getSnapshot,
    entry.coordinator.getSnapshot,
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onOnline = () => entry.coordinator.trigger();
    let lastResumeProbeAt = Number.NEGATIVE_INFINITY;
    const resumeSuppressionMs = 250;
    const scheduleResumeProbe = () => {
      const now = performance.now();
      if (now - lastResumeProbeAt < resumeSuppressionMs) return;
      lastResumeProbeAt = now;
      entry.coordinator.trigger();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') scheduleResumeProbe();
    };
    // Tauri mobile WebViews reliably surface foregrounding as a focus or
    // pageshow event, while browser tabs use visibilitychange. Treat all
    // three as a supervisor kick so a suspended retry timer never makes a
    // just-resumed phone wait for its next backoff interval.
    const onResume = scheduleResumeProbe;
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onResume);
    window.addEventListener('pageshow', onResume);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onResume);
      window.removeEventListener('pageshow', onResume);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [entry]);

  // station#1094 R3/R4: a credential regaining authority is one of the three
  // signals allowed to wake a `blocked` (terminal auth failure) coordinator
  // — without this, re-pairing a device after a 401 would sit blocked until
  // the user happened to click "Try now" or the browser bounced offline/online.
  // Only fires for the SAME key: neither the initial mount nor a switch to a
  // different connection's entry should double up on that entry's own
  // first-subscribe trigger.
  //
  // station#3602: this used to compare the saved credential VALUE, which a
  // browser device session never changes — it is `undefined` before pairing
  // and `undefined` after — so exactly the case this exists for (re-pairing
  // after a 401) was the case it could not see. The authority generation is
  // the fact "this connection gained a credential able to authenticate it",
  // which is what a parked supervisor is waiting for.
  const authority = activeConnection
    ? credentialAuthorityGeneration(activeConnection.id)
    : 0;
  const previousAuthorityRef = useRef<{ key: string; authority: number }>({
    key,
    authority,
  });
  useEffect(() => {
    const previous = previousAuthorityRef.current;
    previousAuthorityRef.current = { key, authority };
    if (previous.key === key && previous.authority !== authority) {
      entry.coordinator.trigger();
    }
  }, [key, authority, entry]);

  return { ...snapshot, recheck: entry.coordinator.trigger };
}
