import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  type Browser,
  type BrowserContext,
  test as base,
  expect,
  type Page,
} from '@playwright/test';
import {
  createNotVerifiedReport,
  performanceReportReceipt,
  referenceFixtureSelection,
  referenceHostGate,
  sweepReferenceFixtures,
} from '../scripts/interactive-workspace-performance.mjs';
import {
  bridgeEvidence,
  prepareRemoteApplyBrief,
  typeRemoteApplyBrief,
} from '../scripts/interactive-workspace-playwright-adapter.mjs';
import { executeOwnedProcess } from '../scripts/lib/owned-process.mjs';
import { INTERACTIVE_WORKSPACE_REFERENCE_TIMEOUT_MS } from '../scripts/verification-lanes.mjs';
import { WORK_BOARD_200_PIN_MIX } from '../src-ui/src/performance/work-board-performance-bridge';
import {
  e2eOperatorAuthorizationHeaders,
  readE2EOperatorCredential,
} from './helpers/e2e-operator-credential';
import {
  allocateLiveStation,
  apiJson,
  createProject,
  createRepository,
  createTaskFromProject,
  type LiveStation,
  pairBrowserDevice,
  startStation,
  stopStation,
} from './helpers/live-station-task';
import { referenceBrowserProvisioningOwner } from './helpers/reference-browser-lifecycle';

const IMPLEMENTED_FIXTURES = [
  'local-input-apply',
  'remote-apply',
  'synthetic-collaboration',
  'open-100k-lines',
  'reconnect-10k-operations',
] as const;
const ONE_HOUR_FIXTURE = 'long-session-bounded-growth';
const WORK_BOARD_FIXTURES = [
  'work-board-200-pins-v1',
  'work-board-one-hour-v1',
] as const;
const ONE_HOUR_REFERENCE_ENABLED =
  process.env.STATION_PERFORMANCE_ONE_HOUR_REFERENCE === '1';
const WORK_BOARD_REFERENCE_ENABLED =
  process.env.STATION_PERFORMANCE_WORK_BOARD_REFERENCE === '1';
const ONE_HOUR_REFERENCE_TIMEOUT_MS = 75 * 60 * 1000;
const WORK_BOARD_ONE_HOUR_REFERENCE_TIMEOUT_MS = 65 * 60 * 1000;

function isImplementedFixture(fixtureId: string): boolean {
  return (
    IMPLEMENTED_FIXTURES.includes(
      fixtureId as (typeof IMPLEMENTED_FIXTURES)[number],
    ) ||
    (ONE_HOUR_REFERENCE_ENABLED && fixtureId === ONE_HOUR_FIXTURE) ||
    (WORK_BOARD_REFERENCE_ENABLED &&
      WORK_BOARD_FIXTURES.includes(
        fixtureId as (typeof WORK_BOARD_FIXTURES)[number],
      ))
  );
}

function isWorkBoardFixture(fixtureId: string): boolean {
  return WORK_BOARD_FIXTURES.includes(
    fixtureId as (typeof WORK_BOARD_FIXTURES)[number],
  );
}

interface FixtureConfig {
  readonly id: string;
}

interface PerformanceConfig {
  readonly sampling: { readonly warmups: number; readonly samples: number };
  readonly fixtures: readonly FixtureConfig[];
  readonly [key: string]: unknown;
}

interface FixtureReport {
  readonly run: {
    readonly adapter?: string;
    readonly generatedAt: string;
    readonly provenance: {
      readonly metadata?: {
        readonly platform: string;
        readonly revision: string;
        readonly build: unknown;
        readonly [key: string]: unknown;
      };
      readonly [key: string]: unknown;
    };
    readonly observations: ReadonlyArray<{
      readonly fixtureId: string;
      readonly status?: string;
      readonly reasonCodes?: readonly string[];
      readonly measurements?: readonly unknown[];
      readonly [key: string]: unknown;
    }>;
  };
}

