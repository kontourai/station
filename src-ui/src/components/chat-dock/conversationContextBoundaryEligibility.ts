import {
  foldedSessionLifecycleState,
  isSessionLifecycleStateAtRest,
} from '@kontourai/station-contracts/session-lifecycle';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import type { ChatSession } from '../../types';
import { isSessionExecutionActive } from '../../utils/execution';

/** What the dock can honestly offer before it submits a context boundary. */
export type ConversationContextBoundaryEligibility =
  | { kind: 'reserve' }
  | { kind: 'stop-session'; reason: string }
  | { kind: 'blocked'; reason: string };

/**
 * Mirrors the server's stopped-session/no-active-turn reservation precondition
 * from the dock's authoritative session read. Unknown is deliberately gated;
 * treating it as ready would recreate the server-side surprise this protects.
 */
export function conversationContextBoundaryEligibility(input: {
  session: ChatSession;
  sessionRead: 'pending' | 'error' | 'present' | 'absent';
  orchestrationSession: OrchestrationSessionSummary | null;
  hasLocalDeferredMessages: boolean;
}): ConversationContextBoundaryEligibility {
  if (input.sessionRead === 'pending') {
    return {
      kind: 'blocked',
      reason: "Checking the agent's status…",
    };
  }
  if (input.sessionRead === 'error') {
    return {
      kind: 'blocked',
      reason: "Couldn't read the agent's status. Reconnect and try again.",
    };
  }
  if (input.sessionRead === 'absent' || !input.orchestrationSession) {
    return {
      kind: 'blocked',
      reason: 'Send a message first.',
    };
  }
  if (input.session.stopPending) {
    return {
      kind: 'blocked',
      reason: 'Waiting for the agent to stop.',
    };
  }
  if (
    input.orchestrationSession.hasActiveTurn ||
    isSessionExecutionActive(input.session)
  ) {
    return {
      kind: 'blocked',
      reason: 'Stop or finish the current turn first.',
    };
  }
  if (input.hasLocalDeferredMessages) {
    return {
      kind: 'blocked',
      reason: 'Send or discard queued messages first.',
    };
  }
  if (
    isSessionLifecycleStateAtRest(
      foldedSessionLifecycleState(input.orchestrationSession.lifecycleState),
    )
  ) {
    return { kind: 'reserve' };
  }
  return {
    kind: 'stop-session',
    reason: 'Stop the agent first.',
  };
}
