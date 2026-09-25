import { join } from 'node:path';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const makeTempDir = trackTempDirs();

function session(store: EventStore, threadId: string, userId: string) {
  store.upsertSession({
    provider: 'claude',
    threadId,
    status: 'closed',
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:01.000Z',
  });
  store.appendEvent({
    eventId: `${threadId}:start`,
    threadId,
    sessionId: threadId,
    provider: 'claude',
    method: 'session.started',
    createdAt: '2026-09-24T00:00:00.000Z',
    metadata: { userId },
  });
}

function fixture(childOwner: string) {
  const directory = makeTempDir('conversation-read-');
  const store = new EventStore(join(directory, 'orchestration.sqlite'));
  session(store, 'root', 'owner');
  store.reserveNextConversationSession({
    conversationId: 'root',
    predecessorSessionId: 'root',
    proposedSessionId: 'root:child',
    createdAt: '2026-09-24T00:00:02.000Z',
  });
  session(store, 'root:child', childOwner);
  const service = new OrchestrationService({
    eventStore: store,
    eventBus: new EventBus(),
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    logger: { debug() {}, warn() {} },
  } as never);
  service.initialize();
  return { service, store };
}

const as = (userId: string) =>
  sessionReadAuthorityFromRequest(userId, undefined, undefined);

describe('who may read a conversation (linked pull requests)', () => {
  test('the owner of every Session in the lineage reads the conversation', () => {
    const { service, store } = fixture('owner');
    expect(service.canUserReadConversation('root', as('owner'))).toBe(true);
    expect(service.canUserReadConversation('root', as('stranger'))).toBe(false);
    store.close();
  });

  test('one lineage Session owned by someone else refuses the whole conversation', () => {
    // The transcript read's rule (readConversationEventWindow): no partial
    // lineage disclosure.
    const { service, store } = fixture('someone-else');
    expect(service.canUserReadConversation('root', as('owner'))).toBe(false);
    store.close();
  });

  test('a child Session id is not a conversation id', () => {
    const { service, store } = fixture('owner');
    expect(service.canUserReadConversation('root:child', as('owner'))).toBe(
      false,
    );
    store.close();
  });
});
