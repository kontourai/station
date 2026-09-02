/** @vitest-environment jsdom */

/**
 * archive#4460: before the fix, only Chat's dock chrome had a resize handle,
 * maximize/collapse and a placement control, and only Home/Activity had an
 * occupant switcher — nobody had all four. These tests drive the REAL
 * `NavigationProvider` (unlike `AmbientChatDockPaneHost.test.tsx`'s static
 * navigation mock) so maximize/collapse genuinely round-trip through the
 * shared navigation store, which is what an occupant switch needs to prove
 * anything about surviving state.
 */

import {
  WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
  WORKSPACE_ACTIVITY_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-activity-pane';
import {
  WORKSPACE_HOME_PANE_DESCRIPTOR,
  WORKSPACE_HOME_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-home-pane';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RegionToolbarControls } from '../../components/header/RegionToolbarControls';
import {
  KeyboardShortcutsProvider,
  useShortcutRegistry,
} from '../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';
import { RegionModelProvider } from '../../contexts/RegionModelContext';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { AmbientChatDockPaneHost } from '../AmbientChatDockPaneHost';
import type { WorkspacePaneDockAction } from '../WorkspacePaneDockContext';

vi.mock('../../views/home/useHomeViewModel', () => ({
  useHomeViewModel: () => ({}),
}));
vi.mock('../../views/home/HomeSurface', () => ({
  HomeSurface: () => <p data-testid="ambient-home-occupant">Home surface</p>,
}));
vi.mock('../../views/SessionsView', () => ({
  SessionsView: () => (
    <p data-testid="ambient-activity-occupant">Sessions surface</p>
  ),
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
}));

// archive#4525: `DockShell` (via `useDockShellChrome`) now reads `useProjects`
// for its project-binding deletion cleanup. Mocked here the same way every
// other unrelated context in this file is — this suite is about control
// parity across occupants, not project binding (see
// `AmbientChatDockProjectBinding.test.tsx` for that).
vi.mock('../../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: [],
    isLoading: false,
    isConfirmedLoaded: true,
  }),
}));

const AMBIENT_DOCK_STORAGE_KEY =
  'station:workspace-pane-host:v2:ambient:chat-dock';
const DEVICE_SETTINGS_KEY = 'station-device-settings-v1';

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: object | null) => void | Promise<void>,
      ) => callback({}),
    },
  });
  window.localStorage.removeItem(AMBIENT_DOCK_STORAGE_KEY);
  window.localStorage.removeItem(DEVICE_SETTINGS_KEY);
  window.history.replaceState({}, '', '/?dock=open');
  navigationStore.navigate('/', { dock: 'open', maximize: null });
  navigationStore.navigate('/', {
    dock: 'open',
    maximize: null,
    dockSlotPlacement: null,
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(AMBIENT_DOCK_STORAGE_KEY);
  window.localStorage.removeItem(DEVICE_SETTINGS_KEY);
  window.history.replaceState({}, '', '/');
  navigationStore.navigate('/', { dock: null, maximize: null });
  delete (globalThis.navigator as { locks?: unknown }).locks;
});

function renderHost(
  onDockActionChange?: (action: WorkspacePaneDockAction | null) => void,
) {
  return render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <ShortcutProbe
            onReady={(registry) => {
              shortcutRegistry = registry;
            }}
          />
          <RegionToolbarControls />
          <AmbientChatDockPaneHost
            renderChatPane={(instance) => (
              <p data-testid="ambient-chat-occupant">
                Chat pane {instance.instanceId}
              </p>
            )}
            onDockActionChange={onDockActionChange}
          />
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
}

let shortcutRegistry: ReturnType<typeof useShortcutRegistry> | null = null;

async function dockedAction(): Promise<WorkspacePaneDockAction> {
  const published: (WorkspacePaneDockAction | null)[] = [];
  renderHost((action) => published.push(action));
  await waitFor(() => {
    expect(published.some((action) => action !== null)).toBe(true);
  });
  const latest = [...published].reverse().find((action) => action !== null);
  if (!latest) throw new Error('no dock action published');
  return latest;
}

/**
 * The full control-parity assertion: resize handle (`DockShell`'s job for
 * every occupant), maximize, collapse, placement control and occupant
 * picker. `occupantName` is the picker's expected current-occupant label.
 */
