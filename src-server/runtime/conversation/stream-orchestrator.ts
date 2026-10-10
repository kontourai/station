/**
 * Streaming orchestration functions
 * Handles streaming pipeline setup, handler creation, and SSE output
 */

import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { InputRequestResponse } from '@kontourai/station-contracts/input-request';
import { MS_PER_MINUTE } from '@kontourai/station-contracts/time';
import {
  readInputRequestResponse,
  validateInputRequestContent,
} from '@kontourai/station-shared/input-request';
import { inputRequestFromMcpElicitation } from '@kontourai/station-shared/mcp-elicitation';
import { APICallError } from 'ai';
import {
  findModelProviderError,
  MODEL_PROVIDER_CREDENTIALS_REJECTED,
  modelProviderErrorStatus,
  modelProviderFailureMessage,
} from '../../providers/model-provider-failure.js';
import type { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import { outwardTransportError } from '../../utils/outward-error.js';
import { parseToolName } from '../../utils/tool-name-normalizer.js';
import { CompletionHandler } from '../streaming/handlers/CompletionHandler.js';
import { MetadataHandler } from '../streaming/handlers/MetadataHandler.js';
import { ReasoningHandler } from '../streaming/handlers/ReasoningHandler.js';
import { ToolCallHandler } from '../streaming/handlers/ToolCallHandler.js';
import type { InjectableStream } from '../streaming/InjectableStream.js';
import { StreamPipeline } from '../streaming/StreamPipeline.js';
import type { MCPToolNameMappingEntry } from '../tools/mcp-tool-names.js';
import {
  isAutoApproved,
  isIntrinsicStationEngineGrant,
} from '../tools/tool-executor.js';
import { STREAM_ABORTED_BY_CLIENT } from './chat-error-marker.js';

/**
 * How long a tool server's form waits for a person (#3284). A server's own
 * request timeout can end the wait sooner; then the request is cancelled.
 */
export const MCP_ELICITATION_TIMEOUT_MS = 10 * MS_PER_MINUTE;

/** A tool server's form elicitation, raised by the MCP tool wrapper. */
export interface McpElicitationCallbackRequest {
  type: 'mcp-elicitation';
  serverId: string;
  /** SDK-validated `elicitation/create` params. */
  params: unknown;
  /** Aborts when the server cancels the request or the turn is stopped. */
  signal?: AbortSignal;
}

/**
 * #3284: show a tool server's form to the person this turn runs for, and
 * return what they did. Rides the same channel as a tool approval — the
 * injected chunk becomes the thread's `request.opened`, and the answer comes
 * back through the approval registry — carrying the form and its answer.
 *
 * Truthfulness: `accept` only with content that passes the requested form;
 * `decline` only when the person declined; everything else (timeout, turn
 * or server cancellation, session stopped) is `cancel`. A request nobody
 * could be asked (an unrenderable form, an unbound hosted session) is an
 * error to the server, never a fabricated answer.
 */
async function requestMcpElicitation(
  request: McpElicitationCallbackRequest,
  context: {
    agentName?: string;
    approvalRegistry: ApprovalRegistry;
    injectableStream: InjectableStream;
    conversationId: string | undefined;
    orchestrationThreadId?: string;
  },
): Promise<InputRequestResponse> {
  const form = inputRequestFromMcpElicitation(request.serverId, request.params);
  if (!form)
    throw new Error(
      'Station cannot show this form: it uses a field type or size Station does not render.',
    );
  if (request.signal?.aborted) return { action: 'cancel' };
  const approvalId = `elicitation-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  context.injectableStream.inject({
    type: 'mcp-elicitation-request',
    approvalId,
    inputRequest: form,
  } as unknown as any);
  // Registered in the same tick as the inject, before any await, so the
  // answer can never arrive for an id the registry does not hold yet.
  const waiting = context.approvalRegistry.registerForAnswer(approvalId, {
    metadata: {
      agentName: context.agentName,
      conversationId: context.conversationId,
      ...(context.orchestrationThreadId &&
      context.orchestrationThreadId === context.conversationId
        ? { orchestrationThreadId: context.orchestrationThreadId }
        : {}),
      description: form.message,
      server: request.serverId,
      source: 'runtime',
      title: `${form.requester} needs your input`,
    },
    timeoutMs: MCP_ELICITATION_TIMEOUT_MS,
  });
  const onAbort = () => context.approvalRegistry.cancel(approvalId);
  request.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const { outcome, answer } = await waiting;
    if (outcome === 'unbound')
      throw new Error(
        'This form could not be shown: the turn is not bound to a session that can answer it.',
      );
    const result = readInputRequestResponse(answer);
    if (outcome === 'approved' && result?.action === 'accept')
      return {
        action: 'accept',
        // Re-checked here, at the last seam before the server: whatever
        // settled the request, only content that fits the form leaves.
        content: validateInputRequestContent(form, result.content),
      };
    if (outcome === 'denied' && result?.action === 'decline')
      return { action: 'decline' };
    return { action: 'cancel' };
  } finally {
    request.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Create elicitation callback for tool approval
 */
export function createElicitationCallback(
  agentSpec: AgentSpec,
  toolNameMapping: Map<
    string,
    {
      original: string;
      normalized: string;
      server: string | null;
      tool: string;
    }
  >,
  approvalRegistry: ApprovalRegistry,
  injectableStream: InjectableStream,
  logger: any,
  getConversationId: () => string | undefined = () => undefined,
  /**
   * #2589: set when this stream is the Station-agent adapter's relay for an
   * orchestration thread. The adapter republishes each tool-approval request
   * below as that thread's `request.opened`, so the approval is on the
   * agent-activity card; the stamp says so on the registry twin.
   */
  orchestrationThreadId?: string,
) {
  const autoApprove = agentSpec?.tools?.autoApprove || [];

  return async (request: any) => {
    if (request?.type === 'mcp-elicitation') {
      return requestMcpElicitation(request as McpElicitationCallbackRequest, {
        agentName: agentSpec?.name,
        approvalRegistry,
        injectableStream,
        conversationId: getConversationId(),
        orchestrationThreadId,
      });
    }
    if (request.type === 'tool-approval') {
      const toolName = request.toolName;

      // Check if auto-approved (check both normalized and original names)
      const isApproved = isAutoApproved(toolName, autoApprove);

      // Also check if the original (non-normalized) name matches
      const toolMapping = Array.from(toolNameMapping.values()).find(
        (m) => m.normalized === toolName,
      );
      const isApprovedOriginal = toolMapping
        ? isAutoApproved(toolMapping.original, autoApprove)
        : false;

      // #2584: the built-in's bounded-write tools, by exact loader identity.
      const isIntrinsic = isIntrinsicStationEngineGrant(
        toolName,
        toolNameMapping as ReadonlyMap<string, MCPToolNameMappingEntry>,
      );

      if (isApproved || isApprovedOriginal || isIntrinsic) {
        logger.info('[Elicitation] Auto-approved, returning true immediately', {
          toolName,
          originalName: toolMapping?.original,
          matched: isApproved ? 'normalized' : 'original',
        });
        return true;
      }

      // Not auto-approved - inject approval request into stream
      const approvalId = `approval-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Parse tool name for UI display
      const { server, tool } = parseToolName(toolName);

      logger.info(
        '[Elicitation] NOT auto-approved, injecting approval request',
        {
          approvalId,
          toolName,
          originalName: toolMapping?.original,
          autoApproveList: autoApprove,
        },
      );

      // Inject event (will appear at next chunk boundary)
      injectableStream.inject({
        type: 'tool-approval-request',
        approvalId,
        toolName,
        server,
        tool,
        toolDescription: request.toolDescription,
        toolArgs: request.toolArgs,
        purpose: request.purpose,
      } as unknown as any);

      // Wait for user approval
      const conversationId = getConversationId();
      return approvalRegistry.register(approvalId, {
        metadata: {
          agentName: agentSpec.name,
          conversationId,
          // Only for the relayed conversation itself.
          ...(orchestrationThreadId && orchestrationThreadId === conversationId
            ? { orchestrationThreadId }
            : {}),
          description:
            typeof request.toolDescription === 'string'
              ? request.toolDescription
              : undefined,
          server,
          source: 'runtime',
          title: toolMapping?.original || toolName,
          tool,
          toolName,
          purpose: request.purpose,
        },
      });
    }
    return false;
  };
}

