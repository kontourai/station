import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readSnoozes, writeSnooze } from '../utils/activity-snooze-store';

let ActiveChatsStore: typeof import('../contexts/active-chats-store').ActiveChatsStore;

/** A real in-memory `localStorage` double — the outer `beforeEach`'s stub is
 * a no-op (`getItem: => null`), which cannot observe a migration. */
class MemoryLocalStorage {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe('ActiveChatsStore', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
    });
    ({ ActiveChatsStore } = await import('../contexts/active-chats-store'));
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('rehydrates persisted session metadata', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'activeChats',
      JSON.stringify([
        {
          sessionId: 'agent:1',
          conversationId: 'conv-1',
          agentSlug: 'planner',
          model: 'sonnet',
          projectSlug: 'proj',
          inputHistory: ['/resume'],
        },
      ]),
    );

    const store = new ActiveChatsStore({ storage });

    expect(store.getSnapshot()).toEqual({
      'agent:1': {
        input: '',
        attachments: [],
        // archive#4151 made hydrateActiveChats derive this unconditionally — an
        // empty array is a real value the exact snapshot must carry (archive#4222).
        attachmentStages: [],
        queuedMessages: [],
        inputHistory: ['/resume'],
        hasUnread: false,
        agentSlug: 'planner',
        conversationId: 'conv-1',
        model: 'sonnet',
        projectSlug: 'proj',
        projectName: undefined,
        provider: undefined,
        providerId: undefined,
        providerOptions: {},
        agentConnectionId: undefined,
        executionMode: undefined,
        executionScope: undefined,
        currentModeId: undefined,
        orchestrationSessionStarted: false,
        orchestrationProvider: undefined,
        orchestrationModel: undefined,
        orchestrationStatus: undefined,
        planArtifact: null,
        flowRun: null,
        sessionAutoApprove: [],
        ephemeralMessages: [],
      },
    });
  });

  // archive#1795: initChat stamps the real creation time through the
  // store's own clock, not a literal 0 — the floor `latestChatTimestamp`
  // (home-view-model.ts) needs for a chat with no messages yet.
  test("initChat stamps a fresh chat with the store clock's current time as createdAt", () => {
    // A distinct injected clock, deliberately DIFFERENT from the fake system
    // time above it: proves the store threads its own `now` into
    // `createDefaultChatState` rather than relying on that function's own
    // `Date.now` default parameter (which would silently agree with the
    // real/faked system clock and mask a regression where the store forgot
    // to pass its clock through).
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    const injectedNow = Date.parse('2026-08-02T12:00:00Z');
    const store = new ActiveChatsStore({
      storage: new MemoryStorage(),
      now: () => injectedNow,
    });
    store.initChat('agent:fresh', {
      agentSlug: 'planner',
      agentName: 'Planner',
      title: 'Planner Chat',
    });

    expect(store.getSnapshot()['agent:fresh'].createdAt).toBe(injectedNow);
  });

  test('navigates input history and restores unsent input', () => {
    const store = new ActiveChatsStore({ storage: new MemoryStorage() });
    store.initChat('agent:2', {
      agentSlug: 'planner',
      agentName: 'Planner',
      title: 'Planner Chat',
    });
    store.updateChat('agent:2', {
      input: 'draft',
      inputHistory: ['first', 'second'],
    });

    store.navigateHistoryUp('agent:2');
    expect(store.getSnapshot()['agent:2']).toMatchObject({
      input: 'second',
      historyIndex: 1,
      savedInput: 'draft',
    });

    store.navigateHistoryUp('agent:2');
    expect(store.getSnapshot()['agent:2']).toMatchObject({
      input: 'first',
      historyIndex: 0,
    });

    store.navigateHistoryDown('agent:2');
    expect(store.getSnapshot()['agent:2']).toMatchObject({
      input: 'second',
      historyIndex: 1,
    });

    store.navigateHistoryDown('agent:2');
    expect(store.getSnapshot()['agent:2']).toMatchObject({
      input: 'draft',
      historyIndex: -1,
      savedInput: undefined,
    });
  });

  test('uses the persisted conversation id when ordering ephemeral messages', () => {
    const store = new ActiveChatsStore({
      storage: new MemoryStorage(),
      now: () => 100,
      randomId: () => 'seed',
      getBackendMessages: (agentSlug, conversationId) => {
        expect(agentSlug).toBe('planner');
        expect(conversationId).toBe('conv-42');
        return [{ timestamp: '2026-01-01T00:00:05.000Z' }];
      },
    });

    store.initChat('planner:session', {
      agentSlug: 'planner',
      agentName: 'Planner',
      title: 'Planner Chat',
      conversationId: 'conv-42',
    });
    store.addEphemeralMessage('planner:session', {
      role: 'system',
      content: 'queued',
    });

    expect(
      store.getSnapshot()['planner:session'].ephemeralMessages?.[0],
    ).toMatchObject({
      id: 'ephemeral-100-seed',
      content: 'queued',
      ephemeral: true,
      timestamp: new Date('2026-01-01T00:00:05.000Z').getTime() + 1,
    });
  });

  test('reorders queued messages, notifies subscribers, and persists the new order (#613, UX audit T3)', () => {
    const storage = new MemoryStorage();
    const setItemSpy = vi.spyOn(storage, 'setItem');
    const store = new ActiveChatsStore({ storage });
    store.initChat('agent:3', {
      agentSlug: 'planner',
      agentName: 'Planner',
      title: 'Planner Chat',
      conversationId: 'conv-3',
    });
    store.updateChat('agent:3', { queuedMessages: ['a', 'b', 'c'] });
    // Drain whatever init/update already scheduled so the assertion below
    // isolates reorder's own (lack of) persist scheduling.
    vi.runAllTimers();
    setItemSpy.mockClear();

    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.reorderQueuedMessage('agent:3', 0, 2);

    expect(store.getSnapshot()['agent:3'].queuedMessages).toEqual([
      'b',
      'c',
      'a',
    ]);
    // Subscribers still re-render on reorder...
    expect(listener).toHaveBeenCalledTimes(1);

    //.and, since made the queue persisted content, reorder now
    // schedules a write like its sibling remove/edit/clear mutators. This
    // assertion previously pinned the opposite, which was correct only while
    // the queue was session-local: a reload otherwise restores an order the
    // user has already changed.
    vi.runAllTimers();
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(String(setItemSpy.mock.calls[0]?.[1])).toContain('"b","c","a"');

    unsubscribe();
  });

  test('ignores reorder for an unknown session', () => {
    const store = new ActiveChatsStore({ storage: new MemoryStorage() });
    expect(() =>
      store.reorderQueuedMessage('missing-session', 0, 1),
    ).not.toThrow();
  });

  test('persists only conversation-backed sessions after debounced updates', () => {
    const storage = new MemoryStorage();
    const store = new ActiveChatsStore({ storage });
    store.initChat('draft:1', {
      agentSlug: 'planner',
      agentName: 'Planner',
      title: 'Draft',
    });
    store.initChat('chat:1', {
      agentSlug: 'planner',
      agentName: 'Planner',
      title: 'Saved',
      conversationId: 'conv-1',
    });
    store.updateChat('chat:1', { model: 'sonnet' });

    vi.runAllTimers();

    expect(JSON.parse(storage.getItem('activeChats') || '[]')).toEqual([
      expect.objectContaining({
        sessionId: 'chat:1',
        conversationId: 'conv-1',
        model: 'sonnet',
      }),
    ]);
  });

  test('persists canonical conversation identity synchronously', () => {
    const storage = new MemoryStorage();
    const store = new ActiveChatsStore({ storage });
    store.initChat('runtime:1', {
      agentSlug: 'claude',
      agentName: 'Claude Runtime',
      title: 'Runtime chat',
      provider: 'claude',
    });

    store.assignConversationId('runtime:1', 'runtime:1');

    expect(JSON.parse(storage.getItem('activeChats') || '[]')).toEqual([
      expect.objectContaining({
        sessionId: 'runtime:1',
        conversationId: 'runtime:1',
        provider: 'claude',
      }),
    ]);
  });

  // archive#1311 a snooze set while a brand-new chat's
  // `HomeWorkItem.id` still reads as its local store key (no conversationId
  // yet) must not silently detach the moment `assignConversationId` flips
  // the canonical id over to the server-assigned conversationId.
  test('assignConversationId migrates an existing snooze from the pre-promotion store key to the new conversationId', () => {
    vi.stubGlobal('localStorage', new MemoryLocalStorage());
    const now = Date.now();
    writeSnooze('draft:1', now + 30 * 60 * 1000, now);

    const storage = new MemoryStorage();
    const store = new ActiveChatsStore({ storage });
    store.initChat('draft:1', {
      agentSlug: 'planner',
      agentName: 'Planner',
      title: 'Draft',
    });

    store.assignConversationId('draft:1', 'conv-999');

    const snoozes = readSnoozes(now);
    expect(snoozes['conv-999']).toBeDefined();
    expect(snoozes['draft:1']).toBeUndefined();
  });

  // No live snooze under the old key: assignConversationId must not
  // fabricate one under the new key either.
  test('assignConversationId is a no-op for snoozing when nothing was snoozed under the old key', () => {
    vi.stubGlobal('localStorage', new MemoryLocalStorage());
    const now = Date.now();

    const storage = new MemoryStorage();
    const store = new ActiveChatsStore({ storage });
    store.initChat('draft:2', {
      agentSlug: 'planner',
      agentName: 'Planner',
      title: 'Draft',
    });

    store.assignConversationId('draft:2', 'conv-888');

    const snoozes = readSnoozes(now);
    expect(snoozes['conv-888']).toBeUndefined();
    expect(snoozes['draft:2']).toBeUndefined();
  });
});

