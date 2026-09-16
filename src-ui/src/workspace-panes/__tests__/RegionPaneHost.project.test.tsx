/** @vitest-environment jsdom */

/**
 * #2047: a docked coding pane is the dock's PROJECT's. Driven through the
 * shipped path — `RegionShells` → `RegionPaneHost` → `DockShell` +
 * `RegionChromeBar` → `dock` `WorkspacePaneHost` → `RegionBuiltinPane` —
 * against the real region model, navigation and device stores, with Chat's
 * renderer stubbed (it would mount the whole chat stack) and the built-in
 * registry stubbed at its one seam (`getBuiltinWorkspacePaneRenderer`, so
 * the coding render graph stays out; what the stub prints is the INSTANCE
 * the host handed it, which is the fact under test).
 */

import { createWorkspaceCodingTerminalPaneInstance } from '@kontourai/station-contracts/workspace-coding-panels';
import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
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
import { KeyboardShortcutsProvider } from '../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';
import {
  RegionModelProvider,
  useRegionModel,
} from '../../contexts/RegionModelContext';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { writeFilePreviewPaneState } from '../filePreviewPaneStateStorage';

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
    ChatDock: () => null,
    renderAmbientChatPane: () => <ChatPane />,
  };
});
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
}));
/** Two projects the dock can bind, by slug; the host reads the id. */
const PROJECTS: Record<string, { id: string; slug: string; name: string }> = {
  alpha: { id: 'alpha-id', slug: 'alpha', name: 'Alpha' },
  beta: { id: 'beta-id', slug: 'beta', name: 'Beta' },
};
/**
 * The project read's own lifecycle. `useProject` is a per-slug fetch
 * (`enabled: !!slug`), so a cold load answers PENDING before it answers "no
 * such project" — the state review M3 is about. `pending` here is that
 * in-flight answer for every non-empty slug.
 */
const projectRead = vi.hoisted(() => ({ pending: false }));
vi.mock('../../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: Object.values(PROJECTS),
    isLoading: false,
    isConfirmedLoaded: true,
  }),
  useProject: (slug: string) =>
    projectRead.pending && slug !== ''
      ? { project: undefined, isLoading: true }
      : { project: PROJECTS[slug], isLoading: false },
}));
/**
 * The registry's one seam. The stub renders the instance it was handed, so
 * every assertion about "which project the pane is bound to" reads the
 * host's real derivation, not the stub's.
 */
/**
 * The dock catalog's data seam: the server's resolved catalog for the dock
 * project, holding the Terminal occurrence the server issues for it.
 */
