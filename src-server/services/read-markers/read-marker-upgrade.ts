import type { FileReadMarkerStore } from './read-marker-store.js';

/**
 * #3075 owner design: begins read state once, at the migration cutoff.
 * Before server-kept unread there was no unread, so everything up to the
 * event store's cutoff (`contentUpgradeFence`, immutable, written before the
 * migration's first batch) reads as seen, but only for the established
 * principals: each person key that already had an acknowledgement record or
 * a first-format marker. Everyone else, including a person first seen later,
 * starts without it, and everything appended after the cutoff reads unread
 * until rendered. Nothing is inferred from provider timestamps: a false
 * unread is acceptable, a false read is not.
 *
 * Runs for a first-format store and for a home with none at all. Returns
 * whether it ran. Without a cutoff (the migration has not completed) nothing
 * begins, and nobody has a baseline: everything reads unread.
 */
export function upgradeReadMarkerStore(input: {
  store: Pick<FileReadMarkerStore, 'pendingUpgrade' | 'completeUpgrade'>;
  acknowledgements: { principals(): readonly string[] };
  events: { contentUpgradeFence(): number | undefined };
  now: Date;
}): boolean {
  if (!input.store.pendingUpgrade()) return false;
  const cutoff = input.events.contentUpgradeFence();
  if (cutoff === undefined) return false;
  input.store.completeUpgrade({
    baselineSequence: cutoff,
    baselineTime: input.now.getTime(),
    establishedPrincipals: input.acknowledgements.principals(),
  });
  return true;
}
