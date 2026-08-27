import type {
  ApprovalAttentionItem,
  AttentionItem,
  SessionFailedAttentionItem,
} from '@kontourai/station-sdk';
import { notificationCategoryLabel } from './notificationLabels';
import { engineLabelForProvider } from './sessionDisplay';
import { NO_FAILURE_DETAIL_RECORDED } from './sessionFailure';

/**
 * Single source of truth for attention-item badge copy. Gate kinds use
 * verdict vocabulary — route-back / gate blocked / exception pending — and
 * must never say "approval": an approval request allows an action, a review
 * decides on output, a gate verdict evaluates evidence (root CONTEXT.md
 * ~624). Shared between AttentionCard and AttentionHistoryItem so the two
 * surfaces can't drift.
 */
export function attentionKindLabel(kind: AttentionItem['kind']): string {
  return notificationCategoryLabel(kind);
}

/**
 * An `approval` item is genuinely still pending exactly when it carries
 * live actions — the agent is waiting on the decision, so dismissal must
 * be the visually-quiet secondary affordance. Whether a session deep link
 * (`openHref`) resolves is orthogonal: ACP tool approvals, for instance,
 * never carry one but are absolutely live (station#750 review finding).
 * Only an action-less item is terminal, where a plain, equally-prominent
 * dismiss is appropriate. Shared between AttentionCard and
 * AttentionHistoryItem so the two surfaces can't drift.
 */
export function isApprovalLivePending(item: ApprovalAttentionItem): boolean {
  return item.actions.length > 0;
}

/**
 * station#3214: the client-side mirror of the ONE predicate that decides what
 * "pending" means — `AttentionProjectionService.list`'s
 * `items.filter((item) => !item.acknowledgedAt)`
 * (`src-server/services/projects/attention-projection.ts:230`), whose result
 * ships as `AttentionProjection.pendingCount` and is what the header bell
 * badge renders.
 *
 * It exists only because a client-side NARROWING produces a subset the server
 * cannot know about, so the subset's pending count has to be recomputed here.
 * Nothing may use it to re-derive the unnarrowed total: that number is read
 * off `pendingCount` (see `useAttentionInbox`), so the page and the badge
 * cannot disagree by construction rather than by two predicates coincidentally
 * agreeing.
 *
 * station#3222 promoted the filter itself to `pendingAttentionItems`: the
 * notification tray renders the pending SUBSET rather than counting it, and a
 * second `!item.acknowledgedAt` spelled in the component is the drift this
 * module exists to prevent.
 */
export function pendingAttentionItems(items: AttentionItem[]): AttentionItem[] {
  return items.filter((item) => !item.acknowledgedAt);
}

/** See `pendingAttentionItems` — the same one predicate, counted. */
export function countPendingAttention(items: AttentionItem[]): number {
  return pendingAttentionItems(items).length;
}

/**
 * station#3214: the parenthesised count beside "Needs attention", and the
 * whole point of this being a function is that the number has to name its own
 * scope.
 *
 * The page used to print the count of the FILTERED list under the same label
 * the bell badge wears for the FULL pending set, so applying any filter made
 * the header contradict the badge the reader had just clicked. Neither number
 * was wrong; the label was, because it did not say which population it meant.
 *
 * So: with nothing narrowed there is one population and one number, which is
 * the badge's own `pendingCount`. With the shown set narrowed there are two,
 * and both are shown as a pair — matching the "Showing X of Y items" summary
 * this page already renders directly above the heading. The pair is rendered
 * whenever the shown set is narrower, including when the two agree: a bare
 * "(3)" that silently means either "3 in total" or "3 in this view" depending
 * on state the reader cannot see is exactly the defect being removed.
 *
 * `narrowed` is deliberately not named `filtered`: station#3222 brought the
 * notification tray onto this helper, and the tray narrows by TRUNCATION (it
 * has room for five rows under a badge that may read nine), not by a filter
 * bar. Both are the same fact — the rows on screen are not the whole pending
 * set — and both must produce the pair, so the parameter names the fact rather
 * than one mechanism that causes it.
 *
 * `null` means render the bare label: nothing narrowed and nothing pending,
 * which is also when the badge itself disappears.
 *
 * `pendingVisible` is deliberately NOT clamped to `pendingTotal`. Within one
 * `/api/attention` response the two are computed from the same array by the
 * same predicate, so a pair reading "(5 of 3)" could only mean the server's
 * definition of pending had drifted from `countPendingAttention`'s — a clamp
 * would hide that behind a plausible number instead of showing it.
 */
export function attentionCountLabel({
  narrowed,
  pendingTotal,
  pendingVisible,
}: {
  narrowed: boolean;
  pendingTotal: number;
  pendingVisible: number;
}): string | null {
  if (narrowed) return `${pendingVisible} of ${pendingTotal}`;
  return pendingTotal > 0 ? `${pendingTotal}` : null;
}

/**
 * What a failed session says when nothing recorded WHY it failed. One
 * constant, imported by the attention surfaces, the session detail pane and
 * the chat dock alike, so the notification and the session it opens cannot
 * describe the same absence with two different sentences.
 *
 * station#3213 moved the declaration to `sessionFailure.ts` and re-exports it
 * here unchanged: the dock's eagerly-loaded composer pane needs the failure
 * fold, and importing it through this module would have hoisted these
 * attention helpers (and `sessionDisplay` behind them) into the entry chunk.
 * The definition stays single; only its home moved to the leaf.
 */
export { NO_FAILURE_DETAIL_RECORDED } from './sessionFailure';

/**
 * station#3203: the cause line for a `session-failed` row. The projection
 * omits `body` entirely when the session recorded no `blockedReason`, and the
 * honest render of that is to SAY so — the reported symptom was a row whose
 * every line read "Session failed", which told the owner nothing and did not
 * even distinguish "no reason was captured" from "the reason is missing here".
 * Never a guess: this only ever returns the recorded reason or the absence.
 */
export function sessionFailureCause(item: SessionFailedAttentionItem): string {
  return item.body ?? NO_FAILURE_DETAIL_RECORDED;
}

/**
 * station#3203: the identity line that makes three failed sessions tellable
 * apart — the engine that ran it and the agent it was assigned to, both read
 * straight off the projection. `engine` arrives as the raw provider id and is
 * labelled HERE, through the same `engineLabelForProvider` every other engine
 * chip uses, falling back to the observed id for a provider this build does
 * not know (that helper's `null` contract).
 *
 * `null` when the projection carried neither, so a row with no recorded
 * engine or agent renders nothing rather than an empty separator asserting
 * structure the data does not have.
 */
export function sessionFailedIdentity(
  item: SessionFailedAttentionItem,
): string | null {
  const parts = [
    item.engine ? (engineLabelForProvider(item.engine) ?? item.engine) : null,
    item.agent ?? null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : null;
}
