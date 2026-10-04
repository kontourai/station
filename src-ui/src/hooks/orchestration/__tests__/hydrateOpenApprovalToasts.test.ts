import { beforeEach, describe, expect, test, vi } from 'vitest';

type ApprovalToastOptions = {
  requestId?: string;
  toolName: string;
  toolPreview?: string;
  actions: Array<{ label: string; onClick: () => void }>;
};

const showToolApproval = vi.fn(
  (_options: ApprovalToastOptions) => 'real-toast',
);
const dismiss = vi.fn();
const fetchWindow = vi.fn();

let chat: Record<string, any> | undefined;
const updateChat = vi.fn((_threadId: string, updates: Record<string, any>) => {
  if (chat) chat = { ...chat, ...updates };
});

vi.mock('@kontourai/station-sdk', () => ({
  fetchOrchestrationConversationEventWindow: (...args: unknown[]) =>
    fetchWindow(...args),
  resolveOrchestrationRequest: vi.fn(),
  inspectAttentionRequest: vi.fn(),
}));
vi.mock('../../../contexts/ToastContext', () => ({
  toastStore: { showToolApproval, show: vi.fn(), dismiss },
}));
vi.mock('../../../contexts/active-chats-store', () => ({
  activeChatsStore: {
    getChatForExecutionSession: () => chat,
    updateChat: (...args: [string, Record<string, any>]) => updateChat(...args),
  },
}));

const { hydrateOpenApprovalToasts } = await import(
  '../hydrateOpenApprovalToasts'
);
const { handleRequestOpenedEvent } = await import('../approvalHandlers');

function requestOpened(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt-1',
    provider: 'claude',
    threadId: 'thread-1',
    createdAt: '2026-09-05T00:00:00.000Z',
    method: 'request.opened',
    requestId: 'req-1',
    requestType: 'approval',
    title: 'Allow Bash',
    payload: { toolName: 'Bash', toolInput: { command: 'git status' } },
    ...overrides,
  };
}

function afterReload() {
  chat = {
    title: 'Conversation',
    agentName: 'Claude',
    pendingApprovals: ['req-1'],
    approvalToasts: new Map([['req-1', 'placeholder-toast']]),
  };
}

const window = (...events: unknown[]) => ({
  events: events.map((event) => ({ sequence: 1, event })),
});

describe('hydrateOpenApprovalToasts (approvals opened before a reload)', () => {
  beforeEach(() => {
    showToolApproval.mockClear();
    dismiss.mockClear();
    updateChat.mockClear();
    fetchWindow.mockReset();
    afterReload();
  });

  test('replaces the placeholder with the toast a live request.opened raises', async () => {
    // The live toast, for comparison.
    chat = { title: 'Conversation', agentName: 'Claude', pendingApprovals: [] };
    handleRequestOpenedEvent('http://api', requestOpened() as never);
    const live = showToolApproval.mock.calls[0]![0];
    showToolApproval.mockClear();

    afterReload();
    fetchWindow.mockResolvedValue(window(requestOpened()));
    await hydrateOpenApprovalToasts(
      'http://api',
      'thread-1',
      new Map([['req-1', 'placeholder-toast']]),
    );

    expect(dismiss).toHaveBeenCalledWith('placeholder-toast');
    expect(showToolApproval).toHaveBeenCalledOnce();
    const hydrated = showToolApproval.mock.calls[0]![0];
    expect(hydrated).toMatchObject({
      toolName: 'Bash',
      toolPreview: 'git status',
    });
    expect(hydrated.actions.map((action) => action.label)).toEqual(
      live.actions.map((action) => action.label),
    );
    expect(hydrated.toolName).toBe(live.toolName);
    expect(hydrated.toolPreview).toBe(live.toolPreview);
    // The new toast replaced the placeholder in the chat's toast map.
    expect(chat?.approvalToasts.get('req-1')).toBe('real-toast');
  });

  test('rebuilds only the toast: the snapshot already holds the chat state', async () => {
    // The request opened in a turn that has since ended: the snapshot left the
    // chat idle with the request still pending. Replaying the live handler's
    // state write would set it back to awaiting-approval.
    chat = { ...chat, orchestrationStatus: 'idle' };
    fetchWindow.mockResolvedValue(window(requestOpened({ turnId: 'turn-1' })));
    await hydrateOpenApprovalToasts(
      'http://api',
      'thread-1',
      new Map([['req-1', 'placeholder-toast']]),
    );

    expect(showToolApproval).toHaveBeenCalledOnce();
    expect(chat?.orchestrationStatus).toBe('idle');
    for (const [, updates] of updateChat.mock.calls)
      expect(Object.keys(updates)).toEqual(['approvalToasts']);
  });

  test('an open id the window does not carry keeps its placeholder', async () => {
    fetchWindow.mockResolvedValue(
      window(requestOpened({ requestId: 'some-other-request' })),
    );
    await hydrateOpenApprovalToasts(
      'http://api',
      'thread-1',
      new Map([['req-1', 'placeholder-toast']]),
    );
    expect(showToolApproval).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    expect(chat?.approvalToasts.get('req-1')).toBe('placeholder-toast');
  });

  test('a server without the window route keeps the placeholder', async () => {
    fetchWindow.mockRejectedValue(
      Object.assign(new Error('not found'), { status: 404 }),
    );
    await hydrateOpenApprovalToasts(
      'http://api',
      'thread-1',
      new Map([['req-1', 'placeholder-toast']]),
    );
    expect(showToolApproval).not.toHaveBeenCalled();
    expect(chat?.approvalToasts.get('req-1')).toBe('placeholder-toast');
  });

  test('a request answered while the window was read is not offered again', async () => {
    fetchWindow.mockImplementation(async () => {
      chat = { ...chat, pendingApprovals: [], approvalToasts: new Map() };
      return window(requestOpened());
    });
    await hydrateOpenApprovalToasts(
      'http://api',
      'thread-1',
      new Map([['req-1', 'placeholder-toast']]),
    );
    expect(showToolApproval).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  test('a toast raised live meanwhile is not duplicated', async () => {
    fetchWindow.mockImplementation(async () => {
      chat = {
        ...chat,
        approvalToasts: new Map([['req-1', 'live-toast']]),
      };
      return window(requestOpened());
    });
    await hydrateOpenApprovalToasts(
      'http://api',
      'thread-1',
      new Map([['req-1', 'placeholder-toast']]),
    );
    expect(showToolApproval).not.toHaveBeenCalled();
    expect(chat?.approvalToasts.get('req-1')).toBe('live-toast');
  });
});
