/**
 * @vitest-environment jsdom
 *
 * Epic #2323 S2 (verifier gap I6): the REAL `ChatWorkspacePane` and its real
 * `station:open-project-chats` listener, the real `ChatDockModalStack` and
 * the real `useChatDockActions`. Only data sources and display-only children
 * are stood in for, and the New Chat picker is a probe that records what it
 * was handed and picks an Agent on request (the picker itself is covered by
 * `NewChatModalSelectDispatch.test.tsx`).
 *
 * The same real pane also owns the dock's file-drop wiring: which view-model
 * state counts as an attachment owner is decided in `ChatDock.tsx`, not in
 * `ChatPaneFileDropBoundary`.
 *
 * Docked inside the real `DockShell`, it also owns the project-binding wiring
 * (archive#4525/#4524): which Project the header badge names, what the
 * switcher does, and which Project the New Chat picker defaults to. The pure
 * resolvers are table-tested in `chat-dock-utils.test.ts`; these tests pin
 * that the pane hands their results to the right surfaces.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { ActiveChatsProvider } from '../../../contexts/ActiveChatsContext';
import { ConversationsProvider } from '../../../contexts/ConversationsContext';
import { KeyboardShortcutsProvider } from '../../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../../contexts/NavigationContext';
import { navigationStore } from '../../../contexts/navigation-store';
import { RegionModelProvider } from '../../../contexts/RegionModelContext';
import { ToastProvider } from '../../../contexts/ToastContext';
import { useShowSurface } from '../../../contexts/useShowSurface';
import { deviceSettingsStore } from '../../../lib/device-settings-store';
import { dispatchNewChatIntent } from '../../../lib/newChatIntent';
import {
  type ProjectChatComposerDraft,
  requestProjectChat,
} from '../../../lib/projectChatEvents';

const { createChatSession, sendMessage, updateChat, pickerProps, dockProbe } =
  vi.hoisted(() => ({
    createChatSession: vi.fn(() => 'new-session'),
    sendMessage: vi.fn(),
    updateChat: vi.fn(),
    pickerProps: [] as Record<string, any>[],
    dockProbe: {
      mobile: false,
      sessions: [] as Record<string, any>[],
      agents: [{ slug: 'assistant', name: 'Assistant' }],
    },
  }));

const projects = [
  { slug: 'pulse', name: 'Pulse', workingDirectory: '/work/pulse' },
  { slug: 'other', name: 'Other', workingDirectory: '/work/other' },
];

// Honours the Agent argument the way the real hook does, so a pane that
// passed a route-selected Agent would lose other Agents' chats.
vi.mock('../../../hooks/useDerivedSessions', () => ({
  useDerivedSessions: (_apiBase: string, agentSlug: string | null) =>
    agentSlug
      ? dockProbe.sessions.filter((session) => session.agentSlug === agentSlug)
      : dockProbe.sessions,
}));
vi.mock('../../../hooks/useDockShellChrome', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../hooks/useDockShellChrome')>();
  return {
    ...actual,
    useDockShellChrome: (
      ...args: Parameters<typeof actual.useDockShellChrome>
    ) => ({
      ...actual.useDockShellChrome(...args),
      isMobile: dockProbe.mobile,
    }),
  };
});
vi.mock('../ChatDockMobileHeader', () => ({
  ChatDockMobileHeader: ({
    activeCount,
    projectSwitcher,
  }: {
    activeCount: number;
    projectSwitcher?: { projectName: string };
  }) => (
    <>
      <div data-testid="mobile-dock-work-badge">{activeCount}</div>
      <div data-testid="mobile-dock-project-name">
        {projectSwitcher?.projectName}
      </div>
    </>
  ),
}));

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
    projects,
    isLoading: false,
    isConfirmedLoaded: true,
  }),
  useProject: (slug: string) => ({
    project: projects.find((project) => project.slug === slug),
    isLoading: false,
  }),
}));
vi.mock('../../../contexts/AgentsContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgents: () => dockProbe.agents,
  useAgentsLoaded: () => true,
}));

// The active chat's transcript and composer are stood in for: the file-drop
// test asks only which pane owns attachments, and the marker shows a chat is
// active.
vi.mock('../ChatDockBody', () => ({
  ChatDockBody: () => <div data-testid="active-chat-body" />,
}));

// A chat's own Project facts: its layouts and the git state of its directory.
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProjectLayoutsQuery: (projectSlug: string) => ({
    data:
      projectSlug === 'other'
        ? [{ slug: 'other-code', name: 'Code', type: 'coding' }]
        : [],
  }),
  useGitStatusQuery: (location: { workingDir?: string } | null) => ({
    data:
      location?.workingDir === '/work/other'
        ? { isRepo: true, branch: 'other-branch', changes: [] }
        : null,
  }),
}));

vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useConnections: () => ({ captureCredentialEvidence: () => null }),
}));

const { ChatWorkspacePane } = await import('../ChatDock');
const { DockShell } = await import('../DockShell');

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
  dockProbe.mobile = false;
  dockProbe.sessions = [];
  dockProbe.agents = [{ slug: 'assistant', name: 'Assistant' }];
  showSurface = undefined;
  deviceSettingsStore.reset('chatDockProjectSlug');
  navigationStore.navigate('/', { chat: null, dock: null });
});

const draft: ProjectChatComposerDraft = {
  title: 'Plugin authoring',
  description: 'Nothing is sent until you send it.',
  label: 'Opening message',
  detail: 'Continue building Pulse',
  message: 'Read the `plugin-authoring` topic, then run `validate_plugin`.',
};

let showSurface: ReturnType<typeof useShowSurface> | undefined;
function CaptureShowSurface() {
  showSurface = useShowSurface();
  return null;
}

function renderPane(projectSlug: string) {
  renderInProviders(
    <ChatWorkspacePane
      placement="fullscreen"
      projectSlug={projectSlug}
      layoutSlug="coding"
    />,
  );
}

/** The ambient placement: docked inside the real shell that owns the binding. */
function renderDockedPane() {
  renderInProviders(
    <DockShell>
      {(shellChrome) => (
        <ChatWorkspacePane placement="dock" shellChrome={shellChrome} />
      )}
    </DockShell>,
  );
}

