import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  PUBLIC_STATION_HANDSHAKE_PATH,
  type PublicStationHandshake,
} from '@kontourai/station-contracts/environment-security';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { execFileSyncBounded } from '../scripts/lib/bounded-capture.mjs';
import { DIALOG_HISTORY_KEY } from '../src-ui/src/components/dialog-history';
import { buildLongSessionTurns } from './fixtures/long-session';
import { assertGalleryScreenSourcesCover } from './gallery-screen-sources.mjs';
import { createAuthenticatedE2ERequest } from './helpers/authenticated-request';
import {
  openDesktopChatInventory,
  phoneChatInventoryControls,
} from './helpers/chat-inventory';
import { contrastRatio } from './helpers/color-contrast';
import {
  agentConnectionFixture,
  modelConnectionFixture,
} from './helpers/connection-fixtures';
import { routeCoreUpdateCheck } from './helpers/core-update-route';
import { resolveE2EApiBase } from './helpers/e2e-target';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';
import {
  type AppErrorObservation,
  type AppErrorSurfaceCounts,
  type ControlBox,
  type ControlMovement,
  type ControlNameDiff,
  createFailedRequestLog,
  failedScreenReason,
  formatControlChangeTable,
  type GalleryFault,
  isChunkPath,
  READ_APP_ERROR_SURFACES,
  readGalleryFaults,
} from './helpers/gallery-app-error-state';
import {
  assertGalleryAssetScopeCapacity,
  createGalleryAssetDiagnostics,
  inventoryGalleryAssets,
  readGalleryLifecycle,
  retainGalleryAssetDiagnostics,
} from './helpers/gallery-asset-diagnostics';
import {
  createDocumentTracker,
  observeGalleryRequests,
} from './helpers/gallery-document-tracker';
import {
  captureScreens,
  failedScreenFields,
  MAX_SECOND_CAPTURES,
  readSettleWindow,
  type SecondCaptureRecord,
} from './helpers/gallery-screen-attempt';
import {
  auditGalleryScreen,
  type GalleryUiAudit,
} from './helpers/gallery-ui-audit';
import {
  emulateKeyboard,
  installKeyboardEmulation,
} from './helpers/keyboard-emulation';
import { memberProjectChannelScreens } from './helpers/member-project-channel-gallery';
import { openChooserFromToggle } from './helpers/region-placement';
import {
  GALLERY_DESIGN_ROOM_ID,
  installProjectConversationsFixture,
  installProjectRoomFixture,
  installTaskRoomFixture,
  LIVE_ROOM_SCENES,
  NAVIGATION_THREAD_ROOT,
  type ProjectRoomScene,
  type TaskRoomScene,
} from './helpers/room-gallery-fixtures';
import { mockRuntimeConversation } from './helpers/runtime-conversation-fixture';
import { runScreenshotCaptureSequence } from './helpers/screenshot-capture-sequence';

/**
 * Build gallery — an at-a-glance contact sheet of what the current build looks
 * like, regenerated on every screenshot-bucket run. Each screen is captured to
 * a stable file under `gallery/` (gitignored, overwritten each run) plus an
 * `index.html` grid, so a human (or agent) can glance at the whole UI without
 * clicking through it. Every declared surface must render; failures remain
 * visible as broken tiles in the gallery and also fail the test.
 *
 * Targeted capture (archive#4464): set `STATION_E2E_SCREENS` to a
 * comma-separated list of `SCREENS[].name` values to capture only that
 * subset. Through the runner, this ONLY works as
 * `npm run test:e2e:screenshot -- --screens=home,agents` — `run-e2e-suite.mjs`
 * deliberately clears any ambient `STATION_E2E_SCREENS` on the spawned
 * Playwright process (an explicit `undefined`, not a conditional spread) so
 * a stray env var can never silently partial an unflagged full run; see
 * `scripts/lib/e2e-runner-options.mjs`. `STATION_E2E_SCREENS` set directly in
 * the shell is honored only by a bare `npx playwright test
 * tests/screenshots.spec.ts` that bypasses the runner entirely — e.g.
 * `STATION_E2E_SCREENS=home,agents npx playwright test tests/screenshots.spec.ts` —
 * NOT by `npm run test:e2e:screenshot` (that command silently captures the
 * full gallery instead). `gallery/capture.json` records the requested subset
 * under `selection` (`null` for a full run) so a partial gallery can never be
 * mistaken for a full one downstream (e.g. by `scripts/screenshot-diff.mjs`,
 * which refuses to baseline a partial run without `--allow-partial`). An
 * unknown screen name fails the run loudly instead of silently capturing
 * nothing.
 */

// Full coverage supplies an isolated, run-scoped directory. Running this
// bucket directly intentionally retains the familiar gitignored gallery/.
const GALLERY_DIR = process.env.STATION_E2E_GALLERY_DIR
  ? resolve(process.env.STATION_E2E_GALLERY_DIR)
  : join(process.cwd(), 'gallery');
// Auxiliary screenshots live in a subdirectory: the gallery review requires
// every top-level PNG to be a capture.json screen, so extra files there fail
// the Nightly capture-coverage check (#3508).
const GALLERY_DIAGNOSTICS = 'diagnostics';

/**
 * Parses `STATION_E2E_SCREENS` into a requested-name list, or `null` when
 * unset/blank (meaning: capture everything). Blank/whitespace-only entries
 * are dropped rather than treated as a request for an empty-named screen.
 */
function parseRequestedScreens(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return names.length > 0 ? names : null;
}

const DESKTOP = { width: 1440, height: 900 } as const;
const MOBILE = { width: 390, height: 844 } as const;
const GALLERY_CONNECTION_ID = 'e2e-host';
const GALLERY_CONNECTION_NAME = 'Station E2E';
const GALLERY_ENVIRONMENT_ID = '00000000-0000-4000-8000-000000000531';

/**
 * station#531: seed the connection chip's complete visible derivation before
 * every navigation. The profile name is the identity rendered beside the
 * state; the environment ID makes this a real saved Station even before the
 * first probe records success. `location.origin` carries the runner's
 * isolated port, but HeaderActions never renders the URL or port.
 *
 * `addInitScript` registrations are page-lifetime global, like the routes in
 * the main test body: this one registration runs before app code on every
 * gallery navigation and resets any probe-written timestamps to the same
 * input shape without leaking a screen-scoped fixture.
 */
async function seedGalleryConnectionProfile(page: Page): Promise<void> {
  await page.addInitScript(
    ({ connectionId, connectionName, environmentId }) => {
      window.localStorage.setItem(
        'station-connect-connections',
        JSON.stringify([
          {
            profileVersion: 4,
            id: connectionId,
            name: connectionName,
            url: window.location.origin,
            environmentId,
            credentialRef: {
              credentialVersion: 1,
              kind: 'connection',
              id: connectionId,
            },
            credentialState: 'saved',
            // This fixture represents an already verified saved Station.
            // Do not race a successful probe to decide whether the mismatch
            // disclosure includes the cached-context explanation.
            lastSuccessAt: 1_700_000_000_000,
          },
        ]),
      );
      window.localStorage.setItem(
        'station-connect-connections-active',
        connectionId,
      );
    },
    {
      connectionId: GALLERY_CONNECTION_ID,
      connectionName: GALLERY_CONNECTION_NAME,
      environmentId: GALLERY_ENVIRONMENT_ID,
    },
  );
}

function fulfillGalleryStationHandshake(
  route: Route,
  boundedHistory = false,
  extraCapabilities: PublicStationHandshake['capabilities'] = {},
): Promise<void> {
  const capabilities = {
    ...(boundedHistory ? { sessionEventWindow: true } : {}),
    ...extraCapabilities,
  };
  return route.fulfill({
    json: {
      schemaVersion: 1,
      environmentId: GALLERY_ENVIRONMENT_ID,
      authentication: { scheme: 'bearer', protocolVersion: 1 },
      transports: { http: 1, sse: 1, websocket: 1 },
      ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
      compatibility: {
        serverVersion: '0.0.0-screenshot-gallery',
        protocolVersion: 1,
        minClientProtocol: 1,
        capabilities: {
          remoteAuth: 1,
          devicePairing: 1,
          environmentProof: 1,
        },
      },
    } satisfies PublicStationHandshake,
  });
}

function fulfillGalleryStationIdentity(route: Route): Promise<void> {
  return route.fulfill({
    json: {
      environmentId: GALLERY_ENVIRONMENT_ID,
      instanceId: 'screenshot-gallery-instance',
      bootId: 'screenshot-gallery-boot',
      sha: '0000000000000000000000000000000000000531',
    },
  });
}

async function fulfillGallerySystemStatus(route: Route): Promise<void> {
  const response = await route.fetch();
  const status = await response.json();
  if (!response.ok() || !status.devicePresentation)
    throw new Error('Gallery requires the live host presentation.');
  await route.fulfill({
    response,
    json: {
      ...status,
      devicePresentation: {
        ...status.devicePresentation,
        hostName: 'Gallery host',
      },
    },
  });
}

async function fulfillGalleryToolAccess(route: Route): Promise<void> {
  const response = await route.fetch();
  const access = await response.json();
  if (!response.ok() || !access.success || !access.data?.station?.name)
    throw new Error('Gallery requires the live tool-access projection.');
  await route.fulfill({
    response,
    json: {
      ...access,
      data: {
        ...access.data,
        station: { ...access.data.station, name: 'Gallery host' },
      },
    },
  });
}

function fulfillGalleryConnectionsFixture(route: Route): Promise<void> {
  if (route.request().method() !== 'GET') return route.fallback();
  return route.fulfill({
    json: {
      success: true,
      data: [
        {
          id: 'lancedb-builtin',
          kind: 'model',
          type: 'lancedb',
          name: 'Station Built-In',
          enabled: true,
          capabilities: ['vectordb'],
          // Existing Knowledge fixtures use this obviously fictional path;
          // unlike the real temp-home path, its bytes never carry a run ID.
          config: { dataDir: '/data/lancedb' },
          status: 'ready',
          prerequisites: [],
          lastCheckedAt: null,
        },
      ],
    },
  });
}

/**
 * The gallery seeds one connected profile. Pin its visible saved name and
 * accessible status before capturing so broken connection chrome cannot
 * become a baseline.
 */
async function assertGalleryConnectionChrome(page: Page): Promise<void> {
  const chip = page.getByTestId('app-toolbar-connection');
  await expect(chip).toHaveClass(/app-toolbar__conn--connected/, {
    timeout: 10_000,
  });
  await expect(chip).toHaveClass(/app-toolbar__conn--compact/);
  // The accessible name contains the visible saved name (WCAG 2.5.3).
  const visible = GALLERY_CONNECTION_NAME;
  const named = `Choose Station — Connected · ${visible}`;
  await expect(chip).toHaveAttribute('aria-label', named);
  await expect(chip).toHaveAttribute('title', named);
  await expect(chip.locator('.app-toolbar__conn-label')).toHaveText(visible);
  // Compact still means the separate state and name spans do not render; the
  // single short label replaces them.
  await expect(chip.locator('.app-toolbar__conn-state')).toHaveCount(0);
  await expect(chip.locator('.app-toolbar__conn-name')).toHaveCount(0);
  // The gallery is a browser E2E instance, never a supervised desktop
  // sidecar — and a sidecar's "App only" is news, so it would have kept the
  // full chip. Pinning its absence is also the premise for the compact form.
  await expect(chip.getByTestId('desktop-sidecar-indicator')).toHaveCount(0);
}

/**
 * Locator for the New Project dialog's full-screen overlay. `App.tsx`'s
 * home-route effect (`useEffect` gated on `window.location.pathname === '/'`)
 * can, under load, transiently resolve `/` through the `project-new` view
 * before the restored-project redirect settles (see `routing.ts`'s root-path
 * fallback and `App.tsx`'s home-route effect) — stacking this overlay on top
 * of whatever else is rendered underneath, including a screen mid-capture.
 * Any screen whose path is `/` (or that drives interactions while sitting on
 * `/`) should assert this overlay is absent immediately before its shot, so a
 * transient redirect can never be captured as the wrong tile (archive#192 —
 * see that issue for the reproduction).
 */
function newProjectOverlay(page: Page) {
  return page.locator('.new-project-modal__overlay');
}

/** Assert the New Project overlay is not covering the screen, with an
 * auto-retrying wait so a transient (self-resolving) flip doesn't fail a
 * screen that's actually fine a moment later. */
async function assertNoStrayProjectModal(page: Page, timeoutMs = 10_000) {
  await expect(newProjectOverlay(page)).toHaveCount(0, { timeout: timeoutMs });
}

/** How long a full navigation may wait for the app shell past the splash. */
const APP_SHELL_READY_TIMEOUT_MS = 20_000;

/**
 * Navigates and waits past the "Warming up" splash for the real app shell.
 * A screen's first navigation and any later full navigation in its own
 * `afterGoto` use this, so each gets the same budget (run 43671004780 failed
 * a child-chat reopen that waited 5 s with the splash still up).
 */
async function gotoAppShell(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      !!document.querySelector('.app') &&
      !document.body.textContent?.includes('Warming up'),
    undefined,
    { timeout: APP_SHELL_READY_TIMEOUT_MS },
  );
}

/**
 * Hides always-visible chrome/widget regions whose content is genuinely
 * environment/timing-dependent rather than a property of the page under
 * test, so re-capturing the identical build never perturbs the gallery
 * pixel-for-pixel (archive#4464):
 *
 *  - `.time-filter-wrapper` (MonitoringTimeControls.tsx, Developer →
 *    Telemetry): the whole relative/absolute time-window control —
 *    `.time-range-sublabel` alone (the absolute "Aug 26, 11:30 PM -> now"
 *    text, which literally renders `Date.now()`) turned out not to be the
 *    whole story; the visible "Last 5 min" preset label beside it also
 *    disagreed between two captures of the identical build, so the entire
 *    control is hidden rather than picking it apart further.
 *  - `.monitoring-summary` (MonitoringHeader.tsx, Developer → Telemetry):
 *    "Active sessions" / "Running turns" — both always read 0 on a fresh
 *    temp-home, but the row still measurably disagreed pixel-for-pixel
 *    between two captures (most plausibly reflowing by a sub-pixel amount
 *    alongside the time-filter control it sits beside).
 *  - `.status-badge` (MonitoringHeader.tsx, Developer → Telemetry): yet
 *    another live connected/connecting/disconnected/error dot, this one
 *    for the monitoring event stream specifically — the same class of
 *    noise as the header connection chip, just a second instance of it.
 *  - `.toast-card__time` (NotificationContainer.tsx): `formatTimestamp`'s
 *    relative "now" — the one remaining live-clock-derived label this
 *    gallery ever renders a toast for
 *    (`motion-reduced-notification`).
 *  - The Profile's completed rebuild timestamp. The unavailable-time
 *    fallback stays visible; only a live "Updated ..." timestamp is hidden.
 *  - `.chat-dock__mobile-conn` (ChatDockMobileHeader.tsx via
 *    `ChatDockMobileConnection.tsx`): the mobile chat dock's OWN
 *    connected/connecting/error/needs-credential indicator — the same
 *    class of live async race as `.app-toolbar__conn` above, just the
 *    phone-header instance of it rather than the desktop one (this suite's
 *    own coverage-expansion arc caught it live: two consecutive
 *    `mobile-onboarding-setup` captures of an identical build disagreed on
 *    ~30 pixels, localized to this dot, the moment a mobile screen was
 *    added late enough in the run for the race to actually land).
 *
 * CSS-hidden (not Playwright's screenshot `mask` option), so the gallery
 * itself stays clean for a human/design reviewer instead of getting an
 * opaque box stamped over it that a reviewer has to mentally discount on
 * every tile. Each label's text is fixed for the shot (no live state to vary
 * its width), so `visibility: hidden` preserves the row height exactly as
 * authored.
 *
 * #2059 removed the `.sidebar__footer-version` build stamp from the sidebar
 * footer, and its rule with it: the volatile text is no longer on screen, so
 * hiding it is not a thing this helper has to do.
 *
 * Must be called AFTER `page.goto` (a fresh navigation drops any
 * previously injected style tag) and as close to the shot as practical.
 */
async function hideVolatileChrome(page: Page) {
  await page
    .locator('.profile-usage-status span')
    .filter({ hasText: /^Updated / })
    .evaluateAll((elements) => {
      for (const element of elements) element.style.visibility = 'hidden';
    });
  await page.addStyleTag({
    content: `
      .time-filter-wrapper { visibility: hidden !important; }
      .monitoring-summary { visibility: hidden !important; }
      .status-badge { visibility: hidden !important; }
      .toast-card__time { visibility: hidden !important; }
      .chat-dock__mobile-conn { display: none !important; }
    `,
  });
  // `addStyleTag` resolves once the <style> element is inserted, not once
  // its rules have been applied and the resulting reflow/repaint has
  // settled — racing that gap intermittently let a shot catch a
  // just-hidden element's stale box for one more frame on one capture and
  // not the other, a residual few-dozen-pixel source of "changed" this
  // feature's own two-consecutive-runs acceptance check kept catching.
  // Two animation-frame ticks bound that gap without an arbitrary sleep.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/**
 * The dominant source of exact-pixel capture noise turned out to be neither
 * chrome region above: it was a race between the fixed post-navigation
 * settle wait and a live, first-boot fetch against a freshly started
 * `--temp-home` server. `Settings`, every `Connections` sub-tab, `Review`,
 * and others render a loading placeholder via the shared `@kontourai/ui`
 * `.skeleton` component (see `assertReducedMotion`'s
 * `motion-reduced-schedule-loading` usage below) until their first fetch
 * resolves — which one capture can catch mid-flight and the very next
 * capture, a few seconds later against warmer server caches, does not.
 * Two runs of an IDENTICAL build then disagree pixel-for-pixel over most of
 * the page, not because anything changed, but because they captured two
 * different lifecycle states of the same screen.
 *
 * Wait for the skeleton to clear before every shot except the one screen
 * that deliberately captures it (`expectSkeleton`).
 */
async function assertNoLoadingSkeleton(page: Page, timeoutMs = 15_000) {
  await expect(page.locator('.skeleton')).toHaveCount(0, {
    timeout: timeoutMs,
  });
}

async function assertReducedMotion(
  page: Page,
  selector: string,
  pseudo?: '::before' | '::after',
) {
  const element = page.locator(selector).first();
  await expect(element).toBeVisible({ timeout: 10_000 });
  const motion = await element.evaluate((node, pseudoElement) => {
    const style = getComputedStyle(node, pseudoElement ?? null);
    return {
      animationDuration: style.animationDuration,
      animationIterationCount: style.animationIterationCount,
      transitionDuration: style.transitionDuration,
    };
  }, pseudo);
  const durations = `${motion.animationDuration},${motion.transitionDuration}`
    .split(',')
    .map((value) => Number.parseFloat(value) || 0);
  expect(
    Math.max(...durations),
    `${selector} computed duration`,
  ).toBeLessThanOrEqual(0.00001);
  expect(
    motion.animationIterationCount
      .split(',')
      .every((value) => value === '1' || value === 'unset'),
    `${selector} animation iteration count`,
  ).toBe(true);
}

/**
 * The Customize list (`views/customize/CustomizeNav.tsx`, via
 * `useConnectionSectionSignals`) renders a live count on its items, including
 * Tools (`useIntegrationsQuery`, `GET /integrations`), the Knowledge dot
 * (`useGlobalKnowledgeStatusQuery`, `GET /api/knowledge/status`), and Skills
 * (`useSkillsQuery`, `GET /api/system/skills`). Before this list replaced the
 * Connections section rail, the same race was measured on Computers
 * (`GET /api/environments/ssh`), which the list no longer counts. None of the three is mocked (unlike
 * Models/Engines/sessions/action-operations above): each settles to a real,
 * deterministic value on a fresh temp-home (measured: Tools 2, Knowledge 1,
 * Computers 1 — matching what `connections-tools`/`connections-knowledge`
 * always captured, screens later in `SCREENS` whose shot never raced this),
 * but the FIRST navigation into the hub can still catch any of the three
 * pre-fetch "0" badge states ahead of the universal 1200ms settle wait,
 * which has no signal (no `.skeleton`) that a badge query is still in
 * flight. Two consecutive captures of an identical build then disagreed by
 * up to ~1,650 pixels on the hub screens (archive#4464 — the same
 * shape was caught again later on `connections` once more via the
 * Computers count, which this function had not yet armed) — not
 * rendering jitter, a genuine
 * pre-settle/settled content race. Arm the wait BEFORE navigation
 * (Playwright's own idiom elsewhere in this repo, e.g.
 * tests/agents-editor-roundtrip.spec.ts): arming it after `page.goto` could
 * miss a response that completes before the listener attaches.
 */
function armConnectionsHubBadgeSettle(page: Page): () => Promise<void> {
  // A silent timeout here would be worse than no guard at all: it would
  // still pay the full 15s wait on every one of the five hub screens, but
  // give zero signal that the guard has stopped doing anything (e.g. after
  // an endpoint rename) — the exact re-flake this function exists to catch
  // would then return with nobody able to tell why. Name the endpoint loudly
  // instead of swallowing the timeout.
  const integrationsSettled = page
    .waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname.endsWith('/integrations'),
      { timeout: 15_000 },
    )
    .catch(() => {
      console.warn(
        '[screenshots.spec] armConnectionsHubBadgeSettle: no GET */integrations ' +
          'response observed within 15s — the badge-settle guard did not fire ' +
          '(endpoint renamed/moved?). Proceeding without it.',
      );
      return undefined;
    });
  const knowledgeStatusSettled = page
    .waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/api/knowledge/status'),
      { timeout: 15_000 },
    )
    .catch(() => {
      console.warn(
        '[screenshots.spec] armConnectionsHubBadgeSettle: no */api/knowledge/status ' +
          'response observed within 15s — the badge-settle guard did not fire ' +
          '(endpoint renamed/moved?). Proceeding without it.',
      );
      return undefined;
    });
  // The Customize list also counts Skills, which nothing above waits for.
  const skillsSettled = page
    .waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname.endsWith('/api/system/skills'),
      { timeout: 15_000 },
    )
    .catch(() => {
      console.warn(
        '[screenshots.spec] armConnectionsHubBadgeSettle: no GET */api/system/skills ' +
          'response observed within 15s — the badge-settle guard did not fire ' +
          '(endpoint renamed/moved?). Proceeding without it.',
      );
      return undefined;
    });
  return async () => {
    await Promise.all([
      integrationsSettled,
      knowledgeStatusSettled,
      skillsSettled,
    ]);
  };
}

/**
 * Every Connections-hub screen below mounts the same shared tab bar, and
 * TanStack Query's default `staleTime: 0` (Tools, Knowledge) means each
 * fresh mount re-fetches those queries again rather than trusting an
 * earlier screen's cached result — and even the Computers query's 5s
 * `staleTime` doesn't save the very first hub navigation, whose initial
 * fetch is still in flight when the shot fires. The race
 * `armConnectionsHubBadgeSettle` guards against can land on ANY of these
 * five screens, not only the first one captured (measured live: it moved
 * from `connections`/`connections-models` in one run to
 * `connections-agent-apps` in the next after only those first two were
 * guarded, then resurfaced on `connections` again post-merge via the
 * then-unarmed Computers count). Returns a fresh `{ beforeGoto, afterGoto }`
 * pair per call so each screen gets its own independent arm/await slot.
 */
function connectionsHubBadgeSettleHooks(): Pick<
  Screen,
  'beforeGoto' | 'afterGoto'
> {
  let settle: () => Promise<void> = async () => {};
  return {
    beforeGoto: (page) => {
      settle = armConnectionsHubBadgeSettle(page);
      return Promise.resolve();
    },
    afterGoto: () => settle(),
  };
}

function fulfillScheduleSystemStatusFixture(route: Route): Promise<void> {
  return route.fulfill({
    json: {
      ready: true,
      acp: { connected: false, connections: [] },
      clis: {},
      prerequisites: [],
      providers: {
        configuredChatReady: true,
        configured: [],
        detected: { ollama: false, bedrock: false },
      },
    },
  });
}

function fulfillScheduleAgentsFixture(route: Route): Promise<void> {
  return route.fulfill({ json: { success: true, data: [] } });
}

function fulfillScheduleProvidersFixture(route: Route): Promise<void> {
  return route.fulfill({
    json: {
      success: true,
      data: [
        {
          id: 'built-in',
          displayName: 'Built-in Scheduler',
          capabilities: ['prompt'],
        },
      ],
    },
  });
}

function fulfillScheduleStatusFixture(route: Route): Promise<void> {
  return route.fulfill({
    json: {
      success: true,
      data: {
        providers: {
          'built-in': {
            id: 'built-in',
            displayName: 'Built-in Scheduler',
            running: true,
            healthy: true,
          },
        },
      },
    },
  });
}

function fulfillScheduleStatsFixture(route: Route): Promise<void> {
  return route.fulfill({
    json: {
      success: true,
      data: {
        providers: {},
        summary: { totalJobs: 0, totalRuns: 0, successRate: -1 },
      },
    },
  });
}

function fulfillScheduleJobsEmptyFixture(route: Route): Promise<void> {
  return route.fulfill({ json: { success: true, data: [] } });
}

/* Callers MUST capture the returned cleanup and run it in afterGoto's
   finally — `Screen.beforeGoto`'s void return type accepts a bare
   `seedScheduleScreenshotApi` shorthand that silently discards it,
   reinstating the cross-screen route leak this fixes (#573). */
async function seedScheduleScreenshotApi(
  page: Page,
): Promise<() => Promise<void>> {
  const cleanups = [
    await withRoute(
      page,
      '**/api/system/status',
      fulfillScheduleSystemStatusFixture,
    ),
    await withRoute(page, '**/api/agents', fulfillScheduleAgentsFixture),
    await withRoute(
      page,
      '**/scheduler/providers',
      fulfillScheduleProvidersFixture,
    ),
    await withRoute(page, '**/scheduler/status', fulfillScheduleStatusFixture),
    await withRoute(page, '**/scheduler/stats', fulfillScheduleStatsFixture),
    await withRoute(page, '**/scheduler/jobs', fulfillScheduleJobsEmptyFixture),
  ];
  return async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  };
}

async function fulfillScheduleLoadingJobsFixture(route: Route): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 15_000));
  await route.fulfill({ json: { success: true, data: [] } });
}

function fulfillScheduleGalleryJobFixture(route: Route): Promise<void> {
  return route.fulfill({
    json: {
      success: true,
      data: [
        {
          name: 'gallery-demo-job',
          provider: 'built-in',
          cron: '30 14 * * *',
          prompt: 'Demo job for the screenshot gallery.',
          enabled: true,
        },
      ],
    },
  });
}

function fulfillAgentsEmptyFixture(route: Route): Promise<void> {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data: [] }),
  });
}

/**
 * `sessions-filtered-empty`'s per-screen override of
 * `**\/api/orchestration/sessions/read-model` (archive#4501 — see that
 * screen's own doc comment). Named, not inline: `page.unroute(url)` called
 * with no handler argument removes EVERY route registered for that URL
 * pattern, not just the caller's own — tearing out the
 * main test body's GLOBAL empty-array mock for the same endpoint
 * (registered once, before the loop) sends every screen captured after this
 * one to the real (offline-during-E2E) dev server, which 500s
 * on it. Passing this same function reference to both `page.route` and the
 * later `page.unroute` removes only this handler, leaving the global one
 * intact for every other screen.
 */
async function _fulfillSessionsFilteredEmptyFixture(
  route: Route,
): Promise<void> {
  // `ProviderSession`/`OrchestrationSessionSummary`'s minimal wire-valid
  // shape (contracts/orchestration.ts, provider.ts), matching the field set
  // `SessionsView.test.tsx`'s own unit fixture already proves renders
  // without crashing. `projectSlug`/`delegation` deliberately omitted —
  // that disables `SessionPullRequestConflictChip` entirely (its query is
  // `enabled: Boolean(session.projectSlug)`) rather than needing a second
  // mocked endpoint.
  const backdated = new Date(
    Date.now() - 3.5 * 24 * 60 * 60 * 1000,
  ).toISOString();
  await route.fulfill({
    json: {
      success: true,
      data: [1, 2, 3].map((n) => ({
        provider: 'claude',
        threadId: `gallery-fixture-thread-${n}`,
        status: 'idle',
        lifecycleState: 'needs_input',
        controlMode: 'station-owned',
        answerability: { answerable: true },
        isLoaded: true,
        isPersisted: true,
        eventCount: n,
        // Backdated well past any minute/hour boundary a second capture
        // run (minutes later) could cross — `relativeTime.ts` buckets in
        // whole days past 24h, so both runs land on the same "3d ago" text
        // regardless of exactly when each ran.
        createdAt: backdated,
        updatedAt: backdated,
      })),
    },
  });
}

/**
 * Marker query param on this screen's own `path` (`/?${ONBOARDING_SETUP_RESET_MARKER}=1`)
 * — see `onboardingSetupBannerSettleHooks`'s doc comment for why the
 * storage-clearing init script gates on it rather than running
 * unconditionally on every navigation.
 */
const ONBOARDING_SETUP_RESET_MARKER = 'e2e-onboarding-setup-reset';

/**
 * Forces the SetupLauncher onboarding banner (`OnboardingGate.tsx`'s
 * `SetupLauncher`, rendered when `shouldRenderSetupLauncher` reads the
 * system status as unconfigured and the banner has not been dismissed this
 * session) — the mobile-onboarding screen's own state. On THIS suite's real
 * host the ambient `/api/system/status` answer does not trip that predicate
 * (a real dev machine tends to have at least one engine CLI installed), so
 * the desktop/mobile screens above never show it; this mirrors
 * `tests/onboarding-setup-banner.spec.ts`'s own "only vectordb providers
 * configured" fixture (its first case) rather than inventing a shape.
 *
 * Same race as `armConnectionsHubBadgeSettle` above: the universal 1200ms
 * post-navigation settle wait has no signal that THIS query is still in
 * flight (no `.skeleton` guards it), so a shot can fire before
 * `/api/system/status` has answered and `shouldRenderSetupLauncher` has had
 * a chance to flip — measured live, intermittently, in consecutive-run
 * checks. Returns a fresh `{ beforeGoto, waitSettled,
 * cleanup }` triple, the same arm-before-navigate shape
 * `connectionsHubBadgeSettleHooks` uses, so the wait is armed before the
 * response it is racing can occur.
 *
 * Both registrations below must not leak past this one
 * screen for the rest of the page-long-lived run —
 *  - the `**\/api/system/status` route, exactly `withRoute`'s documented
 *    leak class (see its own doc comment above): fixed the same way, by
 *    handing the caller a named cleanup to `page.unroute` in `afterGoto`'s
 *    `finally`.
 *  - the storage-clearing `page.addInitScript`, which has NO removal API at
 *    all (`page.route`/`addInitScript` both "ACCUMULATE across every
 *    `beforeGoto` in this same, page-long-lived gallery run" —
 *    `clearDockGalleryStorage`'s doc comment) — left unconditional, it
 *    would silently wipe `station-device-settings-v1` on EVERY later
 *    navigation in the run, not just this screen's own, resetting any
 *    later screen's onboarding-dismissed/device-settings state out from
 *    under it. Self-gated instead, on the `ONBOARDING_SETUP_RESET_MARKER`
 *    query param this screen's own `path` carries: the init script reads
 *    `location.search` at document-start (before the app's router has run,
 *    so the ORIGINAL requested URL, not whatever the client-side router
 *    might later normalize it to) and only clears storage when the marker
 *    is present — true only for a navigation to THIS screen's own URL, so
 *    the accumulated script is an inert no-op on every subsequent
 *    navigation to any other screen's path.
 */
function onboardingSetupBannerSettleHooks(): {
  beforeGoto: (page: Page) => Promise<void>;
  /** Await inside a screen's own `afterGoto`, before its own assertions. */
  waitSettled: () => Promise<void>;
  /** Call in the screen's own `afterGoto` `finally` — see `withRoute`'s doc comment. */
  cleanup: () => Promise<void>;
} {
  let settle: () => Promise<void> = async () => {};
  let unroute: () => Promise<void> = async () => {};
  const statusHandler = (route: Route) =>
    route.fulfill({
      json: {
        ready: false,
        prerequisites: [],
        acp: { connected: false, connections: [] },
        providers: {
          configuredChatReady: false,
          configured: [
            {
              id: 'lancedb-builtin',
              type: 'lancedb',
              enabled: true,
              capabilities: ['vectordb'],
            },
          ],
          detected: { ollama: false, bedrock: false },
        },
        recommendation: {
          code: 'unconfigured',
          type: 'connections',
          actionLabel: 'Open Customize',
          title: 'No usable AI path is configured yet',
          detail:
            'Start Ollama locally or add a provider/runtime connection to make Station ready for first-run chat.',
        },
        clis: {},
      },
    });
  return {
    beforeGoto: async (page) => {
      const armed = page
        .waitForResponse(
          (response) =>
            response.request().method() === 'GET' &&
            new URL(response.url()).pathname.endsWith('/api/system/status'),
          { timeout: 15_000 },
        )
        .then(() => undefined)
        .catch(() => {
          console.warn(
            '[screenshots.spec] onboardingSetupBannerSettleHooks: no GET ' +
              '*/api/system/status response observed within 15s — the ' +
              'settle guard did not fire. Proceeding without it.',
          );
          return undefined;
        });
      settle = () => armed;
      unroute = await withRoute(page, '**/api/system/status', statusHandler);
      await page.addInitScript((marker) => {
        if (!new URLSearchParams(location.search).has(marker)) return;
        // Clears BOTH the legacy flat key (`onboarding-setup-banner.spec.ts`'s
        // own recipe) AND the durable envelope key
        // (`station-device-settings-v1`,
        // src-ui/src/lib/device-settings-store.ts) that legacy key
        // one-time-migrates into. The runner's own Playwright
        // `storageState` (tests/helpers/e2e-browser-storage-state.ts)
        // seeds the legacy key to '1' for every screen in this suite, and
        // `deviceSettingsStore`'s migration runs (and deletes the legacy
        // key) on whichever screen constructs it FIRST in this shared
        // page's run — measured live: with `mobile-connections` captured
        // before this screen, the legacy key was already gone and the
        // envelope already carried `onboardingSetupDismissed: true` by
        // the time this screen's `beforeGoto` ran, so clearing only the
        // legacy key here was a no-op and the launcher never appeared.
        // Clearing the envelope too makes this screen's own state
        // independent of which screens ran before it.
        window.localStorage.removeItem('station:onboarding-setup-dismissed');
        window.localStorage.removeItem('station-device-settings-v1');
      }, ONBOARDING_SETUP_RESET_MARKER);
    },
    waitSettled: () => settle(),
    cleanup: () => unroute(),
  };
}

/**
 * archive#4521: a deterministic NOT-RUNNABLE agent — Station's own engine,
 * no LLM provider connection at all — for the three gallery screens that
 * stage the readiness notice, its popover, and the mobile save footer. The
 * defect class this fixes (the header's "wall of yellow text", a notice
 * with no route to its remedy, an orphaned popover, a duplicate save row)
 * was invisible to the gallery before this: `agent-editor` only ever
 * captures the CREATE flow (`/agents/new`), whose `titleAccessory` is
 * `undefined` while `isCreating` — none of the readiness chip, the
 * notRunnable banner, or "More actions" render there at all.
 */
const GALLERY_NOT_RUNNABLE_AGENT_SLUG = 'gallery-not-runnable-agent';

function notRunnableGalleryAgent(): Record<string, unknown> {
  return {
    slug: GALLERY_NOT_RUNNABLE_AGENT_SLUG,
    name: 'Support Agent',
    prompt: 'You are a support agent that helps customers.',
    // archive#4521: `execution` OMITTED, not an empty-string object —
    // the real wire shape for a Station agent that was never bound to a
    // connection (enriched-agents.ts's `execution: spec.execution`, and an
    // unconfigured spec's `execution` is `undefined`).
    available: false,
    unavailableReason: 'No enabled LLM provider connection is configured.',
    unavailableFix: { kind: 'model-connection' },
  };
}

/**
 * `**\/api/agents` already carries a GLOBAL mock (main test body, `data: []`
 * — the empty default every screen gets unless it overrides) — registering
 * a SECOND handler for the identical pattern stacks it (the most-recently-
 * added handler runs first), which is what lets this one-agent list win for
 * exactly the screens that ask for it. Named, not inline, for the same
 * reason `fulfillSessionsFilteredEmptyFixture` is: `page.unroute(url)` with
 * no handler argument removes EVERY handler registered for that pattern,
 * not just the caller's own, and would tear out the global empty-list mock
 * too — passing this SAME reference to both `page.route` and the cleanup's
 * `page.unroute` removes only this one.
 */
async function fulfillNotRunnableAgentList(route: Route): Promise<void> {
  if (route.request().method() !== 'GET') {
    await route.fallback();
    return;
  }
  await route.fulfill({
    json: { success: true, data: [notRunnableGalleryAgent()] },
  });
}

async function fulfillNotRunnableAgentDetail(route: Route): Promise<void> {
  await route.fulfill({
    json: { success: true, data: notRunnableGalleryAgent() },
  });
}

/**
 * `GET /agents/:slug/tools` answers with an ARRAY of live `Tool` rows
 * (`agent-tools.ts`'s own `data: tools.map(...)`), not the agent's
 * authored `toolsConfig` shape (`{mcpServers, available, autoApprove}`) —
 * conflating the two crashed `groupAgentToolsByServer` (`agentsViewUtils.ts`:
 * `for (const tool of agentTools)`) with "TypeError: n is not iterable"
 * the first time this fixture shipped. An empty array is a materialized
 * agent with no live tools, which this fixture genuinely is.
 */
async function fulfillNotRunnableAgentTools(route: Route): Promise<void> {
  await route.fulfill({ json: { success: true, data: [] } });
}

/**
 * Registers the list/detail/tools mocks this fixture needs. `page.route`
 * handlers persist across `page.goto()` for the page's whole lifetime (see
 * `fulfillSessionsFilteredEmptyFixture`'s doc comment above) — every screen
 * using this fixture MUST unroute with `cleanupNotRunnableAgentApi` in its
 * own `afterGoto`, or the single-fixture agent list leaks into every screen
 * captured after it in the same run (breaking `agents`/`agents-empty`/the
 * real `agent-editor` create flow, all of which expect the global empty
 * default).
 */
async function seedNotRunnableAgentApi(page: Page): Promise<void> {
  await page.route('**/api/agents', fulfillNotRunnableAgentList);
  await page.route(
    `**/api/agents/${GALLERY_NOT_RUNNABLE_AGENT_SLUG}`,
    fulfillNotRunnableAgentDetail,
  );
  await page.route(
    `**/agents/${GALLERY_NOT_RUNNABLE_AGENT_SLUG}/tools`,
    fulfillNotRunnableAgentTools,
  );
}

async function cleanupNotRunnableAgentApi(page: Page): Promise<void> {
  await page.unroute('**/api/agents', fulfillNotRunnableAgentList);
  await page.unroute(
    `**/api/agents/${GALLERY_NOT_RUNNABLE_AGENT_SLUG}`,
    fulfillNotRunnableAgentDetail,
  );
  await page.unroute(
    `**/agents/${GALLERY_NOT_RUNNABLE_AGENT_SLUG}/tools`,
    fulfillNotRunnableAgentTools,
  );
}

