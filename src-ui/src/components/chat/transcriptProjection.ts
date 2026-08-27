import type { ChatMessage } from '../../types';

export type TranscriptRowKind =
  | 'message:user'
  | 'message:assistant'
  | 'message:system';

export interface TranscriptMessageRow {
  readonly id: string;
  readonly kind: TranscriptRowKind;
  readonly message: ChatMessage;
  readonly index: number;
}

export type TranscriptRow = TranscriptMessageRow;

function messageIdentity(sessionId: string, message: ChatMessage): string {
  const explicitId = (message as ChatMessage & { id?: unknown }).id;
  if (typeof explicitId === 'string' && explicitId.length > 0) {
    return `${sessionId}:message:${explicitId}`;
  }
  if (message.traceId) return `${sessionId}:trace:${message.traceId}`;
  if (message.turnId)
    return `${sessionId}:turn:${message.turnId}:${message.role}`;
  // Server rows normally carry an id, trace id, or turn id. Keep the final
  // key content-derived rather than position-derived so prepending cannot
  // remount an already-rendered persisted row.
  return `${sessionId}:message:${message.timestamp ?? 'untimed'}:${message.role}:${message.content}`;
}

function sameMessage(left: ChatMessage, right: ChatMessage): boolean {
  return (
    left.role === right.role &&
    left.content === right.content &&
    left.model === right.model &&
    left.modelOptions === right.modelOptions &&
    left.ephemeral === right.ephemeral &&
    left.showContinue === right.showContinue &&
    left.timestamp === right.timestamp &&
    left.traceId === right.traceId &&
    left.fromPrompt === right.fromPrompt &&
    sameParts(left.contentParts, right.contentParts) &&
    left.attachments === right.attachments &&
    left.toolCalls === right.toolCalls &&
    left.turnId === right.turnId &&
    left.sessionId === right.sessionId &&
    left.agentSlug === right.agentSlug &&
    left.provenance === right.provenance
  );
}

function sameParts(
  left: ChatMessage['contentParts'],
  right: ChatMessage['contentParts'],
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.length === right.length &&
      left.every((part, index) => part === right[index]))
  );
}

/**
 * The transcript is a presentation projection over Station's canonical
 * messages. It never writes events; unchanged rows retain their previous
 * object identity so a live delta only invalidates the affected row.
 *
 * Work activities are NOT projected into separate fold/work rows any more
 * (the pre-#2652-redesign "Show N work activities" disclosure): a message's
 * `contentParts` array is ordered — text, reasoning, and tool parts appear
 * in the order the runtime events occurred, on the live path
 * (`streamHandlers.ts`), the durable projection
 * (`runtime-event-projection.ts`, which flushes buffered text before pushing
 * a tool part), and the SDK refresh path (`mapConversationMessages`). The
 * message renderer (`MessageContent`) preserves that derived reading order,
 * so hoisting work parts out of the message here would discard an ordering
 * the data actually carries.
 */
export function projectTranscriptMessages(
  sessionId: string,
  messages: readonly ChatMessage[],
  previous: readonly TranscriptRow[] = [],
): readonly TranscriptRow[] {
  const previousById = new Map(previous.map((row) => [row.id, row]));
  let changed = false;
  const projected: TranscriptRow[] = [];
  messages.forEach((message, index) => {
    const id = messageIdentity(sessionId, message);
    const kind = `message:${message.role}` as TranscriptRowKind;
    const prior = previousById.get(id);
    if (
      prior &&
      prior.kind === kind &&
      prior.index === index &&
      sameMessage(prior.message, message)
    ) {
      projected.push(prior);
      return;
    }
    changed = true;
    projected.push({ id, kind, message, index });
  });
  return !changed && projected.length === previous.length
    ? previous
    : projected;
}
