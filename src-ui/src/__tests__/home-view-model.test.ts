import type {
  OrchestrationSessionSummary,
  TaskRecord,
} from '@kontourai/station-sdk';
import { describe, expect, test } from 'vitest';
import { buildOutgoingUserMessage } from '../hooks/useActiveChatSessions.helpers';
import {
  buildActiveChatTaskItems,
  buildHomeWorkItems,
  chatTaskSessionId,
  type HomeWorkItem,
} from '../views/home/home-view-model';

describe('buildHomeWorkItems', () => {
  test.each([false, true])(
    'opening a handoff conversation cannot promote predecessor metadata (supplied items: %s)',
    (supplied) => {
      const agents = [
        { slug: 'codex', name: 'Codex' },
        { slug: 'claude', name: 'Claude Code' },
      ] as any;
      const sessions = [
        {
          threadId: 'a-predecessor',
          assignedAgentSlug: 'codex',
          provider: 'codex',
          model: 'gpt-5.6-sol',
          updatedAt: '2026-08-25T12:00:00Z',
        },
        {
          threadId: 'z-child',
          assignedAgentSlug: 'claude',
          provider: 'claude',
          model: 'claude-opus-5',
          updatedAt: '2026-08-25T12:01:00Z',
        },
      ].map((session) => ({
        ...session,
        conversationId: 'conversation',
        title: 'Review work',
        createdAt: session.updatedAt,
        status: 'closed',
        lifecycleState: 'completed',
        isLoaded: true,
        isPersisted: true,
        answerability: { answerable: true },
        eventCount: 1,
      })) as any;
      const chats = {
        reopened: {
          conversationId: 'conversation',
          currentSessionId: 'z-child',
          agentSlug: 'claude',
          agentName: 'Claude Code',
          model: 'claude-opus-5',
          title: 'New chat',
          createdAt: Date.parse('2026-08-25T13:00:00Z'),
          messages: [],
        },
      } as any;
      const before = buildHomeWorkItems({ chats: {}, agents, sessions });
      for (const ordered of [sessions, [...sessions].reverse()]) {
        const after = buildHomeWorkItems({
          chats: supplied ? {} : chats,
          agents,
          sessions: ordered,
          ...(supplied
            ? {
                chatItems: buildActiveChatTaskItems({
                  chats,
                  agents,
                  sessions: ordered,
                }),
                currentSessionIdByConversation: new Map([
                  ['conversation', 'z-child'],
                ]),
              }
            : {}),
        });
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({
          agentSlug: 'claude',
          agentLabel: 'Claude Code',
          model: 'claude-opus-5',
          title: before[0].title,
          lifecycleLabel: before[0].lifecycleLabel,
          orchestrationThreadId: 'z-child',
          chatSessionId: 'reopened',
        });
        expect(after[0]).not.toHaveProperty('currentSessionId');
      }
    },
  );
  test('active-chat consumers retain the newest handoff child for one conversation', () => {
    const items = buildActiveChatTaskItems({
      chats: {
        codex: {
          conversationId: 'conversation-1',
          agentSlug: 'codex',
          agentName: 'Codex',
          model: 'gpt-5.6-sol',
          title: 'Old title',
          createdAt: 10,
          messages: [{ timestamp: '2026-08-24T12:00:00Z' }],
        },
        claude: {
          conversationId: 'conversation-1',
          agentSlug: 'claude',
          agentName: 'Claude Code',
          model: 'claude-opus-5',
          title: 'Current title',
          createdAt: 20,
          messages: [{ timestamp: '2026-08-24T12:01:00Z' }],
        },
      } as any,
      agents: [] as any,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      agentSlug: 'claude',
      model: 'claude-opus-5',
      title: 'Current title',
    });
  });

  // #765 A2: the server had folded the conversation's current execution
  // child to `failed` (runtime.error on the second turn), but the chat
  // store's own state was stale ('running', no local error — the exact
  // shape when the client missed or dropped the SSE runtime.error). The row
  // must read Failed from the server fold, never "Active"/Running off local
  // composer state.
  test('a conversation whose current child the server folded to failed reads Failed, not Running', () => {
    const sessions = [
      {
        // The root execution session shares the conversation's id — long
        // completed once continuation children exist. It must NOT be the
        // correlation the chip reads.
        threadId: 'conversation-765',
        conversationId: 'conversation-765',
        provider: 'claude',
        status: 'ready',
        lifecycleState: 'completed',
        hasActiveTurn: false,
        updatedAt: '2026-08-29T12:00:00Z',
        createdAt: '2026-08-29T11:00:00Z',
        isLoaded: true,
        isPersisted: true,
        answerability: { answerable: true },
        eventCount: 4,
      },
      {
        threadId: 'conversation-765:session:child-1',
        conversationId: 'conversation-765',
        provider: 'claude',
        status: 'dead',
        lifecycleState: 'failed',
        hasActiveTurn: false,
        updatedAt: '2026-08-29T12:05:00Z',
        createdAt: '2026-08-29T12:04:00Z',
        isLoaded: true,
        isPersisted: true,
        answerability: { answerable: true },
        eventCount: 6,
      },
    ] as any;
    const chats = {
      'conversation-765': {
        conversationId: 'conversation-765',
        agentSlug: 'claude',
        agentName: 'Claude Code',
        title: 'Second turn chat',
        status: 'idle',
        orchestrationStatus: 'running',
        createdAt: 10,
        messages: [{ timestamp: '2026-08-29T12:05:00Z' }],
      },
    } as any;

    const [item] = buildActiveChatTaskItems({
      chats,
      agents: [] as any,
      sessions,
    });
    expect(item.lifecycleLabel).toBe('Failed');

    // Discriminating control: the same conversation with a genuinely running
    // newest child stays Running — the failed fold must come from the
    // correlated session, not blanket every conversation-keyed chat.
    const [running] = buildActiveChatTaskItems({
      chats,
      agents: [] as any,
      sessions: [
        sessions[0],
        {
          ...sessions[1],
          status: 'running',
          lifecycleState: 'running',
          hasActiveTurn: true,
        },
      ],
    });
    expect(running.lifecycleLabel).toBe('Running');
  });

  test('keeps current session identity private through Home task merging', () => {
    const work = buildHomeWorkItems({
      chats: {},
      agents: [] as any,
      tasks: [],
      chatItems: [
        {
          id: 'local',
          conversationId: 'c',
          kind: 'chat',
          kindLabel: 'Direct chat',
          title: 'Conversation',
          projectLabel: 'No project',
          agentLabel: 'Codex',
          modelLabel: 'Sol',
          updatedAt: 20,
          lifecycleLabel: 'Completed',
          chatSessionId: 'local',
        },
      ] as any,
      sessions: [
        {
          threadId: 'a-predecessor',
          conversationId: 'c',
          assignedAgentSlug: 'codex',
          model: 'gpt-5.6-sol',
          status: 'closed',
          lifecycleState: 'completed',
          updatedAt: '2026-08-24T12:00:00Z',
        },
        {
          threadId: 'z-child',
          conversationId: 'c',
          assignedAgentSlug: 'claude',
          model: 'claude-opus-5',
          status: 'closed',
          lifecycleState: 'completed',
          updatedAt: '2026-08-24T12:00:00Z',
        },
      ] as any,
      currentSessionIdByConversation: new Map([['c', 'z-child']]),
    });
    expect(work[0]).toMatchObject({
      agentSlug: 'claude',
      model: 'claude-opus-5',
    });
    expect(work[0]).not.toHaveProperty('currentSessionId');
  });

  test('uses lifecycle priority when equal-time current-session map is stale', () => {
    const work = buildHomeWorkItems({
      chats: {},
      agents: [] as any,
      tasks: [],
      chatItems: [],
      sessions: [
        {
          threadId: 'a-completed',
          conversationId: 'c',
          assignedAgentSlug: 'codex',
          status: 'closed',
          lifecycleState: 'completed',
          updatedAt: '2026-08-24T12:00:00Z',
        },
        {
          threadId: 'z-needs',
          conversationId: 'c',
          assignedAgentSlug: 'claude',
          status: 'closed',
          lifecycleState: 'failed',
          updatedAt: '2026-08-24T12:00:00Z',
        },
      ] as any,
      currentSessionIdByConversation: new Map([['c', 'missing']]),
    });
    expect(work[0]).toMatchObject({
      agentSlug: 'claude',
      lifecycleLabel: 'Failed',
    });
  });

  test('uses durable currentSessionId on equal timestamps independent of map order', () => {
    const chats = {
      a_predecessor: {
        conversationId: 'c',
        currentSessionId: 'z_child',
        agentSlug: 'codex',
        agentName: 'Codex',
        model: 'gpt',
        title: 'Old',
        createdAt: 20,
        messages: [],
      },
      z_child: {
        conversationId: 'c',
        currentSessionId: 'z_child',
        agentSlug: 'claude',
        agentName: 'Claude',
        model: 'opus',
        title: 'Current',
        createdAt: 20,
        messages: [],
      },
    } as any;
    expect(
      buildActiveChatTaskItems({ chats, agents: [] as any })[0],
    ).toMatchObject({ agentSlug: 'claude', title: 'Current' });
    expect(
      buildActiveChatTaskItems({
        chats: {
          z_child: chats.z_child,
          a_predecessor: chats.a_predecessor,
        },
        agents: [] as any,
      })[0],
    ).toMatchObject({ agentSlug: 'claude', title: 'Current' });
  });

  test('uses canonical lifecycle priority and never folds missing or unrelated conversations', () => {
    const items = buildActiveChatTaskItems({
      chats: {
        running: {
          conversationId: 'same',
          agentSlug: 'run',
          title: 'Run',
          createdAt: 20,
          messages: [],
          status: 'idle',
        },
        attention: {
          conversationId: 'same',
          agentSlug: 'needs',
          title: 'Needs',
          createdAt: 20,
          messages: [],
          status: 'error',
        },
        // #1582 B9: a chat nothing has been put into is not open work at
        // all, so the "no conversation id" case this test is about has to be
        // a chat mid-first-turn — sent, not yet receipted — rather than an
        // untouched draft.
        missingA: {
          agentSlug: 'a',
          title: 'A',
          createdAt: 20,
          messages: [{ timestamp: 20 }],
        },
        missingB: {
          agentSlug: 'b',
          title: 'B',
          createdAt: 20,
          messages: [{ timestamp: 20 }],
        },
        other: {
          conversationId: 'other',
          agentSlug: 'other',
          title: 'Other',
          createdAt: 20,
          messages: [],
        },
      } as any,
      agents: [] as any,
    });
    expect(items).toHaveLength(4);
    expect(items.find((item) => item.conversationId === 'same')).toMatchObject({
      title: 'Needs',
    });
    expect(items.filter((item) => !item.conversationId)).toHaveLength(2);
    expect(items.find((item) => item.conversationId === 'other')).toMatchObject(
      { title: 'Other' },
    );
  });
  test('folds handoff execution sessions into one durable conversation row while retaining current execution lineage', () => {
    const work = buildHomeWorkItems({
      chats: {
        local: {
          conversationId: 'conversation-handoff',
          title: 'Release review',
          agentSlug: 'codex',
          messages: [{ timestamp: 10 }],
        },
      } as any,
      sessions: [
        {
          threadId: 'codex-execution',
          conversationId: 'conversation-handoff',
          assignedAgentSlug: 'codex',
          provider: 'codex',
          model: 'gpt-5.6-terra',
          status: 'closed',
          lifecycleState: 'completed',
          createdAt: '2026-08-24T12:00:00Z',
          updatedAt: '2026-08-24T12:01:00Z',
          isLoaded: true,
          isPersisted: true,
          answerability: { answerable: true },
          eventCount: 1,
        },
        {
          threadId: 'claude-execution',
          conversationId: 'conversation-handoff',
          assignedAgentSlug: 'claude',
          provider: 'claude',
          model: 'claude-opus-5',
          status: 'running',
          lifecycleState: 'running',
          hasActiveTurn: true,
          createdAt: '2026-08-24T12:01:00Z',
          updatedAt: '2026-08-24T12:02:00Z',
          isLoaded: true,
          isPersisted: true,
          answerability: { answerable: true },
          eventCount: 1,
        },
      ] as any,
      agents: [
        { slug: 'codex', name: 'Codex' },
        { slug: 'claude', name: 'Claude' },
      ] as any,
    });

    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      id: 'conversation-handoff',
      conversationId: 'conversation-handoff',
      chatSessionId: 'local',
      orchestrationThreadId: 'claude-execution',
      orchestrationThreadIds: ['codex-execution', 'claude-execution'],
      title: 'Release review',
      agentSlug: 'claude',
      model: 'claude-opus-5',
      lifecycleLabel: 'Running',
    });
  });

  test('reloads a terminal handoff fold with no live chat copy', () => {
    const work = buildHomeWorkItems({
      chats: {},
      sessions: [
        {
          threadId: 'predecessor',
          conversationId: 'conversation-terminal',
          provider: 'codex',
          status: 'closed',
          lifecycleState: 'completed',
          createdAt: '2026-08-24T12:00:00Z',
          updatedAt: '2026-08-24T12:01:00Z',
          isLoaded: true,
          isPersisted: true,
          answerability: { answerable: true },
          eventCount: 1,
        },
        {
          threadId: 'failed-child',
          conversationId: 'conversation-terminal',
          provider: 'claude',
          status: 'closed',
          lifecycleState: 'failed',
          terminalAttribution: {
            kind: 'runtime_error',
            detail: 'Claude stopped unexpectedly.',
          },
          createdAt: '2026-08-24T12:01:00Z',
          updatedAt: '2026-08-24T12:02:00Z',
          isLoaded: true,
          isPersisted: true,
          answerability: { answerable: true },
          eventCount: 1,
        },
      ] as any,
      agents: [],
    });

    expect(work).toEqual([
      expect.objectContaining({
        id: 'conversation-terminal',
        orchestrationThreadId: 'failed-child',
        orchestrationThreadIds: ['predecessor', 'failed-child'],
        lifecycleLabel: 'Failed',
        failureNotice: 'Claude stopped unexpectedly.',
      }),
    ]);
  });

  test('keeps unrelated durable conversations distinct', () => {
    const work = buildHomeWorkItems({
      chats: {},
      sessions: [
        {
          threadId: 'one',
          conversationId: 'conversation-one',
          provider: 'codex',
          status: 'ready',
          lifecycleState: 'completed',
          createdAt: '2026-08-24T12:00:00Z',
          updatedAt: '2026-08-24T12:01:00Z',
          isLoaded: true,
          isPersisted: true,
          answerability: { answerable: true },
          eventCount: 1,
        },
        {
          threadId: 'two',
          conversationId: 'conversation-two',
          provider: 'claude',
          status: 'ready',
          lifecycleState: 'completed',
          createdAt: '2026-08-24T12:00:00Z',
          updatedAt: '2026-08-24T12:02:00Z',
          isLoaded: true,
          isPersisted: true,
          answerability: { answerable: true },
          eventCount: 1,
        },
      ] as any,
      agents: [],
    });

    expect(work.map((item) => item.id)).toEqual([
      'conversation-two',
      'conversation-one',
    ]);
  });

  test('coalesces a chat and orchestration copy while retaining focus and attention', () => {
    const tasks = buildHomeWorkItems({
      chats: {
        local: {
          conversationId: 'thread-1',
          title: 'Review release',
          agentSlug: 'agent',
          messages: [{ timestamp: 10 }],
        },
      } as any,
      sessions: [
        {
          threadId: 'thread-1',
          provider: 'codex',
          status: 'ready',
          lifecycleState: 'review_pending',
          pendingReview: true,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-02',
          isLoaded: true,
          isPersisted: true,
          answerability: { answerable: true },
          eventCount: 1,
        },
      ] as any,
      agents: [{ slug: 'agent', name: 'Agent' }] as any,
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: 'thread-1',
      kind: 'chat',
      chatSessionId: 'local',
      orchestrationThreadId: 'thread-1',
      lifecycleLabel: 'Needs attention',
    });
    expect(chatTaskSessionId(tasks[0])).toBe('local');
  });

  test('uses human lifecycle labels with attention before running and completed work', () => {
    const tasks = buildHomeWorkItems({
      chats: {},
      agents: [],
      sessions: [
        {
          threadId: 'run',
          provider: 'codex',
          status: 'ready',
          lifecycleState: 'running',
          // Since archive#1069 "Running" means a turn is in flight, not merely that a
          // runtime attached. This fixture's subject is label ordering, so it
          // now carries the turn fold that makes it genuinely running.
          hasActiveTurn: true,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-03',
          isLoaded: true,
          isPersisted: true,
          answerability: { answerable: true },
          eventCount: 1,
        },
        {
          threadId: 'done',
          provider: 'codex',
          status: 'closed',
          lifecycleState: 'completed',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-02',
          isLoaded: true,
          isPersisted: true,
          answerability: { answerable: true },
          eventCount: 1,
        },
      ] as any,
    });
    expect(tasks.map((task) => task.lifecycleLabel)).toEqual([
      'Running',
      'Completed',
    ]);
  });

  test('keeps an effective model visible on a restored orchestration row', () => {
    const [item] = buildHomeWorkItems({
      chats: {},
      agents: [],
      sessions: [
        {
          threadId: 'restored-fable',
          provider: 'claude',
          status: 'ready',
          lifecycleState: 'completed',
          effectiveModel: 'claude-fable-5',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-02',
          isLoaded: true,
          isPersisted: true,
          answerability: { answerable: true },
          eventCount: 1,
        },
      ] as any,
    });

    // The claim is WHICH model survives the restore, so it is asserted on the
    // id. `modelLabel` is a derivation of that id (archive#3391) and reads as
    // a name, not as the internal selector.
    expect(item?.model).toBe('claude-fable-5');
    expect(item?.modelLabel).toBe('Fable 5');
  });

  test('prefers the independently reported model over a malformed legacy selector', () => {
    const [item] = buildHomeWorkItems({
      chats: {},
      agents: [],
      sessions: [
        {
          threadId: 'restored-fable-legacy-selector',
          provider: 'claude',
          status: 'ready',
          lifecycleState: 'completed',
          effectiveModel: 'claude-fable-5[1m]',
          reportedModel: 'claude-fable-5',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-02',
          isLoaded: true,
          isPersisted: true,
          answerability: { answerable: true },
          eventCount: 1,
        },
      ] as any,
    });

    expect(item?.model).toBe('claude-fable-5');
    expect(item?.modelLabel).toBe('Fable 5');
  });

  test('humanizes delegated task identifiers without runtime wording', () => {
    const [task] = buildHomeWorkItems({
      chats: {},
      agents: [],
      sessions: [
        {
          threadId: 'thread/runtime-id',
          provider: 'codex',
          status: 'ready',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
          isLoaded: true,
          isPersisted: true,
          answerability: { answerable: true },
          eventCount: 1,
          delegation: { taskId: 'task:delegated-review' },
        },
      ] as any,
    });
    // archive#3227 A2: was `'Delegated Review'`. Home's private copy stripped
    // the `task:` prefix with its own regex and then Title-Cased the result;
    // `sessionTitle` (which the sessions list and project page already read)
    // keeps the id's own casing behind an explicit "Worker task ·" prefix, so
    // the reader can tell a task id from a human-written title. The
    // no-raw-id assertion below is the load-bearing one and is unchanged.
    expect(task.title).toBe('Worker task · delegated review');
    expect(task.title).not.toMatch(/runtime|task:/i);
  });

  test('never exposes an internal external-agent thread or virtual-agent id', () => {
    const [task] = buildHomeWorkItems({
      chats: {},
      agents: [],
      sessions: [
        {
          threadId: 'kiro:opaque-runtime-thread',
          provider: 'acp',
          assignedAgentSlug: 'kiro',
          status: 'ready',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
          isLoaded: false,
          isPersisted: true,
          answerability: { answerable: true },
          eventCount: 0,
        },
      ] as any,
    });
    // archive#3227 A2/A4: was `'kiro task'`. The title is the ENGINE's name
    // now, not the assigned agent's — `sessionTitle` names the engine that
    // ran the session, and `agentLabel` (asserted immediately below, and
    // rendered as its own field on every Home row that shows an agent) is
    // still where the agent's identity lives. No information leaves the row;
    // it stops being said twice, differently, in two places.
    expect(task.title).toBe('Custom engine session');
    expect(task.agentLabel).toBe('kiro');
    expect(`${task.title} ${task.agentLabel}`).not.toMatch(/opaque/i);
  });

  test('never exposes an internal runtime-agent id without cached metadata', () => {
    const tasks = buildHomeWorkItems({
      chats: {
        local: {
          agentSlug: 'codex',
          // #1582 B9: a message-less, conversation-less chat is a draft and
          // no longer reaches Home at all. This one is a real chat.
          messages: [{ timestamp: 20 }],
        },
      } as any,
      agents: [],
      sessions: [
        {
          // This opaque execution id is intentionally distinct from both the
          // visible Codex engine and the public assigned-agent slug. If Home
          // falls back to its internal session identity, the assertion below
          // must fail instead of mistaking a valid Codex label for a leak.
          threadId: 'codex-runtime',
          provider: 'codex',
          assignedAgentSlug: 'codex',
          status: 'ready',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
          isLoaded: true,
          isPersisted: true,
          answerability: { answerable: true },
          eventCount: 0,
        },
      ] as any,
    });
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Codex Chat' }),
        // archive#3227 A2: was `'codex task'` — see the engine-vs-agent note
        // above. `agentLabel` still pins the slug, which is what this test
        // is actually about (no raw runtime id reaches either field).
        expect.objectContaining({
          title: 'Codex session',
          agentLabel: 'Codex',
        }),
      ]),
    );
    expect(
      tasks.map((task) => `${task.title} ${task.agentLabel}`).join(' '),
    ).not.toContain('codex-runtime');
  });

  test('shows a durable Task once while removing only exactly correlated chats and sessions', () => {
    const work = buildHomeWorkItems({
      chats: {
        local: {
          conversationId: 'session-1',
          title: 'Raw correlated chat',
          messages: [{ timestamp: 20 }],
        },
      } as any,
      sessions: [
        {
          threadId: 'session-1',
          provider: 'codex',
          status: 'ready',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-02',
          isLoaded: true,
          isPersisted: true,
          answerability: { answerable: true },
          eventCount: 1,
        },
      ] as any,
      tasks: [
        {
          id: 'task-1',
          projectId: 'project-alpha',
          title: 'Persisted Task',
          status: 'running',
          priority: 'normal',
          description: '',
          createdBy: 'user',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-03T00:00:00Z',
          sessionId: 'session-1',
        },
      ] as any,
      agents: [],
    });

    expect(work).toEqual([
      expect.objectContaining({
        id: 'task-1',
        kind: 'task',
        title: 'Persisted Task',
        projectLabel: 'project-alpha',
        agentLabel: 'Agent unavailable',
        modelLabel: 'Model unavailable',
        taskSessionId: 'session-1',
      }),
    ]);
  });

  test('does not correlate a durable Task by title or infer optional identity', () => {
    const work = buildHomeWorkItems({
      chats: {
        local: {
          title: 'Same title',
          messages: [{ timestamp: 20 }],
        },
      } as any,
      sessions: [],
      tasks: [
        {
          id: 'task-without-session',
          projectId: 'project-alpha',
          title: 'Same title',
          status: 'todo',
          priority: 'normal',
          description: '',
          createdBy: 'user',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        },
      ] as any,
      agents: [],
    });

    expect(work).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'task-without-session',
          kind: 'task',
          taskSessionId: undefined,
          agentLabel: 'Agent unavailable',
          modelLabel: 'Model unavailable',
        }),
        expect.objectContaining({ kind: 'chat', title: 'Same title' }),
      ]),
    );
  });

  test('labels a canceled durable Task as Stopped, never Completed', () => {
    const canceledTask = {
      id: 'task-canceled',
      projectId: 'project-alpha',
      title: 'Abandoned task',
      status: 'canceled',
      priority: 'normal',
      description: '',
      createdBy: 'user',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    } satisfies TaskRecord;
    const [item] = buildHomeWorkItems({
      chats: {},
      sessions: [],
      tasks: [canceledTask],
      agents: [],
    });

    expect(item.lifecycleLabel).toBe('Stopped');
  });
});

