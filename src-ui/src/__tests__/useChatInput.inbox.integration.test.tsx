/** @vitest-environment jsdom */

import { SDKProvider } from '@kontourai/station-sdk';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { type ReactNode, useSyncExternalStore } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  AGENT,
  CONVERSATION,
  createInboxHarness,
  READER,
} from '../../../src-server/routes/orchestration/__tests__/helpers/thread-inbox-harness';
import { ConversationInboxMessages } from '../components/chat/ConversationInboxMessages';
import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
import { ActiveChatsProvider } from '../contexts/ActiveChatsContext';
import { activeChatsStore } from '../contexts/active-chats-store';
import { PreviewProvider } from '../contexts/PreviewContext';
import { useChatInput } from '../hooks/useChatInput';

vi.mock('../components/chat/FileAttachmentInput', () => ({
  FileAttachmentInput: () => null,
}));
vi.mock('../contexts/AuthorityPersistenceContext', () => ({
  useAuthorityPersistence: () => ({ namespace: 'fixture', status: 'verified' }),
}));
vi.mock('../contexts/AccountPreferencesContext', () => ({
  useAccountPreferences: () => ({
    status: 'account',
    data: { schemaVersion: 1, values: { interactiveApprovalModes: {} } },
  }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://inbox.station' }),
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://inbox.station',
    authorityKey: 'reader',
    requiresEnrolledCredential: false,
    isCurrent: () => true,
  }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'test', name: 'Test' },
    captureCredentialEvidence: () => undefined,
  }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [{ slug: AGENT, name: 'Claude' }],
  useAgentsLoaded: () => true,
  useAgent: () => ({ slug: AGENT, name: 'Claude' }),
}));
vi.mock('../contexts/NavigationContext', () => {
  const navigation = () => ({ navigate: vi.fn() });
  return {
    useNavigation: (
      selector?: (state: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { alias: 'operator' } }),
}));
vi.mock('../contexts/MessageContextContext', () => ({
  useMessageContextContext: () => ({ getComposedContext: () => '' }),
}));
vi.mock('../hooks/useACPConnections', () => ({
  useACPConnections: () => ({ data: [] }),
}));
vi.mock('../hooks/useShareReceiver', () => ({ useShareReceiver: () => {} }));
vi.mock('../hooks/useSTT', () => ({
  useSTT: () => ({
    supported: false,
    state: 'idle',
    transcript: '',
    startListening: vi.fn(),
    stopListening: vi.fn(),
  }),
}));
vi.mock('../hooks/useTTS', () => ({
  useTTS: () => ({
    supported: false,
    speaking: false,
    speak: vi.fn(),
    cancel: vi.fn(),
  }),
}));
vi.mock('../hooks/orchestration/useActiveChatTranscript', () => ({
  useActiveChatTranscript: () => ({
    enabled: false,
    messages: [],
    events: [],
    hasMore: false,
    loading: false,
    settled: true,
    upgradeRequired: false,
    loadOlder: vi.fn(),
    reload: vi.fn(),
  }),
}));

const apiBase = 'http://inbox.station';
const sessionId = 'mounted-inbox';

function Composer() {
  const chat = useChatInput({
    apiBase,
    sessionId,
    agentSlug: AGENT,
    conversationId: CONVERSATION,
    availableModels: [],
  });
  const sessions = useSyncExternalStore(
    activeChatsStore.subscribe,
    activeChatsStore.getSnapshot,
  );
  return (
    <PreviewProvider>
      <ChatDockBody
        activeSession={sessions[sessionId]}
        activeOrchestrationSession={null}
        activeOrchestrationSessionRead="absent"
        onRetryOrchestrationSessions={() => {}}
        chatFontSize={14}
        dockHeight={400}
        showStatsPanel={false}
        showReasoning={false}
        showToolDetails={false}
        modelSupportsAttachments={false}
        fileAttachmentsSupported={false}
        availableModels={[]}
        chatInput={chat}
        setShowStatsPanel={() => {}}
      />
    </PreviewProvider>
  );
}