/**
 * archive#4525: the FIRST call in every screen below that
 * touches dock-project state. `page.addInitScript` registrations ACCUMULATE
 * across every `beforeGoto` in this same, page-long-lived gallery run, and
 * localStorage/sessionStorage themselves persist across `page.goto()` on
 * one page — a later screen does not reliably start from a clean slate
 * (pre-seeding the persisted project binding directly via
 * `page.addInitScript` works in isolation but reliably races the app's own
 * project-confirmation effect immediately after a PRIOR screen's seed —
 * hence these screens drive the binding through the real picker
 * interaction instead; and a seeded chat session can bleed into the following
 * screen's Home sidebar). Clearing first, on every one of these screens, is
 * what makes each one self-contained regardless of gallery run order.
 */
function clearDockGalleryStorage(page: Page) {
  return page.addInitScript(() => {
    window.localStorage.removeItem('station-device-settings-v1');
    window.sessionStorage.removeItem('activeChats');
  });
}

/**
 * archive#4525: seeds one persisted "open chat" — the exact
 * sessionStorage shape `src-ui/src/contexts/active-chats-store.ts` reads on
 * construction (`PersistedActiveChat[]`) — so the dock has a real ACTIVE
 * SESSION to derive its facts row from. Paired with `?chat=<conversationId>`
 * on the screen's `path` (`useChatDockActiveChatSync` resolves the URL
 * pointer against exactly this shape).
 */
function seedActiveChatSession(
  page: Page,
  session: {
    /**
     * `usePruneActiveChats.ts`'s canonical-provider reconciliation path
     * only skips deleting an entry it cannot durably verify when
     * `conversationId === sessionId` AND `provider` is set (and not
     * `'bedrock'`) — otherwise it tries to durably confirm the entry via
     * `fetchAgentConversationPage(agentSlug, …)` against the REAL backend
     * (a fixture `agentSlug` matches nothing there) and PRUNES it within
     * the first render pass — the seeded chat then vanishes from
     * sessionStorage before the shot, and the mismatch state never
     * renders at all.
     */
    conversationId: string;
    agentSlug: string;
    title: string;
    projectSlug?: string;
    projectName?: string;
    urlScoped?: boolean;
  },
) {
  return page.addInitScript((entry) => {
    if (
      entry.urlScoped &&
      new URLSearchParams(location.search).get('chat') !== entry.conversationId
    )
      return;
    window.sessionStorage.setItem(
      'activeChats',
      JSON.stringify([
        {
          sessionId: entry.conversationId,
          conversationId: entry.conversationId,
          agentSlug: entry.agentSlug,
          provider: 'claude',
          createdAt: Date.now(),
          title: entry.title,
          projectSlug: entry.projectSlug,
          projectName: entry.projectName,
          queuedMessages: [],
          inputHistory: [],
        },
      ]),
    );
  }, session);
}

/**
 * Registers `handler` for `pattern` and returns the matching cleanup —
 * `page.unroute(pattern, handler)` — bound as a zero-argument function.
 * `page.route`/`page.addInitScript` registrations both ACCUMULATE across
 * every `beforeGoto` in this same, page-long-lived gallery run (see
 * `clearDockGalleryStorage`'s doc comment for the storage half of this;
 * `fulfillSessionsFilteredEmptyFixture`'s doc comment for the established
 * per-screen `page.route`-override-then-unroute idiom this generalizes).
 * Every screen below that registers a route MUST call the returned cleanup
 * in `cleanup` or `afterGoto`'s `finally`, or its fixture — a project list, a durable
 * session — leaks into every screen captured after it for the rest of the
 * run (a stray "Demo Project" can survive three screens later
 * and change Home's guidance-card content under an unrelated screen name).
 */
async function withRoute(
  page: Page,
  pattern: string,
  handler: (route: Route) => Promise<void> | void,
): Promise<() => Promise<void>> {
  await page.route(pattern, handler);
  return () => page.unroute(pattern, handler);
}

/**
 * `GET /api/orchestration/sessions/read-model` fixture overriding the
 * gallery's global empty-array mock (registered once, before every screen)
 * with one durable session — the canonical-provider reconciliation path
 * `seedActiveChatSession` pairs with needs to durably CONFIRM the fixture
 * chat via this endpoint or it prunes it as unconfirmed.
 */
function orchestrationSessionFixture(session: {
  threadId: string;
  cwd?: string;
}): (route: Route) => Promise<void> {
  return (route) =>
    route.fulfill({
      json: {
        success: true,
        data: [
          {
            provider: 'claude',
            threadId: session.threadId,
            status: 'idle',
            lifecycleState: 'needs_input',
            controlMode: 'station-owned',
            answerability: { answerable: true },
            isLoaded: true,
            isPersisted: true,
            eventCount: 1,
            cwd: session.cwd,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        ],
      },
    });
}

/** Real ChatDock wiring: failed reads recover once, with pending responses held. */
async function verifyConversationRecovery(page: Page): Promise<void> {
  const testInfo = test.info();
  const width = page.viewportSize()!.width;
  const resync = page.getByRole('button', {
    name: 'Status unavailable — resync this conversation',
    exact: true,
  });
  const box = await resync.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  if (width === 390) expect(box!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: join(
      GALLERY_DIR,
      GALLERY_DIAGNOSTICS,
      `freshness-failed-${width}.png`,
    ),
    animations: 'disabled',
  });
  if (width > 600) {
    const row = page
      .locator('.chat-dock-inbox [data-testid="inbox-row"]')
      .filter({ hasText: 'Mismatch demo chat' });
    await expect(row.getByTestId('inbox-row-status')).toContainText(
      'Last known:',
    );
    await expect(row.locator('.inbox-row__status-glyph')).toHaveCSS(
      'animation-name',
      'none',
    );
    await expect(row.locator('.inbox-row__elapsed')).toHaveCount(0);
  } else {
    await page.getByRole('button', { name: /^(Inbox|Back to chat)$/ }).click();
    const picker = page.getByRole('region', { name: 'Chats', exact: true });
    await expect(picker.getByTestId('inbox-row-status')).toBeInViewport();
    await expect(picker.getByTestId('inbox-row-status')).toContainText(
      'Last known:',
    );
    await page.screenshot({
      path: join(
        GALLERY_DIR,
        GALLERY_DIAGNOSTICS,
        `freshness-failed-picker-${width}.png`,
      ),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
  }
  await mockRuntimeConversation(page, {
    id: 'gallery-mismatch-conversation',
    agentSlug: 'demo-agent',
    title: 'Mismatch demo chat',
    provider: 'claude',
    model: 'test-model',
    projectSlug: 'project-b',
    canContinue: true,
    turns: () =>
      buildLongSessionTurns({
        threadId: 'gallery-mismatch-conversation',
        provider: 'claude',
        turnCount: 1,
        replyText: () => 'Recovered conversation transcript',
      }),
  });
  // This synthetic conversation is absent from the real server's snapshot.
  // Keep its SSE transport open during recovery; the HTTP reads below still
  // pass through the real SDK and ChatDock owners to explicit route fixtures.
  await page.evaluate(() => {
    const scope = window as Window & { __recoveryFetch?: typeof fetch };
    scope.__recoveryFetch = window.fetch;
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url, location.href).pathname !== '/api/orchestration/events')
        return original(input, init);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.close(), {
              once: true,
            });
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    };
  });
  try {
    let historyFailed = true;
    let historyReads = 0;
    let releaseHistory!: () => void;
    const historyPending = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    const removeHistory = await withRoute(
      page,
      '**/api/orchestration/conversations/gallery-mismatch-conversation/event-window**',
      async (route) => {
        if (route.request().method() !== 'GET')
          return rejectUnexpectedFixtureRequest(route);
        historyReads++;
        if (historyFailed) {
          await route.fulfill({
            status: 503,
            json: {
              success: false,
              error: 'Recovery fixture history unavailable',
            },
          });
          return;
        }
        await historyPending;
        await route.fallback();
      },
    );
    let releaseOpen!: () => void;
    const openPending = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let openReads = 0;
    const removeOpen = await withRoute(
      page,
      '**/api/conversations/gallery-mismatch-conversation/open',
      async (route) => {
        if (route.request().method() !== 'GET')
          return rejectUnexpectedFixtureRequest(route);
        openReads++;
        await openPending;
        await route.fallback();
      },
    );
    try {
      await resync.click();
      const pending = page.getByRole('button', {
        name: 'Resyncing conversation — resync this conversation',
        exact: true,
      });
      await expect(pending).toBeDisabled();
      await expect(pending).toHaveAttribute('aria-busy', 'true');
      await expect(
        page.getByRole('status').filter({ hasText: 'Resyncing conversation' }),
      ).toBeAttached();
      await expect.poll(() => openReads).toBe(1);
      for (let i = 0; i < 5; i++) await page.keyboard.press('Enter');
      expect(openReads).toBe(1);
      await page.screenshot({
        path: testInfo.outputPath(`resync-pending-${width}.png`),
      });
      releaseOpen();
      await expect(
        page.getByText(
          "Station couldn't confirm Mismatch demo chat can continue.",
          { exact: true },
        ),
      ).toBeHidden();
      await expect(pending).toBeHidden();
      expect(openReads).toBe(1);
      const historyNotice = page.getByRole('alert').filter({
        hasText: 'Session history is unavailable.',
      });
      await expect(historyNotice).toBeVisible({ timeout: 15_000 });
      await expect(historyNotice).toContainText('Try again in a moment.');
      await expect(
        historyNotice.getByRole('button', { name: 'Retry', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText('Recovery fixture history unavailable', {
          exact: false,
        }),
      ).toHaveCount(0);
      const failedHistoryReads = historyReads;
      expect(failedHistoryReads).toBeGreaterThan(0);
      historyFailed = false;
      await resync.click();
      await expect(pending).toBeDisabled();
      await expect.poll(() => historyReads - failedHistoryReads).toBe(1);
      for (let i = 0; i < 5; i++) await page.keyboard.press('Enter');
      expect(historyReads - failedHistoryReads).toBe(1);
      releaseHistory();
      await expect(
        page.getByText('Recovered conversation transcript', { exact: true }),
      ).toBeVisible();
      await expect(historyNotice).toBeHidden();
      await expect(resync).toBeHidden();
      await expect(
        page.getByRole('group', { name: 'Message composer', exact: true }),
      ).toBeFocused();
      await expect(
        page.getByRole('status').filter({ hasText: 'Conversation resynced.' }),
      ).toBeAttached();
      await page.screenshot({
        path: testInfo.outputPath(`resync-recovered-${width}.png`),
      });
      // A successful history read cannot clear the independently failed inventory.
      if (width > 600) {
        const row = page
          .locator('.chat-dock-inbox [data-testid="inbox-row"]')
          .filter({ hasText: 'Mismatch demo chat' });
        await expect(row.getByTestId('inbox-row-status')).toContainText(
          'Last known:',
        );
      }
      await page.screenshot({
        path: join(
          GALLERY_DIR,
          GALLERY_DIAGNOSTICS,
          `freshness-recovered-${width}.png`,
        ),
        animations: 'disabled',
      });
      if (width === 390) {
        await page
          .getByRole('button', { name: /^(Inbox|Back to chat)$/ })
          .click();
        const picker = page.getByRole('region', { name: 'Chats', exact: true });
        await expect(picker.getByTestId('inbox-row-status')).toBeInViewport();
        // History recovery cannot clear the independent failed inventory.
        await expect(picker.getByTestId('inbox-row-status')).toContainText(
          'Last known:',
        );
        await page.screenshot({
          path: join(
            GALLERY_DIR,
            GALLERY_DIAGNOSTICS,
            `freshness-recovered-picker-${width}.png`,
          ),
          animations: 'disabled',
        });
        await page.keyboard.press('Escape');
        await expect(picker).toBeHidden();
      }
      expect(historyReads - failedHistoryReads).toBe(1);
      console.log('HISTORY_RECOVERY_REQUEST_COUNTS', {
        width,
        failedHistoryReads,
        replacementReads: historyReads - failedHistoryReads,
      });
    } finally {
      releaseOpen();
      releaseHistory();
      await removeOpen();
      await removeHistory();
    }
    if (width > 600) {
      let releaseInventory!: () => void;
      const inventoryPending = new Promise<void>((resolve) => {
        releaseInventory = resolve;
      });
      let inventoryReads = 0;
      const removeInventory = await withRoute(
        page,
        '**/api/conversations**',
        async (route) => {
          if (new URL(route.request().url()).pathname !== '/api/conversations')
            return route.fallback();
          if (route.request().method() !== 'GET')
            return rejectUnexpectedFixtureRequest(route);
          inventoryReads++;
          await inventoryPending;
          await route.fulfill({
            json: { success: true, data: { items: [], hasMore: false } },
          });
        },
      );
      try {
        await expect(
          page.getByText('Couldn’t refresh the chats.', { exact: true }),
        ).toBeVisible();
        const inbox = page.getByRole('complementary', { name: 'Chats' });
        // The failed read's Retry is the inbox's refresh (#5029).
        await inbox.getByRole('button', { name: 'Retry', exact: true }).click();
        const refreshing = inbox.getByRole('button', {
          name: 'Retrying…',
          exact: true,
        });
        await expect(refreshing).toBeVisible();
        await expect(refreshing).toBeDisabled();
        await expect.poll(() => inventoryReads).toBe(1);
        // Each attempt reaches the real disabled Retry and must fail
        // actionability for that reason, without issuing another read.
        for (let i = 0; i < 5; i++) {
          await expect(refreshing.click({ timeout: 200 })).rejects.toThrow(
            /not enabled/,
          );
        }
        expect(inventoryReads).toBe(1);
        releaseInventory();
        await expect(
          page.getByText('Couldn’t refresh the chats.', { exact: true }),
        ).toBeHidden();
        // A healthy list offers no refresh control at all.
        await expect(inbox.getByRole('button', { name: /^Retry/ })).toHaveCount(
          0,
        );
        const row = page
          .locator('.chat-dock-inbox [data-testid="inbox-row"]')
          .filter({ hasText: 'Mismatch demo chat' });
        await expect(row.getByTestId('inbox-row-status')).not.toContainText(
          'Last known:',
        );
        await page.screenshot({
          path: join(
            GALLERY_DIR,
            GALLERY_DIAGNOSTICS,
            `freshness-recovered-${width}.png`,
          ),
          animations: 'disabled',
        });
        expect(inventoryReads).toBe(1);
        console.log('INBOX_RECOVERY_REQUEST_COUNTS', {
          inventoryReads,
          pendingActivations: 6,
          pendingRefreshDisabled: true,
        });
      } finally {
        releaseInventory();
        await removeInventory();
      }
    }
    console.log('RECOVERY_REQUEST_COUNTS', {
      width,
      openReads,
      pendingActivations: 6,
    });
  } finally {
    await page.evaluate(() => {
      const scope = window as Window & { __recoveryFetch?: typeof fetch };
      if (scope.__recoveryFetch) window.fetch = scope.__recoveryFetch;
      delete scope.__recoveryFetch;
    });
  }
}

type GalleryProjectFixture = {
  slug: string;
  name: string;
  workingDirectory?: string;
  repositoryDisplay?: string;
  derivedIcon?: string;
};

/** `GET /api/projects` fixture — the list shape `ProjectMetadata[]` (station-contracts). */
function projectsListFixture(
  projects: GalleryProjectFixture[],
): (route: Route) => Promise<void> {
  return (route) =>
    route.fulfill({
      json: {
        success: true,
        data: projects.map((project) => ({
          id: `p-${project.slug}`,
          slug: project.slug,
          name: project.name,
          workingDirectory: project.workingDirectory,
          repositoryDisplay: project.repositoryDisplay,
          derivedIcon: project.derivedIcon,
          hasWorkingDirectory: Boolean(project.workingDirectory),
          layoutCount: 0,
          hasKnowledge: false,
        })),
      },
    });
}

/** `GET /api/projects/:slug` fixture — the detail shape `ProjectConfig`. */
function projectDetailFixture(
  project: GalleryProjectFixture,
): (route: Route) => Promise<void> {
  return (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          id: `p-${project.slug}`,
          slug: project.slug,
          name: project.name,
          workingDirectory: project.workingDirectory,
          repositoryDisplay: project.repositoryDisplay,
          derivedIcon: project.derivedIcon,
          hasWorkingDirectory: Boolean(project.workingDirectory),
          layoutCount: 0,
          hasKnowledge: false,
          agents: [],
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      },
    });
}

/** Keep the selected Project fixture available through both captures. */
function overlayDockProjectMismatchHooks(
  resyncOnly = false,
): Pick<Screen, 'beforeGoto' | 'afterGoto' | 'cleanup'> {
  let cleanups: (() => Promise<void>)[] = [];
  return {
    beforeGoto: async (page) => {
      await clearDockGalleryStorage(page);
      await seedActiveChatSession(page, {
        conversationId: 'gallery-mismatch-conversation',
        agentSlug: 'demo-agent',
        title: 'Mismatch demo chat',
        projectSlug: 'project-b',
        projectName: 'Project B',
      });
      cleanups = [
        await withRoute(
          page,
          '**/api/conversations/gallery-mismatch-conversation/open',
          async (route) => {
            if (route.request().method() !== 'GET')
              return rejectUnexpectedFixtureRequest(route);
            await route.fulfill({
              status: 503,
              json: { success: false, error: 'temporarily_unavailable' },
            });
          },
        ),
        await withRoute(
          page,
          '**/api/orchestration/sessions/read-model',
          orchestrationSessionFixture({
            threadId: 'gallery-mismatch-conversation',
            cwd: '/repos/project-b',
          }),
        ),
        await withRoute(
          page,
          '**/api/projects',
          projectsListFixture([
            { slug: 'project-a', name: 'Project A' },
            {
              slug: 'project-b',
              name: 'Project B',
              workingDirectory: '/repos/project-b',
            },
          ]),
        ),
        await withRoute(
          page,
          '**/api/projects/project-a',
          projectDetailFixture({ slug: 'project-a', name: 'Project A' }),
        ),
        await withRoute(
          page,
          '**/api/projects/project-b',
          projectDetailFixture({
            slug: 'project-b',
            name: 'Project B',
            workingDirectory: '/repos/project-b',
          }),
        ),
      ];
      if (resyncOnly) {
        cleanups.push(
          // The history and scheduler readers share the host capability cache.
          // Advertise the fixture's history support before either can read it.
          await withRoute(page, '**/.well-known/station/v1', (route) =>
            fulfillGalleryStationHandshake(route, true),
          ),
          await withRoute(page, '**/api/conversations**', async (route) => {
            if (
              new URL(route.request().url()).pathname !== '/api/conversations'
            ) {
              await route.fallback();
              return;
            }
            if (route.request().method() !== 'GET')
              return rejectUnexpectedFixtureRequest(route);
            await route.fulfill({
              status: 503,
              json: { success: false, error: 'temporarily_unavailable' },
            });
          }),
        );
      }
    },
    afterGoto: async (page) => {
      await assertNoStrayProjectModal(page);
      if (resyncOnly) {
        await expect(
          page.getByRole('button', {
            name: 'Status unavailable — resync this conversation',
            exact: true,
          }),
        ).toBeVisible();
        if ((page.viewportSize()?.width ?? 0) > 600) {
          await expect(
            page
              .getByRole('complementary', { name: 'Chats' })
              .getByRole('button', {
                name: 'Browse all conversations',
                exact: true,
              }),
          ).toBeVisible();
          await expect(
            page.getByText('Couldn’t refresh the chats.', { exact: true }),
          ).toBeVisible({ timeout: 15_000 });
          await expect(
            page
              .getByRole('complementary', { name: 'Chats' })
              .getByRole('button', { name: 'Retry', exact: true }),
          ).toBeVisible();
        }
        return;
      }
      // The dock's own inbox "ACTIVE NOW" row resolves this fixture
      // session's title asynchronously (a live query racing the seeded
      // sessionStorage title) — waiting for its settled text here, before
      // anything else, is what makes the eventual shot deterministic
      // (the row's transient intermediate text otherwise produces a
      // real, reproducible ~1939-pixel diff between two otherwise
      // byte-identical captures).
      await expect(
        page.locator('.chat-dock-inbox__item').first(),
      ).toContainText('Mismatch demo chat', { timeout: 10_000 });
      // Choosing the next chat's Project must not reassign the open chat.
      const context = page.locator(
        '.session-context-card:not(.session-context-card--sheet)',
      );
      await expect(
        context.getByText('Project B', { exact: true }),
      ).toBeVisible();
      const draft = await openGalleryNewChatDraft(page);
      await chooseGalleryNewChatProject(page, draft, 'Project A');
      await draft.press('Escape');
      await expect(draft).toBeHidden();
      await expect(
        context.getByText('Project B', { exact: true }),
      ).toBeVisible();
      await expect(context.getByText('Project A', { exact: true })).toHaveCount(
        0,
      );
      await expect(page.locator('.chat-dock__project-badge')).toHaveCount(0);
      await expect(
        page.getByRole('button', {
          name: 'Status unavailable — resync this conversation',
          exact: true,
        }),
      ).toBeVisible({ timeout: 10_000 });
      await expect
        .poll(() =>
          page
            .getByRole('button', {
              name: 'Status unavailable — resync this conversation',
              exact: true,
            })
            .evaluate(
              (pill) =>
                pill
                  .getAnimations({ subtree: true })
                  .filter(
                    (animation) =>
                      animation.playState === 'running' &&
                      animation.effect?.getComputedTiming().iterations !==
                        Infinity,
                  ).length,
            ),
        )
        .toBe(0);
      const statusBody = page.locator(
        '[data-chat-status-pill="blocked"] .chat-status-pill__body',
      );
      await expect(statusBody).toHaveCount(1);
      const restingStyle = await statusBody.evaluate(async (element) => {
        await Promise.all(
          element
            .getAnimations()
            .filter(
              (animation) =>
                animation.effect?.getTiming().iterations !== Infinity,
            )
            .map((animation) => animation.finished),
        );
        const style = getComputedStyle(element);
        return { transform: style.transform, opacity: style.opacity };
      });
      expect(
        restingStyle,
        'The settled status body releases its transform effect',
      ).toEqual({ transform: 'none', opacity: '1' });
      expect(
        await page.evaluate(() => document.documentElement.scrollHeight),
        'settled conversation status must not extend the document',
      ).toBe(page.viewportSize()?.height);
    },
    cleanup: async () => {
      // Polling must see the scenario's fixtures until its image and recovery
      // checks finish; removing them in afterGoto races the screenshot.
      for (const cleanup of cleanups) await cleanup();
      cleanups = [];
    },
  };
}

/** Open the real inline draft before choosing its future Project. */
async function openGalleryNewChatDraft(page: Page): Promise<Locator> {
  await page
    .locator('#chat-dock')
    .getByRole('button', { name: 'New chat', exact: true })
    .first()
    .click();
  const draft = page.getByRole('region', { name: 'New chat', exact: true });
  await expect(draft).toBeVisible();
  // The draft's setup check starts as a one-line placeholder and is replaced
  // by the taller setup guidance, which moves the composer down. A tap aimed
  // before that lands on whatever slid under it, so wait for the settled draft.
  for (const label of ['Checking chat setup', 'Loading setup options'])
    await expect(draft.getByRole('status', { name: label })).toHaveCount(0);
  return draft;
}

async function chooseGalleryNewChatProject(
  page: Page,
  draft: Locator,
  name: string,
): Promise<void> {
  await draft.getByRole('button', { name: /^Project: / }).click();
  const picker = page.getByRole('dialog', {
    name: 'Choose project',
    exact: true,
  });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name }).click();
  await expect(picker).toBeHidden();
  await expect(
    draft.getByRole('button', {
      name: `Project: ${name}`,
      exact: true,
    }),
  ).toBeVisible();
}

/** Keep selected Project list/detail fixtures alive until the capture finishes. */
function withGalleryProjectsList(
  projects: GalleryProjectFixture[],
  assertions: (page: Page) => Promise<void>,
  readyAgent = false,
  fullAccess = false,
  modelName = 'Gallery model',
  agentName = 'Station',
): Pick<Screen, 'beforeGoto' | 'afterGoto' | 'cleanup'> {
  let cleanups: (() => Promise<void>)[] = [];
  return {
    beforeGoto: async (page) => {
      await clearDockGalleryStorage(page);
      cleanups = [
        await withRoute(page, '**/api/projects', projectsListFixture(projects)),
      ];
      if (readyAgent) {
        const connection = modelConnectionFixture({
          id: 'gallery-model',
          name: modelName,
          config: {
            defaultModel: 'gallery-model',
            modelOptions: [
              {
                id: 'gallery-model',
                name: modelName,
                originalId: 'gallery-model',
              },
            ],
          },
        });
        cleanups.push(
          await withRoute(page, '**/api/agents', (route) =>
            route.fulfill({
              json: {
                success: true,
                data: [
                  {
                    slug: 'station',
                    name: agentName,
                    source: 'local',
                    engineId: fullAccess ? 'claude' : 'station-agent',
                    ...(fullAccess
                      ? {
                          execution: {
                            agentConnectionId: 'claude',
                            approvalMode: 'never',
                          },
                        }
                      : {}),
                    engineDefault: true,
                    available: true,
                    model: 'gallery-model',
                    toolsConfig: { mcpServers: [], autoApprove: [] },
                  },
                ],
              },
            }),
          ),
          await withRoute(page, '**/api/connections/models', (route) =>
            route.fulfill({ json: { success: true, data: [connection] } }),
          ),
          await withRoute(page, '**/config/app', (route) =>
            route.fulfill({
              json: {
                success: true,
                data: {
                  defaultLLMProvider: connection.id,
                  defaultModel: 'gallery-model',
                },
              },
            }),
          ),
        );
      }
      if (fullAccess)
        cleanups.push(
          await withRoute(page, '**/api/connections/agents', (route) =>
            route.fulfill({
              json: {
                success: true,
                data: [
                  agentConnectionFixture({
                    id: 'claude',
                    config: {
                      modelOptions: [{ id: 'gallery-model', name: modelName }],
                    },
                  }),
                ],
              },
            }),
          ),
        );
      for (const project of projects) {
        cleanups.push(
          await withRoute(
            page,
            `**/api/projects/${project.slug}`,
            projectDetailFixture(project),
          ),
        );
      }
    },
    afterGoto: assertions,
    cleanup: async () => {
      for (const cleanup of cleanups) await cleanup();
      cleanups = [];
    },
  };
}

interface Screen {
  name: string;
  title: string;
  path: string;
  viewport: { width: number; height: number };
  /** Capture with the operating-system reduced-motion preference enabled. */
  reducedMotion?: boolean;
  /** Apply after interactions, which may reapply the saved appearance. */
  captureTheme?: 'dark' | 'light';
  /** Optional selector to await before shooting (beyond the splash gate). */
  waitFor?: string;
  /**
   * Optional hook run before `page.goto` (e.g. `page.route` mocks to force a
   * zero-data / empty-state render — see archive#192's converged empty-state
   * screens below).
   */
  beforeGoto?: (page: Page) => Promise<void>;
  /**
   * Optional hook run after the app shell has settled, before the shot is
   * taken (e.g. driving a modal open via keyboard shortcut, or asserting a
   * screen-specific stable marker so a transient view-selection race can't
   * be captured as the wrong tile).
   */
  afterGoto?: (page: Page) => Promise<void>;
  /**
   * Optional checks after the audit has passed its error-surface check (a
   * post-shot interaction the photo must not show).
   */
  afterAudit?: (page: Page) => Promise<void>;
  /** Release screen fixtures after capture and interaction checks, even on failure. */
  cleanup?: () => Promise<void>;
  /**
   * This screen deliberately captures a loading skeleton (@kontourai/ui's
   * `.skeleton`) itself — opt out of the universal
   * `assertNoLoadingSkeleton` wait below.
   */
  expectSkeleton?: boolean;
}

async function assertSharingRowRhythm(surface: Locator) {
  const labels = surface.locator(
    '.usage-telemetry-disclosure__choices > label',
  );
  await expect(labels).toHaveCount(3);
  const boxes = await labels.evaluateAll((nodes) =>
    nodes.map((node) => {
      const { top, height, bottom } = node.getBoundingClientRect();
      return { top, height, bottom };
    }),
  );
  for (const box of boxes) expect(box.height).toBeGreaterThanOrEqual(44);
  expect(
    Math.max(...boxes.map((box) => box.height)) -
      Math.min(...boxes.map((box) => box.height)),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(boxes[1].top - boxes[0].bottom - (boxes[2].top - boxes[1].bottom)),
  ).toBeLessThanOrEqual(1);
  for (const label of await labels.all())
    await expect(label.locator('small')).toBeVisible();
}

function telemetryConsentScreens(): Screen[] {
  return [DESKTOP, MOBILE].flatMap((viewport) =>
    (
      [
        'dialog-default',
        'dialog-mixed',
        'dialog-dnt',
        'dialog-endpoint',
        'dialog-detailed',
        'dialog-light',
        'settings',
        'settings-dnt',
        'outbox',
        'feedback',
        ...(viewport === MOBILE
          ? (['settings-dnt-after-fix', 'settings-detailed-expanded'] as const)
          : []),
      ] as const
    ).map((mode) => {
      const dialogVisible = mode.startsWith('dialog-');
      const dnt = mode.includes('dnt');
      const endpoint =
        mode === 'dialog-mixed' ||
        mode === 'dialog-endpoint' ||
        mode === 'dialog-detailed' ||
        mode === 'dialog-dnt' ||
        mode === 'settings-dnt-after-fix' ||
        mode === 'settings-detailed-expanded';
      const additionalEndpoint = endpoint
        ? new URL('https://counts.example.test/events')
        : undefined;
      const routes: Array<[RegExp, (route: Route) => Promise<void>]> = [];
      let ownPage: Page;
      const device = viewport === MOBILE ? 'mobile' : 'desktop';
      return {
        name: `telemetry-${mode}-${device}`,
        title: `Usage sharing — ${mode} (${device})`,
        path: dialogVisible ? '/' : '/settings?view=telemetry',
        viewport,
        beforeGoto: async (page) => {
          ownPage = page;
          const apiBase = resolveE2EApiBase();
          const request = createAuthenticatedE2ERequest(page.request);
          const read = async (path: string) => {
            const response = await request.get(new URL(path, apiBase).href);
            expect(
              response.ok(),
              `Telemetry gallery prerequisite ${path}`,
            ).toBe(true);
            const body = (await response.json()) as {
              success: boolean;
              data: Record<string, unknown>;
            };
            expect(body.success).toBe(true);
            expect(body.data).toBeTruthy();
            return body;
          };
          const [configSnapshot, disclosureSnapshot, statusSnapshot] =
            await Promise.all([
              read('/config/app'),
              read('/api/usage-telemetry/disclosure'),
              read('/api/usage-telemetry/status'),
            ]);
          expect(typeof disclosureSnapshot.data.inventoryRevision).toBe(
            'string',
          );
          expect(typeof statusSnapshot.data.liteInventoryRevision).toBe(
            'string',
          );
          const choices = {
            kontour: mode === 'dialog-mixed' ? 'off' : 'lite',
            operator: 'lite',
          } as const;
          const publishers = {
            kontour: {
              tier: dnt ? 'off' : choices.kontour,
              reason: dnt ? 'DNT' : 'user',
              userChoice: choices.kontour,
              fullAvailable: false,
              source: 'config',
            },
            operator: {
              tier: dnt ? 'off' : 'lite',
              reason: dnt ? 'DNT' : 'user',
              userChoice: 'lite',
              fullAvailable: true,
              source: 'config',
            },
          };
          routes.push(
            [
              /\/config\/app(?:\?.*)?$/,
              async (route) => {
                const body = structuredClone(configSnapshot);
                body.data.telemetryTier = choices;
                body.data.productTelemetryEndpoint =
                  additionalEndpoint?.href ?? '';
                delete body.data.telemetryEnabled;
                delete body.data.firstRun;
                await route.fulfill({ json: body });
              },
            ],
            [
              /\/api\/usage-telemetry\/disclosure$/,
              async (route) => {
                const body = structuredClone(disclosureSnapshot);
                Object.assign(body.data, {
                  acknowledged: !dialogVisible,
                  telemetryEnabled: false,
                  endpointConfigured: endpoint,
                  additionalHost: additionalEndpoint?.host,
                  publishers,
                });
                await route.fulfill({ json: body });
              },
            ],
            [
              /\/api\/usage-telemetry\/status$/,
              async (route) => {
                const body = structuredClone(statusSnapshot);
                body.data.publishers = publishers;
                body.data.liteNotices = dialogVisible
                  ? {}
                  : Object.fromEntries(
                      ['kontour', 'operator'].map((publisher) => [
                        publisher,
                        {
                          publisher,
                          inventoryRevision: body.data.liteInventoryRevision,
                          shownAt: '2026-10-19T00:00:00Z',
                        },
                      ]),
                    );
                await route.fulfill({ json: body });
              },
            ],
            [
              /\/api\/usage-telemetry\/lite-notices$/,
              async (route) => {
                await route.fulfill({ json: { success: true } });
              },
            ],
            [
              /\/api\/usage-telemetry\/outbox\?publisher=.+$/,
              async (route) => {
                await route.fulfill({
                  json: {
                    success: true,
                    data: route.request().url().includes('publisher=kontour')
                      ? []
                      : [
                          {
                            publisher: 'operator',
                            tier: 'lite',
                            recordedAt: '2026-10-19T08:00:00Z',
                            outcome: 'dropped',
                            reason: 'notice',
                            payload: { event: 'telemetry_dropped', count: 3 },
                          },
                          {
                            publisher: 'operator',
                            tier: 'lite',
                            recordedAt: '2026-10-19T08:01:00Z',
                            outcome: 'sent',
                            reason: 'acknowledged',
                            payload: {
                              event: 'station_daily',
                              platform: 'darwin',
                            },
                          },
                        ],
                  },
                });
              },
            ],
          );
          for (const [pattern, handler] of routes)
            await page.route(pattern, handler);
          await page.addInitScript(() => {
            localStorage.removeItem(
              'station.usage-telemetry-disclosure.snoozed',
            );
          });
        },
        afterGoto: async (page) => {
          if (dialogVisible) {
            await page
              .getByRole('button', { name: 'Review choices', exact: true })
              .click();
            const dialog = page.getByRole('dialog', {
              name: 'Usage sharing',
            });
            await expect(dialog).toBeVisible();
            if (mode !== 'dialog-mixed') {
              await expect(
                dialog.getByRole('radio', {
                  name: 'Anonymous usage counts',
                  exact: true,
                }),
              ).toBeChecked();
              await expect(
                dialog.getByRole('radio', {
                  name: 'Anonymous usage counts',
                  exact: true,
                }),
              ).toBeFocused();
            }
            for (const name of [
              "Don't share",
              'Anonymous usage counts',
              'Detailed usage to help improve Station',
            ])
              await expect(
                dialog.getByRole('radio', { name, exact: true }),
              ).toBeVisible();
            if (dnt)
              await expect(
                dialog.getByRole('region', { name: 'Do Not Track' }),
              ).toBeVisible();
            if (endpoint)
              await expect(
                dialog.getByText('Also shared with: counts.example.test'),
              ).toBeVisible();
            if (mode === 'dialog-detailed') {
              await dialog
                .getByRole('radio', {
                  name: 'Detailed usage to help improve Station',
                })
                .check();
              const included = dialog.getByRole('region', {
                name: "What's included",
              });
              await expect(
                included.getByText(
                  /A random installation code changes monthly/,
                ),
              ).toBeVisible();
              const technical = included.locator(
                '.usage-telemetry-disclosure__technical',
              );
              await expect(technical).not.toHaveAttribute('open', '');
              await expect(technical.locator('li').first()).not.toBeVisible();
              await technical
                .getByText('Technical details', { exact: true })
                .click();
              await expect(technical.locator('li').first()).toBeVisible();
              await technical
                .getByText('Technical details', { exact: true })
                .click();
              await expect(technical.locator('li').first()).not.toBeVisible();
            }
            if (mode === 'dialog-light')
              await page.evaluate(() =>
                document.documentElement.setAttribute('data-theme', 'light'),
              );
            await assertSharingRowRhythm(dialog);
            if (mode === 'dialog-mixed') {
              await expect(
                dialog.getByText(/current choices differ/),
              ).toBeVisible();
              for (const radio of await dialog.getByRole('radio').all())
                await expect(radio).not.toBeChecked();
              const first = dialog.getByRole('radio', {
                name: "Don't share",
                exact: true,
              });
              await expect(first).toBeFocused();
              await first.press('Enter');
              for (const radio of await dialog.getByRole('radio').all())
                await expect(radio).not.toBeChecked();
              await expect(
                dialog.getByRole('button', {
                  name: 'Save choice',
                  exact: true,
                }),
              ).toBeDisabled();
              await expect(
                dialog.getByRole('button', { name: 'Not now', exact: true }),
              ).toBeInViewport();
              return;
            }
            for (const name of ['Not now', 'Save choice']) {
              const button = dialog.getByRole('button', {
                name,
                exact: true,
              });
              await expect(button).toBeInViewport();
              await button.click({ trial: true });
            }
            return;
          }
          const choice = page
            .getByRole('region', { name: 'Usage sharing choices' })
            .getByRole('radio', {
              name: 'Anonymous usage counts',
              exact: true,
            });
          await choice.scrollIntoViewIfNeeded();
          await expect(choice).toBeChecked();
          const main = page.getByRole('region', {
            name: 'Usage sharing choices',
          });
          await expect(
            main.getByText('Changes wait until you select Save.'),
          ).toBeVisible();
          await expect(
            main.getByText(/You can change this in Privacy & sharing/),
          ).toHaveCount(0);
          await assertSharingRowRhythm(main);
          if (
            mode === 'settings-dnt-after-fix' ||
            mode === 'settings-detailed-expanded'
          ) {
            await main
              .getByRole('radio', {
                name:
                  mode === 'settings-dnt-after-fix'
                    ? "Don't share"
                    : 'Detailed usage to help improve Station',
                exact: true,
              })
              .check();
            const save = page.getByRole('button', {
              name: 'Save',
              exact: true,
            });
            await expect(save).toBeInViewport();
            await save.click({ trial: true });
            if (mode === 'settings-dnt-after-fix') {
              await main
                .getByText('Changes wait until you select Save.')
                .hover();
              // Check end-of-page clearance independently of the scroll
              // position left by radio selection and hover auto-scrolling.
              const content = page.locator('.content-view');
              await page.mouse.wheel(
                0,
                await content.evaluate((element) => element.scrollHeight),
              );
              await expect
                .poll(() =>
                  content.evaluate(
                    (element) =>
                      element.scrollHeight -
                      element.clientHeight -
                      element.scrollTop,
                  ),
                )
                .toBeLessThanOrEqual(1);
              const explanation = main.getByText(
                'Feature use. Monthly code. No account or content.',
                { exact: true },
              );
              await expect(explanation).toBeInViewport({ ratio: 1 });
              await expect
                .poll(async () => {
                  const [text, bar] = await Promise.all([
                    explanation.boundingBox(),
                    page.locator('.settings__save-pill').boundingBox(),
                  ]);
                  if (!text || !bar)
                    throw new Error(
                      'Choice description or Save bar did not render.',
                    );
                  return text.y + text.height <= bar.y - 4;
                })
                .toBe(true);
              await save.click({ trial: true });
            }
            if (mode === 'settings-detailed-expanded') {
              const included = main.getByRole('region', {
                name: "What's included",
              });
              await included
                .getByRole('heading', { name: "What's included" })
                .hover();
              await page.mouse.wheel(0, 600);
              const confirmation = included.getByText(
                /Review what's included, then select Save/,
              );
              await expect(confirmation).toBeVisible();
              await expect
                .poll(async () => {
                  const [text, bar] = await Promise.all([
                    confirmation.boundingBox(),
                    page.locator('.settings__save-pill').boundingBox(),
                  ]);
                  if (!text || !bar)
                    throw new Error(
                      'Detailed confirmation or Save bar did not render.',
                    );
                  return text.y + text.height <= bar.y - 4;
                })
                .toBe(true);
              await expect(
                included.locator('.usage-telemetry-disclosure__technical'),
              ).not.toHaveAttribute('open', '');
            }
          }
          if (dnt)
            await expect(
              page.getByRole('region', { name: 'Do Not Track' }),
            ).toBeVisible();
          if (mode === 'outbox' || mode === 'feedback') {
            await page
              .locator(
                '[data-catalog-id="usage-telemetry"] > details > summary',
              )
              .click();
            if (mode === 'feedback') {
              await page
                .getByRole('combobox', { name: 'Operator telemetry' })
                .selectOption('off');
              await expect(
                page.getByRole('heading', {
                  name: /Changing sharing with Operator/,
                }),
              ).toBeFocused();
              await page
                .locator('.telemetry-feedback')
                .scrollIntoViewIfNeeded();
            } else {
              await page
                .getByText('What was sent to Operator', { exact: true })
                .click();
              const outbox = page.getByRole('region', {
                name: 'What was sent to Operator',
              });
              await outbox.getByText('View sent payload JSON').click();
              await outbox.scrollIntoViewIfNeeded();
              await expect(outbox.locator('pre')).toContainText(
                'station_daily',
              );
              // Rest the Operator select just below the pinned toolbar, so no
              // control is left partly behind it (the judge credits no
              // scroll position).
              await page
                .getByRole('combobox', { name: 'Operator telemetry' })
                .evaluate((select) => {
                  const bar = document.querySelector('.app-toolbar');
                  const barBottom = bar?.getBoundingClientRect().bottom ?? 0;
                  let scroller: Element | null = select.parentElement;
                  while (
                    scroller &&
                    !(
                      /(auto|scroll)/.test(
                        getComputedStyle(scroller).overflowY,
                      ) && scroller.scrollHeight > scroller.clientHeight
                    )
                  )
                    scroller = scroller.parentElement;
                  (scroller ?? document.scrollingElement)?.scrollBy(
                    0,
                    select.getBoundingClientRect().top - barBottom - 8,
                  );
                  // The same for the collapsed dock bar pinned at the bottom
                  // of a phone: a control left straddling its top edge is
                  // partly behind it. Lower the content by the smallest step
                  // that leaves no control across either bar's edge (the
                  // select only moves further below the toolbar).
                  const dock = document.querySelector(
                    '[data-testid="chat-dock-mobile-header"]',
                  );
                  if (!dock) return;
                  const dockTop = dock.getBoundingClientRect().top;
                  const boxes = [
                    ...document.querySelectorAll<HTMLElement>(
                      '.content-view :is(input, select, textarea, button, a[href], summary)',
                    ),
                  ]
                    .map((control) => control.getBoundingClientRect())
                    .filter((box) => box.height > 0);
                  const across = (edge: number, shift: number) =>
                    boxes.some(
                      (box) =>
                        box.top + shift < edge && box.bottom + shift > edge,
                    );
                  for (let lower = 0; lower <= 240; lower += 2) {
                    if (!across(barBottom, lower) && !across(dockTop, lower)) {
                      if (lower > 0)
                        (scroller ?? document.scrollingElement)?.scrollBy(
                          0,
                          -lower,
                        );
                      return;
                    }
                  }
                });
            }
          }
        },
        cleanup: async () => {
          for (const [pattern, handler] of routes)
            await ownPage.unroute(pattern, handler);
        },
      } satisfies Screen;
    }),
  );
}

