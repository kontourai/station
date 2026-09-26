#!/usr/bin/env node
/**
 * Run every whole-tree source scan (`REPO_SCAN_SUITES`, #2176) through the
 * focused runner. The list lives in the impact manifest so this runner, the
 * `repo-scans` CI job and the classification pin cannot disagree about it.
 *
 * `--list` prints the suites and runs nothing.
 */
import { invokedDirectly } from './lib/module-entry.mjs';
import { runFocusedTests } from './run-focused-tests.mjs';
import { REPO_SCAN_SUITES } from './test-impact-manifest.mjs';

/**
 * @param {{ run?: (args: string[]) => Promise<number> }} [options]
 * @returns {Promise<number>} the focused runner's exit code, unchanged
 */
export async function runRepoScans({ run = runFocusedTests } = {}) {
  return run([...REPO_SCAN_SUITES]);
}

if (invokedDirectly(import.meta.url)) {
  if (process.argv.includes('--list')) {
    process.stdout.write(`${REPO_SCAN_SUITES.join('\n')}\n`);
  } else {
    process.exitCode = await runRepoScans();
  }
}
