/**
 * First-run "Which agents do you use?" chapter in the real app (archive#3027,
 * re-placed by the UX audit's RT-02/SHELL-12).
 *
 * The unit suite (`EnginesStep.test.tsx`, `FirstRunHomeChapter.test.tsx`)
 * proves the derivations and the gate against hand-built inputs. It cannot
 * prove the chapter REACHES a browser, that it renders on Home as a dialog, or
 * that a deferral leaves the home a durable record. This spec closes that gap.
 *
 * WHY THE GATE IS SERVED FROM A ROUTE PATCH. The chapter's presence is
 * `AppConfig.firstRun.status`, which a brand-new home really does carry as
 * `pending` — and `tests/first-run-live.spec.ts` asserts exactly that against
 * the bucket's own pristine temp home, with no interception at all. This file
 * pins it instead so each case here can name the state it is about
 * (`pending`, `skipped`, `completed`) rather than depending on what an earlier
 * test in the bucket left behind, and so its `PUT` never mutates that home.
 *
 * WHY THE ENGINE MIX IS SERVED FROM A ROUTE PATCH. `externalEngines[]` is a
 * probe of the machine the suite happens to run on — a host with Claude Code
 * signed in and one without produce different rows, so the four states can
 * only be exercised deterministically by patching that one field onto the real
 * status body (everything else the shell reads stays the server's own answer).
 * The agent catalog is likewise pinned so "already enabled" means an authored
 * Agent this test placed, not whatever the host's home happens to hold.
 */

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

interface EngineRow {
  engineId: string;
  name: string;
  engineConnectionId?: string;
  detected: boolean;
  ready: boolean;
  source: string | null;
  reason?:
    | 'sign_in_required'
    | 'missing_prerequisites'
    | 'cannot_verify'
    | 'disabled';
}

/**
 * One row per `FirstRunEngineState`, plus a second `blocked` row that is NOT
 * detected: `cannot_verify` is the rule that separates "Station could not
 * look" from "not on this machine", and it is the one a shallower fixture
 * would collapse.
 */
const ENGINE_MIX: EngineRow[] = [
  {
    engineId: 'claude-code',
    name: 'Claude Code',
    engineConnectionId: 'claude',
    detected: true,
    ready: true,
    source: 'cli',
  },
  {
    engineId: 'codex',
    name: 'Codex',
    engineConnectionId: 'codex',
    detected: true,
    ready: true,
    source: 'cli',
  },
  {
    engineId: 'muse',
    name: 'Muse Code',
    engineConnectionId: 'muse',
    detected: true,
    ready: true,
    source: 'cli',
  },
  {
    engineId: 'gemini-cli',
    name: 'Gemini CLI',
    engineConnectionId: 'gemini-cli',
    detected: true,
    ready: true,
    source: 'cli',
  },
  {
    engineId: 'kiro',
    name: 'Kiro',
    engineConnectionId: 'kiro',
    detected: true,
    ready: false,
    source: null,
    reason: 'sign_in_required',
  },
  {
    engineId: 'amp',
    name: 'Amp',
    engineConnectionId: 'amp',
    detected: false,
    ready: false,
    source: null,
    reason: 'cannot_verify',
  },
  {
    engineId: 'opencode',
    name: 'OpenCode',
    detected: false,
    ready: false,
    source: null,
  },
];

/** The cold-boot mix: nothing ready, so the setup launcher is genuinely up. */
const ENGINE_MIX_NOTHING_READY: EngineRow[] = ENGINE_MIX.map((engine) =>
  engine.ready
    ? { ...engine, ready: false, source: null, reason: 'sign_in_required' }
    : engine,
);

/**
 * The authored Agent that makes `gemini-cli` read as already enabled.
 * `engineDefault` is deliberately absent — `findAuthoredAgentForEngineConnection`
 * skips engine-default alias rows, so a fixture that set it would silently
 * prove nothing.
 */
const AGENT_CATALOG = [
  { slug: 'station', name: 'Station' },
  {
    slug: 'gemini-cli-agent',
    name: 'Gemini CLI Agent',
    execution: { agentConnectionId: 'gemini-cli' },
  },
];

const AGENTS_PATH = '/api/agents';
const MATERIALIZE_ENGINE_PATH_SUFFIX = '/agents/materialize-engine';
const APP_CONFIG_PATH_SUFFIX = '/config/app';
const FIRST_RUN_PATH_SUFFIX = '/config/first-run';

/**
 * The whole request body (archive#3627). The chapter posts an engine's
 * connection id and NOTHING else — no name, no prompt, no draft — because the
 * server resolves the identity and names the Agent from the same registry
 * projection the catalog renders. That is what these specs are asserting when
 * they read `posted`: not that the right draft was built, but that no draft
 * was built at all.
 */
interface MaterializeEngineBody {
  engineId: string;
}

/**
 * Server replies keyed by the engine connection being materialised.
 * `created: false` is the find-or-create's "it was already there" answer,
 * which is a success the report must word differently.
 */
type MaterializeReplies = Record<
  string,
  | { warnings?: string[]; created?: boolean; agentName?: string }
  | { error: string }
>;

async function patchExternalEngines(page: Page, engines: EngineRow[]) {
  await page.route('**/api/system/status', async (route) => {
    try {
      const response = await route.fetch();
      const status = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        // `prerequisitesState` is pinned so the launcher's own
        // discovery-pending suppression cannot race the assertions; every
        // other field remains the live server's answer.
        body: JSON.stringify({
          ...status,
          prerequisitesState: 'ready',
          externalEngines: engines,
        }),
      });
    } catch {
      // The page aborted this status poll (navigation, unmount). Nothing to
      // serve, and nothing to assert about.
      await route.abort().catch(() => undefined);
    }
  });
}

