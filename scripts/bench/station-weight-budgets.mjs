/**
 * Growth-only budgets for Station's idle weight and request overhead.
 *
 * A budget compares a measured value with a recorded baseline and fails only
 * when the value exceeds `baseline * (1 + ratio) + floor`. Shrinking never
 * fails, so a later improvement needs no baseline edit to pass. There are no
 * absolute magnitudes here: every limit comes from a value measured on the
 * same host (`host` scope, keyed by the host fingerprint) or from the
 * host-independent request baseline (`request` scope). A `report` scope
 * metric is reported with every run and never compared or recorded.
 *
 * A metric that was not measured, or that has no baseline to compare with,
 * is NOT_MEASURED with a reason. It is never PASS and never counted as zero,
 * and `gateOutcome` fails the run for it.
 */

const BASELINE_SCHEMA_VERSION = 2;

/**
 * `ratio` is proportional headroom; `floor` is additive headroom in the
 * metric's own unit, for metrics whose baseline can sit near zero.
 */
export const STATION_WEIGHT_BUDGETS = Object.freeze([
  // Report only: ready time follows host load, not the change under test.
  // On one host, medians of three launches took 5.2-6.1 s in one session and
  // 9.8 s twenty minutes later at similar load average; single launches
  // ranged 3.6-13.5 s. A ceiling either fails clean trees or catches nothing.
  // See docs/reference/station-weight.md#ready-time.
  { id: 'serverReadyMs', scope: 'report' },
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

const compared = (budget) => budget.scope !== 'report';

function baselineValues(baseline, budget, host) {
  if (budget.scope === 'request') return baseline?.request?.values;
  return baseline?.hosts?.[host?.fingerprint]?.values;
}

function checkSchema(baseline) {
  if (
    baseline !== undefined &&
    baseline.schemaVersion !== BASELINE_SCHEMA_VERSION
  )
    throw new Error(
      `baseline schemaVersion ${baseline.schemaVersion} is not ${BASELINE_SCHEMA_VERSION}`,
    );
}

/**
 * @param {{ host: { label?: string, fingerprint?: string }, metrics: Record<string, { status: string, value?: number, reason?: string }> }} result
 * @param {unknown} baseline
 * @param {{ reportOnly?: boolean }} [options]
 */
export function evaluateBudgets(result, baseline, { reportOnly = false } = {}) {
  checkSchema(baseline);
  return STATION_WEIGHT_BUDGETS.map((budget) => {
    const metric = result.metrics?.[budget.id];
    // Report-only metrics are checked first: missing, unmeasured or at any
    // value, they never reach the gate.
    if (!compared(budget))
      return metric?.status === 'measured' && Number.isFinite(metric.value)
        ? { id: budget.id, verdict: 'REPORTED', value: metric.value }
        : {
            id: budget.id,
            verdict: 'REPORTED',
            reason:
              metric?.status === 'measured'
                ? `measured without a finite value (${formatValue(metric.value)})`
                : (metric?.reason ?? 'metric absent from this run'),
          };
    if (metric?.status !== 'measured')
      return {
        id: budget.id,
        verdict: 'NOT_MEASURED',
        reason: metric?.reason ?? 'metric absent from this run',
      };
    if (!Number.isFinite(metric.value))
      throw new Error(`${budget.id} is measured but has no finite value`);
    if (reportOnly)
      return { id: budget.id, verdict: 'NOT_COMPARED', value: metric.value };
    const reference = baselineValues(baseline, budget, result.host)?.[
      budget.id
    ];
    if (!Number.isFinite(reference))
      return {
        id: budget.id,
        verdict: 'NOT_MEASURED',
        value: metric.value,
        reason:
          budget.scope === 'host'
            ? `no baseline for this host (fingerprint ${result.host?.fingerprint ?? 'unknown'}, ${result.host?.label ?? 'unknown platform'})`
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
 * Whether a run passes as a gate. A run that did not complete, a budget that
 * should have been compared and was not, and a budget past its headroom all
 * fail. Report-only mode compares nothing but still fails when a metric was
 * not measured: it skips the baseline, not the measurement.
 */
export function gateOutcome(result, verdicts, { reportOnly = false } = {}) {
  const reasons = [];
  if (result.outcome !== 'completed')
    reasons.push(
      `run ${result.outcome ?? 'unknown'}: ${String(result.reason ?? result.error ?? 'no reason recorded').split('\n')[0]}`,
    );
  const notMeasured = verdicts.filter(
    (entry) => entry.verdict === 'NOT_MEASURED',
  );
  if (notMeasured.length)
    reasons.push(
      `not compared: ${notMeasured.map((entry) => entry.id).join(', ')}`,
    );
  const failed = verdicts.filter((entry) => entry.verdict === 'FAIL');
  if (failed.length)
    reasons.push(`over budget: ${failed.map((entry) => entry.id).join(', ')}`);
  const comparedCount = verdicts.filter((entry) =>
    ['PASS', 'FAIL'].includes(entry.verdict),
  ).length;
  return {
    passed: reasons.length === 0,
    reasons,
    comparedCount,
    summary: reportOnly
      ? `REPORT_ONLY compared nothing: ${verdicts.filter((entry) => entry.verdict === 'NOT_COMPARED').length} budgets measured, 0 compared against a baseline`
      : `compared ${comparedCount} of ${verdicts.filter((entry) => entry.verdict !== 'REPORTED').length} budgets`,
  };
}

/**
 * Returns a new baseline with this run's measured values. Request values are
 * shared by every host; host values are stored under the run's host
 * fingerprint, with only a coarse platform label beside it. An incomplete or
 * dirty run is refused rather than recorded, so a gap can never delete or
 * replace a reference.
 */
export function recordBaseline(result, previous) {
  checkSchema(previous);
  if (result.outcome !== 'completed')
    throw new Error(
      `refusing to record a baseline from a ${result.outcome} run`,
    );
  if (result.dirty)
    throw new Error('refusing to record a baseline from a dirty tree');
  if (!result.host?.fingerprint || !result.host?.label)
    throw new Error('refusing to record a baseline without a host fingerprint');
  const missing = STATION_WEIGHT_BUDGETS.filter(compared)
    .filter((budget) => result.metrics?.[budget.id]?.status !== 'measured')
    .map((budget) => budget.id);
  if (missing.length)
    throw new Error(
      `refusing to record an incomplete baseline; not measured: ${missing.join(', ')}`,
    );
  const pick = (scope) =>
    Object.fromEntries(
      STATION_WEIGHT_BUDGETS.filter((budget) => budget.scope === scope).map(
        (budget) => [budget.id, result.metrics[budget.id].value],
      ),
    );
  const provenance = {
    sourceRevision: result.sourceRevision,
    recordedAt: result.startedAt,
  };
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    request: {
      ...provenance,
      claudeCodeVersion: result.request?.station?.claudeCodeVersion ?? null,
      values: pick('request'),
    },
    hosts: {
      ...(previous?.hosts ?? {}),
      [result.host.fingerprint]: {
        platform: result.host.label,
        ...provenance,
        values: pick('host'),
      },
    },
  };
}

export function formatVerdicts(verdicts) {
  return verdicts.map((entry) => {
    const detail =
      entry.verdict === 'NOT_MEASURED' || entry.value === undefined
        ? entry.reason
        : ['REPORTED', 'NOT_COMPARED'].includes(entry.verdict)
          ? `value=${formatValue(entry.value)}`
          : `value=${formatValue(entry.value)} baseline=${formatValue(entry.baseline)} limit=${formatValue(entry.limit)}`;
    return `[station-weight] ${entry.verdict} ${entry.id} ${detail}`;
  });
}

/**
 * A metric value for display: finite numbers to two decimals, a non-finite
 * number as `null` (what JSON writes for it, so a value prints the same in
 * memory and after a save), anything else as written. Presentation never
 * throws on a value the gate already handled.
 * @param {unknown} value
 */
export function formatValue(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  if (typeof value !== 'number') return String(value);
  return Number.isInteger(value) ? value : Number(value.toFixed(2));
}
