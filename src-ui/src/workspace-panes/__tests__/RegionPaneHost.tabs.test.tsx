/** @vitest-environment jsdom */

/**
 * #2046 2b: a dock region renders a tab strip of its panes above the selected
 * pane, and the strip writes the REGION MODEL — select, close, reorder — so
 * the arrangement stays the one authority and the record carries it. Driven
 * through the shipped path — `RegionShells` → `RegionPaneHost` →
 * `DockShell` + `RegionChromeBar` → `dock` `WorkspacePaneHost` — against the
 * real region model, navigation, device and shortcut stores, with only the
 * two pane renderers stubbed (Chat's would mount the whole chat stack;
 * Activity's the whole sessions surface). The Chat stub keeps the chrome it
 * is handed, so what the chrome tells a renderer about its region
 * (`regionPanes`, the mobile sheet's rows) is asserted from the real
 * derivation.
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
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RegionShells } from '../../app-shell/RegionShells';
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
import type { DockShellChrome } from '../../hooks/useDockShellChrome';
import { MOBILE_MEDIA_QUERY } from '../../hooks/useIsMobile';
import { deviceSettingsStore } from '../../lib/device-settings-store';

vi.mock('../../views/SessionsView', () => ({
  SessionsView: () => <div data-testid="sessions-view" />,
}));
/** The chrome Chat's pane was last handed: the region's panes as it sees them. */
const chatProbe = vi.hoisted(() => ({
  chrome: null as DockShellChrome | null,
}));
vi.mock('../../components/chat-dock/ChatDock', () => ({
  // The model-less mount; never taken under `RegionModelProvider`.
  ChatDock: () => null,
  renderAmbientChatPane: (
    _instance: unknown,
    _auth: unknown,
    chrome: DockShellChrome,
  ) => {
    chatProbe.chrome = chrome;
    return <p data-testid="ambient-chat-occupant">Chat pane</p>;
  },
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

const STORAGE_PREFIX = 'station:workspace-pane-host:v2:ambient:';
const BOTTOM_KEY = `${STORAGE_PREFIX}bottom`;
const RIGHT_KEY = `${STORAGE_PREFIX}right`;
const DEVICE_SETTINGS_KEY = 'station-device-settings-v1';

let model: ReturnType<typeof useRegionModel> | null = null;
let shortcutRegistry: ReturnType<typeof useShortcutRegistry> | null = null;

function Probe() {
  const value = useRegionModel();
  const registry = useShortcutRegistry();
  useEffect(() => {
    model = value;
    shortcutRegistry = registry;
  }, [value, registry]);
  return null;
}

function currentModel(): ReturnType<typeof useRegionModel> {
  if (!model) throw new Error('region model probe never rendered');
  return model;
}

function shortcut(id: string) {
  const entry = (shortcutRegistry?.getAllShortcuts() ?? []).find(
    (candidate) => candidate.id === id,
  );
  if (!entry) throw new Error(`${id} is not registered`);
  return entry;
}

function installMatchMedia(mobile: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: mobile && query === MOBILE_MEDIA_QUERY,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  model = null;
  shortcutRegistry = null;
  chatProbe.chrome = null;
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
  window.localStorage.clear();
  window.localStorage.removeItem(DEVICE_SETTINGS_KEY);
  deviceSettingsStore.reloadFromStorage();
  window.history.replaceState({}, '', '/?dock=open');
  navigationStore.navigate('/', {
    dock: 'open',
    maximize: null,
    dockSlotPlacement: null,
  });
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1024,
  });
  installMatchMedia(false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  navigationStore.navigate('/', {
    dock: null,
    maximize: null,
    dockSlotPlacement: null,
  });
  delete (globalThis.navigator as { locks?: unknown }).locks;
});

/**
 * Mounts the shells and lets the host's lazy chunk land before any
 * assertion waits on it. `RegionShells` reaches `RegionPaneHost` through
 * `React.lazy`, and on a cold vitest worker that first `import()` can outrun
 * `waitFor`'s one-second default (seen on a CI runner: the toolbar rendered,
 * no `.chat-dock` at all); settling the import first makes the wait about
 * the mount, not the chunk.
 */
async function mountShells() {
  const rendered = renderShells();
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  return rendered;
}

function renderShells() {
  return render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <Probe />
          <RegionToolbarControls />
          <RegionShells />
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
}

function shell(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.chat-dock');
  if (!element) throw new Error('no shell rendered');
  return element;
}

function tabs(): [string, string | null][] {
  return within(shell())
    .getAllByRole('tab')
    .map((tab) => [tab.textContent ?? '', tab.getAttribute('aria-selected')]);
}

function storedDocument(key: string): {
  instances: { descriptorId: string }[];
  activeInstanceId?: string;
} | null {
  const raw = window.localStorage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

function recordedBottom(): unknown {
  return (
    deviceSettingsStore.get('regionArrangement') as {
      regions?: { bottom?: { occupant?: unknown } };
    }
  ).regions?.bottom?.occupant;
}

/** Chat in `bottom`, Activity joined and selected: the two-pane region. */
async function renderJoined() {
  const rendered = await mountShells();
  await waitFor(() => expect(model).not.toBeNull());
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );
  act(() => currentModel().placeSurface('activity', 'bottom'));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  await screen.findByTestId('sessions-view');
  return rendered;
}

/**
 * Reverting the region bar (a chromeless host, no strip) fails the tablist
 * assertion; reverting the active-only panel fails the "Chat's occupant is
 * not mounted" one; reverting D3 (the shell labelled by the selected pane)
 * fails the `#chat-dock` and "Dock" assertions while Activity shows.
 */
test('a region holding Chat and Activity renders two tabs above the selected pane', async () => {
  await renderJoined();

  expect(document.querySelectorAll('.chat-dock')).toHaveLength(1);
  const strip = within(shell()).getByRole('tablist', { name: 'Region panes' });
  expect(tabs()).toEqual([
    ['Chat', 'false'],
    ['Activity', 'true'],
  ]);
  // The selected pane is the strip's panel, labelled by its tab.
  const activityTab = within(strip).getByRole('tab', { name: 'Activity' });
  const panel = document.getElementById(
    activityTab.getAttribute('aria-controls') ?? '',
  );
  expect(panel?.getAttribute('role')).toBe('tabpanel');
  expect(panel?.getAttribute('aria-labelledby')).toBe(activityTab.id);
  expect(
    within(panel as HTMLElement).queryByTestId('sessions-view'),
  ).not.toBeNull();
  // Active-only: the pane behind the tab is not mounted.
  expect(screen.queryByTestId('ambient-chat-occupant')).toBeNull();
  // One bar, the region's: the strip sits between the placement grab and
  // the region controls, and no second `.chat-dock__header` renders.
  expect(shell().querySelectorAll('.chat-dock__header')).toHaveLength(1);
  expect(within(shell()).getByLabelText('Move the dock')).toBeTruthy();
  expect(within(shell()).getByLabelText('Hide Activity')).toBeTruthy();
  // D3: the shell is Chat's while Chat is behind Activity's tab.
  expect(shell().id).toBe('chat-dock');
  expect(shell().getAttribute('aria-label')).toBe('Dock');
});

/**
 * Reverting the strip's `selectPane` write (a tab click that reaches only the
 * host controller) fails the model assertion after the click; reverting the
 * record's `selected` fails the reload.
 */
test('a tab click writes the selection through the model and it persists across reload', async () => {
  const first = await renderJoined();

  fireEvent.click(within(shell()).getByRole('tab', { name: 'Chat' }));

  await waitFor(() =>
    expect(currentModel().regions.bottom.occupant).toBe('chat'),
  );
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );
  expect(screen.queryByTestId('sessions-view')).toBeNull();
  expect(tabs()).toEqual([
    ['Chat', 'true'],
    ['Activity', 'false'],
  ]);
  await waitFor(() =>
    expect(storedDocument(BOTTOM_KEY)?.activeInstanceId).toBe('workspace-chat'),
  );
  await waitFor(() =>
    expect(recordedBottom()).toEqual({
      kind: 'pane-host',
      panes: [
        { kind: 'surface', id: 'chat' },
        { kind: 'surface', id: 'activity' },
      ],
      selected: 'chat',
    }),
  );

  first.unmount();
  model = null;
  deviceSettingsStore.reloadFromStorage();
  await mountShells();
  await waitFor(() => expect(model).not.toBeNull());
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );
  expect(tabs()).toEqual([
    ['Chat', 'true'],
    ['Activity', 'false'],
  ]);
});

