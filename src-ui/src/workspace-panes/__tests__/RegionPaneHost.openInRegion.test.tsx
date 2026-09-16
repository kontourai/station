/** @vitest-environment jsdom */

/**
 * #2048 through the shipped path: a caller in `main` opens a pane instance
 * with `useOpenInRegion`, and the region host on the right renders it as a
 * SELECTED tab beside the pane already there; a second open focuses that
 * tab rather than adding one; neither open nor a refusal pushes history.
 * Harness as `RegionPaneHost.tabs.test.tsx`: `RegionShells` →
 * `RegionPaneHost` → `DockShell` + `RegionChromeBar` → `dock`
 * `WorkspacePaneHost`, real model, navigation and device stores, the two
 * pane renderers stubbed.
 */

import { WORKSPACE_ACTIVITY_PANE_INSTANCE } from '@kontourai/station-contracts/workspace-activity-pane';
import { WORKSPACE_HOME_PANE_INSTANCE } from '@kontourai/station-contracts/workspace-home-pane';
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
import { useOpenInRegion } from '../../contexts/useOpenInRegion';
import { deviceSettingsStore } from '../../lib/device-settings-store';

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
vi.mock('../../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: [],
    isLoading: false,
    isConfirmedLoaded: true,
  }),
  useProject: () => ({ project: undefined, isLoading: false }),
}));

const DEVICE_SETTINGS_KEY = 'station-device-settings-v1';

let model: ReturnType<typeof useRegionModel> | null = null;
let open: ReturnType<typeof useOpenInRegion> | null = null;

/** A caller in `main`: not a region host, not a pane — the outlet's side. */
function MainCaller() {
  const value = useRegionModel();
  const command = useOpenInRegion();
  useEffect(() => {
    model = value;
    open = command;
  }, [value, command]);
  return <main data-testid="main-outlet" />;
}

function current() {
  if (!model || !open) throw new Error('caller never rendered');
  return { model, open };
}

beforeEach(() => {
  model = null;
  open = null;
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
 * Reverting `openInRegion` to a host open (`openAction.open`) fails at the
 * tab assertion with the host's `refused` (the surface is not in the
 * region's panes); reverting the model's reveal-existing branch to a
 * placement fails the second open's `existing: true`; adding a history
 * write to either path fails the pushState count.
 */
test('an open from main lands as the selected tab on the right, a second open focuses it, and neither pushes history', async () => {
  render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <MainCaller />
          <RegionShells />
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
  await waitFor(() => expect(open).not.toBeNull());
  // Chat on the right, alone: one pane, no strip.
  act(() => current().model.placeSurface('chat', 'right'));
  await waitFor(() =>
    expect(
      document.querySelector<HTMLElement>('#chat-dock')?.dataset.region,
    ).toBe('right'),
  );
  expect(within(shell('right')).queryByRole('tablist')).toBeNull();
  const pushes = vi.spyOn(window.history, 'pushState');

  let outcome: unknown;
  act(() => {
    outcome = current().open(WORKSPACE_ACTIVITY_PANE_INSTANCE, {
      region: 'right',
    });
  });
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  expect(outcome).toEqual({
    ok: true,
    region: 'right',
    surfaceId: 'activity',
    existing: false,
  });
  const sessions = await screen.findByTestId('sessions-view');
  expect(sessions.closest('.chat-dock')).toBe(shell('right'));
  expect(tabs('right')).toEqual([
    ['Chat', 'false'],
    ['Activity', 'true'],
  ]);
  expect(document.querySelectorAll('.chat-dock')).toHaveLength(1);
  expect(screen.queryByTestId('ambient-chat-occupant')).toBeNull();

  // Back to Chat's tab, then the same open again: focused, not duplicated.
  fireEvent.click(within(shell('right')).getByRole('tab', { name: 'Chat' }));
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );
  act(() => {
    outcome = current().open(WORKSPACE_ACTIVITY_PANE_INSTANCE, {
      region: 'right',
    });
  });
  expect(outcome).toEqual({
    ok: true,
    region: 'right',
    surfaceId: 'activity',
    existing: true,
  });
  await waitFor(() =>
    expect(screen.queryByTestId('sessions-view')).not.toBeNull(),
  );
  expect(tabs('right')).toEqual([
    ['Chat', 'false'],
    ['Activity', 'true'],
  ]);
  expect(current().model.regions.right.panes).toEqual(['chat', 'activity']);

  // A refusal: Home has no dock pane. Nothing moves, nothing is pushed.
  act(() => {
    outcome = current().open(WORKSPACE_HOME_PANE_INSTANCE, {
      region: 'right',
    });
  });
  expect(outcome).toEqual({ ok: false, reason: 'no-surface' });
  expect(tabs('right')).toEqual([
    ['Chat', 'false'],
    ['Activity', 'true'],
  ]);
  expect(pushes).not.toHaveBeenCalled();
  expect(new URLSearchParams(window.location.search).get('pane')).toBeNull();
  expect(screen.getByTestId('main-outlet')).toBeTruthy();
});

/**
 * #2049 review H1: a pane id is DATA now — it is read back from a stored
 * arrangement record — so the id-keyed resolver the shell mounts from and the
 * occurrence minter the host renders from must admit the same ids. While
 * `resolveRegionSurface` admitted by prefix presence alone, a malformed
 * same-prefix id mounted a shell whose entire content was the resize handle:
 * no pane, no tab strip, and therefore no close control.
 *
 * `placeSurface` is deliberately NOT what refuses it: `surfaceMayOccupy` lets
 * a surface it cannot resolve take a dock region (a fixture, a pane a later
 * slice registers at runtime), so the model may hold such an id — it just
 * renders nothing anywhere, exactly as any other unresolvable id does, and
 * `parseRegionArrangementRecord` drops it on the way back in
 * (`region-arrangement-record.test.ts`). The shell is where the user-visible
 * difference lives, so the shell is what this asserts.
 *
 * Reverting `InstanceSurfacePrefix.matches` to `startsWith(prefix)` fails at
 * the first `queryShell('right')` — the shell mounts. Refusing the WELL-FORMED
 * id (a shape rule too strict for what the minter mints) fails at the second.
 */
test('a malformed instance id mounts no shell, while the well-formed id it imitates does', async () => {
  render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <MainCaller />
          <RegionShells />
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
  await waitFor(() => expect(model).not.toBeNull());
  const queryShell = (region: string) =>
    document.querySelector<HTMLElement>(`.chat-dock[data-region="${region}"]`);
  const mountedRegions = () =>
    Array.from(document.querySelectorAll<HTMLElement>('.chat-dock')).map(
      (shell) => shell.dataset.region,
    );
  // Chat's own shell mounts asynchronously; capture the baseline once it has.
  await waitFor(() => expect(mountedRegions()).toEqual(['bottom']));
  const before = mountedRegions();

  for (const malformed of [
    'pr:not-a-real-id',
    'file-preview:zzz',
    // #2157: the Layout families, same rule.
    'board:coding',
    'layout:1d61ce22-7f4b-4282-86f0-019ef1bc223c',
  ]) {
    act(() => current().model.placeSurface(malformed, 'right'));
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(queryShell('right'), malformed).toBeNull();
    expect(mountedRegions(), malformed).toEqual(before);
  }

  act(() =>
    current().model.placeSurface(
      'pr:github.com/kontourai/station#2049',
      'right',
    ),
  );
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  expect(current().model.regions.right.occupant).toBe(
    'pr:github.com/kontourai/station#2049',
  );
  await waitFor(() => expect(queryShell('right')).not.toBeNull());
});
