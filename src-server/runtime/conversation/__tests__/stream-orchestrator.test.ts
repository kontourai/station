import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  CHAT_STREAM_KEEPALIVE_INTERVAL_MS,
  createElicitationCallback,
  outwardTurnFailureText,
  startSSEKeepalive,
  writeSSEChunk,
  writeSSEError,
} from '../stream-orchestrator.js';

describe('createElicitationCallback', () => {
  test('binds a managed approval to its conversation for canonical task routing', async () => {
    const register = vi.fn().mockResolvedValue(true);
    const inject = vi.fn();
    const callback = createElicitationCallback(
      { name: 'Reviewer', tools: { autoApprove: [] } } as any,
      new Map(),
      { register } as any,
      { inject } as any,
      { info: vi.fn() },
      () => 'task-approval',
    );

    await expect(
      callback({
        type: 'tool-approval',
        toolName: 'repo_write',
        toolDescription: 'Update a file',
        toolArgs: { path: 'README.md' },
      }),
    ).resolves.toBe(true);

    expect(inject).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool-approval-request',
        toolName: 'repo_write',
      }),
    );
    expect(register).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        metadata: expect.objectContaining({
          conversationId: 'task-approval',
          source: 'runtime',
          title: 'repo_write',
        }),
      }),
    );
  });
});

describe('createElicitationCallback: the Station-agent relay (#2589)', () => {
  async function registeredMetadata(
    conversationId: string,
    orchestrationThreadId?: string,
  ) {
    const register = vi.fn().mockResolvedValue(true);
    const callback = createElicitationCallback(
      { name: 'Reviewer', tools: { autoApprove: [] } } as any,
      new Map(),
      { register } as any,
      { inject: vi.fn() } as any,
      { info: vi.fn() },
      () => conversationId,
      orchestrationThreadId,
    );
    await callback({ type: 'tool-approval', toolName: 'repo_write' });
    return register.mock.calls[0]?.[1]?.metadata;
  }

  test('an approval in the relayed conversation names its orchestration thread', async () => {
    expect(await registeredMetadata('thread-7', 'thread-7')).toMatchObject({
      conversationId: 'thread-7',
      orchestrationThreadId: 'thread-7',
    });
  });

  test('a plain chat, or a relay thread that is not this conversation, names none', async () => {
    expect(await registeredMetadata('c-1')).not.toHaveProperty(
      'orchestrationThreadId',
    );
    expect(await registeredMetadata('c-1', 'thread-7')).not.toHaveProperty(
      'orchestrationThreadId',
    );
  });
});