describe('mounted composer inbox handoff (test-scoped caller)', () => {
  const station = createInboxHarness();
  afterEach(() => {
    activeChatsStore.removeChat(sessionId);
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
  });

  test('ordinary busy send queues through the dock when native steering is unavailable', async () => {
    vi.stubGlobal(
      'Uint8Array',
      Object.getPrototypeOf(Buffer.prototype).constructor,
    );
    const world = station();
    await world.busy();
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      world.app.request(new Request(input, init)),
    );
    activeChatsStore.initChat(sessionId, {
      agentSlug: AGENT,
      agentName: 'Claude',
      title: 'Inbox',
      conversationId: CONVERSATION,
    });
    activeChatsStore.updateChat(sessionId, {
      status: 'sending',
      orchestrationProvider: 'acp',
      currentSessionId: 'fixture-execution',
      openTurnId: 'fixture-turn',
      messages: [],
      input: 'ordinary follow-up',
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, enabled: false } },
    });
    const mounted = render(
      <QueryClientProvider client={client}>
        <SDKProvider value={{ apiBase, contexts: {}, hooks: {} }}>
          <ActiveChatsProvider>
            <Composer />
          </ActiveChatsProvider>
        </SDKProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(world.inbox.list(CONVERSATION)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'ordinary follow-up',
            state: 'queued',
          }),
        ]),
      ),
    );
    expect(activeChatsStore.getSnapshot()[sessionId]?.queuedMessages).toEqual(
      [],
    );
    world.adapter.complete();
    await waitFor(() =>
      expect(world.prompts()).toContain('ordinary follow-up'),
    );
    expect(
      world.prompts().filter((text) => text === 'ordinary follow-up'),
    ).toHaveLength(1);
    mounted.unmount();
    client.clear();
  });

  test('queues a busy follow-up through SDK and Hono for an independent reader', async () => {
    // SQLite returns Node-realm blobs; use that realm's byte-array constructor.
    vi.stubGlobal(
      'Uint8Array',
      Object.getPrototypeOf(Buffer.prototype).constructor,
    );
    const world = station();
    await world.busy();
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      world.app.request(new Request(input, init)),
    );
    activeChatsStore.initChat(sessionId, {
      agentSlug: AGENT,
      agentName: 'Claude',
      title: 'Inbox',
      conversationId: CONVERSATION,
    });
    activeChatsStore.updateChat(sessionId, {
      status: 'sending',
      orchestrationProvider: 'claude',
      currentSessionId: 'fixture-execution',
      openTurnId: 'fixture-turn',
      messages: [],
      input: 'then summarize',
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, enabled: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <SDKProvider value={{ apiBase, contexts: {}, hooks: {} }}>
          <ActiveChatsProvider>{children}</ActiveChatsProvider>
        </SDKProvider>
      </QueryClientProvider>
    );
    const mounted = render(<Composer />, { wrapper });
    const textbox = await screen.findByRole('textbox');
    fireEvent.click(screen.getByRole('button', { name: /Send mode:/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Queue for next turn' }),
    );
    fireEvent.keyDown(textbox, {
      key: 'Enter',
      ctrlKey: true,
    });
    await waitFor(async () => {
      const response = await world.listInbox(READER);
      const body = await response.json();
      expect(body.data.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'then summarize',
            state: 'queued',
          }),
        ]),
      );
    });
    fireEvent.change(textbox, { target: { value: 'then explain' } });
    fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(world.inbox.list(CONVERSATION)).toHaveLength(2));
    // READER is the existing fixture's scoped caller switch, not authentication coverage.
    const response = await world.listInbox(READER);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'then summarize', state: 'queued' }),
      ]),
    );
    expect(activeChatsStore.getSnapshot()[sessionId]?.queuedMessages).toEqual(
      [],
    );
    mounted.unmount();
    client.clear();
    // A fresh client cache models a second view and a reload. This uses the
    // fixture's route caller, rather than proving browser authentication.
    const scope = {
      apiBase,
      authorityKey: 'reader',
      requiresEnrolledCredential: false,
      isCurrent: () => true,
    };
    setClientCredentialResolver(() => ({
      origin: apiBase,
      requestAuthority: scope,
    }));
    const makeClient = () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
    const firstClient = makeClient();
    const secondClient = makeClient();
    const reader = (readerClient: QueryClient) => (
      <QueryClientProvider client={readerClient}>
        <ActiveChatsProvider>
          <ConversationInboxMessages
            conversationId={CONVERSATION}
            sessionId={sessionId}
            messages={[]}
          />
        </ActiveChatsProvider>
      </QueryClientProvider>
    );
    const first = render(reader(firstClient));
    const second = render(reader(secondClient));
    await within(first.container).findByText('2 pending');
    await within(second.container).findByText('2 pending');
    fireEvent.click(
      within(first.container).getByRole('button', {
        name: '2 pending messages',
      }),
    );
    fireEvent.click(
      within(first.container).getByRole('button', {
        name: 'Remove held message: then summarize',
      }),
    );
    await within(first.container).findByText('1 pending');
    await secondClient.refetchQueries({ queryKey: ['conversation-inbox'] });
    await within(second.container).findByText('1 pending');
    first.unmount();
    firstClient.clear();
    const reloadedClient = makeClient();
    const reloaded = render(reader(reloadedClient));
    await within(reloaded.container).findByText('1 pending');
    world.adapter.complete();
    await waitFor(() => expect(world.prompts()).toContain('then explain'));
    expect(world.prompts()).not.toContain('then summarize');
    await Promise.all(
      [secondClient, reloadedClient].map((c) =>
        c.refetchQueries({ queryKey: ['conversation-inbox'] }),
      ),
    );
    await waitFor(() => {
      expect(within(second.container).queryByText('1 pending')).toBeNull();
      expect(within(reloaded.container).queryByText('1 pending')).toBeNull();
    });
    expect(
      world.prompts().filter((text) => text === 'then explain'),
    ).toHaveLength(1);
    second.unmount();
    reloaded.unmount();
    secondClient.clear();
    reloadedClient.clear();
  });
});
