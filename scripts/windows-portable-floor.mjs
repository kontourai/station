#!/usr/bin/env node
/**
 * The Windows portable floor's Vitest run (`npm run test:windows:portable`).
 *
 *   node scripts/windows-portable-floor.mjs <vitest options and files...>
 *
 * Each terminal process suite (`src-server/services/terminal/__tests__/`,
 * `*.process.test.ts` or `*.real.test.ts`) runs in a Vitest invocation of its
 * own, after one invocation for every other file. A forked Vitest worker on
 * the hosted Windows runner has exited without a word at most once in three
 * runs, each time under a different terminal suite (#3994: runs 41973735929
 * and 42017221712); in one invocation that hid the results of every file the
 * dead worker would have run. Every invocation runs whatever the others did,
 * and the floor fails when any one fails, crashes, is signalled or cannot
 * start: isolation keeps each suite's verdict visible, it never retries one.
 */
import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { invokedDirectly } from './lib/module-entry.mjs';

const ISOLATED_SUITE =
  /^src-server\/services\/terminal\/__tests__\/[^/]+\.(?:process|real)\.test\.ts$/;

/**
 * The invocations for one floor run: every file that is not an isolated
 * terminal suite together, then each isolated suite alone, each with the
 * given options.
 */
export function planFloorInvocations(args) {
  const options = args.filter((arg) => arg.startsWith('-'));
  const files = args.filter((arg) => !arg.startsWith('-') && arg !== 'run');
  if (files.length === 0) throw new Error('the floor names no test files');
  const isolated = files.filter((file) => ISOLATED_SUITE.test(file));
  const shared = files.filter((file) => !ISOLATED_SUITE.test(file));
  return [
    ...(shared.length ? [shared] : []),
    ...isolated.map((file) => [file]),
  ].map((group) => ['run', ...group, ...options]);
}

/**
 * Runs every invocation in order and returns each one's outcome; a failure
 * never stops the ones after it.
 */
export function runFloorInvocations(
  invocations,
  { root, spawnSync = defaultSpawnSync, log = console.log },
) {
  const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
  return invocations.map((args) => {
    const files = args.filter((arg) => arg !== 'run' && !arg.startsWith('-'));
    log(`\n[windows-portable-floor] vitest ${files.join(' ')}`);
    const result = spawnSync(process.execPath, [vitest, ...args], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    });
    return {
      files,
      status: result.status ?? null,
      signal: result.signal ?? null,
      error: result.error ? String(result.error.message ?? result.error) : null,
      passed: result.status === 0 && !result.signal && !result.error,
    };
  });
}

/** The summary line for each failed invocation; empty when all passed. */
export function floorFailures(outcomes) {
  return outcomes
    .filter((outcome) => !outcome.passed)
    .map(
      (outcome) =>
        `${outcome.files.join(' ')}: ${
          outcome.error ??
          (outcome.signal
            ? `signal ${outcome.signal}`
            : `exit ${outcome.status}`)
        }`,
    );
}

if (invokedDirectly(import.meta.url)) {
  const root = resolve(import.meta.dirname, '..');
  const outcomes = runFloorInvocations(
    planFloorInvocations(process.argv.slice(2)),
    { root },
  );
  const failures = floorFailures(outcomes);
  if (failures.length) {
    console.error(
      `\n[windows-portable-floor] ${failures.length} of ${outcomes.length} Vitest invocation(s) failed:\n  ${failures.join('\n  ')}`,
    );
    process.exit(1);
  }
  console.log(
    `\n[windows-portable-floor] all ${outcomes.length} Vitest invocation(s) passed`,
  );
}
