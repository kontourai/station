import {
  useApproveProposedChangeMutation,
  useRejectProposedChangeMutation,
} from '@kontourai/station-sdk';

/**
 * #2064 (D4): the one place a proposed-change decision is made from the UI.
 *
 * Extracted from `ReviewQueueView`, not copied into the inbox. The two
 * surfaces now call the SAME `POST /api/proposed-changes/:id/approve|reject`
 * mutations through one module, so the inbox cannot drift onto a different
 * endpoint, a different payload shape, or a different invalidation — the
 * failure mode a second hand-written pair of `useMutation` calls produces
 * about six months later.
 *
 * The decision payload's `reason` is the only thing that legitimately differs
 * between surfaces, because it records WHERE a human decided. It is built by
 * {@link proposedChangeDecisionReason} from a surface name rather than typed
 * out twice.
 */
export type ProposedChangeDecision = 'approve' | 'reject';

/**
 * The recorded reason for a decision, naming the surface it was taken on.
 * `ProposedChangeDecision.reason` is durable audit text on the change itself,
 * so "Approved from review queue" and "Approved from notifications" have to
 * stay tellable apart — and stay one sentence shape, which is why the surface
 * is a parameter rather than a second literal.
 */
function proposedChangeDecisionReason(
  decision: ProposedChangeDecision,
  surface: string,
): string {
  return `${decision === 'approve' ? 'Approved' : 'Rejected'} from ${surface}`;
}

/**
 * Approve/reject for one proposed change, bound to the surface recording the
 * decision. `pending` is true while either mutation is in flight, so a caller
 * disables both affordances from one flag (what `ReviewQueueView` already
 * did with `approveMutation.isPending || rejectMutation.isPending`).
 */
export function useProposedChangeDecision(surface: string) {
  const approveMutation = useApproveProposedChangeMutation();
  const rejectMutation = useRejectProposedChangeMutation();
  return {
    pending: approveMutation.isPending || rejectMutation.isPending,
    error: approveMutation.error ?? rejectMutation.error,
    decide(id: string, decision: ProposedChangeDecision) {
      const reason = proposedChangeDecisionReason(decision, surface);
      if (decision === 'approve') {
        approveMutation.mutate({ id, decision: { reason } });
      } else {
        rejectMutation.mutate({ id, decision: { reason } });
      }
    },
  };
}
