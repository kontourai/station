import { createHash } from 'node:crypto';
import {
  DAILY_DRIVER_PROFILES,
  DAILY_DRIVER_SCENARIOS,
} from '../daily-driver-profiles.mjs';
import {
  assertDailyDriverScenarioObservationSemantics,
  calculateDailyDriverScenarioObservationDigest,
  classifyScenarioObservation,
  deriveScenarioExpectation,
} from './daily-driver-scenario-observation.mjs';
import {
  assertDailyDriverUiObservationSemantics,
  calculateDailyDriverUiObservationDigest,
} from './daily-driver-ui-observation.mjs';
import { runWithinDeadline } from './verification-execution-lifecycle.mjs';
import { redactVerificationValue } from './verification-redaction.mjs';

export const DAILY_DRIVER_BUDGET_VERSION = 'daily-driver-v1';
export const DAILY_DRIVER_SURFACE = 'deterministic-harness';
export const EXACT_CONFIRMATION = 'STATION_SMOKE_OK';

const PRODUCT_SURFACES = Object.freeze(['ui', 'cli', 'phone']);
const PRODUCT_SURFACE_NOT_EXERCISED = 'PRODUCT_SURFACE_NOT_EXERCISED';

const EXPECTED_CLASSIFICATIONS = Object.freeze({
  trimmed: 'exact_match',
  malformed: 'rejected',
  empty: 'rejected',
  markdown: 'rejected',
  prefix: 'rejected',
  suffix: 'rejected',
  timeout: 'timed_out',
});
const REQUIRED_EXACT_OUTCOMES = Object.freeze(
  Object.keys(EXPECTED_CLASSIFICATIONS),
);

const OUTCOME_NAMES = new Set([
  'trimmed',
  'malformed',
  'empty',
  'markdown',
  'prefix',
  'suffix',
  'timeout',
]);

export const DETERMINISTIC_EXACT_OUTCOMES = Object.freeze([
  { outcome: 'trimmed', response: `  ${EXACT_CONFIRMATION}\n` },
  { outcome: 'malformed', response: null },
  { outcome: 'empty', response: '   ' },
  { outcome: 'markdown', response: `\`${EXACT_CONFIRMATION}\`` },
  { outcome: 'prefix', response: `result: ${EXACT_CONFIRMATION}` },
  { outcome: 'suffix', response: `${EXACT_CONFIRMATION}.` },
  { outcome: 'timeout' },
]);

/**
 * Deterministic multi-turn conversation-agreement harness (station#3307).
 *
 * The engine-shaped fakes below are provider-neutral: they consume an
 * accumulated conversation history — the contract a real engine's context
 * window provides — and never branch on a profile id or engine name. The
 * carry-over check is designed so only real history threading passes: the
 * final reply must derive a token that appears ONLY in the first turn, so an
 * engine that sees just the latest message cannot fake agreement.
 */
export const AGREEMENT_CONTEXT_TOKEN = 'CARRY-4821';

function agreementReplyFromEntry(entry, userTurns) {
  const match = /CARRY-[0-9]+/.exec(entry ?? '');
  return match ? `recall ${match[0]} turns=${userTurns}` : 'nothing recalled';
}

function historyDerivedAgreementEngine(history) {
  const first = history.find((entry) => entry.role === 'user');
  const userTurns = history.filter((entry) => entry.role === 'user').length;
  return agreementReplyFromEntry(first?.text, userTurns);
}

/** Negative control: sees only the latest turn, the way broken carry-over would. */
function historyBlindAgreementEngine(history) {
  const latest = history.at(-1);
  const userTurns = history.filter((entry) => entry.role === 'user').length;
  return agreementReplyFromEntry(latest?.text, userTurns);
}

export const DETERMINISTIC_AGREEMENT_OUTCOMES = Object.freeze([
  { outcome: 'carryover', engine: historyDerivedAgreementEngine },
  { outcome: 'history-blind', engine: historyBlindAgreementEngine },
]);

const EXPECTED_AGREEMENT_CLASSIFICATIONS = Object.freeze({
  carryover: 'context_carryover',
  'history-blind': 'context_missing',
});
const REQUIRED_AGREEMENT_OUTCOMES = Object.freeze(
  Object.keys(EXPECTED_AGREEMENT_CLASSIFICATIONS),
);

