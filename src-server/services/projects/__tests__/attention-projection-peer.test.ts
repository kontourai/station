import { join } from 'node:path';
import type {
  NeedsInputAttentionItem,
  ReviewPendingAttentionItem,
} from '@kontourai/station-contracts/attention';
import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import { afterEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../../orchestration/event-bus.js';
import { EventStore } from '../../orchestration/event-store.js';
import { OrchestrationService } from '../../orchestration/orchestration-service.js';
import { createManualSessionTransitionEvent } from '../../orchestration/session-lifecycle-service.js';
import { AttentionProjectionService } from '../attention-projection.js';

/**
 * A delegated task running on a PAIRED Station is recorded here only as a
 * compact lifecycle record (`recordPeerDelegationActivityDispatch`, advanced
 * by `recordPeerDelegationActivityOutcome` from the peer's status endpoint).
 * When that record reaches `needs_input`, the attention item must say the
 * task is peer-hosted — its thread id cannot take a local turn — and must link
 * to the Activity detail rather than rehydrating a chat whose conversation id
 * is the peer's.
 *
 * The records are written by the REAL writers on a real event store and read
 * back through the real `listSessionReadModel`, so the item's
 * `environmentKind` is derived from what production persists, not from a
 * hand-shaped summary.
 */
// Created before the cleanup hook below, so it removes the directories
// after the stores in them have closed (after-hooks run in reverse order).
const makeTempDir = trackTempDirs();
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture() {
  const home = makeTempDir('station-attention-peer-');
  const store = new EventStore(join(home, 'orchestration.sqlite'));
  cleanups.push(() => {
    store.close();
  });
  // Answerability needs the record's provider registered, as it is in
  // production (Station's own agent adapter); nothing here executes it.
  const registered = new Set(['station-agent', 'claude']);
  const service = new OrchestrationService({
    eventStore: store,
    adoptionLedger: store.createAdoptionLedger(),
    eventBus: new EventBus(),
    adapterRegistry: {
      register() {},
      get: (provider: string) =>
        registered.has(provider) ? ({ provider } as never) : undefined,
      list: () => [],
    } as never,
    logger: { debug() {}, warn() {} },
  });
  cleanups.push(() => {
    service.shutdown();
  });
  const projection = new AttentionProjectionService(
    { list: () => [] } as never,
    service,
    { getRunConsole: async () => ({ gates: [] }) } as never,
  );
  return { service, projection };
}

test('a peer-hosted needs_input item names its paired Station and links to Activity', async () => {
  const { service, projection } = fixture();
  const threadId = service.recordPeerDelegationActivityDispatch({
    taskId: 'task:peer-attention',
    conversationId: 'task:peer-attention',
    prompt: 'Verify the release candidate',
    userId: 'default',
    projectSlug: 'campfit',
    environment: { id: 'environment-peer', name: 'Station B', kind: 'peer' },
    target: { kind: 'agent', id: 'codex' },
  });
  expect(
    service.recordPeerDelegationActivityOutcome({
      taskId: 'task:peer-attention',
      environmentId: 'environment-peer',
      status: 'needs_input',
    }),
  ).toBe(true);

  const { items } = await projection.list();
  const item = items.find(
    (candidate): candidate is NeedsInputAttentionItem =>
      candidate.kind === 'needs_input' &&
      candidate.source.threadId === threadId,
  );
  expect(item).toBeDefined();
  expect(item).toMatchObject({
    environmentKind: 'peer',
    environmentName: 'Station B',
    openHref: activityDeepLink({ sessionId: threadId }),
  });
  // The peer's request events never reach this Station: nothing here may
  // claim an exact local input request to answer.
  expect(item).not.toHaveProperty('inputReference');
});

test('a peer-hosted review_pending item is marked the same way and claims no request', async () => {
  const { service, projection } = fixture();
  const threadId = service.recordPeerDelegationActivityDispatch({
    taskId: 'task:peer-review',
    conversationId: 'task:peer-review',
    prompt: 'Review on the peer',
    userId: 'default',
    // No project: the Activity link must not depend on one.
    environment: { id: 'environment-peer', name: 'Station B', kind: 'peer' },
    target: { kind: 'agent', id: 'codex' },
  });
  expect(
    service.recordPeerDelegationActivityOutcome({
      taskId: 'task:peer-review',
      environmentId: 'environment-peer',
      status: 'review_pending',
    }),
  ).toBe(true);

  const { items } = await projection.list();
  const item = items.find(
    (candidate): candidate is ReviewPendingAttentionItem =>
      candidate.kind === 'review_pending' &&
      candidate.source.threadId === threadId,
  );
  expect(item).toMatchObject({
    environmentKind: 'peer',
    environmentName: 'Station B',
    openHref: activityDeepLink({ sessionId: threadId }),
  });
  expect(item).not.toHaveProperty('requestReference');
});

test('a local needs_input item carries no environment and keeps its chat link (control)', async () => {
  const { service, projection } = fixture();
  const threadId = 'thread-local-attention';
  // The same event shapes the peer writer persists, on a session this
  // Station runs: a `session.started` with no delegation environment, then
  // the contract-validated transition into `needs_input`.
  const publish = (
    service as unknown as { projectAndPublishEvent(event: unknown): void }
  ).projectAndPublishEvent.bind(service);
  publish({
    eventId: 'local-started',
    provider: 'claude',
    threadId,
    createdAt: new Date().toISOString(),
    method: 'session.started',
    sessionId: threadId,
    initialState: 'created',
    sessionState: 'running',
    transitionReason: 'session_started',
    transitionSource: 'runtime',
    metadata: { userId: 'default', projectSlug: 'campfit' },
  });
  publish(
    createManualSessionTransitionEvent({
      provider: 'claude',
      threadId,
      from: 'running',
      to: 'needs_input',
      reason: 'manual_update',
      source: 'system_recovery',
    }),
  );

  const { items } = await projection.list();
  const item = items.find(
    (candidate): candidate is NeedsInputAttentionItem =>
      candidate.kind === 'needs_input' &&
      candidate.source.threadId === threadId,
  );
  expect(item).toBeDefined();
  expect(item).not.toHaveProperty('environmentKind');
  expect(item).not.toHaveProperty('environmentName');
  expect(item?.openHref).toBe(`/projects/campfit?chat=${threadId}&dock=open`);
});
