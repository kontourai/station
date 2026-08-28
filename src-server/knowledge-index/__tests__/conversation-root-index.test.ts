/**
 * End-to-end index integration for `root:conversations` (archive#1879, W4):
 * register the `conversation-store` adapter + boot-wire the root exactly like
 * production (`ensureConversationKnowledgeRoot`), `rebuildRoot` it through the
 * real K3 `SqliteVecIndexProvider` (stub embedder, real chunking, real
 * `listByType` walk — same shape as `sqlite-vec-index-provider.test.ts`'s own
 * `KnowledgeStoreProvider` end-to-end test), then prove the recall-parity
 * property this root must hold like any other: a search hit's `recordId`
 * re-resolves through `adapterFor(rootId).get(recordId)` to a real record
 * with the right title/category — K3's "never treat an index hit as the
 * record" rule (`knowledge-foundation.md`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IEmbeddingProvider } from '@kontourai/station-contracts/knowledge-index';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type {
  ConversationFileStoreReader,
  ConversationSessionReader,
} from '../../knowledge-store/adapters/conversation-store.js';
import { CONVERSATION_ROOT_ID } from '../../knowledge-store/adapters/conversation-store.js';
import { ensureConversationKnowledgeRoot } from '../../knowledge-store/conversation-root-bootstrap.js';
import { KnowledgeStoreProvider } from '../../knowledge-store/knowledge-store-provider.js';
import { chunkKnowledgeText } from '../../services/knowledge/knowledge-storage.js';
import type { SessionQueryModule } from '../../services/orchestration/session-query-module.js';
import { SqliteVecIndexProvider } from '../sqlite-vec-index-provider.js';

/** In-memory fake mirroring the FileStorageAdapter root-persistence methods —
 * same fixture shape used by every other knowledge-store test suite. */
class FakeRootPersistence {
  private roots: KnowledgeStoreRoot[] = [];

  listKnowledgeStoreRoots(): KnowledgeStoreRoot[] {
    return this.roots.slice();
  }

  saveKnowledgeStoreRoot(root: KnowledgeStoreRoot): void {
    const idx = this.roots.findIndex((r) => r.id === root.id);
    if (idx >= 0) this.roots[idx] = root;
    else this.roots.push(root);
  }

  removeKnowledgeStoreRoot(id: string): void {
    const index = this.roots.findIndex((r) => r.id === id);
    if (index < 0) throw new Error(`Knowledge store root '${id}' not found`);
    this.roots.splice(index, 1);
  }
}

/** A pure, deterministic function of the input text — copied from
 * `sqlite-vec-index-provider.test.ts`'s own fixture so index-vs-query
 * embeddings for the same string are guaranteed identical (distance 0). */
function deterministicVector(text: string, dim: number): number[] {
  let seed = 0;
  for (let i = 0; i < text.length; i += 1) {
    seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  }
  const vec: number[] = [];
  for (let i = 0; i < dim; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    vec.push((seed / 0xffffffff) * 2 - 1);
  }
  return vec;
}

class StubEmbedder implements IEmbeddingProvider {
  readonly id = 'stub-embedder';
  readonly displayName = 'Deterministic stub embedder';

  constructor(private readonly dim: number) {}

  dimensions(): number {
    return this.dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => deterministicVector(t, this.dim));
  }
}

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

  async listSessionReadModel() {
    return this.sessions.map((s) => ({
      threadId: s.threadId,
      assignedAgentSlug: s.agentSlug,
    }));
  }
}

describe('root:conversations — end-to-end K3 index integration (station#1879)', () => {
  let dbDir: string;
  let indexProvider: SqliteVecIndexProvider;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'conversation-root-index-'));
    indexProvider = new SqliteVecIndexProvider({
      dbPath: join(dbDir, 'index.db'),
    });
  });

  afterEach(() => {
    indexProvider.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  test('rebuildRoot indexes conversation records; search hits re-resolve through adapterFor(rootId).get(recordId)', async () => {
    const persistence = new FakeRootPersistence();
    const storeProvider = new KnowledgeStoreProvider(persistence);

    const sessionReader = new FakeSessionReader([
      {
        threadId: 'aaaaaaaa-1111-4111-8111-111111111111',
        agentSlug: 'claude',
        title: 'Sourdough starter troubleshooting',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:05:00.000Z',
        messages: [
          textMessage(
            'm1',
            'user',
            'My starter has stopped rising, what should I check?',
          ),
          textMessage(
            'm2',
            'assistant',
            'Feed it daily with equal parts flour and water.',
          ),
        ],
      },
      {
        threadId: 'bbbbbbbb-2222-4222-8222-222222222222',
        agentSlug: 'codex',
        title: 'Vector index tradeoffs',
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:05:00.000Z',
        messages: [
          textMessage('m1', 'user', 'HNSW vs IVF for a small corpus?'),
          textMessage(
            'm2',
            'assistant',
            'HNSW trades memory for speed versus IVF partitioning.',
          ),
        ],
      },
    ]);
    const fileStores = new Map<string, ConversationFileStoreReader>();

    // Boot-wire exactly like production: register + (flag on) create the root.
    await ensureConversationKnowledgeRoot({
      provider: storeProvider,
      persistence,
      sessionReader,
      fileStores,
      getUserId: () => 'user-1',
      projectHomeDir: dbDir,
      knowledgeStoresEnabled: true,
    });

    const root = await storeProvider.getRoot(CONVERSATION_ROOT_ID);
    expect(root).not.toBeNull();

    const embedder = new StubEmbedder(16);
    const result = await indexProvider.rebuildRoot(CONVERSATION_ROOT_ID, {
      store: storeProvider,
      embedder,
    });

    expect(result.records).toBe(2);
    expect(result.chunks).toBeGreaterThanOrEqual(2);

    // Query with the exact embedding of the FIRST real chunk `rebuildRoot`
    // itself derived from the sourdough conversation's record body (same
    // `chunkKnowledgeText` call the rebuild path uses) — guaranteed distance
    // 0 against itself (deterministic embedder), so it must rank first.
    const adapter = await storeProvider.adapterFor(CONVERSATION_ROOT_ID);
    const sourdoughRecord = await adapter.get(
      'aaaaaaaa-1111-4111-8111-111111111111',
    );
    expect(sourdoughRecord).not.toBeNull();
    const [expectedFirstChunk] = chunkKnowledgeText(sourdoughRecord!.body);
    const [queryVector] = await embedder.embed([expectedFirstChunk]);
    const hits = await indexProvider.search(queryVector, {
      topK: 1,
      rootIds: [CONVERSATION_ROOT_ID],
      threshold: -1,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].rootId).toBe(CONVERSATION_ROOT_ID);
    expect(hits[0].score).toBeCloseTo(1, 5);

    // Recall-parity: never trust the hit itself — re-resolve through the
    // adapter, exactly like `knowledge-index-routes.ts`'s search route does.
    const record = await adapter.get(hits[0].recordId);
    expect(record).not.toBeNull();
    expect(record?.id).toBe('aaaaaaaa-1111-4111-8111-111111111111');
    expect(record?.title).toBe('Sourdough starter troubleshooting');
    expect(record?.category).toBe('conversation');
  });
});
