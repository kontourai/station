/**
 * @vitest-environment jsdom
 *
 * The phone transcript's one-work-row shape for a SETTLED assistant turn,
 * through the real client seam: canonical runtime events → the shared
 * transcript projection (`useActiveChatTranscript`) → `ChatMessageList` →
 * `MessageBubble` → `MessageContent` (`foldWork`) → `ToolCallBatch` and its
 * sheet. The content parts are whatever the projection produces for these
 * events; nothing here hand-builds a message.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { OrchestrationCommand } from '@kontourai/station-contracts/orchestration';
import { _setApiBase } from '@kontourai/station-sdk';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { mobile, windowEvents } = vi.hoisted(() => ({
  mobile: { current: true },
  windowEvents: {
    current: [] as Array<{ sequence: number; event: unknown }>,
  },
}));

vi.mock('../hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hooks/useIsMobile')>()),
  useIsMobile: () => mobile.current,
}));
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
vi.mock('../components/chat/StreamingMessage', () => ({
  StreamingMessage: () => <div data-testid="streaming-message">Streaming</div>,
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
import { preloadToolCallBatch } from '../components/chat/ToolCallBatchBoundary';
import { ActiveChatsProvider } from '../contexts/ActiveChatsContext';
import { useActiveChatTranscript } from '../hooks/orchestration/useActiveChatTranscript';
import type { ChatSession } from '../types';
import { messageTime } from '../utils/relativeTime';

const API_BASE = 'http://localhost:3242';
const THREAD = 'codex-thread';

function chatSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'chat-tab',
    conversationId: THREAD,
    currentSessionId: THREAD,
    agentSlug: agentId('station'),
    agentName: 'Station',
    title: 'Fix composer jump',
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
    ...overrides,
  };
}

let sequence = 0;
function runtimeEvent(fields: Record<string, unknown>) {
  sequence += 1;
  return {
    sequence,
    event: {
      eventId: `evt-${sequence}`,
      provider: 'codex',
      threadId: THREAD,
      createdAt: `2026-10-06T09:00:${String(sequence).padStart(2, '0')}.000Z`,
      ...fields,
    },
  };
}

function call(
  turnId: string,
  id: string,
  toolName: string,
  args: Record<string, unknown>,
  status: 'success' | 'error' = 'success',
) {
  return [
    runtimeEvent({
      method: 'tool.started',
      turnId,
      itemId: id,
      toolCallId: id,
      toolName,
      arguments: args,
    }),
    runtimeEvent({
      method: 'tool.completed',
      turnId,
      itemId: id,
      toolCallId: id,
      toolName,
      status,
      output: status === 'error' ? 'error TS2339' : 'ok',
      ...(status === 'error' ? { error: 'exit 2' } : {}),
    }),
  ];
}

const say = (turnId: string, delta: string) =>
  runtimeEvent({
    method: 'content.text-delta',
    turnId,
    itemId: `${turnId}:text:${sequence}`,
    delta,
  });

/** Intent, two runs of calls with narration between, then the outcome. */
function workedTurn({ settled }: { settled: boolean }) {
  return [
    runtimeEvent({ method: 'turn.started', turnId: 't1', prompt: 'Fix it' }),
    say('t1', 'INTENT: I will look at the viewport hook.'),
    ...call('t1', 'c1', 'read_file', { path: 'src/useVisualViewport.ts' }),
    say('t1', 'BETWEEN: the hook reads the layout viewport.'),
    ...call('t1', 'c2', 'edit_file', { path: 'src/ChatInput.tsx' }),
    ...call('t1', 'c3', 'bash', { command: 'npm run typecheck:ui' }, 'error'),
    ...call('t1', 'c4', 'bash', { command: 'npm run typecheck:ui' }),
    say('t1', 'OUTCOME: the composer now follows the visual viewport.'),
    ...(settled
      ? [
          runtimeEvent({
            method: 'turn.completed',
            turnId: 't1',
            finishReason: 'stop',
          }),
        ]
      : []),
  ];
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

function renderTranscript(session = chatSession()) {
  return render(
    <ActiveChatsProvider>
      <TranscriptHarness session={session} />
    </ActiveChatsProvider>,
  );
}

function answerRow(): HTMLElement {
  const row = screen.getByText(/OUTCOME:/).closest<HTMLElement>('.message-row');
  if (!row) throw new Error('no assistant row');
  return row;
}

describe('phone transcript: one work row per settled turn', () => {
  beforeEach(async () => {
    _setApiBase(API_BASE);
    sequence = 0;
    mobile.current = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ success: true, data: [] })),
    );
    // The batch chunk is lazy; load it once so the first render is the
    // collapsed shape rather than the boundary's inline fallback.
    await preloadToolCallBatch();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    _setApiBase('');
  });

  test('a settled turn folds every call and the narration between them into one row; intent and outcome stay', async () => {
    windowEvents.current = workedTurn({ settled: true });
    renderTranscript();

    await waitFor(() => expect(screen.getByText(/OUTCOME:/)).toBeTruthy());
    const row = answerRow();
    const summaries = row.querySelectorAll('.tool-call-batch__summary');
    expect(summaries).toHaveLength(1);
    // The four calls are inside it: no standalone call row in the answer.
    expect(
      row.querySelectorAll('.tool-call:not(.tool-call-batch *)'),
    ).toHaveLength(0);
    expect(within(row).queryByText(/BETWEEN:/)).toBeNull();
    expect(within(row).getByText(/INTENT:/)).toBeTruthy();
    // The summary row sits where the first call was: after the intent,
    // before the outcome.
    const text = row.textContent ?? '';
    const summaryAt = text.indexOf(summaries[0]!.textContent ?? '');
    expect(text.indexOf('INTENT:')).toBeLessThan(summaryAt);
    expect(summaryAt).toBeLessThan(text.indexOf('OUTCOME:'));
    // The c3 failure was recovered by the identical c4: named neutrally.
    expect(summaries[0]!.textContent).toContain('1 retried');
    expect(summaries[0]!.textContent).not.toContain('failed');
  });

  test('opening the work row shows the folded narration between the calls it was written between', async () => {
    windowEvents.current = workedTurn({ settled: true });
    renderTranscript();

    await waitFor(() => expect(screen.getByText(/OUTCOME:/)).toBeTruthy());
    fireEvent.click(
      answerRow().querySelector<HTMLElement>('.tool-call-batch__summary')!,
    );
    const sheet = await screen.findByRole('dialog');
    const between = await within(sheet).findByText(/BETWEEN:/);
    const labels = [...sheet.querySelectorAll('.tool-call__label')].map(
      (el) => el.textContent,
    );
    expect(labels).toEqual([
      'Read useVisualViewport.ts',
      'Edited ChatInput.tsx',
      'Ran npm run typecheck:ui',
      'Ran npm run typecheck:ui',
    ]);
    const readRow = within(sheet)
      .getByText('Read useVisualViewport.ts')
      .closest('.tool-call-batch-sheet__row')!;
    const editRow = within(sheet)
      .getByText('Edited ChatInput.tsx')
      .closest('.tool-call-batch-sheet__row')!;
    expect(
      readRow.compareDocumentPosition(between) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      between.compareDocumentPosition(editRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('desktop keeps today’s per-run shape: narration between runs stays inline', async () => {
    mobile.current = false;
    windowEvents.current = workedTurn({ settled: true });
    renderTranscript();

    await waitFor(() => expect(screen.getByText(/OUTCOME:/)).toBeTruthy());
    const row = answerRow();
    expect(within(row).getByText(/BETWEEN:/)).toBeTruthy();
    // Run 1 is the solo read (an inline row); run 2 is the 3-call batch.
    expect(row.querySelectorAll('.tool-call-batch__summary')).toHaveLength(1);
    expect(within(row).getByText('Read useVisualViewport.ts')).toBeTruthy();
  });

  test('the open turn keeps its streamed shape until it settles', async () => {
    windowEvents.current = workedTurn({ settled: false });
    renderTranscript(
      chatSession({
        status: 'sending',
        orchestrationTurnOpen: true,
        openTurnId: 't1',
      }),
    );

    await waitFor(() => expect(screen.getByText(/OUTCOME:/)).toBeTruthy());
    expect(within(answerRow()).getByText(/BETWEEN:/)).toBeTruthy();
  });

  test('a call still waiting on a grant stays visible and answers its request through the sheet outside the fold', async () => {
    const answers: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes('/checkpoints')) {
          return Response.json({ success: true, data: [] });
        }
        if (url === `${API_BASE}/api/orchestration/commands`) {
          answers.push({
            url,
            method: init?.method ?? 'GET',
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
          });
          return Response.json({ success: true });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    windowEvents.current = [
      runtimeEvent({ method: 'turn.started', turnId: 't1', prompt: 'List' }),
      say('t1', 'INTENT: checking the plugins.'),
      ...call('t1', 'c1', 'read_file', { path: 'plugins/a.json' }),
      say('t1', 'BETWEEN: now the second one.'),
      ...call('t1', 'c2', 'read_file', { path: 'plugins/b.json' }),
      say('t1', 'LAST: listing them.'),
      runtimeEvent({
        method: 'tool.started',
        turnId: 't1',
        itemId: 'c3',
        toolCallId: 'c3',
        toolName: 'Bash',
        arguments: { command: 'ls plugins' },
      }),
      runtimeEvent({
        method: 'request.opened',
        requestId: 'req-1',
        requestType: 'approval',
        title: 'Allow Bash',
        payload: {
          toolName: 'Bash',
          toolCallId: 'c3',
          toolInput: { command: 'ls plugins' },
        },
      }),
    ];
    // The client does not see the turn as live (no open-turn flags), so the
    // row is treated as settled and folds — the grant must survive that.
    renderTranscript();

    await waitFor(() => expect(screen.getByText(/INTENT:/)).toBeTruthy());
    const row = screen
      .getByText(/INTENT:/)
      .closest<HTMLElement>('.message-row')!;
    expect(row.querySelectorAll('.tool-call-batch__summary')).toHaveLength(1);
    expect(within(row).queryByText(/BETWEEN:/)).toBeNull();
    // Nothing follows the last call, so its narration is the turn's last word.
    expect(within(row).getByText(/LAST:/)).toBeTruthy();
    const pending = row.querySelector<HTMLElement>(
      '.tool-call-batch__pending-grant',
    );
    expect(pending?.textContent).toContain('ls plugins');
    if (!pending) throw new Error('no pending grant outside the fold');
    const approval = pending.querySelector('.tool-call');
    expect(approval?.getAttribute('data-approval-thread')).toBe(THREAD);
    expect(approval?.getAttribute('data-approval-id')).toBe('req-1');
    fireEvent.click(within(pending).getByRole('button', { name: 'Answer' }));
    const sheet = await screen.findByRole('dialog', { name: 'Needs approval' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Allow Once' }));
    await waitFor(() =>
      expect(answers).toEqual([
        {
          url: `${API_BASE}/api/orchestration/commands`,
          method: 'POST',
          body: {
            type: 'respondToRequest',
            threadId: THREAD,
            requestId: 'req-1',
            expectedRequestEventId: 'evt-10',
            decision: 'accept',
          } satisfies OrchestrationCommand,
        },
      ]),
    );
  });
});

describe('phone transcript: fold review fixes', () => {
  beforeEach(async () => {
    _setApiBase(API_BASE);
    sequence = 0;
    mobile.current = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ success: true, data: [] })),
    );
    await preloadToolCallBatch();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    _setApiBase('');
  });

  /** A turn the user steered mid-flight; the turn is still open. */
  function steeredOpenTurn() {
    return [
      runtimeEvent({ method: 'turn.started', turnId: 't1', prompt: 'Fix it' }),
      say('t1', 'INTENT: reading first.'),
      ...call('t1', 'c1', 'read_file', { path: 'src/a.ts' }),
      say('t1', 'BETWEEN: now the second file.'),
      ...call('t1', 'c2', 'read_file', { path: 'src/b.ts' }),
      // Text after the last pre-steer call, so the last-words rule cannot be
      // what keeps BETWEEN visible: only the live guard can.
      say('t1', 'TAIL: both files read.'),
      runtimeEvent({
        method: 'turn.started',
        turnId: 't1',
        inputKind: 'steer',
        prompt: 'STEER: also check c.ts',
      }),
      runtimeEvent({
        method: 'tool.started',
        turnId: 't1',
        itemId: 'c3',
        toolCallId: 'c3',
        toolName: 'bash',
        arguments: { command: 'npm test' },
      }),
    ];
  }

  test('a steered live turn known only from the server activity record keeps its pre-steer row unfolded', async () => {
    windowEvents.current = steeredOpenTurn();
    // Liveness comes from the server record; this client never stamped
    // `openTurnId` (it attached to a running turn). The pre-steer row is not
    // the last row, so only the turn-id guard can protect it.
    renderTranscript(
      chatSession({
        conversationActivity: {
          conversationId: THREAD,
          asOfSequence: sequence,
          openTurn: {
            turnId: 't1',
            threadId: THREAD,
            startedAt: '2026-10-06T09:00:01.000Z',
          },
        },
      }),
    );

    await waitFor(() => expect(screen.getByText(/INTENT:/)).toBeTruthy());
    const preSteer = screen
      .getByText(/INTENT:/)
      .closest<HTMLElement>('.message-row')!;
    expect(within(preSteer).getByText(/BETWEEN:/)).toBeTruthy();
  });

  test('without the server record, the live last row is protected by the tail guard alone', async () => {
    // No turn ids on the events at all, so the turn-id guard can never
    // match; the live turn renders as the transcript's last row.
    windowEvents.current = workedTurn({ settled: false }).map((entry) => {
      const { turnId: _turnId, ...event } = entry.event as Record<
        string,
        unknown
      >;
      return { ...entry, event };
    });
    renderTranscript(
      chatSession({ status: 'sending', orchestrationTurnOpen: true }),
    );

    await waitFor(() => expect(screen.getByText(/OUTCOME:/)).toBeTruthy());
    expect(within(answerRow()).getByText(/BETWEEN:/)).toBeTruthy();
  });

  test('a steer inside a turn opens no new exchange; the next turn does', async () => {
    windowEvents.current = [
      ...steeredOpenTurn(),
      runtimeEvent({
        method: 'turn.completed',
        turnId: 't1',
        finishReason: 'stop',
      }),
      runtimeEvent({
        method: 'turn.started',
        turnId: 't2',
        prompt: 'NEXT: and then?',
      }),
      say('t2', 'OUTCOME: done.'),
      runtimeEvent({
        method: 'turn.completed',
        turnId: 't2',
        finishReason: 'stop',
      }),
    ];
    renderTranscript();

    await waitFor(() => expect(screen.getByText(/NEXT:/)).toBeTruthy());
    const userRow = (text: RegExp) =>
      screen.getByText(text).closest<HTMLElement>('.message-row')!;
    expect(userRow(/Fix it/).className).not.toContain('exchange-start');
    expect(userRow(/STEER:/).className).not.toContain('exchange-start');
    expect(userRow(/NEXT:/).className).toContain('message-row--exchange-start');
  });

  test('a turn that ends on a tool call keeps its last narration visible', async () => {
    windowEvents.current = [
      runtimeEvent({
        method: 'turn.started',
        turnId: 't1',
        prompt: 'Clean up',
      }),
      say('t1', 'INTENT: checking what is left.'),
      ...call('t1', 'c1', 'read_file', { path: 'db.json' }),
      say('t1', 'QUESTION: should I delete the prod DB?'),
      ...call('t1', 'c2', 'read_file', { path: 'backup.json' }),
      runtimeEvent({
        method: 'turn.completed',
        turnId: 't1',
        finishReason: 'stop',
      }),
    ];
    renderTranscript();

    await waitFor(() => expect(screen.getByText(/INTENT:/)).toBeTruthy());
    const row = screen
      .getByText(/INTENT:/)
      .closest<HTMLElement>('.message-row')!;
    expect(row.querySelectorAll('.tool-call-batch__summary')).toHaveLength(1);
    expect(within(row).getByText(/QUESTION:/)).toBeTruthy();
  });
});