// review : the previous round's test called
// `serializeActiveChats`/`hydrateActiveChats` DIRECTLY, which bypasses the
// store's persistence decision entirely — so it passed while enqueueing a
// follow-up called `notify(false)` and scheduled no write at all. These drive
// the real store against a real storage double, which is the only place the
// defect was observable.
describe('ActiveChatsStore queued follow-up retention (UX audit T3)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
    });
    ({ ActiveChatsStore } = await import('../contexts/active-chats-store'));
  });
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function storeWith(storage: MemoryStorage) {
    const store = new ActiveChatsStore({ storage });
    store.initChat('agent:q', {
      agentSlug: 'claude',
      agentName: 'Claude Code',
      title: 'New chat',
      conversationId: 'conv-q',
    });
    vi.advanceTimersByTime(400);
    return store;
  }

  test('enqueueing a follow-up schedules a write a new store hydrates', () => {
    const storage = new MemoryStorage();
    const store = storeWith(storage);

    store.updateChat('agent:q', {
      queuedMessages: ['and then run the tests'],
    });
    vi.advanceTimersByTime(400);

    const restored = new ActiveChatsStore({ storage });
    expect(restored.getSnapshot()['agent:q']?.queuedMessages).toEqual([
      'and then run the tests',
    ]);
  });

  test('a recorded drain refusal survives with the message it is holding', () => {
    const storage = new MemoryStorage();
    const store = storeWith(storage);

    store.updateChat('agent:q', {
      queuedMessages: ['keep this follow-up'],
      queuedMessageFailure: {
        message: 'This conversation was started without a workspace.',
        code: 'continuation_workspace_unbound',
        at: 1,
      },
    });
    vi.advanceTimersByTime(400);

    const restored = new ActiveChatsStore({ storage });
    const chat = restored.getSnapshot()['agent:q'];
    expect(chat?.queuedMessages).toEqual(['keep this follow-up']);
    expect(chat?.queuedMessageFailure?.code).toBe(
      'continuation_workspace_unbound',
    );
  });

  // archive#3706: a Dismiss writes ONLY `unsentMessages`, and
  // that field was missing from mergeChatUpdates' shouldPersist list — so the
  // dismiss scheduled no storage write and a dismissed row RESURRECTED on
  // reload. Driven through the real store because that is the only layer the
  // defect was observable at (the direct serialize/hydrate tests passed
  // throughout, same as the note above).
  test('recording and dismissing an unsent record both persist', () => {
    const storage = new MemoryStorage();
    const store = storeWith(storage);

    store.updateChat('agent:q', {
      unsentMessages: [
        { id: 'u-1', content: 'refused text', reason: 'Refused.', at: 1 },
        { id: 'u-2', content: 'second refused', reason: 'Refused.', at: 2 },
      ],
    });
    vi.advanceTimersByTime(400);
    expect(
      new ActiveChatsStore({ storage }).getSnapshot()['agent:q']
        ?.unsentMessages,
    ).toHaveLength(2);

    // The dismiss: exactly what UnsentMessages.tsx writes — this field alone.
    store.updateChat('agent:q', {
      unsentMessages: [
        { id: 'u-2', content: 'second refused', reason: 'Refused.', at: 2 },
      ],
    });
    vi.advanceTimersByTime(400);

    const restored = new ActiveChatsStore({ storage });
    expect(
      restored.getSnapshot()['agent:q']?.unsentMessages?.map((r) => r.id),
    ).toEqual(['u-2']);
  });

  test('editing, reordering, removing and clearing the queue all persist', () => {
    const storage = new MemoryStorage();
    const store = storeWith(storage);
    store.updateChat('agent:q', { queuedMessages: ['one', 'two'] });
    vi.advanceTimersByTime(400);

    store.editQueuedMessage('agent:q', 1, 'two-edited');
    vi.advanceTimersByTime(400);
    expect(
      new ActiveChatsStore({ storage }).getSnapshot()['agent:q']
        ?.queuedMessages,
    ).toEqual(['one', 'two-edited']);

    store.reorderQueuedMessage('agent:q', 0, 1);
    vi.advanceTimersByTime(400);
    expect(
      new ActiveChatsStore({ storage }).getSnapshot()['agent:q']
        ?.queuedMessages,
    ).toEqual(['two-edited', 'one']);

    store.removeQueuedMessage('agent:q', 0);
    vi.advanceTimersByTime(400);
    expect(
      new ActiveChatsStore({ storage }).getSnapshot()['agent:q']
        ?.queuedMessages,
    ).toEqual(['one']);

    store.clearQueue('agent:q');
    vi.advanceTimersByTime(400);
    expect(
      new ActiveChatsStore({ storage }).getSnapshot()['agent:q']
        ?.queuedMessages,
    ).toEqual([]);
  });

  test('the queue is bounded by count, oldest first, and says what it dropped', () => {
    const storage = new MemoryStorage();
    const store = storeWith(storage);

    store.updateChat('agent:q', {
      queuedMessages: Array.from({ length: 52 }, (_, i) => `msg-${i}`),
    });
    vi.advanceTimersByTime(400);

    const chat = store.getSnapshot()['agent:q'];
    expect(chat?.queuedMessages).toHaveLength(50);
    expect(chat?.queuedMessages?.[0]).toBe('msg-2');
    expect(chat?.queuedMessages?.at(-1)).toBe('msg-51');
    const notice = chat?.ephemeralMessages?.at(-1)?.content ?? '';
    expect(notice).toContain('oldest 2 were removed');
    expect(notice).toContain('msg-0');
    expect(notice).toContain('msg-1');
  });

  test('the queue is bounded by size, and never discards the only message', () => {
    const storage = new MemoryStorage();
    const store = storeWith(storage);

    store.updateChat('agent:q', {
      queuedMessages: ['x'.repeat(40_000), 'y'.repeat(40_000)],
    });
    vi.advanceTimersByTime(400);
    expect(store.getSnapshot()['agent:q']?.queuedMessages).toEqual([
      'y'.repeat(40_000),
    ]);

    store.updateChat('agent:q', { queuedMessages: ['z'.repeat(200_000)] });
    expect(store.getSnapshot()['agent:q']?.queuedMessages).toHaveLength(1);
  });

  // 3 : the latch was store-wide, so a write
  // that failed while no chat held a queue consumed it, and every queue
  // created afterwards stayed silent until some write happened to succeed.
  test('a queue created after the first refused write is still told', () => {
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const store = new ActiveChatsStore({ storage: refusing });
    // The first refused write happens with NO queue anywhere.
    store.initChat('agent:q', {
      agentSlug: 'claude',
      agentName: 'Claude Code',
      title: 'New chat',
      conversationId: 'conv-q',
    });
    vi.advanceTimersByTime(400);
    expect(
      (store.getSnapshot()['agent:q']?.ephemeralMessages ?? []).length,
    ).toBe(0);

    // Only now does this chat acquire a queue.
    store.updateChat('agent:q', { queuedMessages: ['unsaved follow-up'] });
    vi.advanceTimersByTime(400);

    const notices = (
      store.getSnapshot()['agent:q']?.ephemeralMessages ?? []
    ).map((message) => message.content);
    expect(
      notices.some((text) => /will not survive a reload/i.test(text ?? '')),
    ).toBe(true);
    expect(
      notices.filter((text) => /will not survive a reload/i.test(text ?? ''))
        .length,
    ).toBe(1);
  });

  test('a second chat that acquires a queue mid-failure-run is told too', () => {
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const store = new ActiveChatsStore({ storage: refusing });
    for (const id of ['agent:a', 'agent:b']) {
      store.initChat(id, {
        agentSlug: 'claude',
        agentName: 'Claude Code',
        title: 'New chat',
        conversationId: `conv-${id}`,
      });
    }
    store.updateChat('agent:a', { queuedMessages: ['first'] });
    vi.advanceTimersByTime(400);
    store.updateChat('agent:b', { queuedMessages: ['second'] });
    vi.advanceTimersByTime(400);

    for (const id of ['agent:a', 'agent:b']) {
      const notices = (store.getSnapshot()[id]?.ephemeralMessages ?? []).map(
        (message) => message.content,
      );
      expect(
        notices.filter((text) => /will not survive a reload/i.test(text ?? ''))
          .length,
      ).toBe(1);
    }
  });

  test('a refused write is reported in the chat holding the queue, not only the console', () => {
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const store = new ActiveChatsStore({ storage: refusing });
    store.initChat('agent:q', {
      agentSlug: 'claude',
      agentName: 'Claude Code',
      title: 'New chat',
      conversationId: 'conv-q',
    });
    store.updateChat('agent:q', { queuedMessages: ['unsaved follow-up'] });
    vi.advanceTimersByTime(400);

    const notices = (
      store.getSnapshot()['agent:q']?.ephemeralMessages ?? []
    ).map((message) => message.content);
    expect(
      notices.some((text) => /will not survive a reload/i.test(text)),
    ).toBe(true);
  });
});

