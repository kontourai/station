/**
 * usePushNotifications — Web Push subscription lifecycle management.
 *
 * Handles registering the service worker, subscribing to Web Push, and
 * unsubscribing. Generic — works for any notification category (tool approvals,
 * high-priority alerts, etc.). The service worker (public/sw.js) handles
 * rendering and action routing per payload type.
 *
 * Architecture:
 *   1. Client subscribes to Web Push (this hook).
 *   2. Subscription is POSTed to /api/system/push-subscribe on the server.
 *   3. Server sends push messages via the NotificationService.
 *   4. Service worker (public/sw.js) receives the push and shows a notification.
 *   5. When the user taps an action, sw.js routes to the appropriate endpoint.
 *
 * Requires:
 *   - VAPID public key on the server (GET /api/system/vapid-public-key)
 *   - Service worker registered at /sw.js
 *   - HTTPS (or localhost) — push requires a secure context
 */
import {
  DevicePairingRequiredError,
  fetchVapidPublicKey,
  subscribePushNotifications,
  unsubscribePushNotifications,
} from '@kontourai/station-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

type NotificationPermission = 'default' | 'denied' | 'granted';

interface UsePushNotificationsOptions {
  enabled: boolean;
  apiBase: string;
}

export interface UsePushNotificationsResult {
  supported: boolean;
  permission: NotificationPermission;
  subscribed: boolean;
  /**
   * True when the server rejected subscribe with device_pairing_required —
   * this browser is not (yet) a paired device. Distinct from `error`: it is
   * an expected, actionable state ("Pair this device first"), not a failure.
   */
  pairingRequired: boolean;
  /** Call this to request permission + subscribe. */
  subscribe: () => Promise<void>;
  /** Unsubscribe and remove from server. */
  unsubscribe: () => Promise<void>;
  error: string | null;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

function matchesVapidKey(
  subscription: PushSubscription,
  publicKey: string | undefined,
): boolean {
  const buffer = subscription.options?.applicationServerKey;
  if (!buffer || !publicKey) return false;
  const actual = new Uint8Array(buffer);
  const expected = urlBase64ToUint8Array(publicKey);
  return (
    actual.length === expected.length &&
    actual.every((byte, index) => byte === expected[index])
  );
}

export function usePushNotifications({
  enabled,
  apiBase,
}: UsePushNotificationsOptions): UsePushNotificationsResult {
  const [supported] = useState(
    () => 'serviceWorker' in navigator && 'PushManager' in window,
  );
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'default',
  );
  const [receipt, setReceipt] = useState<{
    apiBase: string;
    version: number;
    endpoint: string;
  } | null>(null);
  const [pairingRequired, setPairingRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const swRegRef = useRef<ServiceWorkerRegistration | null>(null);
  const scopeRef = useRef({ enabled, apiBase, version: 0 });
  const cancelledThrough = useRef(-1);
  if (
    scopeRef.current.enabled !== enabled ||
    scopeRef.current.apiBase !== apiBase
  ) {
    if (!enabled) cancelledThrough.current = scopeRef.current.version;
    scopeRef.current = {
      enabled,
      apiBase,
      version: scopeRef.current.version + 1,
    };
  }
  const workTail = useRef<Promise<void>>(Promise.resolve());
  const enabling = useRef<{ version: number; promise: Promise<void> } | null>(
    null,
  );
  const cleanupRef = useRef<Promise<void> | null>(null);
  const registeredScopes = useRef(new Map<string, string>());
  const publicKeys = useRef(new Map<string, string>());

  const enqueue = useCallback((run: () => Promise<void>) => {
    const operation = workTail.current.then(run, run);
    workTail.current = operation;
    return operation;
  }, []);

  const removeSubscription = useCallback(
    async (
      subscription: PushSubscription,
      candidateApiBase: string,
      attemptedOwner?: string,
    ) => {
      await subscription.unsubscribe();
      const owners = new Set(
        [...registeredScopes.current]
          .filter(([, endpoint]) => endpoint === subscription.endpoint)
          .map(([base]) => base),
      );
      if (attemptedOwner) owners.add(attemptedOwner);
      if (owners.size === 0) {
        const key =
          publicKeys.current.get(candidateApiBase) ??
          (await fetchVapidPublicKey(candidateApiBase).catch(() => undefined));
        if (matchesVapidKey(subscription, key)) owners.add(candidateApiBase);
      }
      await Promise.all(
        [...owners].map(async (base) => {
          try {
            await unsubscribePushNotifications(subscription.endpoint, base);
            registeredScopes.current.delete(base);
          } catch {
            /* Local revocation stops delivery; host cleanup is best effort. */
          }
        }),
      );
    },
    [],
  );

  useEffect(
    () => () => {
      cancelledThrough.current = scopeRef.current.version;
      scopeRef.current.version += 1;
    },
    [],
  );

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    const version = scopeRef.current.version;
    const isCurrent = () => !cancelled && version === scopeRef.current.version;
    const previousCleanup = cleanupRef.current;
    setError(null);
    setPairingRequired(false);
    const run = async () => {
      try {
        await previousCleanup;
        if (!isCurrent()) return;
        const reg = enabled
          ? await navigator.serviceWorker.register('/sw.js')
          : await navigator.serviceWorker.getRegistration('/sw.js');
        if (!reg || !isCurrent()) return;
        swRegRef.current = reg;
        const subscription = await reg.pushManager.getSubscription();
        if (!subscription || !isCurrent()) return;
        if (!enabled) {
          await removeSubscription(subscription, apiBase);
          if (isCurrent()) setReceipt(null);
          return;
        }
        const key = await fetchVapidPublicKey(apiBase);
        if (!isCurrent()) return;
        publicKeys.current.set(apiBase, key);
        if (!matchesVapidKey(subscription, key)) {
          setError(
            'This browser subscription uses another Station’s key. Enable push notifications here to switch.',
          );
          return;
        }
        await subscribePushNotifications(subscription.toJSON(), apiBase);
        registeredScopes.current.set(apiBase, subscription.endpoint);
        if (version <= cancelledThrough.current) {
          await removeSubscription(subscription, apiBase, apiBase);
          return;
        }
        if (isCurrent())
          setReceipt({ apiBase, version, endpoint: subscription.endpoint });
      } catch (cause) {
        if (!isCurrent()) return;
        if (cause instanceof DevicePairingRequiredError)
          setPairingRequired(true);
        setError(
          cause instanceof DevicePairingRequiredError
            ? 'Pair this device first'
            : cause instanceof Error
              ? cause.message
              : 'Push notifications could not be checked.',
        );
      }
    };
    if (enabled) void enqueue(run);
    else {
      const cleanup = run();
      cleanupRef.current = cleanup;
    }
    return () => {
      cancelled = true;
    };
  }, [supported, enabled, apiBase, enqueue, removeSubscription]);

  const subscribe = useCallback(() => {
    if (!supported || !enabled) return Promise.resolve();
    const version = scopeRef.current.version;
    if (enabling.current?.version === version) return enabling.current.promise;
    const isCurrent = () => version === scopeRef.current.version;
    const run = async () => {
      await cleanupRef.current;
      if (!isCurrent()) return;
      setError(null);
      setPairingRequired(false);
      let subscription: PushSubscription | null = null;
      let created = false;
      let posted = false;
      try {
        const perm = await Notification.requestPermission();
        if (!isCurrent()) return;
        setPermission(perm);
        if (perm !== 'granted')
          throw new Error('Notification permission denied');
        const key = await fetchVapidPublicKey(apiBase);
        if (!isCurrent()) return;
        publicKeys.current.set(apiBase, key);
        const reg =
          swRegRef.current ??
          (await navigator.serviceWorker.register('/sw.js'));
        swRegRef.current = reg;
        if (!isCurrent()) return;
        subscription = await reg.pushManager.getSubscription();
        if (!isCurrent()) return;
        if (subscription && !matchesVapidKey(subscription, key)) {
          await removeSubscription(subscription, apiBase);
          subscription = null;
          if (!isCurrent()) return;
        }
        if (!subscription) {
          subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
          });
          created = true;
        }
        if (!matchesVapidKey(subscription, key))
          throw new Error(
            'The browser subscription does not match this Station’s push key.',
          );
        if (!isCurrent()) {
          if (created || version <= cancelledThrough.current)
            await removeSubscription(subscription, apiBase);
          return;
        }
        posted = true;
        await subscribePushNotifications(subscription.toJSON(), apiBase);
        registeredScopes.current.set(apiBase, subscription.endpoint);
        if (version <= cancelledThrough.current) {
          await removeSubscription(subscription, apiBase, apiBase);
          return;
        }
        if (isCurrent())
          setReceipt({ apiBase, version, endpoint: subscription.endpoint });
      } catch (cause) {
        if (subscription && created)
          await removeSubscription(
            subscription,
            apiBase,
            posted ? apiBase : undefined,
          ).catch(() => {});
        if (!isCurrent()) return;
        setReceipt(null);
        if (cause instanceof DevicePairingRequiredError)
          setPairingRequired(true);
        setError(
          cause instanceof DevicePairingRequiredError
            ? 'Pair this device first'
            : cause instanceof Error
              ? cause.message
              : 'Push notifications could not be enabled.',
        );
      }
    };
    const promise = enqueue(run);
    enabling.current = { version, promise };
    const finished = () => {
      if (enabling.current?.promise === promise) enabling.current = null;
    };
    void promise.then(finished, finished);
    return promise;
  }, [supported, enabled, apiBase, enqueue, removeSubscription]);

  const unsubscribe = useCallback(() => {
    cancelledThrough.current = scopeRef.current.version;
    const version = ++scopeRef.current.version;
    setReceipt(null);
    const previousCleanup = cleanupRef.current;
    const cleanup = (async () => {
      await previousCleanup;
      if (!supported) return;
      try {
        const reg =
          swRegRef.current ??
          (await navigator.serviceWorker.getRegistration('/sw.js'));
        const subscription = await reg?.pushManager.getSubscription();
        if (subscription) await removeSubscription(subscription, apiBase);
      } catch (cause) {
        if (version === scopeRef.current.version)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Push notifications could not be disabled.',
          );
      }
    })();
    cleanupRef.current = cleanup;
    return cleanup;
  }, [supported, apiBase, removeSubscription]);

  return {
    supported: supported && enabled,
    permission,
    subscribed:
      enabled &&
      receipt?.apiBase === apiBase &&
      receipt.version === scopeRef.current.version,
    pairingRequired,
    subscribe,
    unsubscribe,
    error,
  };
}
