/**
 * Runs expo-device-hub as a supervised child (#1970, D11).
 *
 * The hub is a child process, not imported middleware, because serve-sim
 * loads private CoreSimulator frameworks
 * through a native addon and a crash there must not take the server down;
 * restarts back off by doubling so a hub that dies on boot cannot spin.
 *
 * Station specifics:
 * - Launched through `spawnOwnedChild`, so the orphan registry reaps it if
 *   this server dies without cleanup, with `windowsHide`.
 * - `--host 127.0.0.1 --port 0`: the OS picks a free ephemeral port and the
 *   hub prints it (`Local: http://localhost:<port>`), which avoids the
 *   reserve-then-bind race of choosing a port first.
 * - `running` is claimed only after `/readyz` answered on that port.
 * - The child gets an allowlisted environment: no Station credential or API
 *   key in this process's environment reaches the hub.
 * - Locked down (design amendment round 5): `NODE_OPTIONS=--require` preloads
 *   the guard (`device-hub-guard.ts`) into the hub and every node process it
 *   spawns, with a fresh per-launch secret; a private TMPDIR under
 *   `<STATION_HOME>/devices/run/tmp` keeps serve-sim's helper state
 *   Station's own; helpers are killed on stop, crash and restart; npm's
 *   proxy settings point at a dead port so a runtime prebuild-install
 *   cannot download anything even if it were started.
 * - Only hub versions the guard was verified against are launched.
 * - NODE_OPTIONS reaches every child the hub spawns, node or not. Non-node
 *   children (`xcrun`, `adb`, the emulator, serve-sim's native helpers)
 *   ignore it; any node child honours it and so runs guarded too.
 * - After {@link HUB_MAX_ATTEMPTS} consecutive short-lived runs the state is
 *   `crashed` and restarts stop until a person starts it again.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import type { DeviceHubProcessState } from '@kontourai/station-contracts/device-toolchain';
import { spawnOwnedChild } from '../../infra/process-utils.js';
import {
  createDeviceHubConnection,
  type DeviceHubConnection,
  HUB_SECRET_HEADER,
} from './device-hub-connection.js';
import {
  buildHubGuardSource,
  HUB_GUARD_SECRET_ENV,
  HUB_GUARD_VERIFIED_VERSIONS,
} from './device-hub-guard.js';
import {
  hubTmpDir,
  type KillHubHelper,
  killOwnedHubHelper,
  readHubHelpers,
} from './device-hub-helpers.js';

const HUB_INITIAL_DELAY_MS = 1_000;
const HUB_MAX_DELAY_MS = 30_000;
const HUB_STABLE_UPTIME_MS = 60_000;
const HUB_MAX_ATTEMPTS = 5;
const HUB_READY_TIMEOUT_MS = 30_000;
const HUB_STOP_GRACE_MS = 3_000;
/** How long a listener-port read is reused (hub lockdown N3). */
const PORTS_CACHE_MS = 500;
const LISTENING = /Local:\s+http:\/\/(?:localhost|127\.0\.0\.1):([0-9]{1,5})\b/;

/** The environment variables the hub may see. Everything else is dropped. */
export const HUB_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'JAVA_HOME',
  'DEVELOPER_DIR',
  'SystemRoot',
  'windir',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'ProgramFiles',
];

export function deviceHubEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of HUB_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** A dead loopback port: npm/prebuild-install downloads cannot go anywhere. */
const NO_DOWNLOADS_PROXY = 'http://127.0.0.1:9';

/**
 * Environment the hub gets beyond the allowlist, the guard preload and its
 * private temp directory. Shared with SSH device hosts (#1973), which launch
 * the same hub the same way on another machine.
 */
export const HUB_EXTRA_ENV: Readonly<Record<string, string>> = {
  npm_config_offline: 'true',
  npm_config_proxy: NO_DOWNLOADS_PROXY,
  npm_config_https_proxy: NO_DOWNLOADS_PROXY,
};

/** The hub's arguments after its entry script (local and SSH hosts alike). */
export const HUB_LAUNCH_ARGS: readonly string[] = [
  '--host',
  '127.0.0.1',
  '--port',
  '0',
  '--transport',
  'mjpeg',
  '--hide-sidebar',
  '--hide-boot-device',
];

/** The hub's full environment: allowlist + guard preload + private temp. */
export function deviceHubLaunchEnvironment(
  source: NodeJS.ProcessEnv,
  launch: { guardPath: string; secret: string; tmpDir: string },
): NodeJS.ProcessEnv {
  return {
    ...deviceHubEnvironment(source),
    NODE_OPTIONS: `--require ${JSON.stringify(launch.guardPath)}`,
    [HUB_GUARD_SECRET_ENV]: launch.secret,
    TMPDIR: launch.tmpDir,
    TMP: launch.tmpDir,
    TEMP: launch.tmpDir,
    ...HUB_EXTRA_ENV,
  };
}

