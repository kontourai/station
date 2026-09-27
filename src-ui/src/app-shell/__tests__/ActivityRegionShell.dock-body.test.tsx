/** @vitest-environment jsdom */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
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
// Chat's pane would mount the whole chat data stack; `RegionShells` is here
// as the region surface HOST, not for what it renders inside Chat. Since
// #2045 the host renders Chat through `renderAmbientChatPane`, so that is
// the seam stubbed; `ChatDock` is the model-less mount this harness never
// takes.
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
  // #2047: the region host resolves the dock's project through this read;
  // no project here, so the panes that need one derive none.
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
 * 2. in Chromium, with the real cascade-resolved `index.css`, that body is
 *    bounded by the shell and scrolls a list taller than the dock instead of
 *    growing past it — jsdom applies no layout, so the class alone proves
 *    nothing about the geometry it binds.
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

  act(() => model?.showSurface('activity'));
  // This pin verifies host composition, not the chunk-loading deadline.
  await act(async () => {
    await vi.dynamicImportSettled();
  });
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

  // jsdom applies no layout, so the scroll mode is measured in Chromium
  // against the real stylesheet and the DOM this host just produced.
  if (!chromiumIsInstalled(resolve(HERE, '../../../../'))) {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the dock ' +
        'body could not be measured. Install it with ' +
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
      // A list far taller than any dock: the body must scroll it, not grow.
      const list = document.createElement('div');
      list.style.height = '4000px';
      occupant.append(list);
      body.scrollTop = 200;
      return {
        shellBottom: shell.getBoundingClientRect().bottom,
        bodyBottom: body.getBoundingClientRect().bottom,
        bodyHeight: body.clientHeight,
        scrollHeight: body.scrollHeight,
        scrollTop: body.scrollTop,
        // `hidden` also accepts a programmatic scrollTop but gives the user
        // no way to scroll, so the resolved mode is read too.
        overflowY: getComputedStyle(body).overflowY,
      };
    });
    expect(geometry.bodyHeight).toBeGreaterThan(0);
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.bodyHeight);
    expect(geometry.bodyBottom).toBeLessThanOrEqual(geometry.shellBottom);
    expect(geometry.scrollTop).toBe(200);
    expect(['auto', 'scroll']).toContain(geometry.overflowY);
  } finally {
    await browser.close();
  }
});
