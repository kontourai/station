import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { expect, test } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { awaitSessionRecoveryCompleted } from '../../../__test-utils__/session-runtime-barriers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createChildDelegationContext } from '../../../runtime/agents/delegation.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const makeTempDir = trackTempDirs();
function readEdges(path: string) {
  const db = new DatabaseSync(path);
  try {
    return db
      .prepare(
        'SELECT * FROM orchestration_session_ownership ORDER BY created_seq',
      )
      .all()
      .map((row) => ({
        childId: row.child_session_id,
        parentId: row.parent_session_id,
        binding: row.binding,
        createdSequence: row.created_seq,
        eventId: row.event_id,
        backgroundBoundary: row.background_boundary === 1,
      }));
  } finally {
    db.close();
  }
}

const at = '2026-01-01T00:00:00.000Z';
function start(
  threadId: string,
  metadata?: Record<string, unknown>,
): CanonicalRuntimeEvent {
  return {
    eventId: `${threadId}-started`,
    threadId,
    sessionId: threadId,
    provider: 'claude',
    method: 'session.started',
    createdAt: at,
    metadata,
  };
}

test('the start path strips a forged provenance but commits an internally derived exact edge', async () => {
  const root = makeTempDir('ownership-start-');
  const path = join(root, 'events.sqlite');
  const store = new EventStore(path);
  const adapter = new GateTestAdapter();
  const original = adapter.startSession.bind(adapter);
  adapter.startSession = async (input) => {
    const session = await original(input);
    adapter.events.push(start(input.threadId, input.metadata));
    return session;
  };
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventStore: store,
    eventBus: new EventBus(),
    logger: { debug() {}, warn() {} },
  });
  try {
    service.initialize();
    await awaitSessionRecoveryCompleted(service);
    store.appendEvent(start('parent'));
    const delegation = createChildDelegationContext({
      agentSlug: 'planner',
      conversationId: 'parent-conversation',
      sessionId: 'parent',
    });
    for (const trusted of [false, true]) {
      const threadId = trusted ? 'verified-child' : 'claimed-child';
      const outcome = await service.startSessionInternal(
        {
          type: 'start-session',
          input: {
            threadId,
            provider: 'claude',
            cwd: root,
            metadata: {
              delegation,
              stationDelegationProvenance: 'caller-derived',
            },
          },
        },
        {},
        trusted
          ? {
              delegationProvenance: {
                context: delegation,
                provenance: 'caller-derived',
              },
            }
          : {},
      );
      expect(outcome.status).toBe('accepted');
    }
    await expect.poll(() => readEdges(path).length).toBe(2);
    expect(
      readEdges(path).map(({ childId, parentId, binding }) => ({
        childId,
        parentId,
        binding,
      })),
    ).toEqual([
      {
        childId: 'claimed-child',
        parentId: 'parent-conversation',
        binding: 'claimed',
      },
      { childId: 'verified-child', parentId: 'parent', binding: 'verified' },
    ]);
  } finally {
    await service.shutdown();
    store.close();
  }
});

test('ownership shares the start append transaction and its allocated global sequence', () => {
  const path = join(makeTempDir('ownership-atomic-'), 'events.sqlite');
  const store = new EventStore(path);
  const db = new DatabaseSync(path);
  try {
    store.appendEvent(start('parent'));
    const delegation = {
      parentConversationId: 'conversation',
      parentSessionId: 'parent',
    };
    const event = start('child', {
      delegation,
      stationDelegationProvenance: 'caller-derived',
      backgroundBoundary: true,
    });
    db.exec(
      "CREATE TRIGGER fail_edge BEFORE INSERT ON orchestration_session_ownership BEGIN SELECT RAISE(ABORT, 'injected edge failure'); END",
    );
    expect(() => store.appendEvent(event)).toThrow('injected edge failure');
    expect(store.listEvents('child')).toEqual([]);
    expect(readEdges(path)).toEqual([]);
    db.exec('DROP TRIGGER fail_edge');
    store.appendEvent(event);
    expect(readEdges(path)).toEqual([
      {
        childId: 'child',
        parentId: 'parent',
        binding: 'verified',
        eventId: event.eventId,
        createdSequence: store.readGlobalSequence(event.eventId),
        backgroundBoundary: true,
      },
    ]);
  } finally {
    db.close();
    store.close();
  }
});

