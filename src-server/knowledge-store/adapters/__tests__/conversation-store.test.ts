import type { KitRecord } from '@kontourai/station-contracts/knowledge-store';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { describe, expect, test } from 'vitest';
import { isSafePathSegment } from '../../../knowledge-index/path-safety.js';
import type { SessionQueryModule } from '../../../services/orchestration/session-query-module.js';
import { ReadOnlyStoreError } from '../../errors.js';
import {
  CONVERSATION_ROOT_ID,
  CONVERSATION_STORE_ADAPTER_ID,
  type ConversationFileStoreConversation,
  type ConversationFileStoreReader,
  type ConversationSessionReader,
  createConversationStoreAdapterDescriptor,
} from '../conversation-store.js';

/** Deliberately NOT `contract-suite.ts` (module doc: it asserts mutation
 * round-trips, which is the opposite of what a read-only adapter must prove). */

function textMessage(
  id: string,
  role: ConversationMessage['role'],
  text: string,
): ConversationMessage {
  return { id, role, parts: [{ type: 'text', text }] };
}

interface FakeSession {
  threadId: string;
  agentSlug: string;
  projectSlug?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
}

class FakeSessionReader implements ConversationSessionReader {
  constructor(private readonly sessions: FakeSession[]) {}

  readonly sessionQueries: SessionQueryModule = {
    read: async ({ threadId }) => {
      const session = this.sessions.find(
        (candidate) => candidate.threadId === threadId,
      );
      if (!session) return { status: 'not-found' };
      return {
        status: 'found',
        conversation: {
          id: session.threadId,
          agentSlug: session.agentSlug,
          ...(session.projectSlug ? { projectSlug: session.projectSlug } : {}),
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: session.messages.length,
          mutable: false,
        },
        messages: session.messages,
      };
    },
    readUserInput: async () => ({ status: 'not-found' }),
    readAssistantTurn: async () => ({ status: 'not-found' }),
  };

  async listSessionReadModel(): Promise<
    Array<{ threadId: string; assignedAgentSlug?: string }>
  > {
    return this.sessions.map((s) => ({
      threadId: s.threadId,
      assignedAgentSlug: s.agentSlug,
    }));
  }
}

class FakeFileStoreReader implements ConversationFileStoreReader {
  constructor(
    private readonly conversations: ConversationFileStoreConversation[],
    private readonly messagesById: Map<string, unknown[]>,
  ) {}

  async getConversations(): Promise<ConversationFileStoreConversation[]> {
    return this.conversations;
  }

  async getMessages(
    _userId: string,
    conversationId: string,
  ): Promise<unknown[]> {
    return this.messagesById.get(conversationId) ?? [];
  }
}

function emptySessionReader(): FakeSessionReader {
  return new FakeSessionReader([]);
}

function emptyFileStores(): Map<string, ConversationFileStoreReader> {
  return new Map();
}

