import type { FileReadMarkerStore } from './read-marker-store.js';

/**
 * #3075 owner design: converts first-format read state once, at the upgrade
 * fence. Before server-kept unread there was no unread, so everything up to
 * the event store's fence (`contentUpgradeFence`, a contiguous sequence
 * prefix recorded with the projection backfill) reads as seen for everyone,
 * and everything appended after it reads unread until rendered. Nothing is
 * inferred from provider timestamps: a false unread is acceptable, a false
 * read is not.
 *
 * Returns whether an upgrade ran. Without a fence (the backfill has not
 * completed) nothing converts, and the first-format store stays refused:
 * read state unavailable, never "read".
 */
export function upgradeReadMarkerStore(input: {
  store: Pick<FileReadMarkerStore, 'pendingUpgrade' | 'completeUpgrade'>;
  events: { contentUpgradeFence(): number | undefined };
  now: Date;
}): boolean {
  if (!input.store.pendingUpgrade()) return false;
  const fence = input.events.contentUpgradeFence();
  if (fence === undefined) return false;
  input.store.completeUpgrade({
    baselineSequence: fence,
    baselineTime: input.now.getTime(),
  });
  return true;
}
