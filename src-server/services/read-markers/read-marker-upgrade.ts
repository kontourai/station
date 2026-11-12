import {
  FileConversationAcknowledgementStore,
  type IsOwnerDevice,
} from '../orchestration/conversation-acknowledgement-store.js';
import { FileReadMarkerStore } from './read-marker-store.js';

/** A source file past this is refused, and the snapshot frozen missing. */
export const READ_MARKER_MIGRATION_SOURCE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * #3075: the people who had a read record when the content migration
 * begins: each acknowledgement-store key and each person a first-format
 * marker store names. First-format acknowledgement keys are canonicalized
 * with `isOwnerDevice`, the runtime's owner-device rule, so an owner device's
 * record names the person the runtime resolves it to. The event store reads
 * this once, while it writes the cutoff, and freezes it; it is never
 * sampled again. A source past
 * {@link READ_MARKER_MIGRATION_SOURCE_MAX_BYTES} throws.
 */
export function readMarkerMigrationRecipients(
  homeDir: string,
  isOwnerDevice: IsOwnerDevice,
): string[] {
  const options = { maxReadBytes: READ_MARKER_MIGRATION_SOURCE_MAX_BYTES };
  return [
    ...new Set([
      ...new FileConversationAcknowledgementStore(
        homeDir,
        isOwnerDevice,
        options,
      ).principals(),
      ...new FileReadMarkerStore(homeDir, options).legacyRecipients(),
    ]),
  ].sort();
}

/**
 * #3075 owner design: begins read state once, at the migration cutoff.
 * Before server-kept unread there was no unread, so everything up to the
 * event store's cutoff (`contentUpgradeFence`, immutable, written before the
 * migration's first batch) reads as seen, but only for the recipients frozen
 * with that cutoff (`contentMigrationRecipients`). Anyone else, including a
 * person whose first record came after the cutoff, starts without it, and
 * everything appended after the cutoff reads unread until rendered. A
 * missing or unreadable snapshot gives the baseline to nobody. Nothing is
 * inferred from provider timestamps: a false unread is acceptable, a false
 * read is not.
 *
 * Runs for a first-format store and for a home with none at all. Returns
 * whether it ran. Without a cutoff (the migration has not completed) nothing
 * begins, and nobody has a baseline: everything reads unread.
 */
export function upgradeReadMarkerStore(input: {
  store: Pick<FileReadMarkerStore, 'pendingUpgrade' | 'completeUpgrade'>;
  events: {
    contentUpgradeFence(): number | undefined;
    contentMigrationRecipients(): readonly string[] | undefined;
  };
  now: Date;
}): boolean {
  if (!input.store.pendingUpgrade()) return false;
  const cutoff = input.events.contentUpgradeFence();
  if (cutoff === undefined) return false;
  input.store.completeUpgrade({
    baselineSequence: cutoff,
    baselineTime: input.now.getTime(),
    establishedPrincipals: input.events.contentMigrationRecipients() ?? [],
  });
  return true;
}
