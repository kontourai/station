import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { type Browser, expect, type Page, test } from '@playwright/test';
import {
  evaluateInteractiveWorkspacePerformance,
  performanceReportReceipt,
  referenceEvaluatorExitFailure,
} from '../scripts/interactive-workspace-performance.mjs';
import { WORK_BOARD_200_PIN_MIX } from '../src-ui/src/performance/work-board-performance-bridge';
import { readE2EOperatorCredential } from './helpers/e2e-operator-credential';
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

const execFileAsync = promisify(execFile);
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
}

interface AggregatedReport {
  readonly run: FixtureReport['run'];
  readonly [key: string]: unknown;
}

type SpatialBoardSeed = { readonly revision: number };

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
    throw new Error('Work Board Project identity is unavailable');
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

function exactSameProvenance(
  left: FixtureReport['run']['provenance']['metadata'],
  right: FixtureReport['run']['provenance']['metadata'],
): boolean {
  if (!left || !right) return false;
  return (
    left.revision === right.revision &&
    JSON.stringify(left.build) === JSON.stringify(right.build) &&
    left.platform === right.platform
  );
}

/**
 * Telemetry consent may appear after bootstrap navigation. A locator handler
 * runs before each following UI action, so fixture provisioning cannot race a
 * late modal and accidentally exercise the Home page instead of the Task room.
 */
async function installTelemetryDialogDismissal(
  page: Page,
): Promise<() => void> {
  const dialog = page.getByRole('dialog', { name: 'What Station sends' });
  await page.addLocatorHandler(
    dialog,
    async () => {
      await dialog.getByRole('button', { name: 'Not now' }).click();
    },
    { noWaitAfter: true },
  );
  return () => page.removeLocatorHandler(dialog);
}

