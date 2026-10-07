import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { buildOrchestrationSessionSummary } from '../../services/orchestration/orchestration-session-state.js';
import { SessionRecoveryCoordinator } from '../../services/orchestration/session-recovery-coordinator.js';
import {
  type ClaudeMessageState,
  mapClaudeSdkMessage,
} from '../adapters/claude-adapter-events.js';
import { recordClaudeTurnDispatched } from '../adapters/claude-sdk-turns.js';

/**
 * #3157: a Claude Code subscription usage-limit stop, as the SDK delivers it.
 * Shapes follow `@anthropic-ai/claude-agent-sdk` 0.3.278's `SDKRateLimitEvent`
 * / `SDKAssistantMessage` / `SDKResultSuccess` and the reported shape of a
 * subscription limit stop: a `rejected` window (no overage),
 * the synthetic `rate_limit` reply, then an `is_error` result with
 * `api_error_status: 429` and `terminal_reason: 'api_error'`. `resetsAt` is
 * epoch SECONDS.
 */
const SESSION = '11111111-1111-4111-8111-111111111111';
const RESETS_AT_SECONDS = Date.parse('2026-09-25T01:10:00.000Z') / 1_000;

function rejectedWindow(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: RESETS_AT_SECONDS,
      overageStatus: 'rejected',
      ...overrides,
    },
    uuid: '22222222-2222-4222-8222-000000000101',
    session_id: SESSION,
  } as SDKMessage;
}

const RATE_LIMIT_REPLY = {
  type: 'assistant',
  message: {
    model: '<synthetic>',
    id: 'msg_rate_limit',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: "You've hit your session limit · resets 11:10am (Australia/Sydney)",
      },
    ],
    stop_reason: 'stop_sequence',
    stop_sequence: '',
    usage: { input_tokens: 0, output_tokens: 0 },
  },
  parent_tool_use_id: null,
  error: 'rate_limit',
  uuid: '22222222-2222-4222-8222-000000000102',
  session_id: SESSION,
} as unknown as SDKMessage;

function limitedResult(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: 429,
    duration_ms: 412,
    duration_api_ms: 0,
    num_turns: 1,
    result: "You've hit your session limit · resets 11:10am (Australia/Sydney)",
    stop_reason: 'stop_sequence',
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    terminal_reason: 'api_error',
    uuid: '22222222-2222-4222-8222-000000000103',
    session_id: SESSION,
    ...overrides,
  } as unknown as SDKMessage;
}

function claudeRecord(threadId: string): ClaudeMessageState {
  const record: ClaudeMessageState = {
    session: {
      provider: 'claude',
      threadId,
      status: 'running',
      createdAt: '2026-09-24T20:00:00.000Z',
      updatedAt: '2026-09-24T20:00:00.000Z',
    },
    lastSessionState: 'running',
  };
  recordClaudeTurnDispatched(record, 'turn-limited');
  return record;
}

function drive(
  record: ClaudeMessageState,
  messages: SDKMessage[],
): CanonicalRuntimeEvent[] {
  const events: CanonicalRuntimeEvent[] = [];
  for (const message of messages)
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      message,
      publish: (event) => events.push(event),
    });
  return events;
}

function runtimeError(events: CanonicalRuntimeEvent[]) {
  const error = events.find((event) => event.method === 'runtime.error');
  if (error?.method !== 'runtime.error')
    throw new Error('the limited result published no runtime.error');
  return error;
}

