import { OPENED_NOTIFICATION_QUERY_PARAM } from '@kontourai/station-contracts/notification';
import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import { isRelativeStationPath } from '@kontourai/station-shared/notification-envelope';

const LINK_BASE = 'https://station.invalid';
/** Where an alert opens when its own link cannot be kept on Station. */
const SAFE_OPEN_PATH = '/notifications';

/**
 * An OS alert's open link (Web Push, the desktop feed) with the opened
 * record's id added, so the client that loads it marks exactly that record
 * read as opened. Never off-origin: the link is resolved against a fixed
 * base and must stay on it as a single-`/` path with no backslash (dot
 * segments such as `/..//host` or `/%2e%2e//host` collapse to `//host`);
 * otherwise the alert opens `SAFE_OPEN_PATH`. The existing query is kept as
 * written; an `OPENED_NOTIFICATION_QUERY_PARAM` already in the link is
 * replaced, never trusted. The fragment is dropped: a Station link carries
 * none (`isRelativeStationPath`), `#station-ui-bootstrap` is a credential
 * exchange the UI acts on at load, and the desktop host refuses a link
 * with one, which would open nothing.
 */
export function withOpenedNotification(
  href: string,
  notificationId: string,
): string {
  const url = onStationOrigin(href) ?? onStationOrigin(SAFE_OPEN_PATH)!;
  let search: string;
  if (url.searchParams.has(OPENED_NOTIFICATION_QUERY_PARAM)) {
    url.searchParams.set(OPENED_NOTIFICATION_QUERY_PARAM, notificationId);
    search = url.search;
  } else {
    const param = `${OPENED_NOTIFICATION_QUERY_PARAM}=${encodeURIComponent(notificationId)}`;
    search = url.search ? `${url.search}&${param}` : `?${param}`;
  }
  return `${url.pathname}${search}`;
}

function onStationOrigin(href: string): URL | undefined {
  if (!href.startsWith('/') || href.includes('\\')) return undefined;
  let url: URL;
  try {
    url = new URL(href, `${LINK_BASE}/`);
  } catch {
    return undefined;
  }
  return url.origin === LINK_BASE &&
    !url.pathname.startsWith('//') &&
    !url.pathname.includes('\\')
    ? url
    : undefined;
}

/**
 * Resolves the exact-session deep link for a notification's metadata —
 * shared by `AttentionProjectionService`'s approval projection (the attention
 * inbox's "Open session" action) and the web push payload composer
 * (`push-payload-composer.ts`, archive#1100 AC3) so both surfaces resolve
 * the SAME target from the SAME metadata instead of drifting.
 *
 * Extracted verbatim from `attention-projection.ts`'s former private
 * `approvalOpenHref` — no behavior change, only where it lives (plus the
 * `metadata.link` fallback added below, archive#1100 review fix MEDIUM).
 *
 * Resolves to `undefined` — never a same-page fallback like `/notifications`
 * — when the notification's metadata does not carry enough to deep-link
 * into an owning session or a validated own link; callers fall back to a
 * generic destination themselves rather than rendering/sending a dead link.
 */
export function resolveNotificationOpenHref(
  metadata: Record<string, unknown> | undefined,
  sessionId?: string,
  sessionKind?: string,
): string | undefined {
  const meta = metadata ?? {};
  const projectSlug = stringValue(meta.projectSlug);
  // archive#1284 (AC4): both dock-targeting hrefs below carry `dock=open` so
  // the deep link actually opens the chat dock (`navigation-store.ts`'s
  // `isDockOpen` reads this param) — the Activity surface deep link is not a
  // dock target and deliberately carries no `dock=open`.
  if (projectSlug && sessionId) {
    return `/projects/${encodeURIComponent(projectSlug)}?chat=${encodeURIComponent(sessionId)}&dock=open`;
  }
  if (sessionKind === 'runtime' && sessionId) {
    return activityDeepLink({ sessionId });
  }
  if (sessionKind === 'managed' && sessionId) {
    return `/?chat=${encodeURIComponent(sessionId)}&dock=open`;
  }
  // Final fallback (archive#1100 review fix MEDIUM): a notification with no
  // resolvable session (e.g. a scheduled job failure — no session at all)
  // can still carry its OWN deep link in `metadata.link`
  // (builtin-scheduler-execution.ts sets `/schedule?job=<name>`). Only a
  // same-origin relative path is trusted here — a notification's metadata
  // is not an authenticated navigation target, so an absolute/external or
  // protocol-relative ("//host/...") value is rejected rather than handed
  // to a push notification's click target or an "Open" action's href.
  return resolveRelativePathLink(meta.link);
}

function resolveRelativePathLink(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  // The shared same-origin check, which also refuses a path whose dot
  // segments normalize to `//host` (`/..//host`, `/%2e%2e//host`).
  return isRelativeStationPath(trimmed) ? trimmed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