/**
 * Close unplaces (`removePane`): Activity leaves `bottom` and is in NO
 * region — not hidden in place — so the strip goes with the second tab, the
 * record writes the one-pane `surface` form, and the surface's chord shows
 * it afresh. Reverting close to a hide fails the `occupiedRegion` assertion;
 * reverting to the host controller's own close fails the model one.
 */
test('closing a tab unplaces its surface; the region keeps its other pane', async () => {
  await renderJoined();

  fireEvent.click(within(shell()).getByLabelText('Close Activity'));

  await waitFor(() =>
    expect(currentModel().regions.bottom).toMatchObject({
      panes: ['chat'],
      occupant: 'chat',
      visible: true,
    }),
  );
  expect(currentModel().regions.right.panes).toEqual([]);
  expect(currentModel().regions.main.occupant).toBe('home');
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );
  expect(screen.queryByTestId('sessions-view')).toBeNull();
  // One pane: no strip.
  expect(within(shell()).queryByRole('tablist')).toBeNull();
  await waitFor(() =>
    expect(
      storedDocument(BOTTOM_KEY)?.instances.map((i) => i.descriptorId),
    ).toEqual(['pane:builtin:chat']),
  );
  await waitFor(() =>
    expect(recordedBottom()).toEqual({ kind: 'surface', id: 'chat' }),
  );

  // The way back: the chord shows an unplaced surface where it belongs.
  act(() => shortcut('activity.toggle').handler());
  await waitFor(() =>
    expect(currentModel().regions.right).toMatchObject({
      panes: ['activity'],
      occupant: 'activity',
      visible: true,
    }),
  );
});

