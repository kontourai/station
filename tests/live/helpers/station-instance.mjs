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
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Marks requests a SUITE issues through api() so a console budget can tell
 * them apart from the app's own traffic (lowercase: Playwright reports header
 * names lowercased).
 */
export const SUITE_REQUEST_HEADER = 'x-fresh-home-walkthrough';

export function runStation(root, args, { timeoutMs, env }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('./station', args, {
      cwd: root,
      env: env ?? process.env,
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

export async function apiOk(page, method, path, body) {
  const { status, payload } = await api(page, method, path, body);
  if (status >= 400 || payload?.success === false) {
    throw new Error(
      `${method} ${path} failed: HTTP ${status} ${JSON.stringify(payload)?.slice(0, 400)}`,
    );
  }
  return payload;
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
  startTimeoutMs = 20 * 60_000,
}) {
  const started = await runStation(
    root,
    [
      'start',
      `--instance=${instance}`,
      '--temp-home',
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
    home: instanceHome(root, instance),
    async stop() {
      const stopped = await runStation(
        root,
        ['stop', `--instance=${instance}`],
        {
          timeoutMs: 60_000,
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
  const loadingGone = await poll(
    'loading markers to clear',
    timeoutMs,
    async () => (await countVisibleLoadingMarkers(page)) === 0,
  ).then(
    () => true,
    () => false,
  );
  if (!loadingGone) {
    return `a loading treatment (skeleton/spinner/loading screen/access gate) is still visible after ${timeoutMs}ms`;
  }
  return null;
}
