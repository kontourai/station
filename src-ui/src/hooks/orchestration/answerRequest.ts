import {
  inspectAttentionRequest,
  resolveOrchestrationRequest,
} from '@kontourai/station-sdk';
import {
  ChatHttpError,
  StationRequestTimeoutError,
} from '@kontourai/station-sdk/client';

class ApprovalDeliveryUnconfirmedError extends Error {
  readonly code = 'approval_delivery_unconfirmed';
}

/** How an answer the server did not refuse ended. */
export type OrchestrationAnswerOutcome = 'answered' | 'already-settled';
export interface ApprovalAnswerReference {
  apiBase: string;
  threadId: string;
  requestId: string;
  requestEventId?: string;
}
interface ApprovalAnswerState {
  phase: 'sending' | 'unconfirmed' | 'already-settled';
  decision: 'accept' | 'acceptForSession' | 'decline';
  error?: Error;
}
const answerListeners = new Set<() => void>();
export function subscribeApprovalAnswers(listener: () => void) {
  answerListeners.add(listener);
  return () => {
    answerListeners.delete(listener);
  };
}
const notifyAnswers = () => {
  for (const listener of answerListeners) listener();
};
const pendingAnswers = new Map<
  string,
  {
    state: ApprovalAnswerState;
    threadId: string;
    requestId: string;
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

export function readApprovalAnswerState(
  reference: ApprovalAnswerReference,
): ApprovalAnswerState | null {
  return (
    pendingAnswers.get(answerKey(reference.apiBase, reference))?.state ?? null
  );
}

export function forgetApprovalAnswer(threadId: string, requestId: string) {
  for (const [key, value] of pendingAnswers)
    if (value.threadId === threadId && value.requestId === requestId)
      pendingAnswers.delete(key);
  notifyAnswers();
}

export async function inspectApprovalAnswer(
  apiBase: string,
  reference: { threadId: string; requestId: string; requestEventId: string },
): Promise<'pending' | 'already-settled'> {
  const inspection = await inspectAttentionRequest(apiBase, reference, {
    timeoutMs: 5_000,
  });
  const key = answerKey(apiBase, reference);
  if (inspection.state === 'resolved') {
    const current = pendingAnswers.get(key);
    if (current) {
      current.state = {
        phase: 'already-settled',
        decision: current.state.decision,
      };
      notifyAnswers();
    }
    return 'already-settled';
  }
  if (inspection.state === 'open' && inspection.canRespond) {
    pendingAnswers.delete(key);
    notifyAnswers();
    return 'pending';
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
  if (pending?.state.phase === 'already-settled')
    return Promise.resolve('already-settled');
  if (pending)
    return pending.state.phase === 'unconfirmed' ||
      pending.state.decision === request.decision
      ? pending.result
      : Promise.reject(
          new Error('A decision for this request is still being sent.'),
        );
  if (pendingAnswers.size >= 256) {
    for (const [settledKey, entry] of pendingAnswers) {
      if (entry.state.phase !== 'already-settled') continue;
      pendingAnswers.delete(settledKey);
      if (pendingAnswers.size < 256) break;
    }
    notifyAnswers();
  }
  if (pendingAnswers.size >= 256)
    return Promise.reject(
      new Error(
        'Reconnect and check the existing decisions before sending more approvals.',
      ),
    );
  const result = sendAnswer(apiBase, request);
  pendingAnswers.set(key, {
    state: { phase: 'sending', decision: request.decision },
    threadId: request.threadId,
    requestId: request.requestId,
    result,
  });
  notifyAnswers();
  const release = () => {
    if (pendingAnswers.get(key)?.result === result) {
      pendingAnswers.delete(key);
      notifyAnswers();
    }
  };
  void result.then(
    (outcome) => {
      if (outcome !== 'already-settled') release();
    },
    (error: unknown) => {
      if (error instanceof ApprovalDeliveryUnconfirmedError) {
        const current = pendingAnswers.get(key);
        if (current?.result === result) {
          current.state = { ...current.state, phase: 'unconfirmed', error };
          notifyAnswers();
        }
      } else release();
    },
  );
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
        (error instanceof ChatHttpError && !error.stationEnvelope) ||
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
