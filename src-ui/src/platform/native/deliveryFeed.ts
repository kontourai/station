import {
  DESKTOP_INSTALLATION_HEADER,
  NOTIFICATION_DELIVERIES_PATH,
  type SurfaceDeliveryEntry,
  type SurfaceDeliveryFeed,
} from '@kontourai/station-contracts/notification-preferences';
import { authenticatedFetch } from '@kontourai/station-sdk';
import { desktopInstallationId } from './installationId';
import { notifyNatively } from './notify';

/**
 * Desktop OS alerts for enveloped notifications (#2587), read from the
 * server's delivery feed (#2586).
 *
 * The server derives which surface the caller is — a paired device reads
 * `device:<id>`; this computer's desktop app, identified by the
 * {@link DESKTOP_INSTALLATION_HEADER} header, reads
 * `local:desktop-<installationId>` — and echoes it. The client never names
 * or guesses a surface.
 *
 * The server's delivery router is the single policy engine: every entry has
 * already passed focus presence, quiet hours, mutes and minimum urgency, and
 * is redacted per the surface's `hideContent`. This module does not
 * re-decide any of that. It only
 * - reads the feed (reading also renews the surface's lease, which is what
 *   makes the router target it at all);
 * - resumes across reloads: cursor and epoch are kept in localStorage per
 *   connection, tagged with the surface the server echoed, so a reload reads
 *   on from where the previous document stopped and posts what queued in
 *   between. A stored cursor for a different surface is not used;
 * - seeds when there is no usable stored cursor: the feed's current backlog
 *   is not replayed as a burst;
 * - follows the epoch: a different epoch is a restarted server whose answer
 *   is all new;
 * - keeps one presentation guard: no OS alert while this window is focused
 *   (the entry is consumed, since the in-app toast already shows it);
 * - reads one at a time: an overlapping poll (a StrictMode double effect, a
 *   read slower than the interval) joins the read in flight instead of
 *   applying the same entries twice;
 * - never posts the same alert twice in a document: a bounded set of
 *   recently posted (notification id, title, body, urgency), behind the
 *   cursor as a second line. The router re-delivers a dedupe update only
 *   when its content changed, so an update under the same id (a progress
 *   card turning into "needs input") still alerts;
 * - drops an alert whose retract arrives in the same read. A retract for an
 *   alert already posted cannot be honoured: the desktop notification plugin
 *   exposes no way to close a delivered notification.
 *
 * A feed that cannot be read (older Station: 404; `installation_required`,
 * `device_not_eligible`, `surface_required`; 5xx; network) posts nothing.
 */
export interface DeliveryFeedDeps {
  installationId(): Promise<string | undefined>;
  readFeed(input: {
    after: number;
    epoch: string | undefined;
    installationId: string | undefined;
  }): Promise<SurfaceDeliveryFeed | undefined>;
  isWindowFocused(): boolean;
  notify(input: { title: string; body?: string }): Promise<boolean>;
  /**
   * Alerts already posted in this document. Optional: defaults to a
   * module-level bounded set; a test can pass a no-op to observe the cursor
   * and single-flight lines on their own.
   */
  postedAlerts?: PostedAlerts;
  loadCursor(key: string): StoredCursor | undefined;
  saveCursor(key: string, value: StoredCursor): void;
}

export interface StoredCursor {
  surface: string;
  cursor: number;
  epoch: string;
}

const CURSOR_STORAGE_PREFIX = 'station.notificationDeliveryCursor:';

let state: {
  scopeKey: string;
  surface?: string;
  cursor: number | null;
  epoch?: string;
} | null = null;

let inFlight: Promise<number> | null = null;
export interface PostedAlerts {
  has(key: string): boolean;
  add(key: string): void;
}

const RECENTLY_POSTED_MAX = 200;
const recentlyPosted = new Set<string>();
const boundedPostedAlerts: PostedAlerts = {
  has: (key) => recentlyPosted.has(key),
  add: (key) => {
    recentlyPosted.add(key);
    if (recentlyPosted.size > RECENTLY_POSTED_MAX) {
      const oldest = recentlyPosted.values().next().value;
      if (oldest !== undefined) recentlyPosted.delete(oldest);
    }
  },
};

/** Test seam. */
export function resetDeliveryFeedState(): void {
  state = null;
  inFlight = null;
  recentlyPosted.clear();
}

