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

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RegionShells } from '../../app-shell/RegionShells';
import { DockShell } from '../../components/chat-dock/DockShell';
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
import { DOCK_REGION_IDS } from '../../regions/region-model';
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

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <ShortcutProbe />
          <RegionModelProbe />
          <RegionToolbarControls />
          {children}
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>
  );
}

function renderShells() {
  return render(
    <Providers>
      <RegionShells
        homeContinuation={null}
        onNavigate={vi.fn()}
        onDockActionChange={vi.fn()}
      />
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
  });
});
