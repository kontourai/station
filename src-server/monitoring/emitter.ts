import type { EventEmitter } from 'node:events';
import { redactMonitoringContent } from './redaction.js';
import type {
  GenAiOperationName,
  HealthIntegration,
  MonitoringEvent,
} from './schema.js';
import { K, OP, SPAN } from './schema.js';

type PersistFn = (event: MonitoringEvent) => Promise<void>;

function base(
  operation: GenAiOperationName,
  kind: MonitoringEvent[typeof K.SPAN_KIND],
  traceId: string | undefined,
): MonitoringEvent {
  const now = Date.now();
  return {
    timestamp: new Date(now).toISOString(),
    [K.TIMESTAMP_MS]: now,
    // The third join key, guarded like the other two (station#3115): every
    // reader of `trace.id` treats `''` as no trace, so writing it is a
    // durable record of an id that is not one.
    ...(traceId ? { [K.TRACE_ID]: traceId } : {}),
    [K.OP_NAME]: operation,
    [K.SPAN_KIND]: kind,
  };
}

export class MonitoringEmitter {
  private readonly pendingWrites = new Set<Promise<void>>();

  constructor(
    private readonly events: EventEmitter,
    private readonly persist: PersistFn,
  ) {}

  private emit(event: MonitoringEvent): void {
    const redacted = redactMonitoringContent(event);
    this.events.emit('event', redacted);
    const pending = this.persist(redacted).catch(() => {});
    this.pendingWrites.add(pending);
    void pending.finally(() => this.pendingWrites.delete(pending));
  }

  async flush(): Promise<void> {
    while (this.pendingWrites.size > 0) {
      await Promise.all(this.pendingWrites);
    }
  }

  emitAgentStart(opts: {
    slug?: string;
    /**
     * Required to pass, but may be undefined: a turn that has no conversation
     * yet is a real state, and `''` is not the way to say it (station#3086).
     */
    conversationId: string | undefined;
    userId?: string;
    /**
     * Required to pass, but may be undefined: a span whose trace is unknown
     * has no trace id, and `''` is not the way to say it (station#3115).
     */
    traceId: string | undefined;
    input: string;
    model?: string;
    provider?: string;
  }): void {
    this.emit({
      ...base(OP.INVOKE_AGENT, SPAN.START, opts.traceId),
      ...(opts.conversationId
        ? { [K.CONVERSATION_ID]: opts.conversationId }
        : {}),
      [K.MODEL]: opts.model,
      [K.PROVIDER]: opts.provider,
      ...(opts.slug ? { [K.AGENT_SLUG]: opts.slug } : {}),
      ...(opts.userId ? { [K.USER_ID]: opts.userId } : {}),
      [K.INPUT_CHARS]: opts.input.length,
    });
  }

  emitAgentComplete(opts: {
    slug?: string;
    /**
     * Required to pass, but may be undefined: a turn that has no conversation
     * yet is a real state, and `''` is not the way to say it (station#3086).
     */
    conversationId: string | undefined;
    userId?: string;
    /**
     * Required to pass, but may be undefined: a span whose trace is unknown
     * has no trace id, and `''` is not the way to say it (station#3115).
     */
    traceId: string | undefined;
    reason: string;
    steps?: number;
    maxSteps?: number;
    toolCallCount?: number;
    inputChars?: number;
    outputChars?: number;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
    artifacts?: MonitoringEvent[typeof K.ARTIFACTS];
    model?: string;
  }): void {
    this.emit({
      ...base(OP.INVOKE_AGENT, SPAN.END, opts.traceId),
      ...(opts.conversationId
        ? { [K.CONVERSATION_ID]: opts.conversationId }
        : {}),
      [K.MODEL]: opts.model,
      [K.FINISH_REASONS]: [opts.reason],
      [K.INPUT_TOKENS]: opts.usage?.inputTokens,
      [K.OUTPUT_TOKENS]: opts.usage?.outputTokens,
      ...(opts.slug ? { [K.AGENT_SLUG]: opts.slug } : {}),
      ...(opts.userId ? { [K.USER_ID]: opts.userId } : {}),
      [K.AGENT_STEPS]: opts.steps,
      [K.AGENT_MAX_STEPS]: opts.maxSteps,
      [K.INPUT_CHARS]: opts.inputChars,
      [K.OUTPUT_CHARS]: opts.outputChars,
      [K.ARTIFACTS]: opts.artifacts,
    });
  }

