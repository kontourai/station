/** @vitest-environment jsdom */

/**
 * #2045: each dock region owns one pane-host document (`ambient:<region>`)
 * and the surfaces placed there are its panes. Driven through the shipped
 * path — `RegionShells` → `RegionPaneHost` → `DockShell` → chromeless
 * `WorkspacePaneHost` — against the real region model, navigation and
 * device stores, with only the two pane renderers stubbed (Chat's would
 * mount the whole chat stack; Activity's the whole sessions surface).
 *
 * Every assertion that names a storage key spells the literal out rather
 * than deriving it from the host's constants: the test's job is to notice
 * the constants moving.
 */

import { WORKSPACE_ACTIVITY_PANE_INSTANCE } from '@kontourai/station-contracts/workspace-activity-pane';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RegionShells } from '../../app-shell/RegionShells';
import { KeyboardShortcutsProvider } from '../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';
import {
  RegionModelProvider,
  useRegionModel,
} from '../../contexts/RegionModelContext';
import { deviceSettingsStore } from '../../lib/device-settings-store';

vi.mock('../../views/SessionsView', () => ({
  SessionsView: () => <div data-testid="sessions-view" />,
}));
/** The open action Chat's pane sees: the region host's own controller. */
const openProbe = vi.hoisted(() => ({
  action: null as
    | import('../WorkspacePaneHostOpenContext').WorkspacePaneHostOpenAction
    | null,
}));
vi.mock('../../components/chat-dock/ChatDock', async () => {
  const { useWorkspacePaneHostOpenAction } = await import(
    '../WorkspacePaneHostOpenContext'
  );
  function ChatPane() {
    openProbe.action = useWorkspacePaneHostOpenAction();
    return <p data-testid="ambient-chat-occupant">Chat pane</p>;
  }
  return {
    // The model-less mount; never taken under `RegionModelProvider`.
    ChatDock: () => null,
    renderAmbientChatPane: () => <ChatPane />,
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
  // #2047: the region host resolves the dock's project through this read;
  // no project here, so the panes that need one derive none.
  useProject: () => ({ project: undefined, isLoading: false }),
}));

const STORAGE_PREFIX = 'station:workspace-pane-host:v2:ambient:';
const LEGACY_CHAT_DOCK_KEY = `${STORAGE_PREFIX}chat-dock`;
const BOTTOM_KEY = `${STORAGE_PREFIX}bottom`;
const RIGHT_KEY = `${STORAGE_PREFIX}right`;
const DEVICE_SETTINGS_KEY = 'station-device-settings-v1';

let model: ReturnType<typeof useRegionModel> | null = null;

function Probe() {
  const value = useRegionModel();
  useEffect(() => {
    model = value;
  }, [value]);
  return null;
}

function currentModel(): ReturnType<typeof useRegionModel> {
  if (!model) throw new Error('region model probe never rendered');
  return model;
}

beforeEach(() => {
  model = null;
  openProbe.action = null;
  // jsdom has no Web Locks; the host exposes no lockManager prop (it IS the
  // production wiring), so the lease is granted through `navigator.locks`
  // the way `browserWorkspacePaneHostLockManager` takes it.
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
  vi.unstubAllGlobals();
  window.localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  navigationStore.navigate('/', { dock: null, dockSlotPlacement: null });
  delete (globalThis.navigator as { locks?: unknown }).locks;
});

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