async function pinAgentCatalog(page: Page) {
  await page.route(
    (url) => url.pathname === AGENTS_PATH,
    async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: AGENT_CATALOG }),
      });
    },
  );
}

/**
 * Records every `POST /agents/materialize-engine` the chapter issues and
 * answers each one from `replies`, so a single confirm can produce a clean
 * materialisation, a warned one, and a failure in one batch.
 */
async function recordEngineMaterializations(
  page: Page,
  replies: MaterializeReplies,
): Promise<MaterializeEngineBody[]> {
  const posted: MaterializeEngineBody[] = [];
  await page.route(
    (url) => url.pathname.endsWith(MATERIALIZE_ENGINE_PATH_SUFFIX),
    async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') {
        await route.fallback();
        return;
      }
      const body = request.postDataJSON() as MaterializeEngineBody;
      posted.push(body);
      const reply = replies[body.engineId];
      if (reply && 'error' in reply) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: reply.error }),
        });
        return;
      }
      // The NAME is the server's, which is the point of the endpoint: the
      // report can only say "set up as X" because the response said so.
      const name = reply?.agentName ?? `${body.engineId} Agent`;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { slug: name.toLowerCase().replaceAll(' ', '-'), name },
          created: reply?.created ?? true,
          ...(reply?.warnings ? { warnings: reply.warnings } : {}),
        }),
      });
    },
  );
  return posted;
}

interface FirstRunRecord {
  status: 'pending' | 'skipped' | 'completed';
  completedAt?: string;
  skippedAt?: string;
}

/**
 * Serve this home's first-run record, and capture what the chapter writes back
 * instead of letting it reach the bucket's shared temp home.
 *
 * `GET` keeps every other field the real server reported and overrides only
 * `firstRun`; `PUT` records the body and answers with the merged config, which
 * is what the route itself returns — so the chapter's own refetch sees the new
 * status exactly as it would in production.
 */
async function pinFirstRun(page: Page, firstRun: FirstRunRecord | null) {
  const writes: Record<string, unknown>[] = [];
  let current = firstRun;
  // The decision has its own endpoint (review M1): `PUT /config/app` refuses
  // `firstRun` outright, and the server stamps the timestamp, so what a test
  // records here is the STATUS the chapter asked for.
  await page.route(
    (url) => url.pathname.endsWith(FIRST_RUN_PATH_SUFFIX),
    async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') {
        await route.fallback();
        return;
      }
      const body = request.postDataJSON() as {
        status: FirstRunRecord['status'];
      };
      const stamped: FirstRunRecord =
        body.status === 'completed'
          ? { status: 'completed', completedAt: new Date().toISOString() }
          : { status: 'skipped', skippedAt: new Date().toISOString() };
      writes.push({ firstRun: stamped });
      current = stamped;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: stamped }),
      });
    },
  );
  await page.route(
    (url) => url.pathname.endsWith(APP_CONFIG_PATH_SUFFIX),
    async (route) => {
      const request = route.request();
      if (request.method() !== 'GET') {
        await route.fallback();
        return;
      }
      try {
        const response = await route.fetch();
        const payload = (await response.json()) as {
          data?: Record<string, unknown>;
        };
        const data = { ...(payload.data ?? {}) };
        if (current) data.firstRun = current;
        else delete data.firstRun;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...payload, success: true, data }),
        });
      } catch {
        await route.abort().catch(() => undefined);
      }
    },
  );
  return writes;
}

/** Only the first-run records, in the order the chapter wrote them. */
function firstRunWrites(writes: Record<string, unknown>[]): FirstRunRecord[] {
  return writes
    .map((body) => body.firstRun as FirstRunRecord | undefined)
    .filter((record): record is FirstRunRecord => Boolean(record));
}

/** Finish the questions through the primary action and reach the real picker. */
async function startFirstChat(page: Page) {
  await page
    .getByTestId('first-run-about-you')
    .getByRole('button', { name: 'Start your first chat', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'New Chat', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('dialog', { name: 'New Chat', exact: true }),
  ).toHaveCSS('opacity', '1');
  await expect(
    page.getByRole('button', { name: 'Skip the tour', exact: true }),
  ).toHaveCount(0);
}

function engineRow(page: Page, engineId: string) {
  return page.getByTestId(`first-run-engine-${engineId}`);
}

/**
 * The usage-telemetry inventory this browser sees, and every acknowledgement
 * it writes.
 *
 * NOT a dismissal any more. The disclosure used to be a separate modal that
 * `OnboardingGate` rendered ON TOP of everything — including this chapter and
 * the setup launcher — so these specs had to answer it before they could click
 * anything, and it blocked main's own first-run tests for the same reason. It
 * is now the run's FIRST STEP on a `pending` home, which makes "is there
 * anything outstanding" the difference between a two-step and a three-step
 * run. That has to be the case each test names, not whatever receipt an
 * earlier test in the shared bucket happened to leave behind — so it is pinned
 * at the route, exactly like the engine mix, the agent catalog and the
 * first-run record above.
 */
function disclosureInventory(acknowledged: boolean) {
  return {
    acknowledged,
    inventoryRevision: 'rev-e2e',
    events: {
      station_started: {
        description: 'Station completed startup.',
        properties: { platform: { domain: ['darwin', 'linux', 'win32'] } },
      },
    },
  };
}

async function pinTelemetryDisclosure(
  page: Page,
  { acknowledged }: { acknowledged: boolean },
) {
  const acknowledgements: string[] = [];
  let current = acknowledged;
  await page.route(
    (url) => url.pathname.endsWith('/api/usage-telemetry/disclosure'),
    async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: disclosureInventory(current),
        }),
      });
    },
  );
  await page.route(
    (url) =>
      url.pathname.endsWith('/api/usage-telemetry/disclosure/acknowledgements'),
    async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      acknowledgements.push(route.request().url());
      current = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: disclosureInventory(true),
        }),
      });
    },
  );
  return acknowledgements;
}

