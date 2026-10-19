/** @vitest-environment jsdom */

/**
 * The session context card in the REAL dock (`ChatWorkspacePane` inside
 * `DockShell`): whether it shows is the conversation surface's own measured
 * width, and the header items it replaces (the branch badge, the More
 * trigger's running-count badge) stand down only while it shows. While it is
 * folded away the header chip opens the same rows as a sheet.
 *
 * jsdom has no layout, so the one measurement the fit reads — the
 * conversation surface's rendered width — is supplied per test; everything
 * from that number to the DOM is the production path. The Activity line is
 * the real ladder read over a real inbox row for the active chat.
 *
 * Not proved here: CSS geometry (the card's column, the sheet's docking).
 * The browser screenshots in the PR carry those.
 */

import { SESSION_STATUS_WORDS } from '@kontourai/station-contracts/session-attention';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ChatWorkspacePane } from '../components/chat-dock/ChatDock';
import { DockShell } from '../components/chat-dock/DockShell';
import {
  closeSessionInventoryOccurrence,
  openSessionInventoryOccurrence,
} from '../components/chat-dock/sessionInventoryOccurrence';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../contexts/NavigationContext';
import { navigationStore } from '../contexts/navigation-store';
import type { ChatSession } from '../types';
import type { HomeWorkItem } from '../views/home/home-view-model';

const fixture = vi.hoisted(() => ({
  session: null as unknown,
  git: undefined as unknown,
  inbox: [] as unknown[],
  backgroundRunning: 0,
  surfaceWidth: 0,
  authority: undefined as unknown,
  pullRequests: [] as unknown[],
  // The card chunk's state: `ready` renders the real card; `loading`
  // suspends forever (a chunk still in flight); `failed` throws (a chunk
  // that did not load).
  cardChunk: 'ready' as 'ready' | 'loading' | 'failed',
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'test', name: 'Test Station' },
    captureCredentialEvidence: () => undefined,
  }),
}));

// --- Everything NOT under test: mocked to the lightest shape that lets the
// real ChatWorkspacePane mount without crashing. Navigation, device settings
// (a real store, no provider needed) and the keyboard-shortcut registry stay
// real — those are exactly what the shortcut registry exercises.

// `RegionModelProvider` wraps the whole application, so `useShowSurface`
// requires it. This harness mounts a fragment of that tree, and nothing
// here asserts a surface reveal, so the command hook is supplied directly.
const showSurfaceStub = vi.hoisted(() => vi.fn());
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurfaceStub,
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
  useHostRequestAuthorityScope: () => fixture.authority,
}));

vi.mock(
  '@kontourai/station-sdk/conversation-pull-request-links',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@kontourai/station-sdk/conversation-pull-request-links')
    >()),
    getConversationPullRequestLinks: async () => ({
      conversationId: 'conversation-1',
      observedAt: new Date().toISOString(),
      links: fixture.pullRequests,
    }),
  }),
);

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
  useAgentsLoaded: () => true,
}));

vi.mock('../contexts/ConfigContext', () => ({
  useConfig: () => ({ defaultChatFontSize: 14, defaultModel: undefined }),
  CONFIG_DEFAULTS: { defaultChatFontSize: 14 },
}));

vi.mock('../contexts/ModelsContext', () => ({
  useModelsCatalog: () => ({
    models: [],
    isLiveConfirmed: true,
    modelsLoading: false,
  }),
}));

vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: [] }),
  useScopedProjectsQuery: () => ({ data: [], isSuccess: true }),
  useScopedProjectQuery: () => ({ data: undefined, isSuccess: true }),
  useProject: () => undefined,
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../contexts/ActiveChatsContext', () => ({
  activeChatsStore: {
    getState: () => ({}),
    getSnapshot: () => ({}),
    subscribe: () => () => {},
  },
  useActiveChatActions: () => ({
    initChat: vi.fn(),
    removeChat: vi.fn(),
    updateChat: vi.fn(),
    addEphemeralMessage: vi.fn(),
    clearEphemeralMessages: vi.fn(),
  }),
}));

