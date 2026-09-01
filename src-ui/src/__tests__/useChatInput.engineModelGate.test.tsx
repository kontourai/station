/**
 * @vitest-environment jsdom
 *
 * The composer's model button is gated by the engine capability matrix, but
 * the hook used to resolve that matrix from the chat state's bare provider
 * string (`{ type: provider }`) — a value like 'opencode-runtime' that names
 * no engine — so every external engine fell to the unknown matrix, rendered
 * the button disabled, and titled it "does not support model selection"
 * (caught live by the new-chat provider-managed E2E lane; the fixtures here
 * are that lane's own connection shapes). Station-mode chats hit the same
 * hole through model-connection ids ('ollama-local') that name no engine
 * either. The fix threads the caller's resolved connection (canonical
 * `engineId`) into the resolver and short-circuits Station-mode chats to the
 * station matrix.
 */

import { EXECUTION_MODE } from '@kontourai/station-contracts/tool';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
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
import { useChatInput } from '../hooks/useChatInput';
import { resolveBindingStatus } from '../utils/execution';
import type { SelectableModel } from '../utils/modelCapabilities';

const SESSION_ID = 'engine-model-gate-session';

// The new-chat provider-managed E2E lane's OpenCode runtime connection,
// verbatim shape: canonical engineId present, type is the '<id>-runtime'
// convention that names no engine on its own.
const opencodeConnection = {
  id: 'opencode',
  engineId: 'opencode',
  kind: 'agent',
  type: 'opencode-runtime',
  name: 'OpenCode',
  enabled: true,
  config: {},
  status: 'ready',
  runtimeCatalog: {
    source: 'live' as const,
    models: [
      {
        id: 'opencode/big-pickle',
        name: 'Big Pickle',
        originalId: 'opencode/big-pickle',
      },
    ],
    builtInModels: [],
  },
};

// The new-chat provider-managed E2E lane's model-connection shape: a
// user-chosen id and kind 'model' — nothing here names an engine.
const ollamaConnection = {
  id: 'ollama-local',
  kind: 'model',
  type: 'ollama',
  name: 'Local Ollama',
  enabled: true,
  status: 'ready',
  capabilities: ['llm'],
  config: {},
  runtimeCatalog: {
    source: 'live' as const,
    models: [{ id: 'llama3.2', name: 'Llama 3.2', originalId: 'llama3.2' }],
    builtInModels: [],
  },
};

const opencodeAgent = {
  slug: 'opencode',
  name: 'OpenCode',
  execution: {
    agentConnectionId: 'opencode',
    runtimeOptions: { executionMode: EXECUTION_MODE.EXTERNAL },
  },
} as unknown as AgentData;

const bigPickle: SelectableModel = {
  id: 'opencode/big-pickle',
  name: 'Big Pickle',
  originalId: 'opencode/big-pickle',
};

function renderChatInput(options: {
  runtimeConnection?: typeof opencodeConnection | null;
  bindingStatus?: ReturnType<typeof resolveBindingStatus>;
}) {
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
        availableModels: [bigPickle],
        bindingStatus: options.bindingStatus,
        runtimeConnection: options.runtimeConnection,
      }),
    { wrapper },
  );
}

describe('useChatInput engine capability model gate', () => {
  beforeEach(() => {
    localStorage.clear();
    activeChatsStore.removeChat(SESSION_ID);
  });

  afterEach(() => {
    activeChatsStore.removeChat(SESSION_ID);
    localStorage.clear();
    vi.clearAllMocks();
  });

  test('a Station-mode chat backed by a user-named model connection can select models', () => {
    mockAgent = null;
    activeChatsStore.initChat(SESSION_ID, {
      agentSlug: 'station',
      agentName: 'Station',
      title: 'gate test',
    });
    activeChatsStore.updateChat(SESSION_ID, {
      executionMode: EXECUTION_MODE.STATION,
      // A model connection id is user-named ('ollama-local', not the
      // 'ollama-runtime' the resolver's managed-id allowlist expects) and
      // names no engine; Station-engine-ness lives on the execution mode.
      agentConnectionId: 'ollama-local',
      provider: 'ollama',
      model: 'llama3.2',
    });
    // bindingStatus the way the dock builds it: with the model connection.
    const bindingStatus = resolveBindingStatus({
      agent: null,
      chatState: activeChatsStore.getSnapshot()[SESSION_ID],
      runtimeConnection: ollamaConnection as unknown as Parameters<
        typeof resolveBindingStatus
      >[0]['runtimeConnection'],
      globalModels: [
        { id: 'llama3.2', name: 'Llama 3.2', originalId: 'llama3.2' },
      ],
    });
    const { result } = renderChatInput({
      runtimeConnection: null,
      bindingStatus,
    });
    expect(result.current.modelSelectionReason).toBeUndefined();
    expect(result.current.canModelSelect).toBe(true);
  });

  test('a chat with no connection and an engine-less provider stays honestly gated', () => {
    mockAgent = opencodeAgent;
    activeChatsStore.initChat(SESSION_ID, {
      agentSlug: 'opencode',
      agentName: 'OpenCode',
      title: 'gate test',
    });
    activeChatsStore.updateChat(SESSION_ID, {
      executionMode: EXECUTION_MODE.EXTERNAL,
      agentConnectionId: 'opencode',
      provider: 'opencode-runtime',
    });
    const { result } = renderChatInput({ runtimeConnection: null });
    // Without engine identity the unknown matrix must still refuse — the
    // fix adds identity, it must not invent capability.
    expect(result.current.canModelSelect).toBe(false);
  });
});
