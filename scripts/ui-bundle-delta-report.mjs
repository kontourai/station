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
 * It must never fail the job. Enforcement stays with `npm run build:ui` (the
 * step before this one) and the merge-queue candidate. A measurement that
 * cannot be taken is reported as a notice that names why — not a silent
 * skip, which would read the same as "no growth", and not a red, which would
 * turn a diagnostic into a gate.
 *
 * The merge base is built in its own worktree with its OWN node_modules:
 * `@kontourai/*` workspace packages resolve through node_modules into the
 * tree's `packages/`, so a borrowed node_modules measures a plausible, wrong
 * number (station#2776). Both builds are measured by this file's
 * `measureEntryBundle`, so the two numbers share one definition.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedPathsSince, describeMatches } from './lib/change-scope.mjs';
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
        `the candidate build output could not be read (${errorMessage(error)})`,
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

/** Fifteen minutes is far above the measured cost; it bounds a hang only. */
const STEP_TIMEOUT_MS = 15 * 60 * 1000;

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

function measureMergeBase(baseSha) {
  const root = join(
    process.env.RUNNER_TEMP || tmpdir(),
    `station-ui-bundle-base-${baseSha.slice(0, 12)}`,
  );
  rmSync(root, { recursive: true, force: true });
  git(['worktree', 'add', '--detach', root, baseSha]);
  try {
    const env = { ...process.env, STATION_UI_BUNDLE_BUDGET: 'observe' };
    delete env.STATION_BUILD_UI_DIR;
    runNpm(['run', 'dependencies:ci'], root, env);
    runNpm(['run', '--silent', 'build:ui'], root, env);
    return measureEntryBundle(join(root, 'dist-ui'));
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
  const candidateDir = env.STATION_BUILD_UI_DIR || 'dist-ui';
  return {
    baseRef: env.STATION_UI_BUNDLE_DELTA_BASE || 'origin/main',
    mergeBase: (ref) => git(['merge-base', ref, 'HEAD']),
    changedPaths: (baseSha) => changedPathsSince(baseSha),
    measureCandidate: () => {
      if (!existsSync(join(candidateDir, 'index.html')))
        throw new Error(
          `${candidateDir}/index.html is missing; run npm run build:ui first`,
        );
      return measureEntryBundle(candidateDir);
    },
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

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
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
  // Reporting only: whatever happened above, this step does not fail.
  process.exitCode = 0;
}
