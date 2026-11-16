// @vitest-environment jsdom
/**
 * An armed send belongs to the chat it was typed in. While it dispatches the
 * person may open another chat: the request keeps running out of sight, any
 * question it raises waits until they return to its chat, and its acceptance
 * clears that chat's draft without pulling them back to it.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConversationBoundaryDialogs } from '../components/chat-dock/ConversationBoundaryDialogs';
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
      expect(view.setArmedHandoff).toHaveBeenCalledWith(null),
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
