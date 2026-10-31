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
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';
import {
  type ConversationListItem,
  conversationQueries,
  orchestrationQueries,
} from '@kontourai/station-sdk';
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
import { activeChatsStore } from '../../../contexts/active-chats-store';
import { ConversationsProvider } from '../../../contexts/ConversationsContext';
import { KeyboardShortcutsProvider } from '../../../contexts/KeyboardShortcutsContext';
import {
  NavigationProvider,
  useNavigation,
} from '../../../contexts/NavigationContext';
import { navigationStore } from '../../../contexts/navigation-store';
import { openChatsStore } from '../../../contexts/open-chats-store';
import {
  PaneRelationsProvider,
  type PaneRelationsValue,
  usePaneRelations,
} from '../../../contexts/PaneRelationsContext';
import {
  RegionModelProvider,
  type RegionModelValue,
  useRegionModel,
} from '../../../contexts/RegionModelContext';
import { ToastProvider, toastStore } from '../../../contexts/ToastContext';
import { useShowSurface } from '../../../contexts/useShowSurface';
import { isChatInForeground } from '../../../hooks/orchestration/chatForeground';
import type { useOpenConversation } from '../../../hooks/useActiveChatSessionLifecycle';
import { deviceSettingsStore } from '../../../lib/device-settings-store';
import { dispatchNewChatIntent } from '../../../lib/newChatIntent';
import {
  type ProjectChatComposerDraft,
  requestProjectChat,
} from '../../../lib/projectChatEvents';
import { registerDialogHistory } from '../../dialog-history';
import { displayableProjectIcon } from '../../icons/ProjectIcon';

const {
  createChatSession,
  sendMessage,
  updateChat,
  pickerProps,
  pickerMounts,
  autoStarts,
  dockProbe,
  sendAdmission,
  openConversationAction,
} = vi.hoisted(() => ({
  sendAdmission: {} as { onActiveSessionChange?: (id: string) => void },
  openConversationAction: vi
    .fn<ReturnType<typeof useOpenConversation>>()
    .mockResolvedValue(null),
  createChatSession: vi.fn(() => 'new-session'),
  sendMessage: vi.fn(),
  updateChat: vi.fn(),
  pickerProps: [] as Record<string, any>[],
  /** One entry per mount of the picker, not per render. */
  pickerMounts: [] as Record<string, any>[],
  /** What an automatic start (`startWithDefault`) would have sent, per mount. */
  autoStarts: [] as (string | undefined)[],
  dockProbe: {
    mobile: false,
    agentsLoaded: true,
    sessions: [] as Record<string, any>[],
    agents: [{ slug: 'assistant', name: 'Assistant' }],
  },
}));

const RUN_LOCATIONS = {
  pulse: { kind: 'execution-root', path: '/work/pulse/app' },
};
const runLocationReads: boolean[] = [];

// The shape the icon picker stores: a base64 image data URL.
const PULSE_ICON = 'data:image/png;base64,iVBORw0KGgo=';
const projects = [
  {
    slug: 'pulse',
    name: 'Pulse',
    workingDirectory: '/work/pulse',
    icon: PULSE_ICON,
  },
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
    sessionProjectMismatchLabel,
    onToggleInbox,
  }: {
    activeCount: number;
    projectSwitcher?: { projectName: string } | null;
    sessionProjectMismatchLabel?: string;
    onToggleInbox?: () => void;
  }) => (
    <>
      <div data-testid="mobile-dock-work-badge">{activeCount}</div>
      <div data-testid="mobile-dock-project-name">
        {projectSwitcher?.projectName}
      </div>
      <div data-testid="mobile-dock-mismatch">
        {sessionProjectMismatchLabel}
      </div>
      <button type="button" onClick={onToggleInbox}>
        Open task switcher
      </button>
    </>
  ),
}));

// #4266: what the pane hands the "last viewed" recorder on each render. The
// recorder's own rules are tested with it; this pins the pane's wiring.
const acknowledgeCalls = vi.hoisted(
  () => [] as { id: string | undefined; visible: boolean }[],
);
vi.mock('../useAcknowledgeVisibleConversation', () => ({
  useAcknowledgeVisibleConversation: (
    item: { id: string } | undefined,
    visible: boolean,
  ) => {
    acknowledgeCalls.push({ id: item?.id, visible });
  },
}));

vi.mock('../../modals/NewChatModal', async () => {
  const { useEffect } = await import('react');
  return {
    NewChatModal: (props: Record<string, any>) => {
      pickerProps.push(props);
      // The real draft runs its automatic start once per mount, so a
      // remount is what would start (and send) a second time.
      useEffect(() => {
        pickerMounts.push(props);
        if (props.startWithDefault) autoStarts.push(props.initialPrompt);
      }, []);
      return (
        <section aria-label="New chat picker" className="new-chat-modal">
          <textarea aria-label="Draft text" />
        </section>
      );
    },
  };
});
vi.mock('../../../hooks/useActiveChatSessions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCreateChatSession: () => createChatSession,
  // Records the admission callback a send would call (`onSessionMigrate`).
  useSendMessage: (
    _apiBase: string,
    onActiveSessionChange?: (id: string) => void,
  ) => {
    sendAdmission.onActiveSessionChange = onActiveSessionChange;
    return sendMessage;
  },
  useCancelMessage: () => vi.fn(),
  useRehydrateSessions: () => vi.fn(),
  useOpenConversation: () => openConversationAction,
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
  // The run-locations read; each call is one render of a component reading it.
  useScopedProjectRunLocationsQuery: () => {
    runLocationReads.push(true);
    return { data: RUN_LOCATIONS };
  },
}));
vi.mock('../../../contexts/AgentsContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgents: () => dockProbe.agents,
  useAgentsLoaded: () => dockProbe.agentsLoaded,
}));

// The active chat's transcript and composer are stood in for: the file-drop
// test asks only which pane owns attachments, and the marker shows a chat is
// active.
vi.mock('../ChatDockBody', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    // Reports its composer as the real body does, so focus requests reach it.
    ChatDockBody: ({
      onComposerEnabledChange,
    }: {
      onComposerEnabledChange?: (el: HTMLTextAreaElement | null) => void;
    }) => {
      const composer = useRef<HTMLTextAreaElement>(null);
      useEffect(() => {
        onComposerEnabledChange?.(composer.current);
        return () => onComposerEnabledChange?.(null);
      }, [onComposerEnabledChange]);
      return (
        <div data-testid="active-chat-body">
          <p data-testid="answer-selection">Ready for review.</p>
          <textarea aria-label="Chat composer" ref={composer} />
        </div>
      );
    },
  };
});

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

