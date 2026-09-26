import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { invokedDirectly } from './lib/module-entry.mjs';

/** Each baseline fallow writes: the subcommand and its checked-in file. */
export const FALLOW_BASELINES = Object.freeze([
  ['dead-code', 'fallow-baselines/dead-code.json'],
  ['health', 'fallow-baselines/health.json'],
  ['dupes', 'fallow-baselines/dupes.json'],
]);

/**
 * fallow's JS launcher under the current Node rather than an `npx` shim, which
 * Windows refuses to spawn without a shell (EINVAL, CVE-2024-27980); the form
 * `run-fallow-audit.mjs` uses. The launcher IS `fallow`, so the arguments
 * start at the subcommand, with no package-name token as `npx` needed.
 */
export function fallowBaselineInvocations(
  fallowBin = fileURLToPath(import.meta.resolve('fallow/bin/fallow')),
) {
  return FALLOW_BASELINES.map(([subcommand, baseline]) => ({
    command: process.execPath,
    args: [fallowBin, subcommand, '--save-baseline', baseline],
  }));
}

/**
 * Runs every baseline command and returns the process exit code. A command
 * that does not exit 0 fails the whole run and names itself: a baseline that
 * was not written must not report success.
 */
export function runFallowBaselines({
  invocations = fallowBaselineInvocations(),
  spawn = spawnSync,
  report = (message) => console.error(message),
} = {}) {
  for (const { command, args } of invocations) {
    const label = `fallow ${args.slice(1).join(' ')}`;
    const result = spawn(command, args, {
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.error) {
      report(`${label}: ${result.error.message}`);
      return 1;
    }
    if (result.signal) {
      report(`${label}: terminated by ${result.signal}`);
      return 1;
    }
    if (result.status !== 0) {
      report(`${label}: exited ${result.status}`);
      return 1;
    }
  }
  return 0;
}

if (invokedDirectly(import.meta.url)) process.exitCode = runFallowBaselines();