vi.mock('../resolvedWorkspacePaneCatalog', async () => {
  const { WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR } = await import(
    '@kontourai/station-contracts/workspace-coding-panels'
  );
  return {
    useResolvedWorkspacePaneCatalog: (projectSlug: string) => ({
      entries: [
        {
          descriptor: WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
          instance: createWorkspaceCodingTerminalPaneInstance(
            PROJECTS[projectSlug]?.id ?? '',
          ),
          availability: {
            state: 'available',
            reason: { code: 'ready', source: 'resolver' },
          },
          clientRendererPresence: 'present',
        },
      ],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
  };
});
vi.mock('../builtinWorkspacePaneRegistry', () => ({
  getBuiltinWorkspacePaneRenderer: () =>
    function CodingStub({ instance }: { instance: WorkspacePaneInstance }) {
      return (
        <p
          data-testid="coding-pane"
          data-descriptor={instance.descriptorId}
          data-project={instance.boundContext?.projectId}
        >
          Coding pane
        </p>
      );
    },
}));

const STORAGE_PREFIX = 'station:workspace-pane-host:v2:ambient:';
const BOTTOM_KEY = `${STORAGE_PREFIX}bottom`;
const RIGHT_KEY = `${STORAGE_PREFIX}right`;
const DEVICE_SETTINGS_KEY = 'station-device-settings-v1';
const PR_PANE_ID = 'pr:github.com/kontourai/station#2049';
const PREVIEW_ID = `file-preview:${'c'.repeat(32)}`;

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
  projectRead.pending = false;
  openProbe.action = null;
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
  instances: {
    descriptorId: string;
    instanceId: string;
    boundContext?: { projectId?: string };
  }[];
  activeInstanceId?: string;
} | null {
  const raw = window.localStorage.getItem(key);
  return raw ? JSON.parse(raw) : null;
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

/**
 * The region host, its chrome bar and its built-in pane all arrive through
 * dynamic imports, and the FIRST mount in a file pays their transform cost in
 * this runner — measurably more than the 1s `waitFor` default once #2049 put
 * the file-preview state modules on that chain. Waiting longer here is a
 * runner fact, not a product one: every later assertion is immediate.
 */
async function awaitChatPane() {
  await waitFor(() => expect(model).not.toBeNull());
  await waitFor(
    () => expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
    { timeout: 5_000 },
  );
}

async function renderWithChatAndTerminal() {
  const rendered = renderShells();
  await awaitChatPane();
  act(() => currentModel().placeSurface('coding:terminal', 'bottom'));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  const pane = await screen.findByTestId('coding-pane');
  return { rendered, pane };
}

/**
 * Reverting the host's project resolution (`PROJECTLESS_CONTEXT` for every
 * region) fails at the first `coding-pane` find: with no project the pane
 * has no instance and the placeholder renders instead. Reverting the
 * factory's `projectId` binding fails the `data-project` and persisted
 * `boundContext` assertions.
 */
test('a Terminal placed beside Chat is the dock project’s: rendered, persisted and recorded as the region’s second pane', async () => {
  deviceSettingsStore.set('chatDockProjectSlug', 'alpha');
  const { pane } = await renderWithChatAndTerminal();

  expect(tabs('bottom')).toEqual([
    ['Chat', 'false'],
    ['Terminal', 'true'],
  ]);
  expect(pane.closest('.chat-dock')).toBe(shell('bottom'));
  expect(pane.dataset.descriptor).toBe('pane:builtin:coding:terminal');
  expect(pane.dataset.project).toBe('alpha-id');
  // The selected pane is the strip's panel, labelled by its tab.
  const terminalTab = within(shell('bottom')).getByRole('tab', {
    name: 'Terminal',
  });
  const panel = document.getElementById(
    terminalTab.getAttribute('aria-controls') ?? '',
  );
  expect(panel?.getAttribute('role')).toBe('tabpanel');
  expect(
    within(panel as HTMLElement).queryByTestId('coding-pane'),
  ).not.toBeNull();

  await waitFor(() =>
    expect(storedDocument(BOTTOM_KEY)?.instances).toMatchObject([
      { descriptorId: 'pane:builtin:chat' },
      {
        descriptorId: 'pane:builtin:coding:terminal',
        instanceId: 'workspace-coding-terminal',
        boundContext: { projectId: 'alpha-id' },
      },
    ]),
  );
  expect(storedDocument(BOTTOM_KEY)?.activeInstanceId).toBe(
    'workspace-coding-terminal',
  );
  await waitFor(() =>
    expect(
      (
        deviceSettingsStore.get('regionArrangement') as {
          regions?: { bottom?: { occupant?: unknown } };
        }
      ).regions?.bottom?.occupant,
    ).toEqual({
      kind: 'pane-host',
      panes: [
        { kind: 'surface', id: 'chat' },
        { kind: 'surface', id: 'coding:terminal' },
      ],
      selected: 'coding:terminal',
    }),
  );
});

/**
 * A project switch is a new authority fingerprint (the instance's
 * `boundContext` is part of it), not a pane-set change: the instance ids
 * stay, the region's shell is not remounted, and the mounted pane is handed
 * the new project's instance. Reverting the host to derive its document
 * once (a ref) fails the `beta-id` assertions.
 */
test('switching the dock’s project re-binds a mounted coding pane in place', async () => {
  deviceSettingsStore.set('chatDockProjectSlug', 'alpha');
  await renderWithChatAndTerminal();
  const bottom = shell('bottom');
  await waitFor(() =>
    expect(
      storedDocument(BOTTOM_KEY)?.instances[1]?.boundContext?.projectId,
    ).toBe('alpha-id'),
  );

  act(() => deviceSettingsStore.set('chatDockProjectSlug', 'beta'));

  await waitFor(() =>
    expect(screen.getByTestId('coding-pane').dataset.project).toBe('beta-id'),
  );
  expect(document.querySelector('.chat-dock[data-region="bottom"]')).toBe(
    bottom,
  );
  expect(tabs('bottom')).toEqual([
    ['Chat', 'false'],
    ['Terminal', 'true'],
  ]);
  await waitFor(() =>
    expect(storedDocument(BOTTOM_KEY)?.instances).toMatchObject([
      { descriptorId: 'pane:builtin:chat', instanceId: 'workspace-chat' },
      {
        instanceId: 'workspace-coding-terminal',
        boundContext: { projectId: 'beta-id' },
      },
    ]),
  );
});

/**
 * Admission is over the dock's binding, not the surface alone: the open
 * path refuses a Terminal bound to another project (`reason: 'refused'`,
 * the region's document does not gain it), and a persisted one under the
 * same instance id renders and stores as the dock's project rather than the
 * other project's. Reverting `isRegionPane`'s project comparison fails the
 * refusal assertion.
 *
 * What produces that second observable is the host RE-DERIVING the binding
 * on mount from its authority fingerprint, not restoration: disabling
 * `restoreWorkspacePaneHostDocument`'s catalog substitution leaves this test
 * green (verifier injections D2/D2b), and the strict catalog-match branch is
 * never reached for this fixture. Restoration's substitution is a second line
 * of defence and is pinned directly, at the contract, by
 * `packages/contracts/src/__tests__/workspace-pane-host.test.ts`'s "a
 * persisted instance's own project never survives a catalog match".
 */
test('a coding pane bound to another project is refused on open and re-bound on restore', async () => {
  deviceSettingsStore.set('chatDockProjectSlug', 'alpha');
  const other = createWorkspaceCodingTerminalPaneInstance('other-id');
  if (!other) throw new Error('fixture must parse');
  window.localStorage.setItem(
    BOTTOM_KEY,
    JSON.stringify({
      version: '1.1',
      id: 'bottom',
      scope: { kind: 'ambient' },
      instances: [
        {
          version: '1.0',
          descriptorId: 'pane:builtin:chat',
          instanceId: 'workspace-chat',
          stateKey: 'workspace-chat',
          boundContext: { sourceId: 'builtin:workspace-chat' },
        },
        other,
      ],
      activeInstanceId: 'workspace-coding-terminal',
      root: {
        type: 'tabs',
        id: 'root',
        instanceIds: ['workspace-chat', 'workspace-coding-terminal'],
        selectedInstanceId: 'workspace-coding-terminal',
      },
    }),
  );

  const { pane } = await renderWithChatAndTerminal();
  expect(pane.dataset.project).toBe('alpha-id');
  await waitFor(() =>
    expect(
      storedDocument(BOTTOM_KEY)?.instances[1]?.boundContext?.projectId,
    ).toBe('alpha-id'),
  );

  // Chat's pane holds the open probe; select it to mount it.
  fireEvent.click(within(shell('bottom')).getByRole('tab', { name: 'Chat' }));
  await waitFor(() => expect(openProbe.action).not.toBeNull());
  let outcome: unknown;
  act(() => {
    outcome = openProbe.action?.open(other);
  });
  expect(outcome).toEqual({ ok: false, reason: 'refused' });
  expect(
    storedDocument(BOTTOM_KEY)?.instances.map((i) => i.boundContext?.projectId),
  ).toEqual([undefined, 'alpha-id']);

  // The dock's own occurrence passes admission and reaches the host's own
  // no-duplicate rule (`already-open`): a different reason from the other
  // project's `refused`, which is what shows the refusal above was the
  // project comparison and not the surface check.
  const own = createWorkspaceCodingTerminalPaneInstance('alpha-id');
  if (!own) throw new Error('fixture must parse');
  act(() => {
    outcome = openProbe.action?.open(own);
  });
  expect(outcome).toEqual({ ok: false, reason: 'already-open' });
});

/**
 * #1969: the Device pane is the counter-case to D6 below. Its inventory
 * entry ignores the dock's context — a device list is a fact about the
 * Station's host, not about a checkout — so with NO project it renders,
 * where a coding pane renders the "choose a project" placeholder.
 *
 * Making the Device entry project-bound (building it with `codingPane(...)`
 * in `region-surface-panes.ts`) reds this: the host would have no instance
 * and would draw the placeholder instead.
 */
test('without a project the Device pane renders, bound to nothing', async () => {
  renderShells();
  await waitFor(() => expect(model).not.toBeNull());
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );

  act(() => currentModel().placeSurface('device', 'right'));
  await act(async () => {
    await vi.dynamicImportSettled();
  });

  const pane = await screen.findByTestId('coding-pane');
  expect(pane.dataset.descriptor).toBe('pane:builtin:device');
  expect(pane.dataset.project).toBeUndefined();
  expect(screen.queryByText('Choose a project for this dock')).toBeNull();
  expect(currentModel().regions.right).toMatchObject({
    panes: ['device'],
    occupant: 'device',
    visible: true,
  });
  expect(within(shell('right')).getByLabelText('Hide Device')).toBeTruthy();
});

/**
 * D6: no active project. The "+" is Part C's; here the placed pane keeps
 * its tab and its record, throws nothing, and renders "Choose a project for
 * this dock" where the pane would be; binding a project afterwards renders
 * it. Reverting the placeholder (throwing from
 * `createRegionPaneHostDocument` on a null instance) fails at the
 * placeholder find with the boundary's error; reverting the tab (dropping
 * the pane from `panes` on a null instance) fails the `panes` assertion.
 */
test('without a project a placed coding pane keeps its tab and shows the placeholder; binding a project renders it', async () => {
  renderShells();
  await waitFor(() => expect(model).not.toBeNull());
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );

  act(() => currentModel().placeSurface('coding:terminal', 'right'));
  await act(async () => {
    await vi.dynamicImportSettled();
  });

  const placeholder = await screen.findByText('Choose a project for this dock');
  expect(placeholder.closest('.chat-dock')).toBe(shell('right'));
  expect(screen.queryByTestId('coding-pane')).toBeNull();
  expect(currentModel().regions.right).toMatchObject({
    panes: ['coding:terminal'],
    occupant: 'coding:terminal',
    visible: true,
  });
  // The region's bar names the pane it holds; nothing was written for a
  // document the region could not derive; and no "+" is offered — every
  // Open would land a pane that cannot render (D6).
  expect(within(shell('right')).getByLabelText('Hide Terminal')).toBeTruthy();
  expect(window.localStorage.getItem(RIGHT_KEY)).toBeNull();
  expect(screen.queryByLabelText(/^Add pane to /)).toBeNull();

  act(() => deviceSettingsStore.set('chatDockProjectSlug', 'alpha'));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  const pane = await screen.findByTestId('coding-pane');
  expect(pane.dataset.project).toBe('alpha-id');
  expect(screen.queryByText('Choose a project for this dock')).toBeNull();
  await waitFor(() =>
    expect(storedDocument(RIGHT_KEY)?.instances).toMatchObject([
      {
        descriptorId: 'pane:builtin:coding:terminal',
        boundContext: { projectId: 'alpha-id' },
      },
    ]),
  );
});