vi.mock('../contexts/open-chats-store', () => ({
  openChatsStore: {
    getState: () => ({}),
    subscribe: () => () => {},
    registerNavigation: () => () => {},
  },
  useOpenChats: () => [],
  useOpenChatInbox: () => ({
    items: [],
    currentSessionIdByConversation: new Map(),
  }),
  countOpenChatAttention: () => 0,
}));

vi.mock('../hooks/useActiveChatSessions', () => ({
  useRehydrateSessions: () => () => {},
  useCancelMessage: () => vi.fn(),
}));

vi.mock('../hooks/useActiveProject', () => ({
  useActiveProject: () => ({ projectSlug: undefined }),
}));

vi.mock('../hooks/useBackgroundTasks', () => ({
  useChatBackgroundTasksRunningCount: () => fixture.backgroundRunning,
}));

vi.mock('../hooks/useChatDockActions', () => ({
  useChatDockActions: () => ({}),
}));

vi.mock('../hooks/useChatInput', () => ({
  useChatInput: () => ({
    input: '',
    attachments: [],
    textareaRef: { current: null },
    currentModel: undefined,
    canModelSelect: false,
    modelQuery: null,
    commandQuery: null,
    slashCommands: [],
    handleInputChange: vi.fn(),
    handleSend: vi.fn(async () => {}),
    handleCancel: vi.fn(),
    handleClearInput: vi.fn(),
    handleAddAttachments: vi.fn(),
    handleRemoveAttachment: vi.fn(),
    handleClearAttachments: vi.fn(),
    handleModelSelect: vi.fn(),
    handleModelReset: vi.fn(),
    handleModelClose: vi.fn(),
    handleModelOpen: vi.fn(),
    handleModelRuntimeOptionChange: vi.fn(),
    handleApprovalModeChange: vi.fn(),
    handleCommandSelect: vi.fn(async () => {}),
    handleCommandClose: vi.fn(),
    handleHistoryUp: vi.fn(),
    handleHistoryDown: vi.fn(),
    updateFromInput: vi.fn(),
    closeAll: vi.fn(),
    setAttachmentError: vi.fn(),
    selectAttachmentFiles: vi.fn(async () => {}),
  }),
}));

vi.mock('../hooks/useDerivedSessions', () => ({
  useDerivedSessions: () => [],
}));

vi.mock('../hooks/useExitTransition', () => ({
  useExitTransition: (open: boolean) => ({ mounted: open, exiting: false }),
}));

vi.mock('../hooks/orchestration/ensureOrchestrationEventStream', () => ({
  ensureOrchestrationEventStream: () => {},
}));

vi.mock('../components/chat-dock/useChatDockViewModel', () => ({
  useChatDockViewModel: () => ({
    activeSession: fixture.session,
    activeChatAgent: undefined,
    activeChatModelLabel: undefined,
    activeSessionForHook: null,
    activeOrchestrationSessionRead: 'present',
    gitStatus: fixture.git,
    sessionProjectName: 'Demo project',
    sessionDisplayCwd: '/work/demo',
    sessionCodingLayout: undefined,
    dockProjectSlug: undefined,
    mobileProjectName: undefined,
    availableModels: [],
    modelSupportsAttachments: false,
    fileAttachmentsSupported: false,
  }),
}));

// The inbox's rows for this harness: one row for the active chat, so the
// card's Activity line is the real ladder read over a real row.
vi.mock('../views/home/useInboxWorkItems', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../views/home/useInboxWorkItems')>();
  return { ...actual, useInboxWorkItems: () => fixture.inbox };
});

vi.mock('../components/chat-dock/useChatDockActiveChatSync', () => ({
  useChatDockActiveChatSync: () => {},
}));

vi.mock('../components/chat/ShareIntakeController', () => ({
  ShareIntakeController: () => null,
}));

