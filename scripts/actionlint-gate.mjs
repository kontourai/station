/**
 * Statically validate `.github/workflows/**` with `actionlint`.
 *
 * Workflow files were the one category of change in this repo with no local
 * validation at all. `actionlint` was already installed on the machine and
 * wired into nothing, so a malformed `uses:` reference, a bad expression, or a
 * typo'd context reached `main` unchecked — and with hosted CI billing-blocked
 * (see docs/strategy/local-merge-readiness.md) nothing downstream would catch
 * it either. Five GitHub Actions major bumps landed on 2026-07-29 across twelve
 * workflow files; the only reason they were validated is that someone ran this
 * tool by hand.
 *
 * ## A missing tool is NOT_VERIFIED, never a pass
 *
 * If `actionlint` is not installed this exits 2 with `NOT_VERIFIED` on stderr.
 * A check that could not run is unchecked, not clean: the merge floor must
 * retain that distinction instead of manufacturing a green result.
 *
 * ## Baseline
 *
 * `scripts/actionlint-baseline.json` records findings that already existed when
 * this gate landed, so pre-existing noise does not read as a new failure. It is
 * a ratchet in the same spirit as `state-primitives-baseline.json`: the count
 * may only decrease. A NEW finding fails the gate even while the baseline is
 * non-zero.
 *
 * Matching is by `file:rule` rather than `file:line:col`, so unrelated edits
 * that shift a line number do not spuriously fail — at the cost of not
 * distinguishing two instances of the same rule in one file. That trade is
 * deliberate: a line-anchored baseline would need rewriting on every edit,
 * which is exactly the churn that trains people to regenerate baselines
 * without reading them.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const BASELINE_PATH = join(HERE, 'actionlint-baseline.json');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const GITHUB_HOSTED_RUNNER_IMAGES = new Set([
  'ubuntu-latest',
  'ubuntu-22.04',
  // GitHub's partner arm64 hosted image (free for public repositories),
  // used by node-pty-prebuilds.yml to build the linux-arm64 artifact (#1245).
  'ubuntu-22.04-arm',
  'windows-latest',
  'macos-latest',
  'macos-15',
  'macos-15-intel',
  'macos-26',
]);

/** `null` when actionlint is not on PATH. */
export function resolveActionlint(run = execFileSync) {
  try {
    run('actionlint', ['-version'], { encoding: 'utf8', stdio: 'pipe' });
    return 'actionlint';
  } catch {
    return null;
  }
}

/**
 * Parse actionlint's default output into `{file, rule, message}` records.
 * Format: `path:line:col: message [rule]`
 */
export function parseFindings(stdout) {
  const findings = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(
      /^(\S+?):(\d+):(\d+):\s+(.*?)\s+\[([a-z-]+)\]\s*$/,
    );
    if (!match) continue;
    findings.push({
      file: match[1],
      line: Number(match[2]),
      rule: match[5],
      message: match[4],
    });
  }
  return findings;
}

/** Stable identity for baselining: file + rule, deliberately not line/col. */
export function findingKey(finding) {
  return `${finding.file}::${finding.rule}`;
}

export function compareToBaseline(findings, baselineKeys) {
  const allowed = new Set(baselineKeys);
  const seen = new Set();
  const unexpected = [];
  for (const finding of findings) {
    const key = findingKey(finding);
    seen.add(key);
    if (!allowed.has(key)) unexpected.push(finding);
  }
  const resolved = baselineKeys.filter((key) => !seen.has(key));
  return { unexpected, resolved };
}

/**
 * @param {{
 *   workflowDirectoryExists: boolean;
 *   binary?: string | null;
 *   status?: number;
 *   findings?: unknown[];
 * }} input
 */
export function classifyActionlintEvaluation({
  workflowDirectoryExists,
  binary,
  status,
  findings,
}) {
  if (!workflowDirectoryExists) {
    return { exitCode: 1, reason: 'workflow-directory-missing' };
  }
  if (!binary) return { exitCode: 2, reason: 'actionlint-unavailable' };
  if (status !== 0 && status !== 1) {
    return { exitCode: 1, reason: 'actionlint-did-not-scan' };
  }
  if (status === 1 && (findings?.length ?? 0) === 0) {
    return { exitCode: 1, reason: 'actionlint-output-unparseable' };
  }
  return { exitCode: 0, reason: 'evaluated' };
}

/**
 * Persistent runners already retain npm's content-addressed cache in their
 * service account home. actions/setup-node's remote cache downloads and
 * extracts the same multi-gigabyte archive once per job, serializing the fleet
 * without changing npm run dependencies:ci's clean-install or lockfile guarantees.
 */
function resolvedRunnerLabels(job) {
  const runsOn = job?.['runs-on'];
  const matrixKey =
    typeof runsOn === 'string'
      ? runsOn.match(/^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/)?.[1]
      : undefined;
  if (!matrixKey)
    return { runsOn, labels: Array.isArray(runsOn) ? runsOn : [runsOn] };
  const matrix = job?.strategy?.matrix;
  const included = (matrix?.include ?? [])
    .map((entry) => entry?.[matrixKey])
    .filter(Boolean);
  const labels = [matrix?.[matrixKey], ...included]
    .filter(Boolean)
    .flatMap((value) => (Array.isArray(value) ? value : [value]));
  return { runsOn, labels };
}

function classifyRunner(job) {
  const { runsOn, labels } = resolvedRunnerLabels(job);
  const groupRouted =
    runsOn && typeof runsOn === 'object' && !Array.isArray(runsOn);
  return {
    labels,
    persistent: groupRouted || labels.includes('self-hosted'),
    hosted:
      !groupRouted &&
      labels.length > 0 &&
      labels.every((label) => GITHUB_HOSTED_RUNNER_IMAGES.has(label)),
  };
}

const PHYSICAL_HOST_CAPACITY_ACTION =
  'kontourai/.github/actions/physical-host-capacity@';
const TERMINAL_CAPACITY_RECOVERY_ACTION =
  'kontourai/.github/actions/recover-terminal-capacity-owner@563effe7ec559c6f4fcc6c80b3532acb71d86373';
const TERMINAL_CAPACITY_RECOVERY_WORKFLOW =
  '.github/workflows/recover-terminal-capacity-owner.yml';
const PHYSICAL_HOST_CAPACITY_BOOTSTRAP_ACTIONS = [
  'actions/checkout@',
  'actions/setup-node@',
  'kontourai/.github/actions/runner-preflight@',
];
const NIGHTLY_WORKFLOW = '.github/workflows/nightly.yml';
const NIGHTLY_JOB = 'nightly';
const NIGHTLY_REBUILD_INDEX_PREVALIDATION_NAME =
  'Validate requested Nightly rebuild index';
const NIGHTLY_REBUILD_INDEX_PREVALIDATION_RUN = [
  "node --input-type=module -e '",
  '  import { parseNightlyRebuildIndex } from "./scripts/lib/nightly-build-identity.mjs";',
  '  parseNightlyRebuildIndex(process.env.NIGHTLY_REBUILD_INDEX);',
  "'",
  '',
].join('\n');
const NIGHTLY_REBUILD_INDEX_PREVALIDATION_ENV = Object.freeze({
  NIGHTLY_REBUILD_INDEX: '${' + '{ inputs.rebuild_index }}',
});
const NIGHTLY_JOB_ENV = Object.freeze({
  GCP_PLAY_WORKLOAD_IDENTITY_PROVIDER:
    '${' + '{ vars.GCP_PLAY_WORKLOAD_IDENTITY_PROVIDER }}',
  GCP_PLAY_SERVICE_ACCOUNT: '${' + '{ vars.GCP_PLAY_SERVICE_ACCOUNT }}',
  ANDROID_UPLOAD_KEY_ALIAS: '${' + '{ vars.ANDROID_UPLOAD_KEY_ALIAS }}',
  ANDROID_UPLOAD_CERT_SHA256: '${' + '{ vars.ANDROID_UPLOAD_CERT_SHA256 }}',
  ANDROID_BUILD_TOOLS_VERSION: '36.0.0',
  STATION_MOBILE_DEFAULT_ENDPOINT:
    '${' + '{ vars.STATION_MOBILE_DEFAULT_ENDPOINT_NIGHTLY }}',
});
/** The one place the reviewed capacity-action commit is declared.
 *
 * Exported because it used to be restated in two test files as well, and those
 * three copies drifted: #3443 moved the workflows and the contract test to
 * `5661bfac` but left this constant on the previous commit, so the gate
 * rejected every workflow on `main` while `actionlint-gate`'s own suite stayed
 * green — its fixtures restated the stale value, so they agreed with the bug.
 * Import this rather than writing the SHA down again. */
export const REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA =
  '563effe7ec559c6f4fcc6c80b3532acb71d86373';
const REVIEWED_REUSABLE_CAPACITY_WORKFLOW_SHA =
  '02f40a67901a79ce4004c44d91e350b93782644c';
const REVIEWED_SECRET_SCAN_REUSABLE_WORKFLOW_SHA =
  '02f40a67901a79ce4004c44d91e350b93782644c';
const SECRET_SCAN_WORKFLOW = '.github/workflows/secret-scan.yml';
const SECRET_SCAN_REUSABLE_WORKFLOW = `kontourai/.github/.github/workflows/secret-scan.yml@${REVIEWED_SECRET_SCAN_REUSABLE_WORKFLOW_SHA}`;
/**
 * `owner-lifetime-seconds` is part of the host manifest, so it is one shared
 * physical-host setting rather than a per-job tuning knob. The pinned action
 * writes an absolute expiry at acquisition; it does not renew a heartbeat.
 * Keep enough time for the longest admitted job plus post-step recovery.
 */
