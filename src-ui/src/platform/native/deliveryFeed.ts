import {
  DESKTOP_INSTALLATION_HEADER,
  NOTIFICATION_DELIVERIES_PATH,
  type SurfaceDeliveryEntry,
  type SurfaceDeliveryFeed,
} from '@kontourai/station-contracts/notification-preferences';
import { authenticatedFetch } from '@kontourai/station-sdk';
import { desktopInstallationId } from './installationId';
import { notifyNatively } from './notify';
import { invokeTauri } from './tauriInvoke';

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
 * - reads one at a time per connection: an overlapping poll (a StrictMode
 *   double effect, a read slower than the interval) joins the read in
 *   flight instead of applying the same entries twice. A poll for another
 *   connection never joins: it starts its own read, and the old read's
 *   answer is discarded;
 * - bounds every read: the request carries a timeout and the whole read
 *   (including posting) a deadline, after which it is abandoned — nothing
 *   it later receives is applied — and the next poll reads afresh;
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
 *
 * **One consumer (#2608).** A desktop host that consumes the feed natively
 * (`notification_feed_native_consumer` answers `true`,
 * `src-desktop/src/notification_feed.rs`) is the ONLY consumer: this module
 * then never reads the feed and never posts from it, so the two cannot both
 * alert. The native consumer keeps reading while the window is hidden in the
 * tray, which this document cannot. The answer is fixed for the process, so
 * the role never changes hands at runtime. The one handoff is a cursor this
 * module stored under an older build: it is offered to the host once
 * (`notification_feed_adopt_cursor`) and deleted here only if the host took
 * it. A host that takes it resumes from it, so nothing before it repeats; an
 * offer the host refuses (it already started from its own first read) means
 * entries queued between that cursor and the host's first read are not
 * alerted.
 *
 * Only a definite answer settles the role, and only a definite answer is
 * remembered: `true`; or `false` / "Command … not found" from a shell that
 * predates the command (or no Tauri bridge at all), where this module stays
 * the consumer as before. Any other failure (an IPC error) reads and posts
 * nothing and asks again on the next poll — guessing "not native" there is
 * how both would post.
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
  /**
   * Whether the native host consumes this feed itself (#2608): `true`,
   * `false`, or `undefined` when the host could not be asked (read and post
   * nothing, ask again). Absent means it does not.
   */
  nativeConsumer?(): Promise<boolean | undefined>;
  /** Hand a stored cursor to the native consumer; `true` once it owns it. */
  handOffCursor?(input: {
    origin: string;
    cursor: StoredCursor;
  }): Promise<boolean>;
  removeCursor?(key: string): void;
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

/** Request timeout for one feed read; below the hook's poll interval. */
export const FEED_REQUEST_TIMEOUT_MS = 10_000;
/** Deadline for a whole read, posting included. */
export const FEED_READ_DEADLINE_MS = 15_000;

let inFlight: { scopeKey: string; promise: Promise<number> } | null = null;
/** The host's answer, asked once per document: it cannot change. */
let nativeConsumerAnswer: boolean | null = null;

const NATIVE_CONSUMER_COMMAND = 'notification_feed_native_consumer';

/** Tauri's rejection for a command the host does not register. */
function isUnknownCommand(error: unknown, command: string): boolean {
  const message = error instanceof Error ? error.message : error;
  return message === `Command ${command} not found`;
}

function hasTauriBridge(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function askNativeConsumer(): Promise<boolean | undefined> {
  if (nativeConsumerAnswer !== null) return nativeConsumerAnswer;
  if (!hasTauriBridge()) {
    nativeConsumerAnswer = false;
    return false;
  }
  try {
    const value = await invokeTauri<unknown>(NATIVE_CONSUMER_COMMAND);
    if (typeof value !== 'boolean') return undefined;
    nativeConsumerAnswer = value;
    return value;
  } catch (error) {
    if (!isUnknownCommand(error, NATIVE_CONSUMER_COMMAND)) return undefined;
    nativeConsumerAnswer = false;
    return false;
  }
}
/** Connections whose stored cursor was already offered to the host. */
const handedOff = new Set<string>();
/** The connection the latest poll was for; older reads stop applying. */
let activeScopeKey: string | null = null;
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
  activeScopeKey = null;
  recentlyPosted.clear();
  nativeConsumerAnswer = null;
  handedOff.clear();
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
          {
            timeoutMs: FEED_REQUEST_TIMEOUT_MS,
            ...(installationId
              ? { headers: { [DESKTOP_INSTALLATION_HEADER]: installationId } }
              : {}),
          },
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
    nativeConsumer: askNativeConsumer,
    handOffCursor: async ({ origin, cursor }) =>
      (await invokeTauri<unknown>('notification_feed_adopt_cursor', {
        origin,
        cursor,
      })) === true,
    removeCursor: (key) => {
      try {
        localStorage.removeItem(`${CURSOR_STORAGE_PREFIX}${key}`);
      } catch {
        /* Unavailable storage: the host refuses a second offer anyway. */
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
  activeScopeKey = scopeKey;
  if (inFlight?.scopeKey === scopeKey) return inFlight.promise;
  let abandoned = false;
  const live = () => !abandoned && activeScopeKey === scopeKey;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<number>((resolve) => {
    timer = setTimeout(() => {
      abandoned = true;
      resolve(0);
    }, FEED_READ_DEADLINE_MS);
  });
  const entry = {
    scopeKey,
    promise: Promise.race([
      consumeOnce(apiBase, scopeKey, deps, live),
      deadline,
    ]).finally(() => {
      clearTimeout(timer);
      if (inFlight === entry) inFlight = null;
    }),
  };
  inFlight = entry;
  return entry.promise;
}

/**
 * Asked before any read, inside the single flight: when the host consumes
 * the feed — or cannot say whether it does — this document does not read
 * it, so it cannot post an entry the host also posts.
 */
async function consumeOnce(
  apiBase: string,
  scopeKey: string,
  deps: DeliveryFeedDeps,
  live: () => boolean,
): Promise<number> {
  if (deps.nativeConsumer) {
    const native = await deps.nativeConsumer();
    if (native !== false) {
      if (native === true && live())
        await handOffStoredCursor(apiBase, scopeKey, deps);
      return 0;
    }
  }
  return readOnce(scopeKey, deps, live);
}

async function readOnce(
  scopeKey: string,
  deps: DeliveryFeedDeps,
  live: () => boolean,
): Promise<number> {
  const installationId = await deps.installationId();
  if (!live()) return 0;
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
  // A connection switch while the read was in flight (this answer belongs
  // to the previous connection), or a read past its deadline.
  if (!live() || state !== current || !feed) return 0;
  // A cursor stored for another surface (a different installation, or the
  // connection now reads as a different caller) says nothing about this one.
  const seeding = current.cursor === null || current.surface !== feed.surface;
  const from = feed.epoch === current.epoch ? after : 0;
  // The cursor moves as entries are handled, never ahead of them: a read
  // abandoned at its deadline part-way through posting leaves the cursor at
  // the last handled entry, and the next read resumes there. Committing
  // `feed.cursor` up front used to skip every entry not yet posted.
  const commit = (cursor: number) => {
    current.surface = feed.surface;
    current.cursor = cursor;
    current.epoch = feed.epoch;
    deps.saveCursor(scopeKey, {
      surface: feed.surface,
      cursor,
      epoch: feed.epoch,
    });
  };
  if (seeding) {
    commit(feed.cursor);
    return 0;
  }
  const entries = [...feed.entries]
    .filter((entry) => entry.seq > from)
    .sort((a, b) => a.seq - b.seq);
  const retractedAt = new Map<string, number>();
  for (const entry of entries)
    if (entry.kind === 'retract')
      retractedAt.set(entry.notificationId, entry.seq);
  if (deps.isWindowFocused()) {
    commit(feed.cursor);
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (!live()) return count;
    if (
      entry.kind !== 'alert' ||
      (retractedAt.get(entry.notificationId) ?? -1) > entry.seq
    ) {
      commit(entry.seq);
      continue;
    }
    // JSON of the fields keeps the key unambiguous (no separator a title
    // could contain); entries are bounded by the router's caps.
    const key = JSON.stringify([
      entry.notificationId,
      entry.title,
      entry.body ?? null,
      entry.urgency,
    ]);
    const posted = deps.postedAlerts ?? boundedPostedAlerts;
    if (!posted.has(key)) {
      await deps.notify(
        entry.body === undefined
          ? { title: entry.title }
          : { title: entry.title, body: entry.body },
      );
      // Remembered once the OS took it, so an abandoned post (a notifier
      // that hung past the deadline) is retried by the next read.
      posted.add(key);
      count += 1;
    }
    if (!live()) return count;
    commit(entry.seq);
  }
  commit(feed.cursor);
  return count;
}

async function handOffStoredCursor(
  apiBase: string,
  scopeKey: string,
  deps: DeliveryFeedDeps,
): Promise<void> {
  if (handedOff.has(scopeKey)) return;
  handedOff.add(scopeKey);
  const stored = deps.loadCursor(scopeKey);
  if (!stored || !deps.handOffCursor) return;
  let origin: string;
  try {
    origin = new URL(apiBase).origin;
  } catch {
    return;
  }
  try {
    if (await deps.handOffCursor({ origin, cursor: stored }))
      deps.removeCursor?.(scopeKey);
  } catch {
    // The command failed: offer it again on the next poll. The host starts
    // from its first read if no offer lands inside its grace.
    handedOff.delete(scopeKey);
  }
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
    (feed.now === undefined || typeof feed.now === 'string') &&
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