/**
 * archive#3782/archive#3765. `?chat=` and sessionStorage must name the SAME chat, so
 * the id the dock stamps and the id the serializer persists come from one
 * derivation rather than from two call sites that each pick a fallback.
 */
describe('activeChatDurableId', () => {
  test('is the conversation id once the first successful turn promoted the chat', async () => {
    const { activeChatDurableId, serializeActiveChats } = await import(
      '../contexts/active-chats-state'
    );
    const promoted = {
      'claude:1787505679249': {
        conversationId: 'claude:1787505679249',
        agentSlug: 'claude',
        messages: [],
      },
    } as never;

    expect(
      activeChatDurableId('claude:1787505679249', {
        conversationId: 'claude:1787505679249',
      }),
    ).toBe('claude:1787505679249');
    expect(serializeActiveChats(promoted)).toHaveLength(1);
  });

  test('falls back to the session id — never null — for a chat with no conversation yet', async () => {
    const { activeChatDurableId, serializeActiveChats } = await import(
      '../contexts/active-chats-state'
    );

    expect(activeChatDurableId('claude:1787505679249', undefined)).toBe(
      'claude:1787505679249',
    );
    expect(
      activeChatDurableId('claude:1787505679249', { conversationId: '' }),
    ).toBe('claude:1787505679249');
    // The unpromoted chat is deliberately NOT persisted: a durable identity is
    // what makes it restorable, and it does not have one yet.
    expect(
      serializeActiveChats({
        'claude:1787505679249': { agentSlug: 'claude', messages: [] },
      } as never),
    ).toEqual([]);
  });
});