const INVENTORY_CONVERSATION = 'gallery-inventory-conversation';
const galleryInventory = JSON.parse(
  readFileSync(
    join(process.cwd(), 'tests/fixtures/gallery-session-inventory.json'),
    'utf8',
  ),
) as { inventory: unknown; input: { input: { prompt: string } } };

/**
 * Chat inventory's item drill-down (#4169) at 390 and 1440, dark and light,
 * in two states: the authored input read back from a host that advertises
 * `sessionInventoryInputRead`, and an older host whose handshake lacks it
 * ("This Station can't show input details", since #4197). The inventory and input bodies are
 * the real server's responses for one authored turn
 * (`fixtures/gallery-session-inventory.json`, captured from #4169's
 * chat-inventory-drilldown-mobile journey, with only the session id
 * replaced); the chat around them is the gallery's runtime conversation
 * fixture.
 */
function inventoryDrilldownScreens(): Screen[] {
  return [DESKTOP, MOBILE].flatMap((viewport) =>
    (['dark', 'light'] as const).flatMap((theme) =>
      (['read', 'older-host'] as const).map((state): Screen => {
        let cleanups: (() => Promise<void>)[] = [];
        const device = viewport === MOBILE ? 'mobile' : 'desktop';
        const json = (data: unknown) => async (route: Route) => {
          if (route.request().method() !== 'GET')
            return rejectUnexpectedFixtureRequest(route);
          await route.fulfill({ json: { success: true, data } });
        };
        return {
          name: `inventory-drilldown-${state}-${theme}-${device}`,
          title: `Chat inventory drill-down — ${state}, ${theme} (${device})`,
          path: `/?dock=open&chat=${INVENTORY_CONVERSATION}`,
          viewport,
          beforeGoto: async (page) => {
            await clearDockGalleryStorage(page);
            // The live server's event stream does not know this fixture
            // chat; left open, its snapshot raced the fixture transcript and
            // sometimes emptied the chat behind the reader. Hold the stream
            // open and silent, on this chat's URL only (init scripts outlive
            // the screen).
            await page.addInitScript((conversation) => {
              if (
                new URLSearchParams(location.search).get('chat') !==
                conversation
              )
                return;
              const original = window.fetch.bind(window);
              window.fetch = async (input, init) => {
                const url =
                  input instanceof Request ? input.url : String(input);
                if (
                  new URL(url, location.href).pathname !==
                  '/api/orchestration/events'
                )
                  return original(input, init);
                return new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      init?.signal?.addEventListener(
                        'abort',
                        () => controller.close(),
                        { once: true },
                      );
                    },
                  }),
                  { headers: { 'Content-Type': 'text/event-stream' } },
                );
              };
            }, INVENTORY_CONVERSATION);
            await seedActiveChatSession(page, {
              conversationId: INVENTORY_CONVERSATION,
              agentSlug: 'demo-agent',
              title: 'Inventory demo chat',
            });
            await mockRuntimeConversation(page, {
              id: INVENTORY_CONVERSATION,
              agentSlug: 'demo-agent',
              title: 'Inventory demo chat',
              provider: 'claude',
              model: 'test-model',
              canContinue: true,
              turns: () =>
                buildLongSessionTurns({
                  threadId: INVENTORY_CONVERSATION,
                  provider: 'claude',
                  turnCount: 1,
                  replyText: () => 'Inventory fixture answered.',
                }),
            });
            cleanups = [
              await withRoute(
                page,
                '**/api/orchestration/sessions/read-model',
                orchestrationSessionFixture({
                  threadId: INVENTORY_CONVERSATION,
                }),
              ),
              await withRoute(
                page,
                `**/api/orchestration/sessions/${INVENTORY_CONVERSATION}/inventory?**`,
                json(galleryInventory.inventory),
              ),
              await withRoute(
                page,
                `**/api/orchestration/sessions/${INVENTORY_CONVERSATION}/inputs/**`,
                json(galleryInventory.input),
              ),
            ];
            // Both hosts serve the bounded transcript window the fixture
            // answers; only the newer one also serves exact input reads.
            cleanups.push(
              await withRoute(page, '**/.well-known/station/v1', (route) =>
                fulfillGalleryStationHandshake(
                  route,
                  true,
                  state === 'read' ? { sessionInventoryInputRead: true } : {},
                ),
              ),
            );
          },
          afterGoto: async (page) => {
            if (theme === 'light')
              await page.evaluate(() =>
                document.documentElement.setAttribute('data-theme', 'light'),
              );
            // The chat behind the reader has read its transcript from the
            // fixture window, so its status is settled and the same every run.
            await expect(
              page.getByText('Inventory fixture answered.', { exact: true }),
            ).toBeVisible({ timeout: 20_000 });
            // Both layouts open the full reader through conversation overflow;
            // the context card's button opens compact answer inspection.
            if (viewport === MOBILE) {
              const { chatActions, inventoryRow } =
                phoneChatInventoryControls(page);
              await chatActions.click();
              await inventoryRow.click();
            } else {
              await openDesktopChatInventory(page);
            }
            const reader = page.getByRole('dialog', {
              name: 'Chat inventory',
              exact: true,
            });
            await expect(reader).toBeVisible();
            const toggle = reader.getByRole('button', {
              name: /^Authored message (View|Hide) details$/,
            });
            await toggle.click();
            await expect(toggle).toHaveAttribute('aria-expanded', 'true');
            const details = reader.getByRole('region', {
              name: 'Authored message details',
            });
            if (state === 'read')
              await expect(details.locator('pre')).toHaveText(
                galleryInventory.input.input.prompt,
              );
            else
              await expect(
                details.getByText("This Station can't show input details"),
              ).toBeVisible();
            // Photograph the drill-down itself: on a phone it sits below the
            // reader's summary inside the reader's own scroller.
            await details.evaluate((element) =>
              element.scrollIntoView({ block: 'end' }),
            );
            await expect(
              details.getByRole('button', {
                name: 'Open session',
                exact: true,
              }),
            ).toBeInViewport({ ratio: 1 });
            await expect(
              state === 'read'
                ? details.locator('pre')
                : details.getByText("This Station can't show input details"),
            ).toBeInViewport({ ratio: 1 });
            // The drawer must have finished opening before the shot.
            await expect
              .poll(async () => (await reader.boundingBox())?.x ?? -1)
              .toBeGreaterThanOrEqual(0);
          },
          cleanup: async () => {
            for (const cleanup of cleanups.splice(0)) await cleanup();
          },
        };
      }),
    ),
  );
}

/**
 * The Station switcher with a desktop's worth of saved Stations: the active
 * one, two that answer and two whose connections are refused, at 390 and 1440
 * in both themes, plus the inline forget confirmation. Every extra Station is
 * routed here. The switcher calls a Station Online only when its public
 * handshake answers as a Station, so the two that answer serve the gallery's
 * handshake on that path; an empty 200 there reads as "Not confirmed".
 * (Playwright adds the CORS headers a cross-origin read needs to a fulfilled
 * response that has none.) Extra profiles join the gallery's own seed only on
 * this screen's URL, and only once, since init scripts outlive the screen.
 */
function stationSwitcherScreens(): Screen[] {
  const online = 'https://online.gallery.test';
  const offline = 'https://offline.gallery.test';
  const shots = [DESKTOP, MOBILE].flatMap((viewport) =>
    (['dark', 'light'] as const).map((theme) => ({
      viewport,
      theme,
      armed: false,
      forgotten: undefined as 'keyboard' | 'pointer' | undefined,
      extra: false,
    })),
  );
  shots.push({
    viewport: DESKTOP,
    theme: 'dark',
    armed: true,
    forgotten: undefined,
    extra: false,
  });
  // Forgetting a Station never closes the menu: from exactly five Stations
  // the filter field unmounts with focus on it; from six it stays. One
  // screen each for the keyboard, the pointer and the six-Station case.
  shots.push(
    {
      viewport: DESKTOP,
      theme: 'dark',
      armed: true,
      forgotten: 'keyboard',
      extra: false,
    },
    {
      viewport: MOBILE,
      theme: 'dark',
      armed: true,
      forgotten: 'pointer',
      extra: false,
    },
    {
      viewport: DESKTOP,
      theme: 'dark',
      armed: true,
      forgotten: 'keyboard',
      extra: true,
    },
  );
  return shots.map(({ viewport, theme, armed, forgotten, extra }): Screen => {
    const device = viewport === MOBILE ? 'mobile' : 'desktop';
    const name = `station-switcher${armed ? '-forget' : ''}${forgotten ? `-after-${forgotten}${extra ? '-six' : ''}` : ''}-${theme}-${device}`;
    let cleanups: (() => Promise<void>)[] = [];
    return {
      name,
      title: `Station switcher${armed ? ' — forget' : ''}${forgotten ? ` — after forgetting by ${forgotten}${extra ? ' from six' : ' from five'}` : ''}, ${theme} (${device})`,
      path: '/?gallery=station-switcher',
      viewport,
      beforeGoto: async (page) => {
        const answer = (route: Route) =>
          new URL(route.request().url()).pathname ===
          PUBLIC_STATION_HANDSHAKE_PATH
            ? fulfillGalleryStationHandshake(route)
            : route.fulfill({ status: 200 });
        const refuse = (route: Route) => route.abort('connectionrefused');
        await page.route(`${online}/**`, answer);
        await page.route(`${offline}/**`, refuse);
        cleanups = [
          () => page.unroute(`${online}/**`, answer),
          () => page.unroute(`${offline}/**`, refuse),
        ];
        await page.addInitScript(
          ({ activeId, stations }) => {
            if (
              new URLSearchParams(location.search).get('gallery') !==
              'station-switcher'
            )
              return;
            const key = 'station-connect-connections';
            const ids = new Set(stations.map(([id]) => id));
            const saved = JSON.parse(localStorage.getItem(key) ?? '[]').filter(
              (connection: { id: string }) => !ids.has(connection.id),
            );
            const template = saved.find(
              (connection: { id: string }) => connection.id === activeId,
            );
            localStorage.setItem(
              key,
              JSON.stringify([
                ...saved,
                ...stations.map(([id, name, url]) => ({
                  ...template,
                  id,
                  name,
                  url,
                  environmentId: null,
                  credentialRef: { ...template.credentialRef, id },
                  lastSuccessAt: undefined,
                })),
              ]),
            );
            localStorage.setItem(
              'station.switcher.recent',
              JSON.stringify([activeId, 'media', 'build']),
            );
          },
          {
            activeId: GALLERY_CONNECTION_ID,
            stations: [
              ['build', 'Build box', `${online}/build`],
              ['media', 'Media server', online],
              ['laptop', 'Laptop', offline],
              ['dev', 'Old dev instance', `${offline}/dev`],
              ...(extra
                ? ([['spare', 'Spare box', `${online}/spare`]] as const)
                : []),
            ],
          },
        );
      },
      afterGoto: async (page) => {
        if (theme === 'light')
          await page.evaluate(() =>
            document.documentElement.setAttribute('data-theme', 'light'),
          );
        await page.getByTestId('app-toolbar-connection').click();
        const menu = page.getByRole('menu', { name: 'Choose Station' });
        await expect(
          page.getByRole('searchbox', { name: 'Find a Station' }),
        ).toBeFocused();
        await expect(
          menu.getByRole('menuitemradio', { name: 'Media server — Online' }),
        ).toBeVisible();
        await expect(
          menu.getByRole('menuitem', { name: 'Forget 2 unreachable' }),
        ).toBeVisible();
        // A Station that would fail if chosen is drawn greyed out. Its row is
        // `aria-disabled`, not `disabled`, so the shared disabled-row style
        // does not reach it and only its own rule keeps it apart from a row
        // that can be chosen.
        const rowColour = (name: RegExp) =>
          menu
            .getByRole('menuitemradio', { name })
            .evaluate((row) => getComputedStyle(row).color);
        expect(await rowColour(/^Laptop — Unreachable/)).not.toBe(
          await rowColour(/^Media server — Online/),
        );
        if (armed) {
          await menu
            .getByRole('menuitemradio', { name: /^Old dev instance/ })
            .press('Delete');
          const confirm = menu.getByRole('menuitem', {
            name: 'Forget Old dev instance',
          });
          await expect(confirm).toBeFocused();
          if (forgotten) {
            if (forgotten === 'keyboard') await confirm.press('Enter');
            else await confirm.click();
            await expect(
              menu.getByRole('menuitemradio', { name: /^Old dev instance/ }),
            ).toHaveCount(0);
            // The menu stays open and focus sits on a visible item inside it,
            // not on a removed element or <body>. Asserted after a settle
            // tick: a menu that closes on focus loss does so asynchronously.
            await page.waitForTimeout(300);
            await expect(menu).toBeVisible();
            const focus = await page.evaluate(() => {
              const active = document.activeElement;
              const box = active?.getBoundingClientRect();
              return {
                inMenu: Boolean(
                  active?.closest('.app-toolbar__station-switcher'),
                ),
                visible: Boolean(box && box.width > 0 && box.height > 0),
              };
            });
            expect(focus.inMenu).toBe(true);
            expect(focus.visible).toBe(true);
            expect(
              await page
                .getByRole('searchbox', { name: 'Find a Station' })
                .count(),
            ).toBe(extra ? 1 : 0);
          }
        }
      },
      cleanup: async () => {
        for (const cleanup of cleanups.splice(0)) await cleanup();
      },
    };
  });
}

/**
 * #5066: a Task's pull request watch on its Overview, and the Project's
 * Pull requests setting. The Task and Project are real; only the Task's watch
 * read is routed, to a fixed view a real forge would take a day to produce
 * (one pull request ready, one out of fix attempts, two refused actions).
 */
function pullRequestWatchScreens(): Screen[] {
  return (['dark', 'light'] as const).flatMap((theme) =>
    [DESKTOP, MOBILE].flatMap((viewport): Screen[] => {
      const form = viewport.width === DESKTOP.width ? 'desktop' : 'mobile';
      const preview = (page: Page) => {
        const request = createAuthenticatedE2ERequest(page.request);
        let previous: boolean | undefined;
        return {
          request,
          async enable() {
            const previews = await request.get(
              `${resolveE2EApiBase()}/api/feature-previews`,
            );
            expect(previews.ok()).toBe(true);
            const entry = (await previews.json()).data.find(
              (item: { id: string }) =>
                item.id === 'pull-request-agent-feedback',
            );
            expect(entry).toBeDefined();
            previous = entry.enabled;
            const enabled = await request.put(
              `${resolveE2EApiBase()}/api/feature-previews/pull-request-agent-feedback`,
              { data: { enabled: true } },
            );
            expect(enabled.ok()).toBe(true);
          },
          async restore() {
            if (previous === undefined) return;
            const restored = await request.put(
              `${resolveE2EApiBase()}/api/feature-previews/pull-request-agent-feedback`,
              { data: { enabled: previous } },
            );
            expect(restored.ok()).toBe(true);
          },
        };
      };

      const taskSlug = `gallery-pr-watch-${theme}-${viewport.width}`;
      let taskFixture: ReturnType<typeof preview> | undefined;
      let taskProject = false;
      let pageForTask: Page | undefined;
      let restoreHandshake: (() => Promise<void>) | undefined;
      const watchRoute = async (route: Route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const taskId = decodeURIComponent(
          new URL(route.request().url()).pathname.split('/')[3] ?? '',
        );
        const identity = (ref: string) => ({
          provider: 'github',
          host: 'github.com',
          repository: { owner: 'acme', name: 'widgets' },
          ref,
        });
        await route.fulfill({
          json: {
            success: true,
            data: {
              taskId,
              watching: true,
              source: 'project',
              mode: 'project',
              projectEnabled: true,
              maxFixAttempts: 3,
              available: true,
              pullRequests: [
                {
                  identity: identity('42'),
                  url: 'https://github.com/acme/widgets/pull/42',
                  watch: {
                    state: 'ready',
                    headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
                    at: '2026-11-17T09:12:00.000Z',
                  },
                  fixAttempts: 1,
                  maxFixAttempts: 3,
                },
                {
                  identity: identity('57'),
                  url: 'https://github.com/acme/widgets/pull/57',
                  watch: {
                    state: 'budget-spent',
                    failing: ['ci / unit-tests', 'ci / lint'],
                    headSha: 'b2c3d4e5f60718293a4b5c6d7e8f901234567890',
                  },
                  fixAttempts: 3,
                  maxFixAttempts: 3,
                },
                {
                  identity: identity('63'),
                  url: 'https://github.com/acme/widgets/pull/63',
                  watch: {
                    state: 'review-needed',
                    headSha: 'c3d4e5f60718293a4b5c6d7e8f90123456789012',
                    detail:
                      'Required findings were dismissed. Choose Review again.',
                  },
                  fixAttempts: 1,
                  maxFixAttempts: 3,
                },
              ],
              refusals: [
                {
                  id: 'refusal-2',
                  at: '2026-11-17T09:05:00.000Z',
                  kind: 'force-push',
                  outcome: 'refused',
                  toolName: 'Bash',
                  detail: 'git push --force-with-lease origin topic',
                },
                {
                  id: 'refusal-1',
                  at: '2026-11-17T08:40:00.000Z',
                  kind: 'arm-auto-merge',
                  outcome: 'refused',
                  toolName: 'Bash',
                  detail: 'gh pr merge 42 --auto --squash',
                },
              ],
            },
          },
        });
      };
      const taskScreen: Screen = {
        name: `task-pr-watch-${theme}-${form}`,
        title: `Task pull request watch — ${theme}, ${viewport.width}px`,
        path: '/',
        viewport,
        captureTheme: theme,
        async beforeGoto(page) {
          pageForTask = page;
          taskFixture = preview(page);
          await taskFixture.enable();
          const project = await taskFixture.request.post(
            `${resolveE2EApiBase()}/api/projects`,
            { data: { name: taskSlug, slug: taskSlug } },
          );
          expect(project.ok()).toBe(true);
          taskProject = true;
          const task = await taskFixture.request.post(
            `${resolveE2EApiBase()}/api/tasks`,
            {
              data: {
                projectId: taskSlug,
                title: 'Fix the login redirect on Safari',
                createdBy: 'user',
              },
            },
          );
          expect(task.ok()).toBe(true);
          const created = await task.json();
          taskScreen.path = `/tasks/${encodeURIComponent(created.data.id)}?taskView=overview`;
          // The gallery's global handshake names no capability; the panel
          // shows only on a host that serves pull request feedback.
          restoreHandshake = await withRoute(
            page,
            '**/.well-known/station/v1',
            (route) =>
              fulfillGalleryStationHandshake(route, false, {
                pullRequestFeedback: true,
              }),
          );
          await page.route('**/api/tasks/*/pull-request-watch', watchRoute);
        },
        async afterGoto(page) {
          const panel = page.getByRole('region', {
            name: 'Pull request watch',
          });
          await expect(panel).toBeVisible();
          await expect(panel.getByText('Ready for you')).toBeVisible();
          await expect(panel.getByText('Review needs you')).toBeVisible();
          await expect(
            panel.getByText('Still failing: ci / unit-tests, ci / lint'),
          ).toBeVisible();
          await expect(
            panel.getByRole('button', { name: 'Stop watching' }),
          ).toBeVisible();
          await panel
            .getByRole('button', { name: 'Refused actions · 2' })
            .click();
          await expect(panel.getByText('Arm auto-merge')).toBeVisible();
          await panel.scrollIntoViewIfNeeded();
        },
        async cleanup() {
          try {
            await pageForTask?.unroute(
              '**/api/tasks/*/pull-request-watch',
              watchRoute,
            );
            await restoreHandshake?.();
            if (taskProject) {
              const deleted = await taskFixture!.request.delete(
                `${resolveE2EApiBase()}/api/projects/${taskSlug}`,
              );
              expect(deleted.ok()).toBe(true);
            }
          } finally {
            await taskFixture?.restore();
          }
        },
      };

      const projectSlug = `gallery-pr-setting-${theme}-${viewport.width}`;
      let projectFixture: ReturnType<typeof preview> | undefined;
      let projectCreated = false;
      let previousHeadReview = false;
      const projectScreen: Screen = {
        name: `project-pull-requests-${theme}-${form}`,
        title: `Project pull request setting — ${theme}, ${viewport.width}px`,
        path: `/projects/${projectSlug}/edit?section=pull-requests`,
        viewport,
        captureTheme: theme,
        async beforeGoto(page) {
          projectFixture = preview(page);
          await projectFixture.enable();
          const flags = await projectFixture.request.get(
            `${resolveE2EApiBase()}/api/feature-previews`,
          );
          previousHeadReview = (await flags.json()).data.find(
            (entry: { id: string }) => entry.id === 'pull-request-head-review',
          ).enabled;
          expect(
            (
              await projectFixture.request.put(
                `${resolveE2EApiBase()}/api/feature-previews/pull-request-head-review`,
                { data: { enabled: true } },
              )
            ).ok(),
          ).toBe(true);
          const project = await projectFixture.request.post(
            `${resolveE2EApiBase()}/api/projects`,
            {
              data: {
                name: projectSlug,
                slug: projectSlug,
                workingDirectory: process.cwd(),
              },
            },
          );
          expect(project.ok()).toBe(true);
          projectCreated = true;
          const set = await projectFixture.request.put(
            `${resolveE2EApiBase()}/api/projects/${projectSlug}/pull-request-watch`,
            { data: { enabled: true, maxFixAttempts: 3 } },
          );
          expect(set.ok()).toBe(true);
          const defaults = await projectFixture.request.put(
            `${resolveE2EApiBase()}/api/pull-request-feedback/projects/${projectSlug}/defaults`,
            {
              data: {
                settings: {
                  fixFailingChecks: true,
                  addressReviewComments: true,
                  reviewEachHead: true,
                },
              },
            },
          );
          expect(defaults.ok(), await defaults.text()).toBe(true);
        },
        async afterGoto(page) {
          const toggle = page.getByRole('switch', {
            name: 'Watch Task pull requests',
          });
          await expect(toggle).toBeVisible();
          await expect(toggle).toBeEnabled();
          await expect(toggle).toBeChecked();
          await expect(
            page.getByRole('combobox', { name: 'Fix attempts' }),
          ).toHaveValue('3');
          await expect(
            page.getByRole('heading', { name: 'Other Task pull requests' }),
          ).toBeVisible();
          const groupHeading = page.getByRole('heading', {
            name: 'Other Task pull requests',
          });
          const headingBox = await groupHeading.boundingBox();
          expect(headingBox).not.toBeNull();
          const rowBottom = await page
            .getByRole('combobox', { name: 'Fix attempts' })
            .evaluate(
              (element) =>
                element.closest('.page-row')!.getBoundingClientRect().bottom,
            );
          expect(headingBox!.y - rowBottom).toBeGreaterThanOrEqual(16);
          await expect(
            page.getByRole('switch', { name: 'Review each new head' }),
          ).toBeChecked();
          await expect(
            page.getByRole('link', { name: 'Agent feedback', exact: true }),
          ).toHaveCount(0);
        },
        async cleanup() {
          try {
            if (projectCreated) {
              const deleted = await projectFixture!.request.delete(
                `${resolveE2EApiBase()}/api/projects/${projectSlug}`,
              );
              expect(deleted.ok()).toBe(true);
            }
          } finally {
            expect(
              (
                await projectFixture!.request.put(
                  `${resolveE2EApiBase()}/api/feature-previews/pull-request-head-review`,
                  { data: { enabled: previousHeadReview } },
                )
              ).ok(),
            ).toBe(true);
            await projectFixture?.restore();
          }
        },
      };
      const noRepositorySlug = `gallery-pr-no-repo-${theme}-${viewport.width}`;
      let noRepositoryFixture: ReturnType<typeof preview> | undefined;
      let noRepositoryCreated = false;
      const noRepositoryScreen: Screen = {
        name: `project-pull-requests-no-repository-${theme}-${form}`,
        title: `Project pull requests setup — ${theme}, ${viewport.width}px`,
        path: `/projects/${noRepositorySlug}/edit?section=pull-requests`,
        viewport,
        captureTheme: theme,
        async beforeGoto(page) {
          noRepositoryFixture = preview(page);
          await noRepositoryFixture.enable();
          const created = await noRepositoryFixture.request.post(
            `${resolveE2EApiBase()}/api/projects`,
            { data: { name: 'Design notes', slug: noRepositorySlug } },
          );
          expect(created.ok(), await created.text()).toBe(true);
          noRepositoryCreated = true;
        },
        async afterGoto(page) {
          await expect(
            page.getByText('Add a repository to use pull requests'),
          ).toBeVisible();
          await expect(
            page.getByRole('button', { name: 'Open Sources' }),
          ).toBeVisible();
          await expect(
            page.getByRole('switch', { name: 'Watch Task pull requests' }),
          ).toHaveCount(0);
          await expect(
            page.getByRole('button', { name: 'Save', exact: true }),
          ).toHaveCount(0);
        },
        async cleanup() {
          try {
            if (noRepositoryCreated)
              expect(
                (
                  await noRepositoryFixture!.request.delete(
                    `${resolveE2EApiBase()}/api/projects/${noRepositorySlug}`,
                  )
                ).ok(),
              ).toBe(true);
          } finally {
            await noRepositoryFixture?.restore();
          }
        },
      };
      return [taskScreen, projectScreen, noRepositoryScreen];
    }),
  );
}

function taskCapabilityScreens(): Screen[] {
  return (['dark', 'light'] as const).flatMap((theme) =>
    [DESKTOP, MOBILE].map((viewport): Screen => {
      const slug = `gallery-task-tools-${theme}-${viewport.width}`;
      let request: ReturnType<typeof createAuthenticatedE2ERequest>;
      let previousEnabled = false;
      let previewChanged = false;
      let reviewPreviousEnabled = false;
      let reviewChanged = false;
      let releasePreview!: () => void;
      let previewRequested!: Promise<void>;
      let previewRoute: ((route: Route) => Promise<void>) | undefined;
      let pageForCleanup: Page | undefined;
      let projectCreated = false;
      const screen: Screen = {
        name: `task-capabilities-${theme}-${viewport.width === DESKTOP.width ? 'desktop' : 'mobile'}`,
        title: `Task capabilities — ${theme}, ${viewport.width}px`,
        path: '/',
        viewport,
        async beforeGoto(page) {
          pageForCleanup = page;
          request = createAuthenticatedE2ERequest(page.request);
          const previews = await request.get(
            `${resolveE2EApiBase()}/api/feature-previews`,
          );
          expect(previews.ok()).toBe(true);
          const catalog = await previews.json();
          const preview = catalog.data.find(
            (entry: { id: string }) => entry.id === 'task-capabilities',
          );
          expect(preview).toBeDefined();
          previousEnabled = preview.enabled;
          const reviewPreview = catalog.data.find(
            (entry: { id: string }) => entry.id === 'task-review',
          );
          expect(reviewPreview).toBeDefined();
          reviewPreviousEnabled = reviewPreview.enabled;
          const enabledReview = await request.put(
            `${resolveE2EApiBase()}/api/feature-previews/task-review`,
            { data: { enabled: true } },
          );
          expect(enabledReview.ok()).toBe(true);
          reviewChanged = true;
          const enabled = await request.put(
            `${resolveE2EApiBase()}/api/feature-previews/task-capabilities`,
            { data: { enabled: true } },
          );
          expect(enabled.ok()).toBe(true);
          previewChanged = true;
          const project = await request.post(
            `${resolveE2EApiBase()}/api/projects`,
            { data: { name: slug, slug } },
          );
          expect(project.ok()).toBe(true);
          projectCreated = true;
          const task = await request.post(`${resolveE2EApiBase()}/api/tasks`, {
            data: {
              projectId: slug,
              title: 'Review the documentation change',
              createdBy: 'user',
            },
          });
          expect(task.ok()).toBe(true);
          const created = await task.json();
          expect(created.data.id).toBeTruthy();
          screen.path = `/tasks/${encodeURIComponent(created.data.id)}?taskView=overview`;
          let requested!: () => void;
          previewRequested = new Promise<void>((resolveRequested) => {
            requested = resolveRequested;
          });
          const release = new Promise<void>((resolveRelease) => {
            releasePreview = resolveRelease;
          });
          previewRoute = async (route) => {
            if (route.request().method() !== 'GET') return route.continue();
            const response = await route.fetch();
            requested();
            await release;
            await route.fulfill({ response });
          };
          await page.route('**/api/feature-previews', previewRoute);
        },
        async afterGoto(page) {
          await page.evaluate(
            (selected) =>
              document.documentElement.setAttribute('data-theme', selected),
            theme,
          );
          const testInfo = test.info();
          const tabs = page.getByRole('tablist', { name: 'Task views' });
          const overview = tabs.getByRole('tab', { name: 'Overview' });
          const details = tabs.getByRole('tab', { name: 'Details' });
          const visibleWithinStrip = async () => {
            const strip = await tabs.boundingBox();
            const tab = await details.boundingBox();
            expect(strip).not.toBeNull();
            expect(tab).not.toBeNull();
            expect(tab!.x).toBeGreaterThanOrEqual(strip!.x);
            expect(tab!.x + tab!.width).toBeLessThanOrEqual(
              strip!.x + strip!.width,
            );
          };
          await overview.focus();
          const readingPosition = await page.evaluate(() => window.scrollY);
          await page.keyboard.press('End');
          await expect(details).toBeFocused();
          await expect(details).toHaveAttribute('aria-selected', 'true');
          await expect(page).toHaveURL(/taskView=details/);
          await visibleWithinStrip();
          const detailsPanel = page.getByRole('tabpanel', { name: 'Details' });
          await detailsPanel.evaluate((panel) => {
            panel.scrollTop = 100;
          });
          const panelScroll = await detailsPanel.evaluate(
            (panel) => panel.scrollTop,
          );
          expect(panelScroll).toBeGreaterThan(0);
          expect(await page.evaluate(() => window.scrollY)).toBe(
            readingPosition,
          );
          if (viewport.width === MOBILE.width) {
            for (const width of [390, 393]) {
              await page.setViewportSize({ width, height: viewport.height });
              await tabs.evaluate((strip) => {
                strip.scrollLeft = 0;
              });
              writeFileSync(
                join(
                  GALLERY_DIR,
                  GALLERY_DIAGNOSTICS,
                  `task-tabs-${theme}-${width}-clipped-injected.png`,
                ),
                await page.screenshot({
                  path: testInfo.outputPath(
                    `task-tabs-${theme}-${width}-clipped-injected.png`,
                  ),
                }),
              );
              await page.keyboard.press('Shift+Tab');
              await page.keyboard.press('Tab');
              await expect(details).toBeFocused();
              await expect(details).toHaveAttribute('aria-selected', 'true');
              expect(
                await detailsPanel.evaluate((panel) => panel.scrollTop),
              ).toBe(panelScroll);
              await visibleWithinStrip();
              const outline = await details.evaluate(
                (button) => getComputedStyle(button).outlineWidth,
              );
              expect(Number.parseFloat(outline)).toBeGreaterThan(0);
              expect(await page.evaluate(() => window.scrollY)).toBe(
                readingPosition,
              );
              writeFileSync(
                join(
                  GALLERY_DIR,
                  GALLERY_DIAGNOSTICS,
                  `task-tabs-${theme}-${width}-focus-revealed.png`,
                ),
                await page.screenshot({
                  path: testInfo.outputPath(
                    `task-tabs-${theme}-${width}-focus-revealed.png`,
                  ),
                }),
              );
            }
            const cdp = await page.context().newCDPSession(page);
            let touchFailure: unknown;
            try {
              await cdp.send('Emulation.setTouchEmulationEnabled', {
                enabled: true,
              });
              for (const width of [390, 393]) {
                await page.setViewportSize({ width, height: viewport.height });
                const box = await tabs.boundingBox();
                expect(box).not.toBeNull();
                await tabs.evaluate((strip) => {
                  strip.scrollLeft = 0;
                });
                const y = box!.y + box!.height / 2;
                await cdp.send('Input.dispatchTouchEvent', {
                  type: 'touchStart',
                  touchPoints: [{ x: box!.x + box!.width - 35, y }],
                });
                await cdp.send('Input.dispatchTouchEvent', {
                  type: 'touchMove',
                  touchPoints: [{ x: box!.x + 35, y }],
                });
                await cdp.send('Input.dispatchTouchEvent', {
                  type: 'touchEnd',
                  touchPoints: [],
                });
                await expect
                  .poll(() => tabs.evaluate((strip) => strip.scrollLeft))
                  .toBeGreaterThan(0);
                await expect(details).toHaveAttribute('aria-selected', 'true');
                expect(
                  await detailsPanel.evaluate((panel) => panel.scrollTop),
                ).toBe(panelScroll);
              }
            } catch (error) {
              touchFailure = error;
            } finally {
              try {
                await cdp.send('Emulation.setTouchEmulationEnabled', {
                  enabled: false,
                });
              } catch (error) {
                touchFailure ??= error;
              }
              try {
                await cdp.detach();
              } catch (error) {
                touchFailure ??= error;
              }
            }
            if (touchFailure) throw touchFailure;
            await page.setViewportSize(viewport);
          }
          await previewRequested;
          await expect(tabs.getByRole('tab', { name: 'Review' })).toHaveCount(
            0,
          );
          releasePreview();
          const review = tabs.getByRole('tab', { name: 'Review' });
          await expect(review).toBeVisible();
          await expect(details).toHaveAttribute('aria-selected', 'true');
          await visibleWithinStrip();
          await tabs.getByRole('tab', { name: 'Conversation' }).click();
          await page.keyboard.press('ArrowRight');
          await expect(review).toBeFocused();
          await expect(review).toHaveAttribute('aria-selected', 'true');
          await expect(page).toHaveURL(/taskView=review/);
          await page.keyboard.press('ArrowRight');
          await expect(page).toHaveURL(/taskView=work-chats/);
          await page.keyboard.press('ArrowLeft');
          await expect(page).toHaveURL(/taskView=review/);
          await page.goto(screen.path);
          await page.goBack();
          await expect(page).toHaveURL(/taskView=review/);
          await expect(review).toHaveAttribute('aria-selected', 'true');
          await page.goForward();
          await expect(page).toHaveURL(/taskView=overview/);
          await expect(overview).toHaveAttribute('aria-selected', 'true');
          await overview.focus();
          await page.keyboard.press('Home');
          await expect(overview).toBeFocused();
          await expect(overview).toHaveAttribute('aria-selected', 'true');
          if (previewRoute) {
            await page.unroute('**/api/feature-previews', previewRoute);
            previewRoute = undefined;
          }
          const restoredReview = await request.put(
            `${resolveE2EApiBase()}/api/feature-previews/task-review`,
            { data: { enabled: reviewPreviousEnabled } },
          );
          expect(restoredReview.ok()).toBe(true);
          reviewChanged = false;
          if (!reviewPreviousEnabled) {
            await page.goto(screen.path);
            await expect(tabs.getByRole('tab', { name: 'Review' })).toHaveCount(
              0,
            );
            await expect(overview).toHaveAttribute('aria-selected', 'true');
          }
          await page.evaluate(
            (selected) =>
              document.documentElement.setAttribute('data-theme', selected),
            theme,
          );
          const panel = page.getByRole('region', {
            name: 'Capabilities and evidence',
          });
          await expect(panel).toBeVisible();
          await panel
            .getByRole('button', { name: 'Inspect Project tools' })
            .click();
          const search = panel.getByRole('searchbox', {
            name: 'Find a Project tool',
          });
          await expect(search).toBeVisible();
          await search.fill('Station Docs');
          await panel
            .locator('summary')
            .filter({ hasText: 'Station Docs' })
            .click();
          await expect(
            panel.getByText('From Station', { exact: true }),
          ).toBeVisible();
          await expect(
            panel.getByText('Project permits source', { exact: true }),
          ).toBeVisible();
          const heading = panel.getByRole('heading', {
            name: 'Capabilities and evidence',
          });
          const headingBox = await heading.boundingBox();
          const tabBox = await page
            .getByRole('tablist', { name: 'Task views' })
            .boundingBox();
          expect(headingBox).not.toBeNull();
          expect(tabBox).not.toBeNull();
          const top = tabBox!.y + tabBox!.height + 16;
          await page.mouse.move(
            viewport.width / 2,
            (top + viewport.height) / 2,
          );
          await page.mouse.wheel(0, headingBox!.y - top);
          await expect
            .poll(async () => (await heading.boundingBox())?.y)
            .toBeCloseTo(top, 0);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
        },
        async cleanup() {
          try {
            if (projectCreated) {
              const deleted = await request.delete(
                `${resolveE2EApiBase()}/api/projects/${slug}`,
              );
              expect(deleted.ok()).toBe(true);
            }
          } finally {
            releasePreview?.();
            if (previewRoute)
              await pageForCleanup?.unroute(
                '**/api/feature-previews',
                previewRoute,
              );
            if (reviewChanged) {
              const restored = await request.put(
                `${resolveE2EApiBase()}/api/feature-previews/task-review`,
                { data: { enabled: reviewPreviousEnabled } },
              );
              expect(restored.ok()).toBe(true);
            }
            if (previewChanged) {
              const restored = await request.put(
                `${resolveE2EApiBase()}/api/feature-previews/task-capabilities`,
                { data: { enabled: previousEnabled } },
              );
              expect(restored.ok()).toBe(true);
            }
          }
        },
      };
      return screen;
    }),
  );
}