/**
 * Closing Chat's tab is the one close with a navigation mirror: Chat leaves
 * a showing region, so the mirror reads the dock as closed (`dock` param
 * cleared), and a `focusSession`-style `setDockState(true)` — a change
 * against that closed mirror — places Chat again rather than being a no-op.
 * Reverting the mirror's unplaced case fails the `dock` assertion; reverting
 * the sync's guard makes Chat come back HIDDEN on the very next navigation
 * change instead of on an explicit open.
 */
test('closing Chat’s tab closes the dock mirror, and an explicit open brings Chat back', async () => {
  await renderJoined();

  fireEvent.click(within(shell()).getByLabelText('Close Chat'));

  await waitFor(() =>
    expect(currentModel().regions.bottom).toMatchObject({
      panes: ['activity'],
      occupant: 'activity',
      visible: true,
    }),
  );
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get('dock')).toBeNull(),
  );
  // Still one shell — Activity's region — and it is no longer Chat's.
  expect(document.querySelectorAll('.chat-dock')).toHaveLength(1);
  expect(document.querySelector('#chat-dock')).toBeNull();
  expect(shell().getAttribute('aria-label')).toBe('Activity');
  // A navigation change that does not open the dock leaves Chat unplaced.
  act(() => navigationStore.navigate('/settings'));
  await act(async () => Promise.resolve());
  expect(
    ['left', 'right', 'bottom'].some((id) =>
      currentModel().regions[id as 'left'].panes.includes('chat'),
    ),
  ).toBe(false);

  act(() => navigationStore.setDockState(true, false));
  await waitFor(() =>
    expect(currentModel().regions.right).toMatchObject({
      panes: ['chat'],
      occupant: 'chat',
      visible: true,
    }),
  );
  await waitFor(() =>
    expect(
      document.querySelector<HTMLElement>('#chat-dock')?.dataset.region,
    ).toBe('right'),
  );
});

/**
 * A reorder writes `panes` (Alt+Right on the focused tab): the strip, the
 * record and the derived document all follow, and the order survives a
 * reload. Reverting the write fails the model assertion; reverting the
 * record's order fails the reload.
 */
test('reordering tabs writes the pane order and it persists across reload', async () => {
  const first = await renderJoined();

  fireEvent.keyDown(within(shell()).getByRole('tab', { name: 'Chat' }), {
    key: 'ArrowRight',
    altKey: true,
  });

  await waitFor(() =>
    expect(currentModel().regions.bottom).toMatchObject({
      panes: ['activity', 'chat'],
      occupant: 'activity',
    }),
  );
  expect(tabs()).toEqual([
    ['Activity', 'true'],
    ['Chat', 'false'],
  ]);
  await waitFor(() =>
    expect(
      storedDocument(BOTTOM_KEY)?.instances.map((i) => i.descriptorId),
    ).toEqual(['pane:builtin:activity', 'pane:builtin:chat']),
  );
  await waitFor(() =>
    expect(recordedBottom()).toMatchObject({
      panes: [
        { kind: 'surface', id: 'activity' },
        { kind: 'surface', id: 'chat' },
      ],
    }),
  );

  first.unmount();
  model = null;
  deviceSettingsStore.reloadFromStorage();
  await mountShells();
  await waitFor(() => expect(model).not.toBeNull());
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  await screen.findByTestId('sessions-view');
  expect(currentModel().regions.bottom.panes).toEqual(['activity', 'chat']);
  expect(tabs()).toEqual([
    ['Activity', 'true'],
    ['Chat', 'false'],
  ]);
});