describe('conversation-store adapter (station#1879)', () => {
  test('id/root constants are station-clean names', () => {
    expect(CONVERSATION_STORE_ADAPTER_ID).toBe('conversation-store');
    expect(CONVERSATION_ROOT_ID).toBe('root:conversations');
  });

  test('record shape: non-empty title/body/category/provenance, markdown headings, projectSlug tag', async () => {
    const sessionReader = new FakeSessionReader([
      {
        threadId: 'aaaaaaaa-1111-4111-8111-111111111111',
        agentSlug: 'claude',
        projectSlug: 'acme',
        title: 'Debugging the release pipeline',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:05:00.000Z',
        messages: [
          textMessage('m1', 'user', 'Why did the deploy fail?'),
          textMessage('m2', 'assistant', 'The tag pointed at a stale SHA.'),
        ],
      },
    ]);
    const descriptor = createConversationStoreAdapterDescriptor({
      sessionReader,
      fileStores: emptyFileStores(),
      getUserId: () => 'user-1',
    });
    const adapter = await descriptor.create({ storeRoot: '/unused' });

    const records = await adapter.listByType('raw', {});
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.id).toBe('aaaaaaaa-1111-4111-8111-111111111111');
    expect(record.type).toBe('raw');
    expect(record.category).toBe('conversation');
    expect(record.title).toBe('Debugging the release pipeline');
    expect(record.body).toContain('### User');
    expect(record.body).toContain('Why did the deploy fail?');
    expect(record.body).toContain('### claude');
    expect(record.body).toContain('The tag pointed at a stale SHA.');
    expect(record.tags).toEqual(['acme']);
    expect(record.provenance.agent).toBeTruthy();
    expect(record.created_at).toBe('2026-08-01T00:00:00.000Z');
    expect(record.updated_at).toBe('2026-08-01T00:05:00.000Z');
  });

  test('folds both legs and dedupes by id — the SESSION leg wins a collision', async () => {
    const sharedId = 'bbbbbbbb-2222-4222-8222-222222222222';
    const sessionReader = new FakeSessionReader([
      {
        threadId: sharedId,
        agentSlug: 'codex',
        title: 'Session-leg title (should win)',
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:01:00.000Z',
        messages: [textMessage('m1', 'user', 'session leg text')],
      },
      {
        threadId: 'cccccccc-3333-4333-8333-333333333333',
        agentSlug: 'claude',
        title: 'Session-only conversation',
        createdAt: '2026-08-02T01:00:00.000Z',
        updatedAt: '2026-08-02T01:01:00.000Z',
        messages: [textMessage('m1', 'user', 'session-only text')],
      },
    ]);
    const fileStores = new Map<string, ConversationFileStoreReader>([
      [
        'default',
        new FakeFileStoreReader(
          [
            {
              id: sharedId,
              resourceId: 'default',
              userId: 'user-1',
              title: 'File-leg title (should lose)',
              metadata: {},
              createdAt: '2026-08-02T00:00:00.000Z',
              updatedAt: '2026-08-02T00:00:30.000Z',
            },
            {
              id: 'dddddddd-4444-4444-8444-444444444444',
              resourceId: 'default',
              userId: 'user-1',
              title: 'File-only conversation',
              metadata: {},
              createdAt: '2026-08-02T02:00:00.000Z',
              updatedAt: '2026-08-02T02:01:00.000Z',
            },
          ],
          new Map([
            [
              sharedId,
              [
                {
                  id: 'm1',
                  role: 'user',
                  parts: [{ type: 'text', text: 'file leg text' }],
                },
              ],
            ],
            [
              'dddddddd-4444-4444-8444-444444444444',
              [
                {
                  id: 'm1',
                  role: 'user',
                  parts: [{ type: 'text', text: 'file-only text' }],
                },
              ],
            ],
          ]),
        ),
      ],
    ]);

    const descriptor = createConversationStoreAdapterDescriptor({
      sessionReader,
      fileStores,
      getUserId: () => 'user-1',
    });
    const adapter = await descriptor.create({ storeRoot: '/unused' });

    const records = await adapter.listByType('raw', {});
    expect(records).toHaveLength(3); // shared id deduped to one record

    const byId = new Map(records.map((r: KitRecord) => [r.id, r]));
    expect(byId.get(sharedId)?.title).toBe('Session-leg title (should win)');
    expect(byId.get(sharedId)?.body).toContain('session leg text');
    expect(byId.has('cccccccc-3333-4333-8333-333333333333')).toBe(true);
    expect(byId.has('dddddddd-4444-4444-8444-444444444444')).toBe(true);
  });

  test('enumerates well past 100 session conversations — no silent cap (never listAllSessionConversations)', async () => {
    const sessions: FakeSession[] = [];
    for (let i = 0; i < 150; i += 1) {
      sessions.push({
        threadId: `session-${String(i).padStart(4, '0')}`,
        agentSlug: 'claude',
        title: `Conversation ${i}`,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        messages: [textMessage('m1', 'user', `turn ${i}`)],
      });
    }
    const descriptor = createConversationStoreAdapterDescriptor({
      sessionReader: new FakeSessionReader(sessions),
      fileStores: emptyFileStores(),
      getUserId: () => 'user-1',
    });
    const adapter = await descriptor.create({ storeRoot: '/unused' });

    const records = await adapter.listByType('raw', {});
    expect(records).toHaveLength(150);
    // The oldest conversation (index 0) must still be present — a 100-cap
    // (`.slice(-100)`) would silently drop it, keeping only the newest 100.
    expect(records.some((r: KitRecord) => r.id === 'session-0000')).toBe(true);
  });

  test('get(id) resolves an exact id from either leg; unknown id -> null', async () => {
    const sessionId = 'eeeeeeee-5555-4555-8555-555555555555';
    const fileId = 'ffffffff-6666-4666-8666-666666666666';
    const sessionReader = new FakeSessionReader([
      {
        threadId: sessionId,
        agentSlug: 'claude',
        title: 'Session conversation',
        createdAt: '2026-08-03T00:00:00.000Z',
        updatedAt: '2026-08-03T00:00:00.000Z',
        messages: [textMessage('m1', 'user', 'hello from session leg')],
      },
    ]);
    const fileStores = new Map<string, ConversationFileStoreReader>([
      [
        'default',
        new FakeFileStoreReader(
          [
            {
              id: fileId,
              resourceId: 'default',
              userId: 'user-1',
              title: 'File conversation',
              metadata: {},
              createdAt: '2026-08-03T01:00:00.000Z',
              updatedAt: '2026-08-03T01:00:00.000Z',
            },
          ],
          new Map([
            [
              fileId,
              [
                {
                  id: 'm1',
                  role: 'user',
                  parts: [{ type: 'text', text: 'hello from file leg' }],
                },
              ],
            ],
          ]),
        ),
      ],
    ]);
    const descriptor = createConversationStoreAdapterDescriptor({
      sessionReader,
      fileStores,
      getUserId: () => 'user-1',
    });
    const adapter = await descriptor.create({ storeRoot: '/unused' });

    const sessionRecord = await adapter.get(sessionId);
    expect(sessionRecord?.id).toBe(sessionId);
    expect(sessionRecord?.body).toContain('hello from session leg');

    const fileRecord = await adapter.get(fileId);
    expect(fileRecord?.id).toBe(fileId);
    expect(fileRecord?.body).toContain('hello from file leg');

    const missing = await adapter.get('unknown-id-not-real');
    expect(missing).toBeNull();
  });

  test('listByType/listByCategory return [] for every other type/category', async () => {
    const sessionReader = new FakeSessionReader([
      {
        threadId: 'gggggggg-7777-4777-8777-777777777777',
        agentSlug: 'claude',
        title: 'Some conversation',
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:00:00.000Z',
        messages: [textMessage('m1', 'user', 'text')],
      },
    ]);
    const descriptor = createConversationStoreAdapterDescriptor({
      sessionReader,
      fileStores: emptyFileStores(),
      getUserId: () => 'user-1',
    });
    const adapter = await descriptor.create({ storeRoot: '/unused' });

    expect(await adapter.listByType('compiled', {})).toEqual([]);
    expect(await adapter.listByType('concept', {})).toEqual([]);
    expect(await adapter.listByType('snapshot', {})).toEqual([]);
    expect(await adapter.listByType('person', {})).toEqual([]);
    expect(await adapter.listByCategory('meeting-notes', {})).toEqual([]);
    expect(await adapter.listByCategory('conversation', {})).toHaveLength(1);
  });

  test('getLinks is always empty', async () => {
    const descriptor = createConversationStoreAdapterDescriptor({
      sessionReader: emptySessionReader(),
      fileStores: emptyFileStores(),
      getUserId: () => 'user-1',
    });
    const adapter = await descriptor.create({ storeRoot: '/unused' });
    expect(await adapter.getLinks('anything')).toEqual({
      forward: [],
      reverse: [],
    });
  });

  test('every one of the eight mutation verbs throws ReadOnlyStoreError (code READ_ONLY)', async () => {
    const descriptor = createConversationStoreAdapterDescriptor({
      sessionReader: emptySessionReader(),
      fileStores: emptyFileStores(),
      getUserId: () => 'user-1',
    });
    const adapter = await descriptor.create({ storeRoot: '/unused' });

    const attempts: Array<[string, () => Promise<unknown>]> = [
      [
        'create',
        () =>
          adapter.create({
            type: 'raw',
            title: 't',
            body: 'b',
            category: 'conversation',
            provenance: { agent: 'test' },
          }),
      ],
      ['update', () => adapter.update('id', {}, { agent: 'test' })],
      ['link', () => adapter.link('id', [], { agent: 'test' })],
      [
        'propose',
        () =>
          adapter.propose('id', 'proposer', {
            agent: 'test',
            proposal: 'p',
          }),
      ],
      [
        'apply',
        () =>
          adapter.apply('id', 'proposer', {
            agent: 'test',
            new_body: 'b',
            rationale: 'r',
          }),
      ],
      [
        'reject',
        () => adapter.reject('id', 'proposer', { agent: 'test', reason: 'r' }),
      ],
      [
        'supersede',
        () =>
          adapter.supersede('id', ['old'], { agent: 'test', rationale: 'r' }),
      ],
      [
        'retire',
        () =>
          adapter.retire('id', 'retired', { agent: 'test', rationale: 'r' }),
      ],
    ];

    expect(attempts).toHaveLength(8);
    for (const [op, attempt] of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(ReadOnlyStoreError);
      await expect(attempt()).rejects.toMatchObject({
        code: 'READ_ONLY',
      });
      await expect(attempt()).rejects.toThrow(new RegExp(op, 'i'));
    }
  });

  test('conversation ids pass isSafePathSegment (probe risk R9 — UUID-shaped, no traversal risk)', async () => {
    const uuidLikeThreadId = 'a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6';
    const sessionReader = new FakeSessionReader([
      {
        threadId: uuidLikeThreadId,
        agentSlug: 'claude',
        title: 'UUID-id conversation',
        createdAt: '2026-08-05T00:00:00.000Z',
        updatedAt: '2026-08-05T00:00:00.000Z',
        messages: [textMessage('m1', 'user', 'text')],
      },
    ]);
    const descriptor = createConversationStoreAdapterDescriptor({
      sessionReader,
      fileStores: emptyFileStores(),
      getUserId: () => 'user-1',
    });
    const adapter = await descriptor.create({ storeRoot: '/unused' });
    const [record] = await adapter.listByType('raw', {});
    expect(isSafePathSegment(record.id)).toBe(true);
  });

  test('hosted alpha suppresses the unbound bravo file-conversation leg, including direct ids', async () => {
    const bravoId = 'bravo-file-conversation';
    const fileStores = new Map<string, ConversationFileStoreReader>([
      [
        'bravo-agent',
        new FakeFileStoreReader(
          [
            {
              id: bravoId,
              resourceId: 'bravo-agent',
              userId: 'bravo',
              title: 'Bravo private conversation',
              createdAt: '2026-08-08T00:00:00.000Z',
              updatedAt: '2026-08-08T00:00:00.000Z',
            },
          ],
          new Map([[bravoId, [textMessage('m1', 'user', 'bravo secret')]]]),
        ),
      ],
    ]);
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [
        { id: 'alpha', authority: 'alpha.example.test' },
        { id: 'bravo', authority: 'bravo.example.test' },
      ],
    });
    const alpha = sessionReadAuthorityFromRequest(
      'alpha',
      { tenantId: registry.tenants[0].id },
      registry,
    );
    const descriptor = createConversationStoreAdapterDescriptor({
      sessionReader: emptySessionReader(),
      fileStores,
      getUserId: () => 'alpha',
      getReadAuthority: () => alpha,
    });
    const adapter = await descriptor.create({ storeRoot: '/unused' });

    expect(await adapter.listByType('raw', {})).toEqual([]);
    expect(await adapter.get(bravoId)).toBeNull();
  });
});
