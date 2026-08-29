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
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  DEVELOPER_TABS,
  getPathForView,
  resolveViewFromPath,
} from '../../src-ui/src/app-shell/routing.ts';
import { APP_SURFACE_REGISTRY } from '../../src-ui/src/app-shell/surface-registry.ts';
import { CONNECTION_SECTIONS } from '../../src-ui/src/views/connections-hub/connection-sections.ts';
import { WALKTHROUGH_ALLOWLIST } from './fresh-home-walkthrough-allowlist.mjs';

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
 * plugin id. An entry here reports EXPECTED-FAIL (visible in the summary,
 * not hidden) instead of failing the run, and reports loudly when the
 * assertion unexpectedly passes so the entry gets removed.
 * Keep this empty unless a tracked issue names the breakage.
 */
const EXPECTED_PLUGIN_FAILURES = new Map([
  // kontourai/station#765 finding D1 (Critical): the bundled Getting Started
  // Starter installs but its layout renders 'Unsupported layout tab — Plugin
  // layout component "getting-started-home" is not installed or registered.'
  // Reproduced by this suite on main (3088300c8, 2026-08-29) with the
  // identical message — and the same defect class hits every other bundled
  // layout plugin (their components are equally unregistered after install),
  // so each carries the same D1 reference below. Remove each entry as the fix
  // lands; the suite reports loudly when an expected failure starts passing.
  ['getting-started-starter', 'kontourai/station#765 D1'],
  ['coding-starter', 'kontourai/station#765 D1 (same class)'],
  ['knowledge-docs-starter', 'kontourai/station#765 D1 (same class)'],
  ['minimal-layout', 'kontourai/station#765 D1 (same class)'],
  // demo-layout shows the class one step earlier: it installs, but its
  // declared layout never appears in the layout catalog at all.
  ['demo-layout', 'kontourai/station#765 D1 (same class)'],
]);

// ---------------------------------------------------------------------------
// Route derivation — imported from the real tables so the sweep cannot drift.
// ---------------------------------------------------------------------------

function deriveRoutes() {
  const routes = new Set();
  // Every registered surface's canonical route (deduped: several palette
  // entries share /settings and /guidance).
  for (const surface of APP_SURFACE_REGISTRY.getRegistered()) {
    routes.add(surface.route);
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
    const url = new URL(response.url());
    recordFinding(
      'request-error',
      `${response.request().method()} ${response.status()} ${url.pathname}`,
    );
  });
  page.on('requestfailed', (request) => {
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
// Process + HTTP helpers
// ---------------------------------------------------------------------------

function runStation(args, { timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('./station', args, {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    const capture = (chunk) => {
      output += String(chunk);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectPromise(
        new Error(
          `./station ${args.join(' ')} timed out after ${timeoutMs}ms\n${output.slice(-4000)}`,
        ),
      );
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output });
    });
  });
}

