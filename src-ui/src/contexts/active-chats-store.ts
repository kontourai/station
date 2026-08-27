import { migrateSnoozeKey } from '../utils/activity-snooze-store';
import { log } from '../utils/logger';
import {
  type ActiveChatMetadata,
  type ActiveChatsMap,
  type ActiveChatsStoreOptions,
  appendInputHistory,
  assignConversationIdState,
  type BackendTimestampMessage,
  type ChatUIState,
  clearEphemeralMessagesState,
  clearInputState,
  clearQueueState,
  createDefaultChatState,
  createEphemeralMessageState,
  defaultBackendMessages,
  editQueuedMessageState,
  hydrateActiveChats,
  mergeChatUpdates,
  navigateHistoryDownState,
  navigateHistoryUpState,
  QUEUED_MESSAGES_MAX_COUNT,
  removeQueuedMessageState,
  reorderQueuedMessageState,
  serializeActiveChats,
} from './active-chats-state';

export type {
  ActiveChatMetadata,
  ActiveChatsMap,
  ActiveChatsStoreOptions,
  BackendTimestampMessage,
  ChatUIState,
} from './active-chats-state';

// Constructed in unit tests via dynamic import; the app uses the singleton below.
// fallow-ignore-next-line unused-export
export class ActiveChatsStore {
  private chats: ActiveChatsMap = {};
  private listeners = new Set<() => void>();
  private snapshot = this.chats;
  private readonly storageKey: string;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  private getBackendMessages: (
    agentSlug: string,
    conversationId: string,
  ) => BackendTimestampMessage[];
  private readonly now: () => number;
  private readonly randomId: () => string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Which chats have already been told about the CURRENT run of refused
   * writes. UX audit T3 review round 3: this was one store-wide latch, so a
   * write that failed while no chat held a queue consumed it, and every queue
   * created afterwards stayed silent until some write happened to succeed. The
   * notice is per chat, so a chat that acquires a queue during a failure run
   * still gets told.
   */
  private storageFailureReportedFor = new Set<string>();

  constructor(options: ActiveChatsStoreOptions = {}) {
    this.storageKey = options.storageKey ?? 'activeChats';
    this.storage =
      options.storage ??
      (typeof window !== 'undefined' ? window.sessionStorage : null);
    this.getBackendMessages =
      options.getBackendMessages ?? defaultBackendMessages;
    this.now = options.now ?? (() => Date.now());
    this.randomId = options.randomId ?? (() => Math.random().toString(36));
    this.loadFromStorage();
  }

  private loadFromStorage() {
    try {
      const stored = this.storage?.getItem(this.storageKey);
      if (!stored) {
        return;
      }
      const minimal = JSON.parse(stored) as Parameters<
        typeof hydrateActiveChats
      >[0];
      this.chats = hydrateActiveChats(minimal);
      this.snapshot = this.chats;
    } catch (error) {
      log.api('Failed to load active chats from sessionStorage:', error);
    }
  }

  private saveToStorage() {
    try {
      const minimal = serializeActiveChats(this.chats);
      this.storage?.setItem(this.storageKey, JSON.stringify(minimal));
      // A write got through: the run is over and a later failure is news
      // again, for every chat.
      this.storageFailureReportedFor.clear();
    } catch (error) {
      log.api('Failed to save active chats to sessionStorage:', error);
      // UX audit T3 review: this used to be console-only. A failed write means
      // the follow-ups this chat is holding will NOT survive a reload, and the
      // one place that matters is the chat holding them — so say it there,
      // once per chat per failure run, rather than leaving the user to
      // believe their text is safe.
      let notified = false;
      for (const [sessionId, chat] of Object.entries(this.chats)) {
        // station#3706 review (HIGH): unsent records are held on the same
        // promise as queued follow-ups — a chat whose queue is empty but
        // whose "Not sent" rows are populated was the exact state a
        // permanent drop creates, and a refused write left those rows
        // LOOKING retained while reload would destroy them.
        if (!chat.queuedMessages?.length && !chat.unsentMessages?.length)
          continue;
        if (this.storageFailureReportedFor.has(sessionId)) continue;
        this.storageFailureReportedFor.add(sessionId);
        this.appendSystemNotice(
          sessionId,
          'This browser refused to save the messages this chat is holding for you, so they will not survive a reload. Copy anything you need to keep.',
        );
        notified = true;
      }
      if (notified) this.notify(false);
    }
  }

