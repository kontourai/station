/**
 * Streaming orchestration functions
 * Handles streaming pipeline setup, handler creation, and SSE output
 */

import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import { outwardTransportError } from '../../utils/outward-error.js';
import { parseToolName } from '../../utils/tool-name-normalizer.js';
import { CompletionHandler } from '../streaming/handlers/CompletionHandler.js';
import { MetadataHandler } from '../streaming/handlers/MetadataHandler.js';
import { ReasoningHandler } from '../streaming/handlers/ReasoningHandler.js';
import { TextDeltaHandler } from '../streaming/handlers/TextDeltaHandler.js';
import { ToolCallHandler } from '../streaming/handlers/ToolCallHandler.js';
import type { InjectableStream } from '../streaming/InjectableStream.js';
import { StreamPipeline } from '../streaming/StreamPipeline.js';
import { isAutoApproved } from '../tools/tool-executor.js';

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
) {
  const autoApprove = agentSpec?.tools?.autoApprove || [];

  return async (request: any) => {
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

      if (isApproved || isApprovedOriginal) {
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
      } as unknown as any);

      // Wait for user approval
      return approvalRegistry.register(approvalId, {
        metadata: {
          agentName: agentSpec.name,
          conversationId: getConversationId(),
          description:
            typeof request.toolDescription === 'string'
              ? request.toolDescription
              : undefined,
          server,
          source: 'runtime',
          title: toolMapping?.original || toolName,
          tool,
          toolName,
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
    /** Engine + model, carried onto tool events so they can be grouped by them (#3074). */
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
    .use(new TextDeltaHandler())
    .use(new ToolCallHandler())
    .use(metadataHandler)
    .use(completionHandler);

  return pipeline;
}

/**
 * station#1207: how often the `/chat` SSE stream emits a keepalive comment
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
export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

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
  }, SSE_KEEPALIVE_INTERVAL_MS);
  return () => clearInterval(timer);
}

/**
 * Write SSE chunk to stream
 */
export async function writeSSEChunk(
  streamWriter: any,
  chunk: any,
): Promise<void> {
  await streamWriter.write(`data: ${JSON.stringify(chunk)}\n\n`);
  // Force flush by yielding to event loop with setTimeout(0)
  // setImmediate doesn't flush network buffers, but setTimeout does
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Write SSE done marker
 */
export async function writeSSEDone(streamWriter: any): Promise<void> {
  await streamWriter.write('data: [DONE]\n\n');
}

/**
 * Write SSE error
 */
export async function writeSSEError(
  streamWriter: any,
  error: unknown,
): Promise<void> {
  const isCredentialError =
    error instanceof Error &&
    (error.message.includes('credential') ||
      error.message.includes('accessKeyId') ||
      error.message.includes('secretAccessKey'));
  await streamWriter.write(
    `data: ${JSON.stringify({
      type: 'error',
      errorText: outwardTransportError('sse'),
      statusCode: isCredentialError ? 401 : undefined,
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
