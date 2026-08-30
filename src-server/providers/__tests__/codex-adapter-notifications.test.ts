import { PassThrough, Writable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import type { ProviderSession } from '../../providers/adapter-shape.js';
import { adapterTurnDuration } from '../../telemetry/metrics.js';
import { handleCodexNotification } from '../adapters/codex-adapter-notifications.js';
import type { CodexSessionRecord } from '../adapters/codex-adapter-types.js';

class FakeWritable extends Writable {
  _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }
}

function buildRecord(
  overrides: Partial<CodexSessionRecord> = {},
): CodexSessionRecord {
  const session: ProviderSession = {
    provider: 'codex',
    threadId: 'thread-1',
    status: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  return {
    externalThreadId: 'thread-1',
    codexThreadId: 'codex-thread-1',
    process: {
      stdin: new FakeWritable(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: () => true,
      on() {
        return this as any;
      },
      once() {
        return this as any;
      },
      removeListener() {
        return this as any;
      },
    },
    session,
    rpcRequestCounter: 0,
    pendingRpcRequests: new Map(),
    pendingApprovals: new Map(),
    lastSessionState: 'idle',
    turnOutput: new Map(),
    toolNames: new Map(),
    toolStarted: new Set(),
    stopped: false,
    ...overrides,
  };
}

describe('codex-adapter-notifications', () => {
  test('drops malformed token figures at the Codex notification boundary', () => {
    const events: any[] = [];

    handleCodexNotification({
      record: buildRecord(),
      notification: {
        method: 'thread/tokenUsage/updated',
        params: {
          turnId: 'turn-1',
          tokenUsage: {
            total: {
              inputTokens: Number.POSITIVE_INFINITY,
              outputTokens: -1,
              totalTokens: 9,
              cachedInputTokens: 2,
            },
          },
        },
      },
      nowIso: () => '2026-01-02T00:00:00.000Z',
      publish: (event) => events.push(event),
    });

    expect(events).toEqual([
      expect.objectContaining({
        method: 'token-usage.updated',
        totalTokens: 9,
        cacheReadTokens: 2,
      }),
    ]);
    expect(events[0].promptTokens).toBeUndefined();
    expect(events[0].completionTokens).toBeUndefined();
  });

  test('updates session state and emits state change events', () => {
    const record = buildRecord();
    const events: any[] = [];

    handleCodexNotification({
      record,
      notification: {
        method: 'thread/status/changed',
        params: {
          threadId: 'codex-thread-1',
          status: { type: 'active', activeFlags: [] },
        },
      },
      nowIso: () => '2026-01-02T00:00:00.000Z',
      publish: (event) => events.push(event),
    });

    expect(record.lastSessionState).toBe('running');
    expect(record.session.status).toBe('running');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: 'session.state-changed',
      from: 'idle',
      to: 'running',
    });
  });

  test('tracks tool lifecycle and turn completion output', () => {
    const record = buildRecord({
      activeTurnId: 'turn-1',
      activeTurnStartedAt: Date.now() - 10,
      turnOutput: new Map([['turn-1', 'Done.']]),
    });
    const events: any[] = [];

    handleCodexNotification({
      record,
      notification: {
        method: 'item/started',
        params: {
          turnId: 'turn-1',
          item: {
            id: 'tool-1',
            type: 'commandExecution',
            command: 'ls',
            cwd: '/tmp/project',
          },
        },
      },
      nowIso: () => '2026-01-02T00:00:00.000Z',
      publish: (event) => events.push(event),
    });

    handleCodexNotification({
      record,
      notification: {
        method: 'item/completed',
        params: {
          turnId: 'turn-1',
          item: {
            id: 'tool-1',
            type: 'commandExecution',
            command: 'ls',
            cwd: '/tmp/project',
            status: 'completed',
            aggregatedOutput: 'file-a\n',
            exitCode: 0,
            durationMs: 12,
          },
        },
      },
      nowIso: () => '2026-01-02T00:00:01.000Z',
      publish: (event) => events.push(event),
    });

    handleCodexNotification({
      record,
      notification: {
        method: 'turn/completed',
        params: {
          turn: {
            id: 'turn-1',
            status: 'completed',
          },
        },
      },
      nowIso: () => '2026-01-02T00:00:02.000Z',
      publish: (event) => events.push(event),
    });

    expect(record.toolStarted.has('tool-1')).toBe(false);
    expect(record.activeTurnId).toBeUndefined();
    expect(record.session.status).toBe('ready');
    expect(record.session.resumeCursor).toEqual({
      codexThreadId: 'codex-thread-1',
      turnId: 'turn-1',
    });
    expect(events.map((event) => event.method)).toEqual([
      'tool.started',
      'tool.completed',
      'turn.completed',
    ]);
    expect(events[2]).toMatchObject({
      outputText: 'Done.',
      finishReason: 'stop',
    });
  });

  // archive#3442: the Codex app-server reports a genuinely failed turn (e.g.
  // hitting the usage limit mid-turn) through the SAME `turn/completed`
  // notification as a success — the real signal is `turn.status === 'failed'`
  // (protocol: completed | interrupted | failed | inProgress; confirmed via
  // `codex app-server generate-json-schema`'s `TurnStatus`/`Turn.error`
  // definitions), with `turn.error` populated only then. Before this fix, the
  // handler unconditionally published `turn.completed` (via
  // `mapTurnFinishReason` collapsing `failed` into `'other'`), which the
  // session-lifecycle projector folds to 'completed'.
  test('a failed turn publishes runtime.error, not turn.completed', () => {
    const record = buildRecord({
      activeTurnId: 'turn-1',
      activeTurnStartedAt: Date.now() - 10,
      turnOutput: new Map([['turn-1', '']]),
    });
    const events: any[] = [];

    handleCodexNotification({
      record,
      notification: {
        method: 'turn/completed',
        params: {
          turn: {
            id: 'turn-1',
            status: 'failed',
            error: {
              message: "You've hit your usage limit.",
              codexErrorInfo: 'usageLimitExceeded',
            },
          },
        },
      },
      nowIso: () => '2026-01-02T00:00:02.000Z',
      publish: (event) => events.push(event),
    });

    expect(record.activeTurnId).toBeUndefined();
    expect(events.map((event) => event.method)).toEqual(['runtime.error']);
    expect(events[0]).toMatchObject({
      method: 'runtime.error',
      severity: 'error',
      turnId: 'turn-1',
      message: "You've hit your usage limit.",
      details: { codexErrorInfo: 'usageLimitExceeded' },
    });
  });

  // archive#3451 finding 3: `retryEligible` disagreed between the board
  // (crude `lifecycleState === 'failed'`) and the run
  // (`classifyAgentRunFailure` reading `unknown` because this event carried
  // no `code`/`retriable`). `turn.status === 'failed'` is codex's own final
  // word on the turn — the opposite of `willRetry` — so `retriable: false`
  // is a real fact, and `code` is a plain passthrough of `codexErrorInfo`.
  test('a failed turn sets retriable: false and passes codexErrorInfo through as code', () => {
    const record = buildRecord({
      activeTurnId: 'turn-1',
      activeTurnStartedAt: Date.now() - 10,
      turnOutput: new Map([['turn-1', '']]),
    });
    const events: any[] = [];

    handleCodexNotification({
      record,
      notification: {
        method: 'turn/completed',
        params: {
          turn: {
            id: 'turn-1',
            status: 'failed',
            error: {
              message: "You've hit your usage limit.",
              codexErrorInfo: 'usageLimitExceeded',
            },
          },
        },
      },
      nowIso: () => '2026-01-02T00:00:02.000Z',
      publish: (event) => events.push(event),
    });

    expect(events[0]).toMatchObject({
      method: 'runtime.error',
      retriable: false,
      code: 'usageLimitExceeded',
    });
  });

  // Negative control: a failure with no codexErrorInfo does not fabricate a
  // code — retriable: false is still set (a real fact from turn.status).
  test('a failed turn with no codexErrorInfo sets retriable: false and no code', () => {
    const record = buildRecord({
      activeTurnId: 'turn-1',
      activeTurnStartedAt: Date.now() - 10,
      turnOutput: new Map([['turn-1', '']]),
    });
    const events: any[] = [];

    handleCodexNotification({
      record,
      notification: {
        method: 'turn/completed',
        params: {
          turn: {
            id: 'turn-1',
            status: 'failed',
            error: { message: 'Something went wrong.' },
          },
        },
      },
      nowIso: () => '2026-01-02T00:00:02.000Z',
      publish: (event) => events.push(event),
    });

    expect(events[0]).toMatchObject({
      method: 'runtime.error',
      retriable: false,
    });
    expect(events[0]).not.toHaveProperty('code');
  });

  // Negative control: an interrupted (not failed) turn keeps publishing an
  // ordinary turn.completed — only `status: 'failed'` takes the new branch.
  test('an interrupted turn still publishes turn.completed with finishReason cancelled', () => {
    const record = buildRecord({
      activeTurnId: 'turn-1',
      activeTurnStartedAt: Date.now() - 10,
      turnOutput: new Map([['turn-1', '']]),
    });
    const events: any[] = [];

    handleCodexNotification({
      record,
      notification: {
        method: 'turn/completed',
        params: {
          turn: { id: 'turn-1', status: 'interrupted' },
        },
      },
      nowIso: () => '2026-01-02T00:00:02.000Z',
      publish: (event) => events.push(event),
    });

    expect(events.map((event) => event.method)).toEqual(['turn.completed']);
    expect(events[0]).toMatchObject({ finishReason: 'cancelled' });
  });

  // archive#3473 fix round: a successful turn/completed ALWAYS marks the
  // terminal published, so a concurrent stopSession/process-exit synthesis
  // never double-publishes for this turn.
  test('a successful turn/completed marks terminalPublishedForTurnId', () => {
    const record = buildRecord({
      activeTurnId: 'turn-1',
      activeTurnStartedAt: Date.now() - 10,
      turnOutput: new Map([['turn-1', '']]),
    });

    handleCodexNotification({
      record,
      notification: {
        method: 'turn/completed',
        params: { turn: { id: 'turn-1', status: 'completed' } },
      },
      nowIso: () => '2026-01-02T00:00:02.000Z',
      publish: () => {},
    });

    expect(record.terminalPublishedForTurnId).toBe('turn-1');
  });

  // archive#3451 fix round D8: a LATE turn/completed for turn-1 arriving
  // while turn-2 is already the active turn must not wipe turn-2's
  // tracking. terminalPublishedForTurnId is still recorded (a true fact
  // about turn-1), but activeTurnId is untouched since it no longer names
  // turn-1.
  //
  // archive#3572(a) (widened, same test): D8 only gated the `activeTurnId`
  // clear. `activeTurnStartedAt` — turn-2's OWN in-flight start timestamp —
  // used to be cleared unconditionally by turn-1's stale completion two
  // lines below the old D8 guard, so when turn-2 genuinely completed later
  // this record would have no `activeTurnStartedAt` left to read and
  // silently skip recording ITS duration metric. Now gated on the same
  // identity check as the rest of this block.
  test('a late turn/completed for a superseded turn does not clear the CURRENT active turn (or its start timestamp)', () => {
    const activeTurnStartedAt = Date.now() - 10;
    const record = buildRecord({
      activeTurnId: 'turn-2', // turn-2 is now active, not turn-1
      activeTurnStartedAt,
      turnOutput: new Map([['turn-1', '']]),
    });

    handleCodexNotification({
      record,
      notification: {
        method: 'turn/completed',
        params: { turn: { id: 'turn-1', status: 'completed' } },
      },
      nowIso: () => '2026-01-02T00:00:02.000Z',
      publish: () => {},
    });

    expect(record.activeTurnId).toBe('turn-2');
    expect(record.activeTurnStartedAt).toBe(activeTurnStartedAt);
    expect(record.terminalPublishedForTurnId).toBe('turn-1');
  });

  // archive#3572(a): the metric-corruption half of the same defect. Before
  // the fix, the `adapterTurnDuration.record` call ran UNCONDITIONALLY
  // before the identity check even existed, so a stale turn-1 completion
  // recorded a duration sample computed from turn-2's (unrelated) start
  // timestamp — attributing a bogus datapoint to turn-1's stale completion
  // — and then (per the test above's old behavior) wiped
  // `activeTurnStartedAt`, so turn-2's OWN later legitimate completion found
  // nothing to record a duration for at all. One bogus sample, one real one
  // lost. Both must now come out the other way.
  test('station#3572(a): a stale turn/completed does not record a duration metric attributed to the wrong turn', () => {
    const recordSpy = vi
      .spyOn(adapterTurnDuration, 'record')
      .mockImplementation(() => {});
    try {
      const record = buildRecord({
        activeTurnId: 'turn-2',
        activeTurnStartedAt: Date.now() - 10,
        turnOutput: new Map([['turn-1', '']]),
      });

      handleCodexNotification({
        record,
        notification: {
          method: 'turn/completed',
          params: { turn: { id: 'turn-1', status: 'completed' } },
        },
        nowIso: () => '2026-01-02T00:00:02.000Z',
        publish: () => {},
      });
      expect(recordSpy).not.toHaveBeenCalled();

      // The genuine completion for the CURRENTLY active turn still records
      // its own duration normally — this is not a blanket suppression.
      handleCodexNotification({
        record,
        notification: {
          method: 'turn/completed',
          params: { turn: { id: 'turn-2', status: 'completed' } },
        },
        nowIso: () => '2026-01-02T00:00:03.000Z',
        publish: () => {},
      });
      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(recordSpy).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({ provider: 'codex' }),
      );
    } finally {
      recordSpy.mockRestore();
    }
  });

  test('a failed turn (turn.status: failed) marks terminalPublishedForTurnId', () => {
    const record = buildRecord({
      activeTurnId: 'turn-1',
      activeTurnStartedAt: Date.now() - 10,
      turnOutput: new Map([['turn-1', '']]),
    });

    handleCodexNotification({
      record,
      notification: {
        method: 'turn/completed',
        params: {
          turn: { id: 'turn-1', status: 'failed', error: { message: 'x' } },
        },
      },
      nowIso: () => '2026-01-02T00:00:02.000Z',
      publish: () => {},
    });

    expect(record.terminalPublishedForTurnId).toBe('turn-1');
  });

  // archive#3451 finding B2 (blocking): the `willRetry`-falsy 'error'
  // notification arm never marked anything before this fix, even though
  // every downstream consumer (the lifecycle fold, the stall watchdog, the
  // trackEngineTurn telemetry gate, checkpoint capture) already treats a
  // non-deferred runtime.error as terminal. Without this mark, a later
  // stop/exit would synthesize a SECOND terminal via
  // publishOrphanedTurnFailure — double-counting telemetry, double-firing
  // checkpoint capture, and overwriting blockedReason with a generic message
  // that erases the real cause this notification just reported.
  test('a non-retriable error notification marks terminalPublishedForTurnId (B2)', () => {
    const record = buildRecord({ activeTurnId: 'turn-1' });

    handleCodexNotification({
      record,
      notification: {
        method: 'error',
        params: {
          turnId: 'turn-1',
          error: { message: 'Fatal error' },
          willRetry: false,
        },
      },
      nowIso: () => '2026-01-02T00:00:02.000Z',
      publish: () => {},
    });

    expect(record.terminalPublishedForTurnId).toBe('turn-1');
    // Unlike turn/completed, the 'error' notification never clears
    // activeTurnId itself — B2's fix is scoped to marking the terminal
    // published, not to that separate (pre-existing, untouched) behavior.
    expect(record.activeTurnId).toBe('turn-1');
  });

  // Negative control: a RETRIABLE (deferred, willRetry: true) error must NOT
  // mark the terminal published — codex may still resolve this same turn
  // without a new turn.started, and marking it here would incorrectly let a
  // later stop/exit skip publishing the turn's real eventual terminal.
  test('a retriable (deferred) error notification does not mark terminalPublishedForTurnId', () => {
    const record = buildRecord({ activeTurnId: 'turn-1' });

    handleCodexNotification({
      record,
      notification: {
        method: 'error',
        params: {
          turnId: 'turn-1',
          error: { message: 'Transient error' },
          willRetry: true,
        },
      },
      nowIso: () => '2026-01-02T00:00:02.000Z',
      publish: () => {},
    });

    expect(record.terminalPublishedForTurnId).toBeUndefined();
    expect(record.activeTurnId).toBe('turn-1');
  });
});