/**
 * Review M3: the project read in flight is not "no project". While it is
 * pending the region waits — the pane's loading skeleton, no instruction to
 * pick a project the user has already picked, no "+" — and nothing is
 * written to the region's document from a pane set the query has not
 * settled. Once the read settles the reconcile still runs: the stored
 * document gains Chat beside the Terminal.
 *
 * What each revert fails, measured: reverting the skeleton branch fails the
 * placeholder-absent assertion; reverting the deferral (running the
 * reconcile whatever `pending`) fails the FINAL stored-document assertion,
 * because the run is once per mount and the pending render spends it — the
 * settled pane set is then never written. It does NOT fail the raw-bytes
 * assertion below, which held under that injection: restoring the seeded
 * document against the pending-time instances drops the Terminal it does
 * not know, so the ids matched and the reconcile returned early. That
 * assertion is the direct "nothing was written while the query was in
 * flight" claim; it is not what discriminates the deferral.
 */
test('while the dock’s project read is in flight the region waits and writes nothing', async () => {
  projectRead.pending = true;
  deviceSettingsStore.set('chatDockProjectSlug', 'alpha');
  // The stored arrangement a returning user has: Chat and a Terminal at the
  // bottom, the Terminal selected — the region set the host derives its
  // document from before the project read answers.
  deviceSettingsStore.set('regionArrangement', {
    version: 1,
    regions: {
      main: {
        visible: true,
        size: 0,
        occupant: { kind: 'surface', id: 'home' },
      },
      left: { visible: false, size: 400, occupant: null },
      right: { visible: false, size: 400, occupant: null },
      bottom: {
        visible: true,
        size: 320,
        occupant: {
          kind: 'pane-host',
          panes: [
            { kind: 'surface', id: 'chat' },
            { kind: 'surface', id: 'coding:terminal' },
          ],
          selected: 'coding:terminal',
        },
      },
    },
  });
  const terminal = createWorkspaceCodingTerminalPaneInstance('alpha-id');
  if (!terminal) throw new Error('fixture must parse');
  const persisted = JSON.stringify({
    version: '1.1',
    id: 'bottom',
    scope: { kind: 'ambient' },
    instances: [terminal],
    activeInstanceId: 'workspace-coding-terminal',
    root: {
      type: 'tabs',
      id: 'root',
      instanceIds: ['workspace-coding-terminal'],
      selectedInstanceId: 'workspace-coding-terminal',
    },
  });
  window.localStorage.setItem(BOTTOM_KEY, persisted);

  renderShells();
  await waitFor(() => expect(model).not.toBeNull());
  await waitFor(() =>
    expect(currentModel().regions.bottom.panes).toEqual([
      'chat',
      'coding:terminal',
    ]),
  );
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  await waitFor(() =>
    expect(
      document.querySelector('.chat-dock[data-region="bottom"]'),
    ).not.toBeNull(),
  );

  expect(screen.queryByText('Choose a project for this dock')).toBeNull();
  expect(screen.queryByTestId('coding-pane')).toBeNull();
  expect(
    within(shell('bottom')).getByRole('status', { name: 'Loading pane' }),
  ).toBeTruthy();
  expect(screen.queryByLabelText(/^Add pane to /)).toBeNull();
  expect(window.localStorage.getItem(BOTTOM_KEY)).toBe(persisted);

  // The read settles. A region write is the re-render a resolving query
  // would otherwise cause; the settled answer is the mock's.
  projectRead.pending = false;
  act(() => currentModel().setRegion('bottom', { size: 321 }));
  await act(async () => {
    await vi.dynamicImportSettled();
  });

  const pane = await screen.findByTestId('coding-pane');
  expect(pane.dataset.project).toBe('alpha-id');
  await waitFor(() =>
    expect(storedDocument(BOTTOM_KEY)?.instances).toMatchObject([
      { descriptorId: 'pane:builtin:chat' },
      {
        descriptorId: 'pane:builtin:coding:terminal',
        boundContext: { projectId: 'alpha-id' },
      },
    ]),
  );
});

