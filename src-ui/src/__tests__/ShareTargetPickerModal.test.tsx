// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchAgentConversations = vi.fn();
const projectsQuery = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  fetchAgentConversations: (agentSlug: string) =>
    fetchAgentConversations(agentSlug),
}));

// The picker's project read; the real hook needs the connection providers.
vi.mock('../contexts/ProjectsContext', () => ({
  useScopedProjectsQuery: () => projectsQuery(),
}));

import { ShareTargetPickerModal } from '../components/chat/ShareTargetPickerModal';
import { GLOBAL_CONTEXT } from '../components/modals/new-chat-modal-utils';
import { type NewChatIntent, OPEN_NEW_CHAT_EVENT } from '../lib/newChatIntent';

const PROJECTS = [
  { slug: 'alpha', name: 'Alpha project', workingDirectory: '/work/alpha' },
  {
    slug: 'blocked',
    name: 'Blocked project',
    runsAt: { kind: 'unavailable', reason: 'Folder is missing.' },
  },
];

function projectsLoaded(data: unknown[] = PROJECTS) {
  return { data, isLoading: false, isError: false, refetch: vi.fn() };
}

/** A dock that takes (or leaves) New chat intents, recording each one. */
function listenForNewChat(accept: boolean) {
  const intents: NewChatIntent[] = [];
  const listener = (event: Event) => {
    intents.push((event as CustomEvent<NewChatIntent>).detail);
    if (accept) event.preventDefault();
  };
  window.addEventListener(OPEN_NEW_CHAT_EVENT, listener);
  return {
    intents,
    stop: () => window.removeEventListener(OPEN_NEW_CHAT_EVENT, listener),
  };
}

const AGENTS = [
  { slug: 'agent-one', name: 'Agent One' },
  { slug: 'agent-two', name: 'Agent Two' },
];

function conversation(id: string, title: string, updatedAt: string) {
  return { id, title, createdAt: updatedAt, updatedAt };
}

function renderPicker(overrides: Partial<{ sharedFiles: File[] }> = {}) {
  const onShareToConversation = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  render(
    <ShareTargetPickerModal
      isOpen
      agents={AGENTS}
      sharedFiles={
        overrides.sharedFiles ?? [
          new File(['abc'], 'shared.png', { type: 'image/png' }),
        ]
      }
      attachmentCapabilities={{ images: true, files: true }}
      onShareToConversation={onShareToConversation}
      onClose={onClose}
    />,
    { wrapper },
  );
  return { onShareToConversation, onClose };
}

afterEach(() => {
  cleanup();
  fetchAgentConversations.mockReset();
  projectsQuery.mockReset();
});

beforeEach(() => {
  projectsQuery.mockReturnValue(projectsLoaded());
});

