import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { awaitSessionRecoveryCompleted } from '../../../__test-utils__/session-runtime-barriers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { ProviderAdapterShape } from '../../../providers/adapter-shape.js';
import { createOrchestrationRoutes } from '../../../routes/orchestration/orchestration.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const makeTempDir = trackTempDirs();

async function fixture(
  mode:
    | 'finished'
    | 'unknown'
    | 'self'
    | 'self-finished'
    | 'held'
    | 'foreign-self',
) {
  const path = join(makeTempDir('cascade-review-'), 'events.sqlite');
  const probe = vi.fn((pid: number) =>
    pid === process.pid
      ? { state: 'exact' as const, identity: { pid, start: 'self-birth' } }
      : { state: 'unavailable' as const },
  );
  const store = new EventStore(path, undefined, {
    exact: () =>
      mode === 'foreign-self'
        ? null
        : { pid: process.pid, start: 'self-birth' },
    probe,
  });
  const adapter: ProviderAdapterShape = new GateTestAdapter();
  const running = new Set(mode === 'held' ? ['parent', 'child'] : ['parent']);
  const stop = vi
    .spyOn(adapter, 'stopSession')
    .mockImplementation(async (id) => {
      running.delete(id);
    });
  vi.spyOn(adapter, 'hasSession').mockImplementation(async (id) =>
    running.has(id),
  );
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventStore: store,
    eventBus: new EventBus(),
    idleSessionParkAfterMs: 0,
    logger: { debug() {}, warn() {} },
  });
  store.bindSessionActivity((id) => service.hasLocalSessionBinding(id));
  service.initialize();
  await awaitSessionRecoveryCompleted(service);
  for (const id of ['parent', 'child'])
    store.appendEvent({
      eventId: `${id}-start`,
      threadId: id,
      sessionId: id,
      provider: 'claude',
      method: 'session.started',
      createdAt: '2026-01-01T00:00:00.000Z',
      metadata:
        id === 'child'
          ? {
              delegation: {
                parentSessionId: 'parent',
                parentConversationId: 'parent',
              },
              stationDelegationProvenance: 'caller-derived',
            }
          : { userId: 'owner' },
    });
  service.seedSessionRecord({
    threadId: 'parent',
    provider: 'claude',
    status: 'running',
  });
  if (mode === 'held')
    service.seedSessionRecord({
      threadId: 'child',
      provider: 'claude',
      status: 'running',
    });
  if (mode.startsWith('self') || mode === 'foreign-self') {
    const admission = store
      .sessionTurnBoundaryAuthority()
      .claim('child', '2026-01-01T00:00:01.000Z');
    if (admission.kind !== 'owner') throw new Error('Child preparation failed');
    expect(
      admission.claim.beginInvocation('2026-01-01T00:00:02.000Z').kind,
    ).toBe('applied');
    expect(
      admission.claim.accepted('child-turn', '2026-01-01T00:00:03.000Z').kind,
    ).toBe('applied');
  }
  if (mode === 'foreign-self')
    store['db']
      .prepare(
        "UPDATE orchestration_turn_boundaries SET owner_id = 'foreign', owner_birth = 'self-birth', owner_identity_kind = 'exact' WHERE thread_id = 'child'",
      )
      .run();
  if (mode === 'finished' || mode === 'self-finished')
    store.appendEvent({
      eventId: 'child-exit',
      threadId: 'child',
      sessionId: 'child',
      provider: 'claude',
      method: 'session.exited',
      reason: 'completed',
      createdAt: '2026-01-01T00:00:04.000Z',
    });
  const app = new Hono().route(
    '/api/orchestration',
    createOrchestrationRoutes(service, {
      eventBus: new EventBus(),
      logger: { debug() {} },
      getUserId: () => 'owner',
    }),
  );
  return {
    app,
    path,
    probe,
    adapter,
    store,
    service,
    stop,
    running,
    close: async () => {
      await service.shutdown();
      store.close();
    },
  };
}

test('a foreign owner id with our own PID is never a peer', async () => {
  const f = await fixture('foreign-self');
  try {
    expect(f.store.cascadeStopOwner('child', false)).toMatchObject({
      custody: 'unknown',
      reason: 'unverified-local-owner',
    });
  } finally {
    await f.close();
  }
});