export const CAPACITY_OWNER_LIFETIME_SECONDS = 7800;
export const CAPACITY_RECOVERY_MARGIN_SECONDS = 300;
const MAX_PHYSICAL_HOST_CAPACITY_JOB_TIMEOUT_MINUTES = Math.floor(
  (CAPACITY_OWNER_LIFETIME_SECONDS - CAPACITY_RECOVERY_MARGIN_SECONDS) / 60,
);
const DESKTOP_WIN_HOST_ID = 'desktop-win';
const FAST_FEEDBACK_LEASE_WEIGHT = 1;
export const FAST_CHECKS_JOB_TIMEOUT_MINUTES = 45;
const MAX_NON_FAST_DESKTOP_WIN_LEASE_WEIGHT = 9;
const REQUIRED_CAPACITY_INPUTS = [
  'coordination-root',
  'host-id',
  'capacity-units',
  'lease-weight',
  'timeout-seconds',
  'owner-lifetime-seconds',
];
const FAST_FEEDBACK_LABEL = 'fast-feedback';
const HEAVY_HOST_LABEL = 'heavy-host';
const FAST_FEEDBACK_JOB = Object.freeze({
  file: '.github/workflows/ci.yml',
  jobId: 'fast-checks',
});
const FORK_SMOKE_JOB = Object.freeze({
  file: '.github/workflows/ci.yml',
  jobId: 'fork-smoke',
});
const SAME_REPOSITORY_FAST_CHECKS_CONDITION = `\${{ always() && !cancelled() && (github.event_name == 'merge_group' || (github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name == github.repository) || github.event_name == 'workflow_dispatch' || needs.classify.outputs.heavy == 'true') }}`;
const FORK_SMOKE_CONDITION = `\${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name != github.repository }}`;
const PULL_REQUEST_TARGET = 'pull_request_target';
const MERGE_GROUP = 'merge_group';
const MERGE_GROUP_TYPES = ['checks_requested'];
const CI_ROUTER_PR_TARGET_TYPES = [
  'opened',
  'synchronize',
  'reopened',
  'edited',
];
const PRIMARY_ROUTER_JOBS = new Set([
  'classify',
  'fast-checks',
  'fork-smoke',
  'full-regression',
  'manual-completion-diagnostics',
  'browser-smoke',
]);
const FAST_CHECKOUT_REPOSITORY = `\${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name || github.repository }}`;
const FAST_CHECKOUT_REF = `\${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.sha || github.sha }}`;
const PR_TITLE_BASE_CHECKOUT_NAME =
  'Check out base policy for pull-request title gate';
const PR_TITLE_BASE_CHECKOUT_REPOSITORY = `\${{ github.repository }}`;
const PR_TITLE_BASE_CHECKOUT_REF = `\${{ github.event.pull_request.base.sha }}`;
const PR_TITLE_GATE_NAME = 'Validate base-controlled pull-request title';
const PR_TITLE_GATE_IF = `\${{ github.event_name == 'pull_request_target' }}`;
const PR_TITLE_GATE_ENV = Object.freeze({
  PULL_REQUEST_TITLE: `\${{ github.event.pull_request.title }}`,
  PULL_REQUEST_NUMBER: `\${{ github.event.pull_request.number }}`,
});
const PR_TITLE_GATE_RUN =
  'node scripts/commit-message-gate.mjs --pull-request-title "$PULL_REQUEST_TITLE" "$PULL_REQUEST_NUMBER"';
const SECURITY_ANALYSIS_WORKFLOW = '.github/workflows/security-analysis.yml';
const SECURITY_ANALYSIS_CODEQL_JOB = 'codeql';
const DEPENDENCY_REVIEW_JOB = 'dependency-review';
const SECURITY_BASE_CHECKOUT_REPOSITORY = `\${{ github.repository }}`;
const SECURITY_BASE_CHECKOUT_REF = `\${{ github.event_name == 'pull_request_target' && github.event.pull_request.base.sha || github.event_name == 'merge_group' && github.event.merge_group.base_sha || github.sha }}`;
const SECURITY_BASE_CHECKOUT_PATH = 'base-policy';
const SECURITY_CANDIDATE_CHECKOUT_PATH = 'candidate';
const SECURITY_BASE_POLICY_DIRECTORY = `\${{ runner.temp }}/base-policy`;
const SECURITY_SARIF_OUTPUT = `\${{ runner.temp }}/codeql-sarif`;
const SECURITY_NORMALIZED_SARIF = `\${{ runner.temp }}/codeql-sarif-normalized/javascript.sarif`;
const SECURITY_ANALYSIS_TIMEOUT_MINUTES = 30;
const SECURITY_ANALYSIS_CONCURRENCY_GROUP =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
  'security-analysis-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}';
/**
 * Exported for the same reason as `REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA`
 * above: each of these was restated in a workflow contract test, so the gate
 * and the suite asserting the gate's pin could disagree while both stayed
 * green. Import these rather than writing a SHA down again.
 */
export const CHECKOUT_ACTION =
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
export const SETUP_NODE_ACTION =
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020';
export const CODEQL_INIT_ACTION =
  'github/codeql-action/init@cdf488f595d80d6e07e03d4674febd5ab45fa938';
export const CODEQL_ANALYZE_ACTION =
  'github/codeql-action/analyze@cdf488f595d80d6e07e03d4674febd5ab45fa938';
export const DEPENDENCY_REVIEW_ACTION =
  'actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294';
const DEPENDENCY_REVIEW_CANDIDATE_GUARD = `\${{ github.event_name == 'pull_request_target' || github.event_name == 'merge_group' }}`;
const DEPENDENCY_REVIEW_PR_GUARD = `\${{ github.event_name == 'pull_request_target' }}`;
const DEPENDENCY_REVIEW_MERGE_GROUP_GUARD = `\${{ github.event_name == 'merge_group' }}`;
const SECURITY_ISOLATE_BASE_POLICY_RUN =
  'mv base-policy "$BASE_POLICY_DIRECTORY"';
const SECURITY_POLICY_RUN = `mapfile -d '' -t SARIF_FILES < <(find "$CODEQL_SARIF_DIRECTORY" -type f -name javascript.sarif -print0)
if [ "\${#SARIF_FILES[@]}" -ne 1 ]; then
  echo "Expected exactly one JavaScript CodeQL SARIF file; found \${#SARIF_FILES[@]}." >&2
  exit 1
fi
node "$BASE_POLICY_DIRECTORY/scripts/codeql-sarif-normalize.mjs" --input="\${SARIF_FILES[0]}" --output="$CODEQL_NORMALIZED_SARIF"
# PRs read the baseline from the BASE checkout, so an entry a PR
# removes is invisible here; warn instead of failing or the baseline
# could never shrink through a green gate. Push-to-main enforces.
STALE_BASELINE_MODE=fail
if [ "$GITHUB_EVENT_NAME" = "pull_request_target" ] || [ "$GITHUB_EVENT_NAME" = "merge_group" ]; then
  STALE_BASELINE_MODE=warn
fi
node "$BASE_POLICY_DIRECTORY/scripts/codeql-sarif-policy.mjs" --input="$CODEQL_NORMALIZED_SARIF" --baseline="$BASE_POLICY_DIRECTORY/scripts/codeql-error-baseline.json" --stale-baseline="$STALE_BASELINE_MODE"`;
const FORK_CHECKOUT_REPOSITORY = `\${{ github.event.pull_request.head.repo.full_name }}`;
const FORK_CHECKOUT_REF = `\${{ github.event.pull_request.head.sha }}`;
const FULL_REGRESSION_WORKFLOW = '.github/workflows/full-regression.yml';
const FULL_REGRESSION_JOB_ID = 'full-regression';
const FULL_REGRESSION_COMPLETION_STEP = 'Run canonical completion gate';
const ACTIONLINT_ARCHIVE = 'actionlint_1.7.12_linux_amd64.tar.gz';
const ACTIONLINT_SHA256 =
  '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8';
const PINNED_ACTIONLINT_PROVISION_RUN = `mkdir -p "$RUNNER_TEMP/actionlint"
curl --fail --location --retry 3 --output "$RUNNER_TEMP/$ACTIONLINT_ARCHIVE" \\
  "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz"
echo "$ACTIONLINT_SHA256  $RUNNER_TEMP/$ACTIONLINT_ARCHIVE" | sha256sum --check --status
tar -xzf "$RUNNER_TEMP/$ACTIONLINT_ARCHIVE" -C "$RUNNER_TEMP/actionlint"
echo "$RUNNER_TEMP/actionlint" >> "$GITHUB_PATH"
`;
const EXACT_TARGET_SKIP_GUARDS = Object.freeze({
  classify: `\${{ github.event_name != 'pull_request_target' }}`,
  'full-regression': `\${{ always() && !cancelled() && github.event_name != 'pull_request_target' && github.event_name == 'workflow_dispatch' }}`,
  'manual-completion-diagnostics': `\${{ always() && !cancelled() && github.event_name == 'workflow_dispatch' && (needs['full-regression'].result == 'success' || needs['full-regression'].result == 'failure') }}`,
  'browser-smoke':
    "github.event_name != 'pull_request_target' && (github.event_name == 'workflow_dispatch' || needs.classify.outputs.heavy == 'true')",
});
const BASE_CONTROLLED_PR_WORKFLOWS = new Set([
  '.github/workflows/build-ios.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/desktop-clean-checkout.yml',
  '.github/workflows/desktop-rust.yml',
  '.github/workflows/ecosystem-packaging.yml',
  '.github/workflows/install-smoke.yml',
  '.github/workflows/security-analysis.yml',
  '.github/workflows/windows-pr-verification.yml',
]);
const MERGE_QUEUE_WORKFLOWS = new Set([
  '.github/workflows/build-ios.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/security-analysis.yml',
  '.github/workflows/windows-pr-verification.yml',
]);

