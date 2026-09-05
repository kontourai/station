/**
 * @vitest-environment jsdom
 */

import {
  WORKSPACE_HOME_PANE_DESCRIPTOR,
  WORKSPACE_HOME_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-home-pane';
import { act, fireEvent, screen } from '@testing-library/react';
import { createRef, type ReactElement } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type ChatDockMobileDockToggle,
  ChatDockMobileHeader,
  type ChatDockMobileProjectSwitcher,
} from '../components/chat-dock/ChatDockMobileHeader';
import { MOBILE_DOCK_OCCUPANT_PICKER_QUERY } from '../components/chat-dock/mobile-chrome';
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

let pickerQueryMatches = false;
const pickerQueryListeners = new Set<(event: MediaQueryListEvent) => void>();

function setPickerQueryMatches(matches: boolean) {
  pickerQueryMatches = matches;
  act(() => {
    for (const listener of pickerQueryListeners) {
      listener({ matches } as MediaQueryListEvent);
    }
  });
}

function StubOccupantPicker({
  mobileDragPassthrough,
}: {
  mobileDragPassthrough?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label="Docked pane: Chat"
      data-dock-drag-passthrough={mobileDragPassthrough ? '' : undefined}
    >
      Chat
    </button>
  );
}

// archive#3297 put a live connection indicator in this bar, so the header now
// mounts through the same connection boundary the app uses. Nothing here
// asserts on probe results; the stub only keeps the shared health coordinator
// from reaching the network.
beforeEach(() => {
  mobileFlag.isMobile = false;
  pathnameFlag.pathname = '/';
  pickerQueryMatches = false;
  pickerQueryListeners.clear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches() {
        return query === MOBILE_DOCK_OCCUPANT_PICKER_QUERY
          ? pickerQueryMatches
          : false;
      },
      media: query,
      onchange: null,
      addEventListener: (
        event: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => {
        if (event === 'change') pickerQueryListeners.add(listener);
      },
      removeEventListener: (
        event: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => {
        if (event === 'change') pickerQueryListeners.delete(listener);
      },
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
    occupantPicker?: ReactElement<{ mobileDragPassthrough?: boolean }>;
    onSwitchOccupant?: {
      onChoose: (descriptor: unknown, instance: unknown) => void;
      onChooseAsOnlyContent: (descriptor: unknown, instance: unknown) => void;
    } | null;
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
        onSwitchOccupant: overrides.onSwitchOccupant ?? null,
      }}
      occupantPicker={overrides.occupantPicker}
    />,
  );
  return onClear;
}

async function openActions() {
  fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
  return screen.findByRole('dialog', { name: 'Chat actions' });
}

describe('mobile conversation focus', () => {
  test('keeps exactly navigation, readable identity, and actions in the header', () => {
    renderHeader({ occupantPicker: <StubOccupantPicker /> });
    const header = screen.getByTestId('chat-dock-mobile-header');
    expect(header.querySelectorAll('button')).toHaveLength(3);
    const identity = screen.getByRole('button', { name: /^Switch task/ });
    expect(identity.textContent).toContain('New chat');
    expect(identity.textContent).toContain('Codex');
    expect(
      screen.queryByRole('button', { name: /^Switch project/ }),
    ).toBeNull();
    expect(screen.queryByTestId('chat-dock-mobile-connection')).toBeNull();
    setPickerQueryMatches(true);
    expect(header.querySelectorAll('button')).toHaveLength(3);
  });
  test('keeps New chat callable from the actions sheet', async () => {
    const onNewChat = vi.fn();
    renderHeader({ onNewChat });
    await openActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'New chat' }));
    expect(onNewChat).toHaveBeenCalledOnce();
  });
  test('keeps project scope and branch context in the sheet', async () => {
    const onClear = renderHeader({ branchLabel: 'feature/chat' });
    await openActions();
    expect(screen.getByText('feature/chat')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Clear project chat scope' }),
    );
    expect(onClear).toHaveBeenCalledOnce();
  });
  test('opens the shared project picker and preserves project action wiring', async () => {
    const onOpenProject = vi.fn();
    renderHeader({
      projectSwitcher: {
        projectSlug: 'kontour-ai',
        projectName: 'Kontour AI',
        projects: PROJECTS,
        onOpenProject,
        onSwitchProject: vi.fn(),
      },
    });
    await openActions();
    fireEvent.click(screen.getByRole('menuitem', { name: /^Switch project/ }));
    await screen.findByRole('dialog', { name: 'Switch project' });
    fireEvent.click(screen.getByRole('button', { name: 'Open Kontour AI' }));
    expect(onOpenProject).toHaveBeenCalledWith('kontour-ai');
  });
  test('shows live connection state and a visible management label on request', async () => {
    renderHeader();
    await openActions();
    const indicator = screen.getByTestId('chat-dock-mobile-connection');
    expect(indicator.dataset.connectionState).toBeTruthy();
    expect(indicator.textContent).toBeTruthy();
    const listener = vi.fn();
    window.addEventListener('station:open-connections-modal', listener);
    fireEvent.click(indicator);
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener('station:open-connections-modal', listener);
  });
  test('does not duplicate connection management while the app toolbar owns it', async () => {
    renderHeader({ showConnection: false });
    await openActions();
    expect(screen.queryByTestId('chat-dock-mobile-connection')).toBeNull();
  });
  test('collapsed dock can expand without a gesture', () => {
    const onExpand = vi.fn();
    renderHeader({
      dockToggle: { state: 'collapsed', onExpand, onCollapse: vi.fn() },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Expand chat' }));
    expect(onExpand).toHaveBeenCalledOnce();
  });
  test('does not invent attribution or geometry for an unbound fullscreen pane', () => {
    renderHeader({
      agentIdentity: null,
      dockToggle: null,
      projectSwitcher: null,
    });
    expect(
      screen.getByRole('button', { name: 'Switch task' }).textContent,
    ).toBe('New chat');
    expect(screen.queryByRole('button', { name: 'Collapse chat' })).toBeNull();
  });
});

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
    // Activity owns a separate region surface, not an ambient Chat/Home slot.
    expect(
      screen.queryByRole('menuitem', { name: 'Switch to Activity' }),
    ).toBeNull();
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
