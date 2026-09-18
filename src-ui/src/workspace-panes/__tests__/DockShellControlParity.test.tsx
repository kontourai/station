/** @vitest-environment jsdom */

/**
 * archive#4460: before the fix, only Chat's dock chrome had a resize handle,
 * maximize/collapse and a placement control. These tests drive the REAL
 * `NavigationProvider` (unlike `RegionPaneHost.test.tsx`'s static
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
import { RegionPaneHost } from '../RegionPaneHost';

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
  // #2047: the region host resolves the dock's project through this read;
  // no project here, so the panes that need one derive none.
  useProject: () => ({ project: undefined, isLoading: false }),
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
          <RegionPaneHost
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

/** Press a region's toggle: the region shows or hides, every pane with it. */
function pressRegionToggle(regionLabel: string) {
  fireEvent.click(
    screen.getByRole('button', { name: `${regionLabel} region` }),
  );
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

/**
 * The retired "Place Chat here", then #2143's "Show Chat here" offer row
 * under an empty region's toolbar button. Since #2155 the toolbar places
 * nothing at all — its toggles only show and hide, and what goes in a region
 * is the region's own chooser (#2154) — so the placement these tests need as
 * a fixture is issued through the model, the same command every surviving
 * route (a tab's move menu, the chooser, a link's `openInRegion`) reaches.
 * What this file pins is the MIRROR a placement produces, not which chrome
 * sent it; `RegionToolbarControls.test.tsx` owns the toolbar's own behaviour.
 */
function chooseChatForEmptyRight() {
  act(() => currentRegionModel().placeSurface('chat', 'right'));
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
    // The retired "Hide Chat" row: the Bottom region's toggle (#2143).
    pressRegionToggle('Bottom');
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

  /**
   * #2153, through the REAL `useDockShellChrome`: a visible EMPTY region has
   * no occupant to be named after, so the chrome names the REGION and every
   * control that reads `surfaceTitle` follows — the chevron ("Hide Right
   * region"), the landmark and the resize grip.
   *
   * Reverting `surfaceTitle`'s empty-region branch in `useDockShellChrome.ts`
   * to the bare `'Chat'` fallback reds all three: the shell would offer
   * "Hide Chat" on a region holding no Chat, which is #1386's defect
   * relocated. `canMaximize` stays false for an empty region (it reads
   * `shellOccupant !== null`), which is why no maximize control is here.
   */
  test('an empty region names ITSELF in the chevron, the landmark and the grip', async () => {
    render(
      <KeyboardShortcutsProvider>
        <NavigationProvider>
          <RegionModelProvider>
            <RegionModelProbe />
            <RegionPaneHost
              regionId="right"
              renderChatPane={() => <p>unused</p>}
            />
          </RegionModelProvider>
        </NavigationProvider>
      </KeyboardShortcutsProvider>,
    );
    const empty = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        'section[aria-label="Right region"]',
      );
      if (!element) throw new Error('the empty region shell never rendered');
      return element;
    });
    expect(currentRegionModel().regions.right).toMatchObject({
      panes: [],
      occupant: null,
      visible: false,
    });
    // Hidden to start: the chevron offers to SHOW it, under the region's own
    // name. Pressing it is the real model write — an empty region can be
    // shown (#2153) — and the name follows the new state.
    fireEvent.click(within(empty).getByLabelText('Show Right region'));
    await waitFor(() =>
      expect(currentRegionModel().regions.right.visible).toBe(true),
    );
    expect(within(empty).getByLabelText('Hide Right region')).toBeTruthy();
    expect(within(empty).getByLabelText('Resize Right region')).toBeTruthy();
    // No maximize for an empty region, and no tabs.
    expect(
      within(empty).queryByLabelText(/^Expand .* to workspace$/),
    ).toBeNull();
    expect(within(empty).queryAllByRole('tab')).toHaveLength(0);
  });
});

/**
 * The region bar's bare surface is a header drag surface (`RegionChromeBar`
 * wires the chrome's `onHeaderDragPointerDown` pair — the gesture Chat's
 * mobile header wears), so a dock's header resizes the dock whichever
 * occupant it names, on both device shapes: a fine pointer commits the
 * exact clamped height, a coarse one resolves a snap — the same split the
 * resize handle keys on `isMobile`. These drive the REAL chrome through the
 * REAL bar, so the mode selection, the bail wiring and the snap/commit
 * destination are all the shipped path. The pointer mechanics themselves
 * (capture, thresholds, flings) are the shared hook's,
 * `useChatDockVerticalDrag.test.tsx`.
 */