test('unknown custody backs off probing and explicit retry checks again', async () => {
  const f = await fixture('unknown');
  try {
    f.store.upsertSession({
      threadId: 'child',
      provider: 'claude',
      status: 'running',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    f.store['db']
      .prepare(
        `INSERT INTO orchestration_turn_boundaries (boundary_id,thread_id,state,owner_id,owner_pid,owner_birth,owner_identity_kind,created_at,updated_at,purpose,created_sequence) VALUES ('unknown-peer','child','invoking','peer',616161,'peer-birth','exact','2026-01-01','2026-01-01','turn',0)`,
      )
      .run();
    await f.service.dispatch({ type: 'stopSession', threadId: 'parent' });
    const hasSession = vi.mocked(f.adapter.hasSession);
    const attempts = () =>
      hasSession.mock.calls.filter(([id]) => id === 'child').length;
    const initial = attempts();
    expect(initial).toBeGreaterThan(0);
    const processProbes = f.probe.mock.calls.length;
    expect(processProbes).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) await f.service.maintainOwnedWork();
    expect(attempts()).toBe(initial);
    expect(f.probe).toHaveBeenCalledTimes(processProbes);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_001);
    try {
      await f.service.maintainOwnedWork();
    } finally {
      clock.mockRestore();
    }
    expect(attempts()).toBe(initial + 1);
    f.store.requestCascadeRecheck('parent');
    await f.service.maintainOwnedWork();
    expect(attempts()).toBe(initial + 2);
    expect(f.store.pendingCascadeStops()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('one maintenance pass caps unknown adapter probes and retains the entire backlog', async () => {
  const f = await fixture('unknown');
  const at = '2026-01-01T00:00:00.000Z';
  try {
    f.store.appendEvent({
      eventId: 'bulk-parent-stop',
      threadId: 'parent',
      sessionId: 'parent',
      provider: 'claude',
      method: 'session.exited',
      reason: 'stopped',
      createdAt: at,
    });
    for (let i = 0; i < 100; i++) {
      const child = `unknown-${i}`;
      f.store.appendEvent({
        eventId: `${child}-start`,
        threadId: child,
        sessionId: child,
        provider: 'claude',
        method: 'session.started',
        createdAt: at,
      });
      f.store.upsertSession({
        threadId: child,
        provider: 'claude',
        status: 'running',
        createdAt: at,
        updatedAt: at,
      });
      f.store['db']
        .prepare(
          `INSERT INTO orchestration_turn_boundaries (boundary_id,thread_id,state,owner_id,owner_pid,owner_birth,owner_identity_kind,created_at,updated_at,purpose,created_sequence) VALUES (?,?,'invoking','peer',616161,'peer-birth','exact',?,?,'turn',0)`,
        )
        .run(child, child, at, at);
      f.store.recordCascadeStopIntent('parent', child, 'bulk-parent-stop');
    }
    vi.mocked(f.adapter.hasSession).mockClear();
    f.probe.mockClear();
    await f.service.maintainOwnedWork();
    expect(
      vi.mocked(f.adapter.hasSession).mock.calls.length,
    ).toBeLessThanOrEqual(64);
    expect(f.probe.mock.calls.length).toBeGreaterThan(0);
    expect(f.probe.mock.calls.length).toBeLessThanOrEqual(64);
    expect(f.store.pendingCascadeStops()).toHaveLength(101);
    expect(f.stop).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test('a process probe that races an owner change cannot publish the stale peer', () => {
  const store = new EventStore(
    join(makeTempDir('cascade-owner-race-'), 'events.sqlite'),
    undefined,
    {
      exact: () => ({ pid: process.pid, start: 'self-birth' }),
      probe: (pid) => {
        store['db']
          .prepare(
            "UPDATE orchestration_turn_boundaries SET owner_id = 'replacement', owner_pid = 717171, owner_birth = 'replacement-birth' WHERE thread_id = 'child'",
          )
          .run();
        return { state: 'exact', identity: { pid, start: 'peer-birth' } };
      },
    },
  );
  try {
    store['db']
      .prepare(`INSERT INTO orchestration_turn_boundaries (boundary_id,thread_id,state,owner_id,owner_pid,owner_birth,owner_identity_kind,created_at,updated_at,purpose,created_sequence)
      VALUES ('peer','child','invoking','peer-owner',616161,'peer-birth','exact','2026-01-01','2026-01-01','turn',0)`)
      .run();
    expect(store.cascadeStopOwner('child', false)).toMatchObject({
      custody: 'unknown',
      reason: 'owner-changed',
    });
  } finally {
    store.close();
  }
});

test.each(['owner', 'revision'] as const)(
  'custody writes compare the observed boundary inside the writer transaction: %s',
  (change) => {
    const store = new EventStore(
      join(makeTempDir('cascade-custody-cas-'), 'events.sqlite'),
      undefined,
      {
        exact: () => ({ pid: process.pid, start: 'self-birth' }),
        probe: (pid) => ({
          state: 'exact',
          identity: { pid, start: 'peer-birth' },
        }),
      },
    );
    const at = '2026-01-01T00:00:00Z';
    try {
      store.appendEvent({
        eventId: 'parent-stop',
        threadId: 'parent',
        sessionId: 'parent',
        provider: 'claude',
        method: 'session.exited',
        reason: 'stopped',
        createdAt: at,
      });
      store['db']
        .prepare(`INSERT INTO orchestration_turn_boundaries (boundary_id,thread_id,state,owner_id,owner_pid,owner_birth,owner_identity_kind,created_at,updated_at,purpose,created_sequence)
      VALUES ('peer','child','invoking','peer-owner',616161,'peer-birth','exact',?,?,'turn',0)`)
        .run(at, at);
      store.recordCascadeStopIntent('parent', 'child', 'parent-stop');
      const observed = store.cascadeStopOwner('child', false);
      if (observed.custody !== 'peer')
        throw new Error(
          'The peer control did not reach liveness classification',
        );
      store['db']
        .prepare(
          change === 'owner'
            ? "UPDATE orchestration_turn_boundaries SET owner_id = 'replacement' WHERE boundary_id = 'peer'"
            : "UPDATE orchestration_turn_boundaries SET state = 'prepared', updated_at = '2026-01-01T00:00:01Z' WHERE boundary_id = 'peer'",
        )
        .run();
      expect(
        store.recordCascadeStopCustody(
          'child',
          'parent-stop',
          'peer',
          observed.reason,
          0,
          observed.snapshot,
        ),
      ).toBe(false);
      expect(store.pendingCascadeStops()).toEqual([
        expect.objectContaining({ custody: 'unknown', reason: 'unobserved' }),
      ]);
      const fresh = store.cascadeStopOwner('child', false);
      expect(
        store.recordCascadeStopCustody(
          'child',
          'parent-stop',
          'peer',
          fresh.reason,
          0,
          fresh.snapshot,
        ),
      ).toBe(true);
      expect(store.pendingCascadeStops()).toEqual([
        expect.objectContaining({ custody: 'peer' }),
      ]);
    } finally {
      store.close();
    }
  },
);

test('the composed binding is single-shot and reports current local custody', () => {
  const store = new EventStore(
    join(makeTempDir('cascade-binding-owner-'), 'events.sqlite'),
  );
  try {
    store.appendEvent({
      eventId: 'child-exited',
      threadId: 'child',
      sessionId: 'child',
      provider: 'claude',
      method: 'session.exited',
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(store.cascadeStopOwner('child').custody).toBe('settled');
    let held = false;
    store.bindSessionActivity(() => held);
    expect(store.cascadeStopOwner('child').custody).toBe('settled');
    held = true;
    expect(store.cascadeStopOwner('child').custody).toBe('local');
    expect(store.cascadeStopOwner('child', false).custody).toBe('local');
    expect(() => store.bindSessionActivity(() => false)).toThrow(
      'already bound',
    );
    expect(store.cascadeStopOwner('child').custody).toBe('local');
    held = false;
    expect(store.cascadeStopOwner('child').custody).toBe('settled');
  } finally {
    store.close();
  }
});

test('release rechecks custody evidence rather than abandoning a changed owner', async () => {
  const f = await fixture('unknown');
  try {
    await f.service.dispatch({ type: 'stopSession', threadId: 'parent' });
    f.store['db']
      .prepare(`INSERT INTO orchestration_turn_boundaries (boundary_id,thread_id,state,owner_id,owner_pid,owner_birth,owner_identity_kind,created_at,updated_at,purpose,created_sequence)
      VALUES ('new-owner','child','invoking','new-owner',616161,'peer-birth','exact','2026-01-01','2026-01-01','turn',10)`)
      .run();
    expect(() =>
      f.store.deleteThread('parent', { releaseUnknownOwnedWork: true }),
    ).toThrow('ownership changed');
    expect(f.store.pendingCascadeStops()).toHaveLength(1);
    expect(f.store.readSessionByThread('parent')).toBeDefined();
  } finally {
    await f.close();
  }
});

test('an unavailable local adapter cannot permanently block confirmed release', async () => {
  const f = await fixture('held');
  vi.mocked(f.adapter.hasSession).mockImplementation(async (id) => {
    if (id === 'child') throw new Error('Adapter is unavailable');
    return f.running.has(id);
  });
  try {
    await f.service.dispatch({ type: 'stopSession', threadId: 'parent' });
    expect(f.store.pendingCascadeStops()).toEqual([
      expect.objectContaining({
        custody: 'unknown',
        reason: 'binding-unavailable',
      }),
    ]);
    const response = await f.app.request('/api/orchestration/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'releaseUnknownOwnedWork',
        threadId: 'parent',
        confirmation: 'child-process-may-still-be-running',
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(f.running.has('child')).toBe(true);
    expect(f.store.readSessionByThread('parent')).toBeUndefined();
    expect(f.stop).toHaveBeenCalledExactlyOnceWith('parent');
  } finally {
    await f.close();
  }
});

test('release closes a finished parent’s retained adapter before removing it', async () => {
  const f = await fixture('unknown');
  try {
    f.store.appendEvent({
      eventId: 'parent-finished',
      threadId: 'parent',
      sessionId: 'parent',
      provider: 'claude',
      method: 'session.exited',
      reason: 'completed',
      createdAt: '2026-01-01T00:00:00Z',
    });
    await f.service.maintainOwnedWork();
    const response = await f.app.request('/api/orchestration/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'releaseUnknownOwnedWork',
        threadId: 'parent',
        confirmation: 'child-process-may-still-be-running',
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(f.stop).toHaveBeenCalledExactlyOnceWith('parent');
    expect(f.store.readSessionByThread('parent')).toBeUndefined();
    expect(f.store.pendingCascadeStops()).toEqual([]);
  } finally {
    await f.close();
  }
});

test.each(
  (['prepared', 'invoking', 'indeterminate'] as const).flatMap((state) =>
    (['newer-peer-after-exit', 'peer-before-exit'] as const).flatMap((layout) =>
      [false, true].map((reversed) => ({ state, layout, reversed })),
    ),
  ),
)(
  'retained boundaries select the active peer: $state / $layout / reverse=$reversed',
  ({ state, layout, reversed }) => {
    const path = join(makeTempDir('cascade-boundaries-'), 'events.sqlite');
    const store = new EventStore(path, undefined, {
      exact: () => ({ pid: process.pid, start: 'self-birth' }),
      probe: (pid) => ({
        state: 'exact',
        identity: { pid, start: 'peer-birth' },
      }),
    });
    const db = new DatabaseSync(path);
    const at = '2026-01-01T00:00:00.000Z';
    const boundary = (
      id: string,
      boundaryState: string,
      owner: string,
      pid: number,
      birth: string,
      sequence: number,
    ) =>
      db
        .prepare(`INSERT INTO orchestration_turn_boundaries
            (boundary_id, thread_id, state, owner_id, owner_pid, owner_birth, owner_identity_kind, created_at, updated_at, purpose, created_sequence)
            VALUES (?, 'child', ?, ?, ?, ?, 'exact', ?, ?, 'turn', ?)`)
        .run(id, boundaryState, owner, pid, birth, at, at, sequence);
    try {
      for (const id of ['parent', 'child'])
        store.appendEvent({
          eventId: `${id}-start`,
          threadId: id,
          sessionId: id,
          provider: 'claude',
          method: 'session.started',
          createdAt: at,
          metadata:
            id === 'child'
              ? {
                  delegation: {
                    parentSessionId: 'parent',
                    parentConversationId: 'parent',
                  },
                  stationDelegationProvenance: 'caller-derived',
                }
              : {},
        });
      if (layout === 'newer-peer-after-exit')
        boundary(
          'old-local',
          'accepted',
          'old-local',
          process.pid,
          'self-birth',
          1,
        );
      else
        boundary('active-peer', state, 'peer-owner', 616161, 'peer-birth', 2);
      store.appendEvent({
        eventId: 'child-exit',
        threadId: 'child',
        sessionId: 'child',
        provider: 'claude',
        method: 'session.exited',
        reason: 'completed',
        createdAt: at,
      });
      if (layout === 'newer-peer-after-exit')
        boundary('active-peer', state, 'peer-owner', 616161, 'peer-birth', 4);
      store['db'].exec(
        `PRAGMA reverse_unordered_selects = ${reversed ? 'ON' : 'OFF'}`,
      );
      expect(
        store.cascadeStopOwner('child', false),
        `${layout}/${reversed}`,
      ).toMatchObject({
        custody: 'peer',
        owner: { pid: 616161, birth: 'peer-birth' },
      });
      store.appendEvent({
        eventId: 'parent-stop',
        threadId: 'parent',
        sessionId: 'parent',
        provider: 'claude',
        method: 'session.exited',
        reason: 'stopped',
        createdAt: at,
      });
      expect(store.pendingCascadeStops(), `${layout}/${reversed}`).toEqual([
        expect.objectContaining({ childId: 'child' }),
      ]);
      expect(() => store.deleteThread('parent')).toThrow(
        'pending ownership cleanup',
      );
      expect(store.completeCascadeStop('child', 'parent-stop')).toBe(false);
      expect(store.pendingCascadeStops()).toHaveLength(1);
    } finally {
      db.close();
      store.close();
    }
  },
);

test('terminal append never probes a process while holding the writer transaction', () => {
  let store: EventStore;
  const probedInTransaction: boolean[] = [];
  store = new EventStore(
    join(makeTempDir('cascade-probe-lock-'), 'events.sqlite'),
    undefined,
    {
      exact: () => ({ pid: process.pid, start: 'self-birth' }),
      probe: (pid) => {
        probedInTransaction.push(store['db'].isTransaction === true);
        return { state: 'exact', identity: { pid, start: 'peer-birth' } };
      },
    },
  );
  const at = '2026-01-01T00:00:00.000Z';
  try {
    for (const id of ['parent', 'child'])
      store.appendEvent({
        eventId: `${id}-start`,
        threadId: id,
        sessionId: id,
        provider: 'claude',
        method: 'session.started',
        createdAt: at,
        metadata:
          id === 'child'
            ? {
                delegation: {
                  parentSessionId: 'parent',
                  parentConversationId: 'parent',
                },
                stationDelegationProvenance: 'caller-derived',
              }
            : {},
      });
    store['db']
      .prepare(`INSERT INTO orchestration_turn_boundaries (boundary_id, thread_id, state, owner_id, owner_pid, owner_birth, owner_identity_kind, created_at, updated_at, purpose, created_sequence)
      VALUES ('active-peer', 'child', 'invoking', 'peer-owner', 616161, 'peer-birth', 'exact', ?, ?, 'turn', 2)`)
      .run(at, at);
    expect(store.cascadeStopOwner('child', false).custody).toBe('peer');
    expect(probedInTransaction).toEqual([false]);
    store.appendEvent({
      eventId: 'parent-stop',
      threadId: 'parent',
      sessionId: 'parent',
      provider: 'claude',
      method: 'session.exited',
      reason: 'stopped',
      createdAt: at,
    });
    expect(probedInTransaction).toEqual([false]);
    expect(store.pendingCascadeStops()).toHaveLength(1);
  } finally {
    store.close();
  }
});

test('release and remove requires confirmation, preserves the child, and survives reopen', async () => {
  const f = await fixture('unknown');
  try {
    await f.service.dispatch({ type: 'stopSession', threadId: 'parent' });
    const send = (body: unknown) =>
      f.app.request('/api/orchestration/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect(
      (await send({ type: 'releaseUnknownOwnedWork', threadId: 'parent' }))
        .status,
    ).toBe(400);
    expect(f.store.pendingCascadeStops()).toHaveLength(1);
    const response = await send({
      type: 'releaseUnknownOwnedWork',
      threadId: 'parent',
      confirmation: 'child-process-may-still-be-running',
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(f.store.readSessionByThread('parent')).toBeUndefined();
    expect(f.store.eventById('child', 'child-start')?.payload.method).toBe(
      'session.started',
    );
    expect(f.store.pendingCascadeStops()).toEqual([]);
    expect(f.stop).toHaveBeenCalledExactlyOnceWith('parent');
    expect(
      f.store['db']
        .prepare(
          'SELECT COUNT(*) AS count FROM orchestration_cancellation_fences WHERE thread_id = ?',
        )
        .get('child'),
    ).toEqual({ count: 1 });
    expect(
      f.store
        .sessionTurnBoundaryAuthority()
        .claim('child', '2026-01-01T00:01:00Z').kind,
    ).not.toBe('owner');
    const reopened = new EventStore(f.path);
    try {
      expect(reopened.ownedDescendantsBottomUp('parent')).toEqual([]);
      expect(reopened.pendingCascadeStops()).toEqual([]);
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});

test('release cannot discard a pending child whose owner is known', async () => {
  const f = await fixture('unknown');
  try {
    await f.service.dispatch({ type: 'stopSession', threadId: 'parent' });
    const intent = f.store.pendingCascadeStops()[0];
    f.store.recordCascadeStopCustody(
      intent.childId,
      intent.terminalId,
      'peer',
      'live-exact-boundary-owner',
    );
    expect(() =>
      f.store.deleteThread('parent', { releaseUnknownOwnedWork: true }),
    ).toThrow();
    expect(f.store.pendingCascadeStops()).toHaveLength(1);
    expect(f.store.readSessionByThread('parent')).toBeDefined();
  } finally {
    await f.close();
  }
});

test('corrupt interruption results cannot replay another child’s outcome', async () => {
  const f = await fixture('unknown');
  try {
    f.store['db']
      .prepare(
        'INSERT INTO orchestration_cascade_stop_results VALUES (?, ?, ?)',
      )
      .run(
        'child',
        'terminal',
        JSON.stringify({ outcome: 'no-active-turn', threadId: 'other-child' }),
      );
    expect(() =>
      f.store.readCascadeInterruptResult('child', 'terminal'),
    ).toThrow('different target');
  } finally {
    await f.close();
  }
});

test('a fence retained after release cannot hide a child’s own later cascade', async () => {
  const f = await fixture('unknown');
  const at = '2026-01-01T00:00:00Z';
  try {
    f.store.appendEvent({
      eventId: 'grand-start',
      threadId: 'grand',
      sessionId: 'grand',
      provider: 'claude',
      method: 'session.started',
      createdAt: at,
      metadata: {
        delegation: { parentSessionId: 'child', parentConversationId: 'child' },
        stationDelegationProvenance: 'caller-derived',
      },
    });
    await f.service.dispatch({ type: 'stopSession', threadId: 'parent' });
    await f.service.dispatch({
      type: 'releaseUnknownOwnedWork',
      threadId: 'parent',
      confirmation: 'child-process-may-still-be-running',
    });
    f.store.appendEvent({
      eventId: 'child-end-after-release',
      threadId: 'child',
      sessionId: 'child',
      provider: 'claude',
      method: 'session.exited',
      reason: 'completed',
      createdAt: at,
    });
    expect(f.store.pendingCascadeStops()).toEqual([
      expect.objectContaining({
        parentId: 'child',
        childId: 'grand',
        terminalId: 'child-end-after-release',
      }),
    ]);
  } finally {
    await f.close();
  }
});

test.each(['finished', 'self-finished'] as const)(
  'a parent Stop completes for a terminal unbound child: %s',
  async (mode) => {
    const f = await fixture(mode);
    try {
      await expect(
        f.service.dispatch({ type: 'stopSession', threadId: 'parent' }),
      ).resolves.toBeUndefined();
      expect(f.stop).toHaveBeenCalledExactlyOnceWith('parent');
      expect(f.store.pendingCascadeStops()).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

test.each([false, true])(
  'a terminal unbound child permits parent deletion, including pending cleanup: %s',
  async (pending) => {
    const f = await fixture(pending ? 'unknown' : 'finished');
    try {
      if (pending) {
        await f.service.dispatch({ type: 'stopSession', threadId: 'parent' });
        expect(f.store.pendingCascadeStops()).toHaveLength(1);
        f.store.appendEvent({
          eventId: 'child-exit',
          threadId: 'child',
          sessionId: 'child',
          provider: 'claude',
          method: 'session.exited',
          reason: 'completed',
          createdAt: '2026-01-01T00:00:04.000Z',
        });
      }
      expect(() => f.store.deleteThread('parent')).not.toThrow();
      expect(f.store.readSessionByThread('parent')).toBeUndefined();
      expect(f.store.eventById('child', 'child-exit')?.payload.method).toBe(
        'session.exited',
      );
    } finally {
      await f.close();
    }
  },
);

test.each(['unknown', 'self'] as const)(
  'unknown cleanup stays visible while the parent stops itself: %s',
  async (mode) => {
    const f = await fixture(mode);
    try {
      if (mode === 'self')
        expect(f.store.cascadeStopOwner('child', false).custody).toBe('local');
      await expect(
        f.service.dispatch({ type: 'stopSession', threadId: 'parent' }),
      ).resolves.toBeUndefined();
      expect(f.stop).toHaveBeenCalledExactlyOnceWith('parent');
      expect(f.store.pendingCascadeStops()).toEqual([
        expect.objectContaining({ childId: 'child' }),
      ]);
      const response = await f.app.request(
        '/api/orchestration/sessions/parent',
      );
      expect(response.status).toBe(200);
      const summary = await response.json();
      expect(summary).toMatchObject({
        data: {
          session: {
            ownedWork: {
              pendingStopCount: 1,
              pendingStops: [
                expect.objectContaining({ custody: 'unknown', count: 1 }),
              ],
              state: 'unknown',
            },
          },
        },
      });
      expect(() => f.store.deleteThread('parent')).toThrow(
        'pending ownership cleanup',
      );
    } finally {
      await f.close();
    }
  },
);

test.each([false, true])(
  'shutdown drains a pending cascade before adapter teardown, including retirement: %s',
  async (retiring) => {
    const f = await fixture('held');
    let entered!: () => void;
    const stopping = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.stop.mockImplementation(async (id) => {
      if (id === 'child') {
        entered();
        await gate;
      }
      f.running.delete(id);
    });
    let finishRetirement!: () => void;
    const retirement = new Promise<void>((resolve) => {
      finishRetirement = resolve;
    });
    const stopAll = vi.spyOn(f.adapter, 'stopAll');
    if (retiring) stopAll.mockImplementationOnce(() => retirement);
    const stop = f.service.dispatch({
      type: 'stopSession',
      threadId: 'parent',
    });
    let shutdown: Promise<void> | undefined;
    try {
      await stopping;
      if (retiring) {
        f.service['adapterRetirement'].retire(f.adapter);
        await vi.waitFor(() => expect(stopAll).toHaveBeenCalledOnce());
      }
      shutdown = f.service.shutdown();
      finishRetirement();
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopAll).toHaveBeenCalledTimes(retiring ? 1 : 0);
      release();
      await stop;
      await shutdown;
      expect(stopAll).toHaveBeenCalledOnce();
    } finally {
      release();
      finishRetirement();
      await stop;
      await shutdown;
      f.store.close();
    }
  },
);

test.each(['request', 'group'] as const)(
  'owned cancellation rechecks captured %s currency before its durable cascade',
  async (authority) => {
    const f = await fixture('held');
    let current = true;
    let firstGuardPassed = false;
    let faultApplied = false;
    const withdrawal = new Error('controlled group withdrawal');
    const targets = f.store.ownedStopTargets.bind(f.store);
    expect(targets('parent')).toContain('child');
    const lookup = vi
      .spyOn(f.store, 'ownedStopTargets')
      .mockImplementation((id) => {
        const result = targets(id);
        if (id === 'parent' && firstGuardPassed && !faultApplied) {
          expect(result).toContain('child');
          faultApplied = true;
          current = false;
        }
        return result;
      });
    try {
      await expect(
        f.service.dispatchWithReceipt(
          { type: 'interruptTurn', threadId: 'parent' },
          {
            userId: 'owner',
            requestCurrent: () => {
              firstGuardPassed = true;
              return authority === 'request' ? current : true;
            },
          },
          authority === 'group'
            ? {
                delegationGroupAdmission: {
                  signal: new AbortController().signal,
                  assertCurrent: () => {
                    if (!current) throw withdrawal;
                  },
                },
              }
            : undefined,
        ),
      ).rejects.toMatchObject({
        name: 'OrchestrationCommandDispatchError',
        message:
          authority === 'group'
            ? withdrawal.message
            : 'Request authority changed before interruption.',
        receipt: {
          commandType: 'interruptTurn',
          threadId: 'parent',
          status: 'failed',
        },
        receiptStatus: 'persisted',
      });
      expect(faultApplied).toBe(true);
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.store.pendingCascadeStops()).toEqual([]);
      expect(
        f.store
          .listEvents('parent')
          .some(
            ({ payload }) =>
              payload.method === 'session.cancellation-requested',
          ),
      ).toBe(false);
    } finally {
      lookup.mockRestore();
      await f.close();
    }
  },
);
