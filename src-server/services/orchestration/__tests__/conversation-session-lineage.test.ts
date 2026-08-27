import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ORCHESTRATION_EVENT_STORE_MIGRATION } from '../../../domain/migrations/003-orchestration-events.js';
import {
  ConversationSessionLineageConflictError,
  ConversationSessionLineageStructureError,
} from '../conversation-session-lineage.js';
import { EventStore } from '../event-store.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      get(...values: unknown[]): unknown;
      run(...values: unknown[]): { changes?: number };
      all(...values: unknown[]): unknown[];
    };
    close(): void;
  };
};

const directories: string[] = [];
function databasePath(): string {
  const directory = mkdtempSync(
    join(tmpdir(), 'conversation-session-lineage-'),
  );
  directories.push(directory);
  return join(directory, 'orchestration.sqlite');
}

function rows(path: string) {
  const database = new DatabaseSync(path);
  try {
    return database
      .prepare(
        `SELECT conversation_id, session_id, ordinal, predecessor_session_id,
                created_at
         FROM orchestration_conversation_sessions
         ORDER BY conversation_id, ordinal`,
      )
      .all();
  } finally {
    database.close();
  }
}

function providerCreatedAt(path: string, sessionId: string): string | null {
  const database = new DatabaseSync(path);
  try {
    const row = database
      .prepare(
        'SELECT created_at FROM provider_session_state WHERE thread_id = ?',
      )
      .get(sessionId) as { created_at?: string } | undefined;
    return row?.created_at ?? null;
  } finally {
    database.close();
  }
}