function appsLibraryScreens(details = false): Screen[] {
  return (['dark', 'light'] as const).flatMap((theme) =>
    [DESKTOP, MOBILE].map((viewport): Screen => {
      let cleanups: (() => Promise<void>)[] = [];
      return {
        name: `apps-${details ? 'details' : 'library'}-${theme}-${viewport.width === 390 ? 'mobile' : 'desktop'}`,
        title: `Apps ${details ? 'details' : 'library'} — ${theme}, ${viewport.width}px`,
        path: '/',
        viewport,
        beforeGoto: async (page) => {
          cleanups = [
            await withRoute(page, '**/api/feature-previews', (route) => {
              if (route.request().method() !== 'GET')
                return rejectUnexpectedFixtureRequest(route);
              return route.fulfill({
                json: {
                  success: true,
                  data: [{ id: 'apps-library', enabled: true }],
                },
              });
            }),
            await withRoute(page, '**/api/me/layouts', (route) => {
              if (route.request().method() !== 'GET')
                return rejectUnexpectedFixtureRequest(route);
              return route.fulfill({
                json: {
                  success: true,
                  data: [
                    {
                      id: 'morning',
                      slug: 'morning',
                      type: 'custom',
                      name: 'Morning brief',
                      icon: '☀️',
                      description: 'Decisions, active Tasks and recent work.',
                    },
                    {
                      id: 'review',
                      slug: 'review',
                      type: 'custom',
                      name: 'Review desk',
                      icon: '🌿',
                      description:
                        'Release notes and the work that needs a closer look.',
                    },
                    {
                      id: 'tools',
                      slug: 'tools',
                      type: 'custom',
                      name: 'Tool desk',
                      plugin: 'acme-tools',
                      description:
                        'A personal workspace with installed plugin panes.',
                    },
                  ],
                },
              });
            }),
          ];
        },
        afterGoto: async (page) => {
          await page.evaluate(
            (selected) =>
              document.documentElement.setAttribute('data-theme', selected),
            theme,
          );
          if (viewport.width === 390)
            await page
              .getByRole('button', { name: 'Toggle menu', exact: true })
              .click();
          await page
            .getByRole('button', { name: 'Browse apps', exact: true })
            .click();
          const library = page.getByRole('dialog', {
            name: 'Apps',
            exact: true,
          });
          await expect(
            library.getByRole('button', {
              name: 'Morning brief Personal Board Decisions, active Tasks and recent work.',
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            library.getByRole('region', { name: 'Plugin layouts' }),
          ).toBeVisible();
          if (details) {
            await library
              .getByRole('button', { name: 'Edit Morning brief details' })
              .click();
            await expect(
              page
                .getByRole('dialog', { name: 'Edit app details' })
                .getByRole('textbox', { name: 'Description', exact: true }),
            ).toHaveValue('Decisions, active Tasks and recent work.');
          }
        },
        cleanup: async () => {
          for (const cleanup of cleanups) await cleanup();
          cleanups = [];
        },
      };
    }),
  );
}

/**
 * #5064/#5072: the Project Overview groups and the Overview and notifications
 * settings section, both behind the `project-overview` Feature Preview. The
 * Tasks, their runs and their pull request facts are fixtures (no forge is
 * read), seeded so every group is populated, including the green pull request
 * nobody armed ("Not queued") and an auto-resolved Task with its Reopen menu.
 */
function projectOverviewScreens(): Screen[] {
  const DAY = 86_400_000;
  return (['dark', 'light'] as const).flatMap((theme) =>
    [DESKTOP, MOBILE].flatMap((viewport) =>
      (['overview', 'settings'] as const).map((surface): Screen => {
        const size = viewport.width === DESKTOP.width ? 'desktop' : 'mobile';
        const slug = `gallery-overview-${surface}-${theme}-${viewport.width}`;
        let request: ReturnType<typeof createAuthenticatedE2ERequest>;
        const cleanups: (() => Promise<void>)[] = [];
        let created = false;
        let previousPreview = false;
        return {
          name: `project-overview-${surface === 'overview' ? 'groups' : 'settings'}-${theme}-${size}`,
          title:
            surface === 'overview'
              ? `Project Overview groups — ${theme}, ${viewport.width}px`
              : `Project Overview and notifications settings — ${theme}, ${viewport.width}px`,
          path:
            surface === 'overview'
              ? `/projects/${slug}`
              : `/projects/${slug}/edit?section=overview`,
          viewport,
          async beforeGoto(page) {
            request = createAuthenticatedE2ERequest(page.request);
            const previews = await request.get(
              `${resolveE2EApiBase()}/api/feature-previews`,
            );
            expect(previews.ok()).toBe(true);
            const preview = (await previews.json()).data.find(
              (item: { id: string }) => item.id === 'project-overview',
            );
            expect(preview).toBeDefined();
            previousPreview = preview.enabled;
            const enabled = await request.put(
              `${resolveE2EApiBase()}/api/feature-previews/project-overview`,
              { data: { enabled: true } },
            );
            expect(enabled.ok()).toBe(true);
            cleanups.push(async () => {
              const restored = await request.put(
                `${resolveE2EApiBase()}/api/feature-previews/project-overview`,
                { data: { enabled: previousPreview } },
              );
              expect(restored.ok()).toBe(true);
            });
            const response = await request.post(
              `${resolveE2EApiBase()}/api/projects`,
              { data: { name: 'Billing platform', slug } },
            );
            expect(response.ok()).toBe(true);
            created = true;
            if (surface === 'settings') return;

            const now = Date.now();
            const at = (msAgo: number) => new Date(now - msAgo).toISOString();
            const task = (
              id: string,
              title: string,
              overrides: Record<string, unknown> = {},
            ) => ({
              id: `${slug}-${id}`,
              projectId: slug,
              title,
              description: '',
              priority: 'normal',
              status: 'in_progress',
              agentId: 'claude',
              createdBy: 'user',
              createdAt: at(20 * DAY),
              updatedAt: at(2 * 3_600_000),
              sessionId: `${slug}-run-${id}`,
              ...overrides,
            });
            const tasks = [
              task('ask', 'Choose the invoice numbering scheme'),
              task('blocked', 'Unblock the tax provider sandbox', {
                status: 'blocked',
                sessionId: undefined,
              }),
              task('run', 'Refresh the onboarding copy'),
              task('review', 'Review the export redesign'),
              task('stall', 'Ship the billing banner'),
              task('queued', 'Tighten the API rate limits'),
              task('idle', 'Write the release notes', {
                latestReport: {
                  text: 'Drafted notes for 4.2; waiting on the final changelog.',
                  at: at(3_600_000),
                },
              }),
              task('quiet', 'Audit unused feature flags', {
                updatedAt: at(10 * DAY),
              }),
              task('merged', 'Migrate settings storage'),
            ];
            const session = (
              id: string,
              overrides: Record<string, unknown> = {},
            ) => ({
              provider: 'claude',
              threadId: `${slug}-run-${id}`,
              status: 'ready',
              controlMode: 'station-owned',
              answerability: { answerable: true },
              isLoaded: true,
              isPersisted: true,
              eventCount: 6,
              createdAt: at(DAY),
              updatedAt: at(2 * 3_600_000),
              ...overrides,
            });
            const sessions = [
              session('ask', {
                lifecycleState: 'needs_input',
                transitionReason: 'input_requested',
              }),
              session('run', {
                lifecycleState: 'running',
                hasActiveTurn: true,
              }),
              session('review'),
              session('stall'),
              session('queued'),
              session('idle'),
              session('quiet', {
                createdAt: at(11 * DAY),
                updatedAt: at(10 * DAY),
              }),
              session('merged'),
            ];
            const pr = (
              ref: string,
              status: Record<string, unknown>,
            ): Record<string, unknown> => ({
              provider: 'github',
              host: 'github.com',
              repository: { owner: 'example', name: 'billing' },
              ref,
              url: `https://github.com/example/billing/pull/${ref}`,
              observedAt: at(60_000),
              status: {
                state: 'current',
                pullRequestState: 'OPEN',
                mergeability: 'mergeable',
                ...status,
              },
            });
            const facts: Record<string, Record<string, unknown>[]> = {
              review: [
                pr('412', {
                  readiness: 'blocked',
                  reviewDecision: 'review_required',
                }),
              ],
              stall: [pr('415', { readiness: 'clean', landing: 'not-queued' })],
              queued: [
                pr('418', { readiness: 'clean', landing: 'merge-queue' }),
              ],
              merged: [pr('409', { pullRequestState: 'MERGED' })],
            };
            const tasksRoute = (url: URL) => url.pathname === '/api/tasks';
            const tasksHandler = (route: Route) => {
              if (route.request().method() !== 'GET')
                return rejectUnexpectedFixtureRequest(route);
              return route.fulfill({ json: { success: true, data: tasks } });
            };
            await page.route(tasksRoute, tasksHandler);
            cleanups.push(() => page.unroute(tasksRoute, tasksHandler));
            cleanups.push(
              await withRoute(
                page,
                '**/api/tasks/pull-request-facts*',
                (route) => {
                  if (route.request().method() !== 'GET')
                    return rejectUnexpectedFixtureRequest(route);
                  return route.fulfill({
                    json: {
                      success: true,
                      data: {
                        observedAt: at(60_000),
                        tasks: Object.fromEntries(
                          tasks.map((item) => [
                            item.id,
                            {
                              taskCreatedAt: item.createdAt,
                              pullRequests:
                                facts[item.id.slice(slug.length + 1)] ?? [],
                            },
                          ]),
                        ),
                      },
                    },
                  });
                },
              ),
            );
            cleanups.push(
              await withRoute(
                page,
                '**/api/orchestration/sessions/read-model',
                (route) => {
                  if (route.request().method() !== 'GET')
                    return rejectUnexpectedFixtureRequest(route);
                  return route.fulfill({
                    json: { success: true, data: sessions },
                  });
                },
              ),
            );
          },
          async afterGoto(page) {
            await page.evaluate(
              (selected) =>
                document.documentElement.setAttribute('data-theme', selected),
              theme,
            );
            if (surface === 'settings') {
              const section = page.locator('#section-overview');
              await expect(
                section.getByRole('combobox', { name: 'Resolve idle Tasks' }),
              ).toHaveValue('7');
              await expect(
                section.getByRole('combobox', { name: 'Notify me' }),
              ).toBeEnabled();
              await section.scrollIntoViewIfNeeded();
              return;
            }
            const overview = page.locator('.project-overview');
            for (const label of [
              'Waiting on you',
              'Ready for review',
              'Working',
              'Landing',
              'Idle',
            ])
              await expect(
                overview.getByRole('heading', {
                  name: new RegExp(`^${label}`),
                }),
              ).toBeVisible();
            await expect(overview.getByText(/Not queued/)).toBeVisible();
            await overview
              .getByRole('button', { name: /^Resolved · 2$/ })
              .click();
            await expect(
              overview.getByText('Auto-resolved', { exact: true }),
            ).toBeVisible();
            // The last row can be scrolled clear of the collapsed dock: the
            // page reserves room for it below the list. Shown that way, and
            // asserted, so the capture proves it is reachable.
            const last = overview.locator('.project-overview__row').last();
            await last.evaluate((row) =>
              row.scrollIntoView({ block: 'center' }),
            );
            const dock = await page
              .locator('.chat-dock.is-collapsed')
              .boundingBox();
            const lastBox = await last.boundingBox();
            expect(lastBox).not.toBeNull();
            if (dock)
              expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(dock.y);
          },
          async cleanup() {
            for (const cleanup of cleanups.splice(0)) await cleanup();
            if (created) {
              const removed = await request.delete(
                `${resolveE2EApiBase()}/api/projects/${slug}`,
              );
              expect(removed.ok()).toBe(true);
            }
          },
        };
      }),
    ),
  );
}

function projectRepositorySourceScreens(): Screen[] {
  return (['dark', 'light'] as const).flatMap((theme) =>
    [false, true].flatMap((accessDetails) =>
      [DESKTOP, MOBILE].map((viewport): Screen => {
        const slug = `gallery-repository-${accessDetails ? 'access' : 'sources'}-${theme}-${viewport.width}`;
        let request: ReturnType<typeof createAuthenticatedE2ERequest>;
        const cleanups: (() => Promise<void>)[] = [];
        let created = false;
        let previousPreview = false;
        return {
          name: `project-repository-${accessDetails ? 'access' : 'sources'}-${theme}-${viewport.width === DESKTOP.width ? 'desktop' : 'mobile'}`,
          title: `Project repository sources — ${theme}, ${viewport.width}px`,
          path: `/projects/${slug}/edit?section=resources`,
          viewport,
          async beforeGoto(page) {
            request = createAuthenticatedE2ERequest(page.request);
            const previews = await request.get(
              `${resolveE2EApiBase()}/api/feature-previews`,
            );
            expect(previews.ok()).toBe(true);
            const preview = (await previews.json()).data.find(
              (item: { id: string }) => item.id === 'repository-auth-details',
            );
            expect(preview).toBeDefined();
            previousPreview = preview.enabled;
            const enabled = await request.put(
              `${resolveE2EApiBase()}/api/feature-previews/repository-auth-details`,
              { data: { enabled: true } },
            );
            expect(enabled.ok()).toBe(true);
            cleanups.push(async () => {
              const restored = await request.put(
                `${resolveE2EApiBase()}/api/feature-previews/repository-auth-details`,
                { data: { enabled: previousPreview } },
              );
              expect(restored.ok()).toBe(true);
            });
            cleanups.push(
              await withRoute(
                page,
                '**/api/integrations/status?include=github-authentication',
                (route) => {
                  if (route.request().method() !== 'GET')
                    return rejectUnexpectedFixtureRequest(route);
                  return route.fulfill({
                    json: {
                      success: true,
                      data: {
                        connections: [
                          {
                            connectionId: 'github',
                            provider: 'github',
                            actions: [
                              {
                                action: 'read',
                                computedBy: 'github.gh-auth-status',
                                state: 'unverified',
                                reason:
                                  'Repository permissions have not been checked.',
                              },
                            ],
                            authentication: {
                              state: 'signed-in',
                              observedAt: 1793836800000,
                              account: 'example-user',
                              scopes: ['repo', 'read:org'],
                            },
                          },
                        ],
                      },
                    },
                  });
                },
              ),
            );

            const response = await request.post(
              `${resolveE2EApiBase()}/api/projects`,
              { data: { name: 'Station documentation', slug } },
            );
            expect(response.ok()).toBe(true);
            created = true;
            const project = (await response.json()).data;
            const identity = {
              schemaVersion: 1 as const,
              id: `portable-${slug}`,
              repos: [
                {
                  kind: 'git' as const,
                  id: 'github.com/example/station',
                  canonicalRemote: 'github.com/example/station',
                  role: 'primary' as const,
                  label: 'Station repository',
                },
                {
                  kind: 'git' as const,
                  id: 'gitlab.com/example/docs',
                  canonicalRemote: 'gitlab.com/example/docs',
                },
              ],
              executionRoot: {
                repoId: 'gitlab.com/example/docs',
                path: 'manual',
              },
              createdAt: '2026-11-05T00:00:00.000Z',
              updatedAt: '2026-11-05T00:00:00.000Z',
            } satisfies import('@kontourai/station-contracts/project-identity').ProjectPortableIdentity;
            cleanups.push(
              await withRoute(
                page,
                `**/api/projects/${slug}/identity`,
                (route) => {
                  if (route.request().method() !== 'GET')
                    return rejectUnexpectedFixtureRequest(route);
                  return route.fulfill({
                    json: {
                      success: true,
                      data: {
                        identity,
                        association: {
                          portableProjectId: identity.id,
                          localProjectId: project.id,
                          localProjectSlug: slug,
                        },
                      },
                    },
                  });
                },
              ),
            );
            const resolution = {
              posture: 'backing',
              primary: { named: true, resourceId: identity.repos[0].id },
              resources: [
                {
                  state: 'bound',
                  resourceId: identity.repos[0].id,
                  path: '/srv/code/station',
                },
                {
                  state: 'missing',
                  resourceId: identity.repos[1].id,
                  record: 'binding',
                  declaredPath: '/srv/code/docs',
                  reason:
                    'The recorded working copy is unavailable on this Station.',
                },
              ],
            } satisfies import('@kontourai/station-contracts/project-identity').ProjectResolutionView;
            cleanups.push(
              await withRoute(
                page,
                `**/api/projects/${slug}/resolution`,
                (route) => {
                  if (route.request().method() !== 'GET')
                    return rejectUnexpectedFixtureRequest(route);
                  return route.fulfill({
                    json: { success: true, data: resolution },
                  });
                },
              ),
            );
          },
          async afterGoto(page) {
            await page.evaluate(
              (selected) =>
                document.documentElement.setAttribute('data-theme', selected),
              theme,
            );
            const sources = page.locator('[aria-label="Repository sources"]');
            await expect(
              sources.getByRole('link', {
                name: 'example/station',
                exact: true,
              }),
            ).toHaveAttribute('href', 'https://github.com/example/station');
            await expect(
              sources.getByText(
                'The saved folder was not found. Check its location.',
                { exact: true },
              ),
            ).toBeVisible();
            await expect(
              sources.getByText('Working copy verified', { exact: true }),
            ).toHaveCount(0);
            const first = sources
              .locator('.project-repositories__card')
              .first();
            if (accessDetails) {
              await first
                .getByText('Checkout and access details', { exact: true })
                .click();
              await expect(
                first.getByText('/srv/code/station', { exact: true }),
              ).toBeVisible();
              await expect(
                first.getByText('example-user', { exact: true }),
              ).toBeVisible();
              await expect(
                first.getByText('Not checked by this sign-in check', {
                  exact: true,
                }),
              ).toBeVisible();
            }
            if (viewport.width === MOBILE.width && !accessDetails) {
              const section = page.locator('#section-resources');
              for (const label of [
                'Add a repository',
                'Advanced: checkout repair',
              ]) {
                const summary = section
                  .locator('summary')
                  .and(section.getByText(label, { exact: true }));
                await summary.click();
                await expect(
                  section
                    .locator('details[open] > summary')
                    .filter({ hasText: label }),
                ).toHaveCount(1);
                await expect(summary).toBeInViewport({ ratio: 1 });
                if (label === 'Add a repository') {
                  await expect(
                    section.getByRole('button', {
                      name: 'GitHub',
                      exact: true,
                    }),
                  ).toBeVisible();
                  await expect(
                    section.getByRole('button', {
                      name: 'Git URL',
                      exact: true,
                    }),
                  ).toBeVisible();
                }
                await summary.click();
              }
              await sources
                .getByRole('button', { name: 'Review checkout', exact: true })
                .click();
              const repair = section.getByText('Advanced: checkout repair', {
                exact: true,
              });
              await expect(repair).toBeInViewport({ ratio: 1 });
              await expect(
                section
                  .locator('details[open] > summary')
                  .filter({ hasText: 'Advanced: checkout repair' }),
              ).toHaveCount(1);
              await repair.click();
            }
            const target = accessDetails
              ? first.locator('.project-repositories__access')
              : sources.getByRole('heading', {
                  name: 'Repositories',
                  exact: true,
                });
            const header = await page.locator('.detail-header').boundingBox();
            const body = await page
              .locator('.project-settings__body')
              .boundingBox();
            const subject = await target.boundingBox();
            expect(header).not.toBeNull();
            expect(body).not.toBeNull();
            expect(subject).not.toBeNull();
            const top = Math.max(header!.y + header!.height, body!.y) + 16;
            await page.mouse.move(
              body!.x + body!.width / 2,
              Math.min(viewport.height - 100, top + 150),
            );
            await page.mouse.wheel(0, subject!.y - top);
            await expect
              .poll(async () =>
                Math.abs(((await target.boundingBox())?.y ?? 0) - top),
              )
              .toBeLessThan(3);
            const scroller = await page
              .locator('.project-settings__body')
              .boundingBox();
            const pinnedHeader = await page
              .locator('.detail-header')
              .boundingBox();
            const dock = await page
              .locator('.chat-dock.is-collapsed')
              .boundingBox();
            expect(scroller).not.toBeNull();
            expect(pinnedHeader).not.toBeNull();
            expect(dock).not.toBeNull();
            expect(
              scroller!.y,
              'Sources scroll below the header',
            ).toBeGreaterThanOrEqual(
              pinnedHeader!.y + pinnedHeader!.height - 1,
            );
            expect(
              scroller!.y + scroller!.height,
              'Sources scroll above the collapsed dock',
            ).toBeLessThanOrEqual(dock!.y + 1);
            if (accessDetails) {
              await expect(
                first.getByText('example-user', { exact: true }),
              ).toBeInViewport();
              await expect(
                first.getByText('repo, read:org', { exact: true }),
              ).toBeInViewport();
              await expect(
                first.getByRole('button', {
                  name: 'Check sign-in',
                  exact: true,
                }),
              ).toBeInViewport();
            } else {
              await expect(
                sources.getByRole('button', {
                  name: 'Review checkout',
                  exact: true,
                }),
              ).toBeInViewport();
            }
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
          },
          async cleanup() {
            for (const cleanup of cleanups.splice(0)) await cleanup();
            if (created) {
              const removed = await request.delete(
                `${resolveE2EApiBase()}/api/projects/${slug}`,
              );
              expect(removed.ok()).toBe(true);
            }
          },
        };
      }),
    ),
  );
}

/**
 * Room conversation scenes (#4791): the Project room and the Task room
 * rendered by their real components over browser-projection fixtures
 * (tests/helpers/room-gallery-fixtures.ts), at 390 and 1440 in both themes.
 * Reactions, edits, deletes and channel files draw the history's projected
 * fields (#4796, #4797, #4812).
 */
const ROOM_SCENES = [
  { scene: 'empty', room: 'project' },
  { scene: 'short', room: 'project' },
  { scene: 'long', room: 'project' },
  { scene: 'new-messages', room: 'project' },
  { scene: 'failed-send', room: 'project' },
  { scene: 'mention', room: 'project' },
  { scene: 'agent-pending', room: 'project' },
  { scene: 'agent-abandon', room: 'project' },
  { scene: 'keyboard', room: 'project' },
  { scene: 'channels', room: 'project' },
  { scene: 'reactions', room: 'project' },
  { scene: 'reaction-picker', room: 'project' },
  { scene: 'edited', room: 'project' },
  { scene: 'deleted', room: 'project' },
  { scene: 'attachment', room: 'project' },
  { scene: 'live-mention', room: 'project' },
  { scene: 'agent-working', room: 'project' },
  { scene: 'agent-outcome', room: 'project' },
  { scene: 'thread', room: 'task' },
  { scene: 'working', room: 'task' },
] as const satisfies readonly (
  | { scene: ProjectRoomScene; room: 'project' }
  | { scene: TaskRoomScene; room: 'task' }
)[];

/** A phone control is at least 44px both ways (#4810 review 6). */
async function expectTouchTarget(target: Locator, name: string) {
  const box = await target.boundingBox();
  expect(box, name).not.toBeNull();
  expect(Math.round(box!.height), `${name} height`).toBeGreaterThanOrEqual(44);
  expect(Math.round(box!.width), `${name} width`).toBeGreaterThanOrEqual(44);
}

/** Boxes that intersect by more than a hairline. */
function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  return (
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1
  );
}

function roomConversationScreens(): Screen[] {
  return ROOM_SCENES.flatMap(({ scene, room }) =>
    (['dark', 'light'] as const).flatMap((theme) =>
      [DESKTOP, MOBILE].map((viewport): Screen => {
        const width = viewport.width === DESKTOP.width ? 'desktop' : 'mobile';
        const slug = `gallery-room-${scene}-${theme}-${viewport.width}`;
        let request: ReturnType<typeof createAuthenticatedE2ERequest>;
        let created = false;
        let fixture:
          | Awaited<ReturnType<typeof installProjectRoomFixture>>
          | undefined;
        let cleanupTask: (() => Promise<void>) | undefined;
        let restoreHandshake: (() => Promise<void>) | undefined;
        let closeChannelDialogs: (() => Promise<void>) | undefined;
        const screen: Screen = {
          name: `room-${room === 'task' ? 'task-' : ''}${scene}-${theme}-${width}`,
          title: `${room === 'task' ? 'Task' : 'Project'} room, ${scene} — ${theme}, ${viewport.width}px`,
          path: `/projects/${slug}?section=room`,
          viewport,
          async beforeGoto(page) {
            request = createAuthenticatedE2ERequest(page.request);
            const response = await request.post(
              `${resolveE2EApiBase()}/api/projects`,
              { data: { name: 'Onboarding revamp', slug } },
            );
            expect(response.ok()).toBe(true);
            created = true;
            const project = (await response.json()).data;
            if (room === 'project') {
              if (
                (scene === 'keyboard' || scene === 'channels') &&
                viewport.width === MOBILE.width
              )
                await installKeyboardEmulation(page);
              // A current host serves reactions, edits, deletes and files
              // (#4796, #4797, #4812); the room offers them only on this flag.
              restoreHandshake = await withRoute(
                page,
                '**/.well-known/station/v1',
                (route) =>
                  fulfillGalleryStationHandshake(route, false, {
                    projectRoomMessageActions: true,
                    // The shared live stream, typing and members (#4798).
                    ...(LIVE_ROOM_SCENES.includes(scene)
                      ? { projectRoomLive: true }
                      : {}),
                  }),
              );
              fixture = await installProjectRoomFixture(page, {
                slug,
                projectId: project.id,
                scene,
              });
              return;
            }
            // A fixture Task: a real one cannot be deleted and would change
            // every later screen (see installTaskRoomFixture).
            const installed = await installTaskRoomFixture(page, {
              slug,
              projectUuid: project.id,
              scene,
            });
            cleanupTask = installed.cleanup;
            screen.path = `/tasks/${encodeURIComponent(installed.taskId)}?taskView=conversation`;
          },
          async afterGoto(page) {
            if (scene === 'channels') {
              await expect(page).toHaveURL(
                (url) => url.pathname === `/projects/${slug}`,
              );
              closeChannelDialogs = async () => {
                for (const name of [
                  'Close channels',
                  'Close channel options',
                ]) {
                  const close = page.getByRole('dialog').getByRole('button', {
                    name,
                    exact: true,
                  });
                  if (await close.isVisible()) {
                    await close.click({ timeout: 5000 });
                    await expect(close).toBeHidden();
                  }
                }
                // A drawer can disappear before its cleanup Back commits.
                await expect
                  .poll(() =>
                    page.evaluate(
                      (key) => window.history.state?.[key] ?? null,
                      DIALOG_HISTORY_KEY,
                    ),
                  )
                  .toBeNull();
              };
            }
            await page.evaluate(
              (selected) =>
                document.documentElement.setAttribute('data-theme', selected),
              theme,
            );
            if (room === 'task') {
              await expect(
                page.getByRole('list', { name: 'Task room history' }),
              ).toBeVisible();
              if (scene === 'thread') {
                await expect(
                  page.getByRole('img', { name: 'crash-report.png' }),
                ).toBeVisible();
                if (viewport.width === MOBILE.width)
                  await expectTouchTarget(
                    page.getByRole('button', { name: '3 replies' }),
                    'Thread replies',
                  );
              }
              if (scene === 'working')
                await expect(
                  page.getByRole('button', { name: 'Watch' }),
                ).toBeVisible();
              return;
            }
            const roomRegion = page.getByRole('region', {
              name: 'Project room',
              exact: true,
            });
            await expect(roomRegion).toBeVisible();
            // Presence faces sit side by side; initials never overlap (#4810 review 8).
            const expectSeparateFaces = async () => {
              const faces = await roomRegion
                .locator('.project-room__faces > .task-room-avatar')
                .evaluateAll((nodes) =>
                  nodes.map((node) => {
                    const box = node.getBoundingClientRect();
                    return {
                      x: box.x,
                      y: box.y,
                      width: box.width,
                      height: box.height,
                    };
                  }),
                );
              expect(faces.length).toBeGreaterThan(1);
              for (let index = 1; index < faces.length; index += 1)
                expect(
                  overlaps(faces[index - 1]!, faces[index]!),
                  'presence faces overlap',
                ).toBe(false);
            };
            if (scene === 'empty') {
              await expect(
                roomRegion.getByText('Start a chat with your project team.'),
              ).toBeVisible();
              await expectSeparateFaces();
              return;
            }
            const conversation = roomRegion.getByRole('list', {
              name: 'Conversation',
            });
            await expect(
              conversation
                .getByText('Good catch', { exact: false })
                .or(
                  conversation.getByText('ship it tomorrow', { exact: false }),
                ),
            ).toBeVisible();
            const composer = roomRegion.getByRole('textbox', {
              name: /^Message/,
            });
            if (scene === 'failed-send') {
              await composer.fill('Can we move the review to 4pm?');
              await roomRegion.getByRole('button', { name: /^Send/ }).click();
              await expect(
                roomRegion.getByRole('button', { name: /Retry/ }),
              ).toBeVisible();
              if (viewport.width === MOBILE.width) {
                await expectTouchTarget(
                  roomRegion.getByRole('button', {
                    name: 'Retry same message',
                  }),
                  'Retry',
                );
                await expectTouchTarget(
                  roomRegion.getByRole('button', { name: 'Discard' }),
                  'Discard',
                );
              }
            }
            if (scene === 'mention') {
              await composer.click();
              await composer.pressSequentially('@');
            }
            if (scene === 'live-mention') {
              // The reader's own mention stands out; someone is typing.
              await expect(
                conversation.locator('.room-mention--self'),
              ).toHaveText('@Maya Chen');
              await expect(
                roomRegion.getByText('Jonas Berg is typing…'),
              ).toBeVisible();
              // A narrowed search, so the list leaves the room above it in view.
              await composer.click();
              await composer.pressSequentially('@Pri');
              await expect(
                roomRegion.getByRole('option', { name: /Priya Natarajan/ }),
              ).toBeVisible();
              if (viewport.width === MOBILE.width)
                await expectTouchTarget(
                  roomRegion.getByRole('option', { name: /Priya Natarajan/ }),
                  'Mention option',
                );
            }
            if (scene === 'agent-working') {
              await expect(
                conversation.getByText('Working on it…'),
              ).toBeVisible();
              await expect(
                conversation.getByText('Scout is working…'),
              ).toBeVisible();
            }
            if (scene === 'agent-outcome') {
              await expect(
                conversation.getByText('Couldn’t finish'),
              ).toBeVisible();
              await expect(
                conversation.getByText('Stopped', { exact: true }),
              ).toBeVisible();
            }
            if (scene === 'keyboard') {
              await composer.click();
              if (viewport.width === DESKTOP.width) {
                // No keyboard at 1440: a reply being typed, Send enabled.
                await composer.pressSequentially('Updating both now');
                await expect(
                  roomRegion.getByRole('button', { name: /^Send/ }),
                ).toBeEnabled();
              }
              if (viewport.width === MOBILE.width) {
                // 844 tall, 544 visible: the keyboard takes 300px (#4810
                // gallery delta 2). Send stays above it, and the room keeps
                // the composer in view as the viewport changes.
                await emulateKeyboard(page, 300);
                const send = roomRegion.getByRole('button', { name: /^Send/ });
                const overhang = async () => {
                  const box = await send.boundingBox();
                  const visible = await page.evaluate(
                    () =>
                      window.visualViewport!.offsetTop +
                      window.visualViewport!.height,
                  );
                  return box ? box.y + box.height - visible : Infinity;
                };
                await expect
                  .poll(overhang, {
                    message: 'Send ends below the visible viewport (px)',
                  })
                  .toBeLessThanOrEqual(0);
                expect((await send.boundingBox())!.y).toBeGreaterThanOrEqual(0);
                // It lands on the keyboard: measuring before the lift settles
                // scrolled too far and left a blank band above the keyboard.
                const gap = await page.evaluate(
                  () =>
                    window.visualViewport!.offsetTop +
                    window.visualViewport!.height -
                    document
                      .querySelector('.project-room .room-composer')!
                      .getBoundingClientRect().bottom,
                );
                expect(
                  gap,
                  'blank band above the keyboard (px)',
                ).toBeLessThanOrEqual(8);
                await expect(composer).toBeFocused();
              }
            }
            if (scene === 'agent-pending' || scene === 'agent-abandon') {
              const mentionScout = async () => {
                await composer.click();
                await composer.pressSequentially('@');
                await roomRegion
                  .getByRole('option', { name: /^Scout Agent @scout\b/ })
                  .click();
              };
              await mentionScout();
              await composer.fill('Check the pricing copy against the plan.');
              await roomRegion
                .getByRole('button', { name: 'Ask Scout', exact: true })
                .click();
              if (scene === 'agent-pending') {
                await expect(
                  roomRegion.getByText(
                    'Agent is working. Its answer will appear in the Room.',
                  ),
                ).toBeVisible();
                // A follow-up for the same Agent waits; Ask is disabled.
                await mentionScout();
                await composer.fill('Also check the FAQ links.');
                await expect(
                  roomRegion.getByRole('button', {
                    name: 'Waiting for Scout…',
                  }),
                ).toBeDisabled();
                await expect(
                  roomRegion
                    .locator('.room-composer__status')
                    .getByText('Waiting for Scout…'),
                ).toBeVisible();
              } else {
                await expect(
                  roomRegion.getByText(/Agent request not confirmed/),
                ).toBeVisible();
                await roomRegion
                  .getByRole('button', { name: 'Abandon this request' })
                  .click();
                const dialog = page.getByRole('dialog', {
                  name: 'Stop tracking this request?',
                });
                await expect(dialog).toBeVisible();
                await expect(
                  dialog.getByRole('button', { name: 'Cancel', exact: true }),
                ).toBeFocused();
                if (viewport.width === MOBILE.width) {
                  await expectTouchTarget(
                    dialog.getByRole('button', { name: 'Cancel', exact: true }),
                    'Cancel',
                  );
                  await expectTouchTarget(
                    dialog.getByRole('button', {
                      name: 'Stop tracking',
                      exact: true,
                    }),
                    'Stop tracking',
                  );
                }
              }
            }
            if (scene === 'channels') {
              // #4792 on the shared conversation: switch to #design, keep a
              // draft across a real reload, then show the channel list over
              // that channel's conversation.
              const phone = viewport.width === MOBILE.width;
              // On a phone the switcher is in the channel's ⋯ sheet (#4795).
              const openChannels = async () => {
                if (phone) {
                  await roomRegion
                    .getByRole('button', { name: 'Channel options' })
                    .click();
                  await page
                    .getByRole('dialog', { name: /^#/ })
                    .getByRole('button', { name: 'Switch channel' })
                    .click();
                } else
                  await roomRegion
                    .getByRole('button', { name: /switch channel$/ })
                    .click();
                return page.getByRole('dialog', { name: 'Channels' });
              };
              const expectChannel = (region: Locator, name: string) =>
                expect(
                  phone
                    ? region.getByRole('heading', { level: 2, name })
                    : region.getByRole('button', {
                        name: new RegExp(`^${name}\\b.*switch channel$`),
                      }),
                ).toBeVisible();
              const list = await openChannels();
              await list
                .getByRole('button', { name: 'design', exact: true })
                .click();
              await expectChannel(roomRegion, 'design');
              await expect(
                roomRegion.getByText('New checkout screens are up for review.'),
              ).toBeVisible();
              const draftText = 'Shorter CTA: “Pay now”';
              await composer.fill(draftText);
              await page.reload();
              const reloaded = page.getByRole('region', {
                name: 'Project room',
              });
              await expectChannel(reloaded, 'design');
              await expect(
                reloaded.getByRole('textbox', { name: /^Message/ }),
              ).toHaveValue(draftText);
              await page.evaluate(
                (selected) =>
                  document.documentElement.setAttribute('data-theme', selected),
                theme,
              );
              if (viewport.width === MOBILE.width) {
                // #4810's keyboard keep-above, inside a non-default channel:
                // the focused composer and Send stay above a 300px keyboard.
                const field = reloaded.getByRole('textbox', {
                  name: /^Message/,
                });
                await field.click();
                await emulateKeyboard(page, 300);
                const send = reloaded.getByRole('button', { name: /^Send/ });
                await expect
                  .poll(
                    async () => {
                      const box = await send.boundingBox();
                      const visible = await page.evaluate(
                        () =>
                          window.visualViewport!.offsetTop +
                          window.visualViewport!.height,
                      );
                      return box ? box.y + box.height - visible : Infinity;
                    },
                    { message: 'Send ends below the visible viewport (px)' },
                  )
                  .toBeLessThanOrEqual(0);
                await expect(field).toBeFocused();
                await expect(field).toHaveValue(draftText);
                await emulateKeyboard(page, 0);
              }
              const reopened = await openChannels();
              await expect(
                reopened.getByRole('button', { name: 'design', exact: true }),
              ).toBeFocused();
              if (viewport.width === MOBILE.width)
                await expectTouchTarget(
                  reopened.getByRole('button', {
                    name: 'launch-plan',
                    exact: true,
                  }),
                  'Channel row',
                );
            }
            if (scene === 'short' && viewport.width === MOBILE.width) {
              // A real reload mints a new activation epoch; the draft is
              // keyed by the reload partition and survives (#4810 review 1).
              const draftText = 'Draft that survives a reload';
              await composer.fill(draftText);
              await page.reload();
              await expect(
                page
                  .getByRole('region', { name: 'Project room', exact: true })
                  .getByRole('textbox', { name: /^Message/ }),
              ).toHaveValue(draftText);
              // Boot re-applies the saved theme; set the scene's after it.
              await page.evaluate(
                (selected) =>
                  document.documentElement.setAttribute('data-theme', selected),
                theme,
              );
            }
            const messageRow = (text: string) =>
              conversation
                .locator('.room-row')
                .filter({ has: page.getByText(text, { exact: true }) });
            if (scene === 'reactions') {
              const pill = conversation.getByRole('button', {
                name: '🙏 3: You, Priya Natarajan and Jonas Berg',
              });
              await expect(pill).toHaveAttribute('aria-pressed', 'true');
              await expect(
                conversation.getByRole('button', {
                  name: '👀 1: Jonas Berg',
                }),
              ).toHaveAttribute('aria-pressed', 'false');
              if (viewport.width === DESKTOP.width) {
                // Who reacted: the pill's tooltip. Keyboard focus shows it as
                // hover does, and survives the capture's resting pointer.
                await pill.focus();
                await expect(
                  conversation.getByRole('tooltip', {
                    name: 'You, Priya Natarajan and Jonas Berg',
                  }),
                ).toBeVisible();
              } else {
                await expectTouchTarget(pill, 'Reaction pill');
                // The phone's actions are a labelled menu behind ⋯ (no
                // tooltips on touch): full-width 44px rows, Delete last and
                // destructive, focus moved in.
                const own = messageRow(
                  'Good catch. Jonas, can you update both before we ship?',
                );
                const more = own.getByRole('button', { name: /^More actions/ });
                await expectTouchTarget(more, 'More actions');
                await more.click();
                const menu = page.getByRole('menu');
                await expect(menu.getByRole('menuitem')).toHaveText([
                  'React',
                  // In the channel, Reply opens the message's thread (#4795).
                  'Reply in thread',
                  'Edit',
                  'Who reacted',
                  'Delete',
                ]);
                await expect(
                  menu.getByRole('menuitem', { name: 'React', exact: true }),
                ).toBeFocused();
                const menuBox = await menu.boundingBox();
                for (const item of await menu.getByRole('menuitem').all()) {
                  const box = await item.boundingBox();
                  expect(
                    Math.round(box!.height),
                    'menu row height',
                  ).toBeGreaterThanOrEqual(44);
                  expect(box!.width, 'menu row spans the menu').toBeGreaterThan(
                    menuBox!.width - 24,
                  );
                }
                await expect(
                  menu.getByRole('menuitem', { name: 'Delete', exact: true }),
                ).toHaveClass(/action-overflow__row--danger/);
              }
            }
            if (scene === 'reaction-picker') {
              const target = messageRow(
                'Morning! The pricing page copy is ready for review.',
              );
              if (viewport.width === DESKTOP.width) {
                await target.hover();
                await target
                  .getByRole('button', { name: 'React to Jonas Berg' })
                  .click();
              } else {
                await target
                  .getByRole('button', { name: /^More actions/ })
                  .click();
                await page
                  .getByRole('menu')
                  .getByRole('menuitem', { name: 'React', exact: true })
                  .click();
              }
              const picker = page.getByRole('dialog', { name: 'Add reaction' });
              await expect(picker).toBeVisible();
              await expect(
                picker.getByRole('heading', { name: 'Recent' }),
              ).toBeVisible();
              if (viewport.width === MOBILE.width) {
                await expectTouchTarget(
                  picker.getByRole('button', { name: '👍' }).first(),
                  'Picker emoji',
                );
                // A sheet over the conversation, not a full-screen takeover.
                const sheet = await page
                  .locator('.room-emoji-picker')
                  .boundingBox();
                expect(sheet!.y, 'picker sheet top (px)').toBeGreaterThan(
                  MOBILE.height * 0.2,
                );
              } else {
                // Search narrows the catalogue as the person types.
                await picker.getByRole('searchbox').fill('par');
                await expect(
                  picker.getByRole('button', { name: '🎉' }),
                ).toBeVisible();
                await picker.getByRole('searchbox').fill('');
              }
            }
            if (scene === 'edited') {
              await expect(
                messageRow(
                  'I kept the three tiers and moved the FAQ under the comparison table.',
                ).getByText('edited', { exact: true }),
              ).toBeVisible();
              // Up in an empty composer edits your last message (#4793).
              await composer.click();
              await composer.press('ArrowUp');
              await expect(
                roomRegion.getByText('Editing message'),
              ).toBeVisible();
              await expect(composer).toHaveValue(
                'Good catch. Jonas, can you update both numbers before we ship?',
              );
              await expect(
                roomRegion.getByRole('button', { name: 'Save edit' }),
              ).toBeDisabled();
            }
            if (scene === 'deleted') {
              // The deleted message keeps its place, takes no actions, and
              // its thread stays reachable from it (#4797 with #4795).
              const tombstone = conversation
                .locator('.room-row')
                .filter({ has: page.getByText('Message deleted') });
              await expect(tombstone).toBeVisible();
              await expect(
                tombstone.getByRole('button', { name: /^More actions/ }),
              ).toHaveCount(0);
              const summary = tombstone.getByRole('button', {
                name: /1 reply/,
              });
              await expect(summary).toBeVisible();
              if (viewport.width === MOBILE.width) {
                // The phone's thread page: the tombstone as its root, the
                // reply under it.
                await summary.click();
                const threadList = roomRegion.getByRole('list', {
                  name: 'Thread',
                });
                await expect(
                  threadList.getByText('Message deleted'),
                ).toBeVisible();
                await expect(
                  threadList.getByText(
                    'Which FAQ do you mean, the billing one?',
                  ),
                ).toBeVisible();
                await expect(
                  roomRegion.getByRole('textbox', { name: 'Reply in thread' }),
                ).toBeVisible();
              }
            }
            if (scene === 'attachment') {
              await expect(
                conversation.getByRole('img', { name: 'pricing-table.png' }),
              ).toBeVisible();
              const file = conversation.getByRole('link', {
                name: 'plan-limits.pdf',
              });
              await expect(file).toBeVisible();
              if (viewport.width === MOBILE.width) {
                await expectTouchTarget(file, 'Attached file');
                await expectTouchTarget(
                  conversation.getByRole('link', {
                    name: 'Open pricing-table.png',
                  }),
                  'Attached image',
                );
              }
              // A file staged in the shared composer, about to be sent.
              await roomRegion.locator('input[type="file"]').setInputFiles({
                name: 'checkout-flow.png',
                mimeType: 'image/png',
                buffer: readFileSync(
                  new URL(
                    '../docs/design/media/browser-device-ux-browser-390.png',
                    import.meta.url,
                  ),
                ),
              });
              // The staged image's thumbnail is its Preview button (the image
              // inside is decorative).
              await expect(
                roomRegion.getByRole('button', {
                  name: 'Preview checkout-flow.png',
                }),
              ).toBeVisible();
              await expect(
                roomRegion.getByRole('button', { name: 'Send message' }),
              ).toBeEnabled();
            }
            if (scene === 'new-messages' && fixture) {
              const box = await roomRegion
                .locator('.room-conversation__scroller')
                .boundingBox();
              expect(box).not.toBeNull();
              await page.mouse.move(
                box!.x + box!.width / 2,
                box!.y + box!.height / 2,
              );
              // Far enough to stop following, near enough to see the divider.
              await page.mouse.wheel(0, -240);
              await expect(
                roomRegion.getByRole('button', { name: /Jump to latest/ }),
              ).toBeVisible();
              fixture.deliver();
              await expect(
                conversation.getByText('Release notes are drafted.'),
              ).toHaveCount(1);
              const jump = roomRegion.getByRole('button', {
                name: `${fixture.arrivals} new messages`,
                exact: false,
              });
              await expect(jump).toBeVisible();
              // Read down to the divider without reaching the end.
              const divider = conversation.locator('.room-divider--unread');
              for (let step = 0; step < 12; step += 1) {
                if (await divider.isVisible()) {
                  const shown = await divider.evaluate((element) => {
                    const box = element.getBoundingClientRect();
                    const port = element
                      .closest('.room-conversation__scroller')!
                      .getBoundingClientRect();
                    return box.bottom <= port.bottom - 64;
                  });
                  if (shown) break;
                }
                await page.mouse.wheel(0, 60);
                await page.waitForTimeout(80);
              }
              await expect(divider).toBeInViewport();
              await expect(jump).toBeVisible();
              if (viewport.width === MOBILE.width) {
                // On a phone the jump control covers no message (#4810 review 8).
                const pill = await jump.boundingBox();
                expect(pill).not.toBeNull();
                const port = await roomRegion
                  .locator('.room-conversation__scroller')
                  .boundingBox();
                const bodies = await conversation
                  .locator('.room-row__main')
                  .evaluateAll((nodes) =>
                    nodes.map((node) => {
                      const box = node.getBoundingClientRect();
                      return {
                        x: box.x,
                        y: box.y,
                        width: box.width,
                        height: box.height,
                      };
                    }),
                  );
                // Only what the list shows can be covered: clip to its port.
                const covered = bodies
                  .map((body) => {
                    const top = Math.max(body.y, port!.y);
                    const bottom = Math.min(
                      body.y + body.height,
                      port!.y + port!.height,
                    );
                    return { ...body, y: top, height: bottom - top };
                  })
                  .filter((body) => body.height > 1 && overlaps(body, pill!));
                expect(covered, 'jump control covers message text').toEqual([]);
              }
              // A resting desktop pointer would hold a row's hover bar open.
              await page.mouse.move(0, 0);
            }
            await expectSeparateFaces();
          },
          async afterAudit() {
            const close = closeChannelDialogs;
            closeChannelDialogs = undefined;
            await close?.();
          },
          async cleanup() {
            const close = closeChannelDialogs;
            closeChannelDialogs = undefined;
            if (close) {
              // A failed capture still has its original error. Record a
              // secondary dialog cleanup failure with the test artifacts.
              await close().catch((error: unknown) =>
                test.info().attach('Channel dialog cleanup failure', {
                  body: String(error),
                  contentType: 'text/plain',
                }),
              );
            }
            await fixture?.cleanup();
            await restoreHandshake?.();
            await cleanupTask?.();
            if (created) {
              const removed = await request.delete(
                `${resolveE2EApiBase()}/api/projects/${slug}`,
              );
              expect(removed.ok()).toBe(true);
            }
          },
        };
        return screen;
      }),
    ),
  );
}

/**
 * #5063: `#general` with its coordinator, at 1440 and 390 in both themes: a
 * routed reply with its suggested-Tasks card (one Task done, two to start,
 * so Start all shows), a settled Task's result and the coordinator bar. The
 * `project-room-coordinator` preview is turned on on the e2e Station and the
 * handshake advertises `projectRoomCoordinator`; the room and its card come
 * from the room fixture.
 */
function roomCoordinatorScreens(): Screen[] {
  return (['dark', 'light'] as const).flatMap((theme) =>
    [DESKTOP, MOBILE].map((viewport): Screen => {
      const width = viewport.width === DESKTOP.width ? 'desktop' : 'mobile';
      const slug = `gallery-coordinator-${theme}-${viewport.width}`;
      let request: ReturnType<typeof createAuthenticatedE2ERequest>;
      let created = false;
      let previousPreview: boolean | undefined;
      let fixture:
        | Awaited<ReturnType<typeof installProjectRoomFixture>>
        | undefined;
      let restoreHandshake: (() => Promise<void>) | undefined;
      return {
        name: `room-coordinator-${theme}-${width}`,
        title: `Project room coordinator — ${theme}, ${viewport.width}px`,
        path: `/projects/${slug}?section=room`,
        viewport,
        async beforeGoto(page) {
          request = createAuthenticatedE2ERequest(page.request);
          const previews = await request.get(
            `${resolveE2EApiBase()}/api/feature-previews`,
          );
          expect(previews.ok()).toBe(true);
          const preview = (await previews.json()).data.find(
            (item: { id: string }) => item.id === 'project-room-coordinator',
          );
          expect(preview).toBeDefined();
          previousPreview = preview.enabled;
          const enabled = await request.put(
            `${resolveE2EApiBase()}/api/feature-previews/project-room-coordinator`,
            { data: { enabled: true } },
          );
          expect(enabled.ok()).toBe(true);
          const response = await request.post(
            `${resolveE2EApiBase()}/api/projects`,
            { data: { name: 'Onboarding revamp', slug } },
          );
          expect(response.ok()).toBe(true);
          created = true;
          const project = (await response.json()).data;
          restoreHandshake = await withRoute(
            page,
            '**/.well-known/station/v1',
            (route) =>
              fulfillGalleryStationHandshake(route, false, {
                projectRoomMessageActions: true,
                projectRoomCoordinator: true,
              }),
          );
          fixture = await installProjectRoomFixture(page, {
            slug,
            projectId: project.id,
            scene: 'coordinator',
          });
        },
        async afterGoto(page) {
          await page.evaluate(
            (selected) =>
              document.documentElement.setAttribute('data-theme', selected),
            theme,
          );
          const roomRegion = page.getByRole('region', {
            name: 'Project room',
            exact: true,
          });
          await expect(roomRegion).toBeVisible();
          const card = roomRegion.getByRole('region', {
            name: 'Suggested Tasks, 3',
          });
          await expect(card).toBeVisible();
          await expect(card.getByText('Done')).toBeVisible();
          await expect(
            card.getByRole('button', {
              name: 'Start Document the redirect flag',
            }),
          ).toBeVisible();
          const startAll = card.getByRole('button', { name: 'Start all 2' });
          await expect(startAll).toBeVisible();
          await expect(
            roomRegion.getByText('0 working · 0 waiting · up to 2 at once'),
          ).toBeVisible();
          const sweep = roomRegion.getByRole('button', {
            name: 'Status sweep',
          });
          await expect(sweep).toBeVisible();
          await expect(
            roomRegion.getByText('Task finished:', { exact: false }),
          ).toBeVisible();
          if (viewport.width === MOBILE.width) {
            await expectTouchTarget(startAll, 'Start all');
            await expectTouchTarget(sweep, 'Status sweep');
          }
          // The card's own row sits in view for the shot.
          await card.scrollIntoViewIfNeeded();
          await page.mouse.move(0, 0);
        },
        async cleanup() {
          await fixture?.cleanup();
          await restoreHandshake?.();
          if (created) {
            const removed = await request.delete(
              `${resolveE2EApiBase()}/api/projects/${slug}`,
            );
            expect(removed.ok()).toBe(true);
          }
          if (previousPreview !== undefined) {
            const restored = await request.put(
              `${resolveE2EApiBase()}/api/feature-previews/project-room-coordinator`,
              { data: { enabled: previousPreview } },
            );
            expect(restored.ok()).toBe(true);
          }
        },
      };
    }),
  );
}

/**
 * Channel navigation (#4794, #4795): the Project's channel list (the phone's
 * Project page; at 1440 the sidebar with one Project expanded and one
 * collapsed), a channel opened by its address, and a thread. Unread state
 * comes from the read-marker fixture.
 *
 * The channel list is captured in a frame tall enough to show the Project's
 * overview and its Room preview above the collapsed dock.
 */
const CHANNEL_NAV_SCENES = [
  'list',
  'conversation',
  'thread',
  'rail',
  'attention',
] as const;
const PHONE_PAGE = { width: MOBILE.width, height: 1200 } as const;
const DESKTOP_CHANNEL_LIST_PAGE = {
  width: DESKTOP.width,
  height: 1500,
} as const;

function channelNavigationScreens(): Screen[] {
  return CHANNEL_NAV_SCENES.flatMap((scene) =>
    (['dark', 'light'] as const).flatMap((theme) =>
      (scene === 'rail'
        ? [DESKTOP]
        : [DESKTOP, scene === 'list' ? PHONE_PAGE : MOBILE]
      ).map((viewport): Screen => {
        const width = viewport.width === DESKTOP.width ? 'desktop' : 'mobile';
        const phone = viewport.width === MOBILE.width;
        const slug = `gallery-channels-${scene}-${theme}-${viewport.width}`;
        const other = `${slug}-site`;
        let request: ReturnType<typeof createAuthenticatedE2ERequest>;
        const created: string[] = [];
        const cleanups: (() => Promise<void>)[] = [];
        const query =
          scene === 'conversation'
            ? `?section=room&channel=${GALLERY_DESIGN_ROOM_ID}`
            : scene === 'thread'
              ? `?section=room&thread=${NAVIGATION_THREAD_ROOT}`
              : '';
        const screen: Screen = {
          name: `channel-nav-${scene}-${theme}-${width}`,
          title: `Channel navigation, ${scene} — ${theme}, ${viewport.width}px`,
          path: scene === 'attention' ? '/' : `/projects/${slug}${query}`,
          viewport:
            !phone && (scene === 'list' || scene === 'rail')
              ? DESKTOP_CHANNEL_LIST_PAGE
              : viewport,
          ...(scene === 'rail' || scene === 'attention'
            ? { captureTheme: theme }
            : {}),
          async beforeGoto(page) {
            request = createAuthenticatedE2ERequest(page.request);
            const createProject = async (name: string, projectSlug: string) => {
              const response = await request.post(
                `${resolveE2EApiBase()}/api/projects`,
                { data: { name, slug: projectSlug } },
              );
              expect(response.ok()).toBe(true);
              created.push(projectSlug);
              return (await response.json()).data as { id: string };
            };
            const project = await createProject('Onboarding revamp', slug);
            // A second Project stays collapsed in the sidebar.
            await createProject('Kontour site', other);
            if (scene !== 'attention') {
              const room = await installProjectRoomFixture(page, {
                slug,
                projectId: project.id,
                scene: 'navigation',
              });
              cleanups.push(room.cleanup);
              const conversations = await installProjectConversationsFixture(
                page,
                { slug, projectId: project.id },
              );
              cleanups.push(conversations.cleanup);
            }
            if (scene === 'rail' || scene === 'attention') {
              const pattern = '**/api/attention';
              const handler = (route: Route) =>
                route.request().method() !== 'GET'
                  ? rejectUnexpectedFixtureRequest(route)
                  : route.fulfill({
                      json: {
                        success: true,
                        data: {
                          pendingCount: 1,
                          items: [
                            {
                              id: 'approval:gallery-sidebar',
                              kind: 'approval',
                              title: 'Approve workspace check',
                              projectSlug: slug,
                              createdAt: '2026-10-20T12:00:00Z',
                              updatedAt: '2026-10-20T12:00:00Z',
                              source: {
                                notificationId: 'gallery-sidebar',
                                notificationSource: 'approval-inbox',
                              },
                              actions: [],
                            },
                          ],
                        },
                      },
                    });
              await page.route(pattern, handler);
              cleanups.push(() => page.unroute(pattern, handler));
            }
          },
          async afterGoto(page) {
            await page.evaluate(
              (selected) =>
                document.documentElement.setAttribute('data-theme', selected),
              theme,
            );
            const sidebar = page.getByRole('navigation', {
              name: phone ? 'Mobile navigation' : 'Primary navigation',
            });
            // Unread and working come from the read-marker and session
            // fixtures; the rows below are the server's answer.
            const expectProjectList = async (list: Locator) => {
              await expect(
                list.getByRole('button', { name: 'general, 3 unread' }),
              ).toHaveClass(/conversation-list__row--unread/);
              await expect(
                list.getByRole('button', { name: 'design', exact: true }),
              ).toBeVisible();
              await expect(
                list.getByRole('button', {
                  name: 'Fix the login redirect on Safari, Task room, agent working, 2 unread',
                }),
              ).toBeVisible();
              // A Task whose room never opened is not a Task room.
              await expect(
                list.getByRole('button', { name: /Rename the onboarding/ }),
              ).toHaveCount(0);
            };
            const room = page.getByRole('region', {
              name: 'Project room',
              exact: true,
            });
            if (scene === 'conversation' || scene === 'thread') {
              await expect(room).toBeVisible();
              if (scene === 'conversation') {
                await expect(
                  room.getByText('New checkout screens are up for review.'),
                ).toBeVisible();
                if (phone) {
                  await expect(
                    room.getByRole('heading', { level: 2, name: 'design' }),
                  ).toBeVisible();
                  await expectTouchTarget(
                    room.getByRole('button', {
                      name: 'Back to Onboarding revamp',
                    }),
                    'Back',
                  );
                  await expectTouchTarget(
                    room.getByRole('button', { name: 'Channel options' }),
                    'Channel options',
                  );
                } else {
                  // Opening #design marked it read: the sidebar's row is
                  // current and plain.
                  const row = sidebar.getByRole('button', {
                    name: 'design',
                    exact: true,
                  });
                  await expect(row).toHaveAttribute('aria-current', 'page');
                  await expect(row).not.toHaveClass(
                    /conversation-list__row--unread/,
                  );
                }
              } else {
                await expect(
                  room.getByText('Both fixes are in the branch now.'),
                ).toBeVisible();
                await expect(
                  room.getByRole('heading', { name: 'Thread' }),
                ).toBeVisible();
                await expect(
                  room.getByRole('textbox', { name: 'Reply in thread' }),
                ).toBeVisible();
              }
              await page.mouse.move(0, 0);
              return;
            }
            if (scene === 'rail' || scene === 'attention') {
              if (scene === 'rail') {
                const collapse = page.getByRole('button', {
                  name: 'Collapse workspace map',
                });
                const expand = page.getByRole('button', {
                  name: 'Expand workspace map',
                });
                if (await collapse.isVisible()) {
                  await collapse.click();
                  cleanups.push(() => expand.click());
                }
                await expect(expand).toBeVisible();
                const project = sidebar.getByRole('button', {
                  name: /^Onboarding revamp views/,
                });
                await expect(project).toHaveAccessibleName(
                  /Needs attention: 1/,
                );
                await project.click();
                const views = page.getByRole('dialog', {
                  name: 'Onboarding revamp views',
                });
                await expectProjectList(views);
                await expect(
                  views.locator('[data-conversation-row][tabindex="0"]'),
                ).toHaveCount(1);
              } else {
                if (phone)
                  await page
                    .getByRole('button', { name: 'Toggle menu' })
                    .click();
                const project = sidebar.getByRole('button', {
                  name: /^Onboarding revamp/,
                });
                await expect(project).toHaveAccessibleName(
                  /Needs attention: 1/,
                );
                await expect(
                  project.locator('[title="Needs attention: 1"]'),
                ).toBeVisible();
                await expect(
                  sidebar.getByRole('button', { name: /^Kontour site/ }),
                ).not.toHaveAccessibleName(/Needs attention/);
              }
              await page.mouse.move(0, 0);
              return;
            }
            if (phone) {
              const list = page.getByRole('main');
              await expectProjectList(list);
              await expectTouchTarget(
                list.getByRole('button', { name: 'design', exact: true }),
                'Channel row',
              );
            } else {
              await expectProjectList(sidebar);
              // The other Project stays collapsed: no rows of its own.
              await expect(
                sidebar.getByRole('button', {
                  name: 'Kontour site',
                  exact: true,
                }),
              ).toBeVisible();
              await expect(
                sidebar.getByRole('list', { name: 'Channels' }),
              ).toHaveCount(1);
            }
            await page.mouse.move(0, 0);
          },
          async cleanup() {
            for (const release of cleanups.splice(0)) await release();
            for (const projectSlug of created.splice(0)) {
              const removed = await request.delete(
                `${resolveE2EApiBase()}/api/projects/${projectSlug}`,
              );
              expect(removed.ok()).toBe(true);
            }
          },
        };
        return screen;
      }),
    ),
  );
}

/**
 * #5067 / #5071: the Project Library on Files & connections and a new
 * Project's Setup recommendations, both behind their Feature Previews. Each
 * screen turns its preview on for the shot and restores the operator's
 * previous choice afterwards. The Library's answer is a fixed fixture (an
 * upload, a kept file and an orphaned one) so the shot is deterministic; the
 * Setup card is the real card on a real new Project, with a chat
 * continuation pending in this tab.
 */
const PROJECT_LIBRARY_SCENES = ['library', 'setup'] as const;
const PROJECT_LIBRARY_DESKTOP_PAGE = {
  width: DESKTOP.width,
  height: 3000,
} as const;
const PROJECT_SETUP_DESKTOP_PAGE = {
  width: DESKTOP.width,
  height: 1350,
} as const;
const PROJECT_SETUP_PHONE_PAGE = { width: MOBILE.width, height: 1520 } as const;

async function createGalleryProjectFromChat(
  page: Page,
  conversationId: string,
  onCreated: (slug: string) => void,
) {
  const title = 'Quarterly research plan';
  const answer = 'Start by reviewing the customer interviews.';
  const viewport = page.viewportSize();
  // The Save to Project action is in the desktop dock menu.
  await page.setViewportSize(DESKTOP);
  const restoreSession = await withRoute(
    page,
    '**/api/orchestration/sessions/read-model',
    orchestrationSessionFixture({ threadId: conversationId }),
  );
  try {
    await seedActiveChatSession(page, {
      conversationId,
      agentSlug: 'demo-agent',
      title,
      urlScoped: true,
    });
    await mockRuntimeConversation(page, {
      id: conversationId,
      agentSlug: 'demo-agent',
      title,
      provider: 'claude',
      model: 'test-model',
      canContinue: true,
      turns: () =>
        buildLongSessionTurns({
          threadId: conversationId,
          provider: 'claude',
          turnCount: 1,
          replyText: () => answer,
        }),
    });
    await gotoAppShell(page, `/?dock=open&chat=${conversationId}`);
    const dock = page.locator('#chat-dock');
    await expect(dock.getByText(answer, { exact: true })).toBeVisible();
    await dock.getByRole('button', { name: /^More dock actions/ }).click();
    await page
      .getByRole('menuitem', { name: 'Save to Project…', exact: true })
      .click();
    const save = page.getByRole('dialog', { name: 'Save to Project' });
    await save.getByLabel('Project', { exact: true }).selectOption({
      label: 'New Project…',
    });
    await save.getByRole('button', { name: 'Review new Project' }).click();

    const form = page.getByRole('dialog', { name: 'New Project' });
    const name = form.getByRole('textbox', { name: 'Project name' });
    await expect(name).toHaveValue(title);
    await name.fill('Quarterly research');
    await expect(
      form.getByRole('radio', { name: /^Blank workspace/ }),
    ).toBeChecked();
    await form.getByText('More options', { exact: true }).click();
    await form.getByRole('textbox', { name: /^Description/ }).clear();

    const [created] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/projects',
      ),
      form.getByRole('button', { name: 'Create', exact: true }).click(),
    ]);
    expect(created.ok()).toBe(true);
    const { slug } = (await created.json()).data as { slug: string };
    onCreated(slug);
    await expect(page).toHaveURL(/\/projects\/quarterly-research(?:[?#]|$)/);
    await expect(form).toBeHidden();
  } finally {
    await restoreSession();
    if (viewport) await page.setViewportSize(viewport);
  }
}

function projectLibraryScreens(): Screen[] {
  return PROJECT_LIBRARY_SCENES.flatMap((scene) =>
    (['dark', 'light'] as const).flatMap((theme) =>
      [DESKTOP, MOBILE].map((device): Screen => {
        const width = device.width === DESKTOP.width ? 'desktop' : 'mobile';
        // Like the channel list's PHONE_PAGE: the collapsed dock overlays the
        // bottom band of the page's scrollport, so in a 900px or 844px frame
        // some control of these pages always sits behind it. Each frame is
        // tall enough for the whole page, whose end carries the shell's dock
        // clearance. The Library on a phone already ends clear of the dock.
        const viewport =
          scene === 'library'
            ? device === DESKTOP
              ? PROJECT_LIBRARY_DESKTOP_PAGE
              : device
            : device === DESKTOP
              ? PROJECT_SETUP_DESKTOP_PAGE
              : PROJECT_SETUP_PHONE_PAGE;
        const fixtureId = `gallery-${scene}-${theme}-${device.width}`;
        const slug = scene === 'library' ? fixtureId : 'quarterly-research';
        const previewId =
          scene === 'library' ? 'project-library' : 'continue-in-project';
        let request: ReturnType<typeof createAuthenticatedE2ERequest>;
        let previousEnabled: boolean | undefined;
        let createdProjectSlug: string | undefined;
        let restoreHandshake: (() => Promise<void>) | undefined;
        const screen: Screen = {
          name: `project-${scene}-${theme}-${width}`,
          title:
            scene === 'library'
              ? `Project Library — ${theme}, ${viewport.width}px`
              : `Setup recommendations — ${theme}, ${viewport.width}px`,
          path:
            scene === 'library'
              ? `/projects/${slug}?section=sources`
              : `/projects/${slug}`,
          viewport,
          async beforeGoto(page) {
            request = createAuthenticatedE2ERequest(page.request);
            const previews = await request.get(
              `${resolveE2EApiBase()}/api/feature-previews`,
            );
            expect(previews.ok()).toBe(true);
            const preview = (await previews.json()).data.find(
              (entry: { id: string }) => entry.id === previewId,
            );
            expect(preview).toBeDefined();
            previousEnabled = preview.enabled;
            const enabled = await request.put(
              `${resolveE2EApiBase()}/api/feature-previews/${previewId}`,
              { data: { enabled: true } },
            );
            expect(enabled.ok()).toBe(true);
            if (scene === 'library') {
              const project = await request.post(
                `${resolveE2EApiBase()}/api/projects`,
                { data: { name: 'Quarterly research', slug } },
              );
              expect(project.ok()).toBe(true);
              createdProjectSlug = slug;
              const projectId = (await project.json()).data.id as string;
              // The Library mounts only when the host advertises it; the
              // gallery's shared handshake advertises nothing by default.
              restoreHandshake = await withRoute(
                page,
                '**/.well-known/station/v1',
                (route) =>
                  fulfillGalleryStationHandshake(route, false, {
                    projectLibrary: true,
                  }),
              );
              await page.route(
                `**/api/projects/${slug}/library`,
                async (route) => {
                  if (route.request().method() !== 'GET')
                    return route.continue();
                  await route.fulfill({
                    json: {
                      success: true,
                      data: {
                        version: 'project-library/v1',
                        projectId,
                        partial: false,
                        truncated: false,
                        items: [
                          {
                            kind: 'upload',
                            relativePath: 'sources/interview-notes.md',
                            byteLength: 18_432,
                            mediaType: 'text/markdown',
                            modifiedAt: '2026-11-14T16:20:00.000Z',
                          },
                          {
                            kind: 'task-output',
                            outputId: 'gallery-output-report',
                            taskId: 'gallery-task-report',
                            title: 'Findings report',
                            fileName: 'findings-report.md',
                            sourcePath: 'out/findings-report.md',
                            mediaType: 'text/markdown',
                            byteLength: 9_216,
                            contentAvailable: true,
                            createdAt: '2026-11-13T11:05:00.000Z',
                            task: {
                              state: 'present',
                              title: 'Summarize the customer interviews',
                            },
                          },
                          {
                            kind: 'task-output',
                            outputId: 'gallery-output-draft',
                            taskId: 'gallery-task-deleted',
                            title: 'Early draft',
                            fileName: 'early-draft.txt',
                            sourcePath: 'early-draft.txt',
                            mediaType: 'text/plain',
                            byteLength: 2_048,
                            contentAvailable: true,
                            createdAt: '2026-11-02T09:40:00.000Z',
                            task: { state: 'orphaned' },
                          },
                        ],
                      },
                    },
                  });
                },
              );
            } else {
              await createGalleryProjectFromChat(page, fixtureId, (slug) => {
                createdProjectSlug = slug;
              });
            }
          },
          async afterGoto(page) {
            await page.evaluate(
              (selected) =>
                document.documentElement.setAttribute('data-theme', selected),
              theme,
            );
            if (scene === 'library') {
              const list = page.getByRole('list', { name: 'Library files' });
              await expect(list).toBeVisible();
              await expect(list.getByText('Orphaned')).toBeVisible();
              await expect(
                list.getByRole('button', {
                  name: 'From Summarize the customer interviews',
                }),
              ).toBeVisible();
              await list.scrollIntoViewIfNeeded();
            } else {
              const card = page.getByRole('region', {
                name: 'Setup recommendations',
              });
              await expect(card).toBeVisible();
              await expect(
                card.getByRole('checkbox', {
                  name: /New Task: Continue: Quarterly research plan/,
                }),
              ).toBeChecked();
              await expect(
                card.getByRole('button', { name: 'Apply', exact: true }),
              ).toBeVisible();
              await card.scrollIntoViewIfNeeded();
            }
            await page.mouse.move(0, 0);
          },
          async cleanup() {
            await restoreHandshake?.();
            restoreHandshake = undefined;
            if (createdProjectSlug) {
              const removed = await request.delete(
                `${resolveE2EApiBase()}/api/projects/${createdProjectSlug}`,
              );
              expect(removed.ok()).toBe(true);
              createdProjectSlug = undefined;
            }
            if (previousEnabled !== undefined) {
              const restored = await request.put(
                `${resolveE2EApiBase()}/api/feature-previews/${previewId}`,
                { data: { enabled: previousEnabled } },
              );
              expect(restored.ok()).toBe(true);
              previousEnabled = undefined;
            }
          },
        };
        return screen;
      }),
    ),
  );
}

/** Real dock composition with an engine-owned child transcript, under a controlled provider. */
function childChatScreens(): Screen[] {
  const parent = 'gallery-child-parent';
  const child = 'review-files';
  const item = {
    producer: 'engine-subagent',
    reporterThreadId: parent,
    childId: child,
    status: 'completed',
    title: 'Review files',
    transcript: { kind: 'claude-subagent', sessionId: parent, agentId: child },
  };
  const summary = {
    threadId: parent,
    conversationId: parent,
    provider: 'claude',
    status: 'idle',
    lifecycleState: 'idle',
    controlMode: 'station-owned',
    isLoaded: true,
    isPersisted: true,
    answerability: { answerable: true },
    title:
      'Plan the change across the workspace and review every navigation boundary',
    displayTitle:
      'Plan the change across the workspace and review every navigation boundary',
    createdAt: '2026-07-19T10:00:00Z',
    updatedAt: '2026-07-19T10:05:00Z',
    childWork: {
      children: {
        observability: 'reported',
        running: [],
        settled: [item],
        observedAt: '2026-07-19T10:05:00Z',
      },
    },
  };
  return [
    { width: 1440, height: 900 },
    { width: 412, height: 915 },
    { width: 390, height: 844 },
  ].flatMap((viewport) =>
    (['dark', 'light'] as const).map((theme) => {
      let cleanups: (() => Promise<void>)[] = [];
      return {
        name: `child-chat-${theme}-${viewport.width}`,
        title: `Child chat in the dock — ${theme}, ${viewport.width}px`,
        path: `/?dock=open&chat=${parent}&surface=chat&session=${parent}&child=${child}&childTitle=Review+files&galleryTheme=${theme}`,
        viewport,
        beforeGoto: async (page: Page) => {
          await clearDockGalleryStorage(page);
          await page.addInitScript(
            ({ theme, parent }) => {
              const params = new URLSearchParams(location.search);
              if (
                params.get('chat') !== parent ||
                params.get('galleryTheme') !== theme
              )
                return;
              const key = 'station-device-settings-v1';
              const envelope = JSON.parse(
                localStorage.getItem(key) ?? '{"version":2,"values":{}}',
              );
              envelope.values = { ...envelope.values, theme };
              localStorage.setItem(key, JSON.stringify(envelope));
            },
            { theme, parent },
          );
          await seedActiveChatSession(page, {
            conversationId: parent,
            agentSlug: 'demo-agent',
            title:
              'Plan the change across the workspace and review every navigation boundary',
          });
          // The real host has no execution for this controlled provider record.
          await page.addInitScript((id) => {
            if (new URLSearchParams(location.search).get('chat') !== id) return;
            const original = window.fetch.bind(window);
            window.fetch = async (input, init) => {
              const url = input instanceof Request ? input.url : String(input);
              if (
                new URL(url, location.href).pathname !==
                '/api/orchestration/events'
              )
                return original(input, init);
              return new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    init?.signal?.addEventListener(
                      'abort',
                      () => controller.close(),
                      { once: true },
                    );
                  },
                }),
                { headers: { 'Content-Type': 'text/event-stream' } },
              );
            };
          }, parent);
          await mockRuntimeConversation(page, {
            id: parent,
            agentSlug: 'demo-agent',
            title:
              'Plan the change across the workspace and review every navigation boundary',
            provider: 'claude',
            model: 'test-model',
            canContinue: true,
            turns: () =>
              buildLongSessionTurns({
                threadId: parent,
                provider: 'claude',
                turnCount: 1,
                replyText: () => 'The review is ready.',
              }),
          });
          const json = (data: unknown) => (route: Route) =>
            route.fulfill({ json: { success: true, data } });
          cleanups = [
            await withRoute(page, '**/api/me/preferences', (route) => {
              if (route.request().method() !== 'GET')
                return rejectUnexpectedFixtureRequest(route);
              return route.fulfill({
                json: {
                  success: true,
                  data: { schemaVersion: 1, values: { theme } },
                },
              });
            }),
            await withRoute(
              page,
              '**/api/orchestration/sessions/read-model',
              json([summary]),
            ),
            await withRoute(
              page,
              `**/api/orchestration/sessions/${parent}`,
              json({ session: summary, events: [] }),
            ),
            await withRoute(
              page,
              `**/api/orchestration/sessions/${parent}/child-work/${child}/transcript**`,
              json({
                entries: [
                  {
                    message: 0,
                    kind: 'text',
                    role: 'user',
                    text: 'Read the implementation and check the proposed change at phone width.',
                  },
                  {
                    message: 1,
                    kind: 'tool-call',
                    toolCallId: 'read-1',
                    name: 'Read',
                    input: JSON.stringify({ file_path: 'src/navigation.ts' }),
                  },
                  {
                    message: 2,
                    kind: 'tool-result',
                    toolCallId: 'read-1',
                    text: 'The implementation preserves the parent conversation.',
                  },
                  {
                    message: 3,
                    kind: 'text',
                    role: 'assistant',
                    text: 'The navigation keeps the parent draft and header controls available.',
                  },
                ],
              }),
            ),
          ];
        },
        afterGoto: async (page: Page) => {
          await expect(page.locator('html')).toHaveAttribute(
            'data-theme',
            theme,
          );
          const dock = page.locator('#chat-dock');
          await expect(
            dock.getByRole('navigation', { name: 'Chat breadcrumb' }),
          ).toBeVisible({ timeout: 20000 });
          await expect(
            dock.getByText(
              'The navigation keeps the parent draft and header controls available.',
            ),
          ).toBeVisible();
          // A trusted browser Back uses the same history layer as Android system Back.
          const reopen = new URL(page.url());
          reopen.searchParams.set('surface', 'chat');
          reopen.searchParams.set('session', parent);
          reopen.searchParams.set('child', child);
          reopen.searchParams.set('childTitle', 'Review files');
          const beforeBack = page.url();
          await page.goBack();
          await expect(page, 'child Back retains the parent URL').toHaveURL(
            beforeBack,
          );
          await expect(
            dock.getByRole('navigation', { name: 'Chat breadcrumb' }),
          ).toBeHidden();
          await expect(
            dock.getByText('The review is ready.', { exact: true }),
          ).toBeVisible();
          // A full navigation: the same splash wait and breadcrumb budget as
          // this screen's first load, not the 5 s default.
          await gotoAppShell(page, reopen.toString());
          await expect(
            dock.getByRole('navigation', { name: 'Chat breadcrumb' }),
          ).toBeVisible({ timeout: 20000 });
          // Real pointer actions prove the way back survives header
          // clipping: ‹ on a phone, the long ancestor crumb on a wider bar.
          for (const name of viewport.width < 600
            ? ['Back to parent chat']
            : [
                'Plan the change across the workspace and review every navigation boundary',
              ]) {
            const control = dock
              .getByRole('navigation', { name: 'Chat breadcrumb' })
              .getByRole('button', { name, exact: true });
            await expect(control).toBeVisible();
            const box = (await control.boundingBox())!;
            expect(box.width).toBeGreaterThanOrEqual(44);
            expect(box.height).toBeGreaterThanOrEqual(44);
            expect(
              await control.evaluate((button) => {
                const box = button.getBoundingClientRect();
                return button.contains(
                  document.elementFromPoint(
                    box.x + box.width / 2,
                    box.y + box.height / 2,
                  ),
                );
              }),
              `${name} is hit-testable at its center`,
            ).toBe(true);
            await control.click();
            await expect(
              dock.getByRole('navigation', { name: 'Chat breadcrumb' }),
            ).toBeHidden();
            await expect(
              dock.getByText('The review is ready.', { exact: true }),
            ).toBeVisible();
            await page.goto(reopen.toString());
            await expect(
              dock.getByRole('navigation', { name: 'Chat breadcrumb' }),
            ).toBeVisible();
          }
          if (viewport.width < 600)
            await dock
              .getByRole('button', { name: 'Full screen chat', exact: true })
              .click();
          else
            await dock
              .getByRole('button', {
                name: 'Expand dock region to workspace',
                exact: true,
              })
              .click();

          await expect(dock.getByText('No result recorded')).toHaveCount(0);
          const call = dock.locator('.tool-call').first();
          await expect(call).toBeVisible();
          const toggle = call.getByRole('button').first();
          if ((await toggle.getAttribute('aria-expanded')) === 'false')
            await toggle.click();
          await expect(
            dock.getByText(
              'The implementation preserves the parent conversation.',
            ),
          ).toBeVisible();
          await expect(
            dock.getByRole('navigation', { name: 'Chat breadcrumb' }),
          ).toContainText(
            'Plan the change across the workspace and review every navigation boundary',
          );
          await expect(page.locator('html')).toHaveAttribute(
            'data-theme',
            theme,
          );
          if (viewport.width < 600) {
            const header = dock.getByTestId('chat-dock-mobile-header');
            const back = header.getByRole('button', {
              name: 'Back to parent chat',
            });
            const extent = header.getByRole('button', {
              name: 'Restore chat size',
            });
            const actions = header.getByRole('button', {
              name: 'Chat actions',
              exact: true,
            });
            for (const control of [back, extent, actions]) {
              await control.click({ trial: true });
              const box = (await control.boundingBox())!;
              expect(box.width).toBeGreaterThanOrEqual(44);
              expect(box.height).toBeGreaterThanOrEqual(44);
            }
            const titleBox = (await header
              .locator('[aria-current="page"]')
              .boundingBox())!;
            const backBox = (await back.boundingBox())!;
            const extentBox = (await extent.boundingBox())!;
            const actionsBox = (await actions.boundingBox())!;
            expect(backBox.x + backBox.width).toBeLessThanOrEqual(
              titleBox.x + 0.5,
            );
            expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(
              extentBox.x + 0.5,
            );
            expect(extentBox.x + extentBox.width).toBeLessThanOrEqual(
              actionsBox.x + 0.5,
            );

            await actions.click();
            const sheet = page.getByRole('dialog', { name: 'Chat actions' });
            const newChat = sheet.getByRole('menuitem', {
              name: 'New chat',
              exact: true,
            });
            await newChat.click({ trial: true });
            const newChatBox = (await newChat.boundingBox())!;
            expect(newChatBox.width).toBeGreaterThanOrEqual(44);
            expect(newChatBox.height).toBeGreaterThanOrEqual(44);
            await sheet
              .getByRole('button', { name: 'Close actions menu' })
              .click();
            await expect(sheet).toBeHidden();
            await expect(actions).toBeFocused();
          }
          const overflow = await dock.evaluate(
            (element) => element.scrollWidth > element.clientWidth + 1,
          );
          expect(overflow, 'the actual dock fits the viewport').toBe(false);
        },
        cleanup: async () => {
          for (const cleanup of cleanups.reverse()) await cleanup();
        },
      } satisfies Screen;
    }),
  );
}

