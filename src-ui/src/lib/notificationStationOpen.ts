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
 * conversation on <Station>") and only then navigates, so a session id is
 * never looked up on the wrong Station. A Station that is not saved here,
 * one this device cannot confirm, or a switch that fails or is overtaken
 * says so instead of silently dropping the tap or opening it here.
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
  | { kind: 'not-saved' }
  /** The link names a Station, but the active Station's own id is unknown. */
  | { kind: 'unconfirmed' };

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
 * environment id does not contradict the link's; an origin no saved
 * connection serves is not saved here, whatever the link's id says. Without
 * one, the connection with the link's environment id. The active Station's
 * id is `activeEnvironmentId` (the verified authority observation) when
 * given, else its saved one: a same-origin browser connection may never have
 * saved one. A link id that matches nothing while the active Station's own
 * id is unknown is `unconfirmed`: it is never opened here on a guess. Only a
 * request naming no Station (an older Station that sends none) opens on the
 * active one without a match.
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
    // The host's own record of where the alert came from outranks the
    // link: no saved connection serves that origin, so none may open it.
    return { kind: 'not-saved' };
  }
  if (stationId) {
    if (activeId === stationId) return { kind: 'active' };
    const saved = connections.find(
      (connection) => connection.environmentId === stationId,
    );
    if (saved) return pick(saved);
    // The active Station's own id is unknown: it may or may not be the
    // sender, and a guess would look the id up (and mark it read) here.
    if (!activeId) return { kind: 'unconfirmed' };
    return { kind: 'not-saved' };
  }
  return { kind: 'active' };
}

/* ── Notice ─────────────────────────────────────────────────────────── */

export type NotificationOpenNotice =
  | { kind: 'switching'; stationName: string }
  | { kind: 'not-saved' }
  | { kind: 'unconfirmed'; retry: () => void }
  | { kind: 'switch-failed'; stationName: string; retry: () => void }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  /**
   * `apiBase` is the Station the lookup failed on: the notice (and its
   * retry) belongs to that Station and is retired when another is active.
   */
  | { kind: 'unreachable'; apiBase: string; retry: () => void };

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
 * `stationName` is the Station the tap switched to, for the opening label.
 */
const notificationChats: { chatId: string; stationName?: string }[] = [];

export function markNotificationChat(
  chatId: string,
  stationName?: string,
): void {
  const index = notificationChats.findIndex((entry) => entry.chatId === chatId);
  if (index >= 0) notificationChats.splice(index, 1);
  notificationChats.push(stationName ? { chatId, stationName } : { chatId });
  if (notificationChats.length > 8) notificationChats.shift();
}

/** Whether `chatId` was opened by a notification, without forgetting it. */
export function isNotificationChat(chatId: string): boolean {
  return notificationChats.some((entry) => entry.chatId === chatId);
}

/** Whether `chatId` was opened by a notification; forgets it. */
export function takeNotificationChat(chatId: string): boolean {
  const index = notificationChats.findIndex((entry) => entry.chatId === chatId);
  if (index < 0) return false;
  notificationChats.splice(index, 1);
  return true;
}

/**
 * What the dock says while `chatId` opens: the Station's name when a
 * notification tap switched to it first.
 */
export function openingConversationLabel(chatId: string | null): string {
  const stationName = notificationChats.find(
    (entry) => entry.chatId === chatId,
  )?.stationName;
  return stationName
    ? `Opening conversation on ${stationName}`
    : 'Opening conversation';
}

/**
 * Opens an in-app notification target on the active Station (an in-app
 * toast or an attention row: both list the active Station's records),
 * marked like a tap so a missing or refused conversation is reported.
 */
export function openNotificationTargetHere(
  pathname: string,
  params: Record<string, string>,
  navigate: (pathname: string, params: Record<string, string>) => void,
): void {
  if (params.chat) markNotificationChat(params.chat);
  navigate(pathname, params);
}

/* ── Opening ────────────────────────────────────────────────────────── */

export interface NotificationOpenDeps<C extends NotificationStationConnection> {
  connections(): readonly C[];
  active(): C | null;
  /** The active Station's verified environment id, when known. */
  activeEnvironmentId?(): string | null | undefined;
  /**
   * Selects a saved connection. It may resolve without committing it: the
   * connection provider resolves a selection a newer one overtook.
   */
  setActiveConnection(id: string): Promise<unknown>;
  /**
   * The connection the store holds active right now (a live read, not a
   * render's): what a resolved selection actually committed.
   */
  committedActiveId(): string | null;
  navigate(pathname: string, params: Record<string, string>): void;
}

export type NotificationOpenOutcome =
  | 'opened'
  | 'switched'
  | 'not-saved'
  | 'unconfirmed'
  | 'switch-failed'
  /** A newer tap took over while this one was switching. */
  | 'superseded';

/** Advances per open: only the newest tap may navigate after a switch. */
let openGeneration = 0;
/** Switches in flight; a tap for the active Station must overtake them. */
let switchesInFlight = 0;

