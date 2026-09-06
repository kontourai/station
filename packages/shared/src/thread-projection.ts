/**
 * Projection from Station's canonical conversation shape to the portable
 * @kontourai/thread schema (station#1999 S1).
 *
 * Works on the FOLDED state (`ConversationMessage[]` — the one shape every
 * engine family produces: internal runtime, ACP bridge, native-SDK event
 * projection), so Station-engine (VoltAgent/Strands), Claude Code, Codex,
 * and ACP-connected sessions all export through this single function.
 *
 * Fidelity notes (deliberate):
 * - `metadata.provenance` envelopes are not carried into the thread (they
 *   are Station-internal receipts, re-derivable from the event stream);
 *   `turnId` is carried in message metadata so a thread row can still be
 *   correlated back.
 * - The exported model is the runtime-REPORTED model when present, else the
 *   requested one — reported is an observation, requested is an intent.
 * - `tool-invocation` parts embed call and result in one part; the thread
 *   schema pairs them as an assistant `tool_call` plus a following tool
 *   message, preserving `toolCallId` linkage.
 */

import {
  createStationAnswerBinding,
  type StationAnswerBinding,
} from '@kontourai/station-contracts/task-basis';
import {
  type AssistantContent,
  type ContentPart,
  type Message,
  THREAD_SCHEMA_VERSION,
  type Thread,
  type ToolResult,
} from '@kontourai/thread';
import type { ConversationMessage } from './conversation-message';

