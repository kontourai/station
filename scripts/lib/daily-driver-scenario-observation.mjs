import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../../schemas/daily-driver-scenario-observation.schema.json' with {
  type: 'json',
};

const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

export const SCENARIO_OBSERVATION_PRODUCER = 'station-daily-driver-scenarios';
export const SCENARIO_OBSERVATION_TEST_ID = 'daily-driver-ui-scenarios';

/**
 * Semantic fields per scenario, in digest order. Deliberately explicit rather
 * than `Object.keys`: the digest must not silently absorb a field a producer
 * forgot to bound, and must break loudly when the shape changes.
 */
const SCENARIO_DIGEST_FIELDS = Object.freeze({
  'liveness-settlement': [
    'profile',
    'surface',
    'scenario',
    'capability',
    'repetition',
    'answerRenderings',
    'liveRowsAfterResume',
    'failureRenderings',
    'failureBanners',
    'classification',
    'expectationMet',
  ],
  'conversation-agreement': [
    'profile',
    'surface',
    'scenario',
    'capability',
    'repetition',
    'completedTurns',
    'conversationStable',
    'carryOverBound',
    'continuationRouteUsed',
    'distinctSessionCount',
    'terminalPredecessorCount',
    'terminalReuseRefused',
    'persistedLineage',
    'reloadExactlyOnce',
    'settled',
    'classification',
    'expectationMet',
  ],
  'agent-engine-handoff': [
    'profile',
    'surface',
    'scenario',
    'capability',
    'repetition',
    'targetProfile',
    'explicitRouteUsed',
    'conversationStable',
    'targetSessionDistinct',
    'disclosureComplete',
    'targetAgentApplied',
    'persistedMarker',
    'markerExactlyOnce',
    'classification',
    'expectationMet',
  ],
  'transcript-stability': [
    'profile',
    'surface',
    'scenario',
    'capability',
    'repetition',
    'fixtureTurnCount',
    'mountedRowCap',
    'maxMountedRows',
    'loadedRows',
    'orderStable',
    'tailBound',
    'restoreSamplesMs',
    'classification',
    'expectationMet',
  ],
  'performance-stress': [
    'profile',
    'surface',
    'scenario',
    'capability',
    'repetition',
    'scrollHeldDuringStream',
    'taskSwitchStable',
    'queueDrained',
    'mountedRowsDuringStream',
    'loadedRows',
    'mountedRowCap',
    'settled',
    'deltaPaintSamplesMs',
    'classification',
    'expectationMet',
  ],
});

export const SCENARIO_FAILING_CLASSIFICATIONS = Object.freeze({
  'liveness-settlement': 'flashed_or_duplicated',
  'conversation-agreement': 'context_missing',
  'agent-engine-handoff': 'handoff_failed',
  'transcript-stability': 'unbounded',
  'performance-stress': 'stress_failed',
});

export const SCENARIO_PASSING_CLASSIFICATIONS = Object.freeze({
  'liveness-settlement': 'settled_once',
  'conversation-agreement': 'context_carryover',
  'agent-engine-handoff': 'handoff_visible',
  'transcript-stability': 'structurally_bounded',
  'performance-stress': 'stress_bounded',
});

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function digestFieldsFor(observation) {
  const fields = SCENARIO_DIGEST_FIELDS[observation?.scenario];
  if (!fields)
    throw new Error(
      `unsupported daily-driver scenario observation '${observation?.scenario}'`,
    );
  return fields;
}

function observationPayload(observation) {
  return Object.fromEntries(
    digestFieldsFor(observation).map((field) => [field, observation[field]]),
  );
}

export function calculateDailyDriverScenarioObservationDigest(
  provenance,
  observation,
) {
  return digest(
    `daily-driver-scenario-observation:v1:${JSON.stringify({
      producer: provenance.producer,
      testId: provenance.testId,
      sourceRevision: provenance.sourceRevision,
      ...observationPayload(observation),
    })}`,
  );
}

/**
 * The evidence half of every scenario verdict, with no reference to the
 * producer's own `classification`. `classifyScenarioObservation` and
 * `deriveScenarioExpectation` both read THIS, so a spec cannot compute a
 * classification by one rule while the contract judges it by another.
 */
