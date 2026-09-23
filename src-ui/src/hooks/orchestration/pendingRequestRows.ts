import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { toolRequestFromPayload } from '@kontourai/station-shared/tool-request-preview';
import type { ChatMessage } from '../../types';

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

/**
 * Approval requests in this window that are still open: no `request.resolved`
 * for them, and their session has not ended a turn or exited since they
 * opened (an answer would have nothing left to unblock).
 */
export function openApprovalRequests(
  events: readonly CanonicalRuntimeEvent[],
): RequestOpened[] {
  const open = new Map<string, RequestOpened>();
  const key = (threadId: string, requestId: string) =>
    `${threadId}\u0000${requestId}`;
  for (const event of events) {
    if (event.method === 'request.opened') {
      if (
        event.requestType === 'approval' ||
        event.requestType === 'permission'
      )
        open.set(key(event.threadId, event.requestId), event);
    } else if (event.method === 'request.resolved') {
      open.delete(key(event.threadId, event.requestId));
    } else if (THREAD_TERMINAL_METHODS.has(event.method)) {
      for (const [entry, request] of open) {
        if (request.threadId === event.threadId) open.delete(entry);
      }
    }
  }
  return [...open.values()];
}

/**
 * #2316: an open approval must stay answerable from the chat, even when no
 * visible row carries its card.
 *
 * The card normally sits on the tool call it gates (bound by exact call id in
 * `runtime-event-projection.ts`), and only the LAST assistant row offers its
 * buttons. Some requests have no such row: a Claude subagent's call is kept out
 * of the main transcript, Codex reports no call identity at all, and the open
 * turn's own row can be held by the live streaming shell. Live, the toast
 * answers those; after a reload the toast is gone, the conversation reads as
 * busy (awaiting approval), and nothing on screen could answer.
 *
 * When any open request lacks an answerable card, this appends one row that
 * carries a card for EVERY open request — appending it makes it the last row,
 * so a card that was answerable only because its row was last moves here too.
 * The request is never re-bound to some other same-named call; each card
 * names its own request, thread and event.
 */
export function withPendingRequestRow(
  messages: ChatMessage[],
  events: readonly CanonicalRuntimeEvent[],
): ChatMessage[] {
  const open = openApprovalRequests(events);
  if (open.length === 0) return messages;
  const last = messages.at(-1);
  const answerable = new Set(
    last?.role === 'assistant'
      ? (last.contentParts ?? []).flatMap((part) =>
          part.needsApproval && part.approvalId ? [part.approvalId] : [],
        )
      : [],
  );
  if (open.every((request) => answerable.has(request.requestId)))
    return messages;
  return [
    ...messages,
    {
      id: `pending-requests:${open
        .map((request) => request.eventId)
        .join(',')}`,
      role: 'assistant',
      content: '',
      contentParts: open.map((request) => {
        const { toolName, toolInput } = toolRequestFromPayload(request.payload);
        const toolCallId = request.payload?.toolCallId;
        return {
          type: 'tool-invocation',
          toolCallId:
            typeof toolCallId === 'string'
              ? toolCallId
              : `request:${request.requestId}`,
          // A request with no reported tool keeps its title as the row's
          // display name only, so the grant label never names a command line.
          ...(toolName ? { toolName } : { name: request.title }),
          ...(toolInput !== undefined ? { args: toolInput } : {}),
          state: 'awaiting-approval',
          needsApproval: true,
          approvalId: request.requestId,
          approvalThreadId: request.threadId,
          approvalEventId: request.eventId,
        };
      }),
    },
  ];
}
