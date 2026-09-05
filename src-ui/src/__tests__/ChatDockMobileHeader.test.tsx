/**
 * @vitest-environment jsdom
 */

import { fireEvent, screen } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type ChatDockMobileDockToggle,
  ChatDockMobileHeader,
  type ChatDockMobileProjectSwitcher,
} from '../components/chat-dock/ChatDockMobileHeader';
import { renderWithIsolatedConnections } from './renderWithIsolatedConnections';

// archive#3297 put a live connection indicator in this bar, so the header now
// mounts through the same connection boundary the app uses. Nothing here
// asserts on probe results; the stub only keeps the shared health coordinator
// from reaching the network.
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
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
    showConnection?: boolean;
  } = {},
) {
  const onClear = overrides.onClear ?? vi.fn<() => void>();
  renderWithIsolatedConnections(
    <ChatDockMobileHeader
      showDrawerToggle={false}
      showConnection={overrides.showConnection ?? true}
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
      }}
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
 * station#1048 — the mobile dock's connection control used to render
 * unconditionally, so it and the app toolbar's own `app-toolbar-connection`
 * coexisted (both visible, both in the a11y tree) whenever the dock was
 * merely on screen — collapsed or half-open, the DEFAULT mobile state, not
 * only full-screen — which produced two controls whose accessible name
 * started "Manage Stations". `showConnection` (computed by `ChatDock.tsx`
 * from the same `isMobileDockFullscreen` check that already gated
 * `showDrawerToggle`) closes that: the control mounts only when the toolbar
 * is genuinely gone, and unmounts everywhere else.
 */
describe('ChatDockMobileHeader connection control gating', () => {
  test('does not mount while the app toolbar is still on screen (default collapsed dock)', () => {
    renderHeader({ showConnection: false });

    expect(screen.queryByTestId('chat-dock-mobile-connection')).toBeNull();
  });

  test('mounts once the app toolbar is genuinely hidden (dock open and maximized)', () => {
    renderHeader({ showConnection: true });

    expect(
      screen.getByTestId('chat-dock-mobile-connection').tagName.toLowerCase(),
    ).toBe('button');
  });
});

/**
 * #928 C2b deleted the mobile bar's in-bar occupant picker (station#524, the
 * trigger named the docked pane) and the ⋯ sheet's "Switch to …" fallback
 * list with the docked-Home path they switched to. This pins the bar's remaining control
 * set BY ACCESSIBLE NAME, in order: the deletion was meant to remove exactly
 * one bar control, so a bar that loses (or gains, or renames) any other reds
 * here by name instead of shipping as a quiet chrome regression. Captured
 * against the pre-C2b tree, minus the picker. The connection control's name
 * carries live probe state after its em dash, so it is compared by its
 * stable prefix.
 */
describe('the mobile dock bar control set (#928 C2b)', () => {
  test('an open bar offers exactly these controls, by accessible name', () => {
    renderHeader();
    const names = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? '')
      .map((name) =>
        name.startsWith('Manage Stations') ? 'Manage Stations — …' : name,
      );
    expect(names).toEqual([
      'Collapse chat',
      'Switch task — Codex',
      'Chat actions',
      'Switch project — Kontour AI',
      'Manage Stations — …',
      'Activity — active and recent chats',
      'New chat',
    ]);
  });

  test('the ⋯ sheet offers no occupant switch item', async () => {
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    await screen.findByRole('menuitem', { name: 'Chat settings' });
    expect(screen.queryByRole('menuitem', { name: /^Switch to/ })).toBeNull();
  });
});
