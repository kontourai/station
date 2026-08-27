import { readWithStallWatchdog } from '@kontourai/station-contracts/stall-watchdog';
import type { UIBlock } from '@kontourai/station-contracts/ui-block';
import { ChatHttpError } from '../client/chatHttpError';
import { resolveApiBase } from '../query-core';
import type {
  ChatAttachmentInput,
  ConversationMessage,
  ConversationMessagePart,
} from './chatRuntimeTypes';
import { extractUIBlocks, resanitizeUIBlockProvenance } from './uiBlocks';

// Keep the established streaming-module export stable for existing consumers.
export { ChatHttpError } from '../client/chatHttpError';

async function buildChatHttpError(response: Response): Promise<ChatHttpError> {
  try {
    const body = (await response.json()) as {
      error?: unknown;
      code?: unknown;
    } | null;
    const serverMessage =
      body && typeof body.error === 'string' && body.error.length > 0
        ? body.error
        : undefined;
    const code =
      body && typeof body.code === 'string' && body.code.length > 0
        ? body.code
        : undefined;
    return new ChatHttpError(response.status, serverMessage, code);
  } catch {
    // Body isn't JSON (or is empty) — fall back to a generic status message
    // rather than failing to construct an error at all.
    return new ChatHttpError(response.status);
  }
}

type MessageApiPart = {
  type: string;
  text?: string;
  content?: string;
  url?: string;
  mediaType?: string;
  name?: string;
  server?: string;
  toolName?: string;
  originalName?: string;
  toolCallId?: string;
  output?: unknown;
  uiBlock?: unknown;
};

type MessageApiShape = {
  role: 'user' | 'assistant';
  parts?: MessageApiPart[];
  metadata?: {
    timestamp?: string;
    traceId?: string;
    /**
     * station#1410: deliberately typed `unknown` on the wire. The client
     * has no guarantee the server that produced this row shares its
     * envelope version, so the value is carried through unvalidated and
     * only interpreted behind `isSupportedTurnProvenanceEnvelope` at the
     * render boundary (#1410 AC5).
     */
    turnId?: string;
    sessionId?: string;
    sourceEventId?: string;
    answerEligible?: boolean;
    provenance?: unknown;
  };
  timestamp?: string;
};

export type {
  ChatAttachmentInput,
  ConversationMessage,
  ConversationMessagePart,
} from './chatRuntimeTypes';

export function mapConversationMessages(
  messages: MessageApiShape[],
  toolMappings: Record<
    string,
    { server?: string; toolName?: string; originalName?: string }
  > = {},
): ConversationMessage[] {
  return messages.map((message) => {
    const textContent =
      message.parts
        ?.map((part) => part.text || part.content)
        .filter(Boolean)
        .join('\n') || '';

    const contentParts = message.parts
      ?.flatMap((part): ConversationMessagePart[] => {
        if (part.type === 'text') {
          return [{ type: 'text', content: part.text }];
        }
        if (part.type === 'reasoning') {
          return [{ type: 'reasoning', content: part.text }];
        }
        if (part.type === 'file') {
          const typeName = part.mediaType?.split('/')[0] || 'File';
          return [
            {
              type: 'file',
              url: part.url,
              mediaType: part.mediaType,
              name:
                part.name ||
                `${typeName.charAt(0).toUpperCase() + typeName.slice(1)}`,
            },
          ];
        }
        // Pass through ui-block parts that were persisted directly — but
        // NEVER their provenance verbatim (station#1399 fix round, M4):
        // this branch's store (unlike the `tool-*` branch below, whose
        // output flows through the server-side `sanitizeUIBlockEventProvenance`
        // seam) has no equivalent host-sanitizing seam, so re-derive the
        // mirror-only provenance state here rather than trust whatever was
        // stored.
        if (part.type === 'ui-block' && part.uiBlock) {
          return [
            {
              type: 'ui-block',
              toolCallId: part.toolCallId,
              uiBlock: resanitizeUIBlockProvenance(part.uiBlock as UIBlock),
            },
          ];
        }
        if (part.type?.startsWith('tool-')) {
          const toolName = part.type.replace('tool-', '');
          const mapping = toolMappings[toolName] || {};
          const toolPart = {
            ...part,
            server: part.server || mapping.server,
            toolName: part.toolName || mapping.toolName || toolName,
            originalName: part.originalName || mapping.originalName,
            // The tool-result part's own `uiBlock` (inherited from spreading
            // `part`, whose field is `unknown` on the wire) is never the
            // real UI block — that is reconstructed separately below as its
            // own `blockParts` entries, ALREADY sanitized/mirrored by
            // `extractUIBlocks`. Dropping it here avoids an untyped/
            // untrusted value riding along under a field this part type
            // never actually renders.
            uiBlock: undefined,
          };
          // Reconstruct structured ui-block parts from the tool output using
          // the SAME extractor the streaming handlers use, so a persisted
          // render_component form/card/table renders on reload (not just live).
          const blockParts = extractUIBlocks(part.output).map((block) => ({
            type: 'ui-block',
            toolCallId: part.toolCallId,
            uiBlock: block,
          }));
          return [toolPart, ...blockParts];
        }
        return [];
      })
      .filter(Boolean) as ConversationMessagePart[] | undefined;

    return {
      role: message.role,
      content: textContent,
      contentParts: contentParts?.length ? contentParts : undefined,
      timestamp: message.metadata?.timestamp || message.timestamp,
      traceId: message.metadata?.traceId,
      turnId: message.metadata?.turnId,
      sessionId: message.metadata?.sessionId,
      sourceEventId: message.metadata?.sourceEventId,
      answerEligible: message.metadata?.answerEligible,
      provenance: message.metadata?.provenance,
    };
  });
}

