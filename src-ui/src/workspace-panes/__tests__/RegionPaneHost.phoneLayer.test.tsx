/** @vitest-environment jsdom */

/**
 * The phone layer's visible way back: while a pane is open over Chat on a
 * phone, the region's chrome bar carries a "‹ Chat" control, and pressing it
 * returns the region to Chat — the same as the device's Back
 * (`RegionModelContext-phone-layer.test.tsx` proves Back itself). Driven
 * through the shipped path, `RegionShells` → `RegionPaneHost` →
 * `RegionChromeBar`, with the harness `RegionPaneHost.regions.test.tsx` uses.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
import { MOBILE_MEDIA_QUERY } from '../../hooks/useIsMobile';
import { deviceSettingsStore } from '../../lib/device-settings-store';

/** Whether the Activity pane's stand-in holds an unsaved edit (gap G2). */
const activityDirty = vi.hoisted(() => ({ value: false }));
vi.mock('../../views/SessionsView', async () => {
  const { useUnsavedGuard } = await import('../../hooks/useUnsavedGuard');
  function SessionsView() {
    const { DiscardModal } = useUnsavedGuard(activityDirty.value);
    return (
      <div data-testid="sessions-view">
        <DiscardModal />
      </div>
    );
  }
  return { SessionsView };
});
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
  activityDirty.value = false;
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
  // A phone: 390px wide, coarse pointer, inside the mobile breakpoint.
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 390,
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === MOBILE_MEDIA_QUERY || query === '(pointer: coarse)',
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

test('a pane open over Chat on a phone shows "‹ Chat" in its bar, and pressing it returns to Chat', async () => {
  renderShells();
  await waitFor(() => expect(model).not.toBeNull());
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );
  // Chat selected: the phone's Chat header is Chat's bar, and no way back is
  // offered because there is nothing to go back from.
  expect(screen.queryByRole('button', { name: 'Back to Chat' })).toBeNull();

  act(() => currentModel().showSurface('activity'));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  await screen.findByTestId('sessions-view');
  // Over Chat, in Chat's own region — not a second shell.
  expect(currentModel().regions.bottom).toMatchObject({
    panes: ['chat', 'activity'],
    occupant: 'activity',
    maximized: true,
  });
  expect(document.querySelectorAll('.chat-dock')).toHaveLength(1);

  const back = screen.getByRole('button', { name: 'Back to Chat' });
  expect(back.textContent).toContain('Chat');
  fireEvent.click(back);
  await waitFor(() =>
    expect(currentModel().regions.bottom).toMatchObject({
      panes: ['chat'],
      occupant: 'chat',
      maximized: false,
    }),
  );
  await waitFor(() =>
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull(),
  );
  expect(screen.queryByRole('button', { name: 'Back to Chat' })).toBeNull();
  expect(currentModel().phoneLayer).toBeNull();
});

/**
 * Gap G2, through the shipped host: the region host scopes each pane's
 * `useUnsavedGuard` to its surface, so "‹ Chat" asks the layered pane's own
 * dirty guard — and an unrelated dirty guard elsewhere is never asked.
 */
test('"‹ Chat" asks the layered pane’s own dirty guard, and no one else’s', async () => {
  activityDirty.value = true;
  const unrelated = vi.fn();
  const unregister = navigationStore.registerNavigationGuard(
    Symbol('dirty-form-elsewhere'),
    unrelated,
  );
  try {
    renderShells();
    await waitFor(() => expect(model).not.toBeNull());
    act(() => currentModel().showSurface('activity'));
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    await screen.findByTestId('sessions-view');
    fireEvent.click(screen.getByRole('button', { name: 'Back to Chat' }));
    expect(
      await screen.findByRole('dialog', { name: /Unsaved Changes/ }),
    ).toBeTruthy();
    expect(unrelated).not.toHaveBeenCalled();
    expect(currentModel().regions.bottom.occupant).toBe('activity');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(currentModel().regions.bottom.occupant).toBe('chat'),
    );
    expect(unrelated).not.toHaveBeenCalled();
  } finally {
    unregister();
  }
});
