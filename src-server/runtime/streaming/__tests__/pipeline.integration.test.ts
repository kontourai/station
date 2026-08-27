import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, test } from 'vitest';
import { K } from '../../../../src-shared/monitoring-keys.js';
import { MonitoringEmitter } from '../../../monitoring/emitter.js';
import { MetadataHandler } from '../handlers/MetadataHandler.js';
import { ReasoningHandler } from '../handlers/ReasoningHandler.js';
import { TextDeltaHandler } from '../handlers/TextDeltaHandler.js';
import { ToolCallHandler } from '../handlers/ToolCallHandler.js';
import { StreamPipeline } from '../StreamPipeline.js';
import type { StreamChunk } from '../types.js';
import { collect, toStream } from './helpers.js';

describe('StreamPipeline Integration', () => {
  let pipeline: StreamPipeline;
  let metadataHandler: MetadataHandler;

  beforeEach(() => {
    metadataHandler = new MetadataHandler();
    pipeline = new StreamPipeline()
      .use(new ReasoningHandler({ enableThinking: true }))
      .use(new TextDeltaHandler())
      .use(new ToolCallHandler())
      .use(metadataHandler);
  });

  test('processes simple text response', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-start', id: '0' } as StreamChunk,
      { type: 'text-delta', id: '0', text: 'Hello ' } as unknown as StreamChunk,
      { type: 'text-delta', id: '0', text: 'world' } as unknown as StreamChunk,
      { type: 'text-end', id: '0' } as StreamChunk,
    ];

    const result = await collect(pipeline.run(toStream(chunks)));
    const textDeltas = result.filter((c) => c.type === 'text-delta');
    expect(textDeltas.length).toBeGreaterThan(0);
    // Verify all text content is present
    const text = textDeltas.map((c) => (c as any).text).join('');
    expect(text).toBe('Hello world');
  });

  test('processes response with thinking blocks', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-start', id: '0' } as StreamChunk,
      {
        type: 'text-delta',
        id: '0',
        text: '<thinking>',
      } as unknown as StreamChunk,
      {
        type: 'text-delta',
        id: '0',
        text: 'internal thought',
      } as unknown as StreamChunk,
      {
        type: 'text-delta',
        id: '0',
        text: '</thinking>',
      } as unknown as StreamChunk,
      {
        type: 'text-delta',
        id: '0',
        text: 'response',
      } as unknown as StreamChunk,
      { type: 'text-end', id: '0' } as StreamChunk,
    ];

    const result = await collect(pipeline.run(toStream(chunks)));
    expect(result.some((c) => c.type === 'reasoning-start')).toBe(true);
    expect(result.some((c) => c.type === 'reasoning-delta')).toBe(true);
    expect(result.some((c) => c.type === 'reasoning-end')).toBe(true);
    expect(result.some((c) => c.type === 'text-delta')).toBe(true);
  });

  test('processes response with tool calls', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-start', id: '0' } as StreamChunk,
      {
        type: 'text-delta',
        id: '0',
        text: 'Using tool...',
      } as unknown as StreamChunk,
      { type: 'text-end', id: '0' } as StreamChunk,
      {
        type: 'tool-call',
        toolCallId: '1',
        toolName: 'test_tool',
        args: { arg: 'val' },
      } as unknown as StreamChunk,
    ];

    const result = await collect(pipeline.run(toStream(chunks)));
    expect(result.some((c) => c.type === 'text-delta')).toBe(true);
    expect(result.some((c) => c.type === 'tool-call')).toBe(true);
  });

  test('emits tool outcomes only from explicit station-engine stream signals', async () => {
    const persisted: Record<string, unknown>[] = [];
    const monitoringEmitter = new MonitoringEmitter(
      new EventEmitter(),
      async (event) => {
        persisted.push(event);
      },
    );
    const handler = new MetadataHandler(
      undefined,
      {
        slug: 'station',
        conversationId: 'conversation-1',
        userId: 'user-1',
        traceId: 'trace-1',
      },
      monitoringEmitter,
    );

    await collect(
      handler.process(
        toStream([
          {
            type: 'tool-result',
            toolName: 'failed_tool',
            toolCallId: 'error-1',
            error: 'denied',
          },
          {
            type: 'tool-result',
            toolName: 'successful_tool',
            toolCallId: 'success-1',
            status: 'success',
            output: 'ok',
          },
          {
            type: 'tool-result',
            toolName: 'legacy_tool',
            toolCallId: 'unknown-1',
            output: { arbitrary: 'result' },
          },
        ] as StreamChunk[]),
      ),
    );
    await monitoringEmitter.flush();

    expect(persisted.map((event) => event[K.TOOL_CALL_OUTCOME])).toEqual([
      'error',
      'success',
      undefined,
    ]);
  });

  test('processes mixed content: text + thinking + tool calls', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-start', id: '0' } as StreamChunk,
      { type: 'text-delta', id: '0', text: 'Start ' } as unknown as StreamChunk,
      {
        type: 'text-delta',
        id: '0',
        text: '<thinking>',
      } as unknown as StreamChunk,
      { type: 'text-delta', id: '0', text: 'plan' } as unknown as StreamChunk,
      {
        type: 'text-delta',
        id: '0',
        text: '</thinking>',
      } as unknown as StreamChunk,
      {
        type: 'text-delta',
        id: '0',
        text: 'middle ',
      } as unknown as StreamChunk,
      { type: 'text-end', id: '0' } as StreamChunk,
      {
        type: 'tool-call',
        toolCallId: '1',
        toolName: 'tool',
        args: {},
      } as unknown as StreamChunk,
      { type: 'text-start', id: '1' } as StreamChunk,
      { type: 'text-delta', id: '1', text: 'end' } as unknown as StreamChunk,
      { type: 'text-end', id: '1' } as StreamChunk,
    ];

    const result = await collect(pipeline.run(toStream(chunks)));
    expect(result.length).toBeGreaterThan(0);

    const stats = metadataHandler.finalize();
    expect(stats.textChunks).toBeGreaterThan(0);
    expect(stats.reasoningBlocks).toBe(1);
    expect(stats.toolCalls).toBe(1);
  });

  test('handles tag split across chunks', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-start', id: '0' } as StreamChunk,
      { type: 'text-delta', id: '0', text: '<thin' } as unknown as StreamChunk,
      { type: 'text-delta', id: '0', text: 'king>' } as unknown as StreamChunk,
      {
        type: 'text-delta',
        id: '0',
        text: 'thought',
      } as unknown as StreamChunk,
      {
        type: 'text-delta',
        id: '0',
        text: '</think',
      } as unknown as StreamChunk,
      { type: 'text-delta', id: '0', text: 'ing>' } as unknown as StreamChunk,
      { type: 'text-end', id: '0' } as StreamChunk,
    ];

    const result = await collect(pipeline.run(toStream(chunks)));
    expect(result.some((c) => c.type === 'reasoning-start')).toBe(true);
    expect(result.some((c) => c.type === 'reasoning-end')).toBe(true);
  });
});