export function buildConversationTurnInput(
  content: string,
  attachments?: ChatAttachmentInput[],
) {
  if (!attachments || attachments.length === 0) {
    return content;
  }

  const parts: Array<{
    type: string;
    text?: string;
    url?: string;
    mediaType?: string;
  }> = [];

  if (content) {
    parts.push({ type: 'text', text: content });
  }

  for (const attachment of attachments) {
    parts.push({
      type: 'file',
      url: attachment.data,
      mediaType: attachment.type,
    });
  }

  return [
    {
      id: `msg-${Date.now()}`,
      role: 'user',
      parts,
    },
  ];
}

export function buildConversationTurnPayload(input: {
  conversationId?: string;
  content: string;
  title?: string;
  model?: string;
  attachments?: ChatAttachmentInput[];
  projectSlug?: string;
  chatOptions?: Record<string, unknown>;
  /**
   * Ambient, model-facing context (timezone, geolocation, …) delivered
   * out-of-band (#685). The server composes it into the model input only;
   * the persisted user turn stays `content`.
   */
  ambientContext?: string;
}) {
  return {
    input: buildConversationTurnInput(input.content, input.attachments),
    ...(input.ambientContext ? { ambientContext: input.ambientContext } : {}),
    options: {
      ...(input.chatOptions ?? {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.model ? { model: input.model } : {}),
    },
    ...(input.projectSlug ? { projectSlug: input.projectSlug } : {}),
  };
}

function buildAbortAwareHeaders(signal?: AbortSignal) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (
    signal &&
    '_userInitiated' in signal &&
    (signal as AbortSignal & { _userInitiated?: boolean })._userInitiated
  ) {
    headers['X-Abort-Reason'] = 'user-cancel';
  }

  return headers;
}

/**
 * station#1207: how long a chat stream may go completely silent — no bytes
 * at all from the reader, not just no *parsed* SSE event — before it is
 * treated as a stalled turn instead of a slow-but-alive one. A server that
 * crashes mid-turn or a connection that drops with no error event never
 * throws on its own: `reader.read()` just never resolves, and the caller
 * sits in "Working…" forever. Reset on every `reader.read()` resolution
 * (a superset of "a parsed event arrived" — bytes must arrive before any
 * event can be parsed from them), so a genuinely long-running turn is
 * never falsely interrupted.
 *
 * Byte arrival alone is NOT enough, though — review round 1 caught this:
 * the Vercel AI SDK's own `fullStream` emits a `tool-call` chunk and then
 * NOTHING until `tool-result`, so a `delegateTask` sub-agent or a slow
 * MCP/shell tool legitimately produces zero output for well over a minute.
 * `/chat`'s SSE response now emits a periodic keepalive comment
 * (`SSE_KEEPALIVE_INTERVAL_MS`, `stream-orchestrator.ts`, server-side) — a
 * bare `:ping\n\n` line, ignored below by the exact same
 * `!line.startsWith('data: ')` guard that already skips any non-event
 * line, so it resets this watchdog (proving "still alive") without ever
 * reaching `onStreamEvent`. This timeout must stay comfortably larger than
 * that interval — at least 2-3 missed keepalives' worth of margin against
 * jitter — so "keepalives flowing, no content" reads as alive and only
 * "keepalives themselves stopped" reads as a genuine stall.
 */
