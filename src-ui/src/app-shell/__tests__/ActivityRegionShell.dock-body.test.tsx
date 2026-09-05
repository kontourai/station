/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ruleBodiesFor } from '../../__tests__/helpers/css-rules';
import { KeyboardShortcutsProvider } from '../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import {
  RegionModelProvider,
  useRegionModel,
} from '../../contexts/RegionModelContext';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { RegionShells } from '../RegionShells';

vi.mock('../../views/SessionsView', () => ({
  SessionsView: () => <div data-testid="sessions-view" />,
}));
// The Chat shell would mount the whole chat data stack; `RegionShells` is
// here as the region surface HOST, not for what it renders inside Chat.
vi.mock('../../components/chat-dock/ChatDock', () => ({
  ChatDock: () => <div data-testid="chat-shell" />,
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

/**
 * #765 C1 regression pin, re-targeted at the region shell (#928 C2a moved
 * the legacy docked-Home case it used to ride on out of the ambient host).
 * On v0.1.2, docking a non-chat pane collapsed the dock to a title-only
 * strip: the occupant rendered outside the shared shell geometry, got no
 * height, no internal scroll, and no ⌘M — its content was unreachable until
 * un-docked. archive#4460 fixed this by making `DockShell` the single
 * geometry authority for EVERY occupant and wrapping each non-chat
 * occupant's content in `.dock-slot__body`, the one scroll container. Both
 * halves below are what "a docked non-chat pane is usable" derives from:
 *
 * 1. the occupant's content mounts INSIDE `.dock-slot__body` INSIDE the
 *    `.chat-dock` shell root (the element whose height DockShell drives);
 * 2. the `.dock-slot__body` stylesheet rule actually declares the
 *    height-bearing scroll mode (`flex`, `min-height: 0`, `overflow: auto`)
 *    — jsdom applies no layout, so the class alone proves nothing without
 *    the declarations it binds.
 *
 * Driven through the real host (`RegionShells`) and the real reveal
 * (`showSurface`), so the shell under test is the one production mounts.
 */
test('a non-chat dock occupant renders inside the height-bearing scroll container (#765 C1)', async () => {
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
  await waitFor(() => expect(model?.regions.right.occupant).toBe('activity'));
  const occupant = await screen.findByTestId('sessions-view');

  const body = occupant.closest('.dock-slot__body');
  expect(
    body,
    'the docked non-chat occupant must render inside `.dock-slot__body`, the shared scroll container',
  ).not.toBeNull();
  const shell = body?.closest('.chat-dock');
  expect(
    shell,
    'the scroll container must sit inside the `.chat-dock` shell whose height DockShell drives',
  ).not.toBeNull();
  expect(shell?.getAttribute('aria-label')).toBe('Activity');
  expect((shell as HTMLElement | null)?.dataset.region).toBe('right');

  const css = readFileSync(join(__dirname, '../../index.css'), 'utf-8');
  const [rule] = ruleBodiesFor(css, '.dock-slot__body');
  expect(
    rule,
    'index.css must still declare the `.dock-slot__body` rule',
  ).toBeDefined();
  expect(rule).toMatch(/flex:\s*1 1 auto/);
  expect(rule).toMatch(/min-height:\s*0/);
  expect(rule).toMatch(/overflow:\s*auto/);
});
