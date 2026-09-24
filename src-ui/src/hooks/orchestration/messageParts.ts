import type { UIBlock } from '@kontourai/station-contracts/ui-block';
import type { ChatContentPart } from '../../contexts/active-chats-state';

type OrchestrationContentPart = ChatContentPart;

export type OrchestrationStreamingMessage = {
  role: 'assistant';
  content: string;
  contentParts?: OrchestrationContentPart[];
};

export function createAssistantStreamingMessage(): OrchestrationStreamingMessage {
  return {
    role: 'assistant',
    content: '',
    contentParts: [],
  };
}

/**
 * Appends `delta` to the TAIL part when the tail is already this type, and
 * starts a new segment otherwise.
 *
 * It used to append to the FIRST part of the type, wherever it sat. That reads
 * as an optimisation — one text part per turn — but it silently reorders the
 * turn as soon as a tool call interleaves: text "Before", tool started, text
 * "After" produced `[text("BeforeAfter"), tool]`, so narration written after
 * the activity rendered before it. Durable replay (`runtime-event-projection`)
 * flushes text before inserting the tool and reconstructs
 * `[text("Before"), tool, text("After")]` — so the SAME turn changed reading
 * order on reload, and only the live path was wrong.
 *
 * That divergence was invisible while the transcript hoisted every work part
 * into a separate fold above the answer; rendering activity inline in reading
 * order (archive#3690) is what makes the live array's order load-bearing.
 *
 * Every consumer already filters-and-joins these parts rather than reading a
 * single one (`buildAssistantTurnContent`, `ChatDockBody`,
 * `useActiveChatTranscript`, `planArtifacts`), so segmenting costs them
 * nothing.
 */
export function upsertTextPart(
  parts: Array<OrchestrationContentPart> | undefined,
  type: 'text' | 'reasoning',
  delta: string,
) {
  const next = [...(parts || [])];
  const tail = next.length - 1;
  if (tail >= 0 && next[tail].type === type) {
    next[tail] = {
      ...next[tail],
      content: `${next[tail].content || ''}${delta}`,
    };
    return next;
  }
  next.push({ type, content: delta });
  return next;
}

/**
 * Which existing row an update for `toolCallId` may write into.
 *
 * A row with no `sourceEventId` is still open and is this call's slot. A row
 * pinned to THIS terminal is the same fact arriving twice. A row pinned to a
 * DIFFERENT terminal is a distinct durable result and is left alone — the
 * rule `runtime-event-projection.ts` applies on the durable side, so the two
 * folds agree about what one call id may mean twice.
 *
 * station#1569 (H1) carves out the single exception: `unresolved` is not an
 * outcome, it is the admission that none arrived, and one still can — the
 * stop grace can elapse while the engine is holding the real `tool_result`,
 * which then drains and is published for the same call
 * (`claude-adapter-events.ts`'s `settledToolCalls`). Without this the reader
 * got two rows for one call, "no result was reported" beside the result, and
 * the batch header counted the stale one.
 *
 * Only a TERMINAL may supersede it — `resultEventId` is present only on that
 * path (`handleToolCompletedEvent` is the one caller that pins a row). A
 * `tool.started`/`tool.progress` for a reused call id must never erase a
 * settled outcome, which is why this is not simply "match any unresolved
 * row".
 */
export function toolPartSettleableBy(
  part: OrchestrationContentPart,
  toolCallId: string,
  resultEventId: string | undefined,
): boolean {
  if (part.type !== 'tool-invocation' || part.toolCallId !== toolCallId) {
    return false;
  }
  if (
    part.sourceEventId === undefined ||
    part.sourceEventId === resultEventId
  ) {
    return true;
  }
  return resultEventId !== undefined && part.state === 'unresolved';
}

export function upsertToolPart(
  parts: Array<OrchestrationContentPart> | undefined,
  toolCallId: string,
  updates: Record<string, unknown>,
) {
  const next = [...(parts || [])];
  const resultEventId =
    typeof updates.sourceEventId === 'string'
      ? updates.sourceEventId
      : undefined;
  const index = next.findIndex((part) =>
    toolPartSettleableBy(part, toolCallId, resultEventId),
  );
  if (index >= 0) {
    next[index] = {
      ...next[index],
      type: 'tool-invocation',
      toolCallId,
      ...updates,
    };
    return next;
  }
  next.push({
    type: 'tool-invocation',
    toolCallId,
    toolName: String(updates.toolName || updates.name || toolCallId),
    args: updates.args || {},
    ...updates,
  });
  return next;
}

export function upsertToolResultBlocks(
  parts: Array<OrchestrationContentPart> | undefined,
  toolCallId: string,
  sourceEventId: string,
  blocks: UIBlock[],
) {
  const next = [...(parts || [])].filter(
    (part) =>
      !(part.type === 'ui-block' && part.sourceEventId === sourceEventId),
  );

  if (blocks.length === 0) {
    return next;
  }

  const toolIndex = next.findIndex(
    (part) =>
      part.type === 'tool-invocation' && part.sourceEventId === sourceEventId,
  );
  const blockParts = blocks.map(
    (block, index): OrchestrationContentPart => ({
      type: 'ui-block',
      toolCallId,
      sourceEventId,
      uiBlock: {
        ...block,
        id: block.id || `${sourceEventId}-block-${index}`,
      },
    }),
  );

  if (toolIndex === -1) {
    next.push(...blockParts);
    return next;
  }

  next.splice(toolIndex + 1, 0, ...blockParts);
  return next;
}

/**
 * The images a tool returned, placed directly after the row that shows the
 * call — the live twin of `runtime-event-projection.ts`'s `placeToolImages`,
 * so a turn reads the same before and after it settles. Keyed by the terminal
 * event, so a repeated terminal replaces rather than doubles them.
 *
 * Each part carries only the descriptor and the blob reference the server
 * stored: EventStore strips the bytes before the event reaches SSE, and
 * `FilePartPreview` fetches them through the authenticated attachment route —
 * which is what makes the image viewable from a remote device.
 */
export function upsertToolResultFiles(
  parts: Array<OrchestrationContentPart> | undefined,
  toolCallId: string,
  sourceEventId: string,
  attachments: ReadonlyArray<{
    name: string;
    mimeType: string;
    blobRef?: string;
    dataUrl?: string;
  }>,
) {
  const next = [...(parts || [])].filter(
    (part) => !(part.type === 'file' && part.sourceEventId === sourceEventId),
  );
  if (attachments.length === 0) return next;
  const fileParts = attachments.map(
    (attachment): OrchestrationContentPart => ({
      type: 'file',
      ...(attachment.dataUrl === undefined ? {} : { url: attachment.dataUrl }),
      ...(attachment.blobRef === undefined
        ? {}
        : { blobRef: attachment.blobRef }),
      mediaType: attachment.mimeType,
      name: attachment.name,
      toolCallId,
      sourceEventId,
    }),
  );
  const toolIndex = next.findIndex(
    (part) =>
      part.type === 'tool-invocation' && part.sourceEventId === sourceEventId,
  );
  if (toolIndex === -1) {
    next.push(...fileParts);
    return next;
  }
  next.splice(toolIndex + 1, 0, ...fileParts);
  return next;
}

export function buildAssistantTurnContent(
  streamingMessage: OrchestrationStreamingMessage | undefined,
  fallbackText?: string,
) {
  return (
    streamingMessage?.content ||
    streamingMessage?.contentParts
      ?.filter((part) => part.type === 'text' || part.type === 'reasoning')
      .map((part) => part.content || '')
      .join('\n') ||
    fallbackText ||
    ''
  );
}
