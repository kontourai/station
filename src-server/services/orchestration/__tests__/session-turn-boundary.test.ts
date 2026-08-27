import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test } from 'vitest';
import { EventStore } from '../event-store.js';
import {
  createSessionTurnBoundaryAuthority,
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
