/**
 * @vitest-environment jsdom
 */

/**
 * #3071: a turn's abort settles the requests that name it, and the chat
 * store's live fold must say so by the SAME rule the server's snapshot
 * already applies (`requestIdsSettledByTurnAbort`). Found by the sync
 * property test at seed 84 (request.opened naming the turn, then
 * turn.aborted): a client that heard both live kept the request pending
 * while a client that reconnected through a snapshot did not.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from 'vitest';

const dismissToast = vi.fn((_id: string) => {});
const showToast = vi.fn(
  (_message: string, _sessionId?: string, _duration?: number) =>
    'snapshot-toast',
);
let toastCount = 0;
const showToolApproval = vi.fn(() => `toast-${++toastCount}`);
vi.mock('../../../contexts/ToastContext', () => ({
  toastStore: {
    dismiss: (id: string) => dismissToast(id),
    show: (message: string, sessionId?: string, duration?: number) =>
      showToast(message, sessionId, duration),
    showToolApproval: () => showToolApproval(),
    // `notifyTurnTerminal` reports a settled turn; not under test here.
    showTurnActivity: vi.fn(),
  },
  // Read by the delayed turn-terminal notice.
  stripAnsi: (text: string) => text,
}));

let activeChatsStore: import('../../../contexts/active-chats-store').ActiveChatsStore;
let handleRequestOpenedEvent: typeof import('../approvalHandlers').handleRequestOpenedEvent;
let handleTurnAbortedEvent: typeof import('../turnHandlers').handleTurnAbortedEvent;
let handleTurnCompletedEvent: typeof import('../turnHandlers').handleTurnCompletedEvent;
let applyOrchestrationSnapshot: typeof import('../snapshotHandlers').applyOrchestrationSnapshot;
let resetTurnAttentionNotifications: typeof import('../turnAttentionNotifications').resetTurnAttentionNotifications;
/**
 * The server's own open-request fold (`open-requests.ts`), which feeds every
 * snapshot's `openRequestIds` — loaded at runtime from the server tree, as
 * the sync property test does, so the snapshot side of each case below is
 * what a real server would send for these exact events rather than a hand-
 * written answer.
 */
let collectOpenRequests: (events: unknown[]) => Map<string, unknown>;

const apiBase = 'http://localhost:0';
const createdAt = '2026-10-01T00:00:00.000Z';

type Trace = ReadonlyArray<Record<string, unknown>>;

/** The seed-84 trace, on `threadId`: one request names the turn, one does not. */
function abortedTurnTrace(
  threadId: string,
  terminal:
    | { method: 'turn.aborted' }
    | { method: 'turn.completed'; finishReason?: 'cancelled' },
): Trace {
  const base = { provider: 'claude', threadId, createdAt };
  return [
    {
      ...base,
      eventId: `${threadId}-start`,
      method: 'turn.started',
      turnId: 'turn-1',
      prompt: 'go',
    },
    {
      ...base,
      eventId: `${threadId}-named`,
      method: 'request.opened',
      turnId: 'turn-1',
      requestId: 'named-request',
      requestType: 'approval',
      title: 'Allow Read',
    },
    {
      ...base,
      eventId: `${threadId}-unnamed`,
      method: 'request.opened',
      requestId: 'unnamed-request',
      requestType: 'approval',
      title: 'Allow Bash',
    },
    {
      ...base,
      eventId: `${threadId}-terminal`,
      turnId: 'turn-1',
      ...(terminal.method === 'turn.aborted'
        ? { method: 'turn.aborted', reason: 'interrupted' }
        : {
            method: 'turn.completed',
            ...(terminal.finishReason
              ? { finishReason: terminal.finishReason }
              : {}),
          }),
    },
  ];
}

function initChat(threadId: string) {
  activeChatsStore.initChat(threadId, {
    agentSlug: 'claude-code',
    agentName: 'Claude Code',
    title: 'Settlement',
    orchestrationSessionStarted: true,
  });
}