  private debouncedSave = () => {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveToStorage();
      this.saveTimer = null;
    }, 300);
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  /**
   * Locate the durable chat that owns an execution-session event. Runtime
   * events intentionally retain their exact child `threadId`; this lookup is
   * the UI projection seam that lets a conversation tab consume those events
   * without rewriting their provenance.
   */
  getChatForExecutionSession(sessionId: string): ChatUIState | undefined {
    const key = this.getChatKeyForExecutionSession(sessionId);
    return key ? this.chats[key] : undefined;
  }

  /** Durable store key for an exact execution-session identity. */
  getChatKeyForExecutionSession(sessionId: string): string | undefined {
    if (this.chats[sessionId]) return sessionId;
    return Object.entries(this.chats).find(
      ([, chat]) =>
        chat.currentSessionId === sessionId ||
        chat.conversationId === sessionId,
    )?.[0];
  }

  setBackendMessagesResolver(
    resolver: (
      agentSlug: string,
      conversationId: string,
    ) => BackendTimestampMessage[],
  ) {
    this.getBackendMessages = resolver;
  }

  private notify = (persist = false) => {
    this.snapshot = { ...this.chats };
    if (persist) {
      this.debouncedSave();
    }
    this.listeners.forEach((listener) => listener());
  };

  initChat(sessionId: string, metadata?: ActiveChatMetadata) {
    if (this.chats[sessionId]) {
      return;
    }
    // station#1795: stamp the real creation time through the store's own
    // clock (already the single source of truth `now` used everywhere else
    // in this store) rather than letting `createDefaultChatState` fall back
    // to its own `Date.now()` default — keeps every store-created chat on
    // one clock, real or fake, including in tests that inject `now`.
    this.chats[sessionId] = createDefaultChatState(metadata, this.now());
    this.notify(true);
  }

  updateChat(sessionId: string, updates: Partial<ChatUIState>) {
    const targetSessionId = this.getChatKeyForExecutionSession(sessionId);
    const current = targetSessionId ? this.chats[targetSessionId] : undefined;
    if (!current) {
      return;
    }
    const { chat, shouldPersist, droppedQueuedMessages } = mergeChatUpdates(
      current,
      updates,
    );
    this.chats[targetSessionId!] = chat;
    // UX audit T3 review: a bounded queue that discards silently is the same
    // loss the ceiling exists to make safe. Say what was dropped, with the
    // text, so it can be copied back out.
    if (droppedQueuedMessages.length > 0) {
      this.appendSystemNotice(
        sessionId,
        `This chat can hold ${QUEUED_MESSAGES_MAX_COUNT} queued follow-ups; the oldest ${
          droppedQueuedMessages.length === 1
            ? 'one was'
            : `${droppedQueuedMessages.length} were`
        } removed to make room.\nRemoved: ${droppedQueuedMessages.join('\nRemoved: ')}`,
      );
    }
    this.notify(shouldPersist);
  }

  /**
   * A system notice on one chat, without going through `addEphemeralMessage`'s
   * public notify (the callers below are already inside their own
   * notify cycle, and a second one would render an intermediate state).
   */
  private appendSystemNotice(sessionId: string, content: string) {
    const chat = this.chats[sessionId];
    if (!chat) return;
    const next = createEphemeralMessageState(
      chat,
      { role: 'system', content },
      this.now,
      this.randomId,
      this.getBackendMessages,
      chat.conversationId ?? sessionId,
    );
    if (next) this.chats[sessionId] = next;
  }

  removeChat(sessionId: string) {
    delete this.chats[sessionId];
    // A chat re-created under the same id is a different chat, and is owed its
    // own storage-refusal notice.
    this.storageFailureReportedFor.delete(sessionId);
    this.notify(true);
  }

  clearInput(sessionId: string) {
    const current = this.chats[sessionId];
    if (!current) {
      return;
    }
    this.chats[sessionId] = clearInputState(current);
    this.notify(false);
  }

  navigateHistoryUp(sessionId: string) {
    const chat = this.chats[sessionId];
    if (!chat) {
      return;
    }
    const next = navigateHistoryUpState(chat);
    if (!next) {
      return;
    }
    this.chats[sessionId] = next;
    this.notify(false);
  }

  navigateHistoryDown(sessionId: string) {
    const chat = this.chats[sessionId];
    if (!chat) {
      return;
    }
    const next = navigateHistoryDownState(chat);
    if (!next) {
      return;
    }
    this.chats[sessionId] = next;
    this.notify(false);
  }

  addEphemeralMessage(
    sessionId: string,
    message: {
      role: 'user' | 'assistant' | 'system';
      content: string;
      attachments?: any[];
      action?: { label: string; handler: () => void };
    },
  ) {
    const chat = this.chats[sessionId];
    if (!chat) {
      return;
    }
    const backendConversationId = chat.conversationId ?? sessionId;
    const next = createEphemeralMessageState(
      chat,
      message,
      this.now,
      this.randomId,
      this.getBackendMessages,
      backendConversationId,
    );
    if (!next) {
      return;
    }
    this.chats[sessionId] = next;
    this.notify(true);
  }

  clearEphemeralMessages(sessionId: string) {
    const chat = this.chats[sessionId];
    if (!chat) {
      return;
    }
    this.chats[sessionId] = clearEphemeralMessagesState(chat);
    this.notify(true);
  }

  assignConversationId(sessionId: string, conversationId: string) {
    const chat = this.chats[sessionId];
    if (!chat) {
      return;
    }
    this.chats[sessionId] = assignConversationIdState(chat, conversationId);
    // This is the transition from an ephemeral tab to a durable conversation.
    // Persist it synchronously so an immediate reload/navigation cannot lose
    // the session while the ordinary 300 ms coalescing timer is still pending.
    this.saveToStorage();
    // station#1311 review (MEDIUM fix): `HomeWorkItem.id` for this chat
    // reads as `sessionId` (the store key) until now and as `conversationId`
    // from this point on — a snooze set during that window was written
    // under the old id and would otherwise silently stop matching. Migrate
    // it to the new key at the exact moment of promotion, the one place
    // both ids are known together.
    try {
      migrateSnoozeKey(sessionId, conversationId, this.now());
    } catch {
      /* ignore — snooze migration is a convenience, never load-bearing for
       * chat state itself. */
    }
    this.notify(false);
  }

  removeQueuedMessage(sessionId: string, index: number) {
    const chat = this.chats[sessionId];
    if (!chat) {
      return;
    }
    this.chats[sessionId] = removeQueuedMessageState(chat, index);
    // UX audit T3 review: the queue is persisted content, so every edit to it
    // has to schedule a write — reorder/edit/remove/clear included, or a
    // reload restores a queue the user has already changed.
    this.notify(true);
  }

  editQueuedMessage(sessionId: string, index: number, newContent: string) {
    const chat = this.chats[sessionId];
    if (!chat) {
      return;
    }
    this.chats[sessionId] = editQueuedMessageState(chat, index, newContent);
    // UX audit T3 review: the queue is persisted content, so every edit to it
    // has to schedule a write — reorder/edit/remove/clear included, or a
    // reload restores a queue the user has already changed.
    this.notify(true);
  }

  reorderQueuedMessage(sessionId: string, fromIndex: number, toIndex: number) {
    const chat = this.chats[sessionId];
    if (!chat) {
      return;
    }
    this.chats[sessionId] = reorderQueuedMessageState(chat, fromIndex, toIndex);
    // UX audit T3 review: the queue is persisted content, so every edit to it
    // has to schedule a write — reorder/edit/remove/clear included, or a
    // reload restores a queue the user has already changed.
    this.notify(true);
  }

  clearQueue(sessionId: string) {
    const chat = this.chats[sessionId];
    if (!chat) {
      return;
    }
    this.chats[sessionId] = clearQueueState(chat);
    // UX audit T3 review: the queue is persisted content, so every edit to it
    // has to schedule a write — reorder/edit/remove/clear included, or a
    // reload restores a queue the user has already changed.
    this.notify(true);
  }

  addToInputHistory(sessionId: string, input: string) {
    const chat = this.chats[sessionId];
    if (!chat) {
      return;
    }
    this.chats[sessionId] = appendInputHistory(chat, input);
    this.notify(true);
  }
}

export const activeChatsStore = new ActiveChatsStore();