export function meetsScenarioEvidence(observation) {
  switch (observation.scenario) {
    case 'liveness-settlement':
      // The settled answer renders exactly once with no reconstructed live
      // row, and the single failure renders on exactly one surface. Both
      // halves are probe-proven against the pre-station#3330 bundle: the
      // live-row half nets station#3300, the failure half nets station#3299.
      // A single-symbol revert does not reproduce either — see the producer
      // spec's header before concluding an assertion here is powerless.
      return (
        observation.answerRenderings === 1 &&
        observation.liveRowsAfterResume === 0 &&
        observation.failureRenderings === 1 &&
        observation.failureBanners === 0
      );
    case 'conversation-agreement':
      return (
        observation.completedTurns >= 3 &&
        observation.conversationStable === true &&
        observation.carryOverBound === true &&
        observation.continuationRouteUsed === true &&
        observation.distinctSessionCount >= 3 &&
        observation.terminalPredecessorCount >= 2 &&
        observation.terminalPredecessorCount ===
          observation.distinctSessionCount - 1 &&
        observation.terminalReuseRefused === true &&
        observation.persistedLineage === true &&
        observation.reloadExactlyOnce === true &&
        observation.settled === true
      );
    case 'agent-engine-handoff':
      return (
        observation.targetProfile !== observation.profile &&
        observation.explicitRouteUsed === true &&
        observation.conversationStable === true &&
        observation.targetSessionDistinct === true &&
        observation.disclosureComplete === true &&
        observation.targetAgentApplied === true &&
        observation.persistedMarker === true &&
        observation.markerExactlyOnce === true
      );
    case 'transcript-stability':
      // `loadedRows > mountedRowCap` is the POWER clause: a transcript that
      // never held more rows than the cap cannot have exceeded it, so a cap
      // claim over such a run would be a label with nothing behind it.
      return (
        observation.maxMountedRows <= observation.mountedRowCap &&
        observation.loadedRows > observation.mountedRowCap &&
        observation.orderStable === true &&
        observation.tailBound === true &&
        observation.restoreSamplesMs.length > 0
      );
    case 'performance-stress':
      // Same POWER clause as transcript-stability, for the same reason: a
      // stream measured over a transcript that never held more rows than the
      // cap allows cannot have exceeded it, so the cap claim would be
      // unfalsifiable without it.
      return (
        observation.scrollHeldDuringStream === true &&
        observation.taskSwitchStable === true &&
        observation.queueDrained === true &&
        observation.mountedRowsDuringStream <= observation.mountedRowCap &&
        observation.loadedRows > observation.mountedRowCap &&
        observation.settled === true &&
        observation.deltaPaintSamplesMs.length > 0
      );
    default:
      return false;
  }
}

/** The classification an observation's own evidence supports. */
export function classifyScenarioObservation(observation) {
  const table = meetsScenarioEvidence(observation)
    ? SCENARIO_PASSING_CLASSIFICATIONS
    : SCENARIO_FAILING_CLASSIFICATIONS;
  const classification = table[observation.scenario];
  if (!classification)
    throw new Error(
      `unsupported daily-driver scenario observation '${observation?.scenario}'`,
    );
  return classification;
}

/**
 * The scenario an observation claims must derive its expectation from its own
 * evidence fields — a producer cannot stamp `expectationMet: true` over a
 * failing measurement, nor a passing classification over failing evidence.
 */
export function deriveScenarioExpectation(observation) {
  return (
    observation.classification ===
      SCENARIO_PASSING_CLASSIFICATIONS[observation.scenario] &&
    meetsScenarioEvidence(observation)
  );
}

function assertArtifactShape(artifact) {
  if (!validate(artifact))
    throw new Error(
      `invalid daily-driver scenario observation: ${JSON.stringify(validate.errors)}`,
    );
}

