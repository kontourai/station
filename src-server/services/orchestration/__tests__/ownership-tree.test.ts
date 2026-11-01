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
  const store = new EventStore(join(root, 'events.sqlite'));
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
    await expect.poll(() => store.sessionOwnershipEdges().length).toBe(2);
    expect(
      store.sessionOwnershipEdges().map(({ childId, parentId, binding }) => ({
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
    expect(store.sessionOwnershipEdges()).toEqual([]);
    db.exec('DROP TRIGGER fail_edge');
    store.appendEvent(event);
    expect(store.sessionOwnershipEdges()).toEqual([
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
  const expected = store.sessionOwnershipEdges();
  store.close();
  const db = new DatabaseSync(path);
  db.exec('DELETE FROM orchestration_session_ownership');
  db.close();
  const reopened = new EventStore(path);
  try {
    expect(reopened.sessionOwnershipEdges()).toEqual(expected);
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
