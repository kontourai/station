// @vitest-environment jsdom

/**
 * #3077: one chat, two inboxes, one status line.
 *
 * The sidebar's Open-chats mini-inbox and the dock inbox both render the
 * shared row, but a row only says what its ITEM says, and the sidebar used
 * to build its own item from the chat store (`useOpenChats` alone) while the
 * dock merged the chat with its server session. For a chat whose session
 * awaits an approval that read "Needs approval" in the dock and "Idle" in
 * the sidebar at the same moment (the `overlay-dock-project-mismatch`
 * gallery screen caught it). Both surfaces now read the one derivation
 * (`useInboxWorkItems`); this renders both from one store state and one
 * real-fold session and requires the same words.
 *
 * The sidebar is the real `ProjectSidebar` (its mocks mirror
 * `ProjectSidebar.test.tsx`, minus the open-chats mock: the store and the
 * derivation are real here). The dock side is `ChatDockInboxPanel` fed by
 * the same hook and facts `ChatDock.tsx` hands it; `ChatDock` itself is too
 * large to mount here, so its three-line wiring to the hook is the one
 * thing this file takes on trust.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createRef, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FOLD_FIXTURES,
  FOLD_SESSION_CREATED_AT,
} from '../../../tests/helpers/session-summary-fold-fixtures';
import type { AgentSummary } from '../types';

const NOW = Date.parse('2026-09-30T10:01:15.000Z');
const CHAT_TAB = 'tab-1';
const AGENTS: AgentSummary[] = [
  { slug: agentId('demo-agent'), name: 'Demo agent' },
];
/** The row's accessible name: its title and its project. The chat is bound
 *  to Project B and the session reports no slug, so the merge must name the
 *  chat's project, not the session side's "No project" fallback. */
const ROW_NAME = 'Mismatch demo chat, Project B';

/** The server's own fold of a turn that opened an approval (#3042). */
const SESSIONS: OrchestrationSessionSummary[] = [
  {
    provider: 'claude',
    threadId: 'T',
    status: 'running',
    createdAt: FOLD_SESSION_CREATED_AT,
    updatedAt: '2026-09-30T10:00:05.000Z',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 3,
    assignedAgentSlug: agentId('demo-agent'),
    ...FOLD_FIXTURES.approvalInOpenTurn.summary,
  },
];

const showSurfaceStub = vi.hoisted(() => vi.fn());
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurfaceStub,
  useShowSurfacePage: () => showSurfaceStub,
}));
vi.mock('../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => null,
}));
vi.mock('../build-info', () => ({
  buildInfo: { version: '0.1.2', commit: 'test' },
}));
vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: [], isLoading: false }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => AGENTS,
}));
vi.mock('../contexts/NavigationContext', () => {
  const navigation = () => ({
    selectedProject: null,
    selectedProjectLayout: null,
    navigate: vi.fn(),
    setProject: vi.fn(),
    setLayout: vi.fn(),
    pathname: '/',
  });
  return {
    useNavigation: (
      selector?: (state: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});
vi.mock('../hooks/useBranding', () => ({
  useBranding: () => ({ appName: 'Station' }),
}));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({
    isTauri: false,
    productName: undefined,
    channel: undefined,
  }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
  useHostRequestAuthorityScope: () => undefined,
}));
vi.mock('../hooks/useIsMobile', async (importActual) => ({
  ...(await importActual<typeof import('../hooks/useIsMobile')>()),
  useIsMobile: () => false,
}));
// The sessions the sidebar reads, and the sidebar footer's and Boards
// section's reads, answered the way `ProjectSidebar.test.tsx` answers them.
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useOrchestrationSessionsQuery: () => ({ data: SESSIONS }),
  useProjectLayoutsQuery: () => ({ data: [] }),
  useReorderProjectsMutation: () => ({ mutate: vi.fn() }),
  useFeaturePreviewsQuery: () => ({ data: [] }),
  useBoardAvailabilityQuery: () => ({ data: undefined }),
  useAttentionQuery: () => ({ data: { pendingCount: 0 } }),
  usePersonalLayoutsQuery: () => ({ data: [] }),
  useCreatePersonalLayoutMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useUpdatePersonalLayoutMutation: () => ({ mutate: vi.fn() }),
  useDeletePersonalLayoutMutation: () => ({ mutate: vi.fn() }),
  usePromotePersonalLayoutMutation: () => ({ mutate: vi.fn() }),
}));

import { ChatDockInboxPanel } from '../components/chat-dock/ChatDockInboxPanel';
import { MobileTaskSwitcher } from '../components/chat-dock/MobileTaskSwitcher';
import { ProjectSidebar } from '../components/project-sidebar/ProjectSidebar';
import { activeChatsStore } from '../contexts/active-chats-store';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { useInboxWorkItems } from '../views/home/useInboxWorkItems';
import { useWorkFacts } from '../views/home/useWorkFacts';

/** The dock inbox the way `ChatDock.tsx` mounts it: the shared items and
 *  the facts derived beside them. */
