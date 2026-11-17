/**
 * Click-to-open for the desktop's native notification alerts (#2608).
 *
 * The native feed consumer (`src-desktop/src/notification_feed.rs`) posts
 * the OS alert; a click focuses the app, keeps the entry's `link` and the
 * Station origin it read the alert from natively, and emits
 * `station://notification-open`. This module takes them
 * (`take_notification_open_link`, once — a remount or a second event finds
 * nothing) and hands them to the notification opener
 * (`notificationStationOpen.ts`), which opens the link on that Station,
 * switching to it first when another Station is active by then. An older
 * host answers the bare link; it opens on the Station the link names.
 *
 * The link is accepted only as an in-app path, checked here as well as
 * natively: `/…` with an optional query, never a scheme, `//host`,
 * backslash, fragment, whitespace or control character (C0 or C1), and the
 * NORMALIZED path must not be `//host` either (`/..//host` and
 * `/%2e%2e//host` collapse to it). Anything else is
 * dropped — the click has already brought the app forward, and nothing
 * outside the app is ever opened.
 */

import {
  type NotificationOpenRequest,
  notificationLinkRequest,
} from './notificationStationOpen';

export const NOTIFICATION_OPEN_EVENT = 'station://notification-open';

export interface NotificationOpenTarget {
  pathname: string;
  params: Record<string, string>;
}

/** An in-app link as a navigation target (`notificationLinkRequest`). */
export function notificationOpenTarget(
  link: unknown,
): NotificationOpenTarget | null {
  const request = notificationLinkRequest(link);
  return request
    ? { pathname: request.pathname, params: request.params }
    : null;
}

export interface NotificationOpenDeps {
  listen(event: string, handler: () => void): Promise<() => void>;
  take(): Promise<unknown>;
}

async function defaultDeps(): Promise<NotificationOpenDeps> {
  const { invokeTauri, listenTauri } = await import(
    '../platform/native/tauriInvoke'
  );
  return {
    listen: listenTauri,
    take: () => invokeTauri<unknown>('take_notification_open_link'),
  };
}

/**
 * What the host's take answered, as an open request: `{ link, origin }`
 * (the origin only when it is an http(s) origin), or a bare link from an
 * older host.
 */
export function takenNotificationOpen(
  taken: unknown,
): NotificationOpenRequest | null {
  if (typeof taken === 'string') return notificationLinkRequest(taken);
  if (typeof taken !== 'object' || taken === null) return null;
  const { link, origin } = taken as Record<string, unknown>;
  const request = notificationLinkRequest(link);
  if (!request) return null;
  if (typeof origin !== 'string') return request;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return request;
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:'
    ? { ...request, origin: parsed.origin }
    : request;
}

export function subscribeToNotificationOpen(
  open: (request: NotificationOpenRequest) => void,
  depsPromise: Promise<NotificationOpenDeps> = defaultDeps(),
): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void depsPromise
    .then(async (deps) => {
      const drain = () =>
        void deps
          .take()
          .then((taken) => {
            const request = takenNotificationOpen(taken);
            if (!disposed && request) open(request);
          })
          .catch(() => {
            // A convenience: a failed take leaves the app where it is.
          });
      const registered = await deps.listen(NOTIFICATION_OPEN_EVENT, drain);
      if (disposed) {
        registered();
        return;
      }
      unlisten = registered;
      // Subscribe first, then drain: a click before this document listened
      // is kept natively and taken here.
      drain();
    })
    .catch(() => {
      // No native event bridge: nothing to open.
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}