test.describe('First-run engines chapter (station#3027)', () => {
  test('renders on Home as a dialog, listing every engine state and offering only the ready ones', async ({
    page,
  }, testInfo) => {
    await patchExternalEngines(page, ENGINE_MIX);
    await pinAgentCatalog(page);
    await pinFirstRun(page, { status: 'pending' });

    await pinTelemetryDisclosure(page, { acknowledged: true });
    await page.goto('/');
    const chapter = page.getByTestId('first-run-engines');
    await expect(chapter).toBeVisible({ timeout: 20_000 });

    // WHERE it is (SHELL-12). Inside Home's own route content, on the shared
    // dialog surface — not a fixed corner card on the notice layer, and not
    // an app-level overlay that outlives this route.
    const overlay = page.locator('.responsive-surface-overlay');
    await expect(overlay).toBeVisible();
    // archive#3656 moved the `main` landmark to the SHELL (`App.tsx`'s
    // `#station-main`), so Home renders a `section.home-view` inside it and
    // this assertion matched nothing for months. It is still the same claim —
    // the chapter is a descendant of Home's own route content, not a fixed
    // corner card and not an app-level overlay — expressed against the shell
    // that exists (archive#3877).
    await expect(
      page.locator('main.main-content .home-view .first-run-engines'),
    ).toHaveCount(1);
    await expect(page.getByText('Which agents do you use?')).toBeVisible();

    // available — pre-ticked and the user's to change.
    for (const engineId of ['claude-code', 'codex', 'muse']) {
      const row = engineRow(page, engineId);
      await expect(row).toHaveAttribute('data-state', 'available');
      await expect(row.locator('input')).toBeChecked();
      await expect(row.locator('input')).toBeEnabled();
      // A plain available row carries no note: there is nothing to explain.
      await expect(row.locator('.first-run-engines__note')).toHaveCount(0);
    }

    // enabled — visibly idempotent: named as ready, carrying the Agent that
    // already exists, and with NO control at all. A disabled checkbox would
    // drop that sentence out of the tab order.
    const enabled = engineRow(page, 'gemini-cli');
    await expect(enabled).toHaveAttribute('data-state', 'enabled');
    await expect(enabled.locator('input')).toHaveCount(0);
    await expect(enabled).toContainText('Ready — Gemini CLI');
    await expect(enabled).toContainText(
      'Already set up as “Gemini CLI Agent”.',
    );

    // blocked — shown with the server's reason, never offered.
    const signIn = engineRow(page, 'kiro');
    await expect(signIn).toHaveAttribute('data-state', 'blocked');
    await expect(signIn.locator('input')).toHaveCount(0);
    await expect(signIn).toContainText('Sign in to Kiro to use it here.');

    // blocked, and NOT detected: `cannot_verify` is an unknown, not an absence.
    const unverifiable = engineRow(page, 'amp');
    await expect(unverifiable).toHaveAttribute('data-state', 'blocked');
    await expect(unverifiable).toContainText(
      'Station could not verify Amp is ready.',
    );

    // undetected — secondary and collapsed, with no checkbox at all.
    const undetected = engineRow(page, 'opencode');
    await expect(undetected).toBeHidden();
    await expect(page.getByRole('button', { name: 'Set up 3' })).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath('engines-chapter.png'),
      fullPage: false,
    });

    await chapter.getByText('Station also works with').click();
    await expect(undetected).toBeVisible();
    // Since archive#3843 this note NAMES the machine for a reader on a paired
    // device, which every context in this suite is: the runner seeds the
    // operator credential into Connect's vault and a bearer outranks the
    // device-session cookie at the auth boundary. The name is whatever host
    // ran the suite, so this pins the sentence rather than the name — the
    // per-class wording itself is `paired-device-presentation.spec.ts`'s
    // subject, not this one's (archive#3877).
    await expect(undetected).toContainText(
      /Not found on .+\. Agent CLIs run on that computer, so it has to be installed there\./,
    );
    await expect(undetected.locator('input')).toHaveCount(0);

    await page.screenshot({
      path: testInfo.outputPath('engines-chapter-expanded.png'),
      fullPage: false,
    });
  });

  test('confirm creates one agent per newly ticked engine, keeps going past a failure, and reports each outcome', async ({
    page,
  }, testInfo) => {
    await patchExternalEngines(page, ENGINE_MIX);
    await pinAgentCatalog(page);
    const configWrites = await pinFirstRun(page, { status: 'pending' });
    // The FIRST selection fails on purpose: a batch that aborted on the first
    // error would leave the remaining two uncreated and the report short.
    const posted = await recordEngineMaterializations(page, {
      claude: { error: 'Claude Code connection is not ready.' },
      codex: {
        warnings: ['Agent saved but not launchable: Codex is signed out.'],
      },
      muse: { agentName: 'Muse Code Agent' },
    });

    await pinTelemetryDisclosure(page, { acknowledged: true });
    await page.goto('/');
    const chapter = page.getByTestId('first-run-engines');
    await expect(chapter).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Set up 3' }).click();

    const report = page.getByTestId('first-run-engines-report');
    await expect(report).toBeVisible();
    await expect(chapter).toContainText(
      '1 set up · 1 saved with warnings · 1 could not be set up.',
    );
    const items = report.locator('.first-run-engines__report-item');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toHaveAttribute('data-status', 'failed');
    await expect(items.nth(0)).toHaveText(
      'Claude Code: could not be set up. Claude Code connection is not ready.',
    );
    await expect(items.nth(1)).toHaveAttribute('data-status', 'warned');
    await expect(items.nth(1)).toHaveText(
      'Codex: Agent saved but not launchable: Codex is signed out.',
    );
    await expect(items.nth(2)).toHaveAttribute('data-status', 'created');
    await expect(items.nth(2)).toHaveText(
      'Muse Code: set up as “Muse Code Agent”.',
    );

    await page.screenshot({
      path: testInfo.outputPath('engines-outcome-report.png'),
      fullPage: false,
    });

    // Exactly one materialise per ticked-and-selectable engine, in listed
    // order — and nothing at all for the already-bound `gemini-cli`, which
    // renders checked. A second device must not duplicate what the first one
    // made, which is the endpoint's own find-or-create guarantee rather than
    // this chapter's bookkeeping.
    expect(posted.map((body) => body.engineId)).toEqual([
      'claude',
      'codex',
      'muse',
    ]);
    // And the request carries NOTHING else: the name in the report above came
    // back from the server, so no draft was minted here to collide with the
    // picker's own Enable.
    expect(posted.map((body) => Object.keys(body).sort())).toEqual([
      ['engineId'],
      ['engineId'],
      ['engineId'],
    ]);

    // A batch with a FAILURE in it has NO exit that completes the run (review
    // H1). It used to have one plain "Continue" that walked on to the
    // questions, whose Skip then wrote `completed` — for a home whose Claude
    // Code was never enabled.
    await expect(
      chapter.getByRole('button', { name: 'Continue', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByTestId('first-run-engines-retry')).toBeVisible();

    // Going on WITHOUT the engine that failed ends the run as DEFERRED, the
    // questions are never reached, and Home keeps offering the chapter.
    await page.getByTestId('first-run-engines-give-up').click();
    await expect(chapter).toHaveCount(0);
    await expect(page.getByTestId('first-run-about-you')).toHaveCount(0);
    await expect
      .poll(() => firstRunWrites(configWrites).map((record) => record.status))
      .toEqual(['skipped']);
    await expect(page.getByTestId('first-run-home-card')).toBeVisible();
  });

  test('retrying a failed engine until it lands is what completes the run', async ({
    page,
  }) => {
    // The other half of H1: the guard must not be satisfied by never
    // completing anything. The first attempt fails, the retry succeeds, and
    // only then does the run reach the questions and record `completed`.
    await patchExternalEngines(page, ENGINE_MIX);
    await pinAgentCatalog(page);
    const configWrites = await pinFirstRun(page, { status: 'pending' });
    let attempt = 0;
    await page.route(
      (url) => url.pathname.endsWith(MATERIALIZE_ENGINE_PATH_SUFFIX),
      async (route) => {
        const request = route.request();
        if (request.method() !== 'POST') {
          await route.fallback();
          return;
        }
        const body = request.postDataJSON() as MaterializeEngineBody;
        if (body.engineId === 'claude') {
          attempt += 1;
          if (attempt === 1) {
            await route.fulfill({
              status: 400,
              contentType: 'application/json',
              body: JSON.stringify({ success: false, error: 'not ready yet' }),
            });
            return;
          }
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              slug: `${body.engineId}-agent`,
              name: `${body.engineId} Agent`,
            },
            created: true,
          }),
        });
      },
    );

    await pinTelemetryDisclosure(page, { acknowledged: true });
    await page.goto('/');
    const chapter = page.getByTestId('first-run-engines');
    await expect(chapter).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Set up 3' }).click();

    await expect(page.getByTestId('first-run-engines-report')).toBeVisible();
    await page.getByTestId('first-run-engines-retry').click();

    await expect(page.getByTestId('first-run-about-you')).toBeVisible();
    await startFirstChat(page);
    await expect
      .poll(() => firstRunWrites(configWrites).map((record) => record.status))
      .toEqual(['completed']);
  });

  test('unticking an engine excludes it, and a clean batch advances without a report', async ({
    page,
  }) => {
    await patchExternalEngines(page, ENGINE_MIX);
    await pinAgentCatalog(page);
    const configWrites = await pinFirstRun(page, { status: 'pending' });
    const posted = await recordEngineMaterializations(page, { claude: {} });

    await pinTelemetryDisclosure(page, { acknowledged: true });
    await page.goto('/');
    const chapter = page.getByTestId('first-run-engines');
    await expect(chapter).toBeVisible({ timeout: 20_000 });

    // Click the LABEL, not the input: the shared `Checkbox` keeps its real
    // input visually hidden (`.cb__input` is clipped to 1px in Checkbox.css)
    // and paints `.cb__box`, so Playwright's `uncheck` — which requires the
    // input itself to be visible — times out. `toBeChecked` still reads the
    // real input, which is what the state assertions below use.
    await engineRow(page, 'codex').locator('label.cb').click();
    await engineRow(page, 'muse').locator('label.cb').click();
    await expect(engineRow(page, 'codex').locator('input')).not.toBeChecked();
    await expect(engineRow(page, 'muse').locator('input')).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Set up 1' })).toBeVisible();
    await page.getByRole('button', { name: 'Set up 1' }).click();

    // Nothing to acknowledge: the run moves on by itself.
    await expect(chapter).toHaveCount(0);
    await expect(page.getByTestId('first-run-engines-report')).toHaveCount(0);
    await expect(page.getByTestId('first-run-about-you')).toBeVisible();
    expect(posted.map((body) => body.engineId)).toEqual(['claude']);

    // Finishing the questions is what completes the run, and it is the ONLY
    // thing that writes `completed`.
    await startFirstChat(page);
    await expect(page.getByTestId('first-run-about-you')).toHaveCount(0);
    await expect
      .poll(() => firstRunWrites(configWrites).map((r) => r.status))
      .toEqual(['completed']);
    await expect(page.getByTestId('first-run-home-card')).toHaveCount(0);
  });

  test('an engine the server had already materialised reads as already set up', async ({
    page,
  }) => {
    // `POST /agents/materialize-engine` is find-or-create, so a home that
    // already has the Agent answers `created: false`. That is a SUCCESS — the
    // engine the user asked for exists — and the report may not claim this run
    // made it. Nothing else in this suite reads the `created` field off the
    // wire; the unit tests all mock the mutation.
    await patchExternalEngines(page, ENGINE_MIX);
    await pinAgentCatalog(page);
    const configWrites = await pinFirstRun(page, { status: 'pending' });
    await recordEngineMaterializations(page, {
      claude: { created: false, agentName: 'Claude Code' },
      codex: { error: 'Codex connection is not ready.' },
      muse: { agentName: 'Muse Code Agent' },
    });

    await pinTelemetryDisclosure(page, { acknowledged: true });
    await page.goto('/');
    const chapter = page.getByTestId('first-run-engines');
    await expect(chapter).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Set up 3' }).click();

    const items = page
      .getByTestId('first-run-engines-report')
      .locator('.first-run-engines__report-item');
    await expect(items.nth(0)).toHaveAttribute('data-status', 'existing');
    await expect(items.nth(0)).toHaveText(
      'Claude Code: already set up as “Claude Code”.',
    );
    await expect(chapter).toContainText(
      '1 set up · 1 already set up · 1 could not be set up.',
    );

    // And it is not in the failed set: the run's only blocker is Codex, so a
    // retry is offered for that one and the give-up exit still defers.
    await page.getByTestId('first-run-engines-give-up').click();
    await expect
      .poll(() => firstRunWrites(configWrites).map((r) => r.status))
      .toEqual(['skipped']);
  });

  test('"Not now" creates nothing, writes the deferral, and leaves a Home card', async ({
    page,
  }, testInfo) => {
    await patchExternalEngines(page, ENGINE_MIX);
    await pinAgentCatalog(page);
    const configWrites = await pinFirstRun(page, { status: 'pending' });
    const posted = await recordEngineMaterializations(page, {});

    await pinTelemetryDisclosure(page, { acknowledged: true });
    await page.goto('/');
    const chapter = page.getByTestId('first-run-engines');
    await expect(chapter).toBeVisible({ timeout: 20_000 });
    await chapter.getByRole('button', { name: 'Not now' }).click();

    await expect(chapter).toHaveCount(0);
    expect(posted).toEqual([]);
    await expect
      .poll(() => firstRunWrites(configWrites).map((r) => r.status))
      .toEqual(['skipped']);

    // The card is the durable way back in — in the page, scrolling with Home,
    // occluding nothing.
    const card = page.getByTestId('first-run-home-card');
    await expect(card).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('first-run-home-card.png'),
      fullPage: false,
    });
    await card.getByRole('button', { name: 'Set up Station' }).click();
    await expect(chapter).toBeVisible();
  });

  test('a deferred home does not re-open the chapter on the next load', async ({
    page,
  }) => {
    await patchExternalEngines(page, ENGINE_MIX);
    await pinAgentCatalog(page);
    await pinFirstRun(page, {
      status: 'skipped',
      skippedAt: '2026-01-01T00:00:00.000Z',
    });

    await pinTelemetryDisclosure(page, { acknowledged: true });
    await page.goto('/');
    await expect(page.getByTestId('first-run-home-card')).toBeVisible({
      timeout: 20_000,
    });
    // Given ten seconds — twice the delay the audit measured the old card
    // ambushing at — nothing opens by itself.
    await page.waitForTimeout(10_000);
    await expect(page.getByTestId('first-run-engines')).toHaveCount(0);
  });

  test('a completed home is offered nothing, on Home or anywhere else', async ({
    page,
  }) => {
    await patchExternalEngines(page, ENGINE_MIX);
    await pinAgentCatalog(page);
    await pinFirstRun(page, {
      status: 'completed',
      completedAt: '2026-01-01T00:00:00.000Z',
    });

    await pinTelemetryDisclosure(page, { acknowledged: true });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('first-run-home-card')).toHaveCount(0);
    await expect(page.getByTestId('first-run-engines')).toHaveCount(0);
  });

  test('the chapter never renders on a route that is not Home', async ({
    page,
  }) => {
    // SHELL-12's first complaint: the old card appeared on `/schedule`,
    // `/guidance` and `/notifications` and occluded content it did not own.
    // It cannot now, because it is mounted by the Home route itself.
    await patchExternalEngines(page, ENGINE_MIX);
    await pinAgentCatalog(page);
    await pinFirstRun(page, { status: 'pending' });

    await pinTelemetryDisclosure(page, { acknowledged: true });
    await page.goto('/agents');
    await page.waitForTimeout(10_000);
    await expect(page.getByTestId('first-run-engines')).toHaveCount(0);
    await expect(page.getByTestId('first-run-home-card')).toHaveCount(0);
  });

  test('the connect launcher goes first, and the chapter opens once it is resolved', async ({
    page,
  }, testInfo) => {
    // The one thing the launcher still decides: WHEN, within this page load,
    // an already-decided run opens. `firstRun` is `pending` throughout, so the
    // run is never in question — stacking a second overlay on the launcher's
    // own full screen is what is being avoided (`ProjectNewViewGate` suppresses
    // its modal for the same reason).
    await patchExternalEngines(page, ENGINE_MIX_NOTHING_READY);
    await pinAgentCatalog(page);
    await pinFirstRun(page, { status: 'pending' });
    const posted = await recordEngineMaterializations(page, {});

    await pinTelemetryDisclosure(page, { acknowledged: true });
    await page.goto('/');
    await expect(page.getByTestId('setup-launcher')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('first-run-engines')).toHaveCount(0);
    await page.getByRole('button', { name: 'Continue Without Setup' }).click();

    const chapter = page.getByTestId('first-run-engines');
    await expect(chapter).toBeVisible({ timeout: 20_000 });
    await expect(engineRow(page, 'claude-code')).toHaveAttribute(
      'data-state',
      'blocked',
    );
    await expect(engineRow(page, 'claude-code')).toContainText(
      'Sign in to Claude Code to use it here.',
    );
    await expect(
      chapter.getByRole('button', { name: 'Continue' }),
    ).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath('engines-after-connect.png'),
      fullPage: false,
    });

    // Nothing is offered, so confirming this chapter creates nothing and the
    // run moves on rather than stalling on a step with no action.
    await chapter.getByRole('button', { name: 'Continue' }).click();
    await expect(chapter).toHaveCount(0);
    await expect(page.getByTestId('first-run-about-you')).toBeVisible();
    expect(posted).toEqual([]);
  });
});

