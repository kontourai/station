import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { SessionRecoveryCoordinator } from '../../services/orchestration/session-recovery-coordinator.js';
import type { ProviderSession } from '../adapter-shape.js';
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

function buildRecord(threadId: string): CodexSessionRecord {
  const session: ProviderSession = {
    provider: 'codex',
    threadId,
    status: 'running',
    createdAt: '2026-09-24T20:00:00.000Z',
    updatedAt: '2026-09-24T20:00:00.000Z',
  };
  return {
    externalThreadId: threadId,
    codexThreadId: `codex-${threadId}`,
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
    approvedTools: new Set(),
    lastSessionState: 'running',
    activeTurnId: 'turn-limited',
    turnOutput: new Map([['turn-limited', '']]),
    toolNames: new Map(),
    openToolCalls: new Map(),
    stopped: false,
  };
}

/**
 * #3157: shapes from `codex app-server generate-json-schema` (codex-cli
 * 0.160.0): `AccountRateLimitsUpdatedNotification { rateLimits:
 * RateLimitSnapshot }` with epoch-SECOND `resetsAt`, the `error`
 * notification (`willRetry: false`), and `turn/completed` whose failed
 * `turn.error.codexErrorInfo` is the string variant `usageLimitExceeded`.
 */
const PRIMARY_RESET = Date.parse('2026-09-25T01:10:00.000Z') / 1_000;
const SECONDARY_RESET = Date.parse('2026-09-29T08:00:00.000Z') / 1_000;

function rateLimitsUpdated(rateLimits: Record<string, unknown>) {
  return { method: 'account/rateLimits/updated', params: { rateLimits } };
}

const LIMIT_MESSAGE =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again at 1:10 AM.";

function usageLimitStop(
  threadId: string,
  codexErrorInfo: unknown = 'usageLimitExceeded',
) {
  const error = {
    message: LIMIT_MESSAGE,
    codexErrorInfo,
    additionalDetails: null,
  };
  return [
    {
      method: 'error',
      params: {
        error,
        willRetry: false,
        threadId: `codex-${threadId}`,
        turnId: 'turn-limited',
      },
    },
    {
      method: 'turn/completed',
      params: {
        threadId: `codex-${threadId}`,
        turn: { id: 'turn-limited', status: 'failed', error, items: [] },
      },
    },
  ];
}

function drive(
  record: CodexSessionRecord,
  notifications: Array<{ method: string; params?: unknown }>,
): CanonicalRuntimeEvent[] {
  const events: CanonicalRuntimeEvent[] = [];
  for (const notification of notifications)
    void handleCodexNotification({
      record,
      notification,
      nowIso: () => '2026-09-24T21:00:00.000Z',
      publish: (event) => events.push(event),
    });
  return events;
}

function failedTurn(events: CanonicalRuntimeEvent[]) {
  const failed = events.filter(
    (event) => event.method === 'runtime.error' && event.code !== undefined,
  );
  const error = failed.at(-1);
  if (error?.method !== 'runtime.error')
    throw new Error('the failed turn published no coded runtime.error');
  return error;
}