export interface ConversationThreadOptions {
  /** Thread id — use the conversation/session id. */
  threadId: string;
  title?: string;
  cwd?: string;
  /** Station version writing the export, recorded as sourceVersion. */
  sourceVersion?: string;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * The one explicit export mapping used by both Thread export and Basis: an
 * observed Station assistant message keeps its Session/turn tuple and the
 * exact message id that `conversationToThread()` exports. Legacy rows without
 * an observed turn id deliberately remain unidentified.
 */
export function conversationAssistantMessageToStationAnswerBinding(
  message: ConversationMessage,
  threadId: string,
): StationAnswerBinding | null {
  if (
    message.role !== 'assistant' ||
    !message.id ||
    !message.metadata?.turnId ||
    !threadId
  )
    return null;
  return createStationAnswerBinding({
    sessionId: threadId,
    turnId: message.metadata.turnId,
    messageId: message.id,
  });
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// `arguments`/`parsedArguments` on the thread's ToolCall, computed together
// from one `typeof` dispatch rather than two functions independently
// re-deriving the same input's shape — they describe the SAME value and
// must never disagree about it.
//
// `arguments` carries "the raw argument string exactly as the source
// emitted it" (@kontourai/thread's own docblock) — a value that is already a
// string passes through unchanged, never re-encoded into a JSON string
// literal of itself.
//
// `parsedArguments` is "present when the source provided — or the importer
// could recover — a structured form" (same docblock). An object args value
// already has one; a string args value gets one recovered by parsing it as
// JSON, since several sources (ACP's `rawInput`, `ToolStartedEvent.arguments`)
// hand back JSON text rather than a parsed object. A string that isn't JSON,
// or whose parse isn't a plain record — including an array: `asPlainRecord`
// excludes arrays from BOTH an object args value and a parsed string one —
// has no structured form: `undefined`.
//
// station#3542 fix round (independent review finding 7): a side effect worth
// recording because it's easy to miss. Pre-fix, `arguments` was always
// `JSON.stringify`'d even when `args` was already a string, so
// `JSON.parse(arguments)` on the OUTPUT always yielded the original string
// straight back — a consumer parsing `arguments` itself could never tell "the
// source sent something that isn't JSON" apart from "the source sent JSON
// that isn't a plain record" (both looked identical: a re-parseable string).
// Post-fix, `arguments` is the source's raw string, so parsing IT directly now
// makes that distinction — better than the issue asked for.
function toolCallArgs(args: unknown): {
  arguments: string;
  parsedArguments: Record<string, unknown> | undefined;
} {
  const direct = asPlainRecord(args);
  if (direct) {
    return { arguments: JSON.stringify(args), parsedArguments: direct };
  }
  if (typeof args === 'string') {
    let parsedArguments: Record<string, unknown> | undefined;
    try {
      parsedArguments = asPlainRecord(JSON.parse(args));
    } catch {
      parsedArguments = undefined;
    }
    return { arguments: args, parsedArguments };
  }
  return {
    arguments: JSON.stringify(args ?? {}),
    parsedArguments: undefined,
  };
}

function toolResultContent(result: unknown): ContentPart[] {
  const text =
    typeof result === 'string' ? result : (JSON.stringify(result) ?? undefined);
  return typeof text === 'string' && text.length > 0
    ? [{ type: 'text', text }]
    : [];
}

export function conversationToThread(
  messages: ConversationMessage[],
  options: ConversationThreadOptions,
): Thread {
  const threadId = options.threadId;
  const out: Message[] = [];
  let syntheticId = 0;
  const usedIds = new Set(messages.map((message) => message.id));
  const nextId = (): string => {
    let id: string;
    do {
      id = `${threadId}:${++syntheticId}`;
    } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };
  const emittedId = (id: string): string => {
    const resolved = id || nextId();
    usedIds.add(resolved);
    return resolved;
  };
  const knownToolNames = new Map<string, string>();
  const timestampFor = (message: ConversationMessage): number => {
    const stamp = message.metadata?.timestamp;
    if (typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0) {
      return Math.round(stamp);
    }
    return (
      out[out.length - 1]?.timestamp ??
      options.createdAt ??
      // Last resort for a conversation with no timestamps anywhere: the
      // export moment, better than an invalid thread.
      Date.now()
    );
  };

  for (const message of messages) {
    const timestamp = timestampFor(message);
    const messageMetadata =
      message.metadata?.turnId !== undefined
        ? { turnId: message.metadata.turnId }
        : undefined;

    if (message.role === 'user' || message.role === 'system') {
      const content: ContentPart[] = [];
      for (const part of message.parts) {
        if (
          part.type === 'text' &&
          typeof part.text === 'string' &&
          part.text.length > 0
        ) {
          content.push({ type: 'text', text: part.text });
        } else if (part.type === 'file') {
          content.push({
            type: 'file',
            name: part.name ?? 'attachment',
            mediaType: part.mediaType ?? 'application/octet-stream',
            data: part.url ?? '',
          });
        }
        // Unknown part types on user/system messages are skipped.
      }
      if (content.length === 0) continue;
      out.push({
        id: emittedId(message.id),
        threadId,
        role: message.role,
        timestamp,
        content,
        ...(messageMetadata ? { metadata: messageMetadata } : {}),
      });
      continue;
    }

    // Assistant: fold text/reasoning/tool calls; tool-invocation results
    // become a paired tool message so exporters can replay the exchange.
    const content: AssistantContent[] = [];
    const toolResults: ToolResult[] = [];
    for (const part of message.parts) {
      if (
        part.type === 'text' &&
        typeof part.text === 'string' &&
        part.text.length > 0
      ) {
        content.push({ type: 'text', text: part.text });
      } else if (
        part.type === 'reasoning' &&
        typeof part.text === 'string' &&
        part.text.length > 0
      ) {
        content.push({
          type: 'reasoning',
          reasoning: { type: 'reasoning', text: part.text },
        });
      } else if (part.type === 'tool-invocation') {
        const nested = part.toolInvocation;
        const callId = part.toolCallId ?? nested?.toolCallId ?? nextId();
        const name = part.toolName ?? nested?.toolName ?? 'unknown';
        const args = part.args ?? nested?.args;
        const state = part.state ?? nested?.state;
        const result = part.result ?? nested?.result;
        const isError = part.isError ?? nested?.isError;
        knownToolNames.set(callId, name);
        content.push({
          type: 'tool_call',
          toolCall: {
            id: callId,
            name,
            ...toolCallArgs(args),
          },
        });
        const failed = isError === true || state === 'error';
        // station#1558 (fix round, M5): an unresolved call carries a
        // `result` — the sentence saying no result was reported — so it
        // reached this push and exported as an ordinary tool result with no
        // marker at all, i.e. as a success whose output happened to be that
        // sentence. Thread's own vocabulary already names this case, so say
        // it: `unknown` is neither `success` nor `error`, and it is what
        // `thread-tool-result-adapter.ts` maps the same status to on the
        // other export path. Every other state keeps today's shape.
        const unresolved = state === 'unresolved';
        // Thread refuses `terminalStatus` without the owner-issued result id
        // it identifies ("resultId and terminalStatus must be supplied
        // together"). Every unresolved row Station writes carries the
        // terminal event's id, so the pair is available in practice.
        const resultId =
          typeof part.sourceEventId === 'string' &&
          part.sourceEventId.length > 0
            ? part.sourceEventId
            : undefined;
        if (unresolved) {
          // Without an id the status cannot be stated, and a bare result
          // reads as a success. Export the call with NO result instead —
          // "no result was reported" is precisely what happened, and an
          // absence cannot be mistaken for an outcome.
          if (resultId) {
            toolResults.push({
              toolCallId: callId,
              name,
              content: toolResultContent(result),
              resultId,
              terminalStatus: 'unknown',
            });
          }
        } else if (result !== undefined || failed) {
          toolResults.push({
            toolCallId: callId,
            name,
            content: toolResultContent(result),
            ...(failed ? { isError: true } : {}),
          });
        }
      } else if (part.type === 'tool-result') {
        const callId = part.toolCallId ?? nextId();
        toolResults.push({
          toolCallId: callId,
          name: knownToolNames.get(callId) ?? '',
          content: toolResultContent(part.result),
        });
      }
      // Unknown assistant part types are skipped.
    }
    if (content.length === 0 && toolResults.length === 0) continue;

    const reported = message.metadata?.reportedModel;
    const requested = message.metadata?.model;
    const model =
      typeof reported === 'string' && reported.length > 0
        ? reported
        : typeof requested === 'string' && requested.length > 0
          ? requested
          : undefined;

    if (content.length > 0) {
      out.push({
        id: emittedId(message.id),
        threadId,
        role: 'assistant',
        timestamp,
        content,
        model,
        ...(messageMetadata ? { metadata: messageMetadata } : {}),
      });
    }
    if (toolResults.length > 0) {
      out.push({
        id: nextId(),
        threadId,
        role: 'tool',
        timestamp,
        toolResults,
      });
    }
  }

  const fallbackNow = Date.now();
  return {
    schemaVersion: THREAD_SCHEMA_VERSION,
    id: threadId,
    messages: out,
    metadata: {
      source: 'station',
      ...(options.sourceVersion
        ? { sourceVersion: options.sourceVersion }
        : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    },
    createdAt: options.createdAt ?? out[0]?.timestamp ?? fallbackNow,
    updatedAt:
      options.updatedAt ?? out[out.length - 1]?.timestamp ?? fallbackNow,
  };
}