function renderInProviders(pane: ReactNode) {
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
                  <CaptureShowSurface />
                  {pane}
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
  // Open this pane's own picker first, so the picker is mounted and would
  // re-render if a later request changed what it offers.
  act(() => {
    requestProjectChat({
      projectSlug: 'other',
      source: 'new-plugin',
      composerDraft: { ...draft, detail: 'own project' },
    });
  });
  await screen.findByRole('dialog', { name: 'New chat picker' });
  const before = pickerProps.length;

  let claimed = true;
  act(() => {
    claimed = requestProjectChat({
      projectSlug: 'pulse',
      source: 'new-plugin',
      composerDraft: draft,
    });
  });

  expect(claimed).toBe(false);
  // Every picker open bumps its request epoch and remounts it, so a pane
  // that wrongly took this request would have unmounted the open picker by
  // now. It is still the same mounted picker.
  expect(screen.getByRole('dialog', { name: 'New chat picker' })).toBeTruthy();
  // Whatever re-rendered, the picker still offers this pane's own Project
  // and draft; the request for `pulse` was left for another pane.
  for (const props of pickerProps.slice(before)) {
    expect(props.activeProjectSlug).toBe('other');
    expect(props.draftContext?.items[0].detail).toBe('own project');
  }
  expect(pickerProps.at(-1)!.activeProjectSlug).toBe('other');
  expect(createChatSession).not.toHaveBeenCalled();
});

test('the dock passes a background-only session into its mobile work badge', async () => {
  dockProbe.mobile = true;
  dockProbe.sessions = [
    {
      id: 'background-chat',
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Background research',
      projectSlug: 'pulse',
      status: 'idle',
      source: 'manual',
      input: '',
      attachments: [],
      queuedMessages: [],
      inputHistory: [],
      messages: [],
      hasUnread: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      conversationActivity: {
        conversationId: 'background-chat',
        asOfSequence: 4,
        runningChildWork: { count: 1, producers: ['engine-subagent'] },
      },
    },
  ];
  renderPane('pulse');
  expect(
    (await screen.findByTestId('mobile-dock-work-badge')).textContent,
  ).toBe('1');
});

