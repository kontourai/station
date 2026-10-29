import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { probeExactProcessIdentity } from '@kontourai/station-shared/process-identity';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SessionStartRefusedError } from '../../../providers/adapter-shape.js';
import { EventStore } from '../event-store.js';
import { captureTurnIntent } from '../prepared-turn-intent.js';
import {
  createInMemorySessionTurnBoundaryAuthority,
  createSessionTurnBoundaryAuthority,
  runSessionStartWithBoundary,
  SESSION_START_INDETERMINATE_CODE,
  SESSION_TURN_ACCEPTED_CAPACITY,
  SessionStartIndeterminateError,
  type SessionTurnBoundaryCoordinator,
  type SessionTurnBoundaryRecord,
} from '../session-turn-boundary.js';

function terminal(threadId: string, turnId: string): CanonicalRuntimeEvent {
  return {
    eventId: `terminal:${threadId}:${turnId}`,
    provider: 'claude',
    threadId,
    turnId,
    createdAt: '2026-08-16T00:00:02.000Z',
    method: 'turn.completed',
    outputText: 'done',
  };
}

describe('SessionTurnBoundaryAuthority', () => {
  test('an unbound settled row survives host terminal cleanup but deliberate thread deletion removes it', () => {
    const store = new EventStore(':memory:');
    try {
      const authority = store.sessionTurnBoundaryAuthority();
      expect(
        authority.claim('settled-audit', '2030-01-01T00:00:00.000Z').kind,
      ).toBe('owner');
      // The legacy binding cannot decode or author settlement. Its kernel
      // must refuse this tag, while host terminal SQL must preserve it.
      store['db'].exec('PRAGMA ignore_check_constraints = ON');
      store['db']
        .prepare(
          "UPDATE orchestration_turn_boundaries SET state = 'settled' WHERE thread_id = ?",
        )
        .run('settled-audit');
      store['db'].exec('PRAGMA ignore_check_constraints = OFF');
      const rows = () =>
        store['db']
          .prepare(
            'SELECT * FROM orchestration_turn_boundaries WHERE thread_id = ?',
          )
          .all('settled-audit');
      const before = rows();
      expect(before).toHaveLength(1);
      const exited: CanonicalRuntimeEvent = {
        eventId: 'settled-audit-exited',
        provider: 'claude',
        threadId: 'settled-audit',
        sessionId: 'settled-audit',
        method: 'session.exited',
        exitCode: 0,
        createdAt: '2030-01-01T00:00:01.000Z',
      };
      store.appendEvent(exited);
      expect(authority.observe(exited)).toEqual({ kind: 'unavailable' });
      expect(authority.hasPossibleEffect('settled-audit')).toEqual({
        kind: 'unavailable',
      });
      expect(rows()).toEqual(before);
      // A write admission also joins EventStore's persisted-terminal cleanup.
      const lifecycle = authority.claimLifecycle(
        'settled-audit',
        '2030-01-01T00:00:02.000Z',
      );
      expect(rows()).toEqual(before);
      expect(lifecycle.kind).toBe('unavailable');
      store.deleteThread('settled-audit');
      expect(rows()).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('an indeterminate start keeps the engine message a sentence of its own', () => {
    // Codex's text carries no terminal punctuation; the explanation used to
    // run straight on ("…an active writer Provider session creation…").
    expect(
      new SessionStartIndeterminateError(
        new Error('thread t-1 already has an active writer'),
      ).message,
    ).toBe(
      'thread t-1 already has an active writer. Provider session creation may have completed. Inspect the session before retrying.',
    );
    expect(
      new SessionStartIndeterminateError(new Error('Spawn failed.')).message,
    ).toMatch(/^Spawn failed\. Provider/);
  });

  describe('a definitive start refusal', () => {
    const refusal = () =>
      new SessionStartRefusedError('engine refused', 'model_not_advertised');

    test('releases the boundary: the thread is not fenced and the next start may claim it', async () => {
      const authority = createInMemorySessionTurnBoundaryAuthority();

      await expect(
        runSessionStartWithBoundary(authority, 'refused-thread', async () => {
          throw refusal();
        }),
      ).rejects.toBeInstanceOf(SessionStartRefusedError);

      expect(authority.hasPossibleEffect('refused-thread')).toEqual({
        kind: 'available',
        active: false,
      });
      await expect(
        runSessionStartWithBoundary(
          authority,
          'refused-thread',
          async () => 'started',
        ),
      ).resolves.toBe('started');
    });

    test('any other adapter failure stays an indeterminate start and fences the thread', async () => {
      const authority = createInMemorySessionTurnBoundaryAuthority();

      await expect(
        runSessionStartWithBoundary(authority, 'crashed-thread', async () => {
          throw new Error('engine crashed');
        }),
      ).rejects.toMatchObject({ code: SESSION_START_INDETERMINATE_CODE });

      expect(authority.hasPossibleEffect('crashed-thread')).toEqual({
        kind: 'available',
        active: true,
      });
    });

    test('a release the store cannot confirm falls back to the indeterminate start', async () => {
      let record: SessionTurnBoundaryRecord | undefined;
      const coordinator: SessionTurnBoundaryCoordinator = {
        create(input) {
          if (record) return { kind: 'busy' };
          record = { ...input };
          return { kind: 'applied' };
        },
        transition(input) {
          if (!record || record.boundaryId !== input.boundaryId)
            return { kind: 'stale' };
          if (!input.from.includes(record.state)) return { kind: 'stale' };
          record = { ...record, state: input.to, updatedAt: input.now };
          return { kind: 'applied' };
        },
        // The release itself cannot be confirmed.
        remove: () => ({ kind: 'unavailable' }),
        removeTerminal: () => ({ kind: 'applied' }),
        hasPossibleEffect: () => Boolean(record),
        active: () => (record ? [{ ...record }] : []),
        recordAccepted: () => ({ kind: 'unavailable' }),
      };
      const authority = createSessionTurnBoundaryAuthority({
        coordinator,
        owner: { id: 'owner', pid: process.pid, identityKind: 'unverified' },
        processIdentity: {
          exact: () => null,
          probe: () => ({ state: 'unavailable' }),
        },
      });

      await expect(
        runSessionStartWithBoundary(
          authority,
          'unconfirmed-release',
          async () => {
            throw refusal();
          },
        ),
      ).rejects.toMatchObject({ code: SESSION_START_INDETERMINATE_CODE });

      expect(record?.state).toBe('indeterminate');
      expect(authority.hasPossibleEffect('unconfirmed-release')).toEqual({
        kind: 'available',
        active: true,
      });
    });

    test('a task dispatch child claim cannot release, so it keeps the indeterminate start', async () => {
      const authority = createInMemorySessionTurnBoundaryAuthority();
      const owned = authority.claimTaskDispatch(
        'dispatch-refused',
        new Date().toISOString(),
      );
      if (owned.kind !== 'owner')
        throw new Error('Expected dispatch ownership');

      await expect(
        runSessionStartWithBoundary(
          authority,
          'dispatch-refused',
          async () => {
            throw refusal();
          },
          owned.claim.sessionStart,
        ),
      ).rejects.toMatchObject({ code: SESSION_START_INDETERMINATE_CODE });
      expect(authority.hasPossibleEffect('dispatch-refused')).toEqual({
        kind: 'available',
        active: true,
      });
    });
  });

  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function databasePath() {
    const root = mkdtempSync(join(tmpdir(), 'session-turn-boundary-'));
    roots.push(root);
    return join(root, 'orchestration.sqlite');
  }

  test('upgrades a legacy invocation table without losing its unresolved record', () => {
    const path = databasePath();
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE orchestration_turn_boundaries (
      boundary_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, state TEXT NOT NULL,
      provider_turn_id TEXT, owner_id TEXT NOT NULL, owner_pid INTEGER NOT NULL,
      owner_birth TEXT, owner_identity_kind TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ); INSERT INTO orchestration_turn_boundaries VALUES (
      'legacy-boundary','legacy-session','indeterminate',NULL,'legacy-owner',2147483647,
      NULL,'unverified','2026-09-05T00:00:00.000Z','2026-09-05T00:00:00.000Z'
    );`);
    legacy.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new EventStore(path);
      try {
        expect(
          store
            .sessionTurnBoundaryAuthority()
            .hasPossibleEffect('legacy-session'),
        ).toEqual({ kind: 'available', active: true });
        const inspection = new DatabaseSync(path, { readOnly: true });
        try {
          expect(
            inspection
              .prepare(
                'SELECT purpose FROM orchestration_turn_boundaries WHERE boundary_id=?',
              )
              .get('legacy-boundary'),
          ).toEqual({ purpose: 'turn' });
        } finally {
          inspection.close();
        }
      } finally {
        expect(store.close()).toEqual({ kind: 'closed' });
      }
    }
  });

  test.each(['sqlite', 'memory'] as const)(
    'dispatch completion remains owned after provider start and terminal evidence (%s)',
    async (backend) => {
      const store =
        backend === 'sqlite' ? new EventStore(databasePath()) : undefined;
      const authority =
        store?.sessionTurnBoundaryAuthority() ??
        createInMemorySessionTurnBoundaryAuthority();
      try {
        const owned = authority.claimTaskDispatch(
          'dispatch-session',
          '2026-09-05T00:00:00.000Z',
        );
        if (owned.kind !== 'owner')
          throw new Error('Expected dispatch ownership');
        expect(owned.claim.beginEffects('2026-09-05T00:00:01.000Z')).toEqual({
          kind: 'applied',
        });
        let calls = 0;
        expect(
          await runSessionStartWithBoundary(
            authority,
            'dispatch-session',
            async () => {
              calls++;
              return 'started';
            },
            owned.claim.sessionStart,
          ),
        ).toBe('started');
        const exited: CanonicalRuntimeEvent = {
          eventId: 'dispatch-session-exited',
          provider: 'claude',
          threadId: 'dispatch-session',
          sessionId: 'dispatch-session',
          method: 'session.exited',
          createdAt: '2026-09-05T00:00:02.000Z',
          exitCode: 0,
        };
        store?.appendEvent(exited);
        expect(authority.observe(exited)).toEqual({ kind: 'applied' });
        expect(authority.hasPossibleEffect('dispatch-session')).toEqual({
          kind: 'available',
          active: true,
        });
        await expect(
          runSessionStartWithBoundary(
            authority,
            'dispatch-session',
            async () => {
              calls++;
            },
            owned.claim.sessionStart,
          ),
        ).rejects.toThrow('no provider call was made');
        expect(calls).toBe(1);
        expect(owned.claim.settled()).toEqual({ kind: 'applied' });
        expect(authority.hasPossibleEffect('dispatch-session')).toEqual({
          kind: 'available',
          active: false,
        });
      } finally {
        if (store) expect(store.close()).toEqual({ kind: 'closed' });
      }
    },
  );

  test('borrowed startup admission refuses another session and cannot accept a late result after dispatch uncertainty', async () => {
    const store = new EventStore(databasePath());
    try {
      const authority = store.sessionTurnBoundaryAuthority();
      const owned = authority.claimTaskDispatch(
        'exact-dispatch',
        new Date().toISOString(),
      );
      if (owned.kind !== 'owner')
        throw new Error('Expected dispatch ownership');
      let calls = 0;
      await expect(
        runSessionStartWithBoundary(
          authority,
          'wrong-session',
          async () => {
            calls++;
          },
          owned.claim.sessionStart,
        ),
      ).rejects.toThrow('does not match');
      expect(calls).toBe(0);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const starting = runSessionStartWithBoundary(
        authority,
        'exact-dispatch',
        async () => {
          calls++;
          await held;
          return 'late';
        },
        owned.claim.sessionStart,
      );
      expect(calls).toBe(1);
      expect(owned.claim.indeterminate(new Date().toISOString())).toEqual({
        kind: 'applied',
      });
      release();
      await expect(starting).rejects.toThrow('may have completed');
      expect(owned.claim.settled()).toEqual({ kind: 'stale' });
      expect(authority.hasPossibleEffect('exact-dispatch')).toEqual({
        kind: 'available',
        active: true,
      });
    } finally {
      expect(store.close()).toEqual({ kind: 'closed' });
    }
  });

  test('dispatch recovery cannot release a live owner or a replacement that wins during proof', async () => {
    const path = databasePath();
    const first = new EventStore(path);
    const claimed = first
      .sessionTurnBoundaryAuthority()
      .claimTaskDispatch('recover-race', new Date().toISOString());
    if (claimed.kind !== 'owner')
      throw new Error('Expected dispatch admission');
    claimed.claim.beginEffects(new Date().toISOString());
    let verified = false;
    expect(
      await first
        .sessionTurnBoundaryAuthority()
        .recoverCompletedDispatch('recover-race', async () => {
          verified = true;
          return true;
        }),
    ).toEqual({ kind: 'busy' });
    expect(verified).toBe(false);
    first.close();
    const recovering = new EventStore(path);
    try {
      const authority = recovering.sessionTurnBoundaryAuthority();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slow = authority.recoverCompletedDispatch(
        'recover-race',
        async () => {
          await held;
          return true;
        },
      );
      expect(
        await authority.recoverCompletedDispatch(
          'recover-race',
          async () => true,
        ),
      ).toEqual({ kind: 'applied' });
      const replacement = authority.claimTaskDispatch(
        'recover-race',
        new Date().toISOString(),
      );
      if (replacement.kind !== 'owner')
        throw new Error('Expected replacement admission');
      replacement.claim.beginEffects(new Date().toISOString());
      release();
      expect(await slow).toEqual({ kind: 'stale' });
      expect(authority.hasPossibleEffect('recover-race')).toEqual({
        kind: 'available',
        active: true,
      });
      replacement.claim.settled();
    } finally {
      recovering.close();
    }
  });

  test('a crashed dispatch guard is not cleared by replaying provider terminal evidence', () => {
    const path = databasePath();
    const first = new EventStore(path);
    const owned = first
      .sessionTurnBoundaryAuthority()
      .claimTaskDispatch('crashed-dispatch', '2026-09-05T00:00:00.000Z');
    if (owned.kind !== 'owner') throw new Error('Expected dispatch ownership');
    owned.claim.beginEffects('2026-09-05T00:00:01.000Z');
    first.appendEvent({
      eventId: 'crashed-dispatch-terminal',
      provider: 'claude',
      threadId: 'crashed-dispatch',
      sessionId: 'crashed-dispatch',
      method: 'session.exited',
      createdAt: '2026-09-05T00:00:02.000Z',
      exitCode: 0,
    });
    expect(first.close()).toEqual({ kind: 'closed' });
    const second = new EventStore(path);
    try {
      expect(
        second
          .sessionTurnBoundaryAuthority()
          .hasPossibleEffect('crashed-dispatch'),
      ).toEqual({ kind: 'available', active: true });
      expect(
        second
          .sessionTurnBoundaryAuthority()
          .claimTaskDispatch('crashed-dispatch', '2026-09-05T00:01:00.000Z'),
      ).toEqual({ kind: 'busy' });
    } finally {
      expect(second.close()).toEqual({ kind: 'closed' });
    }
  });

  test('session creation settles without inventing a provider turn and cannot reopen after settlement', () => {
    const store = new EventStore(databasePath());
    try {
      const authority = store.sessionTurnBoundaryAuthority();
      const prepared = authority.claimSessionStart(
        'new-session',
        '2026-09-05T00:00:00.000Z',
      );
      if (prepared.kind !== 'owner')
        throw new Error('Expected start admission');
      expect(prepared.claim.started()).toEqual({ kind: 'stale' });
      expect(
        authority.claim('new-session', '2026-09-05T00:00:00.000Z'),
      ).toEqual({ kind: 'busy' });
      expect(
        prepared.claim.beginInvocation('2026-09-05T00:00:01.000Z'),
      ).toEqual({ kind: 'applied' });
      expect(prepared.claim.notInvoked()).toEqual({ kind: 'stale' });
      expect(authority.hasPossibleEffect('new-session')).toEqual({
        kind: 'available',
        active: true,
      });
      expect(prepared.claim.started()).toEqual({ kind: 'applied' });
      expect(prepared.claim.started()).toEqual({ kind: 'applied' });
      expect(
        prepared.claim.beginInvocation('2026-09-05T00:00:02.000Z'),
      ).toEqual({ kind: 'stale' });
      expect(prepared.claim.indeterminate('2026-09-05T00:00:02.000Z')).toEqual({
        kind: 'stale',
      });
      expect(authority.hasPossibleEffect('new-session')).toEqual({
        kind: 'available',
        active: false,
      });
      const unused = authority.claimSessionStart(
        'never-invoked',
        '2026-09-05T00:00:00.000Z',
      );
      if (unused.kind !== 'owner') throw new Error('Expected unused admission');
      expect(unused.claim.notInvoked()).toEqual({ kind: 'applied' });
      expect(unused.claim.beginInvocation('2026-09-05T00:00:01.000Z')).toEqual({
        kind: 'stale',
      });
    } finally {
      expect(store.close()).toEqual({ kind: 'closed' });
    }
  });

  test('uncertain session creation remains protected across restart until exact session terminal evidence', () => {
    const path = databasePath();
    const first = new EventStore(path);
    const claimed = first
      .sessionTurnBoundaryAuthority()
      .claimSessionStart('uncertain-start', '2026-09-05T00:00:00.000Z');
    if (claimed.kind !== 'owner') throw new Error('Expected start admission');
    expect(claimed.claim.beginInvocation('2026-09-05T00:00:01.000Z')).toEqual({
      kind: 'applied',
    });
    const diagnostic: CanonicalRuntimeEvent = {
      eventId: 'uncertain-start-diagnostic',
      provider: 'claude',
      threadId: 'uncertain-start',
      method: 'runtime.error',
      createdAt: '2026-09-05T00:00:02.000Z',
      severity: 'error',
      code: SESSION_START_INDETERMINATE_CODE,
      retriable: false,
      message: 'Start outcome is unresolved',
    };
    first.appendEvent(diagnostic);
    expect(first.sessionTurnBoundaryAuthority().observe(diagnostic)).toEqual({
      kind: 'applied',
    });
    expect(
      first.sessionTurnBoundaryAuthority().hasPossibleEffect('uncertain-start'),
    ).toEqual({ kind: 'available', active: true });
    expect(first.close()).toEqual({ kind: 'closed' });
    const restarted = new EventStore(path);
    try {
      const authority = restarted.sessionTurnBoundaryAuthority();
      expect(authority.hasPossibleEffect('uncertain-start')).toEqual({
        kind: 'available',
        active: true,
      });
      expect(
        authority.claimSessionStart(
          'uncertain-start',
          '2026-09-05T00:05:00.000Z',
        ),
      ).toEqual({ kind: 'busy' });
      const exited: CanonicalRuntimeEvent = {
        eventId: 'terminal:uncertain-start',
        provider: 'claude',
        threadId: 'uncertain-start',
        sessionId: 'uncertain-start',
        method: 'session.exited',
        createdAt: '2026-09-05T00:05:01.000Z',
        exitCode: 0,
      };
      restarted.appendEvent(exited);
      expect(authority.observe(exited)).toEqual({ kind: 'applied' });
      expect(authority.hasPossibleEffect('uncertain-start')).toEqual({
        kind: 'available',
        active: false,
      });
    } finally {
      expect(restarted.close()).toEqual({ kind: 'closed' });
    }
  });

  test('a rejected provider start retains possible effect and refuses replay after restart', async () => {
    const path = databasePath();
    const first = new EventStore(path);
    try {
      await expect(
        runSessionStartWithBoundary(
          first.sessionTurnBoundaryAuthority(),
          'possibly-started',
          async () => {
            throw new Error('connection lost after provider accepted');
          },
        ),
      ).rejects.toMatchObject({ code: SESSION_START_INDETERMINATE_CODE });
      expect(
        first
          .sessionTurnBoundaryAuthority()
          .hasPossibleEffect('possibly-started'),
      ).toEqual({ kind: 'available', active: true });
    } finally {
      expect(first.close()).toEqual({ kind: 'closed' });
    }
    const restarted = new EventStore(path);
    try {
      expect(
        restarted
          .sessionTurnBoundaryAuthority()
          .hasPossibleEffect('possibly-started'),
      ).toEqual({ kind: 'available', active: true });
      expect(
        restarted
          .sessionTurnBoundaryAuthority()
          .claimSessionStart('possibly-started', '2026-09-05T00:05:00.000Z'),
      ).toEqual({ kind: 'busy' });
    } finally {
      expect(restarted.close()).toEqual({ kind: 'closed' });
    }
  });

  test('reconciles a dead invoking owner to indeterminate and never replays it after restart', () => {
    const path = databasePath();
    const first = new EventStore(path);
    const claimed = first
      .sessionTurnBoundaryAuthority()
      .claim('thread-restart', '2026-08-16T00:00:00.000Z');
    expect(claimed.kind).toBe('owner');
    if (claimed.kind !== 'owner') throw new Error('expected boundary owner');
    expect(claimed.claim.beginInvocation('2026-08-16T00:00:01.000Z')).toEqual({
      kind: 'applied',
    });
    expect(first.close()).toEqual({ kind: 'closed' });

    const restarted = new EventStore(path);
    const authority = restarted.sessionTurnBoundaryAuthority();
    expect(authority.hasPossibleEffect('thread-restart')).toEqual({
      kind: 'available',
      active: true,
    });
    expect(
      authority.claimLifecycle('thread-restart', '2026-08-16T00:00:03.000Z'),
    ).toEqual({ kind: 'active-turn' });
    expect(
      authority.claim('thread-restart', '2026-08-16T00:00:03.000Z'),
    ).toEqual({ kind: 'busy' });
    const exited: CanonicalRuntimeEvent = {
      eventId: 'session-exited:thread-restart',
      provider: 'claude',
      threadId: 'thread-restart',
      sessionId: 'thread-restart',
      createdAt: '2026-08-16T00:00:04.000Z',
      method: 'session.exited',
      exitCode: 1,
    };
    restarted.appendEvent(exited);
    expect(authority.observe(exited)).toEqual({ kind: 'applied' });
    expect(authority.hasPossibleEffect('thread-restart')).toEqual({
      kind: 'available',
      active: false,
    });
    restarted.close();
  });

  test('shares one cross-store thread fence and clears only an exact accepted terminal', () => {
    const path = databasePath();
    const first = new EventStore(path);
    const second = new EventStore(path);
    const claimed = first
      .sessionTurnBoundaryAuthority()
      .claim('thread-shared', '2026-08-16T00:00:00.000Z');
    expect(claimed.kind).toBe('owner');
    if (claimed.kind !== 'owner') throw new Error('expected boundary owner');
    claimed.claim.beginInvocation('2026-08-16T00:00:01.000Z');
    claimed.claim.accepted('provider-turn-1', '2026-08-16T00:00:02.000Z');

    expect(
      second
        .sessionTurnBoundaryAuthority()
        .claimLifecycle('thread-shared', '2026-08-16T00:00:03.000Z'),
    ).toEqual({ kind: 'active-turn' });
    second
      .sessionTurnBoundaryAuthority()
      .observe(terminal('thread-shared', 'unrelated-turn'));
    expect(
      second.sessionTurnBoundaryAuthority().hasPossibleEffect('thread-shared'),
    ).toEqual({ kind: 'available', active: true });
    second
      .sessionTurnBoundaryAuthority()
      .observe(terminal('thread-shared', 'provider-turn-1'));
    expect(
      second.sessionTurnBoundaryAuthority().hasPossibleEffect('thread-shared'),
    ).toEqual({ kind: 'available', active: false });
    first.close();
    second.close();
  });

  test('station#2235: a recovery-synthesized abort does not retire the row; the engine abort still does', () => {
    // The recovery publishes its terminal fact mid-flow, before the banner
    // and the explicit close land. Retiring here would delete the record
    // the next boot needs to finish that sequence after a mid-flow crash —
    // so the marker opts this one event out, matched on the field, never
    // on the reason prose.
    const path = databasePath();
    const first = new EventStore(path);
    const second = new EventStore(path);
    const claimed = first
      .sessionTurnBoundaryAuthority()
      .claim('thread-recovery', '2026-08-16T00:00:00.000Z');
    expect(claimed.kind).toBe('owner');
    if (claimed.kind !== 'owner') throw new Error('expected boundary owner');
    claimed.claim.beginInvocation('2026-08-16T00:00:01.000Z');
    claimed.claim.accepted('provider-turn-9', '2026-08-16T00:00:02.000Z');

    second.sessionTurnBoundaryAuthority().observe({
      ...terminal('thread-recovery', 'provider-turn-9'),
      method: 'turn.aborted',
      recoveryTerminal: true,
    } as CanonicalRuntimeEvent);
    expect(
      second
        .sessionTurnBoundaryAuthority()
        .hasPossibleEffect('thread-recovery'),
    ).toEqual({ kind: 'available', active: true });

    second.sessionTurnBoundaryAuthority().observe({
      ...terminal('thread-recovery', 'provider-turn-9'),
      method: 'turn.aborted',
    } as CanonicalRuntimeEvent);
    expect(
      second
        .sessionTurnBoundaryAuthority()
        .hasPossibleEffect('thread-recovery'),
    ).toEqual({ kind: 'available', active: false });
    first.close();
    second.close();
  });

  test('turn-id reuse after terminal history becomes indeterminate until a session terminal', () => {
    const path = databasePath();
    const first = new EventStore(path);
    first.appendEvent({
      ...terminal('thread-join', 'provider-reused'),
      eventId: 'old-terminal',
      createdAt: '2026-08-16T00:00:00.000Z',
    });
    const claimed = first
      .sessionTurnBoundaryAuthority()
      .claim('thread-join', '2026-08-16T00:00:01.000Z');
    expect(claimed.kind).toBe('owner');
    if (claimed.kind !== 'owner') throw new Error('expected boundary owner');
    claimed.claim.beginInvocation('2026-08-16T00:00:02.000Z');
    expect(
      claimed.claim.accepted('provider-reused', '2026-08-16T00:00:03.000Z'),
    ).toEqual({ kind: 'ambiguous' });
    expect(
      first.sessionTurnBoundaryAuthority().hasPossibleEffect('thread-join'),
    ).toEqual({ kind: 'available', active: true });
    first.appendEvent({
      eventId: 'session-terminal-after-reuse',
      provider: 'claude',
      threadId: 'thread-join',
      sessionId: 'thread-join',
      createdAt: '2026-08-16T00:00:04.000Z',
      method: 'session.exited',
      exitCode: 0,
    });
    first.close();

    const restarted = new EventStore(path);
    expect(
      restarted.sessionTurnBoundaryAuthority().hasPossibleEffect('thread-join'),
    ).toEqual({ kind: 'available', active: false });
    restarted.close();
  });

  test('does not let a delayed old live terminal settle a newer reused provider id', () => {
    const store = new EventStore(databasePath());
    const authority = store.sessionTurnBoundaryAuthority();
    const claimed = authority.claim(
      'thread-live-reuse',
      '2026-08-16T00:00:02.000Z',
    );
    expect(claimed.kind).toBe('owner');
    if (claimed.kind !== 'owner') throw new Error('expected boundary owner');
    claimed.claim.beginInvocation('2026-08-16T00:00:03.000Z');
    claimed.claim.accepted('provider-reused', '2026-08-16T00:00:04.000Z');

    authority.observe({
      ...terminal('thread-live-reuse', 'provider-reused'),
      eventId: 'delayed-old-terminal',
      createdAt: '2026-08-16T00:00:01.000Z',
    });
    expect(authority.hasPossibleEffect('thread-live-reuse')).toEqual({
      kind: 'available',
      active: true,
    });
    authority.observe({
      ...terminal('thread-live-reuse', 'provider-reused'),
      eventId: 'current-terminal',
      createdAt: '2026-08-16T00:00:05.000Z',
    });
    expect(authority.hasPossibleEffect('thread-live-reuse')).toEqual({
      kind: 'available',
      active: false,
    });
    store.close();
  });

  test('fences reused identity when a duplicate old terminal arrives during the newer invocation', () => {
    const store = new EventStore(databasePath());
    const authority = store.sessionTurnBoundaryAuthority();
    const old = authority.claim(
      'thread-arrival-reuse',
      '2026-08-16T00:00:00.000Z',
    );
    expect(old.kind).toBe('owner');
    if (old.kind !== 'owner') throw new Error('expected old boundary owner');
    old.claim.beginInvocation('2026-08-16T00:00:01.000Z');
    old.claim.accepted('provider-reused', '2026-08-16T00:00:02.000Z');
    const firstTerminal = {
      ...terminal('thread-arrival-reuse', 'provider-reused'),
      eventId: 'old-terminal-first-delivery',
      createdAt: '2026-08-16T00:00:03.000Z',
    };
    store.appendEvent(firstTerminal);
    authority.observe(firstTerminal);

    const newer = authority.claim(
      'thread-arrival-reuse',
      '2026-08-16T00:00:04.000Z',
    );
    expect(newer.kind).toBe('owner');
    if (newer.kind !== 'owner')
      throw new Error('expected newer boundary owner');
    newer.claim.beginInvocation('2026-08-16T00:00:05.000Z');
    const duplicateTerminal = {
      ...terminal('thread-arrival-reuse', 'provider-reused'),
      eventId: 'old-terminal-duplicate-delivery',
      createdAt: '2026-08-16T00:00:06.000Z',
    };
    store.appendEvent(duplicateTerminal);
    authority.observe(duplicateTerminal);
    expect(
      newer.claim.accepted('provider-reused', '2026-08-16T00:00:07.000Z'),
    ).toEqual({ kind: 'ambiguous' });
    expect(authority.hasPossibleEffect('thread-arrival-reuse')).toEqual({
      kind: 'available',
      active: true,
    });
    expect(
      authority.claim('thread-arrival-reuse', '2026-08-16T00:00:08.000Z'),
    ).toEqual({ kind: 'busy' });
    store.close();
  });

  test('fences a provider id reused while its older acceptance is unresolved', () => {
    const store = new EventStore(databasePath());
    const authority = store.sessionTurnBoundaryAuthority();
    const older = authority.claim(
      'thread-concurrent-reuse',
      '2026-08-16T00:00:00.000Z',
    );
    expect(older.kind).toBe('owner');
    if (older.kind !== 'owner') throw new Error('expected older owner');
    older.claim.beginInvocation('2026-08-16T00:00:01.000Z');
    older.claim.accepted('provider-reused', '2026-08-16T00:00:02.000Z');

    const newer = authority.claim(
      'thread-concurrent-reuse',
      '2026-08-16T00:00:03.000Z',
    );
    expect(newer.kind).toBe('owner');
    if (newer.kind !== 'owner') throw new Error('expected newer owner');
    newer.claim.beginInvocation('2026-08-16T00:00:04.000Z');
    expect(
      newer.claim.accepted('provider-reused', '2026-08-16T00:00:05.000Z'),
    ).toEqual({ kind: 'ambiguous' });
    expect(authority.hasPossibleEffect('thread-concurrent-reuse')).toEqual({
      kind: 'available',
      active: true,
    });
    store.close();
  });

  test('reclaims an owner that closes after the peer has already opened', () => {
    const path = databasePath();
    const owner = new EventStore(path);
    const peer = new EventStore(path);
    const claimed = owner
      .sessionTurnBoundaryAuthority()
      .claim('thread-live-reclaim', '2026-08-16T00:00:00.000Z');
    expect(claimed.kind).toBe('owner');
    expect(owner.close()).toEqual({ kind: 'closed' });

    const reclaimed = peer
      .sessionTurnBoundaryAuthority()
      .claim('thread-live-reclaim', '2026-08-16T00:00:01.000Z');
    expect(reclaimed.kind).toBe('owner');
    if (reclaimed.kind !== 'owner') throw new Error('expected peer ownership');
    expect(reclaimed.claim.notInvoked()).toEqual({ kind: 'applied' });
    peer.close();
  });

  test('bounds protected accepted facts without pruning unresolved evidence', () => {
    const path = databasePath();
    const store = new EventStore(path);
    const authority = store.sessionTurnBoundaryAuthority();
    for (let index = 0; index < SESSION_TURN_ACCEPTED_CAPACITY; index += 1) {
      const claimed = authority.claim(
        'thread-capacity',
        new Date(index * 3_000).toISOString(),
      );
      expect(claimed.kind).toBe('owner');
      if (claimed.kind !== 'owner') throw new Error('expected boundary owner');
      claimed.claim.beginInvocation(
        new Date(index * 3_000 + 1_000).toISOString(),
      );
      expect(
        claimed.claim.accepted(
          `provider-turn-${index}`,
          new Date(index * 3_000 + 2_000).toISOString(),
        ),
      ).toEqual({ kind: 'applied' });
    }
    expect(
      authority.claim('thread-capacity', '2026-08-16T00:00:00.000Z'),
    ).toEqual({ kind: 'busy' });
    expect(authority.hasPossibleEffect('thread-capacity')).toEqual({
      kind: 'available',
      active: true,
    });
    store.close();

    const restarted = new EventStore(path);
    expect(
      restarted
        .sessionTurnBoundaryAuthority()
        .claim('thread-capacity', '2026-08-16T00:00:01.000Z'),
    ).toEqual({ kind: 'busy' });
    restarted.close();
  });

  test('retains an ambiguous begin and indeterminate transition until in-process recovery', () => {
    let record: SessionTurnBoundaryRecord | undefined;
    let transitionFaults = 3;
    const coordinator: SessionTurnBoundaryCoordinator = {
      create(input) {
        if (record) return { kind: 'busy' };
        record = { ...input };
        return { kind: 'applied' };
      },
      transition(input) {
        if (!record || record.boundaryId !== input.boundaryId) {
          return { kind: 'stale' };
        }
        if (record.state === input.to) return { kind: 'applied' };
        if (!input.from.includes(record.state)) return { kind: 'stale' };
        record = {
          ...record,
          state: input.to,
          updatedAt: input.now,
          ...(input.providerTurnId
            ? { providerTurnId: input.providerTurnId }
            : {}),
        };
        if (transitionFaults > 0) {
          transitionFaults -= 1;
          return { kind: 'unavailable' };
        }
        return { kind: 'applied' };
      },
      remove: () => ({ kind: 'stale' }),
      removeTerminal: () => ({ kind: 'applied' }),
      hasPossibleEffect: () => Boolean(record),
      active: () => (record ? [{ ...record }] : []),
      recordAccepted: () => ({ kind: 'unavailable' }),
    };
    const authority = createSessionTurnBoundaryAuthority({
      coordinator,
      owner: { id: 'owner', pid: process.pid, identityKind: 'unverified' },
      processIdentity: {
        exact: () => null,
        probe: () => ({ state: 'unavailable' }),
      },
    });
    const claimed = authority.claim(
      'thread-transition-fault',
      '2026-08-16T00:00:00.000Z',
    );
    expect(claimed.kind).toBe('owner');
    if (claimed.kind !== 'owner') throw new Error('expected boundary owner');
    expect(claimed.claim.beginInvocation('2026-08-16T00:00:01.000Z')).toEqual({
      kind: 'unavailable',
    });
    expect(claimed.claim.indeterminate('2026-08-16T00:00:02.000Z')).toEqual({
      kind: 'unavailable',
    });

    expect(authority.hasPossibleEffect('thread-transition-fault')).toEqual({
      kind: 'available',
      active: true,
    });
    expect(record?.state).toBe('indeterminate');
    expect(
      authority.claim('thread-transition-fault', '2026-08-16T00:00:03.000Z'),
    ).toEqual({ kind: 'busy' });
  });

  // #3563: the owner pid answers signal 0 with EPERM because a process of
  // another user now holds it, and that process was born after the owner.
  // The real shared probe composes both halves; only the kernel calls are
  // stubbed. A boundary owner proven gone must not fence the thread.
  test('a dead owner whose pid was reused by a foreign process does not fence the thread', () => {
    const foreignPid = 2_147_483_000;
    let record: SessionTurnBoundaryRecord | undefined = {
      boundaryId: 'stale-boundary',
      threadId: 'thread-reused-pid',
      state: 'prepared',
      ownerId: 'dead-owner',
      ownerPid: foreignPid,
      ownerBirth: 'owner-birth',
      ownerIdentityKind: 'exact',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
    };
    const coordinator: SessionTurnBoundaryCoordinator = {
      create(input) {
        if (record) return { kind: 'busy' };
        record = { ...input };
        return { kind: 'applied' };
      },
      transition: () => ({ kind: 'stale' }),
      remove(input) {
        if (record?.boundaryId !== input.boundaryId) return { kind: 'stale' };
        record = undefined;
        return { kind: 'applied' };
      },
      removeTerminal: () => ({ kind: 'applied' }),
      hasPossibleEffect: () => Boolean(record),
      active: () => (record ? [{ ...record }] : []),
      recordAccepted: () => ({ kind: 'unavailable' }),
    };
    const lookups: number[] = [];
    const authority = createSessionTurnBoundaryAuthority({
      coordinator,
      owner: { id: 'live-owner', pid: process.pid, identityKind: 'unverified' },
      processIdentity: {
        exact: () => null,
        probe: (pid) =>
          probeExactProcessIdentity(pid, {
            // POSIX semantics: Windows keeps EPERM unavailable (#3563).
            platform: 'linux',
            kill: () => {
              const error = new Error('EPERM') as NodeJS.ErrnoException;
              error.code = 'EPERM';
              throw error;
            },
            lookup: (candidate: number) => {
              lookups.push(candidate);
              return 'foreign-process-birth';
            },
          }),
      },
    });

    const claimed = authority.claim(
      'thread-reused-pid',
      '2026-08-16T00:00:05.000Z',
    );
    expect(lookups).toContain(foreignPid);
    expect(claimed.kind).toBe('owner');
    expect(record?.ownerId).toBe('live-owner');
  });

  test('totalizes a failed busy-path possible-effect probe', () => {
    const authority = createSessionTurnBoundaryAuthority({
      coordinator: {
        create: () => ({ kind: 'busy' }),
        transition: () => ({ kind: 'unavailable' }),
        remove: () => ({ kind: 'unavailable' }),
        removeTerminal: () => ({ kind: 'unavailable' }),
        recordAccepted: () => ({ kind: 'unavailable' }),
        hasPossibleEffect: () => {
          throw new Error('sqlite unavailable');
        },
        active: () => [],
      },
      owner: { id: 'owner', pid: process.pid, identityKind: 'unverified' },
      processIdentity: {
        exact: () => null,
        probe: () => ({ state: 'unavailable' }),
      },
    });
    expect(
      authority.claimLifecycle(
        'thread-probe-fault',
        '2026-08-16T00:00:00.000Z',
      ),
    ).toEqual({ kind: 'unavailable' });
  });
});

// Empty provider ids were accepted by the host authority before Monument.
// They must not turn a matching empty terminal into proof of completion.
test('an empty provider id cannot terminally retire an engine-opened boundary', () => {
  const store = new EventStore(':memory:');
  try {
    const authority = store.sessionTurnBoundaryAuthority();
    expect(
      authority
        .prepareProviderTurn(
          'empty-turn-thread',
          '',
          '2030-01-01T00:00:00.000Z',
        )
        .record(),
    ).toEqual({ kind: 'applied' });
    expect(
      authority.observe({
        eventId: 'empty-terminal',
        provider: 'claude',
        threadId: 'empty-turn-thread',
        turnId: '',
        method: 'turn.completed',
        createdAt: '2030-01-01T00:00:01.000Z',
      }),
    ).toEqual({ kind: 'applied' });
    // Observe alone must keep the legacy possible-effect fact; runtime history
    // reconciliation is a separate host path with its own existing contract.
    expect(
      store['db']
        .prepare(
          'SELECT COUNT(*) AS count FROM orchestration_turn_boundaries WHERE thread_id = ?',
        )
        .get('empty-turn-thread'),
    ).toEqual({ count: 1 });
  } finally {
    store.close();
  }
});

// #3568: turn boundaries and the conversation inbox are separate Monument
// storages on EventStore's one connection, and only the inbox's owns the
// inbox machine. A boundary write must create no inbox table of its own.
test('turn-boundary storage owns no inbox table: a store whose inbox was never opened has none after a boundary write', () => {
  const store = new EventStore(':memory:');
  try {
    const authority = store.sessionTurnBoundaryAuthority();
    expect(
      authority
        .prepareProviderTurn(
          'inbox-free-thread',
          'turn-1',
          '2030-01-01T00:00:00.000Z',
        )
        .record(),
    ).toEqual({ kind: 'applied' });
    const inboxTables = () =>
      store['db']
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'monument_inbox%'",
        )
        .all();
    expect(inboxTables()).toEqual([]);
    expect(
      store.readPendingThreadInboxSubmission('inbox-free-thread', 'turn-1'),
    ).toBeUndefined();
    expect(inboxTables()).toEqual([]);
    // Control: the inbox's own storage does create it.
    store.threadInboxStore();
    expect(inboxTables()).toEqual([{ name: 'monument_inbox_entries' }]);
  } finally {
    store.close();
  }
});

// These cases own actual Station event/audit/claim transaction composition.
function begunIntent(store: EventStore, threadId: string, key?: string) {
  const authority = store.sessionTurnBoundaryAuthority();
  const reserved = authority.reserve!(threadId, '2030-01-01T00:00:00Z');
  if (reserved.kind !== 'owner') throw new Error('reserved prerequisite');
  const capture = captureTurnIntent(
    {
      threadId,
      input: 'original input',
      ...(key ? { clientTurnId: key } : {}),
    },
    { binding: {}, requiresFreshCompanions: false },
  );
  const dedup = key
    ? store.createTurnDeduplicator().claim({
        threadId,
        clientTurnId: key,
        inputDigest: 'station-turn-submission/v1:sha256:' + 'a'.repeat(64),
      })
    : undefined;
  if (dedup && dedup.kind !== 'owner')
    throw new Error('private dedup prerequisite');
  expect(
    reserved.claim.prepareIntent!(
      capture,
      dedup?.kind === 'owner' ? dedup.claim : undefined,
      '2030-01-01T00:00:01Z',
    ),
  ).toEqual({ kind: 'applied' });
  expect(reserved.claim.beginInvocation('2030-01-01T00:00:02Z')).toEqual({
    kind: 'applied',
  });
  const event = (
    id: string,
    native: string | null = 'N',
    invocationId = capture.intent.invocationId,
  ): CanonicalRuntimeEvent => {
    const base = {
      eventId: id,
      provider: 'claude',
      threadId,
      createdAt: '1900-01-01T00:00:00Z',
      invocationId,
    };
    return native === null
      ? {
          ...base,
          method: 'runtime.error',
          message: 'request-owned failure before native acknowledgement',
          severity: 'error',
        }
      : { ...base, method: 'turn.completed', turnId: native };
  };
  return { authority, claim: reserved.claim, capture, event };
}

test('actual prepared claims accept reused native ids without old or untagged terminal authority', () => {
  const store = new EventStore(':memory:');
  try {
    const a = begunIntent(store, 'invocation-reuse', 'A');
    expect(a.claim.accepted('N', '2030-01-01T00:00:03Z')).toEqual({
      kind: 'applied',
    });
    const doneA = a.event('done-A');
    store.appendEvent(doneA);
    expect(a.authority.observe(doneA)).toEqual({ kind: 'applied' });
    const b = begunIntent(store, 'invocation-reuse', 'B');
    expect(b.claim.accepted('N', '2030-01-01T00:00:04Z')).toEqual({
      kind: 'applied',
    });
    for (const invocationId of [a.capture.intent.invocationId, undefined]) {
      const stale = {
        ...doneA,
        eventId: `late-${invocationId}`,
        createdAt: '2100-01-01T00:00:00Z',
        invocationId,
      };
      store.appendEvent(stale);
      expect(b.authority.observe(stale)).toEqual({ kind: 'applied' });
      expect(b.authority.hasPossibleEffect('invocation-reuse')).toEqual({
        kind: 'available',
        active: true,
      });
    }
    const doneB = b.event('done-B');
    const sequence = store['db']
      .prepare(
        'SELECT COALESCE(MAX(global_sequence),0)+1 AS next FROM orchestration_events',
      )
      .get() as { next: number };
    store['db']
      .prepare(`INSERT INTO orchestration_events(id,provider,thread_id,turn_id,method,payload,created_at,sequence,global_sequence)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(
        doneB.eventId,
        doneB.provider,
        doneB.threadId,
        doneB.turnId,
        doneB.method,
        JSON.stringify(doneB),
        doneB.createdAt,
        sequence.next,
        sequence.next,
      );
    const beforeRead = store['db']
      .prepare('SELECT * FROM orchestration_prepared_turns')
      .all();
    expect(b.authority.hasPossibleEffect('invocation-reuse')).toEqual({
      kind: 'available',
      active: false,
    });
    expect(
      store['db'].prepare('SELECT * FROM orchestration_prepared_turns').all(),
    ).toEqual(beforeRead);
    expect(b.authority.observe(doneB)).toEqual({ kind: 'applied' });
    expect(
      store['db'].prepare('SELECT * FROM orchestration_turn_boundaries').all(),
    ).toEqual([]);
    const audit = store['db']
      .prepare(
        'SELECT terminal_retirement FROM orchestration_prepared_turns WHERE invocation_id = ?',
      )
      .get(b.capture.intent.invocationId) as
      | { terminal_retirement: string }
      | undefined;
    expect(JSON.parse(String(audit?.terminal_retirement))).toMatchObject({
      terminal: { terminalEventId: 'done-B' },
      boundary: { createdSequence: expect.any(Number), purpose: 'turn' },
      dedup: {
        inputDigest: 'station-turn-submission/v1:sha256:' + 'a'.repeat(64),
      },
    });
  } finally {
    store.close();
  }
});

test('early request-owned missing-native terminal keeps exact begun custody for late acknowledgement', () => {
  const store = new EventStore(':memory:');
  try {
    const authority = store.sessionTurnBoundaryAuthority();
    expect(
      authority
        .prepareProviderTurn(
          'early-exact',
          'other-native',
          '2030-01-01T00:00:00Z',
        )
        .record(),
    ).toEqual({ kind: 'applied' });
    const b = begunIntent(store, 'early-exact', 'B');
    const event = b.event('early-B', null);
    store.appendEvent(event);
    expect(b.authority.observe(event)).toEqual({ kind: 'applied' });
    expect(
      store['db']
        .prepare(
          'SELECT * FROM orchestration_turn_boundaries WHERE invocation_id = ?',
        )
        .all(b.capture.intent.invocationId),
    ).toEqual([]);
    expect(authority.hasPossibleEffect('early-exact')).toEqual({
      kind: 'available',
      active: true,
    });
    expect(
      store['db']
        .prepare(
          'SELECT provider_turn_id FROM orchestration_turn_boundaries WHERE invocation_id IS NULL',
        )
        .get(),
    ).toEqual({ provider_turn_id: 'other-native' });
    expect(b.claim.accepted('N', '2030-01-01T00:00:03Z')).toEqual({
      kind: 'applied',
    });
    expect(b.claim.accepted('N', '2099-01-01T00:00:00Z')).toEqual({
      kind: 'applied',
    });
    expect(b.claim.terminalObserved('N')).toEqual({ kind: 'stale' });
  } finally {
    store.close();
  }
});

test('host append rollback undoes exact event witness and deletion; delete trigger reaches witness first', () => {
  const store = new EventStore(':memory:');
  try {
    const b = begunIntent(store, 'atomic-terminal', 'B');
    const event = b.event('atomic-B');
    const before = store['db']
      .prepare('SELECT * FROM orchestration_turn_boundaries')
      .all();
    const beforeBody = store['db']
      .prepare('SELECT * FROM orchestration_prepared_turns')
      .all();
    const beforeDedup = store['db']
      .prepare('SELECT * FROM orchestration_turn_dedup')
      .all();
    store[
      'db'
    ].exec(`CREATE TRIGGER fail_terminal_delete BEFORE DELETE ON orchestration_turn_boundaries BEGIN
      SELECT CASE WHEN (SELECT terminal_retirement FROM orchestration_prepared_turns WHERE boundary_id = OLD.boundary_id) IS NULL THEN RAISE(ABORT, 'witness not reached') END;
      SELECT RAISE(ABORT, 'after witness'); END;`);
    expect(() => {
      store['db'].exec('BEGIN IMMEDIATE');
      try {
        store.appendEvent(event);
        const result = b.authority.observe(event);
        if (result.kind !== 'applied')
          throw new Error('terminal transaction unavailable');
      } finally {
        store['db'].exec('ROLLBACK');
      }
    }).toThrow('after witness');
    expect(store.hasEventId(event.eventId)).toBe(false);
    expect(
      store['db'].prepare('SELECT * FROM orchestration_prepared_turns').all(),
    ).toEqual(beforeBody);
    expect(
      store['db'].prepare('SELECT * FROM orchestration_turn_dedup').all(),
    ).toEqual(beforeDedup);
    expect(
      store['db'].prepare('SELECT * FROM orchestration_turn_boundaries').all(),
    ).toEqual(before);
    expect(
      (
        store['db']
          .prepare(
            'SELECT terminal_retirement FROM orchestration_prepared_turns',
          )
          .get() as { terminal_retirement: string | null } | undefined
      )?.terminal_retirement,
    ).toBeNull();
    store['db'].exec('DROP TRIGGER fail_terminal_delete');
    store['db'].exec('BEGIN IMMEDIATE');
    store.appendEvent(event);
    expect(b.authority.observe(event)).toEqual({ kind: 'applied' });
    store['db'].exec('ROLLBACK');
    expect(store.hasEventId(event.eventId)).toBe(false);
    expect(
      store['db'].prepare('SELECT * FROM orchestration_prepared_turns').all(),
    ).toEqual(beforeBody);
    expect(
      store['db'].prepare('SELECT * FROM orchestration_turn_dedup').all(),
    ).toEqual(beforeDedup);
    expect(
      store['db'].prepare('SELECT * FROM orchestration_turn_boundaries').all(),
    ).toEqual(before);
    store.appendEvent(event);
    expect(b.authority.observe(event)).toEqual({ kind: 'applied' });
    expect(b.claim.accepted('N', '2030-01-01T00:00:03Z')).toEqual({
      kind: 'applied',
    });
  } finally {
    store.close();
  }
});

test('post-COMMIT acceptance loss retains the original full begin image across unknown retry', () => {
  const store = new EventStore(':memory:');
  const b = begunIntent(store, 'ack-loss', 'B');
  const db = store['db'];
  const original = db.exec.bind(db);
  let lost = false;
  const spy = vi.spyOn(db, 'exec').mockImplementation((sql) => {
    const result = original(sql);
    if (!lost && sql === 'COMMIT') {
      lost = true;
      throw new Error('committed acknowledgement lost');
    }
    return result;
  });
  try {
    expect(b.claim.accepted('N', '2030-01-01T00:00:03Z')).toEqual({
      kind: 'unavailable',
    });
    spy.mockRestore();
    expect(lost).toBe(true);
    const event = b.event('ack-B');
    store.appendEvent(event);
    expect(b.authority.observe(event)).toEqual({ kind: 'applied' });
    expect(b.claim.accepted('N', '2099-01-01T00:00:00Z')).toEqual({
      kind: 'applied',
    });
    expect(
      store['db'].prepare('SELECT * FROM orchestration_turn_boundaries').all(),
    ).toEqual([]);
  } finally {
    spy.mockRestore();
    store.close();
  }
});

function appendUnobservedCanonical(
  store: EventStore,
  event: CanonicalRuntimeEvent,
) {
  const sequence = store['db']
    .prepare(
      'SELECT COALESCE(MAX(global_sequence),0)+1 AS next FROM orchestration_events',
    )
    .get() as { next: number };
  store['db']
    .prepare(`INSERT INTO orchestration_events(id,provider,thread_id,turn_id,method,payload,created_at,sequence,global_sequence)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(
      event.eventId,
      event.provider,
      event.threadId,
      event.turnId ?? null,
      event.method,
      JSON.stringify(event),
      event.createdAt,
      sequence.next,
      sequence.next,
    );
}

test('host complete-set contradiction fences current custody and later exact acknowledgement without hiding a pinned witness event', () => {
  const store = new EventStore(':memory:');
  try {
    const b = begunIntent(store, 'contradiction', 'B');
    expect(b.claim.accepted('N', '2030-01-01T00:00:03Z')).toEqual({
      kind: 'applied',
    });
    appendUnobservedCanonical(store, b.event('eN'));
    appendUnobservedCanonical(store, b.event('eM', 'M'));
    const before = store['db']
      .prepare('SELECT * FROM orchestration_turn_boundaries')
      .all();
    expect(b.authority.hasPossibleEffect('contradiction')).toEqual({
      kind: 'available',
      active: true,
    });
    expect(b.claim.accepted('N', '2099-01-01T00:00:00Z')).toEqual({
      kind: 'stale',
    });
    expect(
      store['db'].prepare('SELECT * FROM orchestration_turn_boundaries').all(),
    ).toEqual(before);
    store['db'].prepare("DELETE FROM orchestration_events WHERE id='eM'").run();
    expect(b.claim.accepted('N', '2099-01-01T00:00:00Z')).toEqual({
      kind: 'applied',
    });
    const witness = store['db']
      .prepare('SELECT terminal_retirement FROM orchestration_prepared_turns')
      .get();
    store.appendEvent(b.event('late-eM', 'M'));
    expect(b.claim.accepted('N', '2099-01-01T00:00:00Z')).toEqual({
      kind: 'stale',
    });
    expect(
      store['db']
        .prepare('SELECT terminal_retirement FROM orchestration_prepared_turns')
        .get(),
    ).toEqual(witness);
    expect(
      store['db'].prepare('SELECT * FROM orchestration_turn_boundaries').all(),
    ).toEqual([]);
  } finally {
    store.close();
  }
});

test('host exact false observation validates retained contents with and without a boundary', () => {
  const store = new EventStore(':memory:');
  try {
    const b = begunIntent(store, 'false-exact', 'B');
    const event: CanonicalRuntimeEvent = {
      ...b.event('false-event'),
      method: 'turn.aborted',
      turnId: 'N',
      reason: 'recovery',
      recoveryTerminal: true,
    };
    store.appendEvent(event);
    expect(b.authority.observe(event)).toEqual({ kind: 'applied' });
    expect(b.authority.hasPossibleEffect('false-exact')).toEqual({
      kind: 'available',
      active: true,
    });
    const { recoveryTerminal: _marker, ...withoutRecovery } = event;
    for (const retained of [true, false]) {
      if (!retained)
        store['db']
          .prepare(
            "DELETE FROM orchestration_turn_boundaries WHERE thread_id='false-exact'",
          )
          .run();
      for (const changed of [
        { ...event, createdAt: 'changed' },
        { ...event, eventId: 'missing-false' },
        withoutRecovery,
      ]) {
        expect(b.authority.observe(changed)).toEqual({ kind: 'unavailable' });
      }
      expect(b.authority.observe(event)).toEqual({ kind: 'applied' });
    }
  } finally {
    store.close();
  }
});

test('host retirement refuses changed current dedup digest and full original owner revision sequence custody', () => {
  const store = new EventStore(':memory:');
  try {
    const b = begunIntent(store, 'full-custody', 'B');
    const db = store['db'];
    const original = db
      .prepare('SELECT * FROM orchestration_turn_boundaries')
      .get() as Record<string, unknown>;
    for (const [column, value] of [
      ['owner_birth', 'different'],
      ['updated_at', 'different'],
      ['created_at', 'different'],
      ['created_sequence', 99],
      ['input_digest', 'different'],
      ['intent_digest', 'different'],
      ['body_ref', 'different'],
    ] as const) {
      db.prepare(`UPDATE orchestration_turn_boundaries SET ${column}=?`).run(
        value,
      );
      expect(b.claim.accepted('N', '2030-01-01T00:00:03Z')).toEqual({
        kind: 'stale',
      });
      db.prepare(`UPDATE orchestration_turn_boundaries SET ${column}=?`).run(
        original[column],
      );
    }
    expect(b.claim.accepted('N', '2099-01-01T00:00:00Z')).toEqual({
      kind: 'applied',
    });
    const dedup = db
      .prepare('SELECT input_digest,owner_json FROM orchestration_turn_dedup')
      .get() as { input_digest: string; owner_json: string };
    const owner = JSON.parse(dedup.owner_json);
    db.prepare(
      'UPDATE orchestration_turn_dedup SET input_digest=?,owner_json=?',
    ).run('changed', JSON.stringify({ ...owner, inputDigest: 'changed' }));
    expect(b.claim.accepted('N', '2099-01-01T00:00:00Z')).toEqual({
      kind: 'stale',
    });
    db.prepare(
      'UPDATE orchestration_turn_dedup SET input_digest=?,owner_json=?',
    ).run(dedup.input_digest, dedup.owner_json);
    expect(b.claim.accepted('N', '2099-01-01T00:00:00Z')).toEqual({
      kind: 'applied',
    });
  } finally {
    store.close();
  }
});

test('embedded memory preserves invocation identity and exact early settlement without clock inference', () => {
  const authority = createInMemorySessionTurnBoundaryAuthority();
  let oldInvocation = '';
  for (const key of ['A', 'B']) {
    const owned = authority.reserve!('memory-origin', '2030-01-01T00:00:00Z');
    if (owned.kind !== 'owner')
      throw new Error('memory reservation prerequisite');
    const capture = captureTurnIntent(
      { threadId: 'memory-origin', input: key },
      { binding: {}, requiresFreshCompanions: false },
    );
    if (key === 'A') oldInvocation = capture.intent.invocationId;
    expect(
      owned.claim.prepareIntent!(capture, undefined, '2030-01-01T00:00:01Z'),
    ).toEqual({ kind: 'applied' });
    expect(owned.claim.beginInvocation('2030-01-01T00:00:02Z')).toEqual({
      kind: 'applied',
    });
    if (key === 'B') {
      expect(
        authority.observe({
          ...terminal('memory-origin', 'N'),
          eventId: 'old-memory-A',
          invocationId: oldInvocation,
          createdAt: '2100-01-01T00:00:00Z',
        }),
      ).toEqual({ kind: 'applied' });
      expect(authority.hasPossibleEffect('memory-origin')).toEqual({
        kind: 'available',
        active: true,
      });
    }
    expect(
      authority.observe({
        ...terminal('memory-origin', 'N'),
        eventId: key,
        invocationId: capture.intent.invocationId,
        createdAt: '1900-01-01T00:00:00Z',
      }),
    ).toEqual({ kind: 'applied' });
    expect(owned.claim.accepted('N', '2030-01-01T00:00:03Z')).toEqual({
      kind: 'applied',
    });
    expect(authority.hasPossibleEffect('memory-origin')).toEqual({
      kind: 'available',
      active: false,
    });
  }
});

test('no-target cleanup retries genuine pending acceptance from retained witness without collecting unrelated terminal payloads', () => {
  const store = new EventStore(':memory:');
  const b = begunIntent(store, 'witness-preflight', 'B');
  const db = store['db'];
  const original = db.exec.bind(db);
  let phase = 'commit-loss';
  let retryFailed = false;
  const injected = vi.spyOn(db, 'exec').mockImplementation((sql) => {
    if (
      phase === 'retry-loss' &&
      !retryFailed &&
      sql === 'SAVEPOINT monument_command'
    ) {
      retryFailed = true;
      throw new Error('transient acceptance retry unavailable');
    }
    const result = original(sql);
    if (phase === 'commit-loss' && sql === 'COMMIT') {
      phase = 'idle';
      throw new Error('after actual acceptance COMMIT');
    }
    return result;
  });
  try {
    expect(b.claim.accepted('N', '2030-01-01T00:00:03Z')).toEqual({
      kind: 'unavailable',
    });
    phase = 'retry-loss';
    store.appendEvent(b.event('witness-preflight-done'));
    expect(retryFailed).toBe(true);
    expect(
      db.prepare('SELECT * FROM orchestration_turn_boundaries').all(),
    ).toEqual([]);
    const witness = db
      .prepare('SELECT terminal_retirement FROM orchestration_prepared_turns')
      .get() as { terminal_retirement: string };
    expect(
      JSON.parse(witness.terminal_retirement).terminal.terminalEventId,
    ).toBe('witness-preflight-done');
    phase = 'idle';
    injected.mockRestore();
    const reads = vi.spyOn(db, 'prepare');
    const next = b.authority.reserve!(
      'witness-preflight',
      '2030-01-01T00:00:04Z',
    );
    const sql = reads.mock.calls.map(([statement]) => String(statement));
    reads.mockRestore();
    expect(next.kind).toBe('owner');
    expect(
      sql.some((query) =>
        query.includes(
          'SELECT * FROM orchestration_prepared_turns WHERE thread_id = ? AND boundary_id = ?',
        ),
      ),
    ).toBe(true);
    expect(
      sql.some((query) =>
        query.includes(
          'SELECT event.payload FROM orchestration_events AS event',
        ),
      ),
    ).toBe(false);
    expect(b.claim.accepted('N', '2099-01-01T00:00:00Z')).toEqual({
      kind: 'applied',
    });
  } finally {
    injected.mockRestore();
    store.close();
  }
});

test('prepared captured target cleanup keeps true session sequence disposal without an ordinary witness', () => {
  const store = new EventStore(':memory:');
  try {
    const authority = store.sessionTurnBoundaryAuthority();
    const owned = authority.reserve!(
      'prepared-session-scope',
      '2030-01-01T00:00:00Z',
    );
    if (owned.kind !== 'owner') throw new Error('actual reserved prerequisite');
    const capture = captureTurnIntent(
      { threadId: 'prepared-session-scope', input: 'pending' },
      { binding: {}, requiresFreshCompanions: false },
    );
    expect(
      owned.claim.prepareIntent!(capture, undefined, '2030-01-01T00:00:01Z'),
    ).toEqual({ kind: 'applied' });
    const event = {
      eventId: 'prepared-session-exit',
      threadId: 'prepared-session-scope',
      provider: 'claude',
      method: 'session.exited',
      sessionId: 'prepared-session-scope',
      exitCode: 0,
      createdAt: '1900-01-01T00:00:00Z',
    };
    store['db']
      .prepare(
        'INSERT INTO orchestration_events(id,provider,thread_id,method,payload,created_at,sequence,global_sequence) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        event.eventId,
        event.provider,
        event.threadId,
        event.method,
        JSON.stringify(event),
        event.createdAt,
        1,
        1,
      );
    const reads = vi.spyOn(store['db'], 'prepare');
    const provider = authority.prepareProviderTurn(
      event.threadId,
      'provider:new',
      '2030-01-01T00:00:02Z',
    );
    expect(provider.record()).toEqual({ kind: 'applied' });
    const statements = reads.mock.calls.map(([sql]) => String(sql));
    reads.mockRestore();
    expect(
      statements.filter((sql) =>
        sql.includes('SELECT event.payload FROM orchestration_events AS event'),
      ),
    ).toHaveLength(1);
    expect(
      store['db']
        .prepare(
          'SELECT * FROM orchestration_turn_boundaries WHERE invocation_id=?',
        )
        .all(capture.intent.invocationId),
    ).toEqual([]);
    expect(
      store['db']
        .prepare(
          'SELECT terminal_retirement FROM orchestration_prepared_turns WHERE invocation_id=?',
        )
        .get(capture.intent.invocationId),
    ).toEqual({ terminal_retirement: null });
  } finally {
    store.close();
  }
});