export function classifyAgreementReply(reply, turnsCompleted) {
  if (typeof reply !== 'string') return 'context_missing';
  return reply.includes(AGREEMENT_CONTEXT_TOKEN) &&
    reply.includes(`turns=${turnsCompleted}`)
    ? 'context_carryover'
    : 'context_missing';
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function calculateDeterministicObservationDigest({
  outcome,
  classification,
  expectationMet,
}) {
  return digest(`daily-driver:${outcome}:${classification}:${expectationMet}`);
}

function assertPositiveInteger(value, name, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum)
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
}

export function classifyExactConfirmation(value) {
  if (typeof value !== 'string') return 'rejected';
  return value.trim() === EXACT_CONFIRMATION ? 'exact_match' : 'rejected';
}

export function calculateTiming(samplesMs) {
  if (!Array.isArray(samplesMs) || samplesMs.length === 0)
    throw new Error('timing samples must not be empty');
  if (samplesMs.some((sample) => !Number.isFinite(sample) || sample < 0))
    throw new Error('timing samples must be non-negative finite numbers');
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  return {
    samplesMs: [...samplesMs],
    medianMs,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1),
  };
}

export async function runControlledTimeoutLifecycle({
  lifecycle = runWithinDeadline,
} = {}) {
  return lifecycle({
    lane: { id: 'daily-driver-exact-confirmation' },
    request: { key: 'deterministic' },
    deadline: 0,
    now: () => 0,
    fence() {},
    execute: ({ signal }) =>
      new Promise((resolve) => {
        signal?.addEventListener(
          'abort',
          () => resolve({ status: null, signal: 'SIGTERM' }),
          { once: true },
        );
      }),
  });
}

async function deterministicTimeoutRunner() {
  return { timedOut: true };
}

async function observeExactOutcome({ outcome, response, timeoutRunner }) {
  if (outcome !== 'timeout') {
    const classification = classifyExactConfirmation(response);
    const expectationMet = classification === EXPECTED_CLASSIFICATIONS[outcome];
    return {
      outcome,
      classification,
      expectationMet,
      digest: calculateDeterministicObservationDigest({
        outcome,
        classification,
        expectationMet,
      }),
    };
  }

  const lifecycle = await timeoutRunner();
  const classification = lifecycle.timedOut
    ? 'timed_out'
    : 'completed_before_timeout';
  const expectationMet = classification === EXPECTED_CLASSIFICATIONS.timeout;
  return {
    outcome,
    classification,
    expectationMet,
    digest: calculateDeterministicObservationDigest({
      outcome,
      classification,
      expectationMet,
    }),
  };
}

function assertOutcomes(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length === 0)
    throw new Error(
      'exactOutcomes must contain at least one deterministic outcome',
    );
  for (const item of outcomes)
    if (!item || !OUTCOME_NAMES.has(item.outcome))
      throw new Error('exactOutcomes contains an unsupported outcome');
}

async function exactObservations({ outcomes, timeoutRunner }) {
  return Promise.all(
    outcomes.map(({ outcome, response }) =>
      observeExactOutcome({
        outcome,
        response,
        timeoutRunner,
      }),
    ),
  );
}

function assertAgreementOutcomes(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length === 0)
    throw new Error(
      'agreementOutcomes must contain at least one deterministic outcome',
    );
  for (const item of outcomes)
    if (
      !item ||
      !REQUIRED_AGREEMENT_OUTCOMES.includes(item.outcome) ||
      typeof item.engine !== 'function'
    )
      throw new Error('agreementOutcomes contains an unsupported outcome');
}

async function buildAgreementRow({ profile, scenario, repetition, outcomes }) {
  // The old in-memory engine accepted three writes against one array and
  // called that conversation continuity. It had no Session lifecycle, route,
  // SQLite lineage, restart, or terminal-reuse refusal, so it stayed green
  // while the live product rejected every second turn (#3307/#3409/#3912).
  // Keep the deterministic engines available as negative-control utilities,
  // but never promote their canned history fold to product capability proof.
  void outcomes;
  return {
    profile: profile.id,
    surface: DAILY_DRIVER_SURFACE,
    scenario: scenario.id,
    repetition,
    capability: scenario.capability,
    status: 'NOT_VERIFIED',
    reasonCode: 'REAL_LIFECYCLE_ROUTE_QUALIFICATION_REQUIRED',
    evidence: { observations: [] },
  };
}

/**
 * Scenarios whose acceptance rule is about mounted browser rows, paint, and
 * scroll behavior. An in-process harness cannot honestly observe those, so
 * its rows say exactly that instead of "not implemented" — the browser
 * producer (`tests/daily-driver-scenarios.spec.ts`) supplies the UI rows.
 */
