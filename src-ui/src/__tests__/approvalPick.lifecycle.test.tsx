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

vi.mock('../contexts/ConfigContext', () => ({
  useConfig: () => ({ config: undefined }),
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

function fold(event: Record<string, unknown>) {
  clock += 1;
  handleOrchestrationEvent('http://station.test', {
    provider: 'codex',
    threadId: SESSION_ID,
    createdAt: new Date(Date.UTC(2026, 8, 22, 0, 0, clock)).toISOString(),
    ...event,
  } as OrchestrationEventInput);
}

/** A turn.started reporting the model and the approval posture applied. */
function turnStarted(
  turnId: string,
  applied: string,
  effectiveModelOptions: Record<string, unknown> = {},
  effectiveModel = 'model-x',
) {
  fold({
    method: 'turn.started',
    turnId,
    metadata: {
      approvalMode: applied,
      effectiveModel,
      effectiveModelOptions,
    },
  });
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
      sessionOverridePending={override?.pending}
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

  test('the reported symptom: a confirmed Never ask reads Full access, not Default', async () => {
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

  test('revoke, then switch model: full access is not resent', async () => {
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
    step(() => composer.result.current.handleModelSelect(modelY));
    const wire = await send();
    expect(wire?.override).toBe('model-y');
    expect(wire?.options?.approvalMode).toBeUndefined();
    // The pill names the engine's receipt as a default, not an override.
    const pill = renderPill();
    expect(pill.text).toBe('Default');
    expect(pill.name).toMatch(/^Approval mode: Default — /);
  });

  test('a stale report after a stricter pick neither drops nor confirms it', async () => {
    const { composer, step, send } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() => composer.result.current.handleApprovalModeChange('never'));
    await send();
    // Before turn 1's report lands, the user tightens the posture.
    step(() => composer.result.current.handleApprovalModeChange('ask'));
    // The report describes turn 1: model X acknowledged, 'never' applied.
    step(() => turnStarted('t1', 'never'));

    expect(chat().requestedProviderOptions).toBeUndefined();
    expect(chat().pendingApprovalMode).toBe('ask');
    expect(chat().approvalModeOverride).toBeUndefined();
    expect(chat().lastAppliedApprovalMode).toBe('never');
    // The engine still runs with full access; the pill says the stricter
    // pick is not in effect yet (the #2334 decision on the #1933 pin).
    const pending = renderPill();
    expect(pending.text).toBe('Ask · pending');
    expect(pending.name).toMatch(/full access applies until the next turn/);

    step(() => turnCompleted('t1'));
    expect((await send())?.options?.approvalMode).toBe('ask');

    // That turn's report settles it.
    step(() => turnStarted('t2', 'ask'));
    expect(chat().pendingApprovalMode).toBeUndefined();
    expect(chat().approvalModeOverride).toBe('ask');
    expect(renderPill().text).toBe('Ask');
  });

  test('a Default pick settles immediately and sends no posture', async () => {
    const { composer, step, send } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    // A pending pick that is then withdrawn before any turn confirms it.
    step(() => composer.result.current.handleApprovalModeChange('auto'));
    expect(chat().pendingApprovalMode).toBe('auto');
    step(() =>
      composer.result.current.handleApprovalModeChange('connection-default'),
    );
    expect(chat().pendingApprovalMode).toBeUndefined();
    expect(chat().approvalModeOverride).toBeUndefined();

    // Nothing is left to settle, and the send carries the model request
    // without inventing a posture (no Station/connection default here).
    const wire = await send();
    expect(wire?.override).toBe('model-x');
    expect(wire?.options ?? {}).not.toHaveProperty('approvalMode');
    step(() => turnStarted('t1', 'ask'));
    expect(chat().requestedModel).toBeUndefined();
    expect(chat().pendingApprovalMode).toBeUndefined();
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

    // The report acknowledges the model and its controls but not the pick
    // (a refusal-free engine that has not applied it yet).
    step(() => turnStarted('t1', 'ask', { effort: 'high' }));
    step(() => turnCompleted('t1'));
    expect(chat().requestedProviderOptions).toBeUndefined();
    expect(chat().providerOptions).toEqual({ effort: 'high' });
    expect(chat().pendingApprovalMode).toBe('never');

    // The next send still carries both: the effort from the confirmed bag,
    // the pick from its own field.
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

    // The default-model send drops every model override but keeps the pick.
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

  test('with nothing pending, a report that disagrees retires the confirmed pick', async () => {
    const { composer, step, send } = renderComposer();
    step(() => composer.result.current.handleModelSelect(modelX));
    step(() => composer.result.current.handleApprovalModeChange('auto'));
    await send();
    step(() => turnStarted('t1', 'auto'));
    step(() => turnCompleted('t1'));
    expect(chat().approvalModeOverride).toBe('auto');
    // A confirmed pick is resent every turn, like the rest of the override
    // bag the adapters expect.
    expect((await send())?.options?.approvalMode).toBe('auto');

    // The posture changed elsewhere (another device's pick).
    step(() => turnStarted('t2', 'ask'));
    step(() => turnCompleted('t2'));
    expect(chat().approvalModeOverride).toBeUndefined();
    expect((await send())?.options ?? {}).not.toHaveProperty('approvalMode');
  });
  test('a pending pick survives a reload; a confirmed one, a receipt, does not', () => {
    activeChatsStore.updateChat(SESSION_ID, {
      pendingApprovalMode: 'ask',
      approvalModeOverride: 'never',
    });
    const rehydrated = hydrateActiveChats(
      serializeActiveChats(activeChatsStore.getSnapshot()),
    )[SESSION_ID];
    expect(rehydrated?.pendingApprovalMode).toBe('ask');
    expect(rehydrated?.approvalModeOverride).toBeUndefined();
  });

  test('a replayed queued turn sends the pick it was queued with', async () => {
    const { sender } = renderComposer();
    // The live chat has since moved on; the replay must not borrow its pick.
    activeChatsStore.updateChat(SESSION_ID, { pendingApprovalMode: 'never' });
    sendExecutionMessage.mockClear();
    await act(async () => {
      await sender.result.current(
        SESSION_ID,
        'codex',
        'conv-1',
        'queued',
        undefined,
        undefined,
        undefined,
        {
          executionSnapshot: {
            requestedModel: 'model-x',
            requestedProviderOptions: { effort: 'low' },
            providerOptions: {},
            pendingApprovalMode: 'ask',
          },
        },
      );
    });
    const target = sendExecutionMessage.mock.calls[0]?.[1].target as {
      model?: { options?: Record<string, unknown> };
    };
    expect(target.model?.options).toEqual({
      effort: 'low',
      approvalMode: 'ask',
    });
  });
});
