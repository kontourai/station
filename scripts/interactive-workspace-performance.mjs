#!/usr/bin/env node

/**
 * Interactive workspace performance contract (station#2892).
 *
 * An adapter executes the named fixtures; this Module owns provenance,
 * percentile calculation, and budgets. A future real UI adapter implements
 * `runFixture` without changing the contract/checker.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FOREGROUND_WORK_ACTIONS,
  FOREGROUND_WORK_COLLECTOR_UNSUPPORTED,
  FOREGROUND_WORK_COLLECTORS,
  FOREGROUND_WORK_INCIDENT_SOURCES,
  FOREGROUND_WORK_INTERACTIONS,
  FOREGROUND_WORK_JOURNAL_VERSION,
  FOREGROUND_WORK_PANES,
  FOREGROUND_WORK_PHASES,
  FOREGROUND_WORK_STALL_THRESHOLD_MS,
  NATIVE_FOREGROUND_EXECUTOR_COLLECTOR_UNAVAILABLE,
} from '../src-shared/foreground-work-journal-schema.mjs';
import {
  bridgeFixtureReasons,
  deriveBridgeFixtureEvidence,
} from './lib/interactive-workspace-production-bridge.mjs';

export const PERFORMANCE_REPORT_VERSION = 2;
export const REFERENCE_ENVIRONMENT_UNAVAILABLE =
  'REFERENCE_ENVIRONMENT_UNAVAILABLE';
export const INVALID_REFERENCE_EVIDENCE = 'INVALID_REFERENCE_EVIDENCE';
export const REAL_STATION_BROWSER_ADAPTER = 'station-playwright-production-v1';
const foregroundWorkPhases = new Set(FOREGROUND_WORK_PHASES);
const foregroundWorkInteractions = new Set(FOREGROUND_WORK_INTERACTIONS);
const foregroundWorkActions = new Set(FOREGROUND_WORK_ACTIONS);
const foregroundWorkPanes = new Set(FOREGROUND_WORK_PANES);
const foregroundWorkSources = new Set(FOREGROUND_WORK_INCIDENT_SOURCES);
const foregroundWorkCollectors = new Set(FOREGROUND_WORK_COLLECTORS);

const hash = (value) => createHash('sha256').update(value).digest('hex');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const corpusDigest = (config) => hash(JSON.stringify(config.fixtures));

export function percentiles(samples) {
  assert(
    Array.isArray(samples) && samples.length > 0,
    'timing samples must not be empty',
  );
  assert(
    samples.every((value) => Number.isFinite(value) && value >= 0),
    'timing samples must be non-negative finite numbers',
  );
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (fraction) => sorted[Math.ceil(sorted.length * fraction) - 1];
  return {
    count: sorted.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    maxMs: sorted.at(-1),
  };
}

function apply(state, text) {
  const at = state.cursor % (state.text.length + 1);
  state.text = `${state.text.slice(0, at)}${text}${state.text.slice(at)}`;
  state.cursor = at + text.length;
  state.revision += 1;
}

function renderCommit(state) {
  state.lastRender = `${state.revision}:${state.cursor}:${state.text.slice(-64)}`;
}

const syntheticActions = Object.freeze({
  typing: ({ state }) => {
    state.lastInput = 'x';
  },
  'input-apply': ({ state }) => apply(state, 'x'),
  'diff-render': ({ state }) => renderCommit(state),
  'remote-ingress': ({ iteration }) => JSON.stringify({ operation: iteration }),
  transport: ({ iteration }) => new Uint8Array(128).fill(iteration),
  'server-acceptance': ({ iteration }) => String(iteration).padStart(6, '0'),
  'authoritative-document-apply': ({ state }) => apply(state, 'r'),
  'render-commit': ({ state }) => renderCommit(state),
  'participant-update': ({ state }) => apply(state, 'p'),
  'cursor-update': ({ state, iteration }) => {
    state.cursor = (state.cursor + iteration + 1) % (state.text.length + 1);
  },
  'file-open': ({ state }) => {
    state.corpus = Array.from(
      { length: 100_000 },
      (_, index) => `line-${index}`,
    ).join('\n');
  },
  scroll: ({ state, iteration }) => {
    const offset = (iteration * 97) % Math.max(1, state.corpus.length - 512);
    state.viewport = state.corpus.slice(offset, offset + 512);
  },
  reconnect: ({ iteration }) => new Uint8Array(128).fill(iteration),
  'replay-apply': ({ state }) => {
    for (let operation = 0; operation < 10_000; operation += 1)
      state.revision += operation & 1;
  },
  'snapshot-fallback': ({ state }) => {
    state.snapshot = `${state.revision}:${state.cursor}`;
  },
  'long-session': ({ state, mode }) => {
    for (let tick = 0; tick < (mode === 'reference' ? 3_600 : 60); tick += 1)
      state.revision += tick & 1;
  },
  'board-cold-restore': ({ state }) => {
    state.boardPins = 200;
  },
  'board-warm-restore': ({ state }) => {
    state.boardPins = 200;
  },
  'board-grouped-live-resolution-commit': ({ state }) => {
    state.boardResolutionRevision = (state.boardResolutionRevision ?? 0) + 1;
  },
  'board-keyboard-move-resize': ({ state }) => {
    state.boardInteractionRevision = (state.boardInteractionRevision ?? 0) + 1;
  },
  'board-pointer-move-resize': ({ state }) => {
    state.boardInteractionRevision = (state.boardInteractionRevision ?? 0) + 1;
  },
  'board-live-resolution': ({ state }) => {
    state.boardResolutionRevision = (state.boardResolutionRevision ?? 0) + 1;
  },
  'board-interaction-bookkeeping': ({ state }) => {
    state.boardInteractionRevision = (state.boardInteractionRevision ?? 0) + 1;
  },
});

function runSyntheticAction(specification, context) {
  const action = syntheticActions[specification.id];
  assert(action, `missing synthetic action '${specification.id}'`);
  const started = performance.now();
  action(context);
  const completed = Math.max(started, performance.now());
  return {
    kind: specification.id,
    marks: Object.fromEntries(
      specification.marks.map((mark, index) => [
        mark,
        index === 0
          ? started
          : index === specification.marks.length - 1
            ? completed
            : started +
              ((completed - started) * index) /
                (specification.marks.length - 1),
      ]),
    ),
  };
}

function runSyntheticFixture({ fixture, iteration, mode, state, tempRoot }) {
  return {
    measurement: {
      iteration,
      phases: Object.fromEntries(
        Object.entries(fixture.measurementPhases).map(([phase, actions]) => [
          phase,
          {
            actions: actions.map((specification) =>
              runSyntheticAction(specification, {
                fixture,
                iteration,
                mode,
                phase,
                state,
                tempRoot,
              }),
            ),
          },
        ]),
      ),
    },
    workloads: fixture.workloads,
    fallback: fixture.fallback ? { ...fixture.fallback } : undefined,
    growth: fixture.growth
      ? Object.fromEntries(
          Object.keys(fixture.growth).map((name) => [
            name,
            { start: 1, end: 1 },
          ]),
        )
      : undefined,
    duration: fixture.duration
      ? {
          kind: 'virtual-synthetic-collaboration',
          logicalDurationMs:
            mode === 'reference'
              ? fixture.duration.referenceDurationMs
              : 60_000,
          scaled: mode === 'smoke',
        }
      : undefined,
  };
}

/** Current runnable adapter; production UI instrumentation can compose later. */
export const syntheticWorkspaceAdapter = Object.freeze({
  id: 'synthetic-workspace-v1',
  smokeOnly: true,
  runFixture(context) {
    return runSyntheticFixture(context);
  },
});

