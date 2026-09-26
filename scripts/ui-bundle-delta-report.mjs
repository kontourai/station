/**
 * Per-change UI entry-bundle delta, reported and never enforced (#1703).
 *
 * The ceiling in `scripts/ui-bundle-budget.json` is a round number with
 * headroom, so it says nothing about who added which bytes: the lane that
 * crosses it pays for growth since the last raise. This report restores the
 * attribution by measuring the entry bundle of the change's merge base and
 * of the candidate, and printing the difference as a step-summary line and a
 * `::notice` annotation on the pull request.
 *
 * It runs as its own non-required CI job (`ui-bundle-delta` in ci.yml), off
 * the critical path of the required `fast-checks`, and exits zero once
 * started (the job's own timeout is the one thing it cannot outrun). The
 * ceiling is enforced by fast-checks' `npm run build:ui` and the merge-queue
 * candidate, not here. Scoping runs first and needs no installed
 * dependencies, so a pull request that touches no UI build input finishes in
 * seconds. A measurement that
 * cannot be taken is reported as a notice that names why — not a silent
 * skip, which would read the same as "no growth", and not a red, which would
 * turn a diagnostic into a gate.
 *
 * The candidate is installed and built in the current checkout; the merge
 * base in its own worktree with its OWN node_modules: `@kontourai/*`
 * workspace packages resolve through node_modules into the tree's
 * `packages/`, so a borrowed node_modules measures a plausible, wrong number
 * (station#2776). Both builds run in observe mode, so an over-ceiling tree
 * still yields a measurement, and both are measured by the same
 * `measureEntryBundle`, so the two numbers share one definition.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedPathsSince, describeMatches } from './lib/change-scope.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { npmInvocation } from './lib/npm-cli.mjs';
import { measureEntryBundle } from './ui-bundle-budget.mjs';

/**
 * Everything the Vite build reads, from `vite.config.ts`: root `src-ui`, the
 * `@shared` alias, and the three workspace packages aliased straight to their
 * TypeScript sources. Manifests and patches are inputs too — a dependency
 * bump changes the bundle without touching a single source file.
 */
export const UI_BUILD_INPUT_PREFIXES = Object.freeze([
  'patches/',
  'src-ui/',
  'src-shared/',
  'packages/sdk/src/',
  'packages/connect/src/',
  'packages/contracts/src/',
]);

const UI_BUILD_INPUT_FILES = Object.freeze([
  'vite.config.ts',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/ui-bundle-budget.mjs',
  'scripts/ui-bundle-budget.json',
]);

