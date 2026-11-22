import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A memory budget for each fallow child (#5111).
 *
 * With two analysis threads, one `fallow audit` against a base whose
 * analysis fallow has not cached peaked at about 5.5 GiB of resident memory
 * on this repository; the same audit with a warm cache, about 2.7 GiB. Uncapped, that memory is charged to
 * whatever cgroup started it, and inside a Station engine scope (9298 MiB) it
 * OOM-killed the engine itself twice.
 *
 * On Linux with a systemd user manager, each fallow child therefore runs in
 * its own transient user scope with `MemoryMax` set to the budget
 * (`STATION_FALLOW_MEMORY_MAX_MIB`, default
 * {@link DEFAULT_FALLOW_MEMORY_MAX_MIB}). The scope sits under the user
 * manager, outside the caller's scope, so the caller is no longer charged for
 * it. `OOMPolicy=continue` lets the kernel kill only the analyzer, so the
 * wrapper inside the scope (`fallow-memory-scope.mjs`) survives to record the
 * scope's `memory.events` and peak, and the caller reports
 * that it needs more than its budget instead of an opaque signal.
 *
 * Elsewhere (macOS, Windows, no user manager) the child runs uncapped with a
 * warning. Hosted CI (`GITHUB_ACTIONS=true`) runs uncapped without one: each
 * runner is a single tenant with no engine to protect, exactly as before.
 *
 * Off CI each child also runs with one analysis thread. With two, `fallow
 * audit --gate new-only` analyses the base snapshot and the head at the same
 * time; with one, one after the other. That halves the cold peak (5.5 to
 * 2.9 GiB measured) for about 1.7 times the wall time, and leaves every
 * report byte-identical apart from its run id. CI keeps two threads.
 */

const FALLOW_MEMORY_MAX_ENV = 'STATION_FALLOW_MEMORY_MAX_MIB';
/** The measured single-thread peak plus headroom; see docs/guides/code-quality.md. */
export const DEFAULT_FALLOW_MEMORY_MAX_MIB = 5120;
/** Analysis threads: one locally, so base and head run in turn; two on CI. */
const LOCAL_FALLOW_THREADS = 1;
const CI_FALLOW_THREADS = 2;
/** Below this, no audit of this repository can finish; refuse it up front. */
const MIN_FALLOW_MEMORY_MAX_MIB = 1024;

const SYSTEMD_RUN = '/usr/bin/systemd-run';
const SCOPE_WRAPPER = fileURLToPath(
  new URL('./fallow-memory-scope.mjs', import.meta.url),
);

/**
 * The budget in MiB: `STATION_FALLOW_MEMORY_MAX_MIB`, else the default.
 * A malformed or impossibly small value is refused, never silently replaced.
 */
function resolveFallowMemoryBudgetMib(env = process.env) {
  const raw = env[FALLOW_MEMORY_MAX_ENV];
  if (raw === undefined || raw === '') return DEFAULT_FALLOW_MEMORY_MAX_MIB;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value))
    throw new Error(
      `${FALLOW_MEMORY_MAX_ENV} must be a whole number of MiB, got ${JSON.stringify(raw)}`,
    );
  if (value < MIN_FALLOW_MEMORY_MAX_MIB)
    throw new Error(
      `code-health gate needs more than ${value} MiB; ${FALLOW_MEMORY_MAX_ENV} must be at least ${MIN_FALLOW_MEMORY_MAX_MIB} (one fallow audit of this repository peaks near 4 GiB without a warm cache)`,
    );
  return value;
}

function scopeProperties(budgetMib) {
  return [
    `--property=MemoryMax=${budgetMib}M`,
    '--property=MemorySwapMax=0',
    // The kernel kills only the analyzer, not the wrapper that reports it.
    '--property=OOMPolicy=continue',
  ];
}

/**
 * Can this host start a memory-capped user scope? Starts a trivial one with
 * the exact properties a real run uses. Returns the systemd version, or null.
 */
