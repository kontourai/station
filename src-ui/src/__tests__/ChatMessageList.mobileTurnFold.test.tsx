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
import { _setApiBase } from '@kontourai/station-sdk';
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

  test('a call still waiting on a grant stays visible, with its Allow control, outside the fold', async () => {
    windowEvents.current = [
      runtimeEvent({ method: 'turn.started', turnId: 't1', prompt: 'List' }),
      say('t1', 'INTENT: checking the plugins.'),
      ...call('t1', 'c1', 'read_file', { path: 'plugins/a.json' }),
      say('t1', 'BETWEEN: now listing them.'),
      ...call('t1', 'c2', 'read_file', { path: 'plugins/b.json' }),
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
    const pending = row.querySelector('.tool-call-batch__pending-grant');
    expect(pending?.textContent).toContain('ls plugins');
    expect(
      within(pending as HTMLElement).getByRole('button', {
        name: 'Allow Once',
      }),
    ).toBeTruthy();
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
