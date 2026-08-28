import type { EventEmitter } from 'node:events';
import { trace } from '@opentelemetry/api';
import { MonitoringEmitter } from '../../../monitoring/emitter.js';
import {
  toolCalls as otelToolCalls,
  toolDuration as otelToolDuration,
} from '../../../telemetry/metrics.js';
import type { StreamChunk, StreamHandler } from '../types.js';

/**
 * Collects statistics and emits monitoring events
 *
 * Tracks:
 * - Text chunks
 * - Reasoning blocks
 * - Tool calls + duration
 * - Step count
 *
 * Emits monitoring events for observability
 */
export class MetadataHandler implements StreamHandler {
  name = 'metadata';

  private stats = {
    textChunks: 0,
    reasoningBlocks: 0,
    toolCalls: 0,
    steps: 0,
  };

  private toolStartTimes = new Map<string, { start: number; tool?: string }>();
  /**
   * Per-chunk hand-off from `collectStats` to `emitMonitoringEvent`: the
   * tool name and elapsed time belong to the CALL, and the map entry holding
   * them is consumed while collecting stats, which runs first.
   */
  private resolvedResult?: { tool?: string; durationMs: number };

  constructor(
    _monitoringEvents?: EventEmitter,
    private context?: {
      slug: string;
      conversationId?: string;
      userId?: string;
      traceId?: string;
      plugin?: string;
      /** The engine running this stream (archive#3074). */
      provider?: string;
      /** Session-configured model at dispatch; not observed per call. */
      model?: string;
    },
    private monitoringEmitter?: MonitoringEmitter,
  ) {}

  async *process(
    input: AsyncIterable<StreamChunk>,
  ): AsyncGenerator<StreamChunk> {
    for await (const chunk of input) {
      // Collect stats
      this.collectStats(chunk);

      // Emit monitoring events
      this.emitMonitoringEvent(chunk);

      // Pass through unchanged
      yield chunk;
    }
  }

  private collectStats(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'text-delta':
        this.stats.textChunks++;
        break;
      case 'reasoning-start':
        this.stats.reasoningBlocks++;
        break;
      case 'tool-call':
        this.stats.toolCalls++;
        // No `|| 'unknown'`: a missing name is an absence, and substituting
        // a string here made it indistinguishable from a tool actually named
        // `unknown` — in the durable event log, permanently (archive#3073).
        otelToolCalls.add(1, {
          ...(chunk.toolName ? { tool: chunk.toolName } : {}),
          plugin: this.context?.plugin || '',
        });
        if (chunk.toolCallId) {
          this.toolStartTimes.set(chunk.toolCallId, {
            start: performance.now(),
            tool: chunk.toolName,
          });
        }
        break;
      case 'tool-result':
        // Resolve what only the CALL knew: its name, and how long it ran.
        // Both are handed to the emit step below via `resolvedResult`,
        // because the map entry is consumed here.
        this.resolvedResult = undefined;
        if (chunk.toolCallId) {
          const entry = this.toolStartTimes.get(chunk.toolCallId);
          if (entry) {
            const durationMs = performance.now() - entry.start;
            otelToolDuration.record(durationMs, {
              ...(entry.tool ? { tool: entry.tool } : {}),
              plugin: this.context?.plugin || '',
            });
            this.toolStartTimes.delete(chunk.toolCallId);
            this.resolvedResult = { tool: entry.tool, durationMs };
          }
        }
        break;
      case 'start-step':
        this.stats.steps++;
        break;
    }
  }

  private emitMonitoringEvent(chunk: StreamChunk): void {
    if (!this.monitoringEmitter || !this.context) return;
    const { slug, conversationId, userId, traceId } = this.context;

    switch (chunk.type) {
      case 'tool-call':
        this.monitoringEmitter.emitToolCall({
          slug,
          conversationId,
          userId,
          traceId,
          toolName: chunk.toolName,
          toolCallId: chunk.toolCallId,
          input: chunk.input,
          provider: this.context.provider,
          model: this.context.model,
        });
        trace.getActiveSpan()?.addEvent('tool-call', {
          ...(chunk.toolName ? { 'tool.name': chunk.toolName } : {}),
          'tool.call_id': chunk.toolCallId,
        });
        break;
      case 'tool-result':
        this.monitoringEmitter.emitToolResult({
          slug,
          conversationId,
          userId,
          traceId,
          // The result event may carry no name of its own — Strands sends
          // only the call id — so fall back to the name the call recorded
          // (archive#3082). Absent stays absent; nothing is invented.
          toolName: chunk.toolName || this.resolvedResult?.tool,
          toolCallId: chunk.toolCallId,
          result: chunk.output,
          provider: this.context.provider,
          model: this.context.model,
          // Duration on the RECORD, not only in an OTel histogram that is a
          // no-op unless an exporter endpoint is configured (archive#3077).
          durationMs: this.resolvedResult?.durationMs,
          outcome:
            chunk.status === 'error' || chunk.error != null
              ? 'error'
              : chunk.status === 'success'
                ? 'success'
                : undefined,
        });
        trace.getActiveSpan()?.addEvent('tool-result', {
          ...(chunk.toolName ? { 'tool.name': chunk.toolName } : {}),
          'tool.call_id': chunk.toolCallId,
        });
        break;
      case 'reasoning-end': {
        const reasoningChunk = chunk as StreamChunk & { text?: string };
        if (reasoningChunk.text) {
          this.monitoringEmitter.emitReasoning({
            slug,
            conversationId,
            userId,
            traceId,
            text: reasoningChunk.text,
          });
        }
        break;
      }
    }
  }

  finalize() {
    return this.stats;
  }
}