function hasRequiredCapacityOwnerLifetime(value) {
  return String(value) === String(CAPACITY_OWNER_LIFETIME_SECONDS);
}

function hasExactFastFeedbackLeaseWeight(value) {
  return String(value) === String(FAST_FEEDBACK_LEASE_WEIGHT);
}

function hasBoundedNonFastDesktopWinLeaseWeight(value) {
  const numericValue = Number(value);
  return (
    Number.isInteger(numericValue) &&
    numericValue >= 1 &&
    numericValue <= MAX_NON_FAST_DESKTOP_WIN_LEASE_WEIGHT
  );
}

function hasPhysicalHostCapacityStep(job) {
  return (job?.steps ?? []).some(
    (step) =>
      typeof step?.uses === 'string' &&
      step.uses.startsWith(PHYSICAL_HOST_CAPACITY_ACTION),
  );
}

function isTerminalCapacityRecoveryJob(file, jobId, job) {
  return (
    file === TERMINAL_CAPACITY_RECOVERY_WORKFLOW &&
    ['recover-linux', 'recover-windows'].includes(jobId) &&
    job?.steps?.length === 1 &&
    job.steps[0]?.uses === TERMINAL_CAPACITY_RECOVERY_ACTION
  );
}

function isPhysicalHostCapacityBootstrapStep(step) {
  return (
    typeof step?.uses === 'string' &&
    PHYSICAL_HOST_CAPACITY_BOOTSTRAP_ACTIONS.some((action) =>
      step.uses.startsWith(action),
    )
  );
}

/**
 * The Nightly dispatch value is the sole pure pre-admission check. It must
 * reject malformed operator input before the build host is leased, while the
 * exact command prevents this exception from becoming a generic early-work
 * escape hatch.
 */
function hasSafeNightlyPrevalidationContext(document, job) {
  return (
    document?.env === undefined &&
    document?.defaults === undefined &&
    job?.defaults === undefined &&
    JSON.stringify(job?.env) === JSON.stringify(NIGHTLY_JOB_ENV)
  );
}

function isPhysicalHostCapacityPrevalidationStep(
  file,
  jobId,
  document,
  job,
  step,
) {
  return (
    file === NIGHTLY_WORKFLOW &&
    jobId === NIGHTLY_JOB &&
    hasSafeNightlyPrevalidationContext(document, job) &&
    step?.name === NIGHTLY_REBUILD_INDEX_PREVALIDATION_NAME &&
    step?.shell === 'bash' &&
    step?.run === NIGHTLY_REBUILD_INDEX_PREVALIDATION_RUN &&
    JSON.stringify(step?.env) ===
      JSON.stringify(NIGHTLY_REBUILD_INDEX_PREVALIDATION_ENV) &&
    Object.keys(step).length === 4 &&
    ['env', 'name', 'run', 'shell'].every((key) => key in step)
  );
}

function isLinuxRunner(labels) {
  return labels.includes('Linux');
}

function isFastFeedbackJob(file, jobId) {
  return file === FAST_FEEDBACK_JOB.file && jobId === FAST_FEEDBACK_JOB.jobId;
}

function hasExactSameRepositoryFastChecksGuard(file, jobId, condition) {
  return (
    isFastFeedbackJob(file, jobId) &&
    condition === SAME_REPOSITORY_FAST_CHECKS_CONDITION
  );
}

/**
 * `runs-on` labels are a security and scheduling contract, not annotations:
 * GitHub accepts any runner whose labels are a superset of the requested set.
 * The fast listener deliberately lacks `kontour-linux`; every leased Linux
 * job must instead select the heavy listener so a queued heavyweight cannot
 * occupy feedback capacity before its physical-host lease is admitted.
 */
function runnerPartitionFindings(file, jobId, labels, hasCapacityLease) {
  const findings = [];
  const fastFeedback = labels.includes(FAST_FEEDBACK_LABEL);
  const heavyHost = labels.includes(HEAVY_HOST_LABEL);
  const expectedFastFeedback = isFastFeedbackJob(file, jobId);

  if (fastFeedback && !expectedFastFeedback)
    findings.push({
      file,
      jobId,
      message: 'fast-feedback is reserved for ci.yml fast-checks only',
    });

  if (expectedFastFeedback && !fastFeedback)
    findings.push({
      file,
      jobId,
      message:
        'ci.yml fast-checks must target the dedicated fast-feedback listener',
    });

  if (fastFeedback && (labels.includes('kontour-linux') || heavyHost))
    findings.push({
      file,
      jobId,
      message:
        'fast-feedback jobs must not request kontour-linux or heavy-host labels',
    });

  if (expectedFastFeedback && !hasCapacityLease)
    findings.push({
      file,
      jobId,
      message:
        'ci.yml fast-checks must retain physical-host capacity coordination',
    });

  if (isLinuxRunner(labels) && !expectedFastFeedback && !heavyHost)
    findings.push({
      file,
      jobId,
      message:
        'persistent Linux jobs must target an exclusive heavy-host or fast-feedback listener',
    });

  return findings;
}

function physicalHostCapacityFindings(file, jobId, document, job) {
  const findings = [];
  const steps = job?.steps;
  const capacityStepIndex = (steps ?? []).findIndex(
    (candidate) =>
      typeof candidate?.uses === 'string' &&
      candidate.uses.startsWith(PHYSICAL_HOST_CAPACITY_ACTION),
  );
  const step = capacityStepIndex >= 0 ? steps[capacityStepIndex] : undefined;
  if (!step)
    return [
      {
        file,
        jobId,
        message: 'desktop-win jobs must reserve shared physical-host capacity',
      },
    ];

  const earlyWorkStep = steps
    .slice(0, capacityStepIndex)
    .find(
      (candidate) =>
        !isPhysicalHostCapacityBootstrapStep(candidate) &&
        !isPhysicalHostCapacityPrevalidationStep(
          file,
          jobId,
          document,
          job,
          candidate,
        ),
    );
  if (earlyWorkStep)
    findings.push({
      file,
      jobId,
      message:
        'physical-host-capacity must run before every step except checkout, setup-node, runner-preflight, and the exact Nightly rebuild-index prevalidation',
    });

  const revision = step.uses.slice(PHYSICAL_HOST_CAPACITY_ACTION.length);
  if (revision !== REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA)
    findings.push({
      file,
      jobId,
      message: `physical-host-capacity must use reviewed action commit ${REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA}`,
    });

  const missingInputs = REQUIRED_CAPACITY_INPUTS.filter(
    (input) => step?.with?.[input] === undefined,
  );
  if (missingInputs.length > 0)
    findings.push({
      file,
      jobId,
      message: `physical-host-capacity must explicitly set: ${missingInputs.join(', ')}`,
    });

  if (!hasRequiredCapacityOwnerLifetime(step?.with?.['owner-lifetime-seconds']))
    findings.push({
      file,
      jobId,
      message: `physical-host-capacity must set owner-lifetime-seconds: ${CAPACITY_OWNER_LIFETIME_SECONDS}`,
    });

  const hostId = step?.with?.['host-id'];
  const leaseWeight = step?.with?.['lease-weight'];
  if (isFastFeedbackJob(file, jobId)) {
    if (
      leaseWeight !== undefined &&
      !hasExactFastFeedbackLeaseWeight(leaseWeight)
    )
      findings.push({
        file,
        jobId,
        message: `ci.yml fast-checks must reserve exactly ${FAST_FEEDBACK_LEASE_WEIGHT} physical-host capacity unit`,
      });
  } else if (
    String(hostId) === DESKTOP_WIN_HOST_ID &&
    leaseWeight !== undefined &&
    !hasBoundedNonFastDesktopWinLeaseWeight(leaseWeight)
  )
    findings.push({
      file,
      jobId,
      message: `desktop-win capacity reservations other than ci.yml fast-checks must use a literal lease-weight from 1 through ${MAX_NON_FAST_DESKTOP_WIN_LEASE_WEIGHT}`,
    });

  const timeoutMinutes = job?.['timeout-minutes'];
  if (
    isFastFeedbackJob(file, jobId) &&
    timeoutMinutes !== FAST_CHECKS_JOB_TIMEOUT_MINUTES
  )
    findings.push({
      file,
      jobId,
      message: `ci.yml fast-checks must set timeout-minutes: ${FAST_CHECKS_JOB_TIMEOUT_MINUTES}`,
    });
  if (
    typeof timeoutMinutes !== 'number' ||
    timeoutMinutes < 1 ||
    timeoutMinutes > MAX_PHYSICAL_HOST_CAPACITY_JOB_TIMEOUT_MINUTES
  )
    findings.push({
      file,
      jobId,
      message: `physical-host-capacity jobs must set timeout-minutes from 1 through ${MAX_PHYSICAL_HOST_CAPACITY_JOB_TIMEOUT_MINUTES}`,
    });
  return findings;
}

