import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gitLocationKeys,
  sanitizedGitEnvironment,
} from './lib/git-environment.mjs';
import { collectVerificationProvenance } from './lib/test-reliability.mjs';
import { assertInstalledDependenciesMatchLockfile } from './lib/verification-environment-preflight.mjs';
import {
  assertDeterministicBaseline,
  compareTransferEvidence,
  validateTransferEvidence,
} from './orchestration-transfer-budget.mjs';
import { assertWorkspacePackageProvenance } from './workspace-dependency-provenance.mjs';

function fail(message) {
  throw new Error(`orchestration transfer gate: ${message}`);
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: transferGitEnvironment(),
    windowsHide: true,
  }).trim();
}

export function transferGitEnvironment(extra = {}) {
  return sanitizedGitEnvironment({ ...process.env, ...extra });
}

export function withTransferGitEnvironment(run) {
  const keys = gitLocationKeys(process.env);
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    return run();
  } finally {
    for (const key of keys) delete process.env[key];
    for (const [key, value] of Object.entries(prior)) process.env[key] = value;
  }
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv) {
  const parsed = {
    candidateRoot: process.cwd(),
    baselineRoot: process.env.STATION_TRANSFER_BASELINE_ROOT ?? '',
    base: process.env.STATION_BASE_REF ?? 'origin/main',
    outputDir: '.kontourai/orchestration-transfer-gate',
    prepareBaseline: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--prepare-baseline') parsed.prepareBaseline = true;
    else if (argument.startsWith('--candidate-root='))
      parsed.candidateRoot = argument.slice(17);
    else if (argument.startsWith('--baseline-root='))
      parsed.baselineRoot = argument.slice(16);
    else if (argument.startsWith('--base=')) parsed.base = argument.slice(7);
    else if (argument.startsWith('--output-dir='))
      parsed.outputDir = argument.slice(13);
    else if (
      [
        '--candidate-root',
        '--baseline-root',
        '--base',
        '--output-dir',
      ].includes(argument)
    ) {
      const key = argument
        .slice(2)
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      parsed[key] = argv[++index] ?? '';
    } else fail(`unrecognized argument: ${argument}`);
  }
  return parsed;
}

function exactRoot(root, label, shaExpected) {
  const actual = resolve(root);
  if (!existsSync(actual)) fail(`${label} root does not exist: ${actual}`);
  const subject = git(actual, ['rev-parse', 'HEAD']);
  if (subject !== shaExpected)
    fail(`${label} root is ${subject}, expected exact ${shaExpected}`);
  if (git(actual, ['status', '--porcelain']) !== '')
    fail(`${label} root is dirty; capture requires a clean full tree`);
  assertInstalledDependenciesMatchLockfile({ repositoryRoot: actual });
  assertWorkspacePackageProvenance({ repositoryRoot: actual });
  return actual;
}

function provenance(root) {
  return collectVerificationProvenance({ cwd: root });
}

function sameProvenance(left, right, label) {
  for (const key of [
    'headSha',
    'dirty',
    'workspaceDigest',
    'dependencyDigest',
    'toolchain',
    'toolchainIdentity',
    'environmentDigest',
  ]) {
    if (sha(JSON.stringify(left[key])) !== sha(JSON.stringify(right[key])))
      fail(`${label} drifted during capture: ${key}`);
  }
}

