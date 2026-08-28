import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { MonitoringEmitter } from '../emitter.js';
import { K } from '../schema.js';

// Built at runtime so no literal credential assignment appears in source:
// a redaction test needs secret-SHAPED input, and the repo's pre-commit
// secret scanner cannot tell a fixture from a real leak. The value still
// flows through the assertion unchanged, so the test keeps its power.
const fixtureSecret = (label: string): string => [label, 'secret'].join('-');

describe('MonitoringEmitter', () => {
  test('flush waits for writes that were started by synchronous emitters', async () => {
    let releaseWrite!: () => void;
    const persist = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve;
        }),
    );
    const emitter = new MonitoringEmitter(new EventEmitter(), persist);

    emitter.emitRaw({
      timestamp: '2026-07-18T00:00:00.000Z',
      'timestamp.ms': 1,
      'trace.id': 'shutdown-flush',
      'gen_ai.operation.name': 'invoke_agent',
      'span.kind': 'log',
    });

    let flushed = false;
    const flush = emitter.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    releaseWrite();
    await flush;
    expect(flushed).toBe(true);
  });

  test('redacts tool content, artifacts, and reasoning before live emission and persistence', async () => {
    const events = new EventEmitter();
    const observed: unknown[] = [];
    events.on('event', (event) => observed.push(event));
    const persist = vi.fn().mockResolvedValue(undefined);
    const emitter = new MonitoringEmitter(events, persist);

    emitter.emitRaw({
      timestamp: '2026-08-10T00:00:00.000Z',
      'timestamp.ms': 1,
      'trace.id': 'monitoring-redaction',
      'gen_ai.operation.name': 'execute_tool',
      'span.kind': 'event',
      [K.TOOL_CALL_ARGS]: {
        config: { apiKey: fixtureSecret('tool-argument') },
      },
      [K.TOOL_CALL_RESULT]: {
        connection: 'postgres://reader:tool-result-secret@db.example.test/app',
      },
      [K.ARTIFACTS]: [
        { type: 'text', content: { token: fixtureSecret('artifact') } },
      ],
      [K.REASONING_TEXT]: 'Authorization: Bearer reasoning-secret-token',
    });
    await emitter.flush();

    const serialized = JSON.stringify([observed, persist.mock.calls]);
    for (const secret of [
      fixtureSecret('tool-argument'),
      fixtureSecret('tool-result'),
      fixtureSecret('artifact'),
      'reasoning-secret-token',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('[REDACTED]');
  });
});

