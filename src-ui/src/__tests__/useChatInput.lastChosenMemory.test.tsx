/**
 * @vitest-environment jsdom
 *
 * The "last chosen" model memory (hooks/lastChosenModel.ts) used to learn
 * only from the New Chat modal's own picker — an in-session model switch,
 * the far more common way to change models, taught the next New Chat
 * nothing. These pin the new wiring in useChatInput:
 * - picker intent does not become remembered choice until an accepted server
 *   event confirms the model was actually applied
 *   (external agents only, mirroring NewChatModal's PROVIDER_MANAGED gate)
 * - handleModelReset clears the remembered choice (resetting IS choosing
 *   the default)
 * - Station (provider-managed) agents never write the memory: their
 *   admin-configured default must not be shadowed by a stale choice.
 */

import {
  EXECUTION_MODE,
  type RuntimeCatalogSource,
} from '@kontourai/station-contracts/tool';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let mockAgent: unknown = null;
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
  useAgent: () => mockAgent,
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('@kontourai/station-sdk', () => ({
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

import type { AgentData } from '../contexts/AgentsContext';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  buildLastChosenModelBindingKey,
  getLastChosenModelMap,
} from '../hooks/lastChosenModel';
import { useChatInput } from '../hooks/useChatInput';
import type { SelectableModel } from '../utils/modelCapabilities';

const SESSION_ID = 'last-chosen-memory-session';

// AgentData's slug/engine ids are branded; test fixtures route through
// `unknown` once, here, instead of per-call double-casts.
const externalAgent = {
  slug: 'claude',
  name: 'Claude Code',
  execution: {
    agentConnectionId: 'claude-runtime',
    runtimeOptions: { executionMode: EXECUTION_MODE.EXTERNAL },
  },
} as unknown as AgentData;

// Real persisted agent records carry NO executionMode field (no production
// writer sets it — review finding F1 on this change); Station-engine-ness
// lives on the live session chat state. This fixture models that reality.
const stationAgent = {
  slug: 'station',
  name: 'Station',
  execution: {},
} as unknown as AgentData;

const sonnet: SelectableModel = {
  id: 'claude-sonnet-5',
  name: 'Claude Sonnet 5',
  originalId: 'claude-sonnet-5',
};

function renderChatInput(options?: {
  defaultModelSource?: 'last chosen' | 'agent default';
}) {
  activeChatsStore.updateChat(SESSION_ID, {
    agentConnectionId: 'claude',
    provider: 'claude',
  });
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
        agentSlug: (mockAgent as AgentData | null)?.slug ?? null,
        conversationId: 'conv-1',
        availableModels: [sonnet],
        agentDefaultModel: 'claude-opus-5',
        defaultModelSource: options?.defaultModelSource,
      }),
    { wrapper },
  );
}