async function runFixtureTarget(input: {
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
  const bootstrapToken = await startStation(live, true, {
    performanceReference: true,
    taskRoomControlSocket: controlSocket,
  });
  const context = await input.browser.newContext();
  const page = await context.newPage();
  const removeTelemetryDialogHandler =
    await installTelemetryDialogDismissal(page);
  let succeeded = false;
  try {
    await page.goto(`${live.ui}/#station-ui-bootstrap=${bootstrapToken}`);
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
    let exitCode = 0;
    try {
      await execFileAsync(
        process.execPath,
        [
          'scripts/interactive-workspace-performance.mjs',
          '--mode=reference',
          `--config=${configPath}`,
          `--output=${reportPath}`,
          '--json',
        ],
        {
          cwd: process.cwd(),
          env: {
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
          timeout:
            input.fixture.id === 'work-board-one-hour-v1'
              ? WORK_BOARD_ONE_HOUR_REFERENCE_TIMEOUT_MS
              : input.fixture.id === ONE_HOUR_FIXTURE
                ? ONE_HOUR_REFERENCE_TIMEOUT_MS
                : 2_700_000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
    } catch (error) {
      exitCode =
        error && typeof error === 'object' && 'code' in error
          ? Number(error.code)
          : -1;
    }
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
    const receipt = performanceReportReceipt(report);
    // Artifact storage can be unavailable independently of the product run.
    // Emit a bounded, closed receipt before the platform-specific assertion so
    // a nonzero evaluator exit remains diagnosable from the job log alone.
    console.info(
      `[interactive-workspace-performance] fixture=${input.fixture.id} adapterExitCode=${exitCode} receipt=${JSON.stringify(receipt)}`,
    );
    // Persist parseable bounded evidence before enforcing the platform exit:
    // FAIL/NOT_VERIFIED diagnostics must survive the deliberately red Windows
    // acceptance boundary. A missing report still fails honestly at parse.
    const exitFailure = referenceEvaluatorExitFailure(
      process.platform,
      exitCode,
      input.fixture.id,
      report,
    );
    if (exitFailure) throw new Error(exitFailure);
    succeeded = true;
    return {
      live,
      report,
    };
  } finally {
    await removeTelemetryDialogHandler();
    await context.close();
    if (!succeeded) {
      await stopStation(live).catch(() => {});
      rmSync(live.home, { recursive: true, force: true });
    }
  }
}

test.describe
  .serial('Interactive workspace production bridge (#2892)', () => {
    test.setTimeout(
      ONE_HOUR_REFERENCE_ENABLED
        ? 90 * 60 * 1000
        : WORK_BOARD_REFERENCE_ENABLED
          ? 80 * 60 * 1000
          : 3_300_000,
    );

    test('executes isolated real Station targets and aggregates one build receipt', async ({
      browser,
    }) => {
      const fixtureRoot = realpathSync(
        mkdtempSync(join(tmpdir(), 'station-performance-bridge-')),
      );
      const controlParent =
        process.platform === 'win32'
          ? fixtureRoot
          : realpathSync(mkdtempSync(join(tmpdir(), 'station-perf-control-')));
      if (process.platform !== 'win32') chmodSync(controlParent, 0o700);
      const defaultConfig = JSON.parse(
        readFileSync(
          'scripts/fixtures/interactive-workspace/performance-contract.json',
          'utf8',
        ),
      ) as PerformanceConfig;
      const requestedFixtures =
        process.env.STATION_PERFORMANCE_E2E_FIXTURES?.split(',').filter(
          Boolean,
        );
      const selectedFixtureIds = requestedFixtures?.length
        ? requestedFixtures
        : defaultConfig.fixtures.map((fixture) => fixture.id);
      const requestedSamples = Number(
        process.env.STATION_PERFORMANCE_E2E_SAMPLES ?? '100',
      );
      const requestedWarmups = Number(
        process.env.STATION_PERFORMANCE_E2E_WARMUPS ??
          (requestedSamples === 100 ? '5' : '0'),
      );
      const config: PerformanceConfig = {
        ...defaultConfig,
        sampling: {
          warmups: requestedWarmups,
          samples: requestedSamples,
        },
        fixtures: defaultConfig.fixtures.filter((fixture) =>
          selectedFixtureIds.includes(fixture.id),
        ),
      };
      const reports: FixtureReport[] = [];
      const homes: string[] = [];
      let active: LiveStation | undefined;
      let buildInstance: string | undefined;
      try {
        for (const fixture of config.fixtures.filter((candidate) =>
          isImplementedFixture(candidate.id),
        )) {
          const provisioned = await runFixtureTarget({
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
          reports.push(provisioned.report);
          if (previous) {
            rmSync(previous.home, { recursive: true, force: true });
            homes.splice(homes.indexOf(previous.home), 1);
          }
        }
        if (!reports.length)
          throw new Error('No implemented performance fixture was selected');
        const first = reports[0]!;
        const metadata = first.run.provenance.metadata;
        if (!metadata)
          throw new Error('Reference adapter provenance is unavailable');
        for (const report of reports.slice(1)) {
          if (
            report.run.adapter !== first.run.adapter ||
            !exactSameProvenance(metadata, report.run.provenance.metadata)
          )
            throw new Error('Fixture targets did not share one build receipt');
        }
        const observations = reports.flatMap(
          (report) => report.run.observations,
        );
        if (
          selectedFixtureIds.includes(ONE_HOUR_FIXTURE) &&
          !ONE_HOUR_REFERENCE_ENABLED
        )
          observations.push({
            fixtureId: ONE_HOUR_FIXTURE,
            status: 'NOT_VERIFIED',
            reasonCodes: ['ONE_HOUR_REFERENCE_OBSERVATION_NOT_RUN'],
            counts: { failures: 0, degraded: 0 },
          });
        for (const fixtureId of WORK_BOARD_FIXTURES) {
          if (
            selectedFixtureIds.includes(fixtureId) &&
            !WORK_BOARD_REFERENCE_ENABLED
          )
            observations.push({
              fixtureId,
              status: 'NOT_VERIFIED',
              reasonCodes: ['WORK_BOARD_REFERENCE_OBSERVATION_NOT_RUN'],
              counts: { failures: 0, degraded: 0 },
            });
        }
        const order = new Map(
          config.fixtures.map((fixture, index) => [fixture.id, index]),
        );
        observations.sort(
          (left, right) =>
            (order.get(left.fixtureId) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(right.fixtureId) ?? Number.MAX_SAFE_INTEGER),
        );
        const generatedAt = new Date().toISOString();
        const run = {
          ...first.run,
          generatedAt,
          observations,
          provenance: first.run.provenance,
        };
        const evaluated = evaluateInteractiveWorkspacePerformance(config, run, {
          mode: 'reference',
          now: () => new Date(generatedAt),
          expectedRevision: metadata.revision,
        });
        const report = {
          ...evaluated,
          measurement: 'reference',
          run,
        } as AggregatedReport;
        const retainedReport = process.env.STATION_PERFORMANCE_REPORT_OUTPUT;
        if (retainedReport) {
          mkdirSync(dirname(retainedReport), { recursive: true });
          writeFileSync(retainedReport, `${JSON.stringify(report, null, 2)}\n`);
        }
        expect(reports).toHaveLength(
          config.fixtures.filter((candidate) =>
            isImplementedFixture(candidate.id),
          ).length,
        );
        for (const fixtureId of config.fixtures
          .map((fixture) => fixture.id)
          .filter(
            (fixtureId) =>
              selectedFixtureIds.includes(fixtureId) &&
              isImplementedFixture(fixtureId),
          )) {
          const observation = report.run.observations.find(
            (candidate) => candidate.fixtureId === fixtureId,
          );
          if (!observation?.measurements)
            throw new Error(
              `${fixtureId} was not measured: ${JSON.stringify(observation)}`,
            );
          expect(observation.measurements).toHaveLength(requestedSamples);
        }
        if (process.platform === 'win32') {
          const fixtureReports = (
            report as AggregatedReport & {
              fixtures: Array<{
                fixtureId: string;
                status: string;
                decision: string;
                counts: { failures: number; degraded: number };
                metrics: Record<string, { limits: Array<{ passed: boolean }> }>;
              }>;
            }
          ).fixtures;
          for (const fixtureId of config.fixtures
            .map((fixture) => fixture.id)
            .filter(
              (fixtureId) =>
                selectedFixtureIds.includes(fixtureId) &&
                isImplementedFixture(fixtureId),
            )) {
            const fixtureReport = fixtureReports.find(
              (candidate) => candidate.fixtureId === fixtureId,
            );
            expect(fixtureReport).toMatchObject({
              status: 'PASS',
              decision: 'keep',
              counts: { failures: 0, degraded: 0 },
            });
            expect(
              Object.values(fixtureReport?.metrics ?? {}).flatMap(
                (metric) => metric.limits,
              ),
            ).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ passed: true }),
              ]),
            );
            expect(
              Object.values(fixtureReport?.metrics ?? {})
                .flatMap((metric) => metric.limits)
                .every((limit) => limit.passed),
            ).toBe(true);
          }
        }
        if (
          selectedFixtureIds.includes(ONE_HOUR_FIXTURE) &&
          !ONE_HOUR_REFERENCE_ENABLED
        )
          expect(
            report.run.observations.find(
              (observation) => observation.fixtureId === ONE_HOUR_FIXTURE,
            ),
          ).toMatchObject({
            status: 'NOT_VERIFIED',
            reasonCodes: ['ONE_HOUR_REFERENCE_OBSERVATION_NOT_RUN'],
          });
        if (active) {
          await stopStation(active);
          rmSync(active.home, { recursive: true, force: true });
          homes.splice(homes.indexOf(active.home), 1);
          active = undefined;
        }
      } finally {
        if (active) await stopStation(active).catch(() => {});
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