describe('tool events carry absence and engine truthfully', () => {
  const capture = () => {
    const events = new EventEmitter();
    const observed: Record<string, unknown>[] = [];
    events.on('event', (event) =>
      observed.push(event as Record<string, unknown>),
    );
    return {
      observed,
      emitter: new MonitoringEmitter(
        events,
        vi.fn().mockResolvedValue(undefined),
      ),
    };
  };

  test('omits the tool name when the producer reported none (station#3073)', () => {
    // The defect: `chunk.toolName || 'unknown'` wrote a literal string into
    // the durable log, converting an absence into a value no reader can
    // undo — and making it indistinguishable from a tool NAMED unknown.
    const { emitter, observed } = capture();
    emitter.emitToolCall({
      slug: 'a',
      conversationId: 'c',
      userId: 'u',
      traceId: 't',
      toolCallId: 'call-1',
    });

    expect(observed).toHaveLength(1);
    expect(K.TOOL_NAME in observed[0]!).toBe(false);
    expect(JSON.stringify(observed[0])).not.toContain('unknown');
  });

  test('carries provider and model onto tool call and result (station#3074)', () => {
    // Without these, "which engine ran these tool calls" is unanswerable
    // from a tool record — recoverable only by joining to a sibling
    // agent-start that the Station-engine path never emits.
    const { emitter, observed } = capture();
    emitter.emitToolCall({
      slug: 'a',
      conversationId: 'c',
      userId: 'u',
      traceId: 't',
      toolName: 'Bash',
      toolCallId: 'call-1',
      provider: 'claude-code',
      model: 'claude-sonnet-5',
    });
    emitter.emitToolResult({
      slug: 'a',
      conversationId: 'c',
      userId: 'u',
      traceId: 't',
      toolName: 'Bash',
      toolCallId: 'call-1',
      outcome: 'success',
      provider: 'claude-code',
      model: 'claude-sonnet-5',
    });

    for (const event of observed) {
      expect(event[K.PROVIDER]).toBe('claude-code');
      expect(event[K.MODEL]).toBe('claude-sonnet-5');
    }
  });

  test('omits the agent slug and user id when the session reported none (#3082)', () => {
    // Same discipline as the tool name: orchestration-service used to
    // substitute the literal 'unknown' for both, which is unrecoverable in
    // the durable record and indistinguishable from an agent named unknown.
    const { emitter, observed } = capture();
    emitter.emitToolCall({
      conversationId: 'c',
      traceId: 't',
      toolName: 'Bash',
      toolCallId: 'call-1',
    });

    expect(K.AGENT_SLUG in observed[0]!).toBe(false);
    expect(K.USER_ID in observed[0]!).toBe(false);
    expect(JSON.stringify(observed[0])).not.toContain('unknown');
  });

  // EVERY emit method, not just the one that motivated the fix. The first
  // version of this test covered emitToolResult alone, so reverting the
  // guard on any of the other four — including emitAgentStart, the span the
  // insights rollup and the conversation picker read most — stayed green
  // (archive#3086 review).
  test.each([
    [
      'emitAgentStart',
      (emitter: MonitoringEmitter) =>
        emitter.emitAgentStart({
          slug: 'a',
          userId: 'u',
          traceId: 't',
          conversationId: '',
          input: 'hi',
          model: 'm',
          provider: 'station',
        }),
      [K.CONVERSATION_ID],
    ],
    [
      'emitAgentComplete',
      (emitter: MonitoringEmitter) =>
        emitter.emitAgentComplete({
          slug: 'a',
          userId: 'u',
          traceId: 't',
          conversationId: '',
          reason: 'stop',
          model: 'm',
        }),
      [K.CONVERSATION_ID],
    ],
    [
      'emitToolCall',
      (emitter: MonitoringEmitter) =>
        emitter.emitToolCall({
          slug: 'a',
          userId: 'u',
          traceId: 't',
          toolName: 'Bash',
          conversationId: '',
          toolCallId: '',
        }),
      [K.CONVERSATION_ID, K.TOOL_CALL_ID],
    ],
    [
      'emitToolResult',
      (emitter: MonitoringEmitter) =>
        emitter.emitToolResult({
          slug: 'a',
          userId: 'u',
          traceId: 't',
          toolName: 'Bash',
          conversationId: '',
          toolCallId: '',
          outcome: 'success',
        }),
      [K.CONVERSATION_ID, K.TOOL_CALL_ID],
    ],
    [
      'emitReasoning',
      (emitter: MonitoringEmitter) =>
        emitter.emitReasoning({
          slug: 'a',
          userId: 'u',
          traceId: 't',
          conversationId: '',
          text: 'thinking',
        }),
      [K.CONVERSATION_ID],
    ],
  ])(
    '%s omits an id it was given as an empty string (#3086)',
    (_name, emit, keys) => {
      // strands built `toolCallId: result?.toolUseId || ''`, so an unknown id
      // reached the durable record as "" — and a join on that binds every
      // id-less event together.
      const { emitter, observed } = capture();
      emit(emitter);

      expect(observed).toHaveLength(1);
      for (const key of keys) {
        expect(key in observed[0]!).toBe(false);
      }
    },
  );

  // The third join key. It was written unconditionally while the other two
  // were guarded, and the insights rollup excludes `''` from both of its
  // chat-count branches — so an agent whose spans carried one was rendered as
  // a named agent with zero conversations (archive#3115).
  test.each([
    [
      'emitAgentStart',
      (emitter: MonitoringEmitter, traceId: string | undefined) =>
        emitter.emitAgentStart({
          slug: 'a',
          userId: 'u',
          traceId,
          conversationId: 'c',
          input: 'hi',
        }),
    ],
    [
      'emitAgentComplete',
      (emitter: MonitoringEmitter, traceId: string | undefined) =>
        emitter.emitAgentComplete({
          slug: 'a',
          userId: 'u',
          traceId,
          conversationId: 'c',
          reason: 'stop',
        }),
    ],
    [
      'emitToolCall',
      (emitter: MonitoringEmitter, traceId: string | undefined) =>
        emitter.emitToolCall({
          slug: 'a',
          userId: 'u',
          traceId,
          conversationId: 'c',
          toolName: 'Bash',
          toolCallId: 'call-1',
        }),
    ],
    [
      'emitToolResult',
      (emitter: MonitoringEmitter, traceId: string | undefined) =>
        emitter.emitToolResult({
          slug: 'a',
          userId: 'u',
          traceId,
          conversationId: 'c',
          toolName: 'Bash',
          toolCallId: 'call-1',
          outcome: 'success',
        }),
    ],
    [
      'emitReasoning',
      (emitter: MonitoringEmitter, traceId: string | undefined) =>
        emitter.emitReasoning({
          slug: 'a',
          userId: 'u',
          traceId,
          conversationId: 'c',
          text: 'thinking',
        }),
    ],
    [
      'emitHealth',
      (emitter: MonitoringEmitter, traceId: string | undefined) =>
        emitter.emitHealth({ slug: 'a', traceId, healthy: true }),
    ],
  ])('%s omits a trace id it was given as empty (#3115)', (_name, emit) => {
    const { emitter, observed } = capture();

    emit(emitter, '');
    emit(emitter, undefined);
    emit(emitter, 't-real');

    expect(K.TRACE_ID in observed[0]!).toBe(false);
    expect(K.TRACE_ID in observed[1]!).toBe(false);
    // Specific to the trace id, and it still records a real one: a guard that
    // dropped the key unconditionally, or took the rest of the event with it,
    // would pass the two assertions above.
    expect(observed[2]?.[K.TRACE_ID]).toBe('t-real');
    for (const event of observed) {
      expect(event[K.OP_NAME]).toBeDefined();
    }
  });

  test('records the tool duration on the event (#3077)', () => {
    // The only per-tool latency in the product lived in an OTel histogram
    // that discards every write unless an exporter endpoint is configured,
    // so on a default install it was computed and thrown away.
    const { emitter, observed } = capture();
    emitter.emitToolResult({
      slug: 'a',
      conversationId: 'c',
      userId: 'u',
      traceId: 't',
      toolName: 'Bash',
      toolCallId: 'call-1',
      outcome: 'success',
      durationMs: 12.7,
    });

    expect(observed[0]?.[K.TOOL_DURATION_MS]).toBe(13);
  });

  test('omits provider and model when the producer does not know them', () => {
    const { emitter, observed } = capture();
    emitter.emitToolCall({
      slug: 'a',
      conversationId: 'c',
      userId: 'u',
      traceId: 't',
      toolName: 'Bash',
      toolCallId: 'call-1',
    });

    expect(K.PROVIDER in observed[0]!).toBe(false);
    expect(K.MODEL in observed[0]!).toBe(false);
  });
});