function DockInbox() {
  const items = useInboxWorkItems(AGENTS, SESSIONS);
  const workFacts = useWorkFacts(items, SESSIONS);
  return (
    <ChatDockInboxPanel
      items={items}
      workFacts={workFacts}
      activeChatSessionId={null}
      openChatSessionIds={[CHAT_TAB]}
      onFocusChat={vi.fn()}
      onOpenConversation={vi.fn()}
      onOpenSession={vi.fn()}
      onCloseChat={vi.fn()}
      onOpenHistory={vi.fn()}
      now={NOW}
    />
  );
}

/** The mobile task switcher the way `ChatDock.tsx` mounts it: the same
 *  items and facts as the dock panel. It portals its sheet, so its rows are
 *  found on the document rather than in a container. */
function MobileSwitcher() {
  const items = useInboxWorkItems(AGENTS, SESSIONS);
  const workFacts = useWorkFacts(items, SESSIONS);
  return (
    <MobileTaskSwitcher
      open
      tasks={items}
      workFacts={workFacts}
      activeChatSessionId={null}
      openChatSessionIds={[CHAT_TAB]}
      visualViewportStyle={{}}
      triggerRef={createRef<HTMLButtonElement>()}
      onClose={vi.fn()}
      onFocusChat={vi.fn()}
      onOpenConversation={vi.fn()}
      onOpenSession={vi.fn()}
      onCloseChat={vi.fn()}
      now={NOW}
    />
  );
}

function renderWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <KeyboardShortcutsProvider>{ui}</KeyboardShortcutsProvider>
    </QueryClientProvider>,
  );
}

/** The status line as drawn, without screen-reader-only text. */
function statusTextIn(root: HTMLElement): string {
  const clone = within(root)
    .getByTestId('inbox-row-status')
    .cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll('.sr-only')) hidden.remove();
  return clone.textContent ?? '';
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  window.localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  // ONE store state: the chat this tab holds open, on the folded session's
  // conversation. On its own the chat store says nothing about the open
  // approval; only the session does.
  activeChatsStore.initChat(CHAT_TAB, {
    agentSlug: 'demo-agent',
    agentName: 'Demo agent',
    title: 'Mismatch demo chat',
    conversationId: 'T',
    currentSessionId: 'T',
    projectSlug: 'project-b',
    projectName: 'Project B',
  });
});

afterEach(() => {
  cleanup();
  activeChatsStore.removeChat(CHAT_TAB);
  vi.useRealTimers();
});

describe('a chat open in this tab reads the same status in the sidebar and the dock', () => {
  it('both say "Needs approval" for a session awaiting one', async () => {
    const sidebar = renderWithProviders(<ProjectSidebar />);
    const sidebarRow = await within(sidebar.container).findByRole('button', {
      name: ROW_NAME,
    });
    const sidebarSection = sidebarRow.closest(
      '#sidebar-open-chats',
    ) as HTMLElement;
    expect(sidebarSection).not.toBeNull();

    const dock = renderWithProviders(<DockInbox />);
    const dockRow = await within(dock.container).findByRole('button', {
      name: ROW_NAME,
    });

    const sidebarStatus = statusTextIn(sidebarSection);
    const dockStatus = statusTextIn(dock.container);
    // Pinned to the word, not only to each other: two surfaces agreeing on
    // "Idle" for a session that awaits an approval would still be wrong.
    expect(dockStatus).toBe('Needs approval');
    expect(sidebarStatus).toBe(dockStatus);
    // The lane they file it in agrees.
    expect(within(sidebarSection).getByTestId('inbox-row').dataset.lane).toBe(
      'needsYou',
    );
    expect(within(dock.container).getByTestId('inbox-row').dataset.lane).toBe(
      'needsYou',
    );
    // And it is the same item: the accessible name (title and project) too.
    expect(dockRow.getAttribute('aria-label')).toBe(ROW_NAME);
    expect(sidebarRow.getAttribute('aria-label')).toBe(ROW_NAME);
    expect(
      within(dock.container).getByText('Project B', {
        selector: '.inbox-row__project',
      }),
    ).toBeTruthy();
  });

  it('the mobile task switcher shows the same row', async () => {
    renderWithProviders(<MobileSwitcher />);
    const row = await screen.findByRole('button', { name: ROW_NAME });
    const sheet = row.closest('[data-testid="inbox-row"]') as HTMLElement;
    expect(within(sheet).getByText('Needs approval')).toBeTruthy();
    expect(sheet.dataset.lane).toBe('needsYou');
  });

  it('the sidebar row is the dock item for that chat, not a second derivation', () => {
    // The merged item carries the session it was merged with; a chat-only
    // item carries none. Both surfaces read this one.
    let items: ReturnType<typeof useInboxWorkItems> = [];
    function Probe() {
      items = useInboxWorkItems(AGENTS, SESSIONS);
      return null;
    }
    render(<Probe />);
    const row = items.find((item) => item.chatSessionId === CHAT_TAB);
    expect(row).toMatchObject({
      id: 'T',
      kind: 'chat',
      lifecycleLabel: 'Needs attention',
      orchestrationThreadId: 'T',
    });
    // Every open chat has its one item here; nothing is invented for it.
    expect(
      items.filter((item) => item.chatSessionId === CHAT_TAB),
    ).toHaveLength(1);
  });
});
