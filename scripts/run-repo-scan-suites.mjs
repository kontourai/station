#!/usr/bin/env node
/**
 * Run every whole-tree source scan (`REPO_SCAN_SUITES`, #2176) through the
 * focused runner. The list lives in the impact manifest so this runner, the
 * `repo-scans` CI job and the classification pin cannot disagree about it.
 *
 * `--list` prints the suites and runs nothing.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runFocusedTests } from './run-focused-tests.mjs';
import { REPO_SCAN_SUITES } from './test-impact-manifest.mjs';

/**
 * @param {{ run?: (args: string[]) => Promise<number> }} [options]
 * @returns {Promise<number>} the focused runner's exit code, unchanged
 */
export async function runRepoScans({ run = runFocusedTests } = {}) {
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
