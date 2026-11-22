import { STEERING_ENGINE_DURABILITY } from '@kontourai/station-contracts/engine-capability-matrix';
/** @vitest-environment jsdom */

import { SDKProvider } from '@kontourai/station-sdk';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { type ReactNode, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
import { useOutboundQueueFlush } from '../hooks/useOutboundQueueFlush';
import {
  _resetOutboundQueueStorage,
  _setOutboundQueueStorage,
  outboundDispatch,
} from '../lib/outboundQueue';

const connection = vi.hoisted(() => ({ status: 'connected' }));
const requestScope = vi.hoisted(() => ({
  apiBase: 'http://inbox.station',
  authorityKey: 'reader',
  requiresEnrolledCredential: false,
  isCurrent: () => true,
}));

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
    requestScope,
  }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://inbox.station' }),
  useHostRequestAuthorityScope: () => requestScope,
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnectionStatus: () => connection,
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

function Flush() {
  useOutboundQueueFlush(apiBase);
  return null;
}

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
        activeSession={{
          id: sessionId,
          agentSlug: AGENT,
          agentName: 'Claude',
          title: 'Inbox',
          conversationId: sessions[sessionId]?.conversationId,
          currentSessionId: sessions[sessionId]?.currentSessionId,
          orchestrationDurability: sessions[sessionId]?.orchestrationDurability,
          openTurnId: sessions[sessionId]?.openTurnId,
          messages: sessions[sessionId]?.messages ?? [],
          input: sessions[sessionId]?.input ?? '',
          attachments: sessions[sessionId]?.attachments ?? [],
          queuedMessages: sessions[sessionId]?.queuedMessages ?? [],
          status: sessions[sessionId]?.status ?? 'idle',
          createdAt: 0,
          inputHistory: [],
          requestedModel: sessions[sessionId]?.requestedModel ?? undefined,
          source: 'manual',
          updatedAt: 0,
        }}
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
  beforeEach(() => {
    setClientCredentialResolver(() => ({
      origin: apiBase,
      requestAuthority: requestScope,
    }));
  });
  afterEach(() => {
    cleanup();
    activeChatsStore.removeChat(sessionId);
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _resetOutboundQueueStorage();
  });

  // A send Station refuses because an earlier start on this Session is held
  // (the real route's answer). Where the notice says the message went is
  // where the code put it: the composer for a direct send, the pending list
  // for an outbox send.
  for (const path of ['direct send', 'outbox send'] as const) {
    test(`a held refusal of a ${path} says where the message is`, async () => {
      vi.stubGlobal(
        'Uint8Array',
        Object.getPrototypeOf(Buffer.prototype).constructor,
      );
      let stored: unknown;
      _setOutboundQueueStorage({
        getItem: async () => stored,
        setItem: async (_key, value) => {
          stored = value;
        },
        updateItem: async (_key, updater) => {
          stored = updater(stored);
        },
      });
      const { OrchestrationService } = await import(
        '../../../src-server/services/orchestration/orchestration-service'
      );
      const { SessionTurnStartHeldError } = await import(
        '../../../src-server/services/orchestration/session-execution-coordinator'
      );
      const dispatchWithReceipt =
        OrchestrationService.prototype.dispatchWithReceipt;
      vi.spyOn(
        OrchestrationService.prototype,
        'dispatchWithReceipt',
      ).mockImplementation(function (
        this: InstanceType<typeof OrchestrationService>,
        ...args: Parameters<typeof dispatchWithReceipt>
      ) {
        const [command] = args;
        if (command.type === 'sendTurn')
          return Promise.reject(
            new SessionTurnStartHeldError(command.input.threadId, true),
          );
        return dispatchWithReceipt.apply(this, args);
      });
      const world = station();
      // The outbox send: the first request gets no answer (offline), so its
      // row is released for Station's lookup and replayed on reconnect.
      let online = path === 'direct send';
      vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
      connection.status = online ? 'connected' : 'disconnected';
      const posts: string[] = [];
      vi.stubGlobal(
        'fetch',
        async (input: RequestInfo | URL, init?: RequestInit) => {
          if (!online) throw new TypeError('network unavailable');
          const request = new Request(input, init);
          if (request.method === 'POST')
            posts.push(new URL(request.url).pathname);
          return world.app.request(request);
        },
      );
      activeChatsStore.initChat(sessionId, {
        agentSlug: AGENT,
        agentName: 'Claude',
        title: 'Inbox',
        conversationId: CONVERSATION,
      });
      activeChatsStore.updateChat(sessionId, {
        status: 'idle',
        orchestrationProvider: 'claude',
        orchestrationDurability: STEERING_ENGINE_DURABILITY,
        currentSessionId: 'fixture-execution',
        messages: [],
        input: 'held follow-up',
      });
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, enabled: false } },
      });
      const tree = () => (
        <QueryClientProvider client={client}>
          <SDKProvider value={{ apiBase, contexts: {}, hooks: {} }}>
            <ActiveChatsProvider>
              <Flush />
              <Composer />
            </ActiveChatsProvider>
          </SDKProvider>
        </QueryClientProvider>
      );
      const mounted = render(tree());
      fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
      if (path === 'outbox send') {
        await waitFor(async () =>
          expect(await outboundDispatch.snapshot()).toEqual([
            expect.objectContaining({
              content: 'held follow-up',
              awaitingLookup: true,
            }),
          ]),
        );
        online = true;
        connection.status = 'connected';
        mounted.rerender(tree());
        fireEvent(window, new Event('online'));
      }
      const notices = () =>
        (activeChatsStore.getSnapshot()[sessionId]?.ephemeralMessages ?? [])
          .map((message) => String(message.content))
          .filter((content) => content.includes('may still be running'));
      await waitFor(() => expect(notices()).toHaveLength(1));
      const chat = activeChatsStore.getSnapshot()[sessionId];
      const outbox = await outboundDispatch.snapshot();
      if (path === 'direct send') {
        expect(posts).toEqual(['/api/orchestration/chat']);
        expect(chat?.input).toBe('held follow-up');
        expect(outbox).toEqual([]);
        expect(notices()[0]).toContain('Your message is back in the composer.');
        expect(notices()[0]).not.toContain('pending');
      } else {
        // The replay is the outbox's own request; it adds no second row and
        // no second notice.
        expect(posts).toEqual(['/api/orchestration/chat/background']);
        expect(chat?.input ?? '').toBe('');
        expect(outbox).toEqual([
          expect.objectContaining({ content: 'held follow-up' }),
        ]);
        expect(notices()[0]).toContain(
          'Your message is kept in the pending list.',
        );
        expect(notices()[0]).not.toContain('composer');
      }
      expect(world.inbox.list(CONVERSATION)).toEqual([]);
      mounted.unmount();
      client.clear();
      connection.status = 'connected';
    });
  }

  test('reconnect hands an offline busy send to the durable inbox', async () => {
    vi.stubGlobal(
      'Uint8Array',
      Object.getPrototypeOf(Buffer.prototype).constructor,
    );
    let stored: unknown;
    _setOutboundQueueStorage({
      getItem: async () => stored,
      setItem: async (_key, value) => {
        stored = value;
      },
      updateItem: async (_key, updater) => {
        stored = updater(stored);
      },
    });
    const world = station();
    await world.busy();
    let online = false;
    let submissions = 0;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    connection.status = 'disconnected';
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (!online) return Promise.reject(new TypeError('network unavailable'));
      const request = new Request(input, init);
      if (
        request.method === 'POST' &&
        [
          '/api/orchestration/chat',
          '/api/orchestration/chat/background',
        ].includes(new URL(request.url).pathname)
      )
        submissions++;
      return world.app.request(request);
    });
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
      input: 'offline follow-up',
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, enabled: false } },
    });
    const tree = () => (
      <QueryClientProvider client={client}>
        <SDKProvider value={{ apiBase, contexts: {}, hooks: {} }}>
          <ActiveChatsProvider>
            <Flush />
            <Composer />
          </ActiveChatsProvider>
        </SDKProvider>
      </QueryClientProvider>
    );
    const mounted = render(tree());
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    await waitFor(async () =>
      expect(await outboundDispatch.snapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            content: 'offline follow-up',
            status: 'invoking',
          }),
        ]),
      ),
    );
    expect(world.inbox.list(CONVERSATION)).toHaveLength(0);
    await waitFor(() =>
      expect(activeChatsStore.getSnapshot()[sessionId]?.status).toBe('queued'),
    );
    act(() =>
      activeChatsStore.updateChat(sessionId, {
        status: 'sending',
        conversationActivity: {
          conversationId: CONVERSATION,
          asOfSequence: 1,
          openTurn: {
            turnId: 'fixture-turn',
            threadId: 'fixture-execution',
            startedAt: '2026-10-15T00:00:00.000Z',
            trigger: 'provider',
          },
        },
      }),
    );
    online = true;
    connection.status = 'connected';
    mounted.rerender(tree());
    fireEvent(window, new Event('online'));
    await waitFor(async () =>
      expect({
        inbox: world.inbox.list(CONVERSATION),
        outbox: await outboundDispatch.snapshot(),
      }).toMatchObject({
        inbox: [
          expect.objectContaining({
            message: 'offline follow-up',
            state: 'queued',
          }),
        ],
      }),
    );
    expect(submissions).toBe(1);
    const response = await world.listInbox(READER);
    expect((await response.json()).data.entries).toEqual([
      expect.objectContaining({ message: 'offline follow-up' }),
    ]);
    await waitFor(async () =>
      expect(await outboundDispatch.snapshot()).toEqual([]),
    );
    world.adapter.complete();
    await waitFor(() =>
      expect(
        world.prompts().filter((text) => text === 'offline follow-up'),
      ).toHaveLength(1),
    );
    await waitFor(() =>
      expect(
        world.inbox
          .list(CONVERSATION)
          .filter((entry) => entry.state === 'queued'),
      ).toHaveLength(0),
    );
    mounted.unmount();
    client.clear();
  });

  test('ordinary Send queues if a native turn starts while the draft is being prepared', async () => {
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
      status: 'idle',
      orchestrationProvider: 'claude',
      orchestrationDurability: STEERING_ENGINE_DURABILITY,
      currentSessionId: 'fixture-execution',
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
    const send = await screen.findByRole('button', { name: 'Send' });
    expect(
      screen.queryByRole('button', { name: 'Stop the current turn' }),
    ).toBeNull();
    act(() => {
      fireEvent.click(send);
      activeChatsStore.updateChat(sessionId, {
        status: 'sending',
        openTurnId: 'fixture-turn',
      });
    });
    await waitFor(() =>
      expect(world.inbox.list(CONVERSATION)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'ordinary follow-up',
            state: 'queued',
            kind: 'follow-up',
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

  test('shows a queued receipt while the list refresh waits and shares the entry with another reader', async () => {
    // SQLite returns Node-realm blobs; use that realm's byte-array constructor.
    vi.stubGlobal(
      'Uint8Array',
      Object.getPrototypeOf(Buffer.prototype).constructor,
    );
    const world = station();
    await world.busy();
    let holdInboxReads = false;
    let refuseInboxReads = false;
    let heldRead: Request | undefined;
    let releaseReads!: () => void;
    const readsReleased = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const inboxRead =
          request.method === 'GET' &&
          new URL(request.url).pathname.endsWith('/inbox');
        if (inboxRead && refuseInboxReads)
          return new Response(null, { status: 404 });
        const response = await world.app.request(request);
        if (inboxRead && holdInboxReads) {
          heldRead = request;
          await readsReleased;
        }
        return response;
      },
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
      orchestrationDurability: STEERING_ENGINE_DURABILITY,
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
    await waitFor(() =>
      expect(
        client.getQueryData([
          'conversation-inbox',
          apiBase,
          requestScope.authorityKey,
          CONVERSATION,
        ]),
      ).toEqual([]),
    );
    holdInboxReads = true;
    const refresh = client.refetchQueries({ queryKey: ['conversation-inbox'] });
    try {
      await waitFor(() => expect(heldRead).toBeDefined());
      fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
      fireEvent.click(
        await screen.findByRole('button', { name: '1 pending message' }),
      );
      expect(screen.getByText('then summarize')).toBeTruthy();
      expect(textbox).toHaveProperty('value', '');
      expect(heldRead?.signal.aborted).toBe(false);
    } finally {
      holdInboxReads = false;
      releaseReads();
    }
    await act(async () => await refresh);
    expect(screen.getByText('then summarize')).toBeTruthy();
    refuseInboxReads = true;
    await act(() =>
      client.refetchQueries({ queryKey: ['conversation-inbox'] }),
    );
    expect(
      await screen.findByText('Couldn’t load inbox entries.'),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByText('then summarize')).toBeNull(),
    );
    refuseInboxReads = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('1 pending')).toBeTruthy();
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
