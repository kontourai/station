/** @vitest-environment jsdom */

/**
 * archive#4460: before the fix, only Chat's dock chrome had a resize handle,
 * maximize/collapse and a placement control. These tests drive the REAL
 * `NavigationProvider` (unlike `AmbientChatDockPaneHost.test.tsx`'s static
 * navigation mock) so maximize/collapse genuinely round-trip through the
 * shared navigation store.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
import {
  RegionModelProvider,
  useRegionModel,
} from '../../contexts/RegionModelContext';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { AmbientChatDockPaneHost } from '../AmbientChatDockPaneHost';

vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
}));

// archive#4525: `DockShell` (via `useDockShellChrome`) now reads `useProjects`
// for its project-binding deletion cleanup. Mocked here the same way every
// other unrelated context in this file is — this suite is about the shell's
// control set, not project binding (see `DockShellProjectBinding.test.tsx`
// for that).
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
  regionModel = null;
  resetDockPlacementState('/?dock=open', { dock: 'open' });
});

afterEach(() => {
  cleanup();
  // A test that fails before its own `mockRestore` would otherwise leave the
  // store spied, and `vi.spyOn` on an already-spied method hands back the SAME
  // mock — so the next test would read the previous test's calls as its own.
  vi.restoreAllMocks();
  resetDockPlacementState('/', { dock: null });
  delete (globalThis.navigator as { locks?: unknown }).locks;
});

/**
 * `deviceSettingsStore` is a module singleton whose in-memory snapshot
 * survives a `localStorage.removeItem`, so a test that lands the region
 * mirror's `dockSlotPlacement: 'right'` write would otherwise hand every
 * later test in this file a right-hand dock (and no bottom resize handle).
 * `reloadFromStorage` is the store's own documented test-isolation seam —
 * it re-reads the cleared key and notifies, which is also what makes
 * `navigationStore` recompute its `dockMode` fallback.
 */
function resetDockPlacementState(
  url: string,
  params: Record<string, string | null>,
) {
  window.localStorage.removeItem(AMBIENT_DOCK_STORAGE_KEY);
  window.localStorage.removeItem(DEVICE_SETTINGS_KEY);
  window.history.replaceState({}, '', url);
  navigationStore.navigate('/', {
    maximize: null,
    dockSlotPlacement: null,
    ...params,
  });
  deviceSettingsStore.reloadFromStorage();
}

function renderHost() {
  return render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <ShortcutProbe
            onReady={(registry) => {
              shortcutRegistry = registry;
            }}
          />
          <RegionModelProbe />
          <RegionToolbarControls />
          <AmbientChatDockPaneHost
            renderChatPane={(instance) => (
              <p data-testid="ambient-chat-occupant">
                Chat pane {instance.instanceId}
              </p>
            )}
          />
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
}

let shortcutRegistry: ReturnType<typeof useShortcutRegistry> | null = null;

/**
 * Region state is not addressable from the DOM — the placement class and the
 * collapsed class only report which region holds chat and whether it is
 * visible, never which regions were VACATED. Reading the live model is what
 * lets a test see the difference between "chat moved" and "chat was copied".
 */
let regionModel: ReturnType<typeof useRegionModel> | null = null;

function RegionModelProbe() {
  regionModel = useRegionModel();
  return null;
}

function currentRegionModel(): ReturnType<typeof useRegionModel> {
  if (!regionModel) throw new Error('region model probe never rendered');
  return regionModel;
}

function dockParam(): string | null {
  return new URLSearchParams(window.location.search).get('dock');
}

/**
 * #1536 F folded the toolbar's five per-region buttons into ONE "Layout" control;
 * #1552 D2 made what it opens a placement PICKER — a `radiogroup` row per
 * surface whose segments are the regions it may occupy plus `Hidden`. A
 * placement is therefore the surface's row plus the region's segment, and the
 * panel is a `group` rather than a `menu` (the arrow keys belong to the rows).
 */
