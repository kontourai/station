/**
 * @vitest-environment jsdom
 *
 * #3419: another agent's message, and the call that sent it, through the real
 * client seam: canonical runtime events shaped as the server persists them
 * (`clientOrigin.sender` beside the `internal` actor, the prompt framed by
 * `frameAgentMessage`; the server side is recorded by
 * `session-agent-message-provenance.integration.test.ts`) → the shared
 * transcript projection (`useActiveChatTranscript`) → `ChatMessageList` →
 * `MessageBubble` / `ToolCallDisplay`.
 *
 * Three speakers must read apart: the person, this Session's own agent, and
 * another agent. An agent's message that lost its provenance must not quietly
 * become a person's bubble, which is what the "drops its sender" test pins.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { _setApiBase } from '@kontourai/station-sdk';
import { frameAgentMessage } from '@kontourai/station-shared/agent-message-frame';
import {
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

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatMessageList } from '../components/chat/ChatMessageList';
import { ActiveChatsProvider } from '../contexts/ActiveChatsContext';
import { navigationStore } from '../contexts/navigation-store';
import { openChatsStore } from '../contexts/open-chats-store';
import { useActiveChatTranscript } from '../hooks/orchestration/useActiveChatTranscript';
import type { ChatSession } from '../types';

const API_BASE = 'http://localhost:3242';
const THREAD = 'recipient-session';
const SENDER_THREAD = 'sender-session';

function chatSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'chat-tab',
    conversationId: THREAD,
    currentSessionId: THREAD,
    agentSlug: agentId('station'),
    agentName: 'Station',
    title: 'chat',
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
      provider: 'claude',
      threadId: THREAD,
      createdAt: `2026-10-05T10:00:${String(sequence).padStart(2, '0')}.000Z`,
      ...fields,
    },
  };
}

const SENDER = {
  kind: 'agent-session',
  sessionId: SENDER_THREAD,
  title: 'Fix login',
  engine: 'claude',
  requestKey: 'request-key-1',
} as const;
const OTHER_SENDER = {
  kind: 'agent-session',
  sessionId: 'other-sender',
  title: 'Release notes',
  agent: 'Writer',
  requestKey: 'request-key-2',
} as const;

/** The `clientOrigin` the server stamps on a turn another agent started. */
const agentOrigin = (sender: Record<string, unknown> = SENDER) => ({
  version: 1,
  actor: { kind: 'internal' },
  reported: { version: 1, surface: 'unknown', build: null },
  sender,
});
/** The `clientOrigin` of a turn its person typed. */
const personOrigin = {
  version: 1,
  actor: { kind: 'operator' },
  reported: { version: 1, surface: 'web', build: null },
};

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
  // The app mounts one QueryClientProvider above every surface; the sender's
  // row reads the Sessions list through it.
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ActiveChatsProvider>
        <TranscriptHarness session={session} />
      </ActiveChatsProvider>
    </QueryClientProvider>,
  );
}

/** The recipient's transcript: its person, then two other agents, one a steer. */
function recipientEvents(options: { keepSender?: boolean } = {}) {
  const sender = (value: Record<string, unknown>) =>
    options.keepSender === false ? undefined : value;
  const origin = (value: Record<string, unknown>) => ({
    ...agentOrigin(value),
    ...(options.keepSender === false ? { sender: undefined } : {}),
  });
  void sender;
  return [
    runtimeEvent({
      method: 'turn.started',
      turnId: 't1',
      prompt: 'Review the login patch',
      clientOrigin: personOrigin,
    }),
    runtimeEvent({
      method: 'content.text-delta',
      turnId: 't1',
      delta: 'Reading the patch. ',
    }),
    runtimeEvent({
      method: 'turn.started',
      turnId: 't1',
      inputKind: 'steer',
      prompt: frameAgentMessage(SENDER, 'Skip the lockfile.'),
      clientOrigin: origin(SENDER),
    }),
    runtimeEvent({
      method: 'content.text-delta',
      turnId: 't1',
      delta: 'Skipping it. ',
    }),
    runtimeEvent({ method: 'turn.completed', turnId: 't1' }),
    runtimeEvent({
      method: 'turn.started',
      turnId: 't2',
      prompt: frameAgentMessage(OTHER_SENDER, 'Please rebase onto main.'),
      clientOrigin: origin(OTHER_SENDER),
    }),
    runtimeEvent({
      method: 'content.text-delta',
      turnId: 't2',
      delta: 'Rebasing. ',
    }),
    runtimeEvent({ method: 'turn.completed', turnId: 't2' }),
  ];
}