describe('orchestration Running is gated on an in-flight turn (#1069)', () => {
  // Shape copied from a live read-model row on the brian-media dogfood
  // instance, where 13 of 24 sessions rendered "Running" indefinitely.
  const attachedButIdle = {
    threadId: 'codex:1784515865925',
    provider: 'codex',
    assignedAgentSlug: 'codex',
    status: 'ready',
    lifecycleState: 'running',
    previousLifecycleState: 'queued',
    transitionReason: 'session_configured',
    transitionSource: 'runtime',
    lastEventMethod: 'session.configured',
    hasActiveTurn: false,
    pendingReview: false,
    createdAt: '2026-07-28T13:28:00Z',
    updatedAt: '2026-07-28T13:28:00Z',
    isLoaded: true,
    isPersisted: true,
    answerability: { answerable: true },
    eventCount: 1090,
  };

  test('a session that only attached is Ready, not Running', () => {
    const [item] = buildHomeWorkItems({
      chats: {},
      agents: [],
      sessions: [attachedButIdle] as any,
    });
    expect(item.lifecycleLabel).toBe('Ready');
  });

  test('a session with a turn in flight is Running', () => {
    const [item] = buildHomeWorkItems({
      chats: {},
      agents: [],
      sessions: [{ ...attachedButIdle, hasActiveTurn: true }] as any,
    });
    expect(item.lifecycleLabel).toBe('Running');
  });

  test('a blocked session still outranks the turn fold', () => {
    const [item] = buildHomeWorkItems({
      chats: {},
      agents: [],
      sessions: [{ ...attachedButIdle, lifecycleState: 'needs_input' }] as any,
    });
    expect(item.lifecycleLabel).toBe('Needs attention');
  });

  test('a closed session stays Completed even if a turn fold lingers', () => {
    const [item] = buildHomeWorkItems({
      chats: {},
      agents: [],
      sessions: [
        { ...attachedButIdle, status: 'closed', hasActiveTurn: true },
      ] as any,
    });
    expect(item.lifecycleLabel).toBe('Completed');
  });

  // archive#1296: a sticky `pendingReview` (a resolution that bypassed the
  // normal respond/stop path) must never outrank a session that has actually
  // completed — this is the UI half of the fix; the server half stops
  // `pendingReview` from surviving a terminal transition in the first place
  // (session-lifecycle-service.test.ts).
  test('a completed session never reads Needs attention even with a sticky pendingReview', () => {
    const [item] = buildHomeWorkItems({
      chats: {},
      agents: [],
      sessions: [
        {
          ...attachedButIdle,
          lifecycleState: 'completed',
          pendingReview: true,
        },
      ] as any,
    });
    expect(item.lifecycleLabel).toBe('Completed');
  });

  test('a canceled session never reads Needs attention even with a sticky pendingReview', () => {
    const [item] = buildHomeWorkItems({
      chats: {},
      agents: [],
      sessions: [
        {
          ...attachedButIdle,
          lifecycleState: 'canceled',
          pendingReview: true,
        },
      ] as any,
    });
    expect(item.lifecycleLabel).toBe('Stopped');
  });

  // A genuinely failed run is terminal and must never borrow the actionable
  // label reserved for approval/input/review/blocked work.
  test('a failed session reads Failed', () => {
    const [item] = buildHomeWorkItems({
      chats: {},
      agents: [],
      sessions: [{ ...attachedButIdle, lifecycleState: 'failed' }] as any,
    });
    expect(item.lifecycleLabel).toBe('Failed');
  });

  // archive#1296: `status` (transport)
  // and `lifecycleState` (event-fold outcome) are independent — a crashed
  // runtime (lifecycleState 'failed' via runtime.error) commonly also has
  // its connection torn down (status 'closed') once the process exits. The
  // completed/closed branch checked `status === 'closed'` on its own,
  // regardless of lifecycleState, so this exact combination previously
  // read "Completed" instead of "Needs attention".
  test('a failed session with a closed transport status reads Failed, never Completed', () => {
    const [item] = buildHomeWorkItems({
      chats: {},
      agents: [],
      sessions: [
        { ...attachedButIdle, status: 'closed', lifecycleState: 'failed' },
      ] as any,
    });
    expect(item.lifecycleLabel).toBe('Failed');
  });
});

