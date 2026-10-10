import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';

const temp = trackTempDirs();
const now = '2026-10-07T20:00:00.000Z';

function session(store: EventStore, id: string) {
  store.upsertSession({
    threadId: id,
    provider: 'claude',
    status: 'ready',
    createdAt: now,
    updatedAt: now,
  });
}

describe('durable native ownership', () => {
  test('a reserved return fences both aliases until retirement; restart preserves the current owner', () => {
    const path = join(temp('native-session-owner-'), 'events.sqlite');
    let store = new EventStore(path);
    try {
      session(store, 'root');
      store.claimNativeSessionIdentity('native-private-identity', 'root');
      store.reserveNextConversationSession({
        conversationId: 'root',
        predecessorSessionId: 'root',
        proposedSessionId: 'other-engine',
        createdAt: now,
      });
      session(store, 'other-engine');
      store.reserveConversationHandoff({
        conversationId: 'root',
        predecessorSessionId: 'other-engine',
        sessionId: 'return',
        idempotencyKey: 'return-1',
        targetAgentId: 'claude',
        targetEnvironmentId: 'station',
        messageDigest: 'same-message',
        nativeReturnSourceSessionId: 'root',
        nativeReturnSourceEventId: 'root-completed',
        createdAt: now,
      });
      expect(() => store.assertNativeSessionMutable('root')).toThrow(
        'owned by another',
      );
      expect(store.nativeSessionReservedFor('root', 'return')).toBe(true);
      expect(store.nativeSessionReservedFor('root', 'unrelated')).toBe(false);
      expect(() =>
        store.claimNativeSessionIdentity('native-private-identity', 'return'),
      ).toThrow();
      expect(() => store.completeNativeReturnRetirement('return')).toThrow(
        'not confirmed',
      );
      store.recordNativeSessionRetired('root');
      store.completeNativeReturnRetirement('return');
      store.claimNativeSessionIdentity('native-private-identity', 'return');
      store.close();
      store = new EventStore(path);
      expect(() => store.assertNativeSessionMutable('root')).toThrow(
        'owned by another',
      );
      expect(() =>
        store.claimNativeSessionIdentity(
          'native-private-identity',
          'unrelated',
        ),
      ).toThrow('owned by another');
      expect(store.nativeSessionOwnedBy('return')).toBe(true);
      expect(store.nativeSessionReservedFor('root', 'return')).toBe(true);
      expect(store.nativeSessionReservedFor('root', 'unrelated')).toBe(false);
    } finally {
      store.close();
    }
  });

  test('an ordinary same-engine successor cannot claim a still-live source identity', () => {
    const store = new EventStore(
      join(temp('native-session-successor-'), 'events.sqlite'),
    );
    try {
      session(store, 'root');
      store.claimNativeSessionIdentity('native-private-identity', 'root');
      store.reserveNextConversationSession({
        conversationId: 'root',
        predecessorSessionId: 'root',
        proposedSessionId: 'successor',
        createdAt: now,
      });
      expect(() =>
        store.claimNativeSessionIdentity(
          'native-private-identity',
          'successor',
        ),
      ).toThrow('owned by another');
      store.recordNativeSessionRetired('root');
      store.claimNativeSessionIdentity('native-private-identity', 'successor');
      expect(() => store.assertNativeSessionMutable('root')).toThrow(
        'owned by another',
      );
      expect(() => store.assertNativeSessionMutable('successor')).not.toThrow();
      expect(() =>
        store.claimNativeSessionIdentity(
          'another-native-identity',
          'successor',
        ),
      ).toThrow('silently change');
    } finally {
      store.close();
    }
  });
});