describe('phone transcript: the answer meta row states the turn’s own time', () => {
  beforeEach(() => {
    _setApiBase(API_BASE);
    sequence = 0;
    mobile.current = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ success: true, data: [] })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    _setApiBase('');
  });

  test('a settled turn shows its terminal event time beside ⋯', async () => {
    windowEvents.current = workedTurn({ settled: true });
    const completedAt = (
      windowEvents.current.at(-1)!.event as { createdAt: string }
    ).createdAt;
    renderTranscript();

    await waitFor(() => expect(screen.getByText(/OUTCOME:/)).toBeTruthy());
    const time = answerRow().querySelector('.message-meta time');
    expect(time?.getAttribute('datetime')).toBe(completedAt);
    expect(time?.textContent).toBe(
      messageTime(Date.parse(completedAt), Date.now()),
    );
    expect(time?.textContent).not.toBe('');
  });

  test('a row with no turn envelope states no time, even though it carries a timestamp', async () => {
    // No turn id anywhere: the projection still stamps the row's timestamp,
    // but no envelope vouches for it, so the meta row says nothing.
    windowEvents.current = [
      runtimeEvent({ method: 'turn.started', prompt: 'Hi' }),
      say('t?', 'OUTCOME: hello.'),
      runtimeEvent({ method: 'turn.completed', finishReason: 'stop' }),
    ];
    renderTranscript();

    await waitFor(() => expect(screen.getByText(/OUTCOME:/)).toBeTruthy());
    const row = answerRow();
    expect(row.querySelector('.message-meta')).toBeTruthy();
    expect(row.querySelector('.message-meta time')).toBeNull();
  });

  test('desktop renders no meta row', async () => {
    mobile.current = false;
    windowEvents.current = workedTurn({ settled: true });
    renderTranscript();

    await waitFor(() => expect(screen.getByText(/OUTCOME:/)).toBeTruthy());
    expect(answerRow().querySelector('.message-meta')).toBeNull();
  });
});

