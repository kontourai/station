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
 * server's per-surface delivery feed (#2586).
 *
 * The server's delivery router is the single policy engine: every entry in
 * the feed has already passed focus presence, quiet hours, mutes and
 * minimum urgency, and is redacted per the surface's `hideContent`. This
 * module does not re-decide any of that. It only
 * - reads the feed for `local:desktop-<installationId>` (reading also renews
 *   the host's lease, which is what makes the router target it at all);
 * - seeds on the first read of a connection: entries queued before this
 *   document started are not replayed as a burst (a reload loses at most
 *   what arrived between the last read and the reload — disclosed);
 * - keeps one presentation guard: no OS alert while this window is focused
 *   (the entry is consumed, since the in-app toast already shows it);
 * - drops an alert whose retract arrives in the same read. A retract for an
 *   alert already posted cannot be honoured: the desktop notification plugin
 *   exposes no way to close a delivered notification.
 *
 * A feed that cannot be read (older Station: 404; a remote Station, whose
 * feed is local-operator only: 403; 5xx; network) posts nothing.
 */
export interface DeliveryFeedDeps {
  installationId(): Promise<string | undefined>;
  readFeed(
    surface: string,
    after: number,
    epoch: string | undefined,
  ): Promise<SurfaceDeliveryFeed | undefined>;
  isWindowFocused(): boolean;
  notify(input: { title: string; body?: string }): Promise<boolean>;
}

let state: {
  scopeKey: string;
  cursor: number | null;
  epoch?: string;
} | null = null;

/** Test seam. */
export function resetDeliveryFeedState(): void {
  state = null;
}

function defaultDeps(apiBase: string): DeliveryFeedDeps {
  return {
    installationId: () => desktopInstallationId(),
    readFeed: async (surface, after, epoch) => {
      try {
        const query = new URLSearchParams({ surface, after: String(after) });
        if (epoch !== undefined) query.set('epoch', epoch);
        const response = await authenticatedFetch(
          `${apiBase}${NOTIFICATION_DELIVERIES_PATH}?${query}`,
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
  };
}

/** One read of the feed. Returns how many OS alerts were posted. */
export async function pollDeliveryFeed(
  apiBase: string,
  scopeKey: string,
  deps: DeliveryFeedDeps = defaultDeps(apiBase),
): Promise<number> {
  const installationId = await deps.installationId();
  if (!installationId) return 0;
  if (state?.scopeKey !== scopeKey) state = { scopeKey, cursor: null };
  const current = state;
  const after = current.cursor ?? 0;
  const feed = await deps.readFeed(
    desktopHostSurfaceId(installationId),
    after,
    current.epoch,
  );
  // A connection switch while the read was in flight: this answer belongs
  // to the previous connection.
  if (state !== current || !feed) return 0;
  const seeding = current.cursor === null;
  // A different epoch is a restarted server: its sequence began again and
  // it answered from the start of its feed, all of it newer than this
  // document has seen.
  const from = feed.epoch === current.epoch ? after : 0;
  current.cursor = feed.cursor;
  current.epoch = feed.epoch;
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