describe('orchestration display identity', () => {
  test('prefers the bounded server display title and renders compact cwd metadata', () => {
    const [item] = buildHomeWorkItems({
      chats: {},
      agents: [],
      sessions: [
        {
          threadId: 'title-thread',
          provider: 'codex',
          status: 'ready',
          displayTitle: 'Ship the Home history fix',
          cwd: '/Users/brian/dev/github/kontourai/station-worktrees/ui-chat-project-affordances',
          createdAt: '2026-07-30T00:00:00Z',
          updatedAt: '2026-07-30T00:00:00Z',
          isLoaded: true,
          isPersisted: true,
          answerability: { answerable: true },
          eventCount: 1,
        },
      ] as any,
    });

    expect(item.title).toBe('Ship the Home history fix');
    expect(item.cwdLabel).toBe(
      '…/station-worktrees/ui-chat-project-affordances',
    );
  });

  test('falls back to the existing task title when historical sessions lack a prompt title', () => {
    const [item] = buildHomeWorkItems({
      chats: {},
      agents: [{ slug: 'agent', name: 'Planner' }] as any,
      sessions: [
        {
          threadId: 'legacy-title-thread',
          provider: 'codex',
          status: 'ready',
          assignedAgentSlug: 'agent',
          delegation: { taskId: 'task:review-history' },
          createdAt: '2026-07-30T00:00:00Z',
          updatedAt: '2026-07-30T00:00:00Z',
          isLoaded: true,
          isPersisted: true,
          answerability: { answerable: true },
          eventCount: 0,
        },
      ] as any,
    });

    // archive#3227 A2: was `'Review History'` (Home's Title-Casing of the
    // task id). Same canonical form as the delegated-title test above.
    expect(item.title).toBe('Worker task · review history');
    expect(item.cwdLabel).toBeUndefined();
  });
});