describe('ShareTargetPickerModal', () => {
  test('lists recent conversations across agents, most-recent first', async () => {
    fetchAgentConversations.mockImplementation((slug: string) =>
      slug === 'agent-one'
        ? Promise.resolve([
            conversation('c1', 'Older chat', '2026-07-20T10:00:00.000Z'),
          ])
        : Promise.resolve([
            conversation('c2', 'Newer chat', '2026-07-24T10:00:00.000Z'),
          ]),
    );

    renderPicker();

    await screen.findByText('Older chat');
    const titles = screen
      .getAllByText(/(Newer|Older) chat$/)
      .map((node) => node.textContent);
    expect(titles).toEqual(['Newer chat', 'Older chat']);
  });

  test('seeds the shared image into the chosen conversation composer path', async () => {
    fetchAgentConversations.mockImplementation((slug: string) =>
      slug === 'agent-one'
        ? Promise.resolve([
            conversation('c1', 'Design review', '2026-07-24T10:00:00.000Z'),
          ])
        : Promise.resolve([]),
    );

    const { onShareToConversation, onClose } = renderPicker();

    const row = await screen.findByText('Design review');
    fireEvent.click(row);

    await waitFor(() => expect(onShareToConversation).toHaveBeenCalledTimes(1));
    const [target, attachments] = onShareToConversation.mock.calls[0];
    expect(target).toEqual({
      conversationId: 'c1',
      agentSlug: 'agent-one',
      agentName: 'Agent One',
    });
    // The shared File flowed through readChatAttachmentFiles into a real
    // image attachment destined for that conversation's composer.
    expect(attachments).toHaveLength(1);
    expect(attachments[0].type).toBe('image/png');
    expect(attachments[0].name).toBe('shared.png');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test('renders the Empty state when no conversations exist', async () => {
    fetchAgentConversations.mockResolvedValue([]);

    renderPicker();

    await screen.findByText('No chats yet');
  });

  test('filters conversations by the search field', async () => {
    fetchAgentConversations.mockImplementation((slug: string) =>
      slug === 'agent-one'
        ? Promise.resolve([
            conversation('c1', 'Alpha', '2026-07-24T10:00:00.000Z'),
            conversation('c2', 'Beta', '2026-07-23T10:00:00.000Z'),
          ])
        : Promise.resolve([]),
    );

    renderPicker();

    await screen.findByText('Alpha');
    fireEvent.change(screen.getByLabelText('Search chats'), {
      target: { value: 'bet' },
    });

    expect(screen.queryByText('Alpha')).toBeNull();
    expect(screen.getByText('Beta')).not.toBeNull();
  });

  test('New chat hands the shared files to the dock with the chosen project', async () => {
    fetchAgentConversations.mockResolvedValue([]);
    const dock = listenForNewChat(true);
    const files = [
      new File(['a'], 'one.png', { type: 'image/png' }),
      new File(['b'], 'two.png', { type: 'image/png' }),
    ];
    try {
      const { onClose, onShareToConversation } = renderPicker({
        sharedFiles: files,
      });
      // Projects are read only once the New chat step opens.
      expect(projectsQuery).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: /New chat/ }));
      expect(
        screen.getByText(
          'Choose a project for a new chat with 2 shared images',
        ),
      ).not.toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /Alpha project/ }));

      expect(dock.intents).toHaveLength(1);
      expect(dock.intents[0].selection).toEqual({ context: 'alpha' });
      // The very files that were shared, for the new chat to stage.
      expect(dock.intents[0].initialFiles).toEqual(files);
      expect(dock.intents[0].initialFiles?.[0]).toBe(files[0]);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onShareToConversation).not.toHaveBeenCalled();
    } finally {
      dock.stop();
    }
  });

  test('New chat offers No project and filters projects by the search field', async () => {
    fetchAgentConversations.mockResolvedValue([]);
    const dock = listenForNewChat(true);
    try {
      renderPicker();
      fireEvent.click(screen.getByRole('button', { name: /New chat/ }));
      fireEvent.change(screen.getByLabelText('Search projects'), {
        target: { value: 'no proj' },
      });
      expect(
        screen.queryByRole('button', { name: /Alpha project/ }),
      ).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /No project/ }));
      expect(dock.intents[0].selection).toEqual({ context: GLOBAL_CONTEXT });
    } finally {
      dock.stop();
    }
  });

  test('keeps the picker open and says why when no dock takes the new chat', async () => {
    fetchAgentConversations.mockResolvedValue([]);
    const dock = listenForNewChat(false);
    try {
      const { onClose } = renderPicker();
      fireEvent.click(screen.getByRole('button', { name: /New chat/ }));
      fireEvent.click(screen.getByRole('button', { name: /Alpha project/ }));
      expect(dock.intents).toHaveLength(1);
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole('alert').textContent).toMatch(/Open Chat/);
    } finally {
      dock.stop();
    }
  });

  test('a project that cannot start here is not offered as a target', async () => {
    fetchAgentConversations.mockResolvedValue([]);
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /New chat/ }));
    const blocked = screen.getByRole('button', { name: /Blocked project/ });
    expect((blocked as HTMLButtonElement).disabled).toBe(true);
    expect(blocked.getAttribute('title')).toBe('Folder is missing.');
  });

  test('a failed project read offers a retry that refetches', async () => {
    fetchAgentConversations.mockResolvedValue([]);
    const refetch = vi.fn();
    projectsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /New chat/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test('Conversations returns from the project list to the conversation list', async () => {
    fetchAgentConversations.mockImplementation((slug: string) =>
      Promise.resolve(
        slug === 'agent-one'
          ? [conversation('c1', 'Alpha chat', '2026-07-24T10:00:00.000Z')]
          : [],
      ),
    );
    renderPicker();
    await screen.findByText('Alpha chat');
    fireEvent.click(screen.getByRole('button', { name: /New chat/ }));
    expect(screen.queryByText('Alpha chat')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Conversations/ }));
    expect(screen.getByText('Alpha chat')).not.toBeNull();
  });
});
