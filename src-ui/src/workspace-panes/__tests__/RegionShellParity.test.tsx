/** @vitest-environment jsdom */

/**
 * #928: `RegionShells` mounts one `DockShell` per occupied dock region instead
 * of a single ambient `ChatDock` that follows chat around. With chat as the
 * only surface this must be behaviour-neutral, so the oracle is a capture of
 * the pre-refactor tree (`c58ddf284`) rendered through the same harness as
 * `DockShellControlParity.test.tsx` — nine placement × state literals below.
 * Only Chat's pane renderer is mocked (it would mount the whole chat data
 * stack), so RegionShells → `RegionPaneHost` → `DockShell` →
 * `useDockShellChrome` is the shipped path (#2045: the host is the REGION's,
 * one per occupied dock region, and Chat is a pane of it; #2046 2b: the
 * region bar and its tab strip render above the panes, and a region holding
 * Chat is Chat's shell whichever tab it shows).
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
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RegionShells } from '../../app-shell/RegionShells';
import { DockShell } from '../../components/chat-dock/DockShell';
import { OverflowMenu } from '../../components/header/OverflowMenu';
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
import { MOBILE_MEDIA_QUERY } from '../../hooks/useIsMobile';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { DOCK_REGION_IDS, foldedDockRegion } from '../../regions/region-model';
import type { DockMode } from '../../types';
import { RegionPaneHost } from '../RegionPaneHost';

vi.mock('../../components/chat-dock/ChatDock', () => ({
  // The model-less mount; never taken under `RegionModelProvider`.
  ChatDock: () => null,
  renderAmbientChatPane: () => (
    <p data-testid="ambient-chat-occupant">Chat pane</p>
  ),
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
}));
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
vi.mock('../../contexts/ConfigContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/ConfigContext')>()),
  useConfig: () => null,
}));

const AMBIENT_DOCK_STORAGE_KEY =
  'station:workspace-pane-host:v2:ambient:chat-dock';
const DEVICE_SETTINGS_KEY = 'station-device-settings-v1';
const DESKTOP_WIDTH = 1024;

type DockState = 'open' | 'collapsed' | 'maximized';

/** Captured on `c58ddf284` before `RegionShells` existed; see file header. */
const PRE_REFACTOR_CAPTURE: readonly {
  placement: DockMode;
  state: DockState;
  classes: readonly string[];
  dockSlotSize: string;
  /** The rendered side's own `--region-<side>-size`; '' for bottom. */
  sideSize: string;
}[] = [
  {
    placement: 'bottom',
    state: 'open',
    classes: ['chat-dock', 'chat-dock--bottom'],
    dockSlotSize: '320px',
    sideSize: '',
  },
  {
    placement: 'bottom',
    state: 'collapsed',
    classes: ['chat-dock', 'chat-dock--bottom', 'is-collapsed'],
    dockSlotSize: '38px',
    sideSize: '',
  },
  {
    placement: 'bottom',
    state: 'maximized',
    classes: ['chat-dock', 'chat-dock--bottom', 'is-maximized'],
    dockSlotSize: '320px',
    sideSize: '',
  },
  {
    placement: 'left',
    state: 'open',
    classes: ['chat-dock', 'chat-dock--left'],
    dockSlotSize: '0px',
    sideSize: '400px',
  },
  {
    placement: 'left',
    state: 'collapsed',
    classes: ['chat-dock', 'chat-dock--left', 'is-collapsed'],
    dockSlotSize: '0px',
    sideSize: '400px',
  },
  {
    placement: 'left',
    state: 'maximized',
    classes: ['chat-dock', 'chat-dock--left', 'is-maximized'],
    dockSlotSize: '0px',
    sideSize: '400px',
  },
  {
    placement: 'right',
    state: 'open',
    classes: ['chat-dock', 'chat-dock--right'],
    dockSlotSize: '0px',
    sideSize: '400px',
  },
  {
    placement: 'right',
    state: 'collapsed',
    classes: ['chat-dock', 'chat-dock--right', 'is-collapsed'],
    dockSlotSize: '0px',
    sideSize: '400px',
  },
  {
    placement: 'right',
    state: 'maximized',
    classes: ['chat-dock', 'chat-dock--right', 'is-maximized'],
    dockSlotSize: '0px',
    sideSize: '400px',
  },
];

/**
 * jsdom ships no `matchMedia`, so `useIsMobile` — the single source of truth
 * for the media query that decides whether chat.css displays the `⋯` button —
 * would report "not mobile" at every width and the phone tests below would
 * exercise the wrong branch. Only that one query is evaluated; anything else
 * answers false, which is what the absent implementation already meant.
 */
function installMobileMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === MOBILE_MEDIA_QUERY && window.innerWidth <= 768,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => {
  installMobileMatchMedia();
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
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: DESKTOP_WIDTH,
  });
  regionModel = null;
  shortcutRegistry = null;
  resetDockPlacementState('/?dock=open', { dock: 'open' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetDockPlacementState('/', { dock: null });
  delete (globalThis.navigator as { locks?: unknown }).locks;
  delete (window as { matchMedia?: unknown }).matchMedia;
});

/** Same seam as `DockShellControlParity.test.tsx` — see its docblock. */
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

function seedPlacement(placement: DockMode, state: DockState) {
  const params = {
    dock: state === 'collapsed' ? null : 'open',
    dockSlotPlacement: placement,
    maximize: state === 'maximized' ? 'true' : null,
  };
  const query = new URLSearchParams(
    Object.entries(params).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  );
  resetDockPlacementState(`/?${query}`, params);
}

let shortcutRegistry: ReturnType<typeof useShortcutRegistry> | null = null;
let regionModel: ReturnType<typeof useRegionModel> | null = null;

function ShortcutProbe() {
  const registry = useShortcutRegistry();
  useEffect(() => {
    shortcutRegistry = registry;
  }, [registry]);
  return null;
}

function RegionModelProbe() {
  regionModel = useRegionModel();
  return null;
}

function currentRegionModel(): ReturnType<typeof useRegionModel> {
  if (!regionModel) throw new Error('region model probe never rendered');
  return regionModel;
}

