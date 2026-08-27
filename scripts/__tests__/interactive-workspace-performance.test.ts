import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNotVerifiedReport,
  evaluateInteractiveWorkspacePerformance,
  executeInteractiveWorkspaceBenchmark,
  executeReferenceStationBenchmark,
  percentiles,
  performanceReportReceipt,
  referenceAdapterDiagnostics,
  referenceEvaluatorExitFailure,
  runInteractiveWorkspacePerformance,
} from '../interactive-workspace-performance.mjs';
import {
  closedControlReason,
  closedLiveCommandDiagnostic,
  liveCommandRequestMatches,
  measure,
  normalizeAttachedStationHtml,
  peerActorIdentity,
  productionBuildReceipt,
  RECONNECT_EDITOR_READY_TIMEOUT_MS,
  RECONNECT_POOL_BATCH_SIZE,
  REFERENCE_CONTROL_SOCKET_RESPONSE_TIMEOUT_MS,
  referenceAuthContext,
} from '../interactive-workspace-playwright-adapter.mjs';
import {
  buildReceiptMatches,
  unavailableBridgeObservations,
  validateProductionBridgeEvidence,
} from '../lib/interactive-workspace-production-bridge.mjs';
import { performanceReceiptLogLines } from '../print-interactive-workspace-performance-receipts.mjs';

const configPath = resolve(
  'scripts/fixtures/interactive-workspace/performance-contract.json',
);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const roots: string[] = [];

const CHECKOUT_ACTION =
  'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5';
const SETUP_NODE_ACTION =
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020';
const RUNNER_PREFLIGHT_ACTION =
  'kontourai/.github/actions/runner-preflight@1d267a33147d1ce5925ffd1f9aa0ef2063d0d7ef';
const PHYSICAL_HOST_CAPACITY_ACTION =
  'kontourai/.github/actions/physical-host-capacity@563effe7ec559c6f4fcc6c80b3532acb71d86373';

type WorkflowStep = {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  steps?: WorkflowStep[];
};

function expectWindowsPhysicalAcceptanceStepPrefix(
  job: WorkflowJob,
  capacityName: string,
  ownerLifetimeSeconds: string,
) {
  expect(job.steps?.slice(0, 4)).toEqual([
    {
      uses: CHECKOUT_ACTION,
      with: { 'persist-credentials': false },
    },
    {
      uses: SETUP_NODE_ACTION,
      with: { 'node-version-file': '.nvmrc' },
    },
    { uses: RUNNER_PREFLIGHT_ACTION },
    {
      name: capacityName,
      uses: PHYSICAL_HOST_CAPACITY_ACTION,
      with: {
        'coordination-root': 'E:\\kontour-runner-capacity',
        'host-id': 'desktop-win',
        'capacity-units': '10',
        'lease-weight': '6',
        'timeout-seconds': '600',
        'owner-lifetime-seconds': ownerLifetimeSeconds,
      },
    },
  ]);
}
type Observation = {
  fixtureId: string;
  samples: Record<string, number[]>;
  components: Record<string, number[]>;
  counts: { failures: number; degraded: number };
  fallback?: unknown;
  sampling: { warmups: number; samples: number };
  workloads: string[];
  duration?: {
    logicalDurationMs: number;
    scaled: boolean;
  };
};
type FixtureReport = {
  fixtureId: string;
  metrics?: Record<string, unknown>;
  failures?: string[];
};

function bridgeMeasurements(fixture: any) {
  const phases = Object.keys(fixture.measurementPhases);
  return Array.from({ length: config.sampling.samples }, (_, iteration) => ({
    iteration,
    phases: Object.fromEntries(
      phases.map((phase, phaseIndex) => [
        phase,
        {
          actions: (() => {
            let timestamp = iteration * 1000 + phaseIndex * 100;
            return fixture.measurementPhases[phase].map(
              (specification: any, action: number) => {
                const start = timestamp;
                const end = start + action + 1;
                timestamp = end;
                return {
                  kind: specification.id,
                  marks: Object.fromEntries(
                    specification.marks.map((mark: string) => [
                      mark,
                      mark === specification.startMark ? start : end,
                    ]),
                  ),
                };
              },
            );
          })(),
        },
      ]),
    ),
  }));
}

function bridgeObservation(fixture: any) {
  const observation: any = {
    fixtureId: fixture.id,
    sampling: { ...config.sampling },
    measurements: bridgeMeasurements(fixture),
    counts: { failures: 0, degraded: 0 },
    foregroundWork: bridgeForegroundWork(),
  };
  if (fixture.id === 'open-100k-lines') {
    observation.corpus = { ...config.fixtureCorpus, lineCount: 100_000 };
    observation.warmCold = {
      warmupsDiscarded: config.sampling.warmups,
      coldCorpusRebuilt: true,
      source: 'product-owned-bridge',
    };
  }
  if (fixture.fallback) observation.fallback = { ...fixture.fallback };
  if (fixture.growth)
    observation.growth = Object.fromEntries(
      Object.keys(fixture.growth).map((name) => [name, { start: 1, end: 1 }]),
    );
  if (fixture.duration)
    observation.duration = {
      logicalDurationMs: fixture.duration.referenceDurationMs,
      observedDurationMs: fixture.duration.referenceDurationMs,
      scaled: false,
    };
  return observation;
}

