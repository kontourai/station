import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DelegatedTaskSnapshot } from '@kontourai/station-sdk/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from 'vitest';
import { waitOnDelegatedTask } from '../commands/delegate.js';
import { readBody } from './helpers/http-test-helpers.js';

/**
 * `station delegate wait` (#2264) — bounded, observation-only completion
 * waiting. Two layers, mirroring delegate.test.ts's split:
 *
 * 1. `waitOnDelegatedTask` pure-loop tests with an injected clock, sleep,
 *    observe, and AbortSignal — deterministic polling sequences, honest
 *    outcome classification, per-observation budget bounding, child-Session
 *    change tracking, Ctrl-C cleanup, and zero/invalid duration refusal.
 * 2. End-to-end `runCli` tests against a real `http.createServer` mock —
 *    including a proof that waiting issues NO mutating delegation call
 *    (no create/continue/respond/interrupt ever reaches the wire), a 500
 *    observation loss, and a hung read bounded by the remaining wait budget.
 */

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function snapshot(
  status: string,
  overrides: Record<string, unknown> = {},
): DelegatedTaskSnapshot {
  return {
    conversationId: 'conversation:w',
    taskId: 'task:w',
    sessionId: 'session:w',
    currentSessionId: 'session:w',
    status,
    environment: {
      id: 'env-current',
      name: 'Current environment',
      kind: 'current',
    },
    target: { kind: 'agent', id: 'default' },
    eventCount: 0,
    canInterrupt: true,
    resumable: true,
    ...overrides,
  } as unknown as DelegatedTaskSnapshot;
}

