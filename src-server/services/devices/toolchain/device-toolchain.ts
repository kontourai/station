/**
 * Consent-gated, pinned installs of the device tools (#1970, D11).
 *
 * Adapted from t3code's `apps/server/src/device/DeviceToolchain.ts` and
 * `deviceToolMaintenance.ts` (MIT, © 2026 T3 Tools Inc.): stage into a temp
 * sibling, write a sentinel only after the install is verified, then rename
 * into place; read versions without installing or starting anything; reclaim
 * obsolete installs only when nothing runs from them. Station differs in
 * three ways: the install is `npm ci` from a pinned lockfile, so npm checks
 * every fetched tarball against its pinned sha512 before extracting it;
 * lifecycle scripts never run (`--ignore-scripts`); and Station verifies the
 * result itself rather than trusting npm's exit code: the tree's shape and
 * recorded integrities against the lockfile, and the tool's own package
 * re-hashed file by file against the pinned tarball
 * (`device-tool-verify.ts` says exactly what each check establishes).
 *
 * Layout: `<STATION_HOME>/devices/tools/<name>/<version>/` holding
 * `node_modules/<name>/…` and `.install-complete` (the version).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type {
  DeviceToolchainVersions,
  DeviceToolFailure,
  DeviceToolId,
  DeviceToolInstallPhase,
  DeviceToolState,
} from '@kontourai/station-contracts/device-toolchain';
import {
  assertPinnedLock,
  DEVICE_TOOL_PINS,
  type DeviceToolPin,
} from './device-tool-pins.js';
import { verifyInstalledTree } from './device-tool-verify.js';

const DEVICE_TOOL_IDS: readonly DeviceToolId[] = [
  'expo-device-hub',
  'agent-device',
];

const SENTINEL = '.install-complete';
const VERSION_DIR = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/;
const PHASES: readonly DeviceToolInstallPhase[] = [
  'preparing',
  'downloading',
  'verifying',
  'publishing',
];
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const DETAIL_BYTES = 2048;

/** Refusal of an install request that did not carry explicit consent. */
export class DeviceToolConsentRequiredError extends Error {
  constructor() {
    super('Installing device tools requires explicit consent.');
    this.name = 'DeviceToolConsentRequiredError';
  }
}

/**
 * Runs the package manager in `dir`, which already holds the pinned
 * `package.json` and `package-lock.json`. Must not run lifecycle scripts and
 * must not resolve anything the lockfile does not pin.
 */
export interface DeviceToolInstaller {
  run(request: { dir: string; signal: AbortSignal }): Promise<void>;
}

export class DeviceToolInstallError extends Error {
  constructor(
    readonly reason: DeviceToolFailure,
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'DeviceToolInstallError';
  }
}

function toolRoot(stationHome: string, tool: DeviceToolId): string {
  return join(stationHome, 'devices', 'tools', tool);
}

function tail(chunks: Buffer[]): string {
  const text = Buffer.concat(chunks).toString('utf8');
  return text.length > DETAIL_BYTES ? text.slice(-DETAIL_BYTES) : text;
}

/**
 * The npm Station can run without a shell: the `npm-cli.js` that ships beside
 * this Node runtime, else `npm` on PATH (POSIX only — Windows' `npm.cmd`
 * needs a shell, which this never uses). Undefined when neither exists.
 */
export function resolveNpmCommand(
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
  pathEnv: string | undefined = process.env.PATH,
): { command: string; prefixArgs: string[] } | undefined {
  const binDir = dirname(execPath);
  const candidates =
    platform === 'win32'
      ? [join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
      : [
          join(
            dirname(binDir),
            'lib',
            'node_modules',
            'npm',
            'bin',
            'npm-cli.js',
          ),
        ];
  const cli = candidates.find(exists);
  if (cli) return { command: execPath, prefixArgs: [cli] };
  if (platform === 'win32') return undefined;
  const onPath = (pathEnv ?? '')
    .split(':')
    .filter((dir) => dir.startsWith('/'))
    .map((dir) => join(dir, 'npm'))
    .find(exists);
  return onPath ? { command: onPath, prefixArgs: [] } : undefined;
}

/** Production installer: `npm ci` against the pinned lockfile. */
/** Environment variables npm may see; Station credentials never reach it. */
const NPM_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'windir',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'ProgramFiles',
  // A corporate network may need its proxy or CA to reach the registry;
  // content is still checked against the pinned integrities.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
];

function npmInstallEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of NPM_ENV_ALLOWLIST)
    if (source[key] !== undefined) env[key] = source[key];
  env.npm_config_ignore_scripts = 'true';
  return env;
}

type SpawnInstaller = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    stdio: ['ignore', 'ignore', 'pipe'];
    windowsHide: true;
    env: NodeJS.ProcessEnv;
  },
) => ReturnType<typeof spawn>;

export function createNpmCiInstaller(
  options: {
    resolveNpm?: () => { command: string; prefixArgs: string[] } | undefined;
    timeoutMs?: number;
    spawn?: SpawnInstaller;
    env?: NodeJS.ProcessEnv;
  } = {},
): DeviceToolInstaller {
  const resolveNpm = options.resolveNpm ?? (() => resolveNpmCommand());
  const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS;
  const spawnChild: SpawnInstaller = options.spawn ?? spawn;
  return {
    run: ({ dir, signal }) =>
      new Promise<void>((resolvePromise, reject) => {
        const npm = resolveNpm();
        if (!npm) {
          reject(
            new DeviceToolInstallError(
              'package-manager-unavailable',
              'Station could not find npm beside its Node runtime or on PATH.',
              false,
            ),
          );
          return;
        }
        const stderr: Buffer[] = [];
        const child = spawnChild(
          npm.command,
          [
            ...npm.prefixArgs,
            'ci',
            '--ignore-scripts',
            '--omit=dev',
            '--no-audit',
            '--no-fund',
            '--no-update-notifier',
            '--cache',
            join(dir, '.npm-cache'),
          ],
          {
            cwd: dir,
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true,
            env: npmInstallEnvironment(options.env ?? process.env),
          },
        );
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr.push(chunk);
          if (stderr.length > 64) stderr.shift();
        });
        const stop = () => child.kill('SIGKILL');
        const timer = setTimeout(stop, timeoutMs);
        signal.addEventListener('abort', stop, { once: true });
        const settle = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', stop);
        };
        child.once('error', (error) => {
          settle();
          reject(
            new DeviceToolInstallError(
              'install-failed',
              `npm could not start: ${error.message}`,
            ),
          );
        });
        child.once('exit', (code, sig) => {
          settle();
          if (code === 0) resolvePromise();
          else
            reject(
              new DeviceToolInstallError(
                'install-failed',
                `npm ci exited ${code ?? sig}. ${tail(stderr)}`.trim(),
              ),
            );
        });
      }),
  };
}

interface InstallProgress {
  phase: DeviceToolInstallPhase;
  startedAt: string;
  done: Promise<void>;
  abort: AbortController;
}

export interface DeviceToolchainOptions {
  stationHome: string;
  installer: DeviceToolInstaller;
  pins?: Readonly<Record<DeviceToolId, DeviceToolPin>>;
  now?: () => Date;
  /**
   * Command lines of every process on this host, or undefined when they
   * cannot be read (then nothing is reclaimed). Production uses `ps`.
   */
  listProcessCommandLines?: () => Promise<string[] | undefined>;
}

function defaultListProcessCommandLines(): Promise<string[] | undefined> {
  // Windows has no cheap equivalent without PowerShell; reclaim nothing there.
  if (process.platform === 'win32') return Promise.resolve(undefined);
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    const child = spawn('ps', ['-ax', '-o', 'command='], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', () => {
      clearTimeout(timer);
      resolvePromise(undefined);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolvePromise(
        code === 0
          ? Buffer.concat(chunks).toString('utf8').split('\n')
          : undefined,
      );
    });
  });
}

export class DeviceToolchain {
  readonly #stationHome: string;
  readonly #installer: DeviceToolInstaller;
  readonly #pins: Readonly<Record<DeviceToolId, DeviceToolPin>>;
  readonly #now: () => Date;
  readonly #listProcesses: () => Promise<string[] | undefined>;
  readonly #installing = new Map<DeviceToolId, InstallProgress>();
  readonly #failures = new Map<
    DeviceToolId,
    Extract<DeviceToolState, { state: 'failed' }>
  >();
  /** Serializes installs and reclamation: one maintenance at a time. */
  #maintenance: Promise<unknown> = Promise.resolve();

