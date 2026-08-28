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

class ConversationsStore {
  private conversations: ConversationsMap = {};
  private messages: MessagesMap = {};
  private statuses: StatusMap = {};
  private listeners = new Set<() => void>();
  private fetching = new Map<string, Promise<boolean>>();
  private snapshot = {
    conversations: this.conversations,
    messages: this.messages,
    statuses: this.statuses,
  };

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
* row-open policy falls back to `/activity` instead. Every other caller
* (`useMessages`, `useActiveChatSessionMessaging`,
* `rehydrateChatSession`) already ignores the resolved value and reads
* `getSnapshot.messages` directly, so this is additive, not breaking.
*/
  async fetchMessages(
    _apiBase: string,
    agentSlug: string,
    conversationId: string,
    queryClient?: any,
  ): Promise<boolean> {
    const key = `messages:${agentSlug}:${conversationId}`;
    const inFlight = this.fetching.get(key);
    if (inFlight) {
      return inFlight;
    }

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

        this.messages[key] = await fetchConversationMessages(
          agentSlug,
          conversationId,
          toolMappings,
        );
        this.notify();
        return true;
      } catch (error) {
        log.api(`Failed to fetch messages for ${conversationId}:`, error);
        return false;
      } finally {
        this.fetching.delete(key);
      }
    })();

    this.fetching.set(key, promise);
    return promise;
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
      delete this.statuses[`${agentSlug}:${conversationId}`];
      this.notify();
    } catch (error) {
      log.api(`Failed to delete conversation ${conversationId}:`, error);
      throw error;
    }
  }
}

export const conversationsStore = new ConversationsStore();
