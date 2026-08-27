import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type HostedTenantRegistry,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConversationHistoryReadService } from '../conversation-history-read-service.js';
import { EventStore } from '../event-store.js';

function readServiceOptions(eventStore: EventStore) {
  return {
    eventStore,
    canReadSession: vi.fn(() => true),
    hydratePersistedSession: (threadId: string) =>
      eventStore.readSessionByThread(threadId),
    loadedSessionForThread: () => undefined,
    observeAnswerability: () => ({
      threadAttachment: 'detached' as const,
      providerRegistered: true,
      observedBy: 'test',
      observedAt: '2026-08-08T12:00:00.000Z',
    }),
    ownerlessPersonalAccess: false,
  };
}

const hostedRegistry: HostedTenantRegistry = {
  schemaVersion: 1,
  tenants: [
    { id: 'alpha' as any, authority: 'alpha.test' },
    { id: 'bravo' as any, authority: 'bravo.test' },
  ],
  authorityToTenant: {
    'alpha.test': 'alpha' as any,
    'bravo.test': 'bravo' as any,
  },
};

describe('ConversationHistoryReadService', () => {
  let directory: string;
  let eventStore: EventStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'conversation-history-read-'));
    eventStore = new EventStore(join(directory, 'orchestration.sqlite'));
  });

  afterEach(() => {
    eventStore.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test('excludes pre-ownership records in hosted mode and records their durable quarantine during the completed history upgrade', () => {
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-unbound',
      status: 'ready',
      tenantExecutionContext: { tenantId: 'alpha' as any, source: 'session' },
      createdAt: '2026-08-08T12:00:00.000Z',
      updatedAt: '2026-08-08T12:00:00.000Z',
    });
    eventStore.appendEvent({
      eventId: 'thread-unbound-started',
      provider: 'claude',
      threadId: 'thread-unbound',
      createdAt: '2026-08-08T12:00:00.000Z',
      method: 'session.started',
      sessionId: 'thread-unbound',
      metadata: { agentSlug: 'claude' },
    });

    const reader = new ConversationHistoryReadService(
      readServiceOptions(eventStore),
    );
    const authority = sessionReadAuthorityFromRequest(
      'owner-alpha',
      { tenantId: 'alpha' as any },
      hostedRegistry,
    );

    expect(reader.readPage({ authority, limit: 50 })).toEqual({
      records: [],
      hasMore: false,
    });
    expect(eventStore.readConversationHistoryUpgrade()).toMatchObject({
      status: 'complete',
      quarantinedCount: 1,
    });
    expect(eventStore.listConversationHistoryQuarantine()).toEqual([
      expect.objectContaining({
        threadId: 'thread-unbound',
        reason: 'unbound',
      }),
    ]);
  });

  test('includes owner-bound pre-agent records in personal mode only when the existing authority check permits them', () => {
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-personal-unbound',
      status: 'ready',
      createdAt: '2026-08-08T12:00:00.000Z',
      updatedAt: '2026-08-08T12:00:00.000Z',
    });
    eventStore.appendEvent({
      eventId: 'thread-personal-unbound-started',
      provider: 'claude',
      threadId: 'thread-personal-unbound',
      createdAt: '2026-08-08T12:00:00.000Z',
      method: 'session.started',
      sessionId: 'thread-personal-unbound',
      metadata: { userId: 'owner-alpha' },
    });
    const canReadSession = vi.fn(() => true);
    const reader = new ConversationHistoryReadService({
      ...readServiceOptions(eventStore),
      canReadSession,
    });
    const authority = sessionReadAuthorityFromRequest(
      'owner-alpha',
      undefined,
      undefined,
    );

    expect(reader.readPage({ authority, limit: 1 })).toMatchObject({
      records: [
        expect.objectContaining({ threadId: 'thread-personal-unbound' }),
      ],
      hasMore: false,
    });
    expect(canReadSession).toHaveBeenCalledWith(
      'thread-personal-unbound',
      authority,
    );
  });

  test('projects child Sessions into Environment-scoped conversation rows with the newest accepted model', () => {
    const appendChild = (input: {
      threadId: string;
      conversationId: string;
      environmentId: string;
      model: string;
      at: string;
    }) => {
      eventStore.upsertSession({
        provider: 'claude',
        threadId: input.threadId,
        status: 'ready',
        createdAt: input.at,
        updatedAt: input.at,
      });
      // Legacy fallback fixture: no durable lineage row, so the reserved
      // server metadata below is the authoritative pre-lineage identity.
      (
        eventStore as unknown as {
          db: { prepare(sql: string): { run(...values: unknown[]): void } };
        }
      ).db
        .prepare(
          'DELETE FROM orchestration_conversation_sessions WHERE session_id = ?',
        )
        .run(input.threadId);
      eventStore.appendEvent({
        eventId: `${input.threadId}-started`,
        provider: 'claude',
        threadId: input.threadId,
        createdAt: input.at,
        method: 'session.started',
        sessionId: input.threadId,
        metadata: {
          userId: 'owner-alpha',
          agentSlug: 'claude',
          conversationId: input.conversationId,
          environmentId: input.environmentId,
        },
      });
      eventStore.appendEvent({
        eventId: `${input.threadId}-configured`,
        provider: 'claude',
        threadId: input.threadId,
        createdAt: input.at,
        method: 'session.configured',
        sessionId: input.threadId,
        metadata: {
          conversationId: input.conversationId,
          environmentId: input.environmentId,
          modelSelectionReceipt: {
            requestedModel: input.model,
            appliedModel: input.model,
          },
        },
      });
      eventStore.appendEvent({
        eventId: `${input.threadId}-turn`,
        provider: 'claude',
        threadId: input.threadId,
        createdAt: input.at,
        method: 'turn.started',
        turnId: `${input.threadId}-turn`,
        prompt: `Work from ${input.threadId}`,
      });
    };

    appendChild({
      threadId: 'child-a-old',
      conversationId: 'same-conversation',
      environmentId: 'station-a',
      model: 'model-a-old',
      at: '2026-08-08T12:00:00.000Z',
    });
    appendChild({
      threadId: 'child-a-current',
      conversationId: 'same-conversation',
      environmentId: 'station-a',
      model: 'model-a-current',
      at: '2026-08-08T12:02:00.000Z',
    });
    appendChild({
      threadId: 'child-b-current',
      conversationId: 'same-conversation',
      environmentId: 'station-b',
      model: 'model-b-current',
      at: '2026-08-08T12:03:00.000Z',
    });

    const reader = new ConversationHistoryReadService(
      readServiceOptions(eventStore),
    );
    const page = reader.list({
      authority: sessionReadAuthorityFromRequest(
        'owner-alpha',
        undefined,
        undefined,
      ),
      limit: 10,
    });

    expect(page.items).toEqual([
      expect.objectContaining({
        id: 'same-conversation',
        environmentId: 'station-b',
        acceptedModel: 'model-b-current',
      }),
      expect.objectContaining({
        id: 'same-conversation',
        environmentId: 'station-a',
        acceptedModel: 'model-a-current',
        title: 'Work from child-a-old',
        messageCount: 2,
        createdAt: '2026-08-08T12:00:00.000Z',
      }),
    ]);
    expect(page.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ acceptedModel: 'model-a-old' }),
      ]),
    );

    const firstPage = reader.list({
      authority: sessionReadAuthorityFromRequest(
        'owner-alpha',
        undefined,
        undefined,
      ),
      limit: 1,
    });
    expect(firstPage).toMatchObject({
      hasMore: true,
      items: [
        expect.objectContaining({
          id: 'same-conversation',
          environmentId: 'station-b',
          acceptedModel: 'model-b-current',
        }),
      ],
    });
    expect(firstPage.nextCursor).toBeTypeOf('string');
    const secondPage = reader.list({
      authority: sessionReadAuthorityFromRequest(
        'owner-alpha',
        undefined,
        undefined,
      ),
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage).toMatchObject({
      hasMore: false,
      items: [
        expect.objectContaining({
          id: 'same-conversation',
          environmentId: 'station-a',
          acceptedModel: 'model-a-current',
        }),
      ],
    });
  });

  test('immutable lineage wins over corrupt metadata and owner filtering happens before grouping', () => {
    const db = (
      eventStore as unknown as {
        db: { prepare(sql: string): { run(...values: unknown[]): void } };
      }
    ).db;
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'lineaged-child',
      status: 'ready',
      createdAt: '2026-08-08T13:00:00.000Z',
      updatedAt: '2026-08-08T13:00:00.000Z',
    });
    db.prepare(
      'DELETE FROM orchestration_conversation_sessions WHERE session_id = ?',
    ).run('lineaged-child');
    db.prepare(
      `INSERT INTO orchestration_conversation_sessions
        (conversation_id, session_id, ordinal, predecessor_session_id, created_at)
       VALUES (?, ?, 0, NULL, ?)`,
    ).run(
      'canonical-conversation',
      'lineaged-child',
      '2026-08-08T13:00:00.000Z',
    );
    eventStore.appendEvent({
      eventId: 'lineaged-child-started',
      provider: 'claude',
      threadId: 'lineaged-child',
      createdAt: '2026-08-08T13:00:00.000Z',
      method: 'session.started',
      sessionId: 'lineaged-child',
      metadata: {
        userId: 'owner-alpha',
        agentSlug: 'claude',
        conversationId: 'corrupt-metadata-conversation',
        environmentId: 'station-a',
      },
    });
    eventStore.appendEvent({
      eventId: 'lineaged-child-turn',
      provider: 'claude',
      threadId: 'lineaged-child',
      createdAt: '2026-08-08T13:00:01.000Z',
      method: 'turn.started',
      turnId: 'lineaged-child-turn',
      prompt: 'Owner alpha work',
    });

    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'other-owner-child',
      status: 'ready',
      createdAt: '2026-08-08T13:01:00.000Z',
      updatedAt: '2026-08-08T13:01:00.000Z',
    });
    eventStore.appendEvent({
      eventId: 'other-owner-started',
      provider: 'claude',
      threadId: 'other-owner-child',
      createdAt: '2026-08-08T13:01:00.000Z',
      method: 'session.started',
      sessionId: 'other-owner-child',
      metadata: {
        userId: 'owner-bravo',
        agentSlug: 'claude',
        conversationId: 'canonical-conversation',
        environmentId: 'station-a',
      },
    });

    const page = new ConversationHistoryReadService(
      readServiceOptions(eventStore),
    ).list({
      authority: sessionReadAuthorityFromRequest(
        'owner-alpha',
        undefined,
        undefined,
      ),
      limit: 10,
    });
    expect(page.items).toEqual([
      expect.objectContaining({
        id: 'canonical-conversation',
        environmentId: 'station-a',
        title: 'Owner alpha work',
      }),
    ]);
  });

  test('inherits the latest prior accepted model until a later child applies an override', () => {
    const conversationId = 'accepted-model-lineage';
    const addSession = (input: {
      sessionId: string;
      at: string;
      appliedModel?: string;
    }) => {
      eventStore.upsertSession({
        provider: 'claude',
        threadId: input.sessionId,
        status: 'ready',
        createdAt: input.at,
        updatedAt: input.at,
      });
      eventStore.appendEvent({
        eventId: `${input.sessionId}-started`,
        provider: 'claude',
        threadId: input.sessionId,
        createdAt: input.at,
        method: 'session.started',
        sessionId: input.sessionId,
        metadata: {
          userId: 'owner-alpha',
          agentSlug: 'claude',
          conversationId,
          environmentId: 'station-a',
        },
      });
      if (input.appliedModel) {
        eventStore.appendEvent({
          eventId: `${input.sessionId}-configured`,
          provider: 'claude',
          threadId: input.sessionId,
          createdAt: input.at,
          method: 'session.configured',
          sessionId: input.sessionId,
          metadata: {
            conversationId,
            environmentId: 'station-a',
            modelSelectionReceipt: {
              requestedModel: input.appliedModel,
              appliedModel: input.appliedModel,
            },
          },
        });
      }
      eventStore.appendEvent({
        eventId: `${input.sessionId}-turn`,
        provider: 'claude',
        threadId: input.sessionId,
        createdAt: input.at,
        method: 'turn.started',
        turnId: `${input.sessionId}-turn`,
        prompt: `Turn in ${input.sessionId}`,
      });
    };
    const authority = sessionReadAuthorityFromRequest(
      'owner-alpha',
      undefined,
      undefined,
    );
    const reader = new ConversationHistoryReadService(
      readServiceOptions(eventStore),
    );

    addSession({
      sessionId: conversationId,
      at: '2026-08-08T14:00:00.000Z',
      appliedModel: 'root-model',
    });
    eventStore.reserveNextConversationSession({
      conversationId,
      predecessorSessionId: conversationId,
      proposedSessionId: 'child-without-receipt',
      createdAt: '2026-08-08T14:01:00.000Z',
    });
    addSession({
      sessionId: 'child-without-receipt',
      at: '2026-08-08T14:01:00.000Z',
    });
    expect(reader.list({ authority, limit: 10 }).items).toEqual([
      expect.objectContaining({
        id: conversationId,
        acceptedModel: 'root-model',
        title: `Turn in ${conversationId}`,
        messageCount: 2,
      }),
    ]);

    eventStore.reserveNextConversationSession({
      conversationId,
      predecessorSessionId: 'child-without-receipt',
      proposedSessionId: 'child-with-override',
      createdAt: '2026-08-08T14:02:00.000Z',
    });
    addSession({
      sessionId: 'child-with-override',
      at: '2026-08-08T14:02:00.000Z',
      appliedModel: 'override-model',
    });
    expect(reader.list({ authority, limit: 10 }).items).toEqual([
      expect.objectContaining({
        id: conversationId,
        acceptedModel: 'override-model',
        messageCount: 3,
      }),
    ]);
  });

  test('includes a true NULL-owner record only when single-user compatibility is enabled and the authority check permits it', () => {
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-personal-ownerless',
      status: 'ready',
      createdAt: '2026-08-08T12:00:00.000Z',
      updatedAt: '2026-08-08T12:00:00.000Z',
    });
    eventStore.appendEvent({
      eventId: 'thread-personal-ownerless-started',
      provider: 'claude',
      threadId: 'thread-personal-ownerless',
      createdAt: '2026-08-08T12:00:00.000Z',
      method: 'session.started',
      sessionId: 'thread-personal-ownerless',
      metadata: { agentSlug: 'claude' },
    });
    const authority = sessionReadAuthorityFromRequest(
      'owner-alpha',
      undefined,
      undefined,
    );
    const canReadSession = vi.fn(() => true);

    const disabled = new ConversationHistoryReadService({
      ...readServiceOptions(eventStore),
      canReadSession,
    });
    expect(disabled.readPage({ authority, limit: 1 }).records).toEqual([]);

    const enabled = new ConversationHistoryReadService({
      ...readServiceOptions(eventStore),
      canReadSession,
      ownerlessPersonalAccess: true,
    });
    expect(enabled.readPage({ authority, limit: 1 }).records).toEqual([
      expect.objectContaining({ threadId: 'thread-personal-ownerless' }),
    ]);
    expect(canReadSession).toHaveBeenCalledWith(
      'thread-personal-ownerless',
      authority,
    );
  });

  test('excludes an owner and tenant bound row that is quarantined for a missing agent in hosted mode', () => {
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-hosted-pre-agent',
      status: 'ready',
      tenantExecutionContext: { tenantId: 'alpha' as any, source: 'session' },
      createdAt: '2026-08-08T12:00:00.000Z',
      updatedAt: '2026-08-08T12:00:00.000Z',
    });
    eventStore.appendEvent({
      eventId: 'thread-hosted-pre-agent-started',
      provider: 'claude',
      threadId: 'thread-hosted-pre-agent',
      createdAt: '2026-08-08T12:00:00.000Z',
      method: 'session.started',
      sessionId: 'thread-hosted-pre-agent',
      metadata: { userId: 'owner-alpha' },
    });
    const reader = new ConversationHistoryReadService(
      readServiceOptions(eventStore),
    );
    const authority = sessionReadAuthorityFromRequest(
      'owner-alpha',
      { tenantId: 'alpha' as any },
      hostedRegistry,
    );

    expect(reader.readPage({ authority, limit: 1 })).toEqual({
      records: [],
      hasMore: false,
    });
  });
});
