import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';

export interface ConversationOpenPolicyState {
  conversationOpenPending?: boolean;
  conversationOpenFailed?: boolean;
  conversationOpenState?: ConversationOpenResolution;
}

/** The one synchronous gate shared by composer, inventory, Basis, and actions. */
export function conversationCanMutate(
  state: ConversationOpenPolicyState,
): boolean {
  if (state.conversationOpenPending || state.conversationOpenFailed)
    return false;
  const resolution = state.conversationOpenState;
  return (
    resolution === undefined ||
    (resolution.status === 'resolved' && resolution.canContinue)
  );
}