function terminalCapacityRecoveryFindings(file, jobId, job) {
  const step = job?.steps?.[0];
  if (!hasRequiredCapacityOwnerLifetime(step?.with?.['owner-lifetime-seconds']))
    return [
      {
        file,
        jobId,
        message: `terminal capacity recovery must set owner-lifetime-seconds: ${CAPACITY_OWNER_LIFETIME_SECONDS}`,
      },
    ];
  return [];
}

function reusableCapacityWorkflowFindings(file, jobId, job) {
  if (job?.with?.['capacity-coordination-root'] === undefined) return [];

  const findings = [];
  if (!job.uses.endsWith(`@${REVIEWED_REUSABLE_CAPACITY_WORKFLOW_SHA}`))
    findings.push({
      file,
      jobId,
      message: `reusable capacity callers must use reviewed workflow commit ${REVIEWED_REUSABLE_CAPACITY_WORKFLOW_SHA}`,
    });
  if (
    !hasRequiredCapacityOwnerLifetime(
      job?.with?.['capacity-owner-lifetime-seconds'],
    )
  )
    findings.push({
      file,
      jobId,
      message: `reusable capacity callers must set capacity-owner-lifetime-seconds: ${CAPACITY_OWNER_LIFETIME_SECONDS}`,
    });
  if (
    String(job?.with?.['capacity-host-id']) === DESKTOP_WIN_HOST_ID &&
    !hasBoundedNonFastDesktopWinLeaseWeight(
      job?.with?.['capacity-lease-weight'],
    )
  )
    findings.push({
      file,
      jobId,
      message: `desktop-win capacity reservations other than ci.yml fast-checks must use a literal lease-weight from 1 through ${MAX_NON_FAST_DESKTOP_WIN_LEASE_WEIGHT}`,
    });
  const runner = job?.with?.runner;
  let labels;
  if (typeof runner === 'string') {
    try {
      const parsed = JSON.parse(runner);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((label) => typeof label === 'string')
      )
        labels = parsed;
    } catch {
      // Reported below. Routing is an enforceable caller contract, so an
      // expression or malformed JSON must never silently bypass this gate.
    }
  }
  if (!labels) {
    findings.push({
      file,
      jobId,
      message:
        'reusable capacity runner must be a literal JSON array of runner labels',
    });
    return findings;
  }
  if (isLinuxRunner(labels)) {
    if (labels.includes(FAST_FEEDBACK_LABEL))
      findings.push({
        file,
        jobId,
        message: 'fast-feedback is reserved for ci.yml fast-checks only',
      });
    if (!labels.includes(HEAVY_HOST_LABEL))
      findings.push({
        file,
        jobId,
        message:
          'leased Linux jobs must target the heavy-host listener, not shared feedback capacity',
      });
  }
  return findings;
}

function reusableWorkflowPolicyFindings(file, jobId, job) {
  const findings = reusableCapacityWorkflowFindings(file, jobId, job);
  const runner = job?.with?.runner;
  if (typeof runner !== 'string') return findings;

  let labels;
  try {
    const parsed = JSON.parse(runner);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((label) => typeof label === 'string')
    )
      labels = parsed;
  } catch {
    // Capacity-routed reusable workflows already fail closed on a dynamic or
    // malformed runner above. Without a literal route, this layer cannot
    // truthfully classify a non-capacity reusable workflow as persistent.
  }
  if (!labels) return findings;

  const routed = classifyRunner({ 'runs-on': labels });
  if (routed.persistent && !skipsAutomaticPullRequest(job?.if))
    findings.unshift({
      file,
      jobId,
      message:
        'persistent self-hosted reusable-workflow jobs must skip automatic pull_request execution',
    });
  return findings;
}

function persistentStepPolicyFindings(file, jobId, steps) {
  const findings = [];
  for (const step of steps ?? []) {
    if (
      typeof step?.uses === 'string' &&
      step.uses.startsWith('actions/checkout@') &&
      step?.with?.['persist-credentials'] !== false
    )
      findings.push({
        file,
        jobId,
        message:
          'persistent self-hosted checkout must set persist-credentials: false',
      });
    if (
      typeof step?.uses === 'string' &&
      step.uses.startsWith('actions/setup-node@') &&
      step?.with?.cache
    )
      findings.push({
        file,
        jobId,
        message:
          'persistent self-hosted jobs must use the runner-local npm cache, not setup-node remote cache',
      });
  }
  return findings;
}

function persistentJobPolicyFindings(file, jobId, document, job) {
  const runner = classifyRunner(job);
  const hasCapacityStep = hasPhysicalHostCapacityStep(job);
  const terminalCapacityRecovery = isTerminalCapacityRecoveryJob(
    file,
    jobId,
    job,
  );
  if (!runner.persistent && !runner.hosted)
    return [
      {
        file,
        jobId,
        message:
          'runner routing is unresolved; classify it as a hosted image or an explicit self-hosted/group target',
      },
      ...(hasCapacityStep
        ? physicalHostCapacityFindings(file, jobId, document, job)
        : []),
    ];
  if (!runner.persistent)
    return hasCapacityStep
      ? physicalHostCapacityFindings(file, jobId, document, job)
      : [];
  const findings = persistentStepPolicyFindings(file, jobId, job?.steps);
  if (terminalCapacityRecovery)
    findings.push(...terminalCapacityRecoveryFindings(file, jobId, job));
  if (
    !terminalCapacityRecovery &&
    (runner.labels.includes('kontour-linux') ||
      runner.labels.includes('kontour-windows') ||
      runner.labels.includes(HEAVY_HOST_LABEL) ||
      hasCapacityStep)
  )
    findings.push(...physicalHostCapacityFindings(file, jobId, document, job));
  findings.push(
    ...runnerPartitionFindings(file, jobId, runner.labels, hasCapacityStep),
  );
  if (
    !isFastFeedbackJob(file, jobId) &&
    !skipsAutomaticPullRequest(job?.if) &&
    !(
      file === '.github/workflows/ci.yml' &&
      skipsAutomaticPullRequestTarget(job?.if)
    )
  )
    findings.unshift({
      file,
      jobId,
      message:
        'persistent self-hosted jobs must skip automatic pull_request execution',
    });
  return findings;
}

function skipsAutomaticPullRequest(condition) {
  if (typeof condition !== 'string') return false;
  const expression = condition
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
    .trim();
  const exclusion = "github.event_name != 'pull_request'";
  return (
    expression === exclusion ||
    expression.startsWith(`${exclusion} && `) ||
    expression === `always() && ${exclusion}` ||
    expression.startsWith(`always() && ${exclusion} && `) ||
    expression === `always() && !cancelled() && ${exclusion}` ||
    expression.startsWith(`always() && !cancelled() && ${exclusion} && `)
  );
}

export function persistentRunnerPolicyFindings(workflows) {
  const findings = [];
  for (const { file, document } of workflows) {
    for (const [jobId, job] of Object.entries(document?.jobs ?? {})) {
      if (typeof job?.uses === 'string') {
        findings.push(...reusableWorkflowPolicyFindings(file, jobId, job));
        continue;
      }
      findings.push(...persistentJobPolicyFindings(file, jobId, document, job));
    }
    findings.push(...candidatePullRequestWorkflowFindings(file, document));
    findings.push(...primaryCiRouterFindings(file, document));
    findings.push(...fullRegressionActionlintFindings(file, document));
    findings.push(...baseControlledPrWorkflowFindings(file, document));
    findings.push(...mergeQueueWorkflowFindings(file, document));
  }
  return findings;
}

function stepsUseAction(steps, action) {
  return (steps ?? []).some(
    (step) => typeof step?.uses === 'string' && step.uses.startsWith(action),
  );
}

function containsSecretReference(value) {
  if (typeof value === 'string') return /\bsecrets\b/i.test(value);
  if (Array.isArray(value)) return value.some(containsSecretReference);
  if (value && typeof value === 'object')
    return Object.entries(value).some(
      ([key, candidate]) =>
        /\bsecrets\b/i.test(key) || containsSecretReference(candidate),
    );
  return false;
}

function hasOnlyReadContentsPermission(permissions) {
  return (
    permissions &&
    typeof permissions === 'object' &&
    !Array.isArray(permissions) &&
    Object.keys(permissions).length === 1 &&
    permissions.contents === 'read'
  );
}

function forkSmokeIsolationFindings(file, job) {
  const findings = [];
  if (job.if !== FORK_SMOKE_CONDITION)
    findings.push({
      file,
      jobId: FORK_SMOKE_JOB.jobId,
      message:
        'fork-smoke must use the exact fork-only pull_request_target guard',
    });
  if (job?.['runs-on'] !== 'ubuntu-22.04')
    findings.push({
      file,
      jobId: FORK_SMOKE_JOB.jobId,
      message: 'fork-smoke must run only on ubuntu-22.04',
    });
  if (!hasOnlyReadContentsPermission(job.permissions))
    findings.push({
      file,
      jobId: FORK_SMOKE_JOB.jobId,
      message: 'fork-smoke must declare only permissions: { contents: read }',
    });
  if (containsSecretReference(job))
    findings.push({
      file,
      jobId: FORK_SMOKE_JOB.jobId,
      message: 'fork-smoke must not reference secrets',
    });
  if (
    stepsUseAction(job.steps, 'actions/cache@') ||
    (job.steps ?? []).some(
      (step) =>
        typeof step?.uses === 'string' &&
        step.uses.startsWith('actions/setup-node@') &&
        step?.with?.cache,
    )
  )
    findings.push({
      file,
      jobId: FORK_SMOKE_JOB.jobId,
      message: 'fork-smoke must not use shared or trusted caches',
    });
  if (
    stepsUseAction(job.steps, 'actions/upload-artifact@') ||
    stepsUseAction(job.steps, 'actions/download-artifact@')
  )
    findings.push({
      file,
      jobId: FORK_SMOKE_JOB.jobId,
      message: 'fork-smoke must not use shared artifact namespaces',
    });
  if (
    checkoutSteps(job).length === 0 ||
    checkoutSteps(job).some(
      (checkout) => checkout?.with?.['persist-credentials'] !== false,
    )
  )
    findings.push({
      file,
      jobId: FORK_SMOKE_JOB.jobId,
      message: 'fork-smoke checkout must set persist-credentials: false',
    });
  return findings;
}

