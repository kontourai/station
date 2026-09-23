/**
 * @vitest-environment jsdom
 *
 * #2309 Phase B, rendered: what a user sees on a thread from the server's
 * `ConversationTurnActivity` alone.
 *
 * The harness composes the SAME pieces the terminal-tab chat panel does —
 * the real store, `buildTranscriptSession` (the ACP panel's own projection,
 * which has no window seed of its own), the real `ChatMessageList` with the
 * real `StreamingMessage`, the real `ChatInputArea`, and the real
 * `useCancelMessage` behind its Stop button — and feeds it only through the
 * real carrier seams (`applyOrchestrationSnapshot`, `handleOrchestrationEvent`
 * with its stream binding). Only the network is mocked.
 */

import type {
  ConversationTurnActivity,
  OrchestrationConversationStreamBinding,
} from '@kontourai/station-contracts/orchestration';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const interruptOrchestrationTurn = vi.hoisted(() =>
  vi.fn(async (input: { threadId: string }) => ({
    outcome: 'cooperative' as const,
    threadId: input.threadId,
  })),
);
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  interruptOrchestrationTurn,
}));
vi.mock('../contexts/ActiveChatsContext', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../contexts/ActiveChatsContext')>();
  const { activeChatsStore } = await import('../contexts/active-chats-store');
  return {
    ...actual,
    useActiveChatActions: () => ({
      updateChat: (
        id: string,
        updates: Parameters<typeof activeChatsStore.updateChat>[1],
      ) => activeChatsStore.updateChat(id, updates),
    }),
  };
});
vi.mock('../contexts/AgentsContext', () => ({ useAgents: () => [] }));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../contexts/ToastContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contexts/ToastContext')>()),
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../hooks/useToolApproval', () => ({ useToolApproval: () => vi.fn() }));
vi.mock('../components/chat/SessionSummaryCard', () => ({
  SessionSummaryCard: () => null,
}));
vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span aria-hidden="true">U</span>,
}));
vi.mock('../components/conversation-stats/ConversationStats', () => ({
  ContextPercentage: () => null,
}));
vi.mock('../components/chat/FileAttachmentInput', () => ({
  FileAttachmentInput: () => null,
}));
vi.mock('../components/ModelSelector', () => ({
  ModelSelectorAutocomplete: () => null,
}));
vi.mock('../components/chat/SlashCommandSelector', () => ({
  SlashCommandSelector: () => null,
}));
vi.mock('../components/voice/VoiceOrb', () => ({ VoiceOrb: () => null }));

import { buildTranscriptSession } from '../components/acp-connections/ACPChatPanel';
import { ChatInputArea } from '../components/chat/ChatInputArea';
import { ChatMessageList } from '../components/chat/ChatMessageList';
import { isTurnInFlight } from '../contexts/active-chats-state';
import { activeChatsStore } from '../contexts/active-chats-store';
import { handleOrchestrationEvent } from '../hooks/orchestration/eventHandlers';
import { applyOrchestrationSnapshot } from '../hooks/orchestration/snapshotHandlers';
import type { OrchestrationSnapshotPayload } from '../hooks/orchestration/types';
import { useCancelMessage } from '../hooks/useActiveChatSessionMessaging';

const API = 'http://station.test';
// The store is a module singleton that remembers every conversation's newest
// record (by design: a chat opened later starts from it), so each test gets
// a conversation of its own.
let testIndex = 0;
let CONVERSATION = '';
let CHILD = '';
const TURN = 'turn-in-child';
const TURN_STARTED = Date.parse('2026-09-22T18:55:25.000Z');
const minutes = (value: number) => value * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function activity(
  asOfSequence: number,
  extra: Partial<ConversationTurnActivity> = {},
): ConversationTurnActivity {
  return {
    conversationId: CONVERSATION,
    asOfSequence,
    openTurn: { turnId: TURN, threadId: CHILD, startedAt: iso(TURN_STARTED) },
    lastActivityAt: iso(TURN_STARTED),
    ...extra,
  };
}

function snapshot(
  record: ConversationTurnActivity | undefined,
): OrchestrationSnapshotPayload {
  return {
    sessions: [
      {
        provider: 'claude',
        threadId: CONVERSATION,
        status: 'running',
        hasActiveTurn: false,
        ...(record ? { conversationActivity: record } : {}),
      },
      {
        provider: 'claude',
        threadId: CHILD,
        status: 'running',
        hasActiveTurn: record?.openTurn !== undefined,
        ...(record ? { conversationActivity: record } : {}),
      },
    ],
  };
}