// `ChatDock.tsx` pre-warms `RegionPaneHost`'s lazy chunk at module
// load (`void loadRegionPaneHost`), which this test never
// actually needs (it imports `DockShell` directly, not through the ambient
// host). Left real, that dynamic import cascades into `HomeWorkspacePane` /
// `HomeSurface` and can resolve AFTER this test file's environment tears
// down, throwing an unhandled rejection that Vitest warns can produce false
// positives elsewhere. Stubbed to a no-op component so the prewarm has
// nothing async to chase.
// The transcript and the context meter are other owners' surfaces and need
// providers this fragment does not mount; neither is under test here.
vi.mock('../components/chat-dock/ChatDockContentArea', () => ({
  ChatDockContentArea: () => <div data-testid="transcript" />,
}));
vi.mock('../components/conversation-stats/ConversationStats', () => ({
  ContextPercentage: () => null,
}));

// The inventory's lazily loaded entry, reduced to the one decision under test:
// which presentation the REAL resolver picks from the props the dock's host
// handed it. The chunk itself is another lane's surface.
vi.mock('../components/chat-dock/SessionInventoryEntryPoint', async () => {
  const { resolveSessionInventoryCompactHost } = await import(
    '../components/chat-dock/sessionInventoryCompactHost'
  );
  return {
    SessionInventoryEntryPoint: (props: {
      isMobile: boolean;
      dockMode: 'bottom' | 'right';
      fullscreen: boolean;
    }) => (
      <div
        data-testid="inventory-entry"
        data-host={resolveSessionInventoryCompactHost(props)}
      />
    ),
  };
});

// The card's module stands as itself unless a test holds its chunk back.
vi.mock(
  '../components/chat-dock/SessionContextCard',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../components/chat-dock/SessionContextCard')
      >();
    const never = new Promise<never>(() => {});
    return {
      ...actual,
      SessionContextCard: (
        props: Parameters<typeof actual.SessionContextCard>[0],
      ) => {
        if (fixture.cardChunk === 'loading') throw never;
        if (fixture.cardChunk === 'failed') throw new Error('chunk failed');
        return <actual.SessionContextCard {...props} />;
      },
    };
  },
);

vi.mock('../workspace-panes/RegionPaneHost', () => ({
  RegionPaneHost: () => null,
}));

vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-sdk')>();
  return {
    ...actual,
    telemetry: { track: () => {} },
    useAcknowledgeConversationMutation: () => ({ mutate: () => {} }),
    useEngineConnectionsQuery: () => ({ data: [] }),
    useConversationInventoryQuery: () => ({ data: [] }),
    useGenerateSessionSummaryMutation: () => ({ mutate: () => {} }),
    useInvalidateQuery: () => () => {},
    useOrchestrationSessionsQuery: () => ({
      data: [],
      status: 'success',
      refetch: () => {},
    }),
  };
});

const SESSION: ChatSession = {
  id: 'chat-1',
  conversationId: 'conversation-1',
  currentSessionId: 'thread-1',
  agentSlug: 'codex' as ChatSession['agentSlug'],
  agentName: 'Codex',
  title: 'Fix the parser',
  source: 'dock' as ChatSession['source'],
  messages: [],
  input: '',
  attachments: [],
  queuedMessages: ['and then run the tests'],
  status: 'idle',
  projectSlug: 'demo',
} as unknown as ChatSession;

const GIT = {
  isRepo: true,
  branch: 'feature/parser',
  changes: [' M src/parser.ts', '?? src/new.ts'],
  staged: 0,
  unstaged: 1,
  untracked: 1,
  lastCommit: null,
  ahead: 2,
  behind: 0,
};

function inboxRow(overrides: Partial<HomeWorkItem>): HomeWorkItem {
  return {
    id: 'conversation-1',
    kind: 'chat',
    title: 'Fix the parser',
    projectLabel: 'Demo project',
    agentLabel: 'Codex',
    updatedAt: Date.now(),
    lifecycleLabel: 'Running',
    chatSessionId: 'chat-1',
    conversationId: 'conversation-1',
    orchestrationThreadId: 'thread-1',
    ...overrides,
  } as HomeWorkItem;
}

function DockedChat() {
  return (
    <DockShell>
      {(shellChrome) => (
        <ChatWorkspacePane placement="dock" shellChrome={shellChrome} />
      )}
    </DockShell>
  );
}

