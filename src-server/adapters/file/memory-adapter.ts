/**
 * VoltAgent StorageAdapter implementation using file-based NDJSON storage.
 * Aligns with VoltAgent storage interfaces.
 */

import type {
  Conversation,
  ConversationQueryOptions,
  CreateConversationInput,
  GetMessagesOptions,
  StorageAdapter,
  WorkflowStateEntry,
  WorkingMemoryScope,
} from '@voltagent/core';
import type { UIMessage } from 'ai';
import { createLogger } from '../../utils/logger.js';
import {
  applyConversationQueryOptions,
  createMemoryConversationStore,
} from './memory-adapter-conversations.js';
import {
  addStoredMessage,
  addStoredMessages,
  clearStoredMessages,
  deleteStoredMessages,
  readStoredMessages,
  removeLastStoredMessage,
} from './memory-adapter-messages.js';
import { MemoryAdapterPaths } from './memory-adapter-paths.js';
import {
  deleteWorkingMemoryState as deleteWorkingMemoryStateFile,
  getSuspendedWorkflowStateEntries as getSuspendedWorkflowStateEntriesFromFiles,
  getWorkflowStateEntry as getWorkflowStateEntryFromFile,
  getWorkingMemoryState as getWorkingMemoryStateFile,
  setWorkflowStateEntry as setWorkflowStateEntryFile,
  setWorkingMemoryState as setWorkingMemoryStateFile,
} from './memory-adapter-state.js';

const logger = createLogger({ name: 'memory-adapter' });

export interface FileMemoryAdapterOptions {
  projectHomeDir: string;
  usageAggregator?: any;
}

/**
 * File-based storage adapter for VoltAgent memory.
 * Implements the StorageAdapter interface for conversation storage.
 */
export class FileMemoryAdapter implements StorageAdapter {
  private usageAggregator?: any;
  private paths: MemoryAdapterPaths;
  private conversations;

  constructor(options: FileMemoryAdapterOptions) {
    this.paths = new MemoryAdapterPaths(options.projectHomeDir);
    this.usageAggregator = options.usageAggregator;
    this.conversations = createMemoryConversationStore({
      paths: this.paths,
      logger,
    });
  }

  // ===========================================================================
  // Message Operations
  // ===========================================================================

  async addMessage(
    message: UIMessage,
    userId: string,
    conversationId: string,
    context?: any,
  ): Promise<void> {
    await addStoredMessage({
      paths: this.paths,
      resolveResourceId: (nextConversationId, nextUserId) =>
        this.conversations.resolveResourceId(nextConversationId, nextUserId),
      touchConversation: (id) => this.conversations.touchConversation(id),
      usageAggregator: this.usageAggregator,
      message,
      userId,
      conversationId,
      context,
    });
  }

  async addMessages(
    messages: UIMessage[],
    userId: string,
    conversationId: string,
  ): Promise<void> {
    await addStoredMessages({
      paths: this.paths,
      resolveResourceId: (nextConversationId, nextUserId) =>
        this.conversations.resolveResourceId(nextConversationId, nextUserId),
      touchConversation: (id) => this.conversations.touchConversation(id),
      messages,
      userId,
      conversationId,
    });
  }

  /** Apply delayed usage metadata after an assistant message is replaced. */
  async applyEnrichmentUsage(
    userId: string,
    conversationId: string,
    message: UIMessage,
    previousModelId = '',
  ): Promise<void> {
    if (!this.usageAggregator?.applyEnrichmentUsage) return;

    if (message.role !== 'assistant') return;

    await this.usageAggregator.applyEnrichmentUsage(
      message,
      await this.conversations.resolveResourceId(conversationId, userId),
      conversationId,
      previousModelId,
    );
  }

  async getMessages(
    userId: string,
    conversationId: string,
    options?: GetMessagesOptions,
    _context?: any,
  ): Promise<any[]> {
    return readStoredMessages({
      paths: this.paths,
      resolveResourceId: (nextConversationId, nextUserId) =>
        this.conversations.resolveResourceId(nextConversationId, nextUserId),
      findConversationLocation: (id) =>
        this.conversations.loadConversationFromDisk(id).then((conversation) =>
          conversation
            ? {
                path: this.paths.getConversationPath(
                  conversation.resourceId,
                  conversation.id,
                ),
                resourceId: conversation.resourceId,
              }
            : null,
        ),
      userId,
      conversationId,
      options,
    });
  }

  async clearMessages(userId: string, conversationId?: string): Promise<void> {
    await clearStoredMessages({
      paths: this.paths,
      resolveResourceId: (nextConversationId, nextUserId) =>
        this.conversations.resolveResourceId(nextConversationId, nextUserId),
      getConversationsByUserId: (id) => this.getConversationsByUserId(id),
      userId,
      conversationId,
    });
  }

  async removeLastMessage(
    userId: string,
    conversationId: string,
  ): Promise<void> {
    await removeLastStoredMessage({
      paths: this.paths,
      resolveResourceId: (nextConversationId, nextUserId) =>
        this.conversations.resolveResourceId(nextConversationId, nextUserId),
      userId,
      conversationId,
    });
  }

  async deleteMessages(
    messageIds: string[],
    userId: string,
    conversationId: string,
  ): Promise<void> {
    await deleteStoredMessages({
      paths: this.paths,
      resolveResourceId: (nextConversationId, nextUserId) =>
        this.conversations.resolveResourceId(nextConversationId, nextUserId),
      touchConversation: (nextConversationId) =>
        this.conversations.touchConversation(nextConversationId),
      messageIds,
      userId,
      conversationId,
    });
  }

  // ===========================================================================
  // Conversation Operations
  // ===========================================================================