/** Folds the trace through the live handlers, as a connected client does. */
function foldLive(trace: Trace) {
  for (const event of trace) {
    switch (event.method) {
      case 'request.opened':
        handleRequestOpenedEvent(apiBase, event as never);
        break;
      case 'turn.aborted':
        handleTurnAbortedEvent(event as never);
        break;
      case 'turn.completed':
        handleTurnCompletedEvent(apiBase, event as never);
        break;
      default:
        break;
    }
  }
}

/**
 * Applies what the server's snapshot carries for the same trace: its
 * `openRequestIds` are the server fold's survivors. A snapshot speaks for
 * every chat, and marks one it does not list as exited, so the cases below
 * fold the snapshot chat BEFORE the live one.
 */
function foldSnapshot(threadId: string, trace: Trace) {
  const openRequestIds = [...collectOpenRequests([...trace]).keys()];
  const terminal = trace.at(-1)?.method as 'turn.aborted' | 'turn.completed';
  applyOrchestrationSnapshot(
    {
      sessions: [
        {
          provider: 'claude',
          threadId,
          status: 'ready',
          hasActiveTurn: false,
          lastEventMethod: terminal,
          openRequestIds,
          blockingOpenRequestIds: openRequestIds,
        },
      ],
    },
    { apiBase },
  );
}

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
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
  ({ handleRequestOpenedEvent } = await import('../approvalHandlers'));
  ({ handleTurnAbortedEvent, handleTurnCompletedEvent } = await import(
    '../turnHandlers'
  ));
  ({ applyOrchestrationSnapshot } = await import('../snapshotHandlers'));
  ({ resetTurnAttentionNotifications } = await import(
    '../turnAttentionNotifications'
  ));
  ({ collectOpenRequests } = await vi.importActual<any>(
    '../../../../../src-server/services/orchestration/open-requests.js',
  ));
});

beforeEach(() => {
  for (const threadId of Object.keys(activeChatsStore.getSnapshot())) {
    activeChatsStore.removeChat(threadId);
  }
  toastCount = 0;
  dismissToast.mockClear();
  showToast.mockClear();
  showToolApproval.mockClear();
});

afterEach(async () => {
  await vi.dynamicImportSettled();
  resetTurnAttentionNotifications();
  activeChatsStore.flushPendingSave();
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../../../contexts/active-chats-store');
  vi.resetModules();
});