test('open reconstructs ownership from the naming index without promoting historical names', () => {
  const path = join(makeTempDir('ownership-migration-'), 'events.sqlite');
  const store = new EventStore(path);
  store.appendEvent(start('parent'));
  store.appendEvent(
    start('legacy', {
      parentConversationId: 'parent',
      stationDelegationProvenance: 'caller-derived',
    }),
  );
  store.appendEvent(
    start('exact', {
      delegation: {
        parentConversationId: 'conversation',
        parentSessionId: 'parent',
      },
      stationDelegationProvenance: 'caller-derived',
    }),
  );
  const expected = readEdges(path);
  store.close();
  const db = new DatabaseSync(path);
  db.exec('DELETE FROM orchestration_session_ownership');
  db.close();
  const reopened = new EventStore(path);
  try {
    expect(readEdges(path)).toEqual(expected);
    expect(
      expected.map(({ childId, binding }) => ({ childId, binding })),
    ).toEqual([
      { childId: 'legacy', binding: 'claimed' },
      { childId: 'exact', binding: 'verified' },
    ]);
  } finally {
    reopened.close();
  }
});

test('open derives the pending stop and admission fence from an unprojected legacy terminal', () => {
  const path = join(makeTempDir('cascade-open-'), 'events.sqlite');
  const store = new EventStore(path);
  store.appendEvent(start('parent'));
  store.appendEvent(
    start('child', {
      delegation: { parentSessionId: 'parent', parentConversationId: 'parent' },
      stationDelegationProvenance: 'caller-derived',
    }),
  );
  store.close();
  const terminal = {
    eventId: 'legacy-terminal',
    threadId: 'parent',
    sessionId: 'parent',
    provider: 'claude',
    method: 'session.exited',
    createdAt: at,
    reason: 'stopped',
  };
  const db = new DatabaseSync(path);
  db.prepare(`INSERT INTO orchestration_events (id, provider, thread_id, method, payload, created_at, sequence, global_sequence)
    VALUES (?, 'claude', 'parent', 'session.exited', ?, ?, 2, 3)`).run(
    terminal.eventId,
    JSON.stringify(terminal),
    at,
  );
  db.prepare(
    'UPDATE orchestration_stream_identity SET high_water = 3 WHERE singleton = 1',
  ).run();
  db.close();
  const reopened = new EventStore(path);
  try {
    expect(reopened.pendingCascadeStops()).toEqual([
      { parentId: 'parent', childId: 'child', terminalId: 'legacy-terminal' },
    ]);
    expect(
      reopened.sessionTurnBoundaryAuthority().claim('child', at).kind,
    ).toBe('unavailable');
  } finally {
    reopened.close();
  }
});

test('a child still in provider start is enrolled before cancellation and stopped when its adapter binds', async () => {
  const root = makeTempDir('cascade-starting-');
  const path = join(root, 'events.sqlite');
  const store = new EventStore(path);
  const engine = new GateTestAdapter();
  let entered!: () => void;
  const starting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  const attempts: string[] = [];
  const running = new Set(['parent']);
  const adapter: import('../../../providers/adapter-shape.js').ProviderAdapterShape =
    engine;
  adapter.stopSession = async (id) => {
    order.push(id);
    running.delete(id);
  };
  adapter.hasSession = async (id) => running.has(id);
  const original = engine.startSession.bind(engine);
  engine.startSession = async (input) => {
    attempts.push(input.threadId);
    entered();
    await gate;
    const session = await original(input);
    running.add(input.threadId);
    engine.events.push(start(input.threadId, input.metadata));
    return session;
  };
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventStore: store,
    eventBus: new EventBus(),
    logger: { debug() {}, warn() {} },
  });
  let child:
    | ReturnType<OrchestrationService['startSessionInternal']>
    | undefined;
  try {
    service.initialize();
    await awaitSessionRecoveryCompleted(service);
    store.appendEvent(start('parent'));
    service.seedSessionRecord({
      threadId: 'parent',
      provider: 'claude',
      status: 'running',
    });
    const delegation = createChildDelegationContext({
      agentSlug: 'planner',
      conversationId: 'parent',
      sessionId: 'parent',
    });
    child = service.startSessionInternal(
      {
        type: 'start-session',
        input: {
          provider: 'claude',
          threadId: 'child',
          cwd: root,
          metadata: { delegation },
        },
      },
      {},
      {
        delegationProvenance: {
          context: delegation,
          provenance: 'caller-derived',
        },
      },
    );
    await starting;
    await expect(
      service.dispatch({ type: 'stopSession', threadId: 'parent' }),
    ).rejects.toThrow('Owned Session stops remain pending');
    expect(order).toEqual([]);
    release();
    expect((await child).status).toBe('accepted');
    await expect.poll(() => order).toEqual(['child', 'parent']);
    expect(store.pendingCascadeStops()).toEqual([]);
    const late = await service.startSessionInternal(
      {
        type: 'start-session',
        input: {
          provider: 'claude',
          threadId: 'late-child',
          cwd: root,
          metadata: { delegation },
        },
      },
      {},
      {
        delegationProvenance: {
          context: delegation,
          provenance: 'caller-derived',
        },
      },
    );
    expect(late.status).not.toBe('accepted');
    expect(attempts).toEqual(['child']);
  } finally {
    release();
    await child;
    await service.shutdown();
    store.close();
  }
});