/**
 * Review L1: `useDockShellChrome` clears a `chatDockProjectSlug` naming a
 * deleted project only while the shell HOLDS CHAT, so the region set here is
 * the one that strands it — a Terminal on the right, Chat in no region —
 * and every docked coding pane would show "pick one from Chat's project
 * switcher", a switcher that is not on screen, while the route has a
 * project. The settled no-record read falls back to the route's project.
 * Reverting the fallback (the bound slug alone) fails at the `coding-pane`
 * find, with the placeholder in its place; putting Chat back in a region
 * would make the test pass either way, because the chrome's own cleanup
 * clears the binding.
 */
test('a dock binding naming a project that no longer exists falls back to the route’s project', async () => {
  deviceSettingsStore.set('chatDockProjectSlug', 'deleted-project');
  deviceSettingsStore.set('regionArrangement', {
    version: 1,
    regions: {
      main: {
        visible: true,
        size: 0,
        occupant: { kind: 'surface', id: 'home' },
      },
      left: { visible: false, size: 400, occupant: null },
      right: {
        visible: true,
        size: 400,
        occupant: { kind: 'surface', id: 'coding:terminal' },
      },
      bottom: { visible: false, size: 320, occupant: null },
    },
  });
  // No `dock=open`: that param seeds Chat into the bottom region, and a
  // shell holding Chat is exactly the case whose own cleanup clears the
  // stale binding before the host ever reads it.
  window.history.replaceState({}, '', '/projects/alpha');
  navigationStore.navigate('/projects/alpha', {
    dock: null,
    maximize: null,
    dockSlotPlacement: null,
  });
  renderShells();
  await waitFor(() => expect(model).not.toBeNull());
  await waitFor(() =>
    expect(currentModel().regions.right.panes).toEqual(['coding:terminal']),
  );
  expect(currentModel().regions.bottom.panes).toEqual([]);
  await act(async () => {
    await vi.dynamicImportSettled();
  });

  // Re-queried each poll: the region's shell is remounted as the arrangement
  // settles, which detaches an element captured before it.
  await waitFor(() =>
    expect(
      within(shell('right')).getByTestId('coding-pane').dataset.project,
    ).toBe('alpha-id'),
  );
  expect(screen.queryByText('Choose a project for this dock')).toBeNull();
  // The binding itself is untouched: the fallback is a read, not a write
  // (clearing it is `useDockShellChrome`'s, and only with Chat on screen).
  expect(deviceSettingsStore.get('chatDockProjectSlug')).toBe(
    'deleted-project',
  );
});

