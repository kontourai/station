/**
 * #3851 review F5: what a server restart would stop is every session with an
 * active turn, ephemeral ones included, which the session read model leaves
 * out. Real EventStore and OrchestrationService.
 */
import { join } from 'node:path';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const makeTempDir = trackTempDirs();
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function seed(
  store: EventStore,
  threadId: string,
  options: { ephemeral?: boolean; finished?: boolean },
) {
  const at = Date.now() - 60_000;
  const iso = (offset: number) => new Date(at + offset).toISOString();
  store.upsertSession({
    provider: 'claude',
    threadId,
    status: 'running',
    createdAt: iso(0),
    updatedAt: iso(1000),
    ...(options.ephemeral ? { ephemeral: true } : {}),
  } as never);
  store.appendEvent({
    eventId: `${threadId}:start`,
    provider: 'claude',
    threadId,
    createdAt: iso(0),
    method: 'session.started',
    sessionId: threadId,
    metadata: { userId: 'local-operator', agentSlug: 'claude' },
  } as never);
  store.appendEvent({
    eventId: `${threadId}:turn`,
    provider: 'claude',
    threadId,
    turnId: `${threadId}:t1`,
    createdAt: iso(500),
    method: 'turn.started',
    prompt: 'work',
  } as never);
  if (options.finished)
    store.appendEvent({
      eventId: `${threadId}:done`,
      provider: 'claude',
      threadId,
      turnId: `${threadId}:t1`,
      createdAt: iso(1000),
      method: 'turn.completed',
    } as never);
}

test('lists every session with an active turn, ephemeral ones included', async () => {
  const home = makeTempDir('station-active-turns-');
  const store = new EventStore(join(home, 'orchestration.sqlite'));
  stores.push(store);
  seed(store, 'chat', {});
  seed(store, 'webhook', { ephemeral: true });
  seed(store, 'finished', { finished: true });
  const service = new OrchestrationService({
    eventStore: store,
    adoptionLedger: store.createAdoptionLedger(),
    eventBus: new EventBus(),
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    logger: { debug() {}, warn() {} },
  } as never);
  service.initialize();
  // The runtime events as the service's publish path hands them to its
  // execution coordinator (publishCanonicalEvent is private).
  const coordinator = Reflect.get(service, 'sessionExecutionCoordinator') as {
    observe(event: unknown): void;
  };
  for (const threadId of ['chat', 'webhook', 'finished'])
    coordinator.observe({
      method: 'turn.started',
      threadId,
      turnId: `${threadId}:t1`,
    });
  coordinator.observe({
    method: 'turn.completed',
    threadId: 'finished',
    turnId: 'finished:t1',
  });
  const readModel = (
    await service.listSessionReadModel(INTERNAL_SESSION_READ_SCOPE)
  ).map((session) => session.threadId);
  // The control: the read model does not list the ephemeral session.
  expect(readModel).not.toContain('webhook');
  expect(service.listActiveTurnThreadIds().sort()).toEqual(['chat', 'webhook']);
});