/** Builds a bounded scenario observation artifact; raw text is never an input. */
export function createDailyDriverScenarioObservation({
  sourceRevision = 'unverified',
  observations,
}) {
  if (!Array.isArray(observations) || observations.length === 0)
    throw new Error('scenario observations must be a non-empty array');
  const provenance = {
    schemaVersion: 1,
    producer: SCENARIO_OBSERVATION_PRODUCER,
    testId: SCENARIO_OBSERVATION_TEST_ID,
    sourceRevision,
  };
  const artifact = {
    ...provenance,
    observations: observations.map((observation) => {
      // A supplied classification must be the one this observation's evidence
      // supports. Without this a producer could stamp `stress_bounded` over a
      // failing measurement and the artifact would carry a passing-looking
      // label beside `expectationMet: false` — the exact split this contract
      // exists to prevent.
      const classification = classifyScenarioObservation(observation);
      if (
        observation.classification !== undefined &&
        observation.classification !== classification
      )
        throw new Error(
          `scenario observation '${observation.scenario}' claims a classification its evidence does not support`,
        );
      const expectationMet = deriveScenarioExpectation({
        ...observation,
        classification,
      });
      if (
        observation.expectationMet !== undefined &&
        observation.expectationMet !== expectationMet
      )
        throw new Error(
          `scenario observation '${observation.scenario}' claims an expectation its evidence does not derive`,
        );
      const derived = { ...observation, classification, expectationMet };
      return {
        ...derived,
        digest: calculateDailyDriverScenarioObservationDigest(
          provenance,
          derived,
        ),
      };
    }),
  };
  assertArtifactShape(artifact);
  return artifact;
}

/**
 * Merges per-test artifacts written by one Playwright producer run into a
 * single artifact. Fails closed on provenance divergence or duplicate
 * profile/scenario coverage.
 */
export function mergeDailyDriverScenarioObservations(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0)
    throw new Error(
      'scenario observation merge requires at least one artifact',
    );
  for (const artifact of artifacts) assertArtifactShape(artifact);
  const [first] = artifacts;
  for (const artifact of artifacts)
    if (
      artifact.producer !== first.producer ||
      artifact.testId !== first.testId ||
      artifact.sourceRevision !== first.sourceRevision
    )
      throw new Error(
        'scenario observation artifacts disagree on producer provenance',
      );
  const merged = {
    schemaVersion: 1,
    producer: first.producer,
    testId: first.testId,
    sourceRevision: first.sourceRevision,
    observations: artifacts.flatMap((artifact) => artifact.observations),
  };
  assertArtifactShape(merged);
  return merged;
}

/** Enforces integrity and per-profile uniqueness for scenario observations. */
export function assertDailyDriverScenarioObservationSemantics(
  artifact,
  profiles,
) {
  assertArtifactShape(artifact);
  if (!/^[0-9a-f]{40}$/.test(artifact.sourceRevision))
    throw new Error(
      'scenario observation sourceRevision must be a Git revision',
    );
  if (!Array.isArray(profiles) || profiles.length === 0)
    throw new Error('scenario observation profiles must be a non-empty array');
  const profileIds = new Set(profiles.map((profile) => profile.id));
  const seen = new Set();
  for (const observation of artifact.observations) {
    if (!profileIds.has(observation.profile))
      throw new Error(
        `scenario observation has unknown profile '${observation.profile}'`,
      );
    if (
      observation.scenario === 'agent-engine-handoff' &&
      !profileIds.has(observation.targetProfile)
    )
      throw new Error(
        `scenario observation has unknown target profile '${observation.targetProfile}'`,
      );
    const key = `${observation.profile}|${observation.scenario}`;
    if (seen.has(key))
      throw new Error(`scenario observation has duplicate coverage '${key}'`);
    seen.add(key);
    if (observation.classification !== classifyScenarioObservation(observation))
      throw new Error(
        `scenario observation '${key}' claims a classification its evidence does not support`,
      );
    if (observation.expectationMet !== deriveScenarioExpectation(observation))
      throw new Error(
        `scenario observation '${key}' claims an expectation its evidence does not derive`,
      );
    if (
      observation.digest !==
      calculateDailyDriverScenarioObservationDigest(artifact, observation)
    )
      throw new Error(`scenario observation '${key}' has a tampered digest`);
  }
  return artifact;
}
