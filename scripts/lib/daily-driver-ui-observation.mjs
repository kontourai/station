import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../../schemas/daily-driver-ui-observation.schema.json' with {
  type: 'json',
};

const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

const DIGEST_FIELDS = [
  'profile',
  'surface',
  'scenario',
  'capability',
  'repetition',
  'assistantMessageCount',
  'terminal',
  'workingCleared',
  'workingStable',
  'commandBinding',
  'identityBinding',
  'projectBinding',
  'classification',
];

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function observationPayload(observation) {
  return Object.fromEntries(
    DIGEST_FIELDS.map((field) => [field, observation[field]]),
  );
}

function provenancePayload({ producer, testId, sourceRevision }) {
  return { producer, testId, sourceRevision };
}

export function calculateDailyDriverUiObservationDigest(
  provenance,
  observation,
) {
  return digest(
    `daily-driver-ui-observation:v1:${JSON.stringify({
      ...provenancePayload(provenance),
      ...observationPayload(observation),
    })}`,
  );
}

function requiredProfiles(profiles) {
  if (!Array.isArray(profiles) || profiles.length === 0)
    throw new Error('UI observation profiles must be a non-empty array');
  return profiles.filter((profile) =>
    profile.requiredCapabilities?.includes('exact-confirmation'),
  );
}

function assertObservationShape(observation) {
  if (!validate(observation))
    throw new Error(
      `invalid daily-driver UI observation: ${JSON.stringify(validate.errors)}`,
    );
}

/** Builds a bounded UI observation; raw prompts, output, and session identity are never inputs. */
export function createDailyDriverUiObservation({
  sourceRevision = 'unverified',
  observations,
}) {
  if (!Array.isArray(observations))
    throw new Error('UI observations must be an array');
  const provenance = {
    schemaVersion: 1,
    producer: 'station-cross-runtime-chat-switching',
    testId: 'daily-driver-ui-exact-confirmation',
    sourceRevision,
  };
  const artifact = {
    ...provenance,
    observations: observations.map((observation) => ({
      ...observation,
      digest: calculateDailyDriverUiObservationDigest(provenance, observation),
    })),
  };
  assertObservationShape(artifact);
  return artifact;
}

/** Enforces source-independent profile coverage and semantic evidence integrity. */
export function assertDailyDriverUiObservationSemantics(artifact, profiles) {
  assertObservationShape(artifact);
  if (!/^[0-9a-f]{40}$/.test(artifact.sourceRevision))
    throw new Error('UI observation sourceRevision must be a Git revision');

  const required = requiredProfiles(profiles);
  const expectedProfileIds = new Set(required.map((profile) => profile.id));
  const actualProfileIds = new Set();
  for (const observation of artifact.observations) {
    if (!expectedProfileIds.has(observation.profile))
      throw new Error(
        `UI observation has unknown profile '${observation.profile}'`,
      );
    if (actualProfileIds.has(observation.profile))
      throw new Error(
        `UI observation has duplicate profile '${observation.profile}'`,
      );
    actualProfileIds.add(observation.profile);
    if (observation.classification !== 'exact_match')
      throw new Error(`UI observation '${observation.profile}' is not exact`);
    if (observation.assistantMessageCount !== 1)
      throw new Error(
        `UI observation '${observation.profile}' is not single-message`,
      );
    for (const field of [
      'terminal',
      'workingCleared',
      'workingStable',
      'commandBinding',
      'identityBinding',
      'projectBinding',
    ])
      if (observation[field] !== true)
        throw new Error(
          `UI observation '${observation.profile}' failed ${field}`,
        );
    if (
      observation.digest !==
      calculateDailyDriverUiObservationDigest(artifact, observation)
    )
      throw new Error(
        `UI observation '${observation.profile}' has a tampered digest`,
      );
  }
  for (const profile of required)
    if (!actualProfileIds.has(profile.id))
      throw new Error(`UI observation is missing profile '${profile.id}'`);
  return artifact;
}
