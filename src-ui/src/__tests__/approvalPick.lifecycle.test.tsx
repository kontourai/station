/**
 * @vitest-environment jsdom
 *
 * #2334: an approval pick lives in its own field, beside (never inside) the
 * model-options request bag. Every sequence here drives the real composer
 * handlers (`useChatInput`), the real orchestration event fold
 * (`handleOrchestrationEvent`), the real send hook (`useSendMessage`, which
 * calls the real `dispatchForeground`), and the real `ApprovalModeChip` fed
 * the way ChatDockBody feeds it (`sessionApprovalOverride(activeSession)`).
 * Only the network call (`sendExecutionMessage`) is stubbed, so each
 * assertion on the wire reads the exact payload the server would receive.
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

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
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
import { useSendMessage } from '../hooks/useActiveChatSessionMessaging';
import { useChatInput } from '../hooks/useChatInput';
import { sessionApprovalOverride } from '../utils/approvalMode';
import { chatSessionIsLive } from '../utils/execution';
import type { SelectableModel } from '../utils/modelCapabilities';

const SESSION_ID = 'approval-pick-session';
const modelX: SelectableModel = {
  id: 'model-x',
  name: 'X',
  originalId: 'model-x',
};
const modelY: SelectableModel = {
  id: 'model-y',
  name: 'Y',
  originalId: 'model-y',
};

type OrchestrationEventInput = Parameters<typeof handleOrchestrationEvent>[1];
let clock = 0;
/**
 * The server's stream sequence, as the SSE frame id carries it. Never reset:
 * the client's latest-seen position is per Station and outlives a test.
 */
let streamSeq = 1000;

/**
 * Folds one event as the stream delivers it: with the next server position,
 * unless the test names one (a report delivered out of order).
 */
function fold(event: Record<string, unknown>, position = ++streamSeq) {
  clock += 1;
  handleOrchestrationEvent(
    'http://station.test',
    {
      provider: 'codex',
      threadId: SESSION_ID,
      createdAt: new Date(Date.UTC(2026, 8, 22, 0, 0, clock)).toISOString(),
      ...event,
    } as OrchestrationEventInput,
    undefined,
    undefined,
    position,
  );
}

/**
 * A turn.started reporting the model and the approval posture applied
 * (`undefined`: the engine reported no posture).
 */
function turnStarted(
  turnId: string,
  applied: string | undefined,
  effectiveModelOptions: Record<string, unknown> = {},
  effectiveModel = 'model-x',
  position?: number,
) {
  fold(
    {
      method: 'turn.started',
      turnId,
      metadata: {
        ...(applied ? { approvalMode: applied } : {}),
        effectiveModel,
        effectiveModelOptions,
      },
    },
    position,
  );
}

/** Another device's turn on the same session, reporting its posture. */
function otherDeviceTurn(turnId: string, applied: string) {
  turnStarted(turnId, applied);
  turnCompleted(turnId);
}

function turnCompleted(turnId: string) {
  fold({ method: 'turn.completed', turnId });
}

function chat() {
  return activeChatsStore.getSnapshot()[SESSION_ID];
}

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
        availableModels: [modelX, modelY],
        agentDefaultModel: 'model-x',
      }),
    { wrapper },
  );
  const sender = renderHook(() => useSendMessage('http://station.test'), {
    wrapper,
  });
  // The mocked selector reads the store at render time and does not
  // subscribe, so re-render after every store write: each handler must see
  // the chat state the user would see at that moment.
  const step = (fn: () => void) => {
    act(fn);
    composer.rerender();
  };
  /** Sends a turn through the real hook; returns `target.model` on the wire. */
  const send = async (text = 'go') => {
    sendExecutionMessage.mockClear();
    await act(async () => {
      await sender.result.current(SESSION_ID, 'codex', 'conv-1', text);
    });
    composer.rerender();
    expect(sendExecutionMessage).toHaveBeenCalledTimes(1);
    const target = sendExecutionMessage.mock.calls[0]?.[1].target as {
      model?: { override?: string; options?: Record<string, unknown> };
    };
    return target.model;
  };
  return { composer, step, send, sender };
}

