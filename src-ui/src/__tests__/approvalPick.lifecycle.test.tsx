/**
 * @vitest-environment jsdom
 *
 * #2436: the approval pick is a SERVER-ordered session command. The server
 * records it and applies the conversation's latest recorded posture at every
 * session start and turn start (the probe table itself is re-derived and
 * driven through the real routes, executor and orchestration service in
 * `src-server/routes/orchestration/__tests__/approval-posture.lifecycle.test.ts`).
 * What is left for the client, and what this suite drives through the real
 * composer handlers (`useChatInput`), the real send hook (`useSendMessage`,
 * which calls the real `dispatchForeground`), the real queued drain, the
 * real event fold (`handleOrchestrationEvent`), the real persistence
 * (`serializeActiveChats` / `hydrateActiveChats`) and the real
 * `ApprovalModeChip`, fed the way ChatDockBody feeds it:
 *
 * - a pick is sent as a `setApprovalMode` command at once when the chat has a
 *   session, and is otherwise queued and carried by the next send;
 * - no send re-asserts a posture (the #2334 resend bookkeeping is gone);
 * - the posture is folded from the stream by the server's own sequence;
 * - the chip is honest about requested, refused and confirmed.
 *
 * Only the network calls (`sendExecutionMessage`,
 * `setOrchestrationApprovalMode`) are stubbed, so each wire assertion reads
 * the exact payload the server would receive.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
  useAgent: () => null,
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

vi.mock('../contexts/ToastContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contexts/ToastContext')>()),
  useToast: () => ({ showToast: vi.fn() }),
}));

// This Station's `AppConfig`; `defaultApprovalMode` is the layer below a
// session pick (#2144 slice 6).
const stationConfig = vi.hoisted(
  () => ({ current: undefined }) as { current: unknown },
);
vi.mock('../contexts/ConfigContext', () => ({
  useConfig: () => stationConfig.current,
}));

const interruptOrchestrationTurn = vi.hoisted(() => vi.fn());
const setOrchestrationApprovalMode = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  interruptOrchestrationTurn,
  setOrchestrationApprovalMode,
  telemetry: { track: vi.fn() },
  useSkillsQuery: () => ({ data: [] }),
  useProviderCommandsQuery: () => ({ data: [] }),
  useRunSkill: () => ({ mutateAsync: vi.fn() }),
  useSkillDetailReader: () => vi.fn(),
  useEngineConnectionsQuery: () => ({ data: [] }),
  useConfigQuery: () => ({ data: undefined, error: null }),
  useAgentsQuery: () => ({ data: [], error: null }),
  useInvalidateQuery: () => vi.fn(),
}));

vi.mock('../contexts/ActiveChatsContext', async () => {
  const { activeChatsStore } = await import('../contexts/active-chats-store');
  return {
    useActiveChatActions: () => ({
      updateChat: activeChatsStore.updateChat.bind(activeChatsStore),
      clearInput: activeChatsStore.clearInput.bind(activeChatsStore),
      assignConversationId:
        activeChatsStore.assignConversationId.bind(activeChatsStore),
      addEphemeralMessage:
        activeChatsStore.addEphemeralMessage.bind(activeChatsStore),
      clearEphemeralMessages:
        activeChatsStore.clearEphemeralMessages.bind(activeChatsStore),
      addToInputHistory:
        activeChatsStore.addToInputHistory.bind(activeChatsStore),
      navigateHistoryUp:
        activeChatsStore.navigateHistoryUp.bind(activeChatsStore),
      navigateHistoryDown:
        activeChatsStore.navigateHistoryDown.bind(activeChatsStore),
    }),
    useActiveChatSelector: (
      sessionId: string,
      selector: (s: unknown) => unknown,
    ) => selector(activeChatsStore.getSnapshot()[sessionId] || null),
  };
});

vi.mock('../hooks/useStreamingMessage', () => ({
  useStreamingMessage: () => ({ clearStreamingMessage: vi.fn() }),
}));

const sendExecutionMessage = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk/client')>()),
  sendExecutionMessage,
}));

vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => vi.fn(),
  useCancelMessage: () => vi.fn(),
}));

import { ApprovalModeChip } from '../components/badges/ApprovalModeChip';
import {
  hydrateActiveChats,
  serializeActiveChats,
} from '../contexts/active-chats-state';
import { activeChatsStore } from '../contexts/active-chats-store';
import { handleOrchestrationEvent } from '../hooks/orchestration/eventHandlers';
import {
  useCancelMessage,
  useSendMessage,
} from '../hooks/useActiveChatSessionMessaging';
import { useChatInput } from '../hooks/useChatInput';
import { sessionApprovalOverride } from '../utils/approvalMode';
import type { SelectableModel } from '../utils/modelCapabilities';

const SESSION_ID = 'approval-pick-session';
const modelX: SelectableModel = {
  id: 'model-x',
  name: 'X',
  originalId: 'model-x',
};

type OrchestrationEventInput = Parameters<typeof handleOrchestrationEvent>[1];
let clock = 0;
/**
 * The server's global sequence, as the SSE frame id carries it. Never reset:
 * it is per Station and outlives a test.
 */