afterEach(async () => {
  cleanup();
  // An open draft folds its Back entry on unmount; let that traversal land.
  await flushHistory();
  act(() => toastStore.clear());
  paneQueryClient = undefined;
  pickerProps.length = 0;
  pickerMounts.length = 0;
  autoStarts.length = 0;
  runLocationReads.length = 0;
  createChatSession.mockClear();
  sendMessage.mockClear();
  updateChat.mockClear();
  dockProbe.mobile = false;
  dockProbe.agentsLoaded = true;
  dockProbe.sessions = [];
  dockProbe.agents = [{ slug: 'assistant', name: 'Assistant' }];
  acknowledgeCalls.length = 0;
  activeChatsStore.removeChat('chat-a');
  activeChatsStore.removeChat('chat-b');
  openConversationAction.mockReset().mockResolvedValue(null);
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

function RouteScopedChatPane() {
  const { selectedProject, selectedProjectLayout } = useNavigation();
  if (!selectedProject || !selectedProjectLayout) return null;
  return (
    <ChatWorkspacePane
      key={`${selectedProject}:${selectedProjectLayout}`}
      placement="fullscreen"
      projectSlug={selectedProject}
      layoutSlug={selectedProjectLayout}
    />
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

let regionModel: RegionModelValue | undefined;
function CaptureRegionModel() {
  regionModel = useRegionModel();
  return null;
}

let relations: PaneRelationsValue | undefined;
function CaptureRelations() {
  relations = usePaneRelations();
  return null;
}

/** The pane's QueryClient, so a test can see what it invalidates. */
let paneQueryClient: QueryClient | undefined;
function renderInProviders(pane: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  paneQueryClient = queryClient;
  render(
    <QueryClientProvider client={queryClient}>
      <KeyboardShortcutsProvider>
        <NavigationProvider>
          <ToastProvider>
            <ConversationsProvider>
              <ActiveChatsProvider>
                <RegionModelProvider>
                  <PaneRelationsProvider>
                    <CaptureShowSurface />
                    <CaptureRelations />
                    <CaptureRegionModel />
                    {pane}
                  </PaneRelationsProvider>
                </RegionModelProvider>
              </ActiveChatsProvider>
            </ConversationsProvider>
          </ToastProvider>
        </NavigationProvider>
      </KeyboardShortcutsProvider>
    </QueryClientProvider>,
  );
}

test('a remote start from the picker closes it, refreshes sessions, and names its Station with Open task', async () => {
  renderPane('pulse');
  act(() => {
    requestProjectChat({
      projectSlug: 'pulse',
      projectName: 'Pulse',
      source: 'new-plugin',
      composerDraft: draft,
    });
  });
  await screen.findByRole('region', { name: 'New chat picker' });
  const props = pickerProps.at(-1)!;
  const invalidate = vi.spyOn(paneQueryClient!, 'invalidateQueries');

  act(() =>
    props.onTaskStarted({ sessionId: 'session:remote' }, 'brian-media'),
  );

  await waitFor(() =>
    expect(
      screen.queryByRole('region', { name: 'New chat picker' }),
    ).toBeNull(),
  );
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: orchestrationQueries.sessions().queryKey,
  });
  const toast = toastStore
    .getSnapshot()
    .find((entry) => entry.message === 'Task started on brian-media.');
  expect(toast?.sessionId).toBe('session:remote');
  expect(toast?.actions?.map((action) => action.label)).toEqual(['Open task']);
});

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

  await screen.findByRole('region', { name: 'New chat picker' });
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
  await screen.findByRole('region', { name: 'New chat picker' });
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
  expect(screen.getByRole('region', { name: 'New chat picker' })).toBeTruthy();
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

test('the docked destination names the bound Project, never the foreign chat on screen', async () => {
  openForeignChatInPulseBoundDock();
  await act(async () => {});

  // New's destination: the bound Project. Its tooltip is where a NEW chat
  // runs, not the foreign chat's directory, and the bar prints no "This
  // chat" contrast beside it (the chat's own project is its context card).
  const badge = screen.getByRole('button', { name: 'New chats: Pulse' });
  expect(badge.getAttribute('title')).not.toContain('/work/other');
  expect(document.querySelector('.chat-dock__project-session-name')).toBeNull();

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

test('a foreign chat’s code layout is its own Project’s, not the badge’s (archive#4525 review HIGH-2)', async () => {
  openForeignChatInPulseBoundDock();
  await act(async () => {});

  // The bar carries no branch badge any more (the context card's Branch row
  // does); the More menu's Open in Coding still follows the chat's Project.
  expect(
    document.querySelector('.chat-dock__project-context .git-badge'),
  ).toBeNull();

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

  fireEvent.click(screen.getByRole('button', { name: 'New chats: Pulse' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Switch to Other' }),
  );
  await act(async () => {});

  expect(deviceSettingsStore.get('chatDockProjectSlug')).toBe('other');
  expect(screen.getByRole('button', { name: 'New chats: Other' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'New chat picker' })).toBeNull();
  expect(pickerProps).toHaveLength(0);
  expect(createChatSession).not.toHaveBeenCalled();
});

test('the docked New chat button opens a draft in the bound Project with one ready Agent', async () => {
  deviceSettingsStore.set('chatDockProjectSlug', 'pulse');
  navigationStore.navigate('/', { dock: 'open' });
  renderDockedPane();
  await act(async () => {});

  fireEvent.click(screen.getByTitle('New chat (Ctrl+T)'));
  await screen.findByRole('region', { name: 'New chat picker' });
  expect(pickerProps.at(-1)!.activeProjectSlug).toBe('pulse');
  expect(pickerProps.at(-1)!.startSurface).toBe(true);
  expect(createChatSession).not.toHaveBeenCalled();
});

test('the dock reads run locations only while the start composer is open, and hands them over', async () => {
  deviceSettingsStore.set('chatDockProjectSlug', 'pulse');
  navigationStore.navigate('/', { dock: 'open' });
  renderDockedPane();
  await act(async () => {});
  // Nothing reads run locations while the dock shows no start composer.
  expect(runLocationReads).toEqual([]);

  fireEvent.click(screen.getByTitle('New chat (Ctrl+T)'));
  await screen.findByRole('region', { name: 'New chat picker' });

  expect(runLocationReads.length).toBeGreaterThan(0);
  expect(pickerProps.at(-1)!.projectRunLocations).toEqual(RUN_LOCATIONS);
});

test('the dock hands the start composer the sidebar’s project icons', async () => {
  deviceSettingsStore.set('chatDockProjectSlug', 'pulse');
  navigationStore.navigate('/', { dock: 'open' });
  renderDockedPane();
  await act(async () => {});

  fireEvent.click(screen.getByTitle('New chat (Ctrl+T)'));
  await screen.findByRole('region', { name: 'New chat picker' });
  const icons = pickerProps.at(-1)!.projectIconBySlug as ReadonlyMap<
    string,
    string
  >;
  expect(displayableProjectIcon(PULSE_ICON)).toBe(PULSE_ICON);
  expect(icons.get('pulse')).toBe(displayableProjectIcon(PULSE_ICON));
  expect(icons.has('other')).toBe(false);
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
  await screen.findByRole('region', { name: 'New chat picker' });
  expect(pickerProps.at(-1)!.activeProjectSlug).toBe('pulse');
  expect(createChatSession).not.toHaveBeenCalled();
});

/** `chat-a` open in this tab, which is what puts it in the inbox's rows. */
function openChatA() {
  dockProbe.sessions = [chatSession('chat-a')];
  activeChatsStore.initChat('chat-a', {
    agentSlug: 'assistant',
    agentName: 'Assistant',
    title: 'Pulse chat',
    projectSlug: 'pulse',
  } as Parameters<typeof activeChatsStore.initChat>[1]);
}

test('the open pane records the chat on screen as viewed (#4266)', async () => {
  openChatA();
  navigationStore.navigate('/', { chat: 'chat-a' });
  renderPane('pulse');
  await act(async () => {});
  expect(screen.getByTestId('active-chat-body')).toBeTruthy();
  expect(acknowledgeCalls.at(-1)).toEqual({ id: 'chat-a', visible: true });
});

test('a phone opens its dock at the inbox without adding a modal layer', async () => {
  dockProbe.mobile = true;
  openChatA();
  navigationStore.navigate('/', { dock: 'open' });
  renderDockedPane();
  const inbox = await screen.findByRole('region', { name: 'Inbox' });
  expect(inbox.closest('.chat-dock__workspace')).not.toBeNull();
  expect(screen.queryByRole('dialog', { name: 'Chats and tasks' })).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Pulse chat, pulse' }),
  ).toBeTruthy();
});

test('returning to the inbox keeps the reader mounted and preserves its unsent text', async () => {
  dockProbe.mobile = true;
  openChatA();
  navigationStore.navigate('/', { chat: 'chat-a', dock: 'open' });
  renderDockedPane();
  const composer = await screen.findByRole('textbox', {
    name: 'Chat composer',
  });
  fireEvent.change(composer, { target: { value: 'Keep this draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open task switcher' }));
  const inbox = await screen.findByRole('region', { name: 'Inbox' });
  expect(composer.isConnected).toBe(true);
  expect(composer.closest('[hidden]')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open task switcher' }));
  expect(screen.queryByRole('region', { name: 'Inbox' })).toBeNull();
  expect(inbox.isConnected).toBe(true);
  expect(screen.getByRole('textbox', { name: 'Chat composer' })).toBe(composer);
  expect((composer as HTMLTextAreaElement).value).toBe('Keep this draft');
});

test('the phone’s task switcher covers the chat, so it stops counting as viewed (#4266)', async () => {
  dockProbe.mobile = true;
  openChatA();
  navigationStore.navigate('/', { chat: 'chat-a' });
  renderPane('pulse');
  await act(async () => {});
  expect(acknowledgeCalls.at(-1)).toEqual({ id: 'chat-a', visible: true });
  fireEvent.click(screen.getByRole('button', { name: 'Open task switcher' }));
  await act(async () => {});
  expect(acknowledgeCalls.at(-1)).toEqual({ id: 'chat-a', visible: false });
});

// A New chat draft covers the chat on screen like the task switcher does, so
// the covered chat stops counting as viewed until the draft goes.
test('a chat covered by a New chat draft stops counting as viewed', async () => {
  openChatA();
  navigationStore.navigate('/', { chat: 'chat-a' });
  renderPane('pulse');
  await act(async () => {});
  expect(acknowledgeCalls.at(-1)).toEqual({ id: 'chat-a', visible: true });
  act(() => {
    dispatchNewChatIntent({});
  });
  await screen.findByRole('region', { name: 'New chat picker' });
  expect(acknowledgeCalls.at(-1)).toEqual({ id: 'chat-a', visible: false });
  act(() => pickerProps.at(-1)!.onClose());
  await act(async () => {});
  expect(acknowledgeCalls.at(-1)).toEqual({ id: 'chat-a', visible: true });
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
  expect(screen.queryByRole('region', { name: 'New chat picker' })).toBeNull();
  // An ordinary open is still its own.
  let accepted = false;
  act(() => {
    accepted = dispatchNewChatIntent({});
  });
  expect(accepted).toBe(true);
  await screen.findByRole('region', { name: 'New chat picker' });
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
  await screen.findByRole('region', { name: 'New chat picker' });
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
  await screen.findByRole('region', { name: 'New chat picker' });
  act(() => pickerProps.at(-1)!.onDraftChange('First words, then more'));
  act(() => pickerProps.at(-1)!.onClose());
  expect(onClosed).toHaveBeenCalledExactlyOnceWith(
    'dismissed',
    'First words, then more',
  );
});

test('a Personal Board draft opens one projectless chat picker and stays unsent after Agent selection', async () => {
  renderDockedPane();
  let claimed = false;
  act(() => {
    claimed = requestProjectChat({
      projectSlug: null,
      source: 'personal-board',
      composerDraft: {
        ...draft,
        message: 'Use propose_personal_board for /boards/daily.',
      },
    });
  });
  expect(claimed).toBe(true);
  await screen.findByRole('region', { name: 'New chat picker' });
  const props = pickerProps.at(-1)!;
  expect(props.activeProjectSlug).toBeNull();
  expect(props.draftContext.items[0].messageLine).toBe(
    'Use propose_personal_board for /boards/daily.',
  );
  expect(createChatSession).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
  act(() =>
    props.onSelect(
      { slug: 'assistant', name: 'Assistant' },
      undefined,
      undefined,
      props.draftContext.items[0].messageLine,
    ),
  );
  expect(createChatSession).toHaveBeenCalled();
  expect(updateChat).toHaveBeenCalledWith(
    'new-session',
    expect.objectContaining({
      input: 'Use propose_personal_board for /boards/daily.',
    }),
  );
  expect(sendMessage).not.toHaveBeenCalled();
});

/**
 * The real docked pane publishes the conversation it shows as its pane-opener
 * selection (docs/design/pane-relationships.md), so a preview it opened for
 * one conversation hides while another is on screen. Outside a region pane
 * the opener occurrence is the workspace Chat. Removing the pane's
 * `usePublishOpenerSelection` call fails both assertions.
 */
test('the docked pane publishes the conversation it shows, and follows the selection', async () => {
  dockProbe.sessions = [
    { ...chatSession('chat-a'), conversationId: 'conversation-a' },
    { ...chatSession('chat-b'), conversationId: 'conversation-b' },
  ];
  navigationStore.navigate('/', { dock: 'open', chat: 'chat-a' });
  renderDockedPane();
  await waitFor(() =>
    expect(relations?.currentSelection('chat-workspace')).toBe(
      'conversation:conversation-a',
    ),
  );
  act(() => navigationStore.setActiveChat('chat-b'));
  await waitFor(() =>
    expect(relations?.currentSelection('chat-workspace')).toBe(
      'conversation:conversation-b',
    ),
  );
});

// New chat is a draft in the dock's own body, in place of the chat on
// screen, not a dialog stacked over the page: a collapsed dock opens to show
// it, and going to a chat leaves it (the request hears 'dismissed').
test('New chat opens as a draft in the dock body, expanding a collapsed dock; focusing a chat leaves it', async () => {
  dockProbe.sessions = [chatSession('chat-a')];
  navigationStore.navigate('/', { chat: 'chat-a' });
  renderDockedPane();
  await act(async () => {});
  expect(screen.getByTestId('active-chat-body')).toBeTruthy();
  // Collapse it. The region model owns visibility; navigation mirrors it.
  act(() => regionModel!.setRegion('bottom', { visible: false }));
  expect(regionModel!.regions.bottom.visible).toBe(false);

  const onClosed = vi.fn();
  act(() => {
    dispatchNewChatIntent({ initialPrompt: 'Draft words', onClosed });
  });
  const draft = await screen.findByRole('region', { name: 'New chat picker' });
  // In the dock's conversation surface, where the transcript was.
  await waitFor(() => expect(regionModel!.regions.bottom.visible).toBe(true));
  expect(draft.closest('.chat-dock__conversation-surface')).not.toBeNull();
  // The chat it opened over stays mounted under it, hidden and inert.
  const covered = screen.getByTestId('active-chat-body');
  expect(covered.closest('[hidden]')).not.toBeNull();
  expect(covered.closest('[inert]')).not.toBeNull();
  expect(pickerProps.at(-1)!.initialPrompt).toBe('Draft words');

  act(() => {
    openChatsStore.focus({ sessionId: 'chat-a' });
  });
  await waitFor(() =>
    expect(
      screen.queryByRole('region', { name: 'New chat picker' }),
    ).toBeNull(),
  );
  expect(onClosed).toHaveBeenCalledExactlyOnceWith('dismissed', undefined);
  expect(screen.getByTestId('active-chat-body')).toBe(covered);
  expect(covered.closest('[hidden]')).toBeNull();
});

// Any route that moves the dock to another chat leaves the draft, not only the
// dock's own focus paths: here the `?chat=` pointer (a toast's Open, a share,
// browser history) names another chat.
test('the dock moving to another chat by any route dismisses the draft with its text', async () => {
  dockProbe.sessions = [chatSession('chat-a'), chatSession('chat-b')];
  navigationStore.navigate('/', { dock: 'open', chat: 'chat-a' });
  renderDockedPane();
  await act(async () => {});
  const onClosed = vi.fn();
  act(() => {
    dispatchNewChatIntent({ initialPrompt: 'Keep me', onClosed });
  });
  await screen.findByRole('region', { name: 'New chat picker' });
  act(() => pickerProps.at(-1)!.onDraftChange('Keep me, edited'));

  act(() => navigationStore.setActiveChat('chat-b'));
  await waitFor(() =>
    expect(
      screen.queryByRole('region', { name: 'New chat picker' }),
    ).toBeNull(),
  );
  expect(onClosed).toHaveBeenCalledExactlyOnceWith(
    'dismissed',
    'Keep me, edited',
  );
});

// A bare New chat (header, Cmd+T, the palette) while a draft is open keeps
// that draft and focuses it; a request carrying something replaces it.
test.each([false, true])(
  'a plain New chat keeps the open draft and focuses it (mobile=%s); one with a prompt replaces it',
  async (mobile) => {
    dockProbe.mobile = mobile;
    navigationStore.navigate('/', { dock: 'open' });
    renderDockedPane();
    await act(async () => {});
    const onClosed = vi.fn();
    act(() => {
      dispatchNewChatIntent({ initialPrompt: 'Mine', onClosed });
    });
    await screen.findByRole('region', { name: 'New chat picker' });
    const mounts = pickerMounts.length;
    if (mobile) {
      fireEvent.click(
        screen.getByRole('button', { name: 'Open task switcher' }),
      );
      await screen.findByRole('region', { name: 'Inbox' });
      expect(pickerProps.at(-1)!.historyActive).toBe(false);
    }

    act(() => {
      dispatchNewChatIntent({});
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('textbox', { name: 'Draft text' }),
      ),
    );
    expect(pickerMounts).toHaveLength(mounts);
    expect(onClosed).not.toHaveBeenCalled();

    act(() => {
      dispatchNewChatIntent({ initialPrompt: 'Something else' });
    });
    await waitFor(() => expect(pickerMounts).toHaveLength(mounts + 1));
    expect(pickerProps.at(-1)!.initialPrompt).toBe('Something else');
    expect(onClosed).toHaveBeenCalledExactlyOnceWith('dismissed', undefined);
  },
);

// Collapsing the dock (as a phone's setup journey does) keeps the draft
// mounted, hidden: its whole state survives, and an automatic start that
// already ran never runs again on reopening.
test('collapsing and reopening the dock keeps the same draft and never re-runs its automatic start', async () => {
  navigationStore.navigate('/', { dock: 'open' });
  renderDockedPane();
  await act(async () => {});
  act(() => {
    dispatchNewChatIntent({
      startWithDefault: true,
      initialPrompt: 'Go once',
      selection: { context: '__global__', agentSlug: 'assistant' },
    });
  });
  await screen.findByRole('region', { name: 'New chat picker' });
  expect(autoStarts).toEqual(['Go once']);
  const mounts = pickerMounts.length;

  act(() => regionModel!.setRegion('bottom', { visible: false }));
  await waitFor(() =>
    expect(
      screen.queryByRole('region', { name: 'New chat picker' }),
    ).toBeNull(),
  );
  // Hidden, not gone.
  expect(
    document.querySelector('section[aria-label="New chat picker"]'),
  ).not.toBeNull();

  act(() => regionModel!.setRegion('bottom', { visible: true }));
  await screen.findByRole('region', { name: 'New chat picker' });
  expect(pickerMounts).toHaveLength(mounts);
  expect(autoStarts).toEqual(['Go once']);
});

/** jsdom runs `history.back()` as chained 0ms tasks; let queued ones land. */
async function flushHistory() {
  for (let turn = 0; turn < 4; turn += 1)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

// Wiring only: a collapsed dock passes `historyActive: false` to its hidden
// draft. The mocked draft holds no Back entry, so the Back half below cannot
// fail here; the real seam is the StartComposerParity test "a draft out of
// view holds no Back entry…".
test('a collapsed dock tells its hidden draft it is out of view (no Back entry)', async () => {
  navigationStore.navigate('/', { dock: 'open' });
  renderDockedPane();
  await act(async () => {});
  const onClosed = vi.fn();
  act(() => {
    dispatchNewChatIntent({ initialPrompt: 'Keep me', onClosed });
  });
  await screen.findByRole('region', { name: 'New chat picker' });
  expect(pickerProps.at(-1)!.historyActive).toBe(true);
  await flushHistory();

  act(() => regionModel!.setRegion('bottom', { visible: false }));
  await flushHistory();
  expect(pickerProps.at(-1)!.historyActive).toBe(false);
  act(() => window.history.back());
  await flushHistory();

  expect(onClosed).not.toHaveBeenCalled();
  expect(
    document.querySelector('section[aria-label="New chat picker"]'),
  ).not.toBeNull();
});

// A chat hydrating into its tab after the draft opened (a cold `?chat=`) is
// the same chat, not the person going somewhere: the draft stays.
test('a cold ?chat= hydrating under an open draft does not dismiss it', async () => {
  dockProbe.sessions = [];
  // The cold lookup for the pointer is still in flight when the tab lands.
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input instanceof Request ? input.url : input).includes('conv-a')
        ? new Promise<Response>(() => {})
        : realFetch(input, init),
    ),
  );
  navigationStore.navigate('/', { dock: 'open', chat: 'conv-a' });
  renderDockedPane();
  await act(async () => {});
  const onClosed = vi.fn();
  act(() => {
    dispatchNewChatIntent({ initialPrompt: 'Mine', onClosed });
  });
  await screen.findByRole('region', { name: 'New chat picker' });

  // The tab for `?chat=conv-a` arrives: its id differs from the pointer.
  dockProbe.sessions = [{ ...chatSession('chat-a'), conversationId: 'conv-a' }];
  // Re-render the dock so it reads the hydrated tab list.
  act(() => regionModel!.setRegion('bottom', { maximized: true }));
  act(() => navigationStore.updateParams({ probe: '1' }));
  await act(async () => {});
  await act(async () => {});
  // It did hydrate: the chat is mounted under the draft.
  expect(screen.queryByTestId('active-chat-body')).not.toBeNull();

  expect(onClosed).not.toHaveBeenCalled();
  expect(screen.getByRole('region', { name: 'New chat picker' })).toBeTruthy();
  vi.stubGlobal('fetch', realFetch);
});

// The dock's own cover registration, end to end: the chat under a draft is
// not on screen for turn notifications.
test('the chat a draft covers is not foreground while the draft is open', async () => {
  dockProbe.sessions = [chatSession('chat-a')];
  navigationStore.navigate('/', { dock: 'open', chat: 'chat-a' });
  renderDockedPane();
  await act(async () => {});
  const ids = { chatKey: 'chat-a', threadId: 'chat-a' };
  expect(isChatInForeground(ids)).toBe(true);
  act(() => {
    dispatchNewChatIntent({});
  });
  await screen.findByRole('region', { name: 'New chat picker' });
  expect(isChatInForeground(ids)).toBe(false);
  act(() => pickerProps.at(-1)!.onClose());
  await waitFor(() => expect(isChatInForeground(ids)).toBe(true));
});

test('the ambient Inbox revokes foreground ownership and clears covered answer selection', async () => {
  dockProbe.mobile = true;
  openChatA();
  navigationStore.navigate('/', { dock: 'open', chat: 'chat-a' });
  renderDockedPane();
  const answer = await screen.findByTestId('answer-selection');
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(answer);
  selection.removeAllRanges();
  selection.addRange(range);
  const ids = { chatKey: 'chat-a', threadId: 'chat-a' };
  expect(isChatInForeground(ids)).toBe(true);
  expect(selection.toString()).toBe('Ready for review.');
  fireEvent.click(screen.getByRole('button', { name: 'Open task switcher' }));
  await screen.findByRole('region', { name: 'Inbox' });
  expect(isChatInForeground(ids)).toBe(false);
  expect(selection.isCollapsed).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Open task switcher' }));
  expect(isChatInForeground(ids)).toBe(true);
});

test('the Inbox does not accept a drop for the hidden chat or retain its drag affordance', async () => {
  dockProbe.mobile = true;
  openChatA();
  navigationStore.navigate('/', { dock: 'open', chat: 'chat-a' });
  renderDockedPane();
  await act(async () => {});
  expect(dragFileOverPane()).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Open task switcher' }));
  await screen.findByRole('region', { name: 'Inbox' });
  expect(dragFileOverPane()).toBe(false);
  expect(screen.queryByTestId('chat-pane-file-drop-overlay')).toBeNull();
});

function addSavedConversation() {
  paneQueryClient!.setQueryData(orchestrationQueries.sessions().queryKey, [
    {
      threadId: 'saved-thread',
      conversationId: 'saved-conversation',
      assignedAgentSlug: 'assistant',
      displayTitle: 'Saved conversation',
      projectSlug: 'pulse',
      provider: 'claude',
      status: 'idle',
      controlMode: 'station-owned',
      answerability: { answerable: true },
      isLoaded: true,
      isPersisted: true,
      eventCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ]);
}

test('a real failed history open stays at Inbox instead of falling back to the imported reader', async () => {
  dockProbe.mobile = true;
  openChatA();
  navigationStore.navigate('/', { dock: 'open', chat: 'chat-a' });
  renderDockedPane();
  await act(async () => {});
  act(addSavedConversation);
  fireEvent.click(screen.getByRole('button', { name: 'Open task switcher' }));
  const saved = await screen.findByRole('button', {
    name: 'Saved conversation, pulse',
  });
  fireEvent.click(saved);
  await act(async () => {});
  expect(openConversationAction).toHaveBeenCalledOnce();
  expect(screen.getByRole('region', { name: 'Inbox' })).toBeTruthy();
  expect(navigationStore.getSnapshot().activeChat).toBe('chat-a');
});

test.each([false, true])(
  'the global picker routes only a current selection and keeps the new-chat Project (deferred: %s)',
  async (deferred) => {
    openChatA();
    const conversation: ConversationListItem = {
      id: 'other-conversation',
      source: 'runtime',
      agentSlug: agentId('assistant'),
      title: 'Other Project conversation',
      projectSlug: 'other',
      mutable: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 2,
      answerability: { answerable: true },
    };
    const resolution: ConversationOpenResolution = {
      status: 'resolved',
      conversation,
      currentSessionId: conversation.id,
      transcript: { available: true, owner: 'runtime', messageCount: 2 },
      canContinue: true,
      answerability: { answerable: true },
      recoveryActions: [],
    };
    dockProbe.sessions.push({
      ...chatSession('chat-b'),
      conversationId: conversation.id,
      projectSlug: 'other',
      title: conversation.title,
    });
    activeChatsStore.initChat('chat-b', {
      agentSlug: agentId('assistant'),
      agentName: 'Assistant',
      title: conversation.title,
      projectSlug: 'other',
      conversationId: conversation.id,
    });
    let resolveOpen: (() => void) | undefined;
    const fetchBefore = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.endsWith('/api/conversations/other-conversation/open')) {
          if (deferred)
            await new Promise<void>((resolve) => {
              resolveOpen = resolve;
            });
          return Response.json({ success: true, data: resolution });
        }
        return fetchBefore(input, init);
      }),
    );
    try {
      navigationStore.setLayout('pulse', 'coding');
      navigationStore.setActiveChat('chat-a');
      // Entering Pulse's workspace chose Pulse for new chats.
      expect(deviceSettingsStore.get('chatDockProjectSlug')).toBe('pulse');
      renderInProviders(<RouteScopedChatPane />);
      await act(async () => {});
      act(() =>
        paneQueryClient!.setQueryData(
          conversationQueries.inventory().queryKey,
          {
            pages: [{ items: [conversation], hasMore: false }],
            pageParams: [undefined],
          },
        ),
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'More dock actions' }),
      );
      fireEvent.click(
        await screen.findByRole('menuitem', { name: /^Open chat/ }),
      );
      await screen.findByRole('dialog', { name: 'Open chat' });
      fireEvent.click(
        screen.getByRole('button', { name: /Other Project conversation/ }),
      );
      if (deferred) {
        await waitFor(() => expect(resolveOpen).toBeDefined());
        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() =>
          expect(
            screen.queryByRole('dialog', { name: 'Open chat' }),
          ).toBeNull(),
        );
        act(() => dispatchNewChatIntent({}));
        await screen.findByRole('region', { name: 'New chat picker' });
        await act(async () => resolveOpen!());
        expect(navigationStore.getSnapshot().activeChat).toBe('chat-a');
        expect(navigationStore.getSnapshot().pathname).toContain(
          '/projects/pulse/',
        );
        expect(
          screen.getByRole('region', { name: 'New chat picker' }),
        ).toBeTruthy();
        expect(deviceSettingsStore.get('chatDockProjectSlug')).toBe('pulse');
        return;
      }
      await waitFor(() =>
        expect(navigationStore.getSnapshot().pathname).toContain(
          '/projects/other/',
        ),
      );
      await waitFor(() =>
        expect(navigationStore.getSnapshot().activeChat).toBe(conversation.id),
      );
      expect(navigationStore.getSnapshot().pathname).toContain(
        '/projects/other/',
      );
      // Opening an existing conversation routes to its own Project without
      // replacing the Project chosen for new chats.
      expect(deviceSettingsStore.get('chatDockProjectSlug')).toBe('pulse');
      expect(openConversationAction).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal('fetch', fetchBefore);
    }
  },
);