/**
 * Opens `request` on its Station: navigates at once when that is the
 * active Station, switches first when it is another saved one, and shows
 * a notice when it is not saved, unconfirmed, or the switch fails. After a
 * switch it navigates only when this is still the newest tap and the store
 * committed the requested Station: the provider resolves an overtaken
 * selection silently, so resolving proves nothing. Resolves what it did.
 */
export async function openNotificationTarget<
  C extends NotificationStationConnection,
>(
  request: NotificationOpenRequest,
  deps: NotificationOpenDeps<C>,
): Promise<NotificationOpenOutcome> {
  const generation = ++openGeneration;
  const resolution = resolveNotificationStation(
    request,
    deps.connections(),
    deps.active(),
    deps.activeEnvironmentId?.(),
  );
  const open = (stationName?: string) => {
    if (request.params.chat)
      markNotificationChat(request.params.chat, stationName);
    deps.navigate(request.pathname, request.params);
  };
  const retry = () => void openNotificationTarget(request, deps);
  if (resolution.kind === 'not-saved') {
    setNotificationOpenNotice({ kind: 'not-saved' });
    return 'not-saved';
  }
  if (resolution.kind === 'unconfirmed') {
    setNotificationOpenNotice({ kind: 'unconfirmed', retry });
    return 'unconfirmed';
  }
  const active = deps.active();
  // A tap for the active Station while an earlier tap is still switching
  // away from it re-selects it, so that switch cannot land afterwards.
  const connection =
    resolution.kind === 'switch'
      ? resolution.connection
      : switchesInFlight > 0 && active
        ? active
        : null;
  if (!connection) {
    open();
    return 'opened';
  }
  const switching: NotificationOpenNotice = {
    kind: 'switching',
    stationName: connection.name,
  };
  setNotificationOpenNotice(switching);
  const failed = (): NotificationOpenOutcome => {
    setNotificationOpenNotice({
      kind: 'switch-failed',
      stationName: connection.name,
      retry,
    });
    return 'switch-failed';
  };
  switchesInFlight += 1;
  try {
    await deps.setActiveConnection(connection.id);
  } catch {
    return generation === openGeneration ? failed() : 'superseded';
  } finally {
    switchesInFlight -= 1;
  }
  if (generation !== openGeneration) return 'superseded';
  // Something else (the person, another tab) selected another Station
  // while this one was being prepared: never open this id over there.
  if (deps.committedActiveId() !== connection.id) return failed();
  open(resolution.kind === 'switch' ? connection.name : undefined);
  if (getNotificationOpenNotice() === switching)
    setNotificationOpenNotice(null);
  return resolution.kind === 'switch' ? 'switched' : 'opened';
}

/* ── One entry point for every channel ──────────────────────────────── */

type Opener = (request: NotificationOpenRequest) => void;
let opener: Opener | null = null;
const queued: { request: NotificationOpenRequest; position: unknown }[] = [];
/** Where the person is in the app's history (`installNavigationPosition`). */
let navigationPosition: (() => unknown) | null = null;

/**
 * Installed at boot with the navigation store's history position, which
 * every navigation (and Back) moves. A request that waited for the opener
 * is dropped when the person navigated meanwhile: their own navigation
 * supersedes a tap that had not opened yet.
 */
export function installNavigationPosition(read: () => unknown): () => void {
  navigationPosition = read;
  return () => {
    if (navigationPosition === read) navigationPosition = null;
  };
}

/**
 * Open a notification's target. Before the app's opener has mounted (a
 * tap that launched the app), the request waits for it; only the newest
 * waiting request is kept, as only the last tap matters.
 */
export function requestNotificationOpen(
  request: NotificationOpenRequest,
): void {
  if (opener) opener(request);
  else
    queued.splice(0, queued.length, {
      request,
      position: navigationPosition?.(),
    });
}

/** Installed by the app shell once connections are known. */
export function installNotificationOpener(next: Opener): () => void {
  opener = next;
  const position = navigationPosition?.();
  for (const entry of queued.splice(0))
    if (entry.position === position) next(entry.request);
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
 * navigated one) waits until connections are known. The caller takes
 * `NOTIFICATION_LINK_HELD_PARAMS`
 * off the URL before anything reads them, so the dock does not look the
 * conversation up on whichever Station happens to be active, and the read
 * marker is not sent there. Ordinary URLs without notification parameters
 * are left alone.
 */
export function captureNotificationLink(location: {
  pathname: string;
  search: string;
}): NotificationOpenRequest | null {
  const search = new URLSearchParams(location.search);
  if (
    !search.has(NOTIFICATION_STATION_QUERY_PARAM) &&
    !(search.has(OPENED_NOTIFICATION_QUERY_PARAM) && search.has('chat'))
  )
    return null;
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
 * notification link back from the URL and queues it for the opener. (A
 * navigation before the opener mounts drops it: `installNavigationPosition`.)
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
