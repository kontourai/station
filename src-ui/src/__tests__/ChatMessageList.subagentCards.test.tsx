/**
 * @vitest-environment jsdom
 *
 * A subagent spawned by a tool call gets one card, inline in the transcript
 * where that call sits, and the card follows the child from running to its
 * outcome.
 *
 * Real seam on the client: canonical runtime events (the `child-work.updated`
 * deltas in the exact shapes `claude-adapter-child-work.ts` publishes) → the
 * shared transcript projection (`useActiveChatTranscript`) → `ChatMessageList`
 * → `MessageBubble` → `MessageContent` → the card. Only the event window's
 * transport and unrelated app contexts are stubbed.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import type {
  ChildWorkDelta,
  ChildWorkItem,
} from '@kontourai/station-contracts/child-work';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { _setApiBase } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
  useAgentsLoaded: () => true,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3242' }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => vi.fn(),
}));
vi.mock('../components/chat/AttachAnswerToTaskButton', () => ({
  ConnectedAttachUserInputToTaskButton: () => null,
}));
vi.mock('../components/chat/SessionSummaryCard', () => ({
  SessionSummaryCard: () => null,
}));
vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => null,
}));
vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span aria-hidden="true">U</span>,
}));

const { windowEvents } = vi.hoisted(() => ({
  windowEvents: {
    current: [] as Array<{ sequence: number; event: unknown }>,
  },
}));
vi.mock('../hooks/orchestration/useSessionEventWindow', () => ({
  useSessionEventWindow: () => ({
    events: windowEvents.current,
    handoffs: [],
    contextBoundaries: [],
    hasMore: false,
    loadOlder: () => undefined,
    reload: () => undefined,
    upgradeRequired: false,
    loading: false,
    settled: true,
    error: undefined,
  }),
}));

import { ChatMessageList } from '../components/chat/ChatMessageList';
import { ActiveChatsProvider } from '../contexts/ActiveChatsContext';
import { activeChatsStore } from '../contexts/active-chats-store';
import { applyChildWorkToChat } from '../hooks/orchestration/childWorkHandlers';
import { useActiveChatTranscript } from '../hooks/orchestration/useActiveChatTranscript';
import type { ChatSession } from '../types';
import terminalCaptures from './fixtures/codex-child-only-terminal-events.json';
import childOnlySteerEvents from './fixtures/codex-steer-child-only-events.json';
import capturedCodexEvents from './fixtures/codex-subagent-transcript-events.json';
import museWorkflowEvents from './fixtures/muse-workflow-transcript-events.json';

const API_BASE = 'http://localhost:3242';
const THREAD = 'claude-session-1';
const TOOL_CALL = 'toolu_agent_1';
const SESSION_ID = '3f1c9b2e-8d4a-4c11-9e2f-5b7a6c0d1e2f';

function chatSession(): ChatSession {
  return {
    id: 'chat-tab',
    conversationId: 'conversation-1',
    currentSessionId: THREAD,
    agentSlug: agentId('station'),
    agentName: 'Station',
    title: 'Review the ADR freeze',
    source: 'manual',
    messages: [],
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    status: 'idle',
    error: null,
    createdAt: 0,
    updatedAt: 0,
    hasUnread: false,
    orchestrationSessionStarted: true,
    orchestrationHistoryRevision: 0,
  };
}

let sequence = 0;
function runtimeEvent<const T extends Record<string, unknown>>(
  createdAt: string,
  fields: T,
) {
  sequence += 1;
  return {
    sequence,
    event: {
      eventId: `evt-${sequence}`,
      provider: 'claude',
      threadId: THREAD,
      createdAt,
      ...fields,
    },
  };
}

function childWork(createdAt: string, delta: ChildWorkDelta) {
  return runtimeEvent(createdAt, { method: 'child-work.updated', delta });
}

const STARTED_AT = '2026-10-14T14:25:00.000Z';
const ENDED_AT = '2026-10-14T14:42:04.000Z';

/** The child as `observeClaudeTaskStarted` lists it (`local_agent`). */
const runningChild: ChildWorkItem = {
  producer: 'engine-subagent',
  reporterThreadId: THREAD,
  childId: 'a1b2c3',
  status: 'running',
  parent: { toolCallId: TOOL_CALL, turnId: 'turn-1' },
  title: '[opus] review station#3657 ADR freeze',
  kindLabel: 'general-purpose',
  transcript: {
    kind: 'claude-subagent',
    sessionId: SESSION_ID,
    agentId: 'a1b2c3',
  },
  backgrounded: true,
  depth: 1,
  startedAt: STARTED_AT,
  controls: { stop: 'provider-task-stop' },
};

