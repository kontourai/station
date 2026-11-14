// @vitest-environment jsdom
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import type { AgentData } from '../../../contexts/AgentsContext';
import { activeChatsStore } from '../../../contexts/active-chats-store';
import { PreviewProvider } from '../../../contexts/PreviewContext';
import type { useChatInput } from '../../../hooks/useChatInput';
import type { ChatSession } from '../../../types';
import { ConversationBody } from '../ConversationBody';
import { ConversationConnectionProvider } from '../ConversationConnectionContext';
import { createConversationTransport } from '../conversation-transport';
import { conversationConnection } from './fixtures';

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'source', name: 'Source' },
    captureCredentialEvidence: () => undefined,
  }),
}));
vi.mock('../../../contexts/AgentsContext', () => ({
  useAgents: () => [agent],
  useAgentsLoaded: () => true,
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://source.test' }),
  useHostRequestAuthorityScope: () => undefined,
}));
vi.mock('../../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigationActions: () => ({ navigate: vi.fn() }),
  useNavigation: () => ({ navigate: vi.fn() }),
}));
vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));
vi.mock('../../../contexts/MessageContextContext', () => ({
  useMessageContextContext: () => ({ getComposedContext: () => '' }),
}));
vi.mock('../../../hooks/useACPConnections', () => ({
  useACPConnections: () => ({ data: [] }),
}));
vi.mock('../../../hooks/useShareReceiver', () => ({
  useShareReceiver: () => {},
}));
vi.mock('../../../hooks/useSTT', () => ({
  useSTT: () => ({
    supported: false,
    state: 'idle',
    transcript: '',
    startListening: vi.fn(),
    stopListening: vi.fn(),
  }),
}));
vi.mock('../../../hooks/useTTS', () => ({
  useTTS: () => ({
    supported: false,
    speaking: false,
    speak: vi.fn(),
    cancel: vi.fn(),
  }),
}));
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => new Set<string>(),
}));
vi.mock('../../../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => vi.fn(),
}));
vi.mock('../../../lib/outboundQueue', () => ({
  outboundDispatch: {
    discard: vi.fn(async () => {}),
    retiredKeys: vi.fn(async () => ({ accepted: [] })),
  },
}));
vi.mock('../../../contexts/ActiveChatsContext', () => ({
  activeChatsStore,
  useActiveChatActions: () => ({
    updateChat: activeChatsStore.updateChat.bind(activeChatsStore),
    clearEphemeralMessages: vi.fn(),
    addEphemeralMessage: vi.fn(),
  }),
}));

const agent: AgentData = {
  slug: agentId('codex'),
  name: 'Codex',
  available: true,
};
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
  for (const id of Object.keys(activeChatsStore.getSnapshot()))
    activeChatsStore.removeChat(id);
});

