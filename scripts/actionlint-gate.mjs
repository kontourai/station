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
import { collectRequiredBrowserSmokeFindings } from './ci-workflow-governance.mjs';

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
/**
 * The Android toolchain revisions, declared once.
 *
 * Both were written out per workflow, and that is not a style question here:
 * three lanes build Android from three separate definitions (build-android.yml
 * verifies main, nightly-native-stage.yml ships to Play, release.yml ships a
 * tag), so a value restated per lane can be right in the lane you are reading
 * and wrong in the lane that ships. That is not hypothetical — #1795 put a
 * bare `aapt` in build-android.yml while nightly-native-stage.yml resolved it
 * correctly, so `main` was red for a day while nightly builds kept shipping,
 * and neither lane's state told you anything about the other's.
 *
 * Workflows cannot import these, so the guarantee is a contract test reading
 * them from here rather than restating them. Change the value once; the test
 * names every workflow that has not followed.
 */
export const ANDROID_NDK_VERSION = '27.0.12077973';
export const ANDROID_BUILD_TOOLS_VERSION = '36.0.0';

const NIGHTLY_JOB_ENV = Object.freeze({
  GCP_PLAY_WORKLOAD_IDENTITY_PROVIDER:
    '${' + '{ vars.GCP_PLAY_WORKLOAD_IDENTITY_PROVIDER }}',
  GCP_PLAY_SERVICE_ACCOUNT: '${' + '{ vars.GCP_PLAY_SERVICE_ACCOUNT }}',
  ANDROID_UPLOAD_KEY_ALIAS: '${' + '{ vars.ANDROID_UPLOAD_KEY_ALIAS }}',
  ANDROID_UPLOAD_CERT_SHA256: '${' + '{ vars.ANDROID_UPLOAD_CERT_SHA256 }}',
  ANDROID_BUILD_TOOLS_VERSION,
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
/** The reviewed revision of the org's reusable capacity workflow.
 *
 * Exported so fixtures stop restating it. Until #1337's pin bump these tests
 * spelled the value as a raw literal that happened to equal the secret-scan
 * pin, and the two were indistinguishable in the fixture text: replacing what
 * looked like a secret-scan string broke four capacity assertions. Different
 * files, different reviews, and now different values. */
export const REVIEWED_REUSABLE_CAPACITY_WORKFLOW_SHA =
  '02f40a67901a79ce4004c44d91e350b93782644c';
/** A reusable-workflow reference pinned at the reviewed capacity revision.
 * Exported for the fixtures above; the path is incidental, the pin is not. */
export const REVIEWED_CAPACITY_REUSABLE_WORKFLOW_REF = `kontourai/.github/.github/workflows/secret-scan.yml@${REVIEWED_REUSABLE_CAPACITY_WORKFLOW_SHA}`;
/** The reviewed revision of the org's secret-scan reusable workflow.
 *
 * Exported for the reason stated above `REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA`:
 * this value was restated in two test files, so the gate and the suite
 * asserting it could disagree while both stayed green.
 *
 * Bumped to 28deabbf2 to pick up kontourai/.github#43, which adds
 * `--retry-all-errors` to the gitleaks download. A single TLS reset from the
 * release-asset CDN was failing the job before the fixture ran, turning a
 * caller's `main` red from a network blip with nothing to attribute it to
 * (#1337). `--retry` alone does not cover curl exit 35.
 *
 * Note this is deliberately NOT the same value as
 * `REVIEWED_REUSABLE_CAPACITY_WORKFLOW_SHA` any more. They pin different files
 * in the same repository and shared a commit only because that was its HEAD
 * when both were last reviewed; the capacity workflow is unchanged by #43 and
 * stays at its own reviewed revision. */
export const REVIEWED_SECRET_SCAN_REUSABLE_WORKFLOW_SHA =
  '28deabbf24f0ab55911d311df5372d30bea0dba4';
const SECRET_SCAN_WORKFLOW = '.github/workflows/secret-scan.yml';
export const SECRET_SCAN_REUSABLE_WORKFLOW = `kontourai/.github/.github/workflows/secret-scan.yml@${REVIEWED_SECRET_SCAN_REUSABLE_WORKFLOW_SHA}`;
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
// Matches ci.yml's fast-checks fence; raised 45 -> 55 with the fifteen-minute
// ci:fast budget (#2577).
export const FAST_CHECKS_JOB_TIMEOUT_MINUTES = 55;
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
// #2176: the whole-tree source scans run for same-repository pull requests
// only. A fork candidate never reaches it (fork-smoke owns forks).
const REPO_SCANS_CONDITION = `\${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name == github.repository }}`;
const PULL_REQUEST_TARGET = 'pull_request_target';
const MERGE_GROUP = 'merge_group';
const MERGE_GROUP_TYPES = ['checks_requested'];
const CI_ROUTER_PR_TARGET_TYPES = [
  'opened',
  'synchronize',
  'reopened',
  'edited',
];
const UI_BUNDLE_DELTA_JOB = 'ui-bundle-delta';
const UI_BUNDLE_DELTA_CONDITION = `\${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name == github.repository }}`;
const UI_BUNDLE_DELTA_STEP = Object.freeze({
  name: 'Report UI entry bundle delta',
  run: 'node scripts/ui-bundle-delta-report.mjs',
  base: `\${{ github.event.pull_request.base.sha }}`,
});
const UI_BUNDLE_DELTA_CHECKOUT_REPOSITORY = `\${{ github.event.pull_request.head.repo.full_name }}`;
const UI_BUNDLE_DELTA_CHECKOUT_REF = `\${{ github.event.pull_request.head.sha }}`;
const PRIMARY_ROUTER_JOBS = new Set([
  'classify',
  'fast-checks',
  'fork-smoke',
  UI_BUNDLE_DELTA_JOB,
  'full-regression',
  'manual-completion-diagnostics',
  'repo-scans',
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
/**
 * The only CodeQL configuration the scan accepts: test code out, nothing else.
 * Exported so the workflow test and the baseline test share one copy.
 */
export const SECURITY_CODEQL_CONFIG = `paths-ignore:
  - '**/__tests__/**'
  - 'tests/**'
  - '**/*.test.*'
  - '**/*.spec.*'
`;
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
export const WINDOWS_PR_EVIDENCE_UPLOAD_ACTION =
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
const WINDOWS_PR_WORKFLOW = '.github/workflows/windows-pr-verification.yml';
const WINDOWS_PR_JOB = 'windows-pr-portable';
const WINDOWS_PR_EVIDENCE_UPLOAD_NAME =
  'Upload Windows portable verification evidence';
const WINDOWS_PR_EVIDENCE_ARTIFACT_NAME =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
  'windows-portable-verification-${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}';
const WINDOWS_PR_EVIDENCE_PATHS =
  '.kontourai/verification-receipts/\n.kontourai/verification-output/\n';
/**
 * The pinned pnpm bootstrap for `pull_request_target` router jobs.
 *
 * This lived as a bare literal inside `isPinnedPnpmSetup`, where it acted as an
 * allowlist key: a step whose `uses` did not match it exactly was reported as
 * an unreviewed custom action. That is the correct security property — an
 * unreviewed action in a `pull_request_target` job runs beside a write-scoped
 * token — but it also means a Dependabot bump of `pnpm/setup` can never be
 * green, because the bump changes the workflows and nothing updates the pin
 * (#1042, #1725). Reviewing the new SHA is the point; hunting for where it is
 * written down is not. Landing a bump is now one deliberate edit here.
 */
export const PNPM_SETUP_ACTION =
  'pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b';
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
});
const BASE_CONTROLLED_PR_WORKFLOWS = new Set([
  '.github/workflows/build-ios.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/desktop-clean-checkout.yml',
  '.github/workflows/desktop-rust.yml',
  '.github/workflows/ecosystem-packaging.yml',
  '.github/workflows/gallery-pr-check.yml',
  '.github/workflows/install-smoke.yml',
  '.github/workflows/merge-queue-regression.yml',
  '.github/workflows/security-analysis.yml',
  '.github/workflows/windows-pr-verification.yml',
]);
/**
 * The ONLY shared-cache access a pull-request or merge-queue workflow may have:
 * a SHA-pinned restore in a named job. Untrusted candidate code runs in those
 * workflows, so a save there would let a pull request poison an entry that
 * later runs restore. The writer is a trusted main-only warmer
 * (ios-rust-cache-warm.yml). GitHub also issues pull_request_target a
 * read-only cache token by default (changelog 2026-06-26), but a workflow- or
 * job-level `cache-mode` can widen that again, so it is refused outright.
 */
export const REVIEWED_CACHE_RESTORE_ACTION =
  'actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9';
const CACHE_RESTORE_JOBS = Object.freeze({
  '.github/workflows/build-ios.yml': new Set(['build-ios-verification']),
});
const UNTRUSTED_CACHE_TRIGGERS = [
  PULL_REQUEST_TARGET,
  'pull_request',
  MERGE_GROUP,
];
const CACHE_WRITE_MESSAGE =
  'pull-request and merge-queue workflows must not write a shared cache';
const CACHE_MODE_MESSAGE =
  'pull-request and merge-queue workflows must not declare cache-mode';
const CALLEE_CACHE_MODE_MESSAGE =
  'reusable workflows must not declare cache-mode';
const CACHE_RESTORE_MESSAGE =
  'shared-cache restore in a pull-request or merge-queue workflow must be the reviewed pinned actions/cache/restore in a listed job';
const SETUP_NODE_AUTO_CACHE_MESSAGE =
  'setup-node in a pull-request or merge-queue workflow must set package-manager-cache: false';
const CODEQL_TRAP_CACHE_MESSAGE =
  'CodeQL init in a pull-request or merge-queue workflow must turn trap-caching off, at least under pull_request_target';
/**
 * The only TRAP-caching value besides `false` allowed in these workflows.
 * pull_request_target is the one untrusted event whose GITHUB_REF is the base
 * branch, which CodeQL reads as default-branch analysis and so uploads from.
 * Under merge_group and pull_request the ref is a queue or PR ref, and
 * codeql-action (trap-caching.ts at cdf488f) uploads only from the default
 * branch, so there it only restores main's cache.
 */
const CODEQL_TRAP_CACHING_OFF_FOR_PR_TARGET =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
  "${{ github.event_name != 'pull_request_target' }}";
const UNREVIEWED_CACHE_ACTION_MESSAGE =
  'pull-request and merge-queue workflows may only use actions and reusable workflows whose cache behavior is reviewed in UNTRUSTED_ACTION_CACHE_POLICY';
const MISSING_CALLEE_MESSAGE =
  'reusable workflow called from a pull-request or merge-queue job was not found';
/**
 * Every action a pull-request or merge-queue workflow (or a local reusable
 * workflow such a job can reach) may use, keyed by lower-cased owner/repo[/path]
 * because GitHub resolves those case-insensitively. This is an allowlist: an
 * action missing from it is refused until someone checks whether it touches
 * the Actions cache. Each value returns the cache findings for one step; an
 * action whose check returns [] never touches the cache.
 *
 * Reviewed for cache behavior at the pins these workflows use:
 * - checkout, upload-artifact, dependency-review-action, rust-toolchain and
 *   codeql-action/analyze have no cache input and no cache step of their own.
 *   (analyze uploads the TRAP/overlay caches that init configured; see the
 *   init rule below.)
 * - setup-node saves in its post step when `cache:` is set, and v7 defaults
 *   `package-manager-cache: true`, which turns that on by itself when
 *   package.json's packageManager names npm. These jobs check the candidate
 *   out before setup-node, so a pull request could flip it on.
 * - codeql-action/init enables TRAP caching by default on hosted runners and,
 *   under pull_request_target, treats the run as default-branch analysis
 *   (GITHUB_REF is the base branch), so it tries to upload a TRAP cache built
 *   from the candidate: security-analysis run 35824349214 logged "Uploading
 *   TRAP cache ... codeql-trap-1-2.26.4-javascript-<main sha>" and only
 *   GitHub's read-only token stopped it. Overlay caching needs no switch:
 *   init picks restore-only Overlay mode whenever the event payload has a
 *   pull_request (checked before the default branch), saves only in
 *   OverlayBase mode, and merge_group gets neither.
 * - pnpm/setup restores and saves a lockfile-verification log on every run,
 *   independently of its `cache` input, with no opt-out (dist at 703c526: the
 *   post step calls the save unconditionally). That save is NOT safe on its
 *   own merits: the key is the hash of the checked-out (candidate) lockfile,
 *   the pre-upload check only confirms earlier records survived (appended
 *   forged records pass, and a cold key uploads anything), and main's jobs
 *   restore by that same hash once the lockfile merges, so a forged verdict
 *   could skip minimumReleaseAge there. It is allowed only because nothing
 *   at the workflow level could stop it anyway; see the note below.
 *
 * What actually prevents cache writes from these workflows: their jobs run
 * candidate code, which can rewrite later post-step action code under
 * _actions/ and write any key the token permits, so no workflow input or
 * allowlist entry can guarantee the absence of a write. The sole control is
 * GitHub's read-only cache token for pull_request_target (run 35851364104:
 * "Cache save skipped: the effective cache-mode 'read' does not permit
 * writes."). Refusing `cache-mode`, which could widen that token, is
 * therefore the most important rule in untrustedCacheFindings; the rest is
 * defense in depth that keeps reviewed workflows from asking for writes.
 * pnpm/setup is pinned so a bump re-opens this review.
 */
const UNTRUSTED_ACTION_CACHE_POLICY = Object.freeze({
  'actions/checkout': noCacheFindings,
  'actions/upload-artifact': noCacheFindings,
  'actions/dependency-review-action': noCacheFindings,
  'dtolnay/rust-toolchain': noCacheFindings,
  'github/codeql-action/analyze': noCacheFindings,
  'github/codeql-action/init': (step) => [
    ...(isDisabledInput(step?.with?.['trap-caching']) ||
    step?.with?.['trap-caching'] === CODEQL_TRAP_CACHING_OFF_FOR_PR_TARGET
      ? []
      : [CODEQL_TRAP_CACHE_MESSAGE]),
    ...(isUnsetInput(step?.with?.['dependency-caching']) ||
    // 'restore' only reads; codeql-action's CachingKind.Restore never stores.
    ['false', 'none', 'restore'].includes(
      String(step.with['dependency-caching']).trim().toLowerCase(),
    )
      ? []
      : [CACHE_WRITE_MESSAGE]),
  ],
  'actions/setup-node': (step) => [
    ...(isUnsetOrDisabledInput(step?.with?.cache) ? [] : [CACHE_WRITE_MESSAGE]),
    ...(isDisabledInput(step?.with?.['package-manager-cache'])
      ? []
      : [SETUP_NODE_AUTO_CACHE_MESSAGE]),
  ],
  'pnpm/setup': (step) =>
    String(step?.uses).toLowerCase() !== PNPM_SETUP_ACTION.toLowerCase()
      ? [UNREVIEWED_CACHE_ACTION_MESSAGE]
      : isUnsetOrDisabledInput(step?.with?.cache)
        ? []
        : [CACHE_WRITE_MESSAGE],
  // Cache-capable setup actions no untrusted workflow uses today, reviewed so
  // adopting one without its cache switched off is refused as a write rather
  // than as merely unreviewed. setup-go caches by default; the others opt in.
  'actions/setup-go': (step) =>
    isDisabledInput(step?.with?.cache) ? [] : [CACHE_WRITE_MESSAGE],
  'actions/setup-python': (step) =>
    isUnsetOrDisabledInput(step?.with?.cache) ? [] : [CACHE_WRITE_MESSAGE],
  'actions/setup-java': (step) =>
    isUnsetOrDisabledInput(step?.with?.cache) ? [] : [CACHE_WRITE_MESSAGE],
  'actions/setup-dotnet': (step) =>
    isUnsetOrDisabledInput(step?.with?.cache) ? [] : [CACHE_WRITE_MESSAGE],
  'ruby/setup-ruby': (step) =>
    isUnsetOrDisabledInput(step?.with?.['bundler-cache'])
      ? []
      : [CACHE_WRITE_MESSAGE],
  'swatinem/rust-cache': () => [CACHE_WRITE_MESSAGE],
  // actions/cache/* subactions are judged in untrustedStepCacheMessages.
  'actions/cache': () => [CACHE_WRITE_MESSAGE],
});
/**
 * Remote reusable workflows a pull-request or merge-queue job may call. The
 * gate cannot read them offline, so each is reviewed at its pinned SHA:
 * kontourai/.github secret-scan.yml@28deabb uses only actions/checkout, the
 * physical-host-capacity action and run steps (no cache).
 */
const UNTRUSTED_REVIEWED_REMOTE_WORKFLOWS = new Set([
  SECRET_SCAN_REUSABLE_WORKFLOW,
]);
const MERGE_QUEUE_WORKFLOWS = new Set([
  '.github/workflows/build-ios.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/merge-queue-regression.yml',
  '.github/workflows/security-analysis.yml',
  '.github/workflows/windows-pr-verification.yml',
]);
const MERGE_QUEUE_REGRESSION_WORKFLOW =
  '.github/workflows/merge-queue-regression.yml';
/**
 * #2428: the PR gallery check uploads its captures and pixel diffs, which are
 * the only source a PR author may refresh the exact baseline from. The
 * artifact holds what the candidate rendered and nothing the token can reach.
 */
const GALLERY_PR_WORKFLOW = '.github/workflows/gallery-pr-check.yml';
const MERGE_QUEUE_REGRESSION_AGGREGATE_JOB = 'merge-queue-regression';
const MERGE_QUEUE_REGRESSION_AGGREGATE_RUN = `echo "$NEEDS" | jq -r 'to_entries[] | "\\(.key): \\(.value.result)"'
echo "$NEEDS" | jq -e 'length > 0 and (to_entries | all(.value.result == "success"))' > /dev/null
`;

/**
 * The merge-queue regression aggregate reads only its needed jobs' results. It
 * checks out nothing and runs no repository code, so it is the one job in a
 * base-controlled workflow allowed to omit the candidate checkout; any other
 * shape (an action, a second step, a different command) loses the exemption.
 */
function isExactMergeQueueRegressionAggregate(file, jobId, job) {
  const steps = job?.steps ?? [];
  return (
    file === MERGE_QUEUE_REGRESSION_WORKFLOW &&
    jobId === MERGE_QUEUE_REGRESSION_AGGREGATE_JOB &&
    steps.length === 1 &&
    steps[0]?.uses === undefined &&
    hasExactKeys(steps[0]?.env, ['NEEDS']) &&
    steps[0].env.NEEDS === `\${{ toJSON(needs) }}` &&
    steps[0]?.run === MERGE_QUEUE_REGRESSION_AGGREGATE_RUN
  );
}

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

/**
 * station#1648: `playwright install --with-deps` apt-installs system
 * libraries as root. The fleet's runner account has no passwordless sudo, so
 * on a persistent self-hosted runner the flag cannot succeed — it failed
 * three identical times in half a second each in ci-extended, and the job's
 * real work never ran. GitHub-hosted images do have passwordless sudo, which
 * is why this is scoped to persistent runners rather than banned outright.
 *
 * Asserted over the PARSED `run` string, so a block or folded scalar
 * (`run: >-`) cannot hide the flag from it the way a whole-file text scan
 * can. Whole-line shell comments are dropped first: a comment explaining why
 * the flag is absent is inert and must not red a correct tree.
 */
export function refusesWithDepsOnPersistentRunner(run) {
  if (typeof run !== 'string') return true;
  const executable = run
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  return !/--with-deps/.test(executable);
}

function persistentStepPolicyFindings(file, jobId, steps) {
  const findings = [];
  for (const step of steps ?? []) {
    if (!refusesWithDepsOnPersistentRunner(step?.run))
      findings.push({
        file,
        jobId,
        message:
          'persistent self-hosted steps must not pass --with-deps to playwright install: the fleet runner account has no passwordless sudo, so it can only fail. Install the system libraries on the runner image, and use scripts/install-playwright-browsers.mjs here',
      });
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
  const workflowsByFile = new Map(
    workflows.map(({ file, document }) => [file, document]),
  );
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
    findings.push(...untrustedCacheFindings(file, document, workflowsByFile));
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

function isExactWindowsPrEvidenceUpload(file, jobId, step) {
  if (
    file !== WINDOWS_PR_WORKFLOW ||
    jobId !== WINDOWS_PR_JOB ||
    step?.name !== WINDOWS_PR_EVIDENCE_UPLOAD_NAME ||
    step?.if !== 'always()' ||
    step?.uses !== WINDOWS_PR_EVIDENCE_UPLOAD_ACTION
  )
    return false;
  const topLevelKeys = Object.keys(step).sort();
  const withKeys = Object.keys(step.with ?? {}).sort();
  return (
    JSON.stringify(topLevelKeys) ===
      JSON.stringify(['if', 'name', 'uses', 'with']) &&
    JSON.stringify(withKeys) ===
      JSON.stringify([
        'if-no-files-found',
        'include-hidden-files',
        'name',
        'path',
      ]) &&
    step.with.name === WINDOWS_PR_EVIDENCE_ARTIFACT_NAME &&
    step.with.path === WINDOWS_PR_EVIDENCE_PATHS &&
    step.with['include-hidden-files'] === true &&
    step.with['if-no-files-found'] === 'warn'
  );
}

/**
 * #1703: the report-only bundle delta job runs same-repository PR head code
 * (the same trust fast-checks already extends) on a hosted runner with
 * read-only contents and no credentials. It must stay report-only: no
 * continue-on-error hiding a verdict, and exactly one reviewed command.
 */
function uiBundleDeltaJobFindings(file, job) {
  const jobId = UI_BUNDLE_DELTA_JOB;
  const finding = (message) => ({ file, jobId, message });
  const findings = [];
  if (job.if !== UI_BUNDLE_DELTA_CONDITION)
    findings.push(
      finding(
        'ui-bundle-delta must use the exact same-repository pull_request_target guard (no merge_group)',
      ),
    );
  if (!hasOnlyReadContentsPermission(job.permissions))
    findings.push(
      finding(
        'ui-bundle-delta must declare only permissions: { contents: read }',
      ),
    );
  if (job['runs-on'] !== 'ubuntu-22.04')
    findings.push(
      finding('ui-bundle-delta must run on a hosted ubuntu-22.04 image'),
    );
  if (
    typeof job.concurrency?.group !== 'string' ||
    !job.concurrency.group.includes('github.event.pull_request.head.sha')
  )
    findings.push(
      finding(
        'ui-bundle-delta concurrency must key on the pull-request head sha',
      ),
    );
  if (
    job['continue-on-error'] !== undefined ||
    (job.steps ?? []).some((step) => step?.['continue-on-error'] !== undefined)
  )
    findings.push(
      finding(
        'ui-bundle-delta is report-only by exiting zero, never by continue-on-error',
      ),
    );
  const checkouts = checkoutSteps(job);
  const checkout = checkouts[0];
  if (
    checkouts.length !== 1 ||
    checkout?.with?.['persist-credentials'] !== false ||
    checkout?.with?.['fetch-depth'] !== 0
  )
    findings.push(
      finding(
        'ui-bundle-delta must check out once, with full history and persist-credentials: false',
      ),
    );
  if (
    checkout?.with?.repository !== UI_BUNDLE_DELTA_CHECKOUT_REPOSITORY ||
    checkout?.with?.ref !== UI_BUNDLE_DELTA_CHECKOUT_REF
  )
    findings.push(
      finding(
        'ui-bundle-delta must check out exactly the pull-request head repository and sha',
      ),
    );
  const report = (job.steps ?? []).find(
    (step) => step?.name === UI_BUNDLE_DELTA_STEP.name,
  );
  if (report?.env?.STATION_UI_BUNDLE_DELTA_BASE !== UI_BUNDLE_DELTA_STEP.base)
    findings.push(
      finding('ui-bundle-delta must measure against the pull-request base sha'),
    );
  findings.push(
    ...unapprovedActionFindings(file, jobId, job, [
      'actions/checkout@',
      'actions/setup-node@',
    ]),
    ...unapprovedShellFindings(file, jobId, job, [
      { name: UI_BUNDLE_DELTA_STEP.name, run: UI_BUNDLE_DELTA_STEP.run },
    ]),
  );
  return findings;
}

const CI_CREDENTIAL_MESSAGE =
  'ci.yml jobs must not reference secrets, the GitHub token, or the whole github context';

/** Every string value in a parsed workflow node, keys excluded. */
function workflowStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(workflowStrings);
  if (value && typeof value === 'object')
    return Object.values(value).flatMap(workflowStrings);
  return [];
}

/**
 * A `${{ }}` expression that can yield a credential: `secrets.*`, the token
 * by dot or index (`github.token`, `github['token']`), or the whole github
 * context, which contains the token (`toJSON(github)`, any bare `github`
 * that is not immediately dereferenced with `.` or `[`).
 */
export function expressionReadsCredential(expression) {
  return (
    /\bsecrets\b/i.test(expression) ||
    /\bgithub\s*\.\s*token\b/i.test(expression) ||
    /\bgithub\s*\[\s*['"]\s*token\s*['"]\s*\]/i.test(expression) ||
    /(?<![\w./'"-])github(?![\w-]|\s*[.[])/i.test(expression)
  );
}

function referencesCredential(job) {
  return (
    containsSecretReference(job) ||
    workflowStrings(job).some((text) =>
      Array.from(text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)).some(([, body]) =>
        expressionReadsCredential(body),
      ),
    )
  );
}

/**
 * `baseControlledPrWorkflowFindings` exempts ci.yml, so its generic "must not
 * expose secrets" rule never covered this workflow, several of whose jobs run
 * pull-request head code under pull_request_target. No job here needs a
 * credential, so the rule applies to every job rather than guessing which
 * ones run head code.
 */
function ciCredentialFindings(file, jobs) {
  return Object.entries(jobs)
    .filter(([, job]) => referencesCredential(job))
    .map(([jobId]) => ({ file, jobId, message: CI_CREDENTIAL_MESSAGE }));
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
    hasExactKeys(setupNode?.with, [
      'node-version-file',
      'package-manager-cache',
    ]) &&
    setupNode.with?.['node-version-file'] === 'base-policy/.nvmrc' &&
    setupNode.with?.['package-manager-cache'] === false &&
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
      'config',
      'trap-caching',
    ]) &&
    init.with?.['trap-caching'] === CODEQL_TRAP_CACHING_OFF_FOR_PR_TARGET &&
    init.with?.languages === 'javascript-typescript' &&
    init.with?.['build-mode'] === 'none' &&
    init.with?.queries === 'security-extended' &&
    init.with?.['source-root'] === SECURITY_CANDIDATE_CHECKOUT_PATH &&
    init.with?.config === SECURITY_CODEQL_CONFIG &&
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

// This bootstrap installs only the package manager pinned by package.json.
// Keep install explicitly disabled: the action otherwise installs candidate dependencies
// before the reviewed lifecycle entrypoint gets to apply its policy.
function isPinnedPnpmSetup(step) {
  return (
    step?.uses === PNPM_SETUP_ACTION &&
    step?.name === 'Setup pinned pnpm' &&
    Object.keys(step).every(
      (key) => key === 'name' || key === 'uses' || key === 'with',
    ) &&
    Object.keys(step.with ?? {}).join(',') === 'install' &&
    step.with.install === false
  );
}

/**
 * #2176: `repo-scans` runs the candidate's own tests, as fast-checks does,
 * so what it may do is pinned here rather than trusted: the exact
 * same-repository guard, read-only contents, exactly one checkout — the
 * pinned action, fetching exactly the pull request's head from its own
 * repository with no credentials left behind — the pinned setup actions,
 * exactly two commands (the dependency install and `npm run test:repo-scans`)
 * and no `continue-on-error` anywhere, so a failed scan fails the check.
 * It does not review what those commands run; the candidate's tests are
 * candidate code, as in fast-checks.
 */
const REPO_SCANS_CHECKOUT_WITH = Object.freeze({
  'fetch-depth': 1,
  'persist-credentials': false,
  repository: `\${{ github.event.pull_request.head.repo.full_name }}`,
  ref: `\${{ github.event.pull_request.head.sha }}`,
});

function repoScansFindings(file, job) {
  const findings = [];
  const jobId = 'repo-scans';
  if (job.if !== REPO_SCANS_CONDITION)
    findings.push({
      file,
      jobId,
      message:
        'repo-scans must use the exact same-repository pull_request_target guard',
    });
  if (!hasOnlyReadContentsPermission(job.permissions))
    findings.push({
      file,
      jobId,
      message: 'repo-scans must declare only permissions: { contents: read }',
    });
  // A red scan must be a red check: `continue-on-error` on the job or any
  // step would report a failed scan as success.
  if (
    job['continue-on-error'] !== undefined ||
    (job.steps ?? []).some((step) => step?.['continue-on-error'] !== undefined)
  )
    findings.push({
      file,
      jobId,
      message: 'repo-scans must not set continue-on-error on the job or a step',
    });
  // A skipped scan step leaves a green job: the step that runs the scans must
  // be exactly { name, run } — no `if:`, no `env:`, no `working-directory:`.
  const scanSteps = (job.steps ?? []).filter(
    (step) => step?.run === 'npm run test:repo-scans',
  );
  if (
    scanSteps.length !== 1 ||
    JSON.stringify(Object.keys(scanSteps[0]).sort()) !==
      JSON.stringify(['name', 'run'])
  )
    findings.push({
      file,
      jobId,
      message:
        'repo-scans must run npm run test:repo-scans in exactly one unconditional { name, run } step',
    });
  const checkouts = (job.steps ?? []).filter(
    (step) =>
      typeof step?.uses === 'string' &&
      step.uses.startsWith('actions/checkout'),
  );
  const [checkout] = checkouts;
  if (
    checkouts.length !== 1 ||
    checkout.uses !== CHECKOUT_ACTION ||
    JSON.stringify(
      Object.entries(checkout.with ?? {}).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    ) !==
      JSON.stringify(
        Object.entries(REPO_SCANS_CHECKOUT_WITH).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      )
  )
    findings.push({
      file,
      jobId,
      message:
        'repo-scans must check out exactly the pull request head with the pinned checkout action and no credentials',
    });
  findings.push(
    ...unapprovedActionFindings(file, jobId, job, [
      CHECKOUT_ACTION,
      SETUP_NODE_ACTION,
    ]),
    ...unapprovedShellFindings(file, jobId, job, [
      { name: undefined, run: 'npm run dependencies:ci' },
      { name: 'Run repository source scans', run: 'npm run test:repo-scans' },
    ]),
  );
  return findings;
}

function unapprovedActionFindings(file, jobId, job, allowedPrefixes) {
  return (job?.steps ?? [])
    .filter(
      (step) =>
        typeof step?.uses === 'string' &&
        !isPinnedPnpmSetup(step) &&
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

  const findings = collectRequiredBrowserSmokeFindings(document).map(
    (message) => ({ file, jobId: 'fast-checks', message }),
  );
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

  findings.push(...ciCredentialFindings(file, jobs));

  const fast = jobs['fast-checks'];
  const fork = jobs['fork-smoke'];
  const scans = jobs['repo-scans'];
  if (scans) findings.push(...repoScansFindings(file, scans));
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
        // #1540: these exact commands run on the same isolated, read-only
        // candidate runner as ci:fast. No new credentials or host authority.
        {
          name: 'Verify critical browser journeys before merge',
          run: 'npm run test:e2e:pr-smoke',
        },
        {
          name: 'Report contract-test changes for review',
          run: 'node scripts/test-contract-review.mjs',
        },

        {
          name: 'Run interactive workspace performance smoke',
          run: 'npm run performance:workspace:smoke',
        },
        {
          name: 'Enforce candidate UI bundle budget',
          run: 'npm run build:ui',
        },
      ]),
    );
  }
  if (jobs[UI_BUNDLE_DELTA_JOB])
    findings.push(...uiBundleDeltaJobFindings(file, jobs[UI_BUNDLE_DELTA_JOB]));
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
            : isExactMergeQueueRegressionAggregate(file, jobId, job) ||
              hasExplicitCheckout(
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
        !isPinnedPnpmSetup(step) &&
        ![
          'actions/checkout@',
          'actions/setup-node@',
          'dtolnay/rust-toolchain@',
        ].some((prefix) => step.uses.startsWith(prefix)) &&
        !(
          (file === '.github/workflows/build-ios.yml' ||
            file === MERGE_QUEUE_REGRESSION_WORKFLOW ||
            file === GALLERY_PR_WORKFLOW) &&
          step.uses.startsWith('actions/upload-artifact@')
        ) &&
        !isExactWindowsPrEvidenceUpload(file, jobId, step) &&
        !isReviewedCacheRestore(file, jobId, step) &&
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
    }
  }
  return findings;
}

function isReviewedCacheRestore(file, jobId, step) {
  return (
    step?.uses === REVIEWED_CACHE_RESTORE_ACTION &&
    CACHE_RESTORE_JOBS[file]?.has(jobId) === true
  );
}

/**
 * Shared-cache policy for every workflow a pull request or the merge queue can
 * trigger, and for every local reusable workflow such a job can reach.
 * Restores are allowed only through isReviewedCacheRestore; each step must use
 * an action listed in UNTRUSTED_ACTION_CACHE_POLICY and pass its check; and a
 * `cache-mode` key, which could re-grant write access to a low-trust event, is
 * refused in these workflows and in every workflow_call callee. ci.yml is
 * included: it is excluded from baseControlledPrWorkflowFindings, not from
 * this rule.
 */
function untrustedCacheFindings(file, document, workflowsByFile) {
  const findings = [];
  const events = new Set(
    UNTRUSTED_CACHE_TRIGGERS.filter((trigger) =>
      workflowHasTrigger(document, trigger),
    ),
  );
  const isCallee = workflowHasTrigger(document, 'workflow_call');
  if (events.size > 0 || isCallee) {
    const message =
      events.size > 0 ? CACHE_MODE_MESSAGE : CALLEE_CACHE_MODE_MESSAGE;
    if (document && Object.hasOwn(document, 'cache-mode'))
      findings.push({ file, jobId: 'workflow', message });
    for (const [jobId, job] of Object.entries(document?.jobs ?? {}))
      if (job && Object.hasOwn(job, 'cache-mode'))
        findings.push({ file, jobId, message });
  }
  if (events.size === 0) return findings;
  findings.push(
    ...untrustedJobCacheFindings(file, document, events, workflowsByFile, {
      via: '',
      visiting: new Set([file]),
    }),
  );
  return findings;
}

/**
 * Step and call findings for every job of `document`, which runs under one of
 * `events`. Steps are checked in every job regardless of its `if:` (a wrong
 * reachability proof must not weaken the rule for the workflow itself). A
 * local reusable-workflow call is followed unless its `if:` provably excludes
 * every event in `events`; the callee inherits the caller's github.event_name.
 */
function untrustedJobCacheFindings(
  file,
  document,
  events,
  workflowsByFile,
  context,
) {
  const findings = [];
  for (const [ownJobId, job] of Object.entries(document?.jobs ?? {})) {
    const jobId = context.via
      ? `${ownJobId} (called from ${context.via})`
      : ownJobId;
    for (const step of job?.steps ?? [])
      if (typeof step?.uses === 'string')
        for (const message of untrustedStepCacheMessages(file, ownJobId, step))
          findings.push({ file, jobId, message });
    if (typeof job?.uses === 'string')
      findings.push(
        ...untrustedCallCacheFindings(
          file,
          jobId,
          job,
          events,
          workflowsByFile,
          context,
        ),
      );
  }
  return findings;
}

function untrustedCallCacheFindings(
  file,
  jobId,
  job,
  events,
  workflowsByFile,
  { visiting },
) {
  const localCallee = localReusableWorkflowFile(job.uses);
  if (!localCallee)
    return UNTRUSTED_REVIEWED_REMOTE_WORKFLOWS.has(job.uses)
      ? []
      : [{ file, jobId, message: UNREVIEWED_CACHE_ACTION_MESSAGE }];
  const reachable = restrictEventsByCondition(events, job.if);
  if (reachable.size === 0 || visiting.has(localCallee)) return [];
  const callee = workflowsByFile?.get(localCallee);
  if (!callee) return [{ file, jobId, message: MISSING_CALLEE_MESSAGE }];
  return untrustedJobCacheFindings(
    localCallee,
    callee,
    reachable,
    workflowsByFile,
    {
      via: `${file} job '${jobId}'`,
      visiting: new Set([...visiting, localCallee]),
    },
  );
}

function untrustedStepCacheMessages(file, jobId, step) {
  const action = step.uses.split('@')[0].toLowerCase();
  if (action.startsWith('actions/cache/'))
    return isReviewedCacheRestore(file, jobId, step)
      ? []
      : action === 'actions/cache/save'
        ? [CACHE_WRITE_MESSAGE]
        : [CACHE_RESTORE_MESSAGE];
  const policy = Object.hasOwn(UNTRUSTED_ACTION_CACHE_POLICY, action)
    ? UNTRUSTED_ACTION_CACHE_POLICY[action]
    : undefined;
  return policy ? policy(step) : [UNREVIEWED_CACHE_ACTION_MESSAGE];
}

function localReusableWorkflowFile(uses) {
  const match = /^\.\/(\.github\/workflows\/[^@/]+\.ya?ml)$/.exec(uses);
  return match ? match[1] : undefined;
}

/**
 * The subset of `events` under which `condition` can be true, proven only
 * from top-level `github.event_name == 'x'` / `!= 'x'` conjuncts. Anything it
 * cannot read — a top-level `||`, a negation, a template string — is treated
 * as satisfiable, so the result only ever errs toward "reachable". Dropping a
 * conjunct of an `&&` chain can only widen the set, which keeps it sound.
 */
function restrictEventsByCondition(events, condition) {
  if (condition === undefined || condition === null) return new Set(events);
  if (condition === false) return new Set();
  if (typeof condition !== 'string') return new Set(events);
  let expression = condition.trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(expression);
  if (wrapped && !wrapped[1].includes('}}')) expression = wrapped[1].trim();
  else if (expression.includes('${{')) return new Set(events);
  const conjuncts = splitTopLevelConjuncts(expression);
  if (!conjuncts) return new Set(events);
  let reachable = new Set(events);
  for (const conjunct of conjuncts) {
    const inner = /^\(([\s\S]*)\)$/.exec(conjunct);
    if (inner && splitTopLevelConjuncts(inner[1]) !== undefined) {
      reachable = restrictEventsByCondition(reachable, inner[1]);
      continue;
    }
    const comparison = /^github\.event_name\s*(==|!=)\s*'([^']*)'$/i.exec(
      conjunct,
    );
    if (!comparison) continue;
    const value = comparison[2].toLowerCase();
    reachable = new Set(
      [...reachable].filter((event) =>
        comparison[1] === '==' ? event === value : event !== value,
      ),
    );
  }
  return reachable;
}

/**
 * Splits an expression on `&&` outside parentheses and single-quoted strings.
 * Returns undefined when a top-level `||` makes the expression a disjunction,
 * or when its parentheses or quotes do not balance.
 */
function splitTopLevelConjuncts(expression) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (quoted) {
      if (char === "'") {
        if (expression[index + 1] === "'") index += 1;
        else quoted = false;
      }
      continue;
    }
    if (char === "'") quoted = true;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth < 0) return undefined;
    } else if (depth === 0 && expression.startsWith('||', index))
      return undefined;
    else if (depth === 0 && expression.startsWith('&&', index)) {
      parts.push(expression.slice(start, index).trim());
      start = index + 2;
      index += 1;
    }
  }
  if (quoted || depth !== 0) return undefined;
  parts.push(expression.slice(start).trim());
  return parts;
}

function noCacheFindings() {
  return [];
}

function isUnsetInput(value) {
  return value === undefined || value === null || value === '';
}

function isDisabledInput(value) {
  return (
    value === false ||
    (typeof value === 'string' && value.trim().toLowerCase() === 'false')
  );
}

function isUnsetOrDisabledInput(value) {
  return isUnsetInput(value) || isDisabledInput(value);
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
