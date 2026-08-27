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
 * order (station#3690) is what makes the live array's order load-bearing.
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
  const index = next.findIndex(
    (part) =>
      part.type === 'tool-invocation' &&
      part.toolCallId === toolCallId &&
      (part.sourceEventId === undefined ||
        part.sourceEventId === resultEventId),
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