describe('#3157 Codex usage-limit stop', () => {
  const makeTempDir = trackTempDirs();

  async function armFrom(threadId: string, events: CanonicalRuntimeEvent[]) {
    const dir = makeTempDir('codex-usage-limit-');
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const dispatch = vi.fn(async () => ({ kind: 'rejected' as const }));
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      // The Codex adapter's own declaration (codex-adapter.ts metadata).
      adapterForProvider: () =>
        ({
          metadata: {
            recovery: {
              sameSession: true,
              maxAttempts: 1,
              dispatchSettlement: 'provider-response',
            },
          },
        }) as any,
      recoveryDispatchAdapter: { dispatch },
      now: () => new Date('2026-09-24T21:00:00.000Z'),
    });
    // The adapter's `sendTurn` publishes the turn's start.
    const started: CanonicalRuntimeEvent = {
      eventId: `started-${threadId}`,
      provider: 'codex',
      threadId,
      turnId: 'turn-limited',
      createdAt: '2026-09-24T20:59:00.000Z',
      method: 'turn.started',
      prompt: 'Continue the refactor.',
    };
    for (const event of [started, ...events]) {
      store.appendEvent(event);
      coordinator.observe(event);
    }
    const projection = coordinator.latestProjection(threadId);
    await coordinator.dispose();
    store.close();
    return { projection, dispatch };
  }

  test('joins the exhausted window reset from the last snapshot and arms a wait until it', async () => {
    const record = buildRecord('thread-limited');
    const events = drive(record, [
      rateLimitsUpdated({
        limitId: 'codex',
        planType: 'plus',
        primary: {
          usedPercent: 100,
          windowDurationMins: 300,
          resetsAt: PRIMARY_RESET,
        },
        secondary: {
          usedPercent: 46,
          windowDurationMins: 10080,
          resetsAt: SECONDARY_RESET,
        },
        rateLimitReachedType: 'rate_limit_reached',
      }),
      ...usageLimitStop('thread-limited'),
    ]);
    expect(failedTurn(events)).toMatchObject({
      code: 'usageLimitExceeded',
      details: {
        codexErrorInfo: 'usageLimitExceeded',
        usageLimit: true,
        scope: 'account',
        resetAt: '2026-09-25T01:10:00.000Z',
      },
    });
    // The `error` notification (willRetry: false) is the first terminal the
    // coordinator sees; it carries the same facts.
    const notified = events.find(
      (event) => event.method === 'runtime.error' && event.code === undefined,
    );
    expect(notified).toMatchObject({
      retriable: false,
      details: {
        usageLimit: true,
        scope: 'account',
        resetAt: '2026-09-25T01:10:00.000Z',
      },
    });
    const { projection, dispatch } = await armFrom('thread-limited', events);
    expect(projection).toMatchObject({
      failureKind: 'rate-limit',
      scope: 'account',
      decision: 'wait-until-reset',
      dueAt: '2026-09-25T01:10:00.000Z',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('a sparse update keeps the reset an earlier snapshot reported', () => {
    const record = buildRecord('thread-sparse');
    const events = drive(record, [
      rateLimitsUpdated({
        limitId: 'codex',
        primary: { usedPercent: 97, resetsAt: PRIMARY_RESET },
      }),
      rateLimitsUpdated({ primary: { usedPercent: 100 } }),
      ...usageLimitStop('thread-sparse'),
    ]);
    expect(failedTurn(events).details).toMatchObject({
      resetAt: '2026-09-25T01:10:00.000Z',
    });
  });

  test('the same stop with no snapshot reset stays manual', async () => {
    const record = buildRecord('thread-no-reset');
    const events = drive(record, usageLimitStop('thread-no-reset'));
    expect(failedTurn(events).details).toEqual({
      additionalDetails: null,
      codexErrorInfo: 'usageLimitExceeded',
      usageLimit: true,
      scope: 'account',
    });
    const { projection } = await armFrom('thread-no-reset', events);
    expect(projection).toMatchObject({
      failureKind: 'rate-limit',
      decision: 'manual',
      outcome: 'manual',
    });
    expect(projection).not.toHaveProperty('dueAt');
  });

  test('a model-specific allowance, a credit limit, or another failure carries no reset', () => {
    const spark = drive(buildRecord('thread-spark'), [
      rateLimitsUpdated({
        limitId: 'codex_spark',
        primary: { usedPercent: 100, resetsAt: PRIMARY_RESET },
      }),
      ...usageLimitStop('thread-spark'),
    ]);
    expect(failedTurn(spark).details).not.toHaveProperty('resetAt');

    const credits = drive(buildRecord('thread-credits'), [
      rateLimitsUpdated({
        primary: { usedPercent: 100, resetsAt: PRIMARY_RESET },
        rateLimitReachedType: 'workspace_member_credits_depleted',
      }),
      ...usageLimitStop('thread-credits'),
    ]);
    expect(failedTurn(credits).details).not.toHaveProperty('resetAt');

    const context = drive(buildRecord('thread-context'), [
      rateLimitsUpdated({
        primary: { usedPercent: 100, resetsAt: PRIMARY_RESET },
      }),
      ...usageLimitStop('thread-context', 'contextWindowExceeded'),
    ]);
    expect(failedTurn(context).details).not.toHaveProperty('usageLimit');
  });
});