function defaultDeps(apiBase: string): DeliveryFeedDeps {
  return {
    installationId: () => desktopInstallationId(),
    readFeed: async ({ after, epoch, installationId }) => {
      try {
        const query = new URLSearchParams({ after: String(after) });
        if (epoch !== undefined) query.set('epoch', epoch);
        const response = await authenticatedFetch(
          `${apiBase}${NOTIFICATION_DELIVERIES_PATH}?${query}`,
          installationId
            ? { headers: { [DESKTOP_INSTALLATION_HEADER]: installationId } }
            : undefined,
        );
        if (!response.ok) return undefined;
        const body = (await response.json()) as {
          success?: boolean;
          data?: SurfaceDeliveryFeed;
        };
        return body.success && isFeed(body.data) ? body.data : undefined;
      } catch {
        return undefined;
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

/**
 * One read of the feed. Returns how many OS alerts were posted; a call made
 * while a read is in flight joins it.
 */
export function pollDeliveryFeed(
  apiBase: string,
  scopeKey: string,
  deps: DeliveryFeedDeps = defaultDeps(apiBase),
): Promise<number> {
  if (inFlight) return inFlight;
  const read = readOnce(scopeKey, deps).finally(() => {
    if (inFlight === read) inFlight = null;
  });
  inFlight = read;
  return read;
}

async function readOnce(
  scopeKey: string,
  deps: DeliveryFeedDeps,
): Promise<number> {
  const installationId = await deps.installationId();
  if (state?.scopeKey !== scopeKey) {
    const stored = deps.loadCursor(scopeKey);
    state = stored ? { scopeKey, ...stored } : { scopeKey, cursor: null };
  }
  const current = state;
  const after = current.cursor ?? 0;
  const feed = await deps.readFeed({
    after,
    epoch: current.epoch,
    installationId,
  });
  // A connection switch while the read was in flight: this answer belongs
  // to the previous connection.
  if (state !== current || !feed) return 0;
  // A cursor stored for another surface (a different installation, or the
  // connection now reads as a different caller) says nothing about this one.
  const seeding = current.cursor === null || current.surface !== feed.surface;
  const from = feed.epoch === current.epoch ? after : 0;
  current.surface = feed.surface;
  current.cursor = feed.cursor;
  current.epoch = feed.epoch;
  deps.saveCursor(scopeKey, {
    surface: feed.surface,
    cursor: feed.cursor,
    epoch: feed.epoch,
  });
  if (seeding) return 0;
  const entries = [...feed.entries]
    .filter((entry) => entry.seq > from)
    .sort((a, b) => a.seq - b.seq);
  const retractedAt = new Map<string, number>();
  for (const entry of entries)
    if (entry.kind === 'retract')
      retractedAt.set(entry.notificationId, entry.seq);
  if (deps.isWindowFocused()) return 0;
  let count = 0;
  for (const entry of entries) {
    if (entry.kind !== 'alert') continue;
    if ((retractedAt.get(entry.notificationId) ?? -1) > entry.seq) continue;
    // JSON of the fields keeps the key unambiguous (no separator a title
    // could contain); entries are bounded by the router's caps.
    const key = JSON.stringify([
      entry.notificationId,
      entry.title,
      entry.body ?? null,
      entry.urgency,
    ]);
    const posted = deps.postedAlerts ?? boundedPostedAlerts;
    if (posted.has(key)) continue;
    posted.add(key);
    await deps.notify(
      entry.body === undefined
        ? { title: entry.title }
        : { title: entry.title, body: entry.body },
    );
    count += 1;
  }
  return count;
}

function isStoredCursor(value: unknown): value is StoredCursor {
  if (typeof value !== 'object' || value === null) return false;
  const stored = value as Partial<StoredCursor>;
  return (
    typeof stored.surface === 'string' &&
    Number.isSafeInteger(stored.cursor) &&
    (stored.cursor ?? -1) >= 0 &&
    typeof stored.epoch === 'string'
  );
}

function isFeed(value: unknown): value is SurfaceDeliveryFeed {
  if (typeof value !== 'object' || value === null) return false;
  const feed = value as Partial<SurfaceDeliveryFeed>;
  return (
    typeof feed.surface === 'string' &&
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