function storedDocument(key: string): {
  id: string;
  instances: { descriptorId: string }[];
  root: { id: string };
} | null {
  const raw = window.localStorage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

/** A persisted document naming the canonical Chat occurrence under `id`. */
function chatDocument(id: string, rootId: string): string {
  return JSON.stringify({
    version: '1.1',
    id,
    scope: { kind: 'ambient' },
    instances: [
      {
        version: '1.0',
        descriptorId: 'pane:builtin:chat',
        instanceId: 'workspace-chat',
        stateKey: 'workspace-chat',
        boundContext: { sourceId: 'builtin:workspace-chat' },
      },
    ],
    activeInstanceId: 'workspace-chat',
    root: {
      type: 'tabs',
      id: rootId,
      instanceIds: ['workspace-chat'],
      selectedInstanceId: 'workspace-chat',
    },
  });
}

/**
 * Reverting #2045 (per-occupant shells, Chat on `chat-dock`, Activity in
 * its own shell with no host) fails this three ways: no `ambient:bottom`
 * document is ever written, no `ambient:right` document is ever written,
 * and the Activity pane does not sit inside a host frame at all.
 */
test('Activity in `right` and Chat in `bottom` both render through their region hosts and persist per-region documents', async () => {
  renderShells();
  await waitFor(() => expect(model).not.toBeNull());
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );

  act(() => currentModel().placeSurface('activity', 'right'));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  const sessions = await screen.findByTestId('sessions-view');

  const shells = document.querySelectorAll<HTMLElement>('.chat-dock');
  expect(shells).toHaveLength(2);
  const chatShell = document.querySelector<HTMLElement>('#chat-dock');
  const activityShell = document.querySelector<HTMLElement>(
    'section[aria-label="Activity"]',
  );
  if (!chatShell || !activityShell) throw new Error('both shells must render');
  expect(chatShell.dataset.region).toBe('bottom');
  expect(activityShell.dataset.region).toBe('right');
  // Each pane renders inside ITS region's shell: Chat's occupant inside
  // `bottom`'s, Activity's sessions surface inside `right`'s, in the shared
  // `.dock-slot__body` scroll container the dock pane wraps it in.
  expect(
    within(chatShell).queryByTestId('ambient-chat-occupant'),
  ).not.toBeNull();
  expect(sessions.closest('.chat-dock')).toBe(activityShell);
  expect(sessions.closest('.dock-slot__body')).not.toBeNull();
  // Neither host renders tab chrome: `presentation="chromeless"` until
  // slice 2.
  expect(screen.queryByRole('tablist')).toBeNull();

  // The documents are the REGIONS': one per occupied region, each holding
  // the pane of the surface placed there.
  await waitFor(() =>
    expect(
      storedDocument(BOTTOM_KEY)?.instances.map((i) => i.descriptorId),
    ).toEqual(['pane:builtin:chat']),
  );
  await waitFor(() =>
    expect(
      storedDocument(RIGHT_KEY)?.instances.map((i) => i.descriptorId),
    ).toEqual(['pane:builtin:activity']),
  );
  expect(storedDocument(BOTTOM_KEY)?.id).toBe('bottom');
  expect(storedDocument(RIGHT_KEY)?.id).toBe('right');
});

/**
 * Design constraint 1 of #2045: the pre-#2045 Chat document keeps restoring
 * a user's dock. The region Chat occupies ADOPTS it on first run. The
 * discriminator is the tab group's id: the legacy document below carries
 * `legacy-group`, which restoration preserves and a baseline never has
 * (`createWorkspacePaneHostBaselineDocument` names it `root`). Deleting
 * `adoptLegacyChatDockDocument` — or the call in `RegionPaneHost` — makes
 * `ambient:bottom` a fresh baseline whose root is `root`, and the first
 * assertion fails.
 */
test('the legacy `ambient:chat-dock` document is adopted by the region Chat occupies', async () => {
  window.localStorage.setItem(
    LEGACY_CHAT_DOCK_KEY,
    chatDocument('chat-dock', 'legacy-group'),
  );

  renderShells();
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );

  await waitFor(() =>
    expect(storedDocument(BOTTOM_KEY)?.root.id).toBe('legacy-group'),
  );
  expect(storedDocument(BOTTOM_KEY)?.id).toBe('bottom');
  expect(
    storedDocument(BOTTOM_KEY)?.instances.map((i) => i.descriptorId),
  ).toEqual(['pane:builtin:chat']);
  // The legacy key is left in place: an older build in the same-device
  // stale-tab window still reads it.
  expect(storedDocument(LEGACY_CHAT_DOCK_KEY)?.root.id).toBe('legacy-group');
});

/**
 * Adoption follows CHAT, not `bottom`: a device whose Chat lives in `right`
 * adopts into `ambient:right`, and `ambient:bottom` — empty, no host — is
 * never written. An adoption pinned to the default region passed every
 * other test in this file (verifier finding on #2045); this is the one it
 * fails. The placement is seeded the way a remembered one arrives, through
 * the `dockSlotPlacement` device setting the model seeds from.
 */
test('the legacy document is adopted into the region Chat occupies, not into `bottom`', async () => {
  window.localStorage.setItem(
    LEGACY_CHAT_DOCK_KEY,
    chatDocument('chat-dock', 'legacy-group'),
  );
  deviceSettingsStore.set('dockSlotPlacement', 'right');

  renderShells();
  await waitFor(() => expect(model).not.toBeNull());
  await waitFor(() =>
    expect(currentModel().regions.right.occupant).toBe('chat'),
  );
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );

  await waitFor(() =>
    expect(storedDocument(RIGHT_KEY)?.root.id).toBe('legacy-group'),
  );
  expect(storedDocument(RIGHT_KEY)?.id).toBe('right');
  expect(window.localStorage.getItem(BOTTOM_KEY)).toBeNull();
});

