/**
 * Opening a notification on the Station that sent it.
 *
 * Every OS channel's tap ends here: a desktop alert click
 * (`notificationOpen.ts`), a Web Push tap (the service worker messages the
 * open tab, or a cold load carries the link in the URL), and an Android
 * card or alert tap (`AgentActivityLaunchRoutes`). Each names its Station:
 * the link's `NOTIFICATION_STATION_QUERY_PARAM` (the sender's environment
 * id), the tap route's verified Station id, and on the desktop the origin
 * the native host read the alert from. When that Station is not the active
 * one, the app switches to the saved connection first ("Opening
 * conversation on <Station>…") and only then navigates, so a session id is
 * never looked up on the wrong Station. A Station that is not saved here,
 * or a switch that fails, says so instead of silently dropping the tap.
 *
 * The link itself stays a relative path: the Station identity only selects
 * among connections already saved on this device, never a new origin.
 */
import {
  isNotificationStationId,
  NOTIFICATION_STATION_QUERY_PARAM,
  OPENED_NOTIFICATION_QUERY_PARAM,
} from '@kontourai/station-contracts/notification';

/** The subset of a saved connection this module reads. */
export interface NotificationStationConnection {
  id: string;
  name: string;
  url: string;
  endpoints?: ReadonlyArray<{ url: string }>;
  environmentId: string | null;
}

export interface NotificationOpenRequest {
  pathname: string;
  params: Record<string, string>;
  /** The sending Station's environment id, when the channel carries one. */
  stationId?: string;
  /**
   * Desktop only: the Station origin the native host read the alert from.
   * Its own record, never a feed field, so it outranks `stationId`.
   */
  origin?: string;
}

export type NotificationStationResolution<
  C extends NotificationStationConnection,
> =
  | { kind: 'active' }
  | { kind: 'switch'; connection: C }
  | { kind: 'not-saved' };

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function servesOrigin(
  connection: NotificationStationConnection,
  origin: string,
): boolean {
  const urls = [
    connection.url,
    ...(connection.endpoints ?? []).map((e) => e.url),
  ];
  return urls.some((url) => originOf(url) === origin);
}

/**
 * Which saved connection a notification belongs to. With an origin (the
 * desktop host's record), the connection serving that origin, provided its
 * environment id does not contradict the link's; else the connection with
 * the link's environment id. The active Station's id is
 * `activeEnvironmentId` (the verified authority observation) when given,
 * else its saved one: a same-origin browser connection may never have saved
 * one. A request naming no Station (an older Station that sends none), or
 * one this device cannot place while the active Station's own id is unknown,
 * opens on the active one, as before.
 */
export function resolveNotificationStation<
  C extends NotificationStationConnection,
>(
  request: Pick<NotificationOpenRequest, 'stationId' | 'origin'>,
  connections: readonly C[],
  active: C | null,
  activeEnvironmentId?: string | null,
): NotificationStationResolution<C> {
  const activeId = activeEnvironmentId || active?.environmentId || null;
  const stationId = isNotificationStationId(request.stationId)
    ? request.stationId
    : undefined;
  const normalizedOrigin = request.origin ? originOf(request.origin) : null;
  const pick = (connection: C | undefined): NotificationStationResolution<C> =>
    !connection
      ? { kind: 'not-saved' }
      : connection.id === active?.id
        ? { kind: 'active' }
        : { kind: 'switch', connection };
  if (normalizedOrigin) {
    const byOrigin = [...(active ? [active] : []), ...connections].find(
      (connection) => servesOrigin(connection, normalizedOrigin),
    );
    if (byOrigin) {
      const byOriginId =
        byOrigin.environmentId ||
        (byOrigin.id === active?.id ? activeId : null);
      if (stationId && byOriginId && byOriginId !== stationId)
        return { kind: 'not-saved' };
      return pick(byOrigin);
    }
  }
  if (stationId) {
    if (activeId === stationId) return { kind: 'active' };
    const saved = connections.find(
      (connection) => connection.environmentId === stationId,
    );
    if (saved) return pick(saved);
    // The active Station's own id is unknown: it may be the sender.
    if (!activeId && !normalizedOrigin) return { kind: 'active' };
    return { kind: 'not-saved' };
  }
  if (normalizedOrigin) return { kind: 'not-saved' };
  return { kind: 'active' };
}

