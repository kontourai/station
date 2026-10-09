import {
  inspectAttentionRequest,
  resolveOrchestrationRequest,
} from '@kontourai/station-sdk';
import { StationRequestTimeoutError } from '@kontourai/station-sdk/client';

class ApprovalDeliveryUnconfirmedError extends Error {
  readonly code = 'approval_delivery_unconfirmed';
}

/** How an answer the server did not refuse ended. */
export type OrchestrationAnswerOutcome = 'answered' | 'already-settled';
const pendingAnswers = new Map<
  string,
  {
    decision: string;
    threadId: string;
    requestId: string;
    unconfirmed?: boolean;
    result: Promise<OrchestrationAnswerOutcome>;
  }
>();
const answerKey = (
  apiBase: string,
  request: { threadId: string; requestId: string; requestEventId?: string },
) =>
  JSON.stringify([
    apiBase,
    request.threadId,
    request.requestId,
    request.requestEventId,
  ]);

export function forgetApprovalAnswer(threadId: string, requestId: string) {
  for (const [key, value] of pendingAnswers)
    if (value.threadId === threadId && value.requestId === requestId)
      pendingAnswers.delete(key);
}

export async function inspectApprovalAnswer(
  apiBase: string,
  reference: { threadId: string; requestId: string; requestEventId: string },
): Promise<'pending' | 'already-settled'> {
  const inspection = await inspectAttentionRequest(apiBase, reference, {
    timeoutMs: 5_000,
  });
  if (
    inspection.state === 'resolved' ||
    (inspection.state === 'open' && inspection.canRespond)
  ) {
    pendingAnswers.delete(answerKey(apiBase, reference));
    return inspection.state === 'resolved' ? 'already-settled' : 'pending';
  }
  throw new ApprovalDeliveryUnconfirmedError(
    'Station has not confirmed whether this decision was received.',
  );
}

/**
 * Answers one orchestration request, the way every approval surface must:
 * resolves only when Station accepted the decision. Refusals and uncertain
 * delivery reject with distinct outcomes so the surface cannot claim a
 * lost response was a refusal (#2316, #2344).
 *
 * One refusal is not a failure: when the request is no longer open
 * (answered elsewhere, closed by the engine, cancelled, or expired), the
 * request itself says so and this resolves `already-settled`.
 * That is read from the request's current state, never guessed from the
 * error text, and only for an answer bound to its prompt event.
 */
export function answerOrchestrationRequest(
  apiBase: string,
  request: {
    threadId: string;
    requestId: string;
    requestEventId?: string;
    decision: 'accept' | 'acceptForSession' | 'decline';
  },
): Promise<OrchestrationAnswerOutcome> {
  const key = answerKey(apiBase, request);
  const pending = pendingAnswers.get(key);
  if (pending)
    return pending.unconfirmed || pending.decision === request.decision
      ? pending.result
      : Promise.reject(
          new Error('A decision for this request is still being sent.'),
        );
  if (pendingAnswers.size >= 256)
    return Promise.reject(
      new Error(
        'Reconnect and check the existing decisions before sending more approvals.',
      ),
    );
  const result = sendAnswer(apiBase, request);
  pendingAnswers.set(key, {
    decision: request.decision,
    threadId: request.threadId,
    requestId: request.requestId,
    result,
  });
  const release = () => {
    if (pendingAnswers.get(key)?.result === result) pendingAnswers.delete(key);
  };
  void result.then(release, (error: unknown) => {
    if (error instanceof ApprovalDeliveryUnconfirmedError) {
      const current = pendingAnswers.get(key);
      if (current?.result === result) current.unconfirmed = true;
    } else release();
  });
  return result;
}

async function sendAnswer(
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
      timeoutMs: 15_000,
    });
    return 'answered';
  } catch (error) {
    let inspected: 'pending' | 'already-settled' | undefined;
    if (request.requestEventId) {
      try {
        inspected = await inspectApprovalAnswer(apiBase, {
          threadId: request.threadId,
          requestId: request.requestId,
          requestEventId: request.requestEventId,
        });
      } catch {
        /* Observation failure cannot settle or replay the decision. */
      }
    }
    if (inspected === 'already-settled') return inspected;
    const code =
      error instanceof Error && 'code' in error ? error.code : undefined;
    if (
      !inspected &&
      ((error instanceof StationRequestTimeoutError &&
        error.mutation !== false) ||
        error instanceof TypeError ||
        error instanceof SyntaxError ||
        (error instanceof Error &&
          'status' in error &&
          typeof error.status === 'number' &&
          error.status >= 500) ||
        ['transport_timeout', 'transport_reset', 'transport'].includes(
          String(code),
        ))
    )
      throw new ApprovalDeliveryUnconfirmedError(
        'Station may have received this decision. Check its status before trying again.',
        { cause: error },
      );
    throw error;
  }
}
