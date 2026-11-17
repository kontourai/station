import {
  isNotificationStationId,
  NOTIFICATION_STATION_QUERY_PARAM,
  type Notification,
  type NotificationEnvelopeV1,
  notificationSessionHref,
  OPENED_NOTIFICATION_QUERY_PARAM,
} from '@kontourai/station-contracts/notification';
import {
  isRelativeStationPath,
  readNotificationEnvelope,
} from '@kontourai/station-shared/notification-envelope';
import { notificationOpenSession } from './notification-session.js';

const LINK_BASE = 'https://station.invalid';
/** Where an alert opens when its own link cannot be kept on Station. */
const SAFE_OPEN_PATH = '/notifications';

/**
 * An OS alert's open link (Web Push, the desktop feed) with the opened
 * record's id added, so the client that loads it marks exactly that record
 * read as opened, and the sending Station's environment id
 * (`NOTIFICATION_STATION_QUERY_PARAM`), so a client connected to another
 * Station opens it on this one. Never off-origin: the link is resolved
 * against a fixed base and must stay on it as a single-`/` path with no
 * backslash (dot segments such as `/..//host` or `/%2e%2e//host` collapse to
 * `//host`); otherwise the alert opens `SAFE_OPEN_PATH`. The existing query
 * is kept as written; an `OPENED_NOTIFICATION_QUERY_PARAM` or
 * `NOTIFICATION_STATION_QUERY_PARAM` already in the link is replaced, never
 * trusted, and a Station id outside the contract grammar is left out. The
 * fragment is dropped: a Station link carries none
 * (`isRelativeStationPath`), `#station-ui-bootstrap` is a credential
 * exchange the UI acts on at load, and the desktop host refuses a link
 * with one, which would open nothing.
 */
export function withOpenedNotification(
  href: string,
  notificationId: string,
  stationId?: string,
): string {
  const url = onStationOrigin(href) ?? onStationOrigin(SAFE_OPEN_PATH)!;
  // The query as the producer wrote it, unless a parameter this link owns
  // has to be removed (which reserializes it).
  if (
    url.searchParams.has(OPENED_NOTIFICATION_QUERY_PARAM) ||
    url.searchParams.has(NOTIFICATION_STATION_QUERY_PARAM)
  ) {
    url.searchParams.delete(OPENED_NOTIFICATION_QUERY_PARAM);
    url.searchParams.delete(NOTIFICATION_STATION_QUERY_PARAM);
  }
  const kept = url.search;
  const added = [
    `${OPENED_NOTIFICATION_QUERY_PARAM}=${encodeURIComponent(notificationId)}`,
    ...(isNotificationStationId(stationId)
      ? [`${NOTIFICATION_STATION_QUERY_PARAM}=${encodeURIComponent(stationId)}`]
      : []),
  ].join('&');
  const search = kept ? `${kept}&${added}` : `?${added}`;
  return `${url.pathname}${search}`;
}

/**
 * The one open link every OS channel sends for a record (Web Push, the
 * desktop feed): {@link resolveNotificationTarget}, with the opened record
 * and the sending Station added by {@link withOpenedNotification}.
 */
export function notificationOpenLink(
  notification: Notification,
  stationId: string | undefined,
  envelope: NotificationEnvelopeV1 | undefined = readNotificationEnvelope(
    notification,
  ),
): string {
  return withOpenedNotification(
    resolveNotificationTarget(notification, envelope),
    notification.id,
    stationId,
  );
}

/**
 * Where opening a record goes, the same for every channel: the envelope's
 * path target; else the session `notificationOpenSession` names (the one
 * the phones' sealed references name too); else the record's own validated
 * `metadata.link`; else the inbox.
 */
export function resolveNotificationTarget(
  notification: Pick<Notification, 'metadata'>,
  envelope: NotificationEnvelopeV1 | undefined,
): string {
  const target = envelope?.target;
  if (target?.kind === 'path') return target.path;
  const session = notificationOpenSession(notification, envelope);
  if (session) return notificationSessionHref(session);
  return resolveRelativePathLink(notification.metadata?.link) ?? SAFE_OPEN_PATH;
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
  // One href for every session kind (`notificationSessionHref`): the dock
  // open on the session, inside its Project when it has one. `dock=open` is
  // what opens the dock (archive#1284 AC4).
  if (
    sessionId &&
    (projectSlug || sessionKind === 'runtime' || sessionKind === 'managed')
  ) {
    return notificationSessionHref({
      sessionId,
      ...(projectSlug ? { projectSlug } : {}),
    });
  }
  // Final fallback (archive#1100 review fix MEDIUM): a notification with no
  // resolvable session (e.g. a scheduled job failure — no session at all)
  // can still carry its OWN deep link in `metadata.link`
  // (builtin-scheduler-execution.ts sets `/automations?job=<name>`). Only a
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