/**
 * Create and configure streaming pipeline
 */
export function createStreamingPipeline(
  abortSignal: AbortSignal,
  monitoringEvents: any,
  contextData: {
    slug: string;
    conversationId: string | undefined;
    userId: string | undefined;
    traceId: string;
    plugin?: string;
    /** Engine + model, carried onto tool events so they can be grouped by them (archive#3074). */
    provider?: string;
    model?: string;
  },
  monitoringEmitter?: any,
): StreamPipeline {
  const pipeline = new StreamPipeline(abortSignal);
  const completionHandler = new CompletionHandler();
  const metadataHandler = new MetadataHandler(
    monitoringEvents,
    contextData,
    monitoringEmitter,
  );

  // Add handlers in order (elicitation handled via callback + injectable stream)
  pipeline
    .use(new ReasoningHandler({ enableThinking: true }))
    .use(new ToolCallHandler())
    .use(metadataHandler)
    .use(completionHandler);

  return pipeline;
}

/**
 * Named for its stream. `src-server/constants.ts` exports its own
 * `SSE_KEEPALIVE_INTERVAL_MS` (30s) for the long-lived operations streams —
 * `/api/orchestration/events`, monitoring and scheduler — and two exported
 * constants with the same name and different values is a reference a reader
 * has to resolve by import path. Neither cadence changes here.
 *
 * archive#1207: how often the `/chat` SSE stream emits a keepalive comment
 * while the agent is between content events — e.g. a long tool call
 * (delegateTask sub-agent, a slow MCP/shell tool) that legitimately
 * produces no partial output for tens of seconds. Without this, a
 * client-side stall watchdog has no way to distinguish "still alive, just
 * quiet" from "the transport died mid-turn", and either times out real
 * long-running turns or never times out a genuinely dead one.
 *
 * Must stay comfortably smaller than the client's own stall timeout
 * (`CHAT_STREAM_STALL_TIMEOUT_MS` in `packages/sdk/src/query-domains/
 * chatRuntimeStream.ts`) so at least two keepalives are missed before the
 * client gives up — one dropped frame (network jitter, a slow event-loop
 * tick) must never look like a dead server.
 */
