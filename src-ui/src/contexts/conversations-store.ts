import {
  deleteConversation as deleteConversationRequest,
  fetchConversationMessages,
} from '@kontourai/station-sdk';
import { log } from '@/utils/logger';
import type {
  ConversationData,
  ConversationStatus,
  MessageData,
} from './conversation-types';

type ConversationsMap = Record<string, ConversationData[]>;
type MessagesMap = Record<string, MessageData[]>;
type StatusMap = Record<string, ConversationStatus>;

// Open chats and mounted transcript readers are retained independently.
const INACTIVE_TRANSCRIPT_LIMIT = 20;

class ConversationsStore {
  private conversations: ConversationsMap = {};
  private messages: MessagesMap = {};
  private statuses: StatusMap = {};
  private listeners = new Set<() => void>();
  private fetching = new Map<
    string,
    { promise: Promise<boolean>; version: object }
  >();
  private nextFetchSequence = 0;
  private fetchScopes = new Map<
    string,
    { pending: number; publishedSequence: number }
  >();
  private snapshot = {
    conversations: this.conversations,
    messages: this.messages,
    statuses: this.statuses,
  };

  private recentMessages = new Map<string, true>();
  private readers = new Map<string, number>();
  private isActiveConversation: (key: string) => boolean = () => false;

  setActiveConversationReader(reader: (key: string) => boolean) {
    this.isActiveConversation = reader;
  }

  retainMessages(agentSlug: string, conversationId: string): () => void {
    const key = `messages:${agentSlug}:${conversationId}`;
    this.readers.set(key, (this.readers.get(key) ?? 0) + 1);
    if (this.recentMessages.has(key)) this.touchMessages(key);
    return () => {
      const remaining = (this.readers.get(key) ?? 1) - 1;
      if (remaining) this.readers.set(key, remaining);
      else this.readers.delete(key);
      if (this.pruneMessages()) this.notify();
    };
  }

  private touchMessages(key: string) {
    this.recentMessages.delete(key);
    this.recentMessages.set(key, true);
  }

  private pruneMessages(): boolean {
    const inactive = [...this.recentMessages.keys()].filter(
      (key) => !this.readers.has(key) && !this.isActiveConversation(key),
    );
    let changed = false;
    for (const key of inactive.slice(
      0,
      Math.max(0, inactive.length - INACTIVE_TRANSCRIPT_LIMIT),
    )) {
      this.recentMessages.delete(key);
      delete this.messages[key];
      changed = true;
    }
    return changed;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private notify = () => {
    this.snapshot = {
      conversations: this.conversations,
      messages: this.messages,
      statuses: this.statuses,
    };
    this.listeners.forEach((listener) => listener());
  };

  setStatus(
    agentSlug: string,
    conversationId: string,
    status: ConversationStatus,
  ) {
    const key = `${agentSlug}:${conversationId}`;
    this.statuses[key] = status;
    this.notify();
  }

  /**
   * archive#1312: returns whether the fetch actually succeeded —
   * `false` on error, never a thrown rejection (the error is still logged
   * and swallowed, same as before, for callers that only read the store's
   * snapshot afterward). `useOpenConversation` (archive#1297's rehydrate
   * path) is the one caller that now checks this: a fetch failure there
   * must not silently leave a live, permanently empty chat tab with no
   * error — it needs to know to undo the tab and report failure so the
   * row-open policy reveals Activity instead. Every other caller
   * (`useMessages`, `useActiveChatSessionMessaging`,
   * `rehydrateChatSession`) already ignores the resolved value and reads
   * `getSnapshot.messages` directly, so this is additive, not breaking.
   */
  async fetchMessages(
    _apiBase: string,
    agentSlug: string,
    conversationId: string,
    queryClient?: any,
    isCurrent?: () => boolean,
  ): Promise<boolean> {
    const key = `messages:${agentSlug}:${conversationId}`;
    const inFlight = this.fetching.get(key);
    if (inFlight && !isCurrent) {
      return inFlight.promise;
    }

    const version = {};
    const sequence = ++this.nextFetchSequence;
    const scope = this.fetchScopes.get(key) ?? {
      pending: 0,
      publishedSequence: 0,
    };
    scope.pending += 1;
    this.fetchScopes.set(key, scope);
    const promise = (async (): Promise<boolean> => {
      try {
        let toolMappings: Record<
          string,
          { server?: string; toolName?: string; originalName?: string }
        > = {};
        if (queryClient) {
          const cachedTools = queryClient.getQueryData([
            'agentTools',
            agentSlug,
          ]);
          if (cachedTools) {
            toolMappings = cachedTools.reduce((acc: any, tool: any) => {
              acc[tool.name] = {
                server: tool.server,
                toolName: tool.toolName,
                originalName: tool.originalName,
              };
              return acc;
            }, {});
          }
        }

        const messages = await fetchConversationMessages(
          agentSlug,
          conversationId,
          toolMappings,
        );
        if (this.fetchScopes.get(key) !== scope || isCurrent?.() === false)
          return false;
        // A successful older read must not replace a newer published transcript.
        if (sequence > scope.publishedSequence) {
          scope.publishedSequence = sequence;
          this.messages[key] = messages;
          this.touchMessages(key);
          this.pruneMessages();
          this.notify();
        }
        return true;
      } catch (error) {
        log.api(`Failed to fetch messages for ${conversationId}:`, error);
        return false;
      } finally {
        scope.pending -= 1;
        if (scope.pending === 0 && this.fetchScopes.get(key) === scope)
          this.fetchScopes.delete(key);
        if (this.fetching.get(key)?.version === version)
          this.fetching.delete(key);
      }
    })();

    if (!isCurrent) this.fetching.set(key, { promise, version });
    return promise;
  }

  forgetConversation(agentSlug: string, conversationId: string) {
    const key = `messages:${agentSlug}:${conversationId}`;
    this.fetchScopes.delete(key);
    this.fetching.delete(key);
    delete this.messages[key];
    this.recentMessages.delete(key);
    delete this.statuses[`${agentSlug}:${conversationId}`];
    this.notify();
  }

  async refreshMessages(
    apiBase: string,
    agentSlug: string,
    conversationId: string,
    queryClient?: any,
  ): Promise<boolean> {
    const key = `messages:${agentSlug}:${conversationId}`;
    this.fetching.delete(key);
    return this.fetchMessages(apiBase, agentSlug, conversationId, queryClient);
  }

  async deleteConversation(
    _apiBase: string,
    agentSlug: string,
    conversationId: string,
  ) {
    try {
      await deleteConversationRequest(agentSlug, conversationId);
      this.conversations[agentSlug] = (
        this.conversations[agentSlug] || []
      ).filter((conversation) => conversation.id !== conversationId);
      delete this.messages[`messages:${agentSlug}:${conversationId}`];
      this.recentMessages.delete(`messages:${agentSlug}:${conversationId}`);
      delete this.statuses[`${agentSlug}:${conversationId}`];
      this.notify();
    } catch (error) {
      log.api(`Failed to delete conversation ${conversationId}:`, error);
      throw error;
    }
  }
}

export const conversationsStore = new ConversationsStore();