describe('writeSSEChunk', () => {
  test('resolves in the same macrotask turn as the write — no per-frame event-loop round trip', async () => {
    const writes: string[] = [];
    const streamWriter = {
      write: vi.fn((chunk: string) => {
        writes.push(chunk);
        return Promise.resolve();
      }),
    };

    // Queued BEFORE the call, so it is ahead of anything `writeSSEChunk`
    // could schedule. A `setTimeout` inside the function therefore lands
    // behind this one, and the write only resolves after it fires.
    const order: string[] = [];
    const preQueuedMacrotask = new Promise<void>((resolve) => {
      setTimeout(() => {
        order.push('pre-queued-macrotask');
        resolve();
      }, 0);
    });

    await writeSSEChunk(streamWriter, { type: 'text-delta', text: 'hi' });
    order.push('writeSSEChunk-resolved');
    // Awaited so the timer's entry is actually recorded before the
    // comparison — otherwise the assertion reads a one-element array and
    // passes or fails on the array LENGTH rather than on the ordering.
    await preQueuedMacrotask;

    expect(writes).toEqual(['data: {"type":"text-delta","text":"hi"}\n\n']);
    // The discriminating assertion: awaiting the writer is microtask work,
    // and microtasks drain before the next timer callback. With the removed
    // `await new Promise((r) => setTimeout(r, 0))` this reads
    // ['pre-queued-macrotask', 'writeSSEChunk-resolved'].
    expect(order).toEqual(['writeSSEChunk-resolved', 'pre-queued-macrotask']);
  });

  test('resolves without a CHECK-phase turn either — a setImmediate yield is the same per-frame round trip', async () => {
    // The timer test above does not cover this and neither does the bulk one:
    // `setImmediate` has no 1ms clamp, so a per-frame
    // `await new Promise((r) => setImmediate(r))` finishes 1000 frames well
    // inside the bulk bound, and it resolves ahead of a pre-queued
    // `setTimeout(0)` rather than behind it. Only a pre-queued IMMEDIATE
    // discriminates: an immediate scheduled inside the call is queued behind
    // this one, so the write could not resolve first.
    const streamWriter = { write: () => Promise.resolve() };
    const order: string[] = [];
    const preQueuedImmediate = new Promise<void>((resolve) => {
      setImmediate(() => {
        order.push('pre-queued-immediate');
        resolve();
      });
    });

    await writeSSEChunk(streamWriter, { type: 'text-delta', text: 'hi' });
    order.push('writeSSEChunk-resolved');
    await preQueuedImmediate;

    expect(order).toEqual(['writeSSEChunk-resolved', 'pre-queued-immediate']);
  });

  test('1000 sequential frames cost no event-loop turns — a per-frame setTimeout(0) could not finish this fast', async () => {
    const streamWriter = { write: () => Promise.resolve() };

    const startedAt = Date.now();
    for (let index = 0; index < 1000; index += 1) {
      await writeSSEChunk(streamWriter, { type: 'text-delta', text: index });
    }
    const elapsedMs = Date.now() - startedAt;

    // `setTimeout(0)` is clamped to 1ms, so a per-frame yield puts a hard
    // floor of ~1000ms on this loop regardless of how fast the host is. The
    // bound is 4x below that floor so host load cannot turn a real pass into
    // a red, while no amount of host speed can make the timer version pass.
    expect(elapsedMs).toBeLessThan(250);
  });
});

describe('writeSSEError', () => {
  test('never sends provider stderr, credential URLs, or paths to an SSE client', async () => {
    const writes: string[] = [];
    const streamWriter = {
      write: vi.fn(async (value: string) => writes.push(value)),
    };
    const unsafe =
      'provider stderr https://provider.example.test/private?token=secret /Users/operator/private-key';

    await writeSSEError(streamWriter, new Error(unsafe));

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('The response stream failed.');
    expect(writes[0]).not.toContain('provider.example.test');
    expect(writes[0]).not.toContain('token=secret');
    expect(writes[0]).not.toContain('/Users/operator');
  });

  test('forwards the provider HTTP status as a bare number and nothing the provider said', async () => {
    const { APICallError } = await import('@ai-sdk/provider');
    const writes: string[] = [];
    const streamWriter = {
      write: vi.fn(async (value: string) => writes.push(value)),
    };

    await writeSSEError(
      streamWriter,
      new APICallError({
        message: 'rate limited sk-live-SECRET-1234',
        url: 'https://provider.example.test/v1/chat/completions',
        requestBodyValues: { messages: ['sk-live-SECRET-1234'] },
        statusCode: 429,
        responseBody: '{"error":"sk-live-SECRET-1234"}',
      }),
    );

    expect(JSON.parse(writes[0].replace(/^data: /, ''))).toEqual({
      type: 'error',
      errorText: 'The response stream failed.',
      statusCode: 429,
    });
    expect(writes[0]).not.toContain('sk-live-SECRET');
    expect(writes[0]).not.toContain('provider.example.test');
  });

  test("a status on an error that is not the model provider's is never forwarded", async () => {
    const { HTTPException } = await import('hono/http-exception');
    const writes: string[] = [];
    const streamWriter = {
      write: vi.fn(async (value: string) => writes.push(value)),
    };

    await writeSSEError(streamWriter, new HTTPException(404));
    await writeSSEError(
      streamWriter,
      Object.assign(new Error('route refused'), { status: 429 }),
    );
    await writeSSEError(
      streamWriter,
      Object.assign(new Error('catalog refused'), { statusCode: 503 }),
    );

    expect(
      writes.map((w) => JSON.parse(w.replace(/^data: /, '')).statusCode),
    ).toEqual([undefined, undefined, undefined]);
    expect(outwardTurnFailureText(new HTTPException(404))).toBe(
      'The response stream failed.',
    );
  });

  test('infers a credential 401 only without a provider status, and drops a status outside 4xx/5xx', async () => {
    const writes: string[] = [];
    const streamWriter = {
      write: vi.fn(async (value: string) => writes.push(value)),
    };

    await writeSSEError(streamWriter, new Error('missing credential'));
    await writeSSEError(
      streamWriter,
      Object.assign(new Error('redirected'), { statusCode: 302 }),
    );
    await writeSSEError(streamWriter, new Error('plain failure'));
    // A real provider status wins over a credential-shaped message; the
    // inference applies only when no status exists.
    const { APICallError } = await import('@ai-sdk/provider');
    await writeSSEError(
      streamWriter,
      new APICallError({
        message: 'upstream credential store exploded',
        url: 'https://provider.example.test/v1',
        requestBodyValues: {},
        statusCode: 500,
      }),
    );

    expect(
      writes.map((w) => JSON.parse(w.replace(/^data: /, '')).statusCode),
    ).toEqual([401, undefined, undefined, 500]);
    // Only the inferred 401 says it was inferred.
    expect(
      writes.map((w) => JSON.parse(w.replace(/^data: /, '')).statusInferred),
    ).toEqual([true, undefined, undefined, undefined]);
  });
});

