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
import { activeChatsStore } from '../contexts/active-chats-store';
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
      approvalEvents={transcript.approvalEvents}
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
    // #2316 review: the same words as the toast for the same grant — every
    // later Bash call in this session, not "always".
    ['Allow Bash for this session', 'acceptForSession'],
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
          // The exact prompt the user saw (the request.opened event id).
          expectedRequestEventId: 'evt-3',
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
      for (const name of [
        'Allow Once',
        'Allow Bash for this session',
        'Deny',
      ]) {
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

  test('the session grant is labelled with its tool and its session scope, never "Always Allow"', async () => {
    stubFetch(() => Response.json({ success: true, data: {} }));
    renderCard();
    const grant = await screen.findByRole('button', {
      name: 'Allow Bash for this session',
    });
    expect(grant.textContent).toBe('Allow Bash for this session');
    expect(screen.queryByRole('button', { name: /Always Allow/ })).toBeNull();
  });

  describe('a second answer for a request that is already settled', () => {
    const refusedAsResolved = (call: WireCall) =>
      call.method === 'POST'
        ? Response.json(
            {
              success: false,
              error: 'This request has already been resolved.',
              code: 'request_event_changed',
            },
            { status: 409 },
          )
        : null;

    test('reads settled, not failed, when the request itself says it was answered', async () => {
      const calls = stubFetch(
        (call) =>
          refusedAsResolved(call) ??
          Response.json({
            success: true,
            data: {
              state: 'resolved',
              reference: {
                threadId: 'claude-child-b',
                requestId: 'req-claude-b',
                requestEventId: 'evt-3',
              },
              message: 'This request has already been resolved.',
            },
          }),
      );
      renderCard();

      fireEvent.click(
        await screen.findByRole('button', { name: 'Allow Once' }),
      );

      const status = await screen.findByText(
        'This request was already answered.',
      );
      expect(status.getAttribute('role')).toBe('status');
      expect(screen.queryByText(/Your decision was not delivered/)).toBeNull();
      // Settledness is read from the exact request, not guessed from the
      // refusal text.
      expect(calls[1]).toMatchObject({
        method: 'GET',
        url: `${API_BASE}/api/orchestration/sessions/claude-child-b/requests/req-claude-b?eventId=evt-3`,
      });
    });

    test('stays a loud failure when the request is still open', async () => {
      stubFetch(
        (call) =>
          refusedAsResolved(call) ??
          Response.json({
            success: true,
            data: {
              state: 'changed',
              reference: {
                threadId: 'claude-child-b',
                requestId: 'req-claude-b',
                requestEventId: 'evt-3',
              },
              message: 'This request changed.',
            },
          }),
      );
      renderCard();

      fireEvent.click(
        await screen.findByRole('button', { name: 'Allow Once' }),
      );

      const alert = await screen.findByText(/Your decision was not delivered/);
      expect(alert.getAttribute('role')).toBe('alert');
      expect(
        screen.queryByText('This request was already answered.'),
      ).toBeNull();
    });

    test('stays a loud failure when the request cannot be verified', async () => {
      stubFetch(
        (call) =>
          refusedAsResolved(call) ??
          Response.json({
            success: true,
            data: {
              state: 'unavailable',
              reference: {
                threadId: 'claude-child-b',
                requestId: 'req-claude-b',
                requestEventId: 'evt-3',
              },
              message: 'This request could not be verified.',
            },
          }),
      );
      renderCard();

      fireEvent.click(
        await screen.findByRole('button', { name: 'Allow Once' }),
      );

      const alert = await screen.findByText(/Your decision was not delivered/);
      expect(alert.getAttribute('role')).toBe('alert');
      expect(
        screen.queryByText('This request was already answered.'),
      ).toBeNull();
    });

    test('a refused session grant on an already-answered request grants nothing locally', async () => {
      activeChatsStore.initChat('chat-tab', {
        agentSlug: 'station',
        agentName: 'Station',
        title: 'Plugin authoring',
      });
      try {
        stubFetch(
          (call) =>
            refusedAsResolved(call) ??
            Response.json({
              success: true,
              data: {
                state: 'resolved',
                reference: {
                  threadId: 'claude-child-b',
                  requestId: 'req-claude-b',
                  requestEventId: 'evt-3',
                },
                message: 'This request has already been resolved.',
              },
            }),
        );
        renderCard();

        fireEvent.click(
          await screen.findByRole('button', {
            name: 'Allow Bash for this session',
          }),
        );

        await screen.findByText('This request was already answered.');
        // Which decision settled it is not ours to claim: no local grant.
        expect(
          activeChatsStore.getSnapshot()['chat-tab']?.sessionAutoApprove ?? [],
        ).toEqual([]);
      } finally {
        activeChatsStore.removeChat('chat-tab');
      }
    });
  });

  test('a subagent request whose exact call id misses a same-named main call goes to the strip, not onto that call', async () => {
    sequence = 0;
    windowEvents.current = [
      runtimeEvent({
        method: 'turn.started',
        turnId: 'turn-1',
        prompt: 'Delegate the tests',
      }),
      runtimeEvent({
        method: 'tool.started',
        turnId: 'turn-1',
        itemId: 'main-bash',
        toolCallId: 'main-bash',
        toolName: 'Bash',
        arguments: { command: 'ls' },
      }),
      runtimeEvent({
        method: 'request.opened',
        requestId: 'req-sub',
        requestType: 'approval',
        title: 'Allow Bash',
        payload: { toolName: 'Bash', toolCallId: 'sub-call', agentId: 'a1' },
      }),
    ];
    stubFetch(() => Response.json({ success: true, data: {} }));
    renderCard();

    const strip = await screen.findByRole('region', {
      name: 'Approvals waiting on you',
    });
    // Exactly one card offers buttons: the strip's.
    expect(screen.getAllByRole('button', { name: 'Allow Once' })).toHaveLength(
      1,
    );
    expect(
      within(strip).getByRole('button', { name: 'Allow Once' }),
    ).toBeTruthy();
  });

  describe('an approval with no card of its own (e.g. a Claude subagent call)', () => {
    /** After a reload: the window alone, no live toast or streaming shell. */
    function subagentBashAwaitingApproval() {
      return [
        runtimeEvent({
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: 'Review the plugin with a subagent',
        }),
        runtimeEvent({
          method: 'tool.started',
          turnId: 'turn-1',
          itemId: 'toolu-task',
          toolCallId: 'toolu-task',
          toolName: 'Task',
          arguments: { description: 'Review' },
        }),
        // The subagent's own Bash tool_use never enters the main transcript,
        // so this request's exact call id binds to no row.
        runtimeEvent({
          method: 'request.opened',
          requestId: 'req-subagent',
          requestType: 'approval',
          title: 'Allow Bash',
          payload: {
            toolName: 'Bash',
            toolCallId: 'toolu-subagent-bash',
            toolInput: { command: 'npm test' },
            agentId: 'agent-1',
          },
        }),
      ];
    }

    test('stays answerable from the chat after a reload, naming its own request', async () => {
      sequence = 0;
      windowEvents.current = subagentBashAwaitingApproval();
      const calls = stubFetch(() => Response.json({ success: true, data: {} }));
      renderCard();

      fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));

      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]?.body).toEqual({
        type: 'respondToRequest',
        threadId: 'claude-child-b',
        requestId: 'req-subagent',
        expectedRequestEventId: 'evt-3',
        decision: 'decline',
      });
      // It was not re-bound onto the parent's same-turn call.
      expect(
        screen.getAllByRole('button', { name: 'Allow Bash for this session' }),
      ).toHaveLength(1);
    });

    test('offers nothing once the request is resolved, its session exited, or a recovery aborted its turn', async () => {
      for (const settle of [
        {
          method: 'request.resolved',
          requestId: 'req-subagent',
          status: 'approved',
        },
        { method: 'session.exited', exitCode: 0 },
        // A boot recovery's abort: no process holds the request any more.
        {
          method: 'turn.aborted',
          turnId: 'turn-1',
          reason: 'interrupted by restart',
          recoveryTerminal: true,
        },
      ]) {
        cleanup();
        sequence = 0;
        windowEvents.current = [
          ...subagentBashAwaitingApproval(),
          runtimeEvent(settle),
        ];
        stubFetch(() => Response.json({ success: true, data: {} }));
        renderCard();
        await screen.findByText(/Review the plugin with a subagent/);
        expect(screen.queryByRole('button', { name: 'Allow Once' })).toBeNull();
        expect(
          screen.queryByRole('region', { name: 'Approvals waiting on you' }),
        ).toBeNull();
      }
    });

    test.each([['completed', { method: 'turn.completed', turnId: 'turn-1' }]])(
      'stays answerable after the MAIN turn %s — a background subagent outlives it',
      async (_name, end) => {
        sequence = 0;
        windowEvents.current = [
          ...subagentBashAwaitingApproval(),
          runtimeEvent(end),
        ];
        stubFetch(() => Response.json({ success: true, data: {} }));
        renderCard();
        const strip = await screen.findByRole('region', {
          name: 'Approvals waiting on you',
        });
        expect(
          within(strip).getByRole('button', { name: 'Deny' }),
        ).toBeTruthy();
      },
    );

    test('a main-thread request with no card is retired by its turn end', async () => {
      sequence = 0;
      windowEvents.current = [
        runtimeEvent({
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: 'Go',
        }),
        // Codex-shaped: no tool name, no call id, no agent id.
        runtimeEvent({
          method: 'request.opened',
          requestId: 'req-codex',
          requestType: 'approval',
          title: 'rm -rf build',
          payload: { command: 'rm -rf build' },
        }),
        runtimeEvent({
          method: 'turn.aborted',
          turnId: 'turn-1',
          reason: 'interrupted',
        }),
      ];
      stubFetch(() => Response.json({ success: true, data: {} }));
      renderCard();
      await screen.findByText('Go');
      expect(
        screen.queryByRole('region', { name: 'Approvals waiting on you' }),
      ).toBeNull();
    });

    test('is offered in the pending-approvals strip, never as a transcript message', async () => {
      sequence = 0;
      windowEvents.current = subagentBashAwaitingApproval();
      stubFetch(() => Response.json({ success: true, data: {} }));
      renderCard();

      const strip = await screen.findByRole('region', {
        name: 'Approvals waiting on you',
      });
      expect(
        within(strip).getByRole('button', { name: 'Allow Once' }),
      ).toBeTruthy();
      // Not a message row: no message anchor holds it, and no transcript row
      // was invented for it.
      expect(strip.closest('[data-chat-message-key]')).toBeNull();
      for (const row of document.querySelectorAll('[data-chat-message-key]')) {
        expect(row.getAttribute('data-chat-message-key')).not.toMatch(
          /pending/,
        );
      }
    });

    test('lists only requests with no answerable card, and never takes the last row’s buttons', async () => {
      sequence = 0;
      windowEvents.current = [
        ...subagentBashAwaitingApproval(),
        // The parent's own Bash call, bound to its own request.
        runtimeEvent({
          method: 'tool.started',
          turnId: 'turn-1',
          itemId: 'toolu-parent-bash',
          toolCallId: 'toolu-parent-bash',
          toolName: 'Bash',
          arguments: { command: 'ls' },
        }),
        runtimeEvent({
          method: 'request.opened',
          requestId: 'req-parent',
          requestType: 'approval',
          title: 'Allow Bash',
          payload: { toolName: 'Bash', toolCallId: 'toolu-parent-bash' },
        }),
      ];
      const calls = stubFetch(() => Response.json({ success: true, data: {} }));
      renderCard();

      const strip = await screen.findByRole('region', {
        name: 'Approvals waiting on you',
      });
      // One card in the strip: the subagent's. The parent's card stays on
      // its own row, the last one, with its buttons.
      expect(
        within(strip).getAllByRole('button', { name: 'Deny' }),
      ).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: 'Deny' })).toHaveLength(2);
      const rowDeny = screen
        .getAllByRole('button', { name: 'Deny' })
        .find((button) => !strip.contains(button));
      fireEvent.click(rowDeny!);
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]?.body).toMatchObject({ requestId: 'req-parent' });
    });

    test('each session in a lineage offers its own request', async () => {
      sequence = 0;
      windowEvents.current = [
        runtimeEvent({
          method: 'turn.started',
          threadId: 'claude-child-a',
          turnId: 'turn-a',
          prompt: 'Earlier session',
        }),
        runtimeEvent({
          method: 'request.opened',
          threadId: 'claude-child-a',
          requestId: 'req-same-id',
          requestType: 'approval',
          title: 'Allow Read',
          payload: { toolName: 'Read', toolCallId: 'toolu-a' },
        }),
        runtimeEvent({
          method: 'turn.started',
          turnId: 'turn-b',
          prompt: 'Current session',
        }),
        runtimeEvent({
          method: 'request.opened',
          requestId: 'req-same-id',
          requestType: 'approval',
          title: 'Allow Bash',
          payload: { toolName: 'Bash', toolCallId: 'toolu-b' },
        }),
      ];
      const calls = stubFetch(() => Response.json({ success: true, data: {} }));
      renderCard();

      const strip = await screen.findByRole('region', {
        name: 'Approvals waiting on you',
      });
      fireEvent.click(
        within(strip).getByRole('button', {
          name: 'Allow Read for this session',
        }),
      );
      fireEvent.click(
        within(strip).getByRole('button', {
          name: 'Allow Bash for this session',
        }),
      );
      await waitFor(() => expect(calls).toHaveLength(2));
      expect(calls.map((call) => call.body)).toEqual([
        expect.objectContaining({
          threadId: 'claude-child-a',
          requestId: 'req-same-id',
          expectedRequestEventId: 'evt-2',
        }),
        expect.objectContaining({
          threadId: 'claude-child-b',
          requestId: 'req-same-id',
          expectedRequestEventId: 'evt-4',
        }),
      ]);
    });
  });

  test('a bound card answers from a row that is not the last one', async () => {
    sequence = 0;
    windowEvents.current = [
      ...claudeBashAwaitingApproval(),
      // A later turn puts another row after the card's row.
      runtimeEvent({
        method: 'turn.started',
        turnId: 'turn-2',
        prompt: 'And another thing',
      }),
    ];
    const calls = stubFetch(() => Response.json({ success: true, data: {} }));
    renderCard();

    await screen.findByText('And another thing');
    // Still on its own row: nothing was moved to the strip.
    expect(
      screen.queryByRole('region', { name: 'Approvals waiting on you' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({
      requestId: 'req-claude-b',
      expectedRequestEventId: 'evt-3',
      decision: 'accept',
    });
  });

  test.each([
    [
      'aborted',
      { method: 'turn.aborted', turnId: 'turn-1', reason: 'interrupted' },
    ],
    ['completed', { method: 'turn.completed', turnId: 'turn-1' }],
    ['exited', { method: 'session.exited', exitCode: 0 }],
  ])(
    'an old bound card offers no buttons once its turn %s',
    async (_name, end) => {
      sequence = 0;
      windowEvents.current = [
        ...claudeBashAwaitingApproval(),
        runtimeEvent(end),
        runtimeEvent({
          method: 'turn.started',
          turnId: 'turn-2',
          prompt: 'Later work',
        }),
        runtimeEvent({
          method: 'turn.completed',
          turnId: 'turn-2',
          outputText: 'Done later',
        }),
      ];
      stubFetch(() => Response.json({ success: true, data: {} }));
      renderCard();

      await screen.findByText('Later work');
      expect(screen.queryByRole('button', { name: 'Allow Once' })).toBeNull();
      expect(
        screen.queryByRole('region', { name: 'Approvals waiting on you' }),
      ).toBeNull();
      // It says it never ran, rather than reading as a call with no result.
      expect(screen.getByText('Cancelled')).toBeTruthy();
      expect(screen.queryByText('No result recorded')).toBeNull();
    },
  );

  test('a card whose request was settled as cancelled reads Cancelled', async () => {
    sequence = 0;
    windowEvents.current = [
      ...claudeBashAwaitingApproval(),
      runtimeEvent({
        method: 'request.resolved',
        requestId: 'req-claude-b',
        status: 'cancelled',
      }),
    ];
    stubFetch(() => Response.json({ success: true, data: {} }));
    renderCard();
    expect(await screen.findByText('Cancelled')).toBeTruthy();
    expect(screen.queryByText('No result recorded')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Allow Once' })).toBeNull();
  });

  test('a request on the turn the live streaming shell holds is answerable from the strip', async () => {
    const calls = stubFetch(() => Response.json({ success: true, data: {} }));
    // The shell renders the open turn, so its projected row (with the bound
    // card) is left out of the transcript.
    renderCard(
      chatSession({
        orchestrationTurnOpen: true,
        openTurnId: 'turn-1',
        status: 'sending',
      }),
    );

    const strip = await screen.findByRole('region', {
      name: 'Approvals waiting on you',
    });
    fireEvent.click(within(strip).getByRole('button', { name: 'Allow Once' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({
      threadId: 'claude-child-b',
      requestId: 'req-claude-b',
      expectedRequestEventId: 'evt-3',
    });
  });
});
