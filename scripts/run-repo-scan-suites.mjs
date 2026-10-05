#!/usr/bin/env node
/**
 * Run every whole-tree source scan (`REPO_SCAN_SUITES`, #2176) through the
 * focused runner. The list lives in the impact manifest so this runner, the
 * `repo-scans` CI job and the classification pin cannot disagree about it.
 *
 * `--list` prints the suites and runs nothing.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { DOCS_FRESHNESS_MODE_ENV } from './lib/documentation-freshness.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { runFocusedTests } from './run-focused-tests.mjs';
import { REPO_SCAN_SUITES } from './test-impact-manifest.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_BUNDLE = join('packages', 'cli', 'dist', 'station.mjs');

/**
 * The publish-surface suite packs the built CLI and asserts the pre-bundled
 * dist ships: a fresh checkout has no dist, so build the exact bundle first
 * (the bundle suite's own esbuild invocation, not npm lifecycle scripts).
 * Present output is left alone. Returns whether a build ran.
 */
export function ensureCliBundle({
  root = REPO_ROOT,
  exists = existsSync,
  build = buildCliBundle,
} = {}) {
  if (exists(join(root, CLI_BUNDLE))) return false;
  build(root);
  return true;
}

function buildCliBundle(root) {
  execFileSyncBounded(process.execPath, ['esbuild.config.mjs'], {
    cwd: join(root, 'packages', 'cli'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
}

/**
 * @param {{ run?: (args: string[]) => Promise<number>, ensureCli?: () => boolean, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<number>} the focused runner's exit code, unchanged
 */
export async function runRepoScans({
  run = runFocusedTests,
  ensureCli = () => ensureCliBundle(),
  env = process.env,
} = {}) {
  ensureCli();
  // #2923: two scan suites also read recorded documentation freshness. The
  // repo-scans job checks out one commit, so it cannot compute the PR's own
  // change scope, and the strict fallback would fail it on staleness other
  // PRs introduced. The required fast-checks lane owns the scoped verdict
  // (docs:truth:gate); here freshness is reported, unless a caller chose.
  env[DOCS_FRESHNESS_MODE_ENV] ||= 'advisory';
  return run([...REPO_SCAN_SUITES]);
}

if (invokedDirectly(import.meta.url)) {
  if (process.argv.includes('--list')) {
    process.stdout.write(`${REPO_SCAN_SUITES.join('\n')}\n`);
  } else {
    process.exitCode = await runRepoScans();
  }
}