/** Intent, the Agent tool call that spawned the child, and the reply. */
function spawningTurn() {
  return [
    runtimeEvent('2026-10-14T14:24:58.000Z', {
      method: 'turn.started',
      turnId: 'turn-1',
      prompt: 'Review station#3657',
    }),
    runtimeEvent('2026-10-14T14:24:59.000Z', {
      method: 'content.text-delta',
      turnId: 'turn-1',
      itemId: 'turn-1:text:1',
      delta: 'Starting an independent review.',
    }),
    runtimeEvent(STARTED_AT, {
      method: 'tool.started',
      turnId: 'turn-1',
      itemId: TOOL_CALL,
      toolCallId: TOOL_CALL,
      toolName: 'Agent',
      arguments: {
        description: '[opus] review station#3657 ADR freeze',
        prompt: 'Review the ADR freeze PR.',
        subagent_type: 'general-purpose',
        run_in_background: true,
      },
    }),
    // `task_started` → the reporter's authoritative running set.
    childWork(STARTED_AT, {
      kind: 'snapshot',
      producer: 'engine-subagent',
      reporterThreadId: THREAD,
      running: [runningChild],
    }),
    runtimeEvent('2026-10-14T14:25:01.000Z', {
      method: 'tool.completed',
      turnId: 'turn-1',
      itemId: TOOL_CALL,
      toolCallId: TOOL_CALL,
      toolName: 'Agent',
      status: 'success',
      output: 'Async agent launched successfully.',
    }),
    runtimeEvent('2026-10-14T14:25:02.000Z', {
      method: 'content.text-delta',
      turnId: 'turn-1',
      itemId: 'turn-1:text:2',
      delta: 'The reviewer is running in the background.',
    }),
    runtimeEvent('2026-10-14T14:25:03.000Z', {
      method: 'turn.completed',
      turnId: 'turn-1',
      finishReason: 'stop',
    }),
  ];
}

/** `task_progress`: the live status line. */
function progress() {
  return childWork('2026-10-14T14:30:00.000Z', {
    kind: 'upsert',
    item: { ...runningChild, progress: 'Reading the decision records' },
  });
}

/** `task_updated` completed, then `task_notification` with the result. */
function settles(summary: string, item = runningChild) {
  const identity = {
    parent: item.parent,
    title: item.title,
    kindLabel: item.kindLabel,
    transcript: item.transcript,
    backgrounded: true,
    depth: 1,
    startedAt: STARTED_AT,
  };
  return [
    childWork(ENDED_AT, {
      kind: 'settle',
      producer: 'engine-subagent',
      reporterThreadId: THREAD,
      childId: item.childId,
      status: 'completed',
      identity: { ...identity, endedAt: ENDED_AT },
    }),
    childWork('2026-10-14T14:42:05.000Z', {
      kind: 'settle',
      producer: 'engine-subagent',
      reporterThreadId: THREAD,
      childId: item.childId,
      status: 'completed',
      result: {
        summary,
        handle: {
          kind: 'transcript-file',
          path: `/tmp/claude/tasks/${item.childId}.output`,
        },
      },
      usage: { totalTokens: 48_210, toolUses: 37, durationMs: 1_024_000 },
      identity: { ...identity, endedAt: '2026-10-14T14:42:05.000Z' },
    }),
  ];
}

function history65() {
  const entries: Array<{ sequence: number; event: CanonicalRuntimeEvent }> =
    Array.from({ length: 65 }, (_, index) => {
      const call = `toolu_agent_${index}`;
      const childId = `child-${index}`;
      const turnId = 'turn-1';
      const item: ChildWorkItem = {
        ...runningChild,
        childId,
        parent: { toolCallId: call, turnId },
        title: `Review ${index}`,
        transcript: {
          kind: 'claude-subagent',
          sessionId: SESSION_ID,
          agentId: childId,
        },
      };
      return [
        runtimeEvent(STARTED_AT, {
          method: 'tool.started',
          turnId,
          itemId: call,
          toolCallId: call,
          toolName: 'Agent',
          arguments: {},
        }),
        childWork(STARTED_AT, {
          kind: 'snapshot',
          producer: 'engine-subagent',
          reporterThreadId: THREAD,
          running: [item],
        }),
        runtimeEvent(STARTED_AT, {
          method: 'tool.completed',
          turnId,
          itemId: call,
          toolCallId: call,
          toolName: 'Agent',
          status: 'success',
          output: 'Async agent launched successfully.',
        }),
        ...settles(`Result ${index}`, item),
      ];
    }).flat();
  entries.unshift(
    runtimeEvent(STARTED_AT, {
      method: 'turn.started',
      turnId: 'turn-1',
      prompt: 'Review all 65 children',
    }),
  );
  entries.push(
    runtimeEvent(ENDED_AT, {
      method: 'turn.completed',
      turnId: 'turn-1',
      finishReason: 'stop',
    }),
  );
  return entries.map((entry, index) => ({
    ...entry,
    sequence: index + 1,
  }));
}