/** The slice of a child process the supervisor drives. */
export interface SupervisedChild {
  readonly pid: number | undefined;
  readonly stdout: Readable | null;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  onError(listener: (error: Error) => void): void;
  terminate(signal: 'SIGTERM' | 'SIGKILL'): void;
  /** Remove the orphan-registry record after a graceful stop. */
  release(): void;
}

export type SpawnHubChild = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => SupervisedChild;

const spawnOwnedHubChild: SpawnHubChild = (command, args, options) => {
  const { proc, release } = spawnOwnedChild(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return {
    pid: proc.pid,
    stdout: proc.stdout,
    onExit: (listener) => {
      proc.once('exit', (code, signal) => listener(code, signal));
    },
    onError: (listener) => {
      proc.once('error', listener);
    },
    terminate: (signal) => {
      try {
        // A detached child leads its own process group on POSIX: signal the
        // group so the hub's serve-sim/serve-emu helpers go with it.
        if (process.platform !== 'win32' && typeof proc.pid === 'number')
          process.kill(-proc.pid, signal);
        else proc.kill(signal);
      } catch {
        // Already gone.
      }
    },
    release,
  };
};

export interface HubLaunch {
  /** Absolute entry script of the installed hub. */
  entry: string;
  /** Directory the hub runs from (its install directory). */
  cwd: string;
  version: string;
  /** Station-owned run directory: guard file and the hub's private TMPDIR. */
  runDir: string;
}

export interface DeviceHubSupervisorOptions {
  /** The installed hub to run, or undefined when none is installed. */
  resolveLaunch: () => HubLaunch | undefined;
  spawn?: SpawnHubChild;
  nodePath?: string;
  /** Resolves true once `<baseUrl>/readyz` answered 200 (with `headers`). */
  probeReady?: (
    baseUrl: string,
    signal: AbortSignal,
    headers: Record<string, string>,
  ) => Promise<boolean>;
  /** Kills one serve-sim helper this hub install started. */
  killHelper?: KillHubHelper;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  readyTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

async function defaultProbeReady(
  baseUrl: string,
  signal: AbortSignal,
  headers: Record<string, string>,
): Promise<boolean> {
  while (!signal.aborted) {
    try {
      const response = await fetch(`${baseUrl}/readyz`, {
        redirect: 'error',
        signal,
        headers,
      });
      await response.body?.cancel().catch(() => {});
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

class DeviceHubStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceHubStartError';
  }
}

interface Running {
  child: SupervisedChild;
  connection: ReturnType<typeof createDeviceHubConnection>;
  launch: HubLaunch;
  port: number;
  startedAtMs: number;
}

export class DeviceHubSupervisor {
  readonly #options: Required<
    Omit<DeviceHubSupervisorOptions, 'resolveLaunch' | 'env'>
  > &
    Pick<DeviceHubSupervisorOptions, 'resolveLaunch' | 'env'>;
  #state: DeviceHubProcessState = { state: 'stopped' };
  #running: Running | undefined;
  #starting: Promise<DeviceHubConnection> | undefined;
  #timer: unknown;
  #attempts = 0;
  #stopped = false;
  /** Increments on stop; a start from an earlier generation abandons itself. */
  #generation = 0;
  /** The most recent launch, so its helpers stay known after a crash. */
  #lastLaunch: HubLaunch | undefined;
  #portsCache: { at: number; ports: number[] } | undefined;

  constructor(options: DeviceHubSupervisorOptions) {
    this.#options = {
      resolveLaunch: options.resolveLaunch,
      spawn: options.spawn ?? spawnOwnedHubChild,
      nodePath: options.nodePath ?? process.execPath,
      probeReady: options.probeReady ?? defaultProbeReady,
      now: options.now ?? Date.now,
      setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer:
        options.clearTimer ??
        ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
      readyTimeoutMs: options.readyTimeoutMs ?? HUB_READY_TIMEOUT_MS,
      killHelper: options.killHelper ?? killOwnedHubHelper,
      env: options.env,
    };
  }

  /**
   * Every port the managed hub and its stream helpers listen on, read LIVE
   * (never cached across restarts): the host browser must never reach them.
   */
  listeningPorts(): number[] {
    // Read on every egress decision; a short cache keeps that off the disk
    // without letting a new helper's port go undenied for more than a moment.
    const now = this.#options.now();
    if (this.#portsCache && now - this.#portsCache.at < PORTS_CACHE_MS)
      return [...this.#portsCache.ports];
    const ports = new Set<number>();
    if (this.#running) ports.add(this.#running.port);
    if (this.#lastLaunch)
      for (const helper of readHubHelpers(this.#lastLaunch.runDir))
        ports.add(helper.port);
    const sorted = [...ports].sort((a, b) => a - b);
    this.#portsCache = { at: now, ports: sorted };
    return [...sorted];
  }

  /** Kill every helper this hub install started (stop, crash, restart). */
  async #killHelpers(launch: HubLaunch | undefined): Promise<void> {
    if (!launch) return;
    for (const helper of readHubHelpers(launch.runDir)) {
      try {
        await this.#options.killHelper(helper, dirname(launch.cwd));
      } catch {
        // Best effort per helper; the next stop or start tries again.
      }
    }
  }

  state(): DeviceHubProcessState {
    return this.#state;
  }

  /** The live connection, only while the hub is running and answered. */
  connection(): DeviceHubConnection | undefined {
    return this.#running?.connection.ready
      ? this.#running.connection
      : undefined;
  }

  runningVersion(): string | null {
    return this.connection()?.version ?? null;
  }

  runningInstallDir(): string | undefined {
    return this.#running?.launch.cwd;
  }

  /**
   * Start the hub if it is not running (also after `crashed`, which a person
   * asked to clear by calling this) and resolve once it answered.
   */
  ensureStarted(): Promise<DeviceHubConnection> {
    const live = this.connection();
    if (live) return Promise.resolve(live);
    if (this.#starting) return this.#starting;
    this.#stopped = false;
    if (this.#state.state === 'crashed' || this.#state.state === 'stopped')
      this.#attempts = 0;
    if (this.#timer !== undefined) {
      this.#options.clearTimer(this.#timer);
      this.#timer = undefined;
    }
    return this.#start();
  }

  /** Stop and start again, e.g. after an update installed a new version. */
  async restart(): Promise<DeviceHubConnection> {
    await this.stop();
    return this.ensureStarted();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#generation += 1;
    if (this.#timer !== undefined) {
      this.#options.clearTimer(this.#timer);
      this.#timer = undefined;
    }
    const running = this.#running;
    this.#running = undefined;
    this.#starting = undefined;
    this.#portsCache = undefined;
    this.#state = { state: 'stopped' };
    if (running) await this.#terminate(running.child);
    running?.connection.markExited('stopped');
    await this.#killHelpers(running?.launch ?? this.#lastLaunch);
  }

  #start(): Promise<DeviceHubConnection> {
    const generation = this.#generation;
    const launch = this.#options.resolveLaunch();
    if (!launch) {
      this.#state = { state: 'stopped' };
      return Promise.reject(
        new DeviceHubStartError('The device hub is not installed.'),
      );
    }
    this.#state = { state: 'starting', version: launch.version };
    const attempt = this.#spawnOnce(launch, generation);
    this.#starting = attempt;
    attempt.then(
      () => {
        if (this.#starting === attempt) this.#starting = undefined;
      },
      (error: unknown) => {
        if (this.#starting === attempt) this.#starting = undefined;
        if (generation === this.#generation)
          this.#scheduleRestart(
            error instanceof Error ? error.message : String(error),
          );
      },
    );
    return attempt;
  }

  async #spawnOnce(
    launch: HubLaunch,
    generation: number,
  ): Promise<DeviceHubConnection> {
    if (!HUB_GUARD_VERIFIED_VERSIONS.includes(launch.version))
      throw new DeviceHubStartError(
        `Station's hub guard was not verified for expo-device-hub ${launch.version}; it will not run unguarded.`,
      );
    this.#lastLaunch = launch;
    // Helpers left behind by an earlier run (a crash, a SIGKILLed Station).
    await this.#killHelpers(launch);
    const secret = randomBytes(32).toString('hex');
    const tmpDir = hubTmpDir(launch.runDir);
    const guardPath = join(launch.runDir, 'hub-guard.cjs');
    let child: SupervisedChild;
    try {
      mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      writeFileSync(guardPath, buildHubGuardSource(), { mode: 0o600 });
      child = this.#options.spawn(
        this.#options.nodePath,
        [launch.entry, ...HUB_LAUNCH_ARGS],
        {
          cwd: launch.cwd,
          env: deviceHubLaunchEnvironment(this.#options.env ?? process.env, {
            guardPath,
            secret,
            tmpDir,
          }),
        },
      );
    } catch (error) {
      throw new DeviceHubStartError(
        `The device hub could not be started: ${(error as Error).message}`,
      );
    }
    const abort = new AbortController();
    let exited = false;
    const exit = new Promise<never>((_, reject) => {
      child.onError((error) => {
        exited = true;
        reject(
          new DeviceHubStartError(
            `The device hub failed to start: ${error.message}`,
          ),
        );
      });
      child.onExit((code, signal) => {
        exited = true;
        reject(
          new DeviceHubStartError(
            `The device hub exited (${code ?? signal}) before it was ready.`,
          ),
        );
      });
    });
    exit.catch(() => {});
    const timeout = new Promise<never>((_, reject) => {
      const handle = this.#options.setTimer(() => {
        reject(
          new DeviceHubStartError(
            `The device hub did not answer within ${this.#options.readyTimeoutMs} ms.`,
          ),
        );
      }, this.#options.readyTimeoutMs);
      abort.signal.addEventListener('abort', () =>
        this.#options.clearTimer(handle),
      );
    });
    timeout.catch(() => {});
    try {
      const port = await Promise.race([
        readListeningPort(child.stdout),
        exit,
        timeout,
      ]);
      if (port < 1025 || port > 65535 || port === 3000 || port === 3141)
        throw new DeviceHubStartError(
          `The device hub bound an unusable port (${port}).`,
        );
      const connection = createDeviceHubConnection({
        port,
        version: launch.version,
        secret,
      });
      const ready = await Promise.race([
        this.#options.probeReady(connection.baseUrl, abort.signal, {
          [HUB_SECRET_HEADER]: secret,
        }),
        exit,
        timeout,
      ]);
      if (!ready)
        throw new DeviceHubStartError('The device hub never reported ready.');
      if (generation !== this.#generation)
        throw new DeviceHubStartError('The device hub start was cancelled.');
      const running: Running = {
        child,
        connection,
        launch,
        port,
        startedAtMs: this.#options.now(),
      };
      this.#running = running;
      this.#portsCache = undefined;
      this.#state = {
        state: 'running',
        version: launch.version,
        startedAt: new Date(running.startedAtMs).toISOString(),
      };
      child.onExit((code, signal) =>
        this.#onUnexpectedExit(running, `exited (${code ?? signal})`),
      );
      return connection;
    } catch (error) {
      if (!exited) await this.#terminate(child);
      else child.release();
      throw error;
    } finally {
      abort.abort();
    }
  }

  #onUnexpectedExit(running: Running, reason: string): void {
    if (this.#running !== running) return;
    this.#running = undefined;
    this.#portsCache = undefined;
    running.child.release();
    running.connection.markExited(reason);
    // A helper outlives its hub; a crashed hub's helpers go with it.
    void this.#killHelpers(running.launch);
    if (this.#stopped) return;
    if (this.#options.now() - running.startedAtMs >= HUB_STABLE_UPTIME_MS)
      this.#attempts = 0;
    this.#scheduleRestart(`The device hub ${reason}.`);
  }

  #scheduleRestart(detail: string): void {
    if (this.#stopped) return;
    this.#attempts += 1;
    if (this.#attempts >= HUB_MAX_ATTEMPTS) {
      this.#state = { state: 'crashed', attempts: this.#attempts, detail };
      return;
    }
    const delay = Math.min(
      HUB_INITIAL_DELAY_MS * 2 ** (this.#attempts - 1),
      HUB_MAX_DELAY_MS,
    );
    this.#state = {
      state: 'restarting',
      attempt: this.#attempts,
      retryAt: new Date(this.#options.now() + delay).toISOString(),
    };
    this.#timer = this.#options.setTimer(() => {
      this.#timer = undefined;
      if (this.#stopped || this.#starting || this.#running) return;
      this.#start().catch(() => {});
    }, delay);
  }

  async #terminate(child: SupervisedChild): Promise<void> {
    await new Promise<void>((resolve) => {
      let done = false;
      let handle: unknown;
      const finish = () => {
        if (done) return;
        done = true;
        if (handle !== undefined) this.#options.clearTimer(handle);
        resolve();
      };
      child.onExit(finish);
      child.terminate('SIGTERM');
      if (!done)
        handle = this.#options.setTimer(() => {
          child.terminate('SIGKILL');
          finish();
        }, HUB_STOP_GRACE_MS);
    });
    child.release();
  }
}

/** Resolve the port the hub printed, reading its stdout line by line. */
function readListeningPort(stdout: Readable | null): Promise<number> {
  return new Promise((resolve, reject) => {
    if (!stdout) {
      reject(new DeviceHubStartError('The device hub has no output to read.'));
      return;
    }
    let buffered = '';
    const onData = (chunk: Buffer | string) => {
      buffered = (buffered + chunk.toString()).slice(-4096);
      const match = LISTENING.exec(buffered);
      if (match) {
        stdout.off('data', onData);
        // Keep draining so a chatty hub never blocks on a full pipe.
        stdout.resume();
        resolve(Number(match[1]));
      }
    };
    stdout.on('data', onData);
  });
}
