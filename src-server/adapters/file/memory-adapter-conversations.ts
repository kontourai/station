import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { Conversation, ConversationQueryOptions } from '@voltagent/core';
import { MemoryAdapterPaths } from './memory-adapter-paths.js';

export function applyConversationQueryOptions(
  conversations: Conversation[],
  options?: ConversationQueryOptions,
): Conversation[] {
  if (!options) {
    return conversations.slice();
  }

  let filtered = conversations.slice();

  if (options.userId) {
    filtered = filtered.filter(
      (conversation) => conversation.userId === options.userId,
    );
  }

  if (options.resourceId) {
    filtered = filtered.filter(
      (conversation) => conversation.resourceId === options.resourceId,
    );
  }

  const orderBy = options.orderBy ?? 'updated_at';
  const orderDirection = options.orderDirection === 'ASC' ? 1 : -1;

  if (orderBy === 'title') {
    filtered.sort((a, b) => a.title.localeCompare(b.title) * orderDirection);
  } else {
    const key = orderBy === 'created_at' ? 'createdAt' : 'updatedAt';
    filtered.sort((a, b) => {
      const aDate = new Date(a[key]).getTime();
      const bDate = new Date(b[key]).getTime();
      return (aDate - bDate) * orderDirection;
    });
  }

  const offset = options.offset ?? 0;
  const limit = options.limit ?? filtered.length;
  return filtered.slice(offset, offset + limit);
}

export interface MemoryConversationStore {
  loadConversationFromDisk(
    conversationId: string,
  ): Promise<Conversation | null>;
  persistConversation(conversation: Conversation): Promise<void>;
  /**
   * Serialized read-compute-write update, closing the TOCTOU class a plain
   * "read outside, write inside" `updateConversation` has (station#1566
   * review HIGH): `updater` runs INSIDE the same per-conversation queue
   * `persistConversation` already uses, so it always observes the latest
   * committed state — including a write from a concurrent
   * `updateConversation`/`persistConversation` call queued just before it —
   * never a snapshot taken before this call was even queued. Returning
   * `null` from `updater` skips the write entirely (e.g. "someone else's
   * update already made mine redundant/wrong") and the current record is
   * returned unchanged. Throws if the conversation does not exist, matching
   * the prior (object-form-only) `FileMemoryAdapter.updateConversation`
   * behavior.
   */
  updateConversation(
    conversationId: string,
    updater: (current: Conversation) => Partial<Conversation> | null,
  ): Promise<Conversation>;
  touchConversation(conversationId: string): Promise<void>;
  resolveResourceId(conversationId?: string, userId?: string): Promise<string>;
  listAgentConversations(resourceId: string): Promise<Conversation[]>;
  loadAllConversations(): Promise<Conversation[]>;
  deleteConversationAssets(
    resourceId: string,
    conversationId: string,
  ): Promise<void>;
}

