import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let activeChatsStore: import('../../../contexts/active-chats-store').ActiveChatsStore;
let handleTokenUsageUpdatedEvent: typeof import('../usageHandlers').handleTokenUsageUpdatedEvent;

const threadId = 'thread-usage-1';

describe('handleTokenUsageUpdatedEvent', () => {
  beforeEach(async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
    });
    vi.resetModules();

    vi.doMock('../../../contexts/active-chats-store', async () => {
      const actual = await vi.importActual<
        typeof import('../../../contexts/active-chats-store')
      >('../../../contexts/active-chats-store');
      const store = new actual.ActiveChatsStore({
        storage: { getItem: () => null, setItem: () => {} },
      });
      return { ...actual, activeChatsStore: store };
    });

    ({ activeChatsStore } = await import(
      '../../../contexts/active-chats-store'
    ));
    ({ handleTokenUsageUpdatedEvent } = await import('../usageHandlers'));

    activeChatsStore.initChat(threadId, {
      agentSlug: 'claude',
      agentName: 'Claude Code',
      title: 'Claude Chat',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../../contexts/active-chats-store');
    vi.resetModules();
  });

  test('stores the event numbers on the chat as liveUsage', () => {
    handleTokenUsageUpdatedEvent({
      eventId: 'evt-1',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-29T00:00:00.000Z',
      method: 'token-usage.updated',
      promptTokens: 120,
      completionTokens: 40,
      totalTokens: 160,
      cacheReadTokens: 10,
    });

    expect(activeChatsStore.getSnapshot()[threadId]?.liveUsage).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      totalTokens: 160,
      cacheReadTokens: 10,
    });
  });

  test('a later event replaces the earlier one rather than accumulating', () => {
    handleTokenUsageUpdatedEvent({
      eventId: 'evt-1',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-29T00:00:00.000Z',
      method: 'token-usage.updated',
      promptTokens: 100,
      completionTokens: 40,
      totalTokens: 140,
    });
    handleTokenUsageUpdatedEvent({
      eventId: 'evt-2',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-29T00:00:05.000Z',
      method: 'token-usage.updated',
      promptTokens: 150,
      completionTokens: 60,
      totalTokens: 210,
    });

    expect(activeChatsStore.getSnapshot()[threadId]?.liveUsage).toEqual({
      inputTokens: 150,
      outputTokens: 60,
      totalTokens: 210,
    });
  });

  test('derives totalTokens from prompt+completion when absent', () => {
    handleTokenUsageUpdatedEvent({
      eventId: 'evt-1',
      provider: 'codex',
      threadId,
      createdAt: '2026-07-29T00:00:00.000Z',
      method: 'token-usage.updated',
      promptTokens: 10,
      completionTokens: 5,
    });

    expect(
      activeChatsStore.getSnapshot()[threadId]?.liveUsage?.totalTokens,
    ).toBe(15);
  });

  test('a prompt-only frame derives a total with the carried completion', () => {
    handleTokenUsageUpdatedEvent({
      eventId: 'evt-full',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-29T00:00:00.000Z',
      method: 'token-usage.updated',
      promptTokens: 120,
      completionTokens: 40,
      totalTokens: 160,
    });
    handleTokenUsageUpdatedEvent({
      eventId: 'evt-prompt',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-29T00:00:01.000Z',
      method: 'token-usage.updated',
      promptTokens: 200,
    });

    expect(activeChatsStore.getSnapshot()[threadId]?.liveUsage).toEqual({
      inputTokens: 200,
      outputTokens: 40,
      totalTokens: 240,
    });
  });

  test('a completion-only frame derives a total with the carried prompt', () => {
    handleTokenUsageUpdatedEvent({
      eventId: 'evt-full',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-29T00:00:00.000Z',
      method: 'token-usage.updated',
      promptTokens: 120,
      completionTokens: 40,
      totalTokens: 160,
    });
    handleTokenUsageUpdatedEvent({
      eventId: 'evt-completion',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-29T00:00:01.000Z',
      method: 'token-usage.updated',
      completionTokens: 55,
    });

    expect(activeChatsStore.getSnapshot()[threadId]?.liveUsage).toEqual({
      inputTokens: 120,
      outputTokens: 55,
      totalTokens: 175,
    });
  });

  test('keeps ACP context usage exact without fabricating token categories', () => {
    handleTokenUsageUpdatedEvent({
      eventId: 'evt-acp-1',
      provider: 'acp',
      threadId,
      createdAt: '2026-07-29T00:00:00.000Z',
      method: 'token-usage.updated',
      contextTokens: 0,
      contextWindowTokens: 200_000,
    });

    expect(activeChatsStore.getSnapshot()[threadId]?.liveUsage).toEqual({
      contextTokens: 0,
      contextWindowTokens: 200_000,
    });
  });

  test('a context-only frame retains token fields from the prior frame', () => {
    handleTokenUsageUpdatedEvent({
      eventId: 'evt-tokens',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-29T00:00:00.000Z',
      method: 'token-usage.updated',
      promptTokens: 120,
      completionTokens: 40,
      totalTokens: 160,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    });
    handleTokenUsageUpdatedEvent({
      eventId: 'evt-context',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-29T00:00:01.000Z',
      method: 'token-usage.updated',
      contextTokens: 4_096,
      contextWindowTokens: 200_000,
    });

    expect(activeChatsStore.getSnapshot()[threadId]?.liveUsage).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      totalTokens: 160,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      contextTokens: 4_096,
      contextWindowTokens: 200_000,
    });
  });

  test('a cache-only frame retains token fields from the prior frame', () => {
    handleTokenUsageUpdatedEvent({
      eventId: 'evt-tokens',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-29T00:00:00.000Z',
      method: 'token-usage.updated',
      promptTokens: 120,
      completionTokens: 40,
      totalTokens: 160,
    });
    handleTokenUsageUpdatedEvent({
      eventId: 'evt-cache',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-29T00:00:01.000Z',
      method: 'token-usage.updated',
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    });

    expect(activeChatsStore.getSnapshot()[threadId]?.liveUsage).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      totalTokens: 160,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    });
  });

  test('ignores an event for a thread with no active chat', () => {
    handleTokenUsageUpdatedEvent({
      eventId: 'evt-1',
      provider: 'claude',
      threadId: 'thread-does-not-exist',
      createdAt: '2026-07-29T00:00:00.000Z',
      method: 'token-usage.updated',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });

    expect(
      activeChatsStore.getSnapshot()['thread-does-not-exist'],
    ).toBeUndefined();
  });
});