export const CHAT_STREAM_KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * A standard SSE comment line. Deliberately NOT a `data: ` frame: every SSE
 * consumer (browsers' `EventSource`, and this route's own client — the raw
 * fetch+`ReadableStream` reader in `chatRuntimeStream.ts`, which only acts
 * on lines starting with `data: ` and otherwise falls through its
 * `continue`) already ignores a bare comment with zero parser changes, and
 * it can never be mistaken for a renderable chat event.
 */
const SSE_KEEPALIVE_FRAME = ':ping\n\n';

/**
 * Starts a periodic SSE keepalive on `streamWriter`. Returns a stop
 * function that MUST be called (from a `finally`) once the stream ends —
 * an uncleared interval otherwise outlives the request.
 */
export function startSSEKeepalive(streamWriter: any): () => void {
  const timer = setInterval(() => {
    // Best-effort: a failed write here just means the connection is
    // already gone — the main read/write path will observe the same dead
    // connection on its own, this is not this timer's failure to raise.
    void Promise.resolve(streamWriter.write(SSE_KEEPALIVE_FRAME)).catch(
      () => {},
    );
  }, CHAT_STREAM_KEEPALIVE_INTERVAL_MS);
  return () => clearInterval(timer);
}

/**
 * Write SSE chunk to stream.
 *
 * The awaited write is the whole contract. This used to append
 * `await new Promise((r) => setTimeout(r, 0))` under a comment claiming a
 * `setTimeout` flushes network buffers — it does not. Nothing in Node's
 * stream/socket path is driven by a timer expiring; the write is handed to
 * the transport by `write()` itself and `cork`/`uncork` (or the response
 * body's own backpressure) is what defers it. What the timer actually
 * bought was a full macrotask turn per SSE frame, so a turn emitting N
 * token deltas paid N event-loop round trips (≥1ms each, `setTimeout(0)`
 * being clamped to 1ms) purely to wait.
 */
export async function writeSSEChunk(
  streamWriter: any,
  chunk: any,
): Promise<void> {
  await streamWriter.write(
    `data: ${JSON.stringify(outwardStreamChunk(chunk))}\n\n`,
  );
}

/**
 * The cause an engine's `{ type: 'error' }` stream part reports, when the
 * part is one. VoltAgent does not throw for a model error that arrives after
 * output has started; it emits this part carrying the raw provider error
 * (an ai-sdk `APICallError`, whose serialized form holds the request URL,
 * the whole prompt and the response body). The `/chat` route treats it
 * exactly like a thrown error, so it must never be written as a chunk.
 */
export function streamErrorPartCause(chunk: unknown): unknown {
  if (
    !chunk ||
    typeof chunk !== 'object' ||
    (chunk as { type?: unknown }).type !== 'error'
  ) {
    return undefined;
  }
  return (chunk as { error?: unknown }).error ?? new Error('stream error part');
}