function binding(
  record: ConversationTurnActivity,
): OrchestrationConversationStreamBinding {
  return {
    conversationId: CONVERSATION,
    currentSessionId: CHILD,
    activity: record,
  };
}

function Thread() {
  const chat = useSyncExternalStore(
    activeChatsStore.subscribe,
    () => activeChatsStore.getSnapshot()[CONVERSATION],
  );
  const cancel = useCancelMessage(API);
  if (!chat) return null;
  return (
    <>
      <ChatMessageList
        activeSession={buildTranscriptSession(CONVERSATION, 'dev-agent', chat)}
        fontSize={14}
        showReasoning
        showToolDetails
      />
      <ChatInputArea
        sessionId={CONVERSATION}
        input=""
        attachments={[]}
        textareaRef={{ current: null }}
        disabled={false}
        isSending={chat.status === 'sending'}
        turnInFlight={isTurnInFlight(chat)}
        stopPending={!!chat.stopPending}
        modelSupportsAttachments={false}
        fontSize={14}
        dockHeight={600}
        canModelSelect={false}
        availableModels={[]}
        modelQuery={null}
        commandQuery={null}
        slashCommands={[]}
        onInputChange={vi.fn()}
        onSend={vi.fn(async () => {})}
        onCancel={() => void cancel(CONVERSATION)}
        onClearInput={vi.fn()}
        selectAttachmentFiles={vi.fn(async () => {})}
        attachmentError={null}
        onRemoveAttachment={vi.fn()}
        onClearAttachments={vi.fn()}
        onModelSelect={vi.fn()}
        onModelReset={vi.fn()}
        onModelClose={vi.fn()}
        onModelOpen={vi.fn()}
        onModelRuntimeOptionChange={vi.fn()}
        onApprovalModeChange={vi.fn()}
        onCommandSelect={vi.fn(async () => {})}
        onCommandClose={vi.fn()}
        onHistoryUp={vi.fn()}
        onHistoryDown={vi.fn()}
        updateFromInput={vi.fn()}
        closeAll={vi.fn()}
      />
    </>
  );
}

function renderThread() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Thread />
    </QueryClientProvider>,
  );
}

function progressText(): string | null {
  return screen.queryByTestId('turn-activity-progress')?.textContent ?? null;
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      media: '',
      onchange: null,
    })),
  });
});