/**
 * The acceptance, end to end (#2047 D4): from Chat alone at the bottom, the
 * region's "+" opens the dock catalog, Open Terminal lands Terminal as the
 * selected tab beside Chat and the catalog closes. Reverting the catalog's
 * Open to the host's own open action fails the tab assertion (the host
 * refuses a pane the region does not hold); dropping the "+" from the
 * one-pane bar fails at the first click.
 */
test('the "+" opens the dock catalog and Open Terminal lands it as the selected tab beside Chat', async () => {
  deviceSettingsStore.set('chatDockProjectSlug', 'alpha');
  renderShells();
  await waitFor(() => expect(model).not.toBeNull());
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );
  expect(within(shell('bottom')).queryByRole('tablist')).toBeNull();

  fireEvent.click(within(shell('bottom')).getByLabelText('Add pane to Bottom'));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  const dialog = await screen.findByRole('dialog', {
    name: 'Add pane to Bottom',
  });
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Open Terminal' }),
  );
  await act(async () => {
    await vi.dynamicImportSettled();
  });

  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', { name: 'Add pane to Bottom' }),
    ).toBeNull(),
  );
  const pane = await screen.findByTestId('coding-pane');
  expect(pane.dataset.project).toBe('alpha-id');
  expect(tabs('bottom')).toEqual([
    ['Chat', 'false'],
    ['Terminal', 'true'],
  ]);
  expect(currentModel().regions.bottom).toMatchObject({
    panes: ['chat', 'coding:terminal'],
    occupant: 'coding:terminal',
    visible: true,
  });
  // Nothing about the open was a navigation.
  expect(new URLSearchParams(window.location.search).get('pane')).toBeNull();
});