interface ProvisionedFixture {
  readonly live: LiveStation;
  readonly report: FixtureReport;
  readonly exitCode: number;
}

type SpatialBoardSeed = { readonly revision: number };

const DEFAULT_CONFIG_PATH =
  'scripts/fixtures/interactive-workspace/performance-contract.json';

/**
 * #577: decided once, at load, before any fixture exists. On a host that
 * cannot produce reference evidence the bridge test is skipped before
 * Playwright sets up its `browser` fixture, so no Station is provisioned and
 * no browser is launched; the gate test below emits the NOT_VERIFIED receipt
 * that skipped run stands for.
 */
const config: PerformanceConfig = referenceFixtureSelection(
  JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf8')) as PerformanceConfig,
);
const HOST_GATE = referenceHostGate(config);

function retainReport(report: unknown): void {
  const output = process.env.STATION_PERFORMANCE_REPORT_OUTPUT;
  if (!output) return;
  mkdirSync(dirname(output), { recursive: true });
  const staged = `${output}.pending`;
  writeFileSync(staged, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(staged, output);
}

interface OwnedExecution {
  readonly completion: Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>;
  terminate(): Promise<void>;
}

/**
 * What a run has started and not yet released: nested Station daemons and the
 * evaluator's process tree (evaluator, adapter, measured browser). A killed
 * run used to leave both behind (#577), because the test body's `finally`
 * never runs when Playwright interrupts or abandons a test.
 */
interface ReferenceOwnership {
  readonly stations: Set<LiveStation>;
  evaluator?: OwnedExecution;
}

async function releaseStation(
  owner: ReferenceOwnership,
  live: LiveStation,
): Promise<void> {
  try {
    await stopStation(live);
  } finally {
    owner.stations.delete(live);
  }
}

const test = base.extend<{ referenceOwnership: ReferenceOwnership }>({
  // Fixture teardown, unlike the test body's `finally`, also runs when
  // Playwright stops a test early: a timeout, an interrupted run (Ctrl-C), or
  // a worker whose runner went away (its graceful close tears fixtures down).
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring
  referenceOwnership: async ({}, use) => {
    const owner: ReferenceOwnership = { stations: new Set() };
    try {
      await use(owner);
    } finally {
      // The evaluator owns a process group (POSIX) or a taskkill-able tree
      // (Windows), so this reaches the adapter and its browser too.
      await owner.evaluator?.terminate().catch(() => {});
      for (const live of [...owner.stations]) {
        await releaseStation(owner, live).catch(() => {});
        rmSync(live.home, { recursive: true, force: true });
      }
    }
  },
});

/**
 * Runs the reference evaluator as an owned process tree and returns its exit
 * status, or -1 when it was killed or could not start. `timeoutMs` terminates
 * the whole tree, not just the evaluator.
 */
async function runOwnedEvaluator(
  owner: ReferenceOwnership,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<number> {
  const execution = executeOwnedProcess(
    process.execPath,
    args,
    undefined,
    'interactive-workspace performance evaluator',
    { cwd: process.cwd(), env, stdio: 'ignore' },
  ) as OwnedExecution;
  owner.evaluator = execution;
  const timer = setTimeout(() => {
    void execution.terminate().catch(() => {});
  }, timeoutMs);
  try {
    const result = await execution.completion;
    if (result.error) return -1;
    return typeof result.status === 'number' ? result.status : -1;
  } finally {
    clearTimeout(timer);
    owner.evaluator = undefined;
  }
}

async function seedAndOpenWorkBoard(
  page: Page,
  live: LiveStation,
  projectSlug: string,
): Promise<string> {
  const project = await apiJson<{
    success: boolean;
    data?: { id?: string };
  }>(page, `/api/projects/${encodeURIComponent(projectSlug)}`);
  if (!project.success || !project.data?.id)
    throw new Error('Work Board Project name is unavailable');
  let revision = (
    await apiJson<{ success: boolean; data?: SpatialBoardSeed }>(
      page,
      '/api/spatial-board',
    )
  ).data?.revision;
  if (!Number.isSafeInteger(revision))
    throw new Error('Work Board initial revision is unavailable');
  for (const [index, fixturePin] of WORK_BOARD_200_PIN_MIX.entries()) {
    const result = await apiJson<{
      success: boolean;
      data?: SpatialBoardSeed;
    }>(page, '/api/spatial-board/pins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: revision,
        pin: {
          id: `performance-board-pin-${index + 1}`,
          reference: fixturePin.reference,
          x: (index % 20) * 120,
          y: Math.floor(index / 20) * 100,
          width: 100,
          height: 80,
          order: index,
        },
      }),
    });
    if (!result.success || !Number.isSafeInteger(result.data?.revision))
      throw new Error(`Work Board fixture pin ${index + 1} was not persisted`);
    revision = result.data!.revision;
  }
  await page.goto(`${live.ui}/projects/${encodeURIComponent(projectSlug)}`);
  await page.getByRole('button', { name: /Add pane/i }).click();
  const picker = page.getByRole('dialog', { name: 'Add workspace pane' });
  await expect(picker).toBeVisible({ timeout: 20_000 });
  await picker.getByRole('button', { name: /Open Work Board/i }).click();
  await expect(
    page.getByRole('region', { name: 'Personal Work Board' }),
  ).toBeVisible({ timeout: 20_000 });
  const target = new URL(page.url());
  target.searchParams.set(
    'station-performance-reference',
    'interactive-workspace-v3',
  );
  return target.href;
}

