import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateRepoStandards, loadRepoStandards } from '@kontourai/veritas';
import { collectCiWorkflowGovernanceFindings } from './ci-workflow-governance.mjs';
import { collectPublicContributionSurfaceFindings } from './public-contribution-surfaces.mjs';
import { collectRouteErrorEgressFindings } from './route-error-egress-gate.mjs';

export { findVerdictBearingContinueOnError } from './ci-workflow-governance.mjs';

const rootDir = resolve(fileURLToPath(new URL('../', import.meta.url)));
const manifestPath = resolve(
  rootDir,
  '.veritas/proof-families/repo-guardrails.families.json',
);
const repoMapPath = resolve(rootDir, '.veritas/repo-map.json');
const repoStandardsPath = resolve(
  rootDir,
  '.veritas/repo-standards/default.repo-standards.json',
);
const generatedEvidenceRoot = resolve(
  rootDir,
  '.kontourai/veritas/evidence/proof-families',
);
const REPO_GOVERNANCE_RULE_IDS = Object.freeze([
  'required-station-governance-artifacts',
  'ai-instruction-files-synced',
  'brownfield-gap-log-present',
]);
const REPO_GOVERNANCE_RESULT_CONTRACT = Object.freeze({
  'required-station-governance-artifacts': Object.freeze({
    classification: 'hard-invariant',
    enforcementLevel: 'Require',
    enforcement: 'deny',
    owner: 'repo-core',
    rollbackSwitch: null,
    findingKinds: Object.freeze(['missing-artifact']),
  }),
  'ai-instruction-files-synced': Object.freeze({
    classification: 'hard-invariant',
    enforcementLevel: 'Guide',
    enforcement: 'deny',
    owner: 'repo-maintainers',
    rollbackSwitch: null,
    findingKinds: Object.freeze([
      'missing-governance-file',
      'missing-governance-block',
      'stale-governance-block',
    ]),
  }),
  'brownfield-gap-log-present': Object.freeze({
    classification: 'promotable-policy',
    enforcementLevel: 'Guide',
    enforcement: 'advisory',
    owner: 'repo-maintainers',
    rollbackSwitch: 'skip-brownfield-gap-log',
    findingKinds: Object.freeze(['missing-artifact']),
  }),
});
const IMPLEMENTED_VERITAS_RESULT_KEYS = Object.freeze([
  'rule_id',
  'classification',
  'enforcementLevel',
  'enforcement',
  'message',
  'owner',
  'rollback_switch',
  'implemented',
  'passed',
  'status',
  'summary',
  'findings',
]);
const UNIMPLEMENTED_VERITAS_RESULT_KEYS = Object.freeze([
  ...IMPLEMENTED_VERITAS_RESULT_KEYS,
  'reason',
]);
const VERITAS_FINDING_KEYS = Object.freeze(['kind', 'artifact']);
const UNIMPLEMENTED_VERITAS_FINDING_KEYS = Object.freeze([
  'kind',
  'artifact',
  'rule_kind',
]);
const GENERIC_INVALID_RESULT_MESSAGE =
  'Veritas returned an invalid governance policy result.';
const GENERIC_UNPERFORMED_RESULT_MESSAGE =
  'Veritas did not complete a configured governance policy evaluation.';
const GENERIC_POLICY_FAILURE_MESSAGE =
  'Veritas reported a blocking governance policy failure.';
const INVALID_RESULT_ID = 'repo-governance-invalid-veritas-result';

function parseArgs(argv) {
  const args = {
    lane: 'repo-governance',
    runId: process.env.VERITAS_RUN_ID || 'local',
  };
  for (const arg of argv) {
    if (arg.startsWith('--lane=')) {
      args.lane = arg.slice('--lane='.length);
    } else if (arg.startsWith('--run-id=')) {
      args.runId = arg.slice('--run-id='.length);
    }
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeSidecar(record) {
  mkdirSync(generatedEvidenceRoot, { recursive: true });
  const safeRunId = record.runId.replace(/[^a-zA-Z0-9_.-]/g, '-');
  const path = join(
    generatedEvidenceRoot,
    `${safeRunId}-${record.laneId}.json`,
  );
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

function workflowFiles() {
  const workflowDir = resolve(rootDir, '.github/workflows');
  if (!existsSync(workflowDir)) {
    return [];
  }
  return readdirSync(workflowDir)
    .filter((fileName) => fileName.endsWith('.yml'))
    .map((fileName) => join(workflowDir, fileName));
}

function plainDataRecord(value, keys) {
  try {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
    ) {
      return null;
    }
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        return null;
      }
    }
    return descriptors;
  } catch {
    return null;
  }
}

