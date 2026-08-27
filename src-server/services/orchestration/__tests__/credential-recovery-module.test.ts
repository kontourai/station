import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectionRecoveryIntent } from '@kontourai/station-contracts/connection-recovery';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  type CredentialProfileRecoveryAdapter,
  type CredentialProfileRecoveryAttempt,
  type CredentialProfileStageOutcome,
  type CredentialReceiptAcknowledgement,
  type CredentialSettlementOutcome,
  createCredentialRecoveryModule,
} from '../credential-recovery-module.js';
import { EventStore } from '../event-store.js';
import type { RecoveryDispatchAdapter } from '../recovery-dispatch-adapter.js';
import type { RecoveryLedger } from '../recovery-ledger.js';

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

/** Keeps approved #2526 behaviour tests at the new Adapter seam. */
function createCredentialRecoveryModuleForTest(
  dependencies: Omit<
    Parameters<typeof createCredentialRecoveryModule>[0],
    'ledger' | 'dispatchAdapter' | 'adapter'
  > & {
    /** Test fixture owns SQLite; production composes this Interface once. */
    eventStore: EventStore;
    ledger?: RecoveryLedger;
    adapter: TestCredentialRecoveryAdapter;
    restartResume: (input: {
      threadId: string;
      input: string;
      recoveryCorrelationId: string;
      signal: AbortSignal;
      credentialProfileRef?: string;
    }) => Promise<{ turnId: string }>;
  },
) {
  const { restartResume, eventStore, adapter, ledger, ...rest } = dependencies;
  const dispatchAdapter: RecoveryDispatchAdapter = {
    dispatch: async ({ replay, credentialProfileRef }) => {
      const result = await restartResume({ ...replay, credentialProfileRef });
      return { kind: 'accepted', turnId: result.turnId };
    },
  };
  const recoveryAdapter = {
    ...adapter,
    stage: async (
      input: Parameters<CredentialProfileRecoveryAdapter['stage']>[0],
    ) => {
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
                adapter.commit ?? (async () => ({ kind: 'adopted' as const })),
              rollback:
                adapter.rollback ??
                (async () => ({ kind: 'rolled-back' as const })),
              acknowledge:
                adapter.acknowledge ??
                (async () => ({ kind: 'applied' as const })),
            });
      const privateApplication = eventStore
        .createCredentialApplicationFactory()
        .start({
          recoveryFingerprint: input.recoveryFingerprint,
          connectionId: input.provider,
          candidateProfileRef: attempt.candidateProfileRef,
          now: new Date().toISOString(),
        });
      if (privateApplication.kind !== 'owner')
        return { kind: 'indeterminate' as const };
      privateApplication.claim.staged(new Date().toISOString());
      return { kind: 'staged' as const, attempt };
    },
  };
  const composedLedger =
    ledger ??
    eventStore.createRecoveryLedger({
      credentialStartup: {
        inspect: (input) =>
          recoveryAdapter.inspectStartup?.(input) ??
          Promise.resolve({ kind: 'indeterminate' as const }),
        settle: (input) =>
          recoveryAdapter.settleStartup?.(input) ??
          Promise.resolve({ kind: 'indeterminate' as const }),
        acknowledge: async (input) =>
          (await recoveryAdapter.acknowledgeStartup?.(input)) ?? {
            kind: 'unavailable' as const,
          },
      },
    });
  return createCredentialRecoveryModule({
    ...rest,
    adapter: recoveryAdapter,
    ledger: composedLedger,
    dispatchAdapter,
  });
}

