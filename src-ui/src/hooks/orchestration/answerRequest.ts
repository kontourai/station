import {
  inspectAttentionRequest,
  resolveOrchestrationRequest,
} from '@kontourai/station-sdk';

/** How an answer the server did not refuse ended. */
export type OrchestrationAnswerOutcome = 'answered' | 'already-settled';

/**
 * Answers one orchestration request, the way every approval surface must:
 * resolves only when Station accepted the decision, and REJECTS otherwise, so
 * the surface can say the decision did not land (#2316, #2344).
 *
 * One refusal is not a failure: when the request was ALREADY answered
 * elsewhere, the request itself says so and this resolves `already-settled`.
 * That is read from the request's current state, never guessed from the
 * error text, and only for an answer bound to its prompt event.
 */
export async function answerOrchestrationRequest(
  apiBase: string,
  request: {
    threadId: string;
    requestId: string;
    requestEventId?: string;
    decision: 'accept' | 'acceptForSession' | 'decline';
  },
): Promise<OrchestrationAnswerOutcome> {
  try {
    await resolveOrchestrationRequest({
      apiBase,
      threadId: request.threadId,
      requestId: request.requestId,
      // #2316: answer only the exact prompt the user saw.
      ...(request.requestEventId
        ? { expectedRequestEventId: request.requestEventId }
        : {}),
      decision: request.decision,
    });
    return 'answered';
  } catch (error) {
    if (
      request.requestEventId &&
      (await requestAlreadyResolved(apiBase, {
        threadId: request.threadId,
        requestId: request.requestId,
        requestEventId: request.requestEventId,
      }))
    )
      return 'already-settled';
    throw error;
  }
}

/**
 * Whether a refused answer was refused because the request is already
 * answered. Any doubt (the read fails, the request changed, it is still open)
 * is `false`, so a genuine failure stays loud.
 */
async function requestAlreadyResolved(
  apiBase: string,
  reference: { threadId: string; requestId: string; requestEventId: string },
): Promise<boolean> {
  try {
    const inspected = await inspectAttentionRequest(apiBase, reference);
    return inspected.state === 'resolved';
  } catch {
    return false;
  }
}
