import {
  foldedSessionLifecycleState,
  isSessionLifecycleStateStopped,
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
      reason:
        'Station is still reading the current Session lifecycle. Wait before replacing the engine context.',
    };
  }
  if (input.sessionRead === 'error') {
    return {
      kind: 'blocked',
      reason:
        'Station could not read the current Session lifecycle. Reconnect before replacing the engine context.',
    };
  }
  if (input.sessionRead === 'absent' || !input.orchestrationSession) {
    return {
      kind: 'blocked',
      reason:
        'Station has no current Session record to stop. Send or restore the conversation before replacing the engine context.',
    };
  }
  if (input.session.stopPending) {
    return {
      kind: 'blocked',
      reason:
        'Station is waiting for the current turn to stop. No context boundary has been reserved.',
    };
  }
  if (
    input.orchestrationSession.hasActiveTurn ||
    isSessionExecutionActive(input.session)
  ) {
    return {
      kind: 'blocked',
      reason:
        'The current turn or approval is still active. Stop or finish it before replacing the engine context.',
    };
  }
  if (input.hasLocalDeferredMessages) {
    return {
      kind: 'blocked',
      reason:
        'Resolve queued or offline messages before replacing the engine context.',
    };
  }
  if (
    isSessionLifecycleStateStopped(
      foldedSessionLifecycleState(input.orchestrationSession.lifecycleState),
    )
  ) {
    return { kind: 'reserve' };
  }
  return {
    kind: 'stop-session',
    reason:
      'The current Session is ready but still open. Stop it before reserving the next engine context.',
  };
}