function Harness({
  route,
  denyContinue = false,
  sessionFacts = {},
}: {
  route: 'host' | 'direct' | 'relay';
  denyContinue?: boolean;
  sessionFacts?: Partial<ChatSession>;
}) {
  const connection = useMemo(() => {
    const value = conversationConnection(route);
    return denyContinue
      ? {
          ...value,
          capabilities: {
            ...value.capabilities,
            continue: {
              state: 'denied' as const,
              reason: 'permission-required' as const,
            },
          },
        }
      : value;
  }, [route, denyContinue]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [messages, setMessages] = useState<ChatSession['messages']>([]);
  const stored = useSyncExternalStore(
    activeChatsStore.subscribe,
    () => activeChatsStore.getSnapshot()[`tab-${route}`],
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const session: ChatSession = {
    id: `tab-${route}`,
    agentSlug: agent.slug,
    agentName: agent.name,
    title: 'Shared chat',
    source: 'manual',
    messages: stored?.messages ?? messages,
    input: stored?.input ?? input,
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    status: running ? 'sending' : 'idle',
    error: null,
    createdAt: 0,
    updatedAt: 0,
    stationBinding: connection.binding,
    orchestrationTurnOpen: running,
    ...sessionFacts,
  };
  const transport = createConversationTransport(connection);
  const chatInput: ReturnType<typeof useChatInput> = {
    textareaRef,
    quotes: [],
    quotedDraftText: input,
    removeQuote: () => {},
    input: stored?.input ?? input,
    attachments: [],
    attachmentError: null,
    attachmentStages: [],
    sendBlockedReason: undefined,
    attachmentNotice: undefined,
    attachUnavailableReason: undefined,
    removalUnblocksSend: false,
    currentModel: undefined,
    canModelSelect: false,
    modelSelectionReason: undefined,
    modelsStale: false,
    modelQuery: null,
    commandQuery: null,
    slashCommands: [],
    handleInputChange: setInput,
    handleSend: async () => {
      await transport.send(
        {
          target: { environment: { kind: 'current' }, agent: agent.slug },
          message: input,
          clientTurnId: 'shared-turn',
        },
        async () => {
          throw new Error('No visual skill in this fixture');
        },
      );
      setMessages([
        {
          id: 'sent',
          role: 'user',
          content: input,
          timestamp: 0,
          clientId: 'shared-turn',
          turnId: 'turn',
        },
      ]);
      setInput('');
      setRunning(true);
    },
    sendComposedMessage: async () => false,
    handleCancel: async () => {
      await transport.stop({ threadId: 'child', turnId: 'turn' });
      setRunning(false);
    },
    handleClearInput: () => setInput(''),
    handleAddAttachments: () => {},
    selectAttachmentFiles: async () => {},
    replaceAttachmentFile: async () => {},
    setAttachmentError: () => {},
    retryAttachmentStage: async () => {},
    cancelAttachmentStage: async () => {},
    handleRemoveAttachment: () => {},
    handleClearAttachments: () => {},
    handleModelSelect: () => {},
    handleModelReset: () => {},
    handleModelRuntimeOptionChange: () => {},
    handleApprovalModeChange: () => {},
    handleAcpSessionModeChange: async () => {},
    handleModelOpen: () => {},
    openModelForExecution: () => {},
    handleModelClose: () => {},
    handleCommandSelect: async () => {},
    handleCommandClose: () => {},
    handleHistoryUp: () => {},
    handleHistoryDown: () => {},
    handleRestorePortableDraft: () => {},
    updateFromInput: () => {},
    closeAll: () => {},
  };
  return (
    <ConversationConnectionProvider
      value={{
        apiBase: connection.targetApiBase,
        requestScope: {
          ...connection.requestScope,
          isCurrent: connection.isCurrent,
        },
        station: connection,
      }}
    >
      <ConversationBody
        activeSession={session}
        chatFontSize={14}
        dockHeight={600}
        showStatsPanel={false}
        showReasoning={false}
        showToolDetails={false}
        modelSupportsAttachments={false}
        fileAttachmentsSupported={false}
        availableModels={[]}
        chatInput={chatInput}
        setShowStatsPanel={() => {}}
      />
    </ConversationConnectionProvider>
  );
}

test('the real composer applies a narrowed connection ceiling and retains its draft without an open caller-access response', async () => {
  const connection = conversationConnection('relay');
  setClientCredentialResolver(() => ({
    origin: connection.requestScope.apiBase,
    credential: 'fixture-token',
    requestAuthority: { ...connection.requestScope, isCurrent: () => true },
  }));
  const request = vi.fn<typeof fetch>(async (input) =>
    Response.json({
      success: true,
      data: String(input).endsWith('/api/agents') ? [agent] : [],
    }),
  );
  vi.stubGlobal('fetch', request);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const tree = (denied: boolean) => (
    <QueryClientProvider client={client}>
      <PreviewProvider>
        <Harness route="relay" denyContinue={denied} />
      </PreviewProvider>
    </QueryClientProvider>
  );
  const view = render(tree(false));
  const composer = await screen.findByRole('textbox');
  await waitFor(() => expect(composer.hasAttribute('disabled')).toBe(false));
  await userEvent.setup().type(composer, 'A retained answer');
  expect(
    screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled'),
  ).toBe(false);
  view.rerender(tree(true));
  await waitFor(() => expect(composer.hasAttribute('disabled')).toBe(true));
  expect((composer as HTMLTextAreaElement).value).toBe('A retained answer');
  expect(
    screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(
    request.mock.calls.filter(([, options]) => options?.method === 'POST'),
  ).toEqual([]);
});

test.each(['host', 'direct', 'relay'] as const)(
  '%s uses the shared composer, transcript and turn Stop',
  async (route) => {
    const connection = conversationConnection(route);
    const requests: Array<{ url: string; body: unknown }> = [];
    setClientCredentialResolver(() => ({
      origin: connection.requestScope.apiBase,
      credential: 'fixture-token',
      requestAuthority: { ...connection.requestScope, isCurrent: () => true },
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/api/agents'))
          return Response.json({ success: true, data: [agent] });
        if (init?.method === 'POST') {
          requests.push({ url, body: JSON.parse(String(init.body)) });
          return Response.json({
            success: true,
            data: url.endsWith('/chat')
              ? {
                  conversationId: 'conversation',
                  sessionId: 'child',
                  providerTurnId: 'turn',
                }
              : {},
          });
        }
        return Response.json({ success: true, data: [] });
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    render(
      <QueryClientProvider client={client}>
        <PreviewProvider>
          <Harness route={route} />
        </PreviewProvider>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const composer = await screen.findByRole('textbox');
    await waitFor(() => expect(composer.hasAttribute('disabled')).toBe(false));
    await user.type(composer, 'Hello from the shared composer');
    await user.keyboard('{Enter}');
    await screen.findByText('Hello from the shared composer');
    await user.click(
      await screen.findByRole('button', { name: 'Stop the current turn' }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Stop the current turn' }),
      ).toBeNull(),
    );
    expect(requests).toEqual([
      {
        url: `${connection.targetApiBase}/api/orchestration/chat`,
        body: expect.objectContaining({
          message: 'Hello from the shared composer',
          clientTurnId: 'shared-turn',
        }),
      },
      {
        url: `${connection.targetApiBase}/api/orchestration/commands`,
        body: { type: 'interruptTurn', threadId: 'child', turnId: 'turn' },
      },
    ]);
  },
);
// Keep the refusal projection and its actions identical on every route.
test.each(['host', 'direct', 'relay'] as const)(
  '%s renders a refusal inside the user bubble and Edit returns it to the composer',
  async (route) => {
    const text = 'Please continue this work.';
    const retry = vi.fn();
    const connection = conversationConnection(route);
    activeChatsStore.initChat(`tab-${route}`, {
      agentSlug: agent.slug,
      agentName: agent.name,
      title: 'Shared chat',
    });
    activeChatsStore.updateChat(`tab-${route}`, {
      messages: [
        {
          id: 'refused',
          role: 'user',
          clientId: 'refused-key',
          content: text,
          timestamp: 0,
          action: { label: 'Retry', handler: retry },
          deliveryNotice: {
            clientTurnId: 'refused-key',
            text,
            state: 'not-sent',
            description: "Receiver didn't accept this message.",
            diagnostic: 'peer_chat_target_refused: insufficient_scope',
          },
        },
        {
          id: 'reply',
          role: 'assistant',
          content: 'An earlier reply',
          timestamp: 1,
        },
      ],
      stationBinding: connection.binding,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json({ success: true, data: [] }),
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    const { container } = render(
      <QueryClientProvider client={client}>
        <PreviewProvider>
          <Harness route={route} />
        </PreviewProvider>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const message = await screen.findByText(text);
    const bubble = message.closest('.message');
    expect(bubble?.classList.contains('user')).toBe(true);
    expect(bubble?.classList.contains('message--delivery-not-sent')).toBe(true);
    expect(bubble?.querySelectorAll('.message-delivery')).toHaveLength(1);
    expect(
      screen.getAllByText("Receiver didn't accept this message."),
    ).toHaveLength(1);
    const diagnostic = screen.getByText(
      'peer_chat_target_refused: insufficient_scope',
    );
    expect(diagnostic.closest('details')?.open).toBe(false);
    expect(
      container.querySelector('.message__sender')?.textContent ?? '',
    ).not.toMatch(/via/i);
    expect(container.textContent).not.toMatch(/via Source|via Receiver/i);
    await user.click(screen.getByRole('button', { name: /^Retry$/ }));
    expect(retry).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: /^Edit$/ }));
    await waitFor(() =>
      expect(container.querySelector('.message--delivery-not-sent')).toBeNull(),
    );
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      text,
    );
  },
);

test.each([
  { provider: 'claude' as const, connection: 'configured', expected: 'codex' },
  { provider: 'claude' as const, connection: 'previous', expected: 'claude' },
])(
  'composer mark follows configuration only while it names the session: $connection',
  async ({ provider, connection, expected }) => {
    const connectionTarget = conversationConnection('host');
    setClientCredentialResolver(() => ({
      origin: connectionTarget.requestScope.apiBase,
      credential: 'fixture',
      requestAuthority: {
        ...connectionTarget.requestScope,
        isCurrent: () => true,
      },
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input) =>
        Response.json({
          success: true,
          data: String(input).endsWith('/api/agents') ? [agent] : [],
        }),
      ),
    );
    const original = { ...agent };
    Object.assign(agent, {
      engineId: 'codex',
      execution: { agentConnectionId: 'configured' },
    });
    try {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      clients.push(client);
      render(
        <QueryClientProvider client={client}>
          <PreviewProvider>
            <Harness
              route="host"
              sessionFacts={{
                orchestrationProvider: provider,
                agentConnectionId: engineConnectionId(connection),
              }}
            />
          </PreviewProvider>
        </QueryClientProvider>,
      );
      await waitFor(() => {
        const trigger = screen.getByTestId('run-setup-trigger');
        const marks = trigger.querySelectorAll('[data-brand-key]');
        expect(
          Array.from(marks, (mark) => mark.getAttribute('data-brand-key')),
        ).toEqual(
          connection === 'configured' ? ['codex'] : ['codex', expected],
        );
      });
    } finally {
      for (const key of Object.keys(agent))
        delete (agent as unknown as Record<string, unknown>)[key];
      Object.assign(agent, original);
    }
  },
);
