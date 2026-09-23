/**
 * @vitest-environment jsdom
 *
 * #2316: the inline approval card (Allow Once / Always Allow / Deny) must
 * answer an orchestration session's request through orchestration
 * `respondToRequest` — on the session that opened the request — and must say
 * so when the answer does not land.
 *
 * Real seam, end to end on the client: canonical runtime events → the shared
 * transcript projection (`useActiveChatTranscript`) → `ChatMessageList` →
 * `MessageBubble` → `ToolCallDisplay`'s buttons → the real `useToolApproval`
 * → the real SDK → `fetch`. Only the event window's transport and unrelated
 * app contexts are stubbed; the request the card sends is read off the wire.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { _setApiBase } from '@kontourai/station-sdk';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
  windowEvents: { current: [] as Array<{ sequence: number; event: unknown }> },
}));
// The bounded REST window is transport; the projection that turns its events
// into the card is the real one.
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

/** The chat tab: a conversation whose CURRENT child is `claude-child-b`. */
function chatSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'chat-tab',
    conversationId: 'conversation-1',
    currentSessionId: 'claude-child-b',
    agentSlug: agentId('station'),
    agentName: 'Station',
    title: 'Plugin authoring',
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
      threadId: 'claude-child-b',
      createdAt: `2026-09-22T00:00:${String(sequence).padStart(2, '0')}.000Z`,
      ...fields,
    },
  };
}

/** Claude's `canUseTool` for a Bash call, as the adapter publishes it. */
function claudeBashAwaitingApproval() {
  return [
    runtimeEvent({
      method: 'turn.started',
      turnId: 'turn-1',
      prompt: 'List the plugin files',
    }),
    runtimeEvent({
      method: 'tool.started',
      turnId: 'turn-1',
      itemId: 'toolu-1',
      toolCallId: 'toolu-1',
      toolName: 'Bash',
      arguments: { command: 'ls plugins' },
    }),
    runtimeEvent({
      method: 'request.opened',
      requestId: 'req-claude-b',
      requestType: 'approval',
      title: 'Allow Bash',
      payload: {
        toolName: 'Bash',
        toolCallId: 'toolu-1',
        toolInput: { command: 'ls plugins' },
      },
    }),
  ];
}

function TranscriptHarness({ session }: { session: ChatSession }) {
  const transcript = useActiveChatTranscript(API_BASE, session);
  return (
    <ChatMessageList
      activeSession={{ ...session, messages: transcript.messages }}
      fontSize={13}
      showReasoning={false}
      showToolDetails={false}
    />
  );
}

interface WireCall {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(
  answer: (call: WireCall) => Response | Promise<Response>,
): WireCall[] {
  const calls: WireCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const call = {
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      };
      // The transcript's checkpoint read is unrelated to approvals.
      if (url.includes('/checkpoints')) {
        return Response.json({ success: true, data: [] });
      }
      calls.push(call);
      return answer(call);
    }),
  );
  return calls;
}

function renderCard(session = chatSession()) {
  render(
    <ActiveChatsProvider>
      <TranscriptHarness session={session} />
    </ActiveChatsProvider>,
  );
}

describe('#2316 inline approval card', () => {
  beforeEach(() => {
    // What the mounted `ApiBaseProvider` does in the app; the registry route
    // resolves its base from here.
    _setApiBase(API_BASE);
    sequence = 0;
    windowEvents.current = claudeBashAwaitingApproval();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    _setApiBase('');
  });

  test.each([
    ['Allow Once', 'accept'],
    ['Always Allow', 'acceptForSession'],
    ['Deny', 'decline'],
  ] as const)(
    '%s answers the Claude session’s request through orchestration respondToRequest (%s)',
    async (label, decision) => {
      const calls = stubFetch(() => Response.json({ success: true, data: {} }));
      renderCard();

      fireEvent.click(await screen.findByRole('button', { name: label }));

      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toEqual({
        url: `${API_BASE}/api/orchestration/commands`,
        method: 'POST',
        // The request's OWN session — not the chat tab id, not the
        // conversation id — is the only thread that can answer it.
        body: {
          type: 'respondToRequest',
          threadId: 'claude-child-b',
          requestId: 'req-claude-b',
          decision,
        },
      });
      // A decision that landed is not offered again.
      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: label }) as HTMLButtonElement)
            .disabled,
        ).toBe(true),
      );
      expect(screen.queryByText(/Your decision was not delivered/)).toBeNull();
    },
  );

  test.each([
    [
      'the session no longer holds the request',
      () =>
        Response.json(
          {
            success: false,
            error: 'Unknown Claude permission request: req-claude-b',
          },
          { status: 404 },
        ),
      /Unknown Claude permission request: req-claude-b/,
    ],
    [
      'the network fails',
      () => Promise.reject(new TypeError('Failed to fetch')),
      /Failed to fetch/,
    ],
  ])(
    'says the decision was not delivered when %s, and stays actionable',
    async (_case, failure, reason) => {
      stubFetch(failure);
      renderCard();

      fireEvent.click(
        await screen.findByRole('button', { name: 'Allow Once' }),
      );

      // The card's own alert (the transcript may carry unrelated ones, e.g.
      // a lazy Task action that did not load in this environment).
      const alert = await screen.findByText(/Your decision was not delivered/);
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.textContent).toMatch(reason);
      // The request is still open: the card must not pretend it is settled.
      for (const name of ['Allow Once', 'Always Allow', 'Deny']) {
        expect(
          (screen.getByRole('button', { name }) as HTMLButtonElement).disabled,
        ).toBe(false);
      }
    },
  );

  test('a card without its request’s session falls back to the registry route and surfaces its refusal', async () => {
    // A part that does not carry `approvalThreadId` (not produced by the
    // current projection) keeps the ApprovalRegistry route — whose
    // `success: false` used to be ignored.
    const calls = stubFetch(() =>
      Response.json(
        { success: false, error: 'Approval request not found' },
        { status: 404 },
      ),
    );
    render(
      <ActiveChatsProvider>
        <ChatMessageList
          activeSession={chatSession({
            orchestrationSessionStarted: false,
            messages: [
              {
                role: 'assistant',
                content: '',
                contentParts: [
                  {
                    type: 'tool-invocation',
                    toolCallId: 'registry-call',
                    toolName: 'shell_exec',
                    state: 'awaiting-approval',
                    needsApproval: true,
                    approvalId: 'registry-approval-1',
                  },
                ],
              },
            ],
          })}
          fontSize={13}
          showReasoning={false}
          showToolDetails={false}
        />
      </ActiveChatsProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Allow Once' }));

    const alert = await screen.findByText(/Your decision was not delivered/);
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toMatch(/Approval request not found/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `${API_BASE}/tool-approval/registry-approval-1`,
      method: 'POST',
      body: { approved: true },
    });
  });
});
