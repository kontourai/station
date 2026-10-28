import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, constants as fsConstants, readFile } from 'node:fs/promises';
import { availableParallelism, totalmem } from 'node:os';
import type {
  WorkloadBudgetStatus,
  WorkloadHolderUnplacedReason,
} from '@kontourai/station-contracts/system-status';
import {
  type ChildWorkloadLaunch,
  type ChildWorkloadOomKill,
  type ChildWorkloadOutcome,
  closeChildWorkload,
  installChildWorkloadLauncher,
  spawnChildWorkload,
} from '@kontourai/station-shared/child-workload';
import {
  lookupProcessBirthFingerprint,
  lookupProcessBirthFingerprintCached,
  probeExactProcessIdentity,
  probeExactProcessIdentityAsync,
} from '@kontourai/station-shared/process-identity';
import { createLogger } from '../../utils/logger.js';
import {
  type ResolvedWorkloadMemoryBudget,
  readScopeMemory,
  resolveWorkloadMemoryBudget,
  type ScopeMemoryReading,
  WORKLOAD_SESSION_ENV,
  type WorkloadMemorySettings,
  workloadSettingsProblem,
} from './workload-budget.js';
import {
  readWorkloadBudgetSettings,
  writeWorkloadBudgetSettings,
} from './workload-budget-settings.js';

const logger = createLogger({ name: 'workload-resources' });
const MIB = 1024 * 1024;
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);

interface WorkloadLimits {
  memoryMaxBytes: number;
  totalMemoryMaxBytes: number;
  cpuQuotaPercent: number;
  tasksMax: number;
  totalTasksMax: number;
  swapMaxBytes: number;
}

interface ActiveWorkload {
  unit: string;
  /** The Station session an engine launch named; attribution only. */
  sessionId?: string;
  memoryMaxBytes?: number;
  pid?: number;
  birth?: string | null;
  closing?: Promise<void>;
  observed?: (outcome: ChildWorkloadOutcome | undefined) => void;
  /** The scope's cgroup path, resolved once the scope exists. */
  controlGroup?: string;
  /** `oom_kill` count already announced to {@link oomListeners}. */
  oomKillsReported: number;
  /** An engine scope launched with a holder (see holderLaunch). */
  holderLaunched?: boolean;
  /**
   * An engine scope's holder as last seen in the scope's own cgroup.procs:
   * set from the first poll that finds the scope.
   */
  holderState?: 'placed' | 'unplaced';
  /** Why the holder is unplaced, as a short code. */
  holderReason?: WorkloadHolderUnplacedReason;
  /** The holder found in the scope: its pid and kernel start time. */
  holder?: { pid: string; start: string };
  /** Consecutive polls that searched the scope and did not find it. */
  holderMisses?: number;
  /** `oom_kill` count at the last poll; undefined before the first. */
  oomKillsPolled?: number;
  /** A count seen once and not yet announced (see pollOomKills). */
  oomKillsPending?: number;
  /** When a poll first saw the count rise (within the 1 s poll interval). */
  lastOomKillAt?: string;
  oomListeners: Set<(kill: ChildWorkloadOomKill) => void>;
}

let state: 'unmanaged' | 'ready' | 'unavailable' | 'stopping' = 'unmanaged';
let reason: string | undefined;
let limits: WorkloadLimits | undefined;
let slice: string | undefined;
let serviceUnit: string | undefined;
let managerEnv: NodeJS.ProcessEnv;
let budgetSources: ResolvedWorkloadMemoryBudget['sources'] | undefined;
let settingsHome: string | undefined;
let settingsError: string | undefined;
let savedSettings: WorkloadMemorySettings = {};
let cgroupRoot = '/sys/fs/cgroup';
let procRoot = '/proc';
/** The binaries an engine scope's wrapper starts its holder with. */
let holderBinaries: HolderBinaries | undefined;

/** What an engine scope's wrapper starts its holder with. */
export interface HolderBinaries {
  setsid: string;
  sleep: string;
  /** bash(1), when the host has it: the holder then closes every fd >= 3. */
  bash?: string;
}
const active = new Map<string, ActiveWorkload>();
let monitor: ReturnType<typeof setTimeout> | undefined;
const recent: Array<{
  unit: string;
  pid?: number;
  /**
   * `oom-kill-in-scope` when the kernel killed any process in the scope (the
   * engine or a command), whatever systemd reports: under OOMPolicy=continue
   * systemd says `success`.
   */
  result: string;
  /** What systemd itself reported for the scope. */
  systemdResult: string;
  /** The scope's own `oom_kill` count; absent when never read. */
  oomKills?: number;
  /**
   * `close`: read just before the scope was stopped (exact). `last-poll`:
   * the scope was already gone, so this is the last 1 s poll's count.
   */
  oomKillsSource?: 'close' | 'last-poll';
  memoryPeakBytes?: number;
  cpuUsageNSec?: number;
}> = [];

function positiveInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  allowZero = false,
) {
  const value = env[key];
  if (value === undefined) return fallback;
  if (
    !/^(0|[1-9]\d*)$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    (!allowZero && value === '0')
  )
    throw new Error(
      `${key} must be a ${allowZero ? 'nonnegative' : 'positive'} whole number.`,
    );
  return Number(value);
}

function memoryBytes(
  key: string,
  fallbackMiB: number,
  allowZero = false,
): number {
  const bytes = positiveInteger(process.env, key, fallbackMiB, allowZero) * MIB;
  if (!Number.isSafeInteger(bytes))
    throw new Error(`${key} exceeds the supported memory budget.`);
  return bytes;
}

/** Resolves limits without changing any module state. */
function computeLimits(settings: WorkloadMemorySettings): {
  limits: WorkloadLimits;
  sources: ResolvedWorkloadMemoryBudget['sources'];
} {
  const budget = resolveWorkloadMemoryBudget({
    env: process.env,
    settings,
    hostTotalBytes: totalmem(),
  });
  return { limits: limitsFrom(budget), sources: budget.sources };
}