function arrayDataValues(value) {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length;
    if (
      !length ||
      !('value' in length) ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0 ||
      Reflect.ownKeys(descriptors).length !== length.value + 1
    ) {
      return null;
    }
    const values = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        return null;
      }
      values.push(descriptor.value);
    }
    return values;
  } catch {
    return null;
  }
}

function isConfiguredGovernanceRuleId(ruleId) {
  return (
    typeof ruleId === 'string' &&
    Object.hasOwn(REPO_GOVERNANCE_RESULT_CONTRACT, ruleId)
  );
}

function safeGovernanceBlock(ruleId, message) {
  return {
    id: isConfiguredGovernanceRuleId(ruleId) ? ruleId : INVALID_RESULT_ID,
    message,
    severity: 'block',
  };
}

function isValidFinding(finding, contract) {
  const descriptors = plainDataRecord(finding, VERITAS_FINDING_KEYS);
  if (!descriptors) return false;
  return (
    contract.findingKinds.includes(descriptors.kind.value) &&
    typeof descriptors.artifact.value === 'string' &&
    descriptors.artifact.value.length > 0
  );
}

function hasConfiguredResultMetadata(values, ruleId, contract) {
  return (
    values.rule_id === ruleId &&
    values.classification === contract.classification &&
    values.enforcementLevel === contract.enforcementLevel &&
    values.enforcement === contract.enforcement &&
    typeof values.message === 'string' &&
    values.message.length > 0 &&
    values.owner === contract.owner &&
    values.rollback_switch === contract.rollbackSwitch &&
    typeof values.summary === 'string' &&
    values.summary.length > 0
  );
}