describe('chat items borrow the session turn fold (#1074 review finding)', () => {
  const attachedSession = {
    threadId: 'thread-attached',
    provider: 'codex',
    status: 'ready',
    lifecycleState: 'running',
    hasActiveTurn: false,
    createdAt: '2026-07-28T13:00:00Z',
    updatedAt: '2026-07-28T13:00:00Z',
    isLoaded: true,
    isPersisted: true,
    answerability: { answerable: true },
    eventCount: 5,
  };

  test('a stale chat orchestrationStatus cannot override the fold at merge time', () => {
    const [item] = buildHomeWorkItems({
      chats: {
        'thread-attached': {
          conversationId: 'thread-attached',
          title: 'Attached chat',
          agentSlug: 'agent',
          orchestrationStatus: 'running',
          messages: [{ timestamp: 20 }],
        },
      } as any,
      agents: [{ slug: 'agent', name: 'Agent' }] as any,
      sessions: [attachedSession] as any,
    });
    // Pre-fix this merged to 'Running': the chat copy said Running (ungated
    // process status) and moreImportantLifecycle prefers the higher priority.
    expect(item.lifecycleLabel).toBe('Ready');
  });

  test('a chat whose session really has a turn in flight stays Running', () => {
    const [item] = buildHomeWorkItems({
      chats: {
        'thread-attached': {
          conversationId: 'thread-attached',
          title: 'Attached chat',
          agentSlug: 'agent',
          orchestrationStatus: 'running',
          messages: [{ timestamp: 20 }],
        },
      } as any,
      agents: [{ slug: 'agent', name: 'Agent' }] as any,
      sessions: [{ ...attachedSession, hasActiveTurn: true }] as any,
    });
    expect(item.lifecycleLabel).toBe('Running');
  });

  test('local send optimism still reads Running before the first turn event', () => {
    const [item] = buildHomeWorkItems({
      chats: {
        'thread-attached': {
          conversationId: 'thread-attached',
          title: 'Attached chat',
          agentSlug: 'agent',
          status: 'sending',
          messages: [{ timestamp: 20 }],
        },
      } as any,
      agents: [{ slug: 'agent', name: 'Agent' }] as any,
      sessions: [attachedSession] as any,
    });
    expect(item.lifecycleLabel).toBe('Running');
  });

  test('an errored chat reads Failed and outranks a correlated Running session', () => {
    const [item] = buildHomeWorkItems({
      chats: {
        local: {
          conversationId: 'failed-chat-thread',
          title: 'Failed chat',
          status: 'error',
          messages: [{ timestamp: 20 }],
        },
      } as any,
      agents: [],
      sessions: [
        {
          ...attachedSession,
          threadId: 'failed-chat-thread',
          hasActiveTurn: true,
        },
      ] as any,
    });

    expect(item.lifecycleLabel).toBe('Failed');
  });

  test('a chat with no correlated session keeps its own signal', () => {
    const [item] = buildHomeWorkItems({
      chats: {
        local: {
          conversationId: 'no-session',
          title: 'Local chat',
          agentSlug: 'agent',
          orchestrationStatus: 'running',
          messages: [{ timestamp: 20 }],
        },
      } as any,
      agents: [{ slug: 'agent', name: 'Agent' }] as any,
      sessions: [],
    });
    expect(item.lifecycleLabel).toBe('Running');
  });
});