/**
 * The `⋯` overflow menu, mounted the way `HeaderActions` mounts it. Since
 * #917 it is where a coarse device's region commands live, so the phone tests
 * below drive Show/Hide through here rather than through a toolbar control
 * that no longer exists at those widths.
 */
function OverflowMenuHost() {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label="More actions"
        onClick={() => setIsOpen(true)}
      >
        ⋯
      </button>
      <OverflowMenu
        isOpen={isOpen}
        connStatus="connected"
        userInitials="ST"
        onClose={() => setIsOpen(false)}
        onOpenConnections={vi.fn()}
        onOpenHelp={vi.fn()}
        onOpenProfile={vi.fn()}
      />
    </>
  );
}

/**
 * Show/Hide a surface the way a phone user does: `⋯`, then the row. Scoped to
 * the menu's own region group — a shell header can carry the same label.
 */
/**
 * The retired "Swap in X" row under a region heading, and #1552 D2's segment
 * after it, both issued the model's `placeSurface(X, region)`. Since #2143
 * the toolbar carries no per-surface placement (it is one toggle per region,
 * and an OCCUPIED region's control is a toggle, not an offer), so the
 * placement a user makes here is the tab's own move menu or a link's
 * `openInRegion` — both of which are `placeSurface`. This helper issues that
 * command through the model, which is what the tests below pin: the JOIN the
 * command produces and the shell that renders it, not which chrome sent it.
 */
function placeThroughModel(surfaceId: string, region: DockMode) {
  act(() => currentRegionModel().placeSurface(surfaceId, region));
}

function selectRegionCommand(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  const group = document.querySelector('.app-toolbar__overflow-regions');
  if (!group) throw new Error('the overflow menu rendered no region rows');
  fireEvent.click(within(group as HTMLElement).getByRole('button', { name }));
}

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <ShortcutProbe />
          <RegionModelProbe />
          <RegionToolbarControls />
          <OverflowMenuHost />
          {children}
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>
  );
}

function renderShells() {
  return render(
    <Providers>
      <RegionShells />
    </Providers>,
  );
}

function shells(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.chat-dock'));
}

async function renderShellsSettled(): Promise<HTMLElement> {
  renderShells();
  await waitFor(() => expect(shells().length).toBeGreaterThan(0));
  const [shell] = shells();
  if (!shell) throw new Error('no shell rendered');
  return shell;
}

function classTokens(element: Element): string[] {
  return Array.from(element.classList).sort();
}

function shortcutEntries(id: string) {
  return (shortcutRegistry?.getAllShortcuts() ?? []).filter(
    (shortcut) => shortcut.id === id,
  );
}

function clearance(
  name: '--dock-slot-size' | `--region-${DockMode}-size`,
): string {
  return document.documentElement.style.getPropertyValue(name);
}

