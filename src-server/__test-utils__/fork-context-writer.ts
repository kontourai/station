import { isSessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { createConversationRoutes } from '../routes/chat/conversations.js';
import { ConversationForkContextModule } from '../services/orchestration/conversation-fork-context.js';
import { EventStore } from '../services/orchestration/event-store.js';

type ForkWriter = NonNullable<Parameters<typeof createConversationRoutes>[12]>;

/** Real context persistence for route-only tests; no provider Session is fabricated. */
export function createForkContextWriter(
  path: string,
  observations: ForkWriter,
): { writer: ForkWriter; close(): void } {
  const store = new EventStore(path);
  const contexts = new ConversationForkContextModule({
    store: () => store,
    deduplicator: () => store.createTurnDeduplicator(),
    canRead: (reference, scope) =>
      isSessionReadAuthority(scope) &&
      reference.ownerUserId === scope.userId &&
      reference.tenantId === scope.tenantExecutionContext?.tenantId,
    canStart: () => false,
    canReadSession: () => false,
    runtimeMessages: () => [],
    metadata: () => undefined,
    nativeMemoryOwnsTranscript: () => false,
    requiresNativeIdentity: () => false,
  });
  const writer: ForkWriter = {
    ...observations,
    readConversationForkContextForRequest: (source, key, scope) =>
      contexts.forRequest(source, key, scope),
    reserveConversationForkContext: (snapshot, scope) =>
      contexts.reserve(snapshot, scope),
    readConversationForkContextSnapshot: (id, scope) =>
      contexts.snapshot(id, scope),
    publishConversationForkContext: (event, digest, scope) => {
      const published = contexts.publish(event, digest, scope);
      if (published) {
        if (observations.appendConversationForkIfAbsent)
          observations.appendConversationForkIfAbsent(event);
        else observations.appendConversationFork(event);
      }
      return published;
    },
  };
  return { writer, close: () => store.close() };
}
