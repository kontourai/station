#!/usr/bin/env node
/**
 * Run every whole-tree source scan (`REPO_SCAN_SUITES`, #2176) through the
 * focused runner. The list lives in the impact manifest so this runner, the
 * `repo-scans` CI job and the classification pin cannot disagree about it.
 *
 * `--list` prints the suites and runs nothing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
export function ensureCliBundle(
  { root = REPO_ROOT, exists = existsSync, build = buildCliBundle } = {},
) {
  if (exists(join(root, CLI_BUNDLE))) return false;
  build(root);
  return true;
}

function buildCliBundle(root) {
  execFileSync(process.execPath, ['esbuild.config.mjs'], {
    cwd: join(root, 'packages', 'cli'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
}

/**
 * @param {{ run?: (args: string[]) => Promise<number>, ensureCli?: () => boolean }} [options]
 * @returns {Promise<number>} the focused runner's exit code, unchanged
 */
export async function runRepoScans(
  { run = runFocusedTests, ensureCli = () => ensureCliBundle() } = {},
) {
  ensureCli();
  return run([...REPO_SCAN_SUITES]);
}

/**
 * True when this module is the process entrypoint. Compared by REAL path:
 * Node resolves a symlinked main module to its target, so `import.meta.url`
 * is the target while `argv[1]` is the link, and a plain comparison would
 * make the CLI exit 0 having run nothing.
 */
export function isEntrypoint(argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  if (process.argv.includes('--list')) {
    process.stdout.write(`${REPO_SCAN_SUITES.join('\n')}\n`);
  } else {
    process.exitCode = await runRepoScans();
  }
}
