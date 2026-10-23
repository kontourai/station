/** @vitest-environment jsdom */

/**
 * The region's commands (move the shown pane, add a pane, maximize) as rows a
 * pane folds into its own overflow menu (`RegionMenu`). Driven through the
 * shipped path — `RegionShells` → `RegionPaneHost` → `RegionChromeSlotsProvider`
 * + `RegionChromeBar` — against the real region model, navigation and device
 * stores. Chat's renderer is stubbed by a pane that does what
 * `ChatDockHeader` does with the context: absorb the rows while mounted and
 * offer them as buttons. Activity's renderer absorbs nothing, so a bar showing
 * Activity keeps its own buttons.
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
import { KeyboardShortcutsProvider } from '../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';
import {
  RegionModelProvider,
  useRegionModel,
} from '../../contexts/RegionModelContext';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { useRegionChromeSlots } from '../RegionChromeSlots';

vi.mock('../../views/SessionsView', () => ({
  SessionsView: () => <div data-testid="sessions-view" />,
}));

function AbsorbingChatPane() {
  const menu = useRegionChromeSlots()?.regionMenu;
  const absorb = menu?.absorb;
  useEffect(() => absorb?.(), [absorb]);
  return (
    <div data-testid="ambient-chat-occupant">
      {(menu?.actions ?? []).map((row) => (
        <button
          key={row.key}
          type="button"
          data-region-row={row.key}
          onClick={(event) => row.onSelect(event.currentTarget)}
        >
          {row.label}
        </button>
      ))}
    </div>
  );
}

vi.mock('../../components/chat-dock/ChatDock', () => ({
  ChatDock: () => null,
  renderAmbientChatPane: () => <AbsorbingChatPane />,
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

async function mountShells() {
  render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <Probe />
          <RegionShells />
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  await waitFor(() => expect(model).not.toBeNull());
  await screen.findByTestId('ambient-chat-occupant');
}

function bar(): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    '.chat-dock .region-chrome',
  );
  if (!element) throw new Error('no region bar rendered');
  return element;
}

const rows = () =>
  [
    ...screen
      .getByTestId('ambient-chat-occupant')
      .querySelectorAll('[data-region-row]'),
  ].map((row) => row.textContent);

test('a pane that folds the region’s commands leaves the bar with only the grab and the chevron of its own', async () => {
  await mountShells();

  // The rows the pane offers: every region Chat may move to, the chooser,
  // and maximize.
  expect(rows()).toEqual([
    'Move to Left',
    'Move to Right',
    'Add pane…',
    'Maximize',
  ]);
  // The bar drops its buttons for exactly those commands...
  expect(within(bar()).queryByRole('button', { name: 'Move Chat' })).toBeNull();
  expect(within(bar()).queryByLabelText(/^Add pane to /)).toBeNull();
  expect(
    within(bar()).queryByLabelText('Expand dock region to workspace'),
  ).toBeNull();
  // ...and keeps the region's own grab and visibility control.
  expect(within(bar()).getByLabelText('Move the dock')).toBeTruthy();
  expect(within(bar()).getByLabelText('Hide Chat')).toBeTruthy();
});

test('the rows act on the region: maximize, then move the pane', async () => {
  await mountShells();

  fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
  await waitFor(() =>
    expect(currentModel().regions.bottom.maximized).toBe(true),
  );
  // The row follows the state it toggles.
  expect(
    await screen.findByRole('button', { name: 'Restore size' }),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Move to Right' }));
  await waitFor(() =>
    expect(currentModel().regions.right.panes).toContain('chat'),
  );
});

test('a pane that does not fold them (Activity) gets the bar’s own buttons back', async () => {
  await mountShells();
  act(() => currentModel().placeSurface('activity', 'bottom'));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  await screen.findByTestId('sessions-view');

  // Chat's pane unmounted with its tab, and released the rows.
  expect(screen.queryByTestId('ambient-chat-occupant')).toBeNull();
  expect(
    within(bar()).getByRole('button', { name: 'Move Activity' }),
  ).toBeTruthy();
  expect(within(bar()).getByLabelText('Add pane to Bottom')).toBeTruthy();
  expect(
    within(bar()).getByLabelText('Expand dock region to workspace'),
  ).toBeTruthy();
});
