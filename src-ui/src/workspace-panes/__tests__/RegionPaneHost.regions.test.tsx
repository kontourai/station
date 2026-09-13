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