describe('waitOnDelegatedTask (pure loop)', () => {
  test('returns immediately when the first observation is completed', async () => {
    const observe = vi.fn(async () => snapshot('completed'));
    const result = await waitOnDelegatedTask({
      taskId: 'task:w',
      timeoutMs: 10_000,
      intervalMs: 1_000,
      deps: { observe },
    });
    expect(result.outcome).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.pollCount).toBe(1);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  test('polls a deterministic running→running→completed sequence at the interval', async () => {
    const clock = fakeClock();
    const script = [
      snapshot('running'),
      snapshot('running'),
      snapshot('completed'),
    ];
    const budgets: number[] = [];
    const observe = vi.fn(async (budgetMs: number) => {
      budgets.push(budgetMs);
      return script.shift() ?? snapshot('running');
    });
    const result = await waitOnDelegatedTask({
      taskId: 'task:w',
      timeoutMs: 10_000,
      intervalMs: 3_000,
      deps: { observe, now: clock.now, sleep: async (ms) => clock.advance(ms) },
    });
    expect(result.outcome).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.pollCount).toBe(3);
    expect(result.elapsedMs).toBe(6_000);
    expect(result.conversationId).toBe('conversation:w');
    expect(result.currentSessionId).toBe('session:w');
  });

  test('per-observation budgets never exceed the remaining wait budget', async () => {
    const clock = fakeClock();
    const budgets: number[] = [];
    const observe = vi.fn(async (budgetMs: number) => {
      budgets.push(budgetMs);
      clock.advance(0);
      return snapshot('running');
    });
    const result = await waitOnDelegatedTask({
      taskId: 'task:w',
      timeoutMs: 10_000,
      intervalMs: 4_000,
      deps: { observe, now: clock.now, sleep: async (ms) => clock.advance(ms) },
    });
    // Active progress the whole way, then the FIXED observer deadline ends
    // the wait — the task is still running and that is what is reported.
    expect(result.outcome).toBe('wait-timeout');
    expect(result.exitCode).toBe(5);
    expect(result.status).toBe('running');
    // t=0 budget 10000, t=4000 budget 6000, t=8000 budget 2000; the final
    // sleep is clamped to the 2000ms that remain.
    expect(budgets).toEqual([10_000, 6_000, 2_000]);
    expect(result.pollCount).toBe(3);
    expect(result.elapsedMs).toBe(10_000);
  });

  test.each([
    ['failed', 3],
    ['canceled', 3],
  ] as const)(
    'terminal provider status %s exits %i and is not laundered into success',
    async (status, exitCode) => {
      const observe = vi.fn(async () => snapshot(status));
      const result = await waitOnDelegatedTask({
        taskId: 'task:w',
        timeoutMs: 10_000,
        intervalMs: 1_000,
        deps: { observe },
      });
      expect(result.outcome).toBe('failed');
      expect(result.exitCode).toBe(exitCode);
      expect(result.status).toBe(status);
    },
  );

  test('a pending request is needs-action (exit 4), never completed work', async () => {
    const observe = vi.fn(async () =>
      snapshot('needs_input', {
        pendingRequest: {
          id: 'req-1',
          title: 'Allow write?',
          type: 'approval',
        },
      }),
    );
    const result = await waitOnDelegatedTask({
      taskId: 'task:w',
      timeoutMs: 10_000,
      intervalMs: 1_000,
      deps: { observe },
    });
    expect(result.outcome).toBe('needs-action');
    expect(result.exitCode).toBe(4);
    expect(result.pendingRequest).toMatchObject({ id: 'req-1' });
  });

  test('an unknown (or unclassifiable) status is exit 6, not completion or failure', async () => {
    for (const status of ['unknown', 'some-future-status']) {
      const observe = vi.fn(async () => snapshot(status));
      const result = await waitOnDelegatedTask({
        taskId: 'task:w',
        timeoutMs: 10_000,
        intervalMs: 1_000,
        deps: { observe },
      });
      expect(result.outcome).toBe('unknown');
      expect(result.exitCode).toBe(6);
      expect(result.status).toBe(status);
    }
  });

  test('a child Session change mid-wait keeps waiting and reports both identifiers', async () => {
    const clock = fakeClock();
    const script = [
      snapshot('running'),
      snapshot('running', {
        sessionId: 'session:child-2',
        currentSessionId: 'session:child-2',
      }),
      snapshot('completed', {
        sessionId: 'session:child-2',
        currentSessionId: 'session:child-2',
      }),
    ];
    const observe = vi.fn(async () => script.shift() ?? snapshot('completed'));
    const result = await waitOnDelegatedTask({
      taskId: 'task:w',
      timeoutMs: 10_000,
      intervalMs: 1_000,
      deps: { observe, now: clock.now, sleep: async (ms) => clock.advance(ms) },
    });
    expect(result.outcome).toBe('completed');
    expect(result.sessionChanged).toBe(true);
    expect(result.previousSessionId).toBe('session:w');
    expect(result.currentSessionId).toBe('session:child-2');
    expect(result.pollCount).toBe(3);
  });

  test('an observation failure is observation-lost (exit 2), never a task failure', async () => {
    const observe = vi.fn(async (budget: number) => {
      if (budget < 10_000) throw new Error('socket hang up');
      return snapshot('running');
    });
    const clock = fakeClock();
    const result = await waitOnDelegatedTask({
      taskId: 'task:w',
      timeoutMs: 10_000,
      intervalMs: 1_000,
      deps: { observe, now: clock.now, sleep: async (ms) => clock.advance(ms) },
    });
    expect(result.outcome).toBe('observation-lost');
    expect(result.exitCode).toBe(2);
    expect(result.lastError).toBe('socket hang up');
    // The last GOOD observation is preserved and NOT reclassified.
    expect(result.status).toBe('running');
    expect(result.currentSessionId).toBe('session:w');
  });

  test('a cooperative abort during a poll sleep exits 130 without another observation', async () => {
    const controller = new AbortController();
    const observe = vi.fn(async () => snapshot('running'));
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        if (controller.signal.aborted) {
          resolve();
          return;
        }
        controller.signal.addEventListener('abort', () => resolve(), {
          once: true,
        });
        void ms;
      });
    const pending = waitOnDelegatedTask({
      taskId: 'task:w',
      timeoutMs: 10_000,
      intervalMs: 1_000,
      deps: { observe, sleep, signal: controller.signal },
    });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    const result = await pending;
    expect(result.outcome).toBe('interrupted');
    expect(result.exitCode).toBe(130);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('running');
  });

  test('budget expiry with no successful observation is observation-lost, not wait-timeout', async () => {
    const clock = fakeClock();
    const observe = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await waitOnDelegatedTask({
      taskId: 'task:w',
      timeoutMs: 5_000,
      intervalMs: 1_000,
      deps: { observe, now: clock.now, sleep: async (ms) => clock.advance(ms) },
    });
    expect(result.outcome).toBe('observation-lost');
    expect(result.exitCode).toBe(2);
    expect(result.status).toBeUndefined();
    expect(result.lastError).toBe('ECONNREFUSED');
  });
});