function descriptorValues(keys, descriptors) {
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function hasExactUnimplementedResult(values, ruleId) {
  const findings = arrayDataValues(values.findings);
  if (
    values.implemented !== false ||
    values.passed !== null ||
    values.status !== 'error' ||
    values.reason !== 'unknown rule kind' ||
    !findings ||
    findings.length !== 1
  ) {
    return false;
  }
  const finding = plainDataRecord(
    findings[0],
    UNIMPLEMENTED_VERITAS_FINDING_KEYS,
  );
  return Boolean(
    finding &&
      finding.kind.value === 'unknown-rule-kind' &&
      finding.artifact.value === ruleId &&
      typeof finding.rule_kind.value === 'string' &&
      finding.rule_kind.value.length > 0,
  );
}

/**
 * Repo-governance is an outer proof lane: a reported policy finding blocks the
 * lane regardless of the policy's Veritas enforcement level. Veritas 1.5.3
 * exposes a fixed, plain-data result shape; it has no `stage` field. Inspect
 * descriptors rather than calling values so malformed or hostile policy data
 * cannot reach a sidecar or output stream.
 */
export function findingsForRepoGovernanceResult(ruleId, result) {
  const contract = isConfiguredGovernanceRuleId(ruleId)
    ? REPO_GOVERNANCE_RESULT_CONTRACT[ruleId]
    : null;
  const implementedDescriptors = plainDataRecord(
    result,
    IMPLEMENTED_VERITAS_RESULT_KEYS,
  );
  const unimplementedDescriptors = plainDataRecord(
    result,
    UNIMPLEMENTED_VERITAS_RESULT_KEYS,
  );
  if (!contract || (!implementedDescriptors && !unimplementedDescriptors)) {
    return [safeGovernanceBlock(ruleId, GENERIC_INVALID_RESULT_MESSAGE)];
  }

  if (unimplementedDescriptors) {
    const values = descriptorValues(
      UNIMPLEMENTED_VERITAS_RESULT_KEYS,
      unimplementedDescriptors,
    );
    if (
      !hasConfiguredResultMetadata(values, ruleId, contract) ||
      !hasExactUnimplementedResult(values, ruleId)
    ) {
      return [safeGovernanceBlock(ruleId, GENERIC_INVALID_RESULT_MESSAGE)];
    }
    return [safeGovernanceBlock(ruleId, GENERIC_UNPERFORMED_RESULT_MESSAGE)];
  }

  const values = descriptorValues(
    IMPLEMENTED_VERITAS_RESULT_KEYS,
    implementedDescriptors,
  );
  if (
    !hasConfiguredResultMetadata(values, ruleId, contract) ||
    typeof values.implemented !== 'boolean' ||
    values.status !== 'info'
  ) {
    return [safeGovernanceBlock(ruleId, GENERIC_INVALID_RESULT_MESSAGE)];
  }

  const findings = arrayDataValues(values.findings);
  if (!findings) {
    return [safeGovernanceBlock(ruleId, GENERIC_INVALID_RESULT_MESSAGE)];
  }
  if (values.implemented !== true || typeof values.passed !== 'boolean') {
    return [safeGovernanceBlock(ruleId, GENERIC_INVALID_RESULT_MESSAGE)];
  }
  if (values.passed === true && findings.length === 0) return [];
  if (
    values.passed === true ||
    findings.length === 0 ||
    findings.some((finding) => !isValidFinding(finding, contract))
  ) {
    return [safeGovernanceBlock(ruleId, GENERIC_INVALID_RESULT_MESSAGE)];
  }
  return [safeGovernanceBlock(ruleId, GENERIC_POLICY_FAILURE_MESSAGE)];
}

export function runRepoGovernanceChecks({
  routeErrorEgressCheck = () => collectRouteErrorEgressFindings({ rootDir }),
  repoMap = readJson(repoMapPath),
  proofFamilyManifest = readJson(manifestPath),
} = {}) {
  const findings = [];

  for (const checkId of findUnexecutableRoutedProofFamilyIds(
    repoMap,
    proofFamilyManifest,
  )) {
    findings.push({
      id: 'routed-proof-family-not-executable',
      message: `${checkId} is routed into readiness but does not execute assertions. Remove its route or implement assertions first.`,
      severity: 'block',
    });
  }

  if (!existsSync(repoStandardsPath)) {
    findings.push({
      id: 'missing-repo-standards',
      message: 'Missing .veritas/repo-standards/default.repo-standards.json',
      severity: 'block',
    });
  } else {
    const repoStandards = loadRepoStandards(repoStandardsPath);
    for (const ruleId of REPO_GOVERNANCE_RULE_IDS) {
      const [result] = evaluateRepoStandards(
        repoStandards,
        { rootDir },
        { ruleIds: [ruleId] },
      );
      findings.push(...findingsForRepoGovernanceResult(ruleId, result));
    }
  }

  const packageJson = readJson(resolve(rootDir, 'package.json'));
  for (const scriptName of [
    'proof:repo-governance',
    'proof:repo-guardrails',
    'ci:fast',
    'ci:extended',
    'veritas:readiness',
    'veritas:shadow',
  ]) {
    if (typeof packageJson.scripts?.[scriptName] !== 'string') {
      findings.push({
        id: 'missing-package-script',
        message: `package.json is missing required script: ${scriptName}`,
        severity: 'block',
      });
    }
  }

  for (const message of collectPublicContributionSurfaceFindings({
    root: rootDir,
  })) {
    findings.push({
      id: 'public-contribution-surfaces',
      message,
      severity: 'block',
    });
  }

  for (const message of routeErrorEgressCheck()) {
    findings.push({
      id: 'route-error-egress',
      message,
      severity: 'block',
    });
  }

  for (const message of collectCiWorkflowGovernanceFindings({
    ciWorkflowPath: resolve(rootDir, '.github/workflows/ci.yml'),
  })) {
    findings.push({ id: 'ci-workflow-governance', message, severity: 'block' });
  }

  const externalActionPattern =
    /^\s*-\s+uses:\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^\s#]+)\s*$/gm;
  const fullCommitShaPattern = /^[0-9a-f]{40}$/;
  for (const path of workflowFiles()) {
    const relativePath = path.slice(rootDir.length + 1);
    const contents = readFileSync(path, 'utf8');
    for (
      let match = externalActionPattern.exec(contents);
      match !== null;
      match = externalActionPattern.exec(contents)
    ) {
      const [, actionName, ref] = match;
      if (!fullCommitShaPattern.test(ref)) {
        findings.push({
          id: 'unpinned-github-action',
          message: `${relativePath} uses unpinned action ${actionName}@${ref}. Pin to a full commit SHA.`,
          severity: 'block',
        });
      }
    }
  }

  return findings;
}

function runCandidateChecks(family) {
  return [
    {
      id: `${family.id}-candidate-not-required`,
      message: `${family.id} is classified as ${family.defaultDisposition}; it is reported as a family-level candidate and is not a required blocker in this lane.`,
      severity: 'info',
    },
  ];
}

export function evaluateProofFamily(family, { routeErrorEgressCheck } = {}) {
  const findings =
    family.id === 'repo-governance'
      ? runRepoGovernanceChecks({ routeErrorEgressCheck })
      : runCandidateChecks(family);
  const blockingFindings = findings.filter(
    (finding) => finding.severity === 'block',
  );
  return {
    id: family.id,
    laneId: family.evidenceCheckId,
    destination: family.destination,
    owner: family.owner,
    defaultDisposition: family.defaultDisposition,
    currentBlockingStatus: family.currentBlockingStatus,
    regressionSeverity: family.regressionSeverity,
    falsePositiveRisk: family.falsePositiveRisk,
    expiryOrReviewTrigger: family.expiryOrReviewTrigger,
    status:
      blockingFindings.length > 0
        ? 'fail'
        : family.id === 'repo-governance'
          ? 'pass'
          : 'NOT_VERIFIED',
    findings,
  };
}

/**
 * Returns every proof-family evidence check that readiness can route despite
 * reporting NOT_VERIFIED. This is used by the required repo-governance lane,
 * so an assertion-free family cannot silently return to readiness routing.
 */
export function findUnexecutableRoutedProofFamilyIds(
  repoMap,
  proofFamilyManifest,
) {
  const familiesByCheckId = new Map(
    proofFamilyManifest.items.map((family) => [family.evidenceCheckId, family]),
  );
  const routedCheckIds = repoMap.evidence.evidenceCheckRoutes.flatMap(
    (route) => route.evidenceCheckIds,
  );

  return [
    ...new Set(
      routedCheckIds.flatMap((checkId) => {
        const family = familiesByCheckId.get(checkId);
        if (!family || family.id === 'repo-governance') return [];
        return evaluateProofFamily(family).status === 'NOT_VERIFIED'
          ? [checkId]
          : [];
      }),
    ),
  ];
}

function familyResultStatus(result) {
  try {
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      Object.getPrototypeOf(result) !== Object.prototype
    ) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(result, 'status');
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    return ['pass', 'fail', 'NOT_VERIFIED'].includes(descriptor.value)
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

export function proofFamilyExitCode(familyResults) {
  const results = arrayDataValues(familyResults);
  if (!results) return 1;
  if (results.length === 0) return 2;

  const statuses = results.map(familyResultStatus);
  if (statuses.includes('fail') || statuses.includes(null)) return 1;
  if (statuses.includes('NOT_VERIFIED')) return 2;
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = readJson(manifestPath);
  const families = manifest.items.filter(
    (family) => family.evidenceCheckId === args.lane,
  );

  if (families.length === 0) {
    console.error(`Unknown proof family lane: ${args.lane}`);
    process.exit(1);
  }

  const familyResults = families.map((family) => evaluateProofFamily(family));

  const record = {
    schemaVersion: 1,
    runId: args.runId,
    laneId: args.lane,
    sourceProofLaneId: manifest.sourceEvidenceCheckId,
    generatedAt: new Date().toISOString(),
    familyResults,
  };
  const sidecarPath = writeSidecar(record);

  const exitCode = proofFamilyExitCode(familyResults);
  if (exitCode === 1) {
    const failed = familyResults.filter((result) => result.status === 'fail');
    console.error(`Proof family lane failed: ${args.lane}\n`);
    for (const result of failed) {
      for (const finding of result.findings.filter(
        (item) => item.severity === 'block',
      )) {
        console.error(`- ${result.id}: ${finding.message}`);
      }
    }
    console.error(`\nproof-family sidecar: ${sidecarPath}`);
    process.exit(1);
  }
  if (exitCode === 2) {
    console.error(`Proof family lane NOT_VERIFIED: ${args.lane}`);
    for (const result of familyResults.filter(
      (item) => item.status === 'NOT_VERIFIED',
    )) {
      console.error(
        `- ${result.id}: this candidate family did not execute an assertion.`,
      );
    }
    console.error(`\nproof-family sidecar: ${sidecarPath}`);
    process.exit(2);
  }

  console.log(`Proof family lane passed: ${args.lane}`);
  console.log(`proof-family sidecar: ${sidecarPath}`);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main();
}