test.each(['another-chat', 'new-chat', 'same-loading-chat'] as const)(
  'a delayed saved open preserves healthy hydration after selecting %s',
  async (next) => {
    dockProbe.mobile = true;
    openChatA();
    dockProbe.sessions.push({
      ...chatSession('chat-b'),
      title: 'Later conversation',
    });
    activeChatsStore.initChat('chat-b', {
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Later conversation',
      projectSlug: 'pulse',
    } as Parameters<typeof activeChatsStore.initChat>[1]);
    let finishOpen: ((id: string) => void) | undefined;
    let hydration: Parameters<ReturnType<typeof useOpenConversation>>[8];
    openConversationAction.mockImplementationOnce((...args) => {
      hydration = args[8];
      hydration!.initialized('late-saved-tab');
      return new Promise<string>((resolve) => {
        finishOpen = resolve;
      });
    });
    navigationStore.navigate('/', { dock: 'open', chat: 'chat-a' });
    renderDockedPane();
    await act(async () => {});
    act(addSavedConversation);
    fireEvent.click(screen.getByRole('button', { name: 'Open task switcher' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Saved conversation, pulse' }),
    );
    expect(finishOpen).toBeDefined();
    if (next === 'same-loading-chat') {
      dockProbe.sessions.push({
        ...chatSession('late-saved-tab'),
        conversationId: 'saved-conversation',
        title: 'Loading saved chat',
      });
      activeChatsStore.initChat('late-saved-tab', {
        title: 'Loading saved chat',
        agentSlug: agentId('assistant'),
        agentName: 'Assistant',
        conversationId: 'saved-conversation',
        projectSlug: 'pulse',
      });
      fireEvent.click(
        screen.getByRole('button', { name: 'Open task switcher' }),
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Open task switcher' }),
      );
      act(() => openChatsStore.focus({ sessionId: 'late-saved-tab' }));
    } else if (next === 'another-chat')
      fireEvent.click(
        screen.getByRole('button', { name: 'Later conversation, pulse' }),
      );
    else act(() => dispatchNewChatIntent({}));
    if (next === 'another-chat')
      expect(navigationStore.getSnapshot().activeChat).toBe('chat-b');
    else if (next === 'new-chat')
      await screen.findByRole('region', { name: 'New chat picker' });
    else
      expect(navigationStore.getSnapshot().activeChat).toBe(
        'saved-conversation',
      );
    expect(hydration!.current()).toBe(true);
    await act(async () => finishOpen!('late-saved-tab'));
    if (next === 'another-chat')
      expect(navigationStore.getSnapshot().activeChat).toBe('chat-b');
    else if (next === 'same-loading-chat')
      expect(navigationStore.getSnapshot().activeChat).toBe(
        'saved-conversation',
      );
    else {
      expect(
        screen.getByRole('region', { name: 'New chat picker' }),
      ).toBeTruthy();
      expect(navigationStore.getSnapshot().activeChat).toBe('chat-a');
    }
  },
);

test.each(['external-history', 'url-lookup', 'url-history'] as const)(
  'a pending %s open cannot replace a later New chat draft',
  async (entry) => {
    dockProbe.mobile = true;
    openChatA();
    let finishHistory: ((id: string) => void) | undefined;
    let finishLookup: (() => void) | undefined;
    openConversationAction.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishHistory = resolve;
        }),
    );
    const fetchBefore = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.endsWith('/api/conversations/cold-conversation')) {
          if (entry === 'url-lookup')
            await new Promise<void>((resolve) => {
              finishLookup = resolve;
            });
          return Response.json({
            success: true,
            data: {
              id: 'cold-conversation',
              agentSlug: 'assistant',
              projectSlug: 'other',
            },
          });
        }
        return fetchBefore(input, init);
      }),
    );
    try {
      navigationStore.navigate('/', {
        dock: 'open',
        chat: entry === 'external-history' ? 'chat-a' : 'cold-conversation',
      });
      renderDockedPane();
      await act(async () => {});
      if (entry === 'external-history')
        act(() =>
          openChatsStore.focus({
            conversationId: 'cold-conversation',
            agentSlug: 'assistant',
            projectSlug: 'other',
            threadId: 'cold-thread',
          }),
        );
      await waitFor(() =>
        expect(
          entry === 'url-lookup' ? finishLookup : finishHistory,
        ).toBeDefined(),
      );
      act(() => dispatchNewChatIntent({}));
      await screen.findByRole('region', { name: 'New chat picker' });
      await act(async () => {
        if (entry === 'url-lookup') finishLookup!();
        else finishHistory!('late-cold-tab');
      });
      expect(
        screen.getByRole('region', { name: 'New chat picker' }),
      ).toBeTruthy();
      expect(navigationStore.getSnapshot().activeChat).toBe(
        entry === 'external-history' ? 'chat-a' : 'cold-conversation',
      );
      expect(navigationStore.getSnapshot().pathname).toBe('/');
      if (entry === 'url-lookup')
        expect(openConversationAction).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal('fetch', fetchBefore);
    }
  },
);