/**
 * #4799: the reader's own mentions on the attention page, from their private
 * feed in the exact record shape `GET /api/me/notifications` serves.
 */
function personMentionScreens(): Screen[] {
  const mention = (
    id: string,
    title: string,
    body: string,
    createdAt: string,
    read: boolean,
  ) => ({
    id,
    source: 'project-room',
    category: 'room-mention',
    title,
    body,
    priority: 'normal',
    status: 'delivered',
    scheduledAt: null,
    deliveredAt: createdAt,
    metadata: {
      envelope: {
        v: 1,
        source: { kind: 'system', subsystem: 'project-room' },
        audience: {
          kind: 'principal',
          principalId: 'human:local:operator',
          projectId: 'gallery-project',
        },
        urgency: 'attention',
        target: {
          kind: 'path',
          path: `/projects/gallery-onboarding?section=room&message=${id}`,
        },
        interrupt: 'default',
        ...(read ? { readAt: createdAt, readBy: 'web:gallery' } : {}),
      },
    },
    createdAt,
    updatedAt: createdAt,
  });
  const feed = [
    mention(
      'c1000000-0000-4000-8000-000000000001',
      'Priya Natarajan mentioned you in #general',
      '@Maya Chen can you sign off on the copy today? @Jonas Berg has the numbers.',
      new Date(Date.now() - 5 * 60_000).toISOString(),
      false,
    ),
    mention(
      'c1000000-0000-4000-8000-000000000002',
      'Jonas Berg mentioned you in #design',
      'Updated both screens, @Maya Chen. Ready when you are.',
      new Date(Date.now() - 95 * 60_000).toISOString(),
      true,
    ),
  ];
  return (['dark', 'light'] as const).flatMap((theme) =>
    [DESKTOP, MOBILE].map((viewport): Screen => {
      const width = viewport.width === DESKTOP.width ? 'desktop' : 'mobile';
      let restore: (() => Promise<void>) | undefined;
      return {
        name: `notifications-for-you-${theme}-${width}`,
        title: `For you mentions — ${theme}, ${viewport.width}px`,
        path: '/notifications',
        viewport,
        captureTheme: theme,
        async beforeGoto(page) {
          restore = await withRoute(page, '**/api/me/notifications', (route) =>
            route.request().method() === 'GET'
              ? route.fulfill({ json: { success: true, data: feed } })
              : rejectUnexpectedFixtureRequest(route),
          );
        },
        async afterGoto(page) {
          const section = page.getByRole('region', { name: 'For you' });
          await expect(section).toBeVisible();
          await expect(
            section.getByRole('button', {
              // The visually hidden ", unread" is its own box, so the
              // accessible name may carry a space before its comma.
              name: /Priya Natarajan mentioned you in #general\s*, unread/,
            }),
          ).toBeVisible();
          if (viewport.width === MOBILE.width)
            await expectTouchTarget(
              section.getByRole('button').first(),
              'Mention row',
            );
        },
        async cleanup() {
          await restore?.();
        },
      };
    }),
  );
}

