// @vitest-environment jsdom

/**
 * The header "Approval needed" pill counts undismissed approval toasts
 * (`NotificationContainer`). A toast must therefore live exactly as long as
 * its request: `request.resolved` dismisses it by the request's own identity,
 * whatever has happened to the chat that first showed it since — a
 * conversation handoff or reopen resets the chat's toast map
 * (`conversationHandoffUiState.ts`, `conversationOpenController.ts`), and a
 * closed tab removes the chat altogether.
 *
 * Real stores and real handlers; nothing between the event and the toast
 * history is stubbed.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let activeChatsStore: import('../../../contexts/active-chats-store').ActiveChatsStore;
let toastStore: typeof import('../../../contexts/ToastContext').toastStore;
let handleOrchestrationEvent: typeof import('../eventHandlers').handleOrchestrationEvent;

const threadId = 'thread-approval-lifetime';

function pendingApprovalToasts() {
  return toastStore
    .getHistorySnapshot()
    .filter((item) => item.type === 'tool-approval' && !item.dismissed);
}

function open(requestId: string) {
  handleOrchestrationEvent('http://api', {
    eventId: `open-${requestId}`,
    provider: 'acp',
    threadId,
    createdAt: '2026-09-28T19:29:00.000Z',
    method: 'request.opened',
    requestId,
    requestType: 'approval',
    title: 'cd /tmp && gh api x > gsd.mjs',
    payload: { toolCallId: `call-${requestId}`, rawInput: { command: 'x' } },
  } as never);
}

function resolve(requestId: string) {
  handleOrchestrationEvent('http://api', {
    eventId: `resolved-${requestId}`,
    provider: 'acp',
    threadId,
    createdAt: '2026-09-28T19:29:05.000Z',
    method: 'request.resolved',
    requestId,
    status: 'approved',
  } as never);
}

describe('approval toast lifetime', () => {
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
    ({ toastStore } = await import('../../../contexts/ToastContext'));
    ({ handleOrchestrationEvent } = await import('../eventHandlers'));
    activeChatsStore.initChat(threadId, {
      agentSlug: 'opencode',
      agentName: 'OpenCode',
      title: 'opencode chat',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../../contexts/active-chats-store');
    vi.resetModules();
  });

  test('the request settling dismisses its toast', () => {
    open('req-1');
    expect(pendingApprovalToasts()).toHaveLength(1);
    resolve('req-1');
    expect(pendingApprovalToasts()).toHaveLength(0);
  });

  test("the request settling dismisses its toast after the chat's toast map was reset", () => {
    open('req-1');
    // What a handoff or a reopen onto a new child writes.
    activeChatsStore.updateChat(threadId, {
      pendingApprovals: [],
      approvalToasts: new Map(),
    });
    resolve('req-1');
    expect(pendingApprovalToasts()).toHaveLength(0);
  });

  test('the request settling dismisses its toast after the chat was closed', () => {
    open('req-1');
    activeChatsStore.removeChat(threadId);
    resolve('req-1');
    expect(pendingApprovalToasts()).toHaveLength(0);
  });

  test("another request's toast stays", () => {
    open('req-1');
    open('req-2');
    resolve('req-1');
    expect(
      pendingApprovalToasts().map((item) => item.approvalRequestId),
    ).toEqual(['req-2']);
  });
});