function resolveLimits(settings: WorkloadMemorySettings): WorkloadLimits {
  const { limits: resolved, sources } = computeLimits(settings);
  budgetSources = sources;
  return resolved;
}

/**
 * Reads the saved settings and validates them exactly as a write would. A
 * missing file is no choice; an unreadable, malformed or out-of-range file is
 * reported and ignored, so the environment and defaults apply.
 */
async function loadSavedSettings(homeDir: string): Promise<void> {
  const read = await readWorkloadBudgetSettings(homeDir);
  const problem =
    'error' in read
      ? undefined
      : workloadSettingsProblem(read.settings, totalmem(), process.env);
  savedSettings = 'error' in read || problem ? {} : read.settings;
  settingsError =
    'error' in read
      ? read.error
      : problem
        ? `Saved workload budgets were ignored: ${problem}`
        : undefined;
  if (settingsError) logger.warn(settingsError);
}

function limitsFrom(budget: ResolvedWorkloadMemoryBudget): WorkloadLimits {
  return {
    totalMemoryMaxBytes: budget.totalMemoryMaxBytes,
    memoryMaxBytes: budget.memoryMaxBytes,
    cpuQuotaPercent: positiveInteger(
      process.env,
      'STATION_WORKLOAD_CPU_PERCENT',
      availableParallelism() * 75,
    ),
    tasksMax: positiveInteger(process.env, 'STATION_WORKLOAD_TASKS_MAX', 512),
    totalTasksMax: positiveInteger(
      process.env,
      'STATION_WORKLOAD_TOTAL_TASKS_MAX',
      2048,
    ),
    swapMaxBytes: memoryBytes('STATION_WORKLOAD_SWAP_MIB', 256, true),
  };
}

/**
 * The workload slice's CPU weight. The slice sits directly under the user
 * manager, a sibling of the `app.slice` that holds the server's unit, so when
 * just those two contend, that subtree (default weight 100) gets 100/125 =
 * 80% of the CPU. Weights are work-conserving: an idle control plane leaves
 * the CPU to workloads. IOWeight is not set: a user manager is normally
 * delegated only the cpu, memory and pids controllers.
 */
const WORKLOAD_SLICE_CPU_WEIGHT = 25;

function sliceProperties(value: WorkloadLimits): string[] {
  return [
    `MemoryMax=${value.totalMemoryMaxBytes}`,
    'MemorySwapMax=1073741824',
    `CPUQuota=${value.cpuQuotaPercent}%`,
    `CPUWeight=${WORKLOAD_SLICE_CPU_WEIGHT}`,
    `TasksMax=${value.totalTasksMax}`,
  ];
}

/**
 * The server's resident working set under agent load with headroom: a busy
 * server measured about 1.1 GiB (810 MiB resident plus 330 MiB swapped), so
 * the earlier 512 MiB protected less than half of it.
 */
const CONTROL_PLANE_MEMORY_LOW_BYTES = 1536 * MIB;
/** Protection never exceeds this share of host RAM. */
const CONTROL_PLANE_MEMORY_LOW_HOST_DIVISOR = 8;

/**
 * Properties for the server's own unit. This is protection under the host
 * policy, not a global OOM guarantee.
 *
 * - `MemorySwapMax=0`, only where the whole working set fits in 1/8 of host
 *   RAM (12 GiB and up): the server's anonymous memory stays resident, since
 *   a swapped page faulted back in on the event loop stalls every request.
 *   Unlike `MemoryLow` this holds whatever the ancestors set, and it has no
 *   size bound of its own, so a smaller host keeps swap (`infinity` replaces
 *   any earlier runtime value). File-backed pages stay reclaimable either way.
 * - `MemoryLow`: the working set above, at most 1/8 of host RAM so the
 *   protection cannot starve a small host. Under host-wide reclaim the kernel
 *   caps a cgroup's effective protection by its ancestors', and a user
 *   manager cannot set `user.slice` or `user@.service`, so there it takes
 *   effect only where the host protects those ancestors.
 * - `ManagedOOMPreference=avoid`: systemd-oomd picks other candidates first,
 *   but honours that for a user unit only when it acts on pressure at or
 *   below the user manager.
 */
function controlPlaneProperties(hostMemoryBytes: number): string[] {
  const hostShareBytes =
    Math.floor(hostMemoryBytes / MIB / CONTROL_PLANE_MEMORY_LOW_HOST_DIVISOR) *
    MIB;
  const fits = hostShareBytes >= CONTROL_PLANE_MEMORY_LOW_BYTES;
  return [
    `MemoryLow=${fits ? CONTROL_PLANE_MEMORY_LOW_BYTES : hostShareBytes}`,
    `MemorySwapMax=${fits ? 0 : 'infinity'}`,
    'ManagedOOMPreference=avoid',
  ];
}

/** Applies the workload slice's limits and the server unit's protection. */
async function configureControlGroups(
  workloadSlice: string,
  unit: string,
  value: WorkloadLimits,
  hostMemoryBytes: number,
): Promise<void> {
  await runManager([
    'set-property',
    '--runtime',
    workloadSlice,
    ...sliceProperties(value),
  ]);
  await runManager([
    'set-property',
    '--runtime',
    unit,
    ...controlPlaneProperties(hostMemoryBytes),
  ]);
}

const manager = {
  run: (args: string[]): Promise<string> => systemctl(args),
};

function runManager(args: string[]): Promise<string> {
  return manager.run(args);
}