export const CHAT_STREAM_STALL_TIMEOUT_MS = 45_000;

/**
 * Thrown when the stream has gone silent for `CHAT_STREAM_STALL_TIMEOUT_MS`.
 * Deliberately never thrown for a user/client abort (see the `aborted` /
 * `input.signal?.aborted` checks below) — those still resolve to `{}` the
 * same as before this change — so this can only mean the transport died
 * quietly with the turn still in flight. Callers translate this into a
 * clear "connection stalled" message with Retry instead of leaving the turn
 * spinning forever (`translateChatError`'s stall pattern).
 */
export class ChatStreamStallError extends Error {
  constructor(timeoutMs: number) {
    super(
      `The connection to Station stalled — no response for ${Math.round(
        timeoutMs / 1000,
      )}s.`,
    );
    this.name = 'ChatStreamStallError';
  }
}

export async function streamConversationTurn(input: {
  agentSlug: string;
  conversationId?: string;
  content: string;
  title?: string;
  onStreamEvent: (data: any, state: any) => any;
  onConversationStarted?: (conversationId: string, title?: string) => void;
  signal?: AbortSignal;
  model?: string;
  attachments?: ChatAttachmentInput[];
  projectSlug?: string;
  chatOptions?: Record<string, unknown>;
  /** Ambient, model-facing context delivered out-of-band (#685). */
  ambientContext?: string;
  apiBase?: string;
}): Promise<{ conversationId?: string; finishReason?: string }> {
  const payload = buildConversationTurnPayload(input);
  const headers = buildAbortAwareHeaders(input.signal);
  const resolvedApiBase = await resolveApiBase(input.apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/agents/${input.agentSlug}/chat`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: input.signal,
    },
  );

  if (!response.ok) {
    throw await buildChatHttpError(response);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  let aborted = false;
  const abortHandler = async () => {
    aborted = true;
    try {
      await reader.cancel();
    } catch {}
  };
  input.signal?.addEventListener('abort', abortHandler);

  const decoder = new TextDecoder();
  let buffer = '';
  let state = {
    currentTextChunk: '',
    contentParts: [],
    pendingApprovals: new Map(),
    reasoningChunks: [],
  };
  let conversationId = input.conversationId;
  let finishReason: string | undefined;

  try {
    while (true) {
      if (aborted || input.signal?.aborted) {
        break;
      }

      const { done, value } = await readWithStallWatchdog(
        reader,
        CHAT_STREAM_STALL_TIMEOUT_MS,
        (ms) => new ChatStreamStallError(ms),
      );
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data: ')) {
          continue;
        }

        const dataStr = line.slice(6);
        if (dataStr === '[DONE]') {
          break;
        }

        const data = JSON.parse(dataStr);

        if (
          (data.type === 'conversation-started' ||
            data.type === 'conversation') &&
          data.conversationId
        ) {
          conversationId = data.conversationId;
          input.onConversationStarted?.(data.conversationId, data.title);
          continue;
        }

        if (data.type === 'finish' && data.finishReason) {
          finishReason = data.finishReason;
        }

        const result = input.onStreamEvent(data, state);
        state = {
          currentTextChunk: result.currentTextChunk,
          contentParts: result.contentParts,
          pendingApprovals: result.pendingApprovals,
          reasoningChunks: result.currentReasoningChunk
            ? [...result.reasoningChunks, result.currentReasoningChunk]
            : result.reasoningChunks,
        };
      }
    }
  } catch (error) {
    if (
      aborted ||
      input.signal?.aborted ||
      (error as Error).name === 'AbortError'
    ) {
      return {};
    }
    if (error instanceof ChatStreamStallError) {
      // Best-effort: stop consuming a stream that's already gone silent.
      // Never let cleanup mask the real stall error below.
      try {
        await reader.cancel();
      } catch {}
    }
    throw error;
  } finally {
    input.signal?.removeEventListener('abort', abortHandler);
    try {
      reader.releaseLock();
    } catch {}
  }

  return { conversationId, finishReason };
}

import { authenticatedFetch } from '../client/http';