describe('station delegate wait over HTTP', () => {
  let server: ReturnType<typeof createServer>;
  let apiBase = '';
  let consoleLog: MockInstance;
  let stderrWrite: MockInstance;
  const requests: Array<{ method: string; pathname: string }> = [];
  let statusQueue: string[] = [];
  let hangStatusReads = false;
  let failStatusReads: number | null = null;
  let hungResponses: Array<{ destroy: () => void }> = [];

  beforeEach(async () => {
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    requests.length = 0;
    statusQueue = [];
    hangStatusReads = false;
    failStatusReads = null;
    hungResponses = [];

    server = createServer((req, res) => {
      const method = req.method || 'GET';
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      requests.push({ method, pathname: url.pathname });
      const sendJson = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (
        method === 'GET' &&
        /^\/api\/orchestration\/delegations\/[^/]+$/.test(url.pathname)
      ) {
        if (hangStatusReads) {
          // Never respond and never end: a hung read the wait budget must bound.
          hungResponses.push({ destroy: () => res.destroy() });
          return;
        }
        if (failStatusReads !== null) {
          sendJson(failStatusReads, { success: false, error: 'boom' });
          return;
        }
        const status = statusQueue.shift() ?? 'running';
        sendJson(200, {
          success: true,
          data: {
            taskId: 'task:w',
            conversationId: 'conversation:w',
            sessionId: 'session:w',
            currentSessionId: 'session:w',
            status,
            environment: {
              id: 'env-current',
              name: 'Current environment',
              kind: 'current',
            },
            target: { kind: 'agent', id: 'default' },
            eventCount: 0,
            canInterrupt: true,
            resumable: status === 'running',
          },
        });
        return;
      }
      void readBody(req).catch(() => {});
      sendJson(404, { success: false, error: 'Unhandled route' });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address() as AddressInfo;
    apiBase = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const hung of hungResponses) hung.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    vi.restoreAllMocks();
  });

  test('waits for completion, emits one clean JSON envelope, and issues NO mutating delegation call', async () => {
    statusQueue = ['running', 'completed'];
    const { runCli } = await import('../cli.js');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    await expect(
      runCli([
        'delegate',
        'wait',
        'task:w',
        '--interval=1',
        '--timeout=10',
        '--json',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow('exit');

    expect(exit).toHaveBeenCalledWith(0);
    expect(consoleLog).toHaveBeenCalledTimes(1);
    const printed = consoleLog.mock.calls.map((call) => call[0]).join('\n');
    const payload = JSON.parse(printed);
    expect(payload).toMatchObject({
      ok: true,
      kind: 'delegate.wait',
      data: {
        outcome: 'completed',
        exitCode: 0,
        taskId: 'task:w',
        conversationId: 'conversation:w',
        currentSessionId: 'session:w',
        status: 'completed',
      },
    });
    // The observation-only proof: every request this run made was a GET of
    // the one status route. No create, continue, respond, or interrupt call
    // ever reached the wire.
    expect(requests.length).toBeGreaterThanOrEqual(1);
    for (const request of requests) {
      expect(request.method).toBe('GET');
      expect(request.pathname).toBe('/api/orchestration/delegations/task%3Aw');
    }
    // No human progress text was mixed into stdout under --json.
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  test('a 500 while polling is observation-lost exit 2 and explicitly not a task failure', async () => {
    failStatusReads = 500;
    const { runCli } = await import('../cli.js');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    await expect(
      runCli(['delegate', 'wait', 'task:w', '--json', `--api-base=${apiBase}`]),
    ).rejects.toThrow('exit');

    expect(exit).toHaveBeenCalledWith(2);
    const payload = JSON.parse(consoleLog.mock.calls[0][0] as string);
    expect(payload.ok).toBe(false);
    expect(payload.data.outcome).toBe('observation-lost');
    expect(payload.data.status).toBeUndefined();
    expect(payload.data.lastError).toMatch(/boom|Delegation API error/);
  });

  test('a hung status read is bounded by the remaining wait budget, not left unbounded', async () => {
    hangStatusReads = true;
    const { runCli } = await import('../cli.js');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const startedAt = Date.now();

    await expect(
      runCli([
        'delegate',
        'wait',
        'task:w',
        '--timeout=1',
        '--interval=1',
        '--json',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow('exit');

    const elapsed = Date.now() - startedAt;
    // Bounded: without the per-read budget this fetch would hang far longer
    // than the 1s wait budget the caller asked for.
    expect(elapsed).toBeLessThan(15_000);
    expect(exit).toHaveBeenCalledWith(2);
    const payload = JSON.parse(consoleLog.mock.calls[0][0] as string);
    expect(payload.data.outcome).toBe('observation-lost');
    expect(payload.data.elapsedMs).toBeLessThan(15_000);
  });

  test('human output explains a wait timeout leaves the task running, and reuses the status projection', async () => {
    statusQueue = ['running'];
    const { runCli } = await import('../cli.js');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    await expect(
      runCli([
        'delegate',
        'wait',
        'task:w',
        '--timeout=1',
        '--interval=1',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow('exit');

    expect(exit).toHaveBeenCalledWith(5);
    const printed = consoleLog.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('Wait deadline reached');
    expect(printed).toContain('still active');
    expect(printed).toContain('keeps running');
    // The safe status projection (never raw provider logs) is reused.
    expect(printed).toContain('Task task:w: running');
    expect(printed).toContain('Current environment');
    // Progress went to stderr, not stdout.
    expect(stderrWrite).toHaveBeenCalled();
  });

  test('zero, malformed, nonfinite, and out-of-range durations are usage errors before any request', async () => {
    const { runCli } = await import('../cli.js');
    for (const flag of [
      '--timeout=0',
      '--timeout=abc',
      '--timeout=1.5',
      '--timeout=-5',
      '--timeout=Infinity',
      '--timeout=NaN',
      '--timeout=86401',
      '--interval=0',
      '--interval=abc',
      '--interval=1e3',
      '--interval=3601',
    ]) {
      await expect(
        runCli(['delegate', 'wait', 'task:w', flag, `--api-base=${apiBase}`]),
      ).rejects.toThrow(
        /must be a positive whole number of seconds|must be between/,
      );
    }
    // Refusal happened before a single HTTP request.
    expect(requests).toEqual([]);
  });

  test('Ctrl-C (SIGINT) wiring cleans up its listener; the task is reported unaffected', async () => {
    statusQueue = ['completed'];
    const { runCli } = await import('../cli.js');
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const listenersBefore = process.listenerCount('SIGINT');

    await expect(
      runCli(['delegate', 'wait', 'task:w', '--json', `--api-base=${apiBase}`]),
    ).rejects.toThrow('exit');

    expect(process.listenerCount('SIGINT')).toBe(listenersBefore);
    const payload = JSON.parse(consoleLog.mock.calls[0][0] as string);
    expect(payload.data.outcome).toBe('completed');
  });
});