function bridgeForegroundWork() {
  return {
    version: 1,
    collector: 'NOT_VERIFIED',
    collectorReason: 'BROWSER_LONGTASK_UNSUPPORTED',
    thresholdMs: 50,
    incidents: [],
    aggregate: { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
    native: {
      status: 'NOT_VERIFIED',
      reason: 'NATIVE_FOREGROUND_EXECUTOR_COLLECTOR_UNAVAILABLE',
    },
  };
}

function bridgeEvidence() {
  return {
    version: 1,
    source: 'station-ui-production-bridge',
    observations: config.fixtures.map(bridgeObservation),
  };
}

function referenceRun(observations: any[]) {
  const revision = 'a'.repeat(40);
  return {
    adapter: 'station-playwright-production-v1',
    generatedAt: new Date().toISOString(),
    provenance: {
      source: 'executed-in-run',
      metadata: {
        cpu: 'reference-cpu',
        ramBytes: 34359738368,
        gpu: 'reference-gpu',
        display: 'reference-display',
        os: 'win32 reference',
        platform: 'win32',
        buildMode: 'production',
        revision,
        build: {
          kind: 'vite-production-bundle',
          sha256: 'a'.repeat(64),
          uiCommit: revision.slice(0, 7),
        },
      },
    },
    observations: structuredClone(observations),
  };
}

function tempOutput() {
  const root = mkdtempSync(join(tmpdir(), 'station-performance-test-'));
  roots.push(root);
  return join(root, 'report.json');
}

afterEach(() => {
  while (roots.length > 0)
    rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('interactive workspace performance contract', () => {
  it('reports only closed, bounded foreground-work incidents beside percentile results', () => {
    const run: any = executeInteractiveWorkspaceBenchmark(config, {
      now: () => new Date(),
    });
    const remote = run.observations.find(
      (observation: any) => observation.fixtureId === 'remote-apply',
    );
    remote.foregroundWork = {
      version: 1,
      collector: 'browser-longtask',
      thresholdMs: 50,
      incidents: [
        {
          phase: 'render',
          interaction: 'workspace-pane',
          action: 'layout-commit',
          pane: 'diff-panel',
          source: 'browser-longtask',
          durationMs: 51,
        },
      ],
      aggregate: { count: 1, totalDurationMs: 51, maxDurationMs: 51 },
      native: {
        status: 'NOT_VERIFIED',
        reason: 'NATIVE_FOREGROUND_EXECUTOR_COLLECTOR_UNAVAILABLE',
      },
    };
    const report = evaluateInteractiveWorkspacePerformance(config, run, {
      mode: 'smoke',
      expectedRevision: run.provenance.metadata.revision,
      now: () => new Date(),
    });
    expect(
      report.fixtures.find(
        (fixture: any) => fixture.fixtureId === 'remote-apply',
      ).foregroundWork,
    ).toMatchObject({
      status: 'OBSERVED',
      incidents: [{ phase: 'render', durationMs: 51 }],
      native: { status: 'NOT_VERIFIED' },
    });
    remote.foregroundWork.incidents[0].taskId = 'task-99';
    expect(
      evaluateInteractiveWorkspacePerformance(config, run, {
        mode: 'smoke',
        expectedRevision: run.provenance.metadata.revision,
        now: () => new Date(),
      }).fixtures.find((fixture: any) => fixture.fixtureId === 'remote-apply'),
    ).toMatchObject({
      status: 'NOT_VERIFIED',
      reasonCodes: expect.arrayContaining([
        'FOREGROUND_WORK_JOURNAL_UNAVAILABLE_remote-apply',
      ]),
    });
    delete run.observations[0].foregroundWork;
    expect(
      evaluateInteractiveWorkspacePerformance(config, run, {
        mode: 'smoke',
        expectedRevision: run.provenance.metadata.revision,
        now: () => new Date(),
      }).fixtures[0],
    ).toMatchObject({
      status: 'NOT_VERIFIED',
      reasonCodes: expect.arrayContaining([
        'FOREGROUND_WORK_JOURNAL_UNAVAILABLE_local-input-apply',
      ]),
    });
  });
  it('keeps control transport diagnostics closed', () => {
    expect(closedControlReason(new Error('control timed out'))).toBe(
      'CONTROL_TIMEOUT',
    );
    expect(
      closedControlReason(new Error('control receipt framing is invalid')),
    ).toBe('CONTROL_FRAMING');
    expect(
      closedControlReason(new Error('control receipt exceeded budget')),
    ).toBe('CONTROL_RECEIPT_TOO_LARGE');
    expect(closedControlReason(new SyntaxError('private JSON'))).toBe(
      'CONTROL_INVALID_JSON',
    );
    expect(
      closedControlReason(
        Object.assign(new Error('private'), { code: 'ECONNRESET' }),
      ),
    ).toBe('CONTROL_CONNECTION');
    expect(closedControlReason(new Error('socket JSON framing private'))).toBe(
      'CONTROL_UNKNOWN',
    );
  });
  it('reads peer identity from one bounded visible-element wait handle', async () => {
    const dispose = vi.fn();
    // Typed with a rest signature so `mock.calls[0][2]` — the options
    // argument this test asserts on — is in the tuple. A zero-arg `vi.fn`
    // types its calls as `[]`, which is a TS2493 at index 2.
    const waitForFunction = vi.fn(async (..._args: unknown[]) => ({
      jsonValue: async () => 'actor-1',
      dispose,
    }));
    await expect(peerActorIdentity({ waitForFunction })).resolves.toBe(
      'actor-1',
    );
    expect(waitForFunction).toHaveBeenCalledTimes(1);
    expect(waitForFunction.mock.calls[0]?.[2]).toEqual({ timeout: 30_000 });
    expect(dispose).toHaveBeenCalledOnce();
    await expect(
      peerActorIdentity({
        waitForFunction: async () => ({
          jsonValue: async () => false,
          dispose: vi.fn(),
        }),
      }),
    ).rejects.toThrow('peer actor identity is unavailable');
  });
  it('retains only closed live command diagnostics from peer presence stages', () => {
    expect(
      closedLiveCommandDiagnostic(
        new Error('Live command Leave room status 500 outcome DEGRADED'),
      ),
    ).toBe('Live command Leave room status 500 outcome DEGRADED');
    expect(
      closedLiveCommandDiagnostic(new Error('private-token')),
    ).toBeUndefined();
  });
  it('serializes reconnect setup while retaining a bounded Windows editor readiness wait', () => {
    expect(RECONNECT_POOL_BATCH_SIZE).toBe(1);
    expect(RECONNECT_EDITOR_READY_TIMEOUT_MS).toBe(60_000);
  });
  it('fences live-command responses against racing heartbeats', () => {
    const request = (body: string) => ({ postData: () => body });
    expect(
      liveCommandRequestMatches(request('{"command":"heartbeat"}'), 'depart'),
    ).toBe(false);
    expect(
      liveCommandRequestMatches(request('{"command":"depart"}'), 'depart'),
    ).toBe(true);
    expect(
      liveCommandRequestMatches(request('{"command":"join"}'), 'depart'),
    ).toBe(false);
  });
  it('executes all named workloads with exact sampling and components', () => {
    const run = executeInteractiveWorkspaceBenchmark(config, { mode: 'smoke' });
    expect(run.provenance.source).toBe('executed-in-run');
    expect(run.observations).toHaveLength(8);
    const observations = run.observations as Observation[];
    for (const observation of observations) {
      const fixture = config.fixtures.find(
        (item: { id: string }) => item.id === observation.fixtureId,
      );
      expect(observation.sampling).toEqual({ warmups: 5, samples: 100 });
      expect(observation.workloads).toEqual(fixture.workloads);
      for (const samples of Object.values(observation.samples))
        expect(samples).toHaveLength(100);
      for (const samples of Object.values(observation.components))
        expect(samples).toHaveLength(100);
      for (const [component, mapping] of Object.entries(
        fixture.derivation.components,
      )) {
        const record = (observation as any).measurements[0];
        const start = record.phases[(mapping as any).phase].actions.find(
          (action: any) => action.kind === (mapping as any).start[0],
        ).marks[(mapping as any).start[1]];
        const end = record.phases[(mapping as any).phase].actions.find(
          (action: any) => action.kind === (mapping as any).end[0],
        ).marks[(mapping as any).end[1]];
        expect(observation.components[component][0]).toBe(end - start);
      }
    }
    expect(
      observations.find((item) => item.fixtureId === 'reconnect-10k-operations')
        ?.fallback,
    ).toEqual({
      retainedOperations: 10000,
      beyondWindowStrategy: 'snapshot',
    });
    expect(
      observations.find((item) => item.fixtureId === 'open-100k-lines')
        ?.workloads,
    ).toEqual(['file-open', 'scroll', 'diff-render']);
    expect(
      observations.find((item) => item.fixtureId === 'synthetic-collaboration')
        ?.workloads,
    ).toEqual(['remote-ingress', 'participant-update', 'cursor-update']);
    expect(
      observations.find(
        (item) => item.fixtureId === 'long-session-bounded-growth',
      )?.duration,
    ).toMatchObject({ logicalDurationMs: 60_000, scaled: true });
  });
  it('reports p50, p95, p99, and absolute limits from executed samples', () => {
    expect(percentiles([1, 2, 3, 4, 5])).toMatchObject({
      p50Ms: 3,
      p95Ms: 5,
      p99Ms: 5,
      maxMs: 5,
    });
    const run = executeInteractiveWorkspaceBenchmark(config, { mode: 'smoke' });
    const report = evaluateInteractiveWorkspacePerformance(config, run, {
      mode: 'smoke',
      now: () => new Date(run.generatedAt),
      expectedRevision: run.provenance.metadata.revision,
    });
    expect(
      (report.fixtures as FixtureReport[]).find(
        (item) => item.fixtureId === 'open-100k-lines',
      )?.metrics,
    ).toHaveProperty('coldEditableMs.limits');
  });

  it('fails smoke execution when an adapter returns the old workload vocabulary', () => {
    expect(() =>
      executeInteractiveWorkspaceBenchmark(config, {
        adapter: {
          id: 'synthetic-workspace-v1',
          smokeOnly: true,
          runFixture: () => ({
            workloads: ['remote-apply'],
            measurement: { iteration: 0, phases: {} },
            fallback: undefined,
            growth: undefined,
            duration: undefined,
          }),
        },
      }),
    ).toThrow("synthetic workload identity mismatch for 'local-input-apply'");
  });

  it('marks a smoke report NOT_VERIFIED when workload identity is altered', () => {
    const run = executeInteractiveWorkspaceBenchmark(config, { mode: 'smoke' });
    run.observations[0].workloads = ['remote-apply'];
    const report = evaluateInteractiveWorkspacePerformance(config, run, {
      mode: 'smoke',
      now: () => new Date(run.generatedAt),
      expectedRevision: run.provenance.metadata.revision,
    });
    expect(report.fixtures[0]).toMatchObject({
      status: 'NOT_VERIFIED',
      reasonCodes: ['WORKLOAD_IDENTITY_MISMATCH_local-input-apply'],
    });
  });

  it('fails a deliberate 100k open max outlier and degraded ceiling breach', () => {
    const run = executeInteractiveWorkspaceBenchmark(config, { mode: 'smoke' });
    const observations = run.observations as Observation[];
    const open = observations.find(
      (item) => item.fixtureId === 'open-100k-lines',
    )!;
    open.samples.coldEditableMs[99] = 2001;
    const reconnect = observations.find(
      (item) => item.fixtureId === 'reconnect-10k-operations',
    )!;
    reconnect.counts.degraded = 1;
    const report = evaluateInteractiveWorkspacePerformance(config, run, {
      mode: 'smoke',
      now: () => new Date(run.generatedAt),
      expectedRevision: run.provenance.metadata.revision,
    });
    expect(report.status).toBe('FAIL');
    expect(
      (report.fixtures as FixtureReport[]).find(
        (item) => item.fixtureId === 'open-100k-lines',
      )?.failures,
    ).toContain('budget:coldEditableMs');
    expect(
      (report.fixtures as FixtureReport[]).find(
        (item) => item.fixtureId === 'reconnect-10k-operations',
      )?.failures,
    ).toContain('degraded:1/0');
  });

  it('fails a hostile Work Board interaction threshold breach in the shared checker', () => {
    const run = executeInteractiveWorkspaceBenchmark(config, { mode: 'smoke' });
    const board = (run.observations as Observation[]).find(
      (item) => item.fixtureId === 'work-board-200-pins-v1',
    )!;
    board.samples.interactionTaskMs[99] = 51;
    const report = evaluateInteractiveWorkspacePerformance(config, run, {
      mode: 'smoke',
      now: () => new Date(run.generatedAt),
      expectedRevision: run.provenance.metadata.revision,
    });
    expect(report.status).toBe('FAIL');
    expect(
      (report.fixtures as FixtureReport[]).find(
        (item) => item.fixtureId === 'work-board-200-pins-v1',
      )?.failures,
    ).toContain('budget:interactionTaskMs');
  });

  it('propagates adapter failure and degraded outcomes into the budget verdict', () => {
    const run = executeInteractiveWorkspaceBenchmark(config, { mode: 'smoke' });
    const remote = (run.observations as Observation[]).find(
      (observation) => observation.fixtureId === 'remote-apply',
    )!;
    // This is the observation shape returned by a real adapter after an
    // action failure/degradation; checker ownership remains centralized here.
    remote.counts = { failures: 1, degraded: 1 };
    const report = evaluateInteractiveWorkspacePerformance(config, run, {
      mode: 'smoke',
      now: () => new Date(run.generatedAt),
      expectedRevision: run.provenance.metadata.revision,
    });
    expect(
      (report.fixtures as FixtureReport[]).find(
        (item) => item.fixtureId === 'remote-apply',
      )?.failures,
    ).toEqual(expect.arrayContaining(['operation-failures:1', 'degraded:1/0']));
  });

  it('rejects synthetic, stale, and false reference evidence instead of arbitrary PASS data', () => {
    const run = executeInteractiveWorkspaceBenchmark(config, {
      mode: 'smoke',
    });
    run.generatedAt = '2000-01-01T00:00:00.000Z';
    run.provenance.source = 'checked-in-number';
    run.observations[0].samples.inputToModelCommitMs.pop();
    const report = evaluateInteractiveWorkspacePerformance(config, run, {
      mode: 'reference',
      now: () => new Date('2026-08-16T00:00:00.000Z'),
      expectedRevision: run.provenance.metadata.revision,
    });
    expect(report).toMatchObject({ status: 'NOT_VERIFIED' });
    expect(report.reasonCodes).toEqual(
      expect.arrayContaining([
        'INVALID_REFERENCE_EVIDENCE',
        'SYNTHETIC_ADAPTER_FOR_REFERENCE',
        'REAL_STATION_BROWSER_ADAPTER_REQUIRED',
        'SOURCE_NOT_EXECUTED_IN_RUN',
        'STALE_OR_INVALID_TIMESTAMP',
      ]),
    );
  });

  it('retains bounded, redacted diagnostics when the reference adapter cannot produce accepted JSON', () => {
    const run = executeReferenceStationBenchmark(config, {
      now: () => new Date('2026-08-22T00:00:00.000Z'),
      execute: (() => ({
        status: null,
        signal: 'SIGTERM',
        error: { code: 'ETIMEDOUT' },
        stdout: 'not-json',
        stderr: `${'x'.repeat(5_000)}\nBearer super-secret STATION_PERFORMANCE_AUTHORIZATION=also-secret`,
      })) as never,
    });
    const diagnostics = run.provenance.diagnostics;
    expect(diagnostics).toMatchObject({
      status: null,
      signal: 'SIGTERM',
      errorCode: 'ETIMEDOUT',
      stdoutBytes: 8,
    });
    expect(
      Buffer.byteLength(diagnostics.stderrTail, 'utf8'),
    ).toBeLessThanOrEqual(4 * 1024);
    expect(diagnostics.stderrTail).toContain('Bearer [REDACTED]');
    expect(diagnostics.stderrTail).not.toContain('super-secret');
    expect(diagnostics.stderrTail).not.toContain('also-secret');
    expect(run.observations).toHaveLength(config.fixtures.length);
    expect(run.observations[0].reasonCodes).toEqual([
      'REAL_STATION_BROWSER_ADAPTER_UNAVAILABLE',
    ]);
    expect(
      referenceAdapterDiagnostics({
        status: 1,
        signal: 'secret=not-safe',
        error: { code: 'TOKEN=not-safe' },
        stdout: '',
        stderr: '',
      }),
    ).toMatchObject({ signal: null, errorCode: null });
  });

  it('redacts secrets that begin immediately before the retained stderr tail', () => {
    const bearer = 'Bearer bearer-boundary-secret';
    const authorization =
      'STATION_PERFORMANCE_AUTHORIZATION=authorization-boundary-secret';
    for (const secret of [bearer, authorization]) {
      const diagnostics = referenceAdapterDiagnostics({
        status: 1,
        signal: null,
        error: null,
        stdout: '',
        // The first three bytes of each secret fall before the old 4 KiB tail;
        // its token continues through the retained suffix.
        stderr: `${'x'.repeat(100)}\n${secret}${'z'.repeat(4 * 1024 + 3 - secret.length)}`,
      });
      expect(diagnostics.stderrTail).not.toContain('boundary-secret');
      expect(
        Buffer.byteLength(diagnostics.stderrTail, 'utf8'),
      ).toBeLessThanOrEqual(4 * 1024);
    }
  });

  it('keeps the extended control response budget bounded to the reference socket', () => {
    expect(REFERENCE_CONTROL_SOCKET_RESPONSE_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  it('keeps reference artifacts fresh through the bounded 55-minute lane only', () => {
    expect(config.referenceEnvironment.maxArtifactAgeMs).toBe(60 * 60 * 1000);
  });

  it('rejects malformed action attestations from a purported real adapter', () => {
    const smoke = executeInteractiveWorkspaceBenchmark(config, {
      mode: 'smoke',
    });
    const observations = bridgeEvidence().observations.map(
      (observation: any) =>
        observation.fixtureId === 'local-input-apply'
          ? { ...observation, measurements: [{ iteration: 0, phases: {} }] }
          : observation,
    );
    const run = {
      ...smoke,
      adapter: 'station-playwright-production-v1',
      provenance: {
        ...smoke.provenance,
        metadata: {
          cpu: 'reference-cpu',
          ramBytes: 34359738368,
          gpu: 'reference-gpu',
          display: 'reference-display',
          os: 'win32 reference',
          platform: 'win32',
          buildMode: 'production',
          revision: smoke.provenance.metadata.revision,
          build: {
            kind: 'vite-production-bundle',
            sha256: 'a'.repeat(64),
            uiCommit: smoke.provenance.metadata.revision.slice(0, 7),
          },
        },
      },
      observations: validateProductionBridgeEvidence(config, {
        version: 1,
        source: 'station-ui-production-bridge',
        observations,
      }).observations,
    };
    const report = evaluateInteractiveWorkspacePerformance(config, run, {
      mode: 'reference',
      now: () => new Date(run.generatedAt),
      expectedRevision: run.provenance.metadata.revision,
    });
    expect(
      report.fixtures.find(
        (fixture: { fixtureId: string }) =>
          fixture.fixtureId === 'local-input-apply',
      ).reasonCodes,
    ).toContain('MEASUREMENT_RECORD_MISMATCH_local-input-apply');
  });

  it('writes isolated reports and never claims absent reference hardware', () => {
    const output = tempOutput();
    const { report } = runInteractiveWorkspacePerformance(
      ['--mode', 'reference', '--config', configPath, '--output', output],
      { cwd: process.cwd(), env: {} },
    );
    expect(report).toMatchObject({ status: 'NOT_VERIFIED' });
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
      status: 'NOT_VERIFIED',
    });
    expect(createNotVerifiedReport(config, 'missing').status).toBe(
      'NOT_VERIFIED',
    );
  });

  it('reduces retained performance evidence to closed fixture dispositions', () => {
    expect(
      performanceReportReceipt({
        status: 'NOT_VERIFIED',
        reasonCodes: [
          'INVALID_REFERENCE_EVIDENCE',
          'DEGRADED_TOTAL:3/0',
          'unsafe reason',
        ],
        fixtures: [
          {
            fixtureId: 'work-board-200-pins-v1',
            status: 'NOT_VERIFIED',
            reasonCodes: [
              'WORK_BOARD_PERFORMANCE_DRIVER_UNAVAILABLE',
              'DURATION_EVIDENCE_MISMATCH_work-board-one-hour-v1',
              'SAMPLING_MISMATCH_local-input-apply',
              'UNRECOGNIZED_PREFIX_local-input-apply',
            ],
            rawBrowserState: 'must-not-escape',
          },
          {
            fixtureId: 'safe\nlog-injection',
            status: 'unexpected',
            reasonCodes: ['bad reason'],
          },
        ],
      }),
    ).toEqual({
      status: 'NOT_VERIFIED',
      reasonCodes: ['INVALID_REFERENCE_EVIDENCE', 'DEGRADED_TOTAL:3/0'],
      fixtures: [
        {
          fixtureId: 'work-board-200-pins-v1',
          status: 'NOT_VERIFIED',
          reasonCodes: [
            'WORK_BOARD_PERFORMANCE_DRIVER_UNAVAILABLE',
            'DURATION_EVIDENCE_MISMATCH_work-board-one-hour-v1',
            'SAMPLING_MISMATCH_local-input-apply',
          ],
        },
        { fixtureId: 'UNKNOWN', status: 'UNKNOWN', reasonCodes: [] },
      ],
    });
  });

  it('projects every contract metric and growth breach into a closed FAIL category', () => {
    for (const fixture of config.fixtures) {
      const failures = [
        ...fixture.metrics.map(
          (metric: { id: string }) => `budget:${metric.id}`,
        ),
        ...Object.keys(fixture.growth ?? {}).map((name) => `growth:${name}`),
      ];
      const expected = [
        ...fixture.metrics.map(
          (metric: { id: string }) =>
            `BUDGET_EXCEEDED_${fixture.id}_${metric.id}`,
        ),
        ...Object.keys(fixture.growth ?? {}).map(
          (name) => `GROWTH_BUDGET_EXCEEDED_${fixture.id}_${name}`,
        ),
      ];
      expect(
        performanceReportReceipt({
          fixtures: [{ fixtureId: fixture.id, status: 'FAIL', failures }],
        }).fixtures[0],
      ).toEqual({
        fixtureId: fixture.id,
        status: 'FAIL',
        reasonCodes: [],
        failureCodes: expected,
      });
    }
  });

  it('projects every evaluated contract limit breach as bounded aggregate evidence', () => {
    for (const fixture of config.fixtures) {
      const metrics = Object.fromEntries(
        fixture.metrics.map((metric: any) => [
          metric.id,
          Object.fromEntries(
            metric.limits.map((limit: any) => [limit.stat, limit.maxMs + 1]),
          ),
        ]),
      );
      const growth = Object.fromEntries(
        Object.entries(fixture.growth ?? {}).map(([name, budget]: any) => [
          name,
          { delta: budget.maxDelta + 1 },
        ]),
      );
      const receipt = performanceReportReceipt({
        fixtures: [
          {
            fixtureId: fixture.id,
            status: 'FAIL',
            failures: [
              ...fixture.metrics.map(
                (metric: { id: string }) => `budget:${metric.id}`,
              ),
              ...Object.keys(fixture.growth ?? {}).map(
                (name) => `growth:${name}`,
              ),
            ],
            metrics,
            growth,
          },
        ],
      }).fixtures[0] as any;
      expect(receipt.failedLimits).toEqual([
        ...fixture.metrics.flatMap((metric: any) =>
          metric.limits.map((limit: any) => ({
            metric: metric.id,
            stat: limit.stat,
            observedMs: limit.maxMs + 1,
            maxMs: limit.maxMs,
          })),
        ),
        ...Object.entries(fixture.growth ?? {}).map(([name, budget]: any) => ({
          name,
          delta: budget.maxDelta + 1,
          maxDelta: budget.maxDelta,
        })),
      ]);
    }
  });

  it('keeps failed-limit evidence closed to finite failed contract aggregates', () => {
    const credential = 'AKIAIOSFODNN7EXAMPLE';
    const receipt = performanceReportReceipt({
      fixtures: [
        {
          fixtureId: 'remote-apply',
          status: 'FAIL',
          failures: [
            'budget:acceptedIngressToRenderCommitMs',
            'growth:arbitrary-growth',
            `budget:${credential}`,
          ],
          metrics: {
            acceptedIngressToRenderCommitMs: {
              p95Ms: 17,
              maxMs: 999_999,
              limits: [{ stat: 'p95Ms', maxMs: 999_999, secret: credential }],
              samples: [credential],
            },
            arbitraryMetric: { p95Ms: 1_000_000 },
          },
          growth: { arbitraryGrowth: { delta: 1_000_000 } },
          failedLimits: [{ metric: credential }],
          rawBrowserState: credential,
        },
        {
          fixtureId: 'work-board-one-hour-v1',
          status: 'FAIL',
          failures: [
            'budget:interactionTaskMs',
            'growth:boardDomNodes',
            'growth:boardListeners',
          ],
          metrics: { interactionTaskMs: { p95Ms: Number.POSITIVE_INFINITY } },
          growth: {
            boardDomNodes: { delta: Number.NaN },
            boardListeners: { delta: -1 },
          },
        },
      ],
    });
    expect(receipt.fixtures).toEqual([
      {
        fixtureId: 'remote-apply',
        status: 'FAIL',
        reasonCodes: [],
        failureCodes: [
          'BUDGET_EXCEEDED_remote-apply_acceptedIngressToRenderCommitMs',
          'FAILURE_CATEGORY_UNAVAILABLE',
        ],
        failedLimits: [
          {
            metric: 'acceptedIngressToRenderCommitMs',
            stat: 'p95Ms',
            observedMs: 17,
            maxMs: 16,
          },
        ],
      },
      {
        fixtureId: 'work-board-one-hour-v1',
        status: 'FAIL',
        reasonCodes: [],
        failureCodes: [
          'BUDGET_EXCEEDED_work-board-one-hour-v1_interactionTaskMs',
          'GROWTH_BUDGET_EXCEEDED_work-board-one-hour-v1_boardDomNodes',
          'GROWTH_BUDGET_EXCEEDED_work-board-one-hour-v1_boardListeners',
        ],
      },
    ]);
    expect(JSON.stringify(receipt)).not.toContain(credential);
    expect(JSON.stringify(receipt)).not.toMatch(/[\r\n]/u);
  });

  it('omits failed-limit evidence for PASS and NOT_VERIFIED dispositions', () => {
    const fixtures = ['PASS', 'NOT_VERIFIED'].map((status) => ({
      fixtureId: 'remote-apply',
      status,
      failures: ['budget:acceptedIngressToRenderCommitMs'],
      metrics: { acceptedIngressToRenderCommitMs: { p95Ms: 17 } },
    }));
    expect(performanceReportReceipt({ fixtures }).fixtures).toEqual([
      { fixtureId: 'remote-apply', status: 'PASS', reasonCodes: [] },
      { fixtureId: 'remote-apply', status: 'NOT_VERIFIED', reasonCodes: [] },
    ]);
  });

  it('fails closed when a failed-limit aggregate is mutated to the configured maximum', () => {
    const receipt = performanceReportReceipt({
      fixtures: [
        {
          fixtureId: 'remote-apply',
          status: 'FAIL',
          failures: ['budget:acceptedIngressToRenderCommitMs'],
          metrics: { acceptedIngressToRenderCommitMs: { p95Ms: 16 } },
        },
      ],
    });
    expect(receipt.fixtures[0]).toEqual({
      fixtureId: 'remote-apply',
      status: 'FAIL',
      reasonCodes: [],
      failureCodes: [
        'BUDGET_EXCEEDED_remote-apply_acceptedIngressToRenderCommitMs',
      ],
    });
  });

  it('normalizes non-budget FAIL details without retaining raw strategies or counts', () => {
    const receipt = performanceReportReceipt({
      fixtures: [
        {
          fixtureId: 'reconnect-10k-operations',
          status: 'FAIL',
          failures: ['fallback:replay-all'],
        },
        {
          fixtureId: 'remote-apply',
          status: 'FAIL',
          failures: ['operation-failures:7', 'degraded:1/0'],
        },
      ],
    });
    expect(receipt.fixtures).toEqual([
      {
        fixtureId: 'reconnect-10k-operations',
        status: 'FAIL',
        reasonCodes: [],
        failureCodes: ['FALLBACK_CONTRACT_MISMATCH'],
      },
      {
        fixtureId: 'remote-apply',
        status: 'FAIL',
        reasonCodes: [],
        failureCodes: [
          'OPERATION_FAILURES_REPORTED',
          'DEGRADED_PER_FIXTURE_BUDGET_EXCEEDED',
        ],
      },
    ]);
    expect(JSON.stringify(receipt)).not.toContain('replay-all');
    expect(JSON.stringify(receipt)).not.toContain('7');
  });

  it('rejects credential and control-character failure details while retaining only safe categories', () => {
    const credential = 'AKIAIOSFODNN7EXAMPLE';
    const receipt = performanceReportReceipt({
      fixtures: [
        {
          fixtureId: 'remote-apply',
          status: 'FAIL',
          failures: [
            `budget:acceptedIngressToRenderCommitMs${credential}`,
            `operation-failures:1\n${credential}`,
            `degraded:1/0\r${credential}`,
          ],
        },
        {
          fixtureId: 'reconnect-10k-operations',
          status: 'FAIL',
          failures: [`fallback:${credential}`],
        },
        {
          fixtureId: `unknown-${credential}`,
          status: 'FAIL',
          failures: [`budget:${credential}`],
        },
      ],
    });
    expect(receipt.fixtures).toEqual([
      {
        fixtureId: 'remote-apply',
        status: 'FAIL',
        reasonCodes: [],
        failureCodes: ['FAILURE_CATEGORY_UNAVAILABLE'],
      },
      {
        fixtureId: 'reconnect-10k-operations',
        status: 'FAIL',
        reasonCodes: [],
        failureCodes: ['FALLBACK_CONTRACT_MISMATCH'],
      },
      {
        fixtureId: 'UNKNOWN',
        status: 'FAIL',
        reasonCodes: [],
        failureCodes: ['FAILURE_CATEGORY_UNAVAILABLE'],
      },
    ]);
    expect(JSON.stringify(receipt)).not.toContain(credential);
    expect(JSON.stringify(receipt)).not.toMatch(/[\r\n]/u);
  });

  it('retains an unavailable category alongside recognized FAIL details', () => {
    const credential = 'AKIAIOSFODNN7EXAMPLE';
    const receipt = performanceReportReceipt({
      fixtures: [
        {
          fixtureId: 'remote-apply',
          status: 'FAIL',
          failures: [
            'budget:acceptedIngressToRenderCommitMs',
            `future-family:${credential}`,
            null,
          ],
        },
        { fixtureId: 'local-input-apply', status: 'FAIL' },
        { fixtureId: 'synthetic-collaboration', status: 'FAIL', failures: [] },
      ],
    });
    expect(receipt.fixtures).toEqual([
      {
        fixtureId: 'remote-apply',
        status: 'FAIL',
        reasonCodes: [],
        failureCodes: [
          'BUDGET_EXCEEDED_remote-apply_acceptedIngressToRenderCommitMs',
          'FAILURE_CATEGORY_UNAVAILABLE',
        ],
      },
      {
        fixtureId: 'local-input-apply',
        status: 'FAIL',
        reasonCodes: [],
        failureCodes: ['FAILURE_CATEGORY_UNAVAILABLE'],
      },
      {
        fixtureId: 'synthetic-collaboration',
        status: 'FAIL',
        reasonCodes: [],
        failureCodes: ['FAILURE_CATEGORY_UNAVAILABLE'],
      },
    ]);
    expect(JSON.stringify(receipt)).not.toContain(credential);
  });

  it('accepts a successful evaluator only on the physical Windows contract', () => {
    const report = {
      status: 'NOT_VERIFIED',
      reasonCodes: ['REFERENCE_FIXTURE_UNAVAILABLE'],
      fixtures: [
        {
          fixtureId: 'local-input-apply',
          status: 'NOT_VERIFIED',
          reasonCodes: ['REFERENCE_FIXTURE_UNAVAILABLE'],
        },
      ],
    };
    expect(
      referenceEvaluatorExitFailure('win32', 0, 'local-input-apply', report),
    ).toBeNull();
    expect(
      referenceEvaluatorExitFailure('win32', 2, 'local-input-apply', report),
    ).toContain('Reference evaluator exited 2');
    expect(
      referenceEvaluatorExitFailure('darwin', 2, 'local-input-apply', report),
    ).toBeNull();
    expect(
      referenceEvaluatorExitFailure('darwin', 0, 'local-input-apply', report),
    ).toContain('expected unavailable exit 2');
  });

  it('prints only closed regular report entries with bounded unreadable semantics', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-performance-receipt-'));
    roots.push(root);
    writeFileSync(
      join(root, 'safe-report.json'),
      JSON.stringify({
        status: 'NOT_VERIFIED',
        reasonCodes: ['REFERENCE_ENVIRONMENT_UNAVAILABLE'],
        fixtures: [],
      }),
    );
    writeFileSync(join(root, 'unsafe\nreport.json'), '{}');
    writeFileSync(join(root, 'not-json.txt'), '{}');

    const lines = performanceReceiptLogLines(root);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('report=safe-report.json');
    expect(lines[0]).toContain('REFERENCE_ENVIRONMENT_UNAVAILABLE');
    expect(lines.join('\n')).not.toContain('unsafe');
    expect(
      performanceReceiptLogLines(root, {
        readDirectory: () => ['linked-report.json'],
        stat: () => ({
          isFile: () => true,
          isSymbolicLink: () => true,
          size: 1,
        }),
        readFile: () => '{"status":"PASS"}',
      }),
    ).toEqual(['[interactive-workspace-performance] receipt=NO_REPORTS_FOUND']);

    expect(performanceReceiptLogLines(join(root, 'missing'))).toEqual([
      '[interactive-workspace-performance] receipt=NO_REPORTS_FOUND',
    ]);
    writeFileSync(join(root, 'broken-report.json'), '{');
    expect(performanceReceiptLogLines(root)).toContain(
      '[interactive-workspace-performance] report=broken-report.json receipt=UNREADABLE_REPORT',
    );
  });

  it('accepts only contract-owned receipt vocabulary', () => {
    const fixtureIds = config.fixtures.map(
      (fixture: { id: string }) => fixture.id,
    );
    const generatedPrefixes = [
      'DERIVATION_SCHEMA_MISMATCH',
      'DERIVED_COMPONENT_MISMATCH',
      'DERIVED_METRIC_MISMATCH',
      'DURATION_EVIDENCE_MISMATCH',
      'FALLBACK_EVIDENCE_MALFORMED',
      'FOREGROUND_WORK_JOURNAL_UNAVAILABLE',
      'GROWTH_EVIDENCE_MALFORMED',
      'INVALID_COUNTS',
      'INVALID_NOT_VERIFIED_REASON',
      'MEASUREMENT_DERIVATION_MISMATCH',
      'MEASUREMENT_RECORD_MISMATCH',
      'MISSING_BRIDGE_FIXTURE',
      'MISSING_FIXTURE',
      'MISSING_FOREGROUND_WORK_JOURNAL',
      'SAMPLING_MISMATCH',
      'WORKLOAD_IDENTITY_MISMATCH',
    ];
    const generatedReasons = generatedPrefixes.flatMap((prefix) =>
      fixtureIds.map((fixtureId: string) => `${prefix}_${fixtureId}`),
    );

    expect(generatedReasons).toHaveLength(128);
    for (const [index, reason] of generatedReasons.entries()) {
      const fixtureId = fixtureIds[index % fixtureIds.length];
      expect(
        performanceReportReceipt({
          fixtures: [
            {
              fixtureId,
              status: 'NOT_VERIFIED',
              reasonCodes: [reason],
            },
          ],
        }).fixtures[0].reasonCodes,
      ).toEqual([reason]);
    }

    expect(
      performanceReportReceipt({
        reasonCodes: ['AKIAIOSFODNN7EXAMPLE'],
        fixtures: [
          {
            fixtureId: 'work-board-200-pins-v1',
            status: 'NOT_VERIFIED',
            reasonCodes: ['AKIAIOSFODNN7EXAMPLE'],
          },
          {
            fixtureId: 'sk-live-secretmaterial123',
            status: 'NOT_VERIFIED',
            reasonCodes: ['MISSING_FIXTURE_sk-live-secretmaterial123'],
          },
        ],
      }),
    ).toEqual({
      status: 'UNKNOWN',
      reasonCodes: [],
      fixtures: [
        {
          fixtureId: 'work-board-200-pins-v1',
          status: 'NOT_VERIFIED',
          reasonCodes: [],
        },
        { fixtureId: 'UNKNOWN', status: 'NOT_VERIFIED', reasonCodes: [] },
      ],
    });
  });

  it('reconciles UI, Work Board, and isolated-adapter receipt producers', () => {
    const acceptedReasons = [
      'AUTHENTICATED_TASK_IDENTITY_UNAVAILABLE',
      'WORK_BOARD_PHYSICAL_ENVIRONMENT_UNAVAILABLE',
      'WORK_BOARD_200_PIN_FIXTURE_UNAVAILABLE',
      'WORK_BOARD_PRODUCT_COMMIT_TIMEOUT',
      'WORK_BOARD_PRODUCT_ACTION_UNAVAILABLE',
      'ONE_HOUR_REFERENCE_OBSERVATION_NOT_RUN',
      'WORK_BOARD_REFERENCE_OBSERVATION_NOT_RUN',
      'WORK_BOARD_ONE_HOUR_OBSERVATION_NOT_RUN',
      'PRODUCT_TASK_INPUT_TIMEOUT',
      'PRODUCT_FILE_100K_PREPARE_CORPUS_CONTROL_CONNECTION',
      'PRODUCT_FILE_100K_RENDER_DIFF_FAILED',
      'PRODUCT_COLLABORATION_LEAVE_LIVE_COMMAND_OUTCOME_DEGRADED',
      'PRODUCT_COLLABORATION_PRESENCE_OWNER_ABSENCE_FAILED',
      'PRODUCT_RECONNECT_STRATEGY_TIMEOUT_AT_104',
      'PRODUCT_RECONNECT_DRIVER_RETAINED_SEED_RENDER',
      'PRODUCT_RECONNECT_DRIVER_FALLBACK_SAMPLE_104_DOCUMENT_503',
      'PRODUCT_RECONNECT_DRIVER_RETAINED_SAMPLE_4_EDITOR_REVISION_MISMATCH',
      'PRODUCT_RECONNECT_DRIVER_FALLBACK_SAMPLE_4_RENDER_REVISION_MISMATCH',
    ];
    const fixtureId = 'work-board-200-pins-v1';
    for (const reason of acceptedReasons) {
      expect(
        performanceReportReceipt({
          reasonCodes: [reason],
          fixtures: [
            { fixtureId, status: 'NOT_VERIFIED', reasonCodes: [reason] },
          ],
        }),
      ).toEqual({
        status: 'UNKNOWN',
        reasonCodes: [reason],
        fixtures: [
          { fixtureId, status: 'NOT_VERIFIED', reasonCodes: [reason] },
        ],
      });
    }

    for (const knownFixtureId of config.fixtures.map(
      (fixture: { id: string }) => fixture.id,
    )) {
      for (const reason of [
        `PRODUCT_MARK_MEASUREMENT_FAILED_${knownFixtureId}`,
        `ISOLATED_FIXTURE_TASK_UNAVAILABLE_${knownFixtureId}`,
        `ISOLATED_FIXTURE_TIMEOUT_FAILED_${knownFixtureId}`,
        `ISOLATED_FIXTURE_RECONNECT_RETAINED_SAMPLE_104_EDITOR_FAILED_${knownFixtureId}`,
      ]) {
        expect(
          performanceReportReceipt({
            fixtures: [
              {
                fixtureId: knownFixtureId,
                status: 'NOT_VERIFIED',
                reasonCodes: [reason],
              },
            ],
          }).fixtures[0].reasonCodes,
        ).toEqual([reason]);
      }
    }

    for (const reason of [
      'PRODUCT_MARK_MEASUREMENT_FAILED_sk-live-secretmaterial123',
      'ISOLATED_FIXTURE_TASK_UNAVAILABLE_sk-live-secretmaterial123',
      'ISOLATED_FIXTURE_RECONNECT_RETAINED_SAMPLE_105_EDITOR_FAILED_work-board-200-pins-v1',
      'PRODUCT_RECONNECT_STRATEGY_TIMEOUT_AT_105',
      'PRODUCT_RECONNECT_DRIVER_RETAINED_SEED_DOCUMENT_999',
      'PRODUCT_RECONNECT_DRIVER_RETAINED_SAMPLE_4_EDITOR_A1B2C3D4E5F6_EXPECTED_0123456789AB_NO_COMMIT',
      'PRODUCT_RECONNECT_DRIVER_FALLBACK_SAMPLE_4_RENDER_REVISION_MISMATCH_A1B2C3D4E5F6_0123456789AB',
    ]) {
      expect(
        performanceReportReceipt({ reasonCodes: [reason] }).reasonCodes,
      ).toEqual([]);
    }
  });

  it('keeps unavailable real seams per-fixture NOT_VERIFIED and propagates adapter counts', () => {
    const run = referenceRun(
      config.fixtures.map((fixture: any) => ({
        ...bridgeObservation(fixture),
        status: 'NOT_VERIFIED',
        reasonCodes: ['REAL_SURFACE_UNAVAILABLE'],
        counts: { failures: 2, degraded: 1 },
      })),
    );
    const report = evaluateInteractiveWorkspacePerformance(config, run, {
      mode: 'reference',
      now: () => new Date(run.generatedAt),
      expectedRevision: run.provenance.metadata.revision,
    });
    expect(report.status).toBe('NOT_VERIFIED');
    expect(report.fixtures).toHaveLength(8);
    expect(report.fixtures[0]).toMatchObject({
      status: 'NOT_VERIFIED',
      reasonCodes: expect.arrayContaining(['REAL_SURFACE_UNAVAILABLE']),
      counts: { failures: 2, degraded: 1 },
    });
  });

  it('keeps a measured failure dominant over unrelated NOT_VERIFIED fixtures', () => {
    const run = executeInteractiveWorkspaceBenchmark(config, { mode: 'smoke' });
    const observations = run.observations as Observation[];
    observations.find(
      (item) => item.fixtureId === 'local-input-apply',
    )!.samples.interactionTaskMs[99] = 51;
    Object.assign(
      observations.find((item) => item.fixtureId === 'remote-apply')!,
      {
        status: 'NOT_VERIFIED',
        reasonCodes: ['REAL_SURFACE_UNAVAILABLE'],
      },
    );
    const report = evaluateInteractiveWorkspacePerformance(config, run, {
      mode: 'smoke',
      now: () => new Date(run.generatedAt),
      expectedRevision: run.provenance.metadata.revision,
    });
    expect(report.status).toBe('FAIL');
    expect(report.summary).toMatchObject({ FAIL: 1, NOT_VERIFIED: 1 });
  });

  it('preserves observed counts and reasons when invalid samples are NOT_VERIFIED', () => {
    const evidence = bridgeEvidence();
    const observation = evidence.observations[0];
    observation.measurements = [];
    observation.counts = { failures: 3, degraded: 2 };
    const result = validateProductionBridgeEvidence(config, {
      version: 1,
      source: 'station-ui-production-bridge',
      observations: [observation, ...evidence.observations.slice(1)],
    });
    expect(result.observations[0]).toMatchObject({
      status: 'NOT_VERIFIED',
      counts: { failures: 3, degraded: 2 },
    });
    expect(result.observations[0].reasonCodes).toContain(
      'MEASUREMENT_RECORD_MISMATCH_local-input-apply',
    );
  });

  it('normalizes invalid counts, reasonless NOT_VERIFIED, missing duration, and malformed records', () => {
    const evidence = bridgeEvidence();
    const local = evidence.observations[0];
    local.counts = { failures: -1, degraded: Number.NaN };
    const remote = evidence.observations[1];
    remote.status = 'NOT_VERIFIED';
    remote.reasonCodes = [];
    const reconnect = evidence.observations.find(
      (item: { fixtureId: string }) =>
        item.fixtureId === 'reconnect-10k-operations',
    )!;
    reconnect.measurements = [{ iteration: 0, phases: {} }];
    const long = evidence.observations.find(
      (item: { fixtureId: string }) =>
        item.fixtureId === 'long-session-bounded-growth',
    )!;
    delete long.duration.observedDurationMs;
    const result = validateProductionBridgeEvidence(config, evidence);
    expect(result.observations[0]).toMatchObject({
      status: 'NOT_VERIFIED',
      counts: { failures: 0, degraded: 0 },
    });
    expect(result.observations[0].reasonCodes).toContain(
      'INVALID_COUNTS_local-input-apply',
    );
    expect(result.observations[1].reasonCodes).toContain(
      'INVALID_NOT_VERIFIED_REASON_remote-apply',
    );
    expect(reconnect.status).toBeUndefined();
    expect(
      result.observations.find(
        (item: { fixtureId: string }) =>
          item.fixtureId === 'reconnect-10k-operations',
      ).reasonCodes,
    ).toContain('MEASUREMENT_RECORD_MISMATCH_reconnect-10k-operations');
    expect(
      result.observations.find(
        (item: { fixtureId: string }) =>
          item.fixtureId === 'long-session-bounded-growth',
      ).reasonCodes,
    ).toContain('DURATION_EVIDENCE_MISMATCH_long-session-bounded-growth');
  });

  it('rejects scaled or short one-hour evidence before it can pass reference validation', () => {
    for (const duration of [
      {
        logicalDurationMs: 60_000,
        observedDurationMs: 60_000,
        scaled: true,
      },
      {
        logicalDurationMs: 3_600_000,
        observedDurationMs: 3_599_999,
        scaled: false,
      },
    ]) {
      const evidence = bridgeEvidence();
      evidence.observations.find(
        (item: { fixtureId: string }) =>
          item.fixtureId === 'long-session-bounded-growth',
      )!.duration = duration;
      expect(
        validateProductionBridgeEvidence(config, evidence).observations.find(
          (item: { fixtureId: string }) =>
            item.fixtureId === 'long-session-bounded-growth',
        ).reasonCodes,
      ).toContain('DURATION_EVIDENCE_MISMATCH_long-session-bounded-growth');
    }
  });

  it('turns valid fallback and growth contract breaches into measured FAIL', () => {
    const fallbackEvidence = bridgeEvidence();
    fallbackEvidence.observations.find(
      (item: { fixtureId: string }) =>
        item.fixtureId === 'reconnect-10k-operations',
    )!.fallback.beyondWindowStrategy = 'replay-all';
    const fallbackRun = referenceRun(
      validateProductionBridgeEvidence(config, fallbackEvidence).observations,
    );
    const fallbackReport = evaluateInteractiveWorkspacePerformance(
      config,
      fallbackRun,
      {
        mode: 'reference',
        now: () => new Date(fallbackRun.generatedAt),
        expectedRevision: fallbackRun.provenance.metadata.revision,
      },
    );
    expect(fallbackReport.status).toBe('FAIL');
    expect(
      fallbackReport.fixtures.find(
        (item: { fixtureId: string }) =>
          item.fixtureId === 'reconnect-10k-operations',
      ).failures,
    ).toContain('fallback:replay-all');

    const growthEvidence = bridgeEvidence();
    growthEvidence.observations.find(
      (item: { fixtureId: string }) =>
        item.fixtureId === 'long-session-bounded-growth',
    )!.growth.listeners.end = 2;
    const growthRun = referenceRun(
      validateProductionBridgeEvidence(config, growthEvidence).observations,
    );
    const growthReport = evaluateInteractiveWorkspacePerformance(
      config,
      growthRun,
      {
        mode: 'reference',
        now: () => new Date(growthRun.generatedAt),
        expectedRevision: growthRun.provenance.metadata.revision,
      },
    );
    expect(growthReport.status).toBe('FAIL');
    expect(
      growthReport.fixtures.find(
        (item: { fixtureId: string }) =>
          item.fixtureId === 'long-session-bounded-growth',
      ).failures,
    ).toContain('growth:listeners');
  });

  it('derives a reference PASS only from complete raw measurement records', () => {
    const validated = validateProductionBridgeEvidence(
      config,
      bridgeEvidence(),
    );
    expect(validated.observations[0]).toMatchObject({
      samples: { inputToModelCommitMs: Array(100).fill(3) },
      components: { stateApplyMs: Array(100).fill(2) },
    });
    const run = referenceRun(validated.observations);
    const report = evaluateInteractiveWorkspacePerformance(config, run, {
      mode: 'reference',
      now: () => new Date(run.generatedAt),
      expectedRevision: run.provenance.metadata.revision,
    });
    expect(report.status).toBe('PASS');
  });

  it('derives distinct remote component boundaries from causal action marks', () => {
    const remote = validateProductionBridgeEvidence(
      config,
      bridgeEvidence(),
    ).observations.find((item: any) => item.fixtureId === 'remote-apply');
    expect(remote.components).toMatchObject({
      ingressSendMs: Array(100).fill(1),
      transportMs: Array(100).fill(2),
      serverAcceptanceMs: Array(100).fill(3),
      authoritativeDocumentApplyMs: Array(100).fill(4),
      applyToLayoutCommitMs: Array(100).fill(5),
      renderCommitMs: Array(100).fill(5),
    });
    expect(remote.samples.acceptedIngressToRenderCommitMs).toEqual(
      Array(100).fill(12),
    );
  });

  it('excludes transport latency from accepted remote apply while reporting it', () => {
    const evidence = bridgeEvidence();
    const remote = evidence.observations.find(
      (item: any) => item.fixtureId === 'remote-apply',
    );
    for (const record of remote.measurements) {
      const actions = record.phases.measured.actions;
      actions[1].marks.arrivedAt += 10_000;
      for (const action of actions.slice(2))
        for (const mark of Object.keys(action.marks))
          action.marks[mark] += 10_000;
    }
    const observed = validateProductionBridgeEvidence(
      config,
      evidence,
    ).observations.find((item: any) => item.fixtureId === 'remote-apply');
    expect(observed.samples.acceptedIngressToRenderCommitMs).toEqual(
      Array(100).fill(12),
    );
    expect(observed.components.transportMs).toEqual(Array(100).fill(10_002));
  });

  it('keeps fallback timing outside the retained replay budget branch', () => {
    const evidence = bridgeEvidence();
    const reconnect = evidence.observations.find(
      (item: any) => item.fixtureId === 'reconnect-10k-operations',
    );
    for (const record of reconnect.measurements)
      record.phases.fallback.actions[0].marks.fallbackAppliedAt += 10_000;
    const observed = validateProductionBridgeEvidence(
      config,
      evidence,
    ).observations.find(
      (item: any) => item.fixtureId === 'reconnect-10k-operations',
    );
    expect(observed.samples.replayAndRenderMs).toEqual(Array(100).fill(5));
    expect(observed.components.snapshotFallbackMs).toEqual(
      Array(100).fill(10_001),
    );

    const missingFallback = bridgeEvidence();
    delete missingFallback.observations.find(
      (item: any) => item.fixtureId === 'reconnect-10k-operations',
    ).fallback;
    expect(
      validateProductionBridgeEvidence(
        config,
        missingFallback,
      ).observations.find(
        (item: any) => item.fixtureId === 'reconnect-10k-operations',
      ).reasonCodes,
    ).toContain('FALLBACK_EVIDENCE_MALFORMED_reconnect-10k-operations');
  });

  it('rejects duplicate mappings, undeclared endpoints, and unused workloads in the schema', () => {
    const duplicate = structuredClone(config);
    const remote = duplicate.fixtures.find(
      (fixture: any) => fixture.id === 'remote-apply',
    );
    remote.derivation.components.authoritativeDocumentApplyMs = {
      ...remote.derivation.components.transportMs,
    };
    expect(
      validateProductionBridgeEvidence(
        duplicate,
        bridgeEvidence(),
      ).observations.find((item: any) => item.fixtureId === 'remote-apply')
        .reasonCodes,
    ).toContain('DERIVATION_SCHEMA_MISMATCH_remote-apply');

    const undeclared = structuredClone(config);
    undeclared.fixtures[0].derivation.metrics.inputToModelCommitMs.start = [
      'typing',
      'inventedAt',
    ];
    expect(
      validateProductionBridgeEvidence(undeclared, bridgeEvidence())
        .observations[0].reasonCodes,
    ).toContain('DERIVATION_SCHEMA_MISMATCH_local-input-apply');

    const unused = structuredClone(config);
    delete unused.fixtures.find(
      (fixture: any) => fixture.id === 'open-100k-lines',
    ).derivation.components.warmScrollMs;
    expect(
      validateProductionBridgeEvidence(
        unused,
        bridgeEvidence(),
      ).observations.find((item: any) => item.fixtureId === 'open-100k-lines')
        .reasonCodes,
    ).toContain('DERIVATION_SCHEMA_MISMATCH_open-100k-lines');
  });

  it('rejects unused raw marks and causal disorder before deriving samples', () => {
    const oversized = bridgeEvidence();
    const open = oversized.observations.find(
      (item: any) => item.fixtureId === 'open-100k-lines',
    );
    open.measurements[0].phases.warm.actions[1].marks.unusedAt = 1_000_000;
    expect(
      validateProductionBridgeEvidence(config, oversized).observations.find(
        (item: any) => item.fixtureId === 'open-100k-lines',
      ).reasonCodes,
    ).toContain('MEASUREMENT_RECORD_MISMATCH_open-100k-lines');

    const cursor = bridgeEvidence();
    cursor.observations.find(
      (item: any) => item.fixtureId === 'long-session-bounded-growth',
    ).measurements[0].phases.measured.actions[1].marks.unusedAt = 1_000_000;
    expect(
      validateProductionBridgeEvidence(config, cursor).observations.find(
        (item: any) => item.fixtureId === 'long-session-bounded-growth',
      ).reasonCodes,
    ).toContain('MEASUREMENT_RECORD_MISMATCH_long-session-bounded-growth');

    const disordered = bridgeEvidence();
    disordered.observations.find(
      (item: any) => item.fixtureId === 'remote-apply',
    ).measurements[0].phases.measured.actions[1].marks.transportStartedAt = -1;
    expect(
      validateProductionBridgeEvidence(config, disordered).observations.find(
        (item: any) => item.fixtureId === 'remote-apply',
      ).reasonCodes,
    ).toContain('MEASUREMENT_RECORD_MISMATCH_remote-apply');
  });

  it('rejects decorated synthetic aggregates without raw measurement records', () => {
    const decorated = structuredClone(bridgeEvidence()).observations.map(
      (observation: any) => {
        const { measurements, ...synthetic } = observation;
        const fixture = config.fixtures.find(
          (item: { id: string }) => item.id === observation.fixtureId,
        );
        return {
          ...synthetic,
          samples: Object.fromEntries(
            fixture.metrics.map((metric: any) => [
              metric.id,
              Array(100).fill(1),
            ]),
          ),
          components: Object.fromEntries(
            fixture.requiredComponents.map((component: string) => [
              component,
              Array(100).fill(1),
            ]),
          ),
          actions: bridgeMeasurements(fixture).flatMap((record: any) =>
            Object.values(record.phases).flatMap((phase: any) =>
              phase.actions.map((action: any) => ({
                ...action,
                iteration: record.iteration,
              })),
            ),
          ),
        };
      },
    );
    const validated = validateProductionBridgeEvidence(config, {
      version: 1,
      source: 'station-ui-production-bridge',
      observations: decorated,
    });
    expect(validated.observations[0].reasonCodes).toContain(
      'MEASUREMENT_RECORD_MISMATCH_local-input-apply',
    );
    const run = referenceRun(validated.observations);
    expect(
      evaluateInteractiveWorkspacePerformance(config, run, {
        mode: 'reference',
        now: () => new Date(run.generatedAt),
        expectedRevision: run.provenance.metadata.revision,
      }).status,
    ).not.toBe('PASS');
  });

  it('rejects supplied aggregate arrays that disagree with raw derivation', () => {
    const evidence = bridgeEvidence();
    const baseline = validateProductionBridgeEvidence(config, bridgeEvidence());
    const local = evidence.observations[0];
    local.samples = {
      ...baseline.observations[0].samples,
      inputToModelCommitMs: Array(100).fill(999),
    };
    local.components = baseline.observations[0].components;
    const result = validateProductionBridgeEvidence(config, evidence);
    expect(result.observations[0]).toMatchObject({ status: 'NOT_VERIFIED' });
    expect(result.observations[0].reasonCodes).toContain(
      'DERIVED_METRIC_MISMATCH_local-input-apply',
    );
  });

  it('isolates each fixture context so one terminal bridge cannot poison the next', async () => {
    const html = '<meta name="station-build-commit" content="abc1234">';
    const build = {
      kind: 'vite-production-bundle',
      sha256: createHash('sha256').update(html).digest('hex'),
      uiCommit: 'abc1234',
    };
    let closed = false;
    let isolatedContexts = 0;
    let closedContexts = 0;
    let bridgeCalls = 0;
    const page = {
      goto: async () => ({ text: async () => html }),
      locator: () => ({ getAttribute: async () => 'abc1234' }),
      waitForFunction: async () => true,
      evaluate: async (_bridge: unknown, input: unknown) => {
        if (typeof input === 'string') return true;
        expect(input).toMatchObject({
          sampling: config.sampling,
        });
        const requested = (input as { fixtures: Array<{ id: string }> })
          .fixtures;
        if (bridgeCalls++ === 0) return null;
        const evidence = bridgeEvidence();
        return {
          ...evidence,
          observations: evidence.observations.filter((observation: any) =>
            requested.some((fixture) => fixture.id === observation.fixtureId),
          ),
        };
      },
    };
    const result = await measure(config, process.cwd(), {
      env: { STATION_PERFORMANCE_AUTHORIZATION: 'a'.repeat(32) },
      target:
        'http://station.test/tasks/task-1?station-performance-reference=interactive-workspace-v3',
      resolveRevision: () => 'abc1234'.padEnd(40, '0'),
      readBuildReceipt: () => build,
      loadChromium: (async () => ({
        chromium: {
          launch: async () => ({
            newContext: async () => {
              isolatedContexts += 1;
              return {
                newPage: async () => page,
                close: async () => {
                  closedContexts += 1;
                },
              };
            },
            close: async () => {
              closed = true;
            },
          }),
        },
      })) as never,
      metadata: (() => ({ buildMode: 'production' })) as never,
    });
    expect(result).toMatchObject({
      adapter: 'station-playwright-production-v1',
      provenance: { source: 'executed-in-run' },
    });
    expect(result.observations).toHaveLength(8);
    expect(result.observations[0]).not.toHaveProperty('status');
    expect(result.observations[1]).not.toHaveProperty('status');
    expect(result.observations[2]).toMatchObject({
      status: 'NOT_VERIFIED',
      reasonCodes: ['PRODUCTION_MEASUREMENT_BRIDGE_UNAVAILABLE'],
    });
    expect(isolatedContexts).toBe(8);
    expect(closedContexts).toBe(8);
    expect(closed).toBe(true);

    const root = mkdtempSync(join(tmpdir(), 'station-build-receipt-'));
    roots.push(root);
    const bundle = join(root, 'bundle');
    mkdirSync(bundle);
    // The receipt parser consumes the same Vite marker that the fake page
    // exposes; a different attached receipt was already rejected above.
    writeFileSync(join(bundle, 'index.html'), html, { flag: 'w' });
    expect(
      productionBuildReceipt(root, 'abc1234'.padEnd(40, '0'), 'bundle'),
    ).toMatchObject({
      uiCommit: 'abc1234',
    });
  });

  it('normalizes only the one managed nonce bootstrap for build receipt hashing', () => {
    const staticHtml = '<html><head><meta name="build"></head></html>';
    const bootstrap =
      '<script nonce="YWJjZA==">window.__STATION_CSP_NONCE__=document.currentScript.nonce</script>';
    expect(
      normalizeAttachedStationHtml(
        staticHtml.replace('<head>', `<head>${bootstrap}`),
      ),
    ).toBe(staticHtml);
    expect(
      normalizeAttachedStationHtml(
        staticHtml.replace('<head>', `<head>${bootstrap}${bootstrap}`),
      ),
    ).toBeNull();
    expect(
      normalizeAttachedStationHtml(
        staticHtml.replace('<head>', '<head><script>foreign()</script>'),
      ),
    ).toContain('foreign()');
  });

  it('requires one strict runner-owned auth context without URL credentials', () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'station-performance-auth-')),
    );
    roots.push(root);
    const storageState = join(root, 'storage-state.json');
    writeFileSync(storageState, JSON.stringify({ cookies: [], origins: [] }), {
      mode: 0o600,
    });
    expect(
      referenceAuthContext({
        STATION_PERFORMANCE_STORAGE_STATE: storageState,
      }),
    ).toEqual({ kind: 'storage-state', storageState });
    chmodSync(storageState, 0o644);
    expect(
      referenceAuthContext({
        STATION_PERFORMANCE_STORAGE_STATE: storageState,
      }),
    ).toBeNull();
    expect(
      referenceAuthContext({
        STATION_PERFORMANCE_AUTHORIZATION: 'a'.repeat(32),
      }),
    ).toEqual({
      kind: 'authorization',
      authorization: `Bearer ${'a'.repeat(32)}`,
    });
    expect(
      referenceAuthContext({
        STATION_PERFORMANCE_STORAGE_STATE: storageState,
        STATION_PERFORMANCE_AUTHORIZATION: 'a'.repeat(32),
      }),
    ).toBeNull();
  });

  it('does not attach the production bridge without the exact reference URL mode', async () => {
    let launched = false;
    const result = await measure(config, process.cwd(), {
      target: 'http://station.test/tasks/task-1',
      resolveRevision: () => 'abc1234'.padEnd(40, '0'),
      readBuildReceipt: () => ({
        kind: 'vite-production-bundle',
        sha256: 'a'.repeat(64),
        uiCommit: 'abc1234',
      }),
      loadChromium: (async () => {
        launched = true;
        throw new Error('must not launch');
      }) as never,
    });
    expect(launched).toBe(false);
    expect(result.observations[0].reasonCodes).toEqual([
      'PRODUCTION_MEASUREMENT_MODE_UNAVAILABLE',
    ]);
  });

  it('names a fresh reference page without runner auth NOT_VERIFIED', async () => {
    let launched = false;
    const result = await measure(config, process.cwd(), {
      env: {},
      target:
        'http://station.test/tasks/task-1?station-performance-reference=interactive-workspace-v3',
      loadChromium: (async () => {
        launched = true;
        throw new Error('must not launch');
      }) as never,
    });
    expect(launched).toBe(false);
    expect(result.observations[0].reasonCodes).toEqual([
      'REFERENCE_BROWSER_AUTH_CONTEXT_UNAVAILABLE',
    ]);
  });

  it('covers reference child boundaries without a process-heavy Chromium run', () => {
    expect(
      unavailableBridgeObservations(
        config,
        'REAL_STATION_BROWSER_TARGET_UNAVAILABLE',
      ),
    ).toHaveLength(8);
    expect(
      unavailableBridgeObservations(
        config,
        'PRODUCTION_MEASUREMENT_BRIDGE_UNAVAILABLE',
      )[0].reasonCodes,
    ).toEqual(['PRODUCTION_MEASUREMENT_BRIDGE_UNAVAILABLE']);
    expect(
      buildReceiptMatches(
        { sha256: 'a'.repeat(64), uiCommit: 'abc1234' },
        { sha256: 'b'.repeat(64), uiCommit: 'abc1234' },
      ),
    ).toBe(false);
    expect(
      validateProductionBridgeEvidence(config, null).observations[0]
        .reasonCodes,
    ).toEqual(['MALFORMED_PRODUCTION_BRIDGE_EVIDENCE']);
    expect(
      validateProductionBridgeEvidence(config, {
        version: 1,
        source: 'wrong-source',
        observations: [],
      }).observations[0].reasonCodes,
    ).toEqual(['MALFORMED_PRODUCTION_BRIDGE_EVIDENCE']);
  });

  it('uses the live desktop-win native runner labels', () => {
    const workflow = readFileSync(
      '.github/workflows/interactive-workspace-performance.yml',
      'utf8',
    );
    expect(workflow).toContain(
      'runs-on: [self-hosted, Windows, X64, kontour-windows, native]',
    );
    expect(workflow).toContain('npm run build:server');
    expect(workflow).toContain(
      "$env:VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE = '1'",
    );
    expect(workflow).toContain('npm exec -- vite build');
    expect(workflow).toContain(
      'npx playwright test tests/interactive-workspace-performance-bridge.spec.ts',
    );
    expect(workflow).toContain('STATION_PERFORMANCE_REPORT_OUTPUT:');
    expect(workflow).toContain(
      'node scripts/print-interactive-workspace-performance-receipts.mjs .kontourai/performance',
    );
    const jobs = (load(workflow) as { jobs?: Record<string, WorkflowJob> })
      .jobs;
    expect(jobs).toBeDefined();
    const physicalJobs = [
      ['reference-performance', 'Reserve physical host capacity', '7800'],
      [
        'one-hour-collaboration-reference',
        'Reserve physical host capacity for the observed hour',
        '7800',
      ],
      [
        'one-hour-work-board-reference',
        'Reserve physical host capacity for the observed board hour',
        '7800',
      ],
    ] as const;
    for (const [jobId, capacityName, ownerLifetimeSeconds] of physicalJobs) {
      const job = jobs?.[jobId];
      expect(job).toBeDefined();
      expectWindowsPhysicalAcceptanceStepPrefix(
        job as WorkflowJob,
        capacityName,
        ownerLifetimeSeconds,
      );
    }

    const referenceSteps = jobs?.['reference-performance'].steps;
    expect(referenceSteps).toBeDefined();
    const checkoutAfterPreflight = structuredClone(
      referenceSteps as WorkflowStep[],
    );
    [checkoutAfterPreflight[0], checkoutAfterPreflight[2]] = [
      checkoutAfterPreflight[2],
      checkoutAfterPreflight[0],
    ];
    expect(() =>
      expectWindowsPhysicalAcceptanceStepPrefix(
        { steps: checkoutAfterPreflight },
        'Reserve physical host capacity',
        '7800',
      ),
    ).toThrow();

    const leaseBeforePreflight = structuredClone(
      referenceSteps as WorkflowStep[],
    );
    [leaseBeforePreflight[2], leaseBeforePreflight[3]] = [
      leaseBeforePreflight[3],
      leaseBeforePreflight[2],
    ];
    expect(() =>
      expectWindowsPhysicalAcceptanceStepPrefix(
        { steps: leaseBeforePreflight },
        'Reserve physical host capacity',
        '7800',
      ),
    ).toThrow();
    const chromiumInstall = workflow.slice(
      workflow.indexOf(
        '      - name: Install Chromium for the real Station adapter',
      ),
      workflow.indexOf(
        '      - name: Provision isolated Station and execute reference benchmark',
      ),
    );
    expect(chromiumInstall).toContain("PLAYWRIGHT_BROWSERS_PATH: '0'");
    expect(chromiumInstall).toContain('run: npx playwright install chromium');
    const oneHourJob = workflow.slice(
      workflow.indexOf('  one-hour-collaboration-reference:'),
    );
    expect(oneHourJob).toContain(
      'name: One-hour collaboration growth reference',
    );
    expect(oneHourJob).toContain('timeout-minutes: 125');
    expect(oneHourJob).toContain('needs: reference-performance');
    expect(oneHourJob).toContain(
      "if: always() && !cancelled() && github.event_name != 'pull_request'",
    );
    expect(oneHourJob).toContain("STATION_PERFORMANCE_ONE_HOUR_REFERENCE: '1'");
    expect(oneHourJob).toContain(
      'STATION_PERFORMANCE_E2E_FIXTURES: long-session-bounded-growth',
    );
    expect(oneHourJob).toContain('owner-lifetime-seconds: "7800"');
    const workBoardHourJob = workflow.slice(
      workflow.indexOf('  one-hour-work-board-reference:'),
    );
    expect(workBoardHourJob).toContain(
      'name: One-hour Work Board growth reference',
    );
    expect(workBoardHourJob).toContain('timeout-minutes: 125');
    expect(workBoardHourJob).toContain(
      'STATION_PERFORMANCE_E2E_FIXTURES: work-board-one-hour-v1',
    );
    const bridgeSpec = readFileSync(
      'tests/interactive-workspace-performance-bridge.spec.ts',
      'utf8',
    );
    expect(bridgeSpec).toContain('installTelemetryDialogDismissal');
    expect(bridgeSpec).toContain('page.addLocatorHandler');
    expect(bridgeSpec).toContain('removeTelemetryDialogHandler');
    expect(bridgeSpec).toContain(
      'WORK_BOARD_ONE_HOUR_REFERENCE_TIMEOUT_MS = 65 * 60 * 1000',
    );
    expect(bridgeSpec).toContain(
      'WORK_BOARD_REFERENCE_ENABLED\n          ? 80 * 60 * 1000',
    );
    expect(workflow).not.toContain('STATION_PERFORMANCE_UI_URL:');
  });
});