function prepareBaseline(candidateRoot, baselineRoot, baseSha) {
  if (!baselineRoot) fail('--prepare-baseline requires --baseline-root');
  const target = resolve(baselineRoot);
  if (existsSync(target)) {
    exactRoot(target, 'prepared baseline', baseSha);
    console.log(`Prepared baseline already valid: ${target}`);
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  const result = spawnSync(
    'git',
    ['-C', candidateRoot, 'worktree', 'add', '--detach', target, baseSha],
    { stdio: 'inherit', env: transferGitEnvironment(), windowsHide: true },
  );
  if (result.status !== 0)
    fail(`could not create detached baseline worktree: ${target}`);
  console.log(
    `Baseline created at ${target}. Install its OWN locked dependencies before the gate:`,
  );
  console.log(`  cd ${target} && npm run dependencies:ci`);
  console.log(`  cd ${target} && npm run dependencies:verify`);
  console.log(
    'The gate never installs dependencies; rerun after that command succeeds.',
  );
}

// Liveness only: a hung child cannot hold a pre-push forever. This is not a
// throughput or product-performance target and is never recorded as one.
// Current exact captures measured just under 28s on the reference Mac. This
// remains a dead-child liveness bound, not a product-performance budget; 60s
// leaves scheduler/contention margin without allowing an unbounded push hook.
export const TRANSFER_CAPTURE_LIVENESS_TIMEOUT_MS = 60_000;

export function runTransferCapture({
  candidateRoot,
  targetRoot,
  output,
  baseSha,
  capture: captureOverride = undefined,
  spawn = spawnSync,
}) {
  const tsx = resolve(candidateRoot, 'node_modules/tsx/dist/cli.mjs');
  if (!existsSync(tsx)) fail(`candidate capture tool unavailable: ${tsx}`);
  const capture =
    captureOverride ??
    resolve(candidateRoot, 'scripts/orchestration-transfer-capture.ts');
  const captureTsconfig = resolve(
    candidateRoot,
    'scripts/orchestration-transfer-capture.tsconfig.json',
  );
  const result = spawn(
    process.execPath,
    [tsx, capture, targetRoot, output, baseSha, candidateRoot],
    {
      cwd: candidateRoot,
      encoding: 'utf8',
      env: transferGitEnvironment({ TSX_TSCONFIG_PATH: captureTsconfig }),
      timeout: TRANSFER_CAPTURE_LIVENESS_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error?.code === 'ETIMEDOUT')
    fail(
      `capture liveness timeout after ${TRANSFER_CAPTURE_LIVENESS_TIMEOUT_MS}ms for ${targetRoot}`,
    );
  if (result.status !== 0) {
    const resolutionFailure =
      /does not provide an export named|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/.test(
        result.stderr ?? '',
      );
    fail(
      resolutionFailure
        ? `capture dependency resolution failed for ${targetRoot}; inspect the module error above (preparing the baseline again will not repair resolution)`
        : `capture failed for ${targetRoot}`,
    );
  }
  if (!existsSync(output)) fail(`capture produced no report: ${output}`);
  try {
    return JSON.parse(readFileSync(output, 'utf8'));
  } catch {
    fail(`capture produced invalid JSON: ${output}`);
  }
}

function recordedPolicyMetrics(prior, envelope, baseline, candidate) {
  const rows = [];
  for (const [name, limits] of Object.entries(envelope.policy ?? {})) {
    for (const metric of ['wireBytes', 'decodedBytes', 'frames']) {
      const before = prior.policy?.[name]?.[metric];
      const after = limits?.[metric];
      if (before === after) continue;
      for (const scenario of ['external-engine', 'station-native']) {
        const key = (report) =>
          report.phases.find(
            (phase) => phase.scenario === scenario && phase.name === name,
          )?.[metric];
        const baselineValue = key(baseline);
        const candidateValue = key(candidate);
        if (
          !Number.isSafeInteger(before) ||
          !Number.isSafeInteger(after) ||
          !Number.isSafeInteger(baselineValue) ||
          !Number.isSafeInteger(candidateValue)
        )
          fail(
            `policy attribution has unmeasured ${scenario}/${name}/${metric}`,
          );
        rows.push({
          scenario,
          name,
          metric,
          before,
          after,
          baseline: baselineValue,
          candidate: candidateValue,
        });
      }
    }
  }
  return rows;
}

function isMissingBasePolicy(error) {
  const text = String(error?.stderr ?? error?.message ?? error);
  return /path .+ (?:does not exist in|exists on disk, but not in) .+/i.test(
    text,
  );
}

export function policyAttribution({
  candidateRoot,
  baseSha,
  envelope,
  baseline,
  candidate,
  readBase = () =>
    git(candidateRoot, [
      'show',
      `${baseSha}:scripts/fixtures/orchestration-transfer/budget.json`,
    ]),
  exists = existsSync,
  read = readFileSync,
}) {
  let priorRaw;
  try {
    priorRaw = readBase();
  } catch (error) {
    if (!isMissingBasePolicy(error)) throw error;
    return {
      kind: 'INTRODUCTION',
      priorPolicyDigest: null,
      policyDigest: sha(JSON.stringify(envelope)),
    };
  }
  const prior = JSON.parse(priorRaw);
  if (JSON.stringify(prior) === JSON.stringify(envelope))
    return {
      kind: 'UNCHANGED',
      priorPolicyDigest: sha(priorRaw),
      policyDigest: sha(JSON.stringify(envelope)),
    };
  const recordPath = resolve(
    candidateRoot,
    'scripts/fixtures/orchestration-transfer/policy-attribution.json',
  );
  if (!exists(recordPath))
    fail('policy changed without checked-in attribution record');
  const record = JSON.parse(read(recordPath, 'utf8'));
  const digest = sha(JSON.stringify(envelope));
  const actualMetrics = recordedPolicyMetrics(
    prior,
    envelope,
    baseline,
    candidate,
  );
  if (
    record.issue !== 'station#4294' ||
    typeof record.author !== 'string' ||
    record.author.trim() === '' ||
    typeof record.reason !== 'string' ||
    record.reason.trim() === '' ||
    record.priorPolicyDigest !== sha(priorRaw) ||
    record.newPolicyDigest !== digest ||
    !Array.isArray(record.actualMetrics) ||
    JSON.stringify(record.actualMetrics) !== JSON.stringify(actualMetrics)
  )
    fail(
      'policy attribution does not match exact base/candidate policy evidence',
    );
  return {
    kind: 'ATTRIBUTED',
    priorPolicyDigest: sha(priorRaw),
    policyDigest: digest,
    record,
  };
}

/** The capture/compare transaction, injectable so its fail-closed order is testable. */
export function executeTransferComparison({
  candidateRoot,
  baselineRoot,
  outputDir,
  baseSha,
  candidateSha,
  capture = runTransferCapture,
  readPolicy = (root) =>
    JSON.parse(
      readFileSync(
        resolve(root, 'scripts/fixtures/orchestration-transfer/budget.json'),
        'utf8',
      ),
    ),
  beforeCandidate = provenance(candidateRoot),
  beforeBaseline = provenance(baselineRoot),
  readProvenance = provenance,
  assertRoot = exactRoot,
  attribute = policyAttribution,
  write = writeFileSync,
  makeRunDirectory = (directory) => mkdtempSync(resolve(directory, 'run-')),
}) {
  const runDir = makeRunDirectory(outputDir);
  const baselineA = capture({
    candidateRoot,
    targetRoot: baselineRoot,
    output: resolve(runDir, 'baseline-a.json'),
    baseSha,
  });
  const baselineB = capture({
    candidateRoot,
    targetRoot: baselineRoot,
    output: resolve(runDir, 'baseline-b.json'),
    baseSha,
  });
  const candidate = capture({
    candidateRoot,
    targetRoot: candidateRoot,
    output: resolve(runDir, 'candidate.json'),
    baseSha,
  });
  const envelope = readPolicy(candidateRoot);
  assertDeterministicBaseline(baselineA, baselineB);
  const comparison = compareTransferEvidence(
    candidate,
    baselineA,
    envelope.policy,
    {
      candidateSha,
      baseSha,
    },
  );
  validateTransferEvidence(candidate, 'candidate');
  const attribution = attribute({
    candidateRoot,
    baseSha,
    envelope,
    baseline: baselineA,
    candidate,
  });
  sameProvenance(
    beforeCandidate,
    readProvenance(candidateRoot),
    'candidate root',
  );
  sameProvenance(beforeBaseline, readProvenance(baselineRoot), 'baseline root');
  assertRoot(candidateRoot, 'candidate after capture', candidateSha);
  assertRoot(baselineRoot, 'baseline after capture', baseSha);
  const report = {
    schemaVersion: 1,
    candidateSha,
    baseSha,
    baselineSha: baselineA.subjectSha,
    comparison,
    attribution,
    reports: ['baseline-a.json', 'baseline-b.json', 'candidate.json'],
  };
  write(resolve(runDir, 'comparison.json'), `${JSON.stringify(report)}\n`);
  return { report, runDir };
}

function runTransferGateInner(options) {
  const candidateRoot = resolve(options.candidateRoot);
  const baseSha = git(candidateRoot, ['rev-parse', options.base]);
  const candidateSha = git(candidateRoot, ['rev-parse', 'HEAD']);
  if (options.prepareBaseline) {
    prepareBaseline(candidateRoot, options.baselineRoot, baseSha);
    return { prepared: true };
  }
  if (!options.baselineRoot)
    fail(
      `missing --baseline-root. Prepare an exact sibling first: npm run transfer:gate -- --prepare-baseline --baseline-root ../station-worktrees/4294-transfer-baseline-${baseSha.slice(0, 12)} --base ${baseSha}`,
    );
  const baselineRoot = exactRoot(options.baselineRoot, 'baseline', baseSha);
  exactRoot(candidateRoot, 'candidate', candidateSha);
  const outputDir = resolve(candidateRoot, options.outputDir);
  const ignoredRoot = `${resolve(candidateRoot, '.kontourai')}${sep}`;
  if (!outputDir.startsWith(ignoredRoot))
    fail('--output-dir must be an ignored directory inside .kontourai/');
  mkdirSync(outputDir, { recursive: true });
  // A capture only counts if THIS invocation created every artifact. Never
  // reuse a previous green JSON after a child failed before writing anything.
  const runDir = mkdtempSync(resolve(outputDir, 'run-'));
  const { report, runDir: ownedRunDir } = executeTransferComparison({
    candidateRoot,
    baselineRoot,
    outputDir: runDir,
    baseSha,
    candidateSha,
  });
  console.log(
    `PASS: orchestration transfer comparison written to ${ownedRunDir}`,
  );
  return report;
}

export function runTransferGate(options = parseArgs(process.argv.slice(2))) {
  return withTransferGitEnvironment(() => runTransferGateInner(options));
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    runTransferGate();
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
