/**
 * The words this page uses for its two dismissal mechanisms, decided once
 * (archive#3779).
 *
 * The issue reported that a row's own Dismiss DELETES the notification while
 * the bulk action merely acknowledges — "one hides a fact and one destroys a
 * record". Measured against the server, that premise does not hold, and the
 * measurement is what this file exists to record so the next reader does not
 * re-derive it from the HTTP verb:
 *
 *   - Bulk: `POST /api/attention/:id/ack` → `AttentionProjectionService
 *.acknowledge`. The attention ITEM is a projection; acknowledging it
 *     drops it out of `pendingCount` and it resurfaces on its own when the
 *     underlying fact changes again (a session that fails a second time
 *     carries a newer `updatedAt` and reads unacknowledged).
 *   - Row: `DELETE /notifications/:id` → `NotificationService.dismiss`, which
 *     sets `status = 'dismissed'` and keeps the record
 *     (`notification-service.ts`). Nothing is destroyed: the row stays in
 *     Activity, minus its action. Verified live — the DELETE answers 200 and
 *     the row is still on the page and still in `GET /notifications`.
 *
 * So BOTH are dismissals, and one word for both is not the lie the issue
 * describes. What genuinely differs is the SUBJECT (a derived attention item
 * vs a stored notification) and terminality: a notification dismissal is
 * recorded as "a real, terminal user decision" — `schedule` refuses to
 * re-raise a dismissed notification for the same dedupe tag, and the source
 * provider is told via `handleDismiss`. An attention acknowledgement makes no
 * such claim.
 *
 * Renaming the row action "Delete", and confirming it with "the record is
 * removed and cannot be brought back", was tried here and reverted: it is a
 * state word nothing derives, about a record that is still there — the exact
 * defect class this sweep exists to remove. Choosing a second verb for
 * "terminal dismissal of a notification" is a product vocabulary decision, not
 * one to invent under a false premise; the corrected issue carries the
 * evidence.
 *
 * What survives is the part that was always right: the label is read from here
 * rather than written beside each mutation, so if the vocabulary does change
 * it changes in one place instead of five.
 */
export type NotificationRowMechanism =
  | 'acknowledge-attention'
  | 'dismiss-notification';

export interface NotificationRowAction {
  mechanism: NotificationRowMechanism;
  /** The word the user reads. Never chosen at the call site. */
  label: string;
  /**
   * Whether the action destroys a record. FALSE for both today — see the
   * module doc. A `true` here would have to point at a store that forgets.
   */
  destroys: boolean;
  /**
   * Whether the same fact can surface again by itself. An attention item can
   * (the projection re-derives it); a dismissed notification cannot be
   * re-raised for its dedupe tag.
   */
  reversibleByFact: boolean;
}

/** Hides an attention fact. It resurfaces if the fact recurs. */
export const ACKNOWLEDGE_ATTENTION_ACTION: NotificationRowAction = {
  mechanism: 'acknowledge-attention',
  label: 'Dismiss',
  destroys: false,
  reversibleByFact: true,
};

/** Marks the stored notification dismissed. Terminal for its dedupe tag. */
export const DISMISS_NOTIFICATION_ACTION: NotificationRowAction = {
  mechanism: 'dismiss-notification',
  label: 'Dismiss',
  destroys: false,
  reversibleByFact: false,
};