const BROWSER_SURFACE_SCENARIOS = Object.freeze(
  new Set([
    'liveness-settlement',
    'transcript-stability',
    'performance-stress',
  ]),
);

function browserOnlyRow(profile, scenario, repetition) {
  return {
    profile: profile.id,
    surface: DAILY_DRIVER_SURFACE,
    scenario: scenario.id,
    repetition,
    capability: scenario.capability,
    status: 'NOT_VERIFIED',
    reasonCode: 'SCENARIO_REQUIRES_BROWSER_SURFACE',
    evidence: { observations: [] },
  };
}

function unverifiedRow(profile, scenario, repetition) {
  return {
    profile: profile.id,
    surface: DAILY_DRIVER_SURFACE,
    scenario: scenario.id,
    repetition,
    capability: scenario.capability,
    status: 'NOT_VERIFIED',
    reasonCode: 'SCENARIO_NOT_IMPLEMENTED_IN_HARNESS',
    evidence: { observations: [] },
  };
}

function productPlaceholderRow(profile, scenario, repetition, surface) {
  return {
    profile: profile.id,
    surface,
    scenario: scenario.id,
    repetition,
    capability: scenario.capability,
    status: 'NOT_VERIFIED',
    reasonCode: PRODUCT_SURFACE_NOT_EXERCISED,
    evidence: { observations: [] },
  };
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length)
    throw new Error(`${label} must be unique`);
}

function rowKey(row) {
  return [
    row.profile,
    row.surface,
    row.scenario,
    row.repetition,
    row.capability,
  ].join('|');
}

function hasCompleteExactOutcomeSet(observations) {
  const outcomes = observations.map((observation) => observation.outcome);
  return (
    outcomes.length === REQUIRED_EXACT_OUTCOMES.length &&
    new Set(outcomes).size === outcomes.length &&
    REQUIRED_EXACT_OUTCOMES.every((outcome) => outcomes.includes(outcome))
  );
}

function validateDefinitionCoverage(profiles, scenarios) {
  assertUnique(
    profiles.map((profile) => profile.id),
    'profile ids',
  );
  assertUnique(
    scenarios.map((scenario) => scenario.id),
    'scenario ids',
  );
  assertUnique(
    scenarios.map((scenario) => scenario.capability),
    'scenario capabilities',
  );

  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const scenarioById = new Map(
    scenarios.map((scenario) => [scenario.id, scenario]),
  );
  const scenarioByCapability = new Map(
    scenarios.map((scenario) => [scenario.capability, scenario]),
  );
  for (const profile of profiles) {
    assertUnique(
      profile.requiredCapabilities,
      `${profile.id} required capabilities`,
    );
    assertUnique(
      profile.optionalCapabilities,
      `${profile.id} optional capabilities`,
    );
    for (const capability of profile.requiredCapabilities)
      if (!scenarioByCapability.has(capability))
        throw new Error(
          `required capability '${capability}' for '${profile.id}' has no scenario`,
        );
  }
  return { profileById, scenarioById, scenarioByCapability };
}

function expectedMatrixKeys(profiles, scenarioByCapability, repetitions) {
  const expectedKeys = new Set();
  for (const profile of profiles) {
    for (const capability of profile.requiredCapabilities) {
      const scenario = scenarioByCapability.get(capability);
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        expectedKeys.add(
          rowKey({
            profile: profile.id,
            surface: DAILY_DRIVER_SURFACE,
            scenario: scenario.id,
            repetition,
            capability,
          }),
        );
        for (const surface of PRODUCT_SURFACES)
          expectedKeys.add(
            rowKey({
              profile: profile.id,
              surface,
              scenario: scenario.id,
              repetition,
              capability,
            }),
          );
      }
    }
  }
  return expectedKeys;
}

function assertExactRow(row, key, observations) {
  if (observations.length === 0)
    throw new Error(`exact-confirmation row '${key}' has no observations`);
  for (const observation of observations) {
    const expected = EXPECTED_CLASSIFICATIONS[observation.outcome];
    const expectationMet = observation.classification === expected;
    if (
      !expected ||
      observation.expectationMet !== expectationMet ||
      observation.digest !==
        calculateDeterministicObservationDigest(observation)
    )
      throw new Error(`exact-confirmation row '${key}' has false evidence`);
  }
  const passed =
    hasCompleteExactOutcomeSet(observations) &&
    observations.every((observation) => observation.expectationMet === true);
  const expectedStatus = passed ? 'PASS' : 'FAIL';
  const expectedReason = passed
    ? 'EXACT_CONFIRMATION_HARNESS_PASS'
    : 'EXACT_CONFIRMATION_HARNESS_FAILED';
  if (row.status !== expectedStatus || row.reasonCode !== expectedReason)
    throw new Error(`exact-confirmation row '${key}' has a false verdict`);
  return passed;
}