function safeFixtureName(fixtureId: string): string {
  return fixtureId.replaceAll(/[^a-z0-9-]/g, '-').slice(0, 48);
}

/**
 * Telemetry consent may appear after bootstrap navigation. A locator handler
 * runs before each following UI action, so fixture provisioning cannot race a
 * late modal and accidentally exercise the Home page instead of the Task room.
 *
 * Two surfaces carry this dialog name. The standalone disclosure offers "Not
 * now"; Home's first-run chapter, whose disclosure step has the same title,
 * offers only its header's "Close setup" — both defer. Clicking "Not now"
 * alone waited forever on the chapter, blocking every later action until the
 * branch-label wait expired and the context closed under the handler
 * (Windows reference run 35624233388).
 */
async function installTelemetryDialogDismissal(
  page: Page,
): Promise<() => void> {
  const dialog = page.getByRole('dialog', { name: 'What Station sends' });
  await page.addLocatorHandler(
    dialog,
    async () => {
      await dialog
        .getByRole('button', { name: /^(Not now|Close setup)$/ })
        .click();
    },
    { noWaitAfter: true },
  );
  return () => page.removeLocatorHandler(dialog);
}

/**
 * Record this fresh home's first-run decision before any page loads, so the
 * provisioning browser never mounts Home's first-run chapter.
 *
 * The chapter is a modal with a history layer. When the fixture creates the
 * home's first project, `/` briefly swaps Home for its pending skeleton while
 * that project's layouts load (`resolveHomeSurface`). That unmounts the
 * chapter, and its dialog-history cleanup calls `history.back()`. If that
 * lands while `createTaskFromProject`'s `goto('/projects/<slug>')` is still in
 * flight, the traversal cancels the navigation: `goto` resolves with no
 * response and the page stays on Home. That is what happened to fixture 5 of
 * Windows reference run 35865166445, and it reproduced locally at about 1 in 6.
 *
 * Deferring the run writes the same record as the chapter's own "Close setup".
 * A deferred home then offers the usage-telemetry disclosure on every route,
 * including the Task room the evaluator measures. The snooze below is the
 * record the disclosure's own "Not now" writes, and it reaches the evaluator
 * through the saved storage state. The locator handler stays as a backstop.
 */