test('a present-but-uncorrelated conversationId never borrows another session fold', () => {
  const items = buildHomeWorkItems({
    chats: {
      // Store key collides with a real, unrelated session's threadId while the
      // chat's own conversationId correlates with nothing. The merge keys on
      // conversationId, so this chat is never paired with that session — its
      // label must not borrow that session's fold either.
      'thread-unrelated': {
        conversationId: 'conv-not-a-session',
        title: 'Uncorrelated chat',
        agentSlug: 'agent',
        orchestrationStatus: 'running',
        messages: [{ timestamp: 20 }],
      },
    } as any,
    agents: [{ slug: 'agent', name: 'Agent' }] as any,
    sessions: [
      {
        threadId: 'thread-unrelated',
        provider: 'codex',
        status: 'ready',
        lifecycleState: 'running',
        hasActiveTurn: false,
        createdAt: '2026-07-28T13:00:00Z',
        updatedAt: '2026-07-28T13:00:00Z',
        isLoaded: true,
        isPersisted: true,
        answerability: { answerable: true },
        eventCount: 5,
      },
    ] as any,
  });
  // Both items exist and are NOT merged (different ids) — assert the chat's
  // own label, not whichever sorted first.
  const chatItem = items.find((item) => item.kind === 'chat');
  expect(chatItem?.id).toBe('conv-not-a-session');
  expect(chatItem?.lifecycleLabel).toBe('Running');
});

