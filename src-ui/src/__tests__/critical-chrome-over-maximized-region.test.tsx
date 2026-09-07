/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { ruleBodiesFor } from './helpers/css-rules';

/**
 * #1132 — the two halves of "a blocking notice stays reachable over a
 * maximized region", each pinned by the technique that can actually see it.
 *
 * The rules are `:has()` selectors over a layout jsdom does not perform, so
 * nothing here renders them. The browser proof is
 * `tests/connect-reconnect-banner.spec.ts` ("keeps every banner control
 * hit-testable with a maximized right/bottom dock"), which clicks the cap and
 * hit-tests every control's own pixels. These guard the two things that spec
 * cannot report when it goes red: which declarations were deleted, and whether
 * the shell selector still matches a NON-Chat region.
 */

const UI_SRC = join(__dirname, '..');
const BANNER_CSS = readFileSync(
  join(UI_SRC, 'components/notifications/BannerHost.css'),
  'utf-8',
);
const MAXIMIZED = '.app__main:has(> .chat-dock.is-maximized)';
const CAP_RULE = `${MAXIMIZED} > .banner-host--critical-chrome .banner-host__cap`;
const CRITICAL_CARD_RULE = `${MAXIMIZED} > .banner-host--critical-chrome .banner-host__item--critical-chrome`;
const EXPANDED_HOST_RULE = `${MAXIMIZED} > .banner-host.banner-host--critical-chrome.banner-host--expanded`;

/**
 * SOURCE SCAN, not a render: `ruleBodiesFor` reads declarations out of the
 * stylesheet text. It proves the rules exist, carry the tiers this contract
 * depends on, and sit in the order those tiers depend on. It proves nothing
 * about painted stacking — jsdom evaluates neither `:has()` nor z-index.
 */
test('the cap crosses the dock beside the critical card, one tier below it', () => {
  const [cap] = ruleBodiesFor(BANNER_CSS, CAP_RULE);
  expect(
    cap,
    `missing rule: ${CAP_RULE} — without it the cap is the collapsed stack's only indicator and the maximized dock owns its pixels (#1132)`,
  ).toBeDefined();
  expect(cap).toMatch(/z-index:\s*calc\(var\(--layer-dock\)\s*\+\s*1\)/);

  const [card] = ruleBodiesFor(BANNER_CSS, CRITICAL_CARD_RULE);
  expect(card, `missing rule: ${CRITICAL_CARD_RULE}`).toBeDefined();
  // Strictly above the cap: the cap is tucked 8px under the card and is a
  // later sibling, so an equal tier paints its border over the card's edge.
  expect(card).toMatch(/z-index:\s*calc\(var\(--layer-dock\)\s*\+\s*2\)/);
});

/** Same technique, same limits: the declaration exists, not that it paints. */
test('an expanded critical stack crosses the dock whole', () => {
  const [expanded] = ruleBodiesFor(BANNER_CSS, EXPANDED_HOST_RULE);
  expect(
    expanded,
    `missing rule: ${EXPANDED_HOST_RULE} — without it, expanding the stack renders its ordinary cards visible and un-clickable over a maximized dock (#1132)`,
  ).toBeDefined();
  expect(expanded).toMatch(/z-index:\s*calc\(var\(--layer-dock\)\s*\+\s*1\)/);
  // The expanded escalation must outrank the `z-index: auto` the same host
  // carries while collapsed, which it does on specificity (0,6,0 vs 0,5,0).
  // jsdom will not cascade a `:has()` rule to tell us, so what is asserted is
  // that the collapsed rule still says `auto` — if it stopped, the escalation
  // would be arbitrating against a different value than this reasoning
  // assumes. (The startsWith check that used to sit here compared two local
  // literals and could not fail from any source change.)
  const [collapsedHost] = ruleBodiesFor(
    BANNER_CSS,
    `${MAXIMIZED} > .banner-host.banner-host--critical-chrome`,
  );
  expect(collapsedHost).toMatch(/z-index:\s*auto/);
});

vi.mock('../views/SessionsView', () => ({
  SessionsView: () => <div data-testid="sessions-view" />,
}));
// The Chat shell would mount the whole chat data stack; this file needs the
// region surface HOST, not what Chat renders inside it.
vi.mock('../components/chat-dock/ChatDock', () => ({
  ChatDock: () => <div data-testid="chat-shell" />,
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
 * RENDER, through the real host and the real maximize control. Since #1564 any
 * region can be maximized, and every rule above keys on
 * `.chat-dock.is-maximized` — a class named for Chat. `DockShell` is the one
 * shell for every occupant, so a maximized Activity region carries it too;
 * driving the real control is what makes that a fact rather than a reading of
 * `DockShell.tsx`.
 *
 * The compound is READ OUT OF THE STYLESHEET rather than retyped, so renaming
 * the shell class in `BannerHost.css` alone cannot leave this test asserting a
 * token the rules no longer use. `Element.matches` is exercised on the compound
 * only — the surrounding `:has()` is never evaluated here, and jsdom could not
 * evaluate it if it were.
 */
test('a maximized Activity region carries the shell class the rules key on', async () => {
  const shellSelector = /:has\(>\s*([^)]+)\)\s*>\s*\.banner-host/.exec(
    BANNER_CSS.slice(BANNER_CSS.indexOf('.app__main:has(> .chat-dock')),
  )?.[1];
  expect(
    shellSelector,
    'the maximized rules must still key on a compound shell selector',
  ).toBe('.chat-dock.is-maximized');
  const compound = shellSelector as string;

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

  fireEvent.click(
    within(activityShell).getByLabelText('Expand dock region to workspace'),
  );
  await waitFor(() => expect(model?.regions.right.maximized).toBe(true), {
    timeout: 10_000,
  });

  expect(
    activityShell.matches(compound),
    `a maximized Activity region must match "${compound}", the selector every #1132/#920 rule keys on`,
  ).toBe(true);
});