export function createMemoryConversationStore(options: {
  paths: MemoryAdapterPaths;
  logger: Pick<Console, 'error'>;
}): MemoryConversationStore {
  const { paths, logger } = options;
  const conversationCache = new Map<string, Conversation>();
  const conversationResourceCache = new Map<string, string>();
  // station#1566: shared by both `persistConversation` and
  // `updateConversation` (same map, same per-conversation-id queue slot) —
  // the mixed value type (`Promise<void>` writes, `Promise<Conversation>`
  // read-compute-writes) is exactly what lets the two interleave safely: an
  // `updateConversation` queued after a `persistConversation` (or another
  // `updateConversation`) always chains onto that predecessor and reads its
  // committed result, never a pre-queue snapshot.
  const conversationPersistence = new Map<string, Promise<unknown>>();

  function cacheConversation(conversation: Conversation): void {
    conversationCache.set(conversation.id, conversation);
    conversationResourceCache.set(conversation.id, conversation.resourceId);
  }

  async function findConversationLocation(
    conversationId: string,
  ): Promise<{ path: string; resourceId: string } | null> {
    const cachedResource = conversationResourceCache.get(conversationId);
    if (cachedResource) {
      const cachedPath = paths.getConversationPath(
        cachedResource,
        conversationId,
      );
      if (existsSync(cachedPath)) {
        return { path: cachedPath, resourceId: cachedResource };
      }
    }

    const agentsDir = paths.getAgentsDir();
    if (!existsSync(agentsDir)) {
      return null;
    }

    const agentEntries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of agentEntries) {
      if (!entry.isDirectory()) continue;
      const resourceId = entry.name;
      const conversationPath = paths.getConversationPath(
        resourceId,
        conversationId,
      );
      if (existsSync(conversationPath)) {
        return { path: conversationPath, resourceId };
      }
    }

    return null;
  }

  async function loadConversationFromDisk(
    conversationId: string,
  ): Promise<Conversation | null> {
    if (conversationCache.has(conversationId)) {
      return conversationCache.get(conversationId)!;
    }

    const location = await findConversationLocation(conversationId);
    if (!location) {
      return null;
    }

    try {
      const content = await readFile(location.path, 'utf-8');
      const conversation = JSON.parse(content) as Conversation;
      cacheConversation(conversation);
      return conversation;
    } catch (error) {
      logger.error('Failed to read conversation', { conversationId, error });
      return null;
    }
  }

  /**
   * The actual disk write (temp file + atomic rename + cache update),
   * factored out so both `persistConversation` and `updateConversation` can
   * run it from inside their respective queued turn without duplicating the
   * torn-write and cleanup handling.
   */
  async function writeConversationToDisk(
    conversation: Conversation,
  ): Promise<void> {
    const conversationDir = paths.getConversationsDir(conversation.resourceId);
    await mkdir(conversationDir, { recursive: true });
    const conversationPath = paths.getConversationPath(
      conversation.resourceId,
      conversation.id,
    );
    const temporaryPath = `${conversationPath}.${process.pid}.${randomUUID()}.tmp`;
    let persistenceError: unknown;
    try {
      await writeFile(
        temporaryPath,
        JSON.stringify(conversation, null, 2),
        'utf-8',
      );
      // Readers see either the previous complete document or this complete
      // document, never the truncate-then-write window of writeFile(path).
      await rename(temporaryPath, conversationPath);
    } catch (error) {
      persistenceError = error;
      throw error;
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return;
        if (persistenceError !== undefined) {
          throw new AggregateError(
            [persistenceError, error],
            'Failed to persist conversation and clean its temporary file',
          );
        }
        throw error;
      });
    }
    cacheConversation(conversation);
  }

  async function persistConversation(
    conversation: Conversation,
  ): Promise<void> {
    // Preserve invocation order per conversation. Atomic rename prevents torn
    // reads, while this queue also keeps the cache aligned with the document
    // that won the final rename under concurrent saves.
    const predecessor = conversationPersistence.get(conversation.id);
    const operation = (predecessor ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => writeConversationToDisk(conversation));
    conversationPersistence.set(conversation.id, operation);
    try {
      await operation;
    } finally {
      if (conversationPersistence.get(conversation.id) === operation)
        conversationPersistence.delete(conversation.id);
    }
  }

  async function updateConversation(
    conversationId: string,
    updater: (current: Conversation) => Partial<Conversation> | null,
  ): Promise<Conversation> {
    // station#1566 review HIGH: the read (`loadConversationFromDisk`) and the
    // `updater` decision both run INSIDE this queued turn, chained onto the
    // same per-conversation predecessor `persistConversation` uses — so a
    // concurrent write queued just before this one (whether a plain
    // `persistConversation`/object-form `updateConversation`, or another
    // updater-form call) has already landed and updated the cache by the
    // time `current` is read here. There is no window between "decide" and
    // "write" for a third party to land an update this call never sees.
    const predecessor = conversationPersistence.get(conversationId);
    const operation: Promise<Conversation> = (predecessor ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const current = await loadConversationFromDisk(conversationId);
        if (!current) {
          throw new Error(`Conversation ${conversationId} not found`);
        }

        // The updater gets a defensive copy, never the live cache entry: an
        // updater that mutates its argument in place (the natural-looking
        // pattern) must not be able to diverge the cache from disk —
        // especially when it then returns null to skip the write. Mirrors
        // the clone the public getConversation read path already does.
        const patch = updater({
          ...current,
          ...(current.metadata &&
          typeof current.metadata === 'object' &&
          !Array.isArray(current.metadata)
            ? { metadata: { ...current.metadata } }
            : {}),
        });
        if (!patch) {
          // Skip: no write. Still occupies this queue slot for its full
          // turn, so anything queued after it correctly waits its turn too.
          return current;
        }

        const updated: Conversation = {
          ...current,
          ...patch,
          resourceId: current.resourceId,
          createdAt: current.createdAt,
          updatedAt: new Date().toISOString(),
        };
        await writeConversationToDisk(updated);
        return updated;
      });
    conversationPersistence.set(conversationId, operation);
    try {
      return await operation;
    } finally {
      if (conversationPersistence.get(conversationId) === operation)
        conversationPersistence.delete(conversationId);
    }
  }

  async function touchConversation(conversationId: string): Promise<void> {
    const conversation = await loadConversationFromDisk(conversationId);
    if (!conversation) return;

    await persistConversation({
      ...conversation,
      updatedAt: new Date().toISOString(),
    });
  }

  function extractAgentSlug(userId?: string): string | null {
    if (!userId) return null;
    const match = /^agent:([^:]+)/.exec(userId);
    return match ? match[1] : null;
  }

  async function resolveResourceId(
    conversationId?: string,
    userId?: string,
  ): Promise<string> {
    if (conversationId) {
      const cached = conversationResourceCache.get(conversationId);
      if (cached) {
        return cached;
      }

      const conversation = await loadConversationFromDisk(conversationId);
      if (conversation) {
        return conversation.resourceId;
      }
    }

    return extractAgentSlug(userId) ?? 'default';
  }

  async function listAgentConversations(
    resourceId: string,
  ): Promise<Conversation[]> {
    const conversationsDir = paths.getConversationsDir(resourceId);
    if (!existsSync(conversationsDir)) {
      return [];
    }

    const files = await readdir(conversationsDir);
    const conversations: Conversation[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const path = join(conversationsDir, file);
      try {
        const content = await readFile(path, 'utf-8');
        const conversation = JSON.parse(content) as Conversation;
        cacheConversation(conversation);
        conversations.push(conversation);
      } catch (error) {
        logger.error('Failed to parse conversation file', { file, error });
      }
    }

    return conversations;
  }

  async function loadAllConversations(): Promise<Conversation[]> {
    const agentsDir = paths.getAgentsDir();
    if (!existsSync(agentsDir)) {
      return [];
    }

    const entries = await readdir(agentsDir, { withFileTypes: true });
    const conversations: Conversation[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const agentConversations = await listAgentConversations(entry.name);
      conversations.push(...agentConversations);
    }

    return conversations;
  }

  async function deleteConversationAssets(
    resourceId: string,
    conversationId: string,
  ): Promise<void> {
    const conversationPath = paths.getConversationPath(
      resourceId,
      conversationId,
    );
    if (existsSync(conversationPath)) {
      await unlink(conversationPath);
    }

    const messagesPath = paths.getMessagesPath(resourceId, conversationId);
    if (existsSync(messagesPath)) {
      await unlink(messagesPath);
    }

    const workingMemoryPath = paths.getConversationWorkingMemoryPath(
      resourceId,
      conversationId,
    );
    if (existsSync(workingMemoryPath)) {
      await unlink(workingMemoryPath);
    }

    conversationCache.delete(conversationId);
    conversationResourceCache.delete(conversationId);
  }

  return {
    loadConversationFromDisk,
    persistConversation,
    updateConversation,
    touchConversation,
    resolveResourceId,
    listAgentConversations,
    loadAllConversations,
    deleteConversationAssets,
  };
}
