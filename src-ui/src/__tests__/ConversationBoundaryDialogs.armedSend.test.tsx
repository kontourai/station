// @vitest-environment jsdom
/**
 * An armed send belongs to the chat it was typed in. While it dispatches the
 * person may open another chat: the request keeps running out of sight, any
 * question it raises waits until they return to its chat, and its acceptance
 * clears that chat's draft without pulling them back to it.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { armedHandoffStore } from '../components/chat-dock/armedHandoffStore';
import { ConversationBoundaryDialogs } from '../components/chat-dock/ConversationBoundaryDialogs';
import { useConversationBoundaryDialogs } from '../components/chat-dock/useConversationBoundaryDialogs';
import {
  ActiveChatsProvider,
  activeChatsStore,
} from '../contexts/ActiveChatsContext';
import type { ChatSession } from '../types';

const handoffExecutionMessage = vi.fn();
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

function renderBoundary(activeSession: ChatSession) {
  const setHandoffSource = vi.fn();
  const setArmedHandoff = vi.fn();
  const focusSessionInPane = vi.fn();
  const dialogs = {
    handoffSource: {
      id: 'conversation-a',
      agentSlug: 'claude',
      nonce: 1,
      autoSubmit: {
        message: 'The armed draft',
        targetId: 'codex',
        modelId: 'gpt-5',
      },
      armedDraft: { sessionId: 'chat-a', draft: 'The armed draft', quotes: [] },
    },
    setHandoffSource,
    handoffSession: chatA,
    handoffDisabledReason: undefined,
    handoffReturnFocusRef: { current: null },
    setArmedHandoff,
    contextResetSource: null,
  } as never;
  const props = {
    dialogs,
    apiBase: 'http://station.test',
    agents: agents as never,
    projects: [{ slug: 'project-a', name: 'Project A' }] as never,
    activeOrchestrationSession: null,
    activeOrchestrationSessionRead: 'absent' as const,
    chatInput: {
      input: '',
      attachments: [],
      quotes: [],
      textareaRef: { current: null },
      prepareOutgoingText: vi.fn(),
      handleClearInput: vi.fn(),
      handleClearAttachments: vi.fn(),
    } as never,
    composerMenuTriggerRef: { current: null },
    updateChat: activeChatsStore.updateChat.bind(activeChatsStore),
    focusSessionInPane,
    invalidate: vi.fn(),
    showToast: vi.fn(),
    refetchOrchestrationSessions: vi.fn() as never,
  };
  const view = render(
    <ActiveChatsProvider>
      <ConversationBoundaryDialogs {...props} activeSession={activeSession} />
    </ActiveChatsProvider>,
  );
  return {
    ...view,
    setHandoffSource,
    setArmedHandoff,
    focusSessionInPane,
    show: (next: ChatSession) =>
      view.rerender(
        <ActiveChatsProvider>
          <ConversationBoundaryDialogs {...props} activeSession={next} />
        </ActiveChatsProvider>,
      ),
  };
}

describe('an armed send while the person is in another chat', () => {
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
    activeChatsStore.updateChat('chat-a', { input: 'The armed draft' });
    activeChatsStore.initChat('chat-b', {
      agentSlug: 'claude',
      agentName: 'Claude',
      title: 'B',
      conversationId: 'conversation-b',
    });
  });

  test('acceptance clears its own chat’s draft and leaves the person where they are', async () => {
    let accept: (value: unknown) => void = () => {};
    handoffExecutionMessage.mockReturnValueOnce(
      new Promise((resolve) => {
        accept = resolve;
      }),
    );
    const view = renderBoundary(chatA);
    await waitFor(() => expect(handoffExecutionMessage).toHaveBeenCalled());
    // The person opens another chat while the switch is in flight.
    view.show(chatB);
    accept(receipt());
    await waitFor(() =>
      expect(view.setArmedHandoff).toHaveBeenCalledWith(null, 'conversation-a'),
    );
    expect(view.focusSessionInPane).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()['chat-a']?.input ?? '').toBe('');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('an unconfirmed outcome waits for its own chat instead of covering another', async () => {
    handoffExecutionMessage.mockRejectedValueOnce(new TypeError('lost'));
    const view = renderBoundary(chatB);
    await waitFor(() => expect(handoffExecutionMessage).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('dialog')).toBeNull();
    view.show(chatA);
    expect(
      await screen.findByRole('button', { name: 'Retry safely' }),
    ).toBeTruthy();
    // Nothing was cleared: the outcome is unknown.
    expect(activeChatsStore.getSnapshot()['chat-a']?.input).toBe(
      'The armed draft',
    );
  });
});

/**
 * The real hook and dialogs together, as the dock wires them: one chat's
 * in-flight armed send must never surface (or be retried) as another chat's
 * picker.
 */