describe('RegionShells mounts one shell per occupied region (#928)', () => {
  test.each(['bottom', 'left', 'right'] as const)(
    'exactly one shell renders for chat in %s and follows a move',
    async (placement) => {
      seedPlacement(placement, 'open');
      const shell = await renderShellsSettled();
      expect(shells()).toHaveLength(1);
      expect(document.querySelectorAll('#chat-dock')).toHaveLength(1);
      expect(shell.dataset.region).toBe(placement);

      const destination: DockMode = placement === 'right' ? 'left' : 'right';
      act(() => currentRegionModel().placeSurface('chat', destination));
      const destinationShell = await waitFor(() => {
        const element = document.querySelector<HTMLElement>(
          `[data-region="${destination}"]`,
        );
        if (!element) throw new Error('the destination must render a shell');
        return element;
      });
      // #2045: the host is the REGION's (`ambient:<region>` document), so a
      // move is a leave-and-join and the destination's shell is a NEW node.
      // Before #2045 the shell was keyed by occupant and this asserted the
      // same node; that pin is retired with the per-occupant shell it
      // described.
      expect(destinationShell).not.toBe(shell);
      // Chat's shell — `#chat-dock`, "Dock" — is the destination's and there
      // is exactly one of it, which is what "one shell per region" protects.
      expect(document.querySelectorAll('#chat-dock')).toHaveLength(1);
      expect(destinationShell.id).toBe('chat-dock');
      expect(
        destinationShell.classList.contains(`chat-dock--${destination}`),
      ).toBe(true);
      // A MOVE hides the region it vacates (#2153: a move is not a close),
      // so the vacated shell is gone and there is one shell: the
      // destination's. A CLOSE would have left it open on a placeholder.
      expect(shells()).toHaveLength(1);
      expect(shell.isConnected).toBe(false);
      // The re-propped instance republishes clearance for its new region.
      await waitFor(() => expect(clearance('--dock-slot-size')).toBe('0px'));
      // Per-region clearance follows the shell: the vacated region's
      // variable is withdrawn, the destination's is written.
      expect(clearance(`--region-${destination}-size`)).toBe('400px');
      expect(clearance(`--region-${placement}-size`)).toBe('');
    },
  );

  test('an empty HIDDEN region renders no section at all', async () => {
    seedPlacement('right', 'open');
    await renderShellsSettled();
    // Empty AND hidden, which since #2153 is what it takes to render
    // nothing: an empty region that is VISIBLE gets a host (next test).
    expect(currentRegionModel().regions.bottom).toMatchObject({
      panes: [],
      visible: false,
    });
    expect(document.querySelector('[data-region="bottom"]')).toBeNull();
    expect(document.querySelector('[data-region="left"]')).toBeNull();
    expect(
      document.querySelectorAll('section[aria-label="Dock"]'),
    ).toHaveLength(1);
  });

  /**
   * #2153: a dock region may be visible while empty. It renders its own
   * section — named for the REGION, since it has no pane to be named after —
   * with the chrome bar over the chooser (#2154), and no tab strip.
   *
   * Reverting `RegionShells`' mount condition to
   * `occupant && resolveRegionSurface(occupant)` reds the first assertion
   * (no section renders at all); reverting `RegionPaneHost`'s `emptyRegion`
   * branch reds the placeholder assertion.
   */
  test('a visible EMPTY region renders a section named for the region, with the placeholder and no tabs', async () => {
    seedPlacement('right', 'open');
    await renderShellsSettled();
    act(() => currentRegionModel().setRegion('left', { visible: true }));
    await act(async () => {
      await vi.dynamicImportSettled();
    });

    const left = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-region="left"]',
      );
      if (!element) throw new Error('the visible empty region must render');
      return element;
    });
    expect(currentRegionModel().regions.left).toMatchObject({
      panes: [],
      occupant: null,
      visible: true,
    });
    // The landmark is the region's own name, not "Dock" — that is Chat's,
    // and Chat is in `right`.
    expect(left.getAttribute('aria-label')).toBe('Left region');
    expect(left.id).toBe('');
    expect(document.querySelectorAll('#chat-dock')).toHaveLength(1);
    expect(
      within(left).getByText('Nothing in the Left region yet'),
    ).toBeTruthy();
    // No tabs; the body is the chooser (#2154), and the "+" opens the same
    // rows as a menu — both offered without a project.
    expect(within(left).queryAllByRole('tab')).toHaveLength(0);
    expect(
      within(left).getByRole('list', { name: 'Add to Left region' }),
    ).toBeTruthy();
    expect(within(left).getByLabelText('Add pane to Left')).toBeTruthy();
    // The chevron names the region too, so one name reaches the reader from
    // the landmark, the control and the placeholder alike.
    const chevron = within(left).getByLabelText('Hide Left region');
    expect(chevron).toBeTruthy();
    // And it advertises NO chord. `surfaceShortcutId` falls back to
    // `dock.toggle` for a shell with no occupant — CHAT's chord, live in
    // this tree because Chat's own shell in `right` registers it — so
    // without the empty-region branch the tooltip would read "Hide Left
    // region (⌘D)", naming a key that toggles Chat wherever Chat is rather
    // than this region. This is the case that gives the assertion its power:
    // the same check in a tree with no Chat shell passes either way, because
    // an unregistered id displays nothing.
    expect(chevron.title).toBe('Hide Left region');
    // The control group: Chat's own chevron, in the same tree, DOES carry a
    // chord hint. Compared as "the title adds something to the label" rather
    // than against a literal, because the glyph is platform-dependent (⌘D on
    // a Mac, Ctrl+D elsewhere) and this must not red on the runner's OS.
    const chatChevron = within(
      document.querySelector<HTMLElement>('#chat-dock') ?? left,
    ).getByLabelText('Hide Chat');
    expect(
      chatChevron.title.startsWith('Hide Chat ('),
      `the chord must be live in this tree, or the assertion above is vacuous (chat title: ${chatChevron.title})`,
    ).toBe(true);
  });

  test('an occupant without a registered shell renders nothing', async () => {
    seedPlacement('bottom', 'open');
    await renderShellsSettled();

    act(() =>
      currentRegionModel().setRegion('right', {
        panes: ['fixture'],
        occupant: 'fixture',
        visible: true,
      }),
    );
    // Let any host `RegionShells` mounted resolve its chunk: a host handed
    // an occupant with no pane throws, and the throw only becomes visible
    // (as the lazy boundary's error surface) once the chunk has loaded.
    await act(async () => {
      await vi.dynamicImportSettled();
    });

    expect(document.querySelector('[data-region="right"]')).toBeNull();
    expect(shells()).toHaveLength(1);
    // #2045: "nothing" includes no host that threw on a pane it has no
    // inventory for — `RegionShells` decides from the registry before
    // mounting, so no boundary ever has an error to report.
    expect(document.querySelector('.lazy-boundary__error')).toBeNull();
  });

  test.each(PRE_REFACTOR_CAPTURE)(
    'class set and shell id match the pre-refactor capture ($placement/$state)',
    async ({ placement, state, classes }) => {
      seedPlacement(placement, state);
      const shell = await renderShellsSettled();
      await waitFor(() => expect(classTokens(shell)).toEqual([...classes]));
      expect(shell.id).toBe('chat-dock');
      expect(shells()).toHaveLength(1);
    },
  );

  test.each(PRE_REFACTOR_CAPTURE)(
    'clearance variables match the pre-refactor capture ($placement/$state)',
    async ({ placement, state, classes, dockSlotSize, sideSize }) => {
      seedPlacement(placement, state);
      const shell = await renderShellsSettled();
      await waitFor(() => expect(classTokens(shell)).toEqual([...classes]));
      await waitFor(() =>
        expect(clearance('--dock-slot-size')).toBe(dockSlotSize),
      );
      // The captured side width, now under the rendered side's own name:
      // the single-side alias it was captured from is retired (#1374).
      if (placement !== 'bottom') {
        expect(clearance(`--region-${placement}-size`)).toBe(sideSize);
      }
    },
  );

  /**
   * #928 contract, not a capture: the rendered region's variable carries
   * the value its legacy alias does (a side's width, bottom's size) and the
   * other two regions publish nothing. A collapsed side still reports its
   * expanded width — the 36px rail is owned by the `.is-collapsed` track
   * override in index.css/BannerHost.css, not by `--region-<id>-size`.
   */
  test.each(PRE_REFACTOR_CAPTURE)(
    'the rendered region alone publishes --region-<id>-size ($placement/$state)',
    async ({ placement, state, dockSlotSize, sideSize }) => {
      seedPlacement(placement, state);
      await renderShellsSettled();
      await waitFor(() =>
        expect(clearance('--dock-slot-size')).toBe(dockSlotSize),
      );
      for (const region of DOCK_REGION_IDS) {
        expect(clearance(`--region-${region}-size`)).toBe(
          region !== placement
            ? ''
            : placement === 'bottom'
              ? dockSlotSize
              : sideSize,
        );
      }
    },
  );

  /**
   * A computed oracle beside the transcribed one: `regionId === undefined`
   * is the pre-refactor read path (useDockShellChrome.ts `readerRegion`),
   * so the legacy host rendered in the same harness must produce the same
   * shell as `RegionShells` for every state.
   */
  test.each(PRE_REFACTOR_CAPTURE)(
    'RegionShells matches the legacy single-host mount ($placement/$state)',
    async ({ placement, state }) => {
      seedPlacement(placement, state);
      render(
        <Providers>
          <RegionPaneHost renderChatPane={() => <p>Chat pane</p>} />
        </Providers>,
      );
      await waitFor(() => expect(shells()).toHaveLength(1));
      const legacy = shells()[0];
      if (!legacy) throw new Error('legacy shell never rendered');
      await waitFor(() => expect(clearance('--dock-slot-size')).not.toBe(''));
      const expected = {
        classes: classTokens(legacy),
        id: legacy.id,
        dockSlotSize: clearance('--dock-slot-size'),
        // #1374: the legacy mount publishes per-region clearance too, so
        // the comparison spans the same four variables rather than the two
        // aliases that used to be all it wrote.
        regionSizes: DOCK_REGION_IDS.map((region) =>
          clearance(`--region-${region}-size`),
        ),
      };
      cleanup();

      seedPlacement(placement, state);
      const shell = await renderShellsSettled();
      await waitFor(() => expect(classTokens(shell)).toEqual(expected.classes));
      await waitFor(() =>
        expect(clearance('--dock-slot-size')).toBe(expected.dockSlotSize),
      );
      expect(shell.id).toBe(expected.id);
      expect(
        DOCK_REGION_IDS.map((region) => clearance(`--region-${region}-size`)),
      ).toEqual(expected.regionSizes);
      // Not vacuously equal: the rendered region published something.
      expect(expected.regionSizes.filter(Boolean)).toHaveLength(1);
    },
  );

  test('one live dock.maximize registration owned by the chat shell', async () => {
    seedPlacement('bottom', 'open');
    await renderShellsSettled();
    await waitFor(() =>
      expect(shortcutEntries('dock.maximize')).toHaveLength(1),
    );
    // Visibility belongs to `RegionToolbarControls` (mounted above), never
    // to a shell; `DockShellChatShortcutRegistration.test.tsx` pins zero
    // without the toolbar.
    expect(shortcutEntries('dock.toggle')).toHaveLength(1);
  });

  test('the Activity chord places into a free region without evicting Chat, then toggles visibility', async () => {
    seedPlacement('right', 'open');
    await renderShellsSettled();
    const activityToggle = shortcutEntries('activity.toggle')[0];
    if (!activityToggle) throw new Error('activity.toggle must be registered');

    act(() => activityToggle.handler());
    await waitFor(() =>
      expect(currentRegionModel().regions.bottom.occupant).toBe('activity'),
    );
    expect(currentRegionModel().regions.right.occupant).toBe('chat');

    act(() => shortcutEntries('activity.toggle')[0]?.handler());
    await waitFor(() =>
      expect(currentRegionModel().regions.bottom.visible).toBe(false),
    );
    act(() => shortcutEntries('activity.toggle')[0]?.handler());
    await waitFor(() =>
      expect(currentRegionModel().regions.bottom.visible).toBe(true),
    );
  });

  /**
   * #2046 2a, decision 3: the retired "Swap in Activity" under the Bottom
   * heading no longer relocates Chat. Activity JOINS `bottom`'s panes,
   * selected, and Chat stays behind its tab in the same region — the shell
   * node is the same `bottom` shell, and navigation's placement is unchanged
   * (no `setDockMode`). #2046 2b: the shell is Chat's whichever tab shows
   * (D3 — it keeps `#chat-dock` and the "Dock" landmark), the region bar
   * renders both tabs with Activity's pressed, and ⌘D selects Chat's tab
   * back. Reverting to displacement fails the `right` assertion (it would
   * hold Chat) and the `setDockMode` one (it would be called with 'right');
   * reverting D3 fails the `#chat-dock` assertion after the join.
   */
  test('the default Bottom placement joins Activity to Chat’s region; ⌘D selects Chat’s tab back', async () => {
    seedPlacement('bottom', 'open');
    const chatShell = await renderShellsSettled();
    const dockModeWrite = vi.spyOn(navigationStore, 'setDockMode');

    placeThroughModel('activity', 'bottom');

    await waitFor(() =>
      expect(currentRegionModel().regions.bottom).toMatchObject({
        panes: ['chat', 'activity'],
        occupant: 'activity',
        visible: true,
      }),
    );
    expect(currentRegionModel().regions.right.panes).toEqual([]);
    await waitFor(() =>
      expect(
        within(chatShell)
          .getByRole('tab', { name: 'Activity' })
          .getAttribute('aria-selected'),
      ).toBe('true'),
    );
    // One shell, the same node: `bottom`'s host stayed mounted through the
    // pane-set change (no occupant key remount, decision 4).
    expect(shells()).toHaveLength(1);
    expect(chatShell.isConnected).toBe(true);
    expect(chatShell.dataset.region).toBe('bottom');
    expect(chatShell.getAttribute('aria-label')).toBe('Dock');
    expect(document.querySelector('#chat-dock')).toBe(chatShell);
    expect(
      within(chatShell)
        .getByRole('tab', { name: 'Chat' })
        .getAttribute('aria-selected'),
    ).toBe('false');
    expect(navigationStore.getSnapshot().dockMode).toBe('bottom');
    expect(dockModeWrite).not.toHaveBeenCalled();

    act(() => shortcutEntries('dock.toggle')[0]?.handler());
    await waitFor(() =>
      expect(currentRegionModel().regions.bottom.occupant).toBe('chat'),
    );
    await waitFor(() =>
      expect(
        within(chatShell)
          .getByRole('tab', { name: 'Chat' })
          .getAttribute('aria-selected'),
      ).toBe('true'),
    );
    expect(document.querySelector('#chat-dock')).toBe(chatShell);
    expect(currentRegionModel().regions.bottom.visible).toBe(true);
  });

  test('a non-chat shell neither takes the chat id nor the maximize command', async () => {
    seedPlacement('bottom', 'maximized');
    const twoShells = (showRight: boolean) => (
      <Providers>
        <DockShell regionId="bottom">{() => <p>bottom occupant</p>}</DockShell>
        {showRight ? (
          <DockShell regionId="right">{() => <p>right occupant</p>}</DockShell>
        ) : null}
      </Providers>
    );
    const { rerender } = render(twoShells(true));
    await waitFor(() => expect(shells()).toHaveLength(2));
    act(() =>
      currentRegionModel().setRegion('right', {
        panes: ['fixture'],
        occupant: 'fixture',
        visible: true,
      }),
    );

    const bottom = document.querySelector<HTMLElement>(
      '[data-region="bottom"]',
    );
    const right = document.querySelector<HTMLElement>('[data-region="right"]');
    if (!bottom || !right) throw new Error('both shells must render');
    expect(document.querySelectorAll('#chat-dock')).toHaveLength(1);
    expect(bottom.id).toBe('chat-dock');
    expect(right.id).toBe('');
    // Each shell reads ITS region (useDockShellChrome.ts `readerRegion`),
    // not chat's: the right shell is a right panel and stays open while the
    // bottom one collapses.
    expect(right.classList.contains('chat-dock--right')).toBe(true);
    // Navigation's maximize flag is chat's (useDockShellChrome.ts
    // `shellOccupant`); the fixture shell must not inherit it.
    expect(bottom.classList.contains('is-maximized')).toBe(true);
    expect(right.classList.contains('is-maximized')).toBe(false);
    act(() => currentRegionModel().setRegion('bottom', { visible: false }));
    await waitFor(() =>
      expect(bottom.classList.contains('is-collapsed')).toBe(true),
    );
    expect(right.classList.contains('is-collapsed')).toBe(false);

    // The registry is keyed by id (last-register-wins), so a count cannot
    // see a second registration. Unmounting the non-chat shell can: if it
    // had registered, its retraction would leave dock.maximize dead while
    // the chat shell is still mounted (the #1202 shape).
    rerender(twoShells(false));
    await waitFor(() => expect(shells()).toHaveLength(1));
    const [maximize] = shortcutEntries('dock.maximize');
    if (!maximize) throw new Error('dock.maximize must survive the unmount');
    // Collapsing cleared the maximize flag (`setDockState(false, false)`),
    // so the first press maximizes and the second restores.
    act(() => maximize.handler());
    await waitFor(() =>
      expect(bottom.classList.contains('is-maximized')).toBe(true),
    );
    act(() => maximize.handler());
    await waitFor(() =>
      expect(bottom.classList.contains('is-maximized')).toBe(false),
    );
  });

  test('Chat and Activity occupy independent desktop regions with distinct shell ownership', async () => {
    seedPlacement('bottom', 'open');
    await renderShellsSettled();
    act(() => currentRegionModel().placeSurface('activity', 'right'));

    await waitFor(() => expect(shells()).toHaveLength(2));
    expect(document.querySelectorAll('#chat-dock')).toHaveLength(1);
    expect(
      document.querySelectorAll('section[aria-label="Dock"]'),
    ).toHaveLength(1);
    expect(
      document.querySelectorAll('section[aria-label="Activity"]'),
    ).toHaveLength(1);
    expect(shortcutEntries('dock.maximize')).toHaveLength(1);
    await waitFor(() =>
      expect(clearance('--region-bottom-size')).toBe('320px'),
    );
    await waitFor(() => expect(clearance('--region-right-size')).toBe('400px'));

    const chatShell = document.querySelector<HTMLElement>('#chat-dock');
    const activityShell = document.querySelector<HTMLElement>(
      'section[aria-label="Activity"]',
    );
    if (!activityShell) throw new Error('Activity shell never rendered');
    // #928 slice iii: Activity gets the maximize control, but ⌘M is Chat's
    // shell's registration and acts on Chat's region, so it is not
    // advertised here.
    expect(
      within(activityShell).getByLabelText('Expand dock region to workspace'),
    ).toBeTruthy();
    expect(within(activityShell).queryByText('⌘M')).toBeNull();
    expect(
      within(activityShell)
        .getByLabelText('Hide Activity')
        .getAttribute('title'),
    ).toContain('Ctrl+Shift+A');
    expect(
      within(activityShell).getByLabelText('Resize Activity'),
    ).toBeTruthy();

    window.localStorage.setItem('station.chatDock.snap', 'half');
    fireEvent.click(within(activityShell).getByLabelText('Hide Activity'));
    await waitFor(() =>
      expect(activityShell.classList.contains('is-collapsed')).toBe(true),
    );
    // Asserted mid-cycle: after the expand below the key would read 'half'
    // again even if Activity had written it.
    expect(window.localStorage.getItem('station.chatDock.snap')).toBe('half');
    fireEvent.click(within(activityShell).getByLabelText('Show Activity'));
    await waitFor(() =>
      expect(activityShell.classList.contains('is-collapsed')).toBe(false),
    );
    expect(window.localStorage.getItem('station.chatDock.snap')).toBe('half');

    act(() => {
      currentRegionModel().setRegion('right', { visible: false, size: 600 });
    });
    const dockModeWrite = vi.spyOn(navigationStore, 'setDockMode');
    // The retired "Swap in Activity" under the BOTTOM heading — Chat holds
    // `bottom` here and Activity holds `right`. Since #2046 2a choosing it
    // JOINS Activity to `bottom` (selected) and vacates `right`: nothing is
    // swapped, Chat stays in `bottom` behind Activity's tab, and Chat's
    // mirror has nothing to say (its region did not move).
    placeThroughModel('activity', 'bottom');
    await waitFor(() =>
      expect(currentRegionModel().regions.bottom).toMatchObject({
        panes: ['chat', 'activity'],
        occupant: 'activity',
        visible: true,
      }),
    );
    expect(currentRegionModel().regions.right).toMatchObject({
      panes: [],
      visible: false,
      // The vacated region keeps its size for the next surface placed there.
      size: 600,
    });
    await waitFor(() => expect(shells()).toHaveLength(1));
    // `bottom`'s host is the same node, now showing Activity behind a tab
    // strip; `right`'s host unmounted with its last pane. The one shell is
    // still Chat's (#2046 2b, D3): `#chat-dock`, "Dock".
    expect(chatShell?.isConnected).toBe(true);
    expect(activityShell.isConnected).toBe(false);
    expect(document.querySelector('section[aria-label="Activity"]')).toBeNull();
    expect(document.querySelector('#chat-dock')).toBe(chatShell);
    expect(chatShell?.getAttribute('aria-label')).toBe('Dock');
    if (!chatShell) throw new Error('chat shell must render');
    expect(
      within(chatShell)
        .getAllByRole('tab')
        .map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]),
    ).toEqual([
      ['Chat', 'false'],
      ['Activity', 'true'],
    ]);
    expect(navigationStore.getSnapshot().dockMode).toBe('bottom');
    await act(async () => Promise.resolve());
    expect(dockModeWrite).not.toHaveBeenCalled();
    // Not Chat's region, so its width was never Chat's mirror to write.
    expect(deviceSettingsStore.get('chatDockWidth')).toBe(400);
  });

  // #1385: Chat maximized in `bottom`, Activity placed into it. Maximize used
  // to be Chat's navigation flag, so Chat's shell — re-propped by the swap —
  // kept rendering `width: 100%` on a fixed side panel, over the Activity
  // shell the user had just asked for. Maximize is now the region's attribute
  // and `placeSurface` clears it in the region a surface enters; since #2046
  // 2a Activity JOINS `bottom` rather than displacing Chat, and the one
  // shell — `bottom`'s, showing Activity — comes out restored.
  test('the #1385 repro: placing Activity into a maximized Chat region leaves nothing maximized', async () => {
    seedPlacement('bottom', 'maximized');
    const chatShell = await renderShellsSettled();
    await waitFor(() =>
      expect(chatShell.classList.contains('is-maximized')).toBe(true),
    );
    expect(currentRegionModel().regions.bottom.maximized).toBe(true);
    act(() => currentRegionModel().placeSurface('activity', 'right'));
    await waitFor(() => expect(shells()).toHaveLength(2));

    act(() => currentRegionModel().placeSurface('activity', 'bottom'));

    // One shell: `bottom`, which now holds both panes; the vacated `right`
    // hid with its last pane (#2153: a move is not a close). It is Chat's —
    // `#chat-dock` — which is what this repro turns on.
    await waitFor(() => expect(shells()).toHaveLength(1));
    expect(document.querySelectorAll('#chat-dock')).toHaveLength(1);
    const activityShell = document.querySelector<HTMLElement>('#chat-dock');
    if (!activityShell) throw new Error('the joined shell never rendered');
    expect(activityShell.dataset.region).toBe('bottom');
    expect(activityShell).toBe(chatShell);
    await waitFor(() =>
      expect(
        within(activityShell)
          .getByRole('tab', { name: 'Activity' })
          .getAttribute('aria-selected'),
      ).toBe('true'),
    );
    expect(currentRegionModel().regions.bottom).toMatchObject({
      panes: ['chat', 'activity'],
      occupant: 'activity',
      visible: true,
      maximized: false,
    });
    // Vacated by a move, so hidden (#2153), and — the point of this repro —
    // RESTORED: an empty region is never maximized.
    expect(currentRegionModel().regions.right).toMatchObject({
      panes: [],
      visible: false,
      maximized: false,
    });
    await waitFor(() =>
      expect(activityShell.classList.contains('is-maximized')).toBe(false),
    );
    expect(activityShell.style.width).not.toBe('100%');
    expect(document.querySelectorAll('.chat-dock.is-maximized')).toHaveLength(
      0,
    );
    // Chat's mirror followed: navigation no longer says maximized either.
    await waitFor(() =>
      expect(navigationStore.getSnapshot().isDockMaximized).toBe(false),
    );
  });

  test('a maximized Activity renders the geometry a maximized Chat does, and only one region is maximized at a time', async () => {
    // Oracle: Chat maximized in `right`, through the same harness.
    seedPlacement('right', 'maximized');
    const chatRight = await renderShellsSettled();
    await waitFor(() =>
      expect(chatRight.classList.contains('is-maximized')).toBe(true),
    );
    const expected = {
      classes: classTokens(chatRight),
      width: chatRight.style.width,
    };
    expect(expected.width).toBe('100%');
    cleanup();

    seedPlacement('bottom', 'maximized');
    const chatShell = await renderShellsSettled();
    await waitFor(() =>
      expect(chatShell.classList.contains('is-maximized')).toBe(true),
    );
    act(() => currentRegionModel().placeSurface('activity', 'right'));
    await waitFor(() => expect(shells()).toHaveLength(2));
    const activityShell = document.querySelector<HTMLElement>(
      'section[aria-label="Activity"]',
    );
    if (!activityShell) throw new Error('Activity shell never rendered');

    fireEvent.click(
      within(activityShell).getByLabelText('Expand dock region to workspace'),
    );

    await waitFor(() =>
      expect(activityShell.classList.contains('is-maximized')).toBe(true),
    );
    expect(classTokens(activityShell)).toEqual(expected.classes);
    expect(activityShell.style.width).toBe(expected.width);
    expect(currentRegionModel().regions.right.maximized).toBe(true);
    // Maximizing Activity restored Chat: one maximized region at a time.
    expect(currentRegionModel().regions.bottom.maximized).toBe(false);
    await waitFor(() =>
      expect(chatShell.classList.contains('is-maximized')).toBe(false),
    );
    // Activity's maximize is not Chat's: the URL and memory are Chat's mirror.
    expect(navigationStore.getSnapshot().isDockMaximized).toBe(false);
    expect(
      within(activityShell).getByLabelText('Restore dock region size'),
    ).toBeTruthy();

    fireEvent.click(
      within(activityShell).getByLabelText('Restore dock region size'),
    );
    await waitFor(() =>
      expect(activityShell.classList.contains('is-maximized')).toBe(false),
    );
    expect(currentRegionModel().regions.right.maximized).toBe(false);
  });

  // `data-region` names the region the shell RENDERS in, because the desktop
  // grid keys its tracks on it (index.css `.app__main:has(> [data-region])`).
  // The persisted region stays `right` in the model; the fold is what the
  // grid must see (DockShell.tsx `renderedRegion`).
  test('phone with a persisted side placement still renders the folded bottom shell', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    seedPlacement('right', 'open');
    const shell = await renderShellsSettled();
    expect(shells()).toHaveLength(1);
    expect(currentRegionModel().regions.right.occupant).toBe('chat');
    expect(shell.dataset.region).toBe('bottom');
    expect(shell.classList.contains('chat-dock--bottom')).toBe(true);
    await waitFor(() => expect(clearance('--dock-slot-size')).not.toBe(''));
    // Clearance is reported under the rendered region (the one the grid
    // keys on, #1366), not the persisted one.
    expect(clearance('--region-bottom-size')).toBe(
      clearance('--dock-slot-size'),
    );
    expect(clearance('--region-right-size')).toBe('');

    // Activity JOINS Chat's region (#2046 2a): one shell, still Chat's
    // (#2046 2b, D3 — `#chat-dock` stays whichever tab shows), no tab strip
    // on a coarse device, Activity selected.
    act(() => currentRegionModel().placeSurface('activity', 'right'));
    await waitFor(() =>
      expect(currentRegionModel().regions.right.occupant).toBe('activity'),
    );
    expect(shells()).toHaveLength(1);
    expect(document.querySelectorAll('#chat-dock')).toHaveLength(1);
    expect(document.querySelector('section[aria-label="Activity"]')).toBeNull();
    expect(shell.getAttribute('aria-label')).toBe('Dock');
    expect(within(shell).queryByRole('tablist')).toBeNull();
    // #917: at this width the toolbar renders no region control at all, so the
    // `⋯` menu below is the only route. Asserted here so a regression that
    // brings the fieldset back cannot hide behind the commands still working.
    expect(document.querySelector('.app-toolbar__regions')).toBeNull();
    // D2: the folded rows are the region's panes — the selected pane's row
    // is the region's Hide, the other pane's row selects it.
    selectRegionCommand('Show Chat in the dock');
    await waitFor(() =>
      expect(currentRegionModel().regions.right.occupant).toBe('chat'),
    );
    expect(shells()).toHaveLength(1);
    selectRegionCommand('Show Activity in the dock');
    await waitFor(() =>
      expect(currentRegionModel().regions.right.occupant).toBe('activity'),
    );
    expect(shells()).toHaveLength(1);
    // #2046 2a: Activity joined Chat's region above, so hiding Activity hides
    // that one region — its shell stays mounted, collapsed — and showing
    // Activity expands it again.
    selectRegionCommand('Hide Activity from the dock');
    await waitFor(() =>
      expect(shell.classList.contains('is-collapsed')).toBe(true),
    );
    expect(currentRegionModel().regions.right).toMatchObject({
      panes: ['chat', 'activity'],
      occupant: 'activity',
      visible: false,
    });
    selectRegionCommand('Show Activity in the dock');
    await waitFor(() =>
      expect(shell.classList.contains('is-collapsed')).toBe(false),
    );

    /**
     * #1386. The `⋯` row and the docked shell's own visibility control are
     * both on screen here, and they used to carry the SAME accessible name:
     * two buttons called "Hide Activity", one in `.chat-dock__icon-btn` and
     * one in `.menu-row`. The row now says which shell it means, in the same
     * "… the dock" vocabulary as the `Move <title> to the dock` row beside
     * it, so the shell's control — the one a user points at — keeps the bare
     * name to itself.
     *
     * Asserted by CLASS as well as by count: a rename that merely changed
     * which of the two answers to "Hide Activity" would keep a count of one.
     */
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(
      screen
        .getAllByRole('button', { name: 'Hide Activity' })
        .map((button) => button.className),
    ).toEqual(['chat-dock__icon-btn']);
    expect(
      screen.getByRole('button', { name: 'Hide Activity from the dock' })
        .className,
    ).toBe('menu-row');
  });

  // #928 slice C retired Activity's standalone placement, so the route-side
  // away state that used to drive this ("Activity is hidden from the bottom
  // bar" + its Show action) is gone with it. The fold behaviour it was proving
  // is the shell's, not the route's, so it is driven here through the region
  // command every surviving surface offers — no matchMedia stub, so
  // `availablePlacements` reads the real coarse provider, which is the half
  // the old name was about.
  test('re-showing a hidden Activity region folds Chat out through the real coarse provider', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    seedPlacement('bottom', 'open');
    render(
      <Providers>
        <RegionShells />
      </Providers>,
    );
    act(() => {
      currentRegionModel().placeSurface('activity', 'right');
      currentRegionModel().setRegion('right', { visible: false });
    });
    // Hidden: neither occupant renders a shell on a folded device.
    await waitFor(() =>
      expect(
        document.querySelector('section[aria-label="Activity"]'),
      ).toBeNull(),
    );

    selectRegionCommand('Show Activity in the dock');

    await waitFor(() =>
      expect(
        document.querySelector('section[aria-label="Activity"]'),
      ).not.toBeNull(),
    );
    expect(
      foldedDockRegion(
        currentRegionModel().regions,
        currentRegionModel().lastShownRegion,
      ),
    ).toBe('right');
    expect(currentRegionModel().regions.right.visible).toBe(true);
    expect(currentRegionModel().regions.bottom.visible).toBe(false);
    expect(document.querySelector('#chat-dock')).toBeNull();
  });

  test('rotating a two-visible-occupant desktop layout to coarse keeps only the last shown occupant', async () => {
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
    seedPlacement('bottom', 'open');
    await renderShellsSettled();
    act(() => currentRegionModel().placeSurface('activity', 'right'));
    await waitFor(() => expect(shells()).toHaveLength(2));

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    act(() => window.dispatchEvent(new Event('resize')));

    await waitFor(() => expect(shells()).toHaveLength(1));
    expect(
      document.querySelector('section[aria-label="Activity"]'),
    ).not.toBeNull();
    expect(document.querySelector('#chat-dock')).toBeNull();
  });

  // A wide coarse-pointer device (landscape tablet) keeps the desktop grid ON
  // while `availablePlacements` still folds to bottom — the one device class
  // where region and fold can disagree with the grid watching.
  test('a wide coarse-pointer device stamps the folded region the grid keys on', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(pointer: coarse)',
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    seedPlacement('right', 'open');
    const shell = await renderShellsSettled();
    expect(shells()).toHaveLength(1);
    expect(currentRegionModel().regions.right.occupant).toBe('chat');
    expect(shell.dataset.region).toBe('bottom');
    expect(shell.classList.contains('chat-dock--bottom')).toBe(true);
    act(() => currentRegionModel().placeSurface('activity', 'left'));
    await waitFor(() => expect(shells()).toHaveLength(1));
    expect(
      document.querySelector('section[aria-label="Activity"]'),
    ).not.toBeNull();
  });
});

