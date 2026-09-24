/**
 * #2456: the client's child-work path. Since #2457 the Claude adapter emits
 * `child-work.updated`; the `claude-code` `task/registry` / `task/settled`
 * tuples these tests feed are the REPLAY path for pre-#2457 history, driven
 * end to end: the real extension handler → the contract translator → the
 * reducer → the derived `ChatUIState.backgroundTasks` and the settle
 * announcement.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type Store = import('../../../contexts/active-chats-store').ActiveChatsStore;
type Handlers = typeof import('../childWorkHandlers');
type Extension = typeof import('../extensionHandlers');

let activeChatsStore: Store;
let handlers: Handlers;
let handleExtensionNotificationEvent: Extension['handleExtensionNotificationEvent'];

const threadId = 'thread-cw-1';
let seq = 0;

function tuple(type: 'task/registry' | 'task/settled', payload: unknown) {
  seq += 1;
  handleExtensionNotificationEvent({
    eventId: `evt-${seq}`,
    provider: 'claude',
    threadId,
    createdAt: `2026-09-23T00:00:${String(seq).padStart(2, '0')}.000Z`,
    method: 'extension.notification',
    namespace: 'claude-code',
    type,
    payload,
  });
}

const chat = () => activeChatsStore.getSnapshot()[threadId];
const announcements = () =>
  (chat()?.ephemeralMessages ?? []).map((message) => message.content);

describe('child-work client path (legacy Claude tuples → contract reducer)', () => {
  beforeEach(async () => {
    seq = 0;
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
    ({ activeChatsStore } = await import(
      '../../../contexts/active-chats-store'
    ));
    handlers = await import('../childWorkHandlers');
    ({ handleExtensionNotificationEvent } = await import(
      '../extensionHandlers'
    ));
    activeChatsStore.initChat(threadId, {
      agentSlug: 'claude-agent',
      agentName: 'Claude',
      title: 'Claude Chat',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../../contexts/active-chats-store');
    vi.resetModules();
  });

  test('a registry derives every running task with its stop address and depth; settling one keeps its sibling', () => {
    tuple('task/registry', {
      active: [
        {
          taskId: 'a',
          toolCallId: 'toolu-a',
          description: 'Explore',
          subagentType: 'Explore',
          backgrounded: true,
          spawnDepth: 2,
        },
        { taskId: 'b', toolCallId: 'toolu-b', description: 'Lint' },
      ],
    });
    expect(chat()?.backgroundTasks).toEqual([
      {
        taskId: 'a',
        toolCallId: 'toolu-a',
        description: 'Explore',
        subagentType: 'Explore',
        backgrounded: true,
        spawnDepth: 2,
        sessionThreadId: threadId,
        // #2459: the legacy Claude translator's per-task stop seam, carried.
        stop: 'provider-task-stop',
      },
      {
        taskId: 'b',
        toolCallId: 'toolu-b',
        description: 'Lint',
        backgrounded: false,
        sessionThreadId: threadId,
        stop: 'provider-task-stop',
      },
    ]);

    // The adapter's order: the settle, then the registry it left behind.
    tuple('task/settled', { taskId: 'b', status: 'success' });
    tuple('task/registry', {
      active: [{ taskId: 'a', toolCallId: 'toolu-a', backgrounded: true }],
    });
    expect(chat()?.backgroundTasks?.map((task) => task.taskId)).toEqual(['a']);
  });

  test('replaying the same tuple sequence (cursor replay) announces once and leaves nothing running', () => {
    const sequence = () => {
      tuple('task/registry', {
        active: [{ taskId: 'a', description: 'Research', backgrounded: true }],
      });
      tuple('task/settled', {
        taskId: 'a',
        description: 'Research',
        backgrounded: true,
        status: 'success',
      });
      tuple('task/settled', {
        taskId: 'a',
        description: 'Research',
        backgrounded: true,
        status: 'success',
        summary: 'Found it.',
      });
      tuple('task/registry', { active: [] });
    };
    sequence();
    sequence();
    expect(announcements()).toEqual([
      'Background task finished — Research\n\nFound it.',
    ]);
    expect(chat()?.backgroundTasks).toEqual([]);
  });

  test('a task the registry listed as foreground but whose settle says backgrounded is announced', () => {
    tuple('task/registry', {
      active: [{ taskId: 'a', description: 'Deep dive', backgrounded: false }],
    });
    tuple('task/settled', {
      taskId: 'a',
      description: 'Deep dive',
      backgrounded: true,
      status: 'error',
      summary: 'crashed',
    });
    expect(announcements()).toEqual([
      'Background task failed — Deep dive\n\ncrashed',
    ]);
  });

  test('a stopped backgrounded task with only a transcript file announces the stop heading', () => {
    tuple('task/settled', {
      taskId: 'a',
      backgrounded: true,
      status: 'cancelled',
      outputFile: '/tmp/a.jsonl',
    });
    expect(announcements()).toEqual(['⏹ Background task stopped']);
  });

  test('#2459: a settle with no observed outcome is never announced as finished', () => {
    // The legacy tuple's unknown status translates to `unresolved`.
    tuple('task/settled', {
      taskId: 'a',
      description: 'Mystery',
      backgrounded: true,
      status: 'timeout',
      summary: 'partial notes',
    });
    handlers.applyChildWorkToChat(threadId, {
      kind: 'settle',
      producer: 'engine-subagent',
      reporterThreadId: threadId,
      childId: 'b',
      status: 'stopped-unconfirmed',
      result: { summary: 'still going?' },
      identity: { title: 'Runaway', backgrounded: true },
    });
    expect(announcements()).toEqual([
      'Background task ended — outcome unknown — Mystery\n\npartial notes',
      'Background task stop requested — not confirmed — Runaway\n\nstill going?',
    ]);
  });

  test('a reconnect snapshot view is authoritative: an omitted task stops reading as running, and its later real settle still announces', () => {
    tuple('task/registry', {
      active: [{ taskId: 'a', description: 'Long job', backgrounded: true }],
    });
    handlers.applySnapshotChildWork(threadId, {
      observability: 'reported',
      running: [],
      observedAt: '2026-09-23T00:01:00.000Z',
    });
    expect(chat()?.backgroundTasks).toEqual([]);
    expect(announcements()).toEqual([]);

    tuple('task/settled', {
      taskId: 'a',
      description: 'Long job',
      backgrounded: true,
      status: 'success',
      summary: 'done',
    });
    expect(announcements()).toEqual([
      'Background task finished — Long job\n\ndone',
    ]);
  });

  test('a not-reported snapshot view is carried, not rendered as running work', () => {
    handlers.applySnapshotChildWork(threadId, {
      observability: 'not-reported',
      reason: 'The engine reports no subagent identity.',
    });
    expect(handlers.childWorkRegistrySnapshot().notReported[threadId]).toBe(
      'The engine reports no subagent identity.',
    );
    expect(chat()?.backgroundTasks ?? []).toEqual([]);
  });

  test('a snapshot view for a chat this client does not track is ignored', () => {
    handlers.applySnapshotChildWork('thread-unknown', {
      observability: 'not-reported',
      reason: 'r',
    });
    expect(handlers.childWorkRegistrySnapshot().notReported).toEqual({});
  });

  test('after the session ends, a later delta does not re-derive the dead set', () => {
    tuple('task/registry', {
      active: [{ taskId: 'a', description: 'Ghost', backgrounded: true }],
    });
    handlers.forgetChildWorkForThread(threadId);
    activeChatsStore.updateChat(threadId, { backgroundTasks: undefined });
    tuple('task/settled', { taskId: 'z', status: 'success' });
    expect(chat()?.backgroundTasks).toEqual([]);
  });

  test('R2/V2: after a server restart, the reconnect snapshot clears a child the dead process was running', async () => {
    const { applyOrchestrationSnapshot } = await import('../snapshotHandlers');
    tuple('task/registry', {
      active: [{ taskId: 'a', description: 'Long job', backgrounded: true }],
    });
    // A snapshot that carries a running child reaches the chat…
    applyOrchestrationSnapshot({
      sessions: [
        {
          provider: 'claude',
          threadId,
          status: 'running',
          hasActiveTurn: false,
          childWork: {
            children: {
              observability: 'reported',
              running: [
                {
                  producer: 'engine-subagent',
                  reporterThreadId: threadId,
                  childId: 'b',
                  status: 'running',
                  title: 'From the snapshot',
                },
              ],
              observedAt: '2026-09-23T00:05:00.000Z',
            },
          },
        },
      ],
    });
    expect(chat()?.backgroundTasks?.map((task) => task.taskId)).toEqual(['b']);

    // …and the restarted server's truthful empty view clears it.
    applyOrchestrationSnapshot({
      sessions: [
        {
          provider: 'claude',
          threadId,
          status: 'ready',
          hasActiveTurn: false,
          childWork: {
            children: {
              observability: 'reported',
              running: [],
              observedAt: '2026-09-23T00:06:00.000Z',
            },
          },
        },
      ],
    });
    expect(chat()?.backgroundTasks).toEqual([]);
    expect(announcements()).toEqual([]);
  });

  test('ordered parent activity keeps Home and dock active without offering Stop or Steer during child work; reconnect restores it', async () => {
    const { isTurnInFlight } = await import(
      '../../../contexts/active-chats-state'
    );
    const { isSessionExecutionActive, isSessionWorkActive } = await import(
      '../../../utils/execution'
    );
    const { buildHomeWorkItems } = await import(
      '../../../views/home/home-view-model'
    );
    const { partitionHomeWorkItems } = await import(
      '../../../views/home/home-lane-model'
    );
    const { applyOrchestrationSnapshot } = await import('../snapshotHandlers');
    activeChatsStore.updateChat(threadId, {
      conversationId: threadId,
      status: 'idle',
      messages: [{ role: 'user', content: 'work', timestamp: 1 }],
    });
    const states = [
      {
        openTurn: {
          turnId: 'turn-1',
          threadId,
          startedAt: '2026-09-24T00:00:00Z',
        },
      },
      { runningChildWork: { count: 1, producers: ['engine-subagent'] } },
      { runningChildWork: { count: 0, producers: [], followUpPending: true } },
      {
        openTurn: {
          turnId: 'provider-1',
          threadId,
          startedAt: '2026-09-24T00:00:20Z',
          trigger: 'provider',
        },
      },
      {},
    ] as const;
    for (const [index, state] of states.entries()) {
      const activity = {
        conversationId: threadId,
        asOfSequence: index + 1,
        ...state,
      } as any;
      activeChatsStore.applyConversationActivity(activity);
      const chat = activeChatsStore.getSnapshot()[threadId]!;
      const summary = {
        provider: 'claude',
        threadId,
        conversationId: threadId,
        status: 'ready',
        lifecycleState: 'completed',
        hasActiveTurn: Boolean(activity.openTurn),
        createdAt: '2026-09-24T00:00:00Z',
        updatedAt: '2026-09-24T00:00:30Z',
        answerability: { answerable: true },
        conversationActivity: activity,
      } as any;
      const row = buildHomeWorkItems({
        chats: { [threadId]: chat },
        agents: [],
        sessions: [summary],
      }).find((item) => item.conversationId === threadId)!;
      const active = index < 4;
      expect(row.lifecycleLabel).toBe(active ? 'Running' : 'Completed');
      if (index === 1 || index === 2)
        expect(row.activeReason).toBe('background');
      expect(
        partitionHomeWorkItems({
          items: [row],
          now: Date.now(),
          snoozedUntil: new Map(),
          terminalSince: new Map(),
        }).active.length,
      ).toBe(active ? 1 : 0);
      expect([chat].filter(isSessionWorkActive)).toHaveLength(active ? 1 : 0);
      const turnActive = index === 0 || index === 3;
      expect(isTurnInFlight(chat)).toBe(turnActive);
      expect(isSessionExecutionActive(chat)).toBe(turnActive);
    }
    const reconnectActivity = {
      conversationId: threadId,
      asOfSequence: 6,
      runningChildWork: { count: 1, producers: ['engine-subagent'] },
    } as any;
    applyOrchestrationSnapshot({
      sessions: [
        {
          provider: 'claude',
          threadId,
          conversationId: threadId,
          status: 'ready',
          hasActiveTurn: false,
          conversationActivity: reconnectActivity,
          childWork: {
            children: {
              observability: 'reported',
              observedAt: '2026-09-24T00:00:31Z',
              running: [
                {
                  producer: 'engine-subagent',
                  reporterThreadId: threadId,
                  childId: 'reconnected',
                  status: 'running',
                },
              ],
            },
          },
        },
      ],
    });
    const restored = activeChatsStore.getSnapshot()[threadId]!;
    expect(restored.conversationActivity?.runningChildWork?.count).toBe(1);
    expect(isSessionWorkActive(restored)).toBe(true);
    expect(isTurnInFlight(restored)).toBe(false);
  });

  test("an older server's snapshot row (no childWork) leaves the running set alone", async () => {
    const { applyOrchestrationSnapshot } = await import('../snapshotHandlers');
    tuple('task/registry', {
      active: [{ taskId: 'a', description: 'Long job', backgrounded: true }],
    });
    applyOrchestrationSnapshot({
      sessions: [
        { provider: 'claude', threadId, status: 'ready', hasActiveTurn: false },
      ],
    });
    expect(chat()?.backgroundTasks?.map((task) => task.taskId)).toEqual(['a']);
  });

  test('R1: two sessions resolving to one chat both show their children, and a settle on one leaves the other', () => {
    const continuation = `${threadId}:session:child`;
    activeChatsStore.updateChat(threadId, { currentSessionId: continuation });
    tuple('task/registry', {
      active: [{ taskId: 'root-task', description: 'Root work' }],
    });
    handleExtensionNotificationEvent({
      eventId: 'child-registry',
      provider: 'claude',
      threadId: continuation,
      createdAt: '2026-09-23T00:01:00.000Z',
      method: 'extension.notification',
      namespace: 'claude-code',
      type: 'task/registry',
      payload: {
        active: [{ taskId: 'child-task', description: 'Child work' }],
      },
    });
    expect(
      chat()?.backgroundTasks?.map((task) => [
        task.taskId,
        task.sessionThreadId,
      ]),
    ).toEqual([
      ['root-task', threadId],
      ['child-task', continuation],
    ]);

    handleExtensionNotificationEvent({
      eventId: 'child-settled',
      provider: 'claude',
      threadId: continuation,
      createdAt: '2026-09-23T00:01:01.000Z',
      method: 'extension.notification',
      namespace: 'claude-code',
      type: 'task/settled',
      payload: { taskId: 'child-task', status: 'success' },
    });
    expect(chat()?.backgroundTasks?.map((task) => task.taskId)).toEqual([
      'root-task',
    ]);

    // Ending one session drops only its children; the sibling's remain.
    handlers.forgetChildWorkForThread(continuation);
    expect(chat()?.backgroundTasks?.map((task) => task.taskId)).toEqual([
      'root-task',
    ]);
  });

  describe("D2: a rebound chat does not keep a former session's children", () => {
    const former = `${threadId}:session:x`;
    const current = `${threadId}:session:y`;
    const reportFrom = (reporter: string, active: unknown[]) =>
      handleExtensionNotificationEvent({
        eventId: `reg-${reporter}-${active.length}`,
        provider: 'claude',
        threadId: reporter,
        createdAt: '2026-09-23T00:02:00.000Z',
        method: 'extension.notification',
        namespace: 'claude-code',
        type: 'task/registry',
        payload: { active },
      });

    beforeEach(() => {
      // The root session (the chat key itself) has a genuinely running
      // backgrounded child alongside the continuation — R1 must keep it.
      tuple('task/registry', {
        active: [
          { taskId: 'root-bg', description: 'Root', backgrounded: true },
        ],
      });
      activeChatsStore.updateChat(threadId, { currentSessionId: former });
      reportFrom(former, [{ taskId: 'x-task', description: 'Former' }]);
      expect(chat()?.backgroundTasks?.map((task) => task.taskId)).toEqual([
        'root-bg',
        'x-task',
      ]);
      // A reconnect rebinds the chat to a newer session: the former one no
      // longer resolves to this chat.
      activeChatsStore.updateChat(threadId, { currentSessionId: current });
      expect(activeChatsStore.getChatKeyForExecutionSession(former)).toBe(
        undefined,
      );
    });

    test("the former session's empty snapshot view clears its child through the recorded chat", async () => {
      const { applyOrchestrationSnapshot } = await import(
        '../snapshotHandlers'
      );
      applyOrchestrationSnapshot({
        sessions: [
          { provider: 'claude', threadId, status: 'ready' },
          {
            provider: 'claude',
            threadId: former,
            status: 'ready',
            hasActiveTurn: false,
            childWork: {
              children: {
                observability: 'reported',
                running: [],
                observedAt: '2026-09-23T00:03:00.000Z',
              },
            },
          },
        ],
      });
      expect(chat()?.backgroundTasks?.map((task) => task.taskId)).toEqual([
        'root-bg',
      ]);
    });

    test("the former session's exit clears its child even though it no longer has a chat", async () => {
      const { handleOrchestrationEvent } = await import('../eventHandlers');
      handleOrchestrationEvent('http://api', {
        provider: 'claude',
        threadId: former,
        createdAt: '2026-09-23T00:03:00.000Z',
        method: 'session.exited',
      } as never);
      expect(chat()?.backgroundTasks?.map((task) => task.taskId)).toEqual([
        'root-bg',
      ]);
    });

    test('a full snapshot that no longer lists the former session drops its child', async () => {
      const { applyOrchestrationSnapshot } = await import(
        '../snapshotHandlers'
      );
      applyOrchestrationSnapshot({
        sessions: [{ provider: 'claude', threadId, status: 'ready' }],
      });
      expect(chat()?.backgroundTasks?.map((task) => task.taskId)).toEqual([
        'root-bg',
      ]);
    });
  });

  test('R5: closing the chat forgets every reporter that fed it', () => {
    tuple('task/registry', {
      active: [{ taskId: 'a', description: 'Orphan', backgrounded: true }],
    });
    expect(
      Object.keys(handlers.childWorkRegistrySnapshot().items),
    ).toHaveLength(1);
    activeChatsStore.removeChat(threadId);
    expect(handlers.childWorkRegistrySnapshot().items).toEqual({});
  });

  test("R6: an enriching settle announces under the registry's sticky status, not its own", () => {
    tuple('task/settled', {
      taskId: 'a',
      description: 'Audit',
      backgrounded: true,
      status: 'success',
    });
    // The engine's second terminal disagrees about the outcome; the registry
    // keeps the first, and so must the announcement.
    tuple('task/settled', {
      taskId: 'a',
      description: 'Audit',
      backgrounded: true,
      status: 'error',
      summary: 'All clear.',
    });
    expect(announcements()).toEqual([
      'Background task finished — Audit\n\nAll clear.',
    ]);
  });

  test('V3: a settle that already carried its result announces once, even when a later one adds usage', () => {
    const settled = {
      taskId: 'a',
      description: 'Report',
      backgrounded: true,
      status: 'success',
      summary: 'Written.',
    };
    tuple('task/settled', settled);
    tuple('task/settled', { ...settled, usage: { totalTokens: 10 } });
    expect(announcements()).toEqual([
      'Background task finished — Report\n\nWritten.',
    ]);
  });

  test('child-work.updated folds through the same path; a delta naming another reporter is ignored', () => {
    handlers.handleChildWorkUpdatedEvent({
      provider: 'claude',
      threadId,
      createdAt: '2026-09-23T00:00:00.000Z',
      method: 'child-work.updated',
      delta: {
        kind: 'snapshot',
        producer: 'engine-subagent',
        reporterThreadId: 'someone-else',
        running: [
          {
            producer: 'engine-subagent',
            reporterThreadId: 'someone-else',
            childId: 'x',
            status: 'running',
          },
        ],
      },
    });
    expect(chat()?.backgroundTasks ?? []).toEqual([]);

    handlers.handleChildWorkUpdatedEvent({
      provider: 'claude',
      threadId,
      createdAt: '2026-09-23T00:00:01.000Z',
      method: 'child-work.updated',
      delta: {
        kind: 'upsert',
        item: {
          producer: 'engine-subagent',
          reporterThreadId: threadId,
          childId: 'y',
          status: 'running',
          title: 'Upserted',
        },
      },
    });
    expect(chat()?.backgroundTasks?.map((task) => task.description)).toEqual([
      'Upserted',
    ]);
  });

  test('#2457: a real result drained after the session exited is still announced, and brings no running card back', async () => {
    const { handleOrchestrationEvent } = await import('../eventHandlers');
    const live = 'exec-live';
    activeChatsStore.updateChat(threadId, { currentSessionId: live });
    const key = {
      producer: 'engine-subagent' as const,
      reporterThreadId: live,
    };
    handlers.handleChildWorkUpdatedEvent({
      provider: 'claude',
      threadId: live,
      createdAt: '2026-09-23T00:00:00.000Z',
      method: 'child-work.updated',
      delta: {
        kind: 'snapshot',
        ...key,
        running: [
          {
            ...key,
            childId: 'late',
            status: 'running',
            backgrounded: true,
            title: 'Late one',
          },
        ],
      },
    });
    handleOrchestrationEvent('http://api', {
      provider: 'claude',
      threadId: live,
      createdAt: '2026-09-23T00:00:01.000Z',
      method: 'session.exited',
    } as never);
    expect(chat()?.backgroundTasks ?? []).toEqual([]);
    // The adapter drains the engine's real outcome after the exit.
    handlers.handleChildWorkUpdatedEvent({
      provider: 'claude',
      threadId: live,
      createdAt: '2026-09-23T00:00:02.000Z',
      method: 'child-work.updated',
      delta: {
        kind: 'settle',
        ...key,
        childId: 'late',
        status: 'completed',
        result: { summary: 'Found it' },
        identity: { backgrounded: true, title: 'Late one' },
      },
    });
    expect(announcements()).toEqual([
      'Background task finished — Late one\n\nFound it',
    ]);
    expect(chat()?.backgroundTasks ?? []).toEqual([]);
  });

  test('#2457: a live progress upsert reaches the chat task, so the sheet can show it', () => {
    const item = {
      producer: 'engine-subagent' as const,
      reporterThreadId: threadId,
      childId: 'task-p',
      status: 'running' as const,
      title: 'Run four sleeps',
      controls: { stop: 'provider-task-stop' as const },
    };
    handlers.handleChildWorkUpdatedEvent({
      provider: 'claude',
      threadId,
      createdAt: '2026-09-23T00:00:00.000Z',
      method: 'child-work.updated',
      delta: {
        kind: 'snapshot',
        producer: 'engine-subagent',
        reporterThreadId: threadId,
        running: [item],
      },
    });
    expect(chat()?.backgroundTasks?.[0]?.progress).toBeUndefined();
    handlers.handleChildWorkUpdatedEvent({
      provider: 'claude',
      threadId,
      createdAt: '2026-09-23T00:00:01.000Z',
      method: 'child-work.updated',
      delta: {
        kind: 'upsert',
        item: { ...item, progress: 'Executing second sleep interval.' },
      },
    });
    expect(chat()?.backgroundTasks).toEqual([
      expect.objectContaining({
        taskId: 'task-p',
        description: 'Run four sleeps',
        progress: 'Executing second sleep interval.',
        stop: 'provider-task-stop',
      }),
    ]);
  });
});
