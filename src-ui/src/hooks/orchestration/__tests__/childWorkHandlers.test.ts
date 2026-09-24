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