beforeEach(() => {
  testIndex += 1;
  CONVERSATION = `claude:conv-dock-2309-${testIndex}`;
  CHILD = `${CONVERSATION}:session:child-3`;
  for (const id of Object.keys(activeChatsStore.getSnapshot())) {
    activeChatsStore.removeChat(id);
  }
  sessionStorage.clear();
  interruptOrchestrationTurn.mockClear();
  vi.useFakeTimers({
    toFake: [
      'Date',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
  // A reload four minutes and ten seconds into the turn.
  vi.setSystemTime(TURN_STARTED + minutes(4) + 10_000);
  activeChatsStore.initChat(CONVERSATION, {
    agentSlug: 'dev-agent',
    agentName: 'Dev Agent',
    title: 'Long tool call',
    conversationId: CONVERSATION,
  });
  activeChatsStore.updateChat(CONVERSATION, {
    currentSessionId: CONVERSATION,
    orchestrationSessionStarted: true,
    // The prompt this turn answers, already in the restored transcript.
    messages: [
      {
        role: 'user',
        content: 'run the long job',
        timestamp: TURN_STARTED,
        turnId: TURN,
      },
    ],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('#2309 a reload in the middle of a turn running in a lineage child', () => {
  test('shows the working clock from the server start and Stop at once, and Stop addresses the child turn', async () => {
    renderThread();
    // Premise: before the snapshot nothing claims a turn.
    expect(
      screen.queryByRole('button', { name: 'Stop the current turn' }),
    ).toBeNull();

    act(() => applyOrchestrationSnapshot(snapshot(activity(500))));

    // No new event arrived: the snapshot alone carries the turn.
    expect(screen.getByText(/Working for 4:10/)).toBeTruthy();
    const stop = screen.getByRole('button', { name: 'Stop the current turn' });

    await act(async () => {
      fireEvent.click(stop);
    });

    expect(interruptOrchestrationTurn).toHaveBeenCalledTimes(1);
    expect(interruptOrchestrationTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: CHILD,
      turnId: TURN,
    });
    // The settled receipt closes that turn for this client before its
    // turn.aborted frame arrives, so a second press has nothing to stop.
    expect(
      screen.queryByRole('button', { name: 'Stop the current turn' }),
    ).toBeNull();
  });

  test('the clock keeps the server start as time passes, not this view mount', () => {
    renderThread();
    act(() => applyOrchestrationSnapshot(snapshot(activity(500))));
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText(/Working for 4:15/)).toBeTruthy();
  });
});

describe('#2309 what the turn is doing', () => {
  test('a silent long tool shows its name and elapsed time, then the last tool between tools, and the watchdog silence', () => {
    renderThread();
    const bashStarted = TURN_STARTED + 5_000;
    act(() =>
      applyOrchestrationSnapshot(
        snapshot(
          activity(600, {
            runningTools: [
              {
                name: 'bash',
                callId: 'call-sleep',
                startedAt: iso(bashStarted),
              },
            ],
          }),
        ),
      ),
    );
    // `sleep 290`: no event for minutes, yet the row keeps counting.
    expect(progressText()).toBe('Running bash · 4m 5s');
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(progressText()).toBe('Running bash · 4m 35s');

    // The call completes (the binding on tool.completed): between tools.
    const completedAt = iso(Date.now());
    act(() =>
      handleOrchestrationEvent(
        API,
        {
          eventId: 'evt-bash-done',
          provider: 'claude',
          threadId: CHILD,
          createdAt: completedAt,
          method: 'tool.completed',
          turnId: TURN,
          itemId: 'item-sleep',
          toolCallId: 'call-sleep',
          toolName: 'bash',
          status: 'success',
        },
        undefined,
        binding(
          activity(601, {
            lastTool: {
              name: 'bash',
              callId: 'call-sleep',
              outcome: 'success',
              completedAt,
            },
          }),
        ),
      ),
    );
    expect(progressText()).toBe('Last: bash · done');

    // The watchdog's observation, re-read through the sessions list.
    const silentSince = Date.now() - minutes(12);
    act(() =>
      activeChatsStore.applyConversationActivity(
        activity(601, {
          lastTool: {
            name: 'bash',
            callId: 'call-sleep',
            outcome: 'success',
            completedAt,
          },
          progressSilence: {
            detectedAt: iso(Date.now()),
            windowMs: minutes(10),
            silentSinceEventAt: iso(silentSince),
            provider: 'claude',
          },
        }),
      ),
    );
    expect(progressText()).toBe('Last: bash · done· No output for 12m 0s');
  });

  test('when the turn ends there is no working row and no Stop', () => {
    renderThread();
    act(() => applyOrchestrationSnapshot(snapshot(activity(700))));
    expect(screen.getByText(/Working for/)).toBeTruthy();

    act(() =>
      handleOrchestrationEvent(
        API,
        {
          eventId: 'evt-done',
          provider: 'claude',
          threadId: CHILD,
          createdAt: iso(Date.now()),
          method: 'turn.completed',
          turnId: TURN,
        },
        undefined,
        binding({
          conversationId: CONVERSATION,
          asOfSequence: 701,
          lastActivityAt: iso(Date.now()),
        }),
      ),
    );

    expect(screen.queryByText(/Working for/)).toBeNull();
    expect(progressText()).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Stop the current turn' }),
    ).toBeNull();
  });
});

describe('#2309 an older server that sends no activity', () => {
  test('keeps the legacy fold: the local turn state still shows work and Stop, timed from this view', () => {
    renderThread();
    act(() => applyOrchestrationSnapshot(snapshot(undefined)));
    act(() =>
      activeChatsStore.updateChat(CONVERSATION, {
        status: 'sending',
        orchestrationTurnOpen: true,
      }),
    );
    expect(
      activeChatsStore.getSnapshot()[CONVERSATION]?.conversationActivity,
    ).toBeUndefined();
    expect(screen.getByText(/Working for 0:00/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Stop the current turn' }),
    ).toBeTruthy();
    expect(progressText()).toBeNull();
  });
});