beforeEach(() => {
  _setApiBase(API_BASE);
  sequence = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      Response.json({
        success: true,
        data: String(input).includes('/sessions/read-model')
          ? [
              {
                threadId: THREAD,
                provider: 'claude',
                displayTitle: 'Review the login patch',
              },
              {
                threadId: 'other-recipient',
                provider: 'codex',
                displayTitle: 'Release notes',
              },
            ]
          : [],
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  _setApiBase('');
});

describe('another agent’s message in the recipient’s transcript (#3419)', () => {
  test('reads as a third speaker: its own bubble, a header naming the Session and agent, and the sender’s own words', async () => {
    windowEvents.current = recipientEvents();
    renderTranscript();

    const incoming = await waitFor(() => {
      const found = document.querySelectorAll<HTMLElement>('.agent-incoming');
      expect(found).toHaveLength(2);
      return found;
    });
    const [steer, start] = [...incoming];

    // Not the person's bubble, and not the person's avatar.
    for (const bubble of [steer!, start!]) {
      expect(bubble.classList.contains('user')).toBe(false);
      const row = bubble.closest('.message-row');
      expect(row?.classList.contains('message-row--user')).toBe(false);
      expect(row?.classList.contains('message-row--agent')).toBe(true);
      expect(row?.textContent).not.toMatch(/^U/u);
    }

    // The header says who sent it, in words and with an icon, and a screen
    // reader gets the same plus that it is not the person's message.
    expect(steer?.getAttribute('aria-label')).toBe(
      'Message from another agent: Fix login, Claude Code',
    );
    const header = steer!.querySelector('.agent-incoming__header')!;
    expect(header.textContent).toContain('From Fix login · Claude Code');
    expect(header.querySelector('svg')).not.toBeNull();
    expect(
      within(header as HTMLElement).getByText(
        'This is a message from another agent, not from you.',
      ).className,
    ).toBe('sr-only');
    expect(start?.getAttribute('aria-label')).toBe(
      'Message from another agent: Release notes, Writer',
    );

    // What they said is the sender's own words, not the frame the engine got.
    expect(steer?.textContent).toContain('Skip the lockfile.');
    expect(start?.textContent).toContain('Please rebase onto main.');
    expect(document.body.textContent).not.toContain('[Station:');
    expect(document.body.textContent).not.toContain('Its lines follow');
  });

  test('the person’s own message is still the person’s, and the two senders wear different accents', async () => {
    windowEvents.current = recipientEvents();
    renderTranscript();
    await waitFor(() =>
      expect(document.querySelectorAll('.agent-incoming')).toHaveLength(2),
    );

    const person = [...document.querySelectorAll<HTMLElement>('.message.user')];
    expect(person).toHaveLength(1);
    expect(person[0]?.textContent).toContain('Review the login patch');
    expect(person[0]?.classList.contains('agent-incoming')).toBe(false);

    const accents = [
      ...document.querySelectorAll<HTMLElement>('.message-row--agent'),
    ].map((row) => row.style.getPropertyValue('--agent-accent-light'));
    expect(accents).toHaveLength(2);
    expect(accents[0]).toMatch(/^#[0-9a-f]{6}$/u);
    expect(accents[1]).toMatch(/^#[0-9a-f]{6}$/u);
    expect(accents[0]).not.toBe(accents[1]);
  });

  test('a message that drops its sender is not shown as another agent’s, so the rendering above cannot pass by accident', async () => {
    windowEvents.current = recipientEvents({ keepSender: false });
    renderTranscript();
    await waitFor(() =>
      expect(document.querySelectorAll('.message.user').length).toBeGreaterThan(
        1,
      ),
    );
    // Without the provenance the rows are plain user rows: the exact failure
    // the assertions above are there to catch.
    expect(document.querySelectorAll('.agent-incoming')).toHaveLength(0);
  });

  test('the header links to the Session that sent it', async () => {
    windowEvents.current = recipientEvents();
    const focus = vi
      .spyOn(openChatsStore, 'focus')
      .mockImplementation(() => {});
    renderTranscript();
    const link = await waitFor(() => {
      const found = document.querySelector<HTMLAnchorElement>(
        '.agent-incoming .agent-incoming__link',
      );
      expect(found).not.toBeNull();
      return found!;
    });
    expect(link.getAttribute('href')).toBe(
      `/?surface=activity&session=${SENDER_THREAD}`,
    );
    expect(link.getAttribute('aria-label')).toBe(
      'Open Fix login, the Session that sent this message',
    );
    // Not an open chat: Activity opens it, through the canonical deep link.
    const navigate = vi
      .spyOn(navigationStore, 'navigate')
      .mockImplementation(() => {});
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith(
      `/?surface=activity&session=${SENDER_THREAD}`,
    );
    expect(focus).not.toHaveBeenCalled();
    // An open chat is focused in the dock instead.
    vi.spyOn(openChatsStore, 'getSnapshot').mockReturnValue({
      [SENDER_THREAD]: { conversationId: SENDER_THREAD },
    } as never);
    navigate.mockClear();
    fireEvent.click(link);
    expect(focus).toHaveBeenCalledWith({ sessionId: SENDER_THREAD });
    expect(navigate).not.toHaveBeenCalled();
    // A modified click is the browser's (new tab), not ours. jsdom cannot
    // navigate, so the document absorbs the default action after React ran.
    const absorb = (event: Event) => event.preventDefault();
    document.addEventListener('click', absorb);
    focus.mockClear();
    fireEvent.click(link, { ctrlKey: true });
    document.removeEventListener('click', absorb);
    expect(focus).not.toHaveBeenCalled();
  });
});

describe('the sending call in the sender’s transcript (#3419)', () => {
  /** The route's own answers, as `jsonToolResult` hands them to the engine. */
  const answer = (body: Record<string, unknown>) => [
    { type: 'text', text: JSON.stringify(body, null, 2) },
  ];
  const send = (
    id: string,
    mode: string,
    result: Record<string, unknown>,
    text = 'Please rebase onto main.',
  ) => [
    runtimeEvent({
      method: 'tool.started',
      turnId: 's1',
      itemId: id,
      toolCallId: id,
      toolName: 'mcp__station-control__send_to_session',
      arguments: {
        sessionId: 'other-recipient',
        text,
        mode,
        requestKey: `key-${id}`,
      },
    }),
    runtimeEvent({
      method: 'tool.completed',
      turnId: 's1',
      itemId: id,
      toolCallId: id,
      toolName: 'mcp__station-control__send_to_session',
      status: 'success',
      output: answer(result),
    }),
  ];

  test('a start, a steer and a refusal each read as "Sent to <Session>" with their outcome and a link to it', async () => {
    windowEvents.current = [
      runtimeEvent({
        method: 'turn.started',
        turnId: 's1',
        prompt: 'Tell them',
      }),
      ...send('c1', 'start', {
        success: true,
        data: {
          outcome: 'started',
          sessionId: 'other-recipient',
          turnId: 'turn-9',
          eventCursor: 0,
        },
      }),
      ...send('c2', 'steer', {
        success: true,
        data: {
          outcome: 'steered',
          sessionId: 'other-recipient',
          turnId: 'turn-9',
          eventCursor: 4,
        },
      }),
      ...send('c3', 'start', {
        success: false,
        code: 'session_busy',
        error: 'The Session is running a turn, so a start was refused.',
        outcome: 'session_busy',
        reason: 'turn-active',
        sessionId: 'other-recipient',
      }),
      runtimeEvent({ method: 'turn.completed', turnId: 's1' }),
    ];
    renderTranscript(
      chatSession({
        conversationId: SENDER_THREAD,
        currentSessionId: SENDER_THREAD,
      }),
    );

    const rows = await waitFor(() => {
      const found = [
        ...document.querySelectorAll<HTMLElement>('.agent-outgoing'),
      ];
      expect(found).toHaveLength(3);
      return found;
    });
    // Each is its own row, not folded into a "used 3 tools" batch.
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      'Sent to Release notes: Started a turn',
      'Sent to Release notes: Steered the running turn',
      'Sent to Release notes: Refused: Session is busy',
    ]);
    expect(
      rows.map(
        (row) => row.querySelector('.agent-outgoing__outcome')?.textContent,
      ),
    ).toEqual([
      'Started a turn',
      'Steered the running turn',
      'Refused: Session is busy',
    ]);
    for (const row of rows) {
      expect(row.querySelector('svg')).not.toBeNull();
      expect(row.querySelector('.agent-outgoing__text')?.textContent).toBe(
        'Please rebase onto main.',
      );
      expect(
        row.querySelector('a.agent-outgoing__link')?.getAttribute('href'),
      ).toBe('/?surface=activity&session=other-recipient');
    }
    expect(screen.queryByText(/Used \d tools/u)).toBeNull();
  });

  test('a send that has not answered says it is sending, never that it sent', async () => {
    windowEvents.current = [
      runtimeEvent({
        method: 'turn.started',
        turnId: 's1',
        prompt: 'Tell them',
      }),
      runtimeEvent({
        method: 'tool.started',
        turnId: 's1',
        itemId: 'c1',
        toolCallId: 'c1',
        toolName: 'mcp__station-control__send_to_session',
        arguments: {
          sessionId: 'other-recipient',
          text: 'hi',
          mode: 'auto',
          requestKey: 'key-c1',
        },
      }),
    ];
    renderTranscript(
      chatSession({
        conversationId: SENDER_THREAD,
        currentSessionId: SENDER_THREAD,
      }),
    );
    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.agent-outgoing');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(row.getAttribute('aria-label')).toMatch(/^Sending to .*: Sending$/u);
  });
});
