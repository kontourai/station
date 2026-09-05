/** @vitest-environment jsdom */

/**
 * #928: `RegionShells` mounts one `DockShell` per occupied dock region instead
 * of a single ambient `ChatDock` that follows chat around. With chat as the
 * only surface this must be behaviour-neutral, so the oracle is a capture of
 * the pre-refactor tree (`c58ddf284`) rendered through the same harness as
 * `DockShellControlParity.test.tsx` — nine placement × state literals below.
 * Only `ChatDock` is mocked (it would mount the whole chat data stack); the
 * mock renders the real `AmbientChatDockPaneHost`, so RegionShells → host →
 * `DockShell` → `useDockShellChrome` is the shipped path.
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
import { AmbientChatDockPaneHost } from '../AmbientChatDockPaneHost';

vi.mock('../../components/chat-dock/ChatDock', async () => {
  const { AmbientChatDockPaneHost } = await import(
    '../AmbientChatDockPaneHost'
  );
  return {
    ChatDock: ({ regionId }: { regionId?: DockMode }) => (
      <AmbientChatDockPaneHost
        regionId={regionId}
        renderChatPane={() => (
          <p data-testid="ambient-chat-occupant">Chat pane</p>
        )}
      />
    ),
  };
});
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
}));
vi.mock('../../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: [],
    isLoading: false,
    isConfirmedLoaded: true,
  }),
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
  chatDockWidth: string;
}[] = [
  {
    placement: 'bottom',
    state: 'open',
    classes: ['chat-dock', 'chat-dock--bottom'],
    dockSlotSize: '320px',
    chatDockWidth: '',
  },
  {
    placement: 'bottom',
    state: 'collapsed',
    classes: ['chat-dock', 'chat-dock--bottom', 'is-collapsed'],
    dockSlotSize: '38px',
    chatDockWidth: '',
  },
  {
    placement: 'bottom',
    state: 'maximized',
    classes: ['chat-dock', 'chat-dock--bottom', 'is-maximized'],
    dockSlotSize: '320px',
    chatDockWidth: '',
  },
  {
    placement: 'left',
    state: 'open',
    classes: ['chat-dock', 'chat-dock--left'],
    dockSlotSize: '0px',
    chatDockWidth: '400px',
  },
  {
    placement: 'left',
    state: 'collapsed',
    classes: ['chat-dock', 'chat-dock--left', 'is-collapsed'],
    dockSlotSize: '0px',
    chatDockWidth: '400px',
  },
  {
    placement: 'left',
    state: 'maximized',
    classes: ['chat-dock', 'chat-dock--left', 'is-maximized'],
    dockSlotSize: '0px',
    chatDockWidth: '400px',
  },
  {
    placement: 'right',
    state: 'open',
    classes: ['chat-dock', 'chat-dock--right'],
    dockSlotSize: '0px',
    chatDockWidth: '400px',
  },
  {
    placement: 'right',
    state: 'collapsed',
    classes: ['chat-dock', 'chat-dock--right', 'is-collapsed'],
    dockSlotSize: '0px',
    chatDockWidth: '400px',
  },
  {
    placement: 'right',
    state: 'maximized',
    classes: ['chat-dock', 'chat-dock--right', 'is-maximized'],
    dockSlotSize: '0px',
    chatDockWidth: '400px',
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
  name: '--dock-slot-size' | '--chat-dock-width' | `--region-${DockMode}-size`,
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
      await waitFor(() =>
        expect(shells()[0]?.dataset.region).toBe(destination),
      );
      expect(shells()).toHaveLength(1);
      // The same node moved: the shell is keyed by occupant (RegionShells.tsx),
      // so a move re-props the pane instead of remounting it.
      expect(shells()[0]).toBe(shell);
      expect(document.querySelectorAll('#chat-dock')).toHaveLength(1);
      expect(shells()[0]?.classList.contains(`chat-dock--${destination}`)).toBe(
        true,
      );
      // The re-propped instance republishes clearance for its new region.
      await waitFor(() => expect(clearance('--dock-slot-size')).toBe('0px'));
      expect(clearance('--chat-dock-width')).toBe('400px');
      // Per-region clearance follows the shell: the vacated region's
      // variable is withdrawn, the destination's is written.
      expect(clearance(`--region-${destination}-size`)).toBe('400px');
      expect(clearance(`--region-${placement}-size`)).toBe('');
    },
  );

  test('an empty region renders no section at all', async () => {
    seedPlacement('right', 'open');
    await renderShellsSettled();
    expect(document.querySelector('[data-region="bottom"]')).toBeNull();
    expect(document.querySelector('[data-region="left"]')).toBeNull();
    expect(
      document.querySelectorAll('section[aria-label="Dock"]'),
    ).toHaveLength(1);
  });

  test('an occupant without a registered shell renders nothing', async () => {
    seedPlacement('bottom', 'open');
    await renderShellsSettled();

    act(() =>
      currentRegionModel().setRegion('right', {
        occupant: 'fixture',
        visible: true,
      }),
    );

    expect(document.querySelector('[data-region="right"]')).toBeNull();
    expect(shells()).toHaveLength(1);
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
    async ({ placement, state, classes, dockSlotSize, chatDockWidth }) => {
      seedPlacement(placement, state);
      const shell = await renderShellsSettled();
      await waitFor(() => expect(classTokens(shell)).toEqual([...classes]));
      await waitFor(() =>
        expect(clearance('--dock-slot-size')).toBe(dockSlotSize),
      );
      expect(clearance('--chat-dock-width')).toBe(chatDockWidth);
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
    async ({ placement, state, dockSlotSize, chatDockWidth }) => {
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
              : chatDockWidth,
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
          <AmbientChatDockPaneHost renderChatPane={() => <p>Chat pane</p>} />
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
        chatDockWidth: clearance('--chat-dock-width'),
      };
      cleanup();

      seedPlacement(placement, state);
      const shell = await renderShellsSettled();
      await waitFor(() => expect(classTokens(shell)).toEqual(expected.classes));
      await waitFor(() =>
        expect(clearance('--dock-slot-size')).toBe(expected.dockSlotSize),
      );
      expect(shell.id).toBe(expected.id);
      expect(clearance('--chat-dock-width')).toBe(expected.chatDockWidth);
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

  test('the default Bottom swap relocates Chat and mirrors its new region', async () => {
    seedPlacement('bottom', 'open');
    const chatShell = await renderShellsSettled();
    const dockModeWrite = vi.spyOn(navigationStore, 'setDockMode');

    // #1536 F: the per-region swap button folded into the one Layout menu.
    fireEvent.click(screen.getByRole('button', { name: 'Layout regions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Swap in Activity' }));

    await waitFor(() =>
      expect(currentRegionModel().regions.bottom.occupant).toBe('activity'),
    );
    expect(currentRegionModel().regions.right).toMatchObject({
      occupant: 'chat',
      visible: true,
    });
    await waitFor(() =>
      expect(
        document.querySelector('section[aria-label="Activity"]'),
      ).not.toBeNull(),
    );
    await waitFor(() =>
      expect(document.querySelector('#chat-dock')).not.toBeNull(),
    );
    expect(chatShell.isConnected).toBe(true);
    expect(chatShell.dataset.region).toBe('right');
    await waitFor(() =>
      expect(navigationStore.getSnapshot().dockMode).toBe('right'),
    );
    expect(dockModeWrite).toHaveBeenCalledWith('right');
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
    expect(
      within(activityShell).queryByLabelText('Expand dock region to workspace'),
    ).toBeNull();
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
    // #1536 F: the per-region swap button folded into the one Layout menu.
    fireEvent.click(screen.getByRole('button', { name: 'Layout regions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Swap in Activity' }));
    await waitFor(() => expect(chatShell?.dataset.region).toBe('right'));
    expect(activityShell?.dataset.region).toBe('bottom');
    expect(currentRegionModel().regions.right.visible).toBe(true);
    expect(currentRegionModel().regions.bottom.visible).toBe(true);
    await waitFor(() =>
      expect(navigationStore.getSnapshot().dockMode).toBe('right'),
    );
    expect(dockModeWrite).toHaveBeenCalledTimes(1);
    await act(async () => Promise.resolve());
    expect(dockModeWrite).toHaveBeenCalledTimes(1);
    expect(deviceSettingsStore.get('chatDockWidth')).toBe(600);
    expect(currentRegionModel().regions.right.size).toBe(600);
    expect(shells()).toHaveLength(2);
    expect(document.querySelector('#chat-dock')).toBe(chatShell);
    expect(document.querySelector('section[aria-label="Activity"]')).toBe(
      activityShell,
    );
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

    act(() => currentRegionModel().placeSurface('activity', 'right'));
    await waitFor(() => expect(shells()).toHaveLength(1));
    expect(
      document.querySelector('section[aria-label="Activity"]'),
    ).not.toBeNull();
    expect(document.querySelectorAll('#chat-dock')).toHaveLength(0);
    // #917: at this width the toolbar renders no region control at all, so the
    // `⋯` menu below is the only route. Asserted here so a regression that
    // brings the fieldset back cannot hide behind the commands still working.
    expect(document.querySelector('.app-toolbar__regions')).toBeNull();
    selectRegionCommand('Show Chat');
    await waitFor(() =>
      expect(document.querySelectorAll('#chat-dock')).toHaveLength(1),
    );
    expect(shells()).toHaveLength(1);
    selectRegionCommand('Show Activity');
    await waitFor(() =>
      expect(
        document.querySelector('section[aria-label="Activity"]'),
      ).not.toBeNull(),
    );
    expect(shells()).toHaveLength(1);
    selectRegionCommand('Hide Activity');
    await waitFor(() =>
      expect(
        document.querySelector('section[aria-label="Activity"]'),
      ).toBeNull(),
    );
    selectRegionCommand('Show Activity');
    await waitFor(() =>
      expect(
        document.querySelector('section[aria-label="Activity"]'),
      ).not.toBeNull(),
    );
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

    selectRegionCommand('Show Activity');

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
