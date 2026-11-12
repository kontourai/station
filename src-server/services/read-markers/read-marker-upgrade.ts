import type { FileReadMarkerStore } from './read-marker-store.js';

/**
 * #3075 owner design: begins read state once, at the migration cutoff.
 * Before server-kept unread there was no unread, so on a personal Station
 * the owner (`personal:owner`, see {@link FileReadMarkerStore.baselineFor})
 * reads everything up to the event store's cutoff (`contentUpgradeFence`,
 * immutable, taken when the store opened) as seen. Nobody else gets a
 * baseline: their history, and everything appended after the cutoff, reads
 * unread until rendered. A hosted Station gives nobody a baseline. The rule
 * is fixed, never sampled from who had a record. Nothing is inferred from
 * provider timestamps: a false unread is acceptable, a false read is not.
 *
 * Runs for a first-format store and for a home with none at all. Returns
 * whether it ran. Without a cutoff (the migration has not completed) nothing
 * begins, and nobody has a baseline: everything reads unread.
 */
export function upgradeReadMarkerStore(input: {
  store: Pick<FileReadMarkerStore, 'pendingUpgrade' | 'completeUpgrade'>;
  events: { contentUpgradeFence(): number | undefined };
  hosted: boolean;
  now: Date;
}): boolean {
  if (!input.store.pendingUpgrade()) return false;
  const cutoff = input.events.contentUpgradeFence();
  if (cutoff === undefined) return false;
  input.store.completeUpgrade(
    input.hosted
      ? { baselineSequence: 0, baselineTime: 0 }
      : { baselineSequence: cutoff, baselineTime: input.now.getTime() },
  );
  return true;
}