  emitToolCall(opts: {
    slug?: string;
    /**
     * Required to pass, but may be undefined: a turn that has no conversation
     * yet is a real state, and `''` is not the way to say it (station#3086).
     */
    conversationId: string | undefined;
    userId?: string;
    /**
     * Required to pass, but may be undefined: a span whose trace is unknown
     * has no trace id, and `''` is not the way to say it (station#3115).
     */
    traceId: string | undefined;
    /**
     * Omit when the producer reported no name. Do NOT substitute a string:
     * writing the literal 'unknown' into the durable log converts an absence
     * into a value no reader can undo, and makes it indistinguishable from a
     * tool actually named `unknown` (station#3073).
     */
    toolName?: string;
    toolCallId: string | undefined;
    input?: unknown;
    /**
     * The engine that ran the tool (station#3074). Without it, tool usage
     * cannot be grouped by engine at all — the sibling agent-start record is
     * the only carrier today, and the Station-engine path does not even set
     * it there.
     */
    provider?: string;
    /**
     * The SESSION-CONFIGURED model at dispatch — not observed per call. An
     * engine that switches model mid-session labels its tool events with the
     * model the turn started under: the same approximation the agent spans
     * already carry, named so the field does not promise more than it
     * computes.
     */
    model?: string;
  }): void {
    this.emit({
      ...base(OP.EXECUTE_TOOL, SPAN.START, opts.traceId),
      ...(opts.conversationId
        ? { [K.CONVERSATION_ID]: opts.conversationId }
        : {}),
      ...(opts.toolName ? { [K.TOOL_NAME]: opts.toolName } : {}),
      ...(opts.toolCallId ? { [K.TOOL_CALL_ID]: opts.toolCallId } : {}),
      [K.TOOL_CALL_ARGS]: opts.input,
      ...(opts.slug ? { [K.AGENT_SLUG]: opts.slug } : {}),
      ...(opts.userId ? { [K.USER_ID]: opts.userId } : {}),
      ...(opts.provider !== undefined ? { [K.PROVIDER]: opts.provider } : {}),
      ...(opts.model !== undefined ? { [K.MODEL]: opts.model } : {}),
    });
  }

  emitToolResult(opts: {
    slug?: string;
    /**
     * Required to pass, but may be undefined: a turn that has no conversation
     * yet is a real state, and `''` is not the way to say it (station#3086).
     */
    conversationId: string | undefined;
    userId?: string;
    /**
     * Required to pass, but may be undefined: a span whose trace is unknown
     * has no trace id, and `''` is not the way to say it (station#3115).
     */
    traceId: string | undefined;
    /** Omit when the producer reported no name — see `emitToolCall`. */
    toolName?: string;
    toolCallId: string | undefined;
    result?: unknown;
    /** Omit when the source did not report a terminal outcome. */
    outcome?: 'success' | 'error';
    /**
     * Elapsed time from call to result. Recorded on the EVENT because the
     * OTel histogram that used to be its only home is a no-op unless an
     * exporter endpoint is configured — so on a default install tool latency
     * was computed and discarded (station#3077, the #1686 lesson again).
     */
    durationMs?: number;
    provider?: string;
    model?: string;
  }): void {
    this.emit({
      ...base(OP.EXECUTE_TOOL, SPAN.END, opts.traceId),
      ...(opts.conversationId
        ? { [K.CONVERSATION_ID]: opts.conversationId }
        : {}),
      ...(opts.toolName ? { [K.TOOL_NAME]: opts.toolName } : {}),
      ...(opts.toolCallId ? { [K.TOOL_CALL_ID]: opts.toolCallId } : {}),
      [K.TOOL_CALL_RESULT]: opts.result,
      ...(opts.outcome !== undefined
        ? { [K.TOOL_CALL_OUTCOME]: opts.outcome }
        : {}),
      ...(typeof opts.durationMs === 'number'
        ? { [K.TOOL_DURATION_MS]: Math.round(opts.durationMs) }
        : {}),
      ...(opts.slug ? { [K.AGENT_SLUG]: opts.slug } : {}),
      ...(opts.userId ? { [K.USER_ID]: opts.userId } : {}),
      ...(opts.provider !== undefined ? { [K.PROVIDER]: opts.provider } : {}),
      ...(opts.model !== undefined ? { [K.MODEL]: opts.model } : {}),
    });
  }

  emitReasoning(opts: {
    slug?: string;
    /**
     * Required to pass, but may be undefined: a turn that has no conversation
     * yet is a real state, and `''` is not the way to say it (station#3086).
     */
    conversationId: string | undefined;
    userId?: string;
    /**
     * Required to pass, but may be undefined: a span whose trace is unknown
     * has no trace id, and `''` is not the way to say it (station#3115).
     */
    traceId: string | undefined;
    text: string;
  }): void {
    this.emit({
      ...base(OP.CHAT, SPAN.EVENT, opts.traceId),
      ...(opts.conversationId
        ? { [K.CONVERSATION_ID]: opts.conversationId }
        : {}),
      ...(opts.slug ? { [K.AGENT_SLUG]: opts.slug } : {}),
      ...(opts.userId ? { [K.USER_ID]: opts.userId } : {}),
      [K.REASONING_TEXT]: opts.text,
    });
  }

  emitHealth(opts: {
    slug: string;
    userId?: string;
    /**
     * Required to pass, but may be undefined: a span whose trace is unknown
     * has no trace id, and `''` is not the way to say it (station#3115).
     */
    traceId: string | undefined;
    healthy: boolean;
    checks?: Record<string, boolean>;
    integrations?: HealthIntegration[];
  }): void {
    this.emit({
      ...base(OP.INVOKE_AGENT, SPAN.LOG, opts.traceId),
      ...(opts.slug ? { [K.AGENT_SLUG]: opts.slug } : {}),
      ...(opts.userId ? { [K.USER_ID]: opts.userId } : {}),
      [K.HEALTHY]: opts.healthy,
      [K.HEALTH_CHECKS]: opts.checks,
      [K.HEALTH_INTEGRATIONS]: opts.integrations,
    });
  }

  emitRaw(event: MonitoringEvent): void {
    this.emit(event);
  }
}
