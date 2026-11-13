import { isDeepStrictEqual } from 'node:util';
import { isRuntimeEventContentRef } from '@kontourai/station-contracts/runtime-event-content';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { providerUsageScope } from '@kontourai/station-shared/usage-fold';
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
  /**
   * #463: set once any usage frame in this turn came from a provider whose
   * frames are not that turn's own figures (session-cumulative, or a scope
   * nobody declared). The turn's usage is then unknown, never a number.
   */
  usageNotPerTurn?: true;
  provider?: string;
  /** Open tool calls by id: what the start span recorded and what came after. */
  openTools?: Map<string, OpenTool>;
};

type OpenTool = {
  /** For the elapsed time on results (archive#3077). */
  startedAt: number;
  /**
   * The start span's name, which the result reuses so Insights files a call
   * and its outcome in one bucket: OpenCode later retitles a call with its
   * description ("List files"), which is not the tool's name. Absent when the
   * start carried only the call id; the result then takes the final name.
   */
  name?: string;
  /** The arguments the start span carried. */
  startArguments: unknown;
  /** The newest arguments a repeat `tool.started` reported. */
  latestArguments: unknown;
};

/** No input yet: absent, or the empty object an ACP agent reports first. */
function isUnknownInput(input: unknown): boolean {
  return (
    input === undefined ||
    (typeof input === 'object' &&
      input !== null &&
      !Array.isArray(input) &&
      Object.keys(input).length === 0)
  );
}

/** An adapter that knows no name yet labels the call with its own id. */
function realToolName(
  name: string | undefined,
  toolCallId: string | undefined,
): string | undefined {
  return name && name !== toolCallId ? name : undefined;
}

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
      const open = event.toolCallId
        ? context.openTools?.get(event.toolCallId)
        : undefined;
      if (open) {
        // `tool.started` is an upsert, not a lifecycle edge: the ACP
        // tool-update supervisor re-publishes it whenever a call's title,
        // kind or input changes. The start span is already written, and the
        // clock keeps running; what arrived later is carried to the result.
        // An ACP agent's later input supersedes the earlier one: OpenCode
        // first reports `{}`, and Grok backfills fields into a partial input.
        // Claude's repeat is different: its `task_started` re-publishes a
        // started Agent call with a task descriptor, which is not the tool's
        // input, so for Claude only an input not yet known is filled in.
        if (
          event.arguments !== undefined &&
          (event.provider !== 'claude' || isUnknownInput(open.startArguments))
        )
          open.latestArguments = event.arguments;
        return;
      }
      if (event.toolCallId) {
        // performance.now(), matching MetadataHandler: both producers write
        // the SAME station.tool.duration_ms, and a wall clock is not
        // monotonic — an NTP step or a suspended host moves it backward and
        // yields a negative elapsed time for external-engine rows only. One
        // field measured by two clocks is the same defect class as one field
        // carrying two meanings.
        context.openTools ??= new Map();
        context.openTools.set(event.toolCallId, {
          startedAt: performance.now(),
          name: realToolName(event.toolName, event.toolCallId),
          startArguments: event.arguments,
          latestArguments: event.arguments,
        });
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
      // Consume the open call, mirroring MetadataHandler: a redelivered
      // completion for a reused id must not pick up a stale start.
      const open = event.toolCallId
        ? context.openTools?.get(event.toolCallId)
        : undefined;
      if (event.toolCallId) context.openTools?.delete(event.toolCallId);
      const startedAt = open?.startedAt;
      const toolName = open?.name ?? event.toolName;
      if (startedAt !== undefined) {
        // Feed the histogram too, so an exporter-configured deployment sees
        // external-engine latency rather than Station-engine only.
        otelToolDuration.record(performance.now() - startedAt, {
          ...(toolName ? { tool: toolName } : {}),
          plugin: '',
        });
      }
      this.emitter?.emitToolResult({
        slug: context.slug,
        conversationId: context.conversationId,
        userId: context.userId,
        traceId: context.traceId,
        toolName,
        toolCallId: event.toolCallId,
        // Only input the start span does not already show.
        ...(open &&
        open.latestArguments !== undefined &&
        !isDeepStrictEqual(open.latestArguments, open.startArguments)
          ? { input: open.latestArguments }
          : {}),
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
              : // station#1558: its own reported outcome, never `error`.
                // `cancelled` keeps its existing behaviour (omitted — the
                // attribute has no member for it), but an unresolved call
                // must be distinguishable from one whose producer simply
                // never reported: insights counts the two apart.
                event.status === 'unresolved'
                ? 'unresolved'
                : undefined,
      });
    } else if (event.method === 'token-usage.updated') {
      // #463: what one frame measures depends on the provider
      // (PROVIDER_USAGE_SCOPE). Claude and the other `per-turn` reporters
      // describe only this turn, so the turn's usage is the sum of its own
      // frames — the same rule `turn-provenance-fold.ts` applies. Codex
      // reports a session-to-date total; stamping it on this turn's span
      // attributed the whole session to one turn. A per-turn delta would
      // need the previous turn's cumulative figure, which this bridge does
      // not reliably have (a resumed thread, a restart, or a replayed turn
      // all lose it), so a cumulative or undeclared reporter's turn usage
      // is left unknown rather than guessed.
      if (providerUsageScope(event.provider) !== 'per-turn') {
        context.usageNotPerTurn = true;
        context.usage = undefined;
      } else if (!context.usageNotPerTurn) {
        context.usage = addUsage(context.usage, {
          inputTokens: event.promptTokens,
          outputTokens: event.completionTokens,
          totalTokens: event.totalTokens,
        });
      }
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
          ? typeof event.outputText === 'string'
            ? event.outputText.length
            : // A spilled reply's reference keeps the full length.
              isRuntimeEventContentRef(event.outputText)
              ? event.outputText.length
              : undefined
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

type TurnUsage = NonNullable<TurnContext['usage']>;

/** Sums reported components; a component no frame reported stays absent. */
function addUsage(current: TurnUsage | undefined, next: TurnUsage): TurnUsage {
  const sum = (a: number | undefined, b: number | undefined) =>
    a === undefined ? b : b === undefined ? a : a + b;
  return {
    inputTokens: sum(current?.inputTokens, next.inputTokens),
    outputTokens: sum(current?.outputTokens, next.outputTokens),
    totalTokens: sum(current?.totalTokens, next.totalTokens),
  };
}
