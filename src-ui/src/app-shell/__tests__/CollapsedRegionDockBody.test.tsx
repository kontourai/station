/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
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
vi.mock('../../components/chat-dock/ChatDock', () => ({
  ChatDock: () => <div data-testid="chat-shell" />,
  renderAmbientChatPane: () => <div data-testid="chat-shell" />,
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

/**
 * A collapsed dock region is the bar alone — on every edge. Chat gets there
 * by unmounting its body; a non-chat occupant renders `.dock-slot__body`,
 * which nothing used to hide on the bottom, so a collapsed bottom dock kept
 * rendering the pane below the bar (the desktop `height: auto !important`
 * rule sizes the collapsed shell to its content). The fix is the same
 * mechanism the side rails got in the 2026-09-05 UX-audit pass, extended to
 * the bottom edge: one rule, every region.
 *
 * Both halves of the contract are pinned, because either alone proves
 * nothing: the LIVE DOM must actually put a `.dock-slot__body` inside a
 * `.chat-dock[data-region="bottom"].is-collapsed` (so the selector matches
 * what production mounts), and the stylesheet must declare `display: none`
 * for exactly that selector (jsdom applies no layout, so the class alone
 * proves nothing without the declarations it binds). The `height: auto`
 * rule is pinned alongside it because the pair is the mechanism: hiding the
 * body is what leaves `auto` sizing the collapsed dock to the bar.
 */
test('a collapsed bottom dock’s non-chat body is hidden by the shared collapsed rule', async () => {
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

  act(() => model?.placeSurface('activity', 'bottom'));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  await waitFor(() =>
    expect(model?.regions.bottom.occupant).toBe('activity'),
  );
  const occupant = await screen.findByTestId('sessions-view');
  const body = occupant.closest('.dock-slot__body');
  expect(body, 'the pane renders inside the shared scroll container').not.toBeNull();
  const shell = body?.closest('.chat-dock');
  expect(shell?.getAttribute('data-region')).toBe('bottom');
  expect(shell?.className).not.toContain('is-collapsed');

  // The real collapse write, the same one the chevron and the bar's own
  // surface reach (`applyDockSnap('collapsed')` → region `visible: false`).
  act(() => model?.setRegion('bottom', { visible: false }));
  await waitFor(() =>
    expect(shell?.className).toContain('is-collapsed'),
  );
  // The pane stays mounted behind the rule — state survives a collapse, and
  // the selector above is verified against the element it will hide.
  expect(occupant.closest('.chat-dock')).toBe(shell);

  const css = readFileSync(join(__dirname, '../../index.css'), 'utf-8');
  const [hideRule] = ruleBodiesFor(
    css,
    '.app__main > :is( [data-region="left"], [data-region="right"], [data-region="bottom"] ).is-collapsed .dock-slot__body',
  );
  expect(
    hideRule,
    'the collapsed-region body hide must cover the bottom edge too',
  ).toBeDefined();
  expect(hideRule).toMatch(/display:\s*none/);

  const [autoRule] = ruleBodiesFor(
    css,
    '.app__main > [data-region="bottom"].is-collapsed',
  );
  expect(
    autoRule,
    'the collapsed bottom dock must still size to its (now bar-only) content',
  ).toBeDefined();
  expect(autoRule).toMatch(/height:\s*auto\s*!important/);
});
