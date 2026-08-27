/**
 * Cold browser proof for the printed `station start --temp-home` URL.
 *
 * NOT IN CI, and cannot be: it needs a freshly started Station instance whose
 * one-use `#station-ui-bootstrap=<token>` fragment is printed to a terminal,
 * and nothing in this repo's workflows starts one. It is a manual/agent gate,
 * run as two commands:
 *
 *   ./station start --instance=a1f --temp-home --port=3482 --ui-port=5482
 *   PW_BASE_URL='<the printed URL, fragment included>' npm run test:live:cold-bootstrap
 *
 * The handoff is exactly that: `station start` prints the URL, and the operator
 * passes it through `PW_BASE_URL`. There is no discovery step — the fragment is
 * single-use and only that process knows it. Exit 0 means every assertion
 * below held; anything else throws.
 *
 * This intentionally uses no storageState and never intercepts `/api/**`.
 */
import { chromium } from 'playwright';

const printedUrl = process.env.PW_BASE_URL;
if (!printedUrl)
  throw new Error('PW_BASE_URL must be the printed bootstrap URL');

/**
 * AC3's budget: a write issued in the first two seconds of a cold load must
 * reach the server. Asserted against the elapsed time from navigation start to
 * the acknowledgement POST leaving the browser — `click({ timeout })` is only
 * Playwright's action deadline and would still pass if the write moved
 * arbitrarily late.
 *
 * This one is HOST-SENSITIVE and says as much when it fails: it measures the
 * whole cold path — and the dominant term is the entry bundle's parse and first
 * render, not anything this branch touches. Eight runs on the development host
 * (2026-08-20, load average 14-27 from sibling agent sessions) measured
 * 1878 / 3429 / 3433 / 3447 / 4364 / 4672 / 4742 / 4880 / 5082 ms, with the
 * ~2s gap sitting between the first five boot GETs and the rest of them. Only
 * the quietest run met 2000ms.
 *
 * The number is kept at AC3's 2000ms rather than moved to what a busy host
 * happens to do — a budget raised to match the machine measures nothing. Raise
 * it deliberately for a run with `COLD_WRITE_BUDGET_MS=<ms>` and say so when
 * reporting the result.
 */
const COLD_WRITE_BUDGET_MS = Number(process.env.COLD_WRITE_BUDGET_MS ?? 2_000);

/**
 * The load-INSENSITIVE half, and the one that actually pins this branch: the
 * write must leave the browser promptly after the affordance for it exists.
 * `mutationAllowed` used to refuse writes locally for 3-20s after every load,
 * so a click that produced no request at all — or produced one only once a
 * later health probe cleared the stale evidence — reddens here whatever the
 * host is doing.
 */
const WRITE_AFTER_AFFORDANCE_BUDGET_MS = 1_500;

const uiOrigin = new URL(printedUrl).origin;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const requests = [];
let navigationStartedAt = 0;
let acknowledgementRequestedAt;
let disclosureReadyAt;

page.on('request', (request) => {
  if (
    request.method() === 'POST' &&
    request
      .url()
      .endsWith('/api/usage-telemetry/disclosure/acknowledgements') &&
    acknowledgementRequestedAt === undefined
  ) {
    acknowledgementRequestedAt = Date.now();
  }
});

page.on('response', (response) => {
  const request = response.request();
  const url = new URL(response.url());
  if (
    request.method() === 'GET' &&
    url.pathname === '/api/usage-telemetry/disclosure' &&
    response.status() === 200 &&
    disclosureReadyAt === undefined
  ) {
    disclosureReadyAt = Date.now();
  }
  if (
    url.origin === uiOrigin &&
    (url.pathname.includes('/api/') || url.pathname.includes('/pairing/'))
  ) {
    const elapsed = navigationStartedAt ? Date.now() - navigationStartedAt : 0;
    requests.push(
      `+${String(elapsed).padStart(5)}ms ${request.method()} ${url.pathname} ${response.status()}`,
    );
  }
});

try {
  // Every waiter is registered BEFORE navigation and awaited after the write,
  // so nothing in this script sits between the page loading and the write
  // being attempted. The point of the assertion is the app's behaviour in the
  // first two seconds, and a `waitUntil: 'load'` or a `<main>` wait ahead of
  // the click would be measuring this script instead.
  const bootResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/boot') && response.status() === 200,
  );
  // A real authenticated POST issued during the cold window; it proves the
  // browser no longer rejects writes from stale connection evidence.
  const writeResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response
        .url()
        .endsWith('/api/usage-telemetry/disclosure/acknowledgements') &&
      response.status() === 200,
  );
  navigationStartedAt = Date.now();
  await page.goto(printedUrl, { waitUntil: 'commit' });
  await page
    .getByRole('button', { name: 'I understand' })
    .click({ timeout: 20_000 });
  await writeResponse;
  await bootResponse;

  if (acknowledgementRequestedAt === undefined) {
    throw new Error('no acknowledgement POST was observed leaving the browser');
  }
  const writeAtMs = acknowledgementRequestedAt - navigationStartedAt;
  const writeAfterAffordanceMs =
    disclosureReadyAt === undefined
      ? undefined
      : acknowledgementRequestedAt - disclosureReadyAt;
  if (
    writeAfterAffordanceMs === undefined ||
    writeAfterAffordanceMs > WRITE_AFTER_AFFORDANCE_BUDGET_MS
  ) {
    throw new Error(
      `the cold write did not follow its affordance promptly (${writeAfterAffordanceMs ?? 'no disclosure GET observed'}ms, budget ${WRITE_AFTER_AFFORDANCE_BUDGET_MS}ms)\n${requests.join('\n')}`,
    );
  }
  if (writeAtMs > COLD_WRITE_BUDGET_MS) {
    throw new Error(
      `the cold write left the browser ${writeAtMs}ms after navigation start, over the ${COLD_WRITE_BUDGET_MS}ms budget. ` +
        `It followed its affordance in ${writeAfterAffordanceMs}ms, so the app did not refuse or delay the write — check host load, ` +
        `and re-run with COLD_WRITE_BUDGET_MS if this host is busy.\n${requests.join('\n')}`,
    );
  }

  await page.getByRole('main').waitFor({ state: 'visible', timeout: 20_000 });
  if (await page.getByText(/Request access to reconnect/i).count()) {
    throw new Error('stale reconnect banner rendered after bootstrap');
  }

  await page.goto(`${uiOrigin}/projects/new`, { waitUntil: 'load' });
  const visibleSurface = page
    .getByTestId('setup-launcher')
    .or(page.getByRole('heading', { name: 'New Project' }));
  await visibleSurface.waitFor({ state: 'visible', timeout: 20_000 });

  console.log(requests.join('\n'));
  console.log(
    `\ncold write issued +${writeAtMs}ms after navigation start (budget ${COLD_WRITE_BUDGET_MS}ms), ` +
      `${writeAfterAffordanceMs}ms after its affordance (budget ${WRITE_AFTER_AFFORDANCE_BUDGET_MS}ms)`,
  );
} finally {
  await browser.close();
}