function TranscriptHarness({ session }: { session: ChatSession }) {
  const transcript = useActiveChatTranscript(API_BASE, session);
  return (
    <ChatMessageList
      activeSession={{ ...session, messages: transcript.messages }}
      approvalEvents={transcript.enabled ? transcript.events : undefined}
      approvalEventsSettled={transcript.settled}
      suppressStreamingRow={transcript.openTurnProjected}
      fontSize={13}
      showReasoning={false}
      showToolDetails={false}
    />
  );
}

const unexpectedRequests: string[] = [];

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      // The user-row task picker can load after its lazy boundary settles.
      // This transcript fixture has no Tasks to attach an input to.
      if (url === `${API_BASE}/api/tasks`)
        return Response.json({ success: true, data: [] });
      if (url.includes('/checkpoints'))
        return Response.json({ success: true, data: [] });
      if (url.includes(`/child-work/a1b2c3/transcript`))
        return Response.json({
          success: true,
          data: {
            entries: [
              {
                message: 0,
                kind: 'text',
                role: 'user',
                text: 'Review the ADR freeze PR.',
              },
            ],
          },
        });
      unexpectedRequests.push(url);
      return Response.json(
        { success: false, error: 'unexpected fixture request' },
        { status: 500 },
      );
    }),
  );
}

function renderTranscript(session = chatSession(), streamingShell = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <ActiveChatsProvider>
        {streamingShell ? (
          <ChatMessageList
            activeSession={session}
            approvalEvents={
              windowEvents.current as Parameters<
                typeof ChatMessageList
              >[0]['approvalEvents']
            }
            fontSize={13}
            showReasoning={false}
            showToolDetails={false}
          />
        ) : (
          <TranscriptHarness session={session} />
        )}
      </ActiveChatsProvider>
    </QueryClientProvider>
  );
  const rendered = render(tree());
  return {
    rerender: (nextSession = session) => {
      session = nextSession;
      rendered.rerender(tree());
    },
  };
}

async function findCard(): Promise<HTMLElement> {
  return screen.findByTestId('subagent-card');
}