  constructor(options: DeviceToolchainOptions) {
    this.#stationHome = options.stationHome;
    this.#installer = options.installer;
    this.#pins = options.pins ?? DEVICE_TOOL_PINS;
    this.#now = options.now ?? (() => new Date());
    this.#listProcesses =
      options.listProcessCommandLines ?? defaultListProcessCommandLines;
  }

  pin(tool: DeviceToolId): DeviceToolPin {
    return this.#pins[tool];
  }

  installDir(tool: DeviceToolId, version = this.#pins[tool].version): string {
    return join(toolRoot(this.#stationHome, tool), version);
  }

  /** The entry script of the REQUIRED version, when it is installed. */
  installedEntry(tool: DeviceToolId): string | undefined {
    const pin = this.#pins[tool];
    return this.#isComplete(tool, pin.version)
      ? join(this.installDir(tool), 'node_modules', tool, ...pin.entry)
      : undefined;
  }

  #isComplete(tool: DeviceToolId, version: string): boolean {
    const dir = this.installDir(tool, version);
    const pin = this.#pins[tool];
    try {
      return (
        readFileSync(join(dir, SENTINEL), 'utf8').trim() === version &&
        existsSync(join(dir, 'node_modules', tool, ...pin.entry))
      );
    } catch {
      return false;
    }
  }

  /** Completed installs on disk, ascending. Read-only. */
  installedVersions(tool: DeviceToolId): string[] {
    let names: string[];
    try {
      names = readdirSync(toolRoot(this.#stationHome, tool));
    } catch {
      return [];
    }
    return names
      .filter((name) => VERSION_DIR.test(name))
      .filter((version) => this.#isComplete(tool, version))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  }

  /** Derived from disk and in-flight work; never installs or starts anything. */
  state(tool: DeviceToolId, consented: boolean): DeviceToolState {
    const requiredVersion = this.#pins[tool].version;
    const progress = this.#installing.get(tool);
    if (progress) {
      return {
        tool,
        state: 'installing',
        requiredVersion,
        phase: progress.phase,
        step: PHASES.indexOf(progress.phase) + 1,
        totalSteps: PHASES.length,
        startedAt: progress.startedAt,
      };
    }
    if (this.#isComplete(tool, requiredVersion))
      return { tool, state: 'installed', version: requiredVersion };
    const failure = this.#failures.get(tool);
    if (failure) return failure;
    const older = this.installedVersions(tool).at(-1);
    if (older)
      return {
        tool,
        state: 'update-available',
        installedVersion: older,
        requiredVersion,
      };
    return consented
      ? { tool, state: 'not-installed', requiredVersion }
      : { tool, state: 'needs-consent', requiredVersion };
  }

  /** Read-only version report. `running` comes from the supervisor. */
  versions(
    running: Partial<Record<DeviceToolId, string | null>>,
  ): DeviceToolchainVersions {
    return {
      checkedAt: this.#now().toISOString(),
      tools: DEVICE_TOOL_IDS.map((tool) => ({
        tool,
        required: this.#pins[tool].version,
        installed: this.installedVersions(tool),
        running: running[tool] ?? null,
      })),
    };
  }

  /**
   * Install the required version. `consent` must be the literal `true` the
   * operator gave; anything else throws before any I/O. Returns right after
   * starting, with `completion` settling when the install ends either way.
   */
  install(
    tool: DeviceToolId,
    request: { consent: true },
  ): { completion: Promise<void> } {
    if (request?.consent !== true) throw new DeviceToolConsentRequiredError();
    const existing = this.#installing.get(tool);
    if (existing) return { completion: existing.done };
    if (this.#isComplete(tool, this.#pins[tool].version))
      return { completion: Promise.resolve() };
    this.#failures.delete(tool);
    const progress: InstallProgress = {
      phase: 'preparing',
      startedAt: this.#now().toISOString(),
      done: Promise.resolve(),
      abort: new AbortController(),
    };
    this.#installing.set(tool, progress);
    const run = this.#maintenance.then(() => this.#install(tool, progress));
    this.#maintenance = run.catch(() => {});
    progress.done = run
      .catch((error: unknown) => {
        this.#failures.set(tool, {
          tool,
          state: 'failed',
          requiredVersion: this.#pins[tool].version,
          ...(error instanceof DeviceToolInstallError
            ? {
                reason: error.reason,
                detail: error.message,
                retryable: error.retryable,
              }
            : {
                reason: 'install-failed' as const,
                detail: error instanceof Error ? error.message : String(error),
                retryable: true,
              }),
        });
      })
      .finally(() => {
        if (this.#installing.get(tool) === progress)
          this.#installing.delete(tool);
      });
    return { completion: progress.done };
  }

  async #install(tool: DeviceToolId, progress: InstallProgress): Promise<void> {
    const pin = this.#pins[tool];
    const pinProblem = assertPinnedLock(pin);
    if (pinProblem)
      throw new DeviceToolInstallError('integrity-mismatch', pinProblem, false);
    const root = toolRoot(this.#stationHome, tool);
    mkdirSync(root, { recursive: true });
    const staging = join(
      root,
      `.staging-${pin.version}-${randomBytes(6).toString('hex')}`,
    );
    mkdirSync(staging, { recursive: true });
    try {
      writeFileSync(
        join(staging, 'package.json'),
        `${JSON.stringify({ name: pin.lock.name, private: true, dependencies: { [tool]: pin.version } }, null, 2)}\n`,
      );
      writeFileSync(
        join(staging, 'package-lock.json'),
        `${JSON.stringify(pin.lock, null, 2)}\n`,
      );
      progress.phase = 'downloading';
      await this.#installer.run({
        dir: staging,
        signal: progress.abort.signal,
      });
      progress.phase = 'verifying';
      const problem = verifyInstalledTree(staging, pin);
      if (problem)
        throw new DeviceToolInstallError(problem.reason, problem.message);
      progress.phase = 'publishing';
      rmSync(join(staging, '.npm-cache'), { recursive: true, force: true });
      writeFileSync(join(staging, SENTINEL), `${pin.version}\n`);
      const target = this.installDir(tool);
      rmSync(target, { recursive: true, force: true });
      try {
        renameSync(staging, target);
      } catch (error) {
        throw new DeviceToolInstallError(
          'publish-failed',
          `The verified install could not be moved into place: ${(error as Error).message}`,
        );
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  /**
   * Reclaim managed installs other than the required version, never one in
   * use: `inUse` names directories this Station runs from, and any process on
   * the host whose command line names a directory keeps it. When process
   * command lines cannot be read, nothing is reclaimed. Returns the removed
   * versions.
   */
  reclaimObsolete(
    tool: DeviceToolId,
    inUse: readonly string[],
  ): Promise<string[]> {
    const run = this.#maintenance.then(async () => {
      const required = this.#pins[tool].version;
      const candidates = this.installedVersions(tool).filter(
        (version) => version !== required,
      );
      if (candidates.length === 0) return [];
      const commandLines = await this.#listProcesses();
      if (!commandLines) return [];
      const kept = new Set(inUse.map((dir) => resolve(dir)));
      const removed: string[] = [];
      for (const version of candidates) {
        const dir = this.installDir(tool, version);
        if (kept.has(resolve(dir))) continue;
        if (commandLines.some((line) => line.includes(`${dir}${sep}`)))
          continue;
        try {
          if (!lstatSync(dir).isDirectory()) continue;
        } catch {
          continue;
        }
        rmSync(dir, { recursive: true, force: true });
        removed.push(version);
      }
      return removed;
    });
    this.#maintenance = run.catch(() => {});
    return run;
  }

  /**
   * Remove `.staging-*` directories an interrupted install left behind. Only
   * ones older than an hour, so a concurrent install is never pulled out
   * from under itself.
   */
  removeStaleStaging(maxAgeMs = 60 * 60 * 1000): string[] {
    const removed: string[] = [];
    const cutoff = this.#now().getTime() - maxAgeMs;
    for (const tool of DEVICE_TOOL_IDS) {
      const root = toolRoot(this.#stationHome, tool);
      let names: string[];
      try {
        names = readdirSync(root);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.startsWith('.staging-')) continue;
        const dir = join(root, name);
        try {
          if (lstatSync(dir).mtimeMs > cutoff) continue;
        } catch {
          continue;
        }
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    }
    return removed;
  }

  /** Abort in-flight installs (server shutdown). */
  abort(): void {
    for (const progress of this.#installing.values()) progress.abort.abort();
  }
}
