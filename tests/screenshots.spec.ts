import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, type Page, type Route, test } from '@playwright/test';

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

function fulfillGalleryStationHandshake(route: Route): Promise<void> {
  return route.fulfill({
    json: {
      schemaVersion: 1,
      environmentId: GALLERY_ENVIRONMENT_ID,
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
    },
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
 * #1536 F: the gallery seeds exactly ONE Station and reaches it, which is the
 * state whose chip collapsed to its status dot — a fact that does not change
 * while you work, in the row that runs out of width first. So the state and the
 * identity are no longer visible text HERE; they are the accessible name and
 * the tooltip, which is the only channel a dot leaves for the identity.
 *
 * Both are asserted, not just one: the name is what the product's own E2E
 * selectors key on (`/^Manage Stations/`), and the title is what a pointer user
 * can actually read. A chip that dropped either would still pass a class check.
 */
async function assertGalleryConnectionChrome(page: Page): Promise<void> {
  const chip = page.getByTestId('app-toolbar-connection');
  await expect(chip).toHaveClass(/app-toolbar__conn--connected/, {
    timeout: 10_000,
  });
  await expect(chip).toHaveClass(/app-toolbar__conn--compact/);
  const named = `Manage Stations — Connected · ${GALLERY_CONNECTION_NAME}`;
  await expect(chip).toHaveAttribute('aria-label', named);
  await expect(chip).toHaveAttribute('title', named);
  // Collapsed means collapsed: neither text span renders, which is the width
  // this change reclaims.
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

/**
 * Hides always-visible chrome/widget regions whose content is genuinely
 * environment/timing-dependent rather than a property of the page under
 * test, so re-capturing the identical build never perturbs the gallery
 * pixel-for-pixel (archive#4464):
 *
 *  - `.sidebar__status-version` (ProjectSidebarStatus.tsx, via
 *    `buildLabel` in src-ui/src/build-info.ts): the `v<version> ·
 *    <commit>` build stamp rendered in the persistent project sidebar on
 *    every route. Comparing it pixel-for-pixel would invalidate a
 *    committed baseline on every version/commit bump even when nothing
 *    about the screen itself changed.
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
 *    relative "just now" — the one remaining live-clock-derived label this
 *    gallery ever renders a toast for
 *    (`motion-reduced-notification`).
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
 * every tile. The build-stamp label's text is fixed per build (no live state
 * to vary its width), so `visibility: hidden` preserves the sidebar footer's
 * row height exactly as authored.
 *
 * Must be called AFTER `page.goto` (a fresh navigation drops any
 * previously injected style tag) and as close to the shot as practical.
 */
async function hideVolatileChrome(page: Page) {
  await page.addStyleTag({
    content: `
      .sidebar__status-version { visibility: hidden !important; }
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

/**
 * `BannerHost.tsx` measures its own rendered stack height and writes it as
 * `--banner-stack-height` on `.app__main`, which `.main-content`'s
 * `padding-top` (a CSS transition, `BannerHost.css`) reads — the mechanism
 * that reserves layout space for the banner instead of overlaying content.
 * None of this suite's other screens ever expand a banner's disclosure
 * (`overlay-connection-banner`'s "Details" toggle is the first), and doing
 * so races that measure-then-transition pipeline: two otherwise-identical
 * captures disagreed by exactly the reserved-space delta below the banner
 * (confirmed live — the banner card itself, and everything inside it,
 * matched byte-for-byte both times; only the page content's top offset
 * moved). `animations: 'disabled'` on the eventual screenshot call
 * fast-forwards an IN-FLIGHT transition to its end value, but it can't fix
 * a `padding-top` that is still transitioning TOWARD a stale measurement
 * taken before the disclosure content settled. Poll the resolved
 * `padding-top` until it reads the same value across several spaced
 * samples, so the shot only ever happens once that pipeline has actually
 * converged, regardless of how many frames it took this run.
 */
async function waitForStableLayout(
  page: Page,
  selector = '.main-content',
  timeoutMs = 10_000,
) {
  const start = Date.now();
  let last: string | null = null;
  let stableReads = 0;
  while (Date.now() - start < timeoutMs) {
    const current = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).paddingTop : null;
    }, selector);
    if (current !== null && current === last) {
      stableReads += 1;
      if (stableReads >= 3) return;
    } else {
      stableReads = 0;
    }
    last = current;
    await page.waitForTimeout(150);
  }
  throw new Error(
    `waitForStableLayout: '${selector}' padding-top never settled within ${timeoutMs}ms (last read: ${last}).`,
  );
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
 * The Connections hub's shared tab bar (`ConnectionSectionFrame` via
 * `useConnectionSectionSignals`) renders a live count badge on every tab,
 * including Tools (`useIntegrationsQuery`, `GET /integrations`), Knowledge
 * (`useGlobalKnowledgeStatusQuery`, `GET /api/knowledge/status`), and
 * Computers (`useComputerRows` -> `useSshEnvironmentsQuery`,
 * `GET /api/environments/ssh`). None of the three is mocked (unlike
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
  const sshEnvironmentsSettled = page
    .waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname.endsWith('/api/environments/ssh'),
      { timeout: 15_000 },
    )
    .catch(() => {
      console.warn(
        '[screenshots.spec] armConnectionsHubBadgeSettle: no GET */api/environments/ssh ' +
          'response observed within 15s — the badge-settle guard did not fire ' +
          '(endpoint renamed/moved?). Proceeding without it.',
      );
      return undefined;
    });
  return async () => {
    await Promise.all([
      integrationsSettled,
      knowledgeStatusSettled,
      sshEnvironmentsSettled,
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
async function fulfillSessionsFilteredEmptyFixture(
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
          actionLabel: 'Open Connections',
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
  },
) {
  return page.addInitScript((entry) => {
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
 * in `afterGoto`'s `finally`, or its fixture — a project list, a durable
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

type GalleryProjectFixture = {
  slug: string;
  name: string;
  workingDirectory?: string;
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
          hasWorkingDirectory: Boolean(project.workingDirectory),
          workingDirectory: project.workingDirectory,
          layoutCount: 0,
          hasKnowledge: false,
          agents: [],
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      },
    });
}

/**
 * `overlay-dock-project-mismatch`'s hooks, factored out (matching
 * `connectionsHubBadgeSettleHooks()`'s established shape above) because
 * every route registered in `beforeGoto` (needed BEFORE `page.goto` — these
 * queries fire on first render) must be unregistered again in `afterGoto`,
 * and a plain object literal's two callbacks cannot share the `withRoute`
 * cleanup closures any other way.
 */
function overlayDockProjectMismatchHooks(): Pick<
  Screen,
  'beforeGoto' | 'afterGoto'
> {
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
          '**/api/projects/project-b',
          projectDetailFixture({
            slug: 'project-b',
            name: 'Project B',
            workingDirectory: '/repos/project-b',
          }),
        ),
      ];
    },
    afterGoto: async (page) => {
      try {
        await assertNoStrayProjectModal(page);
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
        // The active session (project-b) renders first with no binding
        // bound yet — badge reads "No project" (archive#4525: the badge no
        // longer follows the active session at all). Binding to Project A
        // through the real picker interaction is what produces the
        // mismatch, exactly as a user reaching this state would.
        const badge = page.locator('.chat-dock__project-badge');
        await expect(badge).toHaveText('No project', { timeout: 10_000 });
        await badge.click();
        await expect(
          page.getByRole('dialog', { name: 'Switch project' }),
        ).toBeVisible({ timeout: 10_000 });
        await page.getByRole('button', { name: 'Switch to Project A' }).click();
        await expect(
          page.getByRole('dialog', { name: 'Switch project' }),
        ).toBeHidden({ timeout: 10_000 });
        // The badge now names the BOUND project (by design it never
        // follows the active session) — while the facts
        // row leads with the session's own, muted, differing project name.
        // Scoped to the badge's own class: the project sidebar (seeded
        // from the same `/api/projects` mock) also renders a same-named
        // button.
        await expect(
          page.locator('.chat-dock__project-badge', { hasText: 'Project A' }),
        ).toBeVisible({ timeout: 10_000 });
        await expect(
          page.locator('.chat-dock__project-session-name'),
        ).toBeVisible({ timeout: 10_000 });
      } finally {
        // See `withRoute`'s doc comment: every route registered above must
        // be unregistered again, or its fixture leaks into every screen
        // captured after this one for the rest of the run.
        for (const cleanup of cleanups) await cleanup();
      }
    },
  };
}

/**
 * Shared `beforeGoto`/`afterGoto` shape for a screen whose ONLY dock-gallery
 * fixture is a seeded `/api/projects` list (both `overlay-dock-project-bound`
 * and `overlay-project-switcher-populated`) — clears storage, registers the
 * list, runs the caller's own assertions, then unregisters it (see
 * `withRoute`'s doc comment for why that last step matters).
 */
function withGalleryProjectsList(
  projects: GalleryProjectFixture[],
  assertions: (page: Page) => Promise<void>,
): Pick<Screen, 'beforeGoto' | 'afterGoto'> {
  let cleanup: (() => Promise<void>) | null = null;
  return {
    beforeGoto: async (page) => {
      await clearDockGalleryStorage(page);
      cleanup = await withRoute(
        page,
        '**/api/projects',
        projectsListFixture(projects),
      );
    },
    afterGoto: async (page) => {
      try {
        await assertions(page);
      } finally {
        await cleanup?.();
      }
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
   * This screen deliberately captures a loading skeleton (@kontourai/ui's
   * `.skeleton`) itself — opt out of the universal
   * `assertNoLoadingSkeleton` wait below.
   */
  expectSkeleton?: boolean;
}

const SCREENS: Screen[] = [
  {
    name: 'home',
    title: 'Home / Coding layout',
    path: '/',
    viewport: DESKTOP,
    afterGoto: (page) => assertNoStrayProjectModal(page),
  },
  { name: 'agents', title: 'Agents', path: '/agents', viewport: DESKTOP },
  {
    name: 'skills',
    title: 'Guidance — Skills',
    path: '/guidance?tab=skills',
    viewport: DESKTOP,
  },
  { name: 'registry', title: 'Registry', path: '/registry', viewport: DESKTOP },
  {
    name: 'connections',
    title: 'Connections',
    path: '/connections',
    viewport: DESKTOP,
    ...connectionsHubBadgeSettleHooks(),
  },
  {
    name: 'connections-models',
    title: 'Connections — Models',
    path: '/connections/providers',
    viewport: DESKTOP,
    ...connectionsHubBadgeSettleHooks(),
  },
  {
    name: 'connections-agent-apps',
    title: 'Connections — Engines',
    path: '/connections/engines',
    viewport: DESKTOP,
    ...connectionsHubBadgeSettleHooks(),
  },
  {
    name: 'connections-tools',
    title: 'Connections — Tools',
    path: '/connections/tools',
    viewport: DESKTOP,
    ...connectionsHubBadgeSettleHooks(),
  },
  {
    name: 'connections-knowledge',
    title: 'Connections — Knowledge',
    path: '/connections/knowledge',
    viewport: DESKTOP,
    ...connectionsHubBadgeSettleHooks(),
  },
  {
    name: 'review',
    title: 'Review',
    path: '/review-queue',
    viewport: DESKTOP,
  },
  {
    name: 'sessions',
    title: 'Activity',
    path: '/?surface=activity',
    viewport: DESKTOP,
  },
  { name: 'plugins', title: 'Plugins', path: '/plugins', viewport: DESKTOP },
  (() => {
    let cleanup: () => Promise<void> = async () => {};
    return {
      name: 'schedule',
      title: 'Schedule',
      path: '/schedule',
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
  },
  { name: 'profile', title: 'Profile', path: '/profile', viewport: DESKTOP },
  {
    name: 'settings',
    title: 'Settings',
    path: '/settings',
    viewport: DESKTOP,
  },
  {
    name: 'settings-info-tip',
    title: 'Settings — Approval guardian explanation',
    path: '/settings?view=station-config',
    viewport: DESKTOP,
    afterGoto: async (page) => {
      await page
        .getByRole('button', { name: 'More about Approval guardian' })
        .click();
      const tooltip = page.getByRole('tooltip');
      await expect(tooltip).toBeVisible();
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
    afterGoto: (page) => assertNoStrayProjectModal(page),
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
  {
    name: 'sessions-filtered-empty',
    title: 'Activity — filtered empty',
    path: '/?surface=activity',
    viewport: DESKTOP,
    // archive#4501 ("the honest FilteredEmpty derivation"): `SplitPaneLayout`
    // gained `collectionEmpty` so a typed search over a collection that was
    // ALREADY empty renders the plain `Empty` state, never `FilteredEmpty` —
    // deliberately (SplitPaneLayout.tsx:962-967's own comment: "a typed query
    // over an ALREADY-empty collection is not what emptied it"), so a search
    // can never misattribute "nothing here" to itself, and never offers a
    // "Clear filter" that would fix nothing. `SessionsView.tsx:737` wires
    // `collectionEmpty={projectFiltered.length === 0}`, i.e. the RAW
    // (pre-search) session list. This screen exists to capture the
    // FilteredEmpty branch itself, which is genuinely reachable only when
    // the raw collection is non-empty and the typed search matches none of
    // it — the suite's own global read-model mock (an empty array, a
    // truthful default for a fresh temp-home) can no longer reach it after
    // archive#4501. Override it here with a few real-shaped sessions so
    // `collectionEmpty` is false and "missing-session" filters an actual
    // collection down to zero.
    beforeGoto: async (page) => {
      await page.route(
        '**/api/orchestration/sessions/read-model',
        fulfillSessionsFilteredEmptyFixture,
      );
    },
    afterGoto: async (page) => {
      try {
        await page.getByPlaceholder('Search sessions…').fill('missing-session');
        // The margin here covers the read-model fetch's own latency (>6s
        // wall-clock has been observed under host load — that signal is
        // archive#4466, not something this timeout fixes); a repeat-500
        // still fails loudly via the error branch rather than at this
        // timeout.
        await expect(
          page.getByText('Nothing in sessions matches “missing-session”'),
        ).toBeVisible({ timeout: 15_000 });
        await expect(
          page.getByRole('button', { name: 'Clear filter' }),
        ).toBeVisible();
      } finally {
        // `page.route` handlers persist across `page.goto()` for the
        // page's lifetime (see the resource-posture mock's doc comment in
        // the main test body). `ProjectSidebar` (chrome-wide) reads this
        // SAME endpoint for its own "N open chats" derivation, so leaving
        // this fixture registered would leak 3 phantom open chats into the
        // sidebar of every screen captured after this one in the run.
        // Unregister regardless of whether the assertions above passed —
        // WITH the same handler reference passed to `page.route` above, so
        // this removes only this fixture and leaves the main test body's
        // global empty-array mock for the same URL pattern intact (see
        // `fulfillSessionsFilteredEmptyFixture`'s doc comment: omitting the
        // handler argument here once tore out that global mock too, and
        // every later screen's request fell through to the real, 500ing
        // dev server).
        await page.unroute(
          '**/api/orchestration/sessions/read-model',
          fulfillSessionsFilteredEmptyFixture,
        );
      }
    },
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
      path: '/schedule',
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
      path: '/schedule',
      viewport: DESKTOP,
      reducedMotion: true,
      beforeGoto: async (page) => {
        cleanup = await seedScheduleScreenshotApi(page);
      },
      afterGoto: async (page) => {
        try {
          await page
            .getByRole('button', { name: 'Add job', exact: true })
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
      await page.evaluate(async () => {
        await fetch('/notifications', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source: 'motion-gallery',
            category: 'test',
            title: 'Reduced motion is active',
            body: 'Notification state remains visible without entrance motion.',
            ttl: 15_000,
          }),
        });
      });
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
    name: 'overlay-dock-picker',
    title: 'Overlay — Dock occupant picker menu',
    path: '/?dock=open',
    viewport: DESKTOP,
    afterGoto: async (page) => {
      await assertNoStrayProjectModal(page);
      // DockOccupantPicker's trigger names the current occupant
      // ("Docked pane: Chat") — archive#4484 made DockShell own the chrome
      // for every occupant, so this is present whenever the dock is open
      // and not placed fullscreen (`?dock=open` is neither).
      const trigger = page.getByRole('button', { name: /^Docked pane:/ });
      await trigger.waitFor({ timeout: 10_000 });
      await trigger.click();
      await expect(page.locator('.dock-occupant-menu')).toBeVisible({
        timeout: 10_000,
      });
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
      title: 'Overlay — Connection banner (identity mismatch, expanded)',
      // Deliberately not '/' or '/agents': home's `StarterInspectionCards` /
      // `StarterScheduledCheckCard` widgets, and Agents' "Engines on this
      // machine" list (real host CLI detection — order/count varies between
      // separate server boots; two consecutive captures can disagree
      // well below the banner itself, which matches byte-for-byte
      // both times), are real, live-queried content this screen has no
      // reason to depend on. The banner itself is chrome-wide (mounted
      // regardless of route); Settings is config-driven, not
      // detection-driven, and `?view=overview` + the `.settings__search`
      // wait below are the same route/ready-selector `mobile-settings-overview`
      // already proves stable.
      path: '/settings?view=overview',
      viewport: MOBILE,
      waitFor: '.settings__search',
      beforeGoto: async (page) => {
        // archive#4470's identity-mismatch banner — reachable purely through
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
        // "Connecting from another device?" sentence into the banner's
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
          const banner = page.locator('.banner-host__item').first();
          await expect(banner).toBeVisible({ timeout: 15_000 });
          // archive#4470's expanded surface: reveal the disclosure detail so the
          // banner's full content (message, detail, and the "Pair
          // again"/"Remove" actions) is captured, not just the collapsed
          // one-line summary.
          const details = page.getByRole('button', { name: 'Details' });
          await details.click();
          await expect(details).toHaveAttribute('aria-expanded', 'true');
          await expect(page.locator('.banner-host__detail')).toBeVisible();
          await waitForStableLayout(page);
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
      path: '/schedule',
      viewport: DESKTOP,
      beforeGoto: async (page) => {
        cleanup = await seedScheduleScreenshotApi(page);
      },
      afterGoto: async (page) => {
        try {
          await page
            .getByRole('button', { name: 'Add job', exact: true })
            .click();
          await expect(page.locator('.station-dialog__overlay')).toBeVisible({
            timeout: 10_000,
          });
          await expect(page.locator('.schedule__modal')).toBeVisible();
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
      title: 'Overlay — Destructive confirm (Delete Job)',
      path: '/schedule',
      viewport: DESKTOP,
      beforeGoto: async (page) => {
        cleanups = [
          await seedScheduleScreenshotApi(page),
          // Override the empty-list default with one job so the table (and its
          // per-row Delete action) renders. `lastRun`/`nextRun`/`successRate`
          // are deliberately omitted — each renders live-relative-time text
          // ('never'/'-'/'—') only when present, which is otherwise exactly
          // the kind of two-runs-disagree noise this gallery's own settle
          // guards exist to avoid. The cron's minute/hour are fully specified
          // (no wildcards) so `cronToHuman`'s rendered clock time depends only
          // on those digits, never on the capture's wall-clock moment.
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
            .getByRole('button', { name: 'Delete gallery-demo-job' })
            .click();
          // Deliberately never confirmed: this screen captures the OPEN confirm
          // dialog, not the deletion it would perform.
          await expect(
            page.getByRole('heading', { name: 'Delete Job' }),
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
    title: 'Overlay — Mobile project-switcher sheet',
    path: '/?dock=open',
    viewport: MOBILE,
    afterGoto: async (page) => {
      await assertNoStrayProjectModal(page);
      // archive#793: always rendered (bound project or not — "No project"
      // is a valid, always-reachable switcher state), so this needs no
      // project/session seeding to be deterministic.
      const trigger = page.getByRole('button', { name: /^Switch project/ });
      await trigger.waitFor({ timeout: 10_000 });
      await trigger.click();
      await expect(
        page.locator('.chat-dock__project-switcher-panel'),
      ).toBeVisible({ timeout: 10_000 });
    },
  },
  // archive#4525: no screen in the gallery otherwise stages a BOUND
  // dock project, a session/badge mismatch, or a POPULATED project-switcher
  // row (`overlay-mobile-sheet` above is deliberately empty-state), so
  // those states would be invisible in the build gallery. These
  // three make them visible.
  {
    name: 'overlay-dock-project-bound',
    title: 'Overlay — Chat dock with a bound project',
    path: '/?dock=open',
    viewport: DESKTOP,
    ...withGalleryProjectsList(
      [{ slug: 'demo-project', name: 'Demo Project' }],
      async (page) => {
        await assertNoStrayProjectModal(page);
        // Drives the REAL picker interaction (archive#4524's "Switch to
        // <project>" row) rather than pre-seeding the persisted binding
        // directly — localStorage/sessionStorage seeded via
        // `page.addInitScript` proved unreliable across this gallery's
        // page-long-lived, multi-navigation run (accumulated init scripts
        // across screens raced the app's own project-confirmation effect
        // live). This is both more robust and a stronger proof: it
        // exercises the exact fixed code path
        // (`ChatDock.handleSwitchProject` -> `chrome.setActiveProjectSlug`),
        // not a hand-written substitute for its effect.
        const badge = page.locator('.chat-dock__project-badge');
        await expect(badge).toHaveText('No project', { timeout: 10_000 });
        await badge.click();
        await expect(
          page.getByRole('dialog', { name: 'Switch project' }),
        ).toBeVisible({ timeout: 10_000 });
        await page
          .getByRole('button', { name: 'Switch to Demo Project' })
          .click();
        await expect(
          page.getByRole('dialog', { name: 'Switch project' }),
        ).toBeHidden({ timeout: 10_000 });
        // Scoped to the badge's own class: the project sidebar (seeded
        // from the same `/api/projects` mock) also renders a same-named
        // button.
        await expect(
          page.locator('.chat-dock__project-badge', {
            hasText: 'Demo Project',
          }),
        ).toBeVisible({ timeout: 10_000 });
      },
    ),
  },
  {
    name: 'overlay-dock-project-mismatch',
    title: 'Overlay — Chat dock, session/badge project mismatch',
    path: '/?dock=open&chat=gallery-mismatch-conversation',
    viewport: DESKTOP,
    ...overlayDockProjectMismatchHooks(),
  },
  {
    name: 'overlay-project-switcher-populated',
    title: 'Overlay — Project switcher sheet with a real project row',
    path: '/?dock=open',
    viewport: DESKTOP,
    ...withGalleryProjectsList(
      [{ slug: 'demo-project', name: 'Demo Project' }],
      async (page) => {
        await assertNoStrayProjectModal(page);
        // archive#4524: the row's action is "Switch to <project>" (rebinds
        // the dock, no chat creation) — not the retired "Continue in
        // <project>" (which always opened the New Chat modal).
        const trigger = page.getByRole('button', { name: 'No project' });
        await trigger.waitFor({ timeout: 10_000 });
        await trigger.click();
        await expect(
          page.getByRole('dialog', { name: 'Switch project' }),
        ).toBeVisible({ timeout: 10_000 });
        await expect(
          page.getByRole('button', { name: 'Switch to Demo Project' }),
        ).toBeVisible({ timeout: 10_000 });
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
      await page.evaluate(async () => {
        await fetch('/notifications', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source: 'overlay-gallery',
            category: 'test',
            title: 'Overlay gallery toast',
            body: 'A toast captured at normal (non-reduced) motion.',
            ttl: 15_000,
          }),
        });
      });
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
      await page.evaluate(async () => {
        await fetch('/notifications', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source: 'overlay-gallery',
            category: 'test',
            title: 'Toast with an action',
            body: 'This toast carries a View action button.',
            ttl: 15_000,
            metadata: { navigateTo: { path: '/agents' } },
          }),
        });
      });
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
      await expect(page.locator('.chat-dock')).toBeVisible({
        timeout: 10_000,
      });
    },
  },
  {
    name: 'mobile-connections',
    title: 'Mobile — Connections',
    path: '/connections',
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
];

interface Shot {
  screen: Screen;
  file: string;
  ok: boolean;
  error?: string;
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

test('build gallery — capture key screens', async ({ page }) => {
  const requestedScreens = parseRequestedScreens(
    process.env.STATION_E2E_SCREENS,
  );
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
  // of raising the shared Playwright default used by smaller specs.
  test.setTimeout(Math.max(90_000, selectedScreens.length * 7_000));

  mkdirSync(GALLERY_DIR, { recursive: true });
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
  await page.route('**/.well-known/station/v1', fulfillGalleryStationHandshake);
  await page.route('**/api/system/identity', fulfillGalleryStationIdentity);

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
  await page.route('**/api/system/core-update', (route) =>
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

  try {
    for (const screen of selectedScreens) {
      const file = `${screen.name}.png`;
      try {
        await page.setViewportSize(screen.viewport);
        await page.emulateMedia({
          reducedMotion: screen.reducedMotion ? 'reduce' : 'no-preference',
        });
        if (screen.beforeGoto) {
          await screen.beforeGoto(page);
        }
        await page.goto(screen.path, { waitUntil: 'domcontentloaded' });
        // Wait past the "Warming up" splash for the real app shell.
        await page.waitForFunction(
          () =>
            !!document.querySelector('.app') &&
            !document.body.textContent?.includes('Warming up'),
          undefined,
          { timeout: 20_000 },
        );
        if (screen.waitFor) {
          await page.waitForSelector(screen.waitFor, { timeout: 10_000 });
        }
        // Let async panels settle so the shot reflects loaded data.
        await page.waitForTimeout(1200);
        // archive#4464: a web-font swap (FOUT/FOIT) landing mid-shot is a
        // well-known source of exactly the kind of tiny, isolated
        // text/border-edge pixel noise this feature's own
        // two-consecutive-runs acceptance check was still catching after
        // every other identified source was fixed — one capture can race the
        // fallback-to-real-font swap and the next can miss it entirely.
        await page.evaluate(() => document.fonts.ready);
        if (!screen.expectSkeleton) {
          await assertNoLoadingSkeleton(page);
        }
        if (screen.afterGoto) {
          await screen.afterGoto(page);
        }
        // The identity-mismatch tile deliberately overrides the global healthy
        // handshake and waits for its own deterministic blocked state. Every
        // other screen must prove the gallery-wide route has reached the fixed
        // healthy posture before capture rather than racing the opening probe.
        if (screen.name !== 'overlay-connection-banner') {
          await assertGalleryConnectionChrome(page);
        }
        await hideVolatileChrome(page);
        await page.screenshot({
          path: join(GALLERY_DIR, file),
          fullPage: true,
          // archive#4464: freeze CSS animations/transitions at their end state
          // instead of racing them — `reducedMotion` above only sets the OS
          // media-query preference, it does not itself stop an in-flight
          // transition from being mid-frame at capture time.
          animations: 'disabled',
        });
        shots.push({ screen, file, ok: true });
      } catch (error) {
        // Capture whatever rendered so the broken state is still inspectable.
        try {
          await hideVolatileChrome(page);
          await page.screenshot({
            path: join(GALLERY_DIR, file),
            animations: 'disabled',
          });
        } catch {
          /* nothing renderable */
        }
        shots.push({
          screen,
          file,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
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
          expected: SCREENS.length,
          // `null` marks a full run over every declared SCREENS entry; a
          // requested-name array marks a targeted run so downstream tooling
          // (scripts/screenshot-diff.mjs) can never mistake a partial
          // gallery for full coverage.
          selection: requestedScreens,
          screens: shots.map(({ file, ok, screen, error }) => ({
            file,
            ok,
            name: screen.name,
            error: error ?? null,
          })),
        },
        null,
        2,
      )}\n`,
    );
  }

  const ok = shots.filter((shot) => shot.ok).length;
  expect(ok, 'every selected gallery screen should render').toBe(
    selectedScreens.length,
  );
});