/** The chip as ChatDockBody → ChatInputArea composes it. */
let unmountPill: (() => void) | undefined;
function renderPill() {
  // Only the previous pill: `cleanup()` would also unmount the hooks.
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

describe('an approval pick beside the model options (#2334)', () => {
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
  });

  afterEach(() => {
    unmountPill = undefined;
    cleanup();
    activeChatsStore.removeChat(SESSION_ID);
    vi.clearAllMocks();
  });

  test('probe A, the reported symptom: a confirmed Never ask reads Full access, not Default', async () => {
    const { composer, step, send } = renderComposer();
    // Model X is picked first so the turn.started below ACKNOWLEDGES the
    // request and clears the request bag: the step that used to discard the
    // approval pick along with it.
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() => composer.result.current.handleApprovalModeChange('never'));
    expect((await send())?.options?.approvalMode).toBe('never');
    step(() => turnStarted('t1', 'never'));

    expect(chat().requestedProviderOptions).toBeUndefined();
    expect(chat().pendingApprovalMode).toBeUndefined();
    expect(chat().approvalModeOverride).toBe('never');
    expect(renderPill().text).toBe('Full access');
  });

  test('a confirmed pick is NOT resent to a live session', async () => {
    const { composer, step, send } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() => composer.result.current.handleApprovalModeChange('auto'));
    expect((await send())?.options?.approvalMode).toBe('auto');
    step(() => turnStarted('t1', 'auto'));
    step(() => turnCompleted('t1'));
    expect(chat().approvalModeOverride).toBe('auto');
    expect(chatSessionIsLive(chat())).toBe(true);

    // The engine holds its own posture; re-asserting it could override a
    // newer decision made elsewhere.
    expect((await send())?.options ?? {}).not.toHaveProperty('approvalMode');
    expect(renderPill().text).toBe('Auto');
  });

  test('probe B: a report of the dispatch already in flight when the user picked is stale, and keeps the pick', async () => {
    const { composer, step, send } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() => composer.result.current.handleApprovalModeChange('never'));
    await send();
    // Turn 1 is in flight (no turn.started yet) when the user tightens.
    expect(chat().pendingClientTurnId).toBeDefined();
    step(() => composer.result.current.handleApprovalModeChange('ask'));
    // Turn 1's report arrives AFTER the pick on the stream, but describes
    // the send made before it.
    step(() => turnStarted('t1', 'never'));

    expect(chat().pendingApprovalMode).toBe('ask');
    expect(chat().approvalModeOverride).toBeUndefined();
    const pending = renderPill();
    expect(pending.text).toBe('Ask · pending');
    expect(pending.name).toMatch(/the engine still reports full access/);

    step(() => turnCompleted('t1'));
    expect((await send())?.options?.approvalMode).toBe('ask');
    step(() => turnStarted('t2', 'ask'));
    expect(chat().pendingApprovalMode).toBeUndefined();
    expect(chat().approvalModeOverride).toBe('ask');
    expect(renderPill().text).toBe('Ask');
  });

  test('a report from an older stream position than the pick is stale, and keeps the pick', async () => {
    const { composer, step } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    otherDeviceTurn('t0', 'auto');
    const seenAtPick = streamSeq;
    step(() => composer.result.current.handleApprovalModeChange('never'));
    expect(chat().pendingApprovalPickedAt).toBe(seenAtPick);
    // Delivered late (e.g. held by the delivery buffer), from before the pick.
    step(() => turnStarted('t-old', 'ask', {}, 'model-x', seenAtPick - 1));
    expect(chat().pendingApprovalMode).toBe('never');
  });

  test('probe G: a newer differing report retires a pending pick (the phone decided later)', async () => {
    const { composer, step, send } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    // The desktop picks full access but does not send.
    step(() => composer.result.current.handleApprovalModeChange('never'));
    // The phone then applies Ask on the same session.
    step(() => otherDeviceTurn('phone-1', 'ask'));

    expect(chat().pendingApprovalMode).toBeUndefined();
    expect(chat().approvalModeOverride).toBeUndefined();
    // The desktop's next send does not override the newer decision.
    expect((await send())?.options ?? {}).not.toHaveProperty('approvalMode');
  });

  test('a newer differing report retires a pending pick in the other direction too', async () => {
    const { composer, step, send } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() => composer.result.current.handleApprovalModeChange('ask'));
    step(() => otherDeviceTurn('phone-1', 'never'));

    expect(chat().pendingApprovalMode).toBeUndefined();
    // Latest wins: the phone's later full access is not reverted from here.
    expect((await send())?.options ?? {}).not.toHaveProperty('approvalMode');
    expect(renderPill().text).toBe('Default');
  });

  test("probe I: another device's turn that CHANGES nothing does not retire a pending pick", async () => {
    const { composer, step, send } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() => composer.result.current.handleApprovalModeChange('never'));
    await send();
    step(() => turnStarted('t1', 'never'));
    step(() => turnCompleted('t1'));
    // The desktop tightens but does not send yet.
    step(() => composer.result.current.handleApprovalModeChange('ask'));
    // The phone sends an ordinary message: its turn reports the posture the
    // session already had. A report says what applied, not that anyone
    // decided anything, so this is not a later decision.
    step(() => otherDeviceTurn('phone-1', 'never'));

    expect(chat().pendingApprovalMode).toBe('ask');
    expect((await send())?.options?.approvalMode).toBe('ask');
  });

  test('probe I across a reload: the posture known at the pick survives with the pending pick', () => {
    const { composer, step } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() => otherDeviceTurn('t0', 'never'));
    step(() => composer.result.current.handleApprovalModeChange('ask'));
    composer.unmount();

    expect(reload()).toMatchObject({
      pendingApprovalMode: 'ask',
      pendingApprovalAppliedAtPick: 'never',
    });
    // An ordinary turn elsewhere, same posture: still not a decision.
    otherDeviceTurn('phone-1', 'never');
    expect(chat().pendingApprovalMode).toBe('ask');
    // A change of posture elsewhere is.
    otherDeviceTurn('phone-2', 'auto');
    expect(chat().pendingApprovalMode).toBeUndefined();
  });

  test('probe E: a revoke on another device retires the confirmed pick; nothing re-escalates', async () => {
    const { composer, step, send } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() => composer.result.current.handleApprovalModeChange('never'));
    await send();
    step(() => turnStarted('t1', 'never'));
    step(() => turnCompleted('t1'));
    expect(chat().approvalModeOverride).toBe('never');

    step(() => otherDeviceTurn('phone-1', 'ask'));
    expect(chat().approvalModeOverride).toBeUndefined();
    expect(chat().pendingApprovalMode).toBeUndefined();
    expect((await send())?.options ?? {}).not.toHaveProperty('approvalMode');
    expect(reload()).not.toHaveProperty('approvalModeOverride');
    expect(renderPill().text).toBe('Default');
  });

  test('probe E2: confirmed never, reload, then the phone applies Ask: the desktop does not resend never', async () => {
    const { composer, step, send } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() => composer.result.current.handleApprovalModeChange('never'));
    await send();
    step(() => turnStarted('t1', 'never'));
    step(() => turnCompleted('t1'));
    composer.unmount();

    // Persisted as confirmed, not as a pending request.
    expect(reload()).toMatchObject({ approvalModeOverride: 'never' });
    expect(chat().pendingApprovalMode).toBeUndefined();
    markSessionLive();
    const fresh = renderComposer();
    fresh.step(() => otherDeviceTurn('phone-1', 'ask'));
    expect(chat().approvalModeOverride).toBeUndefined();
    expect((await fresh.send())?.options ?? {}).not.toHaveProperty(
      'approvalMode',
    );
  });

  test('probe E3: after a reload with no report yet, a live session is not sent the confirmed pick', async () => {
    const { composer, step, send } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() => composer.result.current.handleApprovalModeChange('never'));
    await send();
    step(() => turnStarted('t1', 'never'));
    step(() => turnCompleted('t1'));
    composer.unmount();

    reload();
    // The phone tightened while this tab was closed; this client never saw
    // that report. The reconnect snapshot says the session is live.
    markSessionLive();
    const fresh = renderComposer();
    fresh.step(() => {});
    expect((await fresh.send())?.options ?? {}).not.toHaveProperty(
      'approvalMode',
    );
    // The chip says the pick is not confirmed for this session, visibly: the
    // engine may be anywhere, including stricter or looser.
    const pill = renderPill();
    expect(pill.text).toBe('Full access · unconfirmed');
    expect(pill.name).toMatch(/not confirmed for this session/);
  });

  test('a confirmed pick IS applied when a new session starts after a reload (Station default never)', async () => {
    // The old session ended; the reloaded chat's next send starts a new one.
    stationConfig.current = { defaultApprovalMode: 'never' };
    try {
      const { composer, step, send } = renderComposer();
      step(() => composer.result.current.handleModelSelect(modelX));
      step(() => composer.result.current.handleApprovalModeChange('ask'));
      await send();
      step(() => turnStarted('t1', 'ask'));
      step(() => turnCompleted('t1'));
      step(() => fold({ method: 'session.exited', exitCode: 0 }));
      composer.unmount();

      reload();
      expect(chatSessionIsLive(chat())).toBe(false);
      const fresh = renderComposer();
      fresh.step(() => {});
      const pill = renderPill();
      expect(pill.text).toBe('Ask · unconfirmed');
      expect(pill.name).toMatch(
        /^Approval mode: Ask · unconfirmed — not confirmed for this session\./,
      );
      expect((await fresh.send())?.options?.approvalMode).toBe('ask');
    } finally {
      stationConfig.current = undefined;
    }
  });

  test('control: with no pick, that fresh session starts at the Station default', async () => {
    stationConfig.current = { defaultApprovalMode: 'never' };
    try {
      const { send } = renderComposer();
      expect((await send())?.options?.approvalMode).toBe('never');
    } finally {
      stationConfig.current = undefined;
    }
  });

  test('a pending pick survives a reload with its stream position, and a later report still retires it', () => {
    const { composer, step } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() => composer.result.current.handleApprovalModeChange('never'));
    const pickedAt = chat().pendingApprovalPickedAt;
    expect(pickedAt).toBeDefined();
    composer.unmount();

    expect(reload()).toMatchObject({
      pendingApprovalMode: 'never',
      pendingApprovalPickedAt: pickedAt,
    });
    otherDeviceTurn('phone-1', 'ask');
    expect(chat().pendingApprovalMode).toBeUndefined();
  });

  test('probe H: a genuine Default pick clears the pick; neither a live nor a new session is sent one', async () => {
    const { composer, step, send } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() => composer.result.current.handleApprovalModeChange('auto'));
    await send();
    step(() => turnStarted('t1', 'auto'));
    step(() => turnCompleted('t1'));
    step(() =>
      composer.result.current.handleApprovalModeChange('connection-default'),
    );
    expect(chat().approvalModeOverride).toBeUndefined();
    expect(chat().pendingApprovalMode).toBeUndefined();
    // Live session: no posture sent. On Claude that leaves the engine where
    // it is (#2409); this pins only that no pick is asserted.
    expect((await send())?.options ?? {}).not.toHaveProperty('approvalMode');
    composer.unmount();

    reload();
    const fresh = renderComposer();
    expect((await fresh.send())?.options ?? {}).not.toHaveProperty(
      'approvalMode',
    );
  });

  test('probe C: revoke, then switch model: full access is not resent', async () => {
    const { composer, step, send } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() => composer.result.current.handleApprovalModeChange('never'));
    await send();
    step(() => turnStarted('t1', 'never'));
    step(() => turnCompleted('t1'));
    expect(renderPill().text).toBe('Full access');

    // Revoke: Default clears the override at once.
    step(() =>
      composer.result.current.handleApprovalModeChange('connection-default'),
    );
    expect(chat().pendingApprovalMode).toBeUndefined();
    expect(chat().approvalModeOverride).toBeUndefined();

    // A model switch rebuilds the request from the confirmed bag, which
    // never held the pick, so nothing can resurrect it.
    //
    // Sending no posture is not the same as leaving bypass: on Claude a
    // session already at full access KEEPS it when no approval mode arrives,
    // so this Default pick changes nothing there while the chat reports that
    // it did. Pre-existing and tracked as #2409; this test pins only that
    // the revoked 'never' is not resent.
    step(() => composer.result.current.handleModelSelect(modelY));
    const wire = await send();
    expect(wire?.override).toBe('model-y');
    expect(wire?.options?.approvalMode).toBeUndefined();
    // The pill names the engine's receipt as a default, not an override.
    const pill = renderPill();
    expect(pill.text).toBe('Default');
    expect(pill.name).toMatch(/^Approval mode: Default — /);
  });

  test('a Default pick of a pending pick settles immediately and sends no posture', async () => {
    const { composer, step, send } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() => composer.result.current.handleApprovalModeChange('auto'));
    expect(chat().pendingApprovalMode).toBe('auto');
    step(() =>
      composer.result.current.handleApprovalModeChange('connection-default'),
    );
    expect(chat().pendingApprovalMode).toBeUndefined();
    expect(chat().approvalModeOverride).toBeUndefined();
    const wire = await send();
    expect(wire?.override).toBe('model-x');
    expect(wire?.options ?? {}).not.toHaveProperty('approvalMode');
    expect(renderPill().text).toBe('Default');
  });

  test('model controls survive a pending pick', async () => {
    const { composer, step, send } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() =>
      composer.result.current.handleModelRuntimeOptionChange('effort', 'high'),
    );
    step(() => composer.result.current.handleApprovalModeChange('never'));

    // The pick travels beside the model controls, not in place of them.
    expect(chat().requestedProviderOptions).toEqual({ effort: 'high' });
    expect((await send())?.options).toEqual({
      effort: 'high',
      approvalMode: 'never',
    });

    // The report acknowledges the model and its controls, and reports no
    // posture, so the pick is still pending.
    step(() => turnStarted('t1', undefined, { effort: 'high' }));
    step(() => turnCompleted('t1'));
    expect(chat().requestedProviderOptions).toBeUndefined();
    expect(chat().providerOptions).toEqual({ effort: 'high' });
    expect(chat().pendingApprovalMode).toBe('never');
    expect((await send())?.options).toEqual({
      effort: 'high',
      approvalMode: 'never',
    });
  });

  test('a model reset keeps a pending pick and still sends it', async () => {
    const { composer, step, send } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() => composer.result.current.handleApprovalModeChange('ask'));
    step(() => composer.result.current.handleModelReset());

    expect(chat().requestedModel).toBeNull();
    expect(chat().requestedProviderOptions).toBeUndefined();
    expect(chat().pendingApprovalMode).toBe('ask');
    expect(renderPill().text).toBe('Ask');
    const wire = await send();
    expect(wire?.override).toBeUndefined();
    expect(wire?.options).toEqual({ approvalMode: 'ask' });
  });

  test('an escalation refusal settles the refused pick and stops resending it', async () => {
    const { composer, step, send } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    await send();
    step(() => turnStarted('t1', 'ask'));
    step(() => turnCompleted('t1'));
    step(() => composer.result.current.handleApprovalModeChange('never'));
    expect((await send())?.options?.approvalMode).toBe('never');

    step(() =>
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
    step(() => turnStarted('t2', 'ask'));
    step(() => turnCompleted('t2'));

    expect(chat().pendingApprovalMode).toBeUndefined();
    expect(chat().providerOptions?.approvalMode).toBeUndefined();
    expect(renderPill().text).toBe('Default');
    expect((await send())?.options ?? {}).not.toHaveProperty('approvalMode');
  });

  /**
   * An offline replay the way `useOutboundQueueFlush` sends it: the queued
   * turn's own snapshot (captured at enqueue) as `executionSnapshot`.
   */
  async function replay(
    sender: { current: ReturnType<typeof useSendMessage> },
    snapshot: {
      requestedModel?: string | null;
      requestedProviderOptions?: Record<string, unknown>;
      model?: string;
      providerOptions?: Record<string, unknown>;
    },
  ) {
    sendExecutionMessage.mockClear();
    await act(async () => {
      await sender.current(
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
    const target = sendExecutionMessage.mock.calls[0]?.[1].target as {
      model?: { options?: Record<string, unknown> };
    };
    return target.model?.options;
  }

  function queuedSnapshot() {
    const queuedAt = chat();
    return {
      requestedModel: queuedAt.requestedModel,
      requestedProviderOptions: queuedAt.requestedProviderOptions,
      model: queuedAt.model,
      providerOptions: queuedAt.providerOptions,
    };
  }

  test('an offline replay sends a stricter pick made after it was queued', async () => {
    const { composer, step, sender } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() =>
      composer.result.current.handleModelRuntimeOptionChange('effort', 'low'),
    );
    step(() => composer.result.current.handleApprovalModeChange('never'));
    const snapshot = queuedSnapshot();
    step(() => composer.result.current.handleApprovalModeChange('ask'));

    expect(await replay(sender.result, snapshot)).toEqual({
      effort: 'low',
      approvalMode: 'ask',
    });
  });

  test('an offline replay sends a looser pick made after it was queued (the latest wish)', async () => {
    const { composer, step, sender } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() => composer.result.current.handleApprovalModeChange('ask'));
    const snapshot = queuedSnapshot();
    step(() => composer.result.current.handleApprovalModeChange('auto'));

    expect((await replay(sender.result, snapshot))?.approvalMode).toBe('auto');
  });

  test('probe D: a queued follow-up drained after the turn carries the stricter pick', async () => {
    const { composer, step, sender } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() => composer.result.current.handleApprovalModeChange('never'));
    await act(async () => {
      await sender.result.current(SESSION_ID, 'codex', 'conv-1', 'first');
    });
    // Mid-turn: the engine confirms full access.
    step(() => turnStarted('t1', 'never'));
    expect(chat().approvalModeOverride).toBe('never');
    // The user tightens the posture, then queues a follow-up.
    step(() => composer.result.current.handleApprovalModeChange('ask'));
    sendExecutionMessage.mockClear();
    await act(async () => {
      await sender.result.current(SESSION_ID, 'codex', 'conv-1', 'follow-up');
    });
    expect(chat().queuedMessages).toEqual(['follow-up']);
    expect(sendExecutionMessage).not.toHaveBeenCalled();

    // The turn completes; the real drain (turnHandlers → queueDrain) sends.
    step(() => turnCompleted('t1'));
    await vi.waitFor(() => expect(sendExecutionMessage).toHaveBeenCalled(), {
      timeout: 2000,
    });
    const target = sendExecutionMessage.mock.calls[0]?.[1] as {
      message: string;
      target: { model?: { options?: Record<string, unknown> } };
    };
    expect(target.message).toBe('follow-up');
    expect(target.target.model?.options?.approvalMode).toBe('ask');
    // The drained follow-up is marked in flight, so a pick made now knows
    // its report predates the pick.
    expect(chat().pendingClientTurnId).toBeDefined();
  });

  /** A reload: serialize to storage and hydrate back into the store. */
  function reload() {
    const rehydrated = hydrateActiveChats(
      serializeActiveChats(activeChatsStore.getSnapshot()),
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

  /** What the reconnect snapshot establishes: the session is running. */
  function markSessionLive() {
    fold({
      method: 'session.state-changed',
      sessionId: SESSION_ID,
      from: 'starting',
      to: 'idle',
    });
    expect(chatSessionIsLive(chat())).toBe(true);
  }
});