/**
 * WHERE THE USAGE-TELEMETRY DISCLOSURE RENDERS.
 *
 * `OnboardingGate` mounts `<UsageTelemetryDisclosure firstRun />` after its
 * children, so wherever it renders it renders on top. On a fresh home that put
 * it over this chapter — two modals on the first screen a person ever sees,
 * with the chapter unreadable underneath (reproduced live, ../a3-fresh-home.png)
 * — and on `origin/main` it lands over the setup launcher, which is why these
 * specs used to have to answer it before they could click anything.
 *
 * The disclosure belongs to onboarding: on a `pending` home it is the run's
 * first step and the standalone modal does not exist; everywhere else the modal
 * is what shipped, waiting its turn behind the launcher and the chapter.
 */
test.describe('First-run usage-telemetry disclosure placement', () => {
  const disclosureStep = (page: Page) =>
    page.getByTestId('first-run-disclosure');
  const standaloneModal = (page: Page) =>
    page.getByTestId('usage-telemetry-disclosure-modal');

  test('a pending home opens the run AT the disclosure, with no second modal', async ({
    page,
  }, testInfo) => {
    await patchExternalEngines(page, ENGINE_MIX);
    await pinAgentCatalog(page);
    await pinFirstRun(page, { status: 'pending' });
    const acknowledgements = await pinTelemetryDisclosure(page, {
      acknowledged: false,
    });

    await page.goto('/');
    await expect(disclosureStep(page)).toBeVisible({ timeout: 20_000 });
    // The inventory itself, in the chapter's own dialog — same copy as the
    // standalone modal, because it is the same component.
    await expect(page.getByText('What Station sends')).toBeVisible();
    await expect(disclosureStep(page)).toContainText('station_started');
    await expect(page.getByText('Step 1 of 3')).toBeVisible();
    // THE DEFECT THIS CLOSES: exactly one overlay, and the engines step is
    // behind the disclosure rather than beside it.
    await expect(standaloneModal(page)).toHaveCount(0);
    await expect(page.locator('.responsive-surface-overlay')).toHaveCount(1);
    await expect(page.getByTestId('first-run-engines')).toHaveCount(0);

    await page.screenshot({
      path: testInfo.outputPath('disclosure-step.png'),
      fullPage: false,
    });

    await disclosureStep(page)
      .getByRole('button', { name: 'I understand' })
      .click();

    // The receipt is written through the same endpoint the modal uses, and
    // only then does the run move on.
    await expect.poll(() => acknowledgements.length).toBe(1);
    await expect(page.getByTestId('first-run-engines')).toBeVisible();
    await expect(page.getByText('Step 2 of 3')).toBeVisible();
    await expect(disclosureStep(page)).toHaveCount(0);
    await expect(standaloneModal(page)).toHaveCount(0);
  });

  test('"Not now" on the disclosure writes no receipt and still moves the run on', async ({
    page,
  }) => {
    await patchExternalEngines(page, ENGINE_MIX);
    await pinAgentCatalog(page);
    const configWrites = await pinFirstRun(page, { status: 'pending' });
    const acknowledgements = await pinTelemetryDisclosure(page, {
      acknowledged: false,
    });

    await page.goto('/');
    await expect(disclosureStep(page)).toBeVisible({ timeout: 20_000 });
    await disclosureStep(page).getByRole('button', { name: 'Not now' }).click();

    await expect(page.getByTestId('first-run-engines')).toBeVisible();
    await expect(page.getByText('Step 2 of 3')).toBeVisible();
    expect(acknowledgements).toEqual([]);
    // And declining the disclosure is not declining the RUN: nothing was
    // recorded about first run either.
    expect(firstRunWrites(configWrites)).toEqual([]);

    // The standalone modal stays down for this page — the same page-lifetime
    // dismissal its own "Not now" performs — and re-offers on the next load,
    // which is where a home that is no longer `pending` gets asked again.
    await page.getByRole('button', { name: 'Close setup' }).click();
    await expect(standaloneModal(page)).toHaveCount(0);
  });

  test('a pending home is offered no modal anywhere, not just on Home', async ({
    page,
  }) => {
    // THE DISCRIMINATING CASE for the `pending` rule: wherever the chapter
    // IS on screen the modal is already
    // withheld by the one-overlay rule, so removing the `pending` rule changes
    // nothing a Home-only test can see. Off Home the chapter is unmounted and
    // the launcher is not wanted (this mix is ready), so the modal would take
    // the screen on a home that has not been through its first run yet.
    await patchExternalEngines(page, ENGINE_MIX);
    await pinAgentCatalog(page);
    await pinFirstRun(page, { status: 'pending' });
    await pinTelemetryDisclosure(page, { acknowledged: false });

    await page.goto('/agents');
    // A CSS selector, not a role query: a modal that covers the route
    // aria-hides everything beneath it, so a role-based "the page rendered"
    // gate reddens under the very defect this case exists to catch and never
    // reaches the assertions below. It is also what proves the three absences below
    // are not a blank page reading as a pass. Waiting on the disclosure
    // request instead does not work either: when the rule holds, that request
    // is never made.
    await page.waitForSelector('.split-pane', { timeout: 20_000 });
    await page.waitForTimeout(3_000);

    await expect(standaloneModal(page)).toHaveCount(0);
    await expect(page.getByTestId('first-run-disclosure')).toHaveCount(0);
    await expect(page.getByTestId('first-run-engines')).toHaveCount(0);
  });

  test('an upgraded home still gets the standalone modal', async ({ page }) => {
    // No `firstRun` record at all: a home that predates the field, which is
    // the population the modal shipped for. Nothing about it changes.
    await patchExternalEngines(page, ENGINE_MIX);
    await pinAgentCatalog(page);
    await pinFirstRun(page, null);
    await pinTelemetryDisclosure(page, { acknowledged: false });

    await page.goto('/');
    await expect(standaloneModal(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('What Station sends')).toBeVisible();
    // Chat is ready in this mix, so the launcher is not wanted; the point is
    // that the modal is the ONLY overlay, and the chapter is not offered.
    await expect(page.getByTestId('setup-launcher')).toHaveCount(0);
    await expect(page.getByTestId('first-run-engines')).toHaveCount(0);
    await expect(page.getByTestId('first-run-home-card')).toHaveCount(0);
  });

  test('the modal waits for the setup launcher rather than covering it', async ({
    page,
  }) => {
    // The behaviour on `origin/main` that made these specs answer it first:
    // the modal rendered over the launcher and intercepted every click
    // underneath. An upgraded home whose Station still needs connecting gets
    // the launcher, alone.
    await patchExternalEngines(page, ENGINE_MIX_NOTHING_READY);
    await pinAgentCatalog(page);
    await pinFirstRun(page, null);
    await pinTelemetryDisclosure(page, { acknowledged: false });

    await page.goto('/');
    await expect(page.getByTestId('setup-launcher')).toBeVisible({
      timeout: 20_000,
    });
    await expect(standaloneModal(page)).toHaveCount(0);

    // And it takes the screen the moment the launcher is answered.
    await page.getByRole('button', { name: 'Continue Without Setup' }).click();
    await expect(standaloneModal(page)).toBeVisible();
  });

  test('a chapter re-opened from Home’s card suppresses the modal while it is up', async ({
    page,
  }) => {
    // A deferred home carries BOTH — the card offers the run, and the modal is
    // mounted because the home is not `pending` — so opening the run from the
    // card must not leave the modal stacked on top of it.
    await patchExternalEngines(page, ENGINE_MIX);
    await pinAgentCatalog(page);
    await pinFirstRun(page, {
      status: 'skipped',
      skippedAt: '2026-01-01T00:00:00.000Z',
    });
    await pinTelemetryDisclosure(page, { acknowledged: true });

    await page.goto('/');
    await expect(page.getByTestId('first-run-home-card')).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole('button', { name: 'Set up Station' }).click();

    await expect(page.getByTestId('first-run-engines')).toBeVisible();
    await expect(standaloneModal(page)).toHaveCount(0);
    await expect(page.locator('.responsive-surface-overlay')).toHaveCount(1);
    // An acknowledged home has nothing to disclose, so this run is two steps
    // and says two, rather than promising a step that is not coming.
    await expect(page.getByText('Step 1 of 2')).toBeVisible();
  });
});

for (const viewport of [
  { label: 'desktop', width: 1280, height: 900 },
  { label: 'mobile', width: 390, height: 844 },
]) {
  test(`first useful chat completion on ${viewport.label}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await patchExternalEngines(page, []);
    await pinAgentCatalog(page);
    const writes = await pinFirstRun(page, { status: 'pending' });
    await pinTelemetryDisclosure(page, { acknowledged: true });
    await page.goto('/');
    // This fixture has no ready engine: explicitly leave the prerequisite
    // launcher before the independent first-run chapter can open.
    await page
      .getByRole('button', { name: 'Continue Without Setup', exact: true })
      .click();
    const engines = page.getByTestId('first-run-engines');
    await expect(engines).toBeVisible({ timeout: 20_000 });
    await engines
      .getByRole('button', { name: 'Continue', exact: true })
      .click();
    await expect(
      page.locator(
        '[data-testid="first-run-about-you"], [data-testid="engine-picker"]',
      ),
    ).toBeVisible();
    if (await page.getByTestId('engine-picker').isVisible()) {
      await page.getByRole('button', { name: 'Dismiss engine picker' }).click();
    }
    const questions = page.getByTestId('first-run-about-you');
    await expect(questions).toBeVisible();
    await questions
      .getByRole('button', { name: 'Start your first chat' })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`first-chat-choice-${viewport.label}.png`),
      animations: 'disabled',
    });
    await startFirstChat(page);
    await expect
      .poll(() => firstRunWrites(writes).map((record) => record.status))
      .toEqual(['completed']);
    await page.screenshot({
      path: testInfo.outputPath(`first-chat-picker-${viewport.label}.png`),
      animations: 'disabled',
    });
  });
}

async function setupReturnFixture(page: Page) {
  let ready = false;
  let deletedProject = false;
  const projects = [
    {
      slug: 'setup-alpha',
      name: 'Setup Alpha',
      workingDirectory: '/fixture/alpha',
      layoutCount: 0,
    },
    {
      slug: 'setup-beta',
      name: 'Setup Beta',
      workingDirectory: '/fixture/beta',
      layoutCount: 0,
    },
  ];
  await patchExternalEngines(page, ENGINE_MIX);
  await pinFirstRun(page, {
    status: 'completed',
    completedAt: '2026-09-04T00:00:00Z',
  });
  await pinTelemetryDisclosure(page, { acknowledged: true });
  await page.route(
    (url) => url.pathname === AGENTS_PATH,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            {
              slug: 'setup-assistant',
              name: 'Setup Assistant',
              available: ready,
              model: 'fixture-model',
              modelOptions: [{ id: 'fixture-model', name: 'Fixture Model' }],
              ...(!ready
                ? {
                    unavailableReason: 'Connect a Model to continue',
                    unavailableFix: { kind: 'model-connection' },
                  }
                : {}),
            },
          ],
        }),
      }),
  );
  await page.route(
    (url) => url.pathname === '/api/projects',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: projects.filter(
            (project) => !deletedProject || project.slug !== 'setup-beta',
          ),
        }),
      }),
  );
  await page.route(
    (url) => /^\/api\/projects\/setup-(alpha|beta)$/.test(url.pathname),
    (route) => {
      const slug = new URL(route.request().url()).pathname.split('/').pop();
      const missing = deletedProject && slug === 'setup-beta';
      return route.fulfill({
        status: missing ? 404 : 200,
        contentType: 'application/json',
        body: JSON.stringify(
          missing
            ? { success: false, error: 'Project no longer available' }
            : {
                success: true,
                data: {
                  ...projects.find((project) => project.slug === slug),
                  agents: ['setup-assistant'],
                },
              },
        ),
      });
    },
  );
  await page.goto('/');
  await page.evaluate(() =>
    window.dispatchEvent(new Event('station:open-new-chat')),
  );
  const modal = page.getByRole('dialog', { name: 'New Chat', exact: true });
  await expect(modal).toBeVisible();
  await modal.locator('.new-chat-modal__context-button').click();
  await page.locator('[data-context-value="setup-beta"]').click();
  await expect(
    modal.getByRole('button', { name: 'Workspace: Setup Beta' }),
  ).toBeVisible();
  return {
    modal,
    repair: () => {
      ready = true;
    },
    deleteProject: () => {
      deletedProject = true;
    },
  };
}

for (const viewport of [
  { label: 'desktop', width: 1280, height: 900 },
  { label: 'mobile', width: 390, height: 844 },
]) {
  test(`New Chat setup return preserves choices on ${viewport.label}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const fixture = await setupReturnFixture(page);
    await fixture.modal
      .getByRole('button', { name: 'Connect Setup Assistant', exact: true })
      .click();
    await expect(fixture.modal).toHaveCount(0);
    await expect(page).toHaveURL(/\/connections/);
    const returnButton = page.getByRole('button', {
      name: 'Return to New Chat',
      exact: true,
    });
    await expect(returnButton).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`setup-return-banner-${viewport.label}.png`),
      animations: 'disabled',
    });
    // The fixture models an externally completed provider setup. Returning
    // must refetch the canonical catalog rather than trust its earlier row.
    fixture.repair();
    await returnButton.click();
    await expect(fixture.modal).toHaveCSS('opacity', '1');
    await expect(
      fixture.modal.getByRole('button', { name: 'Workspace: Setup Beta' }),
    ).toBeVisible();
    await expect(
      fixture.modal.locator('[data-agent-slug="setup-assistant"]'),
    ).toBeEnabled();
    await expect(
      page.getByRole('button', { name: 'Return to New Chat', exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`setup-return-picker-${viewport.label}.png`),
      animations: 'disabled',
    });
  });
}

