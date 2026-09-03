/**
 * @vitest-environment jsdom
 */

/**
 * archive#1300: (3) the WORK list under Home used to render the first three
 * open chats with no heading; (4) "New Project" used to be a full-width
 * "+ New Project" row instead of a `+` on the PROJECTS section header. Both
 * covered here against the real `ProjectSidebar` composition (mirrors
 * `ProjectSidebarReturnFocus.test.tsx`'s mock shape).
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { openChatsStore } from '../contexts/open-chats-store';

vi.mock('../build-info', () => ({
  buildInfo: { version: '0.1.2', commit: 'test' },
}));

const {
  chats,
  agents,
  navigate,
  setProject,
  setLayout,
  projects,
  sessions,
  platformProfile,
  branding,
} = vi.hoisted(() => ({
  chats: {} as Record<string, unknown>,
  agents: [] as Array<{ slug: string; name: string }>,
  navigate: vi.fn(),
  setProject: vi.fn(),
  setLayout: vi.fn(),
  projects: [] as Array<{ id: string; slug: string; name: string }>,
  sessions: [] as Array<Record<string, unknown>>,
  platformProfile: {
    isTauri: false,
    productName: undefined as string | undefined,
    channel: undefined as 'stable' | 'beta' | 'nightly' | 'dev' | undefined,
  },
  branding: { appName: 'Station' },
}));

vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects, isLoading: false }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => agents,
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  useAllActiveChats: () => chats,
}));
vi.mock('../contexts/open-chats-store', () => ({
  useOpenChats: () =>
    Object.entries(chats).map(([id, chat]: [string, any]) => ({
      id,
      chatSessionId: id,
      kind: 'chat',
      title: chat.title ?? 'Task',
      projectLabel: chat.projectLabel ?? 'Station',
      agentLabel:
        agents.find((agent) => agent.slug === chat.agentSlug)?.name ??
        chat.agentSlug,
      modelLabel: chat.model ?? 'Model not reported',
      lifecycleLabel: 'Recent',
      updatedAt: 0,
    })),
  openChatsStore: {
    focus: vi.fn(),
    openCollection: vi.fn(),
    registerNavigation: ({ openCollection }: any) => {
      openChatsStore.openCollection = openCollection;
      return vi.fn();
    },
  },
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    selectedProject: null,
    selectedProjectLayout: null,
    navigate,
    setProject,
    setLayout,
    pathname: '/',
  }),
}));
vi.mock('../hooks/useBranding', () => ({
  useBranding: () => branding,
}));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => platformProfile,
}));
vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));
vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionsQuery: () => ({ data: sessions }),
  useProjectLayoutsQuery: () => ({ data: [] }),
  useReorderProjectsMutation: () => ({ mutate: vi.fn() }),
  // archive#3313 routed the sidebar's visibility flags through
  // useSurfaceVisibilityFlags, which reads enabled previews from here. A
  // hand-rolled module mock owes every export its subject reaches, so this
  // file went red on main the moment that hook was added.
  useFeaturePreviewsQuery: () => ({ data: [] }),
  // archive#3780 gave ProjectSidebarRow the Board-availability read, and this
  // file went red again for exactly the reason recorded above — the same
  // hazard, one hook later. `undefined` is the honest shape while no row is
  // expanded: the row's read is gated `enabled: expanded && !collapsed`, so
  // the server is never asked, and nothing here asserts a Board entry.
  useBoardAvailabilityQuery: () => ({ data: undefined }),
}));

import { ProjectSidebar } from '../components/project-sidebar/ProjectSidebar';
import { chatDraftsStore } from '../contexts/chat-drafts-store';
import { deviceSettingsStore } from '../lib/device-settings-store';

function resetState() {
  for (const key of Object.keys(chats)) delete chats[key];
  agents.length = 0;
  projects.length = 0;
  sessions.length = 0;
  navigate.mockClear();
  setProject.mockClear();
  setLayout.mockClear();
  platformProfile.isTauri = false;
  platformProfile.productName = undefined;
  platformProfile.channel = undefined;
  branding.appName = 'Station';
  vi.mocked(openChatsStore.focus).mockClear();
  chatDraftsStore.clear('session-draft');
  window.localStorage.clear();
  // The device-settings singleton keeps in-memory state across tests;
  // clearing localStorage alone would leak a prior test's toggles.
  deviceSettingsStore.reloadFromStorage();
}

describe('ProjectSidebar WORK list labeling (station#1300)', () => {
  test.each([
    ['Stable', 'unexpected package title', 'stable', undefined],
    ['Beta', 'unexpected package title', 'beta', 'beta'],
    ['Nightly', 'unexpected package title', 'nightly', 'nightly'],
    ['Dev', 'unexpected package title', 'dev', 'dev'],
  ])(
    'uses trusted %s release identity while presenting its channel as a readable badge',
    (_name, packageName, channel, badge) => {
      resetState();
      platformProfile.isTauri = true;
      platformProfile.productName = packageName;
      platformProfile.channel = channel as typeof platformProfile.channel;
      branding.appName = 'Remote Station';
      render(<ProjectSidebar />);
      const home = screen.getByRole('button', {
        name: `Station${badge ? ` ${badge}` : ''} v0.1.2 Build timestamp unavailable. home`,
      });
      expect(
        home.querySelector('.sidebar__brand-name > span')?.textContent,
      ).toBe('Station');
      if (badge) {
        expect(home.querySelector('.sidebar__channel-badge')?.textContent).toBe(
          badge,
        );
      } else {
        expect(home.querySelector('.sidebar__channel-badge')).toBeNull();
      }
    },
  );

  test('retains web branding instead of a local package identity', () => {
    resetState();
    platformProfile.isTauri = false;
    platformProfile.productName = 'Station Nightly';
    platformProfile.channel = 'nightly';
    branding.appName = 'Acme Station';
    render(<ProjectSidebar />);
    expect(
      screen.getByRole('button', { name: 'Acme Station home' }).textContent,
    ).toContain('Acme Station');
  });

  test('labels the open-chat rows with an "Open chats" heading', async () => {
    resetState();
    chats['session-a'] = { title: 'Fix login bug', agentSlug: 'a' };
    agents.push({ slug: 'a', name: 'Agent A' });

    render(<ProjectSidebar />);
    expect(screen.getByText('Open chats')).toBeTruthy();
    // The mini-inbox rows are lazy-loaded (archive#3314) — await their chunk.
    expect(await screen.findByText('Fix login bug')).toBeTruthy();
  });

  test('hides the "Open chats" heading when there are none', () => {
    resetState();
    render(<ProjectSidebar />);
    expect(screen.queryByText('Open chats')).toBeNull();
  });

  test('projects real non-empty drafts into the sidebar and focuses their owning chat', () => {
    resetState();
    chats['session-draft'] = {
      title: 'Finish release notes',
      agentSlug: 'writer',
    };
    render(<ProjectSidebar />);

    act(() => chatDraftsStore.set('session-draft', '  Remember migration  '));
    expect(screen.getByText('Drafts')).toBeTruthy();
    const draft = screen.getByRole('button', {
      name: /finish release notes.*draft.*remember migration/i,
    });
    fireEvent.click(draft);
    expect(openChatsStore.focus).toHaveBeenCalledWith({
      sessionId: 'session-draft',
    });

    act(() => chatDraftsStore.clear('session-draft'));
    expect(screen.queryByText('Drafts')).toBeNull();

    act(() => chatDraftsStore.set('session-draft', '   '));
    expect(screen.queryByText('Drafts')).toBeNull();
  });
});

/**
 * archive#3314: "Open chats" is a mini-inbox — shared inbox rows
 * (compact variant), collapsible with the nav-group disclosure anatomy,
 * removable (device setting; restore lives in Settings → Appearance), with
 * the cap as a named constant and an "N more" affordance into the dock inbox.
 */