/**
 * #5062/#5065/#5068: Project settings › Brief, Memory, Models and effort,
 * and Usage, with the `project-coordination` preview on. The Project and its
 * notes are real records on the e2e Station; usage is a fixed rollup, since
 * no engine reports usage here.
 */
/**
 * Project settings are shot as whole pages. Measured in the real page at
 * 1440×900 and 390×844: the section rail and the form are inside the page's
 * scrolling content view, and that scrollport ends at the collapsed dock, so
 * scrolling brings the last rail tabs (Schedules, Danger zone), the Brief
 * Instructions field and the Task model field fully clear of it. In a fixed
 * frame some of them always sit at the dock edge, so the frame, not the page,
 * is what the shot has to change.
 */
const PROJECT_SETTINGS_DESKTOP_PAGE = { width: 1440, height: 2500 } as const;
const PROJECT_SETTINGS_PHONE_PAGE = { width: 390, height: 1200 } as const;

function projectCoordinationScreens(): Screen[] {
  const sections = ['brief', 'memory', 'models', 'usage'] as const;
  return sections.flatMap((section) =>
    (['dark', 'light'] as const).flatMap((theme) =>
      [
        PROJECT_SETTINGS_DESKTOP_PAGE,
        section === 'brief' || section === 'models'
          ? PROJECT_SETTINGS_PHONE_PAGE
          : MOBILE,
      ].map((viewport): Screen => {
        const size = viewport.width === DESKTOP.width ? 'desktop' : 'mobile';
        const slug = `gallery-brief-${section}-${theme}-${size}`;
        let request: ReturnType<typeof createAuthenticatedE2ERequest>;
        const cleanups: (() => Promise<void>)[] = [];
        let created = false;
        let previousPreview = false;
        return {
          name: `project-${section}-${theme}-${size}`,
          title: `Project settings ${section} — ${theme}, ${viewport.width}px`,
          path: `/projects/${slug}/edit?section=${section}`,
          viewport,
          async beforeGoto(page) {
            request = createAuthenticatedE2ERequest(page.request);
            const previews = await request.get(
              `${resolveE2EApiBase()}/api/feature-previews`,
            );
            expect(previews.ok()).toBe(true);
            const preview = (await previews.json()).data.find(
              (item: { id: string }) => item.id === 'project-coordination',
            );
            expect(preview).toBeDefined();
            previousPreview = preview.enabled;
            const enabled = await request.put(
              `${resolveE2EApiBase()}/api/feature-previews/project-coordination`,
              { data: { enabled: true } },
            );
            expect(enabled.ok()).toBe(true);
            cleanups.push(async () => {
              const restored = await request.put(
                `${resolveE2EApiBase()}/api/feature-previews/project-coordination`,
                { data: { enabled: previousPreview } },
              );
              expect(restored.ok()).toBe(true);
            });
            const response = await request.post(
              `${resolveE2EApiBase()}/api/projects`,
              {
                data: {
                  name: 'Export redesign',
                  slug,
                  goal: 'Ship the new export flow by Friday',
                  instructions: [
                    'This Project rebuilds CSV and PDF export.',
                    'Work in example/export on main; name pull requests "export: …".',
                    'Run npm test and the export smoke test before saying done.',
                    'If a fixture or credential is missing, say what is missing and stop.',
                    'Ask before changing billing or deleting data.',
                  ].join('\n\n'),
                  taskProviderId: 'claude',
                  taskModel: 'claude-sonnet-5-5',
                  taskEffort: 'medium',
                },
              },
            );
            expect(response.ok()).toBe(true);
            created = true;
            if (section === 'memory') {
              for (const note of [
                {
                  title: 'The release moved to Friday',
                  body: 'Product asked on Tuesday; QA needs Thursday.',
                },
                {
                  title: 'PDF export was dropped from v1',
                  body: 'Rendering cost; revisit after the CSV launch.',
                },
                {
                  title: 'Check with Dana before touching billing',
                  body: 'Billing exports feed the finance close.',
                },
              ]) {
                const saved = await request.post(
                  `${resolveE2EApiBase()}/api/projects/${slug}/memory`,
                  { data: note },
                );
                expect(saved.ok()).toBe(true);
              }
            }
            if (section === 'usage') {
              const row = (
                key: string,
                fields: Record<string, unknown>,
                tokens: [number, number],
              ) => ({
                key,
                stationId: 'local',
                provider: 'claude',
                inputTokens: tokens[0],
                outputTokens: tokens[1],
                pricingStatus: 'unpriced',
                receiptCount: 3,
                ...fields,
              });
              cleanups.push(
                await withRoute(
                  page,
                  '**/api/analytics/usage-rollup?*',
                  (route) => {
                    const url = new URL(route.request().url());
                    if (
                      route.request().method() !== 'GET' ||
                      url.searchParams.get('projectSlug') !== slug
                    )
                      return rejectUnexpectedFixtureRequest(route);
                    const byTask = url.searchParams.get('groupBy') === 'task';
                    return route.fulfill({
                      json: {
                        success: true,
                        data: {
                          window: { from: '2026-10-19', to: '2026-11-17' },
                          coverage: [
                            {
                              stationId: 'local',
                              state: 'complete',
                              window: { from: '2026-10-19', to: '2026-11-17' },
                            },
                          ],
                          receipts: [],
                          rows: byTask
                            ? [
                                row('task:unattributed', {}, [182_000, 9_400]),
                                row(
                                  'task:3f2c9a1e',
                                  { taskId: '3f2c9a1e-csv' },
                                  [412_500, 31_200],
                                ),
                                row(
                                  'task:8b17d044',
                                  { taskId: '8b17d044-pdf' },
                                  [96_300, 7_800],
                                ),
                              ]
                            : [
                                row(
                                  'model:claude-opus-5-5',
                                  { model: 'claude-opus-5-5' },
                                  [182_000, 9_400],
                                ),
                                row(
                                  'model:claude-sonnet-5-5',
                                  { model: 'claude-sonnet-5-5' },
                                  [508_800, 39_000],
                                ),
                              ],
                        },
                      },
                    });
                  },
                ),
              );
            }
          },
          async afterGoto(page) {
            await page.evaluate(
              (selected) =>
                document.documentElement.setAttribute('data-theme', selected),
              theme,
            );
            const body = page.locator('.project-settings__body');
            if (section === 'brief') {
              await expect(
                body.getByRole('textbox', { name: 'Goal', exact: true }),
              ).toHaveValue('Ship the new export flow by Friday');
            } else if (section === 'memory') {
              await expect(
                body.getByText('The release moved to Friday', { exact: true }),
              ).toBeVisible();
            } else if (section === 'models') {
              await expect(
                body.getByRole('combobox', {
                  name: 'Project chat effort',
                  exact: true,
                }),
              ).toHaveValue('medium');
            } else {
              await expect(
                body.getByRole('table', { name: 'By Task' }),
              ).toBeVisible();
            }
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
          },
          async cleanup() {
            for (const cleanup of cleanups.splice(0)) await cleanup();
            if (created) {
              const removed = await request.delete(
                `${resolveE2EApiBase()}/api/projects/${slug}`,
              );
              expect(removed.ok()).toBe(true);
              created = false;
            }
          },
        };
      }),
    ),
  );
}