async function settleFirstRunBeforeBrowsing(
  live: LiveStation,
  context: BrowserContext,
): Promise<void> {
  const headers = {
    ...e2eOperatorAuthorizationHeaders(readE2EOperatorCredential(live.home)),
    'Content-Type': 'application/json',
  };
  const decision = await fetch(`${live.api}/config/first-run`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ status: 'skipped' }),
  });
  expect(decision.status, await decision.text()).toBe(200);
  const disclosure = await fetch(`${live.api}/api/usage-telemetry/disclosure`, {
    headers,
  });
  expect(disclosure.status).toBe(200);
  const { data } = (await disclosure.json()) as {
    data: { acknowledged: boolean; inventoryRevision: string };
  };
  expect(typeof data.inventoryRevision).toBe('string');
  if (data.acknowledged) return;
  await context.addInitScript(
    ({ key, record }) => localStorage.setItem(key, JSON.stringify(record)),
    {
      key: 'station.usage-telemetry-disclosure.snoozed',
      record: {
        until: Date.now() + 7 * 24 * 60 * 60 * 1000,
        inventoryRevision: data.inventoryRevision,
      },
    },
  );
}

async function runFixtureTarget(input: {
  owner: ReferenceOwnership;
  browser: Browser;
  fixtureRoot: string;
  controlParent: string;
  fixture: FixtureConfig;
  config: PerformanceConfig;
  buildInstance?: string;
}): Promise<ProvisionedFixture> {
  const fixtureName = safeFixtureName(input.fixture.id);
  const allocated = await allocateLiveStation(
    `station-performance-${fixtureName}-home-`,
    'performance-reference',
  );
  // The allocated home crosses the nested Station CLI boundary. In
  // particular, it must not retain Windows' 8.3 temp-directory spelling:
  // libuv cannot mix it with the server's long-path watcher identity.
  expect(allocated.home).toBe(realpathSync.native(allocated.home));
  const live = input.buildInstance
    ? { ...allocated, instance: input.buildInstance }
    : allocated;
  const controlSocket =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\station-performance-${randomUUID().replaceAll('-', '')}`
      : join(input.controlParent, `${fixtureName.slice(0, 4)}.sock`);
  // A failed action can outlive its target home, which the next fixture
  // replaces. Keep the server log beside the retained measurement evidence.
  const referenceLogRoot = process.env.STATION_PERFORMANCE_REPORT_OUTPUT
    ? dirname(resolve(process.env.STATION_PERFORMANCE_REPORT_OUTPUT))
    : input.fixtureRoot;
  // Owned before it starts: `station start` launches a daemon that outlives a
  // failed readiness wait.
  input.owner.stations.add(live);
  let context: BrowserContext | undefined;
  let provisioning:
    | ReturnType<typeof referenceBrowserProvisioningOwner>
    | undefined;
  let succeeded = false;
  try {
    mkdirSync(referenceLogRoot, { recursive: true, mode: 0o700 });
    const bootstrapToken = await startStation(live, true, {
      performanceReference: true,
      logFile: join(referenceLogRoot, `${fixtureName}-station.log`),
      taskRoomControlSocket: controlSocket,
    });
    context = await input.browser.newContext();
    const page = await context.newPage();
    provisioning = referenceBrowserProvisioningOwner(
      context,
      await installTelemetryDialogDismissal(page),
    );
    await settleFirstRunBeforeBrowsing(live, context);
    // Await the app's own bootstrap exchange before any authenticated API
    // call: `goto` resolves on load, and a request that beats the exchange's
    // session cookie is refused 401 (Linux smoke-live run 35449087505, second
    // fixture: POST /api/projects answered authentication_required).
    const exchange = page.waitForResponse(
      (response) =>
        response.url().endsWith('/pairing/ui-bootstrap') &&
        response.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await page.goto(`${live.ui}/#station-ui-bootstrap=${bootstrapToken}`);
    expect((await exchange).status()).toBe(200);
    await page.evaluate(() =>
      localStorage.setItem('station:onboarding-setup-dismissed', '1'),
    );
    const repository = join(input.fixtureRoot, `workspace-${fixtureName}`);
    await createRepository(repository, 'performance-reference');
    writeFileSync(join(repository, 'README.md'), 'baseline\nchanged\n');
    await createProject(page, 'performance-reference', repository);
    const taskId = await createTaskFromProject(
      page,
      live,
      'performance-reference',
      `Performance ${fixtureName} Task`,
      repository,
      'performance-reference',
    );
    if (input.fixture.id === 'open-100k-lines')
      expect(
        await apiJson<{ success: boolean }>(
          page,
          `/api/tasks/${encodeURIComponent(taskId)}/references`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              kind: 'artifact',
              targetId: 'plain-text-100k-lines-v1.txt',
              metadata: { path: 'plain-text-100k-lines-v1.txt' },
            }),
          },
        ),
      ).toMatchObject({ success: true });
    const storageState = join(
      input.fixtureRoot,
      `${fixtureName}-storage-state.json`,
    );
    await context.storageState({ path: storageState });
    chmodSync(storageState, 0o600);
    const peerStorageState = join(
      input.fixtureRoot,
      `${fixtureName}-peer-storage-state.json`,
    );
    if (
      input.fixture.id === 'synthetic-collaboration' ||
      input.fixture.id === ONE_HOUR_FIXTURE ||
      input.fixture.id === 'reconnect-10k-operations'
    ) {
      const paired = await pairBrowserDevice(
        live,
        readE2EOperatorCredential(live.home),
        `Performance ${fixtureName} peer`,
      );
      const ownerStorage = await context.storageState();
      const peerContext = await input.browser.newContext({
        storageState: {
          ...ownerStorage,
          cookies: ownerStorage.cookies.filter(
            (cookie) =>
              cookie.name !== 'station-device' &&
              cookie.name !== '__Host-station-device',
          ),
          origins: ownerStorage.origins.map((origin) => ({
            ...origin,
            localStorage: origin.localStorage
              .filter(
                (entry) =>
                  entry.name !== 'station-connect-connections-credentials',
              )
              .map((entry) =>
                entry.name === 'station-connect-connections'
                  ? {
                      ...entry,
                      value: JSON.stringify(
                        (
                          JSON.parse(entry.value) as Array<
                            Record<string, unknown>
                          >
                        ).map((profile) => ({
                          ...profile,
                          credentialState: 'device-session',
                        })),
                      ),
                    }
                  : entry,
              ),
          })),
        },
      });
      await peerContext.addCookies([
        {
          name: 'station-device',
          value: paired.credential,
          url: live.ui,
          httpOnly: true,
          sameSite: 'Strict',
        },
      ]);
      await peerContext.storageState({ path: peerStorageState });
      await peerContext.close();
      chmodSync(peerStorageState, 0o600);
    } else {
      writeFileSync(peerStorageState, '{"cookies":[],"origins":[]}\n', {
        mode: 0o600,
      });
    }

    const configPath = join(
      input.fixtureRoot,
      `${fixtureName}-performance-contract.json`,
    );
    writeFileSync(
      configPath,
      JSON.stringify({ ...input.config, fixtures: [input.fixture] }),
    );
    const reportPath = join(input.fixtureRoot, `${fixtureName}-report.json`);
    const rawBridgePath = join(
      input.fixtureRoot,
      `${fixtureName}-raw-bridge.json`,
    );
    const target = isWorkBoardFixture(input.fixture.id)
      ? await seedAndOpenWorkBoard(page, live, 'performance-reference')
      : `${live.ui}/tasks/${encodeURIComponent(taskId)}?station-performance-reference=interactive-workspace-v3`;
    const exitCode = await provisioning.run(() =>
      runOwnedEvaluator(
        input.owner,
        [
          'scripts/interactive-workspace-performance.mjs',
          '--mode=reference',
          `--config=${configPath}`,
          `--output=${reportPath}`,
          '--json',
        ],
        {
          ...process.env,
          STATION_PERFORMANCE_UI_URL: target,
          STATION_PERFORMANCE_UI_BUILD_DIR: `dist-ui-${live.instance}`,
          STATION_PERFORMANCE_STORAGE_STATE: storageState,
          STATION_PERFORMANCE_CONTROL_SOCKET: controlSocket,
          STATION_PERFORMANCE_PEER_STORAGE_STATE: peerStorageState,
          STATION_PERFORMANCE_RETAINED_TASK_ID: taskId,
          STATION_PERFORMANCE_REMOTE_TASK_ID: taskId,
          STATION_PERFORMANCE_COLLABORATION_TASK_ID: taskId,
          STATION_PERFORMANCE_FILE_TASK_ID: taskId,
          STATION_PERFORMANCE_RAW_BRIDGE_OUTPUT: rawBridgePath,
        },
        input.fixture.id === 'work-board-one-hour-v1'
          ? WORK_BOARD_ONE_HOUR_REFERENCE_TIMEOUT_MS
          : input.fixture.id === ONE_HOUR_FIXTURE
            ? ONE_HOUR_REFERENCE_TIMEOUT_MS
            : 2_700_000,
      ),
    );
    const report = JSON.parse(
      readFileSync(reportPath, 'utf8'),
    ) as FixtureReport;
    const retainedReport = process.env.STATION_PERFORMANCE_REPORT_OUTPUT;
    if (retainedReport) {
      mkdirSync(dirname(retainedReport), { recursive: true });
      writeFileSync(
        join(dirname(retainedReport), `${fixtureName}-subset.json`),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      if (existsSync(rawBridgePath))
        writeFileSync(
          join(dirname(retainedReport), `${fixtureName}-raw-bridge.json`),
          readFileSync(rawBridgePath),
          { mode: 0o600 },
        );
    }
    if (retainedReport) {
      for (const extension of ['png', 'txt', 'json']) {
        const name = `${input.fixture.id}-failure.${extension}`;
        const diagnostic = join(dirname(rawBridgePath), name);
        if (existsSync(diagnostic))
          writeFileSync(
            join(dirname(retainedReport), name),
            readFileSync(diagnostic),
            { mode: 0o600 },
          );
      }
    }
    const receipt = performanceReportReceipt(report);
    // Artifact storage can be unavailable independently of the product run.
    // Emit a bounded, closed receipt before the platform-specific assertion so
    // a nonzero evaluator exit remains diagnosable from the job log alone.
    console.info(
      `[interactive-workspace-performance] fixture=${input.fixture.id} adapterExitCode=${exitCode} receipt=${JSON.stringify(receipt)}`,
    );
    succeeded = true;
    return { live, report, exitCode };
  } finally {
    try {
      if (provisioning) await provisioning.close();
      else await context?.close();
    } finally {
      if (!succeeded) {
        await releaseStation(input.owner, live).catch(() => {});
        rmSync(live.home, { recursive: true, force: true });
      }
    }
  }
}