function checkoutSteps(job) {
  return (job?.steps ?? []).filter(
    (step) =>
      typeof step?.uses === 'string' &&
      step.uses.startsWith('actions/checkout@'),
  );
}

function hasExplicitCheckout(job, repository, ref) {
  const checkouts = checkoutSteps(job);
  return (
    checkouts.length === 1 &&
    checkouts.every(
      (checkout) =>
        checkout?.with?.['persist-credentials'] === false &&
        checkout.with.repository === repository &&
        checkout.with.ref === ref,
    )
  );
}

function hasExactPullRequestTitleGateTopology(
  job,
  candidateRepository,
  candidateRef,
  titleGateIf,
) {
  const steps = job?.steps ?? [];
  const checkouts = checkoutSteps(job);
  if (checkouts.length !== 2) return false;
  const [baseCheckout, candidateCheckout] = checkouts;
  const baseIndex = steps.indexOf(baseCheckout);
  const candidateIndex = steps.indexOf(candidateCheckout);
  const titleIndex = steps.findIndex(
    (step) => step?.name === PR_TITLE_GATE_NAME,
  );
  const titleGate = steps[titleIndex];
  const titleGateKeys =
    titleGateIf === undefined
      ? ['env', 'name', 'run']
      : ['env', 'if', 'name', 'run'];
  return (
    baseCheckout?.uses === CHECKOUT_ACTION &&
    baseCheckout?.name === PR_TITLE_BASE_CHECKOUT_NAME &&
    baseCheckout?.if === titleGateIf &&
    baseCheckout?.with?.['fetch-depth'] === 1 &&
    baseCheckout?.with?.['persist-credentials'] === false &&
    baseCheckout.with.repository === PR_TITLE_BASE_CHECKOUT_REPOSITORY &&
    baseCheckout.with.ref === PR_TITLE_BASE_CHECKOUT_REF &&
    candidateCheckout?.uses === CHECKOUT_ACTION &&
    candidateCheckout?.with?.['fetch-depth'] === 0 &&
    candidateCheckout?.with?.['persist-credentials'] === false &&
    candidateCheckout.with.repository === candidateRepository &&
    candidateCheckout.with.ref === candidateRef &&
    titleGate?.if === titleGateIf &&
    titleGate?.run === PR_TITLE_GATE_RUN &&
    JSON.stringify(titleGate?.env) === JSON.stringify(PR_TITLE_GATE_ENV) &&
    Object.keys(titleGate ?? {}).length === titleGateKeys.length &&
    titleGateKeys.every((key) => key in titleGate) &&
    baseIndex >= 0 &&
    titleIndex > baseIndex &&
    candidateIndex > titleIndex
  );
}

function hasExactKeys(value, expected) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function hasExactSecurityAnalysisSteps(job) {
  const [base, setupNode, isolateBasePolicy, candidate, init, analyze, policy] =
    job?.steps ?? [];
  return (
    hasExactKeys(job, ['name', 'runs-on', 'timeout-minutes', 'steps']) &&
    job?.name === 'CodeQL JavaScript and TypeScript' &&
    job?.['runs-on'] === 'ubuntu-22.04' &&
    job?.['timeout-minutes'] === SECURITY_ANALYSIS_TIMEOUT_MINUTES &&
    (job?.steps?.length ?? 0) === 7 &&
    hasExactKeys(base, ['name', 'uses', 'with']) &&
    base?.name === 'Check out base policy' &&
    base?.uses === CHECKOUT_ACTION &&
    hasExactKeys(base?.with, [
      'fetch-depth',
      'persist-credentials',
      'repository',
      'ref',
      'path',
    ]) &&
    base.with?.['fetch-depth'] === 1 &&
    base.with?.['persist-credentials'] === false &&
    base.with.repository === SECURITY_BASE_CHECKOUT_REPOSITORY &&
    base.with.ref === SECURITY_BASE_CHECKOUT_REF &&
    base.with.path === SECURITY_BASE_CHECKOUT_PATH &&
    hasExactKeys(setupNode, ['uses', 'with']) &&
    setupNode?.uses === SETUP_NODE_ACTION &&
    hasExactKeys(setupNode?.with, ['node-version-file']) &&
    setupNode.with?.['node-version-file'] === 'base-policy/.nvmrc' &&
    hasExactKeys(isolateBasePolicy, ['name', 'env', 'run']) &&
    isolateBasePolicy?.name === 'Isolate base policy outside candidate scan' &&
    hasExactKeys(isolateBasePolicy?.env, ['BASE_POLICY_DIRECTORY']) &&
    isolateBasePolicy.env?.BASE_POLICY_DIRECTORY ===
      SECURITY_BASE_POLICY_DIRECTORY &&
    isolateBasePolicy.run === SECURITY_ISOLATE_BASE_POLICY_RUN &&
    hasExactKeys(candidate, ['name', 'uses', 'with']) &&
    candidate?.name === 'Check out candidate' &&
    candidate?.uses === CHECKOUT_ACTION &&
    hasExactKeys(candidate?.with, [
      'fetch-depth',
      'persist-credentials',
      'repository',
      'ref',
      'path',
    ]) &&
    candidate.with?.['fetch-depth'] === 1 &&
    candidate.with?.['persist-credentials'] === false &&
    candidate.with.repository === FAST_CHECKOUT_REPOSITORY &&
    candidate.with.ref === FAST_CHECKOUT_REF &&
    candidate.with.path === SECURITY_CANDIDATE_CHECKOUT_PATH &&
    hasExactKeys(init, ['name', 'uses', 'with']) &&
    init?.name === 'Initialize CodeQL' &&
    init?.uses === CODEQL_INIT_ACTION &&
    hasExactKeys(init?.with, [
      'languages',
      'build-mode',
      'queries',
      'source-root',
    ]) &&
    init.with?.languages === 'javascript-typescript' &&
    init.with?.['build-mode'] === 'none' &&
    init.with?.queries === 'security-extended' &&
    init.with?.['source-root'] === SECURITY_CANDIDATE_CHECKOUT_PATH &&
    hasExactKeys(analyze, ['id', 'name', 'uses', 'with']) &&
    analyze?.id === 'analyze' &&
    analyze?.name === 'Analyze without ingestion' &&
    analyze?.uses === CODEQL_ANALYZE_ACTION &&
    hasExactKeys(analyze?.with, [
      'category',
      'checkout_path',
      'output',
      'upload',
      'upload-database',
    ]) &&
    analyze.with?.category === '/language:javascript-typescript' &&
    analyze.with?.checkout_path === SECURITY_CANDIDATE_CHECKOUT_PATH &&
    analyze.with?.output === SECURITY_SARIF_OUTPUT &&
    analyze.with?.upload === 'never' &&
    analyze.with?.['upload-database'] === false &&
    hasExactKeys(policy, ['name', 'env', 'run']) &&
    policy?.name === 'Normalize and enforce JavaScript SARIF policy' &&
    hasExactKeys(policy?.env, [
      'CODEQL_SARIF_DIRECTORY',
      'CODEQL_NORMALIZED_SARIF',
      'BASE_POLICY_DIRECTORY',
    ]) &&
    policy.env?.CODEQL_SARIF_DIRECTORY === SECURITY_SARIF_OUTPUT &&
    policy.env?.CODEQL_NORMALIZED_SARIF === SECURITY_NORMALIZED_SARIF &&
    policy.env?.BASE_POLICY_DIRECTORY === SECURITY_BASE_POLICY_DIRECTORY &&
    policy.run?.trim() === SECURITY_POLICY_RUN
  );
}

