import {
  type WebPushSubscription,
  webPushRegistrationFingerprintInput,
} from '@kontourai/station-contracts/environment-security';
import {
  DevicePairingRequiredError,
  fetchWebPushRegistration,
  subscribePushNotifications,
  unsubscribePushNotifications,
} from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';

export type WebPushAuthority = ApiRequestScope & { isCurrent?: () => boolean };
export type WebPushOwner = {
  apiBase: string;
  requestScope: WebPushAuthority | null | undefined;
};
export type ConfirmedWebPushOwner = WebPushOwner & { endpoint: string };

function vapidKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (key.length % 4)) % 4);
  const binary = atob(key.replace(/-/g, '+').replace(/_/g, '/') + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function matchesVapidKey(
  subscription: PushSubscription,
  publicKey: string,
): boolean {
  const buffer = subscription.options?.applicationServerKey;
  if (!buffer) return false;
  const actual = new Uint8Array(buffer);
  const expected = vapidKeyBytes(publicKey);
  return (
    actual.length === expected.length &&
    actual.every((byte, index) => byte === expected[index])
  );
}

function requestOptions(owner: WebPushOwner) {
  return owner.requestScope ? { requestScope: owner.requestScope } : undefined;
}

async function readWebPushOwner(owner: WebPushOwner) {
  const result = await fetchWebPushRegistration(
    owner.apiBase,
    requestOptions(owner),
  );
  if (result.registration?.status === 'pairing-required')
    throw new DevicePairingRequiredError();
  return {
    publicKey: result.publicKey,
    fingerprint:
      result.registration?.status === 'paired'
        ? result.registration.fingerprint
        : undefined,
  };
}

async function browserRegistrationFingerprint(
  subscription: PushSubscription,
): Promise<string | null> {
  const { endpoint, keys } = subscription.toJSON();
  if (!endpoint || !keys?.p256dh || !keys.auth) return null;
  const identity: WebPushSubscription = {
    endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
  const bytes = new TextEncoder().encode(
    webPushRegistrationFingerprintInput(identity),
  );
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function pushStateError(message: string) {
  return new DOMException(message, 'WebPushBrowserState');
}

export async function confirmBrowserPushRegistration(
  owner: WebPushOwner,
  subscription: PushSubscription,
): Promise<void> {
  const observed = await readWebPushOwner(owner);
  if (!matchesVapidKey(subscription, observed.publicKey))
    throw pushStateError(
      'This browser subscription uses another Station’s key. Enable push notifications here to switch.',
    );
  if (observed.fingerprint === undefined)
    throw pushStateError(
      'This Station could not confirm the browser registration.',
    );
  if (
    !observed.fingerprint ||
    observed.fingerprint !==
      (await browserRegistrationFingerprint(subscription))
  )
    throw pushStateError(
      'Register this browser’s subscription on this Station to receive push notifications.',
    );
}

class PushRegistrationCleanupError extends DOMException {
  constructor() {
    super(
      'Browser push is off. Station registration cleanup failed.',
      'WebPushBrowserState',
    );
  }
}

/** Local revocation comes first. Remote cleanup never borrows the next authority. */
export async function removeBrowserPushSubscription(
  subscription: PushSubscription,
  candidate: WebPushOwner,
  owners: Map<string, ConfirmedWebPushOwner>,
  attemptedOwner?: WebPushOwner,
): Promise<void> {
  if (!(await subscription.unsubscribe())) {
    const worker = await navigator.serviceWorker.getRegistration('/sw.js');
    const current = await worker?.pushManager.getSubscription();
    if (current?.endpoint === subscription.endpoint)
      throw pushStateError('Could not turn off browser push.');
  }

  const matching = new Map(
    Array.from(owners).filter(
      ([, owner]) => owner.endpoint === subscription.endpoint,
    ),
  );
  if (attemptedOwner) {
    matching.set(attemptedOwner.apiBase, {
      ...attemptedOwner,
      endpoint: subscription.endpoint,
    });
  }
  if (
    matching.size === 0 &&
    candidate.requestScope !== null &&
    candidate.requestScope?.isCurrent?.() !== false
  ) {
    try {
      const current = await readWebPushOwner(candidate);
      if (
        current.fingerprint &&
        current.fingerprint ===
          (await browserRegistrationFingerprint(subscription))
      ) {
        matching.set(candidate.apiBase, {
          ...candidate,
          endpoint: subscription.endpoint,
        });
      }
    } catch {
      throw new PushRegistrationCleanupError();
    }
  }
  const results = await Promise.allSettled(
    Array.from(matching.values(), async (owner) => {
      if (
        owner.requestScope === null ||
        owner.requestScope?.isCurrent?.() === false
      )
        throw new Error(
          'The push registration belongs to a previous Station connection',
        );
      await unsubscribePushNotifications(
        subscription.endpoint,
        owner.apiBase,
        requestOptions(owner),
      );
      const current = owners.get(owner.apiBase);
      if (
        current?.endpoint === owner.endpoint &&
        current.requestScope?.authorityKey === owner.requestScope?.authorityKey
      )
        owners.delete(owner.apiBase);
    }),
  );
  if (results.some((result) => result.status === 'rejected'))
    throw new PushRegistrationCleanupError();
}

export async function enableBrowserPushSubscription({
  owner,
  registration,
  owners,
  isCurrent,
  cancelled,
  onPermission,
}: {
  owner: WebPushOwner;
  registration: { current: ServiceWorkerRegistration | null };
  owners: Map<string, ConfirmedWebPushOwner>;
  isCurrent: () => boolean;
  cancelled: () => boolean;
  onPermission: (permission: NotificationPermission) => void;
}): Promise<boolean> {
  let subscription: PushSubscription | null = null;
  let created = false;
  let posted = false;
  try {
    const permission = await Notification.requestPermission();
    if (!isCurrent()) return false;
    onPermission(permission);
    if (permission !== 'granted')
      throw pushStateError('Notification permission denied');
    const { publicKey } = await readWebPushOwner(owner);
    if (!isCurrent()) return false;
    const worker =
      registration.current ??
      (await navigator.serviceWorker.register('/sw.js'));
    registration.current = worker;
    if (!isCurrent()) return false;
    subscription = await worker.pushManager.getSubscription();
    if (!isCurrent()) return false;
    if (subscription && !matchesVapidKey(subscription, publicKey)) {
      await removeBrowserPushSubscription(subscription, owner, owners).catch(
        (cause: unknown) => {
          if (!(cause instanceof PushRegistrationCleanupError)) throw cause;
        },
      );
      subscription = null;
      if (!isCurrent()) return false;
    }
    if (!subscription) {
      subscription = await worker.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyBytes(publicKey),
      });
      created = true;
    }
    if (!matchesVapidKey(subscription, publicKey))
      throw new Error(
        'The browser subscription does not match this Station’s push key.',
      );
    if (!isCurrent()) {
      if (created || cancelled())
        await removeBrowserPushSubscription(subscription, owner, owners);
      return false;
    }
    posted = true;
    await subscribePushNotifications(
      subscription.toJSON(),
      owner.apiBase,
      requestOptions(owner),
    );
    owners.set(owner.apiBase, { ...owner, endpoint: subscription.endpoint });
    if (cancelled()) {
      await removeBrowserPushSubscription(subscription, owner, owners, owner);
      return false;
    }
    return isCurrent();
  } catch (cause) {
    if (subscription && created) {
      await removeBrowserPushSubscription(
        subscription,
        owner,
        owners,
        posted ? owner : undefined,
      ).catch(() => {});
    }
    throw cause;
  }
}