const SCREENS: Screen[] = [
  ...projectCoordinationScreens(),
  ...roomConversationScreens(),
  ...roomCoordinatorScreens(),
  ...personMentionScreens(),
  ...channelNavigationScreens(),
  ...projectLibraryScreens(),
  ...memberProjectChannelScreens(),
  ...appsLibraryScreens(),
  ...appsLibraryScreens(true),
  ...projectRepositorySourceScreens(),
  ...projectOverviewScreens(),
  ...telemetryConsentScreens(),
  ...[DESKTOP, MOBILE].map((viewport): Screen => {
    const slug = 'gallery-project-retry-board';
    const layout = {
      id: slug,
      slug,
      type: 'custom',
      name: 'Morning Board',
      config: {},
      createdAt: '2026-11-04T00:00:00.000Z',
      updatedAt: '2026-11-04T00:00:00.000Z',
    };
    const document = {
      layout,
      revision: 'a'.repeat(64),
      definition: null,
      proposal: null,
    } satisfies import('@kontourai/station-contracts/personal-board').PersonalBoardDocument;
    let cleanups: (() => Promise<void>)[] = [];
    return {
      name: `personal-board-projects-unavailable-${viewport.width === 390 ? 'mobile' : 'desktop'}`,
      title: 'Personal Board — Project list failure and retry',
      path: `/boards/${slug}`,
      viewport,
      waitFor: '.personal-board-workspace [role="alert"]',
      beforeGoto: async (page) => {
        cleanups = [
          await withRoute(page, `**/api/me/layouts/${slug}`, (route) => {
            if (route.request().method() !== 'GET')
              return rejectUnexpectedFixtureRequest(route);
            return route.fulfill({ json: { success: true, data: layout } });
          }),
          await withRoute(page, `**/api/me/boards/${slug}`, (route) => {
            if (route.request().method() !== 'GET')
              return rejectUnexpectedFixtureRequest(route);
            return route.fulfill({ json: { success: true, data: document } });
          }),
          await withRoute(page, '**/api/projects', (route) => {
            if (route.request().method() !== 'GET')
              return rejectUnexpectedFixtureRequest(route);
            return route.fulfill({
              status: 503,
              json: {
                success: false,
                error: 'Project list temporarily unavailable',
              },
            });
          }),
        ];
      },
      afterGoto: async (page) => {
        const board = page.locator('.personal-board-workspace');
        await expect(board.getByRole('alert')).toContainText(
          'Could not load Projects',
        );
        await expect(
          board.getByRole('button', { name: 'Retry Projects' }),
        ).toBeVisible();
        await expect(
          board.getByRole('button', { name: /Project watch/ }),
        ).toBeDisabled();
      },
      cleanup: async () => {
        for (const cleanup of cleanups) await cleanup();
        cleanups = [];
      },
    };
  }),
  ...[320, 390].flatMap((width): Screen[] => [
    {
      name: `mobile-http-consent-${width}`,
      title: `Mobile — explicit HTTP development exception (${width}px)`,
      path: '/settings?view=overview',
      viewport: { width, height: 844 },
      waitFor: '[data-testid="app-toolbar-connection"]',
      afterGoto: async (page) => {
        const receiverOrigin = 'http://100.64.0.20:3492';
        const receiverIdentity = '00000000-0000-4000-8000-000000003481';
        const receiverHandshake: PublicStationHandshake = {
          schemaVersion: 1,
          environmentId: receiverIdentity,
          authentication: { scheme: 'bearer', protocolVersion: 1 },
          transports: { http: 1, sse: 1, websocket: 1 },
          compatibility: {
            serverVersion: '0.0.0-screenshot-gallery',
            protocolVersion: 1,
            minClientProtocol: 1,
            capabilities: {
              remoteAuth: 1,
              devicePairing: 1,
              environmentProof: 1,
            },
          },
        };
        const cleanup = await withRoute(
          page,
          `${receiverOrigin}/.well-known/station/v1`,
          (route) => {
            if (route.request().method() !== 'GET')
              return rejectUnexpectedFixtureRequest(route);
            return route.fulfill({ json: receiverHandshake });
          },
        );
        try {
          await page.getByTestId('app-toolbar-connection').click();
          await page
            .getByRole('menuitem', { name: 'Manage Stations', exact: true })
            .click();
          const dialog = page.getByRole('dialog');
          await dialog
            .getByRole('button', { name: 'Connect a Station', exact: true })
            .click();
          await dialog
            .getByRole('textbox', { name: 'Station address', exact: true })
            .fill(receiverOrigin);
          await dialog
            .getByRole('button', { name: 'Continue', exact: true })
            .click();
          await expect(
            dialog.getByText(receiverIdentity, { exact: true }),
          ).toBeVisible();
          await expect(
            dialog.getByRole('checkbox', {
              name: `Use ${receiverOrigin} from this device`,
              exact: true,
            }),
          ).toBeChecked();
          await expect(
            dialog.getByRole('checkbox', {
              name: `Let ${GALLERY_CONNECTION_NAME} send work to ${receiverOrigin}`,
              exact: true,
            }),
          ).not.toBeChecked();
          await dialog
            .getByRole('button', {
              name: 'Request selected access',
              exact: true,
            })
            .click();
          const consent = dialog.getByRole('checkbox', {
            name: 'Allow an unencrypted connection',
          });
          const requestAccess = dialog.getByRole('button', {
            name: 'Request access',
            exact: true,
          });
          await requestAccess.scrollIntoViewIfNeeded();
          await expect(consent).not.toBeChecked();
          await expect(consent).toBeInViewport({ ratio: 1 });
          await expect(requestAccess).toBeDisabled();
          await expect(requestAccess).toBeInViewport({ ratio: 1 });
        } finally {
          await cleanup();
        }
      },
    },
    {
      name: `mobile-access-request-error-${width}`,
      title: `Mobile — failed access request and retry (${width}px)`,
      path: '/settings?view=overview',
      viewport: { width, height: 844 },
      waitFor: '[data-testid="app-toolbar-connection"]',
      afterGoto: async (page) => {
        const cleanup = await withRoute(
          page,
          '**/.well-known/station/v1/pairing/access-request',
          (route) =>
            route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'temporarily_unavailable' }),
            }),
        );
        try {
          await page.getByTestId('app-toolbar-connection').click();
          await page
            .getByRole('menuitem', { name: 'Manage Stations', exact: true })
            .click();
          const dialog = page.getByRole('dialog');
          await dialog
            .getByRole('button', {
              name: `More actions for ${GALLERY_CONNECTION_NAME}`,
            })
            .click();
          await dialog
            .getByRole('menuitem', { name: 'Reconnect', exact: true })
            .click();
          await dialog
            .getByRole('button', { name: 'Request access', exact: true })
            .click();
          await expect(dialog.getByRole('alert')).toHaveCount(1);
          await expect(dialog.getByRole('alert')).toContainText(
            'Connection request failed',
          );
          await expect(
            dialog.getByRole('button', { name: 'Retry', exact: true }),
          ).toBeVisible();
          expect(
            await contrastRatio(
              dialog.getByRole('button', { name: 'Retry', exact: true }),
            ),
          ).toBeGreaterThanOrEqual(4.5);
        } finally {
          await cleanup();
        }
      },
    },
  ]),
  {
    name: 'home',
    title: 'Home / Coding layout',
    path: '/',
    viewport: DESKTOP,
    afterGoto: async (page) => {
      await assertNoStrayProjectModal(page);
      await expect(
        page.getByRole('heading', { name: 'Start your first conversation' }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: "What's next?" }),
      ).toHaveCount(0);
      // A fresh gallery home has no other Station to run on, so "Runs on"
      // names this one as plain text: no control to open.
      await expect(
        page.getByText('Runs on Gallery host', { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: /^Runs on / })).toHaveCount(
        0,
      );
    },
  },
  { name: 'agents', title: 'Agents', path: '/agents', viewport: DESKTOP },
  {
    name: 'skills',
    title: 'Skills',
    path: '/guidance?tab=skills',
    viewport: DESKTOP,
  },
  // The plugin catalogue moved to Apps › Discover; the name is kept.
  {
    name: 'registry',
    title: 'Apps › Discover',
    path: '/apps/discover',
    viewport: DESKTOP,
  },
  {
    name: 'connections',
    title: 'Customize',
    path: '/customize',
    viewport: DESKTOP,
    ...connectionsHubBadgeSettleHooks(),
  },
  {
    name: 'connections-models',
    title: 'Customize — Providers',
    path: '/customize/providers',
    viewport: DESKTOP,
    ...connectionsHubBadgeSettleHooks(),
  },
  {
    name: 'connections-agent-apps',
    title: 'Customize — Engines',
    path: '/customize/engines',
    viewport: DESKTOP,
    ...connectionsHubBadgeSettleHooks(),
  },
  {
    name: 'connections-tools',
    title: 'Customize — Tools',
    path: '/customize/tools',
    viewport: DESKTOP,
    ...connectionsHubBadgeSettleHooks(),
  },
  {
    name: 'connections-knowledge',
    title: 'Customize — Knowledge',
    path: '/customize/knowledge',
    viewport: DESKTOP,
    ...connectionsHubBadgeSettleHooks(),
  },

  // #2065 retired the `review` capture with the global `/review-queue` page it
  // photographed. Not retargeted to `/projects/<slug>/layouts/review`: that
  // surface is Project-scoped and reads three seeded stores (proposed changes,
  // Flow reviews, review evidence) this spec does not stub, so pointing the
  // same entry at it would photograph an empty state under a name that claims
  // otherwise. A real capture is new work with its own fixtures.
  // Installed plugins moved to Apps › Library; the name is kept.
  {
    name: 'plugins',
    title: 'Apps › Library',
    path: '/apps/library',
    viewport: DESKTOP,
  },
  (() => {
    let cleanup: () => Promise<void> = async () => {};
    return {
      name: 'schedule',
      title: 'Schedule',
      path: '/automations',
      viewport: DESKTOP,
      // archive#4464: without this, ScheduleView hits the live (unmocked)
      // scheduler/system endpoints on a freshly booted temp-home server —
      // real content whose exact bytes vary run to run.
      beforeGoto: async (page) => {
        cleanup = await seedScheduleScreenshotApi(page);
      },
      afterGoto: () => cleanup(),
    } satisfies Screen;
  })(),
  {
    name: 'developer-telemetry',
    title: 'Developer telemetry',
    path: '/developer/telemetry',
    viewport: DESKTOP,
    afterGoto: async (page) => {
      const toggles = page.locator(
        '.event-filter.active, .live-mode-toggle.active',
      );
      await expect(toggles).toHaveCount(6);
      for (const toggle of await toggles.all()) {
        expect(await contrastRatio(toggle)).toBeGreaterThanOrEqual(4.5);
      }
    },
  },
  {
    name: 'profile',
    title: 'Profile',
    path: '/profile',
    viewport: DESKTOP,
    afterGoto: async (page) => {
      await expect(
        page.getByRole('region', { name: 'My access', exact: true }),
      ).toContainText('Operator on Gallery host');
    },
  },
  {
    name: 'settings',
    title: 'Settings',
    path: '/settings',
    viewport: DESKTOP,
  },
  {
    // #4692: Display (density and motion), Mode, Theme and Accent.
    name: 'appearance',
    title: 'Appearance',
    path: '/appearance',
    viewport: DESKTOP,
    afterGoto: async (page) => {
      await expect(
        page.getByRole('radiogroup', { name: 'Density' }),
      ).toBeVisible();
    },
  },
  {
    name: 'settings-info-tip',
    title: 'Settings — Approval guardian explanation',
    path: '/settings?view=permissions',
    viewport: DESKTOP,
    afterGoto: async (page) => {
      await page
        .getByRole('button', { name: 'More about Approval guardian' })
        .click();
      const tooltip = page.getByRole('tooltip');
      await expect(tooltip).toBeVisible();
      await expect
        .poll(
          () =>
            page.locator('.app__main').evaluate((element) => element.scrollTop),
          {
            message:
              'Section navigation must keep the application frame in view',
          },
        )
        .toBe(0);
      await expect
        .poll(() =>
          page
            .locator('.app-toolbar')
            .evaluate((element) => element.getBoundingClientRect().top),
        )
        .toBeGreaterThanOrEqual(0);
      await tooltip.evaluate(async (element) => {
        await Promise.all(
          element.getAnimations().map((animation) => animation.finished),
        );
      });
    },
  },
  {
    name: 'agent-editor',
    title: 'Agent editor',
    path: '/agents/new',
    viewport: DESKTOP,
  },
  {
    // archive#4521: the readiness notice + its remedy, on an EXISTING
    // (not `isCreating`) agent — the state `agent-editor` above cannot
    // reach at all (its `titleAccessory`, and the notRunnable banner, both
    // gate on `!isCreating`). Proves: a short "Not set up" chip beside the
    // title (not the all-caps sentence "wall of yellow text"), and the
    // banner's "Add model connection" repair.
    name: 'agent-editor-not-runnable',
    title: 'Agent editor — not runnable',
    path: `/agents/${GALLERY_NOT_RUNNABLE_AGENT_SLUG}`,
    viewport: DESKTOP,
    beforeGoto: seedNotRunnableAgentApi,
    waitFor: '.agent-inline-editor',
    afterGoto: cleanupNotRunnableAgentApi,
  },
  {
    name: 'mobile-home',
    title: 'Mobile — Home',
    path: '/',
    viewport: MOBILE,
    afterGoto: async (page) => {
      await assertNoStrayProjectModal(page);
      // Exercise the two-line heading seen with the hosted runner's fonts.
      const style = await page.addStyleTag({
        content: '.home-view__welcome h1 { max-width: 250px !important; }',
      });
      try {
        const heading = page.locator('.home-view__welcome h1');
        const action = page.locator('.home-view__action').nth(1);
        const dock = page.locator('.chat-dock.is-collapsed');
        await expect(heading).toBeVisible();
        await expect(action).toBeVisible();
        await expect(dock).toBeVisible();
        const headingBox = await heading.boundingBox();
        const actionBox = await action.boundingBox();
        const dockBox = await dock.boundingBox();
        expect(headingBox!.height).toBeGreaterThan(35);
        expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(
          dockBox!.y,
        );
      } finally {
        await style.evaluate((element) => {
          element.parentNode?.removeChild(element);
        });
      }
    },
  },
  {
    name: 'mobile-agents',
    title: 'Mobile — Agents',
    path: '/agents',
    viewport: MOBILE,
  },
  {
    // archive#4521 item 4: on a touch/narrow surface DetailHeader's own
    // sticky footer (`.detail-header__mobile-footer`, `position: fixed`) is
    // the editor's ONE save affordance now — proves it, and only it, is
    // present: the header row's own copy no longer mounts here (gated on
    // `useIsMobile()`), which is what put two Save controls on screen at
    // once before this fix.
    name: 'mobile-agent-editor-save-footer',
    title: 'Mobile — Agent editor save footer',
    path: `/agents/${GALLERY_NOT_RUNNABLE_AGENT_SLUG}`,
    viewport: MOBILE,
    beforeGoto: seedNotRunnableAgentApi,
    waitFor: '.detail-header__mobile-footer',
    afterGoto: async (page) => {
      try {
        await expect(
          page.locator('.agent-editor__save-btn').filter({ visible: true }),
        ).toHaveCount(1);
      } finally {
        await cleanupNotRunnableAgentApi(page);
      }
    },
  },
  {
    name: 'mobile-agent-editor-project-control',
    title: 'Mobile — Project control above the save footer',
    path: `/agents/${GALLERY_NOT_RUNNABLE_AGENT_SLUG}`,
    viewport: MOBILE,
    beforeGoto: seedNotRunnableAgentApi,
    waitFor: '.detail-header__mobile-footer',
    afterGoto: async (page) => {
      try {
        await page.mouse.move(200, 600);
        await page.mouse.wheel(0, 350);
        const project = page.locator('#ae-project');
        await project.click({ trial: true });
        await expect
          .poll(async () => {
            const control = await project.boundingBox();
            const footer = await page
              .locator('.detail-header__mobile-footer')
              .boundingBox();
            return (
              !!control &&
              !!footer &&
              control.y >= 0 &&
              control.y + control.height <= footer.y
            );
          })
          .toBe(true);
      } finally {
        await cleanupNotRunnableAgentApi(page);
      }
    },
  },
  {
    name: 'mobile-settings-overview',
    title: 'Mobile — Settings overview',
    path: '/settings?view=overview',
    viewport: MOBILE,
    // archive#4461: NOT `.settings.page` — SettingsView's root is
    // `<div className="settings">`, with no `page` class, and that root also
    // wraps the pre-config skeleton/error branch (SettingsView.tsx:538), so
    // waiting on `.settings` would accept a half-rendered page as a pass.
    // `.settings__search` (SettingsView.tsx:599) exists only once the loaded
    // branch renders, which is the state this screen exists to capture.
    waitFor: '.settings__search',
  },
  // archive#192 converged empty-state screens — both should render the shared
  // Console Kit `Empty` visual (dashed-border card), not bespoke markup.
  (() => {
    let cleanup: () => Promise<void> = async () => {};
    return {
      name: 'agents-empty',
      title: 'Agents — empty state',
      path: '/agents',
      viewport: DESKTOP,
      beforeGoto: async (page) => {
        cleanup = await withRoute(
          page,
          '**/api/agents',
          fulfillAgentsEmptyFixture,
        );
      },
      afterGoto: async (page) => {
        try {
          // Stability guard: the mocked, empty `/api/agents` response can still
          // land a beat after the generic post-navigation settle, leaving a
          // loading skeleton on screen instead of the converged `Empty` tile.
          // Assert the actual empty-state copy is visible immediately before the
          // shot rather than trusting the fixed settle delay.
          await expect(page.getByText('No agents yet')).toBeVisible({
            timeout: 10_000,
          });
        } finally {
          await cleanup();
        }
      },
    } satisfies Screen;
  })(),
  {
    name: 'command-palette-empty',
    title: 'Command palette — no matches',
    path: '/',
    viewport: DESKTOP,
    afterGoto: async (page) => {
      const openPaletteWithNoMatches = async () => {
        // The screenshot runner executes on macOS, where `cmd` means Meta,
        // not Control. Exercise the palette's public opener directly so this
        // tile captures the same surface without making an OS-specific
        // keyboard-modifier assumption.
        await page.evaluate(() => {
          window.dispatchEvent(new Event('open-command-palette'));
        });
        const input = page.locator('.command-palette__input');
        await input.waitFor({ timeout: 10_000 });
        await input.fill('zzzznonexistentcommandzzzz');
        await page
          .getByText('No matching commands')
          .waitFor({ timeout: 10_000 });
      };

      const overlay = newProjectOverlay(page);

      // Guard against the root-route redirect race described above
      // `newProjectOverlay`: retry the palette-open interaction if the New
      // Project overlay ever wins the race and stacks on top of it, instead
      // of letting a transient flip get captured as this tile.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await overlay.count()) {
          // A redirect already landed before we started — dismiss it and let
          // the home route resettle before retrying.
          await page.keyboard.press('Escape');
          await overlay
            .waitFor({ state: 'detached', timeout: 10_000 })
            .catch(() => undefined);
          await page.waitForTimeout(300);
        }

        await openPaletteWithNoMatches();

        if ((await overlay.count()) === 0) {
          break;
        }

        // The redirect fired mid-interaction and stacked the overlay over the
        // open palette — close everything and retry rather than let it ride.
        await page.keyboard.press('Escape');
        await overlay
          .waitFor({ state: 'detached', timeout: 10_000 })
          .catch(() => undefined);
      }

      // Final stability assertion right before the shot: the palette's own
      // "no matches" Empty state must be visible AND the New Project overlay
      // must be absent. This is the site of a known race (a
      // transient /projects/new flip captured as this tile instead of the
      // command palette) — fail loudly here (recorded as a broken tile, not
      // a silently wrong capture) rather than let it slide.
      await expect(page.getByText('No matching commands')).toBeVisible();
      await expect(overlay).toHaveCount(0);
      // archive#4464: `settingsCatalogLoadState === 'loading'` renders its
      // OWN `SkeletonBlock` above the results list independently of
      // `ranked.length === 0` — "No matching commands" and a loading
      // skeleton for deferred settings commands can both be on screen at
      // once. The universal `assertNoLoadingSkeleton` wait runs before this
      // screen even opens the palette, so it can't catch this one; wait for
      // it here, right before the shot, instead.
      await assertNoLoadingSkeleton(page);
    },
  },
  {
    name: 'motion-reduced-navigation',
    title: 'Reduced motion — desktop navigation',
    path: '/agents',
    viewport: DESKTOP,
    reducedMotion: true,
    // archive#4461: NOT `.page` — that class was retired with the per-view
    // page wrapper; `.route-transition` (AppViewContent.tsx:223) is the
    // element that animates route entrances now. Honest scope: the tokens.css
    // global reduce rule collapses ALL animation/transition durations, so
    // this assertion derives "the global collapse applied to a genuinely
    // animated element", not a per-element reduce override — see archive#4467 for
    // upgrading these probes to getAnimations().
    afterGoto: (page) => assertReducedMotion(page, '.route-transition'),
  },
  (() => {
    let cleanups: (() => Promise<void>)[] = [];
    return {
      name: 'motion-reduced-schedule-loading',
      title: 'Reduced motion — Schedule loading',
      path: '/automations',
      viewport: DESKTOP,
      reducedMotion: true,
      // This screen's whole point is capturing the skeleton itself (with the
      // `/scheduler/jobs` fetch held open below) — opt out of the universal
      // assertNoLoadingSkeleton wait, which would otherwise wait out its
      // entire 15s deadline every run.
      expectSkeleton: true,
      beforeGoto: async (page) => {
        cleanups = [
          await seedScheduleScreenshotApi(page),
          await withRoute(
            page,
            '**/scheduler/jobs',
            fulfillScheduleLoadingJobsFixture,
          ),
        ];
      },
      // archive#4461: NOT `.station-spinner` — that class is gone entirely.
      // `ScheduleView` now renders its loading state via the shared
      // `SkeletonBlock` (ScheduleView.tsx:204-205), whose blocks carry
      // `@kontourai/ui`'s animated `.skeleton` class. Same honest scope as the
      // navigation screen above: this derives the global reduce collapse on an
      // animated element, not the ui package's own reduce override (archive#4467).
      afterGoto: async (page) => {
        try {
          await assertReducedMotion(page, '.skeleton');
        } finally {
          for (const cleanup of cleanups.reverse()) await cleanup();
        }
      },
    } satisfies Screen;
  })(),
  (() => {
    let cleanup: () => Promise<void> = async () => {};
    return {
      name: 'motion-reduced-schedule-modal',
      title: 'Reduced motion — Schedule modal',
      path: '/automations',
      viewport: DESKTOP,
      reducedMotion: true,
      beforeGoto: async (page) => {
        cleanup = await seedScheduleScreenshotApi(page);
      },
      afterGoto: async (page) => {
        try {
          await page
            .getByRole('button', { name: 'New automation', exact: true })
            .click();
          // archive#4461: NOT `.schedule__modal-overlay` — Add Job migrated onto
          // the shared `Dialog` chrome (components/Dialog.tsx), which renders its
          // backdrop as `.station-dialog__overlay` (Dialog.tsx:118, index.css:699).
          // `.schedule__modal` survives unchanged: it's still passed through as
          // `panelClassName` onto the dialog panel
          // (components/scheduler/JobFormModal.tsx:274). Same honest scope as the
          // other motion screens: these derive the global reduce collapse (archive#4467).
          await assertReducedMotion(page, '.station-dialog__overlay');
          await assertReducedMotion(page, '.schedule__modal');
        } finally {
          await cleanup();
        }
      },
    } satisfies Screen;
  })(),
  {
    name: 'motion-reduced-notification',
    title: 'Reduced motion — notification',
    path: '/',
    viewport: DESKTOP,
    reducedMotion: true,
    afterGoto: async (page) => {
      await assertNoStrayProjectModal(page);
      const status = await page.evaluate(async () => {
        const response = await fetch('/notifications', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            category: 'test',
            title: 'Reduced motion is active',
            body: 'Notification state remains visible without entrance motion.',
            ttl: 15_000,
          }),
        });
        return response.status;
      });
      // #2639: a refused request (the route sets `source` itself since #2597)
      // must fail here, not as a toast that never appears.
      expect(status, 'POST /notifications for "Reduced motion is active"').toBe(
        201,
      );
      await expect(page.getByText('Reduced motion is active')).toBeVisible({
        timeout: 10_000,
      });
      await assertReducedMotion(page, '.toast-card');
    },
  },
  {
    name: 'motion-reduced-mobile-chat',
    title: 'Reduced motion — mobile chat dock',
    path: '/?dock=open',
    viewport: MOBILE,
    reducedMotion: true,
    afterGoto: async (page) => {
      await assertNoStrayProjectModal(page);
      await assertReducedMotion(page, '.chat-dock');
    },
  },
  // archive#4469 — overlay screen family: modals, menus, banners, and
  // sheets stacked above the base page. Each is driven open via a stable,
  // deterministic trigger (never the transient home-route redirect race —
  // see `newProjectOverlay`'s doc comment) so its shot is reproducible.
  {
    // Renamed three times: `overlay-dock-picker` (#1541, the dock's own
    // occupant picker, deleted in #928 C2b) became `overlay-layout-picker`
    // (#1552 D2's per-surface placement picker), which #2143 retired for one
    // toggle per region and an empty region's offer menu
    // (`overlay-region-offer-menu`). #2155 retires that too: the toggles only
    // show and hide, and the panel they open is #2154's chooser — the same
    // rows the region's own body and its "+" carry. This shot is that panel,
    // opened the way the toolbar opens it.
    name: 'overlay-region-chooser-from-toggle',
    title: 'Overlay — region chooser, held open from its toggle',
    path: '/?dock=open',
    viewport: DESKTOP,
    afterGoto: async (page) => {
      await assertNoStrayProjectModal(page);
      // A fresh home holds Chat in Bottom; Right is empty and hidden, and its
      // toggle is a toggle — so the panel is behind the HOLD, not the click.
      const trigger = page.getByRole('button', {
        name: 'Right region',
        exact: true,
      });
      await trigger.waitFor({ timeout: 10_000 });
      await expect(trigger).toHaveAttribute('aria-pressed', 'false');
      const menu = await openChooserFromToggle(page, 'Right');
      // Rows, not just the panel: an empty panel would still be "visible"
      // and would capture a shot of nothing. Chat is placed (in Bottom) and
      // lists as a MOVE; the coding rows list disabled without a project —
      // both of which the retired offer menu could not show at all.
      await expect(menu.getByRole('menuitem', { name: /^Chat/ })).toBeVisible();
      await expect(
        menu.getByRole('menuitem', { name: /^Agents/ }),
      ).toBeVisible();
      // The hold must not ALSO have toggled the region under the panel.
      await expect(trigger).toHaveAttribute('aria-pressed', 'false');
    },
  },
  {
    name: 'overlay-command-palette-results',
    title: 'Command palette — with results',
    path: '/',
    viewport: DESKTOP,
    afterGoto: async (page) => {
      // Same New Project overlay redirect race `command-palette-empty`
      // guards against — reused here verbatim.
      const openPaletteWithResults = async () => {
        await page.evaluate(() => {
          window.dispatchEvent(new Event('open-command-palette'));
        });
        const input = page.locator('.command-palette__input');
        await input.waitFor({ timeout: 10_000 });
        // "dock" matches the static, always-present "Open chat dock" Action
        // (id `action:open-dock`, keywords include 'dock') — a result with
        // zero dependency on any mocked query data, unlike the
        // agents/projects/skills/messages groups.
        await input.fill('dock');
        await page
          .locator('.command-palette__option')
          .first()
          .waitFor({ timeout: 10_000 });
      };

      const overlay = newProjectOverlay(page);
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await overlay.count()) {
          await page.keyboard.press('Escape');
          await overlay
            .waitFor({ state: 'detached', timeout: 10_000 })
            .catch(() => undefined);
          await page.waitForTimeout(300);
        }

        await openPaletteWithResults();

        if ((await overlay.count()) === 0) {
          break;
        }

        await page.keyboard.press('Escape');
        await overlay
          .waitFor({ state: 'detached', timeout: 10_000 })
          .catch(() => undefined);
      }

      await expect(
        page.locator('.command-palette__option').first(),
      ).toBeVisible();
      await expect(overlay).toHaveCount(0);
      await assertNoLoadingSkeleton(page);
    },
  },
  {
    // archive#4521 item 3: the "Agent actions" (Duplicate/Delete) popover,
    // opened from its real "More actions" trigger in the agent editor's
    // sticky header — proves it renders anchored beneath the trigger, not
    // floating mid-screen (the orphaned-popover regression: `anchorRef`
    // with no overlay/panel classes to spend that measurement).
    name: 'overlay-agent-actions-menu',
    title: 'Overlay — Agent actions menu',
    path: `/agents/${GALLERY_NOT_RUNNABLE_AGENT_SLUG}`,
    viewport: DESKTOP,
    beforeGoto: seedNotRunnableAgentApi,
    waitFor: '.agent-inline-editor',
    afterGoto: async (page) => {
      try {
        const trigger = page.getByRole('button', { name: 'More actions' });
        await trigger.waitFor({ timeout: 10_000 });
        await trigger.click();
        await expect(
          page.getByRole('dialog', { name: 'Agent actions' }),
        ).toBeVisible({ timeout: 10_000 });
        await expect(
          page.getByRole('menuitem', { name: 'Duplicate' }),
        ).toBeVisible();
      } finally {
        await cleanupNotRunnableAgentApi(page);
      }
    },
  },
  (() => {
    let cleanup: () => Promise<void> = async () => {};
    return {
      name: 'overlay-connection-banner',
      title: 'Station details — Identity mismatch and recovery actions',
      // Settings avoids live Agent detection noise beneath the real dialog.
      path: '/settings?view=overview',
      viewport: MOBILE,
      waitFor: '.settings__search',
      beforeGoto: async (page) => {
        // archive#4470's identity-mismatch condition — reachable purely through
        // the public handshake `probeServerConnection` reads
        // (`serverHealth.ts`), with no dependency on any real paired
        // connection: `typeof handshake.environmentId !== 'string'` alone
        // trips the reason, regardless of what (if anything) this fixture's
        // own `expectedEnvironmentId` is. Every other field is required by
        // `probeServerConnection`/`evaluateCompatibility` to clear the
        // schema/compatibility checks that run before the identity check —
        // a host that fails any of THOSE would report a different reason.
        //
        // Answered only for the first two calls, then left to hang:
        // `ConnectionBannerSource.tsx`'s `loopbackFromElsewhere` grows a
        // "Connecting from another device?" sentence into the condition's
        // `detail` once the coordinator's `failureStreak` crosses 3 — a real
        // retry ladder running on real timers (500ms/1s/2s backoff), racing
        // however long this screen takes to reach its shot. Caught live: two
        // otherwise-identical runs disagreeing on whether that sentence (and
        // the detail box's height) had appeared yet. `main.tsx` mounts the
        // app under `React.StrictMode`, whose dev-mode double-invoke can
        // mount `ConnectionBannerSource` (and its coordinator subscription),
        // unmount it, then remount — the FIRST answered call can land on the
        // torn-down instance, leaving the surviving instance's own first
        // probe to hit whatever comes next. Answering two calls (not one)
        // absorbs a single such remount while every probe after is left to
        // hang (never `fulfill`/`continue`/`abort` — Playwright cancels the
        // in-flight request when the next screen navigates away), which caps
        // any ONE coordinator instance's failure streak at 2 — always below
        // the 3-probe threshold that would change the rendered text.
        let calls = 0;
        cleanup = await withRoute(
          page,
          '**/.well-known/station/v1',
          async (route) => {
            calls += 1;
            if (calls > 2) return;
            await route.fulfill({
              json: {
                schemaVersion: 1,
                authentication: { scheme: 'bearer', protocolVersion: 1 },
                transports: { http: 1, sse: 1, websocket: 1 },
                compatibility: {
                  serverVersion: '0.0.0-screenshot-gallery',
                  protocolVersion: 1,
                  minClientProtocol: 1,
                },
                // environmentId deliberately omitted — the exact condition
                // `probeServerConnection` reads as 'identity-mismatch'.
              },
            });
          },
        );
      },
      afterGoto: async (page) => {
        try {
          await page.getByTestId('app-toolbar-connection').click();
          await page
            .getByRole('menuitem', { name: /^Station details/ })
            .click();
          const details = page.getByRole('dialog', {
            name: 'Station details',
            exact: true,
          });
          await expect(details).toBeVisible({ timeout: 15_000 });
          await expect(
            details.getByRole('button', { name: 'Pair again' }),
          ).toBeVisible();
          await expect(
            details.getByRole('button', { name: 'Remove connection' }),
          ).toBeVisible();
        } finally {
          // `withRoute` removes only this screen's LIFO override. The healthy
          // station#531 handshake registered once in the main test body stays
          // active for every later navigation in this page-long-lived run.
          await cleanup();
        }
      },
    } satisfies Screen;
  })(),
  {
    name: 'overlay-new-project-layout-control',
    title: 'Overlay — New Project scrolled to layout choices',
    path: '/',
    viewport: DESKTOP,
    afterGoto: async (page) => {
      await assertNoStrayProjectModal(page);
      await page.locator('[data-new-project-trigger]').click();
      await expect(newProjectOverlay(page)).toBeVisible();
      await page.getByText('More options', { exact: true }).click();
      await page.mouse.move(700, 650);
      await page.mouse.wheel(0, 700);
      const starter = page.getByRole('button', {
        name: /Start without a layout/,
      });
      await starter.click();
      await expect(starter).toHaveAttribute('aria-pressed', 'true');
      // Where the wheel scroll and the click's scroll-into-view stop varies
      // run to run, and with it which controls are on screen (the identity
      // icon's visible initials flickered in and out of axe's view). Pin the
      // modal's scroller to its exact end, where the layout choices sit, and
      // then wait for it to settle.
      await starter.evaluate((element) => {
        for (
          let node = element.parentElement;
          node;
          node = node.parentElement
        ) {
          const { overflowY } = getComputedStyle(node);
          if (
            (overflowY === 'auto' || overflowY === 'scroll') &&
            node.scrollHeight > node.clientHeight
          ) {
            node.scrollTop = node.scrollHeight;
            return;
          }
        }
        // On a tall viewport the open form can fit without scrolling.
      });
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                new Promise<boolean>((settled) => {
                  const positions = () =>
                    Array.from(document.querySelectorAll('*'))
                      .filter((el) => el.scrollTop > 0)
                      .map((el) => el.scrollTop)
                      .join(',');
                  const before = positions();
                  setTimeout(() => settled(positions() === before), 200);
                }),
            ),
          { timeout: 10_000 },
        )
        .toBe(true);
    },
  },
  {
    name: 'overlay-new-project-modal',
    title: 'Overlay — New Project modal',
    path: '/',
    viewport: DESKTOP,
    afterGoto: async (page) => {
      await assertNoStrayProjectModal(page);
      // The sidebar's "New Project" trigger navigates('/projects/new')
      // explicitly — a stable, always-rendered affordance, unlike relying
      // on the transient home-route redirect this suite otherwise guards
      // against (see `newProjectOverlay`'s doc comment).
      await page.locator('[data-new-project-trigger]').click();
      await expect(newProjectOverlay(page)).toBeVisible({ timeout: 10_000 });
    },
  },
  (() => {
    let cleanup: () => Promise<void> = async () => {};
    return {
      name: 'overlay-add-job-modal',
      title: 'Overlay — Add Job modal',
      path: '/automations',
      viewport: DESKTOP,
      beforeGoto: async (page) => {
        cleanup = await seedScheduleScreenshotApi(page);
      },
      afterGoto: async (page) => {
        try {
          await page
            .getByRole('button', { name: 'New automation', exact: true })
            .click();
          await expect(page.locator('.station-dialog__overlay')).toBeVisible({
            timeout: 10_000,
          });
          await expect(page.locator('.schedule__modal')).toBeVisible();
          await expect(
            page.getByRole('button', {
              name: 'Create automation',
              exact: true,
            }),
          ).toBeDisabled();
        } finally {
          await cleanup();
        }
      },
    } satisfies Screen;
  })(),
  (() => {
    let cleanups: (() => Promise<void>)[] = [];
    return {
      name: 'overlay-confirm-dialog',
      title: 'Overlay — Destructive confirm (Delete automation)',
      path: '/automations',
      viewport: DESKTOP,
      beforeGoto: async (page) => {
        cleanups = [
          await seedScheduleScreenshotApi(page),
          // The fixture supplies one automation with a fixed schedule and no
          // run timestamps, so its row renders consistently across captures.
          await withRoute(
            page,
            '**/scheduler/jobs',
            fulfillScheduleGalleryJobFixture,
          ),
        ];
      },
      afterGoto: async (page) => {
        try {
          await page
            .getByRole('button', { name: 'Actions for gallery-demo-job' })
            .click();
          await page
            .getByRole('menu', { name: 'Actions for gallery-demo-job' })
            .getByRole('menuitem', { name: 'Delete', exact: true })
            .click();
          // Deliberately never confirmed: this screen captures the OPEN confirm
          // dialog, not the deletion it would perform.
          await expect(
            page.getByRole('alertdialog', { name: 'Delete automation' }),
          ).toBeVisible({ timeout: 10_000 });
          await expect(page.locator('.station-dialog__overlay')).toBeVisible();
        } finally {
          for (const cleanup of cleanups.reverse()) await cleanup();
        }
      },
    } satisfies Screen;
  })(),
  {
    name: 'overlay-mobile-sheet',
    title: 'New chat — Mobile composer Project picker',
    path: '/?dock=open',
    viewport: MOBILE,
    afterGoto: async (page) => {
      await assertNoStrayProjectModal(page);
      const draft = await openGalleryNewChatDraft(page);
      await draft.getByRole('button', { name: /^Project: / }).click();
      await expect(
        page.getByRole('dialog', { name: 'Choose project', exact: true }),
      ).toBeVisible();
    },
  },
  // archive#4525: no screen in the gallery otherwise stages a BOUND
  // dock project, a session/badge mismatch, or a POPULATED project-switcher
  // row (`overlay-mobile-sheet` above is deliberately empty-state), so
  // those states would be invisible in the build gallery. These
  // three make them visible.
  ...(['dark', 'light'] as const).flatMap((theme) =>
    [DESKTOP, MOBILE, { width: 412, height: 915 }].map(
      (viewport): Screen => ({
        captureTheme: theme,
        name: `new-chat-${theme}-${viewport.width === DESKTOP.width ? 'desktop' : viewport.width === 412 ? 'phone' : 'mobile'}`,
        title: `New chat — ${theme}, ${viewport.width}px`,
        path: '/?dock=open',
        viewport,
        ...withGalleryProjectsList(
          [
            {
              slug: 'demo-project',
              name: 'Demo Project',
              workingDirectory: '/work/station',
              repositoryDisplay: 'github.com/kontourai/station',
              derivedIcon:
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAm0lEQVR4nO3U0QmAMAwE0E7iJM7pOA7hQvVLEEmay6VaxQTyVbh7P00p5NRtrtdlsxIAz7Ss9VgJcH6/rRgFdINIoR5ACKEFegEUohXGAFwIK4gFQAgkJAIwEUMBaEAUoCL+CZCCntwEJGD8L0gAi4gA1PJXAFAECzDLUQQDgMsRhBfgLrcQHgBd3kKggHC5BrEAXYulMe/6VwA7qPD726l6fusAAAAASUVORK5CYII=',
            },
          ],
          async (page) => {
            const draft = await openGalleryNewChatDraft(page);
            await chooseGalleryNewChatProject(page, draft, 'Demo Project');
            if (theme === 'light')
              await page.evaluate(() =>
                document.documentElement.setAttribute('data-theme', 'light'),
              );
            await expect(
              draft.getByRole('heading', {
                name: /What would you like to do.*Demo Project/,
              }),
            ).toBeVisible();
            await expect(
              draft.getByRole('textbox', { name: 'What would you like done?' }),
            ).toBeVisible();
            const setup = draft.getByTestId('run-setup-trigger');
            const markBox = (await setup
              .locator('.composer-choice__icon')
              .boundingBox())!;
            const labelBox = (await setup
              .locator('.chat-input__chip-stack')
              .boundingBox())!;
            const caretBox = (await setup
              .locator('.choice-caret')
              .boundingBox())!;
            expect(
              labelBox.x - markBox.x - markBox.width,
            ).toBeGreaterThanOrEqual(4);
            expect(
              caretBox.x - labelBox.x - labelBox.width,
            ).toBeGreaterThanOrEqual(4);
            const location = draft.locator('.start-composer__location');
            await expect(location).toBeInViewport();
            const bounds = await location.boundingBox();
            expect(bounds).not.toBeNull();
            expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
              viewport.height,
            );
          },
        ),
      }),
    ),
  ),
  ...(['dark', 'light'] as const).flatMap((theme) =>
    [320, 360, 390, 412, 1440].flatMap((width) =>
      ['short', 'long'].map((names): Screen => {
        let fixturePage: Page;
        const id = `reply-composer-${theme}-${width}-${names}`;
        const model =
          names === 'long'
            ? 'reasoning-model-with-a-very-long-version-id-2026'
            : 'Mini';
        const agent =
          names === 'long'
            ? 'Research assistant with an unusually long name'
            : 'Station';
        const hooks = withGalleryProjectsList(
          [],
          async (page) => {
            await page.evaluate(
              (theme) =>
                document.documentElement.setAttribute('data-theme', theme),
              theme,
            );
            const composer = page
              .locator('.chat-input')
              .filter({ visible: true })
              .last();
            await expect(
              composer.getByRole('textbox', { name: 'Message', exact: true }),
            ).toBeVisible();
            await composer
              .getByRole('textbox', { name: 'Message', exact: true })
              .fill('Follow up on this');
            const trigger = composer.getByTestId('run-setup-trigger');
            await expect(trigger).toHaveAccessibleName(new RegExp(agent));
            await expect(trigger).toHaveAttribute(
              'title',
              new RegExp(
                names === 'long'
                  ? 'Reasoning Model With A Very Long Version Id 2026'
                  : model,
              ),
            );
            const send = composer.locator('.chat-input__send-btn');
            const controlBox = (await trigger.boundingBox())!;
            const sendBox = (await send.boundingBox())!;
            const composerBox = (await composer.boundingBox())!;
            expect(
              Math.abs(
                controlBox.y +
                  controlBox.height / 2 -
                  sendBox.y -
                  sendBox.height / 2,
              ),
            ).toBeLessThanOrEqual(1);
            expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(
              sendBox.x,
            );
            expect(sendBox.x + sendBox.width).toBeLessThanOrEqual(
              composerBox.x + composerBox.width,
            );
            expect(controlBox.width).toBeGreaterThanOrEqual(44);
            expect(controlBox.height).toBeGreaterThanOrEqual(44);
            expect(
              await composer.evaluate((el) => el.scrollWidth <= el.clientWidth),
            ).toBe(true);
            if (width === 412 && names === 'long') {
              // Read glyph geometry through every clipping ancestor. textContent
              // alone includes the Agent and separator even when neither paints.
              const firstVisibleGlyph = await trigger
                .locator('.composer-run-control__label')
                .evaluate((label) => {
                  const walker = document.createTreeWalker(
                    label,
                    NodeFilter.SHOW_TEXT,
                  );
                  for (
                    let node = walker.nextNode();
                    node;
                    node = walker.nextNode()
                  ) {
                    for (let i = 0; i < (node.textContent?.length ?? 0); i++) {
                      const char = node.textContent![i]!;
                      if (!char.trim()) continue;
                      const range = document.createRange();
                      range.setStart(node, i);
                      range.setEnd(node, i + 1);
                      const rect = range.getBoundingClientRect();
                      let left = rect.left;
                      let right = rect.right;
                      for (
                        let parent = node.parentElement;
                        parent;
                        parent = parent.parentElement
                      ) {
                        if (getComputedStyle(parent).overflowX !== 'visible') {
                          const clip = parent.getBoundingClientRect();
                          left = Math.max(left, clip.left);
                          right = Math.min(right, clip.right);
                        }
                      }
                      if (rect.width > 1 && right - left >= rect.width * 0.9)
                        return char;
                    }
                  }
                  return null;
                });
              expect(firstVisibleGlyph).not.toBeNull();
              expect(firstVisibleGlyph).not.toBe('·');
            }
            if (width === 320)
              await expect(
                trigger.locator('.chat-input__chip-stack'),
              ).toBeHidden();
            if (width === 320 && names === 'short') {
              await composer
                .getByRole('button', {
                  name: 'More draft options',
                  exact: true,
                })
                .click();
              await page
                .getByRole('menuitem', { name: 'Saved drafts', exact: true })
                .click();
              const drafts = page.getByRole('dialog', {
                name: 'Saved drafts',
                exact: true,
              });
              await expect(drafts).toBeVisible();
              await drafts
                .getByRole('button', {
                  name: 'Close saved drafts',
                  exact: true,
                })
                .click();
              await composer
                .getByRole('button', {
                  name: 'More draft options',
                  exact: true,
                })
                .click();
              await page
                .getByRole('menuitem', { name: 'Clear message', exact: true })
                .click();
              await expect(
                composer.getByRole('textbox', { name: 'Message', exact: true }),
              ).toHaveValue('');
              await composer
                .getByRole('textbox', { name: 'Message', exact: true })
                .fill('Follow up on this');
            }
            // The Inbox row learns about the draft after the fill settles; the
            // audit reads its name, so capture only once the row says so.
            await expect(
              page
                .getByTestId('inbox-row')
                .getByRole('button', {
                  name: /^Toolbar layout.*Waiting on you.*No project.*unsent draft$/,
                })
                .first(),
            ).toBeAttached();
          },
          true,
          false,
          model,
          agent,
        );
        return {
          name: id,
          title: `Reply composer — ${names} names`,
          path: `/?dock=open&chat=${id}`,
          viewport: { width, height: width === 1440 ? 900 : 915 },
          captureTheme: theme,
          ...hooks,
          beforeGoto: async (page) => {
            fixturePage = page;
            await hooks.beforeGoto?.(page);
            await page.addInitScript((conversation) => {
              if (
                new URLSearchParams(location.search).get('chat') !==
                conversation
              )
                return;
              const original = window.fetch.bind(window);
              window.fetch = async (input, init) => {
                const url =
                  input instanceof Request ? input.url : String(input);
                if (
                  new URL(url, location.href).pathname !==
                  '/api/orchestration/events'
                )
                  return original(input, init);
                return new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      init?.signal?.addEventListener(
                        'abort',
                        () => controller.close(),
                        { once: true },
                      );
                    },
                  }),
                  { headers: { 'Content-Type': 'text/event-stream' } },
                );
              };
            }, id);
            await page.route(
              '**/api/orchestration/sessions/read-model',
              orchestrationSessionFixture({ threadId: id }),
            );
            await seedActiveChatSession(page, {
              conversationId: id,
              agentSlug: 'station',
              title: 'Toolbar layout',
            });
            await mockRuntimeConversation(page, {
              id,
              agentSlug: 'station',
              title: 'Toolbar layout',
              provider: 'station-agent',
              model,
              canContinue: true,
              turns: () =>
                buildLongSessionTurns({
                  threadId: id,
                  provider: 'station-agent',
                  turnCount: 1,
                  replyText: () => 'Ready for your next message.',
                }),
            });
          },
          cleanup: async () => {
            const page = fixturePage;
            await hooks.cleanup?.();
            await page.unroute('**/api/orchestration/sessions/read-model');
            await page.unroute(`**/api/conversations/${id}/open`);
            await page.unroute(
              `**/api/orchestration/conversations/${id}/inbox`,
            );
            await page.unroute(
              `**/api/orchestration/conversations/${id}/event-window**`,
            );
            await page.unroute(
              `**/api/orchestration/sessions/${id}/turns/*/basis`,
            );
          },
        };
      }),
    ),
  ),
  ...[390, 412].map(
    (width): Screen => ({
      name: `run-setup-full-access-${width}`,
      title: 'Run setup — full access',
      path: '/?dock=open',
      viewport: { width, height: 915 },
      ...withGalleryProjectsList(
        [],
        async (page) => {
          const draft = await openGalleryNewChatDraft(page);
          const trigger = draft.getByTestId('run-setup-trigger');
          await expect(trigger).toContainText('⚠');
          await expect(trigger).toHaveAccessibleName(/Full access/);
          await expect(trigger).toBeInViewport();
          const model = trigger.locator('.composer-run-control__model');
          await expect(model).toHaveText('Mini');
          const modelBox = await model.boundingBox();
          const triggerBox = await trigger.boundingBox();
          expect(modelBox).not.toBeNull();
          expect(triggerBox).not.toBeNull();
          expect(modelBox!.x + modelBox!.width).toBeLessThanOrEqual(
            triggerBox!.x + triggerBox!.width,
          );
          expect(
            await model.evaluate((el) => el.scrollWidth <= el.clientWidth),
          ).toBe(true);
          await expect(
            draft.getByRole('button', { name: /Attach/ }).first(),
          ).toBeInViewport();
          await expect(
            draft.getByRole('button', { name: 'Start', exact: true }),
          ).toBeInViewport();
          await expect(
            draft.getByRole('button', {
              name: /^(Speak message|Microphone unavailable)$/,
            }),
          ).toBeInViewport();
        },
        true,
        true,
        'Mini',
      ),
    }),
  ),
  ...(['dark', 'light'] as const).flatMap((theme) =>
    [DESKTOP, MOBILE, { width: 412, height: 915 }].map(
      (viewport): Screen => ({
        name: `run-setup-filled-${theme}-${viewport.width}`,
        title: `Filled run setup — ${theme}, ${viewport.width}px`,
        path: '/?dock=open',
        viewport,
        captureTheme: theme,
        ...withGalleryProjectsList(
          [],
          async (page) => {
            const draft = await openGalleryNewChatDraft(page);
            if (theme === 'light')
              await page.evaluate(() =>
                document.documentElement.setAttribute('data-theme', 'light'),
              );
            const trigger = draft.getByTestId('run-setup-trigger');
            await expect(trigger).toContainText('Mini');
            await expect(trigger).not.toContainText('Station');
            await expect(trigger).toHaveAccessibleName(/^Station · Mini/);
            const setupBox = (await trigger.boundingBox())!;
            const startBox = (await draft
              .getByRole('button', { name: 'Start', exact: true })
              .boundingBox())!;
            expect(
              Math.abs(
                setupBox.y +
                  setupBox.height / 2 -
                  startBox.y -
                  startBox.height / 2,
              ),
            ).toBeLessThanOrEqual(1);
            expect(setupBox.x + setupBox.width).toBeLessThanOrEqual(startBox.x);
            expect(
              await draft
                .locator('.start-composer__box')
                .evaluate((el) => el.scrollWidth <= el.clientWidth),
            ).toBe(true);

            await expect(
              trigger.locator('[data-brand-key="station"]'),
            ).toHaveCount(1);
            await expect(trigger).toBeInViewport();
            await expect(
              page.getByRole('dialog', {
                name: 'Agent & model',
                exact: true,
              }),
            ).toBeHidden();
          },
          true,
          false,
          'Mini',
        ),
      }),
    ),
  ),
  ...(['dark', 'light'] as const).flatMap((theme) =>
    [DESKTOP, MOBILE, { width: 412, height: 915 }].map(
      (viewport): Screen => ({
        captureTheme: theme,
        name: `run-setup-${theme}-${viewport.width}`,
        title: `Run setup — ${theme}, ${viewport.width}px`,
        path: '/?dock=open',
        viewport,
        ...withGalleryProjectsList(
          [{ slug: 'demo-project', name: 'Demo Project' }],
          async (page) => {
            const draft = await openGalleryNewChatDraft(page);
            if (theme === 'light')
              await page.evaluate(() =>
                document.documentElement.setAttribute('data-theme', 'light'),
              );
            const trigger = draft.getByTestId('run-setup-trigger');
            await expect(trigger).toBeInViewport();
            const bounds = await trigger.boundingBox();
            expect(bounds!.width).toBeLessThan(viewport.width);
            await trigger.click();
            await expect(
              page.getByRole('dialog', { name: 'Agent & model' }),
            ).toBeVisible();
            await expect(
              page.getByRole('button', { name: /^Agent:/ }),
            ).toBeVisible();
            await expect(
              page.getByRole('button', { name: /^Model:/ }),
            ).toBeVisible();
          },
        ),
      }),
    ),
  ),
  ...(['dark', 'light'] as const).flatMap((theme) =>
    [{ width: 412, height: 915 }].map(
      (viewport): Screen => ({
        captureTheme: theme,
        name: `run-setup-model-stacked-${theme}-${viewport.width}`,
        title: `Stacked model picker — ${theme}, ${viewport.width}px`,
        path: '/?dock=open',
        viewport,
        ...withGalleryProjectsList(
          [{ slug: 'demo-project', name: 'Demo Project' }],
          async (page) => {
            const draft = await openGalleryNewChatDraft(page);
            if (theme === 'light')
              await page.evaluate(() =>
                document.documentElement.setAttribute('data-theme', 'light'),
              );
            const trigger = draft.getByTestId('run-setup-trigger');
            await expect(trigger).toBeInViewport();
            const bounds = await trigger.boundingBox();
            expect(bounds!.width).toBeLessThan(viewport.width);
            await trigger.click();
            await expect(
              page.getByRole('dialog', { name: 'Agent & model' }),
            ).toBeVisible();
            await expect(
              page.getByRole('button', { name: /^Agent:/ }),
            ).toBeVisible();
            await expect(
              page.getByRole('button', { name: /^Model:/ }),
            ).toBeVisible();
            await page
              .getByRole('dialog', {
                name: 'Agent & model',
                exact: true,
              })
              .getByRole('button', { name: /^Model:/ })
              .click();
            const picker = page.getByRole('dialog', {
              name: /^(Model|Engine & model)$/,
              exact: true,
            });
            await expect(picker).toBeVisible();
            await picker.evaluate(async (panel) => {
              await Promise.allSettled(
                panel
                  .getAnimations({ subtree: true })
                  .map((animation) => animation.finished),
              );
            });
            const box = await picker.boundingBox();
            expect(box!.x).toBeGreaterThanOrEqual(0);
            expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
          },
          true,
        ),
      }),
    ),
  ),
  {
    name: 'overlay-dock-project-bound',
    title: 'New chat — Project chosen before starting',
    path: '/?dock=open',
    viewport: DESKTOP,
    ...withGalleryProjectsList(
      [{ slug: 'demo-project', name: 'Demo Project' }],
      async (page) => {
        await assertNoStrayProjectModal(page);
        const draft = await openGalleryNewChatDraft(page);
        await chooseGalleryNewChatProject(page, draft, 'Demo Project');
        await expect(page.locator('.chat-dock__project-badge')).toHaveCount(0);
      },
    ),
  },
  {
    name: 'overlay-dock-project-mismatch',
    title: 'Chat — Original Project retained after choosing a new-chat Project',
    path: '/?dock=open&chat=gallery-mismatch-conversation',
    viewport: DESKTOP,
    ...overlayDockProjectMismatchHooks(),
  },
  ...(
    [
      ['desktop-conversation-resync', DESKTOP],
      ['mobile-conversation-resync', MOBILE],
    ] as const
  ).map(([name, viewport]) => ({
    name,
    title: `${name.startsWith('mobile') ? 'Mobile' : 'Desktop'} — Conversation status unavailable`,
    path: '/?dock=open&chat=gallery-mismatch-conversation',
    viewport,
    ...overlayDockProjectMismatchHooks(true),
    afterAudit: verifyConversationRecovery,
  })),
  ...[DESKTOP, { width: 412, height: 915 }].map(
    (viewport): Screen => ({
      name: `detected-project-${viewport.width === 412 ? 'phone' : 'desktop'}`,
      title: 'Project picker — detected artwork and repository identity',
      path: '/?dock=open',
      viewport,
      ...withGalleryProjectsList(
        [
          {
            slug: 'demo-project',
            name: 'Demo Project',
            workingDirectory: '/work/station',
            repositoryDisplay: 'github.com/kontourai/station',
            derivedIcon:
              'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAm0lEQVR4nO3U0QmAMAwE0E7iJM7pOA7hQvVLEEmay6VaxQTyVbh7P00p5NRtrtdlsxIAz7Ss9VgJcH6/rRgFdINIoR5ACKEFegEUohXGAFwIK4gFQAgkJAIwEUMBaEAUoCL+CZCCntwEJGD8L0gAi4gA1PJXAFAECzDLUQQDgMsRhBfgLrcQHgBd3kKggHC5BrEAXYulMe/6VwA7qPD726l6fusAAAAASUVORK5CYII=',
          },
        ],
        async (page) => {
          const draft = await openGalleryNewChatDraft(page);
          await chooseGalleryNewChatProject(page, draft, 'Demo Project');
          await draft.getByRole('button', { name: /^Project: / }).click();
          await expect(
            page.getByRole('dialog', { name: 'Choose project' }),
          ).toBeVisible();
        },
      ),
    }),
  ),
  {
    name: 'active-chat-phone',
    title: 'Active chat header — actions and Station identity',
    path: '/?dock=open&chat=gallery-mismatch-conversation',
    viewport: { width: 412, height: 915 },
    ...overlayDockProjectMismatchHooks(true),
  },
  {
    name: 'overlay-project-switcher-populated',
    title: 'New chat — Populated Project picker',
    path: '/?dock=open',
    viewport: DESKTOP,
    ...withGalleryProjectsList(
      [{ slug: 'demo-project', name: 'Demo Project' }],
      async (page) => {
        await assertNoStrayProjectModal(page);
        const draft = await openGalleryNewChatDraft(page);
        await draft.getByRole('button', { name: /^Project: / }).click();
        const picker = page.getByRole('dialog', {
          name: 'Choose project',
          exact: true,
        });
        await expect(picker).toBeVisible();
        await expect(
          picker.getByRole('button', { name: 'Demo Project' }),
        ).toBeVisible();
      },
    ),
  },
  {
    name: 'overlay-toast',
    title: 'Overlay — Toast notification',
    path: '/',
    viewport: DESKTOP,
    afterGoto: async (page) => {
      await assertNoStrayProjectModal(page);
      // Same driving mechanism as `motion-reduced-notification`, without the
      // reduced-motion emulation — nothing about producing the toast itself
      // is motion-preference-specific. `hideVolatileChrome` already hides
      // `.toast-card__time`'s live relative timestamp.
      const status = await page.evaluate(async () => {
        const response = await fetch('/notifications', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            category: 'test',
            title: 'Overlay gallery toast',
            body: 'A toast captured at normal (non-reduced) motion.',
            ttl: 15_000,
          }),
        });
        return response.status;
      });
      // #2639: a refused request (the route sets `source` itself since #2597)
      // must fail here, not as a toast that never appears.
      expect(status, 'POST /notifications for "Overlay gallery toast"').toBe(
        201,
      );
      await expect(page.getByText('Overlay gallery toast')).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.locator('.toast-card')).toBeVisible();
    },
  },
  {
    name: 'overlay-toast-action',
    title: 'Overlay — Toast with an action button',
    path: '/',
    viewport: DESKTOP,
    afterGoto: async (page) => {
      await assertNoStrayProjectModal(page);
      // `NotificationContainer.tsx` renders a "View" action button whenever
      // `notification.metadata.navigateTo` is present (`handleNavigateTo`) —
      // the generic, always-available action-button path (distinct from the
      // pairing-only Allow/Deny pair, which needs a live pairing exchange
      // this gallery has no reason to fabricate). `notificationCreateSchema`
      // (src-server/routes/schemas/schema-definitions/system.ts) is
      // `.passthrough()`, so `metadata` rides through the same POST
      // `overlay-toast` already uses.
      const status = await page.evaluate(async () => {
        const response = await fetch('/notifications', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            category: 'test',
            title: 'Toast with an action',
            body: 'This toast carries a View action button.',
            ttl: 15_000,
            metadata: { navigateTo: { path: '/agents' } },
          }),
        });
        return response.status;
      });
      // #2639: a refused request (the route sets `source` itself since #2597)
      // must fail here, not as a toast that never appears.
      expect(status, 'POST /notifications for "Toast with an action"').toBe(
        201,
      );
      const toast = page.locator('.toast-card', {
        hasText: 'Toast with an action',
      });
      await expect(toast).toBeVisible({ timeout: 10_000 });
      await expect(toast.getByRole('button', { name: 'View' })).toBeVisible();
    },
  },
  // archive#4521 already adds `agent-editor-not-runnable` and
  // `overlay-agent-actions-menu` (above, near `agent-editor`) against a
  // more accurate fixture (a Station-native agent with no LLM provider
  // connection, matching that issue's real defect) — not duplicated
  // here; see `notRunnableGalleryAgent` above.
  // Mobile viewport family (archive#4464-class coverage gap): the
  // primary surfaces at the phone viewport the owner actually dogfoods on —
  // recent owner-reported defects lived at this viewport, and the gallery
  // was desktop-only.
  // Note: a plain "mobile — chat dock" screen (`mobile-chat-dock`,
  // `/?dock=open`, MOBILE
  // viewport, no `reducedMotion`) renders pixel-identical
  // (same decoded-RGBA sha256) to the existing `motion-reduced-mobile-chat`
  // below — the capture loop's `animations: 'disabled'` freezes every shot
  // at its end state regardless of a screen's own `reducedMotion` flag, so
  // the two had no observable visual difference left to justify a second
  // tile. Dropped in favor of `motion-reduced-mobile-chat`; kept
  // `mobile-chat-dock-header-320` below, which is a genuinely distinct
  // 320px worst-case viewport.
  {
    name: 'mobile-chat-dock-header-320',
    title: 'Mobile — Chat dock header (320px worst case)',
    path: '/?dock=open',
    // docs/guides/testing.md / responsive-action-surfaces.txt: 320px is the
    // documented worst-case width `ChatDockMobileHeader.tsx` and
    // `tests/mobile-chat-composer.spec.ts` are proven against — the
    // narrowest one-row mobile chrome this app commits to.
    viewport: { width: 320, height: 568 },
    afterGoto: async (page) => {
      await assertNoStrayProjectModal(page);
      const brand = page.locator('.app-toolbar__brand');
      await expect(brand).toBeVisible();
      const geometry = await brand.evaluate((element) => {
        const toolbar = element.closest('.app-toolbar')!;
        return {
          name: element.textContent,
          available: element.clientWidth,
          required: element.scrollWidth,
          gap: getComputedStyle(toolbar).gap,
          children: Array.from(toolbar.children).map((child) => ({
            className: child.className,
            width: child.getBoundingClientRect().width,
          })),
        };
      });
      expect(
        geometry.required <= geometry.available + 1,
        JSON.stringify(geometry),
      ).toBe(true);
      await expect(page.locator('.chat-dock')).toBeVisible({
        timeout: 10_000,
      });
    },
  },
  {
    name: 'mobile-connections',
    title: 'Mobile — Customize',
    path: '/customize',
    viewport: MOBILE,
    ...connectionsHubBadgeSettleHooks(),
  },
  {
    name: 'mobile-agent-editor',
    title: 'Mobile — Agent editor',
    path: '/agents/new',
    viewport: MOBILE,
  },
  (() => {
    const { beforeGoto, waitSettled, cleanup } =
      onboardingSetupBannerSettleHooks();
    return {
      name: 'mobile-onboarding-setup',
      title: 'Mobile — Onboarding setup banner',
      // The `ONBOARDING_SETUP_RESET_MARKER` query param is this screen's own
      // self-gate for its storage-clearing init script — see
      // `onboardingSetupBannerSettleHooks`'s doc comment. Not read by the app's router (`getLegacyPathRedirect` has no
      // case for `/`, same as the existing `?dock=open` precedent above).
      path: `/?${ONBOARDING_SETUP_RESET_MARKER}=1`,
      viewport: MOBILE,
      beforeGoto,
      afterGoto: async (page) => {
        try {
          await waitSettled();
          await assertNoStrayProjectModal(page);
          const launcher = page.getByTestId('setup-launcher');
          await expect(launcher).toBeVisible({ timeout: 15_000 });
          // See this screen's `volatile: true` baseline entry (archive#4464's
          // own hand-curated-exception mechanism) for why this
          // screen's determinism story ends here rather than in a settle
          // guard: three hypotheses were tried and DISPROVED (a live
          // `/api/system/status` race — closed by `waitSettled` above; a
          // CSS `animation` on the card — it has none, `onboarding-fade-up`
          // belongs to the unrelated `.onboarding-loading__content`
          // full-page loading state; a `--dock-slot-size`-driven layout
          // race — measured byte-identical across 4 repeated runs, both
          // the custom property and the launcher's own `boundingBox()`)
          // before concluding the ~30px (0.009%) residual is sub-pixel
          // rasterization noise at the card's rounded border, surviving
          // even this project's deterministic-rendering Chromium flags
          // (`--disable-lcd-text`/`--font-render-hinting=none`/
          // `--disable-partial-raster`/`--disable-skia-runtime-opts` —
          // playwright.config.ts). This was independently RE-CONFIRMED: 9
          // standalone/mixed-order
          // captures of this one screen (route/init-script order ruled
          // out as the variable)
          // landed on two distinct stable sha256 values (6 of 9 vs 3 of
          // 9), with no correlation found to run order, preceding screen,
          // or anything else under this suite's control — so the
          // exemption stays.
        } finally {
          // See `withRoute`'s doc comment: the status route registered in
          // `beforeGoto` must be unregistered here or the "unconfigured"
          // fixture leaks into every screen captured after this one for
          // the rest of the run.
          await cleanup();
        }
      },
    } satisfies Screen;
  })(),
  ...inventoryDrilldownScreens(),
  ...childChatScreens(),
  ...stationSwitcherScreens(),
  ...taskCapabilityScreens(),
  ...pullRequestWatchScreens(),
];

