/**
 * Notification categories the agent-activity card already raises its own
 * alert for: an approval or input entry (`approval-request`) and a finished,
 * stopped or failed turn. A per-notification alert channel on a phone that
 * gets the card (Live Activity on iOS, the card on Android) skips these, so
 * one event is not announced twice.
 *
 * One list for both platforms: the Android FCM alert channel (#2588) is to
 * read the same constant. The exclusion is unconditional — it does not look
 * at whether the phone's card is actually on — so on a phone with the card
 * turned off (or, on iOS, Live Activities disabled) these categories raise
 * no alert at all; the inbox still has them.
 */
export const CARD_ALERTED_CATEGORIES: ReadonlySet<string> = new Set([
  'approval-request',
  'turn-completed',
  'turn-stopped',
  'turn-failed',
]);
