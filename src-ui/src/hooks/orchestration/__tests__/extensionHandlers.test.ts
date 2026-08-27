import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let activeChatsStore: import('../../../contexts/active-chats-store').ActiveChatsStore;
let handleExtensionNotificationEvent: typeof import('../extensionHandlers').handleExtensionNotificationEvent;

const threadId = 'thread-ext-1';

describe('handleExtensionNotificationEvent', () => {
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
    ({ handleExtensionNotificationEvent } = await import(
      '../extensionHandlers'
    ));

    activeChatsStore.initChat(threadId, {
      agentSlug: 'kiro-agent',
      agentName: 'Kiro',
      title: 'Kiro Chat',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../../contexts/active-chats-store');
    vi.resetModules();
  });

  test('_kiro.dev/mcp/oauth_request renders an ephemeral message with a clickable auth link', () => {
    handleExtensionNotificationEvent({
      eventId: 'evt-1',
      provider: 'acp',
      threadId,
      createdAt: '2026-07-03T00:00:00.000Z',
      method: 'extension.notification',
      namespace: '_kiro.dev',
      type: 'mcp/oauth_request',
      payload: { url: 'https://example.com/oauth/authorize' },
    });

    const chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.ephemeralMessages).toHaveLength(1);
    expect(chat?.ephemeralMessages?.[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining(
        '[Open authentication page](https://example.com/oauth/authorize)',
      ),
    });
  });

  test('_kiro.dev/compaction/status renders a plain-text status line', () => {
    handleExtensionNotificationEvent({
      eventId: 'evt-1',
      provider: 'acp',
      threadId,
      createdAt: '2026-07-03T00:00:00.000Z',
      method: 'extension.notification',
      namespace: '_kiro.dev',
      type: 'compaction/status',
      payload: {},
    });

    const chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.ephemeralMessages).toHaveLength(1);
    expect(chat?.ephemeralMessages?.[0]).toMatchObject({
      role: 'system',
      content: 'Context compacted.',
    });
  });

  test('_kiro.dev/clear/status renders a plain-text status line', () => {
    handleExtensionNotificationEvent({
      eventId: 'evt-1',
      provider: 'acp',
      threadId,
      createdAt: '2026-07-03T00:00:00.000Z',
      method: 'extension.notification',
      namespace: '_kiro.dev',
      type: 'clear/status',
      payload: {},
    });

    const chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.ephemeralMessages).toHaveLength(1);
    expect(chat?.ephemeralMessages?.[0]).toMatchObject({
      role: 'system',
      content: 'History cleared.',
    });
  });

  test('status events prefer an explicit payload.message over the fallback text', () => {
    handleExtensionNotificationEvent({
      eventId: 'evt-1',
      provider: 'acp',
      threadId,
      createdAt: '2026-07-03T00:00:00.000Z',
      method: 'extension.notification',
      namespace: '_kiro.dev',
      type: 'compaction/status',
      payload: { message: 'Compacted 42 messages.' },
    });

    const chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.ephemeralMessages?.[0]).toMatchObject({
      content: 'Compacted 42 messages.',
    });
  });

  test('an unrelated namespace/type is a no-op', () => {
    handleExtensionNotificationEvent({
      eventId: 'evt-1',
      provider: 'acp',
      threadId,
      createdAt: '2026-07-03T00:00:00.000Z',
      method: 'extension.notification',
      namespace: '_kiro.dev',
      type: 'mcp/server_initialized',
      payload: { serverName: 'context7' },
    });

    handleExtensionNotificationEvent({
      eventId: 'evt-2',
      provider: 'acp',
      threadId,
      createdAt: '2026-07-03T00:00:01.000Z',
      method: 'extension.notification',
      namespace: 'other.namespace',
      type: 'mcp/oauth_request',
      payload: { url: 'https://example.com' },
    });

    handleExtensionNotificationEvent({
      eventId: 'evt-3',
      provider: 'acp',
      threadId,
      createdAt: '2026-07-03T00:00:02.000Z',
      method: 'extension.notification',
      namespace: '_kiro',
      type: 'mcp/oauth_request',
      payload: { url: 'https://example.com/speculative' },
    });

    const chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.ephemeralMessages ?? []).toHaveLength(0);
  });

  test('claude-code thinking/tokens sets a thinking activity hint with an approximate token detail', () => {
    handleExtensionNotificationEvent({
      eventId: 'evt-1',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-23T00:00:00.000Z',
      method: 'extension.notification',
      namespace: 'claude-code',
      type: 'thinking/tokens',
      payload: { estimatedTokens: 1234, estimatedTokensDelta: 56 },
    });

    const chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.activityHint).toEqual({
      kind: 'thinking',
      detail: '~1.2k tokens',
    });
  });

  test('identical consecutive thinking/tokens hints (rounding to the same detail bucket) trigger exactly one store update', () => {
    const updateChatSpy = vi.spyOn(activeChatsStore, 'updateChat');

    // 1234 and 1240 both round to the same '~1.2k tokens' formatted detail
    // (formatApproxTokens buckets in 0.1k increments at/above 1000 tokens),
    // matching the raw per-delta token counts claude-adapter-events emits.
    handleExtensionNotificationEvent({
      eventId: 'evt-1',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-23T00:00:00.000Z',
      method: 'extension.notification',
      namespace: 'claude-code',
      type: 'thinking/tokens',
      payload: { estimatedTokens: 1234 },
    });
    handleExtensionNotificationEvent({
      eventId: 'evt-2',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-23T00:00:01.000Z',
      method: 'extension.notification',
      namespace: 'claude-code',
      type: 'thinking/tokens',
      payload: { estimatedTokens: 1240 },
    });

    expect(updateChatSpy).toHaveBeenCalledTimes(1);
    expect(activeChatsStore.getSnapshot()[threadId]?.activityHint).toEqual({
      kind: 'thinking',
      detail: '~1.2k tokens',
    });
  });

  test('a thinking/tokens hint that crosses a formatted-detail bucket still updates the store', () => {
    const updateChatSpy = vi.spyOn(activeChatsStore, 'updateChat');

    handleExtensionNotificationEvent({
      eventId: 'evt-1',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-23T00:00:00.000Z',
      method: 'extension.notification',
      namespace: 'claude-code',
      type: 'thinking/tokens',
      payload: { estimatedTokens: 1234 },
    });
    handleExtensionNotificationEvent({
      eventId: 'evt-2',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-23T00:00:01.000Z',
      method: 'extension.notification',
      namespace: 'claude-code',
      type: 'thinking/tokens',
      payload: { estimatedTokens: 1500 },
    });

    expect(updateChatSpy).toHaveBeenCalledTimes(2);
    expect(activeChatsStore.getSnapshot()[threadId]?.activityHint).toEqual({
      kind: 'thinking',
      detail: '~1.5k tokens',
    });
  });

  test('claude-code session/status sets compacting and clears on null', () => {
    handleExtensionNotificationEvent({
      eventId: 'evt-1',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-23T00:00:00.000Z',
      method: 'extension.notification',
      namespace: 'claude-code',
      type: 'session/status',
      payload: { status: 'compacting' },
    });
    expect(activeChatsStore.getSnapshot()[threadId]?.activityHint).toEqual({
      kind: 'compacting',
    });

    handleExtensionNotificationEvent({
      eventId: 'evt-2',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-23T00:00:01.000Z',
      method: 'extension.notification',
      namespace: 'claude-code',
      type: 'session/status',
      payload: { status: null },
    });
    expect(
      activeChatsStore.getSnapshot()[threadId]?.activityHint,
    ).toBeUndefined();
  });

  test('claude-code task/registry stores background tasks; task/settled clears and announces', () => {
    handleExtensionNotificationEvent({
      eventId: 'evt-1',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-23T00:00:00.000Z',
      method: 'extension.notification',
      namespace: 'claude-code',
      type: 'task/registry',
      payload: {
        active: [
          {
            taskId: 'task-1',
            toolCallId: 'toolu-1',
            description: 'Deep research',
            subagentType: 'researcher',
            backgrounded: true,
          },
        ],
      },
    });

    let chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.backgroundTasks).toEqual([
      {
        taskId: 'task-1',
        toolCallId: 'toolu-1',
        description: 'Deep research',
        subagentType: 'researcher',
        backgrounded: true,
      },
    ]);

    handleExtensionNotificationEvent({
      eventId: 'evt-2',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-23T00:00:01.000Z',
      method: 'extension.notification',
      namespace: 'claude-code',
      type: 'task/settled',
      payload: {
        taskId: 'task-1',
        description: 'Deep research',
        status: 'success',
        summary: 'Report written.',
      },
    });

    chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.backgroundTasks).toEqual([]);
    expect(chat?.ephemeralMessages).toHaveLength(1);
    expect(chat?.ephemeralMessages?.[0]?.content).toContain(
      'Background task finished — Deep research',
    );
    expect(chat?.ephemeralMessages?.[0]?.content).toContain('Report written.');
  });

  test('claude-code task/settled for an untracked task is silent', () => {
    handleExtensionNotificationEvent({
      eventId: 'evt-1',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-23T00:00:00.000Z',
      method: 'extension.notification',
      namespace: 'claude-code',
      type: 'task/settled',
      payload: { taskId: 'task-inline', status: 'success' },
    });

    const chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.ephemeralMessages ?? []).toHaveLength(0);
  });

  test('ignores an event for a thread with no active chat', () => {
    handleExtensionNotificationEvent({
      eventId: 'evt-1',
      provider: 'acp',
      threadId: 'thread-does-not-exist',
      createdAt: '2026-07-03T00:00:00.000Z',
      method: 'extension.notification',
      namespace: '_kiro.dev',
      type: 'mcp/oauth_request',
      payload: { url: 'https://example.com' },
    });

    expect(
      activeChatsStore.getSnapshot()['thread-does-not-exist'],
    ).toBeUndefined();
  });
});