/**
 * 2a review (HIGH): the host's follow of the arrangement used to go through
 * the controller's navigation-writing select, so ONE placement pushed two
 * `?pane=` history entries and a popstate re-pushed a third — Back was
 * trapped. A dock host's selection is the model's, not a navigation fact:
 * nothing here pushes history, `?pane=` is never written, and a popstate
 * that changes `?pane=` moves neither the model nor the shown pane.
 * Reverting `navigationSelection={false}` fails the push count after the
 * join (two entries) and the popstate assertions (the model's `occupant`
 * flips to Chat and a push follows).
 */
test('selection writes no history: a mount, a join, a tab click and a ?pane= popstate leave no entry', async () => {
  const pushes = vi.spyOn(window.history, 'pushState');
  const paneParam = () =>
    new URLSearchParams(window.location.search).get('pane');

  await mountShells();
  await waitFor(() => expect(model).not.toBeNull());
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );
  await waitFor(() => expect(storedDocument(BOTTOM_KEY)).not.toBeNull());
  // A mount whose document agrees with the arrangement writes nothing.
  expect(pushes).not.toHaveBeenCalled();
  expect(paneParam()).toBeNull();

  act(() => currentModel().placeSurface('activity', 'bottom'));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  await screen.findByTestId('sessions-view');
  expect(pushes).not.toHaveBeenCalled();
  expect(paneParam()).toBeNull();

  fireEvent.click(within(shell()).getByRole('tab', { name: 'Chat' }));
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );
  expect(pushes).not.toHaveBeenCalled();
  expect(paneParam()).toBeNull();

  // Back/Forward landing on a URL that names a pane of this host's scope:
  // the model, not the URL, says which tab shows.
  act(() => {
    window.history.replaceState(
      {},
      '',
      `/?dock=open&pane=workspace-activity&paneScope=${encodeURIComponent(JSON.stringify(['ambient']))}`,
    );
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await act(async () => Promise.resolve());
  expect(currentModel().regions.bottom.occupant).toBe('chat');
  expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
  expect(screen.queryByTestId('sessions-view')).toBeNull();
  expect(pushes).not.toHaveBeenCalled();
  expect(paneParam()).toBe('workspace-activity');
});

/** ⌘D with Chat behind Activity's tab selects Chat's tab (2a's toggle, seen in the strip). */
test('⌘D with Chat behind Activity’s tab selects Chat’s tab', async () => {
  await renderJoined();
  expect(tabs()).toEqual([
    ['Chat', 'false'],
    ['Activity', 'true'],
  ]);

  act(() => shortcut('dock.toggle').handler());

  await waitFor(() =>
    expect(tabs()).toEqual([
      ['Chat', 'true'],
      ['Activity', 'false'],
    ]),
  );
  expect(currentModel().regions.bottom.visible).toBe(true);
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );
});

/**
 * D3: `dock.maximize` belongs to the region that HOLDS Chat, whichever tab
 * shows. Reverting to "the shell showing Chat" leaves ⌘M unregistered while
 * Activity's tab is selected, and the handler lookup throws.
 */
test('⌘M maximizes the region while Chat is not the selected tab (D3)', async () => {
  await renderJoined();
  expect(currentModel().regions.bottom.occupant).toBe('activity');

  const maximize = shortcut('dock.maximize');
  act(() => maximize.handler());

  await waitFor(() =>
    expect(currentModel().regions.bottom.maximized).toBe(true),
  );
  await waitFor(() =>
    expect(shell().classList.contains('is-maximized')).toBe(true),
  );
  // The ⌘M hint is advertised on this shell's maximize control: it owns it.
  expect(
    within(shell()).getByLabelText('Restore dock region size').title,
  ).toContain('(');
  act(() => maximize.handler());
  await waitFor(() =>
    expect(currentModel().regions.bottom.maximized).toBe(false),
  );
  // The persisted snap key is Chat's too (`useDockShellChrome`'s own
  // derivation, not `DockShell`'s): hiding this shell while Chat is behind
  // Activity's tab writes it. Reverting `shellHoldsChat` to the selected
  // pane leaves the key unwritten.
  fireEvent.click(within(shell()).getByLabelText('Hide Activity'));
  await waitFor(() =>
    expect(window.localStorage.getItem('station.chatDock.snap')).toBe(
      'collapsed',
    ),
  );
  fireEvent.click(within(shell()).getByLabelText('Show Activity'));
  await waitFor(() =>
    expect(shell().classList.contains('is-collapsed')).toBe(false),
  );
});