// archive#1207 review round 2, item 3: the keepalive producer's cadence
// and cleanup were previously proven only by inspection (the two watchdog
// suites at the client and adapter layers only ever verify the CONSUMER
// side — that keepalives reset a stall timer). This exercises the
// PRODUCER directly.
describe('startSSEKeepalive (station#1207)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('writes a bare SSE comment keepalive at the configured cadence', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const streamWriter = {
      write: vi.fn((chunk: string) => {
        writes.push(chunk);
        return Promise.resolve();
      }),
    };

    startSSEKeepalive(streamWriter);

    // No write yet — the first keepalive fires only once a full interval
    // has actually elapsed, not immediately on start.
    expect(streamWriter.write).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CHAT_STREAM_KEEPALIVE_INTERVAL_MS);
    expect(writes).toEqual([':ping\n\n']);
    // Deliberately NOT a `data: ` frame — every SSE consumer (this route's
    // own client in `chatRuntimeStream.ts`, browsers' EventSource) ignores
    // a bare comment line with zero parser changes.
    expect(writes[0]).not.toMatch(/^data: /);

    await vi.advanceTimersByTimeAsync(CHAT_STREAM_KEEPALIVE_INTERVAL_MS);
    expect(writes).toEqual([':ping\n\n', ':ping\n\n']);
  });

  test('the returned stop function clears the interval — no keepalives after it is called', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const streamWriter = {
      write: vi.fn((chunk: string) => {
        writes.push(chunk);
        return Promise.resolve();
      }),
    };

    const stop = startSSEKeepalive(streamWriter);
    await vi.advanceTimersByTimeAsync(CHAT_STREAM_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(1);

    stop();

    // Many more intervals' worth of (fake) time passes with no writer
    // activity at all — an uncleared interval would keep firing.
    await vi.advanceTimersByTimeAsync(CHAT_STREAM_KEEPALIVE_INTERVAL_MS * 5);
    expect(writes).toHaveLength(1);
  });

  test('a failed keepalive write is swallowed, never thrown into the caller', async () => {
    vi.useFakeTimers();
    const streamWriter = {
      write: vi.fn(() => Promise.reject(new Error('client gone'))),
    };
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    const stop = startSSEKeepalive(streamWriter);
    try {
      await vi.advanceTimersByTimeAsync(CHAT_STREAM_KEEPALIVE_INTERVAL_MS * 2);
    } finally {
      stop();
      process.off('unhandledRejection', onUnhandledRejection);
    }

    expect(streamWriter.write).toHaveBeenCalledTimes(2);
    expect(unhandledRejections).toEqual([]);
  });
});