describe('MetadataHandler tool-event truthfulness (#3073, #3074)', () => {
  const run = async (
    chunks: StreamChunk[],
    context?: Record<string, string | undefined>,
  ) => {
    const persisted: Record<string, unknown>[] = [];
    const emitter = new MonitoringEmitter(new EventEmitter(), async (event) => {
      persisted.push(event as Record<string, unknown>);
    });
    const handler = new MetadataHandler(
      undefined,
      {
        slug: 'station',
        conversationId: 'c',
        userId: 'u',
        traceId: 't',
        ...context,
      },
      emitter,
    );
    await collect(handler.process(toStream(chunks)));
    await emitter.flush();
    return persisted;
  };

  test('omits the tool name at the HANDLER, not just the emitter (#3073)', async () => {
    // This is the site the issue names. The emitter-level test passes even
    // with `chunk.toolName || 'unknown'` restored here, because the handler
    // would simply hand a string down — so without this, the fix at the
    // producer has no test power at all.
    const persisted = await run([
      { type: 'tool-call', toolCallId: 'call-1' } as unknown as StreamChunk,
    ]);

    expect(persisted).toHaveLength(1);
    expect(K.TOOL_NAME in persisted[0]!).toBe(false);
    expect(JSON.stringify(persisted[0])).not.toContain('unknown');
  });

  test('an empty tool name is an absence too, not a value', async () => {
    // Reachable in production: strands-stream-events builds tool-result
    // chunks as `toolName: result?.toolUseId || ''`.
    const persisted = await run([
      {
        type: 'tool-result',
        toolCallId: 'call-2',
        toolName: '',
      } as unknown as StreamChunk,
    ]);

    expect(K.TOOL_NAME in persisted[0]!).toBe(false);
  });

  test('resolves a result name from its call, and records duration (#3082, #3077)', async () => {
    // Strands sends tool-result events carrying only the call id. That id
    // used to be copied into the tool-name field, putting raw ids into every
    // tool-name rollup; now the name comes from the call the handler already
    // remembers, and the elapsed time lands ON the event rather than only in
    // an OTel histogram that is a no-op without an exporter endpoint.
    const persisted = await run([
      {
        type: 'tool-call',
        toolName: 'read_file',
        toolCallId: 'call-9',
      } as unknown as StreamChunk,
      {
        type: 'tool-result',
        toolCallId: 'call-9',
        status: 'success',
        output: 'ok',
      } as unknown as StreamChunk,
    ]);

    const result = persisted.find(
      (event) =>
        event[K.SPAN_KIND] === 'end' && event[K.TOOL_CALL_ID] === 'call-9',
    );
    expect(result?.[K.TOOL_NAME]).toBe('read_file');
    expect(typeof result?.[K.TOOL_DURATION_MS]).toBe('number');
  });

  test("an orphan result cannot inherit the previous result's name or duration", async () => {
    // The reset that makes this true had no coverage: the orphan test below
    // builds a FRESH handler with a single chunk, so the field is undefined
    // from construction and carryover is never exercised. Without the reset,
    // result B inherits A's tool name AND A's elapsed time — a fabricated
    // latency attributed to the wrong tool, which is the exact
    // label-vs-derivation class this batch exists to close.
    const persisted = await run([
      {
        type: 'tool-call',
        toolName: 'read_file',
        toolCallId: 'call-A',
      } as unknown as StreamChunk,
      {
        type: 'tool-result',
        toolCallId: 'call-A',
        status: 'success',
        output: 'ok',
      } as unknown as StreamChunk,
      {
        type: 'tool-result',
        toolCallId: 'orphan-B',
        status: 'success',
        output: 'ok',
      } as unknown as StreamChunk,
    ]);

    const orphan = persisted.find(
      (event) => event[K.TOOL_CALL_ID] === 'orphan-B',
    );
    expect(orphan).toBeDefined();
    expect(K.TOOL_NAME in orphan!).toBe(false);
    expect(K.TOOL_DURATION_MS in orphan!).toBe(false);
  });

  test('does not invent a result name when there was no call to learn it from', async () => {
    const persisted = await run([
      {
        type: 'tool-result',
        toolCallId: 'orphan-1',
        status: 'success',
      } as unknown as StreamChunk,
    ]);

    expect(K.TOOL_NAME in persisted[0]!).toBe(false);
  });

  test('carries the engine and model onto Station-engine tool events (#3074)', async () => {
    const persisted = await run(
      [
        {
          type: 'tool-call',
          toolName: 'read_file',
          toolCallId: 'call-3',
        } as unknown as StreamChunk,
        {
          type: 'tool-result',
          toolName: 'read_file',
          toolCallId: 'call-3',
          status: 'success',
          output: 'ok',
        } as unknown as StreamChunk,
      ],
      { provider: 'station', model: 'claude-sonnet-5' },
    );

    expect(persisted.length).toBeGreaterThanOrEqual(2);
    for (const event of persisted) {
      expect(event[K.PROVIDER]).toBe('station');
      expect(event[K.MODEL]).toBe('claude-sonnet-5');
    }
  });
});