describe('ProjectSidebar Open chats mini-inbox (station#3314)', () => {
  function seedChats(count: number) {
    for (let index = 0; index < count; index += 1) {
      chats[`session-${index}`] = { title: `Chat ${index}`, agentSlug: 'a' };
    }
    agents.push({ slug: 'a', name: 'Agent A' });
  }

  test('rows render through the shared inbox row anatomy, and clicking focuses the chat', async () => {
    resetState();
    seedChats(1);
    render(<ProjectSidebar />);

    const row = await screen.findByRole('button', {
      name: 'Chat 0, Station',
    });
    expect(row.classList).toContain('chat-dock-inbox__item');
    expect(document.querySelector('.chat-dock-inbox--compact')).not.toBeNull();
    fireEvent.click(row);
    expect(openChatsStore.focus).toHaveBeenCalledWith({
      sessionId: 'session-0',
    });
  });

  test('the section collapses through the shared disclosure anatomy and persists', async () => {
    resetState();
    seedChats(1);
    const first = render(<ProjectSidebar />);

    const toggle = screen.getByRole('button', { name: 'Open chats' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe('sidebar-open-chats');
    await screen.findByText('Chat 0');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(
      document.getElementById('sidebar-open-chats')?.hasAttribute('hidden'),
    ).toBe(true);

    // Persisted device-side: a fresh mount stays collapsed.
    first.unmount();
    render(<ProjectSidebar />);
    expect(
      screen
        .getByRole('button', { name: 'Open chats' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });

  test('the section can be removed from the sidebar entirely', () => {
    resetState();
    seedChats(1);
    render(<ProjectSidebar />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove Open chats from sidebar' }),
    );
    expect(screen.queryByText('Open chats')).toBeNull();
    expect(deviceSettingsStore.get('sidebarSections').openChatsHidden).toBe(
      true,
    );
  });

  test('caps the list and offers "N more" that opens the dock inbox', async () => {
    resetState();
    seedChats(5);
    render(<ProjectSidebar />);

    await screen.findByText('Chat 0');
    expect(screen.getByText('Chat 2')).toBeTruthy();
    // Capped at OPEN_CHATS_SIDEBAR_CAP (3): the 4th/5th fold behind N more.
    expect(screen.queryByText('Chat 3')).toBeNull();

    // archive#3314: this used to assert `inboxOpen === true` as proof of
    // a destination. That setting DEFAULTS to true, so the assertion passed on
    // a fresh store whether or not anything wrote it — no power at all, for a
    // button that led nowhere on mobile and in an edge placement.
    //
    // The destination guarantee now lives with the dock, which is the only
    // thing that knows which surface is mounted, and is proven exhaustively in
    // chat-dock-utils.test.ts ("every chrome reaches a destination that
    // mounts"). What the SIDEBAR owes is delegation: ask, never guess.
    deviceSettingsStore.set('inboxOpen', false);
    fireEvent.click(screen.getByRole('button', { name: '2 more' }));
    expect(openChatsStore.openCollection).toHaveBeenCalledTimes(1);
    // The sidebar must NOT decide the destination itself — routing that from
    // here is what produced a dead end in the chromes it cannot see.
    expect(deviceSettingsStore.get('inboxOpen')).toBe(false);
  });

  test('Drafts collapses and removes independently', () => {
    resetState();
    chats['session-draft'] = { title: 'Draft owner', agentSlug: 'a' };
    render(<ProjectSidebar />);
    act(() => chatDraftsStore.set('session-draft', 'draft text'));

    const toggle = screen.getByRole('button', { name: 'Drafts' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove Drafts from sidebar' }),
    );
    expect(screen.queryByText('Drafts')).toBeNull();
    expect(deviceSettingsStore.get('sidebarSections').draftsHidden).toBe(true);

    act(() => chatDraftsStore.clear('session-draft'));
  });
});

describe('ProjectSidebar management navigation', () => {
  test('renders the Customize disclosure independently of deferred sidebar status', () => {
    resetState();
    render(<ProjectSidebar />);

    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    expect(screen.getByRole('button', { name: 'Agents' })).toBeTruthy();
  });
});

/**
 * archive#3202. The per-project badge used to fold the conversation INVENTORY
 * inline in `ProjectSidebar` and count, among other things, unseen finished
 * runs (archive#1781). It now counts one thing — this project's LIVE work,
 * the Sessions list's own "Needs you" + "Active now" lanes scoped to the
 * project (`project-live-work-model.ts`) — because that is exactly what the
 * project page's Live work section lists, and a badge whose destination shows
 * a different set is the defect archive#3202 was filed about.
 *
 * DISCLOSED CONSEQUENCE, pinned below rather than left to be discovered: a
 * finished-and-unopened run no longer contributes to THIS badge. That signal
 * still lives on Home / the chat dock inbox, whose lane model keeps a terminal
 * conversation in "Recently finished" until its rendered version is durably
 * acknowledged.
 */
function session(overrides: Record<string, unknown>) {
  return {
    threadId: 'thread-1',
    provider: 'claude',
    controlMode: 'managed',
    status: 'open',
    projectSlug: 'station',
    assignedAgentSlug: 'station',
    createdAt: '2026-08-02T19:00:00.000Z',
    updatedAt: '2026-08-02T20:00:00.000Z',
    answerability: { answerable: true },
    ...overrides,
  };
}

describe('ProjectSidebar live-work badge', () => {
  test('counts an answerable open request under Needs you', () => {
    resetState();
    projects.push({ id: 'p1', slug: 'station', name: 'Station' });
    sessions.push(
      session({
        threadId: 'waiting',
        lifecycleState: 'needs_input',
        pendingReview: true,
      }),
    );

    render(<ProjectSidebar />);
    expect(
      screen.getByRole('button', { name: /station.*needs you: 1/i }),
    ).toBeTruthy();
  });

  test('counts a mid-flight turn under Active now, and says which is which', () => {
    resetState();
    projects.push({ id: 'p1', slug: 'station', name: 'Station' });
    sessions.push(
      session({
        threadId: 'waiting',
        lifecycleState: 'needs_input',
        pendingReview: true,
      }),
      session({
        threadId: 'running',
        lifecycleState: 'running',
        hasActiveTurn: true,
      }),
    );

    const { container } = render(<ProjectSidebar />);
    // The number and the sentence come from the same lanes, so the badge can
    // never total something its own explanation does not account for.
    expect(
      container.querySelector('.sidebar__project-live-count')?.textContent,
    ).toBe('2');
    expect(
      screen.getByRole('button', {
        name: /station.*needs you: 1 · active now: 1/i,
      }),
    ).toBeTruthy();
  });

  /**
   * archive#1781's narrowing survives the move: `answerability` still demotes
   * an open request nothing can answer. It lands in Active now as
   * 'Unanswerable' rather than claiming to be yours to act on, which is the
   * Sessions lane model's own rule.
   */
  test('an open request nothing can answer is not claimed as Needs you', () => {
    resetState();
    projects.push({ id: 'p1', slug: 'station', name: 'Station' });
    sessions.push(
      session({
        threadId: 'dead',
        lifecycleState: 'needs_input',
        pendingReview: true,
        answerability: {
          answerable: false,
          qualification: 'provider_absent',
          observedBy: 'station-7f3a',
          observedAt: '2026-08-03T12:04:03.000Z',
        },
      }),
    );

    render(<ProjectSidebar />);
    expect(screen.queryByText(/needs you: /i)).toBeNull();
    expect(
      screen.getByRole('button', { name: /station.*active now: 1/i }),
    ).toBeTruthy();
  });

  test('a finished run is not live work and no longer reaches this badge', () => {
    // The archive#1781 leg this change deliberately drops. Asserted, not
    // silently removed: if a later change re-adds finished runs to the badge
    // without re-adding them to the project page section, this reds.
    resetState();
    projects.push({ id: 'p1', slug: 'station', name: 'Station' });
    sessions.push(
      session({ threadId: 'finished', lifecycleState: 'completed' }),
      session({ threadId: 'broken', lifecycleState: 'failed' }),
    );

    const { container } = render(<ProjectSidebar />);
    expect(container.querySelector('.sidebar__project-live-count')).toBeNull();
  });

  test('a session in another project never reaches this project’s badge', () => {
    resetState();
    projects.push(
      { id: 'p1', slug: 'station', name: 'Station' },
      { id: 'p2', slug: 'beacon', name: 'Beacon' },
    );
    sessions.push(
      session({
        threadId: 'elsewhere',
        projectSlug: 'beacon',
        lifecycleState: 'needs_input',
        pendingReview: true,
      }),
    );

    const { container } = render(<ProjectSidebar />);
    const badges = container.querySelectorAll('.sidebar__project-live-count');
    expect(badges).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: /beacon.*needs you: 1/i }),
    ).toBeTruthy();
  });

  test('the badge is visible to a sighted reader, not only announced', () => {
    resetState();
    projects.push({ id: 'p1', slug: 'station', name: 'Station' });
    sessions.push(
      session({
        threadId: 'waiting',
        lifecycleState: 'needs_input',
        pendingReview: true,
      }),
    );

    const { container } = render(<ProjectSidebar />);
    const count = container.querySelector('.sidebar__project-live-count');
    const label = container.querySelector('.sidebar__project-live-label');
    expect(count?.getAttribute('title')).toBe('Needs you: 1');
    expect(count?.getAttribute('title')).toBe(label?.textContent);
  });

  test('selecting the project is unchanged — the badge is not a separate target', () => {
    resetState();
    projects.push({ id: 'p1', slug: 'station', name: 'Station' });
    sessions.push(
      session({
        threadId: 'waiting',
        lifecycleState: 'needs_input',
        pendingReview: true,
      }),
    );

    const { container } = render(<ProjectSidebar />);
    // Clicking the number is clicking the row: the badge stays decoration
    // inside the project button, and the project page it selects is where the
    // live sessions are now listed.
    fireEvent.click(
      container.querySelector('.sidebar__project-live-count') as Element,
    );
    expect(setProject).toHaveBeenCalledWith('station');
  });
});

describe('ProjectSidebar New Project affordance (station#1300)', () => {
  test('renders a "+" icon button on the Projects header instead of a full-width row', () => {
    resetState();
    render(<ProjectSidebar />);

    const trigger = screen.getByRole('button', { name: 'New Project' });
    expect(trigger).toBeTruthy();
    expect(trigger.textContent?.trim()).toBe('');
    expect(screen.queryByText('+ New Project')).toBeNull();
  });

  test('clicking it navigates to /projects/new, same as before', () => {
    resetState();
    render(<ProjectSidebar />);

    fireEvent.click(screen.getByRole('button', { name: 'New Project' }));
    expect(navigate).toHaveBeenCalledWith('/projects/new');
  });
});

describe('ProjectSidebar compact rail chat entry (#1348)', () => {
  test('keeps a named Open chats control inside the collapsed rail', () => {
    resetState();
    // archive#1348 was written against the raw pre-unification key; sidebar
    // collapse now lives in the device-settings envelope, so
    // seed through the store rather than the migrated-away legacy key.
    deviceSettingsStore.set('projectSidebarCollapsed', true);
    const listener = vi.fn();
    const unregister = openChatsStore.registerNavigation({
      focus: vi.fn(),
      openCollection: listener,
    });

    render(<ProjectSidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Open chats' }));

    expect(listener).toHaveBeenCalledOnce();
    unregister();
  });
});
