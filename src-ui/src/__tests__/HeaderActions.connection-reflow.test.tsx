/**
 * @vitest-environment jsdom
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { cleanup, render } from '@testing-library/react';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';

/**
 * archive#4474 — reproduces (and pins the fix for) "the connection-status
 * component reflows content" as it applies to `HeaderActions`' toolbar
 * connection chip (`ConnectionStatusDot` + `.app-toolbar__conn-state`,
 * `@kontourai/station-connect`'s `ConnectionStatusDot`), the ONE instance of
 * this status surface mounted on every page — see `HeaderActions.tsx`'s own
 * comment naming `ChatDockMobileConnection` as the mobile-dock twin, the
 * other consumer.
 *
 * jsdom does not lay out CSS (same precondition as
 * `BannerHost.touch-target.test.tsx` / `BannerHost.disclosure-overlap.test.tsx`),
 * so this renders the real `HeaderActions` component through
 * `@testing-library/react`, injects the resulting markup for several
 * connection states into a real Chromium page carrying the real, cascade-
 * resolved `index.css` + `components/chat/chat.css` (`.app-toolbar__conn*`
 * lives there, not in a component-local stylesheet — `HeaderActions.tsx`
 * imports no CSS of its own), and measures the actual rendered x-offset of a
 * fixed sibling control (`Open settings`, the last item in the action
 * cluster).
 *
 * Root cause: `.app-toolbar__conn-state` (`components/chat/chat.css`) was
 * `white-space: nowrap` with no reserved width, and the visible label text
 * differs in length across connection states ("Connected" vs "Reconnecting"
 * vs "Can't connect" vs "No Station" vs "Pair" — `HeaderActions.tsx`'s own
 * `connStateLabel`). `.app-toolbar__conn-name` (the identity chip, which
 * would otherwise be a second variable-width sibling) is hidden entirely
 * under the shell's mobile breakpoint (`index.css`, archive#3766), so on a
 * phone the STATE LABEL alone drives the connection chip's width — and every
 * other toolbar icon sitting after it in the same flex row
 * (`.app-toolbar__actions`) shifts horizontally when it changes.
 *
 * Two separate assertions, because the mobile breakpoint has a genuine,
 * documented exception this fix must not fight: `chat.css` deliberately
 * hides the state text for `connected`/`idle` on mobile ("the toolbar chip
 * stays compact … dot only while healthy"), so `connected` is narrower than
 * every news-carrying state THERE by design. The desktop-width test is the
 * full reproduction (state text is always shown, so `connected` participates
 * too); the phone-width test instead pins that the states which DO show text
 * on mobile agree with each other.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const INDEX_CSS_PATH = resolve(HERE, '../index.css');
const CHAT_CSS_PATH = resolve(HERE, '../components/chat/chat.css');

function buildFixtureCss(): string {
  const css = `${resolveCssImports(INDEX_CSS_PATH)}\n${resolveCssImports(CHAT_CSS_PATH)}`;
  assertNoImportsSurvive(css);
  return css;
}

let connectionStatus: 'connected' | 'connecting' | 'error' = 'connected';
let connectionReason: string | null = null;

vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  ConnectionStatusDot: ({ status }: { status: string }) => (
    <span data-testid="connection-status" data-state={status} />
  ),
  useConnectionStatus: () => ({
    status: connectionStatus,
    reason: connectionReason,
    recheck: vi.fn(),
  }),
// No pending record in this environment's real localStorage, so this
// never needs to be mocked to reach `awaiting-approval` — archive#4512
 // review wires `reason === 'awaiting-approval'` into
// `connectionIndicatorState` directly, which `renderMarkupForState` below
// reaches through `connectionReason` alone.
  useConnections: () => ({
    activeConnection: {
      id: 'c1',
      name: 'Default',
      lastSuccessAt: '2026-08-18T00:00:00.000Z',
      endpoints: [],
    },
    connections: [
      {
        id: 'c1',
        name: 'Default',
        lastSuccessAt: '2026-08-18T00:00:00.000Z',
        endpoints: [],
      },
    ],
  }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useAttentionQuery: () => ({ data: { items: [], pendingCount: 0 } }),
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ supervisesBundledServer: true }),
}));

vi.mock('../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => null,
}));

vi.mock('../components/notifications/NotificationHistory', () => ({
  NotificationHistory: () => null,
}));

vi.mock('../components/header/HelpMenu', () => ({ HelpMenu: () => null }));
vi.mock('../components/header/OverflowMenu', () => ({
  OverflowMenu: () => null,
}));

/**
 * Every label-bearing chip state, not just the original three — archive#4512
 * review widened this after `needs-repair` and `awaiting-approval`
 * shipped two labels LONGER than any this guard previously reproduced
 * ("Needs re-pairing" ≈97px, "Awaiting approval" ≈102px vs "Can't connect"
 * ≈81px), and a straight revert of the reserved-width bump these two
 * required stayed green here: nothing exercised the strings it was sized
 * for.
 */