/**
 * The open path of a region host admits only the panes of surfaces occupying
 * the region: opening Activity's pane into the region Chat holds is refused
 * by admission (`reason: 'refused'`, not `no-lease` — the lease is held, as
 * the persisted document proves first), and the region's document does not
 * gain it. Before #2045 only the model-less mount pinned this.
 */
test('a region host refuses opening a pane of a surface that does not occupy the region', async () => {
  renderShells();
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );
  await waitFor(() => expect(storedDocument(BOTTOM_KEY)?.id).toBe('bottom'));
  await waitFor(() => expect(openProbe.action).not.toBeNull());

  let outcome: unknown;
  act(() => {
    outcome = openProbe.action?.open(WORKSPACE_ACTIVITY_PANE_INSTANCE);
  });

  expect(outcome).toEqual({ ok: false, reason: 'refused' });
  expect(
    storedDocument(BOTTOM_KEY)?.instances.map((i) => i.descriptorId),
  ).toEqual(['pane:builtin:chat']);
  expect(screen.queryByTestId('sessions-view')).toBeNull();
});

/**
 * Adoption is for a region document that has never been written. Once the
 * region has its own, the legacy document is not consulted: the region's
 * `region-group` survives and the legacy `legacy-group` does not replace it.
 */
test('a region document that already exists is not overwritten by the legacy one', async () => {
  window.localStorage.setItem(
    LEGACY_CHAT_DOCK_KEY,
    chatDocument('chat-dock', 'legacy-group'),
  );
  window.localStorage.setItem(
    BOTTOM_KEY,
    chatDocument('bottom', 'region-group'),
  );

  renderShells();
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );

  await waitFor(() =>
    expect(storedDocument(BOTTOM_KEY)?.root.id).toBe('region-group'),
  );
});

/**
 * A region document persisted while another surface held the region (a
 * swap moved Chat out and Activity in) restores as the CURRENT occupant's
 * baseline: the stale Chat pane is not admitted into Activity's region.
 */
test('a stale region document naming the previous occupant restores as the current occupant', async () => {
  window.localStorage.setItem(RIGHT_KEY, chatDocument('right', 'stale-group'));

  renderShells();
  await waitFor(() => expect(model).not.toBeNull());
  act(() => currentModel().placeSurface('activity', 'right'));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  await screen.findByTestId('sessions-view');

  await waitFor(() =>
    expect(
      storedDocument(RIGHT_KEY)?.instances.map((i) => i.descriptorId),
    ).toEqual(['pane:builtin:activity']),
  );
  expect(storedDocument(RIGHT_KEY)?.root.id).toBe('root');
  expect(document.querySelectorAll('#chat-dock')).toHaveLength(1);
  expect(
    within(
      document.querySelector<HTMLElement>('section[aria-label="Activity"]')!,
    ).queryByTestId('ambient-chat-occupant'),
  ).toBeNull();
});

/**
 * #2046 2a: a region holding two panes derives a two-pane document, persists
 * it under the region's key with the arrangement's selected pane active, and
 * on reload — the arrangement record naming both panes and the selection —
 * hydrates that document and shows the selected pane. Reverting the
 * pane-set derivation (`createRegionPaneHostDocument(documentId, [occupant])`)
 * fails the two-instance assertion; reverting the selection sync fails the
 * `activeInstanceId` assertion after the model's `selectPane`, and the
 * reload's "Chat is what renders" assertion.
 */