async function poll(description, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}${
      lastError ? `: ${lastError}` : ''
    }`,
  );
}

/**
 * Authenticated API call issued FROM the paired page, so it rides the same
 * device-session cookie, origin, and UI proxy the product's own client uses.
 */
async function api(page, method, path, body) {
  const result = await page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(path, {
        method,
        headers:
          body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        // non-JSON response bodies are reported by status alone
      }
      return { status: response.status, payload };
    },
    { method, path, body },
  );
  return result;
}

async function apiOk(page, method, path, body) {
  const { status, payload } = await api(page, method, path, body);
  if (status >= 400 || payload?.success === false) {
    throw new Error(
      `${method} ${path} failed: HTTP ${status} ${JSON.stringify(payload)?.slice(0, 400)}`,
    );
  }
  return payload;
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
 * Every loading treatment the shipped app renders while a surface is not yet
 * real content. All selectors name markup that exists today:
 *  - `.skeleton` — the shared @kontourai/ui placeholder primitive;
 *  - `[role="status"][aria-busy="true"]` — Station's SkeletonBlock/SkeletonList;
 *  - `.fs-screen` / `.station-spinner` — @kontourai/station-sdk's full-screen
 *    loading interstitial ("Polishing the pixels...") and spinner.
 * The suite's first gallery review caught two screenshots the old
 * first-skeleton-only check waved through: a layout still on `.fs-screen`,
 * and the LocalUiSessionGate pending text (checked separately below because
 * it is plain text, not a stable selector).
 */
const LOADING_MARKER_SELECTORS = [
  '.skeleton',
  '[role="status"][aria-busy="true"]',
  '.fs-screen',
  '.station-spinner',
];

async function countVisibleLoadingMarkers(page) {
  let total = 0;
  for (const selector of LOADING_MARKER_SELECTORS) {
    total += await page.locator(selector).filter({ visible: true }).count();
  }
  // LocalUiSessionGate's pending state (src-ui LocalUiSessionGate.tsx).
  total += await page
    .getByText("Checking this browser's Station access")
    .count();
  return total;
}

/**
 * A page has settled when a landmark surface is visible and NO loading
 * treatment remains anywhere on it. A page still showing one after the budget
 * is the "infinite skeleton" defect this suite exists to catch.
 */
async function settlePage(page, label, { record = true } = {}) {
  const landmarkVisible = await page
    .locator('main, [data-testid="setup-launcher"]')
    .first()
    .waitFor({ state: 'visible', timeout: SETTLE_TIMEOUT_MS })
    .then(
      () => true,
      () => false,
    );
  if (!landmarkVisible) {
    if (record) fail(`${label}: no <main> or setup launcher became visible`);
    return false;
  }
  const loadingGone = await poll(
    `${label} loading markers to clear`,
    SETTLE_TIMEOUT_MS,
    async () => (await countVisibleLoadingMarkers(page)) === 0,
  ).then(
    () => true,
    () => false,
  );
  if (!loadingGone) {
    if (record)
      fail(
        `${label}: a loading treatment (skeleton/spinner/loading screen/access gate) is still visible after ${SETTLE_TIMEOUT_MS}ms`,
      );
    return false;
  }
  return true;
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

async function pairBrowser(page) {
  // Read the throwaway home the launcher just created from the instance
  // registry — the same record scripts/run-e2e-suite.mjs trusts.
  const registry = JSON.parse(
    readFileSync(
      join(ROOT, '.station', 'instances', `${INSTANCE}.json`),
      'utf8',
    ),
  );
  const home = registry?.baseDir;
  if (typeof home !== 'string' || !home) {
    throw new Error('Instance registry did not publish a home directory');
  }
  const secret = readFileSync(
    join(home, 'runtime', 'local-grant.secret'),
    'utf8',
  ).trim();
  // Mint must be a DIRECT loopback call on the server port (never the UI
  // proxy) presenting the per-boot local grant — filesystem possession plus
  // loopback position, per docs/design/local-bootstrap-token.md.
  const mint = await fetch(
    `http://127.0.0.1:${SERVER_PORT}/.well-known/station/v1/pairing/mint-ui-bootstrap`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret }),
    },
  );
  if (!mint.ok) {
    throw new Error(`ui-bootstrap mint failed: HTTP ${mint.status}`);
  }
  const { token } = await mint.json();
  // The browser exchanges the one-time token itself via the fragment path —
  // the exact journey `station start` prints for a human. Await the app's own
  // exchange POST rather than polling an authenticated route: probing before
  // the cookie lands would record 401 noise this suite itself caused.
  const exchange = page.waitForResponse(
    (response) =>
      response.url().endsWith('/pairing/ui-bootstrap') &&
      response.request().method() === 'POST',
    { timeout: 30_000 },
  );
  await page.goto(`${UI_ORIGIN}/#station-ui-bootstrap=${token}`, {
    waitUntil: 'load',
  });
  const exchanged = await exchange;
  if (exchanged.status() !== 200) {
    throw new Error(`ui-bootstrap exchange failed: HTTP ${exchanged.status()}`);
  }
  const boot = await api(page, 'GET', '/api/boot');
  if (boot.status !== 200) {
    throw new Error(`paired boot check failed: GET /api/boot ${boot.status}`);
  }
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
        console.error(
          `NOTE: plugin ${pluginId} passed but is listed in EXPECTED_PLUGIN_FAILURES — remove the entry`,
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
  if (expectation) {
    expectedFailures.push(`${pluginId}: ${message} (expected: ${expectation})`);
    console.error(`EXPECTED-FAIL [${pluginId}] ${message} — ${expectation}`);
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
