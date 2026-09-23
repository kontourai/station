/**
 * @vitest-environment jsdom
 *
 * #2321 fix round: an explicit full-access choice that was later revoked
 * must never come back. Drives the real composer handlers
 * (useChatInput.handleApprovalModeChange / handleModelSelect), the real
 * orchestration event fold, and the real ApprovalModeChip, through the exact
 * sequence the review reproduced: Never ask → send (the turn consumes the
 * request) → Default → switch model.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen } from '@testing-library/react';
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

vi.mock('@kontourai/station-sdk', () => ({
  telemetry: { track: vi.fn() },
  useSkillsQuery: () => ({ data: [] }),
  useProviderCommandsQuery: () => ({ data: [] }),
  useRunSkill: () => ({ mutateAsync: vi.fn() }),
  useSkillDetailReader: () => vi.fn(),
}));

vi.mock('../contexts/ActiveChatsContext', async () => {
  const { activeChatsStore } = await import('../contexts/active-chats-store');
  return {
    useActiveChatActions: () => ({
      updateChat: activeChatsStore.updateChat.bind(activeChatsStore),
      clearInput: activeChatsStore.clearInput.bind(activeChatsStore),
      addEphemeralMessage:
        activeChatsStore.addEphemeralMessage.bind(activeChatsStore),
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

vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => vi.fn(),
  useCancelMessage: () => vi.fn(),
}));

import { ApprovalModeChip } from '../components/badges/ApprovalModeChip';
import { activeChatsStore } from '../contexts/active-chats-store';
import { handleOrchestrationEvent } from '../hooks/orchestration/eventHandlers';
import { useChatInput } from '../hooks/useChatInput';
import type { SelectableModel } from '../utils/modelCapabilities';

const SESSION_ID = 'approval-revocation-session';
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

function renderComposer() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(
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
}

/**
 * What the next send and the composer pill both read. Mirrors
 * ChatDockBody.tsx (`modelRuntimeOptions={activeSession.requestedProviderOptions
 * ?? activeSession.providerOptions}`) and ChatInputArea.tsx
 * (`sessionOverride={modelRuntimeOptions?.approvalMode}`), and the dispatch
 * in useActiveChatSessionMessaging.ts (`requestedProviderOptions ??
 * providerOptions`).
 */
function effectiveOptions() {
  const chat = activeChatsStore.getSnapshot()[SESSION_ID];
  return chat.requestedProviderOptions ?? chat.providerOptions;
}

function renderPillText() {
  const chat = activeChatsStore.getSnapshot()[SESSION_ID];
  render(
    <ApprovalModeChip
      engineConnectionId="codex"
      sessionOverride={effectiveOptions()?.approvalMode}
      lastAppliedApprovalMode={chat.lastAppliedApprovalMode}
      onChange={vi.fn()}
    />,
  );
  return screen.getByRole('button', { name: /^Approval mode:/ }).textContent;
}

describe('a revoked full-access choice stays revoked (#2321)', () => {
  beforeEach(() => {
    activeChatsStore.removeChat(SESSION_ID);
    activeChatsStore.initChat(SESSION_ID, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Revocation chat',
    });
    activeChatsStore.updateChat(SESSION_ID, {
      agentConnectionId: 'codex',
      provider: 'codex',
    });
  });

  afterEach(() => {
    activeChatsStore.removeChat(SESSION_ID);
    vi.clearAllMocks();
  });

  test('never → send → Default → switch model does not bring full access back', () => {
    const { result, rerender } = renderComposer();
    // The mocked selector reads the store at render time and does not
    // subscribe, so re-render after every store write: each handler must see
    // the chat state the user would see at that moment.
    const step = (fn: () => void) => {
      act(fn);
      rerender();
    };

    step(() => result.current.handleModelSelect(modelX));
    step(() => result.current.handleApprovalModeChange('never'));

    // The first turn starts and acknowledges model X: the request is consumed.
    step(() => {
      handleOrchestrationEvent('http://station.test', {
        provider: 'codex',
        threadId: SESSION_ID,
        createdAt: '2026-09-22T00:00:00.000Z',
        method: 'turn.started',
        turnId: 'turn-1',
        metadata: {
          approvalMode: 'never',
          effectiveModel: 'model-x',
          effectiveModelOptions: {},
        },
      } as Parameters<typeof handleOrchestrationEvent>[1]);
    });
    expect(effectiveOptions()?.approvalMode).toBe('never');

    step(() => result.current.handleApprovalModeChange('connection-default'));
    // The confirmed bag no longer holds the superseded posture, so no later
    // rebuild from it can restore full access.
    expect(
      activeChatsStore.getSnapshot()[SESSION_ID].providerOptions?.approvalMode,
    ).toBeUndefined();

    step(() => result.current.handleModelSelect(modelY));
    // The model switch keeps the user's pending choice rather than rebuilding
    // from the confirmed bag.
    expect(
      activeChatsStore.getSnapshot()[SESSION_ID].requestedProviderOptions
        ?.approvalMode,
    ).toBe('connection-default');

    expect(effectiveOptions()?.approvalMode).not.toBe('never');
    expect(renderPillText()).not.toMatch(/Full access/);
  });
});
