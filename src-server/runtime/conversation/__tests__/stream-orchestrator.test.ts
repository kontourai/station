import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  CHAT_STREAM_KEEPALIVE_INTERVAL_MS,
  createElicitationCallback,
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