function hasExactDependencyReviewSteps(job) {
  const [pullRequestReview, mergeGroupReview] = job?.steps ?? [];
  const sharedInputs = {
    'vulnerability-check': true,
    'fail-on-severity': 'high',
    'license-check': false,
    'warn-only': false,
    'comment-summary-in-pr': 'never',
  };
  return (
    hasExactKeys(job, ['name', 'if', 'runs-on', 'permissions', 'steps']) &&
    job?.name === 'Dependency review' &&
    job?.if === DEPENDENCY_REVIEW_CANDIDATE_GUARD &&
    job?.['runs-on'] === 'ubuntu-22.04' &&
    hasExactKeys(job?.permissions, ['contents']) &&
    job.permissions.contents === 'read' &&
    (job?.steps?.length ?? 0) === 2 &&
    hasExactKeys(pullRequestReview, ['name', 'if', 'uses', 'with']) &&
    pullRequestReview?.name === 'Review dependency changes' &&
    pullRequestReview?.if === DEPENDENCY_REVIEW_PR_GUARD &&
    pullRequestReview?.uses === DEPENDENCY_REVIEW_ACTION &&
    hasExactKeys(pullRequestReview?.with, [
      'vulnerability-check',
      'fail-on-severity',
      'license-check',
      'warn-only',
      'comment-summary-in-pr',
    ]) &&
    JSON.stringify(pullRequestReview.with) === JSON.stringify(sharedInputs) &&
    hasExactKeys(mergeGroupReview, ['name', 'if', 'uses', 'with']) &&
    mergeGroupReview?.name === 'Review merge-group dependency changes' &&
    mergeGroupReview?.if === DEPENDENCY_REVIEW_MERGE_GROUP_GUARD &&
    mergeGroupReview?.uses === DEPENDENCY_REVIEW_ACTION &&
    hasExactKeys(mergeGroupReview?.with, [
      'base-ref',
      'head-ref',
      'vulnerability-check',
      'fail-on-severity',
      'license-check',
      'warn-only',
      'comment-summary-in-pr',
    ]) &&
    mergeGroupReview.with?.['base-ref'] ===
      `\${{ github.event.merge_group.base_sha }}` &&
    mergeGroupReview.with?.['head-ref'] ===
      `\${{ github.event.merge_group.head_sha }}` &&
    JSON.stringify({
      'vulnerability-check': mergeGroupReview.with?.['vulnerability-check'],
      'fail-on-severity': mergeGroupReview.with?.['fail-on-severity'],
      'license-check': mergeGroupReview.with?.['license-check'],
      'warn-only': mergeGroupReview.with?.['warn-only'],
      'comment-summary-in-pr': mergeGroupReview.with?.['comment-summary-in-pr'],
    }) === JSON.stringify(sharedInputs)
  );
}

function securityAnalysisTopologyFindings(file, jobs) {
  const findings = [];
  const expectedJobs = new Set([
    SECURITY_ANALYSIS_CODEQL_JOB,
    DEPENDENCY_REVIEW_JOB,
  ]);
  for (const jobId of expectedJobs) {
    if (!Object.hasOwn(jobs, jobId))
      findings.push({
        file,
        jobId,
        message: 'security-analysis is missing a reviewed job',
      });
  }
  for (const jobId of Object.keys(jobs)) {
    if (!expectedJobs.has(jobId))
      findings.push({
        file,
        jobId,
        message: 'security-analysis must not add unreviewed jobs',
      });
  }
  return findings;
}

function unapprovedActionFindings(file, jobId, job, allowedPrefixes) {
  return (job?.steps ?? [])
    .filter(
      (step) =>
        typeof step?.uses === 'string' &&
        !allowedPrefixes.some((prefix) => step.uses.startsWith(prefix)),
    )
    .map(() => ({
      file,
      jobId,
      message:
        'pull_request_target router jobs must not add unreviewed custom actions',
    }));
}

function unapprovedShellFindings(file, jobId, job, allowedRuns) {
  return (job?.steps ?? [])
    .filter(
      (step) =>
        typeof step?.run === 'string' &&
        !allowedRuns.some(
          ({ name, run }) => step.name === name && step.run === run,
        ),
    )
    .map(() => ({
      file,
      jobId,
      message:
        'pull_request_target router jobs must not add unreviewed shell execution',
    }));
}

function hasPinnedActionlintProvision(job, smokeStepName) {
  const steps = job?.steps ?? [];
  const provisionIndex = steps.findIndex(
    (step) => step?.name === 'Install pinned actionlint',
  );
  const smokeIndex = steps.findIndex((step) => step?.name === smokeStepName);
  const npmCiIndex = steps.findIndex(
    (step) => step?.run === 'npm run dependencies:ci',
  );
  const provision = steps[provisionIndex];
  return (
    provisionIndex >= 0 &&
    npmCiIndex > provisionIndex &&
    smokeIndex > provisionIndex &&
    provision?.env?.ACTIONLINT_ARCHIVE === ACTIONLINT_ARCHIVE &&
    provision?.env?.ACTIONLINT_SHA256 === ACTIONLINT_SHA256 &&
    provision?.run === PINNED_ACTIONLINT_PROVISION_RUN
  );
}

function workflowHasTrigger(document, trigger) {
  const triggers = document?.on;
  return (
    triggers === trigger ||
    (Array.isArray(triggers) && triggers.includes(trigger)) ||
    (triggers &&
      typeof triggers === 'object' &&
      Object.hasOwn(triggers, trigger))
  );
}

function hasExactSecurityAnalysisPrTargetTrigger(document) {
  const trigger = document?.on?.[PULL_REQUEST_TARGET];
  return (
    trigger &&
    typeof trigger === 'object' &&
    !Array.isArray(trigger) &&
    Object.keys(trigger).length === 1 &&
    Array.isArray(trigger.branches) &&
    trigger.branches.length === 1 &&
    trigger.branches[0] === 'main'
  );
}

function hasExactMergeGroupTrigger(document) {
  const trigger = document?.on?.[MERGE_GROUP];
  return (
    trigger &&
    typeof trigger === 'object' &&
    !Array.isArray(trigger) &&
    Object.keys(trigger).length === 2 &&
    Array.isArray(trigger.branches) &&
    trigger.branches.length === 1 &&
    trigger.branches[0] === 'main' &&
    Array.isArray(trigger.types) &&
    JSON.stringify(trigger.types) === JSON.stringify(MERGE_GROUP_TYPES)
  );
}

function hasExactMainBranchTrigger(trigger) {
  return (
    trigger &&
    typeof trigger === 'object' &&
    !Array.isArray(trigger) &&
    Object.keys(trigger).length === 1 &&
    Array.isArray(trigger.branches) &&
    trigger.branches.length === 1 &&
    trigger.branches[0] === 'main'
  );
}

function hasExactPullRequestSecretScanWorkflow(file, document) {
  const scan = document?.jobs?.scan;
  return (
    file === SECRET_SCAN_WORKFLOW &&
    hasExactKeys(document, [
      'name',
      'on',
      'permissions',
      'concurrency',
      'jobs',
    ]) &&
    document.name === 'Secret Scan' &&
    hasExactKeys(document.on, ['push', 'pull_request', 'workflow_dispatch']) &&
    hasExactMainBranchTrigger(document.on.push) &&
    hasExactMainBranchTrigger(document.on.pull_request) &&
    document.on.workflow_dispatch === null &&
    hasOnlyReadContentsPermission(document.permissions) &&
    hasExactKeys(document.concurrency, ['group', 'cancel-in-progress']) &&
    document.concurrency.group ===
      'station-secret-scan-$' + '{{ github.ref }}' &&
    document.concurrency['cancel-in-progress'] === true &&
    hasExactKeys(document.jobs, ['scan']) &&
    hasExactKeys(scan, ['name', 'uses', 'with', 'permissions']) &&
    scan.name === 'Secret Scan' &&
    scan.uses === SECRET_SCAN_REUSABLE_WORKFLOW &&
    hasExactKeys(scan.with, ['runner']) &&
    scan.with.runner === '"ubuntu-22.04"' &&
    hasOnlyReadContentsPermission(scan.permissions)
  );
}

function hasExactSecurityAnalysisWorkflow(document) {
  return (
    hasExactKeys(document, [
      'name',
      'on',
      'permissions',
      'concurrency',
      'jobs',
    ]) &&
    document?.name === 'Security analysis' &&
    hasExactKeys(document?.on, [
      'push',
      PULL_REQUEST_TARGET,
      MERGE_GROUP,
      'workflow_dispatch',
    ]) &&
    hasExactMainBranchTrigger(document.on.push) &&
    hasExactSecurityAnalysisPrTargetTrigger(document) &&
    hasExactMergeGroupTrigger(document) &&
    document.on.workflow_dispatch === null &&
    hasExactKeys(document.permissions, ['contents']) &&
    document.permissions.contents === 'read' &&
    hasExactKeys(document.concurrency, ['group', 'cancel-in-progress']) &&
    document.concurrency.group === SECURITY_ANALYSIS_CONCURRENCY_GROUP &&
    document.concurrency['cancel-in-progress'] === true
  );
}

function mergeQueueWorkflowFindings(file, document) {
  if (!MERGE_QUEUE_WORKFLOWS.has(file)) return [];
  // Synthetic runner-policy fixtures intentionally omit the workflow trigger
  // surface. Enforce this contract only on a candidate-routing document; the
  // real workflow corpus and trigger-deletion mutations all retain
  // pull_request_target and therefore remain covered.
  if (
    !workflowHasTrigger(document, PULL_REQUEST_TARGET) &&
    !workflowHasTrigger(document, MERGE_GROUP)
  )
    return [];
  if (hasExactMergeGroupTrigger(document)) return [];
  return [
    {
      file,
      jobId: 'workflow',
      message:
        'merge-queue workflow must retain merge_group checks_requested for branches: [main]',
    },
  ];
}

function hasExactCiRouterPrTargetTrigger(document) {
  const trigger = document?.on?.[PULL_REQUEST_TARGET];
  return (
    trigger &&
    typeof trigger === 'object' &&
    !Array.isArray(trigger) &&
    Object.keys(trigger).length === 2 &&
    Array.isArray(trigger.branches) &&
    trigger.branches.length === 1 &&
    trigger.branches[0] === 'main' &&
    Array.isArray(trigger.types) &&
    JSON.stringify(trigger.types) === JSON.stringify(CI_ROUTER_PR_TARGET_TYPES)
  );
}