function seedLineage(
  path: string,
  input: {
    conversationId: string;
    sessionId: string;
    ordinal?: number;
    predecessorSessionId?: string;
    createdAt?: string;
  },
): void {
  const database = new DatabaseSync(path);
  try {
    database
      .prepare(
        `INSERT INTO orchestration_conversation_sessions
          (conversation_id, session_id, ordinal, predecessor_session_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.conversationId,
        input.sessionId,
        input.ordinal ?? 0,
        input.predecessorSessionId ?? null,
        input.createdAt ?? '2026-08-24T00:00:00.000Z',
      );
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('conversation/session lineage persistence', () => {
  test('cancels an unclaimed boundary atomically, keeps its audit marker, and permits a fresh reset', () => {
    const path = databasePath();
    const store = new EventStore(path);
    try {
      store.upsertSession({
        provider: 'claude',
        threadId: 'conversation-cancel',
        status: 'closed',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      });
      store.reserveConversationContextBoundary({
        boundaryId: 'boundary-cancel',
        conversationId: 'conversation-cancel',
        predecessorSessionId: 'conversation-cancel',
        successorSessionId: 'conversation-cancel:session:cancelled',
        idempotencyKey: 'cancel-key',
        policy: 'empty-next-cold-start',
        status: 'reserved',
        actorId: 'user-a',
        createdAt: '2026-08-25T00:01:00.000Z',
      });

      expect(
        store.cancelConversationContextBoundary(
          'boundary-cancel',
          '2026-08-25T00:02:00.000Z',
        ),
      ).toMatchObject({ status: 'cancelled' });
      expect(store.conversationSessions('conversation-cancel')).toEqual([
        expect.objectContaining({ sessionId: 'conversation-cancel' }),
      ]);
      expect(
        store.conversationContextBoundaryByKey(
          'conversation-cancel',
          'cancel-key',
        ),
      ).toMatchObject({
        status: 'cancelled',
        successorSessionId: 'conversation-cancel:session:cancelled',
      });

      expect(
        store.reserveConversationContextBoundary({
          boundaryId: 'boundary-fresh',
          conversationId: 'conversation-cancel',
          predecessorSessionId: 'conversation-cancel',
          successorSessionId: 'conversation-cancel:session:fresh',
          idempotencyKey: 'fresh-key',
          policy: 'continue-from-history',
          status: 'reserved',
          actorId: 'user-a',
          createdAt: '2026-08-25T00:03:00.000Z',
        }).marker,
      ).toMatchObject({
        successorSessionId: 'conversation-cancel:session:fresh',
      });
    } finally {
      store.close();
    }
  });

  test('never cancels a claimed or materialized context-boundary child', () => {
    const path = databasePath();
    const store = new EventStore(path);
    try {
      store.upsertSession({
        provider: 'claude',
        threadId: 'conversation-claimed',
        status: 'closed',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      });
      store.reserveConversationContextBoundary({
        boundaryId: 'boundary-claimed',
        conversationId: 'conversation-claimed',
        predecessorSessionId: 'conversation-claimed',
        successorSessionId: 'conversation-claimed:session:next',
        idempotencyKey: 'claimed-key',
        policy: 'empty-next-cold-start',
        status: 'reserved',
        actorId: 'user-a',
        createdAt: '2026-08-25T00:01:00.000Z',
      });
      store.claimConversationContextBoundaryColdStart(
        'boundary-claimed',
        'start-command',
        '2026-08-25T00:02:00.000Z',
      );
      expect(() =>
        store.cancelConversationContextBoundary(
          'boundary-claimed',
          '2026-08-25T00:03:00.000Z',
        ),
      ).toThrow('not_claimable');
      expect(store.conversationSessions('conversation-claimed')).toHaveLength(
        2,
      );
    } finally {
      store.close();
    }
  });

  test.each(['empty-next-cold-start', 'continue-from-history'] as const)(
    '%s boundary and handoff compose onto one successor session',
    (policy) => {
      const path = databasePath();
      const store = new EventStore(path);
      try {
        store.upsertSession({
          provider: 'claude',
          threadId: `conversation-compose-${policy}`,
          status: 'closed',
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        });
        const successor = `conversation-compose-${policy}:session:next`;
        store.reserveConversationContextBoundary({
          boundaryId: `boundary-${policy}`,
          conversationId: `conversation-compose-${policy}`,
          predecessorSessionId: `conversation-compose-${policy}`,
          successorSessionId: successor,
          idempotencyKey: `boundary-${policy}`,
          policy,
          status: 'reserved',
          actorId: 'user-a',
          createdAt: '2026-08-25T00:01:00.000Z',
        });
        const handoff = store.reserveConversationHandoff({
          conversationId: `conversation-compose-${policy}`,
          predecessorSessionId: `conversation-compose-${policy}`,
          sessionId: successor,
          idempotencyKey: `handoff-${policy}`,
          messageDigest: 'handoff-message',
          targetAgentId: 'codex',
          targetEnvironmentId: 'environment-a',
          createdAt: '2026-08-25T00:02:00.000Z',
        });
        expect(handoff.marker.sessionId).toBe(successor);
        expect(
          store.conversationSessions(`conversation-compose-${policy}`),
        ).toHaveLength(2);
      } finally {
        store.close();
      }
    },
  );

  test('reconciles a claimed context boundary only from its exact durable start receipt', () => {
    const path = databasePath();
    const store = new EventStore(path);
    try {
      store.upsertSession({
        provider: 'claude',
        threadId: 'conversation-boundary',
        status: 'closed',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      });
      store.reserveConversationContextBoundary({
        boundaryId: 'boundary-receipt',
        conversationId: 'conversation-boundary',
        predecessorSessionId: 'conversation-boundary',
        successorSessionId: 'conversation-boundary:session:empty',
        idempotencyKey: 'boundary-key',
        policy: 'empty-next-cold-start',
        status: 'reserved',
        actorId: 'user-a',
        createdAt: '2026-08-25T00:01:00.000Z',
      });
      store.claimConversationContextBoundaryColdStart(
        'boundary-receipt',
        'start-command-a',
        '2026-08-25T00:02:00.000Z',
      );
      store.appendCommandReceipt({
        commandId: 'start-command-a',
        threadId: 'conversation-boundary:session:empty',
        commandType: 'startSession',
        status: 'accepted',
        createdAt: '2026-08-25T00:02:00.000Z',
      });
    } finally {
      store.close();
    }
    const reopened = new EventStore(path);
    try {
      expect(
        reopened.conversationContextBoundaryByKey(
          'conversation-boundary',
          'boundary-key',
        ),
      ).toMatchObject({
        status: 'consumed',
        startCommandId: 'start-command-a',
      });
    } finally {
      reopened.close();
    }
  });

  test('releases a provably unstarted claim and fences mismatched durable receipt evidence', () => {
    const path = databasePath();
    const store = new EventStore(path);
    try {
      for (const id of ['unstarted', 'ambiguous']) {
        store.upsertSession({
          provider: 'claude',
          threadId: `conversation-${id}`,
          status: 'closed',
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        });
        store.reserveConversationContextBoundary({
          boundaryId: `boundary-${id}`,
          conversationId: `conversation-${id}`,
          predecessorSessionId: `conversation-${id}`,
          successorSessionId: `conversation-${id}:session:next`,
          idempotencyKey: `key-${id}`,
          policy: 'empty-next-cold-start',
          status: 'reserved',
          actorId: 'user-a',
          createdAt: '2026-08-25T00:01:00.000Z',
        });
        store.claimConversationContextBoundaryColdStart(
          `boundary-${id}`,
          `command-${id}`,
          '2026-08-25T00:02:00.000Z',
        );
      }
      store.appendCommandReceipt({
        commandId: 'command-ambiguous',
        threadId: 'wrong-session',
        commandType: 'startSession',
        status: 'accepted',
        createdAt: '2026-08-25T00:02:00.000Z',
      });
    } finally {
      store.close();
    }
    const reopened = new EventStore(path);
    try {
      expect(
        reopened.conversationContextBoundaryByKey(
          'conversation-unstarted',
          'key-unstarted',
        ),
      ).toMatchObject({ status: 'failed' });
      expect(
        reopened.conversationContextBoundaryByKey(
          'conversation-ambiguous',
          'key-ambiguous',
        ),
      ).toMatchObject({ status: 'indeterminate' });
    } finally {
      reopened.close();
    }
  });

  test('atomically reserves one explicit handoff child and refuses an idempotency key retarget', () => {
    const path = databasePath();
    const store = new EventStore(path);
    try {
      store.upsertSession({
        provider: 'claude',
        threadId: 'conversation-a',
        status: 'closed',
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      });
      const first = store.reserveConversationHandoff({
        conversationId: 'conversation-a',
        predecessorSessionId: 'conversation-a',
        sessionId: 'conversation-a:session:codex',
        idempotencyKey: 'handoff-1',
        messageDigest: 'message-a',
        targetAgentId: 'codex',
        targetEnvironmentId: 'environment-a',
        targetConnectionId: 'codex',
        createdAt: '2026-08-24T00:01:00.000Z',
      });
      expect(first.outcome).toBe('created');
      expect(store.conversationSessions('conversation-a')).toMatchObject([
        { sessionId: 'conversation-a', ordinal: 0 },
        {
          sessionId: 'conversation-a:session:codex',
          ordinal: 1,
          predecessorSessionId: 'conversation-a',
        },
      ]);
      expect(
        store.conversationHandoffForSession('conversation-a:session:codex'),
      ).toMatchObject({ targetAgentId: 'codex' });
      expect(() =>
        store.reserveConversationHandoff({
          conversationId: 'conversation-a',
          predecessorSessionId: 'conversation-a',
          sessionId: 'conversation-a:session:claude',
          idempotencyKey: 'handoff-1',
          messageDigest: 'message-a',
          targetAgentId: 'claude',
          targetEnvironmentId: 'environment-a',
          createdAt: '2026-08-24T00:01:00.000Z',
        }),
      ).toThrow('idempotency key already names a different target');
      expect(store.conversationSessions('conversation-a')).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  test('fresh homes establish exactly one initial execution session without changing the session record', () => {
    const path = databasePath();
    const store = new EventStore(path);
    try {
      store.upsertSession({
        provider: 'codex',
        threadId: 'conversation-1',
        status: 'ready',
        cwd: '/workspace/station',
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:01.000Z',
      });
      expect(store.readSessionByThread('conversation-1')).toMatchObject({
        threadId: 'conversation-1',
        cwd: '/workspace/station',
        status: 'ready',
      });
      expect(rows(path)).toEqual([
        {
          conversation_id: 'conversation-1',
          session_id: 'conversation-1',
          ordinal: 0,
          predecessor_session_id: null,
          created_at: '2026-08-24T00:00:00.000Z',
        },
      ]);
    } finally {
      store.close();
    }
  });

  test('backfills a legacy event store without rewriting provider sessions or events, and reruns idempotently', () => {
    const path = databasePath();
    const legacy = new DatabaseSync(path);
    legacy.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
    legacy
      .prepare(
        `INSERT INTO provider_session_state
          (thread_id, provider, status, cwd, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-conversation',
        'claude',
        'closed',
        '/workspace/legacy',
        '2026-08-20T00:00:00.000Z',
        '2026-08-21T00:00:00.000Z',
      );
    legacy
      .prepare(
        `INSERT INTO orchestration_conversation_history
          (thread_id, message_count, created_at, updated_at)
         VALUES (?, 0, ?, ?)`,
      )
      .run(
        'history-without-session',
        '2026-08-20T00:00:00.000Z',
        '2026-08-21T00:00:00.000Z',
      );
    legacy
      .prepare(
        `INSERT INTO orchestration_events
          (id, provider, thread_id, method, payload, created_at, sequence, global_sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-event',
        'claude',
        'legacy-conversation',
        'turn.started',
        '{"preserved":true}',
        '2026-08-20T00:00:00.000Z',
        1,
        1,
      );
    legacy.close();

    const upgraded = new EventStore(path);
    upgraded.close();
    const rerun = new EventStore(path);
    try {
      expect(rows(path)).toEqual([
        {
          conversation_id: 'legacy-conversation',
          session_id: 'legacy-conversation',
          ordinal: 0,
          predecessor_session_id: null,
          created_at: '2026-08-20T00:00:00.000Z',
        },
      ]);
      const verify = new DatabaseSync(path);
      try {
        expect(
          verify
            .prepare(
              'SELECT cwd, status FROM provider_session_state WHERE thread_id = ?',
            )
            .get('legacy-conversation'),
        ).toEqual({ cwd: '/workspace/legacy', status: 'closed' });
        expect(
          verify
            .prepare(
              'SELECT payload, sequence, global_sequence FROM orchestration_events WHERE id = ?',
            )
            .get('legacy-event'),
        ).toEqual({
          payload: '{"preserved":true}',
          sequence: 1,
          global_sequence: 1,
        });
        expect(
          verify
            .prepare(
              'SELECT thread_id FROM orchestration_conversation_history WHERE thread_id = ?',
            )
            .get('history-without-session'),
        ).toEqual({ thread_id: 'history-without-session' });
      } finally {
        verify.close();
      }
    } finally {
      rerun.close();
    }
  });

  test('two EventStore instances contend safely for the same initial mapping', () => {
    const path = databasePath();
    const first = new EventStore(path);
    const second = new EventStore(path);
    try {
      const session = {
        provider: 'codex' as const,
        threadId: 'shared-conversation',
        status: 'ready' as const,
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:01.000Z',
      };
      first.upsertSession(session);
      second.upsertSession(session);
      expect(rows(path)).toEqual([
        {
          conversation_id: 'shared-conversation',
          session_id: 'shared-conversation',
          ordinal: 0,
          predecessor_session_id: null,
          created_at: '2026-08-24T00:00:00.000Z',
        },
      ]);
    } finally {
      first.close();
      second.close();
    }
  });

  test('rejects claiming one execution session for a different conversation', () => {
    const path = databasePath();
    const store = new EventStore(path);
    try {
      seedLineage(path, {
        conversationId: 'original-conversation',
        sessionId: 'shared-session',
      });
      let conflict: unknown;
      try {
        store.upsertSession({
          provider: 'codex',
          threadId: 'shared-session',
          status: 'ready',
          createdAt: '2026-08-24T00:00:00.000Z',
          updatedAt: '2026-08-24T00:00:01.000Z',
        });
      } catch (error) {
        conflict = error;
      }
      expect(conflict).toBeInstanceOf(ConversationSessionLineageConflictError);
      expect(conflict).toMatchObject({ reason: 'session-already-linked' });
      expect(store.readSessionByThread('shared-session')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test('rejects assigning a second execution session to an occupied ordinal', () => {
    const path = databasePath();
    const store = new EventStore(path);
    try {
      seedLineage(path, {
        conversationId: 'ordinal-conversation',
        sessionId: 'existing-session',
      });
      let conflict: unknown;
      try {
        store.upsertSession({
          provider: 'codex',
          threadId: 'ordinal-conversation',
          status: 'ready',
          createdAt: '2026-08-24T00:00:00.000Z',
          updatedAt: '2026-08-24T00:00:01.000Z',
        });
      } catch (error) {
        conflict = error;
      }
      expect(conflict).toBeInstanceOf(ConversationSessionLineageConflictError);
      expect(conflict).toMatchObject({ reason: 'ordinal-already-linked' });
      expect(store.readSessionByThread('ordinal-conversation')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test('rejects an idempotent-looking replay when an immutable timestamp changed', () => {
    const path = databasePath();
    const store = new EventStore(path);
    try {
      seedLineage(path, {
        conversationId: 'immutable-conversation',
        sessionId: 'immutable-conversation',
        createdAt: '2026-08-23T00:00:00.000Z',
      });
      let conflict: unknown;
      try {
        store.upsertSession({
          provider: 'codex',
          threadId: 'immutable-conversation',
          status: 'ready',
          createdAt: '2026-08-24T00:00:00.000Z',
          updatedAt: '2026-08-24T00:00:01.000Z',
        });
      } catch (error) {
        conflict = error;
      }
      expect(conflict).toBeInstanceOf(ConversationSessionLineageConflictError);
      expect(conflict).toMatchObject({ reason: 'immutable-facts-mismatch' });
      expect(
        store.readSessionByThread('immutable-conversation'),
      ).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test('atomically reserves one child execution session for a completed conversation', () => {
    const path = databasePath();
    const store = new EventStore(path);
    try {
      store.upsertSession({
        provider: 'codex',
        threadId: 'conversation-1',
        status: 'closed',
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:01.000Z',
      });
      const first = store.reserveNextConversationSession({
        conversationId: 'conversation-1',
        predecessorSessionId: 'conversation-1',
        proposedSessionId: 'conversation-1:session:first',
        createdAt: '2026-08-24T00:00:02.000Z',
      });
      const concurrent = store.reserveNextConversationSession({
        conversationId: 'conversation-1',
        predecessorSessionId: 'conversation-1',
        proposedSessionId: 'conversation-1:session:competing',
        createdAt: '2026-08-24T00:00:03.000Z',
      });
      expect(first.outcome).toBe('created');
      expect(concurrent).toMatchObject({
        outcome: 'existing',
        lineage: first.lineage,
      });
      expect(first.lineage).toMatchObject({
        conversationId: 'conversation-1',
        sessionId: 'conversation-1:session:first',
        ordinal: 1,
        predecessorSessionId: 'conversation-1',
      });

      // A provider start for the reserved child must not rewrite it as a
      // second root conversation or reject the already-reserved lineage.
      store.upsertSession({
        provider: 'codex',
        threadId: first.lineage.sessionId,
        status: 'ready',
        createdAt: first.lineage.createdAt,
        updatedAt: '2026-08-24T00:00:04.000Z',
      });
      expect(store.conversationSessions('conversation-1')).toEqual([
        {
          conversationId: 'conversation-1',
          sessionId: 'conversation-1',
          ordinal: 0,
          createdAt: '2026-08-24T00:00:00.000Z',
        },
        first.lineage,
      ]);
      expect(store.readSessionByThread(first.lineage.sessionId)?.status).toBe(
        'ready',
      );

      store.markSessionClosed(first.lineage.sessionId, 'codex');
      expect(store.readSessionByThread(first.lineage.sessionId)?.status).toBe(
        'closed',
      );
      expect(store.conversationSessions('conversation-1')).toEqual([
        {
          conversationId: 'conversation-1',
          sessionId: 'conversation-1',
          ordinal: 0,
          createdAt: '2026-08-24T00:00:00.000Z',
        },
        first.lineage,
      ]);
    } finally {
      store.close();
    }
  });

  test('reopens a persisted child lineage without re-rooting the child', () => {
    const path = databasePath();
    let store = new EventStore(path);
    store.upsertSession({
      provider: 'codex',
      threadId: 'restart-conversation',
      status: 'closed',
      createdAt: '2026-08-24T01:00:00.000Z',
      updatedAt: '2026-08-24T01:00:01.000Z',
    });
    const child = store.reserveNextConversationSession({
      conversationId: 'restart-conversation',
      predecessorSessionId: 'restart-conversation',
      proposedSessionId: 'restart-conversation:session:1',
      createdAt: '2026-08-24T01:00:02.000Z',
    });
    store.upsertSession({
      provider: 'codex',
      threadId: child.lineage.sessionId,
      status: 'closed',
      createdAt: child.lineage.createdAt,
      updatedAt: '2026-08-24T01:00:03.000Z',
    });
    store.close();

    store = new EventStore(path);
    try {
      expect(store.conversationSessions('restart-conversation')).toEqual([
        {
          conversationId: 'restart-conversation',
          sessionId: 'restart-conversation',
          ordinal: 0,
          createdAt: '2026-08-24T01:00:00.000Z',
        },
        child.lineage,
      ]);
      expect(store.conversationSessions(child.lineage.sessionId)).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('upgrades one pre-fix child timestamp skew once and reopens idempotently', () => {
    const path = databasePath();
    let store = new EventStore(path);
    store.upsertSession({
      provider: 'codex',
      threadId: 'legacy-child-conversation',
      status: 'closed',
      createdAt: '2026-08-24T01:30:00.000Z',
      updatedAt: '2026-08-24T01:30:01.000Z',
    });
    const child = store.reserveNextConversationSession({
      conversationId: 'legacy-child-conversation',
      predecessorSessionId: 'legacy-child-conversation',
      proposedSessionId: 'legacy-child-conversation:session:1',
      createdAt: '2026-08-24T01:30:02.000Z',
    });
    store.upsertSession({
      provider: 'codex',
      threadId: child.lineage.sessionId,
      status: 'closed',
      createdAt: child.lineage.createdAt,
      updatedAt: '2026-08-24T01:30:03.000Z',
    });
    store.close();
    const database = new DatabaseSync(path);
    database
      .prepare(
        'UPDATE provider_session_state SET created_at = ? WHERE thread_id = ?',
      )
      .run('2026-08-24T01:30:02.500Z', child.lineage.sessionId);
    database.close();

    store = new EventStore(path);
    expect(store.conversationSessions('legacy-child-conversation')).toEqual([
      expect.objectContaining({ sessionId: 'legacy-child-conversation' }),
      child.lineage,
    ]);
    store.close();
    expect(providerCreatedAt(path, child.lineage.sessionId)).toBe(
      child.lineage.createdAt,
    );

    store = new EventStore(path);
    expect(providerCreatedAt(path, child.lineage.sessionId)).toBe(
      child.lineage.createdAt,
    );
    store.close();
  });

  test('fails restart when provider and immutable lineage creation facts diverge', () => {
    const path = databasePath();
    const store = new EventStore(path);
    store.upsertSession({
      provider: 'codex',
      threadId: 'tampered-created-at',
      status: 'ready',
      createdAt: '2026-08-24T02:00:00.000Z',
      updatedAt: '2026-08-24T02:00:01.000Z',
    });
    store.close();
    const database = new DatabaseSync(path);
    database
      .prepare(
        `UPDATE orchestration_conversation_sessions
         SET created_at = ? WHERE session_id = ?`,
      )
      .run('2026-08-24T02:00:09.000Z', 'tampered-created-at');
    database.close();

    expect(() => new EventStore(path)).toThrowError(
      expect.objectContaining({
        name: 'ConversationSessionLineageConflictError',
        reason: 'immutable-facts-mismatch',
      }),
    );
  });

  test('fails restart when a provider child no longer maps to its recorded conversation', () => {
    const path = databasePath();
    const store = new EventStore(path);
    store.upsertSession({
      provider: 'codex',
      threadId: 'mapped-conversation',
      status: 'closed',
      createdAt: '2026-08-24T02:20:00.000Z',
      updatedAt: '2026-08-24T02:20:01.000Z',
    });
    const child = store.reserveNextConversationSession({
      conversationId: 'mapped-conversation',
      predecessorSessionId: 'mapped-conversation',
      proposedSessionId: 'mapped-conversation:session:1',
      createdAt: '2026-08-24T02:20:02.000Z',
    });
    store.upsertSession({
      provider: 'codex',
      threadId: child.lineage.sessionId,
      status: 'closed',
      createdAt: child.lineage.createdAt,
      updatedAt: '2026-08-24T02:20:03.000Z',
    });
    store.appendEvent({
      eventId: 'mapped-child-configured',
      provider: 'codex',
      threadId: child.lineage.sessionId,
      sessionId: child.lineage.sessionId,
      method: 'session.configured',
      createdAt: '2026-08-24T02:20:02.500Z',
      metadata: { conversationId: 'mapped-conversation' },
    });
    store.close();
    const database = new DatabaseSync(path);
    database
      .prepare(
        'DELETE FROM orchestration_conversation_sessions WHERE session_id = ?',
      )
      .run(child.lineage.sessionId);
    database.close();

    expect(() => new EventStore(path)).toThrowError(
      expect.objectContaining({
        name: 'ConversationSessionLineageStructureError',
        reason: 'provider-session-unmapped',
      }),
    );
  });

  test.each([
    {
      label: 'invalid root',
      reason: 'invalid-root',
      rows: [
        {
          conversationId: 'root-conversation',
          sessionId: 'not-the-root-conversation',
          ordinal: 0,
        },
      ],
    },
    {
      label: 'forged conversation',
      reason: 'conversation-mismatch',
      rows: [
        {
          conversationId: 'conversation-b',
          sessionId: 'conversation-b',
          ordinal: 0,
        },
        {
          conversationId: 'conversation-a',
          sessionId: 'conversation-a:session:1',
          ordinal: 1,
          predecessorSessionId: 'conversation-b',
        },
      ],
    },
    {
      label: 'missing parent',
      reason: 'missing-predecessor',
      rows: [
        {
          conversationId: 'missing-parent',
          sessionId: 'missing-parent:session:1',
          ordinal: 1,
          predecessorSessionId: 'never-recorded',
        },
      ],
    },
    {
      label: 'wrong ordinal',
      reason: 'ordinal-mismatch',
      rows: [
        {
          conversationId: 'wrong-ordinal',
          sessionId: 'wrong-ordinal',
          ordinal: 0,
        },
        {
          conversationId: 'wrong-ordinal',
          sessionId: 'wrong-ordinal:session:2',
          ordinal: 2,
          predecessorSessionId: 'wrong-ordinal',
        },
      ],
    },
    {
      label: 'cycle',
      reason: 'cycle',
      rows: [
        {
          conversationId: 'cycle',
          sessionId: 'cycle',
          ordinal: 0,
        },
        {
          conversationId: 'cycle',
          sessionId: 'cycle:session:1',
          ordinal: 1,
          predecessorSessionId: 'cycle:session:2',
        },
        {
          conversationId: 'cycle',
          sessionId: 'cycle:session:2',
          ordinal: 2,
          predecessorSessionId: 'cycle:session:1',
        },
      ],
    },
  ])(
    'fails restart with a typed $label lineage conflict',
    ({ rows, reason }) => {
      const path = databasePath();
      new EventStore(path).close();
      for (const lineage of rows) seedLineage(path, lineage);

      let conflict: unknown;
      try {
        new EventStore(path).close();
      } catch (error) {
        conflict = error;
      }
      expect(conflict).toBeInstanceOf(ConversationSessionLineageStructureError);
      expect(conflict).toMatchObject({ reason });
    },
  );
});
