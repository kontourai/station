/**
 * @vitest-environment jsdom
 */

import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { beforeAll, describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionsQuery: () => ({
    data: [],
    isLoading: false,
    isError: false,
  }),
}));
vi.mock('../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => new Set(),
}));

// The account control reads the signed-in name for its initials and, once its
// menu is open, the Settings chord; both providers wrap the real app.
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { name: 'Ada Lovelace' } }),
}));
vi.mock('../hooks/useKeyboardShortcut', () => ({
  useShortcutDisplay: () => '⌘,',
}));
// The access panel at the top of the account menu reads the tool library; its
// own tests own that read, and these pin where the menu's rows go.
vi.mock('../components/profile/MyAccessPanel', () => ({
  MyAccessPanel: () => null,
}));
vi.mock('../views/agent-editor/ToolLibraryContext', () => ({
  StationToolLibraryProvider: ({ children }: { children: ReactNode }) =>
    children,
}));

import { subscribeHelpMenuRequests } from '../components/header/helpMenuRequest';
import { ProjectSidebarFooter } from '../components/project-sidebar/ProjectSidebarFooter';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      media: '',
      onchange: null,
    })),
  });
});

function renderFooter(
  props: Partial<{
    activePath: string;
    navigate: (path: string) => void;
    isMobile: boolean;
    collapsed: boolean;
    onAfterNavigate: () => void;
  }> = {},
) {
  return render(
    <ProjectSidebarFooter
      activePath={props.activePath ?? '/'}
      isMobile={props.isMobile ?? false}
      collapsed={props.collapsed}
      navigate={props.navigate ?? vi.fn()}
      onAfterNavigate={props.onAfterNavigate}
    />,
  );
}