function assertUiExactRow(row, key, observations) {
  const [observation] = observations;
  if (
    observations.length !== 1 ||
    observation?.outcome !== 'ui-product-path' ||
    observation.profile !== row.profile ||
    observation.surface !== row.surface ||
    observation.scenario !== row.scenario ||
    observation.capability !== row.capability ||
    row.repetition !== 1 ||
    observation.repetition !== row.repetition ||
    observation.assistantMessageCount !== 1 ||
    observation.terminal !== true ||
    observation.workingCleared !== true ||
    observation.workingStable !== true ||
    observation.commandBinding !== true ||
    observation.identityBinding !== true ||
    observation.projectBinding !== true ||
    observation.classification !== 'exact_match' ||
    observation.expectationMet !== true ||
    row.status !== 'PASS' ||
    row.reasonCode !== 'UI_EXACT_CONFIRMATION_PASS' ||
    observation.digest !==
      calculateDailyDriverUiObservationDigest(observation, observation)
  )
    throw new Error(`UI exact-confirmation row '${key}' has false evidence`);
}

function assertAgreementRow(row, key, observations) {
  if (
    observations.length !== 0 ||
    row.status !== 'NOT_VERIFIED' ||
    row.reasonCode !== 'REAL_LIFECYCLE_ROUTE_QUALIFICATION_REQUIRED'
  )
    throw new Error(`conversation-agreement row '${key}' has a false verdict`);
  return true;
}

const UI_SCENARIO_REASONS = Object.freeze({
  'liveness-settlement': {
    pass: 'UI_LIVENESS_SETTLEMENT_PASS',
    fail: 'UI_LIVENESS_SETTLEMENT_FAILED',
  },
  'conversation-agreement': {
    pass: 'UI_CONVERSATION_AGREEMENT_PASS',
    fail: 'UI_CONVERSATION_AGREEMENT_FAILED',
  },
  'agent-engine-handoff': {
    pass: 'UI_AGENT_ENGINE_HANDOFF_PASS',
    fail: 'UI_AGENT_ENGINE_HANDOFF_FAILED',
  },
  // `_STRUCTURE_PASS`, not `_PASS`: both of these capabilities also declare a
  // timing budget, and the row proves only the structural half. The budget
  // verdict lives in `timing.aggregates` and can be FAIL while this row is
  // PASS, so an unqualified PASS here would read as the whole declared rule.
  'transcript-stability': {
    pass: 'UI_TRANSCRIPT_STABILITY_STRUCTURE_PASS',
    fail: 'UI_TRANSCRIPT_STABILITY_FAILED',
  },
  'performance-stress': {
    pass: 'UI_PERFORMANCE_STRESS_STRUCTURE_PASS',
    fail: 'UI_PERFORMANCE_STRESS_FAILED',
  },
});

function assertUiScenarioRow(row, key, observations) {
  const reasons = UI_SCENARIO_REASONS[row.scenario];
  const [observation] = observations;
  if (
    !reasons ||
    observations.length !== 1 ||
    observation?.outcome !== 'ui-scenario' ||
    observation.profile !== row.profile ||
    observation.surface !== row.surface ||
    observation.scenario !== row.scenario ||
    observation.capability !== row.capability ||
    row.repetition !== 1 ||
    observation.repetition !== row.repetition
  )
    throw new Error(`UI scenario row '${key}' has false evidence`);
  const { outcome, producer, testId, sourceRevision, digest, ...semantic } =
    observation;
  // The classification is re-derived here, not just carried: a stored report
  // can be replayed, and the digest is recomputable from the row's own
  // fields, so it catches a typo rather than a forgery. Without this a row
  // could carry a passing-looking label over failing evidence — the same
  // split the producer path refuses.
  if (
    observation.classification !== classifyScenarioObservation(semantic) ||
    observation.expectationMet !== deriveScenarioExpectation(semantic) ||
    digest !==
      calculateDailyDriverScenarioObservationDigest(observation, semantic)
  )
    throw new Error(`UI scenario row '${key}' has false evidence`);
  const expectedStatus = observation.expectationMet ? 'PASS' : 'FAIL';
  const expectedReason = observation.expectationMet
    ? reasons.pass
    : reasons.fail;
  if (row.status !== expectedStatus || row.reasonCode !== expectedReason)
    throw new Error(`UI scenario row '${key}' has a false verdict`);
}