/**
 * #2155 D3. The toolbar's per-region toggle used to write `visible` alone
 * while the region bar's chevron went through `applyDockSnap` — so a region
 * hidden from the toolbar kept its maximize memory and came back MAXIMIZED,
 * while one hidden from its own chevron came back at the snap the chevron
 * stored. The #2143 docblock recorded that as an open gap; this is the pin
 * that closes it.
 *
 * The real `RegionShells` → `RegionPaneHost` → `DockShell` →
 * `useDockShellChrome` path is what publishes the applier the toggle calls
 * (`region-visibility-appliers.ts`), so nothing here can pass on a mock.
 *
 * THE ROUTES ARE CROSSED, and that is what gives this its power. Comparing
 * toolbar-hide/toolbar-show against chevron-hide/chevron-show does NOT
 * discriminate: a hide that writes the region directly can clear `maximized`
 * on the way past and reach the same record — measured, by injecting exactly
 * that and watching the same-route comparison stay green. What it cannot
 * reach is the shell's own SNAP, which is not in the region record at all:
 * a direct write leaves the shell still holding `full`, so the chevron's next
 * show reopens the region maximized. Hiding by one control and showing by the
 * other is the sequence that reads it, and the persisted snap below says the
 * same thing absolutely.
 */
describe('the toolbar toggle and the region bar chevron are one act (#2155)', () => {
  const SNAP_KEY = 'station.chatDock.snap';

  /**
   * Maximize Chat's region, hide it by one route, show it by another, and
   * hand back what the model records for that region afterwards.
   */
  async function maximizeHideShow(
    hideBy: 'toolbar' | 'chevron',
    showBy: 'toolbar' | 'chevron',
  ) {
    // The shell seeds its snap from this key when its region holds Chat, so a
    // previous run's `full` would decide the next run's reopen.
    window.localStorage.removeItem(SNAP_KEY);
    seedPlacement('right', 'open');
    const shell = await renderShellsSettled();
    const toolbarToggle = () =>
      screen.getByRole('button', { name: 'Right region' });
    const press = (
      route: 'toolbar' | 'chevron',
      label: 'Hide Chat' | 'Show Chat',
    ) =>
      route === 'toolbar'
        ? fireEvent.click(toolbarToggle())
        : fireEvent.click(within(shell).getByLabelText(label));

    fireEvent.click(
      within(shell).getByLabelText('Expand dock region to workspace'),
    );
    await waitFor(() =>
      expect(currentRegionModel().regions.right.maximized).toBe(true),
    );
    expect(window.localStorage.getItem(SNAP_KEY)).toBe('full');

    press(hideBy, 'Hide Chat');
    await waitFor(() =>
      expect(currentRegionModel().regions.right.visible).toBe(false),
    );
    // Absolute, not by agreement: the hide went through the shell's own
    // `applyDockSnap`, which is the only thing that records the collapse.
    // A hide that wrote the region directly leaves this at `full` — and the
    // next show, by either control, reopens the region maximized.
    expect(
      window.localStorage.getItem(SNAP_KEY),
      `hiding from the ${hideBy} did not record the collapse on the shell's snap`,
    ).toBe('collapsed');
    expect(currentRegionModel().regions.right.maximized).toBe(false);
    expect(toolbarToggle().getAttribute('aria-pressed')).toBe('false');

    press(showBy, 'Show Chat');
    await waitFor(() =>
      expect(currentRegionModel().regions.right.visible).toBe(true),
    );
    const record = { ...currentRegionModel().regions.right };
    cleanup();
    return record;
  }

  /**
   * #2155 review M7: the UNREGISTER, through the mount it belongs to.
   *
   * `region-visibility-appliers.test`-style coverage that calls the registry
   * API by hand cannot prove this — `tests/AGENTS.md` says as much, and the
   * hazard is precisely a shell that went away leaving its closure behind. A
   * region emptied by a MOVE hides and unmounts its host (#2153), so the
   * toolbar's next press has no applier to find and must write the model
   * itself. Dropping the effect's returned cleanup in `useDockShellChrome`
   * reds this: the departed shell's `setRegionOpen` would answer instead, and
   * `setRegion` would never be called.
   */
  test('a shell that unmounts takes its applier with it, and the toggle writes the model', async () => {
    seedPlacement('right', 'open');
    await renderShellsSettled();
    expect(currentRegionModel().regions.right.occupant).toBe('chat');

    // A MOVE empties `right` and hides it, so `RegionShells` mounts no host
    // there at all — the state in which no applier can exist.
    act(() => currentRegionModel().placeSurface('chat', 'bottom'));
    await waitFor(() =>
      expect(document.querySelector('[data-region="right"]')).toBeNull(),
    );
    expect(currentRegionModel().regions.right).toMatchObject({
      panes: [],
      visible: false,
    });

    const wrote = vi.spyOn(currentRegionModel(), 'setRegion');
    fireEvent.click(screen.getByRole('button', { name: 'Right region' }));

    expect(
      wrote,
      'the toolbar found an applier for a region with no mounted shell',
    ).toHaveBeenCalledWith('right', { visible: true, maximized: false });
    await waitFor(() =>
      expect(currentRegionModel().regions.right.visible).toBe(true),
    );
  });

  test('maximize, hide and show leave the identical region record, whichever control does which half', async () => {
    const records = {
      'toolbar → toolbar': await maximizeHideShow('toolbar', 'toolbar'),
      'toolbar → chevron': await maximizeHideShow('toolbar', 'chevron'),
      'chevron → toolbar': await maximizeHideShow('chevron', 'toolbar'),
      'chevron → chevron': await maximizeHideShow('chevron', 'chevron'),
    };

    // The precondition: the sequence really did put Chat in `right` and bring
    // it back on screen, un-maximized. Without it "every route agrees" would
    // be satisfied by four routes that all did nothing.
    expect(records['toolbar → toolbar']).toMatchObject({
      panes: ['chat'],
      occupant: 'chat',
      visible: true,
      maximized: false,
    });
    for (const [route, record] of Object.entries(records))
      expect(record, `${route} left a different arrangement`).toEqual(
        records['chevron → chevron'],
      );
  });
});
