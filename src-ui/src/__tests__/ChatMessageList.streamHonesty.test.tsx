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
  StreamingMessage: (props: {
    statusLabel?: string;
    turnStartedAt?: number;
  }) => (
    <div
      data-testid="streaming-message"
      data-status-label={props.statusLabel ?? ''}
      data-turn-started-at={props.turnStartedAt ?? ''}
    >
      Streaming
    </div>
  ),
}));

vi.mock('../components/chat/SessionSummaryCard', () => ({
  SessionSummaryCard: () => null,
}));

vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span aria-hidden="true">U</span>,
}));

import { ChatMessageList } from '../components/chat/ChatMessageList';
import { backgroundTasksStore } from '../contexts/background-tasks-store';
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

function renderList(
  session: ChatSession,
  suppressStreamingRow = false,
  liveStatusUnavailable = false,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatMessageList
        activeSession={session}
        suppressStreamingRow={suppressStreamingRow}
        liveStatusUnavailable={liveStatusUnavailable}
        fontSize={14}
        showReasoning
        showToolDetails
      />
    </QueryClientProvider>,
  );
}

describe('station#3300 — settled turn stays settled on resume', () => {
  test('a reconnect snapshot with server child work keeps the background banner without a local task list', () => {
    renderList(
      managedSession({
        backgroundTasks: [],
        conversationActivity: {
          conversationId: 'stream-honesty-session',
          asOfSequence: 7,
          runningChildWork: { count: 1, producers: ['engine-subagent'] },
        },
      }),
    );
    expect(screen.getByText('Background task running')).toBeTruthy();
    expect(screen.queryByTestId('streaming-message')).toBeNull();
  });
  test('when the conversation cannot be observed, server child work is a last-known line, not a live one', () => {
    renderList(
      managedSession({
        backgroundTasks: [],
        conversationActivity: {
          conversationId: 'stream-honesty-session',
          asOfSequence: 7,
          runningChildWork: { count: 1, producers: ['engine-subagent'] },
        },
      }),
      false,
      true,
    );
    const banner = screen.getByText(
      'Last known: background task running (status unavailable)',
    ).parentElement as HTMLElement;
    expect(banner.className).toBe('background-tasks-banner');
    expect(screen.queryByText('Background task running')).toBeNull();
    // No animated dots claiming the work is happening now.
    expect(banner.querySelector('.loading-dots-inline')).toBeNull();
  });
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

  test('a projected open turn hides the separate streaming row', () => {
    renderList(
      managedSession({
        orchestrationStatus: 'running',
        orchestrationTurnOpen: true,
        openTurnId: 'turn-2',
        status: 'sending',
      }),
      true,
    );
    expect(screen.queryByTestId('streaming-message')).toBeNull();
  });

  test('#2654: a projected open turn with running child work does not show the turn-over background banner', () => {
    const openTurnWithChildWork = managedSession({
      orchestrationStatus: 'running',
      orchestrationTurnOpen: true,
      openTurnId: 'turn-2',
      status: 'sending',
      backgroundTasks: [],
      conversationActivity: {
        conversationId: 'stream-honesty-session',
        asOfSequence: 9,
        openTurn: {
          turnId: 'turn-2',
          threadId: 'stream-honesty-session',
          startedAt: '2026-09-25T12:00:00.000Z',
        },
        runningChildWork: { count: 1, producers: ['engine-subagent'] },
      },
    });
    renderList(openTurnWithChildWork, true);
    // The live turn renders from the transcript window, not the streaming
    // row — and it is still live, so the banner that means "the turn ended
    // while work continues" must not claim otherwise.
    expect(screen.queryByTestId('streaming-message')).toBeNull();
    expect(screen.queryByText('Background task running')).toBeNull();
  });

  test('#2654: local background tasks during a projected open turn also wait for the turn to end', () => {
    const localTaskMidTurn = managedSession({
      orchestrationStatus: 'running',
      orchestrationTurnOpen: true,
      openTurnId: 'turn-2',
      status: 'sending',
      backgroundTasks: [
        { taskId: 'task-1', backgrounded: true, description: 'index repo' },
      ],
    });
    renderList(localTaskMidTurn, true);
    expect(screen.queryByTestId('streaming-message')).toBeNull();
    expect(
      screen.queryByText('Background agent working — index repo'),
    ).toBeNull();
  });

  test('#2654: once the turn settles, local background tasks show the banner', () => {
    renderList(
      managedSession({
        orchestrationStatus: 'idle',
        orchestrationTurnOpen: false,
        status: 'idle',
        backgroundTasks: [
          { taskId: 'task-1', backgrounded: true, description: 'index repo' },
        ],
      }),
      true,
    );
    expect(
      screen.getByText('Background agent working — index repo'),
    ).toBeTruthy();
  });

  test('a background shell command is named as a command, not an agent', () => {
    renderList(
      managedSession({
        orchestrationStatus: 'idle',
        orchestrationTurnOpen: false,
        status: 'idle',
        backgroundTasks: [
          {
            taskId: 'bash-1',
            backgrounded: true,
            description: 'Watch until merged',
            workKind: 'command',
          },
        ],
      }),
      true,
    );
    expect(
      screen.getByText('Background command running — Watch until merged'),
    ).toBeTruthy();
    expect(screen.queryByText(/Background agent/)).toBeNull();
  });

  test('each running call shows once: in its batch, counted "above" by the strip, which lists only the rest', () => {
    backgroundTasksStore.reset();
    const tools = [
      ['tool-a', 'Run gate:for on paths to edit'],
      ['tool-b', 'Run telemetry tests after change'],
    ] as const;
    for (const [id, description] of tools)
      backgroundTasksStore.ingest(
        {
          provider: 'claude',
          threadId: 'stream-honesty-session',
          createdAt: '2026-11-16T10:00:00.000Z',
          method: 'tool.started',
          toolCallId: id,
          toolName: 'Bash',
          arguments: { command: 'npm run gate:for', description },
        } as never,
        'http://localhost:3242',
      );
    try {
      renderList(
        managedSession({
          orchestrationStatus: 'idle',
          orchestrationTurnOpen: false,
          status: 'idle',
          messages: [
            { role: 'user', content: 'do the thing', timestamp: 1 },
            {
              role: 'assistant',
              content: SETTLED_ANSWER,
              timestamp: 2,
              turnId: 'turn-1',
              // The settled turn's calls, as the durable projection gives
              // them: started, no outcome.
              contentParts: tools.map(([id, description]) => ({
                type: 'tool-invocation',
                toolCallId: id,
                toolName: 'Bash',
                args: { command: 'npm run gate:for', description },
                state: 'call',
              })),
            },
          ] as ChatSession['messages'],
          backgroundTasks: [
            { taskId: 'a-1', backgrounded: true, description: 'Inventory' },
            { taskId: 'a-2', backgrounded: true, description: 'Review' },
            { taskId: 'a-3', backgrounded: true, description: 'Audit' },
          ],
        }),
        true,
      );
      // The transcript's own rows say the calls are running, from the same
      // live record the strip reads; none reads "No result recorded".
      expect(screen.queryByText(/no result/i)).toBeNull();
      for (const [, description] of tools)
        expect(
          screen.getByRole('button', { name: new RegExp(description) }),
        ).toBeTruthy();
      // The strip counts them as shown above and lists only the agents the
      // transcript does not show.
      expect(screen.getByText('2 tools above · 3 agents running')).toBeTruthy();
      const strip = document.querySelector(
        '.background-tasks-strip',
      ) as HTMLElement;
      const rows = strip.querySelectorAll('.background-tasks-banner__task');
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        // The glyph names the kind; the row repeats no "Agent ·" word.
        expect(
          row.querySelector('.background-tasks-banner__task-glyph svg'),
        ).toBeTruthy();
        expect(
          row.querySelector('[role="img"]')?.getAttribute('aria-label'),
        ).toBe('Agent');
        expect(
          row.querySelector('.background-tasks-sheet__meta')?.textContent,
        ).not.toMatch(/Agent|Tool/);
      }
      for (const [, description] of tools)
        expect(strip.textContent).not.toContain(description);
    } finally {
      backgroundTasksStore.reset();
    }
  });

  test("#2304: the streaming row counts from the open turn's server start", () => {
    const serverStart = Date.parse('2026-09-22T12:00:00.000Z');
    renderList(
      managedSession({
        orchestrationStatus: 'running',
        orchestrationTurnOpen: true,
        openTurnId: 'turn-2',
        openTurnStartedAt: serverStart,
        status: 'sending',
      }),
    );

    expect(
      screen
        .getByTestId('streaming-message')
        .getAttribute('data-turn-started-at'),
    ).toBe(String(serverStart));
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

  test('station#2235: awaiting-approval WITH a pending grant names the approval', () => {
    // The label asserts an approval only when a grant is actually pending —
    // a crashed turn's needs_input folds to this status with no request
    // behind it, and must not read as a decision.
    renderList(
      managedSession({
        orchestrationStatus: 'awaiting-approval',
        orchestrationTurnOpen: true,
        openTurnId: 'turn-2',
        status: 'idle',
        pendingApprovals: ['req-1'],
      }),
    );

    expect(
      screen.getByTestId('streaming-message').getAttribute('data-status-label'),
    ).toBe('Waiting for approval');
  });

  test('station#2235: awaiting-approval with NO pending grant waits on the user, not on an approval', () => {
    renderList(
      managedSession({
        orchestrationStatus: 'awaiting-approval',
        orchestrationTurnOpen: true,
        openTurnId: 'turn-2',
        status: 'idle',
        pendingApprovals: [],
      }),
    );

    const label = screen
      .getByTestId('streaming-message')
      .getAttribute('data-status-label');
    expect(label).toBe('Waiting on you');
    expect(label).not.toContain('approval');
  });

  test('awaiting-approval whose every request the user already answered is not "waiting for approval"', () => {
    // Answered from the approval queue, still open on the server until
    // `request.resolved`: the engine is deciding, not the user. The status
    // pill already says so; this line must agree with it.
    renderList(
      managedSession({
        orchestrationStatus: 'awaiting-approval',
        orchestrationTurnOpen: true,
        openTurnId: 'turn-2',
        status: 'idle',
        pendingApprovals: ['req-1'],
        answeredApprovals: ['req-1'],
      }),
    );

    expect(
      screen.getByTestId('streaming-message').getAttribute('data-status-label'),
    ).toBe('');
  });

  test('an answered request no longer holds the typing dots back, an unanswered one does', () => {
    const settledTail = {
      isThinking: true,
      pendingApprovals: ['req-1'],
      status: 'idle' as const,
    };
    const answered = renderList(
      managedSession({ ...settledTail, answeredApprovals: ['req-1'] }),
    );
    expect(
      answered.container.querySelector('.message__thinking'),
    ).not.toBeNull();
    expect(
      answered.container.querySelector('.message__pending-approval'),
    ).toBeNull();
    answered.unmount();

    const waiting = renderList(managedSession({ ...settledTail }));
    expect(waiting.container.querySelector('.message__thinking')).toBeNull();
    expect(
      waiting.container.querySelector('.message__pending-approval'),
    ).not.toBeNull();
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