describe('useChatInput last-chosen model memory', () => {
  beforeEach(() => {
    localStorage.clear();
    // updateChat silently no-ops for sessions that don't exist — the
    // session must be CREATED via initChat or every state-dependent gate
    // in the hook runs against null and tests pass for the wrong reason
    // (this suite's first draft did exactly that).
    activeChatsStore.removeChat(SESSION_ID);
    activeChatsStore.initChat(SESSION_ID, {
      agentSlug: 'claude',
      agentName: 'Claude Code',
      title: 'Memory test chat',
    });
  });

  afterEach(() => {
    activeChatsStore.removeChat(SESSION_ID);
    localStorage.clear();
    vi.clearAllMocks();
  });

  // The two directions share one fixture whose runtime session options make
  // the catalog conjunct TRUE (supportsFastMode), so the matrix gate is the
  // ONLY discriminator between them.
  const fastModel: SelectableModel = {
    id: 'engine-model',
    name: 'Engine Model',
    originalId: 'engine-model',
    capabilities: { supportsFastMode: true },
  } as SelectableModel;

  function renderWithProvider(
    provider: string,
    availableModels = [fastModel],
    catalogSource: RuntimeCatalogSource = provider === 'acp' ? 'live' : 'none',
    conversationId: string | undefined = undefined,
  ) {
    activeChatsStore.updateChat(SESSION_ID, {
      provider,
      agentConnectionId: provider === 'acp' ? 'acp' : 'unknown-connection',
    });
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
          agentSlug: (mockAgent as AgentData | null)?.slug ?? null,
          conversationId,
          availableModels,
          bindingStatus: {
            catalogSource,
            bindingReadiness: 'ready',
            capabilityState: {
              system_prompt: false,
              mcp: false,
              tool_execution: false,
              model_catalog: availableModels.length > 0,
              model_selection: availableModels.length > 0,
            },
            visibleModels: availableModels.map((model) => ({
              ...model,
              originalId: model.originalId ?? model.id,
            })),
          },
          agentDefaultModel: 'engine-model',
        }),
      { wrapper },
    );
  }

  test('an engine whose matrix declares modelSelection unsupported disables the picker with the declared reason (#2462)', () => {
    mockAgent = externalAgent;
    const { result } = renderWithProvider('unrecognized-engine');

    expect(result.current.canModelSelect).toBe(false);
    expect(result.current.modelSelectionReason).toBe(
      'This engine does not support model selection for a chat session.',
    );
  });

  test('ACP model selection stays available before the first turn (#2848)', () => {
    mockAgent = externalAgent;
    const { result } = renderWithProvider('acp');

    expect(result.current.canModelSelect).toBe(true);
    expect(result.current.modelSelectionReason).toBeUndefined();
  });

  test('ACP disables a continuation override from its precise launch capability', () => {
    mockAgent = externalAgent;
    const { result } = renderWithProvider(
      'acp',
      [fastModel],
      'live',
      'existing-conversation',
    );

    expect(result.current.canModelSelect).toBe(false);
    expect(result.current.modelSelectionReason).toBe(
      'This engine can choose a model for a new chat, but cannot change it in an existing conversation.',
    );
  });

  test('an ACP connection with no observed model catalog keeps the picker disabled (#2848)', () => {
    mockAgent = externalAgent;
    const { result } = renderWithProvider('acp', []);

    expect(result.current.canModelSelect).toBe(false);
    expect(result.current.modelSelectionReason).toBe(
      'This engine reported no selectable models.',
    );
  });

  test('an ACP fallback model without live catalog provenance does not advertise selection (#2848)', () => {
    mockAgent = externalAgent;
    const { result } = renderWithProvider('acp', [fastModel], 'none');

    expect(result.current.canModelSelect).toBe(false);
  });

  test('a supported engine with an empty catalog keeps the offline picker available (#2607)', () => {
    mockAgent = externalAgent;
    const { result } = renderWithProvider('claude', []);

    expect(result.current.canModelSelect).toBe(true);
    expect(result.current.modelSelectionReason).toBe(
      'This engine reported no selectable models.',
    );
  });

  test('a requested in-session select is not remembered before server acceptance', () => {
    mockAgent = externalAgent;
    const { result } = renderChatInput();

    act(() => result.current.handleModelSelect(sonnet));

    expect(getLastChosenModelMap()).toEqual({});
    expect(activeChatsStore.getSnapshot()[SESSION_ID]).toMatchObject({
      requestedModel: 'claude-sonnet-5',
      requestedModelSource: 'session override',
    });
  });

  test('reset clears the remembered choice for that binding only', () => {
    mockAgent = externalAgent;
    const { result } = renderChatInput();
    const key = buildLastChosenModelBindingKey(externalAgent);
    // A second binding's memory must survive the reset.
    localStorage.setItem(
      'station.newChat.lastModelByBinding',
      JSON.stringify({ [key]: 'claude-sonnet-5', other: 'gpt-5-codex' }),
    );

    act(() => result.current.handleModelReset());

    expect(getLastChosenModelMap()).toEqual({ other: 'gpt-5-codex' });
    expect(activeChatsStore.getSnapshot()[SESSION_ID]).toMatchObject({
      requestedModel: null,
      requestedModelSource: 'agent default',
    });
  });

  test('a model selected after reset replaces the explicit default request', () => {
    mockAgent = externalAgent;
    const { result } = renderChatInput();

    act(() => result.current.handleModelReset());
    act(() => result.current.handleModelSelect(sonnet));

    expect(activeChatsStore.getSnapshot()[SESSION_ID]).toMatchObject({
      requestedModel: 'claude-sonnet-5',
      requestedModelSource: 'session override',
    });
  });

  test('Station-engine sessions never write the memory (gated on live session state)', () => {
    mockAgent = stationAgent;
    activeChatsStore.updateChat(SESSION_ID, {
      executionMode: EXECUTION_MODE.STATION,
    });
    const { result } = renderChatInput();

    act(() => result.current.handleModelSelect(sonnet));
    act(() => result.current.handleModelReset());

    expect(getLastChosenModelMap()).toEqual({});
  });

  test('reset keeps the memory when the session default IS the remembered choice', () => {
    mockAgent = externalAgent;
    const key = buildLastChosenModelBindingKey(externalAgent);
    localStorage.setItem(
      'station.newChat.lastModelByBinding',
      JSON.stringify({ [key]: 'claude-opus-5' }),
    );
    const { result } = renderChatInput({ defaultModelSource: 'last chosen' });

    // Resetting to a 'last chosen' default re-affirms the memory; clearing
    // it would contradict the "Model reset to last chosen" notice.
    act(() => result.current.handleModelReset());

    expect(getLastChosenModelMap()).toEqual({ [key]: 'claude-opus-5' });
  });
});