function Pane({
  active,
  textarea,
  onState,
}: {
  active: ChatSession;
  textarea: { current: HTMLTextAreaElement | null };
  onState: (state: ReturnType<typeof useConversationBoundaryDialogs>) => void;
}) {
  const dialogs = useConversationBoundaryDialogs({
    agents: agents as never,
    apiBase: 'http://station.test',
    activeSession: active,
    allSessions: [chatA, chatB],
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
      chatInput={
        {
          input: '',
          attachments: [],
          quotes: [],
          textareaRef: textarea,
          prepareOutgoingText: async () => ({
            text: '',
            draft: '',
            quotes: [],
          }),
          handleClearInput: vi.fn(),
          handleClearAttachments: vi.fn(),
        } as never
      }
      composerMenuTriggerRef={{ current: null }}
      updateChat={activeChatsStore.updateChat.bind(activeChatsStore)}
      focusSessionInPane={vi.fn()}
      invalidate={vi.fn()}
      showToast={vi.fn()}
      refetchOrchestrationSessions={vi.fn() as never}
    />
  );
}

describe('one pane, two chats', () => {
  beforeEach(() => {
    handoffExecutionMessage.mockReset();
    sessionStorage.clear();
    armedHandoffStore.clear();
  });

  function mount(active: ChatSession) {
    let latest!: ReturnType<typeof useConversationBoundaryDialogs>;
    const textarea = { current: document.createElement('textarea') };
    document.body.append(textarea.current);
    const tree = (next: ChatSession) => (
      <ActiveChatsProvider>
        <Pane
          active={next}
          textarea={textarea}
          onState={(state) => {
            latest = state;
          }}
        />
      </ActiveChatsProvider>
    );
    const view = render(tree(active));
    return {
      get: () => latest,
      show: (next: ChatSession) => view.rerender(tree(next)),
      textarea,
    };
  }

  test('while chat A’s armed send is in flight, chat B opens no picker and nothing is posted for B', async () => {
    handoffExecutionMessage.mockReturnValue(new Promise(() => {}));
    const pane = mount(chatA);
    act(() =>
      pane.get().setArmedHandoff({
        conversationId: 'conversation-a',
        targetId: 'codex',
        modelId: 'gpt-5',
        label: 'Codex reviewer · GPT-5',
      }),
    );
    act(() =>
      pane.get().sendArmedHandoff({
        text: 'A’s draft',
        draft: 'A’s draft',
        quotes: [],
      }),
    );
    await waitFor(() => expect(handoffExecutionMessage).toHaveBeenCalledOnce());
    pane.show(chatB);
    expect(pane.get().handoffDisabledReason).toBe(
      'Another chat is still switching agents. Open it to finish first.',
    );
    act(() => pane.get().openConversationHandoff(null));
    expect(pane.get().handoffSource?.id).toBe('conversation-a');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      handoffExecutionMessage.mock.calls.every(
        (call) => call[1] === 'conversation-a',
      ),
    ).toBe(true);
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
    // The same component position receives a different source.
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

  test('two panes on one chat share its armed choice and in-flight state', async () => {
    handoffExecutionMessage.mockReturnValue(new Promise(() => {}));
    const first = mount(chatA);
    const second = mount(chatA);
    act(() =>
      first.get().setArmedHandoff({
        conversationId: 'conversation-a',
        targetId: 'codex',
        label: 'Codex reviewer',
      }),
    );
    expect(second.get().armedHandoff?.label).toBe('Codex reviewer');
    act(() =>
      first.get().sendArmedHandoff({ text: 'go', draft: 'go', quotes: [] }),
    );
    // The hook itself reports the send in flight, in both panes.
    await waitFor(() => expect(second.get().armedHandoffPending).toBe(true));
    expect(first.get().armedHandoffPending).toBe(true);
    // Undo is refused while it is in flight, from either pane.
    act(() => second.get().undoArmedHandoff());
    expect(first.get().armedHandoff?.label).toBe('Codex reviewer');
    // And the other pane cannot start its own send meanwhile.
    act(() =>
      second.get().sendArmedHandoff({ text: 'go', draft: 'go', quotes: [] }),
    );
    expect(second.get().handoffSource).toBeNull();
  });
});
