import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type ExecFileOptionsWithStringEncoding,
  execFile as nodeExecFile,
  type SpawnOptions,
  type SpawnOptionsWithoutStdio,
  spawn,
} from 'node:child_process';
import { promisify } from 'node:util';

export interface ChildWorkloadOutcome {
  readonly result: string;
  readonly memoryPeakBytes?: number;
  readonly memoryMaxBytes?: number;
  /** The scope's `memory.events` `oom_kill` count when it was closed. */
  readonly oomKills?: number;
  /**
   * Of {@link oomKills}, those no {@link watchChildWorkloadOomKills} listener
   * was told about while the scope ran: kills at or near the scope's end.
   */
  readonly unreportedOomKills?: number;
}

/** A process inside a running scope was killed by the kernel OOM killer. */
export interface ChildWorkloadOomKill {
  /** The scope's `oom_kill` count after this observation. */
  readonly oomKills: number;
  /** New kills since the previous observation. */
  readonly newKills: number;
  readonly memoryMaxBytes?: number;
}

/**
 * Whether a launch's own process ended because its scope ran out of memory.
 * Under `OOMPolicy=continue` systemd does not record `Result=oom-kill` for
 * the scope, so the kernel's `oom_kill` count is the evidence: the process
 * was SIGKILLed and the scope recorded a kill nobody had been told about yet
 * (a command kill reported while the engine ran is not its death). A scope
 * that systemd itself reports as `oom-kill` still counts.
 */
export function childWorkloadMemoryExhausted(
  outcome: ChildWorkloadOutcome | undefined,
  signal: NodeJS.Signals | null | undefined,
): boolean {
  if (!outcome) return false;
  if (outcome.result === 'oom-kill') return true;
  return signal === 'SIGKILL' && (outcome.unreportedOomKills ?? 0) > 0;
}

const outcomes = new WeakMap<
  object,
  Promise<ChildWorkloadOutcome | undefined>
>();

/** Captures this child's own launch observation, surviving PID reuse and cleanup. */
export function childWorkloadOutcome(
  child: object,
): Promise<ChildWorkloadOutcome | undefined> | undefined {
  return outcomes.get(child);
}

type OomKillWatch = (
  listener: (kill: ChildWorkloadOomKill) => void,
) => () => void;
const oomWatches = new WeakMap<object, OomKillWatch>();

/**
 * Observe OOM kills inside this child's scope while it runs (a command the
 * engine started, normally). Undefined when the child has no managed scope.
 * Returns the unsubscribe.
 */
export function watchChildWorkloadOomKills(
  child: object,
  listener: (kill: ChildWorkloadOomKill) => void,
): (() => void) | undefined {
  return oomWatches.get(child)?.(listener);
}

/** Installed by the server; standalone SDK consumers keep their ordinary launch. */
export interface ChildWorkloadLaunch {
  watchOomKills?: OomKillWatch;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  started(pid: number): void;
  close(): Promise<void>;
  outcome?: Promise<ChildWorkloadOutcome | undefined>;
}

type WorkloadLauncher = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => ChildWorkloadLaunch;

let launcher: WorkloadLauncher | undefined;
const processes = new Map<number, ChildWorkloadLaunch>();

export function installChildWorkloadLauncher(value: WorkloadLauncher): void {
  launcher = value;
}

export function prepareChildWorkload(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ChildWorkloadLaunch | undefined {
  return launcher?.(command, args, env);
}

export function trackChildWorkload(
  launch: ChildWorkloadLaunch | undefined,
  pid: number | undefined,
): void {
  if (!launch || pid === undefined) return;
  launch.started(pid);
  processes.set(pid, launch);
}

export async function closeChildWorkload(
  pid: number | undefined,
): Promise<void> {
  if (pid === undefined) return;
  const launch = processes.get(pid);
  if (!launch) return;
  await closeTrackedWorkload(launch, pid);
}

async function closeTrackedWorkload(
  launch: ChildWorkloadLaunch,
  pid: number | undefined,
): Promise<void> {
  await launch.close();
  if (pid === undefined) return;
  if (processes.get(pid) === launch) processes.delete(pid);
}

export function spawnChildWorkload(
  command: string,
  args: readonly string[],
  options?: SpawnOptionsWithoutStdio,
  defaultSpawn?: typeof spawn,
): ChildProcessWithoutNullStreams;
export function spawnChildWorkload(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  defaultSpawn?: typeof spawn,
): ChildProcess;
export function spawnChildWorkload(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
  defaultSpawn: typeof spawn = spawn,
): ChildProcess {
  const launch = prepareChildWorkload(command, args, options.env);
  let child: ChildProcess;
  try {
    const spawnProcess = launch ? spawn : defaultSpawn;
    child = spawnProcess(
      launch?.command ?? command,
      launch?.args ?? [...args],
      {
        ...options,
        env: launch?.env ?? options.env,
        windowsHide: true,
      },
    );
  } catch (error) {
    void launch?.close().catch(() => {});
    throw error;
  }
  if (launch?.outcome) outcomes.set(child, launch.outcome);
  if (launch?.watchOomKills) oomWatches.set(child, launch.watchOomKills);
  trackChildWorkload(launch, child.pid);
  const cleanup = () => {
    // The runtime launcher retains and reports a failed cleanup for recovery.
    if (launch) void closeTrackedWorkload(launch, child.pid).catch(() => {});
  };
  child.once('exit', cleanup);
  child.once('error', () => {
    if (child.pid === undefined) cleanup();
  });
  return child;
}

const execFile = promisify(nodeExecFile);

export async function execFileChildWorkload(
  command: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
): Promise<{ stdout: string; stderr: string }> {
  const launch = prepareChildWorkload(command, args, options.env);
  if (!launch)
    return execFile(command, args, { ...options, windowsHide: true });
  let pid: number | undefined;
  try {
    const execution = execFile(launch.command, launch.args, {
      ...options,
      env: launch.env,
      windowsHide: true,
    });
    pid = execution.child.pid;
    trackChildWorkload(launch, pid);
    execution.child.once('exit', () => {
      void closeTrackedWorkload(launch, execution.child.pid).catch(() => {});
    });
    return await execution;
  } finally {
    await closeTrackedWorkload(launch, pid);
  }
}

/** Both supported MCP SDKs expose this public transport lifecycle. */
export function ownWorkloadTransport<
  T extends {
    readonly pid: number | null;
    start(): Promise<void>;
    close(): Promise<void>;
    onclose?: () => void;
  },
>(transport: T, launch: ChildWorkloadLaunch | undefined): T {
  if (!launch) return transport;
  const start = transport.start.bind(transport);
  const close = transport.close.bind(transport);
  let pid: number | undefined;
  transport.start = async () => {
    try {
      const onclose = transport.onclose;
      transport.onclose = () => {
        void closeTrackedWorkload(launch, pid).catch(() => {});
        onclose?.();
      };
      const starting = start();
      pid = transport.pid ?? undefined;
      trackChildWorkload(launch, pid);
      await starting;
    } catch (error) {
      await closeTrackedWorkload(launch, pid);
      throw error;
    }
  };
  transport.close = async () => {
    try {
      await close();
    } finally {
      await closeTrackedWorkload(launch, pid);
    }
  };
  return transport;
}
