/**
 * #2456: the client's child-work path. Until #2457 the Claude adapter still
 * reports through `claude-code` `task/registry` / `task/settled`, so these
 * drive the LIVE path end to end: the real extension handler → the contract
 * translator → the reducer → the derived `ChatUIState.backgroundTasks` and the
 * settle announcement.
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
      },
      {
        taskId: 'b',
        toolCallId: 'toolu-b',
        description: 'Lint',
        backgrounded: false,
        sessionThreadId: threadId,
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
});