/**
 * #2049: an instance-keyed pane through the same shipped path. The tab's
 * title is the PANE's, not the surface registry's — a pull request is
 * `#2049` and a preview is its file's name — and the occurrence the host
 * derives is the one the id names, bound to the dock's project.
 *
 * Reverting `RegionPaneHost`'s `pane.title ?? …` fallback to the registry
 * title reds the tab-name assertions with "Pull request" and "File".
 * Reverting the prefix branch in `regionSurfacePane` drops both tabs, so the
 * strip reads `['Chat', 'true']` alone.
 */
test('a pull request and a file preview render as their own dock tabs, named by the pane', async () => {
  deviceSettingsStore.set('chatDockProjectSlug', 'alpha');
  writeFilePreviewPaneState(window.localStorage, PREVIEW_ID, {
    version: '1.0',
    projectSlug: 'alpha',
    path: 'src/components/Header.tsx',
    wrap: true,
  });
  renderShells();
  await awaitChatPane();
  act(() => currentModel().placeSurface(PR_PANE_ID, 'right'));
  act(() => currentModel().placeSurface(PREVIEW_ID, 'right'));
  await act(async () => {
    await vi.dynamicImportSettled();
  });

  expect(tabs('right')).toEqual([
    ['#2049', 'false'],
    ['Header.tsx', 'true'],
  ]);
  const pane = await screen.findByTestId('coding-pane');
  expect(pane.closest('.chat-dock')).toBe(shell('right'));
  expect(pane.dataset.descriptor).toBe(
    'pane:builtin:workspace-preview:file-preview',
  );
  expect(pane.dataset.project).toBe('alpha-id');

  act(() => currentModel().selectPane('right', PR_PANE_ID));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  expect((await screen.findByTestId('coding-pane')).dataset.descriptor).toBe(
    'pane:builtin:workspace-pull-request',
  );

  await waitFor(() =>
    expect(storedDocument(RIGHT_KEY)?.instances).toMatchObject([
      {
        descriptorId: 'pane:builtin:workspace-pull-request',
        instanceId: PR_PANE_ID,
        boundContext: { projectId: 'alpha-id' },
      },
      {
        descriptorId: 'pane:builtin:workspace-preview:file-preview',
        instanceId: PREVIEW_ID,
        boundContext: { projectId: 'alpha-id' },
      },
    ]),
  );
});

