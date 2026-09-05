/**
 * Fresh-home release walkthrough (kontourai/station#766 item 1).
 *
 * Boots the BUILT app against a throwaway home — `./station start --temp-home`
 * on explicit ports, the same launcher a new user runs — pairs a real browser
 * context through the ui-bootstrap mint route, and walks the actual product
 * surface:
 *
 *  1. Route sweep — every path derived from the REAL routing tables
 *     (`src-ui/src/app-shell/routing.ts` + surface registry, imported, not
 *     copied, so the list cannot drift). Asserts no "Page not found" on a
 *     routed path, no infinite skeleton, and screenshots each route into a
 *     reviewable gallery.
 *  2. Console budget — console errors, page errors, and 4xx/5xx responses
 *     during ordinary navigation fail the run unless a known finding in
 *     tests/live/fresh-home-walkthrough-allowlist.mjs covers them.
 *  3. Bundled-content smoke — installs every plugin in the bundled registry
 *     manifest (examples/registry/default.json), applies each plugin layout to
 *     a project, opens every declared tab, and asserts none renders
 *     "Unsupported layout tab" or "Temporarily unavailable".
 *
 * Run with `npm run walkthrough:fresh-home` (executed through tsx so the
 * routing tables import directly). This is release-train/nightly work, not
 * per-PR work — see .github/workflows/fresh-home-walkthrough.yml.
 *
 * Like tests/live/cold-bootstrap.mjs this deliberately uses no storageState
 * and never intercepts `/api/**`: the point is the product as shipped.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { APP_DESTINATION_REGISTRY } from '../../src-ui/src/app-shell/destination-registry.ts';
import {
  DEVELOPER_TABS,
  getPathForView,
  resolveViewFromPath,
} from '../../src-ui/src/app-shell/routing.ts';
import { CONNECTION_SECTIONS } from '../../src-ui/src/views/connections-hub/connection-sections.ts';
import { WALKTHROUGH_ALLOWLIST } from './fresh-home-walkthrough-allowlist.mjs';
// Boot/pair/settle plumbing is shared with the core-loop journey suite
// (#766 item 2) — see tests/live/helpers/station-instance.mjs. Only the
// walkthrough-specific pieces (console budget, gallery, expected-failure
// accounting) live in this file.
import {
  api,
  apiOk,
  pairBrowser as pairBrowserForInstance,
  poll,
  runStation as runStationAt,
  SUITE_REQUEST_HEADER,
  settlePageReason,
} from './helpers/station-instance.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const INSTANCE = process.env.WALKTHROUGH_INSTANCE ?? 'fresh-walkthrough';
const SERVER_PORT = Number(process.env.WALKTHROUGH_SERVER_PORT ?? 3362);
const UI_PORT = Number(process.env.WALKTHROUGH_UI_PORT ?? 5394);
const OUTPUT_ROOT = resolve(
  ROOT,
  process.env.WALKTHROUGH_OUTPUT_DIR ?? 'test-results/fresh-home-walkthrough',
);
const GALLERY_DIR = join(OUTPUT_ROOT, 'gallery');
const UI_ORIGIN = `http://localhost:${UI_PORT}`;
const SETTLE_TIMEOUT_MS = 30_000;

/**
 * Bundled-content assertions expected to fail on current main, keyed by
 * plugin id. Each entry names the tracking issue AND the exact failure it
 * excuses (`expectedMessageSubstring`): only a failure whose message
 * contains that substring reports EXPECTED-FAIL (visible in the summary,
 * not hidden) — any other failure for the same plugin is a REAL failure.
 * A plugin listed here that PASSES fails the run: the entry is stale and
 * must be removed, and letting it linger would silently excuse the next
 * regression. Keep this empty unless a tracked issue names the breakage.
 */
const EXPECTED_PLUGIN_FAILURES = new Map([
  // kontourai/station#765 finding D1 (Critical) hit every bundled layout
  // plugin: installed layouts rendered 'Unsupported layout tab — Plugin
  // layout component "…" is not installed or registered.' The renderer was
  // treating the still-loading lazy PluginRegistry as authoritative absence;
  // with the loading-state fix in src-ui/src/layouts/index.tsx this suite
  // reproduced getting-started-starter, coding-starter,
  // knowledge-docs-starter, and minimal-layout all PASSING live
  // (2026-08-29, this branch), so their entries are gone. Remove each
  // remaining entry as its fix lands; the run FAILS when an expected
  // failure starts passing.
  // demo-layout shows the class one step earlier: it installs, but its
  // declared layout never appears in the layout catalog at all.
  [
    'demo-layout',
    {
      issue: 'kontourai/station#765 D1 (same class)',
      expectedMessageSubstring: 'none appeared in the layout catalog',
    },
  ],
]);