describe('CredentialRecoveryModule', () => {
  const directories: string[] = [];
  afterEach(() =>
    directories
      .splice(0)
      .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
  );

  function fixture() {
    const directory = mkdtempSync(
      join(tmpdir(), 'credential-recovery-module-'),
    );
    directories.push(directory);
    const eventStore = new EventStore(join(directory, 'orchestration.sqlite'));
    const intent = recoveryLedger(eventStore).arm({
      fingerprint: 'thread:turn:capacity:account',
      threadId: 'thread',
      provider: 'codex',
      sourceEventId: 'event',
      sourceTurnId: 'turn',
      failureKind: 'capacity',
      scope: 'account',
      decision: 'retry-now',
      dueAt: '2026-08-12T00:00:00.000Z',
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    return {
      eventStore,
      intent,
      databasePath: join(directory, 'orchestration.sqlite'),
    };
  }

  function markCompensation(
    eventStore: EventStore,
    intent: ConnectionRecoveryIntent,
  ) {
    const claim = eventStore.createRecoveryLedger().claim({
      fingerprint: intent.fingerprint,
      kind: 'profile',
      now: '2026-08-12T00:00:01.000Z',
    });
    expect(claim.kind).toBe('owner');
    if (claim.kind === 'owner') {
      claim.attempt.indeterminate('2026-08-12T00:00:01.500Z');
    }
    expect(
      recoveryLedger(eventStore).compensationRequired(
        intent.fingerprint,
        '2026-08-12T00:00:02.000Z',
        'indeterminate',
      ),
    ).toEqual({ kind: 'applied' });
  }

  test('shares one concurrent claim, then commits only after the recovered turn completes', async () => {
    const { eventStore, intent } = fixture();
    const commit = vi.fn(async () => ({ kind: 'adopted' as const }));
    const stage = vi.fn(async () => credentialAttempt({ commit }));
    const restartResume = vi.fn(async () => ({ turnId: 'recovered-turn' }));
    const module = createCredentialRecoveryModuleForTest({
      eventStore,
      adapter: {
        stage,
      },
      restartResume,
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
    });
    const observation = {
      intent,
      replay: {
        threadId: 'thread',
        input: 'authoritative',
        recoveryCorrelationId: 'id',
        signal: new AbortController().signal,
      },
    };
    await expect(
      Promise.all([module.recover(observation), module.recover(observation)]),
    ).resolves.toEqual([
      { kind: 'restarted', turnId: 'recovered-turn' },
      { kind: 'restarted', turnId: 'recovered-turn' },
    ]);
    expect(stage).toHaveBeenCalledOnce();
    expect(restartResume).toHaveBeenCalledOnce();
    await expect(module.complete(intent)).resolves.toEqual({
      kind: 'recovered',
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(recoveryLedger(eventStore).find(intent.fingerprint)).toMatchObject({
      outcome: 'succeeded',
    });
    eventStore.close();
  });

  test('retries an unavailable durable terminal without committing the opaque attempt twice', async () => {
    const { eventStore, intent } = fixture();
    const ledger = recoveryLedger(eventStore);
    const terminal = ledger.terminal.bind(ledger);
    vi.spyOn(ledger, 'terminal')
      .mockReturnValueOnce({ kind: 'unavailable' })
      .mockImplementation(terminal);
    const commit = vi.fn(async () => ({ kind: 'adopted' as const }));
    const module = createCredentialRecoveryModuleForTest({
      eventStore,
      ledger,
      adapter: {
        stage: vi.fn(async () => credentialAttempt({ commit })),
      },
      restartResume: vi.fn(async () => ({ turnId: 'recovered-turn' })),
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
    });
    await expect(
      module.recover({
        intent,
        replay: {
          threadId: 'thread',
          input: 'authoritative',
          recoveryCorrelationId: 'id',
          signal: new AbortController().signal,
        },
      }),
    ).resolves.toEqual({ kind: 'restarted', turnId: 'recovered-turn' });
    await expect(module.complete(intent)).resolves.toEqual({
      kind: 'indeterminate',
    });
    await expect(module.complete(intent)).resolves.toEqual({
      kind: 'recovered',
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(ledger.find(intent.fingerprint)).toMatchObject({
      outcome: 'succeeded',
    });
    eventStore.close();
  });

  test('retries only exact receipt acknowledgement after the ledger terminal succeeds', async () => {
    const { eventStore, intent } = fixture();
    const commit = vi.fn(async () => ({ kind: 'adopted' as const }));
    const acknowledge = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable' as const })
      .mockResolvedValueOnce({ kind: 'applied' as const });
    const module = createCredentialRecoveryModuleForTest({
      eventStore,
      adapter: {
        stage: vi.fn(async () => credentialAttempt({ commit, acknowledge })),
      },
      restartResume: vi.fn(async () => ({ turnId: 'turn' })),
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
    });
    const observation = {
      intent,
      replay: {
        threadId: 'thread',
        input: 'authoritative',
        recoveryCorrelationId: 'id',
        signal: new AbortController().signal,
      },
    };
    await module.recover(observation);
    await expect(module.complete(intent)).resolves.toEqual({
      kind: 'indeterminate',
    });
    expect(recoveryLedger(eventStore).find(intent.fingerprint)).toMatchObject({
      outcome: 'succeeded',
    });
    await expect(module.complete(intent)).resolves.toEqual({
      kind: 'recovered',
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledTimes(2);
    eventStore.close();
  });

  test('keeps an unknown linked receipt out of every broad startup sweep', async () => {
    const { eventStore, databasePath, intent } = fixture();
    const first = createCredentialRecoveryModuleForTest({
      eventStore,
      adapter: {
        stage: vi.fn(async () => credentialAttempt()),
      },
      restartResume: vi.fn(async () => ({ turnId: 'turn' })),
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
    });
    await first.recover({
      intent,
      replay: {
        threadId: 'thread',
        input: 'authoritative',
        recoveryCorrelationId: 'id',
        signal: new AbortController().signal,
      },
    });
    eventStore.close();

    const restarted = new EventStore(databasePath);
    const rollbackPending = vi.fn(async () => undefined);
    const inspectStartup = vi.fn(async () => ({ kind: 'unknown' as const }));
    const second = createCredentialRecoveryModuleForTest({
      eventStore: restarted,
      adapter: {
        stage: vi.fn(async () => undefined),
        inspectStartup,
        rollbackPending,
      },
      restartResume: vi.fn(async () => ({ turnId: 'unexpected' })),
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:01.000Z'),
    });
    await expect(second.reconcile()).resolves.toEqual({
      kind: 'indeterminate',
      pending: 1,
    });
    await expect(second.reconcile()).resolves.toEqual({
      kind: 'indeterminate',
      pending: 1,
    });
    expect(inspectStartup).toHaveBeenCalledTimes(2);
    expect(rollbackPending).not.toHaveBeenCalled();
    restarted.close();
  });

  test('drains unrelated scoped compensation while an exact receipt remains indeterminate', async () => {
    const { eventStore, databasePath, intent } = fixture();
    const first = createCredentialRecoveryModuleForTest({
      eventStore,
      adapter: { stage: vi.fn(async () => credentialAttempt()) },
      restartResume: vi.fn(async () => ({ turnId: 'turn' })),
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
    });
    await first.recover({
      intent,
      replay: {
        threadId: 'thread',
        input: 'authoritative',
        recoveryCorrelationId: 'id',
        signal: new AbortController().signal,
      },
    });
    eventStore.close();

    const restarted = new EventStore(databasePath);
    const unrelated = recoveryLedger(restarted).arm({
      fingerprint: 'unrelated:turn:capacity:account',
      threadId: 'unrelated',
      provider: 'claude',
      sourceEventId: 'unrelated-event',
      sourceTurnId: 'turn',
      failureKind: 'capacity',
      scope: 'account',
      decision: 'retry-now',
      dueAt: '2026-08-12T00:00:00.000Z',
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    markCompensation(restarted, unrelated);
    const rollbackPending = vi.fn(async () => undefined);
    const module = createCredentialRecoveryModuleForTest({
      eventStore: restarted,
      adapter: {
        stage: vi.fn(async () => undefined),
        inspectStartup: vi.fn(async () => ({ kind: 'indeterminate' as const })),
        rollbackPending,
      },
      restartResume: vi.fn(async () => ({ turnId: 'unexpected' })),
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:01.000Z'),
    });

    await expect(module.reconcile()).resolves.toEqual({
      kind: 'indeterminate',
      pending: 1,
    });
    expect(rollbackPending).toHaveBeenCalledExactlyOnceWith(['claude']);
    expect(rollbackPending).not.toHaveBeenCalledWith(undefined);
    expect(recoveryLedger(restarted).find(unrelated.fingerprint)).toMatchObject(
      {
        outcome: 'failed',
      },
    );
    restarted.close();
  });

  test('settles an accepted linked adopted receipt after a restart without broad rollback', async () => {
    const { eventStore, databasePath, intent } = fixture();
    const first = createCredentialRecoveryModuleForTest({
      eventStore,
      adapter: {
        stage: vi.fn(async () => credentialAttempt()),
      },
      restartResume: vi.fn(async () => ({ turnId: 'turn' })),
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
    });
    await first.recover({
      intent,
      replay: {
        threadId: 'thread',
        input: 'authoritative',
        recoveryCorrelationId: 'id',
        signal: new AbortController().signal,
      },
    });
    eventStore.close();

    const restarted = new EventStore(databasePath);
    const rollbackPending = vi.fn(async () => undefined);
    const second = createCredentialRecoveryModuleForTest({
      eventStore: restarted,
      adapter: {
        stage: vi.fn(async () => undefined),
        inspectStartup: vi.fn(async () => ({
          kind: 'already-adopted' as const,
        })),
        acknowledgeStartup: vi.fn(async () => ({ kind: 'applied' as const })),
        rollbackPending,
      },
      restartResume: vi.fn(async () => ({ turnId: 'unexpected' })),
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:01.000Z'),
    });
    await expect(second.reconcile()).resolves.toEqual({
      kind: 'reconciled',
      recovered: 0,
    });
    expect(recoveryLedger(restarted).find(intent.fingerprint)).toMatchObject({
      outcome: 'succeeded',
    });
    expect(rollbackPending).not.toHaveBeenCalled();
    restarted.close();
  });

  test('holds concurrent recovery behind the one startup sweep, then shares its claim and commit', async () => {
    const { eventStore, intent } = fixture();
    let releaseOrphanSweep: (() => void) | undefined;
    let enteredOrphanSweep: (() => void) | undefined;
    const orphanSweepEntered = new Promise<void>((resolve) => {
      enteredOrphanSweep = resolve;
    });
    let stagedApplication = false;
    const stage = vi.fn(async () => {
      stagedApplication = true;
      return {
        candidateProfileRef: 'opaque',
        capability: 'restart_resume' as const,
      };
    });
    const restartResume = vi.fn(async () => ({ turnId: 'recovered-turn' }));
    const commit = vi.fn(async () => {
      expect(stagedApplication).toBe(true);
      return { kind: 'adopted' as const };
    });
    const module = createCredentialRecoveryModuleForTest({
      eventStore,
      adapter: {
        stage,
        commit,
        rollback: vi.fn(async () => ({ kind: 'rolled-back' as const })),
        rollbackPending: vi.fn((providers?: string[]) => {
          expect(providers).toBeUndefined();
          enteredOrphanSweep?.();
          return new Promise<void>((resolve) => {
            releaseOrphanSweep = resolve;
          });
        }),
      },
      restartResume,
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
    });
    const observation = {
      intent,
      replay: {
        threadId: 'thread',
        input: 'authoritative',
        recoveryCorrelationId: 'id',
        signal: new AbortController().signal,
      },
    };

    const first = module.recover(observation);
    const second = module.recover(observation);
    await orphanSweepEntered;
    expect(stage).not.toHaveBeenCalled();
    expect(restartResume).not.toHaveBeenCalled();

    releaseOrphanSweep?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'restarted', turnId: 'recovered-turn' },
      { kind: 'restarted', turnId: 'recovered-turn' },
    ]);
    expect(stage).toHaveBeenCalledOnce();
    expect(restartResume).toHaveBeenCalledOnce();
    await expect(module.complete(intent)).resolves.toEqual({
      kind: 'recovered',
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(recoveryLedger(eventStore).find(intent.fingerprint)).toMatchObject({
      outcome: 'succeeded',
    });
    eventStore.close();
  });

  test('keeps a competing Module from turning another durable claim into failure', async () => {
    const { eventStore, intent } = fixture();
    const stage = vi.fn(async () => ({
      candidateProfileRef: 'opaque',
      capability: 'restart_resume' as const,
    }));
    const restartResume = vi.fn(async () => ({ turnId: 'recovered-turn' }));
    const dependencies = {
      eventStore,
      adapter: {
        stage,
        commit: vi.fn(async () => ({ kind: 'adopted' as const })),
        rollback: vi.fn(async () => ({ kind: 'rolled-back' as const })),
      },
      restartResume,
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
    };
    const first = createCredentialRecoveryModuleForTest(dependencies);
    const second = createCredentialRecoveryModuleForTest(dependencies);
    const observation = {
      intent,
      replay: {
        threadId: 'thread',
        input: 'authoritative',
        recoveryCorrelationId: 'id',
        signal: new AbortController().signal,
      },
    };

    await expect(
      Promise.all([first.recover(observation), second.recover(observation)]),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: 'restarted', turnId: 'recovered-turn' },
        { kind: 'conflicted' },
      ]),
    );
    expect(restartResume).toHaveBeenCalledOnce();
    expect(recoveryLedger(eventStore).find(intent.fingerprint)).toMatchObject({
      outcome: 'resumed',
    });
    eventStore.close();
  });

  test('keeps a rollback failure durable and exposes it as indeterminate for later compensation', async () => {
    const { eventStore, intent } = fixture();
    const rollback = vi.fn(async () => {
      throw new Error('rollback unavailable');
    });
    const module = createCredentialRecoveryModuleForTest({
      eventStore,
      adapter: {
        stage: vi.fn(async () => ({
          candidateProfileRef: 'opaque',
          capability: 'restart_resume' as const,
        })),
        commit: vi.fn(async () => {
          throw new Error('commit stale');
        }),
        rollback,
        rollbackPending: vi.fn(async () => {
          throw new Error('still unavailable');
        }),
      },
      restartResume: vi.fn(async () => ({ turnId: 'recovered-turn' })),
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
    });
    await module.recover({
      intent,
      replay: {
        threadId: 'thread',
        input: 'authoritative',
        recoveryCorrelationId: 'id',
        signal: new AbortController().signal,
      },
    });
    await expect(module.complete(intent)).resolves.toEqual({
      kind: 'indeterminate',
    });
    expect(rollback).toHaveBeenCalledOnce();
    expect(recoveryLedger(eventStore).find(intent.fingerprint)).toMatchObject({
      outcome: 'compensation-required',
    });
    eventStore.close();
  });

  test('runs pre-existing scoped compensation before exactly one identity-free startup sweep', async () => {
    const { eventStore, intent } = fixture();
    markCompensation(eventStore, intent);
    let releaseScoped: (() => void) | undefined;
    const rollbackPending = vi.fn((providers?: string[]) => {
      if (providers?.includes('codex')) {
        return new Promise<void>((resolve) => {
          releaseScoped = resolve;
        });
      }
      return Promise.resolve();
    });
    const module = createCredentialRecoveryModuleForTest({
      eventStore,
      adapter: {
        stage: vi.fn(async () => undefined),
        commit: vi.fn(async () => ({ kind: 'adopted' as const })),
        rollback: vi.fn(async () => ({ kind: 'rolled-back' as const })),
        rollbackPending,
      },
      restartResume: vi.fn(async () => ({ turnId: 'unexpected' })),
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:03.000Z'),
    });

    const reconciliation = module.reconcile();
    expect(rollbackPending).toHaveBeenNthCalledWith(1, ['codex']);
    releaseScoped?.();
    await expect(reconciliation).resolves.toEqual({
      kind: 'reconciled',
      recovered: 1,
    });
    expect(rollbackPending).toHaveBeenCalledTimes(2);
    expect(rollbackPending).toHaveBeenNthCalledWith(2, undefined);
    expect(recoveryLedger(eventStore).find(intent.fingerprint)).toMatchObject({
      outcome: 'failed',
    });
    eventStore.close();
  });

  test('gives every marker created during deferred scoped compensation its own later pass', async () => {
    const { eventStore, intent } = fixture();
    markCompensation(eventStore, intent);
    let releaseCodex: (() => void) | undefined;
    let releaseClaude: (() => void) | undefined;
    let enteredClaude: (() => void) | undefined;
    const claudeEntered = new Promise<void>((resolve) => {
      enteredClaude = resolve;
    });
    const rollbackPending = vi.fn((providers?: string[]) => {
      if (providers?.includes('codex')) {
        return new Promise<void>((resolve) => {
          releaseCodex = resolve;
        });
      }
      if (providers?.includes('claude')) {
        enteredClaude?.();
        return new Promise<void>((resolve) => {
          releaseClaude = resolve;
        });
      }
      return Promise.resolve();
    });
    const module = createCredentialRecoveryModuleForTest({
      eventStore,
      adapter: {
        stage: vi.fn(async () => undefined),
        commit: vi.fn(async () => ({ kind: 'adopted' as const })),
        rollback: vi.fn(async () => ({ kind: 'rolled-back' as const })),
        rollbackPending,
      },
      restartResume: vi.fn(async () => ({ turnId: 'unexpected' })),
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:03.000Z'),
    });

    const reconciliation = module.reconcile();
    expect(rollbackPending).toHaveBeenNthCalledWith(1, ['codex']);
    const later = recoveryLedger(eventStore).arm({
      fingerprint: 'thread-later:turn:capacity:account',
      threadId: 'thread-later',
      provider: 'claude',
      sourceEventId: 'event-later',
      sourceTurnId: 'turn-later',
      failureKind: 'capacity',
      scope: 'account',
      decision: 'retry-now',
      dueAt: '2026-08-12T00:00:00.000Z',
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    markCompensation(eventStore, later);
    expect(recoveryLedger(eventStore).find(later.fingerprint)).toMatchObject({
      outcome: 'compensation-required',
    });
    releaseCodex?.();

    await claudeEntered;
    const latest = recoveryLedger(eventStore).arm({
      fingerprint: 'thread-latest:turn:capacity:account',
      threadId: 'thread-latest',
      provider: 'muse',
      sourceEventId: 'event-latest',
      sourceTurnId: 'turn-latest',
      failureKind: 'capacity',
      scope: 'account',
      decision: 'retry-now',
      dueAt: '2026-08-12T00:00:00.000Z',
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    markCompensation(eventStore, latest);
    releaseClaude?.();

    await expect(reconciliation).resolves.toEqual({
      kind: 'reconciled',
      recovered: 3,
    });
    expect(rollbackPending).toHaveBeenCalledTimes(4);
    expect(rollbackPending).toHaveBeenNthCalledWith(2, undefined);
    expect(rollbackPending).toHaveBeenNthCalledWith(3, ['claude']);
    expect(rollbackPending).toHaveBeenNthCalledWith(4, ['muse']);
    expect(recoveryLedger(eventStore).find(intent.fingerprint)).toMatchObject({
      outcome: 'failed',
    });
    expect(recoveryLedger(eventStore).find(later.fingerprint)).toMatchObject({
      outcome: 'failed',
    });
    expect(recoveryLedger(eventStore).find(latest.fingerprint)).toMatchObject({
      outcome: 'failed',
    });
    eventStore.close();
  });

  test('leaves a marker durable and stops after its own failed later scoped pass', async () => {
    const { eventStore, intent } = fixture();
    markCompensation(eventStore, intent);
    let releaseClaude: (() => void) | undefined;
    let enteredClaude: (() => void) | undefined;
    const claudeEntered = new Promise<void>((resolve) => {
      enteredClaude = resolve;
    });
    const rollbackPending = vi.fn((providers?: string[]) => {
      if (providers?.includes('claude')) {
        enteredClaude?.();
        return new Promise<void>((resolve) => {
          releaseClaude = resolve;
        });
      }
      if (providers?.includes('muse')) {
        return Promise.reject(new Error('muse cleanup unavailable'));
      }
      return Promise.resolve();
    });
    const module = createCredentialRecoveryModuleForTest({
      eventStore,
      adapter: {
        stage: vi.fn(async () => undefined),
        commit: vi.fn(async () => ({ kind: 'adopted' as const })),
        rollback: vi.fn(async () => ({ kind: 'rolled-back' as const })),
        rollbackPending,
      },
      restartResume: vi.fn(async () => ({ turnId: 'unexpected' })),
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:03.000Z'),
    });

    const reconciliation = module.reconcile();
    const later = recoveryLedger(eventStore).arm({
      fingerprint: 'thread-later:turn:capacity:account',
      threadId: 'thread-later',
      provider: 'claude',
      sourceEventId: 'event-later',
      sourceTurnId: 'turn-later',
      failureKind: 'capacity',
      scope: 'account',
      decision: 'retry-now',
      dueAt: '2026-08-12T00:00:00.000Z',
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    markCompensation(eventStore, later);
    await claudeEntered;
    const newest = recoveryLedger(eventStore).arm({
      fingerprint: 'thread-newest:turn:capacity:account',
      threadId: 'thread-newest',
      provider: 'muse',
      sourceEventId: 'event-newest',
      sourceTurnId: 'turn-newest',
      failureKind: 'capacity',
      scope: 'account',
      decision: 'retry-now',
      dueAt: '2026-08-12T00:00:00.000Z',
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    markCompensation(eventStore, newest);
    releaseClaude?.();

    await expect(reconciliation).resolves.toEqual({
      kind: 'indeterminate',
      pending: 1,
    });
    expect(rollbackPending).toHaveBeenNthCalledWith(1, ['codex']);
    expect(rollbackPending).toHaveBeenNthCalledWith(2, undefined);
    expect(rollbackPending).toHaveBeenNthCalledWith(3, ['claude']);
    expect(rollbackPending).toHaveBeenNthCalledWith(4, ['muse']);
    await Promise.resolve();
    expect(rollbackPending).toHaveBeenCalledTimes(4);
    expect(recoveryLedger(eventStore).find(newest.fingerprint)).toMatchObject({
      outcome: 'compensation-required',
    });
    eventStore.close();
  });

  test('quarantines a reconstructed unlinked intent without broad cleanup', async () => {
    const { eventStore, intent, databasePath } = fixture();
    eventStore.createRecoveryLedger().claim({
      fingerprint: intent.fingerprint,
      kind: 'profile',
      now: '2026-08-12T00:00:01.000Z',
    });
    eventStore.close();

    const afterRestart = new EventStore(databasePath);
    const rollbackPending = vi.fn(async () => undefined);
    const module = createCredentialRecoveryModuleForTest({
      eventStore: afterRestart,
      adapter: {
        stage: vi.fn(async () => undefined),
        commit: vi.fn(async () => ({ kind: 'adopted' as const })),
        rollback: vi.fn(async () => ({ kind: 'rolled-back' as const })),
        rollbackPending,
      },
      restartResume: vi.fn(async () => ({ turnId: 'unexpected' })),
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:02.000Z'),
    });

    await expect(module.reconcile()).resolves.toEqual({
      kind: 'reconciled',
      recovered: 1,
    });
    expect(rollbackPending).not.toHaveBeenCalled();
    await expect(module.complete(intent)).resolves.toEqual({
      kind: 'conflicted',
    });
    expect(recoveryLedger(afterRestart).find(intent.fingerprint)).toMatchObject(
      {
        outcome: 'failed',
      },
    );
    afterRestart.close();
  });

  test('drains unrelated scoped compensation when legacy terminal quarantine is unavailable', async () => {
    const { eventStore, intent, databasePath } = fixture();
    eventStore.createRecoveryLedger().claim({
      fingerprint: intent.fingerprint,
      kind: 'profile',
      now: '2026-08-12T00:00:01.000Z',
    });
    eventStore.close();

    const restarted = new EventStore(databasePath);
    const unrelated = recoveryLedger(restarted).arm({
      fingerprint: 'unrelated-legacy:turn:capacity:account',
      threadId: 'unrelated-legacy',
      provider: 'claude',
      sourceEventId: 'unrelated-legacy-event',
      sourceTurnId: 'turn',
      failureKind: 'capacity',
      scope: 'account',
      decision: 'retry-now',
      dueAt: '2026-08-12T00:00:00.000Z',
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    markCompensation(restarted, unrelated);
    const realLedger = recoveryLedger(restarted);
    const terminalUnavailable = new Proxy(realLedger, {
      get(target, property, receiver) {
        if (property !== 'terminal')
          return Reflect.get(target, property, receiver);
        return (fingerprint: string, outcome: 'failed', now: string) =>
          fingerprint === intent.fingerprint
            ? { kind: 'unavailable' as const }
            : target.terminal(fingerprint, outcome, now);
      },
    });
    const rollbackPending = vi.fn(async () => undefined);
    const module = createCredentialRecoveryModuleForTest({
      eventStore: restarted,
      ledger: terminalUnavailable,
      adapter: {
        stage: vi.fn(async () => undefined),
        rollbackPending,
      },
      restartResume: vi.fn(async () => ({ turnId: 'unexpected' })),
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:02.000Z'),
    });

    await expect(module.reconcile()).resolves.toEqual({
      kind: 'indeterminate',
      pending: 1,
    });
    expect(rollbackPending).toHaveBeenCalledExactlyOnceWith(['claude']);
    expect(rollbackPending).not.toHaveBeenCalledWith(undefined);
    expect(recoveryLedger(restarted).find(unrelated.fingerprint)).toMatchObject(
      {
        outcome: 'failed',
      },
    );
    restarted.close();
  });

  test('quarantines an unlinked reconstructed completion without broad cleanup', async () => {
    const { eventStore, intent, databasePath } = fixture();
    eventStore.createRecoveryLedger().claim({
      fingerprint: intent.fingerprint,
      kind: 'profile',
      now: '2026-08-12T00:00:01.000Z',
    });
    eventStore.close();

    const afterRestart = new EventStore(databasePath);
    const rollbackPending = vi.fn(async () => undefined);
    const module = createCredentialRecoveryModuleForTest({
      eventStore: afterRestart,
      adapter: {
        stage: vi.fn(async () => undefined),
        commit: vi.fn(async () => ({ kind: 'adopted' as const })),
        rollback: vi.fn(async () => ({ kind: 'rolled-back' as const })),
        rollbackPending,
      },
      restartResume: vi.fn(async () => ({ turnId: 'unexpected' })),
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:02.000Z'),
    });

    // A restarted process cannot forge the former process's live capability.
    // Its startup-only reconciliation owns the abandoned prepared claim.
    await expect(module.complete(intent)).resolves.toEqual({
      kind: 'conflicted',
    });
    await expect(module.reconcile()).resolves.toEqual({
      kind: 'reconciled',
      recovered: 1,
    });
    expect(rollbackPending).not.toHaveBeenCalled();
    expect(recoveryLedger(afterRestart).find(intent.fingerprint)).toMatchObject(
      {
        outcome: 'failed',
      },
    );
    afterRestart.close();
  });

  test('persists compensation before failed rollback, restoration, and quarantine without rejecting', async () => {
    const { eventStore, intent } = fixture();
    const rollback = vi.fn(async () => {
      throw new Error('rollback unavailable');
    });
    const restoreSession = vi.fn(async () => {
      throw new Error('restore unavailable');
    });
    const quarantineSession = vi.fn(async () => {
      throw new Error('quarantine unavailable');
    });
    const module = createCredentialRecoveryModuleForTest({
      eventStore,
      adapter: {
        stage: vi.fn(async () => ({
          candidateProfileRef: 'opaque',
          capability: 'restart_resume' as const,
        })),
        commit: vi.fn(async () => {
          throw new Error('commit unavailable');
        }),
        rollback,
        rollbackPending: vi.fn(async () => {
          throw new Error('compensation unavailable');
        }),
      },
      restartResume: vi.fn(async () => ({ turnId: 'recovered-turn' })),
      restoreSession,
      quarantineSession,
      now: () => new Date('2026-08-12T00:00:00.000Z'),
    });

    await expect(
      module.recover({
        intent,
        replay: {
          threadId: 'thread',
          input: 'authoritative',
          recoveryCorrelationId: 'id',
          signal: new AbortController().signal,
        },
      }),
    ).resolves.toEqual({ kind: 'restarted', turnId: 'recovered-turn' });
    await expect(module.complete(intent)).resolves.toEqual({
      kind: 'indeterminate',
    });
    expect(rollback).toHaveBeenCalledOnce();
    expect(restoreSession).toHaveBeenCalledOnce();
    expect(quarantineSession).toHaveBeenCalledOnce();
    expect(recoveryLedger(eventStore).find(intent.fingerprint)).toMatchObject({
      outcome: 'compensation-required',
    });
    eventStore.close();
  });

  test('releases its prepared claim before staging when the caller is already aborted', async () => {
    const { eventStore, intent } = fixture();
    const rollback = vi.fn(async () => ({ kind: 'rolled-back' as const }));
    const controller = new AbortController();
    controller.abort();
    const module = createCredentialRecoveryModuleForTest({
      eventStore,
      adapter: {
        stage: vi.fn(async () => ({
          candidateProfileRef: 'opaque',
          capability: 'restart_resume' as const,
        })),
        commit: vi.fn(async () => ({ kind: 'adopted' as const })),
        rollback,
      },
      restartResume: vi.fn(async () => ({ turnId: 'unexpected' })),
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
    });
    await expect(
      module.recover({
        intent,
        replay: {
          threadId: 'thread',
          input: 'authoritative',
          recoveryCorrelationId: 'id',
          signal: controller.signal,
        },
      }),
    ).resolves.toEqual({ kind: 'rolled-back' });
    expect(rollback).not.toHaveBeenCalled();
    expect(recoveryLedger(eventStore).find(intent.fingerprint)).toMatchObject({
      outcome: 'armed',
    });
    eventStore.close();
  });

  test('does not stage or compensate an already-aborted profile recovery', async () => {
    const { eventStore, intent } = fixture();
    const rollback = vi.fn(async () => {
      throw new Error('rollback unavailable');
    });
    const controller = new AbortController();
    controller.abort();
    const module = createCredentialRecoveryModuleForTest({
      eventStore,
      adapter: {
        stage: vi.fn(async () => ({
          candidateProfileRef: 'opaque',
          capability: 'restart_resume' as const,
        })),
        commit: vi.fn(async () => ({ kind: 'adopted' as const })),
        rollback,
        rollbackPending: vi.fn(async () => {
          throw new Error('reconciliation unavailable');
        }),
      },
      restartResume: vi.fn(async () => ({ turnId: 'unexpected' })),
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
    });

    await expect(
      module.recover({
        intent,
        replay: {
          threadId: 'thread',
          input: 'authoritative',
          recoveryCorrelationId: 'id',
          signal: controller.signal,
        },
      }),
    ).resolves.toEqual({ kind: 'rolled-back' });
    expect(rollback).not.toHaveBeenCalled();
    expect(recoveryLedger(eventStore).find(intent.fingerprint)).toMatchObject({
      outcome: 'armed',
      attempts: 0,
    });
    eventStore.close();
  });

  test('does not enter profile staging after an already-aborted recovery', async () => {
    const { eventStore, intent } = fixture();
    const controller = new AbortController();
    controller.abort();
    const module = createCredentialRecoveryModuleForTest({
      eventStore,
      adapter: {
        stage: vi.fn(async () => {
          eventStore.createRecoveryLedger().claim({
            fingerprint: intent.fingerprint,
            kind: 'profile',
            now: '2026-08-12T00:00:01.000Z',
          });
          return {
            candidateProfileRef: 'opaque',
            capability: 'restart_resume' as const,
          };
        }),
        commit: vi.fn(async () => ({ kind: 'adopted' as const })),
        rollback: vi.fn(async () => {
          throw new Error('losing cleanup unavailable');
        }),
        rollbackPending: vi.fn(async () => undefined),
      },
      restartResume: vi.fn(async () => ({ turnId: 'unexpected' })),
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
    });

    await expect(
      module.recover({
        intent,
        replay: {
          threadId: 'thread',
          input: 'authoritative',
          recoveryCorrelationId: 'id',
          signal: controller.signal,
        },
      }),
    ).resolves.toEqual({ kind: 'rolled-back' });
    expect(recoveryLedger(eventStore).find(intent.fingerprint)).toMatchObject({
      outcome: 'armed',
      attempts: 0,
    });
    eventStore.close();
  });

  test('keeps an indeterminate stage durable instead of releasing it to ordinary replay', async () => {
    const { eventStore, intent } = fixture();
    const module = createCredentialRecoveryModule({
      ledger: eventStore.createRecoveryLedger(),
      dispatchAdapter: {
        dispatch: vi.fn(async () => ({
          kind: 'accepted' as const,
          turnId: 'nope',
        })),
      },
      adapter: {
        // This represents a connection implementation that may have persisted
        // an application before its call failed. It is not an unavailable
        // candidate and therefore must never re-arm the recovery intent.
        stage: vi.fn(async () => ({ kind: 'indeterminate' as const })),
        rollbackPending: vi.fn(async () => {
          throw new Error('scoped cleanup unavailable');
        }),
      },
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
    });

    await expect(
      module.recover({
        intent,
        replay: {
          threadId: 'thread',
          input: 'authoritative',
          recoveryCorrelationId: 'ignored',
          signal: new AbortController().signal,
        },
      }),
    ).resolves.toEqual({ kind: 'indeterminate' });
    expect(recoveryLedger(eventStore).find(intent.fingerprint)).toMatchObject({
      outcome: 'compensation-required',
    });
    eventStore.close();
  });

  test('persists a Claude-style observed turn while it remains prepared', async () => {
    const { eventStore, intent } = fixture();
    const interrupt = vi.fn(async () => undefined);
    const module = createCredentialRecoveryModule({
      ledger: eventStore.createRecoveryLedger(),
      dispatchAdapter: {
        dispatch: vi.fn(async () => ({
          kind: 'observed' as const,
          turnId: 'local-turn',
        })),
        interrupt,
      },
      adapter: {
        stage: vi.fn(async () => ({
          kind: 'staged' as const,
          attempt: credentialAttempt(),
        })),
      },
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
    });
    await expect(
      module.recover({
        intent,
        replay: {
          threadId: 'thread',
          input: 'authoritative',
          recoveryCorrelationId: 'ignored',
          signal: new AbortController().signal,
        },
      }),
    ).resolves.toEqual({ kind: 'indeterminate' });
    expect(recoveryLedger(eventStore).find(intent.fingerprint)).toMatchObject({
      outcome: 'resumed',
      dispatchSettlement: 'prepared',
      resumedTurnId: 'local-turn',
    });
    expect(interrupt).not.toHaveBeenCalled();
    eventStore.close();
  });

  test('live indeterminate cleanup never sweeps another prepared profile claim', async () => {
    const { eventStore, intent } = fixture();
    const second = recoveryLedger(eventStore).arm({
      ...intent,
      fingerprint: 'thread-b:turn-b:capacity:account',
      threadId: 'thread-b',
      sourceEventId: 'event-b',
      sourceTurnId: 'turn-b',
    });
    const settlement = eventStore.createRecoveryLedger();
    const module = createCredentialRecoveryModule({
      ledger: settlement,
      dispatchAdapter: {
        dispatch: vi.fn(async () => ({ kind: 'indeterminate' as const })),
      },
      adapter: {
        stage: vi.fn(async () => ({
          kind: 'staged' as const,
          attempt: credentialAttempt({ candidateProfileRef: 'opaque-a' }),
        })),
      },
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
    });
    // Establish the one startup pass before a different live Module claim.
    await module.reconcile();
    const other = settlement.claim({
      fingerprint: second.fingerprint,
      kind: 'profile',
      now: '2026-08-12T00:00:00.000Z',
    });
    expect(other.kind).toBe('owner');

    await expect(
      module.recover({
        intent,
        replay: {
          threadId: intent.threadId,
          input: 'resume',
          recoveryCorrelationId: 'ignored',
          signal: new AbortController().signal,
        },
      }),
    ).resolves.toEqual({ kind: 'indeterminate' });
    await Promise.resolve(); // Allow the fire-and-forget scoped retry to begin.
    expect(recoveryLedger(eventStore).find(second.fingerprint)).toMatchObject({
      outcome: 'resumed',
      dispatchSettlement: 'prepared',
      dispatchKind: 'profile',
    });
    eventStore.close();
  });

  test('a reconstructed live completion cannot take another process claim', async () => {
    const { eventStore, intent } = fixture();
    const second = recoveryLedger(eventStore).arm({
      ...intent,
      fingerprint: 'thread-complete-b:turn-b:capacity:account',
      threadId: 'thread-complete-b',
      sourceEventId: 'event-b',
      sourceTurnId: 'turn-b',
    });
    const settlement = eventStore.createRecoveryLedger();
    const first = settlement.claim({
      fingerprint: intent.fingerprint,
      kind: 'profile',
      now: '2026-08-12T00:00:00.000Z',
    });
    const other = settlement.claim({
      fingerprint: second.fingerprint,
      kind: 'profile',
      now: '2026-08-12T00:00:00.000Z',
    });
    expect(first.kind).toBe('owner');
    expect(other.kind).toBe('owner');
    if (first.kind !== 'owner') throw new Error('expected first claim');
    const module = createCredentialRecoveryModule({
      ledger: settlement,
      dispatchAdapter: {
        dispatch: vi.fn(async () => ({ kind: 'rejected' as const })),
      },
      adapter: {
        stage: vi.fn(async () => ({ kind: 'unavailable' as const })),
      },
      restoreSession: vi.fn(async () => undefined),
      now: () => new Date('2026-08-12T00:00:02.000Z'),
    });
    await expect(module.complete(intent)).resolves.toEqual({
      kind: 'conflicted',
    });
    expect(recoveryLedger(eventStore).find(second.fingerprint)).toMatchObject({
      outcome: 'resumed',
      dispatchSettlement: 'prepared',
      dispatchKind: 'profile',
    });
    eventStore.close();
  });
});