/**
 * The dock binds another project than the one the preview's state names, so
 * there is no occurrence to derive. The tab stays — the user opened it and
 * closing it is the user's act — and the placeholder says what is actually
 * wrong rather than repeating "choose a project", which is a remedy that
 * would do nothing here (the dock HAS one).
 */
test('a file preview from another project keeps its tab and says it is unavailable', async () => {
  deviceSettingsStore.set('chatDockProjectSlug', 'beta');
  writeFilePreviewPaneState(window.localStorage, PREVIEW_ID, {
    version: '1.0',
    projectSlug: 'alpha',
    path: 'src/components/Header.tsx',
    wrap: true,
  });
  renderShells();
  await awaitChatPane();
  act(() => currentModel().placeSurface(PREVIEW_ID, 'right'));
  await act(async () => {
    await vi.dynamicImportSettled();
  });

  // One pane, so the strip renders no tab list; the shell's own Hide control
  // carries the region's name instead — the prefix's generic "File preview",
  // since nothing in the entry chunk resolves an occurrence to read a file
  // name from.
  expect(within(shell('right')).getByTitle('Hide File preview')).toBeTruthy();
  expect(screen.queryByTestId('coding-pane')).toBeNull();
  expect(
    within(shell('right')).getByText(
      'Header.tsx is not available in this dock',
    ),
  ).toBeTruthy();
  expect(
    within(shell('right')).queryByText('Choose a project for this dock'),
  ).toBeNull();
  // Review M1: with one pane there is no tab strip and so no close control
  // (`onCloseTab` is gated on `tabs.length > 1`), so the copy must not tell
  // the reader to close the tab. The remedy it names is the one that exists
  // in this exact state.
  expect(within(shell('right')).queryByRole('tablist')).toBeNull();
  expect(within(shell('right')).queryByText(/close the tab/i)).toBeNull();
  expect(
    within(shell('right')).getByText(
      /Open it again from the chat that linked it\./,
    ),
  ).toBeTruthy();
});