/**
 * A close restores the region: closing Chat's tab under ⌘M would otherwise
 * leave `bottom` maximized with nothing registered to undo it, and the next
 * Chat reveal — placed into `right`, `bottom` being occupied — renders under
 * the maximized sibling, which index.css hides. Reverting the kept-panes
 * `maximized: false` fails the first assertion.
 */
test('closing a tab while the region is maximized restores it, and the next Chat reveal is visible', async () => {
  await renderJoined();
  act(() => shortcut('dock.maximize').handler());
  await waitFor(() =>
    expect(shell().classList.contains('is-maximized')).toBe(true),
  );

  fireEvent.click(within(shell()).getByLabelText('Close Chat'));
  await waitFor(() =>
    expect(currentModel().regions.bottom).toMatchObject({
      panes: ['activity'],
      maximized: false,
    }),
  );
  expect(shell().classList.contains('is-maximized')).toBe(false);

  act(() => navigationStore.setDockState(true, false));
  await waitFor(() =>
    expect(
      document.querySelector<HTMLElement>('#chat-dock')?.dataset.region,
    ).toBe('right'),
  );
  expect(document.querySelectorAll('.chat-dock.is-maximized')).toHaveLength(0);
  expect(currentModel().regions.right.visible).toBe(true);
});

/**
 * Closing a tab from the keyboard must not drop focus to `<body>`: the
 * button under focus unmounts (with two tabs, the whole strip does), so the
 * bar's first control takes it. Reverting the close handler's refocus fails
 * the `contains` assertion.
 */
test('closing a tab keeps keyboard focus in the region bar', async () => {
  await renderJoined();
  const close = within(shell()).getByLabelText('Close Activity');
  close.focus();
  expect(document.activeElement).toBe(close);
  fireEvent.click(close);
  await waitFor(() =>
    expect(currentModel().regions.bottom.panes).toEqual(['chat']),
  );
  await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  expect(shell().contains(document.activeElement)).toBe(true);
});

/**
 * A pointer close must not steal focus: a browser that does not focus a
 * clicked button (Safari) leaves focus where it was — Chat's composer, say
 * — and the refocus is only for the case where the unmounting button HELD
 * it. Reverting the `activeElement !== body` guard moves focus into the bar.
 */
test('closing a tab by pointer leaves focus where it was', async () => {
  await renderJoined();
  const outside = document.createElement('input');
  document.body.append(outside);
  outside.focus();
  expect(document.activeElement).toBe(outside);
  fireEvent.click(within(shell()).getByLabelText('Close Activity'));
  await waitFor(() =>
    expect(currentModel().regions.bottom.panes).toEqual(['chat']),
  );
  await act(async () => Promise.resolve());
  expect(document.activeElement).toBe(outside);
  outside.remove();
});

/**
 * A shell that BECOMES Chat's adopts Chat's persisted snap: Activity's
 * region seeds from the default at mount, and when Chat joins it the snap
 * it reports is the key's, not the default it started from. Reverting the
 * re-seed leaves `dockSnap` at 'half'.
 */
test('a region that gains Chat adopts Chat’s persisted snap', async () => {
  await renderJoined();
  fireEvent.click(within(shell()).getByLabelText('Close Chat'));
  await waitFor(() =>
    expect(currentModel().regions.bottom.panes).toEqual(['activity']),
  );
  expect(document.querySelector('#chat-dock')).toBeNull();
  window.localStorage.setItem('station.chatDock.snap', 'full');

  act(() => currentModel().placeSurface('chat', 'bottom'));
  await waitFor(() =>
    expect(currentModel().regions.bottom).toMatchObject({
      panes: ['activity', 'chat'],
      occupant: 'chat',
    }),
  );
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );
  expect(shell().id).toBe('chat-dock');
  await waitFor(() => expect(chatProbe.chrome?.dockSnap).toBe('full'));
});