describe('#3157 Claude usage-limit stop', () => {
  const makeTempDir = trackTempDirs();

  /** The adapter's events, persisted and observed the way orchestration does. */
  async function armFrom(threadId: string, events: CanonicalRuntimeEvent[]) {
    const dir = makeTempDir('claude-usage-limit-');
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const dispatch = vi.fn(async () => ({ kind: 'rejected' as const }));
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      // The Claude adapter's own declaration (claude-adapter.ts metadata).
      adapterForProvider: () =>
        ({
          metadata: { recovery: { sameSession: true, maxAttempts: 1 } },
        }) as any,
      recoveryDispatchAdapter: { dispatch },
      now: () => new Date('2026-09-24T21:00:00.000Z'),
    });
    // `sendTurn` publishes the dispatched turn's start; the mapper only ends it.
    const started: CanonicalRuntimeEvent = {
      eventId: `started-${threadId}`,
      provider: 'claude',
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

  test('carries the rejected window reset into the failure and arms a wait until it', async () => {
    const record = claudeRecord('thread-limited');
    const events = drive(record, [
      rejectedWindow(),
      RATE_LIMIT_REPLY,
      limitedResult(),
    ]);
    expect(runtimeError(events)).toMatchObject({
      turnId: 'turn-limited',
      code: 'engine-turn-failed',
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

  test('the session summary tells clients the stop was a usage limit', () => {
    const record = claudeRecord('thread-summary');
    const events = drive(record, [rejectedWindow(), limitedResult()]);
    const summarize = (stream: CanonicalRuntimeEvent[]) =>
      buildOrchestrationSessionSummary({
        persisted: {
          provider: 'claude',
          threadId: 'thread-summary',
          status: 'error',
          createdAt: '2026-09-24T20:00:00.000Z',
          updatedAt: '2026-09-24T21:00:00.000Z',
        },
        answerability: {
          threadAttachment: 'detached',
          providerRegistered: true,
          observedBy: 'test',
          observedAt: '2026-09-24T21:00:00.000Z',
        },
        events: stream,
      });
    expect(summarize(events)).toMatchObject({
      lastEventMethod: 'runtime.error',
      lastRuntimeErrorUsageLimit: true,
    });
    const ordinary = drive(claudeRecord('thread-summary'), [
      limitedResult({ api_error_status: 500, result: 'Internal error' }),
    ]);
    expect(summarize(ordinary)).not.toHaveProperty(
      'lastRuntimeErrorUsageLimit',
    );
  });

  test('the same stop with no reported reset stays manual', async () => {
    const record = claudeRecord('thread-no-reset');
    const events = drive(record, [
      rejectedWindow({ resetsAt: undefined }),
      RATE_LIMIT_REPLY,
      limitedResult(),
    ]);
    expect(runtimeError(events).details).toEqual({
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

  test('a blocking_limit result is a usage limit even without a window report', () => {
    const record = claudeRecord('thread-blocking');
    const events = drive(record, [
      limitedResult({ terminal_reason: 'blocking_limit' }),
    ]);
    expect(runtimeError(events).details).toEqual({
      usageLimit: true,
      scope: 'account',
    });
  });

  test('every rejected window must reset: the latest reset wins, an unknown one withholds it', () => {
    const later = Date.parse('2026-09-30T00:00:00.000Z') / 1_000;
    const both = drive(claudeRecord('thread-two-windows'), [
      rejectedWindow(),
      rejectedWindow({ rateLimitType: 'seven_day', resetsAt: later }),
      limitedResult(),
    ]);
    expect(runtimeError(both).details).toMatchObject({
      resetAt: '2026-09-30T00:00:00.000Z',
    });
    const oneUnknown = drive(claudeRecord('thread-one-unknown'), [
      rejectedWindow(),
      rejectedWindow({ rateLimitType: 'seven_day', resetsAt: undefined }),
      limitedResult(),
    ]);
    expect(runtimeError(oneUnknown).details).not.toHaveProperty('resetAt');
  });

  test('overage, a cleared window, or another failure cause is not a usage-limit stop', () => {
    const overage = drive(claudeRecord('thread-overage'), [
      rejectedWindow({ overageStatus: 'allowed' }),
      limitedResult({ api_error_status: 500 }),
    ]);
    expect(runtimeError(overage)).not.toHaveProperty('details');

    const cleared = drive(claudeRecord('thread-cleared'), [
      rejectedWindow(),
      {
        ...(rejectedWindow() as object),
        rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' },
      } as SDKMessage,
      limitedResult({ api_error_status: 500 }),
    ]);
    expect(runtimeError(cleared)).not.toHaveProperty('details');

    const otherCause = drive(claudeRecord('thread-other-cause'), [
      rejectedWindow(),
      limitedResult({ terminal_reason: 'prompt_too_long' }),
    ]);
    expect(runtimeError(otherCause)).not.toHaveProperty('details');
  });

  test('a rejected window a successful turn ran past does not mark a later failure', () => {
    const record = claudeRecord('thread-stale-window');
    drive(record, [
      rejectedWindow({ rateLimitType: 'seven_day_opus' }),
      limitedResult({
        subtype: 'success',
        is_error: false,
        api_error_status: null,
        terminal_reason: 'completed',
        result: 'Done.',
      }),
    ]);
    recordClaudeTurnDispatched(record, 'turn-after-success');
    const later = drive(record, [
      limitedResult({
        api_error_status: 500,
        result: 'Internal server error',
        uuid: '22222222-2222-4222-8222-000000000105',
      }),
    ]);
    expect(runtimeError(later)).not.toHaveProperty('details');
  });

  test('a rate-limit reply is consumed by its turn and does not mark a later failure', () => {
    const record = claudeRecord('thread-reply-once');
    drive(record, [RATE_LIMIT_REPLY, limitedResult()]);
    recordClaudeTurnDispatched(record, 'turn-later');
    const later = drive(record, [
      limitedResult({
        api_error_status: 500,
        result: 'Internal server error',
        uuid: '22222222-2222-4222-8222-000000000104',
      }),
    ]);
    expect(runtimeError(later)).not.toHaveProperty('details');
  });
});