function systemctl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/systemctl',
      ['--user', '--no-pager', '--no-ask-password', ...args],
      {
        env: managerEnv,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 10_000,
        killSignal: 'SIGKILL',
        maxBuffer: 256 * 1024,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** `oom_kill` from a cgroup's `memory.events`, or undefined when unreadable. */
async function readOomKills(controlGroup: string): Promise<number | undefined> {
  try {
    return (await readScopeMemory(`${cgroupRoot}${controlGroup}`)).oomKills;
  } catch {
    return undefined;
  }
}

/** The scope's control group once systemd has loaded it. */
async function resolveControlGroup(
  entry: ActiveWorkload,
): Promise<string | undefined> {
  if (entry.controlGroup) return entry.controlGroup;
  try {
    const cgroup = (
      await runManager([
        'show',
        entry.unit,
        '--property=ControlGroup',
        '--value',
      ])
    ).trim();
    if (cgroup.startsWith('/') && !cgroup.split('/').includes('..'))
      entry.controlGroup = cgroup;
  } catch {
    /* the next poll tries again */
  }
  return entry.controlGroup;
}

/**
 * Polls that miss the holder before it is reported `not-in-scope`: the first
 * poll can land between setsid's fork and its child's exec of sleep.
 */
const HOLDER_MISSES_TO_REPORT = 2;
/** Polls that search a scope for its holder before giving up for good. */
const HOLDER_SEARCH_LIMIT = 5;

/** A process's start time in clock ticks (field 22 of /proc/<pid>/stat). */
async function processStart(pid: string): Promise<string | undefined> {
  const stat = await readFile(`${procRoot}/${pid}/stat`, 'utf8').catch(
    () => undefined,
  );
  if (!stat) return undefined;
  // Fields after the parenthesized command name start at field 3.
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

/**
 * Tracks an engine scope's holder in the scope's own processes. Until found,
 * each poll searches cgroup.procs for a pid other than the leader whose
 * command line is exactly the holder's: two misses in a row report
 * `not-in-scope`, and the search stops after HOLDER_SEARCH_LIMIT. Once found,
 * each poll confirms that pid is still in the scope with the start time it
 * had; otherwise (killed, say by an agent's `pkill sleep`) the scope reports
 * `holder-gone`. A process in the scope that runs the same
 * `sleep 2147483647` can pass for the holder; that misreports status only,
 * and the scope is held all the same while it runs.
 */
async function observeHolder(
  entry: ActiveWorkload,
  controlGroup: string,
): Promise<void> {
  if (
    !entry.holderLaunched ||
    !holderBinaries ||
    entry.holderReason === 'holder-gone'
  )
    return;
  let pids: string[];
  try {
    pids = (await readFile(`${cgroupRoot}${controlGroup}/cgroup.procs`, 'utf8'))
      .split('\n')
      .filter((pid) => /^\d+$/.test(pid) && Number(pid) !== entry.pid);
  } catch {
    return;
  }
  const known = entry.holder;
  if (known) {
    if (
      pids.includes(known.pid) &&
      (await processStart(known.pid)) === known.start
    )
      return;
    entry.holder = undefined;
    entry.holderState = 'unplaced';
    entry.holderReason = 'holder-gone';
    logger.warn(
      'Workload scope holder is gone; an engine memory kill in it will read as unknown',
      { unit: entry.unit },
    );
    return;
  }
  if ((entry.holderMisses ?? 0) >= HOLDER_SEARCH_LIMIT) return;
  const holderCmdline = `${holderBinaries.sleep}\0${HOLDER_SLEEP_SECONDS}\0`;
  for (const pid of pids) {
    const cmdline = await readFile(`${procRoot}/${pid}/cmdline`, 'utf8').catch(
      () => '',
    );
    if (cmdline !== holderCmdline) continue;
    const start = await processStart(pid);
    if (start === undefined) continue;
    entry.holder = { pid, start };
    entry.holderMisses = 0;
    entry.holderState = 'placed';
    entry.holderReason = undefined;
    return;
  }
  entry.holderMisses = (entry.holderMisses ?? 0) + 1;
  if (
    entry.holderMisses >= HOLDER_MISSES_TO_REPORT &&
    entry.holderState !== 'unplaced'
  ) {
    entry.holderState = 'unplaced';
    entry.holderReason = 'not-in-scope';
    logger.warn(
      'Workload scope holder not found in its scope; an engine memory kill in it will read as unknown',
      { unit: entry.unit },
    );
  }
}

/** The scope's leader is the very process launched, still running. */
async function leaderAlive(entry: ActiveWorkload): Promise<boolean> {
  if (entry.pid === undefined) return false;
  const owner = await probeExactProcessIdentityAsync(entry.pid);
  return (
    owner.state === 'exact' &&
    (!entry.birth || owner.identity.start === entry.birth)
  );
}

/**
 * One pass over running scopes: record each scope's kernel OOM kill count
 * and announce kills inside a running engine's scope. Under
 * `OOMPolicy=continue` the kernel kills one process (normally the largest
 * command) and the engine keeps running, so this is the only report of it
 * besides the command's own failure.
 */
async function pollOomKills(): Promise<void> {
  await Promise.allSettled(
    [...active.values()].map(async (entry) => {
      if (entry.closing || entry.pid === undefined) return;
      const controlGroup = await resolveControlGroup(entry);
      if (!controlGroup) return;
      await observeHolder(entry, controlGroup);
      const oomKills = await readOomKills(controlGroup);
      if (oomKills !== undefined && oomKills > (entry.oomKillsPolled ?? 0))
        entry.lastOomKillAt = new Date().toISOString();
      if (oomKills !== undefined) entry.oomKillsPolled = oomKills;
      if (entry.oomListeners.size === 0) return;
      if (oomKills === undefined || oomKills <= entry.oomKillsReported) return;
      // A kill is a command's only once the engine is seen alive after it:
      // a count waits one poll as pending, and the next poll that finds the
      // exact engine alive announces that earlier count, while any newer
      // kills wait in turn. Announcing at once could take the engine's own
      // death (a poll landing between the kernel's kill and the exit reaching
      // Station) for a command kill and hide it from the close-time verdict,
      // which counts only unannounced kills. A steady stream of command kills
      // is still announced, one poll behind.
      const pending = entry.oomKillsPending;
      if (pending === undefined || pending <= entry.oomKillsReported) {
        entry.oomKillsPending = oomKills;
        return;
      }
      if (entry.closing || !(await leaderAlive(entry))) return;
      const kill: ChildWorkloadOomKill = Object.freeze({
        oomKills: pending,
        newKills: pending - entry.oomKillsReported,
        ...(entry.memoryMaxBytes === undefined
          ? {}
          : { memoryMaxBytes: entry.memoryMaxBytes }),
      });
      entry.oomKillsReported = pending;
      entry.oomKillsPending = oomKills > pending ? oomKills : undefined;
      logger.warn('A process in a workload scope was killed for memory', {
        unit: entry.unit,
        ...kill,
      });
      for (const listener of entry.oomListeners) {
        try {
          listener(kill);
        } catch (error) {
          logger.warn('Workload OOM listener failed', { error });
        }
      }
    }),
  );
}

function monitorLeaders(): void {
  if (monitor || state !== 'ready' || active.size === 0) return;
  monitor = setTimeout(async () => {
    await pollOomKills();
    // MCP transports report close only after inherited stdio pipes close.
    // Observe leader identity independently so retained pipes cannot hide exit.
    await Promise.allSettled(
      [...active.values()].map(async (entry) => {
        if (entry.pid === undefined || entry.closing) return;
        const owner = await probeExactProcessIdentityAsync(entry.pid);
        if (
          owner.state === 'dead' ||
          (owner.state === 'exact' &&
            entry.birth &&
            owner.identity.start !== entry.birth)
        )
          await closeScope(entry);
      }),
    );
    monitor = undefined;
    monitorLeaders();
  }, 1000);
  monitor.unref();
}

async function reapPreviousOwners(prefix: string): Promise<void> {
  const listing = await runManager([
    'list-units',
    '--all',
    '--type=scope',
    '--plain',
    '--no-legend',
    `${prefix}-*.scope`,
  ]);
  for (const line of listing.split('\n')) {
    const unit = line.trim().split(/\s+/)[0];
    const match = new RegExp(
      `^${prefix}-p([1-9]\\d*)-b([a-f0-9]{16})-[a-f0-9]{32}\\.scope$`,
    ).exec(unit);
    if (!match) continue;
    const owner = probeExactProcessIdentity(Number(match[1]));
    if (owner.state === 'unavailable') continue;
    if (owner.state === 'exact' && digest(owner.identity.start) === match[2])
      continue;
    await runManager(['stop', unit]);
    logger.info('Reaped a previous generation workload scope', { unit });
  }
}

/** Boots management even if enforcement is unavailable; workload starts fail closed. */
export async function initializeWorkloadResources(
  options: { homeDir?: string } = {},
): Promise<void> {
  settingsHome = options.homeDir;
  if (settingsHome) await loadSavedSettings(settingsHome);
  if (process.platform !== 'linux') return;
  try {
    const membership = await readFile('/proc/self/cgroup', 'utf8');
    serviceUnit = membership.match(
      /\/(station-[a-zA-Z0-9_.@-]+\.service)(?:\/|$)/mu,
    )?.[1];
    if (!serviceUnit) return;
    state = 'unavailable';
    managerEnv = { ...process.env };
    const version = Number(
      /^systemd (\d+)/m.exec(await runManager(['--version']))?.[1],
    );
    if (!Number.isSafeInteger(version) || version < 253)
      throw new Error(
        'Linux workload isolation requires systemd 253 or newer for scope OOM policy and reporting. Upgrade systemd, then restart Station.',
      );
    limits = resolveLimits(savedSettings);
    holderBinaries = await resolveHolderBinaries();
    if (!holderBinaries)
      logger.warn(
        'No setsid(1) or sleep(1) found: engine scopes run without a holder, so an engine memory kill reads as unknown',
      );
    const prefix = `stationworkload${digest(serviceUnit)}`;
    slice = `${prefix}.slice`;
    await configureControlGroups(slice, serviceUnit, limits, totalmem());
    await reapPreviousOwners(prefix);
    const birth = lookupProcessBirthFingerprintCached(process.pid);
    if (!birth)
      throw new Error('Cannot establish workload owner process identity.');
    const owner = `p${process.pid}-b${digest(birth)}`;
    state = 'ready';
    installScopeLauncher(prefix, owner, version);
    const probe = spawnChildWorkload('/bin/true', [], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let probeError = Buffer.alloc(0);
    probe.stderr?.on('data', (data: Buffer) => {
      probeError = Buffer.concat([probeError, data]).subarray(-2048);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          probe.kill('SIGKILL');
          reject(new Error('Workload scope capability probe timed out.'));
        }, 10_000);
        probe.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        probe.once('exit', (code, signal) => {
          clearTimeout(timeout);
          if (code === 0) resolve();
          else
            reject(
              new Error(
                `Workload scope capability probe exited ${code ?? signal}. ${probeError.toString().trim()}`.trim(),
              ),
            );
        });
      });
    } finally {
      await closeChildWorkload(probe.pid);
    }
    logger.info(
      'Agent workloads use bounded scopes outside the control server',
      { slice, limits },
    );
  } catch (error) {
    if (!serviceUnit && process.env.STATION_SERVICE_MANAGED !== '1') return;
    state = 'unavailable';
    reason = String(error);
    installChildWorkloadLauncher(() => {
      throw new Error(
        `Station cannot start this workload because Linux resource isolation is unavailable. Check the systemd user manager and workload budgets, then restart Station. ${reason}`,
      );
    });
    logger.error(
      'Workload isolation unavailable; management remains available',
      { error },
    );
  }
}