function probeUserScope(budgetMib) {
  const version = spawnSync(SYSTEMD_RUN, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  const major = Number(/systemd (\d+)/.exec(version.stdout ?? '')?.[1]);
  if (version.status !== 0 || !Number.isSafeInteger(major)) return null;
  const probe = spawnSync(
    SYSTEMD_RUN,
    [
      '--user',
      '--scope',
      '--quiet',
      '--no-ask-password',
      ...scopeProperties(budgetMib),
      '--',
      'true',
    ],
    { stdio: 'ignore', timeout: 10_000, windowsHide: true },
  );
  return probe.status === 0 ? major : null;
}

/**
 * How a fallow child runs here: `capped` inside a user scope, or `uncapped`
 * with the warning to print (null on hosted CI, which needs none), and with
 * how many analysis threads.
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform,
 *   probe?: (budgetMib: number) => number | null }} [options]
 */
export function planFallowMemoryCap({
  env = process.env,
  platform = process.platform,
  probe = probeUserScope,
} = {}) {
  const budgetMib = resolveFallowMemoryBudgetMib(env);
  if (env.GITHUB_ACTIONS === 'true')
    return {
      kind: 'uncapped',
      budgetMib,
      threads: CI_FALLOW_THREADS,
      warning: null,
    };
  const threads = LOCAL_FALLOW_THREADS;
  const uncapped = (why) => ({
    kind: 'uncapped',
    budgetMib,
    threads,
    warning: `fallow runs without its ${budgetMib} MiB memory budget: ${why}. One audit can peak near 4 GiB, charged to whatever started it.`,
  });
  if (platform !== 'linux')
    return uncapped(`memory-capped scopes need Linux, not ${platform}`);
  const systemdVersion = probe(budgetMib);
  if (systemdVersion === null)
    return uncapped(
      `${SYSTEMD_RUN} could not start a memory-capped user scope`,
    );
  return { kind: 'capped', budgetMib, threads, systemdVersion };
}

/**
 * The command that runs `executable args` under `plan`. A capped plan runs it
 * through the scope wrapper, which writes the scope's `memory.events` and
 * `memory.peak` to `eventsFile` when the analyzer exits.
 * `plan.cgroupDirectory` stands in for the scope's own cgroup (tests only).
 */
export function wrapFallowCommand(plan, executable, args, eventsFile) {
  if (plan.kind !== 'capped') return { executable, args };
  const wrapped = [
    process.execPath,
    SCOPE_WRAPPER,
    eventsFile,
    plan.cgroupDirectory ?? '',
    executable,
    ...args,
  ];
  if (plan.launcher === 'direct')
    return { executable: wrapped[0], args: wrapped.slice(1) };
  return {
    executable: SYSTEMD_RUN,
    args: [
      '--user',
      '--scope',
      '--quiet',
      '--no-ask-password',
      // From systemd 254 a scope expands `$VAR` in its argv; keep it literal.
      ...(plan.systemdVersion >= 254 ? ['--expand-environment=no'] : []),
      ...scopeProperties(plan.budgetMib),
      '--',
      ...wrapped,
    ],
  };
}

/**
 * What the scope wrapper recorded: `{ oomKills, peakMib }`, or null when it
 * recorded nothing (an uncapped run, or a wrapper that was itself killed).
 */
function readFallowMemoryOutcome(eventsFile) {
  let text;
  try {
    text = readFileSync(eventsFile, 'utf8');
  } catch {
    return null;
  }
  const field = (name) => {
    const match = new RegExp(`^${name} (\\d+)$`, 'm').exec(text);
    return match ? Number(match[1]) : null;
  };
  const peak = field('peak');
  return {
    oomKills: field('oom_kill') ?? 0,
    peakMib: peak === null ? null : Math.round(peak / 1024 ** 2),
  };
}

/**
 * After a fallow child exits, whatever its status: refuse the run when the
 * kernel OOM-killed it inside its budget, saying what it needs rather than
 * what signal it got (the launcher reports a killed analyzer as status 137,
 * or as exit 1 with no report). Otherwise log the scope's peak, which counts
 * reclaimable file cache and so can sit at the budget without any kill.
 */
export function assertWithinFallowMemoryBudget(command, plan, eventsFile) {
  const memory = readFallowMemoryOutcome(eventsFile);
  if (memory?.oomKills)
    throw new Error(
      `code-health gate needs more than ${plan.budgetMib} MiB; fallow ${command} was OOM-killed at its memory budget. Set ${FALLOW_MEMORY_MAX_ENV} higher on a host with room for it, or leave the gate to CI.`,
    );
  if (memory?.peakMib != null)
    console.error(
      `fallow ${command}: scope memory peak ${memory.peakMib} MiB (file cache included) of a ${plan.budgetMib} MiB budget`,
    );
}
