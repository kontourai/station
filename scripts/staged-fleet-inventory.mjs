#!/usr/bin/env node
/** Strict, portable-only nightly staging receipts; no delivery state is inferred. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../schemas/staged-fleet-inventory.schema.json' with {
  type: 'json',
};

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REPOSITORY = 'kontourai/station';
const SOURCE_REF = 'refs/heads/main';
const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const WORKFLOW = '.github/workflows/nightly-fleet-staging.yml';
const CERT_IDENTITY = `https://github.com/${REPOSITORY}/${WORKFLOW}@${SOURCE_REF}`;
const INVENTORY_VALIDATOR = new Ajv2020({
  strict: true,
  allErrors: true,
}).compile(schema);

function fail(message) {
  throw new Error(`staged fleet inventory: ${message}`);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function digest(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export function contentDigest(value, omitted = []) {
  const copy = structuredClone(value);
  for (const key of omitted) delete copy[key];
  return digest(copy);
}
function bytesDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function pathFor(root, name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    fail(`unsafe artifact path: ${String(name)}`);
  const base = realpathSync(root);
  const path = resolve(base, name);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`artifact path is missing: ${name}`);
  }
  if (!path.startsWith(`${base}${sep}`) || stat.isSymbolicLink())
    fail(`artifact path is not a direct file: ${name}`);
  if (realpathSync(path) !== path || !stat.isFile())
    fail(`artifact path is not a regular direct file: ${name}`);
  return path;
}
function claim(root, name) {
  const bytes = readFileSync(pathFor(root, name));
  if (!bytes.length) fail(`empty artifact: ${name}`);
  return { name, sha256: bytesDigest(bytes), size: bytes.length };
}
function assertClaim(root, record, label) {
  if (
    !plain(record) ||
    !DIGEST.test(record.sha256) ||
    !Number.isSafeInteger(record.size) ||
    record.size < 1
  )
    fail(`${label} is not a non-empty content claim`);
  const actual = claim(root, record.name);
  if (actual.sha256 !== record.sha256 || actual.size !== record.size)
    fail(`${label} bytes drifted`);
}
function assertIdentity(value, label) {
  if (
    !SHA.test(value?.sourceSha ?? '') ||
    !/^[1-9][0-9]*$/.test(String(value?.workflowRunId ?? '')) ||
    typeof value?.cohortId !== 'string' ||
    !value.cohortId ||
    !DIGEST.test(value?.cohortPlanDigest ?? '')
  )
    fail(`${label} identity is invalid`);
}

export function assertStaticPlan(plan, planDigest) {
  if (
    !plain(plan) ||
    plan.kind !== 'station.nightly-fleet-staging-plan/v1' ||
    Object.keys(plan).length !== 3 ||
    !Array.isArray(plan.requiredVariants) ||
    !Array.isArray(plan.requiredArtifacts) ||
    plan.requiredVariants.length !== 1 ||
    plan.requiredVariants[0] !== 'portable-server'
  )
    fail('static plan is not the reviewed portable-only shape');
  const expected = [
    'station-nightly-portable.tar.gz',
    'station-nightly-portable.tar.gz.sha256',
    'station-nightly-portable-manifest.json',
    'portable-build-check.json',
    'portable-sbom.cdx.json',
  ];
  if (
    JSON.stringify(plan.requiredArtifacts) !== JSON.stringify(expected) ||
    !DIGEST.test(planDigest ?? '')
  )
    fail('static plan artifact list or digest is invalid');
  return structuredClone(plan);
}
function receiptSemantics(receipt, assetsDir) {
  if (
    !plain(receipt) ||
    receipt.kind !== 'station.staged-fleet-stage-receipt/v1' ||
    receipt.id !== 'portable-server' ||
    receipt.platform !== 'web-portable' ||
    receipt.variant !== 'portable-server'
  )
    fail('portable receipt identity is invalid');
  assertIdentity(receipt, 'receipt');
  for (const [field, expected] of Object.entries({
    stageState: 'STAGED',
    publicationState: 'NOT_PUBLISHED',
    installState: 'NOT_INSTALLED',
    updateState: 'NOT_UPDATED',
    platformSigningState: 'UNSUPPORTED',
    updaterSigningState: 'UNSUPPORTED',
  }))
    if (receipt[field] !== expected)
      fail(`receipt ${field} must be ${expected}`);
  if (
    !Array.isArray(receipt.artifacts) ||
    !Array.isArray(receipt.checks) ||
    receipt.checks.length !== 1 ||
    receipt.checks[0]?.id !== 'portable-manifest-and-checksum' ||
    receipt.checks[0]?.result !== 'PASSED' ||
    receipt.sbom?.state !== 'GENERATED' ||
    receipt.attestation?.claim !== 'REQUIRED'
  )
    fail('portable receipt evidence shape is invalid');
  if (assetsDir) {
    for (const record of receipt.artifacts)
      assertClaim(assetsDir, record, 'receipt artifact');
    assertClaim(assetsDir, receipt.checks[0].evidence, 'portable build check');
    assertClaim(assetsDir, receipt.sbom.artifact, 'portable SBOM');
  }
  const subjects = receipt.attestation.subjects;
  const expected = receipt.artifacts.map(({ name, sha256 }) => ({
    name,
    sha256,
  }));
  if (
    !Array.isArray(subjects) ||
    JSON.stringify(subjects) !== JSON.stringify(expected)
  )
    fail('attestation subjects must retain exact artifact order and content');
  if (
    receipt.receiptContentDigest !==
    contentDigest(receipt, ['receiptContentDigest'])
  )
    fail('receipt content digest is invalid');
}
export function createStageReceipt(input, { assetsDir }) {
  assertIdentity(input, 'receipt input');
  const receipt = {
    kind: 'station.staged-fleet-stage-receipt/v1',
    id: input.id,
    sourceSha: input.sourceSha,
    workflowRunId: String(input.workflowRunId),
    cohortId: input.cohortId,
    cohortPlanDigest: input.cohortPlanDigest,
    platform: input.platform,
    variant: input.variant,
    stageState: input.stageState,
    publicationState: input.publicationState,
    installState: input.installState,
    updateState: input.updateState,
    platformSigningState: input.platformSigningState,
    updaterSigningState: input.updaterSigningState,
    artifacts: input.artifacts.map((name) => claim(assetsDir, name)),
    checks: input.checks.map((check) => ({
      id: check.id,
      result: check.result,
      evidence: claim(assetsDir, check.evidence),
    })),
    sbom: {
      state: input.sbom?.state,
      artifact: claim(assetsDir, input.sbom?.artifact),
    },
    attestation: {
      subjects: input.attestation.subjects.map((name) => {
        const item = claim(assetsDir, name);
        return { name: item.name, sha256: item.sha256 };
      }),
      claim: 'REQUIRED',
    },
  };
  receipt.receiptContentDigest = contentDigest(receipt, [
    'receiptContentDigest',
  ]);
  receiptSemantics(receipt, assetsDir);
  return receipt;
}
export function parseVerifiedAttestation(
  entries,
  subject,
  sourceSha,
  workflowRunId,
  now = new Date(),
) {
  if (
    !Array.isArray(entries) ||
    !plain(subject) ||
    !DIGEST.test(subject.sha256 ?? '')
  )
    fail('attestation verifier input is invalid');
  const runUri = new RegExp(
    `^https://github\\.com/${REPOSITORY}/actions/runs/${workflowRunId}(?:/attempts/[1-9][0-9]*)?$`,
  );
  const matches = entries.filter((entry) => {
    const result = entry?.verificationResult;
    const certificate = result?.signature?.certificate;
    const subjects = result?.statement?.subject;
    const timestamps = result?.verifiedTimestamps;
    const dependencies =
      result?.statement?.predicate?.buildDefinition?.resolvedDependencies;
    return (
      plain(certificate) &&
      Array.isArray(subjects) &&
      Array.isArray(timestamps) &&
      timestamps.length > 0 &&
      Array.isArray(dependencies) &&
      dependencies.filter(
        (dependency) =>
          dependency?.uri ===
            `git+https://github.com/${REPOSITORY}@${SOURCE_REF}` &&
          dependency?.digest?.gitCommit === sourceSha,
      ).length === 1 &&
      certificate.subjectAlternativeName === CERT_IDENTITY &&
      certificate.issuer === OIDC_ISSUER &&
      typeof certificate.certificateIssuer === 'string' &&
      certificate.certificateIssuer &&
      runUri.test(certificate.runInvocationURI ?? '') &&
      subjects.filter(
        (candidate) => candidate?.digest?.sha256 === subject.sha256,
      ).length === 1 &&
      timestamps.every(
        (timestamp) =>
          plain(timestamp) &&
          typeof timestamp.timestamp === 'string' &&
          typeof timestamp.type === 'string' &&
          typeof timestamp.uri === 'string' &&
          !Number.isNaN(Date.parse(timestamp.timestamp)) &&
          Date.parse(timestamp.timestamp) <= now.getTime() + 5_000,
      )
    );
  });
  if (matches.length !== 1)
    fail(
      `attestation verification did not prove exactly one ${subject.name} subject`,
    );
  const certificate = matches[0].verificationResult.signature.certificate;
  return {
    repository: REPOSITORY,
    signerWorkflow: WORKFLOW,
    sourceRef: SOURCE_REF,
    sourceSha,
    oidcIssuer: OIDC_ISSUER,
    certificateIssuer: certificate.certificateIssuer,
    authenticatedWorkflowRunId: workflowRunId,
    runInvocationURI: certificate.runInvocationURI,
    subjectDigest: `sha256:${subject.sha256}`,
    verifiedTimestamps: matches[0].verificationResult.verifiedTimestamps,
  };
}
export function composeFixedInventory(plan, receipt, { planDigest }) {
  assertStaticPlan(plan, planDigest);
  receiptSemantics(receipt);
  const inventory = {
    kind: 'station.staged-fleet-inventory/v1',
    sourceSha: receipt.sourceSha,
    workflowRunId: receipt.workflowRunId,
    cohort: {
      cohortId: receipt.cohortId,
      sourceSha: receipt.sourceSha,
      planDigest: receipt.cohortPlanDigest,
    },
    plan: { kind: plan.kind, contentDigest: planDigest },
    requiredVariants: plan.requiredVariants,
    requiredArtifacts: plan.requiredArtifacts,
    receipts: [receipt],
  };
  inventory.inventoryContentDigest = contentDigest(inventory, [
    'inventoryContentDigest',
  ]);
  return inventory;
}
export function admitFixedInventory(plan, receipt, { assetsDir, planDigest }) {
  assertStaticPlan(plan, planDigest);
  receiptSemantics(receipt, assetsDir);
  const inventory = composeFixedInventory(plan, receipt, { planDigest });
  if (
    receipt.cohortPlanDigest !== planDigest ||
    JSON.stringify(receipt.artifacts.map((item) => item.name)) !==
      JSON.stringify(plan.requiredArtifacts)
  )
    fail('receipt does not cover the fixed plan exactly');
  const subjects = receipt.attestation.subjects.map((subject, index) => {
    const entries = JSON.parse(
      readFileSync(
        pathFor(assetsDir, `attestation-verify-${index}.json`),
        'utf8',
      ),
    );
    return {
      ...subject,
      proof: parseVerifiedAttestation(
        entries,
        subject,
        receipt.sourceSha,
        receipt.workflowRunId,
      ),
    };
  });
  inventory.attestationVerification = {
    kind: 'station.staged-fleet-attestation-verification/v1',
    sourceSha: receipt.sourceSha,
    workflowRunId: receipt.workflowRunId,
    subjects,
  };
  inventory.aggregate = {
    state: 'STAGED_COMPLETE',
    complete: true,
    publicationState: 'NOT_PUBLISHED',
    installState: 'NOT_INSTALLED',
    updateState: 'NOT_UPDATED',
    note: 'Content and authenticated provenance only; no publication, installation, or update outcome is inferred.',
  };
  inventory.admissionContentDigest = contentDigest(inventory, [
    'admissionContentDigest',
  ]);
  if (!INVENTORY_VALIDATOR(inventory))
    fail(
      `schema rejected admitted inventory: ${JSON.stringify(INVENTORY_VALIDATOR.errors)}`,
    );
  return inventory;
}
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === 'assert-plan' && args.length === 2)
    return assertStaticPlan(readJson(args[0]), args[1]);
  if (command === 'stage-receipt' && args.length === 2)
    return process.stdout.write(
      `${JSON.stringify(createStageReceipt(readJson(args[0]), { assetsDir: args[1] }), null, 2)}\n`,
    );
  if (command === 'assert-stage-receipt' && args.length === 2)
    return receiptSemantics(readJson(args[0]), args[1]);
  if (command === 'admit-fixed' && args.length === 3) {
    const plan = readJson(args[0]);
    const planDigest = bytesDigest(readFileSync(args[0]));
    return process.stdout.write(
      `${JSON.stringify(admitFixedInventory(plan, readJson(args[1]), { assetsDir: args[2], planDigest }), null, 2)}\n`,
    );
  }
  fail(
    'usage: staged-fleet-inventory.mjs <assert-plan PLAN DIGEST|stage-receipt INPUT ASSETS|assert-stage-receipt RECEIPT ASSETS|admit-fixed PLAN RECEIPT ASSETS>',
  );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
