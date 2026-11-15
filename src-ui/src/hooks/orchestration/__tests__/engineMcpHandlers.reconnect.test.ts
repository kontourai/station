import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let activeChatsStore: import('../../../contexts/active-chats-store').ActiveChatsStore;
let handleEngineMcpStatusEvent: typeof import('../engineMcpHandlers').handleEngineMcpStatusEvent;

const threadId = 'thread-mcp-1';

beforeEach(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
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
  ({ activeChatsStore } = await import('../../../contexts/active-chats-store'));
  ({ handleEngineMcpStatusEvent } = await import('../engineMcpHandlers'));
  activeChatsStore.initChat(threadId, {
    agentSlug: 'kiro',
    agentName: 'Kiro',
    title: 'Kiro',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../../../contexts/active-chats-store');
  vi.resetModules();
});

const report = (extra: Record<string, unknown>) =>
  ({
    eventId: 'e',
    provider: 'acp',
    threadId,
    createdAt: '2026-11-13T00:00:00.000Z',
    method: 'engine-mcp.status',
    servers: [{ name: 'docs', state: 'ready', scope: 'session' }],
    complete: true,
    ...extra,
  }) as never;

test('the chat keeps whether the session’s engine can reconnect, from the latest report', () => {
  handleEngineMcpStatusEvent(report({ reconnect: true }));
  expect(activeChatsStore.getSnapshot()[threadId]?.engineMcpReconnect).toBe(
    true,
  );
  // A report without the bit (Codex has no reconnect) clears it.
  handleEngineMcpStatusEvent(report({}));
  expect(
    activeChatsStore.getSnapshot()[threadId]?.engineMcpReconnect,
  ).toBeUndefined();
});

test('the chat records that a complete report arrived, and partial reports after it keep that', () => {
  const complete = () =>
    activeChatsStore.getSnapshot()[threadId]?.engineMcpComplete;
  handleEngineMcpStatusEvent(report({ complete: false }));
  expect(complete()).toBeUndefined();
  handleEngineMcpStatusEvent(report({ complete: true }));
  expect(complete()).toBe(true);
  handleEngineMcpStatusEvent(report({ complete: false }));
  expect(complete()).toBe(true);
});
