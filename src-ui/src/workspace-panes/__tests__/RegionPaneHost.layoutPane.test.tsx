/** @vitest-environment jsdom */

/**
 * #2157 through the shipped path: `openSurfaceInRegion('board:<id>')` and
 * `openLayoutInRegion` from `main`, the region host on the right rendering
 * the pane as a tab whose title is the Layout's NAME once the SDK's list
 * resolves, a second Board joining as a second tab with its own document
 * entry, the arrangement surviving a reload, and a project Layout mounting
 * with its project bound through the id while the dock itself has no
 * project. Harness as `RegionPaneHost.openInRegion.test.tsx`: `RegionShells`
 * → `RegionPaneHost` → `DockShell` + `RegionChromeBar` → `dock`
 * `WorkspacePaneHost`, real model, navigation and device stores; the SDK's
 * list queries are stubbed with a fixture, and the Layout renderer's own
 * chunk is replaced by a probe that reports the instance it was handed.
 */

import {
  act,
  cleanup,
  render,
  screen,
  waitFor as waitForDefault,
  within,
} from '@testing-library/react';
import { useEffect, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RegionShells } from '../../app-shell/RegionShells';
import { KeyboardShortcutsProvider } from '../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';
import {
  RegionModelProvider,
  useRegionModel,
} from '../../contexts/RegionModelContext';
import { openLayoutInRegion } from '../../contexts/useOpenInRegion';
import { deviceSettingsStore } from '../../lib/device-settings-store';

const LAYOUT = '1d61ce22-7f4b-4282-86f0-019ef1bc223c';
const OTHER = '2e72df33-8a5c-4393-97a1-12af02cd334d';
const PROJECT = 'f2e27d8e-dd81-4fe3-9d6e-9de369389b01';
const BOARD_ID = `board:${LAYOUT}`;
const OTHER_BOARD_ID = `board:${OTHER}`;
const LAYOUT_ID = `layout:${PROJECT}/${LAYOUT}`;

const sdk = vi.hoisted(() => ({
  boards: [] as { id: string; slug: string; name: string }[],
  projects: [] as { id: string; slug: string; name: string }[],
  layouts: [] as { id: string; slug: string; name: string }[],
  // Bumped to make every mocked list query re-render its readers — the
  // stand-in for React Query's own invalidation.
  version: 0,
  listeners: new Set<() => void>(),
}));
/** The mocked list hooks subscribe here so a fixture change re-renders them. */
function useSdkVersion() {
  return useSyncExternalStore(
    (listener) => {
      sdk.listeners.add(listener);
      return () => sdk.listeners.delete(listener);
    },
    () => sdk.version,
  );
}
function setBoards(boards: { id: string; slug: string; name: string }[]) {
  sdk.boards = boards;
  sdk.version += 1;
  for (const listener of sdk.listeners) listener();
}
// Partial: the registry chunk the region host lazily loads reaches the rest
// of the SDK, so only the three list queries the title resolver reads are
// replaced.
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  usePersonalLayoutsQuery: () => {
    useSdkVersion();
    return { data: sdk.boards, isLoading: false, isError: false };
  },
  useProjectsQuery: () => ({
    data: sdk.projects,
    isLoading: false,
    isError: false,
  }),
  useProjectLayoutsQuery: (slug: string, config?: { enabled?: boolean }) => ({
    data:
      config?.enabled === false || slug !== 'alpha' ? undefined : sdk.layouts,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('../../views/SessionsView', () => ({
  SessionsView: () => <div data-testid="sessions-view" />,
}));
vi.mock('../../components/chat-dock/ChatDock', () => ({
  ChatDock: () => null,
  renderAmbientChatPane: () => (
    <p data-testid="ambient-chat-occupant">Chat pane</p>
  ),
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
}));
// The dock has NO project: `useProject` answers nothing for every slug.
vi.mock('../../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: [],
    isLoading: false,
    isConfirmedLoaded: true,
  }),
  useProject: () => ({ project: undefined, isLoading: false }),
}));
// The renderer's chunk: a probe reporting the instance it was given, so
// every assertion about binding reads the host's real derivation.
vi.mock('../LayoutWorkspacePane', () => ({
  LayoutWorkspacePane: ({
    instance,
  }: {
    instance: { instanceId: string; boundContext?: { projectId?: string } };
  }) => (
    <div
      data-testid="layout-pane"
      data-instance={String(instance.instanceId)}
      data-project={instance.boundContext?.projectId ?? ''}
    />
  ),
}));

const DEVICE_SETTINGS_KEY = 'station-device-settings-v1';
let model: ReturnType<typeof useRegionModel> | null = null;

function Probe() {
  const value = useRegionModel();
  useEffect(() => {
    model = value;
  }, [value]);
  return <main data-testid="main-outlet" />;
}

function current() {
  if (!model) throw new Error('probe never rendered');
  return model;
}