function assertUnimplementedRow(row, key, observations) {
  if (
    row.status !== 'NOT_VERIFIED' ||
    row.reasonCode !== 'SCENARIO_NOT_IMPLEMENTED_IN_HARNESS' ||
    observations.length !== 0
  )
    throw new Error(
      `unimplemented row '${key}' is not explicitly NOT_VERIFIED`,
    );
}

function assertBrowserOnlyRow(row, key, observations) {
  if (
    row.status !== 'NOT_VERIFIED' ||
    row.reasonCode !== 'SCENARIO_REQUIRES_BROWSER_SURFACE' ||
    observations.length !== 0
  )
    throw new Error(
      `browser-surface row '${key}' is not explicitly NOT_VERIFIED`,
    );
}

function assertProductPlaceholder(row, key, observations) {
  if (
    row.status !== 'NOT_VERIFIED' ||
    row.reasonCode !== PRODUCT_SURFACE_NOT_EXERCISED ||
    observations.length !== 0
  )
    throw new Error(`product row '${key}' is not explicitly NOT_VERIFIED`);
}

function assertMatrixRows(report, definitions, expectedKeys) {
  const { profileById, scenarioById } = definitions;

  const actualKeys = report.rows.map(rowKey);
  assertUnique(actualKeys, 'matrix row keys');
  if (actualKeys.length !== expectedKeys.size)
    throw new Error(
      'matrix row count does not match required profile coverage',
    );

  let expectedHarnessStatus = 'PASS';
  for (const row of report.rows) {
    const key = rowKey(row);
    if (!expectedKeys.has(key))
      throw new Error(`unexpected matrix row '${key}'`);
    const scenario = scenarioById.get(row.scenario);
    if (
      !profileById.has(row.profile) ||
      !scenario ||
      row.capability !== scenario.capability
    )
      throw new Error(`matrix row '${key}' has invalid references`);
    if (row.repetition < 1 || row.repetition > report.run.repetitions)
      throw new Error(`matrix row '${key}' has invalid repetition`);

    const observations = row.evidence?.observations ?? [];
    if (
      row.surface === DAILY_DRIVER_SURFACE &&
      scenario.id === 'exact-confirmation'
    ) {
      if (!assertExactRow(row, key, observations))
        expectedHarnessStatus = 'FAIL';
    } else if (
      row.surface === DAILY_DRIVER_SURFACE &&
      scenario.id === 'conversation-agreement'
    ) {
      if (!assertAgreementRow(row, key, observations))
        expectedHarnessStatus = 'FAIL';
    } else if (
      row.surface === DAILY_DRIVER_SURFACE &&
      BROWSER_SURFACE_SCENARIOS.has(scenario.id)
    )
      assertBrowserOnlyRow(row, key, observations);
    else if (row.surface === DAILY_DRIVER_SURFACE)
      assertUnimplementedRow(row, key, observations);
    else if (
      row.surface === 'ui' &&
      scenario.id === 'exact-confirmation' &&
      row.status === 'PASS'
    )
      assertUiExactRow(row, key, observations);
    else if (
      row.surface === 'ui' &&
      UI_SCENARIO_REASONS[scenario.id] &&
      row.status !== 'NOT_VERIFIED'
    ) {
      assertUiScenarioRow(row, key, observations);
      // A browser-surface FAIL is a failed run, not a footnote under a
      // passing harness — the expected fold must see it too.
      if (row.status === 'FAIL') expectedHarnessStatus = 'FAIL';
    } else assertProductPlaceholder(row, key, observations);
  }
  return expectedHarnessStatus;
}

/**
 * Versioned provisional budgets from
 * `docs/strategy/daily-driver-qualification.md` for the measures the browser
 * scenario producer can honestly sample. Budgets it cannot sample stay out of
 * this table so nothing fabricates an aggregate for them.
 */
export const DAILY_DRIVER_TIMING_BUDGETS = Object.freeze([
  {
    scenario: 'transcript-stability',
    capability: 'transcript-stability',
    samplesField: 'restoreSamplesMs',
    budgetMs: 750,
  },
  {
    scenario: 'performance-stress',
    capability: 'performance-stress',
    samplesField: 'deltaPaintSamplesMs',
    budgetMs: 100,
  },
]);