function expectFullDockControls(occupantName: string) {
  expect(
    document.querySelector('hr.chat-dock__resize-handle'),
    'the bottom-dock resize handle must be present regardless of occupant',
  ).not.toBeNull();
  expect(
    screen.getByLabelText(
      /^(Expand dock region to workspace|Restore dock region size)$/,
    ),
    'a maximize/restore control must be present regardless of occupant',
  ).toBeTruthy();
  expect(
    screen.getByLabelText(/^(Show|Hide) dock region$/),
    'a collapse/expand control must be present regardless of occupant',
  ).toBeTruthy();
  expect(
    screen.getByLabelText('Move the dock'),
    'the placement control must be present regardless of occupant',
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: `Docked pane: ${occupantName}` }),
    'the occupant picker must be present regardless of occupant',
  ).toBeTruthy();
}

/**
 * The registry probe exists so a test can drive `dock.toggle` through the same
 * channel ⌘D does, rather than clicking the button and hoping the binding is
 * wired. #1202 shipped a dead ⌘D past 175 green tests because nothing ever
 * exercised the shortcut id itself.
 */
function ShortcutProbe({
  onReady,
}: {
  onReady: (registry: ReturnType<typeof useShortcutRegistry>) => void;
}) {
  const registry = useShortcutRegistry();
  useEffect(() => {
    onReady(registry);
  }, [registry, onReady]);
  return null;
}

describe('every ambient occupant gets the full dock chrome (station#4460)', () => {
  test('real region placement mirrors navigation and device settings', async () => {
    renderHost();
    await waitFor(() =>
      expect(document.querySelector('.chat-dock')).not.toBeNull(),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Place Chat in Right region' }),
    );
    await waitFor(() =>
      expect(document.querySelector('.chat-dock--right')).not.toBeNull(),
    );
    expect(navigationStore.getSnapshot().dockMode).toBe('right');
    expect(deviceSettingsStore.get('dockSlotPlacement')).toBe('right');
    expect(document.querySelector('.chat-dock--bottom')).toBeNull();
  });

  test('the dock.toggle shortcut (cmd+D) collapses the real dock shell', async () => {
    renderHost();
    await waitFor(() => {
      expect(document.querySelector('.chat-dock')).not.toBeNull();
    });
    await waitFor(() => {
      expect(shortcutRegistry).not.toBeNull();
    });
    const toggle = (shortcutRegistry?.getAllShortcuts() ?? []).find(
      (shortcut) => shortcut.id === 'dock.toggle',
    );
    expect(
      toggle,
      'dock.toggle must be registered by the shell chrome',
    ).toBeTruthy();
    expect(toggle?.key).toBe('d');
    expect(toggle?.modifiers).toContain('cmd');
    expect(document.querySelector('.chat-dock.is-collapsed')).toBeNull();
    act(() => {
      toggle?.handler();
    });
    await waitFor(() => {
      expect(document.querySelector('.chat-dock.is-collapsed')).not.toBeNull();
    });
  });

  test('the real region control changes the real dock shell open state', async () => {
    renderHost();
    await waitFor(() => {
      expect(document.querySelector('.chat-dock')).not.toBeNull();
    });
    const control = screen.getByRole('button', {
      name: 'Hide Chat Bottom region',
    });
    expect(document.querySelector('.chat-dock.is-collapsed')).toBeNull();
    fireEvent.click(control);
    await waitFor(() => {
      expect(document.querySelector('.chat-dock.is-collapsed')).not.toBeNull();
    });
  });

  // Chat's OWN header content is rendered by the real `ChatWorkspacePane`
  // (a heavy component with its own large context/data-fetching surface),
  // not by this test's mocked `renderChatPane` — so this file cannot mount
  // Chat's real maximize/collapse/placement/picker controls without also
  // mounting all of `ChatWorkspacePane`. What it CAN prove for Chat, with
  // the mock, is `DockShell`'s own always-present piece: the resize handle.
  // The rest of parity for Chat is covered where the real `ChatDockHeader`
  // (the SAME shared component Home/Activity use below) is unit-tested with
  // `chatControls`/`occupantPicker` supplied:
  // `ChatDockHeaderCollapse.test.tsx` (maximize/collapse/placement) and the
  // occupant-picker rendering test added there for this archive#4460 fix.
  test('Chat, docked by default, gets the shell resize handle', async () => {
    await dockedAction();
    expect(
      document.querySelector('hr.chat-dock__resize-handle'),
      'the bottom-dock resize handle must be present regardless of occupant',
    ).not.toBeNull();
  });

  test('Home, docked, has the SAME controls the shared ChatDockHeader gives Chat', async () => {
    const action = await dockedAction();
    act(() => {
      action.dockPane(
        WORKSPACE_HOME_PANE_DESCRIPTOR,
        WORKSPACE_HOME_PANE_INSTANCE,
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId('ambient-home-occupant')).not.toBeNull();
    });
    expectFullDockControls('Home');
  });

  test('Activity, docked, has the SAME controls the shared ChatDockHeader gives Chat', async () => {
    const action = await dockedAction();
    act(() => {
      action.dockPane(
        WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
        WORKSPACE_ACTIVITY_PANE_INSTANCE,
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId('ambient-activity-occupant')).not.toBeNull();
    });
    expectFullDockControls('Activity');
  });
});

