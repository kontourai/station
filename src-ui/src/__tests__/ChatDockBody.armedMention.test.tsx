/**
 * @vitest-environment jsdom
 *
 * The armed path with the composer's real send preparation: a file mention in
 * the draft reaches the handoff expanded to its workspace path, exactly as an
 * ordinary send would carry it, and the ordinary sender is never called.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

const agentsMock = vi.hoisted(() => ({ current: [] as any[] }));
const composerSeen = vi.hoisted(() => ({
  onSend: undefined as undefined | (() => Promise<void>),
  onQueueFollowUp: undefined as undefined | (() => Promise<void>),
  sendBlockedReason: undefined as string | undefined,
  nextMessageHandoff: undefined as
    | undefined
    | { label: string; kind: string; onUndo: () => void },
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'test', name: 'Test Station' },
    captureCredentialEvidence: () => undefined,
  }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => agentsMock.current,
  useAgentsLoaded: () => true,
  useAgent: () => ({ slug: 'station', name: 'Station' }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3242' }),
  useHostRequestAuthorityScope: () => undefined,
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
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
vi.mock('../hooks/useToolApproval', () => ({
  useToolApproval: () => vi.fn(),
}));
const ordinarySend = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => ordinarySend,
  useCancelMessage: () => vi.fn(),
}));
vi.mock('../components/chat/StreamingMessage', () => ({
  StreamingMessage: () => null,
}));
vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span aria-hidden="true">U</span>,
}));
vi.mock('../contexts/ActiveChatsContext', async () => {
  const { activeChatsStore } = await import('../contexts/active-chats-store');
  const actions = {
    updateChat: activeChatsStore.updateChat.bind(activeChatsStore),
    clearInput: activeChatsStore.clearInput.bind(activeChatsStore),
    addToInputHistory:
      activeChatsStore.addToInputHistory.bind(activeChatsStore),
    clearEphemeralMessages: () => {},
    addEphemeralMessage: () => {},
  };
  return {
    activeChatsStore,
    useActiveChatActions: () => actions,
    useActiveChatSelector: (
      sessionId: string,
      selector: (s: unknown) => unknown,
    ) => selector(activeChatsStore.getSnapshot()[sessionId] || null),
  };
});
vi.mock('../contexts/MessageContextContext', () => ({
  useMessageContextContext: () => ({ getComposedContext: () => '' }),
}));
vi.mock('../hooks/useACPConnections', () => ({
  useACPConnections: () => ({ data: [] }),
}));
vi.mock('../hooks/useShareReceiver', () => ({
  useShareReceiver: () => {},
}));
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
// The composer's Send is the seam: capture what ChatDockBody wires to it.
vi.mock('../components/chat/ChatInputArea', () => ({
  ChatInputArea: ({
    onSend,
    onQueueFollowUp,
    sendBlockedReason,
    nextMessageHandoff,
  }: {
    onSend: () => Promise<void>;
    onQueueFollowUp?: () => Promise<void>;
    sendBlockedReason?: string;
    nextMessageHandoff?: { label: string; kind: string; onUndo: () => void };
  }) => {
    composerSeen.onSend = onSend;
    composerSeen.onQueueFollowUp = onQueueFollowUp;
    composerSeen.sendBlockedReason = sendBlockedReason;
    composerSeen.nextMessageHandoff = nextMessageHandoff;
    return <div data-testid="chat-input-area" />;
  },
}));
vi.mock('../components/chat/QueuedMessages', () => ({
  QueuedMessages: () => null,
}));

import { mentionToken } from '../components/chat/composer-mentions';
import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
import { activeChatsStore } from '../contexts/active-chats-store';
import { useChatInput } from '../hooks/useChatInput';
import type { ChatSession } from '../types';

const CHAT = 'armed-mention';
const WORKSPACE = '/work/app';
const AUTHORITY = 'station-authority';

function Harness({ onArmedSend }: { onArmedSend: (p: unknown) => void }) {
  const chatInput = useChatInput({
    apiBase: 'http://localhost:3242',
    sessionId: CHAT,
    agentSlug: 'station',
    conversationId: 'conversation-armed',
    availableModels: [],
    attachmentCapabilities: { images: true, files: true },
    workingDirectory: WORKSPACE,
    mentionAuthority: AUTHORITY,
    mentionRequestScope: {
      apiBase: 'http://localhost:3242',
      authorityKey: AUTHORITY,
      isCurrent: () => true,
    },
  });
  const session = {
    agentName: 'Station',
    title: 'armed',
    source: 'manual',
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    ...(activeChatsStore.getSnapshot()[CHAT] as object),
    id: CHAT,
    agentSlug: agentId('station'),
    conversationId: 'conversation-armed',
  } as unknown as ChatSession;
  return (
    <ChatDockBody
      activeSession={session}
      chatFontSize={14}
      dockHeight={400}
      showStatsPanel={false}
      showReasoning={false}
      showToolDetails={false}
      modelSupportsAttachments={false}
      fileAttachmentsSupported={false}
      availableModels={[]}
      nextMessageHandoff={{
        label: 'Codex',
        kind: 'agent',
        pending: false,
        onSend: onArmedSend,
        onUndo: () => {},
      }}
      chatInput={chatInput as any}
      setShowStatsPanel={vi.fn()}
    />
  );
}

test('an armed send carries the draft prepared by the real composer pipeline', async () => {
  agentsMock.current = [
    { slug: agentId('station'), name: 'Station', available: true },
  ];
  activeChatsStore.removeChat(CHAT);
  activeChatsStore.initChat(CHAT, {
    agentSlug: 'station',
    agentName: 'Station',
    title: 'armed',
    conversationId: 'conversation-armed',
  });
  const token = mentionToken({
    label: 'notes.md',
    path: 'docs/notes.md',
    workspace: WORKSPACE,
    authority: AUTHORITY,
    type: 'file',
  });
  activeChatsStore.updateChat(CHAT, { input: `Read ${token} please` });
  const onArmedSend = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <Harness onArmedSend={onArmedSend} />
    </QueryClientProvider>,
  );
  await screen.findByTestId('chat-input-area');
  await act(async () => {
    await composerSeen.onSend?.();
  });
  expect(onArmedSend).toHaveBeenCalledOnce();
  const prepared = onArmedSend.mock.calls[0][0] as {
    text: string;
    draft: string;
  };
  expect(prepared.text).toBe('Read @"/work/app/docs/notes.md" please');
  expect(prepared.draft).toBe(`Read ${token} please`);
  expect(ordinarySend).not.toHaveBeenCalled();
});
