import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { EventStore } from '../event-store.js';
import { createRecoveryDispatchAdapter } from '../recovery-dispatch-adapter.js';

describe('RecoveryLedger', () => {
  const directories: string[] = [];
  afterEach(() =>
    directories
      .splice(0)
      .forEach((directory) =>
        rmSync(directory, { recursive: true, force: true }),
      ),
  );

  function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'recovery-dispatch-'));
    directories.push(directory);
    const databasePath = join(directory, 'orchestration.sqlite');
    const eventStore = new EventStore(databasePath);
    const ledger = eventStore.createRecoveryLedger();
    const intent = ledger.arm({
      fingerprint: 'thread:turn:capacity:account',
      threadId: 'thread',
      provider: 'codex',
      sourceEventId: 'event',
      sourceTurnId: 'turn',
      failureKind: 'capacity',
      scope: 'account',
      decision: 'retry-now',
      dueAt: '2026-08-13T00:00:00.000Z',
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    });
    return { databasePath, eventStore, ledger, intent };
  }

  test('keeps the former EventStore recovery method bag out of its Interface', () => {
    const names = Object.getOwnPropertyNames(EventStore.prototype);
    expect(names).not.toEqual(
      expect.arrayContaining([
        'insertRecoveryIntent',
        'readRecoveryIntent',
        'readLatestRecoveryProjection',
        'listPendingRecoveryIntents',
        'listCompensationRequiredRecoveryIntents',
        'recordRecoveryOutcome',
        'recordRecoveryFailure',
        'markRecoveryCompensationRequired',
        'resolveRecoveryCompensation',
        'cancelRecoveryIntent',
        'cancelPendingRecoveryIntents',
        'cancelPendingRecoveryIntentsForTurn',
        'createRecoveryDispatchSettlement',
      ]),
    );
  });

  test('returns frozen redacted snapshots instead of settlement credentials', () => {
    const { eventStore, ledger, intent } = fixture();
    const snapshot = ledger.find(intent.fingerprint);
    expect(snapshot).toBeTruthy();
    expect(snapshot).not.toHaveProperty('dispatchAttemptId');
    expect(snapshot).not.toHaveProperty('recoveryCorrelationId');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as { outcome: string }).outcome = 'succeeded';
    }).toThrow();
    expect(ledger.find(intent.fingerprint)).toMatchObject({ outcome: 'armed' });
    eventStore.close();
  });

  test('atomically grants one attempt across independent SQLite connections', () => {
    const { databasePath, eventStore, ledger, intent } = fixture();
    const second = new EventStore(databasePath);
    const firstClaim = ledger.claim({
      fingerprint: intent.fingerprint,
      kind: 'due',
      now: '2026-08-13T00:00:00.000Z',
    });
    const secondClaim = second.createRecoveryLedger().claim({
      fingerprint: intent.fingerprint,
      kind: 'due',
      now: '2026-08-13T00:00:00.000Z',
    });

    expect(firstClaim).toMatchObject({ kind: 'owner' });
    expect(secondClaim).toEqual({ kind: 'unavailable' });
    const persisted = ledger.find(intent.fingerprint);
    expect(persisted).toMatchObject({
      outcome: 'resumed',
      attempts: 1,
      dispatchSettlement: 'prepared',
      dispatchKind: 'due',
    });
    expect(persisted).not.toHaveProperty('dispatchAttemptId');
    expect(persisted).not.toHaveProperty('recoveryCorrelationId');
    expect(Object.isFrozen(persisted)).toBe(true);
    eventStore.close();
    second.close();
  });

  test('a real child owner fences reconciliation until it exits, then is reclaimed once', async () => {
    const { databasePath, eventStore, intent } = fixture();
    eventStore.close();
    const eventStorePath = new URL('../event-store.ts', import.meta.url)
      .pathname;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { EventStore } from ${JSON.stringify(eventStorePath)};
         const store = new EventStore(process.argv[1]);
         const claim = store.createRecoveryLedger().claim({ fingerprint: process.argv[2], kind: 'due', now: '2026-08-13T00:00:00.000Z' });
         if (claim.kind !== 'owner') process.exit(2);
         process.stdout.write('ready\\n');
         setInterval(() => {}, 1_000);`,
        databasePath,
        intent.fingerprint,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    await once(child.stdout!, 'data');
    const live = new EventStore(databasePath);
    expect(
      live.createRecoveryLedger().reconcilePrepared('2026-08-13T00:00:01.000Z'),
    ).toEqual([]);
    live.close();

    // A different process cannot prove the child identity is dead when its
    // exact-process probe is unavailable, so it must leave the durable claim
    // alone rather than guessing from the PID.
    const unavailable = new EventStore(databasePath, undefined, {
      exact: () => ({ pid: process.pid, start: 'unavailable-observer' }),
      probe: () => ({ state: 'unavailable' as const }),
    });
    expect(
      unavailable
        .createRecoveryLedger()
        .reconcilePrepared('2026-08-13T00:00:01.500Z'),
    ).toEqual([]);
    unavailable.close();

    child.kill('SIGKILL');
    await once(child, 'exit');
    const afterExit = new EventStore(databasePath);
    const ledger = afterExit.createRecoveryLedger();
    expect(ledger.reconcilePrepared('2026-08-13T00:00:02.000Z')).toHaveLength(
      1,
    );
    expect(ledger.reconcilePrepared('2026-08-13T00:00:03.000Z')).toEqual([]);
    afterExit.close();
  });

  test('accepts only the exact prepared capability and latches one-way', () => {
    const { eventStore, ledger, intent } = fixture();
    const claim = ledger.claim({
      fingerprint: intent.fingerprint,
      kind: 'profile',
      now: '2026-08-13T00:00:00.000Z',
    });
    expect(claim.kind).toBe('owner');
    if (claim.kind !== 'owner') throw new Error('expected owner');

    expect(
      claim.attempt.acceptFromProvider({
        turnId: 'provider-turn',
        now: '2026-08-13T00:00:01.000Z',
      }),
    ).toEqual({ kind: 'applied' });
    expect(
      claim.attempt.acceptFromProvider({
        turnId: 'provider-turn',
        now: '2026-08-13T00:00:01.000Z',
      }),
    ).toEqual({ kind: 'applied' });
    expect(claim.attempt.indeterminate('2026-08-13T00:00:02.000Z')).toEqual({
      kind: 'invalid',
    });
    expect(ledger.find(intent.fingerprint)).toMatchObject({
      outcome: 'resumed',
      resumedTurnId: 'provider-turn',
      dispatchSettlement: 'accepted',
      dispatchKind: 'profile',
    });
    eventStore.close();
  });

  test('cannot terminally succeed an indeterminate dispatch', () => {
    const { eventStore, ledger, intent } = fixture();
    const claim = ledger.claim({
      fingerprint: intent.fingerprint,
      kind: 'due',
      now: '2026-08-13T00:00:00.000Z',
    });
    expect(claim.kind).toBe('owner');
    if (claim.kind !== 'owner') throw new Error('expected owner');
    expect(claim.attempt.indeterminate('2026-08-13T00:00:01.000Z')).toEqual({
      kind: 'applied',
    });
    expect(
      ledger.terminal(
        intent.fingerprint,
        'succeeded',
        '2026-08-13T00:00:02.000Z',
      ),
    ).toEqual({ kind: 'stale' });
    expect(ledger.find(intent.fingerprint)).toMatchObject({
      outcome: 'indeterminate',
    });
    eventStore.close();
  });

  test('releases only before invocation, then a restart makes an abandoned claim durable', () => {
    const { databasePath, eventStore, ledger, intent } = fixture();
    const claim = ledger.claim({
      fingerprint: intent.fingerprint,
      kind: 'due',
      now: '2026-08-13T00:00:00.000Z',
    });
    expect(claim.kind).toBe('owner');
    if (claim.kind !== 'owner') throw new Error('expected owner');
    expect(
      claim.attempt.releaseBeforeInvocation({
        outcome: 'armed',
        now: '2026-08-13T00:00:01.000Z',
      }),
    ).toEqual({ kind: 'applied' });
    expect(ledger.find(intent.fingerprint)).toMatchObject({
      outcome: 'armed',
      attempts: 0,
    });

    const retry = ledger.claim({
      fingerprint: intent.fingerprint,
      kind: 'due',
      now: '2026-08-13T00:00:01.000Z',
    });
    expect(retry.kind).toBe('owner');
    // A live owner cannot be taken over by another connection.
    const liveObserver = new EventStore(databasePath);
    expect(
      liveObserver
        .createRecoveryLedger()
        .reconcilePrepared('2026-08-13T00:00:02.000Z'),
    ).toEqual([]);
    liveObserver.close();
    eventStore.close();

    const afterRestart = new EventStore(databasePath);
    const restartLedger = afterRestart.createRecoveryLedger();
    const reconciled = restartLedger.reconcilePrepared(
      '2026-08-13T00:00:02.000Z',
    );
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({ outcome: 'indeterminate' });
    expect(restartLedger.find(intent.fingerprint)).toMatchObject({
      outcome: 'indeterminate',
    });
    expect(restartLedger.reconcilePrepared('2026-08-13T00:00:03.000Z')).toEqual(
      [],
    );
    afterRestart.close();
  });

  test('keeps profile reconciliation with the credential Module owner', () => {
    const { eventStore, ledger, intent } = fixture();
    const profile = ledger.claim({
      fingerprint: intent.fingerprint,
      kind: 'profile',
      now: '2026-08-13T00:00:00.000Z',
    });
    expect(profile.kind).toBe('owner');
    expect(ledger.reconcilePrepared('2026-08-13T00:00:01.000Z', 'due')).toEqual(
      [],
    );
    expect(ledger.find(intent.fingerprint)).toMatchObject({
      outcome: 'resumed',
      dispatchKind: 'profile',
      dispatchSettlement: 'prepared',
    });
    eventStore.close();
  });

  test('startup reconciliation settles only abandoned profile attempts exactly once', () => {
    const { databasePath, eventStore, ledger, intent } = fixture();
    const secondIntent = ledger.arm({
      ...intent,
      fingerprint: 'thread-b:turn-b:capacity:account',
      threadId: 'thread-b',
      sourceEventId: 'event-b',
      sourceTurnId: 'turn-b',
    });
    const first = ledger.claim({
      fingerprint: intent.fingerprint,
      kind: 'profile',
      now: '2026-08-13T00:00:00.000Z',
    });
    const second = ledger.claim({
      fingerprint: secondIntent.fingerprint,
      kind: 'profile',
      now: '2026-08-13T00:00:00.000Z',
    });
    expect(first.kind).toBe('owner');
    expect(second.kind).toBe('owner');
    if (first.kind !== 'owner' || second.kind !== 'owner')
      throw new Error('expected independent owners');

    const liveObserver = new EventStore(databasePath);
    expect(
      liveObserver
        .createRecoveryLedger()
        .reconcilePrepared('2026-08-13T00:00:01.000Z', 'profile'),
    ).toEqual([]);
    liveObserver.close();
    eventStore.close();
    const afterRestart = new EventStore(databasePath);
    const restarted = afterRestart.createRecoveryLedger();
    expect(
      restarted.reconcilePrepared('2026-08-13T00:00:01.000Z', 'profile'),
    ).toHaveLength(2);
    expect(
      restarted.reconcilePrepared('2026-08-13T00:00:02.000Z', 'profile'),
    ).toEqual([]);
    expect(restarted.find(intent.fingerprint)).toMatchObject({
      outcome: 'indeterminate',
    });
    expect(restarted.find(secondIntent.fingerprint)).toMatchObject({
      outcome: 'indeterminate',
    });
    afterRestart.close();
  });

  test('reclaims a closed owner on PID birth mismatch but fails closed when identity is unavailable', () => {
    const { databasePath, eventStore, ledger, intent } = fixture();
    const claim = ledger.claim({
      fingerprint: intent.fingerprint,
      kind: 'due',
      now: '2026-08-13T00:00:00.000Z',
    });
    expect(claim.kind).toBe('owner');
    eventStore.close();

    const mismatch = {
      exact: () => ({ pid: process.pid, start: 'replacement-birth' }),
      probe: () => ({
        state: 'exact' as const,
        identity: { pid: process.pid, start: 'replacement-birth' },
      }),
    };
    const afterReuse = new EventStore(databasePath, undefined, mismatch);
    expect(
      afterReuse
        .createRecoveryLedger()
        .reconcilePrepared('2026-08-13T00:00:01.000Z'),
    ).toHaveLength(1);
    afterReuse.close();

    const second = new EventStore(databasePath, undefined, {
      exact: () => ({ pid: process.pid, start: 'unavailable-owner' }),
      probe: () => ({ state: 'unavailable' as const }),
    });
    const secondLedger = second.createRecoveryLedger();
    const secondIntent = secondLedger.arm({
      ...intent,
      fingerprint: 'unavailable-owner',
    });
    expect(
      secondLedger.claim({
        fingerprint: secondIntent.fingerprint,
        kind: 'due',
        now: '2026-08-13T00:00:02.000Z',
      }).kind,
    ).toBe('owner');
    second.close();
    const blocked = new EventStore(databasePath, undefined, {
      exact: () => ({ pid: process.pid, start: 'new-owner' }),
      probe: () => ({ state: 'unavailable' as const }),
    });
    expect(
      blocked
        .createRecoveryLedger()
        .reconcilePrepared('2026-08-13T00:00:03.000Z'),
    ).toHaveLength(1);
    blocked.close();
  });

  test('classifies only declared provider responses as accepted', async () => {
    const adapter = createRecoveryDispatchAdapter({
      send: async () => ({ turnId: 'turn' }),
      restartProfile: async () => ({ turnId: 'profile-turn' }),
      providerAcceptsResponse: (provider) => provider === 'codex',
    });
    const replay = {
      threadId: 'thread',
      input: 'resume',
      recoveryCorrelationId: 'correlation',
      signal: new AbortController().signal,
    };
    await expect(
      adapter.dispatch({ intent: { provider: 'codex' } as never, replay }),
    ).resolves.toEqual({ kind: 'accepted', turnId: 'turn' });
    await expect(
      adapter.dispatch({ intent: { provider: 'claude' } as never, replay }),
    ).resolves.toEqual({ kind: 'observed', turnId: 'turn' });
  });

  test('reports a lost terminal compare-and-set without claiming recovery', () => {
    const { eventStore, ledger, intent } = fixture();
    expect(
      ledger.terminal(
        intent.fingerprint,
        'succeeded',
        '2026-08-13T00:00:01.000Z',
      ),
    ).toEqual({ kind: 'stale' });
    expect(ledger.find(intent.fingerprint)).toMatchObject({ outcome: 'armed' });
    eventStore.close();
  });

  test('reads back an identical durable terminal after a post-write fault', () => {
    const { databasePath, eventStore, intent } = fixture();
    eventStore.close();
    let faulted = false;
    const faulting = new EventStore(databasePath, undefined, undefined, () => {
      if (!faulted) {
        faulted = true;
        throw new Error('injected after UPDATE');
      }
    });
    const ledger = faulting.createRecoveryLedger();
    const claim = ledger.claim({
      fingerprint: intent.fingerprint,
      kind: 'due',
      now: '2026-08-13T00:00:00.000Z',
    });
    expect(claim.kind).toBe('owner');
    if (claim.kind !== 'owner') throw new Error('expected owner');
    expect(
      claim.attempt.acceptFromProvider({
        turnId: 'provider-turn',
        now: '2026-08-13T00:00:01.000Z',
      }),
    ).toEqual({ kind: 'applied' });
    expect(
      ledger.terminal(
        intent.fingerprint,
        'succeeded',
        '2026-08-13T00:00:02.000Z',
      ),
    ).toEqual({ kind: 'applied' });
    expect(ledger.find(intent.fingerprint)).toMatchObject({
      outcome: 'succeeded',
    });
    faulting.close();
  });

  test('latches exact capability retries without accepting a changed transition', () => {
    const { eventStore, ledger, intent } = fixture();
    const claim = ledger.claim({
      fingerprint: intent.fingerprint,
      kind: 'due',
      now: '2026-08-13T00:00:00.000Z',
    });
    expect(claim.kind).toBe('owner');
    if (claim.kind !== 'owner') throw new Error('expected owner');
    const first = claim.attempt.indeterminate('2026-08-13T00:00:01.000Z');
    expect(first).toEqual({ kind: 'applied' });
    expect(claim.attempt.indeterminate('2026-08-13T00:00:01.000Z')).toEqual(
      first,
    );
    expect(
      claim.attempt.releaseBeforeInvocation({
        outcome: 'armed',
        now: '2026-08-13T00:00:01.000Z',
      }),
    ).toEqual({ kind: 'invalid' });
    eventStore.close();
  });
});