/**
 * The region bar's placement moves the REGION: both panes, in order, with
 * the selection, into the chosen region; the source empties. Reverting
 * `commitDockPlacement` to a one-surface `placeSurface` leaves Chat behind
 * in `bottom` and fails the `bottom.panes` assertion.
 */
test('the region bar’s placement moves both panes to the chosen region', async () => {
  await renderJoined();

  fireEvent.click(
    within(shell()).getByRole('button', { name: 'Move the dock' }),
  );
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Right' }));

  await waitFor(() =>
    expect(currentModel().regions.right).toMatchObject({
      panes: ['chat', 'activity'],
      occupant: 'activity',
      visible: true,
    }),
  );
  // The grab relocated every pane; the emptied source hides (#2153: a move
  // is not a close, and a placeholder left behind would be a second dock).
  expect(currentModel().regions.bottom).toMatchObject({
    panes: [],
    occupant: null,
    visible: false,
  });
  await waitFor(() =>
    expect(
      document.querySelector<HTMLElement>('.chat-dock')?.dataset.region,
    ).toBe('right'),
  );
  // One shell: `right`, which took both panes. The emptied `bottom` hid,
  // so it mounts nothing (an empty region mounts a host only while visible).
  expect(document.querySelectorAll('.chat-dock')).toHaveLength(1);
  expect(document.querySelector('.chat-dock[data-region="bottom"]')).toBeNull();
  expect(tabs()).toEqual([
    ['Chat', 'false'],
    ['Activity', 'true'],
  ]);
  await waitFor(() =>
    expect(
      storedDocument(RIGHT_KEY)?.instances.map((i) => i.descriptorId),
    ).toEqual(['pane:builtin:chat', 'pane:builtin:activity']),
  );
  // Chat's mirror followed the region.
  expect(navigationStore.getSnapshot().dockMode).toBe('right');
});

/**
 * D1: a collapsed region is the bar alone — no strip — and the bar still
 * offers the region's controls; expanding brings the strip back.
 */
test('a collapsed region shows no tab strip', async () => {
  await renderJoined();

  fireEvent.click(within(shell()).getByLabelText('Hide Activity'));

  await waitFor(() =>
    expect(shell().classList.contains('is-collapsed')).toBe(true),
  );
  expect(within(shell()).queryByRole('tablist')).toBeNull();
  expect(within(shell()).getByLabelText('Show Activity')).toBeTruthy();
  expect(within(shell()).getByLabelText('Move the dock')).toBeTruthy();

  fireEvent.click(within(shell()).getByLabelText('Show Activity'));
  await waitFor(() =>
    expect(shell().classList.contains('is-collapsed')).toBe(false),
  );
  expect(within(shell()).getByRole('tablist')).toBeTruthy();
});

/**
 * A coarse device renders no strip. Chat's own mobile header is the bar
 * there, and its overflow sheet lists the region's other panes from the
 * chrome's `regionPanes` — asserted from the chrome Chat's renderer is
 * handed, since the sheet itself is inside the stubbed chat stack
 * (`ChatDockMobileHeader.test.tsx` pins the rows it renders from them).
 * Reverting `regionPanes` to the selected pane alone fails the second
 * assertion.
 */
test('a coarse device renders no strip, and the chrome lists both panes for the overflow sheet', async () => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 390,
  });
  installMatchMedia(true);
  await mountShells();
  await waitFor(() => expect(model).not.toBeNull());
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );
  act(() => currentModel().placeSurface('activity', 'bottom'));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  await screen.findByTestId('sessions-view');
  expect(within(shell()).queryByRole('tablist')).toBeNull();
  // The non-Chat pane's bar: the region controls, nothing else.
  expect(within(shell()).getByLabelText('Hide Activity')).toBeTruthy();

  act(() => currentModel().selectPane('bottom', 'chat'));
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );
  // Chat's turn: no region bar (its mobile header is the bar), and the
  // chrome names both panes with Chat selected.
  expect(shell().querySelector('.chat-dock__header')).toBeNull();
  expect(chatProbe.chrome?.regionPanes).toEqual([
    { id: 'chat', title: 'Chat', selected: true },
    { id: 'activity', title: 'Activity', selected: false },
  ]);
  act(() => chatProbe.chrome?.selectRegionPane('activity'));
  await waitFor(() =>
    expect(currentModel().regions.bottom.occupant).toBe('activity'),
  );
});