const realRect = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/?dock=open');
  navigationStore.navigate('/', { dock: 'open', maximize: null });
  fixture.session = SESSION;
  fixture.git = GIT;
  fixture.inbox = [inboxRow({})];
  fixture.backgroundRunning = 2;
  fixture.surfaceWidth = 1200;
  fixture.authority = undefined;
  fixture.pullRequests = [];
  fixture.cardChunk = 'ready';
  // The one layout fact the fit reads: the conversation surface's width.
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const rect = realRect.call(this);
    if (!this.classList.contains('chat-dock__conversation-surface'))
      return rect;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: rect.bottom,
      height: rect.height,
      right: fixture.surfaceWidth,
      width: fixture.surfaceWidth,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = realRect;
  cleanup();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  navigationStore.navigate('/', { dock: null, maximize: null });
  vi.unstubAllGlobals();
});

function renderDock() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <KeyboardShortcutsProvider>
        <NavigationProvider>
          <DockedChat />
        </NavigationProvider>
      </KeyboardShortcutsProvider>
    </QueryClientProvider>,
  );
  expect(
    document.querySelector('.chat-dock__conversation-surface'),
  ).not.toBeNull();
}

const card = () =>
  document.querySelector<HTMLElement>('aside.session-context-card');
const branchBadge = () => document.querySelector('.git-badge');
const moreBadge = () => document.querySelector('.chat-dock__more-badge');
// The header's "This chat: <project>" lead-in, shown when the chat's own
// project differs from the dock's bound one (the fixture binds none).
const mismatchLabel = () =>
  document.querySelector('.chat-dock__project-session-name');
const chip = () => screen.queryByRole('button', { name: /^This chat/ });

describe('session context card visibility follows the dock body width', () => {
  test('a wide dock shows the card and hides the header items it repeats', async () => {
    fixture.surfaceWidth = 1200;
    renderDock();
    await waitFor(() => expect(card()).not.toBeNull());
    expect(branchBadge()).toBeNull();
    expect(moreBadge()).toBeNull();
    expect(mismatchLabel()).toBeNull();
    expect(chip()).toBeNull();
    const aside = card()!;
    expect(aside.textContent).toContain('feature/parser');
    expect(aside.textContent).toContain('2 changed files');
    expect(aside.textContent).toContain('Background tasks — 2 running');
    expect(aside.textContent).toContain('1 pending message');
    expect(aside.textContent).toContain('Demo project');
  });

  test('a narrow dock folds the card behind a chip and keeps the header items', async () => {
    // 919px: one short of the 640px transcript floor plus the 280px card.
    fixture.surfaceWidth = 919;
    renderDock();
    await waitFor(() => expect(chip()).not.toBeNull());
    expect(card()).toBeNull();
    expect(branchBadge()?.textContent).toContain('feature/parser');
    expect(moreBadge()?.textContent).toBe('2');
    expect(mismatchLabel()?.textContent).toBe('This chat: Demo project');
  });

  test.each([
    ['still loading', 'loading'],
    ['failed to load', 'failed'],
  ] as const)(
    'while the card chunk is %s the header keeps its facts',
    async (_, state) => {
      fixture.cardChunk = state;
      fixture.surfaceWidth = 1200;
      renderDock();
      if (state === 'failed')
        await screen.findByText('Unable to load this part of Station.');
      else
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        });
      expect(card()).toBeNull();
      expect(branchBadge()?.textContent).toContain('feature/parser');
      expect(moreBadge()?.textContent).toBe('2');
      expect(mismatchLabel()).not.toBeNull();
    },
  );

  test('the threshold is the transcript floor plus the card column', async () => {
    fixture.surfaceWidth = 920;
    renderDock();
    await waitFor(() => expect(card()).not.toBeNull());
  });
});

