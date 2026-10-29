import {
  inspectAttentionRequest,
  resolveOrchestrationRequest,
} from '@kontourai/station-sdk';
import {
  ChatHttpError,
  StationRequestTimeoutError,
} from '@kontourai/station-sdk/client';
import { bumpContentRefresh } from './contentRefresh';

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
  phase: 'sending' | 'sent' | 'unconfirmed' | 'already-settled';
  decision: 'accept' | 'acceptForSession' | 'decline';
  sessionGrantScope?: 'server';
  error?: Error;
}
/**
 * docs/design/event-content-spill.md: the digest an approval surface
 * computed after loading every reference of a request whose content was
 * stored out of line, by (thread, request event). An allow decision for
 * such a request carries it; the server refuses one without it, so a
 * surface that never loaded the content cannot allow it.
 */
const viewedContentDigests = new Map<string, string>();
const contentKey = (threadId: string, requestEventId: string) =>
  JSON.stringify([threadId, requestEventId]);
export function recordViewedContentDigest(
  threadId: string,
  requestEventId: string,
  digest: string,
) {
  if (viewedContentDigests.size >= 256)
    viewedContentDigests.delete(viewedContentDigests.keys().next().value!);
  viewedContentDigests.set(contentKey(threadId, requestEventId), digest);
}
function viewedContentDigestFor(request: {
  threadId: string;
  requestEventId?: string;
  decision: 'accept' | 'acceptForSession' | 'decline';
}): string | undefined {
  if (request.decision === 'decline' || !request.requestEventId)
    return undefined;
  return viewedContentDigests.get(
    contentKey(request.threadId, request.requestEventId),
  );
}

// See `contentRefresh.ts`: the 409 marker the card and the toast read.
export {
  contentRefreshVersion,
  subscribeContentRefresh,
} from './contentRefresh';
/** Test seam: what a 409 `request_content_not_loaded` triggers. */
export function requestContentRefreshForTest(
  threadId: string,
  requestEventId: string,
) {
  requestContentRefresh(threadId, requestEventId);
}

function requestContentRefresh(threadId: string, requestEventId: string) {
  viewedContentDigests.delete(contentKey(threadId, requestEventId));
  bumpContentRefresh(threadId, requestEventId);
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
        ...(current.state.sessionGrantScope
          ? { sessionGrantScope: current.state.sessionGrantScope }
          : {}),
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
    sessionGrantScope?: 'server';
  },
): Promise<OrchestrationAnswerOutcome> {
  const key = answerKey(apiBase, request);
  const pending = pendingAnswers.get(key);
  const scope =
    request.decision === 'acceptForSession'
      ? request.sessionGrantScope
      : undefined;
  if (pending?.state.phase === 'already-settled')
    return Promise.resolve('already-settled');
  if (pending)
    return pending.state.phase === 'unconfirmed' ||
      (pending.state.decision === request.decision &&
        pending.state.sessionGrantScope === scope)
      ? pending.result
      : Promise.reject(
          new Error('A decision for this request is still being sent.'),
        );
  if (pendingAnswers.size >= 256) {
    for (const [settledKey, entry] of pendingAnswers) {
      // Confirmed receipts may age out; uncertain decisions must stay locked.
      if (
        entry.state.phase !== 'already-settled' &&
        entry.state.phase !== 'sent'
      )
        continue;
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
    state: {
      phase: 'sending',
      decision: request.decision,
      ...(scope ? { sessionGrantScope: scope } : {}),
    },
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
      const current = pendingAnswers.get(key);
      if (current?.result === result && outcome === 'answered') {
        current.state = { ...current.state, phase: 'sent' };
        notifyAnswers();
      }
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
    /** With `acceptForSession`: widen the grant to the Station browser server. */
    sessionGrantScope?: 'server';
  },
): Promise<OrchestrationAnswerOutcome> {
  const viewedContentDigest = viewedContentDigestFor(request);
  try {
    await resolveOrchestrationRequest({
      apiBase,
      ...(viewedContentDigest ? { viewedContentDigest } : {}),
      threadId: request.threadId,
      requestId: request.requestId,
      // #2316: answer only the exact prompt the user saw.
      ...(request.requestEventId
        ? { expectedRequestEventId: request.requestEventId }
        : {}),
      decision: request.decision,
      ...(request.sessionGrantScope
        ? { sessionGrantScope: request.sessionGrantScope }
        : {}),
      timeoutMs: 15_000,
    });
    return 'answered';
  } catch (error) {
    // The server's binding holds content this card has not loaded (a bound
    // call that arrived later, or one this surface cannot see): reload it
    // and let the person allow again. The decision itself was refused.
    if (
      request.requestEventId &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'request_content_not_loaded'
    ) {
      requestContentRefresh(request.threadId, request.requestEventId);
      throw new Error(
        'Station is loading more of this request. Review it, then allow it again.',
      );
    }
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