let streamSeq = 1000;

/**
 * Folds one event as the stream delivers it: at the next server position,
 * unless the test names one (a frame delivered late).
 */
function fold(event: Record<string, unknown>, position = ++streamSeq) {
  clock += 1;
  handleOrchestrationEvent(
    'http://station.test',
    {
      provider: 'codex',
      threadId: SESSION_ID,
      createdAt: new Date(Date.UTC(2026, 8, 23, 0, 0, clock)).toISOString(),
      ...event,
    } as OrchestrationEventInput,
    undefined,
    undefined,
    position,
  );
}

/** A turn.started reporting the posture the engine applied. */
function turnStarted(
  turnId: string,
  applied: string | undefined,
  extra: Record<string, unknown> = {},
) {
  fold({
    method: 'turn.started',
    turnId,
    metadata: {
      ...(applied ? { approvalMode: applied } : {}),
      effectiveModel: 'model-x',
      effectiveModelOptions: {},
      ...extra,
    },
  });
}

function turnCompleted(turnId: string) {
  fold({ method: 'turn.completed', turnId });
}

/** A recorded posture decision, from any device, at a server position. */
function decided(approvalMode: string, position = ++streamSeq) {
  fold(
    {
      method: 'session.approval-mode-set',
      sessionId: SESSION_ID,
      approvalMode,
    },
    position,
  );
  return position;
}

function chat() {
  return activeChatsStore.getSnapshot()[SESSION_ID];
}

type Wire = {
  model?: { override?: string; options?: Record<string, unknown> };
  setApprovalMode?: string;
};

function renderComposer() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const composer = renderHook(
    () =>
      useChatInput({
        apiBase: 'http://station.test',
        sessionId: SESSION_ID,
        agentSlug: 'codex',
        conversationId: 'conv-1',
        availableModels: [modelX],
        agentDefaultModel: 'model-x',
      }),
    { wrapper },
  );
  const sender = renderHook(() => useSendMessage('http://station.test'), {
    wrapper,
  });
  const step = (fn: () => void) => {
    act(fn);
    composer.rerender();
  };
  /** Picks through the real composer handler and lets the command settle. */
  const pick = async (mode: string) => {
    await act(async () => {
      composer.result.current.handleApprovalModeChange(mode as never);
      await Promise.resolve();
    });
    composer.rerender();
  };
  /** Sends a turn through the real hook; returns what went on the wire. */
  const send = async (text = 'go'): Promise<Wire> => {
    sendExecutionMessage.mockClear();
    await act(async () => {
      await sender.result.current(SESSION_ID, 'codex', 'conv-1', text);
    });
    composer.rerender();
    expect(sendExecutionMessage).toHaveBeenCalledTimes(1);
    const body = sendExecutionMessage.mock.calls[0]?.[1] as {
      target: { model?: Wire['model'] };
      setApprovalMode?: string;
    };
    return {
      ...(body.target.model ? { model: body.target.model } : {}),
      ...(body.setApprovalMode
        ? { setApprovalMode: body.setApprovalMode }
        : {}),
    };
  };
  return { composer, step, pick, send, sender };
}

/** The chip as ChatDockBody → ChatInputArea composes it. */
let unmountPill: (() => void) | undefined;
function renderPill() {
  unmountPill?.();
  const current = chat();
  const override = sessionApprovalOverride(current);
  ({ unmount: unmountPill } = render(
    <ApprovalModeChip
      engineConnectionId="codex"
      sessionOverride={override?.mode}
      sessionOverrideState={override?.state}
      lastAppliedApprovalMode={current.lastAppliedApprovalMode}
      onChange={vi.fn()}
    />,
  ));
  const chip = screen.getByRole('button', { name: /^Approval mode:/ });
  return {
    text: chip.querySelector('.chat-input__approval-chip-label')?.textContent,
    name: chip.getAttribute('aria-label') ?? '',
  };
}