describe('the Activity row speaks the status ladder', () => {
  test.each([
    ['Running', 'Running'],
    ['Needs attention', 'Waiting on you'],
    ['Failed', 'Failed'],
    ['Completed', 'Done'],
  ] as const)('%s reads %s', async (lifecycleLabel, word) => {
    fixture.inbox = [inboxRow({ lifecycleLabel })];
    renderDock();
    await waitFor(() => expect(card()).not.toBeNull());
    const status = card()!.querySelector('.session-context-card__status');
    expect(status?.textContent).toBe(word);
    expect(Object.values(SESSION_STATUS_WORDS)).toContain(word);
  });

  test('the folded chip carries the same ladder word', async () => {
    fixture.surfaceWidth = 600;
    fixture.inbox = [inboxRow({ lifecycleLabel: 'Needs attention' })];
    renderDock();
    await waitFor(() => expect(chip()).not.toBeNull());
    expect(chip()!.textContent).toBe('Waiting on you');
  });

  test('with no inbox row yet the card names no state', async () => {
    fixture.inbox = [];
    renderDock();
    await waitFor(() => expect(card()).not.toBeNull());
    expect(card()!.querySelector('.session-context-card__status')).toBeNull();
  });
});

describe('each row opens the existing surface', () => {
  test('Branch opens the Active work changed files panel', async () => {
    renderDock();
    await waitFor(() => expect(card()).not.toBeNull());
    fireEvent.click(
      screen.getByRole('button', {
        name: /^Changed files — 2 on feature\/parser/,
      }),
    );
    expect(
      await screen.findByRole('complementary', { name: 'Active work files' }),
    ).not.toBeNull();
  });

  test('Activity opens Background tasks', async () => {
    renderDock();
    await waitFor(() => expect(card()).not.toBeNull());
    showSurfaceStub.mockClear();
    fireEvent.click(
      screen.getByRole('button', { name: /Background tasks — 2 running/ }),
    );
    // A desktop dock places the Agents pane (#2050) rather than the sheet.
    expect(showSurfaceStub).toHaveBeenCalledWith('workspace-agents');
  });

  test('Workspace opens the session project', async () => {
    renderDock();
    await waitFor(() => expect(card()).not.toBeNull());
    fireEvent.click(
      screen.getByRole('button', { name: 'Open project — Demo project' }),
    );
    await waitFor(() =>
      expect(navigationStore.getSnapshot().pathname).toMatch(/demo/),
    );
  });
});

describe('the chip opens the rows as a sheet', () => {
  test('opens and closes; Escape returns focus to the chip', async () => {
    fixture.surfaceWidth = 600;
    renderDock();
    await waitFor(() => expect(chip()).not.toBeNull());
    fireEvent.click(chip()!);
    const dialog = await screen.findByRole('dialog', { name: 'This chat' });
    expect(dialog.textContent).toContain('feature/parser');
    expect(chip()!.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'This chat' })).toBeNull(),
    );
    expect(chip()!.getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(document.activeElement).toBe(chip()));
  });

  test('a row action closes the sheet before opening its surface', async () => {
    fixture.surfaceWidth = 600;
    renderDock();
    await waitFor(() => expect(chip()).not.toBeNull());
    fireEvent.click(chip()!);
    await screen.findByRole('dialog', { name: 'This chat' });
    fireEvent.click(
      screen.getByRole('button', {
        name: /^Changed files — 2 on feature\/parser/,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'This chat' })).toBeNull(),
    );
    expect(
      await screen.findByRole('complementary', { name: 'Active work files' }),
    ).not.toBeNull();
  });
});

const AUTHORITY = {
  apiBase: 'http://test.local',
  authorityKey: 'authority-1',
  isCurrent: () => true,
};

/**
 * The per-answer Basis chip's own admission call: it names the chat and the
 * authority, not a host, so it is admitted only when exactly ONE host is
 * registered for that chat (`matches.length === 1`).
 */
function admitBasisOccurrence() {
  return openSessionInventoryOccurrence({
    authorityKey: AUTHORITY.authorityKey,
    activeSessionId: 'chat-1',
    executionSessionId: 'thread-1',
    executionRead: 'present',
    trigger: null,
  });
}

function stubPhone() {
  // The shell's mobile query (`useIsMobile`) matches; nothing else does.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width: 768px'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
}

