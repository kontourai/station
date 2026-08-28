import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { MonitoringEmitter } from '../../monitoring/emitter.js';
import { toolDuration as otelToolDuration } from '../../telemetry/metrics.js';

type TurnContext = {
  threadId: string;
  turnId: string;
  slug?: string;
  conversationId: string;
  userId?: string;
  traceId: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  provider?: string;
  /** Tool call start times, for the elapsed time on results (archive#3077). */
  toolStartedAt?: Record<string, number>;
};

/**
 * Projects canonical external-engine events into Station's monitoring store.
 * Station-agent is deliberately excluded: its relayed
 * `/api/agents/:slug/chat` stream already owns that projection.
 *
 * It no longer feeds lifetime analytics (archive#3245). Doing so made this a
 * SECOND fold of the same events, and a wrong one: it kept the last
 * `token-usage.updated` frame per turn on the belief that every engine
 * reports cumulatively, which over-reported Codex (genuinely
 * session-cumulative, so each turn re-added the whole running total) and
 * discarded provider-reported cost entirely, publishing `0`. Because
 * `mergeRescannedUsageStats` merges lifetime totals with `Math.max`, that
 * inflated figure then LATCHED and could never be corrected by a later,
 * correct rescan. The one derivation is now `foldUsageEvents`, reached by
 * `UsageAggregator.fullRescan` through
 * `OrchestrationService.listSessionUsage`.
 */
export class OrchestrationMonitoringBridge {
  private readonly turns = new Map<string, TurnContext>();

  constructor(
    private readonly emitter: MonitoringEmitter | undefined,
    private readonly sessionContext: (threadId: string) => {
      /** Absent when the session reported none — never a substituted literal (archive#3082). */
      slug?: string;
      conversationId: string;
      /** Absent when the session reported none. */
      userId?: string;
      model?: string;
    } | null,
  ) {}

  onTurnDispatched(input: {
    provider: string;
    threadId: string;
    turnId: string;
    prompt: string;
  }): void {
    if (input.provider === 'station-agent') return;
    const session = this.sessionContext(input.threadId);
    if (!session) return;
    // Credential-profile recovery may replay an already accepted turn. Its
    // original context is still valid, so do not emit a second start span.
    if (this.turns.has(this.key(input.threadId, input.turnId))) return;
    const context: TurnContext = {
      ...session,
      threadId: input.threadId,
      turnId: input.turnId,
      traceId: input.threadId,
      // Retained per turn so the TOOL events can carry it too, not just the
      // start span (archive#3074): grouping tool usage by engine previously
      // required joining back to agent-start, which does not even exist for
      // Station-engine turns.
      provider: input.provider,
    };
    this.turns.set(this.key(input.threadId, input.turnId), context);
    this.emitter?.emitAgentStart({
      slug: context.slug,
      conversationId: context.conversationId,
      userId: context.userId,
      traceId: context.traceId,
      input: input.prompt,
      model: context.model,
      provider: input.provider,
    });
  }

  onRuntimeEvent(event: CanonicalRuntimeEvent): void {
    if (event.provider === 'station-agent') return;
    const turnId = event.turnId;
    if (event.method === 'runtime.error' && !turnId) {
      for (const [, context] of this.turns) {
        if (context.threadId !== event.threadId) continue;
        this.complete(event, context, context.turnId, event.message);
      }
      return;
    }
    const context = turnId
      ? this.turns.get(this.key(event.threadId, turnId))
      : undefined;
    if (!context || !turnId) return;
    if (event.method === 'tool.started') {
      // Remember when it started so the result can carry elapsed time too
      // (archive#3077). Without this, duration exists for Station-engine
      // tools and silently not for external ones — the same
      // present-for-some-rows asymmetry the sibling issue is about.
      if (event.toolCallId) {
        // performance.now(), matching MetadataHandler: both producers write
        // the SAME station.tool.duration_ms, and a wall clock is not
        // monotonic — an NTP step or a suspended host moves it backward and
        // yields a negative elapsed time for external-engine rows only. One
        // field measured by two clocks is the same defect class as one field
        // carrying two meanings.
        context.toolStartedAt = {
          ...(context.toolStartedAt ?? {}),
          [event.toolCallId]: performance.now(),
        };
      }
      this.emitter?.emitToolCall({
        slug: context.slug,
        conversationId: context.conversationId,
        userId: context.userId,
        traceId: context.traceId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: event.arguments,
        provider: context.provider,
        model: context.model,
      });
    } else if (event.method === 'tool.completed') {
      // Consume the start time, mirroring MetadataHandler: a redelivered
      // completion for a reused id must not pick up a stale start.
      const startedAt = event.toolCallId
        ? context.toolStartedAt?.[event.toolCallId]
        : undefined;
      if (event.toolCallId && context.toolStartedAt) {
        const { [event.toolCallId]: _consumed, ...rest } =
          context.toolStartedAt;
        context.toolStartedAt = rest;
      }
      if (startedAt !== undefined) {
        // Feed the histogram too, so an exporter-configured deployment sees
        // external-engine latency rather than Station-engine only.
        otelToolDuration.record(performance.now() - startedAt, {
          ...(event.toolName ? { tool: event.toolName } : {}),
          plugin: '',
        });
      }
      this.emitter?.emitToolResult({
        slug: context.slug,
        conversationId: context.conversationId,
        userId: context.userId,
        traceId: context.traceId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        result: event.output ?? event.error,
        ...(startedAt !== undefined
          ? { durationMs: performance.now() - startedAt }
          : {}),
        provider: context.provider,
        model: context.model,
        outcome:
          event.status === 'error'
            ? 'error'
            : event.status === 'success'
              ? 'success'
              : undefined,
      });
    } else if (event.method === 'token-usage.updated') {
      // Claude/Codex streams report cumulative usage, so retain the last frame.
      context.usage = {
        inputTokens: event.promptTokens,
        outputTokens: event.completionTokens,
        totalTokens: event.totalTokens,
      };
    } else if (
      event.method === 'turn.completed' ||
      event.method === 'turn.aborted' ||
      event.method === 'runtime.error'
    ) {
      this.complete(
        event,
        context,
        turnId,
        event.method === 'turn.completed'
          ? (event.finishReason ?? 'other')
          : event.method === 'turn.aborted'
            ? event.reason
            : event.message,
      );
    }
  }

  private complete(
    event: Extract<
      CanonicalRuntimeEvent,
      { method: 'turn.completed' | 'turn.aborted' | 'runtime.error' }
    >,
    context: TurnContext,
    turnId: string,
    reason: string | undefined,
  ): void {
    this.emitter?.emitAgentComplete({
      slug: context.slug,
      conversationId: context.conversationId,
      userId: context.userId,
      traceId: context.traceId,
      reason: reason ?? 'error',
      outputChars:
        event.method === 'turn.completed'
          ? event.outputText?.length
          : undefined,
      usage: context.usage,
      model: context.model,
    });
    this.turns.delete(this.key(event.threadId, turnId));
  }

  private key(threadId: string, turnId: string): string {
    return `${threadId}:${turnId}`;
  }
}