test.each(['timer', 'catalog'] as const)(
  'a cold URL %s retry cannot renew selection after New chat',
  async (retry) => {
    dockProbe.mobile = true;
    dockProbe.agentsLoaded = retry !== 'catalog';
    openChatA();
    let releaseLookup: (() => void) | undefined;
    let lookupCount = 0;
    const fetchBefore = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.endsWith('/api/conversations/cold-conversation')) {
          lookupCount += 1;
          if (lookupCount === 1) {
            await new Promise<void>((resolve) => {
              releaseLookup = resolve;
            });
            if (retry === 'timer')
              return Response.json(
                { success: false, error: 'Temporary failure' },
                { status: 503 },
              );
          }
          return Response.json({
            success: true,
            data: {
              id: 'cold-conversation',
              agentSlug: 'assistant',
              projectSlug: 'other',
            },
          });
        }
        return fetchBefore(input, init);
      }),
    );
    try {
      navigationStore.navigate('/', {
        dock: 'open',
        chat: 'cold-conversation',
      });
      renderDockedPane();
      await waitFor(() => expect(releaseLookup).toBeDefined());
      await act(async () => releaseLookup!());
      act(() => {
        dispatchNewChatIntent({});
        dockProbe.agentsLoaded = true;
      });
      await screen.findByRole('region', { name: 'New chat picker' });
      if (retry === 'timer')
        await act(
          async () => new Promise((resolve) => setTimeout(resolve, 350)),
        );
      await act(async () => {});
      expect(lookupCount).toBe(1);
      expect(openConversationAction).not.toHaveBeenCalled();
      expect(navigationStore.getSnapshot().activeChat).toBe(
        'cold-conversation',
      );
      expect(
        screen.getByRole('region', { name: 'New chat picker' }),
      ).toBeTruthy();
    } finally {
      vi.stubGlobal('fetch', fetchBefore);
    }
  },
);