/** Does one repo-relative path feed the UI build? */
export function isUiBuildInput(path) {
  const normalized = String(path).replaceAll('\\', '/');
  if (!normalized) return false;
  if (UI_BUILD_INPUT_FILES.includes(normalized)) return true;
  // Trailing slashes are load-bearing: `src-ui/` must not match `src-uix/`.
  return UI_BUILD_INPUT_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

const numberFormat = new Intl.NumberFormat('en-US');

/** `1234` → `+1,234`, `-12` → `-12`, `0` → `+0`. */
export function formatSignedBytes(delta) {
  const sign = delta < 0 ? '-' : '+';
  return `${sign}${numberFormat.format(Math.abs(delta))}`;
}

function describeField(label, baseBytes, candidateBytes) {
  return `${label} ${formatSignedBytes(candidateBytes - baseBytes)} B (${numberFormat.format(baseBytes)} → ${numberFormat.format(candidateBytes)})`;
}

export function formatDeltaLine({ base, candidate, baseSha }) {
  return (
    `UI entry bundle: ${describeField('JS', base.entryJsGzipBytes, candidate.entryJsGzipBytes)}, ` +
    `${describeField('CSS', base.entryCssGzipBytes, candidate.entryCssGzipBytes)} ` +
    `gzip vs merge-base ${baseSha.slice(0, 12)}`
  );
}

export function formatUnmeasuredLine(reason) {
  return `UI entry bundle delta could not be measured: ${reason}`;
}

export function formatSkippedLine(reason) {
  return `UI entry bundle delta not measured: ${reason}`;
}

/** Workflow-command data escaping, so a reason cannot end the annotation. */
function escapeCommandData(text) {
  return text
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

export function noticeAnnotation(line) {
  return `::notice title=UI entry bundle::${escapeCommandData(line)}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Decide and measure. Every dependency is injectable so the outcome shapes
 * are testable without a build; the real ones live in `defaultDeps`.
 * Returns `{ kind: 'delta' | 'skipped' | 'unmeasured', line }` and never
 * throws.
 */
export function runDeltaReport(deps) {
  let baseSha;
  try {
    baseSha = deps.mergeBase(deps.baseRef);
  } catch (error) {
    return {
      kind: 'unmeasured',
      line: formatUnmeasuredLine(
        `no merge base between ${deps.baseRef} and HEAD (${errorMessage(error)})`,
      ),
    };
  }

  let matched;
  try {
    matched = deps.changedPaths(baseSha).filter(isUiBuildInput);
  } catch (error) {
    return {
      kind: 'unmeasured',
      line: formatUnmeasuredLine(
        `could not list the paths this change touches (${errorMessage(error)})`,
      ),
    };
  }
  if (matched.length === 0) {
    return {
      kind: 'skipped',
      line: formatSkippedLine(
        `this change touches no UI build input since merge-base ${baseSha.slice(0, 12)}`,
      ),
    };
  }

  let candidate;
  try {
    candidate = deps.measureCandidate();
  } catch (error) {
    return {
      kind: 'unmeasured',
      line: formatUnmeasuredLine(
        `the candidate could not be built and measured (${errorMessage(error)})`,
      ),
    };
  }

  let base;
  try {
    base = deps.measureBase(baseSha);
  } catch (error) {
    return {
      kind: 'unmeasured',
      line: formatUnmeasuredLine(
        `merge-base ${baseSha.slice(0, 12)} could not be built and measured (${errorMessage(error)})`,
      ),
    };
  }

  return {
    kind: 'delta',
    line: `${formatDeltaLine({ base, candidate, baseSha })}; inputs: ${describeMatches(matched)}`,
  };
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...options,
  }).trim();
}

/**
 * Bounds a hang, not the measured cost (hosted runners: ~48s install, ~19s
 * build per side). Four npm steps at this bound must fit inside the job's
 * 30-minute timeout, so a hang ends in this script's notice rather than in
 * the job being killed red with nothing said.
 */
const STEP_TIMEOUT_MS = 6 * 60 * 1000;

function runNpm(args, cwd, env) {
  const npm = npmInvocation(args);
  const result = spawnSync(npm.command, npm.args, {
    cwd,
    env,
    stdio: 'inherit',
    timeout: STEP_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `\`npm ${args.join(' ')}\` exited ${result.status ?? result.signal}`,
    );
}

/**
 * Built into a `dist-ui-` directory (gitignored) rather than `dist-ui/`, so a
 * local run never replaces the build a dev server or desktop app is serving.
 */
const DELTA_BUILD_DIR = 'dist-ui-delta';

/**
 * Observe mode: an over-ceiling tree must still yield a measurement.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function deltaBuildEnv(env = process.env) {
  return {
    ...env,
    STATION_UI_BUNDLE_BUDGET: 'observe',
    STATION_BUILD_UI_DIR: DELTA_BUILD_DIR,
  };
}

function installBuildAndMeasure(root) {
  const env = deltaBuildEnv();
  runNpm(['run', 'dependencies:ci'], root, env);
  runNpm(['run', '--silent', 'build:ui'], root, env);
  return measureEntryBundle(join(root, DELTA_BUILD_DIR));
}

function measureMergeBase(baseSha) {
  const root = join(
    process.env.RUNNER_TEMP || tmpdir(),
    `station-ui-bundle-base-${baseSha.slice(0, 12)}`,
  );
  // A previous run can leave this exact path registered. Remove only that
  // registration: a repo-wide `git worktree prune` would also drop every
  // sibling registration in a developer's repository.
  try {
    git(['worktree', 'remove', '--force', root]);
  } catch {
    // Not a registered working tree: nothing of ours to clean up.
  }
  rmSync(root, { recursive: true, force: true });
  // --force covers the one case remove cannot: this path still registered
  // after its directory was deleted by hand.
  git(['worktree', 'add', '--force', '--detach', root, baseSha]);
  try {
    return installBuildAndMeasure(root);
  } finally {
    try {
      git(['worktree', 'remove', '--force', root]);
    } catch {
      // Best effort: a leftover worktree on an ephemeral runner is harmless,
      // and this cleanup must not replace the measurement's own outcome.
    }
  }
}

export function defaultDeps(env = process.env) {
  return {
    baseRef: env.STATION_UI_BUNDLE_DELTA_BASE || 'origin/main',
    mergeBase: (ref) => git(['merge-base', ref, 'HEAD']),
    changedPaths: (baseSha) => changedPathsSince(baseSha),
    measureCandidate: () => installBuildAndMeasure(process.cwd()),
    measureBase: measureMergeBase,
  };
}

function report(outcome, env = process.env) {
  console.log(noticeAnnotation(outcome.line));
  if (!env.GITHUB_STEP_SUMMARY) return;
  try {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `### UI entry bundle delta\n\n${outcome.line}\n`,
    );
  } catch (error) {
    console.log(
      noticeAnnotation(
        `UI entry bundle delta could not be written to the step summary: ${errorMessage(error)}`,
      ),
    );
  }
}

if (invokedDirectly(import.meta.url)) {
  let outcome;
  try {
    outcome = runDeltaReport(defaultDeps());
  } catch (error) {
    outcome = {
      kind: 'unmeasured',
      line: formatUnmeasuredLine(errorMessage(error)),
    };
  }
  report(outcome);
  // Reporting only: once started, this step does not fail.
  process.exitCode = 0;
}
