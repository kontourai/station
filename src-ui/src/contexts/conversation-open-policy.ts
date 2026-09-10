import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';

interface ConversationOpenPolicyState {
  conversationOpenPending?: boolean;
  conversationOpenFailed?: boolean;
  conversationOpenState?: ConversationOpenResolution;
}

/**
 * What is known about this conversation's continuation right now.
 *
 * `resolving` is a DON'T-KNOW-YET, not a verdict, and it is the state every
 * reloaded deep link starts in — `hydrateActiveChats` seeds
 * `conversationOpenPending` for every persisted chat that has a conversation
 * id. Folding it into the same boolean as `read-only` is what made an ordinary
 * reload paint a red "is read-only" alert for the seconds before the point-read
 * landed, alongside the empty "Start a conversation" placeholder and a second
 * red line under the composer: three contradictory claims about a healthy
 * conversation (#1582 E3/B6).
 *
 * `busy` is an authorized active-turn wait and still blocks writes.
 * `read-only` is the verdict: the read failed, or it resolved to
 * `missing-session`/`unavailable`, or denied continuation without an active-turn wait. Only that earns error
 * chrome.
 */
type ConversationOpenPhase =
  | 'resolving'
  | 'busy'
  | 'writable'
  | 'read-only';

export function conversationOpenPhase(
  state: ConversationOpenPolicyState,
): ConversationOpenPhase {
  // Pending is read FIRST and on its own. A resolution left over from a prior
  // read is not an answer about the read now in flight.
  if (state.conversationOpenPending) return 'resolving';
  if (state.conversationOpenFailed) return 'read-only';
  const resolution = state.conversationOpenState;
  if (
    resolution?.status === 'resolved' &&
    !resolution.canContinue &&
    resolution.continuationPending
  )
    return 'busy';
  return resolution === undefined ||
    (resolution.status === 'resolved' && resolution.canContinue)
    ? 'writable'
    : 'read-only';
}

/**
 * The one synchronous gate shared by mutation, composer, inventory, and Basis.
 *
 * Unchanged in meaning: a conversation still in flight is not writable either.
 * What changed is that callers who want to SAY something about the state read
 * the phase instead, so "we do not know yet" stops rendering as "we know it is
 * broken".
 */
export function conversationCanMutate(
  state: ConversationOpenPolicyState,
): boolean {
  return conversationOpenPhase(state) === 'writable';
}