// The draft owns a file dropped on it; the chat it covers must not take it.
test('the covered chat does not take file drops while a draft is open', async () => {
  dockProbe.sessions = [chatSession('chat-a')];
  navigationStore.navigate('/', { dock: 'open', chat: 'chat-a' });
  renderDockedPane();
  await act(async () => {});
  expect(dragFileOverPane(), 'the active chat refused a file').toBe(true);
  act(() => {
    dispatchNewChatIntent({});
  });
  await screen.findByRole('region', { name: 'New chat picker' });
  expect(dragFileOverPane(), 'the covered chat took a file').toBe(false);
});

// Coming back from a setup journey that collapsed the dock shows the draft.
test('returning from setup reveals a collapsed dock’s draft', async () => {
  navigationStore.navigate('/', { dock: 'open' });
  renderDockedPane();
  await act(async () => {});
  act(() => {
    dispatchNewChatIntent({ initialPrompt: 'Mine' });
  });
  await screen.findByRole('region', { name: 'New chat picker' });
  act(() => regionModel!.setRegion('bottom', { visible: false }));
  expect(regionModel!.regions.bottom.visible).toBe(false);
  act(() => pickerProps.at(-1)!.onReturnFromSetup());
  await waitFor(() => expect(regionModel!.regions.bottom.visible).toBe(true));
  await screen.findByRole('region', { name: 'New chat picker' });
});

