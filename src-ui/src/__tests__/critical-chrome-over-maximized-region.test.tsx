/** @vitest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RegionShells } from '../app-shell/RegionShells';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../contexts/NavigationContext';
import {
  RegionModelProvider,
  useRegionModel,
} from '../contexts/RegionModelContext';
import { deviceSettingsStore } from '../lib/device-settings-store';

vi.mock('../views/SessionsView', () => ({
  SessionsView: () => <div data-testid="sessions-view" />,
}));
// The Chat shell would mount the whole chat data stack; this file needs the
// region surface HOST, not what Chat renders inside it.
// Since #2045 `RegionShells` renders Chat as a pane of the region's host
// through `renderAmbientChatPane`; `ChatDock` is the model-less mount this
// harness never takes.
vi.mock('../components/chat-dock/ChatDock', () => ({
  ChatDock: () => <div data-testid="chat-shell" />,
  renderAmbientChatPane: () => <div data-testid="chat-shell" />,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
}));
vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: [],
    isLoading: false,
    isConfirmedLoaded: true,
  }),
  // #2047: the region host resolves the dock's project through this read;
  // no project here, so the panes that need one derive none.
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

beforeEach(() => {
  model = null;
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1024,
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('maximizing Activity uses the shared dock shell', async () => {
  const compound = '.chat-dock.is-maximized';

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
  await waitFor(() => expect(model).not.toBeNull());

  act(() => model?.showSurface('activity'));
  await waitFor(() => expect(model?.regions.right.occupant).toBe('activity'), {
    timeout: 10_000,
  });
  // The pane behind this shell is lazy, and on a loaded machine the mount can
  // take longer than testing-library's 1s default — observed live, as an
  // "Activity shell never rendered" against a DOM holding only its skeleton.
  const activityShell = await waitFor(
    () => {
      const shell = document.querySelector<HTMLElement>(
        'section[aria-label="Activity"]',
      );
      if (!shell) throw new Error('Activity shell never rendered');
      return shell;
    },
    { timeout: 10_000 },
  );
  // Both directions: an un-maximized Activity region must NOT match, or the
  // assertion below would pass on a selector that matches every shell.
  expect(activityShell.matches(compound)).toBe(false);

  // Since #2045/#2055 the Activity pane mounts behind its own lazy boundary
  // INSIDE the shell (`renderActivityDockPane`), so the shell's section —
  // and its skeleton — exist one async hop before the header carrying the
  // expand control does. The section's existence says nothing about the
  // control's; wait for the control where it renders. (Observed live as a
  // deterministic red on pristine main: the click ran against a shell whose
  // pane boundary was still showing its skeleton.)
  fireEvent.click(
    await within(activityShell).findByLabelText(
      'Expand dock region to workspace',
      {},
      { timeout: 10_000 },
    ),
  );
  await waitFor(() => expect(model?.regions.right.maximized).toBe(true), {
    timeout: 10_000,
  });

  expect(
    activityShell.matches(compound),
    `a maximized Activity region must match "${compound}", the selector every #1132/#920 rule keys on`,
  ).toBe(true);
});
