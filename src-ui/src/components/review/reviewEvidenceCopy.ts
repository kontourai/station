import type { ReviewEvidenceUnavailableReason } from '@kontourai/station-contracts/review-evidence';

/**
 * The operator remedy differs by reason, so the copy names it per project.
 * Extracted from `ReviewQueueView` (#2064 D4) because the project's Coding
 * layout now renders the same per-project unavailability: a project Station
 * could not read must not render as a project with no receipts, and the two
 * surfaces must not describe one root cause two ways.
 *
 * A `Record` over the reason union rather than a lookup with a fallback: a
 * new reason is a type error here until it has its own copy, instead of
 * silently rendering under the wrong remedy.
 */
export const REVIEW_UNAVAILABLE_REASON_COPY: Record<
  ReviewEvidenceUnavailableReason,
  string
> = {
  // Deliberately not "locked by another Station process": the read only knows
  // the lock was held past its wait, which a slow index repair produces as
  // readily as a second process, and sending the operator to hunt a process
  // that may not exist is worse than naming what was observed.
  'lock-unavailable': 'contended — another Station process or a long repair',
  'workspace-unreadable': 'workspace path unreadable',
  'receipts-unreadable': 'receipts unreadable',
};
