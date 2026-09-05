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

// The sheet's project picker and connection control mount inside this bar's
// tree; `useIsMobile`/`useNavigation` are mocked so neither needs a real
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

async function openActions() {
  fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
  return screen.findByRole('dialog', { name: 'Chat actions' });
}

describe('mobile conversation focus', () => {
  test('keeps exactly navigation, readable identity, and actions in the header', () => {
    renderHeader();
    const header = screen.getByTestId('chat-dock-mobile-header');
    expect(header.querySelectorAll('button')).toHaveLength(3);
    const identity = screen.getByRole('button', { name: /^Switch task/ });
    expect(identity.textContent).toContain('New chat');
    expect(identity.textContent).toContain('Codex');
    expect(
      screen.queryByRole('button', { name: /^Switch project/ }),
    ).toBeNull();
    expect(screen.queryByTestId('chat-dock-mobile-connection')).toBeNull();
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

/**
 * #928 C2b deleted the mobile bar's occupant picker and the ⋯ sheet's
 * "Switch to …" fallback list with the docked-Home path they switched to.
 * #1512 then reduced the bar to three controls; this pins that control set
 * BY ACCESSIBLE NAME, in order, on the merged bar, so a control lost,
 * gained or renamed reds here by name instead of shipping as a quiet chrome
 * regression, and the sheet is checked for the retired switch items.
 */
describe('the mobile dock bar control set (#928 C2b)', () => {
  test('an open bar offers exactly these controls, by accessible name', () => {
    renderHeader();
    expect(
      screen
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? ''),
    ).toEqual(['Collapse chat', 'Switch task — Codex', 'Chat actions']);
  });

  test('the ⋯ sheet offers no occupant switch item', async () => {
    renderHeader();
    await openActions();
    await screen.findByRole('menuitem', { name: 'Chat settings' });
    expect(screen.queryByRole('menuitem', { name: /^Switch to/ })).toBeNull();
  });
});