/** A holder sleeps for the longest time sleep(1) takes portably. */
const HOLDER_SLEEP_SECONDS = '2147483647';

/**
 * The setsid(1) and sleep(1) an engine scope's wrapper starts its holder
 * with, or undefined when the host has none (engine scopes then run without
 * one, reported `holder-unavailable`).
 */
async function resolveHolderBinaries(): Promise<HolderBinaries | undefined> {
  const first = async (candidates: string[]) => {
    for (const candidate of candidates) {
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        /* next */
      }
    }
    return undefined;
  };
  const setsid = await first(['/usr/bin/setsid', '/bin/setsid']);
  const sleep = await first(['/usr/bin/sleep', '/bin/sleep']);
  const bash = await first(['/usr/bin/bash', '/bin/bash']);
  return setsid && sleep
    ? { setsid, sleep, ...(bash ? { bash } : {}) }
    : undefined;
}

/**
 * The scope's shell wrapper. For an engine's own scope it first starts a
 * holder, a sleep(1) that keeps the scope's cgroup, and so its own
 * `memory.events`, after the engine dies (systemd collects a scope as soon as
 * its last process exits). The holder is forked inside the scope before the
 * engine is exec'd, so it is there however soon the engine dies, and nothing
 * is migrated between cgroups. `setsid -f` gives it its own session and
 * process group, out of reach of the group kill that tears a Codex engine
 * down. Its descriptors 0-2 are /dev/null and 3-9 closed, which covers every
 * pipe Station maps to the engine (Node maps a child's stdio, IPC and extra
 * pipes onto the lowest descriptors and opens everything else close-on-exec).
 * Descriptors Station itself inherited without close-on-exec (from a harness,
 * a terminal, a CI step) can sit at 10 and above, where dash cannot name
 * them; a parent waiting for EOF on one would wait as long as the holder
 * lives. So where the host has bash, the holder first closes every descriptor
 * from 3 up that /dev/fd lists, then execs sleep; without bash it keeps the
 * 3-9 closure only. The scope's stop kills the holder with the rest.
 */
