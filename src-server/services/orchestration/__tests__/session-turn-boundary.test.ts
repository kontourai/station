import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test } from 'vitest';
import { EventStore } from '../event-store.js';
import {
  createInMemorySessionTurnBoundaryAuthority,
  createSessionTurnBoundaryAuthority,
  runSessionStartWithBoundary,
  SESSION_START_INDETERMINATE_CODE,
  SESSION_TURN_ACCEPTED_CAPACITY,
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
      expect(
        authority.observe({
          eventId: 'terminal:uncertain-start',
          provider: 'claude',
          threadId: 'uncertain-start',
          sessionId: 'uncertain-start',
          method: 'session.exited',
          createdAt: '2026-09-05T00:05:01.000Z',
          exitCode: 0,
        }),
      ).toEqual({ kind: 'applied' });
      expect(authority.hasPossibleEffect('uncertain-start')).toEqual({
        kind: 'available',
        active: false,
      });
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
    expect(
      authority.observe({
        eventId: 'session-exited:thread-restart',
        provider: 'claude',
        threadId: 'thread-restart',
        sessionId: 'thread-restart',
        createdAt: '2026-08-16T00:00:04.000Z',
        method: 'session.exited',
        exitCode: 1,
      }),
    ).toEqual({ kind: 'applied' });
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

  test('totalizes a failed busy-path possible-effect probe', () => {
    const authority = createSessionTurnBoundaryAuthority({
      coordinator: {
        create: () => ({ kind: 'busy' }),
        transition: () => ({ kind: 'unavailable' }),
        remove: () => ({ kind: 'unavailable' }),
        removeTerminal: () => ({ kind: 'unavailable' }),
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