test('New Chat setup return supports Back, cancellation and deleted Project disclosure', async ({
  page,
}) => {
  const fixture = await setupReturnFixture(page);
  await fixture.modal
    .getByRole('button', { name: 'Connect Setup Assistant', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Return to New Chat', exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(fixture.modal).toBeVisible();
  await expect(
    fixture.modal.getByRole('button', { name: 'Workspace: Setup Beta' }),
  ).toBeVisible();
  await fixture.modal
    .getByRole('button', { name: 'Connect Setup Assistant', exact: true })
    .click();
  fixture.deleteProject();
  await page
    .getByRole('button', { name: 'Return to New Chat', exact: true })
    .click();
  await expect(fixture.modal.getByRole('alert')).toContainText(
    'workspace you selected is no longer available',
  );
  await expect(
    fixture.modal.getByRole('button', { name: 'Workspace: Select workspace' }),
  ).toBeVisible();
  await fixture.modal
    .getByRole('button', { name: 'Connect Setup Assistant', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Cancel return', exact: true })
    .click();
  await expect(fixture.modal).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Return to New Chat', exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    window.dispatchEvent(new Event('station:open-new-chat')),
  );
  await expect(fixture.modal).toBeVisible();
  await expect(
    fixture.modal.getByRole('button', { name: 'Workspace: No workspace' }),
  ).toBeVisible();
});
