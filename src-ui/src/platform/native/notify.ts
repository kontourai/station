import { createNativeNotifier } from './notifier';

/**
 * Single entry point for OS notifications, so callers do not each decide
 * whether the host supports one.
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
 * Post one OS notification from the running app.
 *
 * This is the foreground path: it posts from the webview, so it reaches the
 * user only while the app is running. On a desktop host that is the whole of
 * the problem #1912 describes — the operator was using Station, in front of
 * it, and still had to poll the API from a shell to find a pairing approval
 * that expires in five minutes. On Android the webview is frozen when
 * backgrounded, so this is not background delivery there; that needs push
 * (archive#917, see docs/design/notification-delivery.md).
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