/* ── Notice ─────────────────────────────────────────────────────────── */

export type NotificationOpenNotice =
  | { kind: 'switching'; stationName: string }
  | { kind: 'not-saved' }
  | { kind: 'switch-failed'; stationName: string; retry: () => void }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'unreachable'; retry: () => void };

let notice: NotificationOpenNotice | null = null;
const noticeListeners = new Set<() => void>();

export function getNotificationOpenNotice(): NotificationOpenNotice | null {
  return notice;
}

export function setNotificationOpenNotice(
  next: NotificationOpenNotice | null,
): void {
  if (notice === next) return;
  notice = next;
  for (const listener of noticeListeners) listener();
}

export function subscribeToNotificationOpenNotice(
  listener: () => void,
): () => void {
  noticeListeners.add(listener);
  return () => noticeListeners.delete(listener);
}

/* ── Conversations a notification asked to open ─────────────────────── */

/**
 * Chat ids a notification tap opened, so the dock reports a failed open of
 * one (not found, no access, unreachable) instead of clearing it silently.
 * Other `?chat=` opens — a reload of a draft that was never saved — keep
 * their quiet behavior. Bounded; an id is forgotten once its open settles.
 */
const notificationChats: string[] = [];

export function markNotificationChat(chatId: string): void {
  if (!notificationChats.includes(chatId)) notificationChats.push(chatId);
  if (notificationChats.length > 8) notificationChats.shift();
}

/** Whether `chatId` was opened by a notification; forgets it. */
export function takeNotificationChat(chatId: string): boolean {
  const index = notificationChats.indexOf(chatId);
  if (index < 0) return false;
  notificationChats.splice(index, 1);
  return true;
}

/* ── Opening ────────────────────────────────────────────────────────── */

export interface NotificationOpenDeps<C extends NotificationStationConnection> {
  connections(): readonly C[];
  active(): C | null;
  /** The active Station's verified environment id, when known. */
  activeEnvironmentId?(): string | null | undefined;
  setActiveConnection(id: string): Promise<unknown>;
  navigate(pathname: string, params: Record<string, string>): void;
}

/**
 * Opens `request` on its Station: navigates at once when that is the
 * active Station, switches first when it is another saved one, and shows
 * a notice when it is not saved or the switch fails. Resolves what it did.
 */
export async function openNotificationTarget<
  C extends NotificationStationConnection,
>(
  request: NotificationOpenRequest,
  deps: NotificationOpenDeps<C>,
): Promise<'opened' | 'switched' | 'not-saved' | 'switch-failed'> {
  const resolution = resolveNotificationStation(
    request,
    deps.connections(),
    deps.active(),
    deps.activeEnvironmentId?.(),
  );
  const open = () => {
    if (request.params.chat) markNotificationChat(request.params.chat);
    deps.navigate(request.pathname, request.params);
  };
  if (resolution.kind === 'active') {
    open();
    return 'opened';
  }
  if (resolution.kind === 'not-saved') {
    setNotificationOpenNotice({ kind: 'not-saved' });
    return 'not-saved';
  }
  const { connection } = resolution;
  const switching: NotificationOpenNotice = {
    kind: 'switching',
    stationName: connection.name,
  };
  setNotificationOpenNotice(switching);
  try {
    await deps.setActiveConnection(connection.id);
  } catch {
    setNotificationOpenNotice({
      kind: 'switch-failed',
      stationName: connection.name,
      retry: () => void openNotificationTarget(request, deps),
    });
    return 'switch-failed';
  }
  // The selection is committed (`setActiveConnection` resolves after the
  // store switched), so the dock's lookup runs against this Station.
  open();
  if (getNotificationOpenNotice() === switching)
    setNotificationOpenNotice(null);
  return 'switched';
}

