/**
 * @vitest-environment jsdom
 *
 * A transcript painted from this client's recent copy, while its re-read is
 * in flight, offers no approval answer anywhere: not on a bound transcript
 * row, not on the live streaming row's tool call, not in the phone's approval
 * sheet. The request may already be answered elsewhere, and a button whose
 * click could only fail ("Your decision was not delivered") is worse than
 * none. Each surface renders through the real `ChatMessageList`; only the
 * bounded window transport and unrelated chrome are stubbed.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
const mobile = vi.hoisted(() => ({ value: false }));
vi.mock('../hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hooks/useIsMobile')>()),
  useIsMobile: () => mobile.value,
}));
const windowEvents = vi.hoisted(() => ({
  current: [] as Array<{ sequence: number; event: unknown }>,
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
    revalidating: false,
    error: undefined,
  }),
}));

import { ChatMessageList } from '../components/chat/ChatMessageList';
import { ActiveChatsProvider } from '../contexts/ActiveChatsContext';
import { activeChatsStore } from '../contexts/active-chats-store';
import { useActiveChatTranscript } from '../hooks/orchestration/useActiveChatTranscript';
import type { ChatSession } from '../types';

const API_BASE = 'http://localhost:3242';
const ALLOW = { name: 'Allow Once' };

function chatSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'held-tab',
    conversationId: 'held-conversation',
    currentSessionId: 'held-child',
    agentSlug: agentId('station'),
    agentName: 'Station',
    title: 'Held approvals',
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
      threadId: 'held-child',
      createdAt: `2026-11-01T00:00:${String(sequence).padStart(2, '0')}.000Z`,
      ...fields,
    },
  };
}

/** A Bash call bound to its request: its transcript row carries the answer. */
function boundRowRequest() {
  return [
    runtimeEvent({ method: 'turn.started', turnId: 'turn-1', prompt: 'ls' }),
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
      requestId: 'req-row',
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

/** A request no row can answer: the strip, or on a phone the sheet. */
function unboundRequest() {
  return [
    runtimeEvent({ method: 'turn.started', turnId: 'turn-1', prompt: 'go' }),
    runtimeEvent({
      method: 'request.opened',
      requestId: 'req-sheet',
      requestType: 'approval',
      title: 'Allow Bash',
      payload: { toolName: 'Bash', toolCallId: 'sub-call', agentId: 'a1' },
    }),
  ];
}

function Harness({ session, held }: { session: ChatSession; held: boolean }) {
  const transcript = useActiveChatTranscript(API_BASE, session);
  return (
    <ChatMessageList
      activeSession={{ ...session, messages: transcript.messages }}
      approvalEvents={transcript.enabled ? transcript.events : undefined}
      approvalEventsSettled={transcript.settled}
      approvalsHeld={held}
      fontSize={13}
      showReasoning={false}
      showToolDetails={false}
    />
  );
}

let queryClient: QueryClient;
function renderList(session: ChatSession, held: boolean) {
  const tree = (isHeld: boolean) => (
    <QueryClientProvider client={queryClient}>
      <ActiveChatsProvider>
        <Harness session={session} held={isHeld} />
      </ActiveChatsProvider>
    </QueryClientProvider>
  );
  const view = render(tree(held));
  return { release: () => view.rerender(tree(false)) };
}

describe('approvals on a cached paint', () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    sequence = 0;
    mobile.value = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ success: true, data: [] })),
    );
  });
  afterEach(async () => {
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    cleanup();
    queryClient.clear();
    vi.unstubAllGlobals();
    activeChatsStore.removeChat('held-tab');
  });

  test('a bound transcript row offers no answer while held, then offers it', async () => {
    windowEvents.current = boundRowRequest();
    const view = renderList(chatSession(), true);
    await screen.findAllByText(/ls plugins/);
    expect(screen.queryByRole('button', ALLOW)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
    view.release();
    expect(await screen.findByRole('button', ALLOW)).toBeTruthy();
  });

  test("the live streaming row's tool call offers no answer while held, then offers it", async () => {
    windowEvents.current = [];
    activeChatsStore.initChat('held-tab', {
      agentSlug: 'station',
      agentName: 'Station',
      title: 'Held approvals',
    });
    activeChatsStore.updateChat('held-tab', {
      orchestrationTurnOpen: true,
      streamingMessage: {
        role: 'assistant',
        content: '',
        contentParts: [
          {
            type: 'tool-invocation',
            toolCallId: 'live-call',
            toolName: 'Bash',
            args: { command: 'rm -r build' },
            state: 'running',
            needsApproval: true,
            approvalId: 'req-live',
            approvalThreadId: 'held-child',
            approvalEventId: 'evt-live',
          },
        ],
      },
    });
    const view = renderList(
      chatSession({ orchestrationTurnOpen: true, status: 'sending' }),
      true,
    );
    await screen.findAllByText(/rm -r build/);
    expect(screen.queryByRole('button', ALLOW)).toBeNull();
    view.release();
    expect(await screen.findByRole('button', ALLOW)).toBeTruthy();
  });

  test("the phone's approval sheet holds a request while held, then offers it", async () => {
    mobile.value = true;
    windowEvents.current = unboundRequest();
    const view = renderList(chatSession(), true);
    await screen.findByText('go');
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', ALLOW)).toBeNull();
    view.release();
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getAllByRole('button', ALLOW).length).toBeGreaterThan(0);
  });
});
