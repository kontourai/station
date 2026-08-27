import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TurnStartedEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  connectionRecoveryOutcomes,
  credentialProfileApplication,
} from '../../../telemetry/metrics.js';
import type {
  CredentialReceiptAcknowledgement,
  CredentialSettlementOutcome,
} from '../credential-recovery-module.js';
import {
  type CredentialProfileRecoveryAdapter,
  type CredentialProfileRecoveryAttempt,
  type CredentialProfileStageOutcome,
  createCredentialRecoveryModule,
} from '../credential-recovery-module.js';
import { EventStore } from '../event-store.js';
import type { RecoveryDispatchAdapter } from '../recovery-dispatch-adapter.js';
import { SessionRecoveryCoordinator as RuntimeSessionRecoveryCoordinator } from '../session-recovery-coordinator.js';

function recoveryLedger(eventStore: EventStore) {
  return eventStore.createRecoveryLedger();
}

function credentialAttempt(
  overrides: Partial<CredentialProfileRecoveryAttempt> = {},
): CredentialProfileRecoveryAttempt {
  return Object.freeze({
    candidateProfileRef: 'opaque',
    capability: 'restart_resume' as const,
    commit: async () => ({ kind: 'adopted' as const }),
    rollback: async () => ({ kind: 'rolled-back' as const }),
    inspect: async () => ({ kind: 'staged' as const }),
    acknowledge: async () => ({ kind: 'applied' as const }),
    ...overrides,
  });
}

type TestCredentialAttempt =
  | CredentialProfileRecoveryAttempt
  | Pick<
      CredentialProfileRecoveryAttempt,
      'candidateProfileRef' | 'capability'
    >;

type TestCredentialRecoveryAdapter = Omit<
  CredentialProfileRecoveryAdapter,
  'stage'
> & {
  stage: (
    input: Parameters<CredentialProfileRecoveryAdapter['stage']>[0],
  ) => Promise<
    TestCredentialAttempt | CredentialProfileStageOutcome | undefined
  >;
  commit?: () => Promise<CredentialSettlementOutcome>;
  rollback?: () => Promise<CredentialSettlementOutcome>;
  acknowledge?: () => Promise<CredentialReceiptAcknowledgement>;
};

vi.mock('../../../telemetry/metrics.js', () => ({
  connectionRecoveryOutcomes: { add: vi.fn() },
  credentialProfileApplication: { add: vi.fn() },
  orchestrationEventsPersisted: { add: vi.fn() },
  orchestrationEventPersistDuration: { record: vi.fn() },
}));

/** Existing coordinator behavior tests inject the real Module at its Interface. */
type CoordinatorOptions = Omit<
  ConstructorParameters<typeof RuntimeSessionRecoveryCoordinator>[0],
  'recoveryDispatchAdapter'
> & {
  recoveryDispatchAdapter?: RecoveryDispatchAdapter;
  /** Existing #2526 scenarios are adapted at the test seam only. */
  sendTurn?: (input: {
    threadId: string;
    input: string;
    attachments?: TurnStartedEvent['attachments'];
    ambientContext?: string;
    modelId?: string;
    modelOptions?: Record<string, string | number | boolean>;
    recoveryCorrelationId: string;
    signal: AbortSignal;
    credentialProfileRef?: string;
  }) => Promise<{ turnId: string }>;
  interruptTurn?: (threadId: string, turnId: string) => Promise<void>;
  credentialRecoveryAdapter?: TestCredentialRecoveryAdapter;
  restartResume?: (input: {
    threadId: string;
    input: string;
    attachments?: TurnStartedEvent['attachments'];
    ambientContext?: string;
    modelId?: string;
    modelOptions?: Record<string, string | number | boolean>;
    recoveryCorrelationId: string;
    signal: AbortSignal;
    credentialProfileRef?: string;
  }) => Promise<{ turnId: string }>;
  restoreSession?: (input: {
    threadId: string;
    signal: AbortSignal;
  }) => Promise<void>;
  quarantineSession?: (threadId: string) => Promise<void>;
};

class SessionRecoveryCoordinator extends RuntimeSessionRecoveryCoordinator {
  constructor(options: CoordinatorOptions) {
    const {
      credentialRecoveryAdapter: adapter,
      sendTurn,
      interruptTurn,
      restartResume,
      restoreSession,
      quarantineSession,
      ...coordinatorOptions
    } = options;
    const recoveryDispatchAdapter: RecoveryDispatchAdapter =
      coordinatorOptions.recoveryDispatchAdapter ?? {
        dispatch: async ({ replay, credentialProfileRef }) => {
          const dispatch = credentialProfileRef ? restartResume : sendTurn;
          if (!dispatch) return { kind: 'rejected' };
          const result = await dispatch({ ...replay, credentialProfileRef });
          return { kind: 'accepted', turnId: result.turnId };
        },
        interrupt: interruptTurn
          ? async ({ threadId, turnId }) => interruptTurn(threadId, turnId)
          : undefined,
      };
    const recoveryLedger =
      coordinatorOptions.recoveryLedger ??
      coordinatorOptions.eventStore.createRecoveryLedger();
    const credentialRecovery = adapter
      ? createCredentialRecoveryModule({
          ledger: recoveryLedger,
          adapter: {
            ...adapter,
            stage: async (input) => {
              const raw = await adapter.stage(input);
              if (!raw) return { kind: 'unavailable' as const };
              if ('kind' in raw) return raw;
              const attempt =
                'commit' in raw
                  ? raw
                  : credentialAttempt({
                      candidateProfileRef: raw.candidateProfileRef,
                      capability: raw.capability,
                      commit:
                        adapter.commit ??
                        (async () => ({ kind: 'adopted' as const })),
                      rollback:
                        adapter.rollback ??
                        (async () => ({ kind: 'rolled-back' as const })),
                      acknowledge:
                        adapter.acknowledge ??
                        (async () => ({ kind: 'applied' as const })),
                    });
              return { kind: 'staged' as const, attempt };
            },
          },
          dispatchAdapter: recoveryDispatchAdapter,
          restoreSession: async (input) => restoreSession?.(input),
          quarantineSession,
          now: coordinatorOptions.now ?? (() => new Date()),
        })
      : undefined;
    super({
      ...coordinatorOptions,
      recoveryLedger,
      recoveryDispatchAdapter,
      credentialRecovery,
    });
  }
}

