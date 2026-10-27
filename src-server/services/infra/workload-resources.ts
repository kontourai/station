import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { availableParallelism, totalmem } from 'node:os';
import {
  type ChildWorkloadLaunch,
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
const active = new Map<string, ActiveWorkload>();
let monitor: ReturnType<typeof setTimeout> | undefined;
const recent: Array<{
  unit: string;
  pid?: number;
  result: string;
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

function resolveLimits(settings: WorkloadMemorySettings): WorkloadLimits {
  const budget = resolveWorkloadMemoryBudget({
    env: process.env,
    settings,
    hostTotalBytes: totalmem(),
  });
  budgetSources = budget.sources;
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

function sliceProperties(value: WorkloadLimits): string[] {
  return [
    `MemoryMax=${value.totalMemoryMaxBytes}`,
    'MemorySwapMax=1073741824',
    `CPUQuota=${value.cpuQuotaPercent}%`,
    `TasksMax=${value.totalTasksMax}`,
  ];
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

function monitorLeaders(): void {
  if (monitor || state !== 'ready' || active.size === 0) return;
  monitor = setTimeout(async () => {
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
  if (settingsHome) {
    const read = await readWorkloadBudgetSettings(settingsHome);
    savedSettings = read.settings;
    settingsError = 'error' in read ? read.error : undefined;
    if (settingsError) logger.warn(settingsError);
  }
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
    const prefix = `stationworkload${digest(serviceUnit)}`;
    slice = `${prefix}.slice`;
    await runManager([
      'set-property',
      '--runtime',
      slice,
      ...sliceProperties(limits),
    ]);
    // Resource pressure should select workloads before the control plane.
    // This is protection under the host policy, not a global OOM guarantee.
    await runManager([
      'set-property',
      '--runtime',
      serviceUnit,
      'MemoryLow=536870912',
      'ManagedOOMPreference=avoid',
    ]);
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
      observed,
      memoryMaxBytes: limits.memoryMaxBytes,
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
        '--property=OOMPolicy=kill',
        `--property=TasksMax=${limits.tasksMax}`,
        '--',
        '/usr/bin/env',
        ...restore,
        '--',
        ...assignments,
        '/bin/sh',
        '-c',
        'exec "$@"',
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
          '--property=LoadState,ActiveState,Result,MemoryPeak,CPUUsageNSec',
        ])
      )
        .trim()
        .split('\n')
        .map((line) => line.split('=')),
    );
    const memoryPeakBytes = Number(properties.MemoryPeak);
    entry.observed?.(
      properties.LoadState === 'not-found'
        ? undefined
        : Object.freeze({
            result: properties.Result ?? 'unavailable',
            ...(Number.isSafeInteger(memoryPeakBytes) && memoryPeakBytes >= 0
              ? { memoryPeakBytes }
              : {}),
            memoryMaxBytes: entry.memoryMaxBytes,
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
    const outcome = {
      unit: entry.unit,
      pid: entry.pid,
      result: properties.Result ?? 'unavailable',
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

export type WorkloadEnforcementState = typeof state;

/**
 * The limits an engine launched now would receive, only while enforcement
 * is actually configured. Absent everywhere a scope would not be created.
 */
export function enforcedWorkloadLimits():
  | Readonly<
      Pick<WorkloadLimits, 'memoryMaxBytes' | 'swapMaxBytes' | 'tasksMax'>
    >
  | undefined {
  if (state !== 'ready' || !limits) return undefined;
  const { memoryMaxBytes, swapMaxBytes, tasksMax } = limits;
  return { memoryMaxBytes, swapMaxBytes, tasksMax };
}

function enforcementSummary() {
  return {
    state,
    ...(reason ? { reason } : {}),
    platform: process.platform,
  };
}

/** Operator view: budgets, where each came from, and the saved choices. */
export function workloadBudgetStatus() {
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
  };
}

export class WorkloadSettingsRejectedError extends Error {
  readonly code = 'workload_settings_invalid' as const;
}

/**
 * Persists the operator's choice and applies it without a restart while
 * enforcement runs: the slice's aggregate MemoryMax is set again now, and
 * scopes launched from now on receive the new per-engine limit. Running
 * scopes keep the limit they were launched with.
 */
export async function applyWorkloadBudgetSettings(
  settings: WorkloadMemorySettings,
) {
  if (!settingsHome)
    throw new Error('Workload budget settings have no Station home.');
  const problem = workloadSettingsProblem(settings, totalmem());
  if (problem) throw new WorkloadSettingsRejectedError(problem);
  const next = { ...settings };
  await writeWorkloadBudgetSettings(settingsHome, next);
  savedSettings = next;
  settingsError = undefined;
  if (state === 'ready' && slice) {
    const resolved = resolveLimits(savedSettings);
    await runManager([
      'set-property',
      '--runtime',
      slice,
      ...sliceProperties(resolved),
    ]);
    limits = resolved;
    logger.info('Workload budgets changed', { slice, limits });
  } else {
    // Keep the reported sources in step with the saved choice.
    try {
      resolveLimits(savedSettings);
    } catch {
      /* the environment error is reported when enforcement starts */
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
  const entry = [...active.values()]
    .reverse()
    .find(
      (candidate) =>
        candidate.sessionId === sessionId && candidate.pid !== undefined,
    );
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
    serviceUnit?: string;
    version?: number;
  }): Promise<void> {
    manager.run = options.run;
    cgroupRoot = options.cgroupRoot;
    managerEnv = {};
    settingsHome = options.homeDir;
    const read = await readWorkloadBudgetSettings(options.homeDir);
    savedSettings = read.settings;
    settingsError = 'error' in read ? read.error : undefined;
    serviceUnit = options.serviceUnit ?? 'station-test.service';
    limits = resolveLimits(savedSettings);
    const prefix = `stationworkload${digest(serviceUnit)}`;
    slice = `${prefix}.slice`;
    await runManager([
      'set-property',
      '--runtime',
      slice,
      ...sliceProperties(limits),
    ]);
    state = 'ready';
    installScopeLauncher(
      prefix,
      'p1-b0000000000000000',
      options.version ?? 255,
    );
  },
  reset(): void {
    manager.run = systemctl;
    cgroupRoot = '/sys/fs/cgroup';
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