function candidatePullRequestWorkflowFindings(file, document) {
  if (!workflowHasTrigger(document, 'pull_request')) return [];
  if (hasExactPullRequestSecretScanWorkflow(file, document)) return [];
  return [
    {
      file,
      jobId: 'workflow',
      message:
        'candidate-controlled pull_request workflows are prohibited; use the reviewed pull_request_target topology',
    },
  ];
}

/**
 * `full:regression` runs `gate:workflows`, so the reusable completion workflow
 * must provision actionlint or the gate exits 2 on the binary being absent and
 * the lane fails before it validates anything. That is what failed the v0.1.6
 * tag. Pinning the copy here is what keeps this file's provisioning identical
 * to ci.yml's: without it the two drift on the next actionlint bump, and the
 * only thing tying them together is a comment.
 */
function fullRegressionActionlintFindings(file, document) {
  if (file !== FULL_REGRESSION_WORKFLOW) return [];
  const job = document?.jobs?.[FULL_REGRESSION_JOB_ID];
  if (!job) return [];
  if (hasPinnedActionlintProvision(job, FULL_REGRESSION_COMPLETION_STEP))
    return [];
  return [
    {
      file,
      jobId: FULL_REGRESSION_JOB_ID,
      message:
        'the completion lane must provision pinned and checksummed actionlint before the completion gate, or gate:workflows cannot validate',
    },
  ];
}

function primaryCiRouterFindings(file, document) {
  if (!workflowHasTrigger(document, PULL_REQUEST_TARGET)) {
    if (file !== '.github/workflows/ci.yml' || !hasCiRouterTrigger(document))
      return [];
    return [
      {
        file,
        jobId: 'workflow',
        message:
          'ci.yml must use pull_request_target for the reviewed base-controlled PR router',
      },
    ];
  }
  if (file !== '.github/workflows/ci.yml') return [];

  const findings = [];
  const jobs = document?.jobs ?? {};
  if (!hasOnlyReadContentsPermission(document.permissions))
    findings.push({
      file,
      jobId: 'workflow',
      message:
        'base-controlled PR workflows must declare only permissions: { contents: read }',
    });
  if (!hasExactCiRouterPrTargetTrigger(document))
    findings.push({
      file,
      jobId: 'workflow',
      message:
        'ci.yml pull_request_target must retain main branches and the exact opened/synchronize/reopened/edited title-routing types',
    });
  for (const [jobId, job] of Object.entries(jobs)) {
    if (
      job?.permissions !== undefined &&
      !hasOnlyReadContentsPermission(job.permissions)
    )
      findings.push({
        file,
        jobId,
        message:
          'base-controlled PR job permission overrides must declare only permissions: { contents: read }',
      });
  }
  if (workflowHasTrigger(document, 'pull_request'))
    findings.push({
      file,
      jobId: 'workflow',
      message:
        'ci.yml pull_request_target router must not also use candidate-controlled pull_request',
    });
  for (const jobId of PRIMARY_ROUTER_JOBS) {
    if (!Object.hasOwn(jobs, jobId))
      findings.push({
        file,
        jobId,
        message: 'ci.yml pull_request_target router is missing a reviewed job',
      });
  }
  for (const jobId of Object.keys(jobs)) {
    if (!PRIMARY_ROUTER_JOBS.has(jobId))
      findings.push({
        file,
        jobId,
        message:
          'pull_request_target router must not add unreviewed jobs or reusable workflows',
      });
  }

  const fast = jobs['fast-checks'];
  const fork = jobs['fork-smoke'];
  if (fast) {
    if (!hasExactSameRepositoryFastChecksGuard(file, 'fast-checks', fast.if))
      findings.push({
        file,
        jobId: 'fast-checks',
        message:
          'ci.yml fast-checks must use the exact same-repository pull_request_target guard',
      });
    if (!hasOnlyReadContentsPermission(fast.permissions))
      findings.push({
        file,
        jobId: 'fast-checks',
        message:
          'fast-checks must declare only permissions: { contents: read }',
      });
    if (
      !hasExactPullRequestTitleGateTopology(
        fast,
        FAST_CHECKOUT_REPOSITORY,
        FAST_CHECKOUT_REF,
        PR_TITLE_GATE_IF,
      )
    )
      findings.push({
        file,
        jobId: 'fast-checks',
        message:
          'fast-checks must validate the pull-request title from exact base policy before candidate checkout',
      });
    if (!hasPinnedActionlintProvision(fast, 'Run fast CI lane'))
      findings.push({
        file,
        jobId: 'fast-checks',
        message:
          'fast-checks must provision pinned and checksummed actionlint before fast CI execution',
      });
    findings.push(
      ...unapprovedActionFindings(file, 'fast-checks', fast, [
        'actions/checkout@',
        'actions/setup-node@',
        'actions/upload-artifact@',
        'kontourai/.github/actions/runner-preflight@',
        PHYSICAL_HOST_CAPACITY_ACTION,
      ]),
    );
    findings.push(
      ...unapprovedShellFindings(file, 'fast-checks', fast, [
        { name: PR_TITLE_GATE_NAME, run: PR_TITLE_GATE_RUN },
        { name: undefined, run: 'npm run dependencies:ci' },
        {
          name: 'Install pinned actionlint',
          run: fast.steps?.find(
            (step) => step?.name === 'Install pinned actionlint',
          )?.run,
        },
        { name: 'Dependency advisory floor', run: 'npm run audit:policy' },
        {
          // station#4170: reviewed with its workflow step in the same change.
          // Marginal surface over the already-reviewed lane is nil: the job
          // runs `npm run dependencies:ci` + the candidate's test corpus wholesale; this pins
          // the exact browser-provisioning script (persistent-$HOME
          // convention, #3453; bounded retry, #3517).
          name: 'Install Chromium for changed-set touch-target checks',
          run: 'echo "PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright" >> "$GITHUB_ENV"\nfor attempt in 1 2 3; do\n  echo "Playwright install attempt $attempt"\n  if PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright" timeout 360 npx playwright install chromium; then\n    exit 0\n  fi\n  echo "::warning::Playwright install attempt $attempt timed out or failed; retrying"\n  sleep 15\ndone\necho "::error::Playwright install failed after 3 attempts"\nexit 1\n',
        },
        { name: 'Run fast CI lane', run: 'npm run ci:fast' },
        {
          name: 'Run interactive workspace performance smoke',
          run: 'npm run performance:workspace:smoke',
        },
        {
          name: 'Enforce candidate UI bundle budget',
          run: 'npm run build:connect && npm run build:ui',
        },
      ]),
    );
  }
  if (fork) {
    findings.push(...forkSmokeIsolationFindings(file, fork));
    if (
      !hasExactPullRequestTitleGateTopology(
        fork,
        FORK_CHECKOUT_REPOSITORY,
        FORK_CHECKOUT_REF,
        undefined,
      )
    )
      findings.push({
        file,
        jobId: 'fork-smoke',
        message:
          'fork-smoke must validate the pull-request title from exact base policy before candidate checkout',
      });
    if (!hasPinnedActionlintProvision(fork, 'Run isolated fork smoke'))
      findings.push({
        file,
        jobId: 'fork-smoke',
        message:
          'fork-smoke must provision pinned and checksummed actionlint before smoke execution',
      });
    findings.push(
      ...unapprovedActionFindings(file, 'fork-smoke', fork, [
        'actions/checkout@',
        'actions/setup-node@',
      ]),
    );
    findings.push(
      ...unapprovedShellFindings(file, 'fork-smoke', fork, [
        { name: PR_TITLE_GATE_NAME, run: PR_TITLE_GATE_RUN },
        { name: undefined, run: 'npm run dependencies:ci' },
        {
          name: 'Install pinned actionlint',
          run: fork.steps?.find(
            (step) => step?.name === 'Install pinned actionlint',
          )?.run,
        },
        { name: 'Run isolated fork smoke', run: 'npm run ci:fast' },
      ]),
    );
  }
  for (const jobId of [
    'classify',
    'full-regression',
    'manual-completion-diagnostics',
    'browser-smoke',
  ]) {
    const job = jobs[jobId];
    if (job && job.if !== EXACT_TARGET_SKIP_GUARDS[jobId])
      findings.push({
        file,
        jobId,
        message:
          'persistent ci.yml jobs must use the exact reviewed pull_request_target skip guard',
      });
  }
  return findings;
}