// A send admission completing in another chat moves the dock
// (`onSessionMigrate`); that is not the person leaving the draft.
test('a send admission moving the dock does not dismiss the open draft', async () => {
  dockProbe.sessions = [chatSession('chat-a'), chatSession('chat-b')];
  navigationStore.navigate('/', { dock: 'open', chat: 'chat-b' });
  renderDockedPane();
  await act(async () => {});
  const onClosed = vi.fn();
  act(() => {
    dispatchNewChatIntent({ initialPrompt: 'Mine', onClosed });
  });
  await screen.findByRole('region', { name: 'New chat picker' });
  expect(sendAdmission.onActiveSessionChange).toBeTypeOf('function');
  act(() => sendAdmission.onActiveSessionChange!('chat-a'));
  await act(async () => {});
  expect(onClosed).not.toHaveBeenCalled();
  expect(screen.getByRole('region', { name: 'New chat picker' })).toBeTruthy();
});

// The draft's own project chip is the one destination: the header's project
// controls stand down while it is open, on desktop and on a phone.
test('the header shows no project destination while a draft is open', async () => {
  deviceSettingsStore.set('chatDockProjectSlug', 'pulse');
  navigationStore.navigate('/', { dock: 'open' });
  renderDockedPane();
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'New chats: Pulse' })).toBeTruthy();
  act(() => {
    dispatchNewChatIntent({});
  });
  await screen.findByRole('region', { name: 'New chat picker' });
  expect(screen.queryByRole('button', { name: /^New chats:/ })).toBeNull();
  act(() => pickerProps.at(-1)!.onClose());
  await screen.findByRole('button', { name: 'New chats: Pulse' });
  cleanup();

  dockProbe.mobile = true;
  navigationStore.navigate('/', { dock: 'open' });
  renderDockedPane();
  await act(async () => {});
  expect(screen.getByTestId('mobile-dock-project-name').textContent).toBe(
    'Pulse',
  );
  act(() => {
    dispatchNewChatIntent({});
  });
  await screen.findByRole('region', { name: 'New chat picker' });
  expect(screen.getByTestId('mobile-dock-project-name').textContent).toBe('');
});