/**
 * These two describe blocks switch Home → Activity, not Chat → Home: Chat's
 * maximize control belongs to the real `ChatDockHeader` rendered by the
 * (heavy, unmocked-here) `ChatWorkspacePane`, but Home and Activity both
 * render through the exact same shared `ChatDockHeader` this file CAN mount
 * with the ambient host's existing mocks. `DockShell` — the thing actually
 * under test — cannot tell Home and Activity apart from Chat: it is the same
 * persistent instance for all three, so proving it survives a Home→Activity
 * switch proves the general claim (any occupant, not case-by-case).
 */
describe('maximize state survives an occupant switch (station#4460)', () => {
  test('maximizing while Home is docked, then switching to Activity, stays maximized with a restore control reachable', async () => {
    const action = await dockedAction();
    act(() => {
      action.dockPane(
        WORKSPACE_HOME_PANE_DESCRIPTOR,
        WORKSPACE_HOME_PANE_INSTANCE,
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId('ambient-home-occupant')).not.toBeNull();
    });

    fireEvent.click(screen.getByLabelText('Expand dock region to workspace'));
    await waitFor(() => {
      expect(document.querySelector('.chat-dock.is-maximized')).not.toBeNull();
    });

    act(() => {
      action.dockPane(
        WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
        WORKSPACE_ACTIVITY_PANE_INSTANCE,
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId('ambient-activity-occupant')).not.toBeNull();
    });

    // The trap this pins: a maximized non-chat occupant with no way back.
    // The shell stayed maximized (it never remounted — DockShell survives
    // the occupant switch) AND its own header still carries a working
    // restore control for whichever occupant is now docked.
    expect(
      document.querySelector('.chat-dock.is-maximized'),
      'the dock must remain maximized across the occupant switch',
    ).not.toBeNull();
    const restoreControl = screen.getByLabelText('Restore dock region size');
    fireEvent.click(restoreControl);
    await waitFor(() => {
      expect(document.querySelector('.chat-dock.is-maximized')).toBeNull();
    });
  });
});

describe('dock-slot geometry is stable across an occupant switch (station#4460)', () => {
  test('a maximized height survives switching from Home to Activity with no settings-derived jump', async () => {
    const action = await dockedAction();
    act(() => {
      action.dockPane(
        WORKSPACE_HOME_PANE_DESCRIPTOR,
        WORKSPACE_HOME_PANE_INSTANCE,
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId('ambient-home-occupant')).not.toBeNull();
    });

    // Commit a height that does not match the device-setting default (320)
    // — the exact scenario a settings-derived fallback would have gotten
    // wrong for a non-chat occupant pre-fix.
    fireEvent.click(screen.getByLabelText('Expand dock region to workspace'));
    await waitFor(() => {
      expect(document.querySelector('.chat-dock.is-maximized')).not.toBeNull();
    });
    const maximizedSize =
      document.documentElement.style.getPropertyValue('--dock-slot-size');
    expect(maximizedSize).not.toBe('');
    expect(maximizedSize).not.toBe('320px');

    act(() => {
      action.dockPane(
        WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
        WORKSPACE_ACTIVITY_PANE_INSTANCE,
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId('ambient-activity-occupant')).not.toBeNull();
    });

    // Single authority: Activity reads the SAME shell instance Home did, so
    // the published `--dock-slot-size` does not revert to an
    // Activity-derived fallback the moment it takes the slot.
    expect(
      document.documentElement.style.getPropertyValue('--dock-slot-size'),
    ).toBe(maximizedSize);
  });
});
