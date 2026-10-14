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
import { _setApiBase } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
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
  ConnectedAnswerBasisAffordance: () => null,
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
import { useActiveChatTranscript } from '../hooks/orchestration/useActiveChatTranscript';
import type { ChatSession } from '../types';

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
function runtimeEvent(createdAt: string, fields: Record<string, unknown>) {
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
function settles(summary: string) {
  const identity = {
    parent: runningChild.parent,
    title: runningChild.title,
    kindLabel: runningChild.kindLabel,
    transcript: runningChild.transcript,
    backgrounded: true,
    depth: 1,
    startedAt: STARTED_AT,
  };
  return [
    childWork(ENDED_AT, {
      kind: 'settle',
      producer: 'engine-subagent',
      reporterThreadId: THREAD,
      childId: 'a1b2c3',
      status: 'completed',
      identity: { ...identity, endedAt: ENDED_AT },
    }),
    childWork('2026-10-14T14:42:05.000Z', {
      kind: 'settle',
      producer: 'engine-subagent',
      reporterThreadId: THREAD,
      childId: 'a1b2c3',
      status: 'completed',
      result: {
        summary,
        handle: {
          kind: 'transcript-file',
          path: '/tmp/claude/tasks/a1b2c3.output',
        },
      },
      usage: { totalTokens: 48_210, toolUses: 37, durationMs: 1_024_000 },
      identity: { ...identity, endedAt: '2026-10-14T14:42:05.000Z' },
    }),
  ];
}

function TranscriptHarness({ session }: { session: ChatSession }) {
  const transcript = useActiveChatTranscript(API_BASE, session);
  return (
    <ChatMessageList
      activeSession={{ ...session, messages: transcript.messages }}
      approvalEvents={transcript.enabled ? transcript.events : undefined}
      approvalEventsSettled={transcript.settled}
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

function renderTranscript() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <ActiveChatsProvider>
        <TranscriptHarness session={chatSession()} />
      </ActiveChatsProvider>
    </QueryClientProvider>
  );
  const rendered = render(tree());
  return { rerender: () => rendered.rerender(tree()) };
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
    vi.unstubAllGlobals();
    _setApiBase('');
  });

  test('a running subagent renders one card after the call that spawned it, with its live status line', async () => {
    windowEvents.current = [...spawningTurn(), progress()];
    renderTranscript();
    const card = await findCard();
    expect(screen.getAllByTestId('subagent-card')).toHaveLength(1);
    expect(
      within(card).getByText('[opus] review station#3657 ADR freeze'),
    ).toBeTruthy();
    expect(within(card).getByText('Running')).toBeTruthy();
    expect(within(card).getByText('Reading the decision records')).toBeTruthy();
    // Engine and subagent type are the record's; the model was not reported,
    // and says so rather than borrowing the parent's.
    expect(card.textContent).toContain('general-purpose · Claude Code · ');
    expect(within(card).getByText('model not reported')).toBeTruthy();
    // Spawn point: after the intent, before the reply that followed the
    // call, in the same assistant row.
    const text = document.body.textContent ?? '';
    const intentAt = text.indexOf('Starting an independent review.');
    const cardAt = text.indexOf(card.textContent ?? '');
    const replyAt = text.indexOf('The reviewer is running in the background.');
    expect(intentAt).toBeGreaterThanOrEqual(0);
    expect(cardAt).toBeGreaterThan(intentAt);
    expect(replyAt).toBeGreaterThan(
      cardAt + (card.textContent ?? '').length - 1,
    );
    expect(unexpectedRequests).toEqual([]);
  });

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