function isRawErrorValue(value: unknown): boolean {
  return value instanceof Error || APICallError.isInstance(value);
}

/**
 * The rule for every chunk written to a `/chat` client: no raw error object
 * crosses, and step frames carry only their type. A top-level field holding an `Error` (a `tool-error` part's
 * `error`, or any future part that carries one) is replaced by the fixed
 * outward text, since serializing it exposes whatever the error holds.
 * Chunks without such a field are returned as the same object.
 */
function outwardStreamChunk(chunk: unknown): unknown {
  if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) return chunk;
  // Step payloads are provider diagnostics; no Station client consumes them.
  const type = (chunk as { type?: unknown }).type;
  if (type === 'start-step' || type === 'finish-step') return { type };
  let next: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(chunk)) {
    if (!isRawErrorValue(value)) continue;
    next ??= { ...(chunk as Record<string, unknown>) };
    next[key] = outwardTransportError('sse');
  }
  return next ?? chunk;
}

/**
 * Write SSE done marker
 */
export async function writeSSEDone(streamWriter: any): Promise<void> {
  await streamWriter.write('data: [DONE]\n\n');
}

function isCredentialShapedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('credential') ||
      error.message.includes('accessKeyId') ||
      error.message.includes('secretAccessKey'))
  );
}

/**
 * The status a `/chat` failure may carry to a client: the model provider's
 * own status (`modelProviderErrorStatus`: an ai-sdk `APICallError` only)
 * when it is a 4xx/5xx integer. Only when no such
 * status exists does a credential-shaped message stand in as a 401, flagged
 * `statusInferred` because no HTTP response supplied it.
 */
function outwardFailureStatus(error: unknown): {
  statusCode?: number;
  statusInferred?: true;
} {
  // Through RetryError/AggregateError/cause wrappers, like the /chat
  // preparation path, so a retried provider error still names its status.
  const statusCode = modelProviderErrorStatus(findModelProviderError(error));
  if (statusCode !== undefined) return { statusCode };
  return isCredentialShapedError(error)
    ? { statusCode: 401, statusInferred: true }
    : {};
}

/**
 * The failure text a `/chat` turn may persist and serve (the `[CHAT_ERROR]`
 * transcript marker, `chat-lifecycle.ts`). Never the thrown error's own
 * message: a provider error's text is remote-controlled and has carried
 * response bodies and secrets. It is the status sentence when a provider
 * status is known, the unnumbered credentials sentence when the refusal was
 * inferred, Station's own abort constant for an abort, else the fixed
 * outward generic.
 */
export function outwardTurnFailureText(error: unknown): string {
  const { statusCode, statusInferred } = outwardFailureStatus(error);
  if (statusInferred) return MODEL_PROVIDER_CREDENTIALS_REJECTED;
  if (statusCode !== undefined) return modelProviderFailureMessage(statusCode);
  if (error instanceof Error && error.message === STREAM_ABORTED_BY_CLIENT) {
    return STREAM_ABORTED_BY_CLIENT;
  }
  return outwardTransportError('sse');
}

/**
 * Write SSE error.
 *
 * The text is always the fixed outward generic; the provider's own message
 * never crosses. What may cross is the HTTP status (`outwardFailureStatus`):
 * a bare integer carries no provider-controlled text, and it is what lets
 * the station-agent relay tell the user WHY the turn failed ("rejected the
 * credentials", "rate-limited") instead of only that it did. An inferred
 * credential 401 says so with `statusInferred: true`, so no consumer quotes
 * it as a status the provider returned.
 */
export async function writeSSEError(
  streamWriter: any,
  error: unknown,
): Promise<void> {
  const { statusCode, statusInferred } = outwardFailureStatus(error);
  await streamWriter.write(
    `data: ${JSON.stringify({
      type: 'error',
      errorText: outwardTransportError('sse'),
      statusCode,
      ...(statusInferred ? { statusInferred } : {}),
    })}\n\n`,
  );
}

/**
 * Save cancellation message when stream is aborted
 */
export async function saveCancellationMessage(
  agent: any,
  operationContext: any,
): Promise<void> {
  const mem = agent.getMemory();
  if (mem && operationContext.conversationId && operationContext.userId) {
    await mem.addMessage(
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        parts: [{ type: 'text', text: '_⚠️ Response cancelled by user_' }],
      },
      operationContext.userId,
      operationContext.conversationId,
    );
  }
}
