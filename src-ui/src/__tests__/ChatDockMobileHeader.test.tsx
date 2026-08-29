/**
 * @vitest-environment jsdom
 */

import {
  WORKSPACE_HOME_PANE_DESCRIPTOR,
  WORKSPACE_HOME_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-home-pane';
import { fireEvent, screen } from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type ChatDockMobileDockToggle,
  ChatDockMobileHeader,
  type ChatDockMobileProjectSwitcher,
} from '../components/chat-dock/ChatDockMobileHeader';
import { renderWithIsolatedConnections } from './renderWithIsolatedConnections';

// station#520 (review round 3, B1): the overflow sheet's occupant-switch
// items now read `useIsMobile()`/`useNavigation()` themselves (the same
// inputs `DockOccupantPicker` reads for `chooseAmbientOccupant`) — mutable
// mocks so the maximize-routing tests below can drive both without a real
// `matchMedia` breakpoint or router.
const mobileFlag = vi.hoisted(() => ({ isMobile: false }));
vi.mock('../hooks/useIsMobile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useIsMobile')>();
  return { ...actual, useIsMobile: () => mobileFlag.isMobile };
});
const pathnameFlag = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    get pathname() {
      return pathnameFlag.pathname;
    },
  }),
}));

// archive#3297 put a live connection indicator in this bar, so the header now
// mounts through the same connection boundary the app uses. Nothing here
// asserts on probe results; the stub only keeps the shared health coordinator
// from reaching the network.
beforeEach(() => {
  mobileFlag.isMobile = false;
  pathnameFlag.pathname = '/';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});

const PROJECTS = [
  {
    id: 'p-kontour',
    slug: 'kontour-ai',
    name: 'Kontour AI',
    hasWorkingDirectory: false,
    layoutCount: 0,
    hasKnowledge: false,
  },
];

function renderHeader(
  overrides: {
    onClear?: ReturnType<typeof vi.fn<() => void>>;
    onNewChat?: ReturnType<typeof vi.fn<() => void>>;
    projectSwitcher?: ChatDockMobileProjectSwitcher | null;
    dockToggle?: ChatDockMobileDockToggle | null;
    projectScope?: { name: string; onClear: () => void } | null;
    agentIdentity?: { name: string; slug: string; icon?: string } | null;
    branchLabel?: string | null;
    onOpenProject?: (() => void) | null;
    openProjectName?: string | null;
    occupantPicker?: ReactNode;
    onSwitchOccupant?: {
      onChoose: (descriptor: unknown, instance: unknown) => void;
      onChooseAsOnlyContent: (descriptor: unknown, instance: unknown) => void;
    } | null;
  } = {},
) {
  const onClear = overrides.onClear ?? vi.fn<() => void>();
  renderWithIsolatedConnections(
    <ChatDockMobileHeader
      showDrawerToggle={false}
      sessionTitle="New chat"
      projectScope={
        overrides.projectScope === null
          ? undefined
          : (overrides.projectScope ?? { name: 'Kontour AI', onClear })
      }
      dockToggle={
        overrides.dockToggle !== undefined
          ? overrides.dockToggle
          : {
              state: 'open',
              onExpand: vi.fn(),
              onCollapse: vi.fn(),
            }
      }
      projectSwitcher={
        overrides.projectSwitcher !== undefined
          ? overrides.projectSwitcher
          : {
              projectSlug: 'kontour-ai',
              projectName: 'Kontour AI',
              projects: PROJECTS,
              onOpenProject: vi.fn(),
              onSwitchProject: vi.fn(),
            }
      }
      agentIdentity={
        overrides.agentIdentity !== undefined
          ? overrides.agentIdentity
          : { name: 'Codex', slug: 'codex' }
      }
      branchLabel={overrides.branchLabel ?? null}
      activeCount={0}
      unreadCount={0}
      taskSwitcherTriggerRef={createRef<HTMLButtonElement>()}
      activityTriggerRef={createRef<HTMLButtonElement>()}
      onOpenTaskSwitcher={vi.fn()}
      onOpenActivity={vi.fn()}
      onToggleSidebar={vi.fn()}
      onDragPointerDown={vi.fn()}
      onDragClickCapture={vi.fn()}
      onNewChat={overrides.onNewChat ?? vi.fn()}
      overflow={{
        onOpenConversation: vi.fn(),
        onToggleHistory: vi.fn(),
        onOpenChatSettings: vi.fn(),
        onOpenProject: overrides.onOpenProject ?? null,
        openProjectName: overrides.openProjectName ?? null,
        onOpenProfile: vi.fn(),
        onOpenAppSettings: vi.fn(),
        onCollapseDock: vi.fn(),
        onExpandDock: vi.fn(),
        onRestoreDock: vi.fn(),
        isDockMaximized: false,
        onSwitchOccupant: overrides.onSwitchOccupant ?? null,
      }}
      occupantPicker={overrides.occupantPicker}
    />,
  );
  return onClear;
}

