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
import { DevicePairingRequiredError } from '@kontourai/station-sdk';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { describeStationFailure } from '../utils/stationFailure';
import type {
  ConfirmedWebPushOwner,
  WebPushAuthority,
  WebPushOwner,
} from './web-push-browser-registration';

type NotificationPermission = 'default' | 'denied' | 'granted';

interface UsePushNotificationsOptions {
  enabled: boolean;
  apiBase: string;
  /** Null while the selected Station authority is unavailable. */
  requestScope?: WebPushAuthority | null;
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

function pushFailure(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === 'WebPushBrowserState')
    return cause.message;
  if (cause instanceof DevicePairingRequiredError)
    return 'Pair this device first';
  if (cause instanceof StationHttpError) {
    if (cause.status === 401)
      return 'Sign in to this Station to check Web Push.';
    if (cause.status === 403) return 'This Station refused Web Push access.';
    if (cause.status === 404) return 'Web Push is unavailable on this Station.';
  }
  return describeStationFailure(cause).body;
}

export function usePushNotifications({
  enabled,
  apiBase,
  requestScope,
}: UsePushNotificationsOptions): UsePushNotificationsResult {
  const [supported] = useState(
    () => 'serviceWorker' in navigator && 'PushManager' in window,
  );
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'default',
  );
  const [registeredVersion, setRegisteredVersion] = useState(-1);
  const [pairingRequired, setPairingRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const swRegRef = useRef<ServiceWorkerRegistration | null>(null);
  const authorityKey =
    requestScope === null ? null : requestScope?.authorityKey;
  const scopeRef = useRef({
    enabled,
    apiBase,
    requestScope,
    authorityKey,
    version: 0,
  });
  const cancelledThrough = useRef(-1);
  if (
    scopeRef.current.enabled !== enabled ||
    scopeRef.current.apiBase !== apiBase ||
    scopeRef.current.authorityKey !== authorityKey
  ) {
    if (!enabled) cancelledThrough.current = scopeRef.current.version;
    scopeRef.current = {
      enabled,
      apiBase,
      requestScope,
      authorityKey,
      version: scopeRef.current.version + 1,
    };
  }
  const workTail = useRef<Promise<void>>(Promise.resolve());
  const enabling = useRef<{ version: number; promise: Promise<void> } | null>(
    null,
  );
  const cleanupRef = useRef<Promise<void> | null>(null);
  const registeredScopes = useRef(new Map<string, ConfirmedWebPushOwner>());

  const enqueue = useCallback((run: () => Promise<void>) => {
    const operation = workTail.current.then(run, run);
    workTail.current = operation;
    return operation;
  }, []);

  const removeSubscription = useCallback(
    async (
      subscription: PushSubscription,
      candidate: WebPushOwner,
      attemptedOwner?: WebPushOwner,
    ) => {
      const { removeBrowserPushSubscription } = await import(
        './web-push-browser-registration'
      );
      await removeBrowserPushSubscription(
        subscription,
        candidate,
        registeredScopes.current,
        attemptedOwner,
      );
    },
    [],
  );

  const reportError = useCallback((cause: unknown) => {
    setPairingRequired(cause instanceof DevicePairingRequiredError);
    setError(pushFailure(cause));
  }, []);

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
    setError(null);
    setPairingRequired(false);
    const run = async () => {
      const owner = scopeRef.current;
      if (
        owner.authorityKey !== authorityKey ||
        owner.apiBase !== apiBase ||
        owner.enabled !== enabled
      )
        return;
      const { version } = owner;
      const isCurrent = () =>
        !cancelled &&
        version === scopeRef.current.version &&
        owner.requestScope?.isCurrent?.() !== false;
      try {
        await cleanupRef.current;
        if (!isCurrent()) return;
        setRegisteredVersion(-1);
        setError(null);
        setPairingRequired(false);
        const reg = await navigator.serviceWorker.getRegistration('/sw.js');
        if (!reg || !isCurrent()) return;
        swRegRef.current = reg;
        const subscription = await reg.pushManager.getSubscription();
        if (!subscription || !isCurrent()) return;
        if (!enabled) {
          await removeSubscription(subscription, owner);
          return;
        }
        if (owner.requestScope === null) return;
        const { confirmBrowserPushRegistration } = await import(
          './web-push-browser-registration'
        );
        if (!isCurrent()) return;
        await confirmBrowserPushRegistration(owner, subscription);
        if (!isCurrent()) return;
        registeredScopes.current.set(apiBase, {
          ...owner,
          endpoint: subscription.endpoint,
        });
        setRegisteredVersion(version);
      } catch (cause) {
        if (isCurrent()) reportError(cause);
      }
    };
    const sync = () => {
      void enqueue(run);
    };
    if (enabled) {
      sync();
      window.addEventListener('online', sync);
      window.addEventListener('focus', sync);
    } else cleanupRef.current = run();
    return () => {
      cancelled = true;
      window.removeEventListener('online', sync);
      window.removeEventListener('focus', sync);
    };
  }, [
    supported,
    enabled,
    apiBase,
    authorityKey,
    enqueue,
    removeSubscription,
    reportError,
  ]);

  const subscribe = useCallback(() => {
    const owner = scopeRef.current;
    if (!supported || !owner.enabled || owner.requestScope === null)
      return Promise.resolve();
    const { version } = owner;
    if (enabling.current?.version === version) return enabling.current.promise;
    const isCurrent = () =>
      version === scopeRef.current.version &&
      owner.requestScope?.isCurrent?.() !== false;
    const run = async () => {
      await cleanupRef.current;
      if (!isCurrent()) return;
      setError(null);
      setPairingRequired(false);
      try {
        const { enableBrowserPushSubscription } = await import(
          './web-push-browser-registration'
        );
        if (!isCurrent()) return;
        const subscribed = await enableBrowserPushSubscription({
          owner,
          registration: swRegRef,
          owners: registeredScopes.current,
          isCurrent,
          cancelled: () => version <= cancelledThrough.current,
          onPermission: setPermission,
        });
        if (isCurrent() && subscribed) setRegisteredVersion(version);
      } catch (cause) {
        if (!isCurrent()) return;
        setRegisteredVersion(-1);
        reportError(cause);
      }
    };
    const promise = enqueue(run);
    enabling.current = { version, promise };
    const finished = () => {
      if (enabling.current?.promise === promise) enabling.current = null;
    };
    void promise.then(finished, finished);
    return promise;
  }, [supported, enqueue, reportError]);

  const unsubscribe = useCallback(() => {
    const owner = scopeRef.current;
    cancelledThrough.current = scopeRef.current.version;
    const version = ++scopeRef.current.version;
    setRegisteredVersion(-1);
    const previousCleanup = cleanupRef.current;
    const cleanup = (async () => {
      await previousCleanup;
      if (!supported) return;
      try {
        const reg =
          swRegRef.current ??
          (await navigator.serviceWorker.getRegistration('/sw.js'));
        const subscription = await reg?.pushManager.getSubscription();
        if (subscription) await removeSubscription(subscription, owner);
      } catch (cause) {
        if (version === scopeRef.current.version) reportError(cause);
      }
    })();
    cleanupRef.current = cleanup;
    return cleanup;
  }, [supported, removeSubscription, reportError]);

  return {
    supported: supported && enabled && requestScope !== null,
    permission,
    subscribed:
      enabled &&
      registeredVersion === scopeRef.current.version &&
      requestScope?.isCurrent?.() !== false,
    pairingRequired,
    subscribe,
    unsubscribe,
    error,
  };
}
