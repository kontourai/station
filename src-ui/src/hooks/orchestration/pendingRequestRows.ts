import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { readHarnessQuestionnaire } from '@kontourai/station-shared/harness-questions';
import { readMcpElicitationForm } from '@kontourai/station-shared/mcp-elicitation-form';
import {
  approvalRetiredBy,
  isSubagentApprovalRequest,
} from '@kontourai/station-shared/runtime-event-projection';
import {
  toolRequestFromPayload,
  toolRequestServerGrantFromPayload,
  toolRequestSessionGrantFromPayload,
} from '@kontourai/station-shared/tool-request-preview';
import type { ChatMessage } from '../../types';

/** One card for the pending-approvals strip: the transcript's own part shape. */
export type PendingApprovalRequest = NonNullable<
  ChatMessage['contentParts']
>[number];

type RequestOpened = Extract<
  CanonicalRuntimeEvent,
  { method: 'request.opened' }
>;

const NO_REQUESTS: PendingApprovalRequest[] = [];

const requestKey = (threadId: string, requestId: string) =>
  `${threadId}\u0000${requestId}`;

/**
 * Approval requests in this window that are still open: no `request.resolved`
 * for them, and nothing since has retired them (`approvalRetiredBy`: a session
 * exit, or — for a main-thread request — the end of its turn). This is the
 * same rule the projection uses to retire a bound card. Keyed by thread AND
 * request id: a conversation window folds every session in its lineage.
 */
function openApprovalRequests(
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
    } else {
      for (const [entry, request] of open) {
        if (
          request.threadId === event.threadId &&
          !(request.blocking === false && event.method === 'turn.completed') &&
          approvalRetiredBy(
            event.method,
            isSubagentApprovalRequest(request.payload),
          )
        )
          open.delete(entry);
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
  /**
   * station#2530 review 3: the OPEN turn's own row, when the live streaming
   * shell renders it. F4 stitching can make that row PRESENT in `messages`
   * before the turn settles while the shell (whose parts carry no request
   * binding, so nothing to click) is still what is on screen.
   * Bound-detection ignores a binding on this turn, and the strip stays the
   * answering surface for it.
   *
   * Pass it ONLY while the shell renders the open turn. Once the transcript
   * window projects the turn instead (`suppressStreamingRow`), the projected
   * row carries the binding and renders Allow/Deny itself — a solo row
   * directly, a batch through its always-visible pending-grant rows — and
   * excluding it here rendered the same request as a second actionable card.
   */
  openTurnId?: string,
): PendingApprovalRequest[] {
  const open = openApprovalRequests(events);
  if (open.length === 0) return NO_REQUESTS;
  const bound = new Set<string>();
  for (const message of messages) {
    if (openTurnId !== undefined && message.turnId === openTurnId) continue;
    for (const part of message.contentParts ?? []) {
      if (part.needsApproval && part.approvalId && part.approvalThreadId)
        bound.add(requestKey(part.approvalThreadId, part.approvalId));
    }
  }
  const unanswered = open.flatMap((request) => {
    const questionnaire = readHarnessQuestionnaire(
      request.payload?.questionnaire,
    );
    const mcpElicitation = readMcpElicitationForm(
      request.payload?.mcpElicitation,
    );
    if (
      !questionnaire &&
      !mcpElicitation &&
      bound.has(requestKey(request.threadId, request.requestId))
    )
      return [];
    const { toolName, toolInput } = toolRequestFromPayload(request.payload);
    const toolCallId = request.payload?.toolCallId;
    return [
      {
        type: 'tool-invocation',
        toolCallId:
          typeof toolCallId === 'string'
            ? toolCallId
            : `request:${request.requestId}`,
        // A request with no reported tool keeps its title as the display name
        // only, so the grant label never names a command line.
        ...(toolName ? { toolName } : { name: request.title }),
        ...(toolName ? { approvalToolName: toolName } : {}),
        ...(typeof request.payload?.toolKind === 'string'
          ? { toolKind: request.payload.toolKind }
          : {}),
        ...(toolInput !== undefined ? { args: toolInput } : {}),
        state: 'awaiting-approval',
        needsApproval: true,
        approvalId: request.requestId,
        ...(questionnaire ? { questionnaire } : {}),
        ...(mcpElicitation ? { mcpElicitation } : {}),
        approvalThreadId: request.threadId,
        approvalEventId: request.eventId,
        approvalSessionGrant: toolRequestSessionGrantFromPayload(
          request.payload,
        ),
        approvalServerGrant: toolRequestServerGrantFromPayload(request.payload),
      },
    ];
  });
  return unanswered.length === 0 ? NO_REQUESTS : unanswered;
}