test.describe('Brief driver functional controls', () => {
  test.skip(
    process.env.STATION_PERFORMANCE_BRIEF_FUNCTIONAL !== '1',
    'explicit functional browser window required',
  );
  test('Brief driver follows the mounted Plan autosave journey without a reference verdict', async ({
    browser,
    referenceOwnership,
  }) => {
    test.setTimeout(10 * 60 * 1000);
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'station-brief-driver-')),
    );
    const live = await allocateLiveStation(
      'station-brief-home-',
      'brief-driver',
    );
    referenceOwnership.stations.add(live);
    const context = await browser.newContext();
    const page = await context.newPage();
    const removeTelemetry = await installTelemetryDialogDismissal(page);
    try {
      const token = await startStation(live, true, {
        performanceReference: true,
      });
      await settleFirstRunBeforeBrowsing(live, context);
      const exchange = page.waitForResponse(
        (response) =>
          response.url().endsWith('/pairing/ui-bootstrap') &&
          response.request().method() === 'POST',
      );
      await page.goto(`${live.ui}/#station-ui-bootstrap=${token}`);
      expect((await exchange).status()).toBe(200);
      const repository = join(root, 'workspace');
      await createRepository(repository, 'brief-driver');
      await createProject(page, 'brief-driver', repository);
      const taskId = await createTaskFromProject(
        page,
        live,
        'brief-driver',
        'Brief driver Task',
        repository,
        'brief-driver',
      );
      await page.exposeBinding(
        '__stationInteractiveWorkspacePerformanceDriver',
        (_source, command) => typeRemoteApplyBrief(page, taskId, command),
      );
      await page.goto(
        `${live.ui}/tasks/${encodeURIComponent(taskId)}?station-performance-reference=interactive-workspace-v3`,
      );
      await prepareRemoteApplyBrief(page, taskId);
      const editor = page.getByRole('textbox', {
        name: 'Task brief',
        exact: true,
      });
      const before = await editor.getAttribute('data-station-working-revision');
      expect(before).toMatch(/^swsr-v[12]:[0-9a-f]{64}$/);
      const desired = `${await editor.inputValue()}0`;
      // The functional check observes autosave, never a synthetic Save button.
      const batch = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            `/api/tasks/${encodeURIComponent(taskId)}/room/batches` &&
          response.request().method() === 'POST',
      );
      const contract = JSON.parse(
        readFileSync(DEFAULT_CONFIG_PATH, 'utf8'),
      ) as PerformanceConfig;
      const [response, evidence] = await Promise.all([
        batch,
        bridgeEvidence(page, {
          ...contract,
          sampling: { warmups: 0, samples: 1 },
          fixtures: contract.fixtures.filter(
            (fixture) => fixture.id === 'remote-apply',
          ),
        }),
      ]);
      expect(evidence.observations[0]).toMatchObject({
        counts: { failures: 0, degraded: 0 },
        autosave: { debounceMs: 450, samples: [{ iteration: 0 }] },
      });
      expect(evidence.observations[0].measurements).toHaveLength(1);
      expect(response.status()).toBe(200);
      const accepted = (await response.json()).data;
      expect(accepted).toMatchObject({ kind: 'committed', text: desired });
      expect(accepted.revision).not.toBe(before);
      await expect(editor).toHaveAttribute(
        'data-station-working-revision',
        accepted.revision,
      );
      await expect(editor).toHaveValue(desired);
      await expect(
        page
          .getByRole('region', { name: 'Task room editor' })
          .getByRole('status'),
      ).toHaveText('Saved');
      await expect(
        typeRemoteApplyBrief(page, taskId, {
          iteration: 1,
          workingRevision: before,
          text: `${desired}1`,
        }),
      ).rejects.toThrow('identity or writability');
      await expect(
        typeRemoteApplyBrief(page, 'other-task', {
          iteration: 1,
          workingRevision: accepted.revision,
          text: `${desired}1`,
        }),
      ).rejects.toThrow('identity changed');
      await page
        .getByRole('button', { name: 'View brief', exact: true })
        .click();
      await expect(
        typeRemoteApplyBrief(page, taskId, {
          iteration: 1,
          workingRevision: accepted.revision,
          text: `${desired}1`,
        }),
      ).rejects.toThrow('identity or writability');
    } finally {
      removeTelemetry();
      await context.close();
      await releaseStation(referenceOwnership, live);
      rmSync(live.home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test.describe('Interactive workspace reference host gate (#577)', () => {
  test.skip(HOST_GATE.runs, 'this host can produce reference evidence');

  test('reports NOT_VERIFIED without provisioning a Station or launching a browser', () => {
    if (HOST_GATE.runs) throw new Error('unreachable: skipped above');
    const receipt = performanceReportReceipt(HOST_GATE.report);
    console.info(
      `[interactive-workspace-performance] host=${process.platform} skipped=${HOST_GATE.reason} receipt=${JSON.stringify(receipt)}`,
    );
    retainReport(HOST_GATE.report);
    expect(receipt).toMatchObject({
      status: 'NOT_VERIFIED',
      reasonCodes: ['REFERENCE_OS_MISMATCH'],
    });
  });
});

test.describe
  .serial('Interactive workspace production bridge (#2892)', () => {
    // Before the `browser` fixture: a skipped test never launches one.
    test.skip(!HOST_GATE.runs, HOST_GATE.runs ? '' : HOST_GATE.reason);
    test.beforeAll(() => {
      retainReport(
        createNotVerifiedReport(config, 'REFERENCE_FIXTURE_NOT_RUN'),
      );
    });
    test.setTimeout(
      ONE_HOUR_REFERENCE_ENABLED
        ? INTERACTIVE_WORKSPACE_REFERENCE_TIMEOUT_MS.oneHour
        : WORK_BOARD_REFERENCE_ENABLED
          ? INTERACTIVE_WORKSPACE_REFERENCE_TIMEOUT_MS.workBoard
          : INTERACTIVE_WORKSPACE_REFERENCE_TIMEOUT_MS.default,
    );

    test('executes isolated real Station targets and aggregates one build receipt', async ({
      browser,
      referenceOwnership,
    }) => {
      const fixtureRoot = realpathSync(
        mkdtempSync(join(tmpdir(), 'station-performance-bridge-')),
      );
      const controlParent =
        process.platform === 'win32'
          ? fixtureRoot
          : realpathSync(mkdtempSync(join(tmpdir(), 'station-perf-control-')));
      if (process.platform !== 'win32') chmodSync(controlParent, 0o700);
      const homes: string[] = [];
      const cleanupFailures: string[] = [];
      let active: LiveStation | undefined;
      let buildInstance: string | undefined;
      try {
        const { failures } = await sweepReferenceFixtures(config, {
          unavailableReason: (fixtureId: string) =>
            isImplementedFixture(fixtureId)
              ? undefined
              : fixtureId === ONE_HOUR_FIXTURE
                ? 'ONE_HOUR_REFERENCE_OBSERVATION_NOT_RUN'
                : 'WORK_BOARD_REFERENCE_OBSERVATION_NOT_RUN',
          retainReport,
          runFixture: async (fixture: FixtureConfig) => {
            const provisioned = await runFixtureTarget({
              owner: referenceOwnership,
              browser,
              fixtureRoot,
              controlParent,
              fixture,
              config,
              ...(buildInstance ? { buildInstance } : {}),
            });
            const previous = active;
            active = provisioned.live;
            buildInstance ??= active.instance;
            homes.push(active.home);
            if (previous) {
              // The shared instance's force start replaced the earlier target.
              referenceOwnership.stations.delete(previous);
              try {
                rmSync(previous.home, { recursive: true, force: true });
                homes.splice(homes.indexOf(previous.home), 1);
              } catch {
                cleanupFailures.push(
                  `${fixture.id}: earlier target cleanup failed`,
                );
              }
            }
            return provisioned;
          },
        });
        const issues = [...failures, ...cleanupFailures];
        if (issues.length) throw new Error(issues.join('\n'));
      } finally {
        if (active)
          await releaseStation(referenceOwnership, active).catch(() => {});
        for (const home of homes)
          rmSync(home, { recursive: true, force: true });
        if (process.env.STATION_PERFORMANCE_REPORT_OUTPUT) {
          rmSync(fixtureRoot, { recursive: true, force: true });
          if (controlParent !== fixtureRoot)
            rmSync(controlParent, { recursive: true, force: true });
        }
      }
    });
  });