// ---------------------------------------------------------------------------
// Route derivation — imported from the real tables so the sweep cannot drift.
// ---------------------------------------------------------------------------

function deriveRoutes() {
  const routes = new Set();
  // Every registered surface's canonical route (deduped: several palette
  // entries share /settings and /guidance).
  for (const destination of APP_DESTINATION_REGISTRY.getRegistered()) {
    routes.add(destination.route);
  }
  // Developer tabs are path segments of /developer.
  for (const tab of DEVELOPER_TABS) routes.add(`/developer/${tab}`);
  // Connections IA: each section owns a canonical path.
  for (const section of CONNECTION_SECTIONS) routes.add(section.path);
  // Static parameterless child routes, serialized by the same function the
  // app navigates with.
  for (const view of [{ type: 'agent-new' }, { type: 'project-new' }]) {
    const path = getPathForView(view);
    if (!path) throw new Error(`getPathForView returned null for ${view.type}`);
    routes.add(path);
  }
  const derived = [...routes].sort((a, b) =>
    a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b),
  );
  // Sanity: everything we derived must resolve in the routing table. A route
  // that stops resolving is a product regression the sweep must not skip past.
  for (const route of derived) {
    const view = resolveViewFromPath(route);
    if (view.type === 'not-found') {
      throw new Error(
        `Derived route ${route} resolves to not-found in resolveViewFromPath — routing table and derivation disagree`,
      );
    }
  }
  return derived;
}

// ---------------------------------------------------------------------------
// Findings (console budget)
// ---------------------------------------------------------------------------

/** @type {{ line: string, phase: string, allowlisted: string | null }[]} */
const findings = [];
const failures = [];
const expectedFailures = [];
let phase = 'boot';

function recordFinding(kind, detail) {
  const line = `${kind} ${detail}`;
  const match = WALKTHROUGH_ALLOWLIST.find((entry) => entry.pattern.test(line));
  findings.push({ line, phase, allowlisted: match ? match.reason : null });
}

function fail(message) {
  failures.push(`[${phase}] ${message}`);
  console.error(`FAIL [${phase}] ${message}`);
}

