import { createHash } from 'node:crypto';

export const ORCHESTRATION_TRANSFER_REPORT_SCHEMA_VERSION = 1;
export const TRANSFER_SCENARIOS = Object.freeze([
  'external-engine',
  'station-native',
]);
export const REQUIRED_PHASES = Object.freeze([
  'initialEventWindow',
  'snapshot',
  'live',
  'shortReplay',
  'fallback',
]);
const METRICS = Object.freeze(['wireBytes', 'decodedBytes', 'frames']);

function fail(message) {
  throw new Error(`orchestration transfer budget: ${message}`);
}

function sha(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function finiteInteger(value, path, positive = false) {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0))
    fail(`${path} must be a ${positive ? 'positive' : 'non-negative'} integer`);
}

export function phaseKey(phase) {
  return `${phase?.scenario}/${phase?.name}`;
}

export function validateTransferEvidence(report, label) {
  if (
    !report ||
    report.schemaVersion !== ORCHESTRATION_TRANSFER_REPORT_SCHEMA_VERSION
  )
    fail(`${label} has an absent or incompatible schemaVersion`);
  for (const field of ['subjectSha', 'baseSha']) {
    if (
      typeof report[field] !== 'string' ||
      !/^[0-9a-f]{40}$/i.test(report[field])
    )
      fail(`${label} has no exact ${field}`);
  }
  if (report.dirty !== false) fail(`${label} is not a clean tree measurement`);
  for (const field of ['fixtureDigest', 'toolDigest'])
    if (!sha(report[field])) fail(`${label} has malformed ${field}`);
  for (const field of ['node', 'platform', 'arch'])
    if (typeof report[field] !== 'string' || report[field].trim() === '')
      fail(`${label} has missing runtime identity: ${field}`);
  if (!Array.isArray(report.phases)) fail(`${label} has absent phases`);
  const expected = new Set(
    TRANSFER_SCENARIOS.flatMap((scenario) =>
      REQUIRED_PHASES.map((name) => `${scenario}/${name}`),
    ),
  );
  const seen = new Set(report.phases.map(phaseKey));
  if (
    report.phases.length !== expected.size ||
    seen.size !== expected.size ||
    [...expected].some((key) => !seen.has(key))
  )
    fail(`${label} has an incomplete or duplicate scenario/phase matrix`);
  for (const phase of report.phases) {
    if (!TRANSFER_SCENARIOS.includes(phase?.scenario))
      fail(`${label} has unknown scenario`);
    if (!REQUIRED_PHASES.includes(phase?.name))
      fail(`${label} has unknown phase`);
    for (const metric of METRICS)
      finiteInteger(
        phase[metric],
        `${label}.${phaseKey(phase)}.${metric}`,
        metric !== 'frames',
      );
    if (phase.name !== 'initialEventWindow' && phase.frames === 0)
      fail(`${label}.${phaseKey(phase)} has no SSE frames`);
    if (!['identity', 'gzip'].includes(phase.contentEncoding))
      fail(`${label}.${phaseKey(phase)} has unsupported encoding evidence`);
    if (
      (phase.contentEncoding === 'identity' &&
        phase.compressionRatio !== null) ||
      (phase.contentEncoding === 'gzip' &&
        (!Number.isFinite(phase.compressionRatio) ||
          phase.compressionRatio <= 0))
    )
      fail(`${label}.${phaseKey(phase)} has invalid compression evidence`);
    if (phase.complete !== true && phase.abortedByClient !== true)
      fail(`${label}.${phaseKey(phase)} has incomplete stream evidence`);
  }
  return new Map(report.phases.map((phase) => [phaseKey(phase), phase]));
}

export function compareTransferEvidence(candidate, baseline, policy, expected) {
  const candidatePhases = validateTransferEvidence(candidate, 'candidate');
  const baselinePhases = validateTransferEvidence(baseline, 'baseline');
  if (
    !expected ||
    candidate.subjectSha !== expected.candidateSha ||
    baseline.subjectSha !== expected.baseSha ||
    candidate.baseSha !== expected.baseSha ||
    baseline.baseSha !== expected.baseSha
  )
    fail('caller did not provide matching exact candidate/base SHAs');
  if (candidate.fixtureDigest !== baseline.fixtureDigest)
    fail('fixture digest mismatch');
  if (candidate.toolDigest !== baseline.toolDigest)
    fail('tool digest mismatch');
  for (const key of ['node', 'platform', 'arch']) {
    if (candidate[key] !== baseline[key])
      fail(`runtime identity mismatch: ${key}`);
  }
  const deltas = {};
  for (const [key, phase] of candidatePhases) {
    const prior = baselinePhases.get(key);
    const ceiling = policy?.[phase.name];
    if (!prior || !ceiling) fail(`policy or baseline omits ${key}`);
    deltas[key] = {};
    for (const metric of METRICS) {
      finiteInteger(ceiling[metric], `policy.${phase.name}.${metric}`);
      if (phase[metric] > ceiling[metric])
        fail(
          `WIRE_BUDGET_EXCEEDED_${phase.scenario}_${phase.name}: ${metric} ${phase[metric]} > ${ceiling[metric]}`,
        );
      deltas[key][metric] = {
        absolute: phase[metric] - prior[metric],
        percent:
          prior[metric] === 0
            ? null
            : ((phase[metric] - prior[metric]) / prior[metric]) * 100,
      };
    }
  }
  return {
    policyDigest: createHash('sha256')
      .update(JSON.stringify(policy))
      .digest('hex'),
    deltas,
  };
}

export function assertDeterministicBaseline(first, second) {
  const left = validateTransferEvidence(first, 'baseline A');
  const right = validateTransferEvidence(second, 'baseline B');
  for (const key of [
    'subjectSha',
    'baseSha',
    'fixtureDigest',
    'toolDigest',
    'node',
    'platform',
    'arch',
  ]) {
    if (first[key] !== second[key])
      fail(`baseline A/B identity disagreement: ${key}`);
  }
  for (const [key, phase] of left) {
    const other = right.get(key);
    for (const metric of METRICS) {
      if (phase[metric] !== other?.[metric])
        fail(`baseline A/B measurement disagreement: ${key}.${metric}`);
    }
  }
}