describe('the region bar is a header drag surface (real chrome)', () => {
  test('a bare-surface drag on a fine pointer commits an exact dock height', async () => {
    renderHost();
    await waitFor(() =>
      expect(document.querySelector('.chat-dock--bottom')).not.toBeNull(),
    );
    const shell = document.querySelector('.chat-dock') as HTMLElement;
    const bar = shell.querySelector('.region-chrome') as HTMLElement;
    expect(
      bar,
      'the ambient dock renders its region bar on a fine pointer',
    ).not.toBeNull();

    // Down at the bar, up 300px: the committed height is the pointer's
    // distance to the viewport bottom (768 - 400), clamped.
    fireEvent.pointerDown(
      bar.querySelector('.chat-dock__title') as HTMLElement,
      { button: 0, pointerId: 1, clientY: 700 },
    );
    expect(
      shell.className,
      'a bare-surface press announces the drag immediately (no tap target under it)',
    ).toContain('is-dragging');
    fireEvent.pointerMove(bar, { pointerId: 1, clientY: 400 });
    fireEvent.pointerUp(bar, { pointerId: 1, clientY: 400 });

    expect(shell.className).not.toContain('is-dragging');
    expect(shell.style.height).toBe('368px');
  });

  test('a bare-surface drag on a coarse non-chat bar resolves a snap — collapse, like chat’s bar', async () => {
    // A coarse pointer folds every placement to bottom and renders no tab
    // strip. The AMBIENT mount is chat-locked (its selection never leaves
    // chat, so there the bar yields to ChatDockMobileHeader), so the coarse
    // bar drives a regional mount holding Activity.
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: true,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    try {
      render(
        <KeyboardShortcutsProvider>
          <NavigationProvider>
            <RegionModelProvider>
              <RegionModelProbe />
              <RegionPaneHost
                regionId="bottom"
                // Bottom's default occupant is chat (and its pane set keeps
                // it beside Activity), so both renderers need a stub; only
                // the SELECTED pane's is on this test's path.
                renderChatPane={() => <p data-testid="region-chat-occupant" />}
                renderActivityPane={() => (
                  <p data-testid="region-activity-occupant" />
                )}
              />
            </RegionModelProvider>
          </NavigationProvider>
        </KeyboardShortcutsProvider>,
      );
      act(() => currentRegionModel().placeSurface('activity', 'bottom'));
      await waitFor(() =>
        expect(
          screen.queryByTestId('region-activity-occupant'),
        ).not.toBeNull(),
      );
      const shell = document.querySelector('.chat-dock--bottom') as HTMLElement;
      const bar = shell.querySelector('.region-chrome') as HTMLElement;
      expect(
        bar,
        'a coarse device renders the bar for a non-chat pane (mobileChat is chat-only)',
      ).not.toBeNull();
      expect(shell.className).not.toContain('is-collapsed');

      // Down 40px from the bar and release: a decisive downward gesture puts
      // the dock away — position and fling resolve to the same verdict here.
      fireEvent.pointerDown(
        bar.querySelector('.chat-dock__title') as HTMLElement,
        { button: 0, pointerId: 1, clientY: 700 },
      );
      fireEvent.pointerMove(bar, { pointerId: 1, clientY: 740 });
      fireEvent.pointerUp(bar, { pointerId: 1, clientY: 740 });

      await waitFor(() =>
        expect(currentRegionModel().regions.bottom.visible).toBe(false),
      );
      expect(shell.className).toContain('is-collapsed');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a press on a bar control is not a dock gesture — the grab keeps its own drag', async () => {
    renderHost();
    await waitFor(() =>
      expect(document.querySelector('.chat-dock--bottom')).not.toBeNull(),
    );
    const shell = document.querySelector('.chat-dock') as HTMLElement;
    const bar = shell.querySelector('.region-chrome') as HTMLElement;
    const grab = bar.querySelector(
      '.chat-dock__placement-grab',
    ) as HTMLButtonElement;

    // The grab's own placement drag hit-tests the drop edges on move;
    // jsdom has no `elementFromPoint` (null = "over no edge").
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => null,
    });
    const heightBefore = shell.style.height;
    fireEvent.pointerDown(grab, { button: 0, pointerId: 2, clientY: 700 });
    fireEvent.pointerMove(grab, { pointerId: 2, clientY: 400 });
    // The press went to the grab's placement drag: the dock neither announced
    // its own gesture nor followed the pointer's height.
    expect(shell.className).not.toContain('is-dragging');
    expect(shell.style.height).toBe(heightBefore);
    fireEvent.pointerUp(grab, { pointerId: 2, clientY: 400 });
    expect(shell.className).not.toContain('is-dragging');
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });
});