// A phone opens the draft full height from a half sheet; a dismissed draft
// gives the half sheet back, maximize memory included. A started one stays.
test('a phone draft dismissed from a half sheet restores the half sheet', async () => {
  dockProbe.mobile = true;
  dockProbe.sessions = [chatSession('new-session')];
  navigationStore.navigate('/', { dock: 'open' });
  renderDockedPane();
  await act(async () => {});
  act(() => regionModel!.setRegion('bottom', { maximized: false }));
  act(() => navigationStore.setDockState(true, false));
  expect(navigationStore.lastDockMaximized).toBe(false);

  act(() => {
    dispatchNewChatIntent({});
  });
  await screen.findByRole('region', { name: 'New chat picker' });
  await waitFor(() => expect(regionModel!.regions.bottom.maximized).toBe(true));

  act(() => pickerProps.at(-1)!.onClose());
  await waitFor(() =>
    expect(regionModel!.regions.bottom.maximized).toBe(false),
  );
  expect(regionModel!.regions.bottom.visible).toBe(true);
  expect(navigationStore.lastDockMaximized).toBe(false);
  expect(
    new URLSearchParams(window.location.search).get('maximize'),
  ).toBeNull();

  // Started: the new chat opens at the half sheet it had, as any chat.
  act(() => {
    dispatchNewChatIntent({});
  });
  await screen.findByRole('region', { name: 'New chat picker' });
  await waitFor(() => expect(regionModel!.regions.bottom.maximized).toBe(true));
  act(() => {
    pickerProps
      .at(-1)!
      .onSelect(
        { slug: 'assistant', name: 'Assistant' },
        undefined,
        undefined,
        'Go',
      );
  });
  await act(async () => {});
  expect(createChatSession).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(regionModel!.regions.bottom.maximized).toBe(false),
  );
  expect(regionModel!.regions.bottom.visible).toBe(true);
  expect(navigationStore.lastDockMaximized).toBe(false);
});

