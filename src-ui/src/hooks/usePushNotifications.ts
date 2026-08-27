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
  const [subscribed, setSubscribed] = useState(false);
  const [pairingRequired, setPairingRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const swRegRef = useRef<ServiceWorkerRegistration | null>(null);

  // Register service worker on mount (no-op if already registered)
  useEffect(() => {
    if (!supported || !enabled) return;
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        swRegRef.current = reg;
        return reg.pushManager.getSubscription();
      })
      .then((sub) => {
        setSubscribed(!!sub);
      })
      .catch((err) => setError(err.message));
  }, [supported, enabled]);

  const subscribe = useCallback(async () => {
    if (!supported || !enabled) return;
    setError(null);
    setPairingRequired(false);

    try {
      // Request notification permission
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') {
        setError('Notification permission denied');
        return;
      }

      // Get VAPID public key from server
      const publicKey = await fetchVapidPublicKey(apiBase);

      // Register SW if not yet done
      const reg =
        swRegRef.current ?? (await navigator.serviceWorker.register('/sw.js'));
      swRegRef.current = reg;

      // Subscribe to push
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });

      // Send subscription to server
      await subscribePushNotifications(subscription.toJSON(), apiBase);

      setSubscribed(true);
    } catch (err: any) {
      if (err instanceof DevicePairingRequiredError) {
        setPairingRequired(true);
        setError('Pair this device first');
        return;
      }
      setError(err.message);
    }
  }, [supported, enabled, apiBase]);

  const unsubscribe = useCallback(async () => {
    if (!swRegRef.current) return;
    try {
      const sub = await swRegRef.current.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe();
        // Notify server to remove subscription
        await unsubscribePushNotifications(sub.endpoint, apiBase).catch(() => {
          /* best-effort */
        });
      }
      setSubscribed(false);
    } catch (err: any) {
      setError(err.message);
    }
  }, [apiBase]);

  return {
    supported: supported && enabled,
    permission,
    subscribed,
    pairingRequired,
    subscribe,
    unsubscribe,
    error,
  };
}