describe('phone transcript: meta time reads the envelope, not the row timestamp', () => {
  beforeEach(() => {
    _setApiBase(API_BASE);
    sequence = 0;
    mobile.current = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ success: true, data: [] })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    _setApiBase('');
  });

  /** The settled answer row and envelope exactly as the projection writes them. */
  function projectedAnswer() {
    const events = workedTurn({ settled: true }).map((entry) => entry.event);
    const rows = projectRuntimeEventsToMessages(events as never);
    const answer = [...rows].reverse().find((row) => row.role === 'assistant')!;
    const provenance = answer.metadata?.provenance as
      | Record<string, unknown>
      | undefined;
    if (!provenance?.observedAt) throw new Error('no projected envelope');
    return { answer, provenance };
  }

  function renderRow(provenance: unknown, timestamp: number) {
    const { answer } = projectedAnswer();
    render(
      <ActiveChatsProvider>
        <ChatMessageList
          activeSession={chatSession({
            orchestrationSessionStarted: false,
            messages: [
              {
                role: 'assistant',
                content: 'OUTCOME: answer.',
                turnId: answer.metadata?.turnId,
                sessionId: THREAD,
                timestamp,
                provenance,
              },
            ],
          })}
          fontSize={13}
          showReasoning={false}
          showToolDetails={false}
        />
      </ActiveChatsProvider>,
    );
    return answerRow();
  }

  test('a row whose timestamp disagrees with its envelope shows the envelope time', () => {
    const { provenance } = projectedAnswer();
    const observedAt = String(provenance.observedAt);
    // A client-clock fill-in, two days off the real settle.
    const fabricated = Date.parse(observedAt) - 2 * 86_400_000 + 4_321_000;
    const row = renderRow(provenance, fabricated);
    const time = row.querySelector('.message-meta time');
    expect(time?.getAttribute('datetime')).toBe(observedAt);
    expect(time?.textContent).toBe(
      messageTime(Date.parse(observedAt), Date.now()),
    );
    expect(time?.textContent).not.toBe(messageTime(fabricated, Date.now()));
  });

  test('an envelope that fails validation (no observedAt) states no time, even with a row timestamp', () => {
    const { provenance } = projectedAnswer();
    const { observedAt: _dropped, ...withoutTime } = provenance;
    const row = renderRow(withoutTime, Date.now());
    expect(row.querySelector('.message-meta')).toBeTruthy();
    expect(row.querySelector('.message-meta time')).toBeNull();
  });

  test('a valid envelope whose observedAt does not parse states no time, even with a row timestamp', () => {
    const { provenance } = projectedAnswer();
    const row = renderRow({ ...provenance, observedAt: 'garbage' }, Date.now());
    expect(row.querySelector('.message-meta')).toBeTruthy();
    expect(row.querySelector('.message-meta time')).toBeNull();
  });
});