function layoutPicker() {
  fireEvent.click(screen.getByRole('button', { name: 'Layout regions' }));
  return screen.getByRole('group', { name: 'Layout regions' });
}

/** Press one segment of one surface's row of the picker. */
function chooseSegment(surfaceTitle: string, segmentLabel: string) {
  const row = within(layoutPicker()).getByRole('radiogroup', {
    name: `${surfaceTitle} placement`,
  });
  fireEvent.click(within(row).getByRole('radio', { name: segmentLabel }));
}

async function placeChatRight() {
  renderHost();
  await waitFor(() =>
    expect(document.querySelector('.chat-dock')).not.toBeNull(),
  );
  chooseChatForEmptyRight();
  await waitFor(() =>
    expect(document.querySelector('.chat-dock--right')).not.toBeNull(),
  );
}

function chooseChatForEmptyRight() {
  // The retired "Place Chat here" under a Right heading.
  chooseSegment('Chat', 'Right');
}

function dockToggle(): () => void {
  const toggle = (shortcutRegistry?.getAllShortcuts() ?? []).find(
    (shortcut) => shortcut.id === 'dock.toggle',
  );
  if (!toggle) throw new Error('dock.toggle is not registered');
  return toggle.handler;
}

async function mountedChatDock() {
  renderHost();
  await waitFor(() => {
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
  });
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

/**
 * #928 step 3b flips the writer: a placement, a visibility change or a size
 * change is made on the REGION MODEL, and navigation's `dock`/`maximize`/
 * `dockSlotPlacement` params plus the `dockSlotPlacement`/`chatDockHeight`/
 * `chatDockWidth` device settings become its durable mirror. These tests drive
 * the real toolbar control, the real `dock.toggle` handler and the real
 * `DockShell` against the real navigation and device stores, so nothing here
 * can pass on a mocked mirror.
 */
describe('the region model is the dock writer (station#928 step 3b)', () => {
  test('seeding from a persisted placement writes nothing back', async () => {
    deviceSettingsStore.set('dockSlotPlacement', 'right');
    const dockModeWrite = vi.spyOn(navigationStore, 'setDockMode');
    const deviceWrite = vi.spyOn(deviceSettingsStore, 'set');

    renderHost();
    await waitFor(() =>
      expect(document.querySelector('.chat-dock--right')).not.toBeNull(),
    );

    // #1265: resolving a remembered placement is not a user action, so the
    // mirror must stay silent — a mount that re-emitted its own seed would
    // write a `dockSlotPlacement` URL param nobody asked for, and would make
    // every route the user opens look like an explicit placement choice.
    expect(dockModeWrite).not.toHaveBeenCalled();
    expect(deviceWrite).not.toHaveBeenCalled();
    expect(
      new URLSearchParams(window.location.search).get('dockSlotPlacement'),
    ).toBeNull();
  });

  test('placing chat in a region vacates the old one and mirrors navigation and device settings', async () => {
    await placeChatRight();

    expect(navigationStore.getSnapshot().dockMode).toBe('right');
    expect(deviceSettingsStore.get('dockSlotPlacement')).toBe('right');
    // The move is a move, not a copy: nothing but the model can report this.
    expect(currentRegionModel().regions.bottom.occupant).toBeNull();
    expect(currentRegionModel().regions.right.occupant).toBe('chat');
    expect(document.querySelector('.chat-dock--bottom')).toBeNull();
  });

  test("a region size write is mirrored to that region's own device setting", async () => {
    await placeChatRight();

    act(() => currentRegionModel().setRegion('right', { size: 517 }));

    await waitFor(() =>
      expect(deviceSettingsStore.get('chatDockWidth')).toBe(517),
    );
    // The bottom region's own setting is untouched — the mirror is per region,
    // not a single "dock size".
    expect(deviceSettingsStore.get('chatDockHeight')).toBe(320);
  });

  test('toggling visibility moves only the dock param and writes no size', async () => {
    await placeChatRight();
    const deviceWrite = vi.spyOn(deviceSettingsStore, 'set');
    const toggle = dockToggle();

    expect(dockParam()).toBe('open');
    expect(document.querySelector('.chat-dock.is-collapsed')).toBeNull();

    act(() => toggle());
    await waitFor(() =>
      expect(document.querySelector('.chat-dock.is-collapsed')).not.toBeNull(),
    );
    expect(dockParam()).toBeNull();
    expect(currentRegionModel().regions.right.visible).toBe(false);

    act(() => toggle());
    await waitFor(() =>
      expect(document.querySelector('.chat-dock.is-collapsed')).toBeNull(),
    );
    expect(dockParam()).toBe('open');
    expect(currentRegionModel().regions.right.visible).toBe(true);

    // A visibility change carries no size, so the mirror must write none —
    // a mirror that re-emits every field on every diff would loop the store.
    expect(deviceWrite.mock.calls.map(([key]) => key)).toEqual([]);
  });

  test('an unrelated device-setting change leaves the placed region alone', async () => {
    await placeChatRight();

    act(() => deviceSettingsStore.set('inboxOpen', false));

    expect(currentRegionModel().regions.right.occupant).toBe('chat');
    expect(currentRegionModel().regions.right.visible).toBe(true);
    expect(document.querySelector('.chat-dock--right')).not.toBeNull();
    expect(document.querySelector('.chat-dock.is-collapsed')).toBeNull();
  });

  test('one user action produces exactly one mirror write per mirrored field', async () => {
    renderHost();
    await waitFor(() =>
      expect(document.querySelector('.chat-dock')).not.toBeNull(),
    );
    const dockModeWrite = vi.spyOn(navigationStore, 'setDockMode');
    const dockStateWrite = vi.spyOn(navigationStore, 'setDockState');
    const deviceWrite = vi.spyOn(deviceSettingsStore, 'set');

    chooseChatForEmptyRight();
    await waitFor(() =>
      expect(document.querySelector('.chat-dock--right')).not.toBeNull(),
    );

    // A placement moves one mirrored fact — where chat is (once, through
    // `setDockMode`, which writes the URL param and the device setting
    // together). The dock was showing before and after, so `setDockState`,
    // whose side effect is recording `lastDockMaximized`, must not run.
    expect(dockModeWrite).toHaveBeenCalledTimes(1);
    expect(dockModeWrite).toHaveBeenCalledWith('right');
    expect(dockStateWrite).not.toHaveBeenCalled();
    expect(deviceWrite.mock.calls.map(([key]) => key)).toEqual([
      'dockSlotPlacement',
      'chatDockWidth',
    ]);

    dockModeWrite.mockClear();
    dockStateWrite.mockClear();
    deviceWrite.mockClear();

    act(() => dockToggle()());
    await waitFor(() =>
      expect(document.querySelector('.chat-dock.is-collapsed')).not.toBeNull(),
    );

    expect(dockStateWrite).toHaveBeenCalledTimes(1);
    expect(dockModeWrite).not.toHaveBeenCalled();
    expect(deviceWrite.mock.calls.map(([key]) => key)).toEqual([]);
  });

  test('moving a docked dock keeps the remembered maximize', async () => {
    renderHost();
    await waitFor(() =>
      expect(document.querySelector('.chat-dock')).not.toBeNull(),
    );
    // Maximize, then dock back down the way a navigation does: the store
    // keeps `lastDockMaximized` so a later `focusSession` reveal can restore
    // Full (archive#1298, `useChatDockActions`).
    act(() => navigationStore.setDockState(true, true));
    act(() => navigationStore.collapseMaximizedDock());
    expect(navigationStore.lastDockMaximized).toBe(true);

    chooseChatForEmptyRight();
    await waitFor(() =>
      expect(document.querySelector('.chat-dock--right')).not.toBeNull(),
    );

    expect(navigationStore.lastDockMaximized).toBe(true);
  });

  // #928 slice iii: the chord writes the REGION; navigation's `maximize`
  // param and `lastDockMaximized` follow as its mirror. The collapse-on-
  // navigate seam (archive#1298) restores the region without forgetting the
  // preference, and a `focusSession`-style restore is inbound to the region.
  test('dock.maximize maximizes the region, mirrors navigation, and survives collapse-on-navigate as memory', async () => {
    renderHost();
    await waitFor(() =>
      expect(document.querySelector('.chat-dock')).not.toBeNull(),
    );
    const maximize = (shortcutRegistry?.getAllShortcuts() ?? []).find(
      (shortcut) => shortcut.id === 'dock.maximize',
    );
    if (!maximize) throw new Error('dock.maximize is not registered');
    const dockStateWrite = vi.spyOn(navigationStore, 'setDockState');

    act(() => maximize.handler());

    await waitFor(() =>
      expect(document.querySelector('.chat-dock.is-maximized')).not.toBeNull(),
    );
    expect(currentRegionModel().regions.bottom.maximized).toBe(true);
    expect(dockStateWrite).toHaveBeenCalledTimes(1);
    expect(dockStateWrite).toHaveBeenCalledWith(true, true);
    expect(new URLSearchParams(window.location.search).get('maximize')).toBe(
      'true',
    );
    expect(navigationStore.lastDockMaximized).toBe(true);

    // Navigating elsewhere restores the dock to its docked size (archive#869)
    // WITHOUT touching the memory (archive#1298): the region clears, the URL
    // param clears, `lastDockMaximized` stays.
    dockStateWrite.mockClear();
    act(() => navigationStore.navigate('/projects'));
    await waitFor(() =>
      expect(currentRegionModel().regions.bottom.maximized).toBe(false),
    );
    await waitFor(() =>
      expect(document.querySelector('.chat-dock.is-maximized')).toBeNull(),
    );
    expect(
      new URLSearchParams(window.location.search).get('maximize'),
    ).toBeNull();
    expect(dockStateWrite).not.toHaveBeenCalled();
    expect(navigationStore.lastDockMaximized).toBe(true);

    // The `focusSession` restore still speaks navigation; the region follows.
    act(() =>
      navigationStore.setDockState(true, navigationStore.lastDockMaximized),
    );
    await waitFor(() =>
      expect(currentRegionModel().regions.bottom.maximized).toBe(true),
    );
    await waitFor(() =>
      expect(document.querySelector('.chat-dock.is-maximized')).not.toBeNull(),
    );
  });

  test('placing chat while the dock is hidden reveals it there', async () => {
    renderHost();
    await waitFor(() =>
      expect(document.querySelector('.chat-dock')).not.toBeNull(),
    );
    // Hide from Full so the close leaves a memory worth keeping: a docked
    // close forwards `false`, which any show would then preserve trivially.
    const maximize = (shortcutRegistry?.getAllShortcuts() ?? []).find(
      (shortcut) => shortcut.id === 'dock.maximize',
    );
    if (!maximize) throw new Error('dock.maximize is not registered');
    act(() => maximize.handler());
    await waitFor(() =>
      expect(document.querySelector('.chat-dock.is-maximized')).not.toBeNull(),
    );
    act(() => dockToggle()());
    await waitFor(() =>
      expect(document.querySelector('.chat-dock.is-collapsed')).not.toBeNull(),
    );
    expect(navigationStore.lastDockMaximized).toBe(true);
    const dockStateWrite = vi.spyOn(navigationStore, 'setDockState');

    chooseChatForEmptyRight();
    await waitFor(() =>
      expect(document.querySelector('.chat-dock--right')).not.toBeNull(),
    );

    expect(document.querySelector('.chat-dock.is-collapsed')).toBeNull();
    expect(dockParam()).toBe('open');
    expect(dockStateWrite).toHaveBeenCalledTimes(1);
    // A placement into a hidden empty region is placement + show in one diff
    // with `maximized` cleared (#1385): a plain show, so it forwards no
    // maximize and the memory the close kept survives (#1563). The
    // `setRegion({ visible: true })` re-show is pinned in
    // `RegionModelContext.reshowKeepsMaximizeMemory.test.tsx`.
    expect(dockStateWrite).toHaveBeenCalledWith(true, undefined);
    expect(document.querySelector('.chat-dock.is-maximized')).toBeNull();
    expect(navigationStore.lastDockMaximized).toBe(true);
  });

  test('a placement arriving through the device setting is not replayed as a choice', async () => {
    renderHost();
    await waitFor(() =>
      expect(document.querySelector('.chat-dock--bottom')).not.toBeNull(),
    );
    const dockModeWrite = vi.spyOn(navigationStore, 'setDockMode');

    // Another tab's choice lands as a device-setting change; navigation
    // recomputes `dockMode` from it (navigation-store.ts,
    // `handleDeviceSettingsChange`) and the model re-seeds.
    act(() => deviceSettingsStore.set('dockSlotPlacement', 'right'));
    await waitFor(() =>
      expect(document.querySelector('.chat-dock--right')).not.toBeNull(),
    );

    // A seed is inbound. Replaying it as a user write would stamp
    // `dockSlotPlacement` into this tab's URL, after which the URL param
    // governs and this tab never follows the device setting again.
    expect(dockModeWrite).not.toHaveBeenCalled();
    expect(
      new URLSearchParams(window.location.search).get('dockSlotPlacement'),
    ).toBeNull();
    expect(currentRegionModel().regions.right.occupant).toBe('chat');
    expect(currentRegionModel().regions.bottom.occupant).toBeNull();
  });

  test('a hidden region keeps its occupant mounted', async () => {
    renderHost();
    await waitFor(() =>
      expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
    );

    act(() => currentRegionModel().setRegion('bottom', { visible: false }));

    await waitFor(() =>
      expect(document.querySelector('.chat-dock.is-collapsed')).not.toBeNull(),
    );
    expect(currentRegionModel().regions.bottom.visible).toBe(false);
    // `DockShell` renders its occupant unconditionally and collapses the box
    // with a class — hiding a region must not unmount the surface inside it,
    // or every collapse would throw away the occupant's live state.
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
  });
});

describe('the docked Chat gets the full dock chrome (station#4460)', () => {
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
    expect(document.querySelector('.chat-dock.is-collapsed')).toBeNull();
    // The retired "Hide Chat" row: Chat's `Hidden` segment.
    chooseSegment('Chat', 'Hidden');
    await waitFor(() => {
      expect(document.querySelector('.chat-dock.is-collapsed')).not.toBeNull();
    });
  });

  // Chat's OWN header content is rendered by the real `ChatWorkspacePane`
  // (a heavy component with its own large context/data-fetching surface),
  // not by this test's mocked `renderChatPane` — so this file cannot mount
  // Chat's real maximize/collapse/placement controls without also mounting
  // all of `ChatWorkspacePane`. What it CAN prove for Chat, with the mock,
  // is `DockShell`'s own always-present piece: the resize handle. The rest
  // of the control set is covered where the real `ChatDockHeader` (the SAME
  // shared component the Activity region shell uses) is unit-tested with
  // `chatControls` supplied: `ChatDockHeaderCollapse.test.tsx`
  // (maximize/collapse/placement and the header's accessible-name pin).
  test('Chat, docked by default, gets the shell resize handle', async () => {
    await mountedChatDock();
    expect(
      document.querySelector('hr.chat-dock__resize-handle'),
      'the bottom-dock resize handle must be present regardless of occupant',
    ).not.toBeNull();
  });
});