test('a two-pane region persists both panes with the selected one active and reloads showing it', async () => {
  const first = renderShells();
  await waitFor(() => expect(model).not.toBeNull());
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );

  act(() => currentModel().placeSurface('activity', 'bottom'));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  await screen.findByTestId('sessions-view');
  expect(currentModel().regions.bottom).toMatchObject({
    panes: ['chat', 'activity'],
    occupant: 'activity',
  });
  // One shell, the region's; the chromeless host shows the selected pane
  // only, so Chat's occupant is not mounted while Activity is selected.
  expect(document.querySelectorAll('.chat-dock')).toHaveLength(1);
  expect(screen.queryByTestId('ambient-chat-occupant')).toBeNull();
  await waitFor(() =>
    expect(
      storedDocument(BOTTOM_KEY)?.instances.map((i) => i.descriptorId),
    ).toEqual(['pane:builtin:chat', 'pane:builtin:activity']),
  );
  await waitFor(() =>
    expect(
      (storedDocument(BOTTOM_KEY) as { activeInstanceId?: string } | null)
        ?.activeInstanceId,
    ).toBe('workspace-activity'),
  );

  // The model's select reaches the host: Chat's tab shows, Activity's does
  // not, and the persisted document follows.
  act(() => currentModel().selectPane('bottom', 'chat'));
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );
  expect(screen.queryByTestId('sessions-view')).toBeNull();
  await waitFor(() =>
    expect(
      (storedDocument(BOTTOM_KEY) as { activeInstanceId?: string } | null)
        ?.activeInstanceId,
    ).toBe('workspace-chat'),
  );
  // The arrangement record carries the pane set and the selection (the
  // provider writes it 150 ms after the change).
  await waitFor(() => {
    const record = (
      deviceSettingsStore.get('regionArrangement') as {
        regions?: { bottom?: { occupant?: unknown } };
      }
    ).regions?.bottom?.occupant;
    expect(record).toEqual({
      kind: 'pane-host',
      panes: [
        { kind: 'surface', id: 'chat' },
        { kind: 'surface', id: 'activity' },
      ],
      selected: 'chat',
    });
  });

  // Reload: a fresh provider reads the record, the host hydrates the
  // region's document, and Chat — the selected pane — is what renders.
  first.unmount();
  model = null;
  deviceSettingsStore.reloadFromStorage();
  renderShells();
  await waitFor(() => expect(model).not.toBeNull());
  await waitFor(() =>
    expect(currentModel().regions.bottom).toMatchObject({
      panes: ['chat', 'activity'],
      occupant: 'chat',
      visible: true,
    }),
  );
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );
  expect(screen.queryByTestId('sessions-view')).toBeNull();
  expect(
    storedDocument(BOTTOM_KEY)?.instances.map((i) => i.descriptorId),
  ).toEqual(['pane:builtin:chat', 'pane:builtin:activity']);
});

/**
 * The test the #2045 docblock named as the condition for dropping the
 * host's `occupants.join('+')` key (#2046 2a, decision 4): the pane set of a
 * MOUNTED region changes — Activity joins `right` while it holds Chat, then
 * Chat leaves for `bottom` (the swap's end state, reached without a swap) —
 * under a stale persisted document, and the controller's authority-
 * fingerprint path alone, no remount, lands the region on its current
 * panes. The `DockShell` node identity across both changes is what proves
 * "no remount"; the persisted document and the rendered pane are what prove
 * the fingerprint path did the work.
 */
test('a region host follows its pane set through the fingerprint path alone: no remount under a stale document', async () => {
  window.localStorage.setItem(RIGHT_KEY, chatDocument('right', 'stale-group'));
  deviceSettingsStore.set('dockSlotPlacement', 'right');

  renderShells();
  await waitFor(() => expect(model).not.toBeNull());
  await waitFor(() =>
    expect(currentModel().regions.right.occupant).toBe('chat'),
  );
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );
  const rightShell = document.querySelector<HTMLElement>(
    '[data-region="right"]',
  );
  if (!rightShell) throw new Error('right shell never rendered');
  // The stale document (Chat alone, `stale-group`) matches the pane set, so
  // it is what the host hydrated — the reconciliation left it alone.
  await waitFor(() =>
    expect(storedDocument(RIGHT_KEY)?.root.id).toBe('stale-group'),
  );

  // Activity joins `right`: the fingerprint changes, the host restores the
  // derived two-pane document with Activity active, and persists it.
  act(() => currentModel().placeSurface('activity', 'right'));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  await screen.findByTestId('sessions-view');
  expect(document.querySelector('[data-region="right"]')).toBe(rightShell);
  await waitFor(() =>
    expect(
      storedDocument(RIGHT_KEY)?.instances.map((i) => i.descriptorId),
    ).toEqual(['pane:builtin:chat', 'pane:builtin:activity']),
  );
  expect(storedDocument(RIGHT_KEY)?.root.id).toBe('root');

  // Chat leaves for `bottom`: `right`'s fingerprint changes again, Chat's
  // pane is revoked from `right`'s document, and Activity stays selected.
  act(() => currentModel().placeSurface('chat', 'bottom'));
  await waitFor(() =>
    expect(
      document.querySelector<HTMLElement>('#chat-dock')?.dataset.region,
    ).toBe('bottom'),
  );
  expect(document.querySelector('[data-region="right"]')).toBe(rightShell);
  expect(currentModel().regions.right).toMatchObject({
    panes: ['activity'],
    occupant: 'activity',
  });
  await waitFor(() =>
    expect(
      storedDocument(RIGHT_KEY)?.instances.map((i) => i.descriptorId),
    ).toEqual(['pane:builtin:activity']),
  );
  await waitFor(() =>
    expect(
      storedDocument(BOTTOM_KEY)?.instances.map((i) => i.descriptorId),
    ).toEqual(['pane:builtin:chat']),
  );
  expect(within(rightShell).queryByTestId('ambient-chat-occupant')).toBeNull();
  expect(within(rightShell).queryByTestId('sessions-view')).not.toBeNull();
});
