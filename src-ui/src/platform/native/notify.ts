import {
  LIVE_NOTIFICATION_STATUSES,
  notificationsUrl,
} from '@kontourai/station-sdk';
import { createNativeNotifier } from './notifier';

/**
 * Single entry point for OS notifications, so callers do not each decide
 * whether the host supports one.
 *
 * Delivery lives in the **host**, not here. The web layer sees every
 * notification over SSE, but that stream is suspended with the webview when
 * the app is backgrounded and its events are not replayed on reconnect — so
 * notifications raised while the user was elsewhere were lost rather than
 * delivered late. Device testing confirmed it: they posted in the foreground
 * and were silent when backgrounded. The host keeps polling while the webview
 * is paused, which is the entire point.
 *
 * Built lazily and remembered: constructing at module scope would make merely
 * importing this file a side effect, and permission is asked once rather than
 * on every delivery.
 */
let notifier: ReturnType<typeof createNativeNotifier> | null = null;
let ready: Promise<boolean> | null = null;

export async function primeNativeNotifications(): Promise<boolean> {
  notifier ??= createNativeNotifier();
  if (!(await notifier.isAvailable())) return false;
  ready ??= notifier.ensurePermission();
  return ready;
}

/**
 * Hand the host the connection to watch. Safe to call again when the active
 * connection changes — the host replaces any watch already running, so two
 * pollers never double-notify.
 *
 * The URL is built here rather than in the host: the route and the
 * live-status filter are Station API knowledge the SDK already owns, and a
 * second copy in another language is a copy that rots quietly.
 */
export async function watchNotificationsNatively(input: {
  endpoint: string;
  credential: string;
}): Promise<void> {
  if (!(await primeNativeNotifications())) return;
  await notifier?.watch({
    url: notificationsUrl(input.endpoint, {
      status: LIVE_NOTIFICATION_STATUSES,
    }),
    credential: input.credential,
  });
}

export async function stopWatchingNotificationsNatively(): Promise<void> {
  // Nothing was ever started, so there is nothing to ask the host about.
  if (!notifier) return;
  await notifier.unwatch();
}

/**
 * Post one OS notification from the running app.
 *
 * This is the foreground path, and it is deliberately NOT the dormant host
 * watch above (#917): it posts from the webview, so it reaches the user only
 * while the app is running. On a desktop host that is the whole of the
 * problem #1912 describes — the operator was using Station, in front of it,
 * and still had to poll the API from a shell to find a pairing approval that
 * expires in five minutes. On Android the webview is frozen when
 * backgrounded, which is exactly why the host-side watch exists there and why
 * this is not a substitute for it.
 *
 * Returns whether the OS accepted it, so callers can decide whether an
 * in-app fallback is still needed rather than assuming delivery.
 */
export async function notifyNatively(input: {
  title: string;
  body?: string;
}): Promise<boolean> {
  if (!(await primeNativeNotifications())) return false;
  try {
    await notifier?.notify(input);
    return true;
  } catch {
    // A refused or unavailable notifier must never break the surface that
    // asked for it — the in-app attention list is still there.
    return false;
  }
}