describe('a turn ending settles the pending requests that name it (#3071)', () => {
  test('a reloaded client learns the turn from the event window, so a live turn.aborted settles like a live client', async () => {
    initChat('live');
    initChat('reloaded');
    const trace = abortedTurnTrace('live', { method: 'turn.aborted' });
    foldLive(trace);

    // The reload: the snapshot lists the request, and the chat has no turn
    // binding for it until the event window is read.
    const fetchWindow = vi.fn(async () =>
      Response.json({
        success: true,
        data: {
          protocolVersion: 1,
          events: [
            {
              sequence: 1,
              event: {
                provider: 'claude',
                threadId: 'reloaded',
                createdAt,
                eventId: 'reloaded-named',
                method: 'request.opened',
                turnId: 'turn-1',
                requestId: 'named-request',
                requestType: 'approval',
                title: 'Allow Read',
              },
            },
          ],
        },
      }),
    );
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fetchWindow);
    onTestFinished(() => {
      vi.stubGlobal('fetch', realFetch);
    });
    applyOrchestrationSnapshot(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'reloaded',
            status: 'ready',
            hasActiveTurn: true,
            lastEventMethod: 'request.opened',
            openRequestIds: ['named-request'],
            blockingOpenRequestIds: ['named-request'],
          },
        ],
      },
      { apiBase },
    );
    await vi.waitFor(() =>
      expect(
        activeChatsStore.getSnapshot().reloaded?.pendingApprovalTurnIds,
      ).toEqual({ 'named-request': 'turn-1' }),
    );
    // The hydration wrote the binding and nothing about the request's state.
    expect(activeChatsStore.getSnapshot().reloaded?.pendingApprovals).toEqual([
      'named-request',
    ]);

    handleTurnAbortedEvent({
      ...(trace.at(-1) as Record<string, unknown>),
      threadId: 'reloaded',
      eventId: 'reloaded-terminal',
    } as never);
    expect(activeChatsStore.getSnapshot().reloaded?.pendingApprovals).toEqual(
      [],
    );
    // A live client that heard the same events agrees on the named request.
    expect(activeChatsStore.getSnapshot().live?.pendingApprovals).not.toContain(
      'named-request',
    );
  });

  test('turn.aborted: live and snapshot clients agree — the named request is settled, the unnamed one stays', () => {
    initChat('live');
    initChat('snapshot');
    foldSnapshot(
      'snapshot',
      abortedTurnTrace('snapshot', { method: 'turn.aborted' }),
    );
    foldLive(abortedTurnTrace('live', { method: 'turn.aborted' }));

    const live = activeChatsStore.getSnapshot().live;
    const snapshot = activeChatsStore.getSnapshot().snapshot;
    expect(live?.pendingApprovals).toEqual(['unnamed-request']);
    expect(snapshot?.pendingApprovals).toEqual(live?.pendingApprovals);
    expect(live?.pendingApprovalTurnIds).toEqual({});
    // The settled request's toast is gone; the live one's is still up.
    expect(dismissToast).toHaveBeenCalledTimes(1);
    expect(dismissToast).toHaveBeenCalledWith('toast-1');
    expect([...(live?.approvalToasts ?? new Map()).keys()]).toEqual([
      'unnamed-request',
    ]);
    expect(live?.orchestrationStatus).toBe('aborted');
  });

  test('an "answered here" mark leaves with the request the turn end settled, live and by snapshot', () => {
    initChat('live');
    initChat('snapshot');
    const answered = ['named-request', 'unnamed-request'];
    // Both requests were answered from the queue before the turn ended.
    for (const threadId of ['live', 'snapshot']) {
      foldLive(
        abortedTurnTrace(threadId, { method: 'turn.aborted' }).slice(0, -1),
      );
      activeChatsStore.updateChat(threadId, { answeredApprovals: answered });
    }
    foldSnapshot(
      'snapshot',
      abortedTurnTrace('snapshot', { method: 'turn.aborted' }),
    );
    handleTurnAbortedEvent(
      abortedTurnTrace('live', { method: 'turn.aborted' }).at(-1) as never,
    );

    // The named request is settled and gone; the unnamed one is still open, so
    // its mark stays (it is still answered, still awaiting `request.resolved`).
    expect(activeChatsStore.getSnapshot().live?.pendingApprovals).toEqual([
      'unnamed-request',
    ]);
    expect(activeChatsStore.getSnapshot().live?.answeredApprovals).toEqual([
      'unnamed-request',
    ]);
    expect(activeChatsStore.getSnapshot().snapshot?.answeredApprovals).toEqual([
      'unnamed-request',
    ]);
  });

  test('turn.completed with finishReason cancelled settles the same way', () => {
    initChat('live');
    initChat('snapshot');
    const trace = (threadId: string) =>
      abortedTurnTrace(threadId, {
        method: 'turn.completed',
        finishReason: 'cancelled',
      });
    foldSnapshot('snapshot', trace('snapshot'));
    foldLive(trace('live'));
    expect(activeChatsStore.getSnapshot().live?.pendingApprovals).toEqual([
      'unnamed-request',
    ]);
    expect(activeChatsStore.getSnapshot().snapshot?.pendingApprovals).toEqual([
      'unnamed-request',
    ]);
  });

  test('an ordinary turn.completed settles nothing, live or snapshot', () => {
    initChat('live');
    initChat('snapshot');
    const trace = (threadId: string) =>
      abortedTurnTrace(threadId, { method: 'turn.completed' });
    foldSnapshot('snapshot', trace('snapshot'));
    foldLive(trace('live'));
    expect(activeChatsStore.getSnapshot().live?.pendingApprovals).toEqual([
      'named-request',
      'unnamed-request',
    ]);
    expect(activeChatsStore.getSnapshot().snapshot?.pendingApprovals).toEqual([
      'named-request',
      'unnamed-request',
    ]);
    expect(dismissToast).not.toHaveBeenCalled();
  });

  test('an abort of a DIFFERENT turn, while another is open, settles only that turn’s own request', () => {
    initChat('live');
    const trace = abortedTurnTrace('live', { method: 'turn.aborted' });
    foldLive(trace.slice(0, -1));
    // A request of the open turn, and the abort of a queued send (#2324):
    // the open turn's stream is untouched and its request stays answerable.
    handleRequestOpenedEvent(apiBase, {
      provider: 'claude',
      threadId: 'live',
      createdAt,
      eventId: 'live-open-turn-request',
      method: 'request.opened',
      turnId: 'turn-2',
      requestId: 'open-turn-request',
      requestType: 'approval',
      title: 'Allow Write',
    } as never);
    activeChatsStore.updateChat('live', {
      openTurnId: 'turn-2',
      orchestrationTurnOpen: true,
      status: 'sending',
    });
    handleTurnAbortedEvent(trace.at(-1) as never);
    const live = activeChatsStore.getSnapshot().live;
    expect(live?.pendingApprovals).toEqual([
      'unnamed-request',
      'open-turn-request',
    ]);
    expect(live?.pendingApprovalTurnIds).toEqual({
      'open-turn-request': 'turn-2',
    });
    expect(live?.openTurnId).toBe('turn-2');
    expect(live?.status).toBe('sending');
  });

  test('a request learned from a snapshot names no turn to this client, so a live abort keeps it visible', () => {
    // The safe direction: the server's list is already the fold's survivors
    // and carries no turn binding. A client that only ever saw the id cannot
    // settle it by name; it stays answerable until a `request.resolved`,
    // the next snapshot, or the server refusing its answer — never hidden
    // on a guess.
    initChat('live');
    applyOrchestrationSnapshot(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'live',
            status: 'ready',
            hasActiveTurn: true,
            openRequestIds: ['named-request'],
            blockingOpenRequestIds: ['named-request'],
          },
        ],
      },
      { apiBase },
    );
    expect(activeChatsStore.getSnapshot().live?.pendingApprovals).toEqual([
      'named-request',
    ]);
    handleTurnAbortedEvent(
      abortedTurnTrace('live', { method: 'turn.aborted' }).at(-1) as never,
    );
    expect(activeChatsStore.getSnapshot().live?.pendingApprovals).toEqual([
      'named-request',
    ]);
  });

  test('a snapshot keeps the bindings this client learned live for the ids it still lists', () => {
    initChat('live');
    const trace = abortedTurnTrace('live', { method: 'turn.aborted' });
    foldLive(trace.slice(0, -1));
    expect(activeChatsStore.getSnapshot().live?.pendingApprovalTurnIds).toEqual(
      { 'named-request': 'turn-1' },
    );
    // A snapshot taken while both are open, then the abort heard live.
    foldSnapshot('live', trace.slice(0, -1));
    expect(activeChatsStore.getSnapshot().live?.pendingApprovals).toEqual([
      'named-request',
      'unnamed-request',
    ]);
    expect(activeChatsStore.getSnapshot().live?.pendingApprovalTurnIds).toEqual(
      { 'named-request': 'turn-1' },
    );
    handleTurnAbortedEvent(trace.at(-1) as never);
    expect(activeChatsStore.getSnapshot().live?.pendingApprovals).toEqual([
      'unnamed-request',
    ]);
  });
});
