/**
 * Growth-only budgets for Station's idle weight and request overhead.
 *
 * A budget compares a measured value with a recorded baseline and fails only
 * when the value exceeds `baseline * (1 + ratio) + floor`. Shrinking never
 * fails, so a later improvement needs no baseline edit to pass. There are no
 * absolute magnitudes here: every limit comes from a value measured on the
 * same host class (`host` scope) or from the host-independent request
 * baseline (`request` scope).
 *
 * A metric that was not measured, or that has no baseline to compare with,
 * is NOT_MEASURED with a reason. It is never PASS and never counted as zero.
 */

export const BASELINE_SCHEMA_VERSION = 1;

/**
 * `ratio` is proportional headroom; `floor` is additive headroom in the
 * metric's own unit, for metrics whose baseline can sit near zero.
 */
export const STATION_WEIGHT_BUDGETS = Object.freeze([
  // Launch timing swings with host load: clean runs on one loaded host
  // ranged 3.6-8.6 s, so a 50% ceiling failed a clean tree.
  { id: 'serverReadyMs', scope: 'host', ratio: 1, floor: 0 },
  { id: 'restMemoryBytes', scope: 'host', ratio: 0.25, floor: 0 },
  { id: 'idleSessionsMemoryBytes', scope: 'host', ratio: 0.25, floor: 0 },
  // Percentage points: a near-idle tree must not fail on scheduler noise.
  { id: 'idleCpuPercent', scope: 'host', ratio: 1, floor: 1 },
  {
    id: 'leftoverAfterStopMemoryBytes',
    scope: 'host',
    ratio: 0.25,
    floor: 0,
  },
  {
    id: 'request.stationAddedTextBytes',
    scope: 'request',
    ratio: 0.1,
    floor: 0,
  },
  {
    id: 'request.stationAddedToolCount',
    scope: 'request',
    ratio: 0.1,
    floor: 0,
  },
  {
    id: 'request.stationAddedToolDefinitionBytes',
    scope: 'request',
    ratio: 0.1,
    floor: 0,
  },
  // A new side request (for example a title call) is a discrete change, not
  // noise; the ceiling is the baseline count and only growth fails.
  { id: 'request.sideCallCount', scope: 'request', ratio: 0, floor: 0 },
]);

/** Host class: host-scope baselines only compare like with like. */
export function hostClass(host) {
  return `${host.platform}-${host.arch}`;
}

function baselineValues(baseline, budget, klass) {
  if (budget.scope === 'request') return baseline?.request?.values;
  return baseline?.hosts?.[klass]?.values;
}

/**
 * @param {{ host: { platform: string, arch: string }, metrics: Record<string, { status: string, value?: number, reason?: string }> }} result
 * @param {unknown} baseline
 */
export function evaluateBudgets(result, baseline) {
  const klass = hostClass(result.host);
  if (
    baseline !== undefined &&
    baseline.schemaVersion !== BASELINE_SCHEMA_VERSION
  )
    throw new Error(
      `baseline schemaVersion ${baseline.schemaVersion} is not ${BASELINE_SCHEMA_VERSION}`,
    );
  return STATION_WEIGHT_BUDGETS.map((budget) => {
    const metric = result.metrics?.[budget.id];
    if (metric?.status !== 'measured')
      return {
        id: budget.id,
        verdict: 'NOT_MEASURED',
        reason: metric?.reason ?? 'metric absent from this run',
      };
    if (!Number.isFinite(metric.value))
      throw new Error(`${budget.id} is measured but has no finite value`);
    const reference = baselineValues(baseline, budget, klass)?.[budget.id];
    if (!Number.isFinite(reference))
      return {
        id: budget.id,
        verdict: 'NOT_MEASURED',
        value: metric.value,
        reason:
          budget.scope === 'host'
            ? `no ${klass} baseline for this metric`
            : 'no request baseline for this metric',
      };
    const limit = reference * (1 + budget.ratio) + budget.floor;
    return {
      id: budget.id,
      verdict: metric.value > limit ? 'FAIL' : 'PASS',
      value: metric.value,
      baseline: reference,
      limit,
    };
  });
}

/**
 * Returns a new baseline with this run's measured values. Request values are
 * shared by every host; host values are stored under the run's host class.
 */
export function recordBaseline(result, previous) {
  const klass = hostClass(result.host);
  const next = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    request: previous?.request,
    hosts: { ...(previous?.hosts ?? {}) },
  };
  const pick = (scope) =>
    Object.fromEntries(
      STATION_WEIGHT_BUDGETS.filter((budget) => budget.scope === scope)
        .map((budget) => [budget.id, result.metrics?.[budget.id]])
        .filter(([, metric]) => metric?.status === 'measured')
        .map(([id, metric]) => [id, metric.value]),
    );
  const provenance = {
    sourceRevision: result.sourceRevision,
    recordedAt: result.startedAt,
  };
  const requestValues = pick('request');
  if (Object.keys(requestValues).length)
    next.request = {
      ...provenance,
      claudeCodeVersion: result.request?.station?.claudeCodeVersion ?? null,
      values: requestValues,
    };
  const hostValues = pick('host');
  if (Object.keys(hostValues).length)
    next.hosts[klass] = {
      ...provenance,
      host: {
        release: result.host.release,
        cpuModel: result.host.cpuModel,
        cpus: result.host.cpus,
        totalMemoryBytes: result.host.totalMemoryBytes,
      },
      values: hostValues,
    };
  return next;
}

export function formatVerdicts(verdicts) {
  return verdicts.map((entry) => {
    const detail =
      entry.verdict === 'NOT_MEASURED'
        ? entry.reason
        : `value=${round(entry.value)} baseline=${round(entry.baseline)} limit=${round(entry.limit)}`;
    return `[station-weight] ${entry.verdict} ${entry.id} ${detail}`;
  });
}

function round(value) {
  return Number.isInteger(value) ? value : Number(value.toFixed(2));
}