function renderShells() {
  return render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <Probe />
          <RegionShells />
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
}

function shell(region: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `.chat-dock[data-region="${region}"]`,
  );
  if (!element) throw new Error(`no ${region} shell rendered`);
  return element;
}

function tabs(region: string): [string, string | null][] {
  return within(shell(region))
    .getAllByRole('tab')
    .map((tab) => [tab.textContent ?? '', tab.getAttribute('aria-selected')]);
}

function storedRightDocument(): { instances: { instanceId: string }[] } | null {
  const raw = window.localStorage.getItem(
    'station:workspace-pane-host:v2:ambient:right',
  );
  return raw ? JSON.parse(raw) : null;
}

/** The persisted arrangement's right region, as a reload would read it. */
function recordedRight(): { panes?: { id: string }[] } | undefined {
  return (
    deviceSettingsStore.get('regionArrangement') as {
      regions?: { right?: { occupant?: { panes?: { id: string }[] } } };
    }
  ).regions?.right?.occupant;
}

async function settle() {
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

/**
 * Loading the real SDK behind the partial mock (the registry chunk reaches
 * it) is slower than testing-library's 1s default on a loaded host.
 */
const WAIT = { timeout: 8000 } as const;
const waitFor: typeof waitForDefault = (callback, options) =>
  waitForDefault(callback, { ...WAIT, ...options });

beforeEach(() => {
  model = null;
  sdk.boards = [
    { id: LAYOUT, slug: 'my-board', name: 'My Board' },
    { id: OTHER, slug: 'second', name: 'Second Board' },
  ];
  sdk.projects = [{ id: PROJECT, slug: 'alpha', name: 'Alpha' }];
  sdk.layouts = [{ id: LAYOUT, slug: 'notes', name: 'Alpha Notes' }];
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
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
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
 * A1 + A2. Reverting the `board:` prefix entry in `INSTANCE_SURFACE_PREFIXES`
 * fails the first outcome (`no-surface`); reverting the host's
 * `LayoutPaneTitles` merge fails the title assertion (the tab reads
 * "Board", the prefix fallback); reverting the second open to a reveal of
 * the first fails the two-tab assertion.
 */
test('a Board opens on the right titled by its name, a second Board joins as its own tab, and a reload keeps both', async () => {
  const first = renderShells();
  await waitFor(() => expect(model).not.toBeNull());
  act(() => current().placeSurface('chat', 'right'));
  await waitFor(() =>
    expect(
      document.querySelector<HTMLElement>('#chat-dock')?.dataset.region,
    ).toBe('right'),
  );

  let outcome: unknown;
  act(() => {
    outcome = current().openSurfaceInRegion(BOARD_ID, { region: 'right' });
  });
  await settle();
  expect(outcome).toEqual({
    ok: true,
    region: 'right',
    surfaceId: BOARD_ID,
    existing: false,
  });
  const pane = await screen.findByTestId('layout-pane', undefined, WAIT);
  expect(pane.dataset.instance).toBe(BOARD_ID);
  expect(pane.dataset.project).toBe('');
  expect(pane.closest('.chat-dock')).toBe(shell('right'));
  // The title resolves from the personal list, not the prefix fallback.
  await waitFor(() =>
    expect(tabs('right')).toEqual([
      ['Chat', 'false'],
      ['My Board', 'true'],
    ]),
  );

  act(() => {
    outcome = current().openSurfaceInRegion(OTHER_BOARD_ID, {
      region: 'right',
    });
  });
  await settle();
  expect(outcome).toEqual({
    ok: true,
    region: 'right',
    surfaceId: OTHER_BOARD_ID,
    existing: false,
  });
  await waitFor(() =>
    expect(tabs('right')).toEqual([
      ['Chat', 'false'],
      ['My Board', 'false'],
      ['Second Board', 'true'],
    ]),
  );
  expect(screen.getByTestId('layout-pane').dataset.instance).toBe(
    OTHER_BOARD_ID,
  );
  // Two distinct documents entries, one per Board.
  await waitFor(() =>
    expect(
      storedRightDocument()?.instances.map((entry) => entry.instanceId),
    ).toEqual(['workspace-chat', BOARD_ID, OTHER_BOARD_ID]),
  );

  // The record is written asynchronously; a reload reads what was written.
  await waitFor(() =>
    expect(recordedRight()?.panes?.map((entry) => entry.id)).toEqual([
      'chat',
      BOARD_ID,
      OTHER_BOARD_ID,
    ]),
  );

  // Reload: the arrangement record round-trips both ids.
  first.unmount();
  model = null;
  deviceSettingsStore.reloadFromStorage();
  renderShells();
  await waitFor(() => expect(model).not.toBeNull());
  await settle();
  expect(current().regions.right.panes).toEqual([
    'chat',
    BOARD_ID,
    OTHER_BOARD_ID,
  ]);
  await waitFor(() =>
    expect(tabs('right')).toEqual([
      ['Chat', 'false'],
      ['My Board', 'false'],
      ['Second Board', 'true'],
    ]),
  );
  expect(screen.getByTestId('layout-pane').dataset.instance).toBe(
    OTHER_BOARD_ID,
  );
});

/**
 * A3. The dock has no project (`useProject` answers nothing), which is the
 * case that renders "Choose a project for this dock" for a coding pane —
 * and here the pane MOUNTS, bound to the project its id names. Reverting
 * `layoutSurfacePane` to bind the dock's `projectId` fails the mount (no
 * occurrence with a null project); reverting the occurrence to bind none
 * fails the `data-project` assertion.
 */
test("a project Layout mounts with its project bound through the id while the dock has none, titled by the Layout's name", async () => {
  renderShells();
  await waitFor(() => expect(model).not.toBeNull());
  // Chat first, so the region has a tab strip to read the title from (a
  // region holding one pane shows none).
  act(() => current().placeSurface('chat', 'right'));
  await waitFor(() =>
    expect(
      document.querySelector<HTMLElement>('#chat-dock')?.dataset.region,
    ).toBe('right'),
  );

  let outcome: unknown;
  act(() => {
    outcome = openLayoutInRegion(
      current(),
      { kind: 'project', projectId: PROJECT, layoutId: LAYOUT },
      { region: 'right' },
    );
  });
  await settle();
  expect(outcome).toEqual({
    ok: true,
    region: 'right',
    surfaceId: LAYOUT_ID,
    existing: false,
  });
  const pane = await screen.findByTestId('layout-pane', undefined, WAIT);
  expect(pane.dataset.instance).toBe(LAYOUT_ID);
  expect(pane.dataset.project).toBe(PROJECT);
  expect(
    within(shell('right')).queryByText('Choose a project for this dock'),
  ).toBeNull();
  await waitFor(() =>
    expect(within(shell('right')).getByRole('tab', { name: 'Alpha Notes' })),
  );

  // A second open of the same Layout is a reveal.
  act(() => {
    outcome = openLayoutInRegion(current(), {
      kind: 'project',
      projectId: PROJECT,
      layoutId: LAYOUT,
    });
  });
  expect(outcome).toEqual({
    ok: true,
    region: 'right',
    surfaceId: LAYOUT_ID,
    existing: true,
  });
  // An id the grammar cannot mint is refused before the model is asked.
  expect(
    openLayoutInRegion(current(), { kind: 'board', layoutId: 'coding' }),
  ).toEqual({ ok: false, reason: 'no-surface' });
});

/**
 * Review M2(a): the title map is MERGED per reporter, and a merge that only
 * adds never forgets. When the personal list stops carrying a Board after
 * its tab resolved (promoted into a project, deleted elsewhere), the tab
 * must fall back to the prefix title rather than keep a name for a record
 * that is gone. Reverting the `next.delete(id)` loop in `mergeLayoutTitles`
 * reds the second assertion.
 */
test('a Board dropped from the list after its tab resolved reverts to the prefix title', async () => {
  renderShells();
  await waitFor(() => expect(model).not.toBeNull());
  act(() => current().placeSurface('chat', 'right'));
  await waitFor(() =>
    expect(
      document.querySelector<HTMLElement>('#chat-dock')?.dataset.region,
    ).toBe('right'),
  );
  act(() => {
    current().openSurfaceInRegion(BOARD_ID, { region: 'right' });
  });
  await settle();
  await waitFor(() =>
    expect(within(shell('right')).getByRole('tab', { name: 'My Board' })),
  );

  act(() => setBoards(sdk.boards.filter((board) => board.id !== LAYOUT)));
  await waitFor(() =>
    expect(tabs('right')).toEqual([
      ['Chat', 'false'],
      ['Board', 'true'],
    ]),
  );
  // The tab itself stays: closing it is the user's act.
  expect(current().regions.right.panes).toEqual(['chat', BOARD_ID]);
});

/**
 * Review M2(c): the title reporter is mounted by EVERY region host, not the
 * right one. Gating `<LayoutPaneTitles>` on `regionId === 'right'` reds this.
 */
test('a Board docked in bottom is titled by its name too', async () => {
  renderShells();
  await waitFor(() => expect(model).not.toBeNull());
  act(() => current().placeSurface('chat', 'bottom'));
  await waitFor(() =>
    expect(
      document.querySelector<HTMLElement>('#chat-dock')?.dataset.region,
    ).toBe('bottom'),
  );
  act(() => {
    current().openSurfaceInRegion(OTHER_BOARD_ID, { region: 'bottom' });
  });
  await settle();
  await waitFor(() =>
    expect(tabs('bottom')).toEqual([
      ['Chat', 'false'],
      ['Second Board', 'true'],
    ]),
  );
  expect(screen.getByTestId('layout-pane').closest('.chat-dock')).toBe(
    shell('bottom'),
  );
});
