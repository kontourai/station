import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
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
 * fallow exits 1 when it finds issues and still writes the baseline, and
 * saving a baseline over a tree with known findings is this script's normal
 * use. So exit 0 or 1 counts as success only when the baseline file was
 * written by this run; any other exit, a signal, or a spawn error fails.
 */
const FINDINGS_EXIT = 1;

function baselineWrittenSince(path, startedAtMs) {
  try {
    // Coarse filesystem timestamps can trail the clock by up to 2s.
    return statSync(path).mtimeMs >= startedAtMs - 2000;
  } catch {
    return false;
  }
}

/**
 * Runs every baseline command and returns the process exit code. The first
 * command that fails stops the run and names itself: a baseline that was not
 * written must not report success.
 */
export function runFallowBaselines({
  invocations = fallowBaselineInvocations(),
  spawn = spawnSync,
  written = baselineWrittenSince,
  now = Date.now,
  report = (message) => console.error(message),
} = {}) {
  for (const { command, args } of invocations) {
    const label = `fallow ${args.slice(1).join(' ')}`;
    const baseline = args[args.indexOf('--save-baseline') + 1];
    const startedAt = now();
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
    if (result.status !== 0 && result.status !== FINDINGS_EXIT) {
      report(`${label}: exited ${result.status}`);
      return 1;
    }
    if (!written(baseline, startedAt)) {
      report(`${label}: exited ${result.status} without writing ${baseline}`);
      return 1;
    }
  }
  return 0;
}

if (invokedDirectly(import.meta.url)) process.exitCode = runFallowBaselines();