describe('SessionRecoveryCoordinator', () => {
  const dirs: string[] = [];
  afterEach(() =>
    dirs
      .splice(0)
      .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
  );

  test('restarts a staged credential profile and commits only its matching completion without recording the ref', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const sendTurn = vi.fn(async () => ({ turnId: 'ordinary-turn' }));
    const restartResume = vi.fn(async () => ({ turnId: 'profile-turn' }));
    const commit = vi.fn(async () => ({ kind: 'adopted' as const }));
    const rollback = vi.fn(async () => ({ kind: 'rolled-back' as const }));
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({
          metadata: {
            recovery: {
              sameSession: true,
              application: 'restart_resume',
            },
          },
        }) as any,
      sendTurn,
      restartResume,
      credentialRecoveryAdapter: {
        stage: async () => ({
          candidateProfileRef: 'canary-profile-ref',
          capability: 'restart_resume',
        }),
        commit,
        rollback,
      },
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'authoritative input',
    });
    coordinator.observe({
      eventId: 'account-exhausted',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'runtime.error',
      severity: 'error',
      message: 'account capacity exhausted',
      details: { scope: 'account', retryAfterMs: 0 },
    });
    await vi.runAllTimersAsync();
    expect(sendTurn).not.toHaveBeenCalled();
    expect(restartResume).toHaveBeenCalledWith(
      expect.objectContaining({ credentialProfileRef: 'canary-profile-ref' }),
    );
    coordinator.observe({
      eventId: 'completed',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'profile-turn',
      createdAt: now.toISOString(),
      method: 'turn.completed',
      finishReason: 'stop',
    });
    await Promise.resolve();
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(
      JSON.stringify(vi.mocked(credentialProfileApplication.add).mock.calls),
    ).not.toContain('canary-profile-ref');
    store.close();
    vi.useRealTimers();
  });

  test('routes a Claude observed terminal event to exact profile compensation', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-observed-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const rollback = vi.fn(async () => {
      throw new Error('retain exact compensation');
    });
    const restoreSession = vi.fn(async () => undefined);
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({
          metadata: {
            recovery: { sameSession: true, application: 'restart_resume' },
          },
        }) as any,
      recoveryDispatchAdapter: {
        dispatch: async () => ({
          kind: 'observed',
          turnId: 'claude-local-turn',
        }),
      },
      credentialRecoveryAdapter: {
        stage: async () => ({
          candidateProfileRef: 'opaque',
          capability: 'restart_resume',
        }),
        commit: vi.fn(async () => ({ kind: 'adopted' as const })),
        rollback,
      },
      restoreSession,
      now: () => now,
    });
    store.appendEvent({
      eventId: 'observed-source',
      provider: 'claude',
      threadId: 'thread-observed',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'authoritative input',
    });
    coordinator.observe({
      eventId: 'observed-error',
      provider: 'claude',
      threadId: 'thread-observed',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'runtime.error',
      severity: 'error',
      message: 'account capacity exhausted',
      details: { scope: 'account', retryAfterMs: 0 },
    });
    await vi.runAllTimersAsync();
    expect(
      recoveryLedger(store).latestProjection('thread-observed'),
    ).toMatchObject({
      outcome: 'resumed',
    });

    coordinator.observe({
      eventId: 'observed-completed',
      provider: 'claude',
      threadId: 'thread-observed',
      turnId: 'claude-local-turn',
      createdAt: now.toISOString(),
      method: 'turn.completed',
      finishReason: 'stop',
    });
    await vi.runAllTimersAsync();
    expect(restoreSession).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
    expect(
      recoveryLedger(store).latestProjection('thread-observed'),
    ).toMatchObject({
      outcome: 'compensation-required',
    });
    store.close();
    vi.useRealTimers();
  });

  test('completes an accepted ordinary retry when credential recovery is configured', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-ordinary-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const commit = vi.fn(async () => ({ kind: 'adopted' as const }));
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn: vi.fn(async () => ({ turnId: 'ordinary-retry-turn' })),
      credentialRecoveryAdapter: {
        stage: async () => undefined,
        commit,
        rollback: vi.fn(async () => ({ kind: 'rolled-back' as const })),
      },
      now: () => now,
    });
    store.appendEvent({
      eventId: 'ordinary-source',
      provider: 'codex',
      threadId: 'ordinary-thread',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'resume',
    });
    coordinator.observe({
      eventId: 'ordinary-error',
      provider: 'codex',
      threadId: 'ordinary-thread',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'runtime.error',
      severity: 'error',
      message: 'account capacity exhausted',
      details: { scope: 'account', retryAfterMs: 0 },
    });
    await vi.runAllTimersAsync();
    coordinator.observe({
      eventId: 'ordinary-completed',
      provider: 'codex',
      threadId: 'ordinary-thread',
      turnId: 'ordinary-retry-turn',
      createdAt: now.toISOString(),
      method: 'turn.completed',
      finishReason: 'stop',
    });
    await vi.runAllTimersAsync();
    expect(
      recoveryLedger(store).latestProjection('ordinary-thread'),
    ).toMatchObject({ outcome: 'succeeded' });
    expect(commit).not.toHaveBeenCalled();
    store.close();
    vi.useRealTimers();
  });

  test('RECOVERY TELEMETRY DEFECT: emits the existing transient and terminal classifier decisions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const outcomes = vi.fn();
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn: async () => ({ turnId: 'unused' }),
      onOutcome: outcomes,
      now: () => new Date('2026-08-11T12:00:00.000Z'),
    });
    for (const [turnId, message, details] of [
      ['transient', 'capacity exhausted', { retryAfterMs: 0 }],
      ['terminal', 'authentication failed', {}],
    ] as const) {
      store.appendEvent({
        eventId: `${turnId}-start`,
        provider: 'claude',
        threadId: turnId,
        turnId,
        createdAt: '2026-08-11T12:00:00.000Z',
        method: 'turn.started',
        prompt: 'never exported',
      });
      coordinator.observe({
        eventId: `${turnId}-error`,
        provider: 'claude',
        threadId: turnId,
        turnId,
        createdAt: '2026-08-11T12:00:00.000Z',
        method: 'runtime.error',
        severity: 'error',
        message,
        details,
      });
    }
    expect(
      outcomes,
      'recovery telemetry did not follow the existing classifier',
    ).toHaveBeenCalledWith({
      failureKind: 'capacity',
      decision: 'retry-now',
      outcome: 'armed',
    });
    expect(
      outcomes,
      'terminal recovery telemetry did not follow the existing classifier',
    ).toHaveBeenCalledWith({
      failureKind: 'authentication',
      decision: 'reconnect',
      outcome: 'manual',
    });
    store.close();
  });

  test('shutdown rolls back a staged credential profile before clearing in-memory attempt state', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const rollback = vi.fn(async () => ({ kind: 'rolled-back' as const }));
    const restartResume = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<{ turnId: string }>((resolve) => {
          signal.addEventListener('abort', () =>
            resolve({ turnId: 'late-profile-turn' }),
          );
        }),
    );
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({
          metadata: {
            recovery: {
              sameSession: true,
              application: 'restart_resume',
            },
          },
        }) as any,
      sendTurn: vi.fn(),
      restartResume,
      credentialRecoveryAdapter: {
        stage: async () => ({
          candidateProfileRef: 'profile-shutdown',
          capability: 'restart_resume',
        }),
        commit: vi.fn(async () => ({ kind: 'adopted' as const })),
        rollback,
      },
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started-shutdown-profile',
      provider: 'claude',
      threadId: 'thread-shutdown-profile',
      turnId: 'turn-shutdown-profile',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'authoritative input',
    });
    coordinator.observe({
      eventId: 'account-exhausted-shutdown-profile',
      provider: 'claude',
      threadId: 'thread-shutdown-profile',
      turnId: 'turn-shutdown-profile',
      createdAt: now.toISOString(),
      method: 'runtime.error',
      severity: 'error',
      message: 'account capacity exhausted',
      details: { scope: 'account', retryAfterMs: 0 },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(restartResume).toHaveBeenCalledOnce();

    await coordinator.dispose();

    expect(rollback).toHaveBeenCalledOnce();
    expect(
      coordinator.latestProjection('thread-shutdown-profile'),
    ).toMatchObject({ outcome: 'canceled' });
    store.close();
    vi.useRealTimers();
  });

  test.each([
    ['without reset timing', {}],
    ['before a future reset', { retryAfterMs: 60_000 }],
  ])(
    'an eligible enrolled profile recovers immediately %s',
    async (_label, timing) => {
      vi.useFakeTimers();
      const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
      dirs.push(dir);
      const store = new EventStore(join(dir, 'orchestration.sqlite'));
      const now = new Date('2026-07-29T12:00:00.000Z');
      const restartResume = vi.fn(async () => ({ turnId: 'profile-turn' }));
      const coordinator = new SessionRecoveryCoordinator({
        eventStore: store,
        adapterForProvider: () =>
          ({
            metadata: {
              recovery: {
                sameSession: true,
                application: 'restart_resume',
              },
            },
          }) as any,
        sendTurn: vi.fn(),
        restartResume,
        credentialRecoveryAdapter: {
          stage: async () => ({
            candidateProfileRef: 'backup',
            capability: 'restart_resume',
          }),
          commit: vi.fn(async () => ({ kind: 'adopted' as const })),
          rollback: vi.fn(),
        },
        now: () => now,
      });
      store.appendEvent({
        eventId: 'started-immediate',
        provider: 'codex',
        threadId: 'thread-immediate',
        turnId: 'turn-immediate',
        createdAt: now.toISOString(),
        method: 'turn.started',
        prompt: 'authoritative input',
      });
      coordinator.observe({
        eventId: 'exhausted-immediate',
        provider: 'codex',
        threadId: 'thread-immediate',
        turnId: 'turn-immediate',
        createdAt: now.toISOString(),
        method: 'runtime.error',
        severity: 'error',
        message: 'account capacity exhausted',
        details: { scope: 'account', ...timing },
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(restartResume).toHaveBeenCalledOnce();
      expect(coordinator.latestProjection('thread-immediate')).toMatchObject({
        outcome: 'resumed',
      });
      await coordinator.dispose();
      store.close();
      vi.useRealTimers();
    },
  );

  test('commit rejection rolls back, restores the committed profile session, and records failure', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const rollback = vi.fn(async () => ({ kind: 'rolled-back' as const }));
    const restoreSession = vi.fn(async () => undefined);
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({
          metadata: {
            recovery: {
              sameSession: true,
              application: 'restart_resume',
            },
          },
        }) as any,
      sendTurn: vi.fn(),
      restartResume: vi.fn(async () => ({ turnId: 'candidate-turn' })),
      restoreSession,
      credentialRecoveryAdapter: {
        stage: async () => ({
          candidateProfileRef: 'backup',
          capability: 'restart_resume',
        }),
        commit: vi.fn(async () => {
          throw new Error('stale commit');
        }),
        rollback,
      },
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started-commit-failure',
      provider: 'codex',
      threadId: 'thread-commit-failure',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'authoritative input',
    });
    coordinator.observe({
      eventId: 'exhausted-commit-failure',
      provider: 'codex',
      threadId: 'thread-commit-failure',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'runtime.error',
      severity: 'error',
      message: 'account capacity exhausted',
      details: { scope: 'account' },
    });
    await vi.advanceTimersByTimeAsync(0);
    coordinator.observe({
      eventId: 'completed-commit-failure',
      provider: 'codex',
      threadId: 'thread-commit-failure',
      turnId: 'candidate-turn',
      createdAt: now.toISOString(),
      method: 'turn.completed',
      finishReason: 'stop',
    });
    await vi.runAllTimersAsync();

    expect(rollback).toHaveBeenCalledOnce();
    expect(restoreSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-commit-failure' }),
    );
    expect(coordinator.latestProjection('thread-commit-failure')).toMatchObject(
      { outcome: 'failed' },
    );
    store.close();
    vi.useRealTimers();
  });

  test('rollback rejection retains a non-terminal attempt for later compensation', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const rollback = vi.fn(async () => {
      throw new Error('persistent rollback unavailable');
    });
    const quarantineSession = vi.fn(async () => undefined);
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({
          metadata: {
            recovery: {
              sameSession: true,
              application: 'restart_resume',
            },
          },
        }) as any,
      sendTurn: vi.fn(),
      restartResume: vi.fn(async () => ({ turnId: 'candidate-turn' })),
      restoreSession: vi.fn(async () => undefined),
      quarantineSession,
      credentialRecoveryAdapter: {
        stage: async () => ({
          candidateProfileRef: 'backup',
          capability: 'restart_resume',
        }),
        commit: vi.fn(async () => {
          throw new Error('stale commit');
        }),
        rollback,
      },
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started-rollback-failure',
      provider: 'codex',
      threadId: 'thread-rollback-failure',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'authoritative input',
    });
    coordinator.observe({
      eventId: 'exhausted-rollback-failure',
      provider: 'codex',
      threadId: 'thread-rollback-failure',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'runtime.error',
      severity: 'error',
      message: 'account capacity exhausted',
      details: { scope: 'account' },
    });
    await vi.advanceTimersByTimeAsync(0);
    coordinator.observe({
      eventId: 'completed-rollback-failure',
      provider: 'codex',
      threadId: 'thread-rollback-failure',
      turnId: 'candidate-turn',
      createdAt: now.toISOString(),
      method: 'turn.completed',
      finishReason: 'stop',
    });
    await vi.runAllTimersAsync();

    expect(rollback).toHaveBeenCalledOnce();
    expect(quarantineSession).not.toHaveBeenCalled();
    expect(
      coordinator.latestProjection('thread-rollback-failure'),
    ).toMatchObject({ outcome: 'compensation-required' });
    store.close();
    vi.useRealTimers();
  });

  test.each([
    {
      name: 'successful cleanup',
      rejectCleanup: false,
      expectedOutcome: 'failed',
    },
    {
      name: 'rejected cleanup',
      rejectCleanup: true,
      expectedOutcome: 'compensation-required',
    },
  ] as const)(
    'reconciles identity-free compensation ownership after restart: $name',
    async ({ rejectCleanup, expectedOutcome }) => {
      const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
      dirs.push(dir);
      const databasePath = join(dir, 'orchestration.sqlite');
      const now = new Date('2026-07-29T12:00:00.000Z');
      const fingerprint = 'thread-restart:source-turn:capacity:account';
      const beforeRestart = new EventStore(databasePath);
      recoveryLedger(beforeRestart).arm({
        fingerprint,
        threadId: 'thread-restart',
        provider: 'codex',
        sourceEventId: 'source-event',
        sourceTurnId: 'source-turn',
        failureKind: 'capacity',
        scope: 'account',
        decision: 'manual',
        maxAttempts: 1,
        outcome: 'resumed',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      expect(
        recoveryLedger(beforeRestart).compensationRequired(
          fingerprint,
          now.toISOString(),
        ),
      ).toEqual({ kind: 'applied' });
      beforeRestart.close();

      const afterRestart = new EventStore(databasePath);
      const rollbackPending = vi.fn(async () => {
        if (rejectCleanup) throw new Error('registry cleanup unavailable');
      });
      const credentialRecovery = createCredentialRecoveryModule({
        adapter: {
          stage: vi.fn(async () => ({ kind: 'unavailable' as const })),
          rollbackPending,
        },
        ledger: afterRestart.createRecoveryLedger(),
        dispatchAdapter: { dispatch: async () => ({ kind: 'rejected' }) },
        restoreSession: vi.fn(),
        now: () => now,
      });
      const coordinator = new SessionRecoveryCoordinator({
        eventStore: afterRestart,
        adapterForProvider: () => undefined,
        sendTurn: vi.fn(),
        credentialRecovery,
        now: () => now,
      });
      await credentialRecovery.reconcile();

      expect(rollbackPending).toHaveBeenCalledWith(['codex']);
      expect(coordinator.latestProjection('thread-restart')).toMatchObject({
        outcome: expectedOutcome,
      });
      afterRestart.close();
    },
  );

  test('a compensation snapshot cannot settle a later cross-provider marker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const insertCompensation = (
      threadId: string,
      provider: 'codex' | 'claude',
    ) => {
      const fingerprint = `${threadId}:source-turn:capacity:account`;
      recoveryLedger(store).arm({
        fingerprint,
        threadId,
        provider,
        sourceEventId: `${threadId}-source`,
        sourceTurnId: 'source-turn',
        failureKind: 'capacity',
        scope: 'account',
        decision: 'manual',
        maxAttempts: 1,
        outcome: 'resumed',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      recoveryLedger(store).compensationRequired(
        fingerprint,
        now.toISOString(),
      );
      return fingerprint;
    };
    const codexFingerprint = insertCompensation(
      'thread-codex-compensation',
      'codex',
    );
    let resolveCodexCleanup: (() => void) | undefined;
    const rollbackPending = vi.fn((providers?: string[]) =>
      providers?.includes('codex')
        ? new Promise<void>((resolve) => {
            resolveCodexCleanup = resolve;
          })
        : Promise.resolve(),
    );
    const credentialRecovery = createCredentialRecoveryModule({
      adapter: {
        stage: vi.fn(async () => ({ kind: 'unavailable' as const })),
        rollbackPending,
      },
      ledger: store.createRecoveryLedger(),
      dispatchAdapter: { dispatch: async () => ({ kind: 'rejected' }) },
      restoreSession: vi.fn(),
      now: () => now,
    });
    new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () => undefined,
      sendTurn: vi.fn(),
      credentialRecovery,
      now: () => now,
    });
    const firstCleanup = credentialRecovery.reconcile();
    expect(rollbackPending).toHaveBeenNthCalledWith(1, ['codex']);

    const claudeFingerprint = insertCompensation(
      'thread-claude-compensation',
      'claude',
    );
    resolveCodexCleanup?.();
    await firstCleanup;
    await Promise.resolve();

    expect(recoveryLedger(store).find(codexFingerprint)).toMatchObject({
      outcome: 'failed',
    });
    expect(rollbackPending).toHaveBeenNthCalledWith(2, undefined);
    expect(rollbackPending).toHaveBeenNthCalledWith(3, ['claude']);
    expect(recoveryLedger(store).find(claudeFingerprint)).toMatchObject({
      outcome: 'failed',
    });
    store.close();
  });

  test('restoration rejection quarantines the candidate session before recording failure', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const quarantineSession = vi.fn(async () => undefined);
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({
          metadata: {
            recovery: {
              sameSession: true,
              application: 'restart_resume',
            },
          },
        }) as any,
      sendTurn: vi.fn(),
      restartResume: vi.fn(async () => ({ turnId: 'candidate-turn' })),
      restoreSession: vi.fn(async () => {
        throw new Error('stop failed');
      }),
      quarantineSession,
      credentialRecoveryAdapter: {
        stage: async () => ({
          candidateProfileRef: 'backup',
          capability: 'restart_resume',
        }),
        commit: vi.fn(async () => {
          throw new Error('stale commit');
        }),
        rollback: vi.fn(async () => ({ kind: 'rolled-back' as const })),
      },
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started-restore-failure',
      provider: 'codex',
      threadId: 'thread-restore-failure',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'authoritative input',
    });
    coordinator.observe({
      eventId: 'exhausted-restore-failure',
      provider: 'codex',
      threadId: 'thread-restore-failure',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'runtime.error',
      severity: 'error',
      message: 'account capacity exhausted',
      details: { scope: 'account' },
    });
    await vi.advanceTimersByTimeAsync(0);
    coordinator.observe({
      eventId: 'completed-restore-failure',
      provider: 'codex',
      threadId: 'thread-restore-failure',
      turnId: 'candidate-turn',
      createdAt: now.toISOString(),
      method: 'turn.completed',
      finishReason: 'stop',
    });
    await vi.runAllTimersAsync();

    expect(quarantineSession).toHaveBeenCalledWith('thread-restore-failure');
    expect(
      coordinator.latestProjection('thread-restore-failure'),
    ).toMatchObject({ outcome: 'failed' });
    store.close();
    vi.useRealTimers();
  });

  test('shutdown after restart acknowledgement cancels and rolls back the resumed attempt', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const rollback = vi.fn(async () => ({ kind: 'rolled-back' as const }));
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({
          metadata: {
            recovery: {
              sameSession: true,
              application: 'restart_resume',
            },
          },
        }) as any,
      sendTurn: vi.fn(),
      restartResume: vi.fn(async () => ({ turnId: 'acknowledged-turn' })),
      credentialRecoveryAdapter: {
        stage: async () => ({
          candidateProfileRef: 'backup',
          capability: 'restart_resume',
        }),
        commit: vi.fn(async () => ({ kind: 'adopted' as const })),
        rollback,
      },
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started-acknowledged',
      provider: 'codex',
      threadId: 'thread-acknowledged',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'authoritative input',
    });
    coordinator.observe({
      eventId: 'exhausted-acknowledged',
      provider: 'codex',
      threadId: 'thread-acknowledged',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'runtime.error',
      severity: 'error',
      message: 'account capacity exhausted',
      details: { scope: 'account' },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.latestProjection('thread-acknowledged')).toMatchObject({
      outcome: 'resumed',
    });

    await coordinator.dispose();

    expect(rollback).toHaveBeenCalledOnce();
    expect(coordinator.latestProjection('thread-acknowledged')).toMatchObject({
      outcome: 'canceled',
    });
    store.close();
    vi.useRealTimers();
  });

  test('shutdown keeps a canceled claimed attempt durably compensable when rollback fails', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const rollback = vi.fn(async () => {
      throw new Error('rollback unavailable during shutdown');
    });
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({
          metadata: {
            recovery: {
              sameSession: true,
              application: 'restart_resume',
            },
          },
        }) as any,
      sendTurn: vi.fn(),
      restartResume: vi.fn(async () => ({ turnId: 'acknowledged-turn' })),
      credentialRecoveryAdapter: {
        stage: async () => ({
          candidateProfileRef: 'backup',
          capability: 'restart_resume',
        }),
        commit: vi.fn(async () => ({ kind: 'adopted' as const })),
        rollback,
        rollbackPending: vi.fn(async () => {
          throw new Error('compensation unavailable during shutdown');
        }),
      },
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started-shutdown-fault',
      provider: 'codex',
      threadId: 'thread-shutdown-fault',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'authoritative input',
    });
    coordinator.observe({
      eventId: 'exhausted-shutdown-fault',
      provider: 'codex',
      threadId: 'thread-shutdown-fault',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'runtime.error',
      severity: 'error',
      message: 'account capacity exhausted',
      details: { scope: 'account' },
    });
    await vi.advanceTimersByTimeAsync(0);

    await coordinator.dispose();

    expect(rollback).toHaveBeenCalledOnce();
    expect(
      recoveryLedger(store).find(
        'thread-shutdown-fault:source-turn:capacity:account',
      ),
    ).toMatchObject({ outcome: 'compensation-required' });
    store.close();
    vi.useRealTimers();
  });

  test('shutdown cancels the prepared manual profile recovery before staging settles', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const rollback = vi.fn(async () => ({ kind: 'rolled-back' as const }));
    let resolveStage:
      | ((attempt: {
          candidateProfileRef: string;
          capability: 'restart_resume';
        }) => void)
      | undefined;
    const stage = vi.fn(
      () =>
        new Promise<{
          candidateProfileRef: string;
          capability: 'restart_resume';
        }>((resolve) => {
          resolveStage = resolve;
        }),
    );
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({
          metadata: {
            recovery: {
              sameSession: true,
              application: 'restart_resume',
            },
          },
        }) as any,
      sendTurn: vi.fn(),
      restartResume: vi.fn(),
      credentialRecoveryAdapter: {
        stage,
        commit: vi.fn(async () => ({ kind: 'adopted' as const })),
        rollback,
      },
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started-manual-stage-shutdown',
      provider: 'codex',
      threadId: 'thread-manual-stage-shutdown',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'authoritative input',
    });
    coordinator.observe({
      eventId: 'exhausted-manual-stage-shutdown',
      provider: 'codex',
      threadId: 'thread-manual-stage-shutdown',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'runtime.error',
      severity: 'error',
      message: 'account capacity exhausted',
      details: { scope: 'account' },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stage).toHaveBeenCalledOnce();

    const disposing = coordinator.dispose();
    resolveStage?.({
      candidateProfileRef: 'backup',
      capability: 'restart_resume',
    });
    await disposing;

    expect(rollback).toHaveBeenCalledOnce();
    expect(
      coordinator.latestProjection('thread-manual-stage-shutdown'),
    ).toMatchObject({ outcome: 'canceled' });
    store.close();
    vi.useRealTimers();
  });

  test('shutdown during scheduled profile staging cancels and rolls back the claimed intent', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const rollback = vi.fn(async () => ({ kind: 'rolled-back' as const }));
    let resolveStage:
      | ((attempt: {
          candidateProfileRef: string;
          capability: 'restart_resume';
        }) => void)
      | undefined;
    const stage = vi.fn(
      () =>
        new Promise<{
          candidateProfileRef: string;
          capability: 'restart_resume';
        }>((resolve) => {
          resolveStage = resolve;
        }),
    );
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({
          metadata: {
            recovery: {
              sameSession: true,
              application: 'restart_resume',
            },
          },
        }) as any,
      sendTurn: vi.fn(),
      restartResume: vi.fn(),
      credentialRecoveryAdapter: {
        stage,
        commit: vi.fn(async () => ({ kind: 'adopted' as const })),
        rollback,
      },
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started-scheduled-stage-shutdown',
      provider: 'codex',
      threadId: 'thread-scheduled-stage-shutdown',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'authoritative input',
    });
    recoveryLedger(store).arm({
      fingerprint:
        'thread-scheduled-stage-shutdown:source-turn:capacity:account',
      threadId: 'thread-scheduled-stage-shutdown',
      provider: 'codex',
      sourceEventId: 'started-scheduled-stage-shutdown',
      sourceTurnId: 'source-turn',
      failureKind: 'capacity',
      scope: 'account',
      decision: 'retry-now',
      dueAt: now.toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    coordinator.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    expect(stage).toHaveBeenCalledOnce();

    const disposing = coordinator.dispose();
    resolveStage?.({
      candidateProfileRef: 'backup',
      capability: 'restart_resume',
    });
    await disposing;

    expect(rollback).toHaveBeenCalledOnce();
    expect(
      coordinator.latestProjection('thread-scheduled-stage-shutdown'),
    ).toMatchObject({ outcome: 'canceled' });
    store.close();
    vi.useRealTimers();
  });

  test.each(['shutdown', 'turn-abort'] as const)(
    'a completion that owns the lifecycle serializes a deferred commit before %s cancellation',
    async (cancellation) => {
      vi.useFakeTimers();
      const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
      dirs.push(dir);
      const store = new EventStore(join(dir, 'orchestration.sqlite'));
      const now = new Date('2026-07-29T12:00:00.000Z');
      let resolveCommit: ((outcome: { kind: 'adopted' }) => void) | undefined;
      const commit = vi.fn(
        () =>
          new Promise<{ kind: 'adopted' }>((resolve) => {
            resolveCommit = resolve;
          }),
      );
      const rollback = vi.fn(async () => ({ kind: 'rolled-back' as const }));
      const coordinator = new SessionRecoveryCoordinator({
        eventStore: store,
        adapterForProvider: () =>
          ({
            metadata: {
              recovery: {
                sameSession: true,
                application: 'restart_resume',
              },
            },
          }) as any,
        sendTurn: vi.fn(),
        restartResume: vi.fn(async () => ({ turnId: 'candidate-turn' })),
        credentialRecoveryAdapter: {
          stage: async () => ({
            candidateProfileRef: 'backup',
            capability: 'restart_resume',
          }),
          commit,
          rollback,
        },
        now: () => now,
      });
      store.appendEvent({
        eventId: `started-deferred-${cancellation}`,
        provider: 'codex',
        threadId: `thread-deferred-${cancellation}`,
        turnId: 'source-turn',
        createdAt: now.toISOString(),
        method: 'turn.started',
        prompt: 'authoritative input',
      });
      coordinator.observe({
        eventId: `exhausted-deferred-${cancellation}`,
        provider: 'codex',
        threadId: `thread-deferred-${cancellation}`,
        turnId: 'source-turn',
        createdAt: now.toISOString(),
        method: 'runtime.error',
        severity: 'error',
        message: 'account capacity exhausted',
        details: { scope: 'account' },
      });
      await vi.advanceTimersByTimeAsync(0);
      coordinator.observe({
        eventId: `completed-deferred-${cancellation}`,
        provider: 'codex',
        threadId: `thread-deferred-${cancellation}`,
        turnId: 'candidate-turn',
        createdAt: now.toISOString(),
        method: 'turn.completed',
        finishReason: 'stop',
      });
      await Promise.resolve();
      expect(commit).toHaveBeenCalledOnce();

      let disposal: Promise<void> | undefined;
      if (cancellation === 'shutdown') {
        disposal = coordinator.dispose();
      } else {
        coordinator.observe({
          eventId: 'aborted-after-completion',
          provider: 'codex',
          threadId: 'thread-deferred-turn-abort',
          turnId: 'candidate-turn',
          createdAt: now.toISOString(),
          method: 'turn.aborted',
          reason: 'late abort',
        });
      }
      resolveCommit?.({ kind: 'adopted' });
      await vi.runAllTimersAsync();
      await disposal;

      expect(
        coordinator.latestProjection(`thread-deferred-${cancellation}`),
      ).toMatchObject({ outcome: 'succeeded' });
      expect(rollback).not.toHaveBeenCalled();
      if (cancellation !== 'shutdown') await coordinator.dispose();
      store.close();
      vi.useRealTimers();
    },
  );

  test('reconciles a persisted wait after reconstruction and records success only on completion', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const sendTurn = vi.fn(async () => ({ turnId: 'recovered-turn' }));
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn,
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'authoritative input',
    });
    recoveryLedger(store).arm({
      fingerprint: 'thread:turn:rate-limit:server',
      threadId: 'thread',
      provider: 'claude',
      sourceEventId: 'started',
      sourceTurnId: 'turn',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'wait-until-reset',
      dueAt: now.toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    coordinator.reconcile();
    await vi.runAllTimersAsync();
    expect(sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread',
        input: 'authoritative input',
      }),
    );
    expect(coordinator.latestProjection('thread')).toMatchObject({
      outcome: 'resumed',
    });
    coordinator.observe({
      eventId: 'completed',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'recovered-turn',
      createdAt: now.toISOString(),
      method: 'turn.completed',
      finishReason: 'stop',
    });
    await vi.runAllTimersAsync();
    expect(coordinator.latestProjection('thread')).toMatchObject({
      outcome: 'succeeded',
    });
    store.close();
    vi.useRealTimers();
  });

  test('an adapter without declared capability does not dispatch or persist a raw error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const sendTurn = vi.fn(async () => ({ turnId: 'unexpected' }));
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () => ({ metadata: {} }) as any,
      sendTurn,
    });
    store.appendEvent({
      eventId: 'started',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: '2026-07-29T12:00:00.000Z',
      method: 'turn.started',
      prompt: 'authoritative input',
    });
    coordinator.observe({
      eventId: 'error',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: '2026-07-29T12:00:01.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: '429 token secret-value',
    });
    expect(sendTurn).not.toHaveBeenCalled();
    expect(coordinator.latestProjection('thread')).toMatchObject({
      decision: 'unsupported',
      outcome: 'unsupported',
    });
    expect(
      recoveryLedger(store).find('thread:turn:rate-limit:unknown'),
    ).not.toHaveProperty('message');
    expect(
      JSON.stringify(vi.mocked(connectionRecoveryOutcomes.add).mock.calls),
    ).not.toContain('secret-value');
    store.close();
  });

  test('projects an unknown-reset manual decision without dispatching', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const sendTurn = vi.fn(async () => ({ turnId: 'unexpected' }));
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn,
    });
    store.appendEvent({
      eventId: 'started-manual',
      provider: 'claude',
      threadId: 'manual-thread',
      turnId: 'manual-turn',
      createdAt: '2026-07-29T12:00:00.000Z',
      method: 'turn.started',
      prompt: 'authoritative input',
    });
    coordinator.observe({
      eventId: 'error-manual',
      provider: 'claude',
      threadId: 'manual-thread',
      turnId: 'manual-turn',
      createdAt: '2026-07-29T12:00:01.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'provider capacity unavailable',
    });
    expect(sendTurn).not.toHaveBeenCalled();
    expect(coordinator.latestProjection('manual-thread')).toMatchObject({
      decision: 'manual',
      outcome: 'manual',
    });
    store.close();
  });

  test('fails closed when an untrusted runtime-error detail cannot be read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const sendTurn = vi.fn();
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn,
    });
    store.appendEvent({
      eventId: 'started-unreadable',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: '2026-07-29T12:00:00.000Z',
      method: 'turn.started',
      prompt: 'authoritative input',
    });
    expect(() =>
      coordinator.observe({
        eventId: 'error-unreadable',
        provider: 'claude',
        threadId: 'thread',
        turnId: 'turn',
        createdAt: '2026-07-29T12:00:01.000Z',
        method: 'runtime.error',
        severity: 'error',
        message: 'provider capacity unavailable',
        details: new Proxy(
          {},
          {
            get: () => {
              throw new Error('untrusted detail');
            },
          },
        ),
      }),
    ).not.toThrow();
    expect(recoveryLedger(store).pending()).toEqual([]);
    expect(sendTurn).not.toHaveBeenCalled();
    store.close();
  });

  test('a recovered turn failure closes its intent instead of recursively rearming', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const sendTurn = vi.fn(async () => ({ turnId: 'recovered-turn' }));
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn,
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'authoritative input',
    });
    recoveryLedger(store).arm({
      fingerprint: 'thread:turn:rate-limit:server',
      threadId: 'thread',
      provider: 'claude',
      sourceEventId: 'started',
      sourceTurnId: 'turn',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'retry-now',
      dueAt: now.toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    coordinator.reconcile();
    await vi.runAllTimersAsync();
    coordinator.observe({
      eventId: 'recovered-error',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'recovered-turn',
      createdAt: now.toISOString(),
      method: 'runtime.error',
      severity: 'error',
      message: '429 still rate limited',
    });
    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(coordinator.latestProjection('thread')).toMatchObject({
      outcome: 'failed',
      attempts: 1,
    });
    expect(recoveryLedger(store).pending()).toEqual([]);
    store.close();
    vi.useRealTimers();
  });

  test('replays the canonical turn envelope through sendTurn without recovery-side content', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const sendTurn = vi.fn(async () => ({ turnId: 'recovered-turn' }));
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn,
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started-envelope',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'typed input',
      ambientContext: '[Timezone: America/Denver]',
      attachments: [
        {
          kind: 'image',
          name: 'screen.png',
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,AA==',
          size: 1,
        },
      ],
      metadata: {
        effectiveModel: 'claude-sonnet',
        effectiveModelOptions: { effort: 'high', fastMode: true },
        permissionMode: 'acceptEdits',
        approvalMode: 'auto',
      },
    });
    recoveryLedger(store).arm({
      fingerprint: 'thread:turn:rate-limit:server',
      threadId: 'thread',
      provider: 'claude',
      sourceEventId: 'started-envelope',
      sourceTurnId: 'turn',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'retry-now',
      dueAt: now.toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    coordinator.reconcile();
    await vi.runAllTimersAsync();
    expect(sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread',
        input: 'typed input',
        ambientContext: '[Timezone: America/Denver]',
        // The real bytes, not merely "an array": persistence stores these as a
        // blob reference (station#3374), so this is what proves the replay
        // resolves the reference rather than handing the provider a husk.
        attachments: [
          {
            kind: 'image',
            name: 'screen.png',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,AA==',
            size: 1,
            blobRef: expect.stringMatching(/^sha256-[0-9a-f]{64}$/),
          },
        ],
        modelId: 'claude-sonnet',
        modelOptions: {
          effort: 'high',
          fastMode: true,
          approvalMode: 'auto',
        },
      }),
    );
    expect(
      JSON.stringify(
        recoveryLedger(store).find('thread:turn:rate-limit:server'),
      ),
    ).not.toContain('typed input');
    store.close();
    vi.useRealTimers();
  });

  test('refuses to replay a turn whose attachment bytes are gone (#3374)', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const sendTurn = vi.fn(async () => ({ turnId: 'recovered-turn' }));
    const warn = vi.fn();
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn,
      now: () => now,
      logger: { warn },
    });
    store.appendEvent({
      eventId: 'started-reclaimed',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'what is in this screenshot?',
      attachments: [
        {
          kind: 'image',
          name: 'screen.png',
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,AA==',
          size: 1,
        },
      ],
    });
    // What retention leaves behind: the event still records the attachment,
    // the bytes it referenced are gone.
    rmSync(join(dir, 'attachments'), { recursive: true, force: true });
    recoveryLedger(store).arm({
      fingerprint: 'thread:turn:rate-limit:server',
      threadId: 'thread',
      provider: 'claude',
      sourceEventId: 'started-reclaimed',
      sourceTurnId: 'turn',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'retry-now',
      dueAt: now.toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    coordinator.reconcile();
    await vi.runAllTimersAsync();

    // Re-running the turn without the image asks the model a different
    // question than the user did, so the intent fails instead.
    expect(sendTurn).not.toHaveBeenCalled();
    expect(coordinator.latestProjection('thread')).toMatchObject({
      outcome: 'failed',
    });
    // The ledger row records `failed` with no reason column, so this log line
    // is the only place the user's failed recovery is explained. It must name
    // the attachment, not merely report that something went wrong.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('attachment bytes are no longer stored'),
      expect.objectContaining({ attachments: ['screen.png'] }),
    );
    store.close();
    vi.useRealTimers();
  });

  test.each([
    {
      provider: 'claude' as const,
      metadata: { permissionMode: 'plan' },
      expected: { permissionMode: 'plan' },
    },
    {
      provider: 'codex' as const,
      metadata: {
        approvalPolicy: 'untrusted',
        sandbox: 'workspace-write',
      },
      expected: { approvalMode: 'ask' },
    },
  ])(
    'reconstructs $provider raw approval posture when normalized approvalMode is absent',
    async ({ provider, metadata, expected }) => {
      vi.useFakeTimers();
      const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
      dirs.push(dir);
      const store = new EventStore(join(dir, 'orchestration.sqlite'));
      const now = new Date('2026-07-29T12:00:00.000Z');
      const sendTurn = vi.fn(async () => ({ turnId: 'recovered-turn' }));
      const coordinator = new SessionRecoveryCoordinator({
        eventStore: store,
        adapterForProvider: () =>
          ({ metadata: { recovery: { sameSession: true } } }) as any,
        sendTurn,
        now: () => now,
      });
      store.appendEvent({
        eventId: 'started-approval',
        provider,
        threadId: 'thread',
        turnId: 'turn',
        createdAt: now.toISOString(),
        method: 'turn.started',
        prompt: 'input',
        metadata,
      });
      recoveryLedger(store).arm({
        fingerprint: 'thread:turn:rate-limit:server',
        threadId: 'thread',
        provider,
        sourceEventId: 'started-approval',
        sourceTurnId: 'turn',
        failureKind: 'rate-limit',
        scope: 'server',
        decision: 'retry-now',
        dueAt: now.toISOString(),
        maxAttempts: 1,
        outcome: 'armed',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      coordinator.reconcile();
      await vi.runAllTimersAsync();
      expect(sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({ modelOptions: expected }),
      );
      store.close();
      vi.useRealTimers();
    },
  );

  test('projects reconnect as terminal manual work when no reconnect callback exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const sendTurn = vi.fn();
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn,
    });
    store.appendEvent({
      eventId: 'started-auth',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: '2026-07-29T12:00:00.000Z',
      method: 'turn.started',
      prompt: 'authoritative input',
    });
    coordinator.observe({
      eventId: 'error-auth',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: '2026-07-29T12:00:01.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'Authentication token expired',
    });
    expect(coordinator.latestProjection('thread')).toMatchObject({
      decision: 'reconnect',
      outcome: 'manual',
    });
    expect(recoveryLedger(store).pending()).toEqual([]);
    expect(sendTurn).not.toHaveBeenCalled();
    store.close();
  });

  test('source-turn abort cancels the timer before it can dispatch', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const sendTurn = vi.fn(async () => ({ turnId: 'unexpected' }));
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn,
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started-abort',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'input',
    });
    recoveryLedger(store).arm({
      fingerprint: 'thread:turn:rate-limit:server',
      threadId: 'thread',
      provider: 'claude',
      sourceEventId: 'started-abort',
      sourceTurnId: 'turn',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'wait-until-reset',
      dueAt: new Date(now.getTime() + 1_000).toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    coordinator.reconcile();
    coordinator.observe({
      eventId: 'aborted-source',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'turn.aborted',
      reason: 'user canceled',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendTurn).not.toHaveBeenCalled();
    expect(coordinator.latestProjection('thread')).toMatchObject({
      outcome: 'canceled',
    });
    store.close();
    vi.useRealTimers();
  });

  test('retries an unavailable first cancellation in its serialized lifecycle', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(
      join(tmpdir(), 'recovery-coordinator-cancel-retry-'),
    );
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const realLedger = recoveryLedger(store);
    const realCancel = realLedger.cancel.bind(realLedger);
    const cancel = vi
      .fn()
      .mockReturnValueOnce({ kind: 'unavailable' as const })
      .mockReturnValueOnce({ kind: 'unavailable' as const })
      .mockImplementation(realCancel);
    const ledger = new Proxy(realLedger, {
      get(target, property, receiver) {
        return property === 'cancel'
          ? cancel
          : Reflect.get(target, property, receiver);
      },
    });
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      recoveryLedger: ledger,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn: vi.fn(async () => ({ turnId: 'unexpected' })),
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started-cancel-retry',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'input',
    });
    realLedger.arm({
      fingerprint: 'thread:turn:rate-limit:server',
      threadId: 'thread',
      provider: 'claude',
      sourceEventId: 'started-cancel-retry',
      sourceTurnId: 'turn',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'wait-until-reset',
      dueAt: new Date(now.getTime() + 1_000).toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    coordinator.reconcile();
    coordinator.observe({
      eventId: 'aborted-cancel-retry',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'turn.aborted',
      reason: 'user canceled',
    });
    await vi.advanceTimersByTimeAsync(0);
    // Two unavailable writes leave the durable intent pending; the caller
    // must not observe a false cancellation before the serialized retry.
    expect(realLedger.find('thread:turn:rate-limit:server')).toMatchObject({
      outcome: 'armed',
    });
    expect(coordinator.latestProjection('thread')).toMatchObject({
      outcome: 'armed',
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(cancel).toHaveBeenCalledTimes(3);
    expect(realLedger.find('thread:turn:rate-limit:server')).toMatchObject({
      outcome: 'canceled',
    });
    expect(coordinator.latestProjection('thread')).toMatchObject({
      outcome: 'canceled',
    });
    store.close();
    vi.useRealTimers();
  });

  test('restarts from a durable source abort when every original cancellation write was unavailable', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(
      join(tmpdir(), 'recovery-coordinator-cancel-restart-'),
    );
    dirs.push(dir);
    const path = join(dir, 'orchestration.sqlite');
    const now = new Date('2026-07-29T12:00:00.000Z');
    const firstStore = new EventStore(path);
    const realLedger = recoveryLedger(firstStore);
    const unavailableLedger = new Proxy(realLedger, {
      get(target, property, receiver) {
        return property === 'cancel'
          ? () => ({ kind: 'unavailable' as const })
          : Reflect.get(target, property, receiver);
      },
    });
    const first = new SessionRecoveryCoordinator({
      eventStore: firstStore,
      recoveryLedger: unavailableLedger,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn: vi.fn(async () => ({ turnId: 'must-not-run' })),
      now: () => now,
    });
    firstStore.appendEvent({
      eventId: 'source-started-restart',
      provider: 'claude',
      threadId: 'thread-restart',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'input',
    });
    realLedger.arm({
      fingerprint: 'thread-restart:source-turn:rate-limit:server',
      threadId: 'thread-restart',
      provider: 'claude',
      sourceEventId: 'source-started-restart',
      sourceTurnId: 'source-turn',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'wait-until-reset',
      dueAt: new Date(now.getTime() + 60_000).toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    const sourceAborted = {
      eventId: 'source-aborted-restart',
      provider: 'claude',
      threadId: 'thread-restart',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'turn.aborted',
      reason: 'user canceled',
    } as const;
    firstStore.appendEvent(sourceAborted);
    first.observe(sourceAborted);
    await Promise.resolve();
    firstStore.close();

    const restartedStore = new EventStore(path);
    const dispatch = vi.fn(async () => ({ turnId: 'must-not-run' }));
    const restarted = new SessionRecoveryCoordinator({
      eventStore: restartedStore,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn: dispatch,
      now: () => now,
    });
    restarted.reconcile();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(
      recoveryLedger(restartedStore).find(
        'thread-restart:source-turn:rate-limit:server',
      ),
    ).toMatchObject({ outcome: 'canceled' });
    expect(dispatch).not.toHaveBeenCalled();
    restartedStore.close();
    vi.useRealTimers();
  });

  test('persists a shutdown cancellation fence when every cancel CAS is unavailable', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-shutdown-fence-'));
    dirs.push(dir);
    const path = join(dir, 'orchestration.sqlite');
    const store = new EventStore(path);
    const real = recoveryLedger(store);
    const unavailable = new Proxy(real, {
      get(target, property, receiver) {
        return property === 'cancel'
          ? () => ({ kind: 'unavailable' as const })
          : Reflect.get(target, property, receiver);
      },
    });
    const now = new Date('2026-08-13T00:00:00.000Z');
    const fingerprint = 'shutdown:turn:rate-limit:server';
    real.arm({
      fingerprint,
      threadId: 'shutdown',
      provider: 'claude',
      sourceEventId: 'shutdown-source',
      sourceTurnId: 'turn',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'wait-until-reset',
      dueAt: new Date(now.getTime() + 60_000).toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    const first = new SessionRecoveryCoordinator({
      eventStore: store,
      recoveryLedger: unavailable,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn: vi.fn(async () => ({ turnId: 'must-not-run' })),
      now: () => now,
    });
    await expect(first.dispose()).rejects.toMatchObject({
      code: 'RECOVERY_SHUTDOWN_UNSETTLED',
      pending: 1,
    });
    store.close();

    const restartedStore = new EventStore(path);
    const dispatch = vi.fn(async () => ({ turnId: 'must-not-run' }));
    const restarted = new SessionRecoveryCoordinator({
      eventStore: restartedStore,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn: dispatch,
      now: () => now,
    });
    restarted.reconcile();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recoveryLedger(restartedStore).find(fingerprint)).toMatchObject({
      outcome: 'canceled',
    });
    expect(dispatch).not.toHaveBeenCalled();
    await expect(restarted.dispose()).resolves.toBeUndefined();
    restartedStore.close();
    vi.useRealTimers();
  });

  test('refuses a re-entrant runtime error after dispose publishes its stopping gate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-stopping-gate-'));
    dirs.push(dir);
    const path = join(dir, 'orchestration.sqlite');
    const store = new EventStore(path);
    const now = new Date('2026-08-13T00:00:00.000Z');
    const real = recoveryLedger(store);
    let coordinator!: SessionRecoveryCoordinator;
    const stoppingLedger = new Proxy(real, {
      get(target, property, receiver) {
        if (property !== 'cancelShutdownRequested')
          return Reflect.get(target, property, receiver);
        return (at: string) => {
          // This runs synchronously from dispose's first shutdown operation,
          // before dispose reaches any await. It models a re-entrant provider
          // runtime.error while a shutdown storage call yields control.
          coordinator.observe({
            eventId: 'error-during-dispose',
            provider: 'claude',
            threadId: 'thread-during-dispose',
            turnId: 'source-turn',
            createdAt: at,
            method: 'runtime.error',
            severity: 'error',
            message: 'account capacity exhausted',
            details: { scope: 'account' },
          });
          return target.cancelShutdownRequested(at);
        };
      },
    });
    store.appendEvent({
      eventId: 'source-during-dispose',
      provider: 'claude',
      threadId: 'thread-during-dispose',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'input',
    });
    coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      recoveryLedger: stoppingLedger,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn: vi.fn(async () => ({ turnId: 'must-not-run' })),
      now: () => now,
    });

    await expect(coordinator.dispose()).resolves.toBeUndefined();
    expect(real.pending()).toEqual([]);
    store.close();

    const reopened = new EventStore(path);
    expect(recoveryLedger(reopened).pending()).toEqual([]);
    reopened.close();
  });

  test('resumed-turn abort cancels the correlated recovery intent', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn: async () => ({ turnId: 'recovered-turn' }),
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started-resumed',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'input',
    });
    recoveryLedger(store).arm({
      fingerprint: 'thread:turn:rate-limit:server',
      threadId: 'thread',
      provider: 'claude',
      sourceEventId: 'started-resumed',
      sourceTurnId: 'turn',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'retry-now',
      dueAt: now.toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    coordinator.reconcile();
    await vi.runAllTimersAsync();
    coordinator.observe({
      eventId: 'aborted-resumed',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'recovered-turn',
      createdAt: now.toISOString(),
      method: 'turn.aborted',
      reason: 'user canceled',
    });
    expect(coordinator.latestProjection('thread')).toMatchObject({
      outcome: 'canceled',
    });
    expect(recoveryLedger(store).pending()).toEqual([]);
    store.close();
    vi.useRealTimers();
  });

  test('source-turn abort cancels an already claimed dispatch', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    let dispatchedSignal: AbortSignal | undefined;
    const sendTurn = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<{ turnId: string }>((resolve) => {
          dispatchedSignal = signal;
          signal?.addEventListener('abort', () =>
            resolve({ turnId: 'canceled-turn' }),
          );
        }),
    );
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn,
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started-in-flight-abort',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'input',
    });
    recoveryLedger(store).arm({
      fingerprint: 'thread:turn:rate-limit:server',
      threadId: 'thread',
      provider: 'claude',
      sourceEventId: 'started-in-flight-abort',
      sourceTurnId: 'turn',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'retry-now',
      dueAt: now.toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    coordinator.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendTurn).toHaveBeenCalledTimes(1);
    coordinator.observe({
      eventId: 'aborted-source-in-flight',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'turn.aborted',
      reason: 'user canceled',
    });
    await vi.runAllTimersAsync();
    expect(dispatchedSignal?.aborted).toBe(true);
    expect(coordinator.latestProjection('thread')).toMatchObject({
      decision: 'retry-now',
      outcome: 'canceled',
    });
    store.close();
    vi.useRealTimers();
  });

  test('source-turn abort durably cancels a claimed dispatch that ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    let dispatchedSignal: AbortSignal | undefined;
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn: ({ signal }) => {
        dispatchedSignal = signal;
        return new Promise<{ turnId: string }>(() => {});
      },
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started-uncooperative-abort',
      provider: 'claude',
      threadId: 'thread-uncooperative-abort',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'input',
    });
    recoveryLedger(store).arm({
      fingerprint: 'thread-uncooperative-abort:source-turn:rate-limit:server',
      threadId: 'thread-uncooperative-abort',
      provider: 'claude',
      sourceEventId: 'started-uncooperative-abort',
      sourceTurnId: 'source-turn',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'retry-now',
      dueAt: now.toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    coordinator.reconcile();
    await vi.advanceTimersByTimeAsync(0);

    coordinator.observe({
      eventId: 'aborted-uncooperative-source',
      provider: 'claude',
      threadId: 'thread-uncooperative-abort',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'turn.aborted',
      reason: 'user canceled',
    });

    expect(dispatchedSignal?.aborted).toBe(true);
    expect(
      recoveryLedger(store).find(
        'thread-uncooperative-abort:source-turn:rate-limit:server',
      ),
    ).toMatchObject({ outcome: 'canceled' });
    store.close();
    vi.useRealTimers();
  });

  test('source-turn abort interrupts a recovered turn after sendTurn acknowledges it', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const interruptTurn = vi.fn(async () => undefined);
    let dispatchedSignal: AbortSignal | undefined;
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn: async ({ signal }) => {
        dispatchedSignal = signal;
        return { turnId: 'recovered-turn' };
      },
      interruptTurn,
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started-post-ack-abort',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'input',
    });
    recoveryLedger(store).arm({
      fingerprint: 'thread:turn:rate-limit:server',
      threadId: 'thread',
      provider: 'claude',
      sourceEventId: 'started-post-ack-abort',
      sourceTurnId: 'turn',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'retry-now',
      dueAt: now.toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    coordinator.reconcile();
    await vi.runAllTimersAsync();
    coordinator.observe({
      eventId: 'aborted-source-post-ack',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'turn.aborted',
      reason: 'user canceled',
    });
    await vi.runAllTimersAsync();
    expect(dispatchedSignal?.aborted).toBe(true);
    expect(interruptTurn).toHaveBeenCalledWith('thread', 'recovered-turn');
    expect(coordinator.latestProjection('thread')).toMatchObject({
      outcome: 'canceled',
    });
    store.close();
    vi.useRealTimers();
  });

  test('does not treat a local fast turn observation as provider acceptance', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const interruptTurn = vi.fn(async () => undefined);
    let coordinator: SessionRecoveryCoordinator;
    coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn: async ({ recoveryCorrelationId }) => {
        coordinator.observe({
          eventId: 'manual-started-concurrent',
          provider: 'claude',
          threadId: 'thread',
          turnId: 'manual-turn',
          createdAt: now.toISOString(),
          method: 'turn.started',
          prompt: 'manual input',
        });
        coordinator.observe({
          eventId: 'recovered-started-fast',
          provider: 'claude',
          threadId: 'thread',
          turnId: 'recovered-turn',
          createdAt: now.toISOString(),
          method: 'turn.started',
          prompt: 'input',
          metadata: { recoveryCorrelationId },
        });
        coordinator.observe({
          eventId: 'recovered-completed-fast',
          provider: 'claude',
          threadId: 'thread',
          turnId: 'recovered-turn',
          createdAt: now.toISOString(),
          method: 'turn.completed',
          finishReason: 'stop',
        });
        return { turnId: 'recovered-turn' };
      },
      interruptTurn,
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started-fast',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'input',
    });
    recoveryLedger(store).arm({
      fingerprint: 'thread:turn:rate-limit:server',
      threadId: 'thread',
      provider: 'claude',
      sourceEventId: 'started-fast',
      sourceTurnId: 'turn',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'retry-now',
      dueAt: now.toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    coordinator.reconcile();
    await vi.runAllTimersAsync();
    expect(coordinator.latestProjection('thread')).toMatchObject({
      outcome: 'resumed',
    });
    expect(interruptTurn).not.toHaveBeenCalled();
    store.close();
    vi.useRealTimers();
  });

  test('keeps a fast recovered failure terminal without contradictory cancellation telemetry', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const metricStart = vi.mocked(connectionRecoveryOutcomes.add).mock.calls
      .length;
    let coordinator: SessionRecoveryCoordinator;
    coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn: async ({ recoveryCorrelationId }) => {
        coordinator.observe({
          eventId: 'recovered-started-fast-failure',
          provider: 'claude',
          threadId: 'thread',
          turnId: 'recovered-turn',
          createdAt: now.toISOString(),
          method: 'turn.started',
          prompt: 'input',
          metadata: { recoveryCorrelationId },
        });
        coordinator.observe({
          eventId: 'recovered-failed-fast',
          provider: 'claude',
          threadId: 'thread',
          turnId: 'recovered-turn',
          createdAt: now.toISOString(),
          method: 'runtime.error',
          severity: 'error',
          message: 'still unavailable',
        });
        return { turnId: 'recovered-turn' };
      },
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started-fast-failure',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'input',
    });
    recoveryLedger(store).arm({
      fingerprint: 'thread:turn:rate-limit:server',
      threadId: 'thread',
      provider: 'claude',
      sourceEventId: 'started-fast-failure',
      sourceTurnId: 'turn',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'retry-now',
      dueAt: now.toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    coordinator.reconcile();
    await vi.runAllTimersAsync();
    expect(coordinator.latestProjection('thread')).toMatchObject({
      outcome: 'failed',
    });
    const newOutcomes = vi
      .mocked(connectionRecoveryOutcomes.add)
      .mock.calls.slice(metricStart)
      .map(([, attributes]) => attributes?.outcome);
    expect(newOutcomes).toContain('failed');
    expect(newOutcomes).not.toContain('canceled');
    store.close();
    vi.useRealTimers();
  });

  test('station#3510: a runtime.error persisted before dispatch acceptance still completes the recovery intent', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      recoveryDispatchAdapter: {
        dispatch: async () => {
          // Simulates the provider stream publishing a canonical terminal
          // for the recovered turn BEFORE the dispatch promise itself
          // resolves acceptance — durable (appended to the store), but
          // never observed LIVE by the coordinator. This is the exact race
          // station#3510 describes: a turn that fails before
          // `recoveryDispatchAdapter.dispatch` returns.
          store.appendEvent({
            eventId: 'recovered-turn-failed',
            provider: 'codex',
            threadId: 'thread',
            turnId: 'recovered-turn',
            createdAt: now.toISOString(),
            method: 'runtime.error',
            severity: 'error',
            message: 'stream disconnected',
          });
          return { kind: 'accepted', turnId: 'recovered-turn' };
        },
      },
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started',
      provider: 'codex',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'authoritative input',
    });
    recoveryLedger(store).arm({
      fingerprint: 'thread:turn:rate-limit:server',
      threadId: 'thread',
      provider: 'codex',
      sourceEventId: 'started',
      sourceTurnId: 'turn',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'retry-now',
      dueAt: now.toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    coordinator.reconcile();
    await vi.runAllTimersAsync();
    // Before the station#3510 fix, `replayObservedTerminal` searched only
    // `turn.completed`/`turn.aborted` and found nothing here — the intent
    // stayed `resumed` forever. It must now close as `failed`.
    expect(recoveryLedger(store).latestProjection('thread')).toMatchObject({
      outcome: 'failed',
    });
    expect(recoveryLedger(store).pending()).toEqual([]);
    store.close();
    vi.useRealTimers();
  });

  test('station#3510: a deferred-retriable runtime.error found on replay does not close the intent', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      recoveryDispatchAdapter: {
        dispatch: async () => {
          // codex's own willRetry error: `isDeferredRetriableTurnError` —
          // the SAME predicate the stall watchdog uses — must exclude this
          // from the replay search too, or the two would disagree about
          // whether the turn had ended (station#3510's explicit condition).
          store.appendEvent({
            eventId: 'recovered-turn-retriable',
            provider: 'codex',
            threadId: 'thread',
            turnId: 'recovered-turn',
            createdAt: now.toISOString(),
            method: 'runtime.error',
            severity: 'error',
            message: 'stream disconnected, retrying',
            retriable: true,
          });
          return { kind: 'accepted', turnId: 'recovered-turn' };
        },
      },
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started',
      provider: 'codex',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'authoritative input',
    });
    recoveryLedger(store).arm({
      fingerprint: 'thread:turn:rate-limit:server',
      threadId: 'thread',
      provider: 'codex',
      sourceEventId: 'started',
      sourceTurnId: 'turn',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'retry-now',
      dueAt: now.toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    coordinator.reconcile();
    await vi.runAllTimersAsync();
    expect(recoveryLedger(store).latestProjection('thread')).toMatchObject({
      outcome: 'resumed',
    });
    store.close();
    vi.useRealTimers();
  });

  test('keeps same-thread exclusion until the recovered turn is terminal', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const sendTurn = vi.fn(async () => ({ turnId: 'recovered-turn' }));
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn,
      now: () => now,
    });
    for (const suffix of ['one', 'two']) {
      store.appendEvent({
        eventId: `started-${suffix}`,
        provider: 'claude',
        threadId: 'thread',
        turnId: `turn-${suffix}`,
        createdAt: now.toISOString(),
        method: 'turn.started',
        prompt: suffix,
      });
      recoveryLedger(store).arm({
        fingerprint: `thread:turn-${suffix}:rate-limit:server`,
        threadId: 'thread',
        provider: 'claude',
        sourceEventId: `started-${suffix}`,
        sourceTurnId: `turn-${suffix}`,
        failureKind: 'rate-limit',
        scope: 'server',
        decision: 'retry-now',
        dueAt: now.toISOString(),
        maxAttempts: 1,
        outcome: 'armed',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
    }
    coordinator.reconcile();
    await vi.runAllTimersAsync();
    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(
      recoveryLedger(store).find('thread:turn-one:rate-limit:server'),
    ).toMatchObject({ outcome: 'resumed' });
    expect(
      recoveryLedger(store).find('thread:turn-two:rate-limit:server'),
    ).toMatchObject({ outcome: 'failed' });
    store.close();
    vi.useRealTimers();
  });

  test('shutdown aborts and awaits a claimed dispatch and blocks future timer dispatch', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    let dispatchedSignal: AbortSignal | undefined;
    const sendTurn = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<{ turnId: string }>((resolve) => {
          dispatchedSignal = signal;
          signal?.addEventListener('abort', () =>
            resolve({ turnId: 'late-turn' }),
          );
        }),
    );
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn,
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started-shutdown',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'input',
    });
    recoveryLedger(store).arm({
      fingerprint: 'thread:turn:rate-limit:server',
      threadId: 'thread',
      provider: 'claude',
      sourceEventId: 'started-shutdown',
      sourceTurnId: 'turn',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'retry-now',
      dueAt: now.toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    coordinator.reconcile();
    await vi.runAllTimersAsync();
    await coordinator.dispose();
    expect(dispatchedSignal?.aborted).toBe(true);
    expect(coordinator.latestProjection('thread')).toMatchObject({
      outcome: 'canceled',
    });
    recoveryLedger(store).arm({
      fingerprint: 'thread:later:rate-limit:server',
      threadId: 'thread',
      provider: 'claude',
      sourceEventId: 'started-shutdown',
      sourceTurnId: 'later',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'wait-until-reset',
      dueAt: new Date(now.getTime() + 1_000).toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    coordinator.reconcile();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendTurn).toHaveBeenCalledTimes(1);
    store.close();
    vi.useRealTimers();
  });

  test('shutdown durably cancels when a claimed dispatch ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'recovery-coordinator-'));
    dirs.push(dir);
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    const now = new Date('2026-07-29T12:00:00.000Z');
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({ metadata: { recovery: { sameSession: true } } }) as any,
      sendTurn: () => new Promise<{ turnId: string }>(() => {}),
      now: () => now,
    });
    store.appendEvent({
      eventId: 'started-uncooperative-shutdown',
      provider: 'claude',
      threadId: 'thread-uncooperative-shutdown',
      turnId: 'source-turn',
      createdAt: now.toISOString(),
      method: 'turn.started',
      prompt: 'input',
    });
    recoveryLedger(store).arm({
      fingerprint:
        'thread-uncooperative-shutdown:source-turn:rate-limit:server',
      threadId: 'thread-uncooperative-shutdown',
      provider: 'claude',
      sourceEventId: 'started-uncooperative-shutdown',
      sourceTurnId: 'source-turn',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'retry-now',
      dueAt: now.toISOString(),
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    coordinator.reconcile();
    await vi.advanceTimersByTimeAsync(0);

    const disposal = coordinator.dispose();
    await vi.advanceTimersByTimeAsync(500);
    await disposal;

    expect(
      recoveryLedger(store).find(
        'thread-uncooperative-shutdown:source-turn:rate-limit:server',
      ),
    ).toMatchObject({ outcome: 'canceled' });
    store.close();
    vi.useRealTimers();
  });
});
