/**
 * DesktopHostChannel (#2586): the `desktop-os` DeliveryChannel. The desktop
 * app's webview stops polling while hidden in the tray, so the OS alert has
 * to come from something that keeps running — the native host. This channel
 * queues the router's DECIDED deliveries per surface — this computer's
 * `local:desktop-<installationId>`, or `device:<id>` for a desktop app on a
 * remote Station — and the host reads its own from
 * `GET /api/notifications/deliveries` (the route derives which).
 *
 * - Only decided deliveries: every entry already passed the policy (focus,
 *   quiet hours, minUrgency, mute). The host shows what it reads.
 * - Redacted per the surface's `hideContent` before it is queued: a hidden
 *   entry never carries the title or body, so nothing downstream can leak it.
 * - Registration is a lease: a host is a delivery target only while it has
 *   read its feed within `leaseMs`. A host that never polls is never
 *   targeted, so the channel is inert until a native consumer exists.
 * - Retract: a read or dismiss elsewhere queues a `retract` entry.
 * - Bounded: surfaces, entries per surface and entry age are all capped;
 *   in memory only (a restart starts every feed empty and the host re-reads
 *   from the new cursor).
 */
import { randomUUID } from 'node:crypto';
import type {
  Notification,
  NotificationEnvelopeV1,
} from '@kontourai/station-contracts/notification';
import {
  DESKTOP_HOST_SURFACE_PREFIX,
  type SurfaceDeliveryEntry,
  type SurfaceDeliveryFeed,
} from '@kontourai/station-contracts/notification-preferences';
import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import { resolveNotificationOpenHref } from '../notification-deep-link.js';
import type {
  ChannelTarget,
  DeliveryChannel,
  DeliveryOutcome,
  SurfaceId,
} from './channel.js';

export const DESKTOP_HOST_LEASE_MS = 90_000;
const MAX_SURFACES = 16;
const MAX_ENTRIES_PER_SURFACE = 100;
const MAX_ENTRY_AGE_MS = 60 * 60 * 1000;
const HIDDEN_TITLE = 'Station';

/** `local:desktop-<id>`, id of UUID-ish characters. */
const DESKTOP_SURFACE_PATTERN = /^local:desktop-[A-Za-z0-9-]{8,64}$/;

export function isDesktopHostSurface(value: unknown): value is SurfaceId {
  return (
    typeof value === 'string' &&
    value.startsWith(DESKTOP_HOST_SURFACE_PREFIX) &&
    DESKTOP_SURFACE_PATTERN.test(value)
  );
}

interface SurfaceFeed {
  lastReadAt: number;
  entries: Array<SurfaceDeliveryEntry & { queuedAt: number }>;
}

export class DesktopHostChannel implements DeliveryChannel {
  readonly kind = 'desktop-os' as const;
  readonly capabilities = {
    retract: true,
    sealed: false,
    wakesClosedApp: false,
  };
  readonly #feeds = new Map<SurfaceId, SurfaceFeed>();
  readonly #now: () => number;
  /** Sequence numbers are per server run; this names the run. */
  readonly #epoch: string;
  #seq = 0;

  constructor(options: { now?: () => number; epoch?: string } = {}) {
    this.#now = options.now ?? Date.now;
    this.#epoch = options.epoch ?? randomUUID();
  }

  registrations(): Array<{ surface: SurfaceId; ref: string }> {
    const now = this.#now();
    const live: Array<{ surface: SurfaceId; ref: string }> = [];
    for (const [surface, feed] of this.#feeds)
      if (now - feed.lastReadAt <= DESKTOP_HOST_LEASE_MS)
        live.push({ surface, ref: surface });
    return live;
  }

  async deliver(
    notification: Notification,
    envelope: NotificationEnvelopeV1,
    to: ChannelTarget[],
  ): Promise<DeliveryOutcome[]> {
    const link = resolveNotificationTargetLink(notification, envelope);
    return to.map(({ surface, ref, hideContent }) => {
      const feed = this.#feeds.get(surface);
      if (!feed) return { ref, result: 'gone' };
      this.#push(feed, {
        seq: 0,
        kind: 'alert',
        notificationId: notification.id,
        title: hideContent ? HIDDEN_TITLE : notification.title,
        ...(hideContent || notification.body === undefined
          ? {}
          : { body: notification.body }),
        urgency: envelope.urgency,
        link,
        at: new Date(this.#now()).toISOString(),
      });
      return { ref, result: 'sent' };
    });
  }

  async retract(notificationId: string, to: ChannelTarget[]): Promise<void> {
    for (const { surface } of to) {
      const feed = this.#feeds.get(surface);
      if (!feed) continue;
      this.#push(feed, {
        seq: 0,
        kind: 'retract',
        notificationId,
        at: new Date(this.#now()).toISOString(),
      });
    }
  }

  /**
   * The host's read: entries after `after`, and a renewed lease. The first
   * read registers the surface (bounded; the least recently read is
   * dropped past the cap).
   */
  read(surface: SurfaceId, after: number, epoch?: string): SurfaceDeliveryFeed {
    // A cursor from another server run (or past this run's last entry)
    // means nothing here: answer from the start rather than withhold
    // everything until this run's sequence catches up.
    const since =
      (epoch !== undefined && epoch !== this.#epoch) || after > this.#seq
        ? 0
        : after;
    const now = this.#now();
    let feed = this.#feeds.get(surface);
    if (!feed) {
      feed = { lastReadAt: now, entries: [] };
      this.#feeds.set(surface, feed);
      this.#evictSurfaces();
    }
    feed.lastReadAt = now;
    this.#prune(feed, now);
    return {
      surface,
      entries: feed.entries
        .filter((entry) => entry.seq > since)
        .map(({ queuedAt: _queuedAt, ...entry }) => entry),
      cursor: this.#seq,
      epoch: this.#epoch,
      leaseMs: DESKTOP_HOST_LEASE_MS,
    };
  }

  #push(feed: SurfaceFeed, entry: SurfaceDeliveryEntry): void {
    this.#seq += 1;
    feed.entries.push({ ...entry, seq: this.#seq, queuedAt: this.#now() });
    this.#prune(feed, this.#now());
  }

  #prune(feed: SurfaceFeed, now: number): void {
    feed.entries = feed.entries
      .filter((entry) => now - entry.queuedAt <= MAX_ENTRY_AGE_MS)
      .slice(-MAX_ENTRIES_PER_SURFACE);
  }

  #evictSurfaces(): void {
    while (this.#feeds.size > MAX_SURFACES) {
      let oldest: SurfaceId | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [surface, feed] of this.#feeds)
        if (feed.lastReadAt < oldestAt) {
          oldest = surface;
          oldestAt = feed.lastReadAt;
        }
      if (oldest === undefined) break;
      this.#feeds.delete(oldest);
    }
  }
}

/**
 * Where a click opens: the envelope's target when it has one, else the
 * same session/metadata resolution Web Push uses, else the inbox.
 */
function resolveNotificationTargetLink(
  notification: Notification,
  envelope: NotificationEnvelopeV1,
): string {
  const target = envelope.target;
  if (target?.kind === 'path') return target.path;
  if (target?.kind === 'session')
    return activityDeepLink({ sessionId: target.sessionId });
  const metadata = notification.metadata ?? {};
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value : undefined;
  return (
    resolveNotificationOpenHref(
      metadata,
      text(metadata.sessionId) ?? text(metadata.conversationId),
      text(metadata.sessionKind),
    ) ?? '/notifications'
  );
}