function scopeWrapper(holder: boolean): string {
  return holder && holderBinaries
    ? engineScopeWrapper(holderBinaries)
    : 'exec "$@"';
}

/** The wrapper of an engine's own scope, with its holder (see scopeWrapper). */
export function engineScopeWrapper(binaries: HolderBinaries): string {
  for (const path of Object.values(binaries))
    if (!/^[A-Za-z0-9/._-]+$/.test(path))
      throw new Error(`Unsafe holder binary path: ${path}`);
  const closed = [3, 4, 5, 6, 7, 8, 9].map((fd) => `${fd}>&-`).join(' ');
  const holder = binaries.bash
    ? // -p: ignore inherited BASH_ENV, SHELLOPTS and BASHOPTS. An unexpanded
      // glob (no /dev/fd, or noglob) or any non-numeric name never reaches eval.
      `'${binaries.bash}' -p -c 'for fd in /dev/fd/*; do [ -e "$fd" ] || continue; fd=\${fd##*/}; case $fd in 0|1|2|*[!0-9]*) ;; *) eval "exec $fd>&-" ;; esac; done; exec ${binaries.sleep} ${HOLDER_SLEEP_SECONDS}' station-holder`
    : `'${binaries.sleep}' ${HOLDER_SLEEP_SECONDS}`;
  return `'${binaries.setsid}' -f ${holder} </dev/null >/dev/null 2>&1 ${closed}; exec "$@"`;
}

function installScopeLauncher(
  prefix: string,
  owner: string,
  version: number,
): void {
  installChildWorkloadLauncher((command, args, env) => {
    if (state !== 'ready' || !limits || !slice || !serviceUnit)
      throw new Error(
        `Station workload isolation is ${state}: ${reason ?? 'server is stopping'}`,
      );
    if (active.size >= 256)
      throw new Error(
        'Station has reached its 256 active workload scopes; finish or close an existing workload.',
      );
    const unit = `${prefix}-${owner}-${randomUUID().replaceAll('-', '')}.scope`;
    let observed: ActiveWorkload['observed'];
    const outcome = new Promise<ChildWorkloadOutcome | undefined>((resolve) => {
      observed = resolve;
    });
    const sessionId = env[WORKLOAD_SESSION_ENV];
    const entry: ActiveWorkload = {
      unit,
      ...(sessionId ? { sessionId } : {}),
      ...(sessionId && holderBinaries ? { holderLaunched: true } : {}),
      ...(sessionId && !holderBinaries
        ? { holderState: 'unplaced', holderReason: 'holder-unavailable' }
        : {}),
      observed,
      memoryMaxBytes: limits.memoryMaxBytes,
      oomKillsReported: 0,
      oomListeners: new Set(),
    };
    active.set(unit, entry);
    // Only the two user-bus coordinates are borrowed. Restore the target's
    // exact environment before exec, including their absence in allowlists.
    const restore: string[] = [];
    const launchEnv = { ...env };
    // Attribution only; the launched process does not inherit the label.
    delete launchEnv[WORKLOAD_SESSION_ENV];
    for (const key of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
      if (managerEnv[key] !== undefined) launchEnv[key] = managerEnv[key];
      restore.push(`--unset=${key}`);
    }
    const assignments = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].flatMap(
      (key) => (env[key] === undefined ? [] : [`${key}=${env[key]}`]),
    );
    return {
      outcome,
      command: '/usr/bin/systemd-run',
      args: [
        '--user',
        '--scope',
        '--quiet',
        '--no-ask-password',
        // Before systemd 254, scope launches always preserve literal argv.
        ...(version >= 254 ? ['--expand-environment=no'] : []),
        `--unit=${unit}`,
        `--slice=${slice}`,
        `--property=BindsTo=${serviceUnit}`,
        `--property=After=${serviceUnit}`,
        `--property=MemoryMax=${limits.memoryMaxBytes}`,
        `--property=MemorySwapMax=${limits.swapMaxBytes}`,
        // The kernel OOM killer picks one process in the scope (normally the
        // largest command) and the engine survives to see that command fail.
        // `kill` would set memory.oom.group and end the engine with it.
        '--property=OOMPolicy=continue',
        `--property=TasksMax=${limits.tasksMax}`,
        '--',
        '/usr/bin/env',
        ...restore,
        '--',
        ...assignments,
        '/bin/sh',
        '-c',
        scopeWrapper(Boolean(sessionId)),
        'station-workload',
        command,
        ...args,
      ],
      env: launchEnv,
      started(pid) {
        entry.pid = pid;
        entry.birth = lookupProcessBirthFingerprint(pid);
        monitorLeaders();
      },
      close: () => closeScope(entry),
      watchOomKills(listener) {
        entry.oomListeners.add(listener);
        monitorLeaders();
        return () => entry.oomListeners.delete(listener);
      },
    } satisfies ChildWorkloadLaunch;
  });
}

