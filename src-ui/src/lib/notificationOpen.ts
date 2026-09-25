/**
 * Click-to-open for the desktop's native notification alerts (#2608).
 *
 * The native feed consumer (`src-desktop/src/notification_feed.rs`) posts
 * the OS alert; a click focuses the app, keeps the entry's `link` natively
 * and emits `station://notification-open`. This module takes the link
 * (`take_notification_open_link`, once — a remount or a second event finds
 * nothing) and navigates to it.
 *
 * The link is accepted only as an in-app path, checked here as well as
 * natively: `/…` with an optional query, never a scheme, `//host`,
 * backslash, fragment, whitespace or control character (C0 or C1), and the
 * NORMALIZED path must not be `//host` either (`/..//host` and
 * `/%2e%2e//host` collapse to it). Anything else is
 * dropped — the click has already brought the app forward, and nothing
 * outside the app is ever opened.
 */

export const NOTIFICATION_OPEN_EVENT = 'station://notification-open';
const MAX_LINK_LENGTH = 2048;
const BASE = 'https://station.invalid';

export interface NotificationOpenTarget {
  pathname: string;
  params: Record<string, string>;
}

export function notificationOpenTarget(
  link: unknown,
): NotificationOpenTarget | null {
  if (
    typeof link !== 'string' ||
    link.length === 0 ||
    link.length > MAX_LINK_LENGTH ||
    !link.startsWith('/') ||
    link.startsWith('//') ||
    link.includes('\\') ||
    link.includes('#') ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
    /[\s\u0000-\u001f\u007f-\u009f]/.test(link)
  )
    return null;
  let url: URL;
  try {
    url = new URL(link, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE || url.pathname.startsWith('//')) return null;
  return {
    pathname: url.pathname,
    params: Object.fromEntries(url.searchParams),
  };
}

export interface NotificationOpenDeps {
  listen(event: string, handler: () => void): Promise<() => void>;
  take(): Promise<unknown>;
}

async function defaultDeps(): Promise<NotificationOpenDeps> {
  const [{ listen }, { invokeTauri }] = await Promise.all([
    import('@tauri-apps/api/event'),
    import('../platform/native/tauriInvoke'),
  ]);
  return {
    listen: (event, handler) => listen(event, () => handler()),
    take: () => invokeTauri<unknown>('take_notification_open_link'),
  };
}

export function subscribeToNotificationOpen(
  navigate: (pathname: string, params?: Record<string, string | null>) => void,
  depsPromise: Promise<NotificationOpenDeps> = defaultDeps(),
): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void depsPromise
    .then(async (deps) => {
      const drain = () =>
        void deps
          .take()
          .then((link) => {
            const target = notificationOpenTarget(link);
            if (!disposed && target) navigate(target.pathname, target.params);
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
