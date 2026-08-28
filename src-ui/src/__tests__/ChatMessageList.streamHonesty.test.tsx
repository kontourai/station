/**
 * @vitest-environment jsdom
 *
 * archive#3300: a settled turn must not flash back to "Working…" after
 * resume, and its answer must not render twice.
 *
 * The defect is two disagreeing derivations of "is this turn live":
 * - the streaming shell rendered off the SESSION-level flags alone
 *   (`isSessionExecutionActive`: `orchestrationStatus === 'running'` /
 *   `status === 'sending'`), while
 * - the settled-row suppression in `useActiveChatTranscript` reads the TURN
 *   fold (`orchestrationTurnOpen && turnId === openTurnId`).
 *
 * Whenever the flags claim live work but the turn fold says the turn is
 * closed — e.g. a webview reload restoring the persisted
 * `orchestrationStatus: 'running'` for a turn that settled while the app was
 * hidden — BOTH rendered: the settled row (with provenance) and a
 * reconstructed streaming row ("Working…" / a bare copy of the answer).
 * These tests pin the converged gate: for an orchestration-managed session
 * the shell renders from the turn fold plus the optimistic local-send
 * window, never from `orchestrationStatus` alone.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({
    apiBase: 'http://localhost:3242',
  }),
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

vi.mock('../hooks/useToolApproval', () => ({
  useToolApproval: () => vi.fn(),
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

vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span aria-hidden="true">U</span>,
}));

import { ChatMessageList } from '../components/chat/ChatMessageList';
import type { ChatSession } from '../types';

const SETTLED_ANSWER = 'The settled answer for turn-1.';

function managedSession(overrides: Partial<ChatSession>): ChatSession {
  return {
    id: 'stream-honesty-session',
    agentSlug: agentId('dev-agent'),
    agentName: 'Dev Agent',
    title: 'Stream honesty',
    source: 'manual',
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    hasUnread: false,
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    orchestrationSessionStarted: true,
    messages: [
      { role: 'user', content: 'do the thing', timestamp: 1 },
      {
        role: 'assistant',
        content: SETTLED_ANSWER,
        timestamp: 2,
        turnId: 'turn-1',
      },
    ] as ChatSession['messages'],
    ...overrides,
  };
}

function renderList(session: ChatSession) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatMessageList
        activeSession={session}
        fontSize={14}
        showReasoning
        showToolDetails
      />
    </QueryClientProvider>,
  );
}

describe('station#3300 — settled turn stays settled on resume', () => {
  test('REPRO: a stale "running" orchestrationStatus with the turn fold closed must not reconstruct the streaming row under the settled answer', () => {
    // The exact resume shape: `orchestrationStatus: 'running'` is persisted
    // to sessionStorage and restored on a webview reload; the turn fold
    // (`orchestrationTurnOpen`) and `status` are NOT persisted, and the turn
    // itself settled while the app was hidden — the transcript already has
    // its row.
    renderList(
      managedSession({
        orchestrationStatus: 'running',
        orchestrationTurnOpen: false,
        status: 'idle',
      }),
    );

    // The settled answer renders exactly once…
    expect(screen.getAllByText(SETTLED_ANSWER)).toHaveLength(1);
    // …and no live-work row is reconstructed for it (archive#3300: the
    // "Working…" flash and the bare duplicate are both this one element).
    expect(screen.queryByTestId('streaming-message')).toBeNull();
  });

  test('REPRO: the same stale flags with the turn fold ABSENT (a rehydrated chat never saw turn events) must not claim live work either', () => {
    renderList(
      managedSession({
        orchestrationStatus: 'running',
        orchestrationTurnOpen: undefined,
        status: 'idle',
      }),
    );

    expect(screen.queryByTestId('streaming-message')).toBeNull();
  });

  test('an open turn still renders the streaming row', () => {
    renderList(
      managedSession({
        orchestrationStatus: 'running',
        orchestrationTurnOpen: true,
        openTurnId: 'turn-2',
        status: 'sending',
      }),
    );

    expect(screen.getByTestId('streaming-message')).toBeTruthy();
  });

  test('the optimistic local-send window (submit before turn.started) still renders the streaming row', () => {
    renderList(
      managedSession({
        orchestrationStatus: 'idle',
        orchestrationTurnOpen: false,
        status: 'sending',
      }),
    );

    expect(screen.getByTestId('streaming-message')).toBeTruthy();
  });

  test('a mid-turn approval (status idle, turn fold open) keeps the streaming row', () => {
    // #1076: an in-turn approval drops `status` to 'idle' while the turn
    // stays open — the shell must not disappear under the approval prompt.
    renderList(
      managedSession({
        orchestrationStatus: 'awaiting-approval',
        orchestrationTurnOpen: true,
        openTurnId: 'turn-2',
        status: 'idle',
      }),
    );

    expect(screen.getByTestId('streaming-message')).toBeTruthy();
  });

  test('a non-managed session keeps the session-level derivation', () => {
    // Direct-path chats never see turn events; their only liveness signal is
    // the session-level flags, unchanged by archive#3300.
    renderList(
      managedSession({
        orchestrationSessionStarted: false,
        orchestrationStatus: undefined,
        status: 'sending',
      }),
    );

    expect(screen.getByTestId('streaming-message')).toBeTruthy();
  });
});