function revision(cwd) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function runtimeMetadata(gitRevision) {
  return {
    cpu: cpus()[0]?.model || null,
    ramBytes: totalmem(),
    gpu: null,
    display: null,
    os: `${platform()} ${release()}`,
    platform: platform(),
    buildMode: 'development',
    revision: gitRevision,
  };
}

function emptyObservation(fixture) {
  return {
    fixtureId: fixture.id,
    samples: Object.fromEntries(fixture.metrics.map(({ id }) => [id, []])),
    components: Object.fromEntries(
      fixture.requiredComponents.map((id) => [id, []]),
    ),
    counts: { failures: 0, degraded: 0 },
    foregroundWork: notVerifiedForegroundWork(),
  };
}

function sameWorkloads(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((workload, index) => workload === expected[index])
  );
}

export function executeInteractiveWorkspaceBenchmark(
  config,
  {
    adapter = syntheticWorkspaceAdapter,
    cwd = process.cwd(),
    mode = 'smoke',
    now = () => new Date(),
  } = {},
) {
  assert(
    typeof adapter?.runFixture === 'function',
    'adapter.runFixture is required',
  );
  const tempRoot = mkdtempSync(
    resolve(tmpdir(), 'station-interactive-workspace-'),
  );
  const startedAt = now().toISOString();
  try {
    const observations = config.fixtures.map((fixture) => {
      const observation = emptyObservation(fixture);
      observation.measurements = [];
      const state = { cursor: 0, lastRender: '', revision: 0, text: '' };
      const iterations = config.sampling.warmups + config.sampling.samples;
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        const measured = adapter.runFixture({
          fixture,
          iteration,
          mode,
          state,
          tempRoot,
        });
        assert(
          sameWorkloads(measured.workloads, fixture.workloads),
          `synthetic workload identity mismatch for '${fixture.id}'`,
        );
        assert(
          measured.measurement?.phases,
          `synthetic measurement record missing for '${fixture.id}'`,
        );
        if (iteration < config.sampling.warmups) continue;
        observation.measurements.push({
          ...measured.measurement,
          iteration: iteration - config.sampling.warmups,
        });
        observation.workloads = measured.workloads;
        if (measured.counts) {
          observation.counts.failures += measured.counts.failures ?? 0;
          observation.counts.degraded += measured.counts.degraded ?? 0;
        }
        if (measured.fallback) observation.fallback = measured.fallback;
        if (measured.growth) observation.growth = measured.growth;
        if (measured.duration) observation.duration = measured.duration;
      }
      observation.sampling = { ...config.sampling };
      const {
        samples: _samples,
        components: _components,
        ...rawObservation
      } = observation;
      const derived = deriveBridgeFixtureEvidence(
        config,
        fixture,
        rawObservation,
      );
      assert(
        derived.reasons.length === 0,
        `synthetic contract mismatch for '${fixture.id}': ${derived.reasons.join(',')}`,
      );
      return derived.observation;
    });
    const gitRevision = revision(cwd);
    return {
      adapter: adapter.id,
      generatedAt: now().toISOString(),
      startedAt,
      provenance: {
        source: 'executed-in-run',
        fixtureCorpus: {
          id: config.fixtureCorpus.id,
          sha256: corpusDigest(config),
        },
        warmCold: {
          cold: 'fresh-100k-line corpus per file-open iteration',
          warm: 'five discarded warmups before measured iterations',
        },
        metadata: runtimeMetadata(gitRevision),
      },
      observations,
      foregroundWork: {
        version: 1,
        collector: 'manual-only',
        thresholdMs: 50,
        incidents: [],
        aggregate: { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
        native: {
          status: 'NOT_VERIFIED',
          reason: 'NATIVE_FOREGROUND_EXECUTOR_COLLECTOR_UNAVAILABLE',
        },
      },
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

/**
 * Reference measurements are delegated to the real-browser adapter. Keeping
 * its async Playwright lifecycle in a child process lets this contract remain
 * the sole checker while preserving the existing Node command surface.
 */
export function executeReferenceStationBenchmark(
  config,
  {
    cwd = process.cwd(),
    env = process.env,
    now = () => new Date(),
    execute = spawnSync,
    configPath = 'scripts/fixtures/interactive-workspace/performance-contract.json',
  } = {},
) {
  const result = execute(
    process.execPath,
    [
      'scripts/interactive-workspace-playwright-adapter.mjs',
      '--config',
      configPath,
    ],
    {
      cwd,
      env: { ...env, STATION_PERFORMANCE_NOW: now().toISOString() },
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  try {
    const run = JSON.parse(result.stdout);
    if (run.adapter === REAL_STATION_BROWSER_ADAPTER) return run;
  } catch {
    // The report below keeps unavailable browser/runtime evidence explicit.
  }
  return {
    adapter: 'unavailable-real-station-browser',
    generatedAt: now().toISOString(),
    provenance: {
      source: 'adapter-unavailable',
      diagnostics: referenceAdapterDiagnostics(result),
    },
    observations: config.fixtures.map((fixture) => ({
      fixtureId: fixture.id,
      status: 'NOT_VERIFIED',
      reasonCodes: ['REAL_STATION_BROWSER_ADAPTER_UNAVAILABLE'],
      counts: { failures: 0, degraded: 0 },
    })),
  };
}

const MAX_REFERENCE_ADAPTER_STDERR_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCE_ADAPTER_STDERR_TAIL_BYTES = 4 * 1024;

function boundedUtf8Tail(value, maxBytes) {
  const bytes = Buffer.from(typeof value === 'string' ? value : '', 'utf8');
  return bytes.subarray(Math.max(0, bytes.length - maxBytes)).toString('utf8');
}

function boundedReferenceAdapterStderr(value) {
  const stderr = typeof value === 'string' ? value : '';
  // spawnSync uses the same 10 MiB maxBuffer below. Refuse, rather than slice,
  // a larger injected result: slicing could cut through a secret before the
  // redactor can recognize and remove it.
  return Buffer.byteLength(stderr, 'utf8') <=
    MAX_REFERENCE_ADAPTER_STDERR_INPUT_BYTES
    ? stderr
    : '[stderr omitted: diagnostic input exceeded byte budget]';
}

function redactReferenceAdapterDiagnostic(value) {
  return value
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/giu, '$1 [REDACTED]')
    .replace(
      /\b(STATION_PERFORMANCE_(?:AUTHORIZATION|PEER_AUTHORIZATION))=\S+/giu,
      '$1=[REDACTED]',
    )
    .replace(
      /\b(authorization|token|password|secret)=([^\s&]+)/giu,
      '$1=[REDACTED]',
    );
}

function boundedDiagnosticCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value)
    ? value
    : null;
}

export function referenceAdapterDiagnostics(result) {
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  return {
    status: Number.isInteger(result?.status) ? result.status : null,
    signal: boundedDiagnosticCode(result?.signal),
    errorCode: boundedDiagnosticCode(result?.error?.code),
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stderrTail: boundedUtf8Tail(
      redactReferenceAdapterDiagnostic(
        boundedReferenceAdapterStderr(result?.stderr),
      ),
      MAX_REFERENCE_ADAPTER_STDERR_TAIL_BYTES,
    ),
  };
}

const MAX_PERFORMANCE_RECEIPT_FIXTURES = 16;
const MAX_PERFORMANCE_RECEIPT_REASONS = 32;
const MAX_PERFORMANCE_RECEIPT_FAILED_LIMITS = 32;
const PERFORMANCE_RECEIPT_DEGRADED_TOTAL =
  /^DEGRADED_TOTAL:(?:0|[1-9]\d{0,8})\/(?:0|[1-9]\d{0,8})$/u;
const PERFORMANCE_RECEIPT_CONTRACT = readJson(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures/interactive-workspace/performance-contract.json',
  ),
);
const PERFORMANCE_RECEIPT_FIXTURE_IDS = new Set(
  PERFORMANCE_RECEIPT_CONTRACT.fixtures.map((fixture) => fixture.id),
);
const PERFORMANCE_RECEIPT_FAILURE_VOCABULARY = new Map(
  PERFORMANCE_RECEIPT_CONTRACT.fixtures.map((fixture) => [
    fixture.id,
    {
      metricIds: new Set(fixture.metrics.map((metric) => metric.id)),
      metricLimits: new Map(
        fixture.metrics.map((metric) => [
          metric.id,
          metric.limits.map(({ stat, maxMs }) => ({ stat, maxMs })),
        ]),
      ),
      growthIds: new Set(Object.keys(fixture.growth ?? {})),
      growthLimits: new Map(
        Object.entries(fixture.growth ?? {}).map(([name, { maxDelta }]) => [
          name,
          maxDelta,
        ]),
      ),
      hasFallback: Boolean(fixture.fallback),
    },
  ]),
);
const PERFORMANCE_RECEIPT_FIXED_REASONS = new Set([
  'BRIDGE_FIXTURE_IDENTITIES_MISMATCH',
  'BUILD_MODE_MISMATCH',
  'FIXTURE_CORPUS_EVIDENCE_MISMATCH',
  'FOREGROUND_WORK_JOURNAL_UNAVAILABLE',
  'AUTHENTICATED_TASK_IDENTITY_UNAVAILABLE',
  'INVALID_REFERENCE_EVIDENCE',
  'MALFORMED_PRODUCTION_BRIDGE_EVIDENCE',
  'MISSING_HARDWARE_CPU',
  'MISSING_HARDWARE_DISPLAY',
  'MISSING_HARDWARE_GPU',
  'MISSING_HARDWARE_RAM',
  'MISSING_OS_METADATA',
  'PLAYWRIGHT_RUNTIME_UNAVAILABLE',
  'PRODUCTION_BUILD_RECEIPT_MISSING',
  'PRODUCTION_BUILD_RECEIPT_UNAVAILABLE',
  'PRODUCTION_MEASUREMENT_BRIDGE_UNAVAILABLE',
  'PRODUCTION_MEASUREMENT_MODE_UNAVAILABLE',
  'REAL_STATION_BROWSER_ADAPTER_ERROR',
  'REAL_STATION_BROWSER_ADAPTER_REQUIRED',
  'REAL_STATION_BROWSER_ADAPTER_UNAVAILABLE',
  'REAL_STATION_BROWSER_TARGET_INVALID',
  'REAL_STATION_BROWSER_TARGET_UNAVAILABLE',
  'REFERENCE_BROWSER_AUTH_CONTEXT_UNAVAILABLE',
  'REFERENCE_ENVIRONMENT_UNAVAILABLE',
  'REFERENCE_OS_MISMATCH',
  'REVISION_MISMATCH',
  'SOURCE_NOT_EXECUTED_IN_RUN',
  'STALE_OR_INVALID_TIMESTAMP',
  'SYNTHETIC_ADAPTER_FOR_REFERENCE',
  'UNKNOWN_SMOKE_ADAPTER',
  'WARM_COLD_EVIDENCE_MISMATCH',
  'WORK_BOARD_200_PIN_FIXTURE_UNAVAILABLE',
  'WORK_BOARD_ONE_HOUR_OBSERVATION_NOT_RUN',
  'WORK_BOARD_PERFORMANCE_BRIDGE_UNAVAILABLE',
  'WORK_BOARD_PERFORMANCE_DRIVER_UNAVAILABLE',
  'WORK_BOARD_PHYSICAL_ENVIRONMENT_UNAVAILABLE',
  'WORK_BOARD_PRODUCT_ACTION_UNAVAILABLE',
  'WORK_BOARD_PRODUCT_COMMIT_TIMEOUT',
  'WORK_BOARD_REFERENCE_OBSERVATION_NOT_RUN',
  'ONE_HOUR_REFERENCE_OBSERVATION_NOT_RUN',
  'PLAIN_TEXT_100K_SHIPPED_FILE_SURFACE_UNAVAILABLE',
  'RETAINED_10K_RECONNECT_FIXTURE_UNAVAILABLE',
  'SHIPPED_SURFACE_UNAVAILABLE',
  'TWO_PARTICIPANT_REFERENCE_SURFACE_UNAVAILABLE',
]);
const PERFORMANCE_RECEIPT_FIXTURE_REASON_PREFIXES = [
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
const PERFORMANCE_RECEIPT_GENERATED_REASONS = new Set(
  PERFORMANCE_RECEIPT_FIXTURE_REASON_PREFIXES.flatMap((prefix) =>
    [...PERFORMANCE_RECEIPT_FIXTURE_IDS].map(
      (fixtureId) => `${prefix}_${fixtureId}`,
    ),
  ),
);
const PERFORMANCE_RECEIPT_PRODUCT_MARK_FIXED_REASONS = new Set([
  'PRODUCT_COLLABORATION_CURSOR_RECEIPT_INVALID',
  'PRODUCT_COLLABORATION_DOCUMENT_TOO_SHORT',
  'PRODUCT_COLLABORATION_IDENTITIES_INVALID',
  'PRODUCT_COLLABORATION_PRESENCE_RECEIPT_INVALID',
  'PRODUCT_COLD_CORPUS_NOT_REBUILT',
  'PRODUCT_CORPUS_DRIVER_UNAVAILABLE',
  'PRODUCT_CORPUS_PATH_CHANGED',
  'PRODUCT_CORPUS_RECEIPT_INVALID',
  'PRODUCT_DIFF_COMMIT_TIMEOUT',
  'PRODUCT_DIFF_CONTENT_UNAVAILABLE',
  'PRODUCT_EPOCH_MISMATCH',
  'PRODUCT_FILE_DIFF_UNAVAILABLE',
  'PRODUCT_FILE_PREVIEW_COMMIT_TIMEOUT',
  'PRODUCT_FILE_PREVIEW_PROJECT_IDENTITY_UNAVAILABLE',
  'PRODUCT_FILE_PREVIEW_PROJECTION_INVALID',
  'PRODUCT_FILE_PREVIEW_SURFACE_UNAVAILABLE',
  'PRODUCT_FILE_REFERENCE_UNAVAILABLE',
  'PRODUCT_FILE_SCROLL_INVALID',
  'PRODUCT_FILE_TASK_WORKSPACE_UNAVAILABLE',
  'PRODUCT_LONG_SESSION_CURSOR_RECEIPT_INVALID',
  'PRODUCT_LONG_SESSION_DISPLAY_UNAVAILABLE',
  'PRODUCT_LONG_SESSION_DURATION_INSUFFICIENT',
  'PRODUCT_LONG_SESSION_PRESENCE_RECEIPT_INVALID',
  'PRODUCT_LONG_SESSION_RUNNER_UNAVAILABLE',
  'PRODUCT_MARK_FAILURE_UNCLASSIFIED',
  'PRODUCT_MARK_TIMEOUT',
  'PRODUCT_RECONNECT_ACTIVE_CURSOR_MISSING',
  'PRODUCT_RECONNECT_LAST_EVENT_ID_MISMATCH',
  'PRODUCT_RECONNECT_LAST_EVENT_ID_MISSING',
  'PRODUCT_RECONNECT_OFFLINE_FENCE_TIMEOUT',
  'PRODUCT_RECONNECT_OLD_STREAM_ABORT_TIMEOUT',
  'PRODUCT_RECONNECT_RENDER_TIMEOUT',
  'PRODUCT_RECONNECT_REQUEST_FENCE_TIMEOUT',
  'PRODUCT_RECONNECT_SEED_RECEIPT_INVALID',
  'PRODUCT_RECONNECT_STRATEGY_RECEIPT_INVALID',
  'PRODUCT_RECONNECT_STRATEGY_TIMEOUT',
  'PRODUCT_REMOTE_APPLY_REVISION_DIVERGED',
  'PRODUCT_REMOTE_CURSOR_TIMEOUT',
  'PRODUCT_ROOM_PRESENCE_TIMEOUT',
  'PRODUCT_SAVE_READINESS_TIMEOUT',
  'PRODUCT_SERVER_RECEIPT_UNAVAILABLE',
  'PRODUCT_SETTLED_ADOPTION_TIMEOUT',
  'PRODUCT_SETTLED_AUTHORIZATION_ENDED',
  'PRODUCT_SETTLED_DOCUMENT_STALE',
  'PRODUCT_SETTLED_READ_ONLY',
  'PRODUCT_SETTLED_REFUSED',
  'PRODUCT_SETTLED_ROOM_UNAVAILABLE',
  'PRODUCT_SETTLED_STATE_INDETERMINATE',
  'PRODUCT_TASK_COMMIT_TIMEOUT',
  'PRODUCT_TASK_IDENTITY_UNAVAILABLE',
  'PRODUCT_TASK_INPUT_TIMEOUT',
  'PRODUCT_WARM_CORPUS_REBUILT',
]);
const PERFORMANCE_RECEIPT_PRODUCT_MARK_CORPUS_REASONS = [
  'CONTROL_TIMEOUT',
  'CONTROL_CONNECTION',
  'CONTROL_FRAMING',
  'CONTROL_RECEIPT_TOO_LARGE',
  'CONTROL_INVALID_JSON',
  'CONTROL_UNKNOWN',
  'UNAVAILABLE',
  'REFUSED',
  'UNKNOWN',
  'CORPUS_ID_MISMATCH',
  'DIGEST_MISMATCH',
  'LINE_COUNT_MISMATCH',
];
const PERFORMANCE_RECEIPT_PRODUCT_MARK_COLLABORATION_ACTIONS = [
  'OWNER_PUBLISH',
  'PEER_PUBLISH',
  'OWNER_PRESENCE',
  'PEER_CURSOR',
  'OWNER_CURSOR',
  'NAVIGATION',
  'LEAVE',
  'OWNER_ABSENCE',
  'JOIN',
  'ANNOUNCE',
];
const PERFORMANCE_RECEIPT_PRODUCT_MARK_LIVE_OUTCOMES = [
  'DEPARTED',
  'JOINED',
  'UPDATED',
  'REFRESHED',
  'DEGRADED',
  'REFUSED',
  'UNAVAILABLE',
  'UNKNOWN',
];
const PERFORMANCE_RECEIPT_PRODUCT_MARK_FILE_STAGES = [
  'PREPARE_CORPUS',
  'OPEN_FILE',
  'SCROLL_FILE',
  'RENDER_DIFF',
];
const PERFORMANCE_RECEIPT_PRODUCT_MARK_PRESENCE_STAGES = [
  'NAVIGATION',
  'LEAVE',
  'OWNER_ABSENCE',
  'JOIN',
  'ANNOUNCE',
];
const PERFORMANCE_RECEIPT_RECONNECT_ITERATIONS = Array.from(
  {
    length:
      PERFORMANCE_RECEIPT_CONTRACT.sampling.warmups +
      PERFORMANCE_RECEIPT_CONTRACT.sampling.samples,
  },
  (_unused, iteration) => iteration,
);
const PERFORMANCE_RECEIPT_RECONNECT_STAGES = [
  'DELTA_OBSERVE',
  'GAP_OBSERVE',
  'RETAINED_SEED',
  'FALLBACK_BEYOND_SEED',
  ...PERFORMANCE_RECEIPT_RECONNECT_ITERATIONS.flatMap((iteration) => [
    `RETAINED_POOL_${iteration}`,
    `FALLBACK_POOL_${iteration}`,
    `RETAINED_SET_ONLINE_${iteration}`,
    `RETAINED_SAMPLE_${iteration}`,
    `FALLBACK_SET_ONLINE_${iteration}`,
    `FALLBACK_SAMPLE_${iteration}`,
  ]),
];
const PERFORMANCE_RECEIPT_ISOLATED_FIXTURE_BOUNDARIES = [
  'BUILD_RECEIPT',
  'TASK_AUTHORITY',
  'FALLBACK_AUTHORITY',
  'AUTHORITY_REFRESH',
  'PRODUCT_BRIDGE',
  'NAVIGATION',
  'CONTEXT',
  'TIMEOUT',
  'UNCLASSIFIED',
];
const PERFORMANCE_RECEIPT_RECONNECT_CLIENT_STAGES = [
  'NAVIGATION',
  'AUTHORITY',
  'RELOAD',
  'EDITOR',
  'BRIDGE',
  'CHECKPOINT',
];
const PERFORMANCE_RECEIPT_PRODUCT_MARK_GENERATED_REASONS = new Set([
  ...PERFORMANCE_RECEIPT_PRODUCT_MARK_CORPUS_REASONS.map(
    (reason) => `PRODUCT_FILE_100K_PREPARE_CORPUS_${reason}`,
  ),
  ...PERFORMANCE_RECEIPT_PRODUCT_MARK_FILE_STAGES.map(
    (stage) => `PRODUCT_FILE_100K_${stage}_FAILED`,
  ),
  ...PERFORMANCE_RECEIPT_PRODUCT_MARK_PRESENCE_STAGES.map(
    (stage) => `PRODUCT_COLLABORATION_PRESENCE_${stage}_FAILED`,
  ),
  ...PERFORMANCE_RECEIPT_PRODUCT_MARK_COLLABORATION_ACTIONS.flatMap(
    (action) => [
      `PRODUCT_COLLABORATION_${action}_FAILED`,
      ...PERFORMANCE_RECEIPT_PRODUCT_MARK_LIVE_OUTCOMES.map(
        (outcome) =>
          `PRODUCT_COLLABORATION_${action}_LIVE_COMMAND_OUTCOME_${outcome}`,
      ),
    ],
  ),
  ...PERFORMANCE_RECEIPT_RECONNECT_ITERATIONS.flatMap((iteration) => [
    `PRODUCT_RECONNECT_STRATEGY_TIMEOUT_AT_${iteration}`,
    `PRODUCT_RECONNECT_RENDER_TIMEOUT_AT_${iteration}`,
  ]),
]);
const PERFORMANCE_RECEIPT_ISOLATED_FIXTURE_REASONS = new Set([
  ...[...PERFORMANCE_RECEIPT_FIXTURE_IDS].flatMap((fixtureId) => [
    `PRODUCT_MARK_MEASUREMENT_FAILED_${fixtureId}`,
    `ISOLATED_FIXTURE_TASK_UNAVAILABLE_${fixtureId}`,
    ...PERFORMANCE_RECEIPT_ISOLATED_FIXTURE_BOUNDARIES.map(
      (boundary) => `ISOLATED_FIXTURE_${boundary}_FAILED_${fixtureId}`,
    ),
    ...PERFORMANCE_RECEIPT_RECONNECT_STAGES.flatMap((stage) => [
      `ISOLATED_FIXTURE_RECONNECT_${stage}_FAILED_${fixtureId}`,
      ...PERFORMANCE_RECEIPT_RECONNECT_CLIENT_STAGES.map(
        (client) =>
          `ISOLATED_FIXTURE_RECONNECT_${stage}_${client}_FAILED_${fixtureId}`,
      ),
    ]),
  ]),
]);
const PERFORMANCE_RECEIPT_PRODUCT_MARK_RECONNECT_DRIVER_SUFFIXES = new Set([
  '',
  '_STRATEGY',
  '_APPLY',
  '_EDITOR_MISSING',
  '_EDITOR_REVISION_MISMATCH',
  '_RENDER_NO_COMMIT',
  '_RENDER_TASK_MISMATCH',
  '_RENDER_BEFORE_APPLY',
  '_RENDER_MATCH_REJECTED',
  '_RENDER_REVISION_MISMATCH',
  '_RENDER',
]);
const PERFORMANCE_RECEIPT_PRODUCT_MARK_RECONNECT_DRIVER_FIXED_REASONS = new Set(
  [
    'OLD_STREAM_ABORT',
    'ACTIVE_CURSOR_MISSING',
    'RESUME_REQUEST_TIMEOUT',
    'RESUME_HEADER_MISSING',
    'RESUME_HEADER_MISMATCH',
    'SEED_RECEIPT_INVALID',
    'SEED_UNAVAILABLE',
    'UNCLASSIFIED',
  ].map((reason) => `PRODUCT_RECONNECT_DRIVER_${reason}`),
);

function boundedProductMarkReconnectDriverReason(reason) {
  if (
    PERFORMANCE_RECEIPT_PRODUCT_MARK_RECONNECT_DRIVER_FIXED_REASONS.has(reason)
  )
    return true;
  const prefix = 'PRODUCT_RECONNECT_DRIVER_';
  if (!reason.startsWith(prefix)) return false;
  const remainder = reason.slice(prefix.length);
  return PERFORMANCE_RECEIPT_RECONNECT_STAGES.some((stage) => {
    if (!remainder.startsWith(stage)) return false;
    const suffix = remainder.slice(stage.length);
    return (
      PERFORMANCE_RECEIPT_PRODUCT_MARK_RECONNECT_DRIVER_SUFFIXES.has(suffix) ||
      /^_DOCUMENT_(?:NONE|[1-5]\d{2})$/u.test(suffix)
    );
  });
}

function closedPerformanceReceiptStatus(value) {
  return ['PASS', 'FAIL', 'NOT_VERIFIED'].includes(value) ? value : 'UNKNOWN';
}

function closedPerformanceReceiptReasonCodes(value) {
  return (Array.isArray(value) ? value : [])
    .filter((reason) => {
      return (
        typeof reason === 'string' &&
        (PERFORMANCE_RECEIPT_FIXED_REASONS.has(reason) ||
          PERFORMANCE_RECEIPT_PRODUCT_MARK_FIXED_REASONS.has(reason) ||
          PERFORMANCE_RECEIPT_DEGRADED_TOTAL.test(reason) ||
          PERFORMANCE_RECEIPT_GENERATED_REASONS.has(reason) ||
          PERFORMANCE_RECEIPT_PRODUCT_MARK_GENERATED_REASONS.has(reason) ||
          PERFORMANCE_RECEIPT_ISOLATED_FIXTURE_REASONS.has(reason) ||
          boundedProductMarkReconnectDriverReason(reason))
      );
    })
    .slice(0, MAX_PERFORMANCE_RECEIPT_REASONS);
}

function closedPerformanceReceiptFixtureId(value) {
  return typeof value === 'string' && PERFORMANCE_RECEIPT_FIXTURE_IDS.has(value)
    ? value
    : 'UNKNOWN';
}

function closedPerformanceReceiptFailureCodes(fixture) {
  const fixtureId = closedPerformanceReceiptFixtureId(fixture?.fixtureId);
  if (fixture?.status !== 'FAIL') return [];
  if (fixtureId === 'UNKNOWN') return ['FAILURE_CATEGORY_UNAVAILABLE'];

  const vocabulary = PERFORMANCE_RECEIPT_FAILURE_VOCABULARY.get(fixtureId);
  const codes = new Set();
  const failures = fixture?.failures;
  let hasUnavailableCategory =
    !Array.isArray(failures) || failures.length === 0;
  for (const failure of Array.isArray(failures) ? failures : []) {
    if (typeof failure !== 'string') {
      hasUnavailableCategory = true;
      continue;
    }
    const budgetMetric = failure.match(/^budget:([A-Za-z0-9_-]{1,64})$/u)?.[1];
    if (budgetMetric && vocabulary.metricIds.has(budgetMetric)) {
      codes.add(`BUDGET_EXCEEDED_${fixtureId}_${budgetMetric}`);
      continue;
    }
    const growthMetric = failure.match(/^growth:([A-Za-z0-9_-]{1,64})$/u)?.[1];
    if (growthMetric && vocabulary.growthIds.has(growthMetric)) {
      codes.add(`GROWTH_BUDGET_EXCEEDED_${fixtureId}_${growthMetric}`);
      continue;
    }
    if (vocabulary.hasFallback && /^fallback:[^\r\n]{1,128}$/u.test(failure)) {
      codes.add('FALLBACK_CONTRACT_MISMATCH');
      continue;
    }
    if (/^operation-failures:[1-9]\d{0,8}$/u.test(failure)) {
      codes.add('OPERATION_FAILURES_REPORTED');
      continue;
    }
    if (
      new RegExp(
        `^degraded:[1-9]\\d{0,8}/${PERFORMANCE_RECEIPT_CONTRACT.degraded.maxPerFixture}$`,
        'u',
      ).test(failure)
    )
      codes.add('DEGRADED_PER_FIXTURE_BUDGET_EXCEEDED');
    else hasUnavailableCategory = true;
  }
  const maximumKnownCodes = hasUnavailableCategory
    ? MAX_PERFORMANCE_RECEIPT_REASONS - 1
    : MAX_PERFORMANCE_RECEIPT_REASONS;
  const receiptCodes = [...codes].slice(0, maximumKnownCodes);
  return hasUnavailableCategory
    ? [...receiptCodes, 'FAILURE_CATEGORY_UNAVAILABLE']
    : receiptCodes;
}

function ownFiniteNumber(value, key, { nonNegative = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    !descriptor ||
    !('value' in descriptor) ||
    !Number.isFinite(descriptor.value)
  )
    return null;
  return !nonNegative || descriptor.value >= 0 ? descriptor.value : null;
}

function closedPerformanceReceiptFailedLimits(fixture) {
  const fixtureId = closedPerformanceReceiptFixtureId(fixture?.fixtureId);
  if (fixture?.status !== 'FAIL' || fixtureId === 'UNKNOWN') return [];

  const vocabulary = PERFORMANCE_RECEIPT_FAILURE_VOCABULARY.get(fixtureId);
  const failures = Array.isArray(fixture?.failures) ? fixture.failures : [];
  const budgetMetrics = new Set();
  const growthNames = new Set();
  for (const failure of failures) {
    if (typeof failure !== 'string') continue;
    const budgetMetric = failure.match(/^budget:([A-Za-z0-9_-]{1,64})$/u)?.[1];
    if (budgetMetric && vocabulary.metricIds.has(budgetMetric)) {
      budgetMetrics.add(budgetMetric);
      continue;
    }
    const growthName = failure.match(/^growth:([A-Za-z0-9_-]{1,64})$/u)?.[1];
    if (growthName && vocabulary.growthIds.has(growthName))
      growthNames.add(growthName);
  }

  const failedLimits = [];
  for (const metric of budgetMetrics) {
    for (const { stat, maxMs } of vocabulary.metricLimits.get(metric)) {
      const observedMs = ownFiniteNumber(fixture?.metrics?.[metric], stat, {
        nonNegative: true,
      });
      if (observedMs !== null && observedMs > maxMs)
        failedLimits.push({ metric, stat, observedMs, maxMs });
    }
  }
  for (const name of growthNames) {
    const delta = ownFiniteNumber(fixture?.growth?.[name], 'delta');
    const maxDelta = vocabulary.growthLimits.get(name);
    if (delta !== null && delta > maxDelta)
      failedLimits.push({ name, delta, maxDelta });
  }
  return failedLimits.slice(0, MAX_PERFORMANCE_RECEIPT_FAILED_LIMITS);
}

/**
 * A report may be too large to retain in a hosted artifact, but its acceptance
 * disposition must still be recoverable from the job log. Keep this receipt
 * intentionally closed: it exposes fixture/status/reason codes and
 * contract-derived failure categories and failed aggregate limits only, never
 * browser state, identifiers, raw measurements, raw failure details, or
 * adapter stderr.
 */
export function performanceReportReceipt(report) {
  const fixtures = Array.isArray(report?.fixtures) ? report.fixtures : [];
  return {
    status: closedPerformanceReceiptStatus(report?.status),
    reasonCodes: closedPerformanceReceiptReasonCodes(report?.reasonCodes),
    fixtures: fixtures
      .slice(0, MAX_PERFORMANCE_RECEIPT_FIXTURES)
      .map((fixture) => {
        const status = closedPerformanceReceiptStatus(fixture?.status);
        const failedLimits =
          status === 'FAIL'
            ? closedPerformanceReceiptFailedLimits(fixture)
            : [];
        return {
          fixtureId: closedPerformanceReceiptFixtureId(fixture?.fixtureId),
          status,
          reasonCodes: closedPerformanceReceiptReasonCodes(
            fixture?.reasonCodes,
          ),
          ...(status === 'FAIL'
            ? {
                failureCodes: closedPerformanceReceiptFailureCodes(fixture),
                ...(failedLimits.length > 0 ? { failedLimits } : {}),
              }
            : {}),
        };
      }),
  };
}

/**
 * The browser harness deliberately expects an unavailable reference adapter on
 * non-Windows development hosts, but the physical Windows contract accepts
 * only a successful child evaluator. Keep that platform boundary executable
 * and independently testable instead of relying on a dangling `else`.
 */
export function referenceEvaluatorExitFailure(
  platformName,
  exitCode,
  fixtureId,
  report,
) {
  if (platformName === 'win32') {
    if (exitCode === 0) return null;
    return `Reference evaluator exited ${exitCode} for ${closedPerformanceReceiptFixtureId(fixtureId)}; receipt=${JSON.stringify(performanceReportReceipt(report))}`;
  }
  return exitCode === 2
    ? null
    : `Reference evaluator expected unavailable exit 2 on ${platformName}, received ${exitCode} for ${closedPerformanceReceiptFixtureId(fixtureId)}; receipt=${JSON.stringify(performanceReportReceipt(report))}`;
}

function evidenceReasons(config, run, { expectedRevision, mode, now }) {
  const reasons = [];
  const metadata = run.provenance?.metadata ?? {};
  const ageMs = now().getTime() - Date.parse(run.generatedAt);
  if (run.provenance?.source !== 'executed-in-run')
    reasons.push('SOURCE_NOT_EXECUTED_IN_RUN');
  if (mode === 'smoke' && run.adapter !== syntheticWorkspaceAdapter.id)
    reasons.push('UNKNOWN_SMOKE_ADAPTER');
  if (mode === 'reference' && run.adapter === syntheticWorkspaceAdapter.id)
    reasons.push('SYNTHETIC_ADAPTER_FOR_REFERENCE');
  if (mode === 'reference' && run.adapter !== REAL_STATION_BROWSER_ADAPTER)
    reasons.push('REAL_STATION_BROWSER_ADAPTER_REQUIRED');
  if (
    !Number.isFinite(ageMs) ||
    ageMs < 0 ||
    ageMs > config.referenceEnvironment.maxArtifactAgeMs
  )
    reasons.push('STALE_OR_INVALID_TIMESTAMP');
  if (metadata.revision !== expectedRevision) reasons.push('REVISION_MISMATCH');
  if (mode === 'reference') {
    for (const name of ['cpu', 'gpu', 'display'])
      if (!metadata[name])
        reasons.push(`MISSING_HARDWARE_${name.toUpperCase()}`);
    if (!Number.isFinite(metadata.ramBytes) || metadata.ramBytes <= 0)
      reasons.push('MISSING_HARDWARE_RAM');
    if (!metadata.os || !metadata.platform) reasons.push('MISSING_OS_METADATA');
    if (metadata.platform !== config.referenceEnvironment.platform)
      reasons.push('REFERENCE_OS_MISMATCH');
    if (metadata.buildMode !== config.referenceEnvironment.buildMode)
      reasons.push('BUILD_MODE_MISMATCH');
    if (
      metadata.build?.kind !== 'vite-production-bundle' ||
      !metadata.build?.sha256 ||
      !metadata.build?.uiCommit
    )
      reasons.push('PRODUCTION_BUILD_RECEIPT_MISSING');
  }
  return reasons;
}

function fixtureReport(config, fixture, observation, mode) {
  const foregroundWork = foregroundWorkReport(observation?.foregroundWork);
  const evidenceReasons = [
    mode === 'reference'
      ? bridgeFixtureReasons(config, fixture, observation)
      : !observation
        ? [`MISSING_FIXTURE_${fixture.id}`]
        : observation.status === 'NOT_VERIFIED'
          ? (observation.reasonCodes ?? [])
          : !sameWorkloads(observation.workloads, fixture.workloads)
            ? [`WORKLOAD_IDENTITY_MISMATCH_${fixture.id}`]
            : [],
    ...(foregroundWork.valid
      ? []
      : [`FOREGROUND_WORK_JOURNAL_UNAVAILABLE_${fixture.id}`]),
  ].flat();
  if (evidenceReasons.length > 0) {
    return {
      fixtureId: fixture.id,
      seam: fixture.seam,
      fixture: fixture.fixture,
      status: 'NOT_VERIFIED',
      decision: 'NOT_VERIFIED',
      counts: observation.counts ?? { failures: 0, degraded: 0 },
      failures: [],
      reasonCodes: evidenceReasons,
      foregroundWork: foregroundWork.report,
    };
  }
  const metrics = Object.fromEntries(
    fixture.metrics.map((metric) => {
      const statistics = percentiles(observation.samples[metric.id]);
      const limits = metric.limits.map((limit) => ({
        ...limit,
        observedMs: statistics[limit.stat],
        passed: statistics[limit.stat] <= limit.maxMs,
      }));
      return [
        metric.id,
        {
          ...statistics,
          limits,
          passed: limits.every((limit) => limit.passed),
        },
      ];
    }),
  );
  const components = Object.fromEntries(
    fixture.requiredComponents.map((name) => [
      name,
      percentiles(observation.components[name]),
    ]),
  );
  const growth = Object.fromEntries(
    Object.entries(fixture.growth ?? {}).map(([name, budget]) => {
      const { start, end } = observation.growth[name];
      return [
        name,
        {
          start,
          end,
          delta: end - start,
          maxDelta: budget.maxDelta,
          passed: end - start <= budget.maxDelta,
        },
      ];
    }),
  );
  const failures = observation.counts.failures;
  const degraded = observation.counts.degraded;
  const failed = [
    ...Object.entries(metrics)
      .filter(([, value]) => !value.passed)
      .map(([id]) => `budget:${id}`),
    ...Object.entries(growth)
      .filter(([, value]) => !value.passed)
      .map(([id]) => `growth:${id}`),
    ...(fixture.fallback &&
    (observation.fallback.retainedOperations !==
      fixture.fallback.retainedOperations ||
      observation.fallback.beyondWindowStrategy !==
        fixture.fallback.beyondWindowStrategy)
      ? [`fallback:${observation.fallback.beyondWindowStrategy}`]
      : []),
    ...(failures > 0 ? [`operation-failures:${failures}`] : []),
    ...(degraded > config.degraded.maxPerFixture
      ? [`degraded:${degraded}/${config.degraded.maxPerFixture}`]
      : []),
  ];
  return {
    fixtureId: fixture.id,
    seam: fixture.seam,
    fixture: fixture.fixture,
    status: failed.length === 0 ? 'PASS' : 'FAIL',
    decision:
      failed.length === 0 ? fixture.decision.onPass : fixture.decision.onFail,
    metrics,
    components,
    growth,
    fallback: observation.fallback ?? null,
    duration: observation.duration ?? null,
    counts: { failures, degraded },
    failures: failed,
    foregroundWork: foregroundWork.report,
  };
}

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === 'object' &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function notVerifiedForegroundWork() {
  return {
    version: FOREGROUND_WORK_JOURNAL_VERSION,
    collector: 'NOT_VERIFIED',
    collectorReason: FOREGROUND_WORK_COLLECTOR_UNSUPPORTED,
    thresholdMs: FOREGROUND_WORK_STALL_THRESHOLD_MS,
    incidents: [],
    aggregate: { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
    native: {
      status: 'NOT_VERIFIED',
      reason: NATIVE_FOREGROUND_EXECUTOR_COLLECTOR_UNAVAILABLE,
    },
  };
}

function foregroundWorkReport(raw) {
  const unavailable = {
    status: 'NOT_VERIFIED',
    reasonCodes: ['FOREGROUND_WORK_JOURNAL_UNAVAILABLE'],
    ...notVerifiedForegroundWork(),
  };
  if (
    !exactKeys(
      raw,
      raw?.collector === 'NOT_VERIFIED'
        ? [
            'version',
            'collector',
            'collectorReason',
            'thresholdMs',
            'incidents',
            'aggregate',
            'native',
          ]
        : [
            'version',
            'collector',
            'thresholdMs',
            'incidents',
            'aggregate',
            'native',
          ],
    ) ||
    raw.version !== FOREGROUND_WORK_JOURNAL_VERSION ||
    raw.thresholdMs !== FOREGROUND_WORK_STALL_THRESHOLD_MS ||
    !foregroundWorkCollectors.has(raw.collector) ||
    (raw.collector === 'NOT_VERIFIED'
      ? raw.collectorReason !== FOREGROUND_WORK_COLLECTOR_UNSUPPORTED
      : Object.hasOwn(raw, 'collectorReason')) ||
    !Array.isArray(raw.incidents) ||
    raw.incidents.length > 64
  )
    return { valid: false, report: unavailable };
  const incidents = raw.incidents;
  const valid = incidents.every(
    (incident) =>
      exactKeys(incident, [
        'phase',
        'interaction',
        'action',
        'pane',
        'source',
        'durationMs',
      ]) &&
      foregroundWorkPhases.has(incident.phase) &&
      foregroundWorkInteractions.has(incident.interaction) &&
      foregroundWorkActions.has(incident.action) &&
      foregroundWorkPanes.has(incident.pane) &&
      foregroundWorkSources.has(incident.source) &&
      Number.isFinite(incident.durationMs) &&
      incident.durationMs >= FOREGROUND_WORK_STALL_THRESHOLD_MS,
  );
  const aggregate = raw.aggregate;
  const totalDurationMs = incidents.reduce(
    (total, incident) => total + incident.durationMs,
    0,
  );
  const maxDurationMs = incidents.reduce(
    (max, incident) => Math.max(max, incident.durationMs),
    0,
  );
  if (
    !valid ||
    !exactKeys(aggregate, ['count', 'totalDurationMs', 'maxDurationMs']) ||
    !Number.isSafeInteger(aggregate.count) ||
    aggregate.count !== incidents.length ||
    !Number.isFinite(aggregate.totalDurationMs) ||
    aggregate.totalDurationMs !== totalDurationMs ||
    !Number.isFinite(aggregate.maxDurationMs) ||
    aggregate.maxDurationMs !== maxDurationMs ||
    !exactKeys(raw.native, ['status', 'reason']) ||
    raw.native.status !== 'NOT_VERIFIED' ||
    raw.native.reason !== NATIVE_FOREGROUND_EXECUTOR_COLLECTOR_UNAVAILABLE
  )
    return { valid: false, report: unavailable };
  return {
    valid: true,
    report: {
      status:
        raw.collector === 'browser-longtask' ? 'OBSERVED' : 'NOT_VERIFIED',
      ...(raw.collector === 'NOT_VERIFIED' && {
        reasonCodes: [FOREGROUND_WORK_COLLECTOR_UNSUPPORTED],
      }),
      version: raw.version,
      collector: raw.collector,
      ...(raw.collector === 'NOT_VERIFIED' && {
        collectorReason: raw.collectorReason,
      }),
      thresholdMs: raw.thresholdMs,
      incidents: incidents.map((incident) => ({ ...incident })),
      aggregate: { ...aggregate },
      native: { ...raw.native },
    },
  };
}

export function createNotVerifiedReport(
  config,
  reasonCodes,
  observations = [],
) {
  const reasons = Array.isArray(reasonCodes) ? reasonCodes : [reasonCodes];
  const totals = observations.reduce(
    (total, observation) => ({
      failures: total.failures + (observation.counts?.failures ?? 0),
      degraded: total.degraded + (observation.counts?.degraded ?? 0),
    }),
    { failures: 0, degraded: 0 },
  );
  return {
    schemaVersion: PERFORMANCE_REPORT_VERSION,
    contractVersion: config.contractVersion,
    status: 'NOT_VERIFIED',
    reasonCodes: reasons,
    fixtures: config.fixtures.map((fixture) => {
      const observation = observations.find(
        (item) => item.fixtureId === fixture.id,
      );
      return {
        fixtureId: fixture.id,
        seam: fixture.seam,
        status: 'NOT_VERIFIED',
        decision: 'NOT_VERIFIED',
        counts: observation?.counts ?? { failures: 0, degraded: 0 },
        reasonCodes: observation?.reasonCodes ?? reasons,
        foregroundWork: foregroundWorkReport(observation?.foregroundWork)
          .report,
      };
    }),
    summary: {
      PASS: 0,
      FAIL: 0,
      NOT_VERIFIED: config.fixtures.length,
      failures: totals.failures,
      degraded: totals.degraded,
    },
  };
}

export function evaluateInteractiveWorkspacePerformance(config, run, options) {
  const reasons = evidenceReasons(config, run, options);
  if (options.mode === 'reference' && reasons.length > 0)
    return createNotVerifiedReport(
      config,
      [INVALID_REFERENCE_EVIDENCE, ...reasons],
      run.observations,
    );
  const fixtures = config.fixtures.map((fixture) =>
    fixtureReport(
      config,
      fixture,
      run.observations.find((item) => item.fixtureId === fixture.id),
      options.mode,
    ),
  );
  const summary = {
    PASS: 0,
    FAIL: 0,
    NOT_VERIFIED: 0,
    failures: 0,
    degraded: 0,
  };
  let measuredDegraded = 0;
  for (const fixture of fixtures) {
    summary[fixture.status] += 1;
    summary.failures += fixture.counts.failures;
    summary.degraded += fixture.counts.degraded;
    if (fixture.status !== 'NOT_VERIFIED')
      measuredDegraded += fixture.counts.degraded;
  }
  const totalDegraded = measuredDegraded > config.degraded.maxTotal;
  const hasFailure = summary.FAIL > 0 || totalDegraded;
  const allPassed = !hasFailure && summary.NOT_VERIFIED === 0;
  return {
    schemaVersion: PERFORMANCE_REPORT_VERSION,
    contractVersion: config.contractVersion,
    status: hasFailure ? 'FAIL' : allPassed ? 'PASS' : 'NOT_VERIFIED',
    reasonCodes: totalDegraded
      ? [`DEGRADED_TOTAL:${summary.degraded}/${config.degraded.maxTotal}`]
      : reasons,
    provenance: run.provenance,
    fixtures,
    summary,
  };
}

function parseArgs(args) {
  const options = {
    mode: 'smoke',
    config: 'scripts/fixtures/interactive-workspace/performance-contract.json',
    output: null,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') options.json = true;
    else if (argument.startsWith('--mode=')) options.mode = argument.slice(7);
    else if (argument.startsWith('--config='))
      options.config = argument.slice(9);
    else if (argument.startsWith('--output='))
      options.output = argument.slice(9);
    else if (['--mode', '--config', '--output'].includes(argument)) {
      index += 1;
      const value = args[index];
      assert(value && !value.startsWith('--'), `${argument} requires a value`);
      options[argument.slice(2)] = value;
    } else throw new Error(`unknown option '${argument}'`);
  }
  assert(
    ['smoke', 'reference'].includes(options.mode),
    '--mode must be smoke or reference',
  );
  return options;
}

export function runInteractiveWorkspacePerformance(
  args,
  {
    cwd = process.cwd(),
    env = process.env,
    now = () => new Date(),
    adapter = syntheticWorkspaceAdapter,
    referenceAdapter = executeReferenceStationBenchmark,
  } = {},
) {
  const options = parseArgs(args);
  const config = readJson(resolve(cwd, options.config));
  const run =
    options.mode === 'reference'
      ? referenceAdapter(config, { cwd, env, now, configPath: options.config })
      : executeInteractiveWorkspaceBenchmark(config, {
          adapter,
          cwd,
          mode: options.mode,
          now,
        });
  const report = evaluateInteractiveWorkspacePerformance(config, run, {
    mode: options.mode,
    now,
    expectedRevision: revision(cwd),
  });
  report.measurement = options.mode;
  report.run = run;
  if (options.output) {
    const output = resolve(cwd, options.output);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  return { options, report };
}

function render(report) {
  const lines = [
    `Interactive workspace performance: ${report.status}`,
    `Rows: PASS=${report.summary.PASS}, FAIL=${report.summary.FAIL}, NOT_VERIFIED=${report.summary.NOT_VERIFIED}; failures=${report.summary.failures}; degraded=${report.summary.degraded}`,
    ...report.fixtures.map(
      (fixture) =>
        `${fixture.fixtureId}: ${fixture.status}; decision=${fixture.decision}`,
    ),
    ...(report.reasonCodes?.length
      ? [`Reasons: ${report.reasonCodes.join(', ')}`]
      : []),
  ];
  return `${lines.join('\n')}\n`;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { options, report } = runInteractiveWorkspacePerformance(
      process.argv.slice(2),
    );
    process.stdout.write(
      options.json ? `${JSON.stringify(report)}\n` : render(report),
    );
    process.exitCode =
      report.status === 'PASS' ? 0 : report.status === 'FAIL' ? 1 : 2;
  } catch (error) {
    process.stderr.write(
      `[interactive-workspace-performance] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