describe('buildHomeWorkItems remote-session read augmentation (station#1097)', () => {
  const LOCAL_SESSION = {
    threadId: 'local-thread',
    provider: 'codex',
    status: 'ready',
    lifecycleState: 'running',
    hasActiveTurn: true,
    createdAt: '2026-07-28T13:00:00Z',
    updatedAt: '2026-07-28T13:00:00Z',
    isLoaded: true,
    isPersisted: true,
    answerability: { answerable: true },
    eventCount: 1,
  };
  const REMOTE_SESSION = {
    threadId: 'remote-thread',
    provider: 'claude',
    status: 'ready',
    lifecycleState: 'running',
    hasActiveTurn: true,
    createdAt: '2026-07-28T14:00:00Z',
    updatedAt: '2026-07-28T14:00:00Z',
    isLoaded: true,
    isPersisted: true,
    answerability: { answerable: true },
    eventCount: 1,
  };

  function localOnlyInputs() {
    return {
      chats: {} as Record<string, unknown>,
      sessions: [LOCAL_SESSION] as any,
      agents: [] as any,
    };
  }

  // the local-first invariant. Omitting `remoteEnvironments` and
  // passing its default `[]` explicitly must produce byte-identical output
  // to each other, and to what this exact input produced before remote
  // support existed (a plain local orchestration item, untouched).
  test('AC3: omitting remoteEnvironments and passing [] both leave the local-only result unchanged', () => {
    const withoutField = buildHomeWorkItems(localOnlyInputs() as any);
    const withEmptyArray = buildHomeWorkItems({
      ...localOnlyInputs(),
      remoteEnvironments: [],
    } as any);

    expect(withoutField).toEqual(withEmptyArray);
    expect(withoutField).toHaveLength(1);
    expect(withoutField[0]).toMatchObject({
      id: 'local-thread',
      kind: 'orchestration',
      kindLabel: 'Session',
    });
    expect(withoutField[0].environmentId).toBeUndefined();
    expect(withoutField[0].environmentLabel).toBeUndefined();
  });

  // a two-station fixture — one local session, one connected remote
  // environment's session — merges into one list, the remote item carrying
  // environment provenance for the badge.
  test('AC1: merges a connected remote environment session into the list with provenance', () => {
    const items = buildHomeWorkItems({
      ...localOnlyInputs(),
      remoteEnvironments: [
        {
          environmentId: 'env-a',
          environmentName: 'Brian media',
          sessions: [REMOTE_SESSION],
        },
      ],
    } as any);

    expect(items).toHaveLength(2);
    const remoteItem = items.find((task) => task.kind === 'remote-session');
    expect(remoteItem).toMatchObject({
      id: 'remote:env-a:remote-thread',
      kind: 'remote-session',
      kindLabel: 'Remote session',
      environmentId: 'env-a',
      environmentLabel: 'Brian media',
    });
    // The local item is untouched by the merge — no provenance fields leak
    // onto it.
    const localItem = items.find((task) => task.kind === 'orchestration');
    expect(localItem?.environmentId).toBeUndefined();
    expect(localItem?.environmentLabel).toBeUndefined();
  });

  test('R2: a remote session id can never collide with a local item sharing the same raw thread id', () => {
    const items = buildHomeWorkItems({
      chats: {},
      sessions: [LOCAL_SESSION] as any,
      agents: [] as any,
      remoteEnvironments: [
        {
          environmentId: 'env-a',
          environmentName: 'Brian media',
          // Deliberately the SAME threadId as LOCAL_SESSION.
          sessions: [{ ...LOCAL_SESSION }] as any,
        },
      ],
    });

    expect(items).toHaveLength(2);
    const ids = items.map((task) => task.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain('local-thread');
    expect(ids).toContain('remote:env-a:local-thread');
  });

  test('R3: one unreachable environment (absent from remoteEnvironments) never removes or blocks another connected environment or the local list', () => {
    // The aggregator (server-side) already drops unreachable environments
    // from `remoteEnvironments` entirely (see
    // `remote-session-reader.test.ts`) — this proves the client-side merge
    // is equally indifferent to a shorter-than-expected remote list; it
    // never blocks on, or requires, every known environment answering.
    const items = buildHomeWorkItems({
      ...localOnlyInputs(),
      remoteEnvironments: [
        {
          environmentId: 'env-reachable',
          environmentName: 'Reachable box',
          sessions: [REMOTE_SESSION],
        },
        // 'env-unreachable' is simply absent — exactly what the server
        // aggregator returns for a connected-but-timed-out environment.
      ],
    } as any);

    expect(items.map((task) => task.id)).toEqual(
      expect.arrayContaining([
        'local-thread',
        'remote:env-reachable:remote-thread',
      ]),
    );
    expect(items).toHaveLength(2);
  });
});

describe('station#1795: a chat with no messages yet is not epoch-0', () => {
  // Regression for the reported bug: a brand-new chat has neither
  // `messages` nor `ephemeralMessages` populated and no `streamingMessage`,
  // so `latestChatTimestamp`'s reduce used to bottom out at its literal `0`
  // seed — sorting the chat dead last (behind every item with a real,
  // however old, timestamp) and rendering it in "Earlier" stamped "20668d"
  // (days since 1970). archive#1295 already fixed the case where a chat
  // HAS a message with no usable timestamp; this covers the genuinely
  // message-less case that fix does not reach.
  test('a chat with no messages sorts by its own creation time, not epoch 0', () => {
    const createdAt = Date.parse('2026-08-02T12:00:00Z');
    const tasks = buildHomeWorkItems({
      chats: {
        fresh: {
          // #1582 B9: the message-less chat that still reaches Home is the
          // REHYDRATED one — messages are not persisted across a reload, but
          // the conversation id is, so this is exactly the shape #1795
          // reported. An untouched draft is no longer work at all.
          conversationId: 'conversation-untouched',
          agentSlug: 'agent',
          title: 'Untouched chat',
          createdAt,
        },
        old: {
          agentSlug: 'agent',
          title: 'Old chat',
          messages: [{ role: 'user', content: 'hi', timestamp: 20 }],
        },
      } as any,
      sessions: [],
      agents: [{ slug: 'agent', name: 'Agent' }] as any,
    });

    const fresh = tasks.find((task) => task.title === 'Untouched chat');
    expect(fresh?.updatedAt).toBe(createdAt);
    // A real (however old) message timestamp is still an epoch-ms value
    // dwarfed by any 2020s+ createdAt, so the fresh, message-less chat
    // must sort ahead of it rather than dead last at 0.
    expect(tasks[0].title).toBe('Untouched chat');
  });

  test('a chat with no createdAt and no messages still falls back to 0 (no regression for legacy fixtures)', () => {
    const tasks = buildHomeWorkItems({
      chats: {
        bare: {
          conversationId: 'conversation-bare',
          agentSlug: 'agent',
          title: 'Bare chat',
        },
      } as any,
      sessions: [],
      agents: [{ slug: 'agent', name: 'Agent' }] as any,
    });

    expect(tasks.find((task) => task.title === 'Bare chat')?.updatedAt).toBe(0);
  });
});

describe('station#1295: chat recency is no longer derived from a 0 timestamp', () => {
  // Regression for the exact reported bug: no normal write path stamped
  // `ChatMessage.timestamp`, so `latestChatTimestamp` reduced to 0 for a
  // perfectly healthy chat — sorting it dead last (behind every item with a
  // real, however old, timestamp) and making it un-eligible for "Just
  // finished" (see mobile-activity-groups.ts's window check). Prior
  // fixtures in this file hardcode plausible stamps (`messages: [{
  // timestamp: 20 }]`); this one goes through the real write path
  // (`buildOutgoingUserMessage`) instead of a hand-picked value.
  test('a chat whose only message came from the real send path sorts ahead of an old real-timestamp item', () => {
    const { messages } = buildOutgoingUserMessage(undefined, 'hi');
    const tasks = buildHomeWorkItems({
      chats: {
        local: {
          agentSlug: 'agent',
          title: 'Fresh chat',
          messages,
        },
        old: {
          agentSlug: 'agent',
          title: 'Old chat',
          messages: [{ role: 'user', content: 'hi', timestamp: 20 }],
        },
      } as any,
      sessions: [],
      agents: [{ slug: 'agent', name: 'Agent' }] as any,
    });

    const fresh = tasks.find((task) => task.title === 'Fresh chat');
    const old = tasks.find((task) => task.title === 'Old chat');
    expect(fresh?.updatedAt).toBeGreaterThan(0);
    expect(fresh?.updatedAt ?? 0).toBeGreaterThan(old?.updatedAt ?? 0);
    // The recency comparator sorts descending by updatedAt, so the fresh
    // chat must lead the list, not sort dead last as it would at 0.
    expect(tasks[0].title).toBe('Fresh chat');
  });

  // archive#1295: streaming bumps recency even though `streamingMessage`
  // itself carries no timestamp and hasn't been appended to `messages` yet
  // (finalize does that) — without this, a chat streaming RIGHT NOW could
  // still sort behind one that merely finished a while ago.
  test('an actively streaming chat sorts ahead of an older finished chat', () => {
    const tasks = buildHomeWorkItems({
      chats: {
        streaming: {
          agentSlug: 'agent',
          title: 'Streaming chat',
          messages: [{ role: 'user', content: 'hi', timestamp: 20 }],
          streamingMessage: { role: 'assistant', content: 'partial...' },
        },
        finished: {
          agentSlug: 'agent',
          title: 'Finished chat',
          messages: [
            { role: 'user', content: 'hi', timestamp: 1000 },
            { role: 'assistant', content: 'done', timestamp: 2000 },
          ],
        },
      } as any,
      sessions: [],
      agents: [{ slug: 'agent', name: 'Agent' }] as any,
    });

    expect(tasks[0].title).toBe('Streaming chat');
  });
});

/**
 * archive#1783 (ADR 0012 residual) — the Home lane family.
 *
 * `orchestrationLifecycleLabel` folded a dead session's sticky
 * `pendingReview`/`needs_input` to `'Needs attention'`, which
 * `lifecycle-priority.ts` ranks TOP. Since archive#1791 retired the
 * boot-time cancellation write, nothing ever moved it off, so one dead
 * session pinned the top of Home — and of the lane placement and the mobile
 * Active group derived from the same label — indefinitely.
 */
describe('Failed rows carry their reason (station#3688)', () => {
  function buildChat(chat: Record<string, unknown>): HomeWorkItem[] {
    return buildHomeWorkItems({
      chats: {
        'chat-1': {
          agentSlug: 'claude',
          agentName: 'Claude Code',
          conversationId: 'conv-1',
          ...chat,
        } as never,
      },
      agents: [],
      sessions: [],
    });
  }

  test('a failed chat with a recorded drain refusal shows that refusal', () => {
    const [item] = buildChat({
      status: 'error',
      error: 'raw transport text',
      queuedMessageFailure: {
        message: 'This conversation was started without a workspace.',
        code: 'continuation_workspace_unbound',
        at: 1,
      },
    });
    expect(item.lifecycleLabel).toBe('Failed');
    // The persisted, user-shaped refusal outranks the raw send error.
    expect(item.failureNotice).toBe(
      'This conversation was started without a workspace.',
    );
  });

  test('a failed chat with only a raw send error renders the bare chip (#3724 review: raw diagnostics are unfit for the inbox)', () => {
    const [item] = buildChat({ status: 'error', error: 'HTTP 500' });
    expect(item.lifecycleLabel).toBe('Failed');
    expect(item.failureNotice).toBeUndefined();
  });

  test('iff, direction 1: a failure with no recorded reason renders the bare chip, never invented prose', () => {
    const [item] = buildChat({ status: 'error' });
    expect(item.lifecycleLabel).toBe('Failed');
    expect(item.failureNotice).toBeUndefined();
  });

  test('iff, direction 2: a non-failed chat never carries a failure notice, even with stale reason state', () => {
    const [item] = buildChat({
      status: 'idle',
      queuedMessageFailure: { message: 'old refusal', at: 1 },
    });
    expect(item.lifecycleLabel).not.toBe('Failed');
    expect(item.failureNotice).toBeUndefined();
  });

  test('a failed session row reads the server-derived compact attribution, never blockedReason', () => {
    const base: OrchestrationSessionSummary = {
      threadId: 'thread-failed',
      provider: 'claude',
      status: 'error',
      controlMode: 'station-owned',
      lifecycleState: 'failed',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
      isLoaded: true,
      isPersisted: true,
      answerability: { answerable: true },
      eventCount: 1,
      blockedReason: 'Engine exited before the turn completed.',
      terminalAttribution: {
        kind: 'runtime_error',
        detail: 'The provider rejected this request.',
      },
    };
    const [item] = buildHomeWorkItems({
      chats: {},
      agents: [],
      sessions: [base],
    });
    expect(item.lifecycleLabel).toBe('Failed');
    expect(item.failureNotice).toBe('The provider rejected this request.');
  });

  test('a requested-stop session remains distinct from completed and carries its compact attribution', () => {
    const [item] = buildHomeWorkItems({
      chats: {},
      agents: [],
      sessions: [
        {
          threadId: 'thread-stopped',
          provider: 'claude',
          status: 'ready',
          controlMode: 'station-owned',
          lifecycleState: 'canceled',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-02',
          isLoaded: true,
          isPersisted: true,
          answerability: { answerable: true },
          eventCount: 1,
          terminalAttribution: {
            kind: 'requested_stop',
            detail: 'Stopped by request.',
          },
        },
      ],
    });

    expect(item.lifecycleLabel).toBe('Stopped');
    expect(item.failureNotice).toBe('Stopped by request.');
  });

  // archive#3724: the iff must survive the chat+session MERGE —
  // the spread used to carry the chat side's notice regardless of which
  // side's label won.
  test('merge: an errored chat under a winning non-Failed label sheds its notice', () => {
    const session: OrchestrationSessionSummary = {
      threadId: 'conv-1',
      provider: 'claude',
      status: 'ready',
      controlMode: 'station-owned',
      lifecycleState: 'needs_input',
      pendingReview: true,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
      isLoaded: true,
      isPersisted: true,
      answerability: { answerable: true },
      eventCount: 1,
    };
    const [item] = buildHomeWorkItems({
      chats: {
        'chat-1': {
          agentSlug: 'claude',
          agentName: 'Claude Code',
          conversationId: 'conv-1',
          status: 'error',
          queuedMessageFailure: { message: 'refused', at: 1 },
        } as never,
      },
      agents: [],
      sessions: [session],
    });
    // 'Needs attention' outranks 'Failed' in the merge.
    expect(item.lifecycleLabel).toBe('Needs attention');
    expect(item.failureNotice).toBeUndefined();
  });

  test('merge: a winning Failed label keeps the recorded chat-side notice', () => {
    const session: OrchestrationSessionSummary = {
      threadId: 'conv-1',
      provider: 'claude',
      status: 'error',
      controlMode: 'station-owned',
      lifecycleState: 'failed',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
      isLoaded: true,
      isPersisted: true,
      answerability: { answerable: true },
      eventCount: 1,
    };
    const [item] = buildHomeWorkItems({
      chats: {
        'chat-1': {
          agentSlug: 'claude',
          agentName: 'Claude Code',
          conversationId: 'conv-1',
          status: 'error',
          queuedMessageFailure: { message: 'refused by the send path', at: 1 },
        } as never,
      },
      agents: [],
      sessions: [session],
    });
    expect(item.lifecycleLabel).toBe('Failed');
    expect(item.failureNotice).toBe('refused by the send path');
  });

  // The discriminating case injection proved missing: a BLOCKED session
  // carries a blockedReason too, and its label is not Failed. An unbound
  // derivation (the archive#1783 shape — computed without the label gate) puts
  // failure prose under a non-Failed chip; this is the test that reddens it.
  test('iff, session side: a blocked (non-failed) session with a blockedReason carries no failure notice', () => {
    const base: OrchestrationSessionSummary = {
      threadId: 'thread-blocked',
      provider: 'claude',
      status: 'ready',
      controlMode: 'station-owned',
      lifecycleState: 'blocked',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
      isLoaded: true,
      isPersisted: true,
      answerability: { answerable: true },
      eventCount: 1,
      blockedReason: 'Waiting on an approval.',
    };
    const [item] = buildHomeWorkItems({
      chats: {},
      agents: [],
      sessions: [base],
    });
    expect(item.lifecycleLabel).not.toBe('Failed');
    expect(item.failureNotice).toBeUndefined();
  });
});

describe('Home lifecycle label answerability (station#1783)', () => {
  const observation = {
    answerable: false,
    qualification: 'provider_absent',
    observedBy: 'station-7f3a',
    observedAt: '2026-08-03T12:04:03.000Z',
  } as const;

  // Fully typed, with NO cast. `as never` is a stronger exemption than the
  // `as OrchestrationSessionSummary` removed earlier in this branch — it
  // disables structural checking outright, so archive#1778's required member
  // would not be enforced for this fixture at all. Review caught that the
  // "no casts survive" claim was false while these two remained.
  function build(
    session: Partial<OrchestrationSessionSummary>,
  ): HomeWorkItem[] {
    const base: OrchestrationSessionSummary = {
      threadId: 'thread-dead',
      provider: 'acme',
      status: 'ready',
      controlMode: 'station-owned',
      lifecycleState: 'needs_input',
      pendingReview: true,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
      isLoaded: true,
      isPersisted: true,
      answerability: { answerable: true },
      eventCount: 1,
    };
    return buildHomeWorkItems({
      chats: {},
      agents: [],
      sessions: [{ ...base, ...session }],
    });
  }

  test('an unanswerable session reads Unanswerable, not Needs attention', () => {
    const [item] = build({ answerability: observation });
    expect(item.lifecycleLabel).toBe('Unanswerable');
  });

  test('the row carries the observation, so the label is not a bare adjective', () => {
    const [item] = build({ answerability: observation });
    expect(item.unanswerableNotice).toContain("no adapter for provider 'acme'");
    expect(item.unanswerableNotice).toContain('station-7f3a');
    expect(item.unanswerableNotice).toContain('2026-08-03T12:04:03.000Z');
  });

  test('anti-filter: the row is still built', () => {
    expect(build({ answerability: observation })).toHaveLength(1);
  });

  test('control: an answerable session is unchanged and unannotated', () => {
    const [item] = build({});
    expect(item.lifecycleLabel).toBe('Needs attention');
    expect(item.unanswerableNotice).toBeUndefined();
  });

  /**
   *`turn.completed` folds a session to `completed`, and
   * recovery skips already-closed sessions at boot — so after any restart
   * every ordinary finished conversation is detached and takes the
   * `past_resume` arm. This is not an edge case; it is the steady state of
   * the whole inventory. The first version computed the notice
   * unconditionally, so each of those rows rendered `✓ Done` with
   * "Unanswerable by the serving Station (the session cannot resume)"
   * underneath it.
   */
  test('a terminal session still reads Completed — the finished branch wins', () => {
    const [item] = build({
      lifecycleState: 'completed',
      answerability: observation,
    });
    expect(item.lifecycleLabel).toBe('Completed');
  });

  test('...and carries NO notice, so nothing contradicts the Done chip', () => {
    const [item] = build({
      lifecycleState: 'completed',
      answerability: observation,
    });
    expect(item.unanswerableNotice).toBeUndefined();
  });

  test('the notice is bound to the label — iff, both directions', () => {
    // A notice without the label contradicts the row; a label without the
    // notice is the bare adjective the negative arm's basis exists to prevent.
    const cases: Partial<OrchestrationSessionSummary>[] = [
      {},
      { answerability: observation },
      { lifecycleState: 'completed', answerability: observation },
      { lifecycleState: 'failed' },
      { lifecycleState: 'running', hasActiveTurn: true },
      { lifecycleState: 'needs_input', pendingReview: false },
      {
        lifecycleState: 'blocked',
        pendingReview: false,
        answerability: observation,
      },
    ];
    for (const session of cases) {
      const [item] = build(session);
      expect(item.unanswerableNotice !== undefined).toBe(
        item.lifecycleLabel === 'Unanswerable',
      );
    }
  });

  test('an idle detached session is NOT relabelled — no request is waiting', () => {
    // The field answers a question about an OPEN REQUEST. With nothing
    // awaiting a response there is no request to be unanswerable about, so
    // consulting it here would be the session-scoped read review blocked.
    const [item] = build({
      lifecycleState: 'running',
      pendingReview: false,
      hasActiveTurn: false,
      answerability: observation,
    });
    expect(item.lifecycleLabel).toBe('Ready');
    expect(item.unanswerableNotice).toBeUndefined();
  });

  test('a failed session still reads Failed', () => {
    const [item] = build({ lifecycleState: 'failed' });
    expect(item.lifecycleLabel).toBe('Failed');
  });
});

/**
 * Home draws an agent icon per row and offers a project destination per chart
 * row, and both are resolved from the row's SLUGS. A display label cannot
 * stand in for either: `agentLabel` may already be an engine name, and
 * `projectLabel` carries `sessionProjectLabel`'s caveats. So the slugs have to
 * reach every kind of row that has one — including a chat, which used to be
 * excluded because the OPEN policy had no use for it.
 */
describe('identity slugs reach the rows that display them', () => {
  const session = {
    threadId: 'thread-1',
    provider: 'codex',
    status: 'ready',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-02',
    isLoaded: true,
    isPersisted: true,
    answerability: { answerable: true },
    eventCount: 1,
  };

  test('a chat item carries its own agent and project slugs', () => {
    const [item] = buildHomeWorkItems({
      chats: {
        local: {
          conversationId: 'c1',
          title: 'Direct chat',
          agentSlug: 'codex-agent',
          projectSlug: 'station',
          projectName: 'Station',
          messages: [{ timestamp: 10 }],
        },
      } as any,
      sessions: [],
      agents: [{ slug: 'codex-agent', name: 'Codex' }] as any,
    });
    expect(item).toMatchObject({
      kind: 'chat',
      agentSlug: 'codex-agent',
      projectSlug: 'station',
    });
  });

  test('a chat naming no agent or project carries neither field', () => {
    const [item] = buildHomeWorkItems({
      chats: {
        local: { conversationId: 'c1', messages: [{ timestamp: 10 }] },
      } as any,
      sessions: [],
      agents: [],
    });
    expect(item.agentSlug).toBeUndefined();
    expect(item.projectSlug).toBeUndefined();
  });

  /**
   * The merge used to base the row on the chat copy and drop the session
   * copy's slugs. Harmless while nothing read them; once the row draws an
   * icon it meant a merged row lost its agent for no reason the user could
   * see. The two copies describe one conversation, so the session's record
   * is the same identity, not a second guess at it.
   */
  test('a merged row falls back to the session copy for a slug the chat lacks', () => {
    const [item] = buildHomeWorkItems({
      chats: {
        local: {
          conversationId: 'thread-1',
          title: 'Review release',
          messages: [{ timestamp: 10 }],
        },
      } as any,
      sessions: [
        {
          ...session,
          assignedAgentSlug: 'codex-agent',
          projectSlug: 'station',
        },
      ] as any,
      agents: [{ slug: 'codex-agent', name: 'Codex' }] as any,
    });
    expect(item).toMatchObject({
      kind: 'chat',
      chatSessionId: 'local',
      agentSlug: 'codex-agent',
      projectSlug: 'station',
    });
  });

  test('a merged row omits the agent slug when the chat and session disagree', () => {
    const [item] = buildHomeWorkItems({
      chats: {
        local: {
          conversationId: 'thread-1',
          agentSlug: 'chat-agent',
          messages: [{ timestamp: 10 }],
        },
      } as any,
      sessions: [{ ...session, assignedAgentSlug: 'session-agent' }] as any,
      agents: [] as any,
    });
    expect(item.agentSlug).toBeUndefined();
  });
});
