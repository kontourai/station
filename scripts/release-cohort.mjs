#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PLATFORMS = Object.freeze(['android', 'macos']);
const ORDER = Object.freeze(['android', 'macos']);
const POLICY = Object.freeze({
  releaseMode: 'atomic',
  requiredReceipt: 'provider-backed',
  externalEvidenceAuthority: 'github-artifact-attestation',
});

export class CohortValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CohortValidationError';
  }
}
const fail = (message) => {
  throw new CohortValidationError(message);
};
const plain = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim())
    fail(`${label} must be a non-empty string`);
  return value;
};
function canon(value) {
  if (
    value === null ||
    ['string', 'boolean'].includes(typeof value) ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) return value.map(canon);
  if (plain(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canon(value[key])]),
    );
  fail('value must be JSON-serializable');
}
export const canonicalJson = (value) => JSON.stringify(canon(value));
const hash = (value) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
function exact(value, expected, label) {
  if (canonicalJson(value) !== canonicalJson(expected))
    fail(`${label} is not its canonical content-bound form`);
  return expected;
}
function sha(value, label, pattern = SHA1) {
  if (!pattern.test(value ?? '')) fail(`${label} is invalid`);
  return value;
}
function facts(input = {}) {
  const channel = text(input.channel, 'channel');
  if (!['nightly', 'preview', 'stable'].includes(channel))
    fail(`channel is not supported: ${channel}`);
  const workflowRunId = text(
    String(input.workflowRunId ?? ''),
    'workflowRunId',
  );
  if (!/^[1-9][0-9]{0,18}$/.test(workflowRunId))
    fail('workflowRunId must be a positive GitHub run identifier');
  const requiredPlatforms = [...(input.requiredPlatforms ?? [])].sort();
  if (canonicalJson(requiredPlatforms) !== canonicalJson(PLATFORMS))
    fail('requiredPlatforms must exactly be android and macos');
  if (
    !plain(input.versionIdentities) ||
    canonicalJson(Object.keys(input.versionIdentities).sort()) !==
      canonicalJson(['android', 'desktop'])
  )
    fail('versionIdentities must exactly provide android and desktop');
  const versionIdentities = {
    android: text(input.versionIdentities.android, 'versionIdentities.android'),
    desktop: text(input.versionIdentities.desktop, 'versionIdentities.desktop'),
  };
  if (
    !plain(input.availabilityPolicy) ||
    canonicalJson(input.availabilityPolicy) !== canonicalJson(POLICY)
  )
    fail(
      'availabilityPolicy must exactly be the atomic provider-backed policy',
    );
  return {
    channel,
    sourceSha: sha(input.sourceSha, 'sourceSha'),
    workflowRunId,
    versionIdentities,
    availabilityPolicy: { ...POLICY },
    requiredPlatforms,
    promotionOrder: [...ORDER],
  };
}
function planFor(input) {
  const f = facts(input);
  const cohortId = `cohort-${hash(f)}`;
  const base = { kind: 'station.release-cohort-plan/v1', cohortId, ...f };
  return { ...base, planContentDigest: hash(base) };
}
export const createCohortPlan = (input) => structuredClone(planFor(input));
function plan(value) {
  if (value?.kind !== 'station.release-cohort-plan/v1')
    fail('plan kind is invalid');
  return exact(value, planFor(value), 'plan');
}
function artifact({ name, bytes }) {
  const n = text(name, 'artifact.name');
  const b = Buffer.isBuffer(bytes)
    ? bytes
    : bytes instanceof Uint8Array
      ? Buffer.from(bytes)
      : fail(`artifact ${n} must contain bytes`);
  if (!b.length) fail(`artifact ${n} must not be empty`);
  return {
    name: n,
    sha256: createHash('sha256').update(b).digest('hex'),
    size: b.length,
  };
}
export const createArtifactRecord = artifact;
function artifacts(values) {
  if (!Array.isArray(values) || !values.length)
    fail('artifacts must be non-empty');
  const names = new Set();
  return values.map((value) => {
    const item = Object.hasOwn(value ?? {}, 'bytes') ? artifact(value) : value;
    if (!plain(item) || names.has(text(item.name, 'artifact.name')))
      fail('artifacts contain a duplicate or invalid name');
    names.add(item.name);
    sha(item.sha256, 'artifact.sha256', SHA256);
    if (!Number.isSafeInteger(item.size) || item.size < 1)
      fail('artifact.size is invalid');
    return { name: item.name, sha256: item.sha256, size: item.size };
  });
}
function artifactAttestationClaim(p, records, value) {
  const keys = [
    'authority',
    'repository',
    'runId',
    'subjectDigest',
    'verificationReference',
    'workflowRef',
  ];
  if (
    !plain(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(keys)
  ) {
    fail('artifactAttestationClaim schema is invalid');
  }
  const result = {
    authority: text(value.authority, 'artifactAttestationClaim.authority'),
    repository: text(value.repository, 'artifactAttestationClaim.repository'),
    workflowRef: text(
      value.workflowRef,
      'artifactAttestationClaim.workflowRef',
    ),
    runId: text(String(value.runId), 'artifactAttestationClaim.runId'),
    subjectDigest: text(
      value.subjectDigest,
      'artifactAttestationClaim.subjectDigest',
    ),
    verificationReference: text(
      value.verificationReference,
      'artifactAttestationClaim.verificationReference',
    ),
  };
  if (
    result.authority !== 'github-artifact-attestation' ||
    result.repository !== 'kontourai/station'
  )
    fail('artifactAttestationClaim authority or repository is invalid');
  if (
    !result.workflowRef.endsWith(`@${p.sourceSha}`) ||
    result.runId !== p.workflowRunId
  )
    fail(
      'artifactAttestationClaim does not bind the exact source workflow run',
    );
  if (result.subjectDigest !== `sha256:${hash(records)}`)
    fail(
      'artifactAttestationClaim.subjectDigest does not bind staged artifact records',
    );
  return result;
}
function stageFor(p, input) {
  const platform = text(input?.platform, 'platform');
  if (!p.requiredPlatforms.includes(platform))
    fail('stage platform is not required');
  const records = artifacts(input?.artifacts);
  const base = {
    kind: 'station.release-cohort-stage-receipt/v1',
    cohortId: p.cohortId,
    planContentDigest: p.planContentDigest,
    channel: p.channel,
    sourceSha: p.sourceSha,
    workflowRunId: p.workflowRunId,
    versionIdentities: p.versionIdentities,
    platform,
    artifacts: records,
    artifactAttestationClaim: artifactAttestationClaim(
      p,
      records,
      input?.artifactAttestationClaim,
    ),
  };
  return { ...base, stageContentDigest: hash(base) };
}
export const createStageReceipt = (p, input) => stageFor(plan(p), input);
function stage(p, value) {
  if (value?.kind !== 'station.release-cohort-stage-receipt/v1')
    fail('stage receipt kind is invalid');
  return exact(value, stageFor(p, value), 'stage receipt');
}
function stages(p, values) {
  if (!Array.isArray(values) || values.length !== 2)
    fail('stage receipts must contain both platforms');
  const map = new Map(
    values.map((v) => {
      const r = stage(p, v);
      if (
        r.cohortId !== p.cohortId ||
        r.planContentDigest !== p.planContentDigest
      )
        fail('stage receipt does not bind plan');
      return [r.platform, r];
    }),
  );
  if (map.size !== 2) fail('stage receipts must be unique');
  return p.requiredPlatforms.map(
    (x) => map.get(x) ?? fail(`missing stage receipt for ${x}`),
  );
}
function downloads(receipts, value) {
  if (
    !plain(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(PLATFORMS)
  )
    fail('downloadedArtifacts must exactly match admitted platforms');
  for (const receipt of receipts) {
    const group = value[receipt.platform];
    if (
      !plain(group) ||
      canonicalJson(Object.keys(group).sort()) !==
        canonicalJson(receipt.artifacts.map((a) => a.name).sort())
    )
      fail('downloaded artifacts do not match receipt');
    for (const record of receipt.artifacts)
      if (
        canonicalJson(
          artifact({ name: record.name, bytes: group[record.name] }),
        ) !== canonicalJson(record)
      )
        fail(
          `downloaded artifact ${receipt.platform}/${record.name} does not match receipt`,
        );
  }
}
function admissionFor(p, rs) {
  const base = {
    kind: 'station.release-cohort-admission/v1',
    state: 'staged',
    plan: p,
    stageReceipts: rs,
  };
  return { ...base, admissionContentDigest: hash(base) };
}
export function admitCohort(input, values, downloadedArtifacts) {
  const p = plan(input);
  const rs = stages(p, values);
  downloads(rs, downloadedArtifacts);
  return admissionFor(p, rs);
}
function admission(value) {
  if (
    value?.kind !== 'station.release-cohort-admission/v1' ||
    value?.state !== 'staged'
  )
    fail('admission must be staged');
  const p = plan(value.plan);
  return exact(
    value,
    admissionFor(p, stages(p, value.stageReceipts)),
    'admission',
  );
}
function receipt(a, value) {
  if (!plain(value)) fail('promotion receipt must be an object');
  const platform = text(value.platform, 'promotion platform');
  const outcome = text(value.outcome, 'promotion outcome');
  if (!a.plan.promotionOrder.includes(platform))
    fail('promotion platform is invalid');
  const expectedProvider =
    platform === 'android' ? 'google-play' : 'github-releases';
  const evidence = value.providerEvidenceClaim;
  const keys = [
    'cohortId',
    'immutableReference',
    'provider',
    'queryReceiptDigest',
    'sourceSha',
  ];
  if (
    !plain(evidence) ||
    canonicalJson(Object.keys(evidence).sort()) !== canonicalJson(keys)
  )
    fail('providerEvidenceClaim schema is invalid');
  const providerEvidenceClaim = {
    provider: text(evidence.provider, 'providerEvidenceClaim.provider'),
    immutableReference: text(
      evidence.immutableReference,
      'providerEvidenceClaim.immutableReference',
    ),
    queryReceiptDigest: text(
      evidence.queryReceiptDigest,
      'providerEvidenceClaim.queryReceiptDigest',
    ),
    cohortId: text(evidence.cohortId, 'providerEvidenceClaim.cohortId'),
    sourceSha: text(evidence.sourceSha, 'providerEvidenceClaim.sourceSha'),
  };
  if (
    providerEvidenceClaim.provider !== expectedProvider ||
    providerEvidenceClaim.cohortId !== a.plan.cohortId ||
    providerEvidenceClaim.sourceSha !== a.plan.sourceSha ||
    !/^sha256:[a-f0-9]{64}$/.test(providerEvidenceClaim.queryReceiptDigest)
  )
    fail(
      'providerEvidenceClaim does not bind the expected provider, cohort, source, and query receipt',
    );
  if (outcome === 'reported_success')
    return {
      platform,
      outcome,
      providerEvidenceClaim,
    };
  if (outcome === 'reported_absent')
    return {
      platform,
      outcome,
      providerEvidenceClaim,
      recoveryAction: text(value.recoveryAction, 'recoveryAction'),
    };
  if (outcome === 'unknown')
    return {
      platform,
      outcome,
      providerEvidenceClaim,
      recoveryAction: text(value.recoveryAction, 'recoveryAction'),
    };
  fail('promotion outcome is invalid');
}
function receipts(a, values) {
  if (!Array.isArray(values) || values.length > 2)
    fail('promotionReceipts are invalid');
  return values.map((v, i) => {
    const r = receipt(a, v);
    if (r.platform !== a.plan.promotionOrder[i])
      fail(
        `promotion must be serialized; expected ${a.plan.promotionOrder[i]}`,
      );
    return r;
  });
}
function stateFor({
  admission: a,
  state,
  attempt,
  previousStateDigest,
  promotionReceipts,
  reason,
  recoveryAction,
}) {
  const base = {
    kind: 'station.release-cohort-state/v1',
    state,
    admission: a,
    admissionContentDigest: a.admissionContentDigest,
    attempt,
    previousStateDigest,
    promotionReceipts,
    ...(reason ? { reason } : {}),
    ...(recoveryAction ? { recoveryAction } : {}),
  };
  return { ...base, stateContentDigest: hash(base) };
}
function state(value, allowed) {
  if (
    value?.kind !== 'station.release-cohort-state/v1' ||
    !allowed.includes(value.state)
  )
    fail(`transition does not accept state ${String(value?.state)}`);
  const a = admission(value.admission);
  if (
    value.admissionContentDigest !== a.admissionContentDigest ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1
  )
    fail('state admission or attempt is invalid');
  if (
    (value.attempt === 1 && value.previousStateDigest !== null) ||
    (value.attempt > 1 && !SHA256.test(value.previousStateDigest ?? ''))
  )
    fail('state lineage is invalid');
  const rs = receipts(a, value.promotionReceipts);
  const outcomes = rs.map((r) => r.outcome);
  let reason;
  let recoveryAction;
  if (value.state === 'promotion_started') {
    if (
      Object.hasOwn(value, 'reason') ||
      Object.hasOwn(value, 'recoveryAction')
    )
      fail('promotion_started carries stale fields');
  } else if (value.state === 'staged') {
    fail('staged retry claims are not authoritative');
    reason = text(value.reason, 'reason');
    recoveryAction = text(value.recoveryAction, 'recoveryAction');
  } else {
    if (
      !outcomes.includes('unknown') &&
      !(
        outcomes.includes('reported_success') &&
        outcomes.includes('reported_absent')
      )
    )
      fail('partial recovery outcome is invalid');
    reason = text(value.reason, 'reason');
    recoveryAction = text(value.recoveryAction, 'recoveryAction');
  }
  return exact(
    value,
    stateFor({
      admission: a,
      state: value.state,
      attempt: value.attempt,
      previousStateDigest: value.previousStateDigest,
      promotionReceipts: rs,
      reason,
      recoveryAction,
    }),
    'state',
  );
}
export function beginPromotion(input) {
  if (input?.kind === 'station.release-cohort-admission/v1') {
    const a = admission(input);
    return stateFor({
      admission: a,
      state: 'promotion_started',
      attempt: 1,
      previousStateDigest: null,
      promotionReceipts: [],
    });
  }
  fail('only a fresh staged admission may begin structural promotion claims');
}
export function recordProviderPromotion(input, raw) {
  const s = state(input, ['promotion_started']);
  if (s.promotionReceipts.some((r) => r.outcome !== 'reported_success'))
    fail('cannot continue after absent or unknown outcome');
  const r = receipt(s.admission, raw);
  if (
    r.platform !== s.admission.plan.promotionOrder[s.promotionReceipts.length]
  )
    fail(
      `promotion must be serialized; expected ${s.admission.plan.promotionOrder[s.promotionReceipts.length]}`,
    );
  return stateFor({ ...s, promotionReceipts: [...s.promotionReceipts, r] });
}
export function finalizeCohort(input) {
  const s = state(input, ['promotion_started']);
  const unknown = s.promotionReceipts.find((r) => r.outcome === 'unknown');
  if (unknown)
    return stateFor({
      ...s,
      state: 'partial_recovery_required',
      reason: `${unknown.platform} outcome is unknown.`,
      recoveryAction: unknown.recoveryAction,
    });
  const absent = s.promotionReceipts.find(
    (r) => r.outcome === 'reported_absent',
  );
  if (absent) {
    const partial = s.promotionReceipts.some(
      (r) => r.outcome === 'reported_success',
    );
    return stateFor({
      ...s,
      state: 'partial_recovery_required',
      reason: partial
        ? `${absent.platform} was reported absent after another provider effect was reported successful.`
        : `${absent.platform} was reported absent and remains unverified.`,
      recoveryAction: absent.recoveryAction,
    });
  }
  if (s.promotionReceipts.length === 2) {
    const base = {
      kind: 'station.release-cohort-verification-candidate/v1',
      state: 'ready_for_verification',
      admission: s.admission,
      admissionContentDigest: s.admissionContentDigest,
      cohortId: s.admission.plan.cohortId,
      sourceSha: s.admission.plan.sourceSha,
      workflowRunId: s.admission.plan.workflowRunId,
      versionIdentities: s.admission.plan.versionIdentities,
      stageClaims: s.admission.stageReceipts,
      providerClaims: s.promotionReceipts,
    };
    return { ...base, candidateContentDigest: hash(base) };
  }
  return stateFor(s);
}
const json = (path) => JSON.parse(readFileSync(resolve(path), 'utf8'));
const stageInput = (value) => ({
  ...value,
  artifacts: value.artifacts?.map((a) => ({
    name: a.name,
    bytes: readFileSync(text(a.path, 'artifact.path')),
  })),
});
const downloaded = (value) =>
  Object.fromEntries(
    Object.entries(value).map(([platform, entries]) => [
      platform,
      Object.fromEntries(
        Object.entries(entries).map(([name, entry]) => [
          name,
          readFileSync(text(entry.path, 'artifact.path')),
        ]),
      ),
    ]),
  );
export function main(argv = process.argv.slice(2)) {
  const [cmd, ...paths] = argv;
  let result;
  if (cmd === 'plan' && paths.length === 1)
    result = createCohortPlan(json(paths[0]));
  else if (cmd === 'stage-receipt' && paths.length === 2)
    result = createStageReceipt(json(paths[0]), stageInput(json(paths[1])));
  else if (cmd === 'admit' && paths.length >= 3)
    result = admitCohort(
      json(paths[0]),
      paths.slice(2).map(json),
      downloaded(json(paths[1])),
    );
  else if (cmd === 'begin-promotion' && paths.length === 1)
    result = beginPromotion(json(paths[0]));
  else if (cmd === 'promotion-receipt' && paths.length === 2)
    result = recordProviderPromotion(json(paths[0]), json(paths[1]));
  else if (cmd === 'finalize' && paths.length === 1)
    result = finalizeCohort(json(paths[0]));
  else
    fail(
      'usage: release-cohort.mjs <plan|stage-receipt|admit|begin-promotion|promotion-receipt|finalize> ...',
    );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
