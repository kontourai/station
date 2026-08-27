import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createElicitationCallback,
  SSE_KEEPALIVE_INTERVAL_MS,
  startSSEKeepalive,
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

// station#1207 review round 2, item 3: the keepalive producer's cadence
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

    await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toEqual([':ping\n\n']);
    // Deliberately NOT a `data: ` frame — every SSE consumer (this route's
    // own client in `chatRuntimeStream.ts`, browsers' EventSource) ignores
    // a bare comment line with zero parser changes.
    expect(writes[0]).not.toMatch(/^data: /);

    await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE_INTERVAL_MS);
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
    await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(1);

    stop();

    // Many more intervals' worth of (fake) time passes with no writer
    // activity at all — an uncleared interval would keep firing.
    await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE_INTERVAL_MS * 5);
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
      await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE_INTERVAL_MS * 2);
    } finally {
      stop();
      process.off('unhandledRejection', onUnhandledRejection);
    }

    expect(streamWriter.write).toHaveBeenCalledTimes(2);
    expect(unhandledRejections).toEqual([]);
  });
});