describe('ChatDockMobileHeader project scope', () => {
  test('uses the plain project name with one clear action, folded into the ⋯ sheet (#3309 review SF-2)', async () => {
    const onClear = renderHeader();

    expect(screen.getByText('Kontour AI')).toBeTruthy();
    expect(screen.queryByText(/Project chats:/i)).toBeNull();

    // The bar itself must not carry it: at 320px its non-shrinking 44px slots
    // already exceed the available width in exactly this configuration.
    const header = screen.getByTestId('chat-dock-mobile-header');
    expect(
      header.querySelector('[aria-label="Clear project chat scope"]'),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    const clear = await screen.findByRole('menuitem', {
      name: 'Clear project chat scope',
    });
    expect(clear.textContent).toContain('Kontour AI');
    fireEvent.click(clear);
    expect(onClear).toHaveBeenCalledOnce();
  });

  test('no scope means no clear action in the sheet', async () => {
    renderHeader({ projectScope: null });

    fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    await screen.findByRole('menuitem', { name: 'Chat settings' });
    expect(
      screen.queryByRole('menuitem', { name: 'Clear project chat scope' }),
    ).toBeNull();
  });
});

/**
 * archive#793: a project-switcher trigger distinct from the task
 * switcher's own buried eyebrow (`aria-label="Switch task"`) — see D3 in the
 * plan for why the eyebrow could not simply grow a click behavior.
 */
describe('ChatDockMobileHeader project switcher', () => {
  test('renders no switcher trigger when the active chat has no bound project', () => {
    renderHeader({ projectSwitcher: null });

    expect(
      screen.queryByRole('button', { name: /^Switch project/ }),
    ).toBeNull();
  });

  test('renders a distinct, accessible switcher trigger when a project is bound', () => {
    renderHeader({
      projectSwitcher: {
        projectSlug: 'kontour-ai',
        projectName: 'Kontour AI',
        projects: PROJECTS,
        onOpenProject: vi.fn(),
        onSwitchProject: vi.fn(),
      },
    });

    const trigger = screen.getByRole('button', {
      name: 'Switch project — Kontour AI',
    });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.className).toContain('app-toolbar__icon-btn');
    expect(trigger.textContent).toContain('Kontour AI');
    // Distinct from the task switcher — never repurposed and never named
    // "Switch task" or "Clear project chat scope".
    expect(screen.getByRole('button', { name: /^Switch task/ })).not.toBe(
      trigger,
    );
  });

  test('collapsed dock shows an Expand chat toggle that restores without a gesture', () => {
    const onExpand = vi.fn();
    const onCollapse = vi.fn();
    renderHeader({
      dockToggle: { state: 'collapsed', onExpand, onCollapse },
    });

    const toggle = screen.getByRole('button', { name: 'Expand chat' });
    // A tap on the toggle must never be interpreted as a drag start.
    expect(toggle.hasAttribute('data-no-dock-drag')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Collapse chat' })).toBeNull();

    fireEvent.click(toggle);
    expect(onExpand).toHaveBeenCalledOnce();
    expect(onCollapse).not.toHaveBeenCalled();
  });

  test('open dock shows a Collapse chat toggle', () => {
    const onExpand = vi.fn();
    const onCollapse = vi.fn();
    renderHeader({ dockToggle: { state: 'open', onExpand, onCollapse } });

    const toggle = screen.getByRole('button', { name: 'Collapse chat' });
    expect(screen.queryByRole('button', { name: 'Expand chat' })).toBeNull();

    fireEvent.click(toggle);
    expect(onCollapse).toHaveBeenCalledOnce();
    expect(onExpand).not.toHaveBeenCalled();
  });

  test('a fullscreen placement renders no dock toggle at all', () => {
    renderHeader({ dockToggle: null });

    expect(screen.queryByRole('button', { name: 'Expand chat' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Collapse chat' })).toBeNull();
  });

  test('New chat is a pinned header icon, not an overflow item (#3309)', () => {
    const onNewChat = vi.fn<() => void>();
    renderHeader({ onNewChat });

    const newChat = screen.getByRole('button', { name: 'New chat' });
    // Part of the drag surface, never a drag blocker.
    expect(newChat.hasAttribute('data-dock-drag-passthrough')).toBe(true);
    fireEvent.click(newChat);
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  test('the dock toggle leads the bar and the ⋯ trigger trails the title (#3309)', () => {
    renderHeader();

    const header = screen.getByTestId('chat-dock-mobile-header');
    const buttons = Array.from(header.querySelectorAll('button'));
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Collapse chat');
    expect(buttons.at(-1)?.getAttribute('aria-label')).toBe('New chat');

    // The ⋯ chat-actions trigger shares the identity cluster with the title,
    // in the old caret's slot.
    const cluster = header.querySelector('.chat-dock__mobile-identity-cluster');
    expect(cluster).not.toBeNull();
    expect(
      cluster?.querySelector('[aria-label^="Switch task"]'),
    ).not.toBeNull();
    expect(
      cluster?.querySelector('[aria-label="Chat actions"]'),
    ).not.toBeNull();
    expect(header.querySelector('.chat-dock__mobile-title-caret')).toBeNull();
  });

  test('the agent leads the identity block, inside the existing Switch task control (#3309)', () => {
    renderHeader({ agentIdentity: { name: 'Codex', slug: 'codex' } });

    const header = screen.getByTestId('chat-dock-mobile-header');
    const identity = header.querySelector('[aria-label^="Switch task"]');
    expect(identity).not.toBeNull();
    // Inside the identity control, never a slot of its own: the bar's 320px
    // arithmetic counts buttons, and an eighth would break it.
    const avatar = header.querySelector(
      '[data-testid="chat-dock-mobile-agent-avatar"]',
    );
    expect(identity?.contains(avatar ?? null)).toBe(true);
    expect(avatar?.closest('button')).toBe(identity);
    expect(
      header.querySelector('.chat-dock__mobile-eyebrow')?.textContent,
    ).toBe('Codex');
  });

  test('the branch follows the agent in the eyebrow when both are known (#3309)', () => {
    renderHeader({
      agentIdentity: { name: 'Codex', slug: 'codex' },
      branchLabel: 'feat/3309-agent-identity',
    });

    expect(
      screen
        .getByTestId('chat-dock-mobile-header')
        .querySelector('.chat-dock__mobile-eyebrow')?.textContent,
    ).toBe('Codex · feat/3309-agent-identity');
  });

  test('the identity control names the agent to a screen reader, not just to the eye (#3309)', () => {
    renderHeader({ agentIdentity: { name: 'Codex', slug: 'codex' } });

    // Everything visible inside this button is aria-hidden presentational
    // chrome, so its label is the ONLY agent attribution a phone screen-reader
    // user gets. The action stays the prefix so the control is still findable
    // by it (and every spec locating it by name keeps matching).
    const identity = screen
      .getByTestId('chat-dock-mobile-header')
      .querySelector('[aria-label^="Switch task"]');
    expect(identity?.getAttribute('aria-label')).toBe('Switch task — Codex');
    // The session TITLE stays out of it: a name is matched by substring, and a
    // chat titled "New chat" otherwise made this control answer to the same
    // name as the New chat button beside it — for Playwright's strict mode and
    // for voice control alike.
    expect(identity?.getAttribute('aria-label')).not.toContain('New chat');

    // …and the title reaches AT as the DESCRIPTION instead, where an arbitrary
    // string is safe because neither locators nor voice control match on it.
    const describedBy = identity?.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy as string);
    expect(description?.textContent).toBe('New chat');
  });

  test('the ⋯ sheet names the project it would open (#3309)', async () => {
    renderHeader({ onOpenProject: vi.fn(), openProjectName: 'Kontour AI' });

    fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    const open = await screen.findByRole('menuitem', { name: /Open project/ });
    // The phone bar drops the project LABEL below 481px on the argument that
    // the name stays reachable here; the item used to read a bare "Open
    // project", which made that argument false. Part of the accessible NAME,
    // not an aria-hidden hint, or it would still not be reachable.
    expect(open.textContent).toContain('Kontour AI');
    expect(
      screen.getByRole('menuitem', { name: /Open project — |Open project/ }),
    ).toBeTruthy();
    expect(open.getAttribute('aria-label')).toBeNull();
  });

  test('no active chat means no agent avatar and no invented attribution', () => {
    renderHeader({ agentIdentity: null, branchLabel: 'main' });

    const header = screen.getByTestId('chat-dock-mobile-header');
    expect(
      header.querySelector('[data-testid="chat-dock-mobile-agent-avatar"]'),
    ).toBeNull();
    // The eyebrow still carries what IS known, and nothing more.
    expect(
      header.querySelector('.chat-dock__mobile-eyebrow')?.textContent,
    ).toBe('main');
  });

  test('opens the shared project switcher sheet and wires its actions', async () => {
    const onOpenProject = vi.fn();
    const onSwitchProject = vi.fn();
    renderHeader({
      projectSwitcher: {
        projectSlug: 'kontour-ai',
        projectName: 'Kontour AI',
        projects: PROJECTS,
        onOpenProject,
        onSwitchProject,
      },
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Switch project — Kontour AI' }),
    );
    await screen.findByRole('dialog', { name: 'Switch project' });

    fireEvent.click(screen.getByRole('button', { name: 'Open Kontour AI' }));
    expect(onOpenProject).toHaveBeenCalledWith('kontour-ai');

    expect(onSwitchProject).not.toHaveBeenCalled();
  });
});

/**
 * archive#3297 — connection state on the surface where the failure is seen.
 *
 * The app toolbar's indicator is hidden while the mobile dock is full-screen
 * (`app__main--mobile-dock-fullscreen`), and this bar replaced it, so the chat
 * screen showed no connection state at all. The state that needed a decision
 * — a rejected credential — was distinguished only by a `title` tooltip,
 * which a touch device cannot show.
 */
describe('ChatDockMobileHeader connection indicator', () => {
  test('shows connection state on the chat surface, always, not only when broken', () => {
    renderHeader();

    const indicator = screen.getByTestId('chat-dock-mobile-connection');
    expect(indicator.tagName.toLowerCase()).toBe('button');
    // An indicator that appears only on failure makes its absence the signal,
    // and absence is not evidence that anything was checked.
    expect(indicator.dataset.connectionState).toBeTruthy();
    expect(indicator.getAttribute('aria-label')).toBeTruthy();
  });

  test('carries no title, because a tooltip is what touch cannot reach', () => {
    renderHeader();

    expect(
      screen.getByTestId('chat-dock-mobile-connection').getAttribute('title'),
    ).toBeNull();
  });

  test('is a real control that opens connection management on tap', () => {
    // The state-dependent target (re-pairing vs the list) is proven against
    // both branches in ChatDockMobileConnection.test.tsx, where the failure
    // reason can actually be set. This asserts only that the header's control
    // is wired to the app's open-connections seam at all.
    const opened: unknown[] = [];
    const listener = () => opened.push(true);
    window.addEventListener('station:open-connections-modal', listener);
    try {
      renderHeader();
      fireEvent.click(screen.getByTestId('chat-dock-mobile-connection'));
      expect(opened).toHaveLength(1);
    } finally {
      window.removeEventListener('station:open-connections-modal', listener);
    }
  });
});

/**
 * station#524: `ChatDockMobileHeader` carried no occupant picker while
 * `ChatDockHeader` (Home/Activity) rendered one at every width — a phone
 * could switch INTO Chat but had no dock-borne way back out. `occupantPicker`
 * is a pre-rendered node (the same contract `ChatDockHeader`'s own prop
 * documents), so these tests drive it through a stub rather than the real
 * `DockOccupantPicker` (that component's own behavior is pinned in
 * `AmbientChatDockPaneHost.test.tsx`).
 */
describe('ChatDockMobileHeader occupant picker (station#524)', () => {
  test('renders the pre-rendered occupant picker when supplied', () => {
    renderHeader({
      occupantPicker: (
        <button type="button" aria-label="Docked pane: Chat">
          Chat
        </button>
      ),
    });

    expect(
      screen.getByRole('button', { name: 'Docked pane: Chat' }),
    ).toBeTruthy();
  });

  test('renders nothing extra when the occupant picker is absent (full-screen Chat placement)', () => {
    renderHeader({ occupantPicker: undefined });

    expect(screen.queryByRole('button', { name: /^Docked pane:/ })).toBeNull();
    const header = screen.getByTestId('chat-dock-mobile-header');
    expect(
      header.querySelector('.chat-dock__mobile-occupant-picker'),
    ).toBeNull();
  });
});

/**
 * station#524 (review round 2, H2) + station#520 (review round 3, B1): the
 * ⋯ overflow sheet's occupant-switch items are reachable at EVERY dock
 * state (collapsed/half/maximized), not only when the header's own
 * occupant picker hides at <=430px — so they must carry the SAME mobile
 * dock-and-empty contract `DockOccupantPicker` does: maximize when picking
 * this occupant would strand the main area behind it, plain switch
 * otherwise. Review round 2 wired the sheet to the plain action only; these
 * tests pin the round-3 fix (`chooseAmbientOccupant`, shared with the
 * picker) instead of re-pinning the gap.
 */
type OccupantChooser = (descriptor: unknown, instance: unknown) => void;

describe('ChatDockMobileHeader overflow sheet occupant switch (station#520/524)', () => {
  function switcher(
    overrides: {
      onChoose?: ReturnType<typeof vi.fn<OccupantChooser>>;
      onChooseAsOnlyContent?: ReturnType<typeof vi.fn<OccupantChooser>>;
    } = {},
  ) {
    return {
      onChoose: overrides.onChoose ?? vi.fn<OccupantChooser>(),
      onChooseAsOnlyContent:
        overrides.onChooseAsOnlyContent ?? vi.fn<OccupantChooser>(),
    };
  }

  test('lists every other ambient occupant when onSwitchOccupant is supplied', async () => {
    renderHeader({ onSwitchOccupant: switcher() });

    fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    expect(
      await screen.findByRole('menuitem', { name: 'Switch to Home' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('menuitem', { name: 'Switch to Activity' }),
    ).toBeTruthy();
    // Chat is the current occupant of this header — never its own item.
    expect(
      screen.queryByRole('menuitem', { name: 'Switch to Chat' }),
    ).toBeNull();
  });

  test('desktop or off-route: calls the plain onChoose and closes the sheet', async () => {
    mobileFlag.isMobile = false;
    pathnameFlag.pathname = '/';
    const onChoose = vi.fn<OccupantChooser>();
    const onChooseAsOnlyContent = vi.fn<OccupantChooser>();
    renderHeader({
      onSwitchOccupant: switcher({ onChoose, onChooseAsOnlyContent }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    const item = await screen.findByRole('menuitem', {
      name: 'Switch to Home',
    });
    fireEvent.click(item);

    expect(onChoose).toHaveBeenCalledWith(
      WORKSPACE_HOME_PANE_DESCRIPTOR,
      WORKSPACE_HOME_PANE_INSTANCE,
    );
    expect(onChooseAsOnlyContent).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  /**
   * station#520 (review round 3, B1): the reproduction the reviewer named
   * verbatim — the header's own `isDockMaximized: false` default (a
   * COLLAPSED or HALF dock, not maximized) with the picked pane's own
   * route (`/`) already on screen. Before this fix the sheet always called
   * the plain action here, stranding `WorkspacePaneAwayState` as the whole
   * main area exactly like #520's acceptance criterion describes.
   */
  test("mobile + on the picked pane's own route (dock NOT maximized): routes through onChooseAsOnlyContent", async () => {
    mobileFlag.isMobile = true;
    pathnameFlag.pathname = '/'; // Home's own canonical route.
    const onChoose = vi.fn<OccupantChooser>();
    const onChooseAsOnlyContent = vi.fn<OccupantChooser>();
    renderHeader({
      onSwitchOccupant: switcher({ onChoose, onChooseAsOnlyContent }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    const item = await screen.findByRole('menuitem', {
      name: 'Switch to Home',
    });
    fireEvent.click(item);

    expect(onChooseAsOnlyContent).toHaveBeenCalledWith(
      WORKSPACE_HOME_PANE_DESCRIPTOR,
      WORKSPACE_HOME_PANE_INSTANCE,
    );
    expect(onChoose).not.toHaveBeenCalled();
  });

  test('renders no switch items when onSwitchOccupant is absent (full-screen placement)', async () => {
    renderHeader({ onSwitchOccupant: null });

    fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    await screen.findByRole('menuitem', { name: 'Chat settings' });
    expect(screen.queryByRole('menuitem', { name: /^Switch to/ })).toBeNull();
  });
});
