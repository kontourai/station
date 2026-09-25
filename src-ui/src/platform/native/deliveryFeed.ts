import {
  desktopHostSurfaceId,
  NOTIFICATION_DELIVERIES_PATH,
  type SurfaceDeliveryEntry,
  type SurfaceDeliveryFeed,
} from '@kontourai/station-contracts/notification-preferences';
import { authenticatedFetch } from '@kontourai/station-sdk';
import { desktopInstallationId } from './installationId';
import { notifyNatively } from './notify';

/**
 * Desktop OS alerts for enveloped notifications (#2587), read from the
 * server's per-surface delivery feed (#2586). The feed always serves the
 * caller's OWN surface:
 * - a Station on this computer (loopback endpoint, local operator): the
 *   desktop host surface `local:desktop-<installationId>`, named in the
 *   request;
 * - any other Station (this app is a paired device there): the device's
 *   `device:<id>` surface, derived by the server from the credential — the
 *   request names no surface.
 * The loopback guess is corrected by the server's answer: a surface refusal
 * switches to the other form once, and the working form is remembered for
 * the connection.
 *
 * The server's delivery router is the single policy engine: every entry in
 * the feed has already passed focus presence, quiet hours, mutes and
 * minimum urgency, and is redacted per the surface's `hideContent`. This
 * module does not re-decide any of that. It only
 * - reads the feed (reading also renews the surface's lease, which is what
 *   makes the router target it at all);
 * - resumes across reloads: the cursor and epoch are kept in localStorage
 *   per (endpoint, connection id, surface), so a reload reads on from where
 *   the previous document stopped and posts what was queued in between;
 * - seeds when there is no stored cursor (first run on a connection): the
 *   feed's current backlog is not replayed as a burst;
 * - keeps one presentation guard: no OS alert while this window is focused
 *   (the entry is consumed, since the in-app toast already shows it);
 * - drops an alert whose retract arrives in the same read. A retract for an
 *   alert already posted cannot be honoured: the desktop notification plugin
 *   exposes no way to close a delivered notification.
 *
 * A feed that cannot be read (older Station: 404; 5xx; network) posts
 * nothing.
 */
export type FeedRead =
  | { kind: 'feed'; feed: SurfaceDeliveryFeed }
  /** The server refused the surface form (named vs the caller's own). */
  | { kind: 'wrong-surface' }
  | { kind: 'failed' };

type FeedMode = 'installation' | 'own';
export interface DeliveryFeedDeps {
  installationId(): Promise<string | undefined>;
  /** `surface` undefined: the caller's own (device) surface. */
  readFeed(
    surface: string | undefined,
    after: number,
    epoch: string | undefined,
  ): Promise<FeedRead>;
  isWindowFocused(): boolean;
  notify(input: { title: string; body?: string }): Promise<boolean>;
  loadCursor(key: string): StoredCursor | undefined;
  saveCursor(key: string, value: StoredCursor): void;
}

export interface StoredCursor {
  cursor: number;
  epoch: string;
}

const CURSOR_STORAGE_PREFIX = 'station.notificationDeliveryCursor:';

let state: {
  storageKey: string;
  cursor: number | null;
  epoch?: string;
} | null = null;
/** The surface form that worked, per connection scope. */
const modes = new Map<string, FeedMode>();

/** Test seam. */
export function resetDeliveryFeedState(): void {
  state = null;
  modes.clear();
}

function defaultDeps(apiBase: string): DeliveryFeedDeps {
  return {
    installationId: () => desktopInstallationId(),
    readFeed: async (surface, after, epoch) => {
      try {
        const query = new URLSearchParams({ after: String(after) });
        if (epoch !== undefined) query.set('epoch', epoch);
        if (surface !== undefined) query.set('surface', surface);
        const response = await authenticatedFetch(
          `${apiBase}${NOTIFICATION_DELIVERIES_PATH}?${query}`,
        );
        const body = (await response.json().catch(() => ({}))) as {
          success?: boolean;
          data?: SurfaceDeliveryFeed;
          error?: string;
        };
        if (response.ok)
          return body.success && isFeed(body.data)
            ? { kind: 'feed', feed: body.data }
            : { kind: 'failed' };
        return (response.status === 400 && body.error === 'invalid_request') ||
          (response.status === 403 &&
            (body.error === 'surface_not_yours' ||
              body.error === 'surface_required'))
          ? { kind: 'wrong-surface' }
          : { kind: 'failed' };
      } catch {
        return { kind: 'failed' };
      }
    },
    isWindowFocused: () =>
      document.visibilityState === 'visible' && document.hasFocus(),
    notify: notifyNatively,
    loadCursor: (key) => {
      try {
        const value: unknown = JSON.parse(
          localStorage.getItem(`${CURSOR_STORAGE_PREFIX}${key}`) ?? 'null',
        );
        return isStoredCursor(value) ? value : undefined;
      } catch {
        return undefined;
      }
    },
    saveCursor: (key, value) => {
      try {
        localStorage.setItem(
          `${CURSOR_STORAGE_PREFIX}${key}`,
          JSON.stringify(value),
        );
      } catch {
        /* Storage full or unavailable: the next reload seeds instead. */
      }
    },
  };
}

