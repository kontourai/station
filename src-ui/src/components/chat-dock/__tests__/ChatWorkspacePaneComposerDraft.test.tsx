/**
 * @vitest-environment jsdom
 *
 * Epic #2323 S2 (verifier gap I6): the REAL `ChatWorkspacePane` and its real
 * `station:open-project-chats` listener, the real `ChatDockModalStack` and
 * the real `useChatDockActions`. Only data sources and display-only children
 * are stood in for, and the New Chat picker is a probe that records what it
 * was handed and picks an Agent on request (the picker itself is covered by
 * `NewChatModalSelectDispatch.test.tsx`).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { ActiveChatsProvider } from '../../../contexts/ActiveChatsContext';
import { ConversationsProvider } from '../../../contexts/ConversationsContext';
import { KeyboardShortcutsProvider } from '../../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../../contexts/NavigationContext';
import { RegionModelProvider } from '../../../contexts/RegionModelContext';
import { ToastProvider } from '../../../contexts/ToastContext';
import {
  type ProjectChatComposerDraft,
  requestProjectChat,
} from '../../../lib/projectChatEvents';

const { createChatSession, sendMessage, updateChat, pickerProps } = vi.hoisted(
  () => ({
    createChatSession: vi.fn(() => 'new-session'),
    sendMessage: vi.fn(),
    updateChat: vi.fn(),
    pickerProps: [] as Record<string, any>[],
  }),
);

vi.mock('../../modals/NewChatModal', () => ({
  NewChatModal: (props: Record<string, any>) => {
    pickerProps.push(props);
    return <div role="dialog" aria-label="New chat picker" />;
  },
}));
vi.mock('../../../hooks/useActiveChatSessions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCreateChatSession: () => createChatSession,
  useSendMessage: () => sendMessage,
  useCancelMessage: () => vi.fn(),
  useRehydrateSessions: () => vi.fn(),
  useOpenConversation: () => vi.fn(),
}));
vi.mock('../../../contexts/ActiveChatsContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useActiveChatActions: () => ({
    updateChat,
    removeChat: vi.fn(),
    initChat: vi.fn(),
  }),
}));
vi.mock('../../../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useApiBase: () => ({ apiBase: 'http://station.test' }),
  useHostRequestAuthorityScope: () => undefined,
}));
vi.mock('../../../contexts/ProjectsContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProjects: () => ({
    projects: [
      { slug: 'pulse', name: 'Pulse' },
      { slug: 'other', name: 'Other' },
    ],
    isLoading: false,
    isConfirmedLoaded: true,
  }),
  useProject: () => ({ project: undefined, isLoading: false }),
}));
vi.mock('../../../contexts/AgentsContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgents: () => [{ slug: 'assistant', name: 'Assistant' }],
  useAgentsLoaded: () => true,
}));

vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useConnections: () => ({ captureCredentialEvidence: () => null }),
}));

const { ChatWorkspacePane } = await import('../ChatDock');

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ success: true, data: [] })),
  );
});

afterEach(() => {
  cleanup();
  pickerProps.length = 0;
  createChatSession.mockClear();
  sendMessage.mockClear();
  updateChat.mockClear();
});

const draft: ProjectChatComposerDraft = {
  title: 'Plugin authoring',
  description: 'Nothing is sent until you send it.',
  label: 'Opening message',
  detail: 'Continue building Pulse',
  message: 'Read the `plugin-authoring` topic, then run `validate_plugin`.',
};

function renderPane(projectSlug: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <KeyboardShortcutsProvider>
        <NavigationProvider>
          <ToastProvider>
            <ConversationsProvider>
              <ActiveChatsProvider>
                <RegionModelProvider>
                  <ChatWorkspacePane
                    placement="fullscreen"
                    projectSlug={projectSlug}
                    layoutSlug="coding"
                  />
                </RegionModelProvider>
              </ActiveChatsProvider>
            </ConversationsProvider>
          </ToastProvider>
        </NavigationProvider>
      </KeyboardShortcutsProvider>
    </QueryClientProvider>,
  );
}

test('a fullscreen pane for the requested Project opens its picker with the draft, creates nothing, and sends nothing', async () => {
  renderPane('pulse');

  let claimed = false;
  act(() => {
    claimed = requestProjectChat({
      projectSlug: 'pulse',
      projectName: 'Pulse',
      source: 'new-plugin',
      composerDraft: draft,
    });
  });
  expect(claimed).toBe(true);

  await screen.findByRole('dialog', { name: 'New chat picker' });
  const props = pickerProps.at(-1)!;
  expect(props.activeProjectSlug).toBe('pulse');
  expect(props.draftContext?.items[0].messageLine).toBe(draft.message);
  // Opening the picker starts nothing.
  expect(createChatSession).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();

  // The person picks an Agent: the chat is created in THIS Project with the
  // draft in its composer, and still nothing is sent.
  act(() => {
    props.onSelect(
      { slug: 'assistant', name: 'Assistant' },
      'pulse',
      'Pulse',
      draft.message,
    );
  });
  expect(createChatSession).toHaveBeenCalledWith(
    'assistant',
    'Assistant',
    undefined,
    'pulse',
    'Pulse',
    expect.anything(),
  );
  expect(updateChat).toHaveBeenCalledWith('new-session', {
    input: draft.message,
  });
  expect(sendMessage).not.toHaveBeenCalled();
});

test('a fullscreen pane bound to another Project leaves the draft alone', async () => {
  renderPane('other');

  let claimed = true;
  act(() => {
    claimed = requestProjectChat({
      projectSlug: 'pulse',
      source: 'new-plugin',
      composerDraft: draft,
    });
  });

  expect(claimed).toBe(false);

  // Positive control instead of a timeout: a draft for THIS pane's own
  // Project opens its picker. When that picker is up, the only request it
  // ever showed must be its own; the earlier one for `pulse` opened nothing.
  act(() => {
    requestProjectChat({
      projectSlug: 'other',
      source: 'new-plugin',
      composerDraft: draft,
    });
  });
  await screen.findByRole('dialog', { name: 'New chat picker' });
  expect(pickerProps.map((props) => props.activeProjectSlug)).not.toContain(
    'pulse',
  );
  expect(pickerProps.at(-1)!.activeProjectSlug).toBe('other');
  expect(createChatSession).not.toHaveBeenCalled();
});