/** A reload: serialize to storage and hydrate back into the store. */
function reload(persisted?: (chats: unknown[]) => unknown[]) {
  // Through JSON, as sessionStorage stores it.
  const stored = JSON.parse(
    JSON.stringify(serializeActiveChats(activeChatsStore.getSnapshot())),
  ) as unknown[];
  const rehydrated = hydrateActiveChats(
    (persisted ? persisted(stored) : stored) as Parameters<
      typeof hydrateActiveChats
    >[0],
  )[SESSION_ID];
  activeChatsStore.removeChat(SESSION_ID);
  activeChatsStore.initChat(SESSION_ID, {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Approval pick chat',
  });
  activeChatsStore.updateChat(SESSION_ID, rehydrated!);
  return rehydrated!;
}

/** The chat has a server session to record a decision on. */
function startedSession() {
  activeChatsStore.updateChat(SESSION_ID, {
    orchestrationSessionStarted: true,
    currentSessionId: SESSION_ID,
  });
}

describe('an approval pick as a server-ordered command (#2436)', () => {
  beforeEach(() => {
    clock = 0;
    activeChatsStore.removeChat(SESSION_ID);
    activeChatsStore.initChat(SESSION_ID, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Approval pick chat',
    });
    activeChatsStore.updateChat(SESSION_ID, {
      agentConnectionId: 'codex',
      provider: 'codex',
      executionMode: 'external',
      conversationId: 'conv-1',
    });
    sendExecutionMessage.mockResolvedValue({
      conversationId: 'conv-1',
      sessionId: SESSION_ID,
      providerTurnId: 'provider-turn',
      target: { kind: 'agent', id: 'codex' },
      resolution: {},
    });
    setOrchestrationApprovalMode.mockImplementation(
      async (input: { threadId: string; approvalMode: string }) => ({
        threadId: input.threadId,
        approvalMode: input.approvalMode,
        sequence: ++streamSeq,
      }),
    );
  });

  afterEach(() => {
    unmountPill = undefined;
    cleanup();
    activeChatsStore.removeChat(SESSION_ID);
    stationConfig.current = undefined;
    vi.clearAllMocks();
  });

  test('with a session, a pick is sent as a command at once and folded at its sequence', async () => {
    startedSession();
    const { pick } = renderComposer();
    await pick('ask');

    expect(setOrchestrationApprovalMode).toHaveBeenCalledWith({
      threadId: SESSION_ID,
      approvalMode: 'ask',
      apiBase: 'http://station.test',
    });
    const recorded = await setOrchestrationApprovalMode.mock.results[0]?.value;
    expect(chat().approvalPosture).toBe('ask');
    expect(chat().approvalPostureSequence).toBe(recorded.sequence);
    expect(chat().queuedApprovalMode).toBeUndefined();
  });

  test('probe A: full access reads pending until the engine reports it, then Full access (not Default)', async () => {
    startedSession();
    const { pick, send } = renderComposer();
    await pick('never');
    expect(renderPill().text).toBe('Full access · pending');

    const wire = await send();
    // The server applies the recorded posture; the send carries none.
    expect(wire.setApprovalMode).toBeUndefined();
    expect(wire.model?.options ?? {}).not.toHaveProperty('approvalMode');
    act(() => turnStarted('t1', 'never'));
    expect(renderPill().text).toBe('Full access');
  });

  test('no send re-asserts a posture, confirmed or not (the #2334 resend is gone)', async () => {
    startedSession();
    const { pick, send } = renderComposer();
    await pick('auto');
    act(() => turnStarted('t1', 'auto'));
    act(() => turnCompleted('t1'));
    for (const turnId of ['t2', 't3']) {
      const wire = await send();
      expect(wire.setApprovalMode).toBeUndefined();
      expect(wire.model?.options ?? {}).not.toHaveProperty('approvalMode');
      act(() => turnStarted(turnId, 'auto'));
      act(() => turnCompleted(turnId));
    }
  });

  test('before the chat has a session, a pick is queued and carried by the first send, not in the model options', async () => {
    const { pick, send } = renderComposer();
    await pick('never');
    expect(setOrchestrationApprovalMode).not.toHaveBeenCalled();
    expect(chat().queuedApprovalMode).toBe('never');
    expect(renderPill().text).toBe('Full access · pending');

    const wire = await send();
    expect(wire.setApprovalMode).toBe('never');
    expect(wire.model?.options ?? {}).not.toHaveProperty('approvalMode');
    // Accepted: the server recorded it.
    expect(chat().queuedApprovalMode).toBeUndefined();
    expect(chat().approvalPosture).toBe('never');
    act(() => turnStarted('t1', 'never'));
    act(() => turnCompleted('t1'));
    // And the next send carries nothing.
    expect((await send()).setApprovalMode).toBeUndefined();
  });

  test('offline: a pick whose command fails stays queued and rides the next send', async () => {
    startedSession();
    setOrchestrationApprovalMode.mockRejectedValueOnce(new Error('offline'));
    const { pick, send } = renderComposer();
    await pick('ask');
    expect(chat().queuedApprovalMode).toBe('ask');
    expect(chat().approvalPosture).toBeUndefined();

    expect((await send()).setApprovalMode).toBe('ask');
    expect(chat().queuedApprovalMode).toBeUndefined();
  });

  test('a queued pick survives a reload and rides the next send', async () => {
    const { pick } = renderComposer();
    await pick('auto');
    cleanup();
    expect(reload()).toMatchObject({ queuedApprovalMode: 'auto' });
    const fresh = renderComposer();
    expect((await fresh.send()).setApprovalMode).toBe('auto');
  });

  test('a send that fails keeps the pick queued', async () => {
    const { pick, sender } = renderComposer();
    await pick('ask');
    sendExecutionMessage.mockRejectedValueOnce(new Error('network down'));
    await act(async () => {
      await sender.result
        .current(SESSION_ID, 'codex', 'conv-1', 'go')
        .catch(() => undefined);
    });
    expect(chat().queuedApprovalMode).toBe('ask');
  });

  /**
   * An offline replay the way `useOutboundQueueFlush` sends it: the queued
   * turn's own snapshot (captured at enqueue) as `executionSnapshot`.
   */
  test('an offline replay carries the chat CURRENT queued pick, not one captured with the turn', async () => {
    const { pick, sender } = renderComposer();
    await pick('never');
    const queuedAt = chat();
    const snapshot = {
      requestedModel: queuedAt.requestedModel,
      requestedProviderOptions: queuedAt.requestedProviderOptions,
      model: queuedAt.model,
      providerOptions: queuedAt.providerOptions,
    };
    await pick('ask');
    sendExecutionMessage.mockClear();
    await act(async () => {
      await sender.result.current(
        SESSION_ID,
        'codex',
        'conv-1',
        'queued',
        undefined,
        undefined,
        'queued-turn',
        { executionSnapshot: snapshot },
      );
    });
    const body = sendExecutionMessage.mock.calls[0]?.[1] as {
      setApprovalMode?: string;
    };
    expect(body.setApprovalMode).toBe('ask');
  });

  test('probe D: a queued follow-up drained after the turn carries a pick the server has not received', async () => {
    const { pick, sender } = renderComposer();
    await act(async () => {
      await sender.result.current(SESSION_ID, 'codex', 'conv-1', 'first');
    });
    act(() => turnStarted('t1', undefined));
    // Offline now: the command fails, so the pick stays queued.
    setOrchestrationApprovalMode.mockRejectedValueOnce(new Error('offline'));
    await pick('ask');
    sendExecutionMessage.mockClear();
    await act(async () => {
      await sender.result.current(SESSION_ID, 'codex', 'conv-1', 'follow-up');
    });
    expect(chat().queuedMessages).toEqual(['follow-up']);
    act(() => turnCompleted('t1'));
    await vi.waitFor(() => expect(sendExecutionMessage).toHaveBeenCalled(), {
      timeout: 2000,
    });
    const drained = sendExecutionMessage.mock.calls[0]?.[1] as {
      message: string;
      setApprovalMode?: string;
    };
    expect(drained.message).toBe('follow-up');
    expect(drained.setApprovalMode).toBe('ask');
    await vi.waitFor(() => expect(chat().queuedApprovalMode).toBeUndefined());
  });

  describe('the fold is by server sequence, never by arrival', () => {
    test("another device's decision updates the chip, and the engine report keeps it honest", async () => {
      startedSession();
      const { pick } = renderComposer();
      await pick('never');
      act(() => turnStarted('t1', 'never'));
      expect(renderPill().text).toBe('Full access');
      // The phone tightens.
      act(() => {
        decided('ask');
      });
      expect(chat().approvalPosture).toBe('ask');
      const pill = renderPill();
      expect(pill.text).toBe('Ask · pending');
      expect(pill.name).toMatch(/the engine still reports full access/);
    });

    test('a decision delivered late, from an older position, does not replace a newer one', async () => {
      startedSession();
      const { pick } = renderComposer();
      await pick('ask');
      const current = chat().approvalPostureSequence!;
      act(() => {
        decided('never', current - 1);
      });
      expect(chat().approvalPosture).toBe('ask');
    });

    test('a re-pick of the same posture on another device is visible and ordered', async () => {
      startedSession();
      const { pick } = renderComposer();
      await pick('ask');
      const before = chat().approvalPostureSequence!;
      act(() => {
        decided('never');
      });
      const phoneRepick = decided('ask');
      expect(chat().approvalPosture).toBe('ask');
      expect(chat().approvalPostureSequence).toBe(phoneRepick);
      expect(phoneRepick).toBeGreaterThan(before);
    });

    test("this device's own command result, arriving after its SSE frame, is a no-op", async () => {
      startedSession();
      let resolveCommand: (value: unknown) => void = () => {};
      setOrchestrationApprovalMode.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCommand = resolve;
          }),
      );
      const { pick } = renderComposer();
      await pick('ask');
      const framePosition = decided('ask');
      // Meanwhile the phone decides never; then the command result lands.
      decided('never');
      await act(async () => {
        resolveCommand({
          threadId: SESSION_ID,
          approvalMode: 'ask',
          sequence: framePosition,
        });
        await Promise.resolve();
      });
      expect(chat().approvalPosture).toBe('never');
      expect(chat().queuedApprovalMode).toBeUndefined();
    });
  });

  test('a Default pick is a command too; the chip shows the defaults, and a live session is sent no posture', async () => {
    startedSession();
    act(() =>
      fold({ method: 'session.state-changed', from: 'starting', to: 'idle' }),
    );
    const { pick, send } = renderComposer();
    await pick('never');
    await pick('connection-default');
    expect(setOrchestrationApprovalMode).toHaveBeenLastCalledWith(
      expect.objectContaining({ approvalMode: 'connection-default' }),
    );
    expect(chat().approvalPosture).toBe('connection-default');
    expect(renderPill().text).toBe('Default');
    const wire = await send();
    expect(wire.setApprovalMode).toBeUndefined();
    expect(wire.model?.options ?? {}).not.toHaveProperty('approvalMode');
    // What the engine applied is what the chip names (#2409).
    act(() => turnStarted('t1', 'ask'));
    expect(renderPill().name).toMatch(/^Approval mode: Default — Ask first/);
  });

  test('T3: the Station default is not sent for a new session when a posture is recorded', async () => {
    stationConfig.current = { defaultApprovalMode: 'never' };
    startedSession();
    const { pick, send } = renderComposer();
    await pick('ask');
    act(() => fold({ method: 'session.exited', exitCode: 0 }));
    const wire = await send();
    expect(wire.model?.options ?? {}).not.toHaveProperty('approvalMode');
  });

  test('control: with no pick, a new session is sent the Station default on the default channel', async () => {
    stationConfig.current = { defaultApprovalMode: 'never' };
    const { send } = renderComposer();
    const wire = await send();
    expect(wire.model?.options?.approvalMode).toBe('never');
    expect(wire.setApprovalMode).toBeUndefined();
  });

  test('a refused full access shows it needs a restart, and nothing is resent', async () => {
    startedSession();
    const { pick, send } = renderComposer();
    await pick('never');
    act(() =>
      fold({
        method: 'runtime.warning',
        severity: 'warning',
        message: 'Full-access mode requires restarting the session.',
        code: 'approval-escalation-requires-restart',
        details: {
          requestedApprovalMode: 'never',
          revertToApprovalMode: 'ask',
        },
      }),
    );
    act(() => turnStarted('t1', 'ask', { approvalEscalationRejected: true }));
    act(() => turnCompleted('t1'));
    const pill = renderPill();
    expect(pill.text).toBe('Full access · needs restart');
    expect(pill.name).not.toMatch(/next turn/);
    const wire = await send();
    expect(wire.setApprovalMode).toBeUndefined();
    expect(wire.model?.options ?? {}).not.toHaveProperty('approvalMode');
  });

  test('model controls are untouched by a pick, and a model reset keeps a queued pick', async () => {
    const { composer, step, pick, send } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() =>
      composer.result.current.handleModelRuntimeOptionChange('effort', 'low'),
    );
    await pick('ask');
    expect(chat().requestedProviderOptions).toEqual({ effort: 'low' });
    const wire = await send();
    expect(wire.model?.options).toEqual({ effort: 'low' });
    expect(wire.setApprovalMode).toBe('ask');
  });

  describe('migration of persisted picks (#2436 §5)', () => {
    function persistWith(fields: Record<string, unknown>) {
      renderComposer();
      cleanup();
      return reload((stored) =>
        stored.map((entry) =>
          (entry as { sessionId: string }).sessionId === SESSION_ID
            ? { ...(entry as object), ...fields }
            : entry,
        ),
      );
    }

    test("main's options-bag Ask becomes a queued pick and leaves the bag", async () => {
      const restored = persistWith({
        requestedProviderOptions: { effort: 'low', approvalMode: 'ask' },
      });
      expect(restored.queuedApprovalMode).toBe('ask');
      expect(restored.requestedProviderOptions).toEqual({ effort: 'low' });
      const fresh = renderComposer();
      expect((await fresh.send()).setApprovalMode).toBe('ask');
    });

    test('a confirmed or options-bag full access is dropped, never re-escalated from stale state', () => {
      expect(
        persistWith({ providerOptions: { approvalMode: 'never' } })
          .queuedApprovalMode,
      ).toBeUndefined();
      expect(
        persistWith({ approvalModeOverride: 'never' }).queuedApprovalMode,
      ).toBeUndefined();
    });

    test("the unreleased #2334 branch's unsent pending pick is kept, since it was an explicit request", () => {
      expect(
        persistWith({ pendingApprovalMode: 'never' }).queuedApprovalMode,
      ).toBe('never');
    });
  });

  /** Drives a queued follow-up to its drained dispatch. */
  async function drainFollowUp() {
    const { composer, step, sender } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    await act(async () => {
      await sender.result.current(SESSION_ID, 'codex', 'conv-1', 'first');
    });
    act(() => turnStarted('t1', undefined));
    await act(async () => {
      await sender.result.current(SESSION_ID, 'codex', 'conv-1', 'follow-up');
    });
    sendExecutionMessage.mockClear();
    act(() => turnCompleted('t1'));
    await vi.waitFor(() => expect(sendExecutionMessage).toHaveBeenCalled(), {
      timeout: 2000,
    });
    const [, drained] = sendExecutionMessage.mock.calls[0] ?? [];
    const clientTurnId = (drained as { clientTurnId: string }).clientTurnId;
    return { clientTurnId };
  }

  test("LOW-1: the drained follow-up's turn.started reconciles its optimistic row, not a second copy", async () => {
    const { clientTurnId } = await drainFollowUp();
    expect(chat().pendingClientTurnId).toBe(clientTurnId);
    act(() =>
      fold({
        method: 'turn.started',
        turnId: 't2',
        prompt: 'follow-up',
        metadata: { effectiveModel: 'model-x', effectiveModelOptions: {} },
      }),
    );
    const rows = (chat().messages ?? []).filter(
      (message) => message.role === 'user' && message.content === 'follow-up',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ turnId: 't2' });
    expect(chat().pendingClientTurnId).toBeUndefined();
  });

  test('LOW-1: Stop before the drained follow-up starts binds its cancel to that dispatch', async () => {
    const { clientTurnId } = await drainFollowUp();
    interruptOrchestrationTurn.mockResolvedValue({
      outcome: 'pending-turn-start',
      threadId: SESSION_ID,
    });
    const cancel = renderHook(() => useCancelMessage('http://station.test'));
    await act(async () => {
      await cancel.result.current(SESSION_ID);
    });
    expect(interruptOrchestrationTurn).toHaveBeenCalledWith(
      expect.objectContaining({ clientTurnId }),
    );
  });
});
