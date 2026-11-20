// @vitest-environment jsdom
/**
 * The dock's handoff wiring, through the real hook and dialogs: Continue
 * sends the composer's draft as the ordinary send would prepare it (quotes
 * composed in) and clears exactly that draft on acceptance; each open is its
 * own dialog, so one chat's request state never appears in another's picker;
 * a picker whose chat is closed is dropped; cancelling the engine picker
 * returns focus to the composer.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConversationBoundaryDialogs } from '../components/chat-dock/ConversationBoundaryDialogs';
import { useConversationBoundaryDialogs } from '../components/chat-dock/useConversationBoundaryDialogs';
import {
  ActiveChatsProvider,
  activeChatsStore,
} from '../contexts/ActiveChatsContext';
import { chatDraftsStore } from '../contexts/chat-drafts-store';
import type { ChatSession } from '../types';

const handoffExecutionMessage = vi.fn();
/** What the stubbed Station section reports when Finish is pressed. */
const station = vi.hoisted(() => ({ result: undefined as unknown }));
// The Station picker's own behavior has its own tests; here it only reports
// a chosen result so the dock's wiring of that result is what is tested.
vi.mock(
  '../components/chat-dock/ConversationStationHandoff',
  async (importOriginal) => {
    const React = await import('react');
    return {
      ...(await importOriginal<
        typeof import('../components/chat-dock/ConversationStationHandoff')
      >()),
      ConversationStationChoice: ({
        onChange,
      }: {
        onChange: (id: string) => void;
      }) =>
        React.createElement(
          'button',
          { type: 'button', onClick: () => onChange('receiver') },
          'Choose Receiver',
        ),
      ConversationStationHandoff: ({
        onContinued,
      }: {
        onContinued: (result: unknown) => void;
      }) =>
        React.createElement(
          'button',
          { type: 'button', onClick: () => onContinued(station.result) },
          'Finish on Receiver',
        ),
    };
  },
);
vi.mock('@kontourai/station-sdk/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk/client')>()),
  handoffExecutionMessage: (...args: unknown[]) =>
    handoffExecutionMessage(...args),
  getConversationHandoffStatus: vi.fn(),
}));
vi.mock('../lib/outboundQueue', () => ({
  outboundDispatch: {
    fenceConversationHandoff: async (
      _input: unknown,
      effect: () => Promise<unknown>,
    ) => ({ status: 'completed', value: await effect() }),
  },
}));
vi.mock('../hooks/useOutboundQueueSnapshot', () => ({
  useOutboundQueueSnapshot: () => ({ status: 'ready', turns: [] }),
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useConversationContextBoundaryStatusQuery: () => ({ data: undefined }),
}));
vi.mock('../hooks/useNewChatSelectionModel', () => ({
  useNewChatSelectionModel: () => ({
    agentConnections: ['claude', 'codex'].map((id) => ({
      id,
      kind: 'agent',
      enabled: true,
      status: 'ready',
      capabilities: ['agent-runtime'],
    })),
    selectedProjectConfig: { agents: ['claude', 'codex'] },
    modelsForAgent: () => [{ id: 'gpt-5', name: 'GPT-5' }],
    defaultEffectiveModelForAgent: () => ({ id: 'gpt-5' }),
  }),
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
});

const agents = [
  {
    slug: 'claude',
    name: 'Claude',
    available: true,
    execution: { agentConnectionId: 'claude' },
  },
  {
    slug: 'codex',
    name: 'Codex reviewer',
    available: true,
    execution: { agentConnectionId: 'codex' },
  },
];
const chat = (id: string, conversationId: string) =>
  ({
    id,
    agentSlug: 'claude',
    conversationId,
    projectSlug: 'project-a',
    status: 'idle',
    messages: [],
    queuedMessages: [],
  }) as unknown as ChatSession;
const chatA = chat('chat-a', 'conversation-a');
const chatB = chat('chat-b', 'conversation-b');

function receipt() {
  return {
    handoff: {
      predecessorSessionId: 'session-a',
      sessionId: 'session-b',
      currentSessionId: 'session-b',
      outcome: 'created',
      target: {
        agentId: 'codex',
        engine: { kind: 'connection', connectionId: 'codex' },
        modelId: 'gpt-5',
      },
      carried: [],
      reset: [],
    },
  };
}

function Pane({
  active,
  sessions = [chatA, chatB],
  chatInput,
  onState,
  continueOnStation,
}: {
  active: ChatSession;
  sessions?: ChatSession[];
  chatInput: Record<string, unknown>;
  onState: (state: ReturnType<typeof useConversationBoundaryDialogs>) => void;
  continueOnStation?: (result: unknown, title?: string) => void;
}) {
  const dialogs = useConversationBoundaryDialogs({
    agents: agents as never,
    apiBase: 'http://station.test',
    activeSession: active,
    allSessions: sessions,
  });
  onState(dialogs);
  return (
    <ConversationBoundaryDialogs
      dialogs={dialogs}
      apiBase="http://station.test"
      agents={agents as never}
      projects={[{ slug: 'project-a', name: 'Project A' }] as never}
      activeSession={active}
      activeOrchestrationSession={null}
      activeOrchestrationSessionRead="absent"
      chatInput={chatInput as never}
      composerMenuTriggerRef={{ current: null }}
      updateChat={activeChatsStore.updateChat.bind(activeChatsStore)}
      focusSessionInPane={vi.fn()}
      invalidate={vi.fn()}
      showToast={vi.fn()}
      refetchOrchestrationSessions={vi.fn() as never}
      {...(continueOnStation ? { continueOnStation } : {})}
    />
  );
}

function mount(
  active: ChatSession,
  overrides: Record<string, unknown> = {},
  continueOnStation?: (result: unknown, title?: string) => void,
) {
  let latest!: ReturnType<typeof useConversationBoundaryDialogs>;
  const textarea = { current: document.createElement('textarea') };
  document.body.append(textarea.current);
  const chatInput = {
    input: '',
    attachments: [],
    quotes: [],
    textareaRef: textarea,
    prepareOutgoingText: vi.fn(async () => ({
      text: '',
      draft: '',
      quotes: [],
    })),
    handleClearInput: vi.fn(),
    handleClearAttachments: vi.fn(),
    ...overrides,
  };
  const tree = (next: ChatSession, sessions?: ChatSession[]) => (
    <ActiveChatsProvider>
      <Pane
        active={next}
        sessions={sessions}
        chatInput={chatInput}
        continueOnStation={continueOnStation}
        onState={(state) => {
          latest = state;
        }}
      />
    </ActiveChatsProvider>
  );
  const view = render(tree(active));
  return {
    get: () => latest,
    show: (next: ChatSession, sessions?: ChatSession[]) =>
      view.rerender(tree(next, sessions)),
    textarea,
    chatInput,
  };
}

describe('dock handoff wiring', () => {
  beforeEach(() => {
    handoffExecutionMessage.mockReset();
    sessionStorage.clear();
    for (const id of ['chat-a', 'chat-b']) activeChatsStore.removeChat(id);
    activeChatsStore.initChat('chat-a', {
      agentSlug: 'claude',
      agentName: 'Claude',
      title: 'A',
      conversationId: 'conversation-a',
    });
  });

  test('Continue sends the prepared draft and, once accepted, clears it and its quotes', async () => {
    handoffExecutionMessage.mockResolvedValueOnce(receipt());
    const quote = {
      version: 1 as const,
      origin: 'http://station.test',
      sessionId: 'chat-a',
      turnId: 't',
      messageId: 'm',
      revision: 'a'.repeat(64),
      excerpt: 'the quoted answer',
    };
    chatDraftsStore.addQuote('chat-a', quote);
    const quotes = chatDraftsStore.getQuotes('chat-a');
    const pane = mount(chatA, {
      input: 'Pick this up',
      quotes,
      prepareOutgoingText: vi.fn(async () => ({
        text: '> the quoted answer\n\nPick this up',
        draft: 'Pick this up',
        quotes,
      })),
    });
    act(() => pane.get().openConversationHandoff(null));
    fireEvent.click(screen.getByRole('radio', { name: /Codex reviewer/ }));
    expect(
      screen.getByText('Your draft is sent as the first message.'),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Codex reviewer' }),
    );
    await waitFor(() => expect(pane.get().handoffSource).toBeNull());
    expect(handoffExecutionMessage.mock.calls[0][2].message).toBe(
      '> the quoted answer\n\nPick this up',
    );
    expect(pane.chatInput.handleClearInput).toHaveBeenCalledOnce();
    // A handoff never carries attachments: they (and uploads) stay put.
    expect(pane.chatInput.handleClearAttachments).not.toHaveBeenCalled();
    expect(chatDraftsStore.getQuotes('chat-a')).toHaveLength(0);
  });

  test('a new open is a new dialog: no earlier request state carries into it', async () => {
    handoffExecutionMessage.mockReturnValue(new Promise(() => {}));
    const pane = mount(chatA);
    act(() => pane.get().openConversationHandoff(null));
    fireEvent.click(screen.getByRole('radio', { name: /Codex reviewer/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Codex reviewer' }),
    );
    await screen.findByRole('button', { name: 'Continuing…' });
    // The same component position receives another chat's source.
    act(() =>
      pane.get().setHandoffSource({
        id: 'conversation-b',
        agentSlug: 'claude',
        nonce: 99,
      }),
    );
    pane.show(chatB);
    expect(screen.queryByRole('button', { name: 'Continuing…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry safely' })).toBeNull();
  });

  test('a picker whose chat is closed is dropped', async () => {
    const pane = mount(chatA);
    act(() => pane.get().openConversationHandoff(null));
    expect(pane.get().handoffSource?.id).toBe('conversation-a');
    pane.show(chatB, [chatB]);
    await waitFor(() => expect(pane.get().handoffSource).toBeNull());
  });

  test('cancelling the engine picker returns focus to the composer', async () => {
    const pane = mount(chatA);
    act(() => pane.get().openExecutionHandoff());
    fireEvent.click(
      await screen.findByRole('button', { name: 'Cancel engine change' }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(pane.textarea.current),
    );
  });

  describe('continuing on a paired Station', () => {
    const quote = {
      version: 1 as const,
      origin: 'http://station.test',
      sessionId: 'chat-a',
      turnId: 't',
      messageId: 'm',
      revision: 'b'.repeat(64),
      excerpt: 'quoted for the Station',
    };
    beforeEach(() =>
      chatDraftsStore.consumeQuotes(
        'chat-a',
        chatDraftsStore.getQuotes('chat-a'),
      ),
    );
    const result = (clearsComposer: boolean) => ({
      connection: { stationName: 'Receiver' },
      receipt: { conversationId: 'conversation:import:x' },
      agentSlug: 'claude',
      message: 'Pick this up there',
      clearsComposer,
      sentQuotes: [quote],
    });

    test('an active chat whose draft was sent clears it and its quotes, and keeps attachments', async () => {
      chatDraftsStore.addQuote('chat-a', quote);
      station.result = result(true);
      const continueOnStation = vi.fn();
      const pane = mount(chatA, {}, continueOnStation);
      act(() => pane.get().openConversationHandoff(null));
      fireEvent.click(screen.getByRole('button', { name: 'Choose Receiver' }));
      fireEvent.click(
        screen.getByRole('button', { name: 'Finish on Receiver' }),
      );
      await waitFor(() => expect(pane.get().handoffSource).toBeNull());
      expect(continueOnStation).toHaveBeenCalledWith(station.result, undefined);
      expect(pane.chatInput.handleClearInput).toHaveBeenCalledOnce();
      expect(pane.chatInput.handleClearAttachments).not.toHaveBeenCalled();
      expect(chatDraftsStore.getQuotes('chat-a')).toHaveLength(0);
    });

    test('a draft the Station handoff did not send stays in the composer', async () => {
      chatDraftsStore.addQuote('chat-a', quote);
      station.result = result(false);
      const continueOnStation = vi.fn();
      const pane = mount(chatA, {}, continueOnStation);
      act(() => pane.get().openConversationHandoff(null));
      fireEvent.click(screen.getByRole('button', { name: 'Choose Receiver' }));
      fireEvent.click(
        screen.getByRole('button', { name: 'Finish on Receiver' }),
      );
      await waitFor(() => expect(continueOnStation).toHaveBeenCalledOnce());
      expect(pane.chatInput.handleClearInput).not.toHaveBeenCalled();
      expect(chatDraftsStore.getQuotes('chat-a')).toHaveLength(1);
    });

    test("another chat's Station handoff leaves this composer alone", async () => {
      chatDraftsStore.addQuote('chat-a', quote);
      station.result = result(true);
      const continueOnStation = vi.fn();
      const pane = mount(chatA, {}, continueOnStation);
      act(() =>
        pane.get().setHandoffSource({
          id: 'conversation-b',
          agentSlug: 'claude',
          nonce: 7,
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Choose Receiver' }));
      fireEvent.click(
        screen.getByRole('button', { name: 'Finish on Receiver' }),
      );
      await waitFor(() => expect(continueOnStation).toHaveBeenCalledOnce());
      expect(pane.chatInput.handleClearInput).not.toHaveBeenCalled();
      expect(chatDraftsStore.getQuotes('chat-a')).toHaveLength(1);
    });
  });
});
