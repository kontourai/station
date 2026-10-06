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

const { hydrateOpenApprovalToasts, OLDER_PAGE_LIMIT, OLDER_PAGE_TURNS } =
  await import('../hydrateOpenApprovalToasts');
const { handleRequestOpenedEvent, settlePendingApprovalsOnTurnEnd } =
  await import('../approvalHandlers');

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

// The route's window shape: an older page is named by `nextCursor`, and the
// last page has neither it nor `hasMore`.
const window = (...events: unknown[]) => ({
  protocolVersion: 1,
  events: events.map((event, index) => ({ sequence: index + 1, event })),
  hasMore: false,
  watermark: 10,
});
const olderAvailable = (page: ReturnType<typeof window>, cursor: string) => ({
  ...page,
  hasMore: true,
  nextCursor: cursor,
});
const place = () => new Map([['req-1', 'placeholder-toast']]);

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

  test('never writes the chat status: the snapshot already holds the chat state', async () => {
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
    expect(chat?.pendingApprovals).toEqual(['req-1']);
    expect(chat?.answeredApprovals).toBeUndefined();
    // Only the toast map and the turn binding are ever written.
    const written = new Set(
      updateChat.mock.calls.flatMap(([, updates]) => Object.keys(updates)),
    );
    expect([...written].sort()).toEqual([
      'approvalToasts',
      'pendingApprovalTurnIds',
    ]);
  });

  test('learns the turn a pending request names, so a live abort of that turn settles it as on a live client', async () => {
    const abort = {
      eventId: 'abort-1',
      provider: 'claude',
      threadId: 'thread-1',
      createdAt: '2026-09-05T00:00:01.000Z',
      method: 'turn.aborted',
      turnId: 'turn-1',
      reason: 'interrupted',
    } as never;

    // A client that saw the request open live.
    chat = {
      title: 'Conversation',
      agentName: 'Claude',
      pendingApprovals: [],
      approvalToasts: new Map(),
    };
    handleRequestOpenedEvent(
      'http://api',
      requestOpened({ turnId: 'turn-1' }) as never,
    );
    const liveSettled = settlePendingApprovalsOnTurnEnd(chat as never, abort);
    expect(liveSettled).toMatchObject({ pendingApprovals: [] });

    // A reloaded client.
    afterReload();
    fetchWindow.mockResolvedValue(window(requestOpened({ turnId: 'turn-1' })));
    await hydrateOpenApprovalToasts(
      'http://api',
      'thread-1',
      new Map([['req-1', 'placeholder-toast']]),
    );
    expect(chat?.pendingApprovalTurnIds).toEqual({ 'req-1': 'turn-1' });
    expect(settlePendingApprovalsOnTurnEnd(chat as never, abort)).toMatchObject(
      { pendingApprovals: [], pendingApprovalTurnIds: {} },
    );
  });

  test('keeps a binding the chat already has, and binds nothing for an event naming no turn', async () => {
    chat = { ...chat, pendingApprovalTurnIds: { 'req-1': 'turn-live' } };
    fetchWindow.mockResolvedValue(window(requestOpened({ turnId: 'turn-1' })));
    await hydrateOpenApprovalToasts(
      'http://api',
      'thread-1',
      new Map([['req-1', 'placeholder-toast']]),
    );
    expect(chat?.pendingApprovalTurnIds).toEqual({ 'req-1': 'turn-live' });

    afterReload();
    fetchWindow.mockResolvedValue(window(requestOpened()));
    await hydrateOpenApprovalToasts(
      'http://api',
      'thread-1',
      new Map([['req-1', 'placeholder-toast']]),
    );
    expect(chat?.pendingApprovalTurnIds).toBeUndefined();
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
      return window(requestOpened({ turnId: 'turn-1' }));
    });
    await hydrateOpenApprovalToasts(
      'http://api',
      'thread-1',
      new Map([['req-1', 'placeholder-toast']]),
    );
    expect(showToolApproval).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    expect(chat?.pendingApprovalTurnIds).toBeUndefined();
  });

  test('a toast raised live meanwhile is not duplicated', async () => {
    fetchWindow.mockImplementation(async () => {
      chat = {
        ...chat,
        approvalToasts: new Map([['req-1', 'live-toast']]),
      };
      return window(requestOpened({ turnId: 'turn-1' }));
    });
    await hydrateOpenApprovalToasts(
      'http://api',
      'thread-1',
      new Map([['req-1', 'placeholder-toast']]),
    );
    expect(showToolApproval).not.toHaveBeenCalled();
    expect(chat?.approvalToasts.get('req-1')).toBe('live-toast');
    expect(chat?.pendingApprovalTurnIds).toBeUndefined();
  });

  describe('an approval opened in an older turn', () => {
    const otherTurn = (n: number) =>
      requestOpened({
        eventId: `evt-other-${n}`,
        requestId: `answered-${n}`,
        turnId: `turn-${n}`,
      });

    test('gets its real toast and turn binding from an older page', async () => {
      fetchWindow
        .mockResolvedValueOnce(olderAvailable(window(otherTurn(3)), 'cursor-1'))
        .mockResolvedValueOnce(olderAvailable(window(otherTurn(2)), 'cursor-2'))
        .mockResolvedValueOnce(window(requestOpened({ turnId: 'turn-1' })));
      await hydrateOpenApprovalToasts('http://api', 'thread-1', place());

      expect(fetchWindow).toHaveBeenCalledTimes(3);
      expect(fetchWindow.mock.calls[0]![2]).toEqual({
        turnLimit: 1,
        direction: 'newest',
      });
      expect(fetchWindow.mock.calls[1]![2]).toEqual({
        cursor: 'cursor-1',
        turnLimit: OLDER_PAGE_TURNS,
        direction: 'newest',
      });
      expect(fetchWindow.mock.calls[2]![2]).toMatchObject({
        cursor: 'cursor-2',
      });
      expect(showToolApproval).toHaveBeenCalledOnce();
      expect(showToolApproval.mock.calls[0]![0]).toMatchObject({
        toolName: 'Bash',
        toolPreview: 'git status',
      });
      expect(chat?.approvalToasts.get('req-1')).toBe('real-toast');
      expect(chat?.pendingApprovalTurnIds).toEqual({ 'req-1': 'turn-1' });
    });

    test('stops at the page cap and keeps the placeholder beyond it', async () => {
      let n = 0;
      fetchWindow.mockImplementation(async () => {
        n += 1;
        return olderAvailable(window(otherTurn(n)), `cursor-${n}`);
      });
      await hydrateOpenApprovalToasts('http://api', 'thread-1', place());

      expect(fetchWindow).toHaveBeenCalledTimes(1 + OLDER_PAGE_LIMIT);
      expect(showToolApproval).not.toHaveBeenCalled();
      expect(chat?.approvalToasts.get('req-1')).toBe('placeholder-toast');
    });

    test('stops when the window has no older page', async () => {
      fetchWindow.mockResolvedValue(window(otherTurn(1)));
      await hydrateOpenApprovalToasts('http://api', 'thread-1', place());
      expect(fetchWindow).toHaveBeenCalledOnce();
      expect(chat?.approvalToasts.get('req-1')).toBe('placeholder-toast');
    });

    test('reads no second page when the first resolved everything', async () => {
      fetchWindow.mockResolvedValue(
        olderAvailable(window(requestOpened({ turnId: 'turn-1' })), 'cursor-1'),
      );
      await hydrateOpenApprovalToasts('http://api', 'thread-1', place());
      expect(fetchWindow).toHaveBeenCalledOnce();
      expect(showToolApproval).toHaveBeenCalledOnce();
    });

    test('a failed older read keeps the placeholder', async () => {
      fetchWindow
        .mockResolvedValueOnce(olderAvailable(window(otherTurn(2)), 'cursor-1'))
        .mockRejectedValueOnce(new Error('boom'));
      await hydrateOpenApprovalToasts('http://api', 'thread-1', place());
      expect(fetchWindow).toHaveBeenCalledTimes(2);
      expect(chat?.approvalToasts.get('req-1')).toBe('placeholder-toast');
    });

    test('an answer arriving while older pages are read is not overwritten', async () => {
      fetchWindow
        .mockResolvedValueOnce(olderAvailable(window(otherTurn(2)), 'cursor-1'))
        .mockImplementationOnce(async () => {
          chat = { ...chat, pendingApprovals: [], approvalToasts: new Map() };
          return window(requestOpened({ turnId: 'turn-1' }));
        });
      await hydrateOpenApprovalToasts('http://api', 'thread-1', place());
      expect(fetchWindow).toHaveBeenCalledTimes(2);
      expect(showToolApproval).not.toHaveBeenCalled();
      expect(dismiss).not.toHaveBeenCalled();
      expect(chat?.pendingApprovalTurnIds).toBeUndefined();
      expect(chat?.approvalToasts.size).toBe(0);
    });
  });
});
