/** @vitest-environment jsdom */
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { TaskShapingHost } from '../components/chat/TaskShapingComposer';
import { useLaunchChat } from '../hooks/useActiveChatSessionLifecycle';
import { requestTaskShaping } from '../lib/task-shaping';

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
  activeChatsStore: { getSnapshot: () => host.chats },
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

test('a clear one-liner starts a project chat with the selected agent and proposal instructions, without a title form', async () => {
  render(<TaskShapingHost />);
  act(() => requestTaskShaping({ projectSlug: 'alpha', agentSlug: 'station' }));
  expect(screen.queryByLabelText('Task title')).toBeNull();
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Show installer step counts' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start shaping' }));
  await waitFor(() => expect(host.launch).toHaveBeenCalledTimes(1));
  expect(host.launch).toHaveBeenCalledWith(
    'station',
    'Station',
    'Show installer step counts',
    'alpha',
    'Alpha',
    { provider: 'station' },
    expect.stringContaining('station-task-proposal'),
  );
});

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
      source: { sessionId: 'session-source', turnId: 'answer-source' },
    }),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Shape this conversation' }),
  );
  await waitFor(() => expect(host.send).toHaveBeenCalledTimes(1));
  expect(host.send).toHaveBeenCalledWith(
    'chat-key',
    'station',
    'conversation-source',
    'Shape this conversation into a Task.',
    [],
    expect.stringContaining('Focus on the answer in turn answer-source.'),
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
