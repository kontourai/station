/** @vitest-environment jsdom */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../tests/helpers/css-cascade-fixture';
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

const HERE = dirname(fileURLToPath(import.meta.url));

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
 * `.chat-dock[data-region="bottom"].is-collapsed`, and that DOM, laid out in
 * Chromium against the real `index.css`, must give the body no box and end
 * the dock at its bar (jsdom applies no layout, so the class alone proves
 * nothing). The bar-only height is the other half of the mechanism: hiding
 * the body is what leaves the desktop `height: auto` sizing the dock to it.
 */
test('a collapsed bottom dock’s non-chat body is hidden and the dock ends at its bar', async () => {
  render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <Probe />
          <div className="app app--with-sidebar">
            <div className="app__main">
              <RegionShells />
            </div>
          </div>
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
  await waitFor(() => expect(model).not.toBeNull());

  act(() => model?.placeSurface('activity', 'bottom'));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  await waitFor(() => expect(model?.regions.bottom.occupant).toBe('activity'));
  const occupant = await screen.findByTestId('sessions-view');
  const body = occupant.closest('.dock-slot__body');
  expect(
    body,
    'the pane renders inside the shared scroll container',
  ).not.toBeNull();
  const shell = body?.closest('.chat-dock');
  expect(shell?.getAttribute('data-region')).toBe('bottom');
  expect(shell?.className).not.toContain('is-collapsed');

  // The real collapse write, the same one the chevron and the bar's own
  // surface reach (`applyDockSnap('collapsed')` → region `visible: false`).
  act(() => model?.setRegion('bottom', { visible: false }));
  await waitFor(() => expect(shell?.className).toContain('is-collapsed'));
  // The pane stays mounted behind the rule — state survives a collapse, and
  // the selector above is verified against the element it will hide.
  expect(occupant.closest('.chat-dock')).toBe(shell);

  // jsdom applies no layout, so what the collapsed dock shows is measured in
  // Chromium against the real stylesheet and the DOM this host just produced.
  if (!chromiumIsInstalled(resolve(HERE, '../../../../'))) {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the ' +
        'collapsed dock could not be measured. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  }
  const markup = document.body.innerHTML;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    const css = resolveCssImports(resolve(HERE, '../../index.css'));
    assertNoImportsSurvive(css);
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body style="margin:0">${markup}</body></html>`,
    );
    const geometry = await page.evaluate(() => {
      const occupant = document.querySelector<HTMLElement>(
        '[data-testid="sessions-view"]',
      );
      const body = occupant?.closest<HTMLElement>('.dock-slot__body');
      const shell = body?.closest<HTMLElement>('.chat-dock');
      if (!occupant || !body || !shell) throw new Error('dock not serialized');
      // Real content the collapse has to hide, not an empty stub.
      const list = document.createElement('div');
      list.style.height = '600px';
      occupant.append(list);
      const bar = shell.querySelector<HTMLElement>('.chat-dock__header');
      if (!bar) throw new Error('collapsed dock has no bar');
      return {
        bodyBoxes: body.getClientRects().length,
        // How far the collapsed dock ends past its bar, less its own border.
        belowBar:
          shell.getBoundingClientRect().bottom -
          bar.getBoundingClientRect().bottom -
          Number.parseFloat(getComputedStyle(shell).borderBottomWidth),
      };
    });
    expect(
      geometry.bodyBoxes,
      'the collapsed dock must not lay out its pane body',
    ).toBe(0);
    // Two-sided: a dock taller than its bar shows a band below it, and one
    // shorter clips the bar's bottom edge.
    expect(
      Math.abs(geometry.belowBar),
      'the collapsed bottom dock must end at its bar',
    ).toBeLessThanOrEqual(0.5);
  } finally {
    await browser.close();
  }
});