function timingAggregatesFor(uiScenarioObservation) {
  const aggregates = [];
  for (const observation of uiScenarioObservation.observations)
    for (const budget of DAILY_DRIVER_TIMING_BUDGETS) {
      if (observation.scenario !== budget.scenario) continue;
      const samples = observation[budget.samplesField];
      if (!Array.isArray(samples) || samples.length === 0) continue;
      const timing = calculateTiming(samples);
      aggregates.push({
        profile: observation.profile,
        surface: 'ui',
        scenario: budget.scenario,
        capability: budget.capability,
        ...timing,
        budgetMs: budget.budgetMs,
        budgetStatus: timing.p95Ms <= budget.budgetMs ? 'PASS' : 'FAIL',
        budgetVersion: DAILY_DRIVER_BUDGET_VERSION,
      });
    }
  return aggregates;
}

function buildTimingSection(uiScenarioObservation) {
  const aggregates = uiScenarioObservation
    ? timingAggregatesFor(uiScenarioObservation)
    : [];
  if (aggregates.length === 0)
    return {
      budgetVersion: DAILY_DRIVER_BUDGET_VERSION,
      status: 'NOT_VERIFIED',
      reasonCode: 'PRODUCT_TIMING_NOT_MEASURED',
      aggregates: [],
    };
  // UI-measured samples are real product-surface evidence, but CLI/phone and
  // the remaining budget lines are not measured, so the section as a whole
  // stays NOT_VERIFIED — the aggregates carry what was actually observed.
  return {
    budgetVersion: DAILY_DRIVER_BUDGET_VERSION,
    status: 'NOT_VERIFIED',
    reasonCode: 'PRODUCT_TIMING_PARTIALLY_MEASURED',
    aggregates,
  };
}

function assertTimingClaims(report) {
  const timing = report.timing;
  if (timing?.status !== 'NOT_VERIFIED')
    throw new Error('deterministic reports cannot claim verified timing');
  if (timing.reasonCode === 'PRODUCT_TIMING_NOT_MEASURED') {
    if (timing.aggregates?.length !== 0)
      throw new Error('unmeasured timing sections cannot carry aggregates');
    return;
  }
  if (timing.reasonCode !== 'PRODUCT_TIMING_PARTIALLY_MEASURED')
    throw new Error('deterministic timing has an unsupported reason code');
  if (!Array.isArray(timing.aggregates) || timing.aggregates.length === 0)
    throw new Error('partially measured timing must carry aggregates');
  for (const aggregate of timing.aggregates) {
    const budget = DAILY_DRIVER_TIMING_BUDGETS.find(
      (candidate) => candidate.scenario === aggregate.scenario,
    );
    const row = report.rows.find(
      (candidate) =>
        candidate.surface === 'ui' &&
        candidate.profile === aggregate.profile &&
        candidate.scenario === aggregate.scenario &&
        candidate.status !== 'NOT_VERIFIED',
    );
    const samples =
      row?.evidence?.observations?.[0]?.[budget?.samplesField ?? ''];
    if (
      !budget ||
      aggregate.surface !== 'ui' ||
      aggregate.capability !== budget.capability ||
      aggregate.budgetMs !== budget.budgetMs ||
      !Array.isArray(samples) ||
      JSON.stringify(aggregate.samplesMs) !== JSON.stringify(samples)
    )
      throw new Error(
        `timing aggregate '${aggregate.profile}|${aggregate.scenario}' is not backed by a UI scenario row`,
      );
    const recomputed = calculateTiming(samples);
    const expectedStatus =
      recomputed.p95Ms <= budget.budgetMs ? 'PASS' : 'FAIL';
    if (
      aggregate.medianMs !== recomputed.medianMs ||
      aggregate.p95Ms !== recomputed.p95Ms ||
      aggregate.maxMs !== recomputed.maxMs ||
      aggregate.budgetStatus !== expectedStatus
    )
      throw new Error(
        `timing aggregate '${aggregate.profile}|${aggregate.scenario}' has a false derivation`,
      );
  }
}

function assertDeterministicClaims(report, expectedHarnessStatus) {
  if (report.run.mode !== 'deterministic')
    throw new Error('live qualification report semantics are not implemented');
  const measuredBudgetFailed = report.timing?.aggregates?.some(
    (aggregate) => aggregate.budgetStatus === 'FAIL',
  );
  const expectedRunStatus =
    expectedHarnessStatus === 'FAIL' || measuredBudgetFailed ? 'FAIL' : 'PASS';
  if (report.run.harnessStatus !== expectedRunStatus)
    throw new Error('harnessStatus does not match exercised row verdicts');
  if (
    report.promotion?.status !== 'NOT_VERIFIED' ||
    !report.promotion.reasonCodes?.includes('REQUIRED_LIVE_ROWS_NOT_VERIFIED')
  )
    throw new Error('deterministic reports cannot claim promotion');
  assertTimingClaims(report);
}

