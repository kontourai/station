/** @vitest-environment jsdom */

import { SDKProvider } from '@kontourai/station-sdk';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ReactNode, useRef } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  AGENT,
  CONVERSATION,
  createInboxHarness,
  READER,
} from '../../../src-server/routes/orchestration/__tests__/helpers/thread-inbox-harness';
import { ChatInputArea } from '../components/chat/ChatInputArea';
import { ConversationInboxMessages } from '../components/chat/ConversationInboxMessages';
import { ActiveChatsProvider } from '../contexts/ActiveChatsContext';
import { activeChatsStore } from '../contexts/active-chats-store';
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const noop = () => {};
  return (
    <ChatInputArea
      input={chat.input}
      attachments={[]}
      textareaRef={textareaRef}
      disabled={false}
      turnInFlight
      busyFollowUp="queue"
      onQueueFollowUp={() =>
        chat.handleSend(undefined, undefined, { queueOnBusy: true })
      }
      modelSupportsAttachments
      fontSize={14}
      dockHeight={600}
      canModelSelect={false}
      availableModels={[]}
      modelQuery={null}
      commandQuery={null}
      slashCommands={[]}
      onInputChange={noop}
      onSend={async () => {}}
      onCancel={noop}
      onClearInput={noop}
      onRemoveAttachment={noop}
      onClearAttachments={noop}
      onModelSelect={noop}
      onModelReset={noop}
      onModelClose={noop}
      onModelOpen={noop}
      onModelRuntimeOptionChange={noop}
      onApprovalModeChange={noop}
      onCommandSelect={async () => {}}
      onCommandClose={noop}
      onHistoryUp={noop}
      onHistoryDown={noop}
      updateFromInput={noop}
      closeAll={noop}
    />
  );
}

describe('mounted composer inbox handoff (test-scoped caller)', () => {
  const station = createInboxHarness();
  afterEach(() => {
    activeChatsStore.removeChat(sessionId);
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
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
    fireEvent.keyDown(screen.getByRole('textbox'), {
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
    const readerClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const reader = () => (
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
    const view = render(reader());
    await screen.findByText('1 pending');
    view.unmount();
    readerClient.clear();
    const reloaded = render(reader());
    await screen.findByText('1 pending');
    world.adapter.complete();
    await waitFor(() =>
      expect(world.inbox.list(CONVERSATION)[0]?.state).toBe('sent'),
    );
    await readerClient.refetchQueries({ queryKey: ['conversation-inbox'] });
    await waitFor(() => expect(screen.queryByText('1 pending')).toBeNull());
    reloaded.unmount();
    readerClient.clear();
  });
});