async function statusRasterState(page: Page) {
  return page
    .getByRole('button', {
      name: 'Status unavailable — resync this conversation',
      exact: true,
    })
    .locator('..')
    .evaluate((host) => {
      const svg = host.querySelector('.live-status-glyph svg');
      if (!(svg instanceof SVGSVGElement))
        throw new Error('Mismatch status warning SVG is missing');
      const matrix = svg.getScreenCTM();
      if (!matrix) throw new Error('Mismatch status SVG has no screen matrix');
      const rect = svg.getBoundingClientRect();
      return {
        devicePixelRatio,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        matrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f],
        strokeWidth: getComputedStyle(svg).strokeWidth,
        color: getComputedStyle(svg).color,
        ancestors: [
          host,
          ...host.querySelectorAll('button, .chat-status-pill__body'),
        ]
          .slice(0, 8)
          .map((element) => {
            const style = getComputedStyle(element);
            return {
              className: element.className,
              transform: style.transform,
              opacity: style.opacity,
              willChange: style.willChange,
            };
          }),
        animations: host
          .getAnimations({ subtree: true })
          .slice(0, 16)
          .map((animation) => {
            const timing = animation.effect?.getComputedTiming();
            return {
              playState: animation.playState,
              pending: animation.pending,
              fill: timing?.fill,
              progress: timing?.progress,
              iterations:
                timing?.iterations === Infinity
                  ? 'infinite'
                  : timing?.iterations,
            };
          }),
      };
    });
}

interface Shot {
  screen: Screen;
  file: string;
  ok: boolean;
  error?: string;
  browserErrors?: string[];
  sha256?: string;
  controls?: Array<{ label: string; disabled: boolean }>;
  rasterDiagnostic?: {
    before: Awaited<ReturnType<typeof statusRasterState>>;
    after: Awaited<ReturnType<typeof statusRasterState>>;
    retiredCount: number;
    file: string;
    sha256: string;
  };
  layout?: {
    appMainScrollTop: number;
    appMainScrollHeight: number;
    appMainClientHeight: number;
    documentScrollY: number;
  };
  /**
   * Product assertions on the photographed state (hit targets, horizontal
   * overflow, blocking axe). Recorded, not judged, here: the pixels are valid
   * whatever they find, and `scripts/gallery-ui-findings.mjs` judges them
   * against the shrink-only allowlist. An audit that threw is an `error`,
   * which that judge fails rather than reading as "no findings".
   */
  uiAudit?: GalleryUiAudit | { error: string };
  /** 2 when an app error surface earned this screen its single second capture. */
  attempts?: 1 | 2;
  /** The final attempt's app error surface, when that is why the screen failed. */
  appError?: AppErrorObservation;
  /**
   * Report only. Between the controls read just before the screenshot and
   * those read after the audit: which names changed, and how far
   * same-identity controls moved.
   */
  controlsAfterPhoto?: ControlNameDiff;
  controlMovement?: ControlMovement;
}

/** Visible controls, as the capture records them for a screen. */
async function readVisibleControls(page: Page) {
  return page
    .locator('button, [role="button"], input[type="submit"]')
    .evaluateAll((elements) =>
      elements
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.top < innerHeight &&
            rect.bottom > 0 &&
            rect.left < innerWidth &&
            rect.right > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none'
          );
        })
        .slice(0, 100)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            label: (
              element.getAttribute('aria-label') ||
              element.textContent ||
              element.getAttribute('value') ||
              ''
            )
              .trim()
              .slice(0, 160),
            disabled:
              element.matches(':disabled') ||
              element.getAttribute('aria-disabled') === 'true',
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        }),
    ) as Promise<ControlBox[]>;
}

function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return value.replace(
    /[&<>"']/g,
    (character) => entities[character] ?? character,
  );
}

function renderIndex(shots: Shot[], capturedAt: string): string {
  const tiles = shots
    .map((shot) => {
      const dims = `${shot.screen.viewport.width}×${shot.screen.viewport.height}`;
      const href = encodeURIComponent(shot.file);
      const title = escapeHtml(shot.screen.title);
      const path = escapeHtml(shot.screen.path);
      const body = shot.ok
        ? `<a href="${href}" target="_blank" rel="noreferrer"><img loading="lazy" src="${href}" alt="${title}" /></a>`
        : `<div class="broken">failed to capture<br/><code>${escapeHtml(shot.error ?? '')}</code></div>`;
      return `<figure class="tile${shot.ok ? '' : ' is-broken'}">
        ${body}
        <figcaption><span class="t">${title}</span><span class="m">${path} · ${escapeHtml(dims)}</span></figcaption>
      </figure>`;
    })
    .join('\n');
  const okCount = shots.filter((s) => s.ok).length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" />
<title>Station build gallery</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b0e11; color: #e6edf3; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
  header { padding: 20px 24px; border-bottom: 1px solid #1e2630; position: sticky; top: 0; background: #0b0e11; }
  header h1 { margin: 0 0 4px; font-size: 18px; }
  header p { margin: 0; color: #8b98a5; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; padding: 20px 24px; }
  .tile { margin: 0; background: #11161c; border: 1px solid #1e2630; border-radius: 8px; overflow: hidden; }
  .tile.is-broken { border-color: #5b2330; }
  .tile img { display: block; width: 100%; height: auto; background: #0b0e11; }
  .tile .broken { display: grid; place-items: center; min-height: 180px; color: #f0a0b0; text-align: center; padding: 16px; font-size: 12px; }
  figcaption { display: flex; justify-content: space-between; gap: 8px; padding: 8px 12px; border-top: 1px solid #1e2630; }
  figcaption .t { font-weight: 600; }
  figcaption .m { color: #8b98a5; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>Station build gallery</h1>
  <p>${okCount}/${SCREENS.length} screens captured · ${escapeHtml(capturedAt)}</p>
</header>
<main class="grid">
${tiles}
</main>
</body>
</html>`;
}

function readGalleryCheckout() {
  try {
    const values = String(
      execFileSyncBounded(
        'git',
        ['rev-parse', '--show-toplevel', 'HEAD', 'HEAD^{tree}'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 4096,
        },
      ),
    )
      .trim()
      .split(/\r?\n/);
    if (
      values.length !== 3 ||
      realpathSync(values[0]) !== realpathSync(process.cwd()) ||
      !/^[a-f0-9]{40}$/.test(values[1]) ||
      !/^[a-f0-9]{40}$/.test(values[2])
    ) {
      return {
        sha: null,
        tree: null,
        dirty: null,
        complete: false,
        error: 'INVALID_GIT_IDENTITY',
      };
    }
    const status = execFileSyncBounded(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 65536,
      },
    );
    const dirty = String(status).length !== 0;
    return {
      sha: values[1],
      tree: values[2],
      dirty,
      complete: !dirty,
      error: null,
    };
  } catch {
    return {
      sha: null,
      tree: null,
      dirty: null,
      complete: false,
      error: 'GIT_IDENTITY_READ_FAILED',
    };
  }
}
/** One line per failed screen, naming a lost lazy chunk as such (#5028). */
function failedShotReasons(shots: Shot[]): string[] {
  return shots
    .filter((shot) => !shot.ok)
    .map((shot) =>
      failedScreenReason(
        shot.screen.name,
        shot.error ?? 'screen did not render',
        shot.appError,
      ),
    );
}

test('build gallery — capture key screens', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && browserErrors.length < 10)
      browserErrors.push(message.text().slice(0, 1000));
  });
  page.on('pageerror', (error) => {
    if (browserErrors.length < 10)
      browserErrors.push((error.stack ?? error.message).slice(0, 1000));
  });
  const requestedScreens = parseRequestedScreens(
    process.env.STATION_E2E_SCREENS,
  );
  // gate:for routes UI paths to screens through these entry modules; a screen
  // without them would be invisible to that routing.
  assertGalleryScreenSourcesCover(SCREENS.map((screen) => screen.name));
  let selectedScreens = SCREENS;
  if (requestedScreens) {
    const knownNames = new Set(SCREENS.map((screen) => screen.name));
    const unknown = requestedScreens.filter((name) => !knownNames.has(name));
    if (unknown.length > 0) {
      throw new Error(
        `STATION_E2E_SCREENS requested unknown screen(s): ${unknown.join(', ')}. ` +
          `Known screens: ${[...knownNames].sort().join(', ')}.`,
      );
    }
    // A filter matching zero screens is an error, not a silent no-op capture
    // — the guard above already rejects any name that isn't a known screen,
    // so this can only trip if SCREENS itself ever loses every requested
    // name; keep it as a loud, explicit second line of defense.
    selectedScreens = SCREENS.filter((screen) =>
      requestedScreens.includes(screen.name),
    );
    if (selectedScreens.length === 0) {
      throw new Error(
        `STATION_E2E_SCREENS matched zero screens (requested: ${requestedScreens.join(', ')}).`,
      );
    }
  }

  // Keep the gallery's timeout proportional to its declared coverage instead
  // of raising the shared Playwright default used by smaller specs: 7 s a
  // screen, the run's bounded second captures, and an investigation's settle
  // window when one is set (0 by default).
  const settleWindowMs = readSettleWindow(process.env);
  test.setTimeout(
    Math.max(
      90_000,
      selectedScreens.length * (7_000 + settleWindowMs) +
        MAX_SECOND_CAPTURES * (7_000 + settleWindowMs),
    ),
  );

  // Test-only; refused on GitHub Actions and on a full capture (see
  // readGalleryFaults).
  const faults = readGalleryFaults(
    process.env,
    requestedScreens,
    SCREENS.map((screen) => screen.name),
  );
  if (faults.length > 0)
    console.log(
      `Gallery fault injection is ACTIVE for this targeted capture: ${JSON.stringify(faults)}`,
    );

  mkdirSync(join(GALLERY_DIR, GALLERY_DIAGNOSTICS), { recursive: true });
  const checkoutStart = readGalleryCheckout();
  // Every declared screen gets its own bucket, even in a targeted capture.
  assertGalleryAssetScopeCapacity(SCREENS.length);
  const origin = new URL(
    process.env.PW_BASE_URL ?? test.info().project.use.baseURL ?? '',
  ).origin;
  const documents = createDocumentTracker();
  const assets = createGalleryAssetDiagnostics(
    origin,
    selectedScreens.map((screen) => screen.name),
    Date.now,
    documents,
  );
  const failedRequests = createFailedRequestLog(origin, documents);
  const stopObserving = observeGalleryRequests(page, {
    documents,
    failedRequests,
    assets,
  });
  const secondCaptures: SecondCaptureRecord[] = [];
  // The attempt the fault injection acts on, and the photo it may wait for.
  let faultAttempt: {
    screen: string;
    attempt: number;
    screenshotWritten: Promise<void>;
    release: () => void;
  } | null = null;
  const faultsFired: Array<{
    screen: string;
    attempt: number;
    kind: GalleryFault['kind'];
    path?: string;
  }> = [];
  const chunkFaults = faults.filter(
    (fault): fault is Extract<GalleryFault, { kind: 'chunk' }> =>
      fault.kind === 'chunk',
  );
  // Test-only: a worker-cached chunk would never reach the network, and a
  // poisoned one must not outlive its screen.
  const evictFaultedChunks = () =>
    page
      .evaluate(
        async (chunks) => {
          if (typeof caches === 'undefined') return;
          for (const name of await caches.keys()) {
            const cache = await caches.open(name);
            for (const request of await cache.keys()) {
              const { pathname } = new URL(request.url);
              if (
                chunks.some((chunk) => pathname.startsWith(`/assets/${chunk}-`))
              )
                await cache.delete(request);
            }
          }
        },
        chunkFaults.map((fault) => fault.chunk),
      )
      .catch(() => {});
  if (chunkFaults.length > 0)
    // The context, not the page: chunks are served through the app's service
    // worker, whose own fetches page.route never sees.
    await page.context().route(
      (url) =>
        chunkFaults.some((fault) => isChunkPath(url.pathname, fault.chunk)),
      async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const active = faultAttempt;
        const fault = chunkFaults.find(
          (candidate) =>
            active !== null &&
            candidate.screen === active.screen &&
            candidate.attempts.includes(active.attempt) &&
            isChunkPath(pathname, candidate.chunk),
        );
        // Every request for the chunk in the attempt: a route chunk is also
        // preloaded, and failing only the first left the import to succeed.
        if (!active || !fault) return route.fallback();
        if (fault.when === 'after-screenshot') await active.screenshotWritten;
        faultsFired.push({
          screen: active.screen,
          attempt: active.attempt,
          kind: fault.kind,
          path: pathname,
        });
        if (fault.mode === 'not-found') return route.fulfill({ status: 404 });
        if (fault.mode === 'poison')
          return route.fulfill({
            status: 200,
            contentType: 'text/javascript',
            body: 'throw new Error("Gallery fault injection: a chunk that throws when evaluated");',
          });
        await route.abort('aborted');
      },
    );
  const emittedBefore = process.env.STATION_E2E_UI_DIR
    ? inventoryGalleryAssets(process.env.STATION_E2E_UI_DIR)
    : null;
  let assetDiagnosticsRetention = 'NOT_ATTEMPTED';
  let assetDiagnosticsBudget: object | null = null;
  const capturedAt = new Date().toISOString();
  const shots: Shot[] = [];

  // station#531: HeaderActions' gallery-wide connection posture is a healthy,
  // connected Station at rest. Register the saved identity and both probe
  // responses once before any navigation: all three are page-lifetime inputs,
  // and together they pin every rendered substring to
  // "Connected · Station E2E" (the browser gallery never renders the
  // desktop-only "App only" qualifier). The screen-scoped identity-mismatch
  // banner fixture intentionally overrides only the handshake while that one
  // named screen is active, then unregisters itself via `withRoute`.
  await seedGalleryConnectionProfile(page);
  // Each navigation starts with the same device placement. Closing a lazy
  // Activity pane after mount races its restoration from the previous shot.
  // Intentional region scenarios still open their surface through the URL.
  await page.addInitScript(() => {
    const key = 'station-device-settings-v1';
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const envelope = JSON.parse(raw);
    if (envelope.values) delete envelope.values.regionArrangement;
    localStorage.setItem(key, JSON.stringify(envelope));
  });
  // Each navigation also starts with no persisted query cache. Since #2278
  // every verified authority restores its whitelisted queries (`projects`
  // among them) from IndexedDB with `refetchOnMount: false` and a 5-minute
  // `staleTime`, so a screen inherits whatever an EARLIER screen's real
  // backend returned and never issues the request its own `page.route`
  // fixture answers. That is what emptied the project switcher on
  // `overlay-dock-project-bound`, `overlay-dock-project-mismatch` and
  // `overlay-project-switcher-populated`: they passed alone and failed after
  // `home`. Which earlier writes had flushed is also timing-dependent (the
  // persister throttles), so the restored state was not even stable run to
  // run. Deleting the database here is ordered, not raced: an `open` for the
  // same name waits for a pending `deleteDatabase` to finish, so the app's
  // first read always sees an empty store. The name mirrors
  // `IDB_DATABASE_NAME` in `src-ui/src/lib/queryPersistence.ts`.
  await page.addInitScript(() => {
    if (typeof indexedDB !== 'undefined')
      indexedDB.deleteDatabase('station-query-cache');
  });
  await page.route('**/.well-known/station/v1', (route) =>
    fulfillGalleryStationHandshake(route),
  );
  await page.route('**/api/system/identity', fulfillGalleryStationIdentity);
  await page.route('**/api/system/status', fulfillGallerySystemStatus);
  await page.route('**/api/tool-library/access', fulfillGalleryToolAccess);

  // station#531: a fresh temp-home seeds this same built-in vector connection,
  // but gives it `<run-specific-home>/vectordb`. Seed the established
  // `/data/lancedb` E2E fixture once for the page lifetime so Knowledge keeps
  // the real editable product field visible with stable bytes on every run.
  await page.route('**/api/connections', fulfillGalleryConnectionsFixture);

  // archive#4464: freeze the host's live CPU/resource-posture reading.
  // The developer System tab polls `GET /api/system/resource-posture`
  // every 15s and renders a real, chrome-wide "host is busy/at capacity"
  // banner (App.tsx's lazy boundary — present on every route) whenever THIS
  // machine is genuinely under load, which two Playwright+Station runs back
  // to back reliably produce. That real host signal, not either volatile
  // chrome region above, turned out to be the DOMINANT source of
  // cross-run pixel noise measured during this feature's own development:
  // it shifts every route's layout down by however tall the banner is, at
  // whatever moment THIS run happens to sample a busy host — never the same
  // moment twice. Registered once, before any navigation: Playwright route
  // handlers persist across `page.goto()` for the page's lifetime, so this
  // single mock covers every screen captured below.
  await page.route('**/api/system/resource-posture', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          kind: 'healthy',
          busyPercent: 0,
          cpuCount: 8,
          sampledAt: null,
          sampleMs: null,
          thresholdPercent: 90,
          source: 'screenshot-gallery-fixture',
        },
      },
    }),
  );
  // archive#4464: `ProjectSidebar` (chrome-wide) calls
  // `useOrchestrationSessionsQuery` unconditionally for its own "open
  // chats" derivation, and `SessionsView`/`sidebar` both render a
  // `.skeleton` list until it resolves. On a freshly booted `--temp-home`
  // server this is a genuinely live query with variable latency — under
  // host load, `sessions-filtered-empty` measured it exceeding the
  // universal skeleton-clear wait outright. A fresh temp-home has no real
  // sessions to show regardless, so seed the deterministic (and, for a
  // brand-new install, ACCURATE) empty answer everywhere rather than only
  // on the two screens that visibly depend on it.
  await page.route('**/api/orchestration/sessions/read-model', (route) =>
    route.fulfill({ json: { success: true, data: [] } }),
  );
  // archive#4464: `ActionOperationsSection` (Activity page's right pane)
  // renders "Connecting to operation status…" while `useActionOperationsQuery`
  // is loading and only settles to "Nothing has run yet" once that live
  // poll resolves — the same live-query race as the sessions list above,
  // just a second endpoint.
  await page.route('**/api/action-operations*', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: { schemaVersion: 'station.action-operation/v1', items: [] },
      },
    }),
  );
  // archive#4464: the Connections hub's "Engines" tab badge
  // (connection-section-signals.ts) is the one count in that tab row that
  // isn't already deterministically 0/empty on a fresh temp-home — CLI/agent
  // engine detection resolves asynchronously, and the badge visibly hadn't
  // converged the same way twice, reflowing every tab to its right
  // (Tools/Knowledge/Computers) and cascading into a large diff across
  // every Connections-hub screen even though nothing on those tabs changed.
  await page.route('**/api/connections/agents', (route) =>
    route.fulfill({ json: { success: true, data: [] } }),
  );
  // archive#4464-class determinism guard:
  // `CoreUpdateLaunchCheck` (App.tsx, mounted chrome-wide via `LazyBoundary`
  // on every route) fires `useCoreUpdateStatusQuery` on first render, which
  // hits `GET /api/system/core-update` — a server route
  // (system-update-routes.ts) that runs a REAL `git fetch` against this
  // checkout's actual `origin` remote and reports how many commits behind
  // HEAD is. Left unmocked, this is genuinely live: a real network call
  // whose outcome depends on this host's git state and on whatever lands on
  // the real remote between two runs, racing the universal settle wait like
  // every other unmocked global query this suite already guards against
  // (resource-posture, sessions read-model, action-operations,
  // connections/agents above). Measured unmocked, it flips a chrome-wide
  // "Station update
  // available" banner on/off across two consecutive runs of the IDENTICAL
  // build, reflowing everything below it and disagreeing on up to ~34% of
  // pixels on 12 of 37 screens (agent-editor, agents, command-palette-empty,
  // connections-models, developer-telemetry, mobile-agents,
  // motion-reduced-mobile-chat, motion-reduced-schedule-loading, plugins,
  // profile, review, sessions) — not rendering jitter, the dominant source
  // of this suite's non-determinism. Seed a fixed, deterministic "up to
  // date" answer so the banner never appears in the gallery at all.
  await routeCoreUpdateCheck(page, (route) =>
    route.fulfill({
      json: {
        installKind: 'source-checkout',
        applyMethod: 'git-pull',
        currentHash: 'gallery0',
        remoteHash: 'gallery0',
        branch: 'main',
        behind: 0,
        ahead: 0,
        updateAvailable: false,
      },
    }),
  );

  // The screen being captured's diagnostics, set by its attempts' ports and
  // read when its result is recorded.
  let layout: Shot['layout'];
  let rasterDiagnostic: Shot['rasterDiagnostic'];
  let uiAudit: Shot['uiAudit'];
  const screenFault = (
    screen: Screen,
    kind: GalleryFault['kind'],
    attempt: number,
  ) =>
    faults.find(
      (fault) =>
        fault.screen === screen.name &&
        fault.kind === kind &&
        fault.attempts.includes(attempt),
    );
  try {
    // gallery-screen-attempt.ts owns the loop over screens, the run's
    // second-capture budget, the order of the error-surface checks and the
    // retry rule. Every attempt is a fresh navigation on the same instance;
    // `beforeGoto` and `cleanup` run for each.
    await captureScreens(page, selectedScreens, {
      failedRequests,
      screenStarted: (screen) => assets.screen(screen.name),
      screenFinished: (screen) => assets.screenFinished(screen.name),
      ports: (screen, attempt) => {
        const file = `${screen.name}.png`;
        browserErrors.length = 0;
        layout = undefined;
        rasterDiagnostic = undefined;
        uiAudit = undefined;
        let release = () => {};
        const screenshotWritten = new Promise<void>((resolve) => {
          release = resolve;
        });
        faultAttempt = {
          screen: screen.name,
          attempt,
          screenshotWritten,
          release,
        };
        const faulted = chunkFaults.some(
          (fault) => fault.screen === screen.name,
        );
        return {
          capture: async (photo) => {
            if (faulted) await evictFaultedChunks();
            await page.setViewportSize(screen.viewport);
            await page.emulateMedia({
              reducedMotion: screen.reducedMotion ? 'reduce' : 'no-preference',
            });
            if (screen.beforeGoto) {
              await screen.beforeGoto(page);
            }
            // Delivery is live-only. Observe this document's general-event stream
            // before navigation so the POST cannot beat its subscription.
            const notificationStream = [
              'motion-reduced-notification',
              'overlay-toast',
              'overlay-toast-action',
            ].includes(screen.name)
              ? page.waitForResponse(
                  (response) => {
                    const url = new URL(response.url());
                    return (
                      response.status() === 200 &&
                      (url.pathname === '/events' ||
                        (url.pathname === '/api/orchestration/events' &&
                          url.searchParams.get('includeGeneral') === '1'))
                    );
                  },
                  { timeout: 10_000 },
                )
              : null;
            // #1650: the ORDER of everything below lives in
            // `runScreenshotCaptureSequence` so it is a unit a test can execute —
            // a passing gallery run compares pixels and can never report a step
            // having moved to the wrong side of another one. Each step's own
            // reason stays here, next to the mechanic it performs. The web-font
            // settle is the one step that module performs itself, against the page
            // passed here, so the STEP MAP cannot wire in a settle that reads
            // nothing. That the object passed here is the real page is checked by
            // `typecheck:e2e` (the structural assignment on this line) and by
            // reading the diff, like the other six steps.
            await runScreenshotCaptureSequence(page, {
              reachScreen: async () => {
                await gotoAppShell(page, screen.path);
                // Route-only captures must not inherit a drawer opened by an
                // earlier scenario. Surface stress cases opt in through their URL.
                const requestedState = new URL(
                  screen.path,
                  'http://gallery.invalid',
                );
                if (requestedState.searchParams.get('surface') !== 'activity') {
                  const hideActivity = page.getByRole('button', {
                    name: 'Hide Activity',
                    exact: true,
                  });
                  if (await hideActivity.count()) await hideActivity.click();
                }
                if (requestedState.searchParams.get('dock') !== 'open') {
                  const collapseChat = page.getByRole('button', {
                    name: 'Collapse chat',
                    exact: true,
                  });
                  if (await collapseChat.count()) await collapseChat.click();
                }
                if (screen.waitFor) {
                  await page.waitForSelector(screen.waitFor, {
                    timeout: 10_000,
                  });
                }
                // Let async panels settle so the shot reflects loaded data.
                await page.waitForTimeout(1200);
              },
              assertNoLoadingSkeleton: screen.expectSkeleton
                ? null
                : () => assertNoLoadingSkeleton(page),
              // Called as a method on `screen`, not as a bare extracted function:
              // no declared hook uses `this` today, and this keeps that from being
              // a precondition of the refactor rather than a property of the file.
              afterGoto: screen.afterGoto
                ? async () => {
                    await notificationStream;
                    await screen.afterGoto?.(page);
                  }
                : null,
              // The identity-mismatch tile deliberately overrides the global
              // healthy handshake and waits for its own deterministic blocked
              // state. Every other screen must prove the gallery-wide route has
              // reached the fixed healthy posture before capture rather than
              // racing the opening probe.
              assertConnectionChrome:
                screen.name === 'overlay-connection-banner'
                  ? null
                  : () => assertGalleryConnectionChrome(page),
              hideVolatileChrome: () => hideVolatileChrome(page),
              screenshot: async () => {
                if (screenFault(screen, 'fail-step', attempt))
                  throw new Error(
                    'Gallery fault injection: an ordinary capture-step failure (fail-step).',
                  );
                // Lazy brand marks can settle after the data skeleton disappears.
                // A pending or failed mark is an incomplete reference image.
                await expect(
                  page.locator('.brand-icon[data-brand-key]').filter({
                    hasNot: page.locator('svg, img, .brand-icon__glyph'),
                  }),
                ).toHaveCount(0, { timeout: 15_000 });
                if (screen.name === 'settings-info-tip') {
                  layout = await page.evaluate(() => {
                    const main =
                      document.querySelector<HTMLElement>('.app__main');
                    if (!main)
                      throw new Error('Gallery app main column is missing');
                    return {
                      appMainScrollTop: main.scrollTop,
                      appMainScrollHeight: main.scrollHeight,
                      appMainClientHeight: main.clientHeight,
                      documentScrollY: window.scrollY,
                    };
                  });
                }
                if (screen.name !== 'settings-info-tip') {
                  await page.mouse.move(0, 0);
                }
                if (screen.captureTheme) {
                  await page.evaluate(
                    (theme) =>
                      document.documentElement.setAttribute(
                        'data-theme',
                        theme,
                      ),
                    screen.captureTheme,
                  );
                  await expect(page.locator('html')).toHaveAttribute(
                    'data-theme',
                    screen.captureTheme,
                  );
                }
                await photo();
                if (screen.name === 'overlay-dock-project-mismatch') {
                  const before = await statusRasterState(page);
                  const retiredCount = await page
                    .getByRole('button', {
                      name: 'Status unavailable — resync this conversation',
                      exact: true,
                    })
                    .locator('..')
                    .evaluate((host) => {
                      const finished = host
                        .getAnimations({ subtree: true })
                        .filter((animation) => {
                          const timing = animation.effect?.getComputedTiming();
                          return (
                            animation.playState === 'finished' &&
                            timing?.iterations !== Infinity &&
                            (timing?.fill === 'both' ||
                              timing?.fill === 'forwards')
                          );
                        });
                      for (const animation of finished) animation.cancel();
                      return finished.length;
                    });
                  await page.evaluate(
                    () =>
                      new Promise<void>((resolveFrame) =>
                        requestAnimationFrame(() =>
                          requestAnimationFrame(() => resolveFrame()),
                        ),
                      ),
                  );
                  const after = await statusRasterState(page);
                  const diagnosticFile = `${GALLERY_DIAGNOSTICS}/${screen.name}.retired-effects-diagnostic.png`;
                  await page.screenshot({
                    path: join(GALLERY_DIR, diagnosticFile),
                    fullPage: true,
                    animations: 'disabled',
                  });
                  rasterDiagnostic = {
                    before,
                    after,
                    retiredCount,
                    file: diagnosticFile,
                    sha256: createHash('sha256')
                      .update(readFileSync(join(GALLERY_DIR, diagnosticFile)))
                      .digest('hex'),
                  };
                }
              },
            });
          },
          readSurfaces: async () =>
            (await page.evaluate(
              READ_APP_ERROR_SURFACES,
            )) as AppErrorSurfaceCounts,
          screenshot: async () => {
            await page.screenshot({
              path: join(GALLERY_DIR, file),
              fullPage: true,
              // archive#4464: freeze CSS animations/transitions at their end
              // state instead of racing them — `reducedMotion` above only sets
              // the OS media-query preference, it does not itself stop an
              // in-flight transition from being mid-frame at capture time.
              animations: 'disabled',
            });
            faultAttempt?.release();
            const move = screenFault(screen, 'move-after-photo', attempt);
            if (move && move.kind === 'move-after-photo')
              await page.evaluate((delayMs) => {
                setTimeout(() => {
                  const block = document.createElement('div');
                  block.style.height = '80px';
                  document.querySelector('.app')?.before(block);
                }, delayMs);
              }, move.delayMs);
          },
          readControls: () => readVisibleControls(page),
          // Audit the photographed state, before any post-shot interaction.
          audit: async () => {
            try {
              uiAudit = await auditGalleryScreen(page, screen.name);
            } catch (error) {
              uiAudit = {
                error: error instanceof Error ? error.message : String(error),
              };
            }
            return uiAudit;
          },
          // Capture whatever rendered so the broken state is still inspectable.
          fallbackScreenshot: async () => {
            await hideVolatileChrome(page);
            await page.screenshot({
              path: join(GALLERY_DIR, file),
              animations: 'disabled',
            });
          },
          cleanup: async () => {
            faultAttempt?.release();
            faultAttempt = null;
            try {
              await screen.cleanup?.();
            } finally {
              if (faulted) await evictFaultedChunks();
            }
            if (screenFault(screen, 'fail-cleanup', attempt))
              throw new Error(
                'Gallery fault injection: the screen cleanup threw (fail-cleanup).',
              );
          },
          now: () => performance.now(),
          wait: (ms) => page.waitForTimeout(ms),
          settleWindowMs,
          evidence: () => {
            const { records, omitted } = failedRequests.snapshot();
            return {
              failedRequests: records,
              omitted,
              consoleErrors: [...browserErrors],
            };
          },
        };
      },
      keepFirstImage: (screen) => {
        try {
          mkdirSync(join(GALLERY_DIR, 'transients'), { recursive: true });
          const kept = `transients/${screen.name}.attempt-1.png`;
          copyFileSync(
            join(GALLERY_DIR, `${screen.name}.png`),
            join(GALLERY_DIR, kept),
          );
          return kept;
        } catch {
          return null;
        }
      },
      log: (line) => process.stdout.write(`${line}\n`),
      screenCaptured: (screen, result) => {
        const file = `${screen.name}.png`;
        if (result.record) secondCaptures.push(result.record);
        const { final } = result;
        const shot: Shot = final.ok
          ? {
              screen,
              file,
              ok: true,
              browserErrors: browserErrors.length
                ? [...browserErrors]
                : undefined,
              controls: final.atPhoto.map(({ label, disabled }) => ({
                label,
                disabled,
              })),
              layout,
              rasterDiagnostic,
              uiAudit: final.audit,
              controlsAfterPhoto: final.controlsAfterPhoto,
              controlMovement: final.controlMovement,
              sha256: createHash('sha256')
                .update(readFileSync(join(GALLERY_DIR, file)))
                .digest('hex'),
            }
          : {
              screen,
              file,
              // An app error surface leads with its identity, not the layout
              // findings of its error row (#5028).
              ...failedScreenFields(result, browserErrors),
            };
        shot.attempts = result.attempts;
        shots.push(shot);
      },
    });
  } finally {
    stopObserving();
    try {
      const network = await assets.finish();
      const checkoutEnd = readGalleryCheckout();
      const lifecycle = process.env.STATION_E2E_OUTPUT_DIR
        ? readGalleryLifecycle(
            join(
              dirname(process.env.STATION_E2E_OUTPUT_DIR),
              'lifecycle.ndjson',
            ),
          )
        : { incomplete: true, events: [] };
      const result = retainGalleryAssetDiagnostics(
        join(GALLERY_DIR, GALLERY_DIAGNOSTICS),
        network,
        emittedBefore,
        process.env.STATION_E2E_UI_DIR
          ? inventoryGalleryAssets(process.env.STATION_E2E_UI_DIR)
          : null,
        {
          complete:
            checkoutStart.complete &&
            checkoutEnd.complete &&
            checkoutStart.sha === checkoutEnd.sha &&
            checkoutStart.tree === checkoutEnd.tree &&
            !lifecycle.incomplete,
          checkoutStart,
          checkoutEnd,
          workflowEventSha: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '')
            ? process.env.GITHUB_SHA
            : null,
          selectedScreens: selectedScreens.map((screen) => screen.name),
          nodeVersion: process.version,
          lifecycle,
          uiProcessLifecycle: 'UNKNOWN',
        },
      );
      assetDiagnosticsRetention = result.retention;
      assetDiagnosticsBudget = result;
    } catch {
      assetDiagnosticsRetention = 'INCOMPLETE';
      console.error(
        'Gallery asset diagnostics incomplete: metadata retention failed.',
      );
    }
    // Written in a finally so an abort mid-loop still (best-effort — a hard
    // worker kill can outrun it) leaves the partial gallery and capture.json
    // behind: losing every screen's evidence because one screen was slow
    // inverts what this suite is for. Both artifacts carry the expected
    // total, so a partial run reads as "12/29", never as a complete "12/12".
    writeFileSync(
      join(GALLERY_DIR, 'index.html'),
      renderIndex(shots, capturedAt),
    );
    writeFileSync(
      join(GALLERY_DIR, 'capture.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runId: process.env.STATION_E2E_RUN_ID ?? null,
          capturedAt,
          assetDiagnosticsRetention,
          assetDiagnosticsBudget,
          expected: SCREENS.length,
          // `null` marks a full run over every declared SCREENS entry; a
          // requested-name array marks a targeted run so downstream tooling
          // (scripts/screenshot-diff.mjs) can never mistake a partial
          // gallery for full coverage.
          selection: requestedScreens,
          // Every screen whose first attempt ended on an app error surface,
          // and how its single second capture went; `second: "passed"` is a
          // transient. Counted, never hidden.
          secondCaptures,
          // Only when an investigation widened the control record's window.
          ...(settleWindowMs > 0 ? { settleWindowMs } : {}),
          faultInjection:
            faults.length > 0 ? { faults, fired: faultsFired } : null,
          screens: shots.map(
            ({
              file,
              ok,
              screen,
              error,
              browserErrors,
              sha256,
              controls,
              layout,
              rasterDiagnostic,
              uiAudit,
              attempts,
              appError,
              controlsAfterPhoto,
              controlMovement,
            }) => ({
              file,
              ok,
              name: screen.name,
              viewport: screen.viewport,
              error: error ?? null,
              browserErrors,
              sha256,
              controls,
              layout,
              rasterDiagnostic,
              uiAudit,
              attempts: attempts ?? 1,
              appError,
              controlsAfterPhoto,
              controlMovement,
            }),
          ),
        },
        null,
        2,
      )}\n`,
    );
    for (const line of formatControlChangeTable(
      shots.map(({ screen, controlsAfterPhoto, controlMovement }) => ({
        name: screen.name,
        controlsAfterPhoto,
        controlMovement,
      })),
      settleWindowMs,
    ))
      console.log(line);
    if (secondCaptures.length > 0) {
      const count = (second: SecondCaptureRecord['second']) =>
        secondCaptures.filter((record) => record.second === second).length;
      console.log(
        `Gallery app error surfaces with a failed chunk request: ${secondCaptures.length} screen(s); ${count('passed')} passed a second capture (transient), ${secondCaptures.length - count('passed') - count('budget-exhausted')} failed it, ${count('budget-exhausted')} not captured again (budget of ${MAX_SECOND_CAPTURES}).`,
      );
    }
  }

  const failedReasons = failedShotReasons(shots);
  for (const reason of failedReasons) console.log(reason);
  const ok = shots.filter((shot) => shot.ok).length;
  expect(
    ok,
    `every selected gallery screen should render; failed: ${failedReasons.join('; ') || 'none recorded'}`,
  ).toBe(selectedScreens.length);
  if (
    selectedScreens.some(
      (screen) => screen.name === 'overlay-dock-project-mismatch',
    )
  ) {
    const diagnostic = shots.find(
      (shot) => shot.screen.name === 'overlay-dock-project-mismatch',
    )?.rasterDiagnostic;
    expect(
      diagnostic,
      'settled status motion should be observed',
    ).toBeDefined();
    expect(
      diagnostic?.retiredCount,
      'completed status entry/morph effects must release their fill',
    ).toBe(0);
    const body = diagnostic?.before.ancestors.find(
      (ancestor) => ancestor.className === 'chat-status-pill__body',
    );
    expect(body?.transform).toBe('none');
    expect(body?.opacity).toBe('1');
  }
});