  async createConversation(
    input: CreateConversationInput,
  ): Promise<Conversation> {
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: input.id,
      resourceId: input.resourceId,
      userId: input.userId,
      title: input.title,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    await this.conversations.persistConversation(conversation);
    return conversation;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const conversation = await this.conversations.loadConversationFromDisk(id);
    return conversation ? { ...conversation } : null;
  }

  async getConversations(resourceId: string): Promise<Conversation[]> {
    const conversations =
      await this.conversations.listAgentConversations(resourceId);
    return applyConversationQueryOptions(conversations);
  }

  async getConversationsByUserId(
    userId: string,
    options?: Omit<ConversationQueryOptions, 'userId'>,
  ): Promise<Conversation[]> {
    const conversations = await this.conversations.loadAllConversations();
    return applyConversationQueryOptions(conversations, { ...options, userId });
  }

  async queryConversations(
    options: ConversationQueryOptions,
  ): Promise<Conversation[]> {
    const conversations = await this.conversations.loadAllConversations();
    return applyConversationQueryOptions(conversations, options);
  }

  async countConversations(options: ConversationQueryOptions): Promise<number> {
    const conversations = await this.conversations.loadAllConversations();
    return applyConversationQueryOptions(conversations, {
      ...options,
      limit: undefined,
      offset: undefined,
    }).length;
  }

  /**
   * Accepts either the pre-#1566 object form (a static partial patch) or an
   * updater function `(current) => partial | null`. Both forms now run their
   * ENTIRE read-compute-write through `this.conversations.updateConversation`
   * — the same serialized per-conversation queue `persistConversation` uses
   * — closing the TOCTOU a separate outer `getConversation` read used to
   * leave open (station#1566 review HIGH): a concurrent write queued in
   * between could be silently overwritten by this one computing from a
   * stale snapshot. The object form is wrapped in an updater that ignores
   * `current` and returns the same static patch every time — it never
   * skips (`null`) — so its write behavior versus the old implementation is
   * unchanged; only the object form's OWN merge base is now guaranteed
   * fresh-at-write-time rather than fresh-at-call-time.
   */
  async updateConversation(
    id: string,
    updates:
      | Partial<Omit<Conversation, 'id' | 'createdAt' | 'updatedAt'>>
      | ((
          current: Conversation,
        ) => Partial<
          Omit<Conversation, 'id' | 'createdAt' | 'updatedAt'>
        > | null),
  ): Promise<Conversation> {
    const updater = typeof updates === 'function' ? updates : () => updates;
    return this.conversations.updateConversation(id, updater);
  }

  async deleteConversation(id: string): Promise<void> {
    const conversation = await this.getConversation(id);
    if (!conversation) {
      return;
    }

    await this.conversations.deleteConversationAssets(
      conversation.resourceId,
      id,
    );
  }

  // ===========================================================================
  // Working Memory
  // ===========================================================================

  async getWorkingMemory(params: {
    conversationId?: string;
    userId?: string;
    scope: WorkingMemoryScope;
  }): Promise<string | null> {
    return getWorkingMemoryStateFile({
      paths: this.paths,
      resolveResourceId: (conversationId, userId) =>
        this.conversations.resolveResourceId(conversationId, userId),
      conversationId: params.conversationId,
      userId: params.userId,
      scope: params.scope,
    });
  }

  async setWorkingMemory(params: {
    conversationId?: string;
    userId?: string;
    content: string;
    scope: WorkingMemoryScope;
  }): Promise<void> {
    await setWorkingMemoryStateFile({
      paths: this.paths,
      resolveResourceId: (conversationId, userId) =>
        this.conversations.resolveResourceId(conversationId, userId),
      conversationId: params.conversationId,
      userId: params.userId,
      content: params.content,
      scope: params.scope,
    });
  }

  async deleteWorkingMemory(params: {
    conversationId?: string;
    userId?: string;
    scope: WorkingMemoryScope;
  }): Promise<void> {
    await deleteWorkingMemoryStateFile({
      paths: this.paths,
      resolveResourceId: (conversationId, userId) =>
        this.conversations.resolveResourceId(conversationId, userId),
      conversationId: params.conversationId,
      userId: params.userId,
      scope: params.scope,
    });
  }

  // ===========================================================================
  // Workflow State
  // ===========================================================================

  async getWorkflowState(
    executionId: string,
  ): Promise<WorkflowStateEntry | null> {
    return getWorkflowStateEntryFromFile(this.paths, executionId);
  }

  async queryWorkflowRuns(_query: any): Promise<WorkflowStateEntry[]> {
    return [];
  }

  async setWorkflowState(
    executionId: string,
    state: WorkflowStateEntry,
  ): Promise<void> {
    await setWorkflowStateEntryFile(this.paths, executionId, state);
  }

  async updateWorkflowState(
    executionId: string,
    updates: Partial<WorkflowStateEntry>,
  ): Promise<void> {
    const existing = await this.getWorkflowState(executionId);
    if (!existing) {
      throw new Error(`Workflow state ${executionId} not found`);
    }

    const merged: WorkflowStateEntry = {
      ...existing,
      ...updates,
      createdAt: existing.createdAt,
      updatedAt: updates.updatedAt ?? new Date(),
    };

    if (merged.suspension && existing.suspension) {
      merged.suspension = {
        ...existing.suspension,
        ...updates.suspension,
      };
    }

    await this.setWorkflowState(executionId, merged);
  }

  async getSuspendedWorkflowStates(
    workflowId: string,
  ): Promise<WorkflowStateEntry[]> {
    return getSuspendedWorkflowStateEntriesFromFiles(this.paths, workflowId);
  }
}