function chatSession(id: string): Record<string, any> {
  return {
    id,
    agentSlug: 'assistant',
    agentName: 'Assistant',
    title: 'Pulse chat',
    projectSlug: 'pulse',
    status: 'idle',
    source: 'manual',
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    messages: [],
    hasUnread: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Drags one file over the pane and reports whether it offered to take it. */
function dragFileOverPane(): boolean {
  const pane = screen.getByRole('region', { name: 'Chat dock' });
  const dataTransfer = {
    types: ['Files'],
    files: [new File(['x'], 'note.txt')],
    items: [],
  } as unknown as DataTransfer;
  fireEvent.dragEnter(pane, { dataTransfer, relatedTarget: null });
  const offered = screen.queryByTestId('chat-pane-file-drop-overlay') !== null;
  fireEvent.dragLeave(pane, { dataTransfer, relatedTarget: null });
  return offered;
}

test('file drops follow the pane’s attachment owner: none without an active chat, none over an imported conversation', async () => {
  dockProbe.sessions = [chatSession('chat-a')];
  renderPane('pulse');
  expect(dragFileOverPane(), 'a pane with no active chat took a file').toBe(
    false,
  );
  cleanup();

  navigationStore.navigate('/', { chat: 'chat-a' });
  renderPane('pulse');
  await act(async () => {});
  expect(screen.getByTestId('active-chat-body')).toBeTruthy();
  expect(dragFileOverPane(), 'the active chat’s pane refused a file').toBe(
    true,
  );

  // An imported conversation takes over the reading surface; the chat behind
  // it still exists, but nothing on screen can hold an attachment.
  act(() => showSurface!('chat', { session: 'imported-thread' }));
  await act(async () => {});
  expect(
    dragFileOverPane(),
    'an imported conversation’s pane took a file',
  ).toBe(false);
});

/**
 * The dock is bound to Pulse while the chat on screen belongs to Other: the
 * badge keeps naming the binding, and the chat's own Project and directory
 * are reported beside it rather than dropped (archive#4525 review HIGH-2,
 * MED-1).
 */
function openForeignChatInPulseBoundDock() {
  deviceSettingsStore.set('chatDockProjectSlug', 'pulse');
  dockProbe.sessions = [
    { ...chatSession('chat-a'), projectSlug: 'other', projectName: 'Other' },
  ];
  navigationStore.navigate('/', { dock: 'open', chat: 'chat-a' });
  renderDockedPane();
}

test('the docked badge names the bound Project and reports a foreign chat’s own Project and directory', async () => {
  openForeignChatInPulseBoundDock();
  await act(async () => {});

  const badge = screen.getByRole('button', { name: 'Pulse' });
  // The directory is the chat's, not the bound Project's.
  expect(badge.getAttribute('title')).toBe('This chat (Other) — /work/other');
  expect(
    document.querySelector('.chat-dock__project-session-name')?.textContent,
  ).toBe('This chat: Other');

  // The switcher marks the bound Project as current.
  fireEvent.click(badge);
  await screen.findByRole('dialog', { name: 'Projects' });
  expect(
    screen
      .getByRole('button', { name: 'Switch to Pulse' })
      .closest('li')
      ?.getAttribute('aria-current'),
  ).toBe('true');
  expect(
    screen
      .getByRole('button', { name: 'Switch to Other' })
      .closest('li')
      ?.getAttribute('aria-current'),
  ).toBeNull();
});

test('a foreign chat’s git state and code layout are its own Project’s, not the badge’s (archive#4525 review HIGH-2)', async () => {
  openForeignChatInPulseBoundDock();
  await act(async () => {});

  expect(
    document.querySelector('.chat-dock__project-context .git-badge__branch')
      ?.textContent,
  ).toContain('other-branch');

  fireEvent.click(screen.getByRole('button', { name: 'More dock actions' }));
  fireEvent.click(
    await screen.findByRole('menuitem', { name: 'Open in Coding' }),
  );
  expect(navigationStore.getSnapshot().pathname).toBe(
    '/projects/other/layouts/other-code',
  );
});

test('the mobile header names the same bound Project as the desktop badge', async () => {
  dockProbe.mobile = true;
  openForeignChatInPulseBoundDock();
  expect(
    (await screen.findByTestId('mobile-dock-project-name')).textContent,
  ).toBe('Pulse');
});

test('switching Project rebinds the dock and opens no New Chat picker (archive#4524)', async () => {
  openForeignChatInPulseBoundDock();
  await act(async () => {});

  fireEvent.click(screen.getByRole('button', { name: 'Pulse' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Switch to Other' }),
  );
  await act(async () => {});

  expect(deviceSettingsStore.get('chatDockProjectSlug')).toBe('other');
  expect(screen.getByRole('button', { name: 'Other' })).toBeTruthy();
  expect(screen.queryByRole('dialog', { name: 'New chat picker' })).toBeNull();
  expect(pickerProps).toHaveLength(0);
  expect(createChatSession).not.toHaveBeenCalled();
});

test('the docked New chat button opens a draft in the bound Project with one ready Agent', async () => {
  deviceSettingsStore.set('chatDockProjectSlug', 'pulse');
  navigationStore.navigate('/', { dock: 'open' });
  renderDockedPane();
  await act(async () => {});

  fireEvent.click(screen.getByTitle('New chat (Ctrl+T)'));
  await screen.findByRole('dialog', { name: 'New chat picker' });
  expect(pickerProps.at(-1)!.activeProjectSlug).toBe('pulse');
  expect(pickerProps.at(-1)!.startSurface).toBe(true);
  expect(createChatSession).not.toHaveBeenCalled();
});

test('the docked New Chat picker defaults to the dock’s bound Project', async () => {
  dockProbe.agents = [
    { slug: 'assistant', name: 'Assistant' },
    { slug: 'reviewer', name: 'Reviewer' },
  ];
  deviceSettingsStore.set('chatDockProjectSlug', 'pulse');
  navigationStore.navigate('/', { dock: 'open' });
  renderDockedPane();
  await act(async () => {});

  // New chat retains the bound Project with multiple Agents too.
  fireEvent.click(screen.getByTitle('New chat (Ctrl+T)'));
  await screen.findByRole('dialog', { name: 'New chat picker' });
  expect(pickerProps.at(-1)!.activeProjectSlug).toBe('pulse');
  expect(createChatSession).not.toHaveBeenCalled();
});

test('a route-selected Agent does not hide other Agents’ chats from the dock (#1053)', async () => {
  dockProbe.sessions = [chatSession('chat-a')];
  navigationStore.navigate('/agents/codex', { dock: 'open', chat: 'chat-a' });
  expect(navigationStore.getSnapshot().selectedAgent).toBe('codex');
  renderDockedPane();
  await act(async () => {});

  // `chat-a` belongs to `assistant`; the dock still shows it as the active chat.
  expect(screen.getByTestId('active-chat-body')).toBeTruthy();
  expect(
    document.querySelector('.chat-dock__active-identity-agent')?.textContent,
  ).toBe('Assistant');
});

test('a Project-scoped pane shows only that Project’s chats', async () => {
  dockProbe.sessions = [
    { ...chatSession('chat-other'), projectSlug: 'other', title: 'Other chat' },
  ];
  navigationStore.navigate('/', { chat: 'chat-other' });
  renderPane('pulse');
  await act(async () => {});
  expect(screen.queryByTestId('active-chat-body')).toBeNull();
});

// Review FI-1 / HIGH-1: Home's starts, selections and hand-offs are the
// ambient dock's. A dock scoped to one project leaves them alone, and only a
// dock that took one tells the sender so (the sender keeps its draft
// otherwise).
test('a project-scoped pane leaves Home intents to the ambient dock and says it did not take them', async () => {
  renderPane('pulse');
  const selection = { context: '__global__', agentSlug: 'assistant' };
  for (const detail of [
    { startWithDefault: true, initialPrompt: 'Go', selection },
    { initialPrompt: 'Go', selection, handoff: { kind: 'skills' as const } },
    { initialPrompt: 'Go', selection },
  ]) {
    let accepted = true;
    act(() => {
      accepted = dispatchNewChatIntent(detail);
    });
    expect(accepted).toBe(false);
  }
  expect(screen.queryByRole('dialog', { name: 'New chat picker' })).toBeNull();
  // An ordinary open is still its own.
  let accepted = false;
  act(() => {
    accepted = dispatchNewChatIntent({});
  });
  expect(accepted).toBe(true);
  await screen.findByRole('dialog', { name: 'New chat picker' });
});

test("the ambient dock takes Home's hand-off and reports how it ended", async () => {
  renderDockedPane();
  const onClosed = vi.fn();
  let accepted = false;
  act(() => {
    accepted = dispatchNewChatIntent({
      initialPrompt: 'Keep me',
      selection: { context: '__global__', agentSlug: 'assistant' },
      handoff: { kind: 'repair', agentSlug: 'assistant', route: 'models' },
      onClosed,
    });
  });
  expect(accepted).toBe(true);
  await screen.findByRole('dialog', { name: 'New chat picker' });
  const props = pickerProps.at(-1)!;
  expect(props.initialPrompt).toBe('Keep me');
  expect(props.handoff).toEqual({
    kind: 'repair',
    agentSlug: 'assistant',
    route: 'models',
  });
  // Closed (or its setup journey cancelled, which closes it): dismissed.
  act(() => props.onClose());
  expect(onClosed).toHaveBeenCalledTimes(1);
  expect(onClosed.mock.calls[0][0]).toBe('dismissed');

  const onStarted = vi.fn();
  act(() => {
    dispatchNewChatIntent({
      startWithDefault: true,
      initialPrompt: 'Start me',
      selection: { context: '__global__', agentSlug: 'assistant' },
      onClosed: onStarted,
    });
  });
  await waitFor(() =>
    expect(pickerProps.at(-1)!.initialPrompt).toBe('Start me'),
  );
  act(() => {
    pickerProps
      .at(-1)!
      .onSelect(
        { slug: 'assistant', name: 'Assistant' },
        undefined,
        undefined,
        'Start me',
      );
  });
  expect(onStarted).toHaveBeenCalledTimes(1);
  expect(onStarted.mock.calls[0][0]).toBe('started');
});

// Review FI-A: an unreadable selection from Home reaches the dock's modal as
// such (the modal then says so), and a later ordinary open does not carry
// it over.
test('an unreadable selection reaches the modal as unreadable, and only for that request', async () => {
  renderDockedPane();
  act(() => {
    dispatchNewChatIntent({
      startWithDefault: true,
      initialPrompt: 'Keep me',
      selection: { context: '__global__', agentSlug: '' } as never,
    });
  });
  await waitFor(() => expect(pickerProps.at(-1)!.selectionInvalid).toBe(true));
  expect(pickerProps.at(-1)!.startWithDefault).toBe(false);
  expect(pickerProps.at(-1)!.initialPrompt).toBe('Keep me');
  act(() => pickerProps.at(-1)!.onClose());
  act(() => {
    dispatchNewChatIntent({});
  });
  await waitFor(() => expect(pickerProps.at(-1)!.selectionInvalid).toBe(false));
});

// Review F3: a dismissed hand-off hands back the dock's draft as the person
// left it there, not the text Home first sent.
test("a dismissed hand-off returns the dock's edited draft", async () => {
  renderDockedPane();
  const onClosed = vi.fn();
  act(() => {
    dispatchNewChatIntent({
      initialPrompt: 'First words',
      selection: { context: '__global__', agentSlug: 'assistant' },
      handoff: { kind: 'skills' },
      onClosed,
    });
  });
  await screen.findByRole('dialog', { name: 'New chat picker' });
  act(() => pickerProps.at(-1)!.onDraftChange('First words, then more'));
  act(() => pickerProps.at(-1)!.onClose());
  expect(onClosed).toHaveBeenCalledExactlyOnceWith(
    'dismissed',
    'First words, then more',
  );
});