function attachConsoleBudget(page) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text().replace(/\s+/g, ' ').trim();
    // Chromium echoes every failed HTTP fetch as a console error with no URL
    // in the text. The `response`/`requestfailed` listeners below already
    // record those with method, status, and path — keep the single
    // authoritative finding rather than a vaguer duplicate.
    if (text.startsWith('Failed to load resource:')) return;
    // One line per finding: whitespace collapsed so allowlist patterns stay
    // single-line and anchored.
    recordFinding('console-error', text);
  });
  page.on('pageerror', (error) => {
    recordFinding('page-error', String(error).replace(/\s+/g, ' ').trim());
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    // The suite's own api() calls carry this marker; their failures are
    // asserted by the caller. The budget measures what the APP does during
    // ordinary navigation, not what this harness asked for.
    if (response.request().headers()[SUITE_REQUEST_HEADER]) return;
    const url = new URL(response.url());
    recordFinding(
      'request-error',
      `${response.request().method()} ${response.status()} ${url.pathname}`,
    );
  });
  page.on('requestfailed', (request) => {
    if (request.headers()[SUITE_REQUEST_HEADER]) return;
    const failure = request.failure()?.errorText ?? 'unknown failure';
    // Navigating away mid-flight aborts in-progress fetches; that is the
    // sweep's own doing, not a product failure.
    if (failure.includes('ERR_ABORTED')) return;
    recordFinding(
      'request-error',
      `${request.method()} FAILED(${failure}) ${new URL(request.url()).pathname}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Process helper (shared implementation, this suite's ROOT bound in)
// ---------------------------------------------------------------------------

function runStation(args, { timeoutMs }) {
  return runStationAt(ROOT, args, { timeoutMs });
}

// ---------------------------------------------------------------------------
// Page settling + screenshots
// ---------------------------------------------------------------------------

let shotIndex = 0;
async function screenshot(page, name) {
  shotIndex += 1;
  const file = join(
    GALLERY_DIR,
    `${String(shotIndex).padStart(2, '0')}-${name}.png`,
  );
  await page.screenshot({ path: file });
}

function routeShotName(route) {
  return route === '/'
    ? 'home'
    : route
        .slice(1)
        .replaceAll('/', '-')
        .replaceAll(/[^\w-]/g, '_');
}

/**
 * A page has settled when a landmark surface is visible and NO loading
 * treatment remains anywhere on it (the shared settled-page definition —
 * see settlePageReason in helpers/station-instance.mjs). A page still
 * showing one after the budget is the "infinite skeleton" defect this suite
 * exists to catch.
 */
async function settlePage(page, label, { record = true } = {}) {
  const reason = await settlePageReason(page, SETTLE_TIMEOUT_MS);
  if (reason === null) return true;
  if (record) fail(`${label}: ${reason}`);
  return false;
}

async function assertTextAbsent(page, text, label) {
  const count = await page.getByText(text).count();
  if (count > 0) {
    fail(`${label}: renders "${text}"`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Walkthrough phases
// ---------------------------------------------------------------------------

function pairBrowser(page) {
  // Shared journey: instance-registry home discovery, DIRECT loopback mint
  // presenting the per-boot local grant, browser-owned fragment exchange
  // (docs/design/local-bootstrap-token.md) — helpers/station-instance.mjs.
  return pairBrowserForInstance(page, {
    root: ROOT,
    instance: INSTANCE,
    serverPort: SERVER_PORT,
    uiOrigin: UI_ORIGIN,
  });
}

/**
 * Walk the product's own first-boot chrome the way a new user does, so the
 * sweep sees the pages behind it rather than a modal on every screenshot.
 * Each step is optional — copy changes should fail the assertions that
 * matter, not this dismissal.
 */
async function dismissFirstRun(page) {
  await settlePage(page, 'first boot');
  await screenshot(page, 'first-boot');
  const steps = [
    ['button', 'Continue Without Setup'],
    ['button', 'I understand'],
    ['button', 'Not now'],
  ];
  for (const [role, name] of steps) {
    const control = page.getByRole(role, { name, exact: true }).first();
    const visible = await control
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(
        () => true,
        () => false,
      );
    if (!visible) continue;
    await control.click();
    // The click either advances to the next chapter (whose control the next
    // iteration waits for, bounded) or closes the chrome; wait for this
    // control to leave first so a re-render cannot double-fire it.
    await control
      .waitFor({ state: 'hidden', timeout: 10_000 })
      .catch(() => undefined);
  }
  await settlePage(page, 'home after first-run dismissal');
  await screenshot(page, 'home-after-first-run');
}

async function sweepRoutes(page, routes) {
  for (const route of routes) {
    phase = `route ${route}`;
    await page.goto(`${UI_ORIGIN}${route}`, { waitUntil: 'load' });
    const settled = await settlePage(page, route);
    if (settled) {
      await assertTextAbsent(page, 'Page not found', route);
    }
    await screenshot(page, routeShotName(route));
  }
}

/**
 * Install one bundled plugin the way Station's own client installs one
 * (archive#4288): preview first, then install carrying the decision the
 * preview produced — the same sequence tests/helpers/install-plugin.ts
 * encodes. The one-click `POST /api/registry/plugins/install` route refuses
 * every bundled layout plugin by design (it holds no operator decision), so
 * it is deliberately NOT what this smoke exercises.
 */
async function installBundledPlugin(page, plugin) {
  // Manifest sources are relative to examples/registry/default.json — the
  // same resolution the bundled registry provider performs.
  const source = resolve(ROOT, 'examples/registry', plugin.source);
  const preview = await api(page, 'POST', '/api/plugins/preview', { source });
  const previewed = preview.payload;
  if (preview.status >= 400 || previewed?.valid !== true) {
    throw new Error(
      `preview refused ${plugin.id}: HTTP ${preview.status} ${previewed?.error ?? ''}`,
    );
  }
  if (!previewed.contentDigest || !previewed.permissions) {
    throw new Error(`preview for ${plugin.id} returned no basis to approve`);
  }
  await apiOk(page, 'POST', '/api/plugins/install', {
    source,
    consent: {
      permissions: previewed.permissions.required ?? [],
      contentDigest: previewed.contentDigest,
      dependencies: (previewed.dependencies ?? []).map((entry) => entry.id),
      ...((previewed.dependencies ?? []).some((entry) => entry.consent)
        ? {
            dependencyApprovals: (previewed.dependencies ?? []).flatMap(
              (entry) =>
                entry.consent
                  ? [
                      {
                        id: entry.id,
                        permissions: entry.consent.permissions,
                        contentDigest: entry.consent.contentDigest,
                        dependencies: entry.consent.dependencies,
                      },
                    ]
                  : [],
            ),
          }
        : {}),
    },
  });
}

async function bundledContentSmoke(page) {
  phase = 'bundled-content';
  const manifest = JSON.parse(
    readFileSync(join(ROOT, 'examples/registry/default.json'), 'utf8'),
  );
  for (const plugin of manifest.plugins) {
    phase = `bundled-content install ${plugin.id}`;
    try {
      await installBundledPlugin(page, plugin);
    } catch (error) {
      reportPluginFailure(plugin.id, `install failed: ${error}`);
    }
  }

  phase = 'bundled-content project';
  const projectSlug = 'fresh-home-walkthrough';
  await apiOk(page, 'POST', '/api/projects', {
    name: 'Fresh Home Walkthrough',
    slug: projectSlug,
  });
  const available = await apiOk(page, 'GET', '/api/projects/layouts/available');
  const pluginLayouts = (available.data ?? []).filter(
    (item) => item.source === 'plugin',
  );
  // Coverage assertion, derived from the plugins' own manifests: every
  // bundled plugin that DECLARES a layout must surface one in the catalog
  // after install. Without this, a plugin whose layout silently fails to
  // register is simply absent from the loop below and nothing notices.
  const availablePluginNames = new Set(
    pluginLayouts.map((item) => item.plugin),
  );
  for (const plugin of manifest.plugins) {
    const pluginManifest = JSON.parse(
      readFileSync(
        resolve(ROOT, 'examples/registry', plugin.source, 'plugin.json'),
        'utf8',
      ),
    );
    if (pluginManifest.layout && !availablePluginNames.has(plugin.id)) {
      reportPluginFailure(
        plugin.id,
        'declares a layout in plugin.json but none appeared in the layout catalog after install',
      );
    }
  }

  for (const item of pluginLayouts) {
    const pluginId = item.plugin;
    phase = `bundled-content layout ${pluginId}`;
    const pluginFailures = [];
    const track = (message) => pluginFailures.push(message);
    try {
      const applied = await apiOk(
        page,
        'POST',
        `/api/projects/${projectSlug}/layouts/apply`,
        { layoutId: item.id },
      );
      const layoutSlug = applied.data?.slug;
      if (!layoutSlug) throw new Error('apply returned no layout slug');
      const resolved = await apiOk(
        page,
        'GET',
        `/api/projects/${projectSlug}/layouts/${layoutSlug}`,
      );
      const tabs = resolved.data?.config?.tabs ?? [];
      const tabPaths = [
        `/projects/${projectSlug}/layouts/${layoutSlug}`,
        ...tabs.map(
          (tab) => `/projects/${projectSlug}/layouts/${layoutSlug}/${tab.id}`,
        ),
      ];
      for (const path of tabPaths) {
        await page.goto(`${UI_ORIGIN}${path}`, { waitUntil: 'load' });
        if (!(await settlePageQuiet(page))) {
          track(`${path}: did not settle`);
        }
        for (const forbidden of [
          'Unsupported layout tab',
          'Temporarily unavailable',
        ]) {
          if ((await page.getByText(forbidden).count()) > 0) {
            track(`${path}: renders "${forbidden}"`);
          }
        }
        await screenshot(page, `plugin-${routeShotName(path)}`);
      }
    } catch (error) {
      track(String(error));
    }
    if (pluginFailures.length === 0) {
      if (EXPECTED_PLUGIN_FAILURES.has(pluginId)) {
        fail(
          `plugin ${pluginId} passed but is listed in EXPECTED_PLUGIN_FAILURES — remove its entry`,
        );
      }
      continue;
    }
    for (const message of pluginFailures) {
      reportPluginFailure(pluginId, message);
    }
  }
}

/** settlePage without recording a suite failure (caller owns attribution). */
function settlePageQuiet(page) {
  return settlePage(page, 'plugin layout', { record: false });
}

function reportPluginFailure(pluginId, message) {
  const expectation = EXPECTED_PLUGIN_FAILURES.get(pluginId);
  // Excuse only the SPECIFIC tracked failure: a listed plugin failing some
  // other way is a real failure, not a covered one.
  if (expectation && message.includes(expectation.expectedMessageSubstring)) {
    expectedFailures.push(
      `${pluginId}: ${message} (expected: ${expectation.issue})`,
    );
    console.error(
      `EXPECTED-FAIL [${pluginId}] ${message} — ${expectation.issue}`,
    );
    return;
  }
  fail(`plugin ${pluginId}: ${message}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const routes = deriveRoutes();
console.log(
  `fresh-home walkthrough: ${routes.length} routes derived from the routing tables\n${routes.join('\n')}\n`,
);
// A fresh gallery per run: stale screenshots from a previous run must never
// pass for this run's evidence.
rmSync(GALLERY_DIR, { recursive: true, force: true });
mkdirSync(GALLERY_DIR, { recursive: true });

console.log(
  `starting ./station start --instance=${INSTANCE} --temp-home on ${SERVER_PORT}/${UI_PORT} (builds on first run)...`,
);
const started = await runStation(
  [
    'start',
    `--instance=${INSTANCE}`,
    '--temp-home',
    '--clean',
    '--force',
    `--port=${SERVER_PORT}`,
    `--ui-port=${UI_PORT}`,
    `--log=${join(OUTPUT_ROOT, 'station.log')}`,
  ],
  // First start builds the app; hosted CI needs the headroom.
  { timeoutMs: 20 * 60_000 },
);
if (started.code !== 0) {
  console.error(started.output.slice(-6000));
  throw new Error(`./station start exited ${started.code}`);
}

let browser;
try {
  await poll('UI to serve /', 60_000, async () => {
    // Dial 127.0.0.1 explicitly: Node's fetch may resolve `localhost` to ::1
    // while the started instance listens on IPv4 loopback.
    const response = await fetch(`http://127.0.0.1:${UI_PORT}/`);
    return response.ok;
  });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  attachConsoleBudget(page);

  phase = 'pairing';
  await pairBrowser(page);
  phase = 'first-run';
  await dismissFirstRun(page);
  await sweepRoutes(page, routes);
  await bundledContentSmoke(page);
} finally {
  await browser?.close();
  phase = 'teardown';
  const stopped = await runStation(['stop', `--instance=${INSTANCE}`], {
    timeoutMs: 60_000,
  }).catch((error) => ({ code: -1, output: String(error) }));
  if (stopped.code !== 0) {
    console.error(`WARNING: ./station stop exited ${stopped.code}`);
  }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const blockingFindings = findings.filter((finding) => !finding.allowlisted);
const allowlistedFindings = findings.filter((finding) => finding.allowlisted);

writeFileSync(
  join(OUTPUT_ROOT, 'summary.json'),
  `${JSON.stringify(
    {
      routes,
      failures,
      expectedFailures,
      blockingFindings,
      allowlistedFindings,
    },
    null,
    2,
  )}\n`,
);

if (allowlistedFindings.length > 0) {
  console.log(`\nallowlisted findings (${allowlistedFindings.length}):`);
  for (const finding of allowlistedFindings) {
    console.log(
      `  [${finding.phase}] ${finding.line}\n    -> ${finding.allowlisted}`,
    );
  }
}
if (expectedFailures.length > 0) {
  console.log(`\nexpected failures (${expectedFailures.length}):`);
  for (const entry of expectedFailures) console.log(`  ${entry}`);
}
if (blockingFindings.length > 0) {
  console.error(`\nconsole-budget violations (${blockingFindings.length}):`);
  for (const finding of blockingFindings) {
    console.error(`  [${finding.phase}] ${finding.line}`);
  }
}
if (failures.length > 0) {
  console.error(`\nfailures (${failures.length}):`);
  for (const failure of failures) console.error(`  ${failure}`);
}

if (failures.length > 0 || blockingFindings.length > 0) {
  console.error(
    `\nfresh-home walkthrough FAILED — gallery at ${GALLERY_DIR}, summary at ${join(OUTPUT_ROOT, 'summary.json')}`,
  );
  process.exit(1);
}
console.log(
  `\nfresh-home walkthrough passed — ${routes.length} routes swept, gallery at ${GALLERY_DIR}`,
);
