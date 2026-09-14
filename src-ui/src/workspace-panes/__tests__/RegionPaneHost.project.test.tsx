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
vi.mock('../../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: Object.values(PROJECTS),
    isLoading: false,
    isConfirmedLoaded: true,
  }),
  useProject: (slug: string) => ({
    project: PROJECTS[slug],
    isLoading: false,
  }),
}));
/**
 * The registry's one seam. The stub renders the instance it was handed, so
 * every assertion about "which project the pane is bound to" reads the
 * host's real derivation, not the stub's.
 */
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

async function renderWithChatAndTerminal() {
  const rendered = renderShells();
  await waitFor(() => expect(model).not.toBeNull());
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );
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
 * same instance id is re-bound to the dock's project on restore rather
 * than rendered as the other project's. Reverting `isRegionPane`'s project
 * comparison fails the refusal assertion.
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
  // document the region could not derive.
  expect(within(shell('right')).getByLabelText('Hide Terminal')).toBeTruthy();
  expect(window.localStorage.getItem(RIGHT_KEY)).toBeNull();

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
