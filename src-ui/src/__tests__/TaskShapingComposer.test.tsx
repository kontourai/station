/** @vitest-environment jsdom */
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { TaskShapingHost } from '../components/chat/TaskShapingComposer';
import { toastStore } from '../contexts/ToastContext';
import { useLaunchChat } from '../hooks/useActiveChatSessionLifecycle';
import {
  requestTaskShaping,
  TASK_SHAPING_INSTRUCTION,
} from '../lib/task-shaping';

const host = vi.hoisted(() => ({
  init: vi.fn(),
  launch: vi.fn(),
  send: vi.fn(),
  update: vi.fn(),
  navigate: vi.fn(),
  chats: {} as Record<string, unknown>,
}));
vi.mock('@kontourai/station-sdk', () => ({
  useEngineConnectionsQuery: () => ({ data: [] }),
  useProjectQuery: () => ({ data: { slug: 'alpha' } }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [{ slug: 'station', name: 'Station' }],
}));
vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: [{ slug: 'alpha', name: 'Alpha' }],
    isConfirmedLoaded: true,
  }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigationActions: () => ({
    setActiveChat: host.navigate,
    setDockState: vi.fn(),
  }),
  useNavigation: () => ({
    setActiveChat: host.navigate,
    setDockState: vi.fn(),
  }),
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({
    updateChat: host.update,
    initChat: host.init,
  }),
}));
vi.mock('../contexts/active-chats-store', () => ({
  activeChatsStore: { getSnapshot: () => host.chats, updateChat: host.update },
}));
vi.mock('../hooks/useActiveChatSessionMessaging', () => ({
  useSendMessage: () => host.send,
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useLaunchChat: () => host.launch,
  useSendMessage: () => host.send,
  useOpenConversation: () => vi.fn(),
}));
vi.mock('../components/agent-selection-policy', () => ({
  selectChatReadyAgents: ({ agents }: { agents: unknown[] }) => agents,
}));
vi.mock('../utils/execution', () => ({
  resolveAgentExecution: () => ({ provider: 'station' }),
}));
vi.mock('../app-shell/chat-placement', () => ({
  showChatPageOrDock: (open: () => void) => open(),
}));
beforeEach(() => {
  host.launch.mockReset();
  host.send.mockReset();
  host.navigate.mockReset();
  host.update.mockReset();
  host.chats = {};
});

test.each(['alpha', undefined])(
  'New Task hands the current context to the normal composer (%s), without opening a form',
  (projectSlug) => {
    const listener = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener('station:open-new-chat', listener);
    render(<TaskShapingHost />);
    act(() => requestTaskShaping({ projectSlug }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({
      detail: {
        taskShaping: true,
        selection: { context: projectSlug ?? '__global__' },
      },
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    window.removeEventListener('station:open-new-chat', listener);
  },
);

test('Turn into Task shapes the same conversation and preserves an unsent draft', async () => {
  host.chats = {
    'chat-key': {
      agentSlug: 'station',
      currentSessionId: 'session-source',
      conversationId: 'conversation-source',
      input: 'Unsent thought',
      attachments: [],
    },
  };
  host.send.mockImplementation(async () => {
    host.chats['chat-key'] = {
      ...(host.chats['chat-key'] as object),
      input: '',
    };
    return true;
  });
  render(<TaskShapingHost />);
  act(() =>
    requestTaskShaping({
      source: {
        sessionId: 'session-source',
        turnId: 'answer-source',
        excerpt: 'Installer progress matters.',
      },
    }),
  );
  await waitFor(() => expect(host.send).toHaveBeenCalledTimes(1));
  expect(host.send).toHaveBeenCalledWith(
    'chat-key',
    'station',
    'conversation-source',
    'Shape this conversation into a Task.',
    [],
    expect.stringContaining(
      'Focus on this excerpt from the conversation:\n> Installer progress matters.',
    ),
  );
  expect(host.launch).not.toHaveBeenCalled();
  expect(host.update).toHaveBeenCalledWith('chat-key', {
    input: 'Unsent thought',
    attachments: [],
  });
});

test('the chat launch owner sends shaping instructions as model context while retaining only the person’s idea as the visible prompt', async () => {
  const { result } = renderHook(() => useLaunchChat('http://station.test'));
  await act(async () => {
    await result.current(
      'station',
      'Station',
      'My idea',
      'alpha',
      'Alpha',
      undefined,
      'Hidden shaping instructions',
    );
  });
  expect(host.send).toHaveBeenCalledWith(
    expect.any(String),
    'station',
    undefined,
    'My idea',
    undefined,
    'Hidden shaping instructions',
  );
});

test('a failed shaping entry uses the dismissible app toast', async () => {
  toastStore.dismissAll();
  render(<TaskShapingHost />);
  act(() => requestTaskShaping({ source: { sessionId: 'missing' } }));
  await waitFor(() => expect(toastStore.getSnapshot()).toHaveLength(1));
  expect(toastStore.getSnapshot()[0].message).toContain(
    'Open this conversation',
  );
  expect(screen.queryByRole('alert')).toBeNull();
  toastStore.dismissAll();
});

test('a promptless shaping launch retains mode for the first typed turn', async () => {
  const { result } = renderHook(() => useLaunchChat('http://station.test'));
  await act(async () => {
    await result.current(
      'station',
      'Station',
      undefined,
      'alpha',
      'Alpha',
      undefined,
      TASK_SHAPING_INSTRUCTION,
    );
  });
  expect(host.update).toHaveBeenCalledWith(expect.any(String), {
    taskShaping: true,
  });
  expect(host.send).not.toHaveBeenCalled();
});