async function closeScope(entry: ActiveWorkload): Promise<void> {
  if (entry.pid === undefined) {
    entry.observed?.(undefined);
    active.delete(entry.unit);
    return;
  }
  if (entry.closing) return entry.closing;
  entry.closing = (async () => {
    // Successful empty scopes may disappear before inspection. A failed stop
    // on a live unit must remain visible as an unsettled cleanup.
    const properties = Object.fromEntries(
      (
        await runManager([
          'show',
          entry.unit,
          '--property=LoadState,ActiveState,Result,MemoryPeak,CPUUsageNSec,ControlGroup',
        ])
      )
        .trim()
        .split('\n')
        .map((line) => {
          const at = line.indexOf('=');
          return at < 0 ? [line, ''] : [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    const memoryPeakBytes = Number(properties.MemoryPeak);
    // Read the kernel's kill count before the scope is stopped and its
    // cgroup removed.
    const controlGroup =
      typeof properties.ControlGroup === 'string' &&
      properties.ControlGroup.startsWith('/') &&
      !properties.ControlGroup.split('/').includes('..')
        ? properties.ControlGroup
        : entry.controlGroup;
    // An engine scope's holder keeps the cgroup until this read, so the count
    // is the scope's own. Without one (a collected scope) it is unknown.
    const oomKills = controlGroup
      ? await readOomKills(controlGroup)
      : undefined;
    const oomCounts =
      oomKills === undefined
        ? {}
        : {
            oomKills,
            unreportedOomKills: Math.max(0, oomKills - entry.oomKillsReported),
          };
    entry.observed?.(
      properties.LoadState === 'not-found'
        ? // systemd already collected the scope (no holder kept it): its
          // count is gone, so the outcome is unknown unless it was read.
          oomKills === undefined
          ? undefined
          : Object.freeze({
              result: 'collected',
              memoryMaxBytes: entry.memoryMaxBytes,
              ...oomCounts,
            })
        : Object.freeze({
            result: properties.Result ?? 'unavailable',
            ...(Number.isSafeInteger(memoryPeakBytes) && memoryPeakBytes >= 0
              ? { memoryPeakBytes }
              : {}),
            memoryMaxBytes: entry.memoryMaxBytes,
            ...oomCounts,
          }),
    );
    if (properties.LoadState !== 'not-found') {
      try {
        if (
          properties.ActiveState !== 'failed' &&
          properties.ActiveState !== 'inactive'
        )
          await runManager([
            'kill',
            '--signal=SIGKILL',
            '--kill-whom=all',
            entry.unit,
          ]);
        await runManager(['stop', entry.unit]);
      } catch (error) {
        const stateNow = await runManager([
          'show',
          entry.unit,
          '--property=LoadState',
          '--value',
        ]);
        if (stateNow.trim() !== 'not-found') throw error;
      }
      if (properties.ActiveState === 'failed')
        await runManager(['reset-failed', entry.unit]);
    }
    const finiteCounter = (value: string | undefined) => {
      const parsed = Number(value);
      return value !== undefined && Number.isSafeInteger(parsed) && parsed >= 0
        ? parsed
        : undefined;
    };
    const systemdResult = properties.Result ?? 'unavailable';
    // A scope systemd collected before this read (a terminal whose shell
    // exited on hangup; command scopes have no holder) keeps what the last
    // poll saw, labelled so: a kill in its final second can be missing.
    const recordedKills = oomKills ?? entry.oomKillsPolled;
    const outcome = {
      unit: entry.unit,
      pid: entry.pid,
      // A process in the scope was OOM-killed. Whether that was the engine
      // (it died) or a command (it survived) is the engine adapter's verdict,
      // so the record names only what the kernel did.
      result: (recordedKills ?? 0) > 0 ? 'oom-kill-in-scope' : systemdResult,
      systemdResult,
      ...(recordedKills === undefined
        ? {}
        : {
            oomKills: recordedKills,
            oomKillsSource:
              oomKills === undefined
                ? ('last-poll' as const)
                : ('close' as const),
          }),
      memoryPeakBytes: finiteCounter(properties.MemoryPeak),
      cpuUsageNSec: finiteCounter(properties.CPUUsageNSec),
    };
    recent.push(outcome);
    if (recent.length > 64) recent.shift();
    logger.info('Workload scope settled', outcome);
    active.delete(entry.unit);
  })().catch((error: unknown) => {
    entry.observed?.(undefined);
    entry.closing = undefined;
    logger.warn('Workload scope cleanup did not settle', {
      unit: entry.unit,
      error,
    });
    throw error;
  });
  return entry.closing;
}

export async function stopWorkloadResources(): Promise<void> {
  if (state !== 'ready') return;
  state = 'stopping';
  clearTimeout(monitor);
  monitor = undefined;
  const results = await Promise.allSettled(
    [...active.values()].map(closeScope),
  );
  if (results.some((result) => result.status === 'rejected'))
    throw new Error('Some workload scopes did not confirm cleanup.');
}

export async function inspectWorkloadResources() {
  let memory: Record<string, number> | undefined;
  let pressure: string | undefined;
  let measurementError: string | undefined;
  try {
    if (slice && state === 'ready') {
      const cgroup = (
        await runManager(['show', slice, '--property=ControlGroup', '--value'])
      ).trim();
      if (cgroup.startsWith('/') && !cgroup.split('/').includes('..')) {
        const root = `/sys/fs/cgroup${cgroup}`;
        const [current, peak, stat, psi] = await Promise.all([
          readFile(`${root}/memory.current`, 'utf8'),
          readFile(`${root}/memory.peak`, 'utf8'),
          readFile(`${root}/memory.stat`, 'utf8'),
          readFile(`${root}/memory.pressure`, 'utf8'),
        ]);
        memory = { currentBytes: Number(current), peakBytes: Number(peak) };
        for (const line of stat.split('\n')) {
          const [key, value] = line.split(' ');
          if (['anon', 'file', 'kernel'].includes(key))
            memory[`${key}Bytes`] = Number(value);
        }
        pressure = psi;
      }
    }
  } catch (error) {
    measurementError = String(error);
  }
  return {
    state,
    reason,
    limits,
    slice,
    active: [...active.values()].map(({ unit, pid, sessionId }) => ({
      unit,
      pid,
      ...(sessionId ? { sessionId } : {}),
    })),
    recent: [...recent],
    memory,
    pressure,
    measurementError,
  };
}

/**
 * The limits an engine launched now would receive, only while enforcement
 * is actually configured. Absent everywhere a scope would not be created.
 */
export function enforcedWorkloadLimits(
  sessionId?: string,
):
  | Readonly<
      Pick<WorkloadLimits, 'memoryMaxBytes' | 'swapMaxBytes' | 'tasksMax'>
    >
  | undefined {
  if (state !== 'ready' || !limits) return undefined;
  const { memoryMaxBytes, swapMaxBytes, tasksMax } = limits;
  // A Session whose engine scope already exists runs under the limit that
  // scope was launched with, even if the setting changed since.
  const launched = sessionId
    ? sessionScope(sessionId)?.memoryMaxBytes
    : undefined;
  return {
    memoryMaxBytes: launched ?? memoryMaxBytes,
    swapMaxBytes,
    tasksMax,
  };
}

function sessionScope(sessionId: string): ActiveWorkload | undefined {
  return [...active.values()]
    .reverse()
    .find(
      (candidate) =>
        candidate.sessionId === sessionId && candidate.pid !== undefined,
    );
}

function enforcementSummary() {
  return {
    state,
    ...(reason ? { reason } : {}),
    platform: process.platform,
  };
}

/** Operator view: budgets, where each came from, and the saved choices. */
export function workloadBudgetStatus(): WorkloadBudgetStatus {
  const effective =
    limits ??
    (() => {
      try {
        return resolveLimits(savedSettings);
      } catch {
        return undefined;
      }
    })();
  return {
    enforcement: enforcementSummary(),
    hostMemoryBytes: totalmem(),
    ...(effective
      ? {
          limits: {
            memoryMaxBytes: effective.memoryMaxBytes,
            totalMemoryMaxBytes: effective.totalMemoryMaxBytes,
            swapMaxBytes: effective.swapMaxBytes,
            tasksMax: effective.tasksMax,
          },
        }
      : {}),
    ...(budgetSources ? { sources: { ...budgetSources } } : {}),
    settings: { ...savedSettings },
    ...(settingsError ? { settingsError } : {}),
    settingsWritable: settingsHome !== undefined,
    // A running manager re-applies the slice and stamps new scopes at launch;
    // anything else reads the settings only when enforcement starts.
    applies: state === 'ready' ? ('new-scopes' as const) : ('restart' as const),
    activeScopes: active.size,
    // Each running scope keeps the per-engine limit it was launched with.
    scopes: [...active.values()]
      .filter((entry) => entry.pid !== undefined)
      .map((entry) => ({
        unit: entry.unit,
        ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
        ...(entry.memoryMaxBytes === undefined
          ? {}
          : { memoryMaxBytes: entry.memoryMaxBytes }),
        oomKills: entry.oomKillsPolled ?? entry.oomKillsReported,
        ...(entry.lastOomKillAt ? { lastOomKillAt: entry.lastOomKillAt } : {}),
        ...(entry.holderState ? { holder: entry.holderState } : {}),
        ...(entry.holderReason ? { holderReason: entry.holderReason } : {}),
      })),
  };
}

export class WorkloadSettingsRejectedError extends Error {
  readonly code = 'workload_settings_invalid' as const;
}

let applyQueue: Promise<unknown> = Promise.resolve();

/** Current memory use of the whole workload slice, when it can be read. */
async function sliceMemoryCurrent(): Promise<number | undefined> {
  if (!slice) return undefined;
  const cgroup = (
    await runManager(['show', slice, '--property=ControlGroup', '--value'])
  ).trim();
  if (!cgroup.startsWith('/') || cgroup.split('/').includes('..'))
    return undefined;
  return (await readScopeMemory(`${cgroupRoot}${cgroup}`)).currentBytes;
}

/**
 * Persists the operator's choice and, while enforcement runs, applies it
 * without a restart. The total is the slice's MemoryMax, which binds every
 * running engine at once, so a total below what the slice uses now is
 * refused rather than forcing an immediate out-of-memory kill. Scopes
 * launched from now on receive the new per-engine limit; running scopes keep
 * the per-engine limit they were launched with.
 *
 * Saves are serialized. The slice is changed before the file is renamed into
 * place, and a failed rename restores the previous slice properties, so the
 * saved file, the reported state and the enforced limits never disagree.
 */
export function applyWorkloadBudgetSettings(
  settings: WorkloadMemorySettings,
): Promise<WorkloadBudgetStatus> {
  const run = applyQueue.then(() => applySettingsNow(settings));
  applyQueue = run.catch(() => {});
  return run;
}

async function applySettingsNow(
  settings: WorkloadMemorySettings,
): Promise<WorkloadBudgetStatus> {
  if (!settingsHome)
    throw new Error('Workload budget settings have no Station home.');
  const home = settingsHome;
  const problem = workloadSettingsProblem(settings, totalmem(), process.env);
  if (problem) throw new WorkloadSettingsRejectedError(problem);
  const next = { ...settings };
  let computed: ReturnType<typeof computeLimits> | undefined;
  try {
    computed = computeLimits(next);
  } catch {
    // An invalid environment variable already stops enforcement; the saved
    // values are still stored for when it is fixed.
  }
  const enforcing = state === 'ready' && slice !== undefined && !!limits;
  if (enforcing && computed) {
    const used = await sliceMemoryCurrent().catch(() => undefined);
    if (used !== undefined && computed.limits.totalMemoryMaxBytes < used)
      throw new WorkloadSettingsRejectedError(
        `The total (${Math.round(computed.limits.totalMemoryMaxBytes / MIB)} MiB) is below what running engines use now (${Math.round(used / MIB)} MiB). Lower it when fewer engines run.`,
      );
  }
  const previous = limits;
  await writeWorkloadBudgetSettings(home, next, async () => {
    if (enforcing && computed && slice)
      await runManager([
        'set-property',
        '--runtime',
        slice,
        ...sliceProperties(computed.limits),
      ]);
  }).catch(async (error: unknown) => {
    // The slice may already carry the new total; put the old one back.
    if (enforcing && computed && slice && previous)
      await runManager([
        'set-property',
        '--runtime',
        slice,
        ...sliceProperties(previous),
      ]).catch(() => {});
    throw error;
  });
  savedSettings = next;
  settingsError = undefined;
  if (computed) {
    budgetSources = computed.sources;
    if (enforcing) {
      limits = computed.limits;
      logger.info('Workload budgets changed', { slice, limits });
    }
  }
  return workloadBudgetStatus();
}

/**
 * The calling session's own scope, read from its cgroup v2 files. A session
 * is attributed only when its engine launch named it; every other case is
 * reported as such rather than guessed.
 */
export async function inspectSessionWorkload(sessionId: string) {
  const base = {
    enforcement: enforcementSummary(),
    ...(limits
      ? {
          limits: {
            memoryMaxBytes: limits.memoryMaxBytes,
            totalMemoryMaxBytes: limits.totalMemoryMaxBytes,
            swapMaxBytes: limits.swapMaxBytes,
            tasksMax: limits.tasksMax,
          },
        }
      : {}),
  };
  if (state !== 'ready') return { ...base, scope: { state: 'none' as const } };
  const entry = sessionScope(sessionId);
  if (!entry) return { ...base, scope: { state: 'unattributed' as const } };
  try {
    const cgroup = (
      await runManager([
        'show',
        entry.unit,
        '--property=ControlGroup',
        '--value',
      ])
    ).trim();
    if (!cgroup.startsWith('/') || cgroup.split('/').includes('..'))
      throw new Error(`unexpected control group ${cgroup.slice(0, 120)}`);
    const memory: ScopeMemoryReading = await readScopeMemory(
      `${cgroupRoot}${cgroup}`,
    );
    return {
      ...base,
      scope: {
        state: 'measured' as const,
        unit: entry.unit,
        launchedMemoryMaxBytes: entry.memoryMaxBytes,
        memory,
        ...(entry.lastOomKillAt ? { lastOomKillAt: entry.lastOomKillAt } : {}),
      },
    };
  } catch (error) {
    return {
      ...base,
      scope: {
        state: 'unmeasured' as const,
        unit: entry.unit,
        launchedMemoryMaxBytes: entry.memoryMaxBytes,
        error: String(error),
      },
    };
  }
}

/**
 * Test seam: runs the real launcher, settings and inspection code against a
 * fake systemd manager and cgroup root, without Linux or systemd.
 */
export const __workloadTestHooks = {
  async start(options: {
    run: (args: string[]) => Promise<string>;
    homeDir: string;
    cgroupRoot: string;
    /** Stands in for /proc (each pid's cmdline). */
    procRoot?: string;
    serviceUnit?: string;
    version?: number;
    /** null: the host has no setsid(1) or sleep(1). */
    holderBinaries?: HolderBinaries | null;
    /** Stands in for the host's physical memory (default: this host's). */
    hostMemoryBytes?: number;
  }): Promise<void> {
    manager.run = options.run;
    cgroupRoot = options.cgroupRoot;
    procRoot = options.procRoot ?? '/proc';
    holderBinaries =
      options.holderBinaries === null
        ? undefined
        : (options.holderBinaries ?? {
            setsid: '/usr/bin/setsid',
            sleep: '/usr/bin/sleep',
          });
    managerEnv = {};
    settingsHome = options.homeDir;
    await loadSavedSettings(options.homeDir);
    serviceUnit = options.serviceUnit ?? 'station-test.service';
    limits = resolveLimits(savedSettings);
    const prefix = `stationworkload${digest(serviceUnit)}`;
    slice = `${prefix}.slice`;
    await configureControlGroups(
      slice,
      serviceUnit,
      limits,
      options.hostMemoryBytes ?? totalmem(),
    );
    state = 'ready';
    installScopeLauncher(
      prefix,
      'p1-b0000000000000000',
      options.version ?? 255,
    );
  },
  pollOomKills,
  /**
   * Replaces the recorded start time of a running scope's leader, as if its
   * pid now belonged to a different process (pid reuse).
   */
  recordLeaderBirth(sessionId: string, birth: string): void {
    for (const entry of active.values())
      if (entry.sessionId === sessionId) entry.birth = birth;
  },
  reset(): void {
    manager.run = systemctl;
    cgroupRoot = '/sys/fs/cgroup';
    procRoot = '/proc';
    holderBinaries = undefined;
    state = 'unmanaged';
    reason = undefined;
    limits = undefined;
    slice = undefined;
    serviceUnit = undefined;
    budgetSources = undefined;
    settingsHome = undefined;
    settingsError = undefined;
    savedSettings = {};
    active.clear();
    clearTimeout(monitor);
    monitor = undefined;
    installChildWorkloadLauncher(undefined as never);
  },
};