type ChipState =
  | 'connected'
  | 'connecting'
  | 'error'
  | 'needs-credential'
  | 'needs-repair'
  | 'awaiting-approval';

function statusAndReasonFor(state: ChipState): {
  status: 'connected' | 'connecting' | 'error';
  reason: string | null;
} {
  switch (state) {
    case 'connected':
      return { status: 'connected', reason: null };
    case 'connecting':
      return { status: 'connecting', reason: null };
    case 'error':
      return { status: 'error', reason: 'unreachable' };
    case 'needs-credential':
      return { status: 'error', reason: 'authentication-failed' };
    case 'needs-repair':
      return { status: 'error', reason: 'identity-mismatch' };
    case 'awaiting-approval':
      return { status: 'error', reason: 'awaiting-approval' };
  }
}

async function renderMarkupForState(state: ChipState): Promise<string> {
  const { status, reason } = statusAndReasonFor(state);
  connectionStatus = status;
  connectionReason = reason;
  const { HeaderActions } = await import('../components/header/HeaderActions');
  const { container, unmount } = render(
    <HeaderActions
      helpPrompts={[]}
      settingsShortcut="⌘,"
      showHelp={false}
      showNotifications={false}
      showOverflow={false}
      userInitials="ST"
      onCloseHelp={() => {}}
      onCloseNotifications={() => {}}
      onCloseOverflow={() => {}}
      onHelpPrompt={() => {}}
      onOpenConnections={() => {}}
      onOpenProfile={() => {}}
      onToggleHelp={() => {}}
      onToggleNotifications={() => {}}
      onToggleSettings={() => {}}
      onToggleOverflow={() => {}}
      onViewAllNotifications={() => {}}
    />,
  );
  const markup = container.innerHTML;
  unmount();
  return markup;
}

function buildFixtureHtml(markup: string): string {
  const css = buildFixtureCss();
  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <style>${css}</style>
  </head>
  <body style="margin:0">${markup}</body>
</html>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'HeaderActions connection chip does not reflow sibling toolbar controls (station#4474)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser?.close();
    });

    afterEach(() => {
      cleanup();
    });

    async function settingsX(
      markup: string,
      viewport: { width: number; height: number },
    ): Promise<number> {
      const page = await browser.newPage({ viewport });
      try {
        await page.setContent(buildFixtureHtml(markup));
        const box = await page
          .locator('[aria-label="Open settings"]')
          .boundingBox();
        expect(box, 'Open settings control not visible').not.toBe(null);
        return box!.x;
      } finally {
        await page.close();
      }
    }

    test('the Settings control holds its position across every label-bearing state on a desktop-width toolbar', async () => {
// At desktop widths the state label is always visible (the mobile
// breakpoint's dot-only-while-healthy rule, below, does not apply), so
// this is the full reproduction of the reported class: every visibly
// different label this chip can show — including the two widest,
// "Needs re-pairing" and "Awaiting approval" — must not move any
// sibling control.
      const viewport = { width: 1280, height: 400 };
      const states: ChipState[] = [
        'connected',
        'connecting',
        'error',
        'needs-credential',
        'needs-repair',
        'awaiting-approval',
        'connected',
      ];
      const xs: number[] = [];
      for (const state of states) {
        xs.push(await settingsX(await renderMarkupForState(state), viewport));
      }

      expect(
        xs,
        'Settings control shifted horizontally as the connection chip flipped state — the chip must reserve its own width rather than reflow the rest of the toolbar.',
      ).toEqual(states.map(() => xs[0]));
    });

    test('news-carrying states agree on width at a phone viewport', async () => {
// On mobile, `index.css`'s own breakpoint intentionally hides the state
// text while `connected`/`idle` (dot only — "the toolbar chip stays
// compact on mobile … `idle` stays dot-only too", chat.css) — that is a
// deliberate, documented product decision this fix does not touch, so
// `connected` is deliberately excluded from this comparison. What is
// NOT deliberate: DIFFERENT news-carrying states ("Reconnecting" vs
// "Can't connect" vs "Needs re-pairing" vs "Awaiting approval", all
// shown) rendering at different widths for no reason, which is what
// the reported flips (connected → reconnecting → …) look like once
// the phone genuinely has something to say twice in a row with
// different wording. `needs-repair`/`awaiting-approval` are the two
// that archive#4512 added, and the ones this guard did not reproduce
 // before review widened it.
      const viewport = { width: 390, height: 200 };
      const states: ChipState[] = [
        'connecting',
        'error',
        'needs-credential',
        'needs-repair',
        'awaiting-approval',
      ];
      const xs: number[] = [];
      for (const state of states) {
        xs.push(await settingsX(await renderMarkupForState(state), viewport));
      }
      expect(xs).toEqual(states.map(() => xs[0]));
    });
  },
);

test.skipIf(chromiumAvailable)(
  'HeaderActions connection-chip reflow — Chromium not installed, cannot verify (station#4474)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the ' +
        'connection-chip reflow fix (station#4474) could not be checked — ' +
        'this is a missing precondition, not a passing check. Install it ' +
        'with `npm run install:playwright` and re-run.',
    );
  },
);