describe('one inventory host per chat', () => {
  afterEach(() => closeSessionInventoryOccurrence());

  test.each([
    ['desktop', false],
    ['phone', true],
  ] as const)(
    'on a %s exactly one host registers, so an answer can open Chat inventory',
    async (_, phone) => {
      if (phone) stubPhone();
      fixture.authority = AUTHORITY;
      renderDock();
      await waitFor(() => expect(admitBasisOccurrence()).toBe(true));
      // The admitted occurrence renders through that one host, which hands the
      // entry the phone/desktop presentation it was mounted for.
      const entry = await screen.findByTestId('inventory-entry');
      // One host, so one presentation: a second host under the same id would
      // render the occurrence twice, and one under another id would make the
      // admission above refuse.
      expect(screen.getAllByTestId('inventory-entry')).toHaveLength(1);
      if (phone) expect(entry.dataset.host).toBe('full-fallback');
      else expect(entry.dataset.host).not.toBe('full-fallback');
      // And the card's footer is pressable once that host exists.
      if (!phone) {
        await waitFor(() =>
          expect(
            screen.getByRole('button', { name: 'Chat inventory' }),
          ).toHaveProperty('disabled', false),
        );
      }
    },
  );
});

describe('linked pull requests', () => {
  test('a linked pull request shows its row, which opens Chat details', async () => {
    fixture.authority = AUTHORITY;
    fixture.pullRequests = [
      {
        provider: 'github',
        host: 'github.com',
        repository: { owner: 'acme', name: 'parser' },
        ref: '42',
        source: 'explicit',
        observedAt: new Date().toISOString(),
        status: {
          state: 'current',
          title: 'Parser fix',
          pullRequestState: 'OPEN',
        },
      },
    ];
    renderDock();
    const row = await screen.findByRole('button', {
      name: '1 linked pull request — open chat details',
    });
    expect(row.textContent).toContain('#42');
    expect(row.textContent).toContain('Parser fix');
    showSurfaceStub.mockClear();
    fireEvent.click(row);
    expect(showSurfaceStub).toHaveBeenCalledWith('activity', {
      session: 'thread-1',
    });
  });

  test('nothing linked adds no row', async () => {
    fixture.authority = AUTHORITY;
    renderDock();
    await waitFor(() => expect(card()).not.toBeNull());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(card()!.textContent).not.toContain('Pull requests');
  });
});

describe('on a phone', () => {
  beforeEach(() => {
    stubPhone();
  });

  async function openFromActions() {
    const actions = await screen.findByRole('button', { name: 'Chat actions' });
    fireEvent.click(actions);
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'This chat — Running' }),
    );
    return actions;
  }

  test('never shows the card inline, whatever the width, and adds no third control to the bar', async () => {
    fixture.surfaceWidth = 1200;
    renderDock();
    await screen.findByRole('button', { name: 'Chat actions' });
    expect(card()).toBeNull();
    expect(chip()).toBeNull();
  });

  test('the actions sheet row opens a bottom sheet; closing it returns to ⋯', async () => {
    renderDock();
    const actions = await openFromActions();
    const dialog = await screen.findByRole('dialog', { name: 'This chat' });
    expect(
      dialog.closest('.responsive-surface-overlay')?.hasAttribute('data-sheet'),
    ).toBe(true);
    // The branch is a labelled row here, not a bare line in the actions sheet.
    expect(dialog.textContent).toContain('Branch');
    expect(dialog.textContent).toContain('feature/parser');
    fireEvent.click(screen.getByRole('button', { name: 'Close chat context' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'This chat' })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(actions));
  });

  test('a row in the sheet closes it before opening its surface', async () => {
    renderDock();
    await openFromActions();
    await screen.findByRole('dialog', { name: 'This chat' });
    fireEvent.click(
      screen.getByRole('button', {
        name: /^Changed files — 2 on feature\/parser/,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'This chat' })).toBeNull(),
    );
    expect(
      await screen.findByRole('dialog', { name: 'Active work files' }),
    ).not.toBeNull();
  });
});