function baseControlledPrWorkflowFindings(file, document) {
  if (file === '.github/workflows/ci.yml') return [];
  if (
    !workflowHasTrigger(document, PULL_REQUEST_TARGET) &&
    file !== SECURITY_ANALYSIS_WORKFLOW
  )
    return [];
  if (!BASE_CONTROLLED_PR_WORKFLOWS.has(file))
    return [
      {
        file,
        jobId: 'workflow',
        message:
          'pull_request_target is reserved for reviewed base-controlled PR workflows',
      },
    ];
  const findings = [];
  if (
    file === SECURITY_ANALYSIS_WORKFLOW &&
    !hasExactSecurityAnalysisWorkflow(document)
  )
    findings.push({
      file,
      jobId: 'workflow',
      message:
        'security-analysis must retain the exact base-controlled workflow shape, triggers, permissions, and concurrency',
    });
  if (
    file === SECURITY_ANALYSIS_WORKFLOW &&
    !hasExactSecurityAnalysisPrTargetTrigger(document)
  )
    findings.push({
      file,
      jobId: 'workflow',
      message:
        'security-analysis pull_request_target must retain exactly branches: [main] with no event filters',
    });
  const workflowWithoutJobs = { ...document, jobs: undefined };
  if (!hasOnlyReadContentsPermission(document.permissions))
    findings.push({
      file,
      jobId: 'workflow',
      message:
        'base-controlled PR workflows must declare only permissions: { contents: read }',
    });
  if (containsSecretReference(workflowWithoutJobs))
    findings.push({
      file,
      jobId: 'workflow',
      message: 'base-controlled PR workflows must not expose secrets',
    });
  const jobs = document?.jobs ?? {};
  if (file === SECURITY_ANALYSIS_WORKFLOW)
    findings.push(...securityAnalysisTopologyFindings(file, jobs));
  for (const [jobId, job] of Object.entries(jobs)) {
    if (
      job?.permissions !== undefined &&
      !hasOnlyReadContentsPermission(job.permissions)
    )
      findings.push({
        file,
        jobId,
        message:
          'base-controlled PR job permission overrides must declare only permissions: { contents: read }',
      });
    const runner = classifyRunner(job);
    if (!runner.hosted)
      findings.push({
        file,
        jobId,
        message:
          'base-controlled PR workflows must run candidate code only on GitHub-hosted runners',
      });
    const hasExactReviewedSteps =
      file === SECURITY_ANALYSIS_WORKFLOW &&
      jobId === SECURITY_ANALYSIS_CODEQL_JOB
        ? hasExactSecurityAnalysisSteps(job)
        : file === SECURITY_ANALYSIS_WORKFLOW && jobId === DEPENDENCY_REVIEW_JOB
          ? hasExactDependencyReviewSteps(job)
          : file === SECURITY_ANALYSIS_WORKFLOW
            ? false
            : hasExplicitCheckout(
                job,
                FAST_CHECKOUT_REPOSITORY,
                FAST_CHECKOUT_REF,
              );
    if (!hasExactReviewedSteps)
      findings.push({
        file,
        jobId,
        message:
          file === SECURITY_ANALYSIS_WORKFLOW &&
          jobId === SECURITY_ANALYSIS_CODEQL_JOB
            ? 'security-analysis must retain the exact base-policy and candidate checkouts, pinned CodeQL actions, and sole base-policy shell'
            : file === SECURITY_ANALYSIS_WORKFLOW &&
                jobId === DEPENDENCY_REVIEW_JOB
              ? 'dependency-review must retain the exact hosted pull_request_target action-only topology'
              : 'base-controlled PR jobs must explicitly check out the pull-request head repository and SHA',
      });
    const jobWithoutSteps = { ...job, steps: undefined };
    if (containsSecretReference(jobWithoutSteps))
      findings.push({
        file,
        jobId,
        message: 'base-controlled PR jobs must not expose secrets',
      });
    for (const step of job.steps ?? []) {
      if (
        containsSecretReference(step) &&
        !isExactReviewedDispatchSecretStep(file, jobId, step)
      )
        findings.push({
          file,
          jobId,
          message: 'base-controlled PR jobs must not expose secrets',
        });
      if (
        typeof step?.uses === 'string' &&
        ![
          'actions/checkout@',
          'actions/setup-node@',
          'dtolnay/rust-toolchain@',
        ].some((prefix) => step.uses.startsWith(prefix)) &&
        !(
          file === '.github/workflows/build-ios.yml' &&
          step.uses.startsWith('actions/upload-artifact@')
        ) &&
        !(
          file === SECURITY_ANALYSIS_WORKFLOW &&
          jobId === SECURITY_ANALYSIS_CODEQL_JOB &&
          step.uses.startsWith('github/codeql-action/')
        ) &&
        !(
          file === SECURITY_ANALYSIS_WORKFLOW &&
          jobId === DEPENDENCY_REVIEW_JOB &&
          step.uses === DEPENDENCY_REVIEW_ACTION
        )
      )
        findings.push({
          file,
          jobId,
          message:
            'base-controlled PR workflows must not add unreviewed custom actions or reusable execution',
        });
      if (
        (typeof step?.uses === 'string' &&
          step.uses.startsWith('actions/cache@')) ||
        (typeof step?.uses === 'string' &&
          step.uses.startsWith('actions/setup-node@') &&
          step?.with?.cache)
      )
        findings.push({
          file,
          jobId,
          message: 'base-controlled PR workflows must not use shared caches',
        });
    }
  }
  return findings;
}

function isExactReviewedDispatchSecretStep(file, jobId, step) {
  return (
    file === '.github/workflows/ecosystem-packaging.yml' &&
    jobId === 'exercise-clean-macos' &&
    step?.name === 'Owner-gated external publish boundary' &&
    step?.if === `\${{ github.event_name == 'workflow_dispatch' }}`
  );
}

function hasCiRouterTrigger(document) {
  return (
    workflowHasTrigger(document, PULL_REQUEST_TARGET) ||
    workflowHasTrigger(document, 'pull_request') ||
    workflowHasTrigger(document, 'push')
  );
}

function skipsAutomaticPullRequestTarget(condition) {
  return (
    Object.values(EXACT_TARGET_SKIP_GUARDS).includes(condition) ||
    condition === `\${{ github.event_name == 'workflow_dispatch' }}`
  );
}

/** Exported so a test can run the policy over the REAL workflow corpus through
 * the same loader the gate uses. Synthetic fixtures cannot catch a stale
 * reviewed-SHA constant, because a fixture written against that constant agrees
 * with whatever it currently says. */
export function readWorkflowDocuments() {
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => ({
      file: `.github/workflows/${file}`,
      document: load(readFileSync(join(WORKFLOW_DIR, file), 'utf8')),
    }));
}

function main() {
  if (!existsSync(WORKFLOW_DIR)) {
    console.error(
      '[actionlint] FAILED — .github/workflows is missing, so workflows were NOT validated.',
    );
    return classifyActionlintEvaluation({
      workflowDirectoryExists: false,
    }).exitCode;
  }

  let runnerPolicyFindings;
  try {
    runnerPolicyFindings = persistentRunnerPolicyFindings(
      readWorkflowDocuments(),
    );
  } catch (error) {
    console.error(
      `[actionlint] FAILED to parse workflows for persistent-runner policy: ${error?.message ?? error}`,
    );
    return 1;
  }
  if (runnerPolicyFindings.length > 0) {
    console.error('[actionlint] persistent-runner policy violation(s):');
    for (const finding of runnerPolicyFindings) {
      console.error(
        `    ${finding.file} job '${finding.jobId}': ${finding.message}`,
      );
    }
    return 1;
  }

  const binary = resolveActionlint();
  if (!binary) {
    console.error(
      '[actionlint] NOT_VERIFIED — actionlint is not installed, so workflow files were NOT validated.\n' +
        '            This is an unchecked surface. Install it to close the gap:\n' +
        '              brew install actionlint   (or see https://github.com/rhysd/actionlint)',
    );
    return classifyActionlintEvaluation({
      workflowDirectoryExists: true,
      binary,
    }).exitCode;
  }

  // No arguments: actionlint discovers `.github/workflows` from the repo root
  // itself. Passing the directory is a USAGE ERROR (exit 3, "is a directory"),
  // not a scan — and the first draft of this gate did exactly that, parsed the
  // resulting error text into zero findings, and reported OK. A gate that
  // never ran its own tool and calls that a pass is the precise failure this
  // gate exists to prevent, so the exit status is now classified rather than
  // assumed.
  //
  //   0 → clean scan
  //   1 → scan ran, findings reported (the normal path here)
  //   anything else → the tool did not scan; FAIL loudly
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(binary, [], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    status = typeof error.status === 'number' ? error.status : -1;
    stdout = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }

  if (status !== 0 && status !== 1) {
    console.error(
      `[actionlint] FAILED to run (exit ${status}) — workflows were NOT validated.\n` +
        `${stdout.trim().slice(0, 500)}`,
    );
    return 1;
  }

  const findings = parseFindings(stdout);
  const evaluation = classifyActionlintEvaluation({
    workflowDirectoryExists: true,
    binary,
    status,
    findings,
  });
  if (evaluation.exitCode !== 0) {
    console.error(
      `[actionlint] FAILED — ${
        evaluation.reason === 'actionlint-output-unparseable'
          ? 'actionlint exited 1 without parseable findings, so its result cannot be trusted'
          : `actionlint did not scan (exit ${status})`
      }.\n${stdout.trim().slice(0, 500)}`,
    );
    return evaluation.exitCode;
  }
  const baseline = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
    : { findings: [] };
  const baselineKeys = baseline.findings ?? [];
  const { unexpected, resolved } = compareToBaseline(findings, baselineKeys);

  if (resolved.length > 0) {
    console.log(
      `[actionlint] ${resolved.length} baselined finding(s) no longer present — ` +
        'remove them from scripts/actionlint-baseline.json to hold the ground:',
    );
    for (const key of resolved) console.log(`    ${key}`);
  }

  if (unexpected.length > 0) {
    console.error(
      `[actionlint] ${unexpected.length} finding(s) not in the baseline:`,
    );
    for (const finding of unexpected) {
      console.error(
        `    ${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`,
      );
    }
    return 1;
  }

  console.log(
    `[actionlint] OK — ${findings.length} finding(s), all baselined ` +
      `(${baselineKeys.length} in baseline).`,
  );
  return 0;
}

if (process.argv[1]?.endsWith('actionlint-gate.mjs')) {
  process.exit(main());
}