function isStoredCursor(value: unknown): value is StoredCursor {
  if (typeof value !== 'object' || value === null) return false;
  const stored = value as Partial<StoredCursor>;
  return (
    Number.isSafeInteger(stored.cursor) &&
    (stored.cursor ?? -1) >= 0 &&
    typeof stored.epoch === 'string'
  );
}

/** One read of the feed. Returns how many OS alerts were posted. */
export async function pollDeliveryFeed(
  apiBase: string,
  scopeKey: string,
  deps: DeliveryFeedDeps = defaultDeps(apiBase),
): Promise<number> {
  const installationId = await deps.installationId();
  const hostSurface = installationId
    ? desktopHostSurfaceId(installationId)
    : undefined;
  let mode: FeedMode =
    modes.get(scopeKey) ??
    (hostSurface && isLoopback(apiBase) ? 'installation' : 'own');
  let read: FeedRead | undefined;
  let current: NonNullable<typeof state> | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (mode === 'installation' && !hostSurface) return 0;
    // `own` is keyed by the connection alone: its surface is the device the
    // connection's credential belongs to.
    const storageKey = `${scopeKey}\n${mode === 'installation' ? hostSurface : 'own'}`;
    if (state?.storageKey !== storageKey) {
      const stored = deps.loadCursor(storageKey);
      state = stored
        ? { storageKey, cursor: stored.cursor, epoch: stored.epoch }
        : { storageKey, cursor: null };
    }
    current = state;
    read = await deps.readFeed(
      mode === 'installation' ? hostSurface : undefined,
      current.cursor ?? 0,
      current.epoch,
    );
    if (read.kind !== 'wrong-surface') break;
    const other: FeedMode = mode === 'installation' ? 'own' : 'installation';
    if (other === 'installation' && !hostSurface) return 0;
    mode = other;
  }
  // A connection switch while the read was in flight: this answer belongs
  // to the previous connection.
  if (!current || state !== current || read?.kind !== 'feed') return 0;
  modes.set(scopeKey, mode);
  const feed = read.feed;
  const after = current.cursor ?? 0;
  const storageKey = current.storageKey;
  const seeding = current.cursor === null;
  // A different epoch is a restarted server: its sequence began again and
  // it answered from the start of its feed, all of it newer than this
  // document has seen.
  const from = feed.epoch === current.epoch ? after : 0;
  current.cursor = feed.cursor;
  current.epoch = feed.epoch;
  deps.saveCursor(storageKey, { cursor: feed.cursor, epoch: feed.epoch });
  if (seeding) return 0;
  const entries = [...feed.entries]
    .filter((entry) => entry.seq > from)
    .sort((a, b) => a.seq - b.seq);
  const retractedAt = new Map<string, number>();
  for (const entry of entries)
    if (entry.kind === 'retract')
      retractedAt.set(entry.notificationId, entry.seq);
  if (deps.isWindowFocused()) return 0;
  let posted = 0;
  for (const entry of entries) {
    if (entry.kind !== 'alert') continue;
    if ((retractedAt.get(entry.notificationId) ?? -1) > entry.seq) continue;
    await deps.notify(
      entry.body === undefined
        ? { title: entry.title }
        : { title: entry.title, body: entry.body },
    );
    posted += 1;
  }
  return posted;
}

function isLoopback(apiBase: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(
      new URL(apiBase).hostname,
    );
  } catch {
    return false;
  }
}

function isFeed(value: unknown): value is SurfaceDeliveryFeed {
  if (typeof value !== 'object' || value === null) return false;
  const feed = value as Partial<SurfaceDeliveryFeed>;
  return (
    Number.isSafeInteger(feed.cursor) &&
    typeof feed.epoch === 'string' &&
    Array.isArray(feed.entries) &&
    feed.entries.every(isEntry)
  );
}

function isEntry(value: unknown): value is SurfaceDeliveryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(entry.seq) ||
    typeof entry.notificationId !== 'string'
  )
    return false;
  if (entry.kind === 'retract') return true;
  return (
    entry.kind === 'alert' &&
    typeof entry.title === 'string' &&
    (entry.body === undefined || typeof entry.body === 'string')
  );
}
