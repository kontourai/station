/**
 * Shared boot/pair/settle helpers for the live product suites
 * (tests/live/fresh-home-walkthrough.mjs and tests/live/core-loop-journeys.mjs,
 * kontourai/station#766 items 1 and 2).
 *
 * Extracted from the fresh-home walkthrough rather than re-derived so both
 * suites drive the identical product path: `./station start --temp-home` (the
 * launcher a new user runs), the ui-bootstrap mint/exchange pairing journey,
 * and the same settled-page definition. Anything suite-specific — console
 * budgets, screenshots, failure accounting — stays in the suites.
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import {
  pluginLifecycleUnapplied,
  readPluginLifecycleResponse,
} from '../../../packages/contracts/src/plugin.ts';

/**
 * Marks requests a SUITE issues through api() so a console budget can tell
 * them apart from the app's own traffic (lowercase: Playwright reports header
 * names lowercased).
 */
export const SUITE_REQUEST_HEADER = 'x-fresh-home-walkthrough';

export function runStation(root, args, { timeoutMs, env }) {
  return new Promise((resolvePromise, rejectPromise) => {
    // `./station` is a bash launcher; Windows runs its CLI entry directly.
    const [command, launch] =
      process.platform === 'win32'
        ? [
            process.execPath,
            [
              join(root, 'node_modules/tsx/dist/cli.mjs'),
              'scripts/station-cli.ts',
              ...args,
            ],
          ]
        : ['./station', args];
    const child = spawn(command, launch, {
      cwd: root,
      env: { ...(env ?? process.env), STATION_INVOKED_CWD: root },
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

/**
 * The checkout revision and host a live result came from: a measurement or
 * journey result means little without them.
 */
export function runProvenance(root) {
  const git = (args) =>
    execFileSync('git', args, { cwd: root, windowsHide: true })
      .toString()
      .trim();
  return {
    revision: git(['rev-parse', 'HEAD']),
    uncommittedChanges: git(['status', '--porcelain']) !== '',
    environment: {
      platform: `${platform()} ${release()} ${arch()}`,
      cpus: `${cpus().length} × ${cpus()[0]?.model ?? 'unknown'}`,
      memoryGiB: Math.round(totalmem() / 2 ** 30),
      node: process.version,
    },
  };
}

export async function poll(description, timeoutMs, probe) {
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
export async function api(page, method, path, body) {
  const result = await page.evaluate(
    async ({ method, path, body, marker }) => {
      const response = await fetch(path, {
        method,
        headers: {
          [marker]: '1',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
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
    { method, path, body, marker: SUITE_REQUEST_HEADER },
  );
  return result;
}

/**
 * `acceptSaved`: a plugin lifecycle route's designed `202` (saved, not
 * applied) is returned rather than thrown. Only a caller that then takes the
 * step that applies it (for a plugin activation, recovery) and checks the
 * result may pass it; the contract's reader decides what counts as saved.
 */
export async function apiOk(
  page,
  method,
  path,
  body,
  { acceptSaved = false } = {},
) {
  const { status, payload } = await api(page, method, path, body);
  if (
    acceptSaved &&
    readPluginLifecycleResponse(status, payload).state === 'saved'
  )
    return payload;
  if (status >= 400 || payload?.success === false) {
    const verdict =
      status === 202 && pluginLifecycleUnapplied(payload)
        ? 'was saved but not applied'
        : 'failed';
    throw new Error(
      `${method} ${path} ${verdict}: HTTP ${status} ${JSON.stringify(payload)?.slice(0, 400)}`,
    );
  }
  return payload;
}

/**
 * Station does not resume an activation that did not complete: the plugin
 * reads Needs recovery until a person recovers it. A live suite takes that
 * documented step once, approving exactly what the recovery review shows, and
 * fails with the plugin's readiness named if it is still not active.
 */
export async function recoverPluginOnce(page, name) {
  const path = `/api/plugins/${encodeURIComponent(name)}`;
  const review = await apiOk(page, 'GET', `${path}/recovery-preview`);
  await apiOk(
    page,
    'POST',
    `${path}/recover`,
    {
      recoveryRevision: review.recoveryRevision,
      consent: {
        contentDigest: review.contentDigest,
        grantRevision: review.grantRevision,
        ...(review.registryTrustRevision
          ? { registryTrustRevision: review.registryTrustRevision }
          : {}),
        permissions: review.permissions?.required ?? [],
        dependencies: (review.dependencies ?? []).map((entry) => entry.id),
        dependencyApprovals: (review.dependencies ?? []).map(
          ({ id, consent }) => ({ id, ...consent }),
        ),
      },
    },
    { acceptSaved: true },
  );
  const listed = await apiOk(page, 'GET', '/api/plugins');
  const row = listed?.plugins?.find((entry) => entry?.name === name);
  const readiness =
    row?.installationReadiness?.state ?? (row ? 'ready' : 'absent');
  if (readiness !== 'ready')
    throw new Error(
      `${name} was installed but is not active (readiness ${readiness}) after one recovery`,
    );
}

/**
 * The throwaway home the launcher created for an instance, read from the
 * instance registry — the same record scripts/run-e2e-suite.mjs trusts.
 */
export function instanceHome(root, instance) {
  const registry = JSON.parse(
    readFileSync(
      join(root, '.station', 'instances', `${instance}.json`),
      'utf8',
    ),
  );
  const home = registry?.baseDir;
  if (typeof home !== 'string' || !home) {
    throw new Error(
      `Instance registry for ${instance} did not publish a home directory`,
    );
  }
  return home;
}

/**
 * Start `./station start --temp-home` on explicit ports and wait for the UI
 * proxy to serve `/`. First start builds the app, so callers budget that in
 * `startTimeoutMs`. Returns a `stop()` that runs `./station stop` and reports
 * a nonzero exit without throwing (teardown must not mask the verdict).
 */
export async function startTempHomeInstance({
  root,
  instance,
  serverPort,
  uiPort,
  logPath,
  env,
  home,
  startTimeoutMs = 20 * 60_000,
}) {
  const started = await runStation(
    root,
    [
      'start',
      `--instance=${instance}`,
      ...(home ? [`--base=${home}`] : ['--temp-home']),
      '--clean',
      '--force',
      `--port=${serverPort}`,
      `--ui-port=${uiPort}`,
      ...(logPath ? [`--log=${logPath}`] : []),
    ],
    { timeoutMs: startTimeoutMs, env },
  );
  if (started.code !== 0) {
    console.error(started.output.slice(-6000));
    throw new Error(`./station start (${instance}) exited ${started.code}`);
  }
  await poll(`UI for ${instance} to serve /`, 60_000, async () => {
    // Dial 127.0.0.1 explicitly: Node's fetch may resolve `localhost` to ::1
    // while the started instance listens on IPv4 loopback.
    const response = await fetch(`http://127.0.0.1:${uiPort}/`);
    return response.ok;
  });
  return {
    uiOrigin: `http://localhost:${uiPort}`,
    home: home ?? instanceHome(root, instance),
    async stop() {
      const stopped = await runStation(
        root,
        ['stop', `--instance=${instance}`],
        {
          timeoutMs: 60_000,
          env,
        },
      ).catch((error) => ({ code: -1, output: String(error) }));
      if (stopped.code !== 0) {
        console.error(
          `WARNING: ./station stop (${instance}) exited ${stopped.code}`,
        );
      }
      return stopped;
    },
  };
}

/**
 * Pair a browser page with a started instance through the ui-bootstrap mint
 * route: a DIRECT loopback mint call presenting the per-boot local grant
 * (filesystem possession plus loopback position, per
 * docs/design/local-bootstrap-token.md), then the browser exchanges the
 * one-time token itself via the fragment path — the exact journey
 * `station start` prints for a human.
 */
export async function pairBrowser(
  page,
  { root, instance, serverPort, uiOrigin },
) {
  const home = instanceHome(root, instance);
  const secret = readFileSync(
    join(home, 'runtime', 'local-grant.secret'),
    'utf8',
  ).trim();
  const mint = await fetch(
    `http://127.0.0.1:${serverPort}/.well-known/station/v1/pairing/mint-ui-bootstrap`,
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
  // Await the app's own exchange POST rather than polling an authenticated
  // route: probing before the cookie lands would record 401 noise the suite
  // itself caused.
  const exchange = page.waitForResponse(
    (response) =>
      response.url().endsWith('/pairing/ui-bootstrap') &&
      response.request().method() === 'POST',
    { timeout: 30_000 },
  );
  await page.goto(`${uiOrigin}/#station-ui-bootstrap=${token}`, {
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
 * Every loading treatment the shipped app renders while a surface is not yet
 * real content. All selectors name markup that exists today:
 *  - `.skeleton` — the shared @kontourai/ui placeholder primitive;
 *  - `[role="status"][aria-busy="true"]` — Station's SkeletonBlock/SkeletonList;
 *  - `.fs-screen` / `.station-spinner` — @kontourai/station-sdk's full-screen
 *    loading interstitial ("Polishing the pixels...") and spinner.
 * The walkthrough's first gallery review caught two screenshots the old
 * first-skeleton-only check waved through: a layout still on `.fs-screen`,
 * and the LocalUiSessionGate pending text (checked separately below because
 * it is plain text, not a stable selector).
 */
export const LOADING_MARKER_SELECTORS = [
  '.skeleton',
  '.route-pending',
  '[role="status"][aria-busy="true"]',
  '.fs-screen',
  '.station-spinner',
];

export async function countVisibleLoadingMarkers(page) {
  let total = 0;
  for (const selector of LOADING_MARKER_SELECTORS) {
    total += await page.locator(selector).filter({ visible: true }).count();
  }
  // LocalUiSessionGate's pending state (src-ui LocalUiSessionGate.tsx).
  total += await page
    .getByText("Checking this browser's Station access")
    .count();
  const mainText = await page
    .locator('main')
    .filter({ visible: true })
    .allTextContents();
  if (
    mainText.length > 0 &&
    mainText.every((text) => !text.trim()) &&
    (await page.getByRole('dialog').filter({ visible: true }).count()) === 0
  )
    total += 1;
  return total;
}

/**
 * A page has settled when a landmark surface is visible and NO loading
 * treatment remains anywhere on it. A page still showing one after the budget
 * is the "infinite skeleton" defect the walkthrough exists to catch.
 *
 * Returns `null` when settled, otherwise a failure-reason string — the caller
 * owns whether that reason is a suite failure (the walkthrough's `fail`) or a
 * journey failure.
 */
export async function settlePageReason(page, timeoutMs) {
  const landmarkVisible = await page
    .locator('main, [data-testid="setup-launcher"]')
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .then(
      () => true,
      () => false,
    );
  if (!landmarkVisible) {
    return 'no <main> or setup launcher became visible';
  }
  // A transient empty shell between route mounts is not settled content.
  let clearObservations = 0;
  const loadingGone = await poll(
    'loading markers to clear',
    timeoutMs,
    async () => {
      clearObservations =
        (await countVisibleLoadingMarkers(page)) === 0
          ? clearObservations + 1
          : 0;
      return clearObservations >= 3;
    },
  ).then(
    () => true,
    () => false,
  );
  if (!loadingGone) {
    return `a loading treatment (skeleton/spinner/loading screen/access gate) is still visible after ${timeoutMs}ms`;
  }
  return null;
}