describe('ProjectSidebarFooter', () => {
  test('places Automations and Customize before icon-only Updates and the account', () => {
    renderFooter();
    expect(
      screen
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual([
      'Automations',
      'Customize',
      'Updates',
      'Profile and settings: AL',
    ]);
    const updates = screen.getByRole('button', { name: 'Updates' });
    expect(updates.textContent).toBe('');
    expect(updates.classList.contains('updates-control--collapsed')).toBe(true);
    expect(screen.queryByRole('button', { name: /^Who is here:/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
    expect(
      screen.getByRole('button', { name: /^Profile and settings:/ })
        .textContent,
    ).toBe('AL');
    expect(
      screen
        .getByRole('button', { name: 'Customize' })
        .getAttribute('data-first-run-anchor'),
    ).toBe('customize');
  });

  test('Automations opens its route', () => {
    const navigate = vi.fn();
    renderFooter({ navigate });
    fireEvent.click(screen.getByRole('button', { name: 'Automations' }));
    expect(navigate).toHaveBeenCalledWith('/automations');
  });

  test('closes the mobile drawer after a footer navigation, and only on mobile', () => {
    const onAfterNavigate = vi.fn();
    const { unmount } = renderFooter({ isMobile: false, onAfterNavigate });
    fireEvent.click(screen.getByRole('button', { name: 'Automations' }));
    expect(onAfterNavigate).not.toHaveBeenCalled();
    unmount();

    renderFooter({ isMobile: true, onAfterNavigate });
    fireEvent.click(screen.getByRole('button', { name: 'Automations' }));
    expect(onAfterNavigate).toHaveBeenCalledTimes(1);
  });

  // Exactly one control may claim to be the current location, and it is
  // derived through the registry's view ownership rather than a path-prefix
  // comparison here (#1582 D4's rule).
  test.each([['/automations', 'Automations', 'Customize']])(
    'marks the %s control as the current page',
    (path, current, other) => {
      renderFooter({ activePath: path });
      expect(
        screen
          .getByRole('button', { name: current })
          .getAttribute('aria-current'),
      ).toBe('page');
      expect(
        screen
          .getByRole('button', { name: other })
          .getAttribute('aria-current'),
      ).toBeNull();
    },
  );

  test('marks neither control on an unrelated route', () => {
    renderFooter({ activePath: '/agents' });
    expect(
      screen
        .getAllByRole('button')
        .filter((button) => button.getAttribute('aria-current') === 'page'),
    ).toHaveLength(0);
  });

  // #2059 product decision: the build identity left the footer. It is not
  // panel chrome — `ReportProblemDialog` stamps `buildLabel` into every
  // report, which is where the number is actually needed. The old
  // "renders the build identity with full detail in the tooltip" test went
  // with the element it described; what replaces it is the assertion that the
  // rail no longer carries a version at all.
  test('carries no build identity', () => {
    const { container } = renderFooter();
    expect(screen.queryByTestId('sidebar-build-version')).toBeNull();
    expect(container.textContent).not.toMatch(/v\d+\.\d+\.\d+/);
  });

  test('opens Customize, restores its trigger on close, and navigates through a choice', async () => {
    const navigate = vi.fn();
    const onAfterNavigate = vi.fn();
    render(
      <ProjectSidebarFooter
        isMobile={true}
        navigate={navigate}
        onAfterNavigate={onAfterNavigate}
        activePath="/settings"
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Customize' });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole('dialog', { name: 'Customize' });
    fireEvent.click(screen.getByRole('button', { name: 'Close Customize' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('link', { name: 'Agents' }));
    expect(navigate).toHaveBeenCalledWith('/agents');
    expect(onAfterNavigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Customize' })).toBeNull();
  });

  test('the account menu opens above its trigger and its rows navigate through the footer', async () => {
    const navigate = vi.fn();
    const onAfterNavigate = vi.fn();
    renderFooter({ navigate, isMobile: true, onAfterNavigate });
    const trigger = screen.getByRole('button', {
      name: /^Profile and settings:/,
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = await screen.findByRole('menu', {
      name: 'Profile and settings',
    });
    // Anchored by its bottom edge above the trigger, not at the header's
    // top-right corner where the old avatar menu opened.
    expect(menu.style.bottom).not.toBe('');
    expect(menu.style.top).toBe('auto');

    fireEvent.click(screen.getByRole('menuitem', { name: 'Profile' }));
    expect(navigate).toHaveBeenCalledWith('/profile');
    // The footer's own navigation, so the phone drawer closes after it.
    expect(onAfterNavigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Open settings' }),
    );
    expect(navigate).toHaveBeenLastCalledWith('/settings');
  });

  test('the account menu asks the header for help and closes the phone drawer', async () => {
    const helpRequests = vi.fn();
    const unsubscribe = subscribeHelpMenuRequests(helpRequests);
    try {
      const navigate = vi.fn();
      const onAfterNavigate = vi.fn();
      renderFooter({ navigate, isMobile: true, onAfterNavigate });
      fireEvent.click(
        screen.getByRole('button', { name: /^Profile and settings:/ }),
      );
      fireEvent.click(
        await screen.findByRole('menuitem', { name: 'Ask Station for help' }),
      );
      expect(helpRequests).toHaveBeenCalledTimes(1);
      expect(onAfterNavigate).toHaveBeenCalledTimes(1);
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  test('the account control is pressed on the profile route and names Settings as current there', async () => {
    renderFooter({ activePath: '/settings' });
    const trigger = screen.getByRole('button', {
      name: /^Profile and settings:/,
    });
    expect(trigger.className).not.toContain('sidebar__footer-action--active');
    fireEvent.click(trigger);
    expect(
      (
        await screen.findByRole('menuitem', { name: 'Open settings' })
      ).getAttribute('aria-current'),
    ).toBe('page');
  });

  // Keyboard operability of the panel's bottom controls, which the retired
  // status line's controls had. Every one is a real `button` element — which
  // is what carries Enter/Space activation and tab order — rather than a
  // clickable `div`, and none is removed from the tab order.
  test('every footer control is a focusable button in the tab order', () => {
    renderFooter();
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.tagName)).toEqual(
      buttons.map(() => 'BUTTON'),
    );
    expect(buttons.map((button) => button.getAttribute('type'))).toEqual(
      buttons.map(() => 'button'),
    );
    for (const button of buttons) {
      expect(button.getAttribute('tabindex')).toBeNull();
      expect(button.hasAttribute('disabled')).toBe(false);
      button.focus();
      expect(document.activeElement).toBe(button);
    }
  });
});

test('the collapsed footer keeps utilities reachable and Customize returns to More', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  try {
    const navigate = vi.fn();
    renderFooter({ collapsed: true, navigate });
    expect(screen.queryByRole('button', { name: 'Automations' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Who is here:/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Updates' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /^Profile and settings:/ }),
    ).toBeTruthy();
    const more = screen.getByRole('button', { name: 'Sidebar utilities' });
    more.focus();
    fireEvent.click(more);
    expect(
      screen.getByRole('dialog', { name: 'Sidebar utilities' }),
    ).toBeTruthy();
    const press = createEvent.pointerDown(more, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(more, press);
    if (!press.defaultPrevented) act(() => more.focus());
    fireEvent.click(more);
    expect(
      screen.queryByRole('dialog', { name: 'Sidebar utilities' }),
    ).toBeNull();
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('button', { name: 'Automations' }));
    expect(navigate).toHaveBeenCalledWith('/automations');
    expect(
      screen.queryByRole('dialog', { name: 'Sidebar utilities' }),
    ).toBeNull();
    more.focus();
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    await screen.findByRole('dialog', { name: 'Customize' });
    fireEvent.click(screen.getByRole('button', { name: 'Close Customize' }));
    await waitFor(() => expect(document.activeElement).toBe(more));
  } finally {
    vi.unstubAllGlobals();
  }
});

/**
 * The app renders under StrictMode, which replays a component's effects once
 * when it mounts. The account menu's chunk loads on demand, so it mounts
 * already open: a replayed focus entry restored focus to the trigger while
 * its focusout dismissal still listened, and the menu closed in the same task
 * it opened (found in the running app, phone drawer and desktop alike).
 */
describe('the account menu under StrictMode', () => {
  for (const isMobile of [true, false])
    test(`${isMobile ? 'phone drawer' : 'desktop rail'}: it opens and stays open`, async () => {
      render(
        <StrictMode>
          <ProjectSidebarFooter
            activePath="/"
            isMobile={isMobile}
            navigate={vi.fn()}
          />
        </StrictMode>,
      );
      const trigger = screen.getByRole('button', {
        name: /^Profile and settings:/,
      });
      trigger.focus();
      fireEvent.click(trigger);
      const menu = await screen.findByRole('menu', {
        name: 'Profile and settings',
      });
      // Past the chunk load and every replayed effect: still open, and focus
      // went into the menu rather than back to the trigger.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(menu.isConnected).toBe(true);
      expect(menu.contains(document.activeElement)).toBe(true);
    });
});