/* ── One entry point for every channel ──────────────────────────────── */

type Opener = (request: NotificationOpenRequest) => void;
let opener: Opener | null = null;
const queued: NotificationOpenRequest[] = [];

/**
 * Open a notification's target. Before the app's opener has mounted (a
 * tap that launched the app), the request waits for it; only the newest
 * waiting request is kept, as only the last tap matters.
 */
export function requestNotificationOpen(
  request: NotificationOpenRequest,
): void {
  if (opener) opener(request);
  else queued.splice(0, queued.length, request);
}

/** Installed by the app shell once connections are known. */
export function installNotificationOpener(next: Opener): () => void {
  opener = next;
  for (const request of queued.splice(0)) next(request);
  return () => {
    if (opener === next) opener = null;
  };
}

/* ── Links ──────────────────────────────────────────────────────────── */

const LINK_BASE = 'https://station.invalid';
const MAX_LINK_LENGTH = 2048;

/**
 * A notification link as an open request: an in-app path only (`/…` with
 * an optional query; never a scheme, `//host`, backslash, fragment,
 * whitespace or control character, and the normalized path must not be
 * `//host` either). The Station parameter becomes `stationId` and leaves
 * the params; anything else is null.
 */
export function notificationLinkRequest(
  link: unknown,
): NotificationOpenRequest | null {
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
    url = new URL(link, LINK_BASE);
  } catch {
    return null;
  }
  if (url.origin !== LINK_BASE || url.pathname.startsWith('//')) return null;
  const params = Object.fromEntries(url.searchParams);
  const stationId = params[NOTIFICATION_STATION_QUERY_PARAM];
  delete params[NOTIFICATION_STATION_QUERY_PARAM];
  return {
    pathname: url.pathname,
    params,
    ...(isNotificationStationId(stationId) ? { stationId } : {}),
  };
}

/** Parameters held back from a cold load until its Station is known. */
export const NOTIFICATION_LINK_HELD_PARAMS = [
  'chat',
  'dock',
  OPENED_NOTIFICATION_QUERY_PARAM,
  NOTIFICATION_STATION_QUERY_PARAM,
] as const;

/**
 * A notification link loaded cold (a Web Push tap that opened a tab or
 * navigated one): when the URL names a Station, the request to open once
 * connections are known. The caller takes `NOTIFICATION_LINK_HELD_PARAMS`
 * off the URL before anything reads them, so the dock does not look the
 * conversation up on whichever Station happens to be active, and the read
 * marker is not sent there. Without a Station parameter: null, and the URL
 * is left alone.
 */
export function captureNotificationLink(location: {
  pathname: string;
  search: string;
}): NotificationOpenRequest | null {
  const search = new URLSearchParams(location.search);
  if (!search.has(NOTIFICATION_STATION_QUERY_PARAM)) return null;
  const stationId = search.get(NOTIFICATION_STATION_QUERY_PARAM);
  const params = Object.fromEntries(search);
  delete params[NOTIFICATION_STATION_QUERY_PARAM];
  return {
    pathname: location.pathname,
    params,
    ...(isNotificationStationId(stationId) ? { stationId } : {}),
  };
}

/**
 * Runs once at startup, before the first render: holds a cold-loaded
 * notification link back from the URL and queues it for the opener.
 */
export function holdColdNotificationLink(
  location: { pathname: string; search: string },
  clearParams: (params: Record<string, null>) => void,
): void {
  const request = captureNotificationLink(location);
  if (!request) return;
  clearParams(
    Object.fromEntries(NOTIFICATION_LINK_HELD_PARAMS.map((key) => [key, null])),
  );
  requestNotificationOpen(request);
}