/** Enforces fail-closed matrix relationships JSON Schema cannot express. */
export function assertDailyDriverQualificationSemantics(report) {
  if (report?.schemaVersion !== 1)
    throw new Error('daily-driver report schemaVersion must be 1');
  const profiles = report.profiles ?? [];
  const scenarios = report.scenarios ?? [];
  const definitions = validateDefinitionCoverage(profiles, scenarios);
  const expectedKeys = expectedMatrixKeys(
    profiles,
    definitions.scenarioByCapability,
    report.run.repetitions,
  );
  const harnessStatus = assertMatrixRows(report, definitions, expectedKeys);
  assertDeterministicClaims(report, harnessStatus);

  return report;
}

function buildUiExactRows({ profiles, scenarios, uiObservation }) {
  if (!uiObservation) return [];
  assertDailyDriverUiObservationSemantics(uiObservation, profiles);
  const exactScenario = scenarios.find(
    (scenario) => scenario.capability === 'exact-confirmation',
  );
  if (!exactScenario) throw new Error('exact-confirmation scenario is missing');
  return uiObservation.observations.map((observation) => ({
    profile: observation.profile,
    surface: 'ui',
    scenario: exactScenario.id,
    repetition: observation.repetition,
    capability: exactScenario.capability,
    status: 'PASS',
    reasonCode: 'UI_EXACT_CONFIRMATION_PASS',
    evidence: {
      observations: [
        {
          ...observation,
          outcome: 'ui-product-path',
          expectationMet: true,
          producer: uiObservation.producer,
          testId: uiObservation.testId,
          sourceRevision: uiObservation.sourceRevision,
        },
      ],
    },
  }));
}

function buildUiScenarioRows({ profiles, scenarios, uiScenarioObservation }) {
  if (!uiScenarioObservation) return [];
  assertDailyDriverScenarioObservationSemantics(
    uiScenarioObservation,
    profiles,
  );
  return uiScenarioObservation.observations.map((observation) => {
    const scenario = scenarios.find(
      (candidate) => candidate.id === observation.scenario,
    );
    const reasons = UI_SCENARIO_REASONS[observation.scenario];
    if (!scenario || !reasons || scenario.capability !== observation.capability)
      throw new Error(
        `UI scenario observation '${observation.scenario}' has no matching scenario`,
      );
    const passed = observation.expectationMet === true;
    return {
      profile: observation.profile,
      surface: 'ui',
      scenario: scenario.id,
      repetition: observation.repetition,
      capability: scenario.capability,
      status: passed ? 'PASS' : 'FAIL',
      reasonCode: passed ? reasons.pass : reasons.fail,
      evidence: {
        observations: [
          {
            ...observation,
            outcome: 'ui-scenario',
            producer: uiScenarioObservation.producer,
            testId: uiScenarioObservation.testId,
            sourceRevision: uiScenarioObservation.sourceRevision,
          },
        ],
      },
    };
  });
}

async function buildExactRow({
  profile,
  scenario,
  repetition,
  exactOutcomes,
  timeoutRunner,
}) {
  const observations = await exactObservations({
    outcomes: exactOutcomes,
    timeoutRunner,
  });
  const passed =
    hasCompleteExactOutcomeSet(observations) &&
    observations.every((observation) => observation.expectationMet);
  return {
    profile: profile.id,
    surface: DAILY_DRIVER_SURFACE,
    scenario: scenario.id,
    repetition,
    capability: scenario.capability,
    status: passed ? 'PASS' : 'FAIL',
    reasonCode: passed
      ? 'EXACT_CONFIRMATION_HARNESS_PASS'
      : 'EXACT_CONFIRMATION_HARNESS_FAILED',
    evidence: { observations },
  };
}

async function buildDeterministicRow({
  profile,
  scenario,
  repetition,
  exactOutcomes,
  timeoutRunner,
  agreementOutcomes,
}) {
  if (scenario.id === 'exact-confirmation')
    return buildExactRow({
      profile,
      scenario,
      repetition,
      exactOutcomes,
      timeoutRunner,
    });
  if (scenario.id === 'conversation-agreement')
    return buildAgreementRow({
      profile,
      scenario,
      repetition,
      outcomes: agreementOutcomes,
    });
  if (BROWSER_SURFACE_SCENARIOS.has(scenario.id))
    return browserOnlyRow(profile, scenario, repetition);
  return unverifiedRow(profile, scenario, repetition);
}

