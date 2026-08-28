/**
 * @vitest-environment jsdom
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

let deriveActivityLabel: typeof import('../../../components/chat/StreamingMessage').deriveActivityLabel;
let isSessionExecutionActive: typeof import('../../../utils/execution').isSessionExecutionActive;
let activeChatsStore: import('../../../contexts/active-chats-store').ActiveChatsStore;
let handleTurnStartedEvent: typeof import('../turnHandlers').handleTurnStartedEvent;
let handleRuntimeErrorEvent: typeof import('../turnHandlers').handleRuntimeErrorEvent;
let handleRequestOpenedEvent: typeof import('../approvalHandlers').handleRequestOpenedEvent;
let handleRequestResolvedEvent: typeof import('../approvalHandlers').handleRequestResolvedEvent;
let handleSessionExitedEvent: typeof import('../sessionHandlers').handleSessionExitedEvent;
let handleSessionStateChangedEvent: typeof import('../sessionHandlers').handleSessionStateChangedEvent;

const threadId = 'thread-activity-1';

// active-chats-store (transitively imported by these modules) reads
// localStorage at module scope — stub before any dynamic import.
beforeAll(async () => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
  });
  ({ deriveActivityLabel } = await import(
    '../../../components/chat/StreamingMessage'
  ));
  ({ isSessionExecutionActive } = await import('../../../utils/execution'));
});

describe('isSessionExecutionActive — indicator gating', () => {
  test('a stale idle orchestrationStatus no longer vetoes a local send', () => {
    // The regression: after the first turn, orchestrationStatus is 'idle';
    // the old preference order hid the indicator until the provider's
    // session.state-changed round-tripped.
    expect(
      isSessionExecutionActive({
        status: 'sending',
        orchestrationStatus: 'idle',
      } as any),
    ).toBe(true);
  });

  test('truth table', () => {
    expect(isSessionExecutionActive(null)).toBe(false);
    expect(isSessionExecutionActive({ status: 'idle' } as any)).toBe(false);
    expect(isSessionExecutionActive({ status: 'sending' } as any)).toBe(true);
    expect(
      isSessionExecutionActive({
        status: 'idle',
        orchestrationStatus: 'running',
      } as any),
    ).toBe(true);
    expect(
      isSessionExecutionActive({
        status: 'idle',
        orchestrationStatus: 'awaiting-approval',
      } as any),
    ).toBe(true);
    expect(
      isSessionExecutionActive({
        status: 'idle',
        orchestrationStatus: 'aborted',
      } as any),
    ).toBe(false);
  });
});

describe('handleTurnCompletedEvent — terminal event ends execution activity (#1005)', () => {
  let handleTurnCompletedEvent: typeof import('../turnHandlers').handleTurnCompletedEvent;

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
    ({ handleTurnCompletedEvent } = await import('../turnHandlers'));
    activeChatsStore.initChat(threadId, {
      agentSlug: 'claude-code',
      agentName: 'Claude Code',
      title: 'Claude Code Chat',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../../contexts/active-chats-store');
    vi.resetModules();
  });

  test('turn.completed alone (no post-turn session.state-changed) deactivates the session', () => {
    activeChatsStore.updateChat(threadId, {
      status: 'sending',
      orchestrationStatus: 'running',
      streamingMessage: {
        role: 'assistant',
        contentParts: [{ type: 'text', content: 'pong' }],
      },
    } as any);

    handleTurnCompletedEvent('http://localhost:0', {
      eventId: 'evt-1005',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-27T00:00:00.000Z',
      method: 'turn.completed',
      outputText: 'pong',
    } as any);

    const chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.streamingMessage).toBeUndefined();
    expect(isSessionExecutionActive(chat)).toBe(false);
  });
});

describe('deriveActivityLabel — richest-signal-first labeling', () => {
  test('provider hints win over fallbacks', () => {
    expect(
      deriveActivityLabel({ kind: 'thinking', detail: '~1.2k tokens' }, false),
    ).toBe('Thinking… ~1.2k tokens');
    expect(deriveActivityLabel({ kind: 'thinking' }, false)).toBe('Thinking…');
    expect(deriveActivityLabel({ kind: 'compacting' }, true)).toBe(
      'Compacting context…',
    );
    expect(deriveActivityLabel({ kind: 'requesting' }, false)).toBe(
      'Preparing…',
    );
  });

  test('falls back to reasoning presence, then a generic working label', () => {
    expect(deriveActivityLabel(undefined, true)).toBe('Thinking…');
    expect(deriveActivityLabel(undefined, false)).toBe('Working…');
  });
});

describe('handleTurnStartedEvent — optimistic running status', () => {
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
    ({ handleTurnStartedEvent } = await import('../turnHandlers'));

    activeChatsStore.initChat(threadId, {
      agentSlug: 'claude-code',
      agentName: 'Claude Code',
      title: 'Claude Code Chat',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../../contexts/active-chats-store');
    vi.resetModules();
  });

  test('turn.started flips a stale idle orchestrationStatus to running and clears the stale hint', () => {
    activeChatsStore.updateChat(threadId, {
      orchestrationStatus: 'idle',
      activityHint: { kind: 'thinking' },
    });

    handleTurnStartedEvent({
      eventId: 'evt-1',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-23T00:00:00.000Z',
      method: 'turn.started',
      turnId: 'turn-1',
    } as any);

    const chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.status).toBe('sending');
    expect(chat?.orchestrationStatus).toBe('running');
    expect(chat?.activityHint).toBeUndefined();
    expect(
      isSessionExecutionActive({
        status: chat?.status,
        orchestrationStatus: chat?.orchestrationStatus,
      } as any),
    ).toBe(true);
  });
});

describe('handleSessionExitedEvent / handleSessionStateChangedEvent — clearing transient activity state on session death', () => {
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
    ({ handleSessionExitedEvent, handleSessionStateChangedEvent } =
      await import('../sessionHandlers'));
    ({ handleTurnStartedEvent, handleRuntimeErrorEvent } = await import(
      '../turnHandlers'
    ));
    ({ handleRequestOpenedEvent, handleRequestResolvedEvent } = await import(
      '../approvalHandlers'
    ));

    activeChatsStore.initChat(threadId, {
      agentSlug: 'claude-code',
      agentName: 'Claude Code',
      title: 'Claude Code Chat',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../../contexts/active-chats-store');
    vi.resetModules();
  });

  test('session.exited clears a live activityHint and pending backgroundTasks', () => {
    activeChatsStore.updateChat(threadId, {
      activityHint: { kind: 'thinking', detail: '~1.2k tokens' },
      backgroundTasks: [{ taskId: 'task-1', backgrounded: true }],
    });

    handleSessionExitedEvent(
      {
        eventId: 'evt-1',
        provider: 'claude',
        threadId,
        createdAt: '2026-07-23T00:00:00.000Z',
        method: 'session.exited',
        sessionId: 'session-1',
      } as any,
      activeChatsStore,
    );

    const chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.activityHint).toBeUndefined();
    expect(chat?.backgroundTasks).toBeUndefined();
    expect(chat?.orchestrationStatus).toBe('exited');
  });

  test('a terminal session.state-changed (e.g. errored) clears activityHint and backgroundTasks', () => {
    activeChatsStore.updateChat(threadId, {
      activityHint: { kind: 'compacting' },
      backgroundTasks: [{ taskId: 'task-2', backgrounded: true }],
    });

    handleSessionStateChangedEvent(
      {
        eventId: 'evt-1',
        provider: 'claude',
        threadId,
        createdAt: '2026-07-23T00:00:00.000Z',
        method: 'session.state-changed',
        sessionId: 'session-1',
        from: 'running',
        to: 'errored',
      } as any,
      activeChatsStore,
    );

    const chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.activityHint).toBeUndefined();
    expect(chat?.backgroundTasks).toBeUndefined();
    expect(chat?.orchestrationStatus).toBe('errored');
  });

  test('a non-terminal session.state-changed (e.g. idle) leaves activityHint/backgroundTasks untouched', () => {
    activeChatsStore.updateChat(threadId, {
      activityHint: { kind: 'thinking' },
      backgroundTasks: [{ taskId: 'task-3', backgrounded: true }],
    });

    handleSessionStateChangedEvent(
      {
        eventId: 'evt-1',
        provider: 'claude',
        threadId,
        createdAt: '2026-07-23T00:00:00.000Z',
        method: 'session.state-changed',
        sessionId: 'session-1',
        from: 'running',
        to: 'idle',
      } as any,
      activeChatsStore,
    );

    const chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.activityHint).toEqual({ kind: 'thinking' });
    expect(chat?.backgroundTasks).toEqual([
      { taskId: 'task-3', backgrounded: true },
    ]);
  });

  // archive#1076: `to` is the provider's coarse PROCESS status — 'running' means the
  // runtime attached, not that a turn is open. The snapshot path already
  // gates this (archive#1034); the live-event path must agree or a mere attach
  // (service restart re-attach, reconnect) strands the chat as active for
  // every orchestrationStatus consumer (home labels via the lifecycle merge,
  // the streaming-shell engagement in isSessionExecutionActive).
  test("a state-changed to 'running' with no open turn does not mark the chat running (#1076)", () => {
    // No turn is open: the chat is at rest (no turn.started, no local send).
    activeChatsStore.updateChat(threadId, {
      status: 'idle',
      orchestrationStatus: 'idle',
    });

    handleSessionStateChangedEvent(
      {
        eventId: 'evt-attach',
        provider: 'claude',
        threadId,
        createdAt: '2026-07-23T00:00:00.000Z',
        method: 'session.state-changed',
        sessionId: 'session-1',
        from: 'connecting',
        to: 'running',
      } as any,
      activeChatsStore,
    );

    const chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.orchestrationStatus).toBe('idle');
    expect(chat?.status).toBe('idle');
    expect(
      isSessionExecutionActive({
        status: chat?.status,
        orchestrationStatus: chat?.orchestrationStatus,
      } as any),
    ).toBe(false);
  });

  test("a state-changed to 'running' during an open turn keeps the chat running (#1076)", () => {
    // The REAL sequence, not seeded store state: turn.started opens the
    // client turn fold.
    handleTurnStartedEvent({
      eventId: 'evt-turn',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-23T00:00:00.000Z',
      method: 'turn.started',
      turnId: 'turn-1',
    } as any);

    handleSessionStateChangedEvent(
      {
        eventId: 'evt-mid-turn',
        provider: 'claude',
        threadId,
        createdAt: '2026-07-23T00:00:01.000Z',
        method: 'session.state-changed',
        sessionId: 'session-1',
        from: 'ready',
        to: 'running',
      } as any,
      activeChatsStore,
    );

    const chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.orchestrationStatus).toBe('running');
    expect(chat?.status).toBe('sending');
    expect(
      isSessionExecutionActive({
        status: chat?.status,
        orchestrationStatus: chat?.orchestrationStatus,
      } as any),
    ).toBe(true);
  });

  // archive#1076: an in-turn approval drops UI status to 'idle', so
  // status alone must not be the turn authority — the post-approval
  // 'running' state-change has to re-engage the shell for the still-open
  // turn.
  test('the post-approval running state-change re-engages the still-open turn (#1076 review HIGH)', () => {
    const at = '2026-07-23T00:00:00.000Z';
    handleTurnStartedEvent({
      eventId: 'evt-1',
      provider: 'claude',
      threadId,
      createdAt: at,
      method: 'turn.started',
      turnId: 'turn-1',
    } as any);
    handleRequestOpenedEvent('http://localhost:0', {
      eventId: 'evt-2',
      provider: 'claude',
      threadId,
      createdAt: at,
      method: 'request.opened',
      requestId: 'req-1',
      requestType: 'approval',
      title: 'Approve tool',
    } as any);
    handleSessionStateChangedEvent(
      {
        eventId: 'evt-3',
        provider: 'claude',
        threadId,
        createdAt: at,
        method: 'session.state-changed',
        sessionId: 'session-1',
        from: 'running',
        to: 'awaiting-approval',
      } as any,
      activeChatsStore,
    );
    // Mid-approval the shell is parked; the turn is still open.
    expect(activeChatsStore.getSnapshot()[threadId]?.status).toBe('idle');
    handleRequestResolvedEvent({
      eventId: 'evt-4',
      provider: 'claude',
      threadId,
      createdAt: at,
      method: 'request.resolved',
      requestId: 'req-1',
      resolution: 'approved',
    } as any);
    handleSessionStateChangedEvent(
      {
        eventId: 'evt-5',
        provider: 'claude',
        threadId,
        createdAt: at,
        method: 'session.state-changed',
        sessionId: 'session-1',
        from: 'awaiting-approval',
        to: 'running',
      } as any,
      activeChatsStore,
    );

    const chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.status).toBe('sending');
    expect(chat?.orchestrationStatus).toBe('running');
    expect(
      isSessionExecutionActive({
        status: chat?.status,
        orchestrationStatus: chat?.orchestrationStatus,
      } as any),
    ).toBe(true);
  });

  test('runtime.error closes the turn fold, so a later running state-change stays inactive (#1076)', () => {
    const at = '2026-07-23T00:00:00.000Z';
    handleTurnStartedEvent({
      eventId: 'evt-1',
      provider: 'claude',
      threadId,
      createdAt: at,
      method: 'turn.started',
      turnId: 'turn-1',
    } as any);
    handleRuntimeErrorEvent({
      eventId: 'evt-2',
      provider: 'claude',
      threadId,
      createdAt: at,
      method: 'runtime.error',
      severity: 'error',
      message: 'engine crashed',
    } as any);
    handleSessionStateChangedEvent(
      {
        eventId: 'evt-3',
        provider: 'claude',
        threadId,
        createdAt: at,
        method: 'session.state-changed',
        sessionId: 'session-1',
        from: 'errored',
        to: 'running',
      } as any,
      activeChatsStore,
    );

    const chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.status).toBe('idle');
    expect(chat?.orchestrationStatus).toBe('idle');
  });

  // archive#1207 1, 2: a silent stall on the
  // station-agent adapter's inner /chat bridge has no dedicated
  // `turn.failed` event — `runtime.error` IS the terminal-failure signal
  // for this path (server-side proof: `station-agent-adapter.test.ts`'s
  // "a silently stalled inner /chat stream publishes runtime.error..."
  // test). This pins the client maps it to error state + a real Retry
  // affordance, reusing the EXISTING `[SYSTEM_EVENT] [CHAT_ERROR]` +
  // `findPrecedingUserTurn` "Send again" mechanism (archive#797,
  // `chat-dock-failed-turn-retry.test.ts` proves that mechanism generically
  // resolves ANY correctly-shaped marker) rather than inventing a second
  // retry path this module has no hook access to build.
  test('runtime.error (the stall-triggered path) appends the reusable [SYSTEM_EVENT][CHAT_ERROR] retry marker after the real user turn', () => {
    const at = '2026-07-23T00:00:00.000Z';
    activeChatsStore.updateChat(threadId, {
      messages: [
        { role: 'user', content: 'delegate this long task', timestamp: 1 },
      ],
    });

    handleTurnStartedEvent({
      eventId: 'evt-1',
      provider: 'station-agent',
      threadId,
      createdAt: at,
      method: 'turn.started',
      turnId: 'turn-1',
    } as any);
    handleRuntimeErrorEvent({
      eventId: 'evt-2',
      provider: 'station-agent',
      threadId,
      createdAt: at,
      method: 'runtime.error',
      severity: 'error',
      message:
        'Station agent did not accept the task turn: station-agent chat bridge stalled — no response for 45s',
    } as any);

    const chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.status).toBe('error');

    const marker = (chat?.messages ?? []).at(-1);
    expect(marker?.role).toBe('user');
    expect(marker?.content).toMatch(/^\[SYSTEM_EVENT\] \[CHAT_ERROR\]/);
    expect(marker?.content).toContain('stalled — no response for 45s');

    // The real user turn the marker should resolve back to is still there,
    // immediately before it.
    const precedingTurn = (chat?.messages ?? []).at(-2);
    expect(precedingTurn).toMatchObject({
      role: 'user',
      content: 'delegate this long task',
    });
  });

  test('compacts consecutive identical runtime errors in the live fold without crossing a new turn', () => {
    const at = '2026-07-30T00:00:00.000Z';
    handleTurnStartedEvent({
      eventId: 'evt-compact-1',
      provider: 'claude',
      threadId,
      createdAt: at,
      method: 'turn.started',
      turnId: 'turn-compact-1',
    } as any);
    handleRuntimeErrorEvent({
      eventId: 'evt-compact-2',
      provider: 'claude',
      threadId,
      createdAt: at,
      method: 'runtime.error',
      severity: 'error',
      message: 'engine crashed',
    } as any);
    handleRuntimeErrorEvent({
      eventId: 'evt-compact-3',
      provider: 'claude',
      threadId,
      createdAt: at,
      method: 'runtime.error',
      severity: 'error',
      message: 'engine crashed',
    } as any);

    let chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.streamingMessage?.contentParts).toEqual([
      { type: 'text', content: 'engine crashed (repeated 2×)' },
    ]);
    expect(chat?.messages?.at(-1)?.content).toBe(
      '[SYSTEM_EVENT] [CHAT_ERROR] engine crashed (repeated 2×)',
    );

    handleTurnStartedEvent({
      eventId: 'evt-compact-4',
      provider: 'claude',
      threadId,
      createdAt: at,
      method: 'turn.started',
      turnId: 'turn-compact-2',
    } as any);
    handleRuntimeErrorEvent({
      eventId: 'evt-compact-5',
      provider: 'claude',
      threadId,
      createdAt: at,
      method: 'runtime.error',
      severity: 'error',
      message: 'engine crashed',
    } as any);

    chat = activeChatsStore.getSnapshot()[threadId];
    // this used to assert TWO cards, which is the
    // defect that review names — the previous turn's failure card survived
    // beside the new turn's, both claiming the conversation. A card is a
    // statement about one turn, so the earlier turn's is pruned and the new
    // failure is NOT compacted into it (the counts above still prove
    // compaction works WITHIN a turn).
    expect(
      chat?.messages?.filter((message) =>
        message.content.includes('[CHAT_ERROR]'),
      ),
    ).toHaveLength(1);
    expect(chat?.messages?.at(-1)?.content).toBe(
      '[SYSTEM_EVENT] [CHAT_ERROR] engine crashed',
    );
    expect(chat?.messages?.at(-1)?.turnId).toBe('turn-compact-2');
  });
});