describe('subagent transcript cards', () => {
  beforeEach(() => {
    _setApiBase(API_BASE);
    sequence = 0;
    unexpectedRequests.length = 0;
    stubFetch();
  });

  afterEach(() => {
    cleanup();
    activeChatsStore.removeChat('chat-tab');
    vi.unstubAllGlobals();
    _setApiBase('');
  });

  // Observable invariant at the mounted caller: the independent input child
  // identities must each have exactly one card on both live and cold paths.
  // Removing standalone placement loses the prose-free cases below.
  test.each([
    ...capturedCodexEvents.map((events, index) => ({
      name: `Codex capture ${index}`,
      events,
    })),
    ...childOnlySteerEvents.map((events, index) => ({
      name: `steer capture ${index}`,
      events,
    })),
    ...terminalCaptures.map(({ status, events }) => ({
      name: `real Codex ${status}`,
      events,
    })),
    ...[
      'last-segment',
      'new-turn',
      'queued',
      'two-children',
      'steer-before-prose',
    ].map((name) => {
      const capture = childOnlySteerEvents[0] as CanonicalRuntimeEvent[];
      const start = capture.find((event) => event.method === 'turn.started')!;
      const spawn = capture.find(
        (event) =>
          event.method === 'child-work.updated' &&
          event.delta.kind === 'snapshot',
      )!;
      const steer = capture.find(
        (event) =>
          event.method === 'turn.started' && event.inputKind === 'steer',
      )!;
      const end = {
        ...start,
        eventId: 'end',
        method: 'turn.completed',
        finishReason: 'stop',
      };
      const next = [
        {
          ...start,
          eventId: 'next-start',
          turnId: 'next',
          prompt: 'Next turn',
        },
        {
          ...start,
          eventId: 'next-text',
          method: 'content.text-delta',
          turnId: 'next',
          itemId: 'next-text',
          delta: 'Next answer.',
        },
        { ...end, eventId: 'next-end', turnId: 'next' },
      ];
      const early = {
        ...start,
        eventId: 'early',
        method: 'content.text-delta',
        itemId: 'early',
        delta: 'Earlier answer.',
      };
      const second = {
        ...spawn,
        eventId: 'second-spawn',
        delta: {
          ...(spawn.method === 'child-work.updated' &&
          spawn.delta.kind === 'snapshot'
            ? spawn.delta
            : {}),
          running: (spawn.method === 'child-work.updated' &&
          spawn.delta.kind === 'snapshot'
            ? spawn.delta.running
            : []
          ).map((item) => ({
            ...item,
            childId: 'second',
            title: 'Second child',
          })),
        },
      };
      const events =
        name === 'last-segment'
          ? [start, early, steer, spawn, end]
          : name === 'new-turn' || name === 'queued'
            ? [start, spawn, end, ...next]
            : name === 'two-children'
              ? [start, spawn, second, steer, end]
              : [start, spawn, steer, end];
      return { name, events };
    }),
    {
      name: 'Claude tool-row',
      events: spawningTurn().map((entry) => entry.event),
    },
    {
      name: 'Muse shared-call',
      events: [
        runtimeEvent(STARTED_AT, {
          provider: 'muse',
          threadId: 'muse-session-1',
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: 'Workflow',
        }).event,
        runtimeEvent(STARTED_AT, {
          provider: 'muse',
          threadId: 'muse-session-1',
          method: 'tool.started',
          turnId: 'turn-1',
          itemId: 'call_workflow_1',
          toolCallId: 'call_workflow_1',
          toolName: 'workflow',
          arguments: {},
        }).event,
        ...museWorkflowEvents,
      ],
    },
    {
      name: '65-child history',
      events: history65().map((entry) => entry.event),
    },
  ])(
    'each child renders exactly once live and on replay: $name',
    async ({ name, events: raw }) => {
      const events = raw as CanonicalRuntimeEvent[];
      const expected = new Map<string, string>();
      for (const event of events) {
        if (event.method !== 'child-work.updated') continue;
        const delta = event.delta;
        const items =
          delta.kind === 'snapshot'
            ? delta.running
            : delta.kind === 'upsert'
              ? [delta.item]
              : [];
        for (const item of items)
          expected.set(item.childId, item.title ?? item.childId);
      }
      expect(expected.size).toBeGreaterThan(0);
      const session = {
        ...chatSession(),
        currentSessionId: events[0].threadId,
      };
      const live = {
        ...session,
        orchestrationTurnOpen: true,
        openTurnId: events.find((event) => 'turnId' in event && event.turnId)
          ?.turnId,
        status: 'sending' as const,
        orchestrationStatus: 'running' as const,
      };
      const setEvents = (input: CanonicalRuntimeEvent[]) => {
        windowEvents.current = input.map((event, index) => ({
          sequence: index + 1,
          event,
        }));
      };
      const assertOnce = async () => {
        await act(async () => {});
        const cards = screen.queryAllByTestId('subagent-card');
        expect(cards).toHaveLength(expected.size);
        for (const [id, title] of expected)
          expect(
            cards.filter((card) =>
              within(card).queryByText(title, { exact: true }),
            ),
            id,
          ).toHaveLength(1);
        return cards.map((card) =>
          card
            .closest('.chat-message-anchor')
            ?.getAttribute('data-chat-message-key'),
        );
      };
      setEvents(events.filter((event) => event.method !== 'turn.completed'));
      const view = renderTranscript(live);
      const liveKeys = await assertOnce();
      setEvents(events);
      await act(async () => view.rerender(session));
      const settledKeys = await assertOnce();
      const card = screen.getAllByTestId('subagent-card')[0];
      if (name === 'last-segment')
        expect(
          screen.getByText('Also check this').compareDocumentPosition(card) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      if (name === 'new-turn' || name === 'queued')
        expect(
          card.compareDocumentPosition(screen.getByText('Next turn')) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();

      for (const key of liveKeys.filter((key) => key?.startsWith('subagent:')))
        expect(settledKeys).toContain(key);
      cleanup();
      renderTranscript(session);
      expect(await assertOnce()).toEqual(settledKeys);
      expect(unexpectedRequests).toEqual([]);
    },
  );

  test('a standalone card stays in its own turn and keeps its DOM node when later same-turn prose arrives', async () => {
    const capture = childOnlySteerEvents[0] as CanonicalRuntimeEvent[];
    const start = capture.find((event) => event.method === 'turn.started')!;
    const spawn = capture.find(
      (event) => event.method === 'child-work.updated',
    )!;
    const events: CanonicalRuntimeEvent[] = [start, spawn];
    const setEvents = () => {
      windowEvents.current = events.map((event, index) => ({
        sequence: index + 1,
        event,
      }));
    };
    setEvents();
    const session = { ...chatSession(), currentSessionId: start.threadId };
    const view = renderTranscript(session);
    const card = await findCard();
    const anchor = card.closest('.chat-message-anchor');
    expect(anchor?.getAttribute('data-chat-turn-id')).toBe(start.turnId);
    events.push({
      ...start,
      method: 'content.text-delta',
      eventId: 'later-prose',
      itemId: 'later-prose',
      delta: 'Later same-turn prose.',
    });
    setEvents();
    await act(async () => view.rerender(session));
    expect(await findCard()).toBe(card);
    expect(screen.getAllByTestId('subagent-card')).toHaveLength(1);
    expect(
      card.compareDocumentPosition(screen.getByText('Later same-turn prose.')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    if (
      spawn.method !== 'child-work.updated' ||
      spawn.delta.kind !== 'snapshot'
    )
      throw new Error('Expected captured spawn snapshot');
    events.push({
      ...start,
      method: 'tool.started',
      eventId: 'late-tool',
      toolCallId: spawn.delta.running[0].parent!.toolCallId!,
      itemId: 'late-tool',
      toolName: 'spawn_agent',
      arguments: {},
    });
    setEvents();
    await act(async () => view.rerender(session));
    expect(screen.getAllByTestId('subagent-card')).toEqual([card]);
  });

  test.each(capturedCodexEvents.map((events, index) => ({ events, index })))(
    'captured Codex spawn format $index renders a completed card at its spawn position without a tool row',
    async ({ events, index }) => {
      windowEvents.current = events.map((event, index) => ({
        sequence: index + 1,
        event,
      }));
      renderTranscript({ ...chatSession(), currentSessionId: 'thread-codex' });
      await waitFor(() =>
        expect(document.body.textContent).toContain('The subagent'),
      );
      const card = await findCard();
      expect(screen.getAllByTestId('subagent-card')).toHaveLength(1);
      expect(within(card).getByText('Completed')).toBeTruthy();
      expect(within(card).getByText('done')).toBeTruthy();
      expect(
        within(card).getByText(index === 0 ? '0:05' : '0:04'),
      ).toBeTruthy();
      const spawnAt = events.findIndex(
        (event) => event.method === 'child-work.updated',
      );
      const before = events
        .slice(0, spawnAt)
        .filter((event) => event.method === 'content.text-delta')
        .map((event) => ('delta' in event ? event.delta : ''))
        .join('');
      const text = document.body.textContent ?? '';
      const cardAt = text.indexOf(card.textContent ?? '');
      if (before) expect(cardAt).toBeGreaterThan(text.indexOf(before));
      expect(text.indexOf('The subagent', cardAt)).toBeGreaterThan(cardAt);
      expect(unexpectedRequests).toEqual([]);
    },
  );

  test.each([false, true])(
    'a same-turn Codex steer keeps one card at the original spawn (queued follow-up: %s)',
    async (queuedFollowUp) => {
      const captured = capturedCodexEvents[0];
      const spawnAt = captured.findIndex(
        (event) => event.method === 'child-work.updated',
      );
      const turnId = '00000000-0000-7000-8000-000000000002';
      const envelope = {
        provider: 'codex',
        threadId: 'thread-codex',
        createdAt: STARTED_AT,
      };
      const events = [
        {
          ...envelope,
          eventId: 'review-start',
          method: 'turn.started',
          turnId,
          prompt: 'Start',
        },
        ...captured.slice(0, spawnAt + 1),
        {
          ...envelope,
          eventId: 'review-steer',
          method: 'turn.started',
          inputKind: 'steer',
          turnId,
          prompt: 'Also check this',
        },
        ...captured.slice(spawnAt + 1),
        ...(queuedFollowUp
          ? [
              {
                ...envelope,
                eventId: 'queued-start',
                method: 'turn.started',
                turnId: 'queued-turn',
                prompt: 'Queued follow-up',
              },
              {
                ...envelope,
                eventId: 'queued-answer',
                method: 'content.text-delta',
                turnId: 'queued-turn',
                itemId: 'queued-text',
                delta: 'Follow-up answered.',
              },
              {
                ...envelope,
                eventId: 'queued-end',
                method: 'turn.completed',
                turnId: 'queued-turn',
                finishReason: 'stop',
              },
            ]
          : []),
      ];
      windowEvents.current = events.map((event, index) => ({
        sequence: index + 1,
        event,
      }));
      renderTranscript({ ...chatSession(), currentSessionId: 'thread-codex' });
      await screen.findAllByTestId('subagent-card');
      const cards = screen.getAllByTestId('subagent-card');
      expect(cards).toHaveLength(1);
      const text = document.body.textContent ?? '';
      expect(text.indexOf(cards[0].textContent ?? '')).toBeLessThan(
        text.indexOf('Also check this'),
      );
      if (queuedFollowUp)
        expect(screen.getByText('Follow-up answered.')).toBeTruthy();
    },
  );

  // Captured through CodexAdapterTransport and the real steerTurn writer in
  // round-2 review: both provider formats spawn before any assistant prose.
  test.each(
    childOnlySteerEvents.flatMap((events, capture) =>
      [false, true].map((queued) => ({ events, capture, queued })),
    ),
  )(
    'child-only Codex segment survives steer, completion and replay (capture $capture, queued $queued)',
    async ({ events, queued }) => {
      const start = events.find((event) => event.method === 'turn.started')!;
      const turnId = start.turnId;
      const completion = events.findIndex(
        (event) => event.method === 'turn.completed',
      );
      windowEvents.current = events
        .slice(0, completion)
        .map((event, index) => ({ sequence: index + 1, event }));
      const prose = events
        .filter((event) => event.method === 'content.text-delta')
        .map((event) => event.delta)
        .join('');
      activeChatsStore.initChat('chat-tab');
      activeChatsStore.updateChat('chat-tab', {
        streamingMessage: {
          role: 'assistant',
          content: prose,
          contentParts: [],
        },
      });
      const liveSession = {
        ...chatSession(),
        currentSessionId: 'thread-codex',
        orchestrationTurnOpen: true,
        openTurnId: turnId,
        status: 'sending' as const,
        orchestrationStatus: 'running' as const,
      };
      const view = renderTranscript(liveSession);
      const assertCard = async () => {
        await waitFor(() =>
          expect(document.body.textContent).toContain(
            prose.replaceAll('`', ''),
          ),
        );
        const card = await findCard();
        expect(screen.getAllByTestId('subagent-card')).toHaveLength(1);
        const text = document.body.textContent ?? '';
        expect(text.indexOf(card.textContent ?? '')).toBeLessThan(
          text.indexOf(prose.replaceAll('`', '')),
        );
        return card;
      };
      await assertCard();
      const followUp = queued
        ? [
            {
              ...start,
              eventId: 'follow-start',
              turnId: 'follow',
              prompt: 'Queued follow-up',
            },
            {
              ...start,
              eventId: 'follow-text',
              turnId: 'follow',
              method: 'content.text-delta',
              itemId: 'follow-text',
              delta: 'Follow-up answered.',
            },
            {
              ...start,
              eventId: 'follow-end',
              turnId: 'follow',
              method: 'turn.completed',
              finishReason: 'stop',
            },
          ]
        : [];
      windowEvents.current = [...events, ...followUp].map((event, index) => ({
        sequence: index + 1,
        event,
      }));
      const settledSession = {
        ...chatSession(),
        currentSessionId: 'thread-codex',
      };
      view.rerender(settledSession);
      const settledCard = await assertCard();
      expect(within(settledCard).getByText('Completed')).toBeTruthy();
      const rowId = settledCard
        .closest('.chat-message-anchor')
        ?.getAttribute('data-chat-message-key');
      if (queued) expect(screen.getByText('Follow-up answered.')).toBeTruthy();
      cleanup();
      renderTranscript(settledSession);
      const replayCard = await assertCard();
      expect(
        replayCard
          .closest('.chat-message-anchor')
          ?.getAttribute('data-chat-message-key'),
      ).toBe(rowId);
      activeChatsStore.removeChat('chat-tab');
    },
  );

  test('the live ChatMessageList caller places a post-steer spawn after both segments of prose', async () => {
    const captured = capturedCodexEvents[0];
    const spawn = captured.find(
      (event) => event.method === 'child-work.updated',
    )!;
    const envelope = {
      provider: 'codex',
      threadId: 'thread-codex',
      createdAt: STARTED_AT,
      turnId: '00000000-0000-7000-8000-000000000002',
    };
    const events = [
      {
        ...envelope,
        eventId: 'start',
        method: 'turn.started',
        prompt: 'Start',
      },
      {
        ...envelope,
        eventId: 'pre',
        method: 'content.text-delta',
        itemId: 'pre',
        delta: 'Original plan.',
      },
      {
        ...envelope,
        eventId: 'steer',
        method: 'turn.started',
        inputKind: 'steer',
        prompt: 'Change direction',
      },
      {
        ...envelope,
        eventId: 'post',
        method: 'content.text-delta',
        itemId: 'post',
        delta: 'New plan.',
      },
      spawn,
      {
        ...envelope,
        eventId: 'after',
        method: 'content.text-delta',
        itemId: 'post',
        delta: 'After spawn.',
      },
    ];
    windowEvents.current = events.map((event, index) => ({
      sequence: index + 1,
      event,
    }));
    activeChatsStore.initChat('chat-tab');
    activeChatsStore.updateChat('chat-tab', {
      streamingMessage: {
        role: 'assistant',
        content: 'Original plan.New plan.After spawn.',
        contentParts: [],
      },
    });
    renderTranscript(
      {
        ...chatSession(),
        currentSessionId: 'thread-codex',
        openTurnId: envelope.turnId,
        orchestrationTurnOpen: true,
        status: 'sending',
        orchestrationStatus: 'running',
      },
      true,
    );
    const card = await findCard();
    expect(screen.getAllByTestId('subagent-card')).toHaveLength(1);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Original plan.New plan.');
    expect(text.indexOf(card.textContent ?? '')).toBeGreaterThan(
      text.indexOf('Original plan.New plan.') +
        'Original plan.New plan.'.length -
        1,
    );
    expect(text.indexOf('After spawn.')).toBeGreaterThan(
      text.indexOf(card.textContent ?? ''),
    );
    activeChatsStore.removeChat('chat-tab');
  });

  test('a Codex child spawned after a steer uses the new row and its local text offset', async () => {
    const captured = capturedCodexEvents[0];
    const spawnAt = captured.findIndex(
      (event) => event.method === 'child-work.updated',
    );
    const turnId = '00000000-0000-7000-8000-000000000002';
    const envelope = {
      provider: 'codex',
      threadId: 'thread-codex',
      createdAt: STARTED_AT,
      turnId,
    };
    windowEvents.current = [
      {
        ...envelope,
        eventId: 'start',
        method: 'turn.started',
        prompt: 'Start',
      },
      ...captured.slice(0, spawnAt),
      {
        ...envelope,
        eventId: 'steer',
        method: 'turn.started',
        inputKind: 'steer',
        prompt: 'Change direction',
      },
      {
        ...envelope,
        eventId: 'before-spawn',
        method: 'content.text-delta',
        itemId: 'steered-text',
        delta: 'New plan.',
      },
      ...captured.slice(spawnAt),
    ].map((event, index) => ({ sequence: index + 1, event }));
    renderTranscript({ ...chatSession(), currentSessionId: 'thread-codex' });
    const card = await findCard();
    const row = card.closest('.chat-message-anchor');
    expect(row?.textContent).toContain('New plan.');
    expect(row?.textContent?.indexOf(card.textContent ?? '')).toBe(
      (row?.textContent?.indexOf('New plan.') ?? -1) + 'New plan.'.length,
    );
    expect(screen.getAllByTestId('subagent-card')).toHaveLength(1);
  });

  test('a Codex spawn follows the native tool row before it, even when no text separates them', async () => {
    const captured = capturedCodexEvents[0];
    const spawnAt = captured.findIndex(
      (event) => event.method === 'child-work.updated',
    );
    const tool = {
      provider: 'codex',
      threadId: 'thread-codex',
      turnId: '00000000-0000-7000-8000-000000000002',
      itemId: 'cmd-1',
      toolCallId: 'cmd-1',
      toolName: 'shell_exec',
    };
    windowEvents.current = [
      ...captured.slice(0, spawnAt).map((event) => ({ sequence: 0, event })),
      runtimeEvent(captured[0].createdAt, {
        ...tool,
        method: 'tool.started',
        arguments: { command: 'pwd', cwd: '/tmp/project' },
      }),
      runtimeEvent(captured[0].createdAt, {
        ...tool,
        method: 'tool.completed',
        status: 'success',
        output: { output: '/tmp/project', exitCode: 0, durationMs: 12 },
      }),
      ...captured.slice(spawnAt).map((event) => ({ sequence: 0, event })),
    ].map((entry, index) => ({ ...entry, sequence: index + 1 }));
    renderTranscript({ ...chatSession(), currentSessionId: 'thread-codex' });
    const card = await findCard();
    expect(screen.getAllByTestId('subagent-card')).toHaveLength(1);
    const text = document.body.textContent ?? '';
    expect(text.indexOf('pwd')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(card.textContent ?? '')).toBeGreaterThan(
      text.indexOf('pwd'),
    );
  });

  test('all 65 completed children whose spawns are loaded keep their cards and results', async () => {
    windowEvents.current = history65();
    renderTranscript();
    await screen.findByText('Result 0');
    expect(screen.getAllByTestId('subagent-card')).toHaveLength(65);
    expect(screen.getByText('Result 64')).toBeTruthy();
  });

  test('a Muse workflow call renders each child in writer order once', async () => {
    windowEvents.current = [
      runtimeEvent(STARTED_AT, {
        provider: 'muse',
        method: 'turn.started',
        turnId: 'turn-1',
        prompt: 'Launch workflow',
      }),
      runtimeEvent(STARTED_AT, {
        provider: 'muse',
        method: 'tool.started',
        turnId: 'turn-1',
        itemId: 'call_workflow_1',
        toolCallId: 'call_workflow_1',
        toolName: 'workflow',
        arguments: {},
      }),
      ...museWorkflowEvents.map((event) => ({
        sequence: ++sequence,
        event: {
          ...event,
          threadId: THREAD,
          delta: {
            ...event.delta,
            reporterThreadId: THREAD,
            running: event.delta.running.map((item) => ({
              ...item,
              reporterThreadId: THREAD,
            })),
          },
        },
      })),
      runtimeEvent(ENDED_AT, {
        provider: 'muse',
        method: 'turn.completed',
        turnId: 'turn-1',
        finishReason: 'stop',
      }),
    ];
    renderTranscript();
    const group = await screen.findByText('2 subagents');
    const disclosure = group.closest('button')!;
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(within(disclosure).getByText('2 running')).toBeTruthy();
    fireEvent.click(disclosure);
    await screen.findByText('second');
    const cards = screen.getAllByTestId('subagent-card');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText('first')).toBeTruthy();
    expect(within(cards[1]).getByText('second')).toBeTruthy();
  });

  test('completion notices merge into represented cards while a child without a loaded spawn keeps its notice', async () => {
    activeChatsStore.initChat(THREAD, {
      agentSlug: 'station',
      agentName: 'Station',
      title: 'Review',
    });
    applyChildWorkToChat(THREAD, { kind: 'upsert', item: runningChild });
    applyChildWorkToChat(THREAD, {
      kind: 'settle',
      producer: 'engine-subagent',
      reporterThreadId: THREAD,
      childId: runningChild.childId,
      status: 'completed',
      result: { summary: 'Review complete' },
    });
    applyChildWorkToChat(THREAD, {
      kind: 'settle',
      producer: 'engine-subagent',
      reporterThreadId: THREAD,
      childId: 'unanchored',
      status: 'completed',
      identity: { backgrounded: true, title: 'Other child' },
      result: { summary: 'Other result' },
    });
    const notices =
      activeChatsStore.getSnapshot()[THREAD].ephemeralMessages ?? [];
    expect(notices).toHaveLength(2);
    windowEvents.current = [...spawningTurn(), ...settles('Review complete')];
    renderTranscript({ ...chatSession(), messages: notices });
    await findCard();
    expect(
      screen.queryByText(/Background task finished — \[opus\]/),
    ).toBeNull();
    expect(
      await screen.findByText(/Background task finished — Other child/),
    ).toBeTruthy();
    expect(screen.getAllByText('Review complete')).toHaveLength(1);
    activeChatsStore.removeChat(THREAD);
  });

  test.each([false, true])(
    'a running Claude child renders once at its call (start outside window: %s)',
    async (startOutsideWindow) => {
      windowEvents.current = [...spawningTurn(), progress()].filter(
        (entry) => !startOutsideWindow || entry.event.method !== 'tool.started',
      );
      renderTranscript();
      const card = await findCard();
      expect(
        within(card).getByRole('img', { name: 'Claude Code' }),
      ).toBeTruthy();
      expect(screen.getAllByTestId('subagent-card')).toHaveLength(1);
      expect(
        within(card).getByText('[opus] review station#3657 ADR freeze'),
      ).toBeTruthy();
      expect(within(card).getByText('Running')).toBeTruthy();
      expect(
        within(card).getByText('Reading the decision records'),
      ).toBeTruthy();
      // Spawn point: after the intent, before the reply that followed the
      // call, in the same assistant row.
      const text = document.body.textContent ?? '';
      const intentAt = text.indexOf('Starting an independent review.');
      const cardAt = text.indexOf(card.textContent ?? '');
      const replyAt = text.indexOf(
        'The reviewer is running in the background.',
      );
      expect(intentAt).toBeGreaterThanOrEqual(0);
      expect(cardAt).toBeGreaterThan(intentAt);
      expect(replyAt).toBeGreaterThan(
        cardAt + (card.textContent ?? '').length - 1,
      );
      expect(within(card).queryByText('model not reported')).toBeNull();
      fireEvent.click(within(card).getByRole('button', { expanded: false }));
      expect(card.textContent).toContain('general-purpose · Claude Code · ');
      expect(within(card).getByText('model not reported')).toBeTruthy();
      expect(unexpectedRequests).toEqual([]);
    },
  );

  test('the card follows the child to Completed with its elapsed time, result preview, and an inspectable transcript', async () => {
    windowEvents.current = [...spawningTurn(), progress()];
    const view = renderTranscript();
    await findCard();
    windowEvents.current = [
      ...windowEvents.current,
      ...settles(
        '**Verdict: merge as-is.** I found no blockers.\n\nEvery required check passed.',
      ),
    ];
    view.rerender();
    const card = await findCard();
    await within(card).findByText('Completed');
    expect(within(card).queryByText('Running')).toBeNull();
    // The first settle's reported end (17m 04s after the reported start).
    expect(within(card).getByText('17:04')).toBeTruthy();
    expect(
      within(card).getByText('**Verdict: merge as-is.** I found no blockers.'),
    ).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { expanded: false }));
    expect(
      await within(card).findByText('Every required check passed.'),
    ).toBeTruthy();
    expect(
      within(card).getByText('48,210 tokens · 37 tool uses · ran 17:04'),
    ).toBeTruthy();
    fireEvent.click(
      within(card).getByRole('button', { name: 'View transcript' }),
    );
    expect(
      await within(card).findByText('Review the ADR freeze PR.', {
        selector: '.child-work-transcript__text',
      }),
    ).toBeTruthy();
    expect(unexpectedRequests).toEqual([]);
  });

  test('a loaded Claude spawning call reconstructs its completed child from terminal identity without a running snapshot', async () => {
    windowEvents.current = [
      ...spawningTurn().filter(
        (entry) => entry.event.method !== 'child-work.updated',
      ),
      ...settles('Result retained in terminal history'),
    ];
    renderTranscript();
    const card = await findCard();
    expect(screen.getAllByTestId('subagent-card')).toHaveLength(1);
    expect(within(card).getByText('Completed')).toBeTruthy();
    expect(
      within(card).getByText('Result retained in terminal history'),
    ).toBeTruthy();
  });

  test('a session that ends without settling its child reads No result, never Completed', async () => {
    windowEvents.current = [
      ...spawningTurn(),
      runtimeEvent('2026-10-14T14:50:00.000Z', {
        method: 'session.exited',
        sessionId: THREAD,
      }),
    ];
    renderTranscript();
    const card = await findCard();
    await within(card).findByText('No result');
    expect(within(card).queryByText('Completed')).toBeNull();
    expect(within(card).queryByText('Running')).toBeNull();
  });
});