async function buildDeterministicRows({
  profiles,
  scenarios,
  repetitions,
  exactOutcomes,
  timeoutRunner,
  agreementOutcomes,
}) {
  const rows = [];
  for (const profile of profiles)
    for (const scenario of scenarios) {
      if (!profile.requiredCapabilities.includes(scenario.capability)) continue;
      for (let repetition = 1; repetition <= repetitions; repetition += 1)
        rows.push(
          await buildDeterministicRow({
            profile,
            scenario,
            repetition,
            exactOutcomes,
            timeoutRunner,
            agreementOutcomes,
          }),
        );
    }
  return rows;
}

function buildProductRows({ profiles, scenarios, repetitions }) {
  const rows = [];
  for (const profile of profiles)
    for (const scenario of scenarios) {
      if (!profile.requiredCapabilities.includes(scenario.capability)) continue;
      for (let repetition = 1; repetition <= repetitions; repetition += 1)
        for (const surface of PRODUCT_SURFACES)
          rows.push(
            productPlaceholderRow(profile, scenario, repetition, surface),
          );
    }
  return rows;
}

function replaceProductRows(rows, replacements) {
  const replacementsByKey = new Map(
    replacements.map((row) => [rowKey(row), row]),
  );
  const availableKeys = new Set(rows.map(rowKey));
  for (const key of replacementsByKey.keys())
    if (!availableKeys.has(key))
      throw new Error(`UI observation replacement has no matrix row '${key}'`);
  return rows.map((row) => replacementsByKey.get(rowKey(row)) ?? row);
}

function qualificationEnvelope({
  profiles,
  scenarios,
  rows,
  repetitions,
  timeoutMs,
  uiScenarioObservation,
}) {
  const timing = buildTimingSection(uiScenarioObservation);
  const measuredBudgetFailed = timing.aggregates.some(
    (aggregate) => aggregate.budgetStatus === 'FAIL',
  );
  return {
    schemaVersion: 1,
    run: {
      mode: 'deterministic',
      repetitions,
      timeoutMs,
      // Any exercised row that FAILED poisons the run — a UI scenario row
      // included. Folding only the in-process rows here let a browser-surface
      // FAIL sit under `harnessStatus: 'PASS'`.
      harnessStatus:
        rows.some((row) => row.status === 'FAIL') || measuredBudgetFailed
          ? 'FAIL'
          : 'PASS',
    },
    profiles,
    scenarios,
    rows,
    timing,
    promotion: {
      status: 'NOT_VERIFIED',
      reasonCodes: ['REQUIRED_LIVE_ROWS_NOT_VERIFIED'],
    },
  };
}

/** Creates a safe, deterministic qualification report without calling an engine. */
export async function createDailyDriverQualificationReport({
  profiles = DAILY_DRIVER_PROFILES,
  scenarios = DAILY_DRIVER_SCENARIOS,
  repetitions = 1,
  timeoutMs = 5,
  exactOutcomes = DETERMINISTIC_EXACT_OUTCOMES,
  timeoutRunner = deterministicTimeoutRunner,
  agreementOutcomes = DETERMINISTIC_AGREEMENT_OUTCOMES,
  uiObservation,
  uiScenarioObservation,
} = {}) {
  assertPositiveInteger(repetitions, 'repetitions', 100);
  assertPositiveInteger(timeoutMs, 'timeoutMs', 60_000);
  assertOutcomes(exactOutcomes);
  assertAgreementOutcomes(agreementOutcomes);
  validateDefinitionCoverage(profiles, scenarios);
  const rows = await buildDeterministicRows({
    profiles,
    scenarios,
    repetitions,
    exactOutcomes,
    timeoutRunner,
    agreementOutcomes,
  });
  const uiRows = [
    ...buildUiExactRows({ profiles, scenarios, uiObservation }),
    ...buildUiScenarioRows({ profiles, scenarios, uiScenarioObservation }),
  ];
  const productRows = buildProductRows({ profiles, scenarios, repetitions });
  const report = redactVerificationValue(
    qualificationEnvelope({
      profiles,
      scenarios,
      rows: replaceProductRows([...rows, ...productRows], uiRows),
      repetitions,
      timeoutMs,
      uiScenarioObservation,
    }),
  );
  return assertDailyDriverQualificationSemantics(report);
}
