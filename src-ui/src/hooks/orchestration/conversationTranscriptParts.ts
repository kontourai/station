import type { OrchestrationSequencedEvent } from '@kontourai/station-contracts/orchestration';
import type { MessagePart } from '@kontourai/station-shared/conversation-message';
import type { ChatMessage } from '../../types';
import { extractUIBlocks } from '../../utils/uiBlocks';
import { upsertToolResultBlocks } from './messageParts';

type ContentPart = NonNullable<ChatMessage['contentParts']>[number];

/**
 * The ONE mapping from a projected conversation part to the content part the
 * message renderers (`MessageContent`, `MessageBubble`) read. The chat dock
 * used to own it inline; the Activity session detail rendered the same
 * projection with a hand-picked subset of these fields, so a runtime error's
 * code (translation), a file's blobRef/name, a cancelled or approval-bound
 * call all rendered differently in the two places for one event.
 */
export function conversationPartToContentParts(
  part: MessagePart,
): ContentPart[] {
  const mapped = {
    type: part.type,
    content: part.text,
    url: part.url,
    blobRef: part.blobRef,
    mediaType: part.mediaType,
    name: part.name,
    toolCallId: part.toolCallId,
    sourceEventId: part.sourceEventId,
    toolName: part.toolName,
    ...(part.toolKind !== undefined ? { toolKind: part.toolKind } : {}),
    args: part.args,
    result: part.result,
    output: part.output,
    error: part.error,
    cancelled: part.cancelled,
    state: part.state,
    isError: part.isError,
    progressMessage: part.progressMessage,
    runtimeError: part.runtimeError,
    runtimeErrorCode: part.runtimeErrorCode,
    needsApproval: part.needsApproval,
    approvalId: part.approvalId,
    approvalThreadId: part.approvalThreadId,
    approvalEventId: part.approvalEventId,
    ...(part.approvalToolName !== undefined
      ? { approvalToolName: part.approvalToolName }
      : {}),
    approvalSessionGrant: part.approvalSessionGrant,
    approvalServerGrant: part.approvalServerGrant,
    approvalStatus: part.approvalStatus,
    ...(part.inputRequestRecord
      ? { inputRequestRecord: { ...part.inputRequestRecord } }
      : {}),
  } as ContentPart;
  // Preserve the same tool-result identity and sanitized blocks as the live
  // renderer when a completed turn enters durable replay.
  return part.type === 'tool-invocation' &&
    part.sourceEventId &&
    part.toolCallId
    ? (upsertToolResultBlocks(
        [mapped],
        part.toolCallId,
        part.sourceEventId,
        extractUIBlocks(part.output),
      ) as ContentPart[])
    : [mapped];
}

/**
 * A durable window read plus the live frames past its watermark, in server
 * sequence order: the chat dock's stitching, shared with the session detail.
 * Live frames come from the document-wide sequenced store, which keeps every
 * frame of an open turn (bounded per Station, with a truncation watermark the
 * caller answers by re-reading the window) instead of a per-view cap.
 */
export function stitchWindowWithLiveEvents(input: {
  windowEvents: readonly OrchestrationSequencedEvent[];
  watermark: number | undefined;
  liveEvents: readonly OrchestrationSequencedEvent[];
  threadIds: ReadonlySet<string | undefined>;
}): OrchestrationSequencedEvent[] {
  const watermark =
    input.watermark ??
    Math.max(0, ...input.windowEvents.map((item) => item.sequence));
  const events = [...input.windowEvents];
  const persistedIds = new Set(
    input.windowEvents.map((item) => item.event.eventId).filter(Boolean),
  );
  for (const item of input.liveEvents) {
    if (item.sequence <= watermark || !input.threadIds.has(item.event.threadId))
      continue;
    if (persistedIds.has(item.event.eventId)) continue;
    events.push(item);
  }
  return events.sort((left, right) => left.sequence - right.sequence);
}
