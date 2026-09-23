import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { toolRequestFromPayload } from '@kontourai/station-shared/tool-request-preview';
import type { ChatMessage } from '../../types';

/** One card for the pending-approvals strip: the transcript's own part shape. */
export type PendingApprovalRequest = NonNullable<
  ChatMessage['contentParts']
>[number];

type RequestOpened = Extract<
  CanonicalRuntimeEvent,
  { method: 'request.opened' }
>;

/** Events after which an unanswered request on that thread is moot. */
const THREAD_TERMINAL_METHODS = new Set([
  'turn.completed',
  'turn.aborted',
  'session.exited',
]);

const NO_REQUESTS: PendingApprovalRequest[] = [];

const requestKey = (threadId: string, requestId: string) =>
  `${threadId}\u0000${requestId}`;

/**
 * Approval requests in this window that are still open: no `request.resolved`
 * for them, and their session has not ended a turn or exited since they
 * opened (an answer would have nothing left to unblock). Keyed by thread AND
 * request id: a conversation window folds every session in its lineage.
 */
export function openApprovalRequests(
  events: readonly CanonicalRuntimeEvent[],
): RequestOpened[] {
  const open = new Map<string, RequestOpened>();
  for (const event of events) {
    if (event.method === 'request.opened') {
      if (
        event.requestType === 'approval' ||
        event.requestType === 'permission'
      )
        open.set(requestKey(event.threadId, event.requestId), event);
    } else if (event.method === 'request.resolved') {
      open.delete(requestKey(event.threadId, event.requestId));
    } else if (THREAD_TERMINAL_METHODS.has(event.method)) {
      for (const [entry, request] of open) {
        if (request.threadId === event.threadId) open.delete(entry);
      }
    }
  }
  return [...open.values()];
}

/**
 * #2316: open approval requests that no rendered transcript row can answer.
 *
 * A request's card normally sits on the tool call it gates (bound by exact
 * call id in `runtime-event-projection.ts`) and answers from there. Some
 * requests have no such row: a Claude subagent's call is kept out of the main
 * transcript, Codex reports no call identity at all, and the open turn's own
 * row can be held by the live streaming shell. Live, the toast answers those;
 * after a reload the toast is gone and the conversation reads as busy
 * (awaiting approval) with nothing on screen to answer it.
 *
 * Returns one card per such request for the pending-approvals strip — never a
 * transcript message, and never re-bound onto another same-named call. Each
 * card names its own request, thread and event.
 */
export function unansweredApprovalRequests(
  messages: readonly ChatMessage[],
  events: readonly CanonicalRuntimeEvent[],
): PendingApprovalRequest[] {
  const open = openApprovalRequests(events);
  if (open.length === 0) return NO_REQUESTS;
  const bound = new Set<string>();
  for (const message of messages) {
    for (const part of message.contentParts ?? []) {
      if (part.needsApproval && part.approvalId && part.approvalThreadId)
        bound.add(requestKey(part.approvalThreadId, part.approvalId));
    }
  }
  const unanswered = open.filter(
    (request) => !bound.has(requestKey(request.threadId, request.requestId)),
  );
  if (unanswered.length === 0) return NO_REQUESTS;
  return unanswered.map((request) => {
    const { toolName, toolInput } = toolRequestFromPayload(request.payload);
    const toolCallId = request.payload?.toolCallId;
    return {
      type: 'tool-invocation',
      toolCallId:
        typeof toolCallId === 'string'
          ? toolCallId
          : `request:${request.requestId}`,
      // A request with no reported tool keeps its title as the display name
      // only, so the grant label never names a command line.
      ...(toolName ? { toolName } : { name: request.title }),
      ...(toolInput !== undefined ? { args: toolInput } : {}),
      state: 'awaiting-approval',
      needsApproval: true,
      approvalId: request.requestId,
      approvalThreadId: request.threadId,
      approvalEventId: request.eventId,
    };
  });
}