// On a phone the header's project switcher comes back with the draft gone,
// and the covered chat's project-mismatch note stands down while it is open.
test('the phone header hides the chat’s project facts only while a draft is open', async () => {
  dockProbe.mobile = true;
  openForeignChatInPulseBoundDock();
  await act(async () => {});
  const mismatch = () =>
    screen.getByTestId('mobile-dock-mismatch').textContent ?? '';
  expect(mismatch()).not.toBe('');
  expect(screen.getByTestId('mobile-dock-project-name').textContent).toBe(
    'Pulse',
  );
  act(() => {
    dispatchNewChatIntent({});
  });
  await screen.findByRole('region', { name: 'New chat picker' });
  expect(mismatch()).toBe('');
  expect(screen.getByTestId('mobile-dock-project-name').textContent).toBe('');
  act(() => pickerProps.at(-1)!.onClose());
  await waitFor(() =>
    expect(screen.getByTestId('mobile-dock-project-name').textContent).toBe(
      'Pulse',
    ),
  );
  expect(mismatch()).not.toBe('');
});

// Leaving a phone draft for a chat is going to that chat: the dock that the
// draft opened full height must stay open, not fold back to how it was.
test('a phone draft left for another chat keeps the dock open on that chat', async () => {
  dockProbe.mobile = true;
  dockProbe.sessions = [chatSession('chat-a')];
  navigationStore.navigate('/', { dock: null });
  renderDockedPane();
  await act(async () => {});
  act(() => regionModel!.setRegion('bottom', { visible: false }));
  expect(regionModel!.regions.bottom.visible).toBe(false);

  act(() => {
    dispatchNewChatIntent({});
  });
  await screen.findByRole('region', { name: 'New chat picker' });
  expect(regionModel!.regions.bottom.visible).toBe(true);

  // A toast's Open: the URL names the chat and an open dock.
  act(() => navigationStore.updateParams({ dock: 'open', chat: 'chat-a' }));
  await waitFor(() =>
    expect(
      screen.queryByRole('region', { name: 'New chat picker' }),
    ).toBeNull(),
  );
  await act(async () => {});
  expect(regionModel!.regions.bottom.visible).toBe(true);
  expect(screen.getByTestId('active-chat-body')).toBeTruthy();
  expect(screen.getByTestId('active-chat-body').closest('[hidden]')).toBeNull();
});

// Start navigates to its new chat while the draft still holds its Back entry;
// that navigation collapses the entry through the draft's own close. The
// draft has already started by then, so the close must not restore the
// phone dock's earlier (closed) size or tell the requester 'dismissed'.
test('a phone draft started from a closed dock opens its chat at its earlier size', async () => {
  dockProbe.mobile = true;
  dockProbe.sessions = [chatSession('new-session')];
  navigationStore.navigate('/', { dock: null });
  renderDockedPane();
  await act(async () => {});
  // Closed, remembering a half sheet.
  act(() => navigationStore.setDockState(false, false));
  act(() =>
    regionModel!.setRegion('bottom', { visible: false, maximized: false }),
  );
  const outcomes: string[] = [];
  act(() => {
    dispatchNewChatIntent({ onClosed: (outcome) => outcomes.push(outcome) });
  });
  await screen.findByRole('region', { name: 'New chat picker' });
  expect(regionModel!.regions.bottom.visible).toBe(true);
  // The real draft holds a Back entry closed by its own onClose.
  const draft = pickerProps.at(-1)!;
  const release = registerDialogHistory('draft-under-test', () =>
    draft.onClose(),
  );
  act(() => {
    pickerProps
      .at(-1)!
      .onSelect(
        { slug: 'assistant', name: 'Assistant' },
        undefined,
        undefined,
        'Go',
      );
  });
  release();
  await act(async () => {});
  expect(outcomes).toEqual(['started']);
  expect(regionModel!.regions.bottom.visible).toBe(true);
  // At the size the dock had, as opening any chat does: the full height
  // was the draft's.
  expect(regionModel!.regions.bottom.maximized).toBe(false);
  expect(new URL(window.location.href).searchParams.get('chat')).toBe(
    'new-session',
  );
});

// Start hands focus to the new chat's composer (`requestComposerFocus`),
// not back to whatever opened the draft.
test('Start focuses the new chat’s composer', async () => {
  dockProbe.sessions = [chatSession('new-session')];
  navigationStore.navigate('/', { dock: 'open' });
  renderDockedPane();
  await act(async () => {});
  act(() => {
    dispatchNewChatIntent({});
  });
  await screen.findByRole('region', { name: 'New chat picker' });
  act(() => (document.activeElement as HTMLElement | null)?.blur());
  act(() => {
    pickerProps
      .at(-1)!
      .onSelect(
        { slug: 'assistant', name: 'Assistant' },
        undefined,
        undefined,
        'Go',
      );
  });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Chat composer' }),
    ),
  );
});
