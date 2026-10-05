/**
 * The full Windows install and uninstall (#2675 slice W2): install.sh's
 * archive install for a host with no Station service, in the same
 * variables, files and messages. After install.ts has staged and verified a
 * version, this makes it the active install:
 *
 * - `current`, a directory junction to `versions\<version>` (a junction needs
 *   no privilege, unlike a directory symlink), switched by
 *   `pointCurrentAt` with a crash-recovery rule;
 * - the owned launcher `<bin>\station[-beta|-nightly].cmd`, recognized by
 *   its exact text;
 * - the schema 4 install state, `.station-release-state.json`, with the
 *   manifest URL and the ports;
 * - the ports: STATION_INSTALL_SERVER_PORT / STATION_INSTALL_UI_PORT, then
 *   the ports this install recorded, then the channel's (decision D8: the
 *   bootstrap's STATION_SERVER_PORT / STATION_UI_PORT are never read);
 * - stop, switch, start, with the previous version restored when any step
 *   fails; then prune every version but the active and the previous one.
 *
 * A Station service in the update path (slice W3): a service runs this
 * install through the fixed launcher, which owns its own switch. A running
 * one is handed the staged version as an update request, and its launcher
 * trials it and keeps or rolls it back; a stopped one is switched with the
 * install and left stopped, its launcher state recording the new version.
 */
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { STATION_CHANNEL_PORTS_DATA } from '../channel-ports.generated.js';
import { renamePathSyncRetrying } from '../fs-windows-compat.js';
import {
  ServiceUpdateAlreadyRequestedError,
  serviceUpdatePaths,
  writeServiceUpdateRequest,
} from '../service-launcher-protocol.js';
import {
  assertWindowsPathsTrusted,
  runWindowsTrustCommand,
} from '../windows-path-trust.js';
import {
  activeVersionDir,
  assertSafeRemoveTarget,
  type Context,
  canonicalize,
  DATA_ROOT_MARKER,
  DATA_ROOT_SIGNATURE,
  fail,
  INSTALL_ROOT_MARKER,
  INSTALL_ROOT_SIGNATURE,
  type InstallerEnv,
  InstallRefusal,
  inside,
  installRootTrustProblem,
  isLink,
  owner,
  type Paths,
  type PreparedRelease,
  plainPowerShellMessage,
  prepareOwnedInstallRoot,
  prepareOwnedRoot,
  prepareRelease,
  prepareSafeDirectory,
  RINGS,
  readChannel,
  readStageRequest,
  removeInstallRoot,
  removeTree,
  resolvePaths,
  same,
  sealTree,
  versionPaths,
} from './install.js';

const CURRENT_NEXT = 'current.next';

/**
 * Points `<install root>\current` at `target`. On POSIX a link renamed over
 * `current` replaces it atomically. Windows cannot rename over a directory
 * or junction, so there `current` is removed and `current.next` renamed into
 * its place; a crash between the two leaves only `current.next`, which
 * `recoverCurrent` finishes.
 */
export function pointCurrentAt(
  installRoot: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const current = join(installRoot, 'current');
  const next = join(installRoot, CURRENT_NEXT);
  if (isLink(next)) unlinkSync(next);
  // 'junction' is ignored off Windows, where this makes a symlink.
  symlinkSync(target, next, 'junction');
  if (platform === 'win32' && isLink(current)) unlinkSync(current);
  renamePathSyncRetrying(next, current, { platform });
}

/**
 * Finishes a switch a crash interrupted (see pointCurrentAt): with no
 * `current`, a `current.next` becomes it. With both, `current` stands and
 * the stale `current.next` goes.
 */
export function recoverCurrent(
  installRoot: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const current = join(installRoot, 'current');
  const next = join(installRoot, CURRENT_NEXT);
  if (!isLink(next)) return;
  if (isLink(current) || existsSync(current)) unlinkSync(next);
  else renamePathSyncRetrying(next, current, { platform });
}

function removeCurrent(installRoot: string): void {
  const current = join(installRoot, 'current');
  if (isLink(current)) unlinkSync(current);
}

/**
 * The owned launcher's exact text. cmd.exe reads a batch file in the OEM code
 * page, so the file must be ASCII: a path beneath the user profile (the
 * install root always is) is written relative to %USERPROFILE%, which cmd.exe
 * expands from the Unicode environment, so a profile such as C:\Users\José
 * works. Any other non-ASCII path is refused, as is `%`, `^` or a quote,
 * which a batch file cannot hold literally.
 *
 * The last line hands over to the version's bin\station.cmd without CALL:
 * control transfers to it and `%*` is expanded once, so the caller's
 * arguments arrive unchanged (CALL would double `^` and expand `%` again).
 * The SETLOCAL environment stays in effect for the batch file it transfers
 * to, and that file's own `exit /b` sets the exit status.
 */
export function launcherText(
  paths: Paths,
  profile: string = canonicalize(homedir()),
): string {
  const render = (value: string): string => {
    const underProfile =
      inside(value, profile) && value.length > profile.length;
    const literal = underProfile ? value.slice(profile.length) : value;
    if (/[%^"\r\n]/.test(literal))
      fail(
        `a Station path contains a character the Windows launcher cannot quote (% ^ or a quote): ${value}`,
      );
    if (/[^\x20-\x7e]/.test(literal))
      fail(
        `a Station path has a non-ASCII part the Windows launcher cannot hold (cmd.exe reads it in the console code page): ${value}; choose a path whose part beneath your profile, or the whole path outside it, is ASCII`,
      );
    return underProfile ? `%USERPROFILE%${literal}` : literal;
  };
  return [
    '@echo off',
    'rem station-owned-launcher-v2',
    'setlocal EnableExtensions DisableDelayedExpansion',
    `set "STATION_CHANNEL=${paths.channel}"`,
    `set "STATION_ROOT=${render(paths.stationRoot)}"`,
    `set "STATION_HOME=${render(paths.stationHome)}"`,
    `set "STATION_INSTALL_ROOT=${render(paths.installRoot)}"`,
    `"${render(join(paths.current, 'bin', 'station.cmd'))}" %*`,
    '',
  ].join('\r\n');
}

/**
 * The version `current` names, which must be a directory of this install's
 * `versions`: its runtime\node.exe is about to run, so a `current` pointing
 * anywhere else is refused.
 */
function activeInstalledVersion(paths: Paths): string | null {
  const active = activeVersionDir(paths.current);
  const versions = canonicalize(paths.versions);
  if (active !== null && (!inside(active, versions) || same(active, versions)))
    fail(
      `${paths.current} points outside ${paths.versions}; refusing to run anything from it`,
    );
  return active;
}

/**
 * An install root that already exists is checked before anything in it is
 * read, recovered or run: it must be this installer's and, on Windows,
 * restricted to the current user.
 */
function assertExistingInstallRoot(paths: Paths, env: InstallerEnv): void {
  if (existsSync(paths.installRoot) || isLink(paths.installRoot))
    prepareOwnedInstallRoot(paths.installRoot, env);
}

function launcherIsOwned(paths: Paths): boolean {
  try {
    const info = lstatSync(paths.launcher);
    return (
      info.isFile() &&
      !info.isSymbolicLink() &&
      readFileSync(paths.launcher, 'utf8') === launcherText(paths)
    );
  } catch {
    return false;
  }
}

function writeExclusive(path: string, text: string, mode: number): void {
  const fd = openSync(path, 'wx', mode);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readIfPresent(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Puts `bytes` back at `path`, or removes `path` when there were none. */
function restoreFile(path: string, bytes: Buffer | null, mode: number): void {
  if (bytes === null) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  const stage = `${path}.restore.${process.pid}`;
  if (existsSync(stage)) unlinkSync(stage);
  writeExclusive(stage, bytes.toString('utf8'), mode);
  renamePathSyncRetrying(stage, path);
}

type Ports = { server: number; ui: number };

/** The ports an install state file's bytes record, or null. */
function portsOf(state: Buffer | null): Ports | null {
  try {
    const value = JSON.parse(state?.toString('utf8') ?? 'null');
    return Number.isInteger(value?.serverPort) &&
      Number.isInteger(value?.uiPort)
      ? { server: value.serverPort, ui: value.uiPort }
      : null;
  } catch {
    return null;
  }
}

function parsePort(value: string): number {
  if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65_535)
    fail(`invalid Station port: ${value}`);
  return Number(value);
}

/**
 * The ports this install recorded, validated as install.sh validates its
 * state: null when there is no state or it predates recorded ports.
 */
function readRecordedPorts(paths: Paths): Ports | null {
  if (!existsSync(paths.stateFile) && !isLink(paths.stateFile)) return null;
  const malformed: () => never = () =>
    fail('existing install channel state is unsafe or malformed');
  let value: Record<string, unknown>;
  try {
    const info = lstatSync(paths.stateFile);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (owner !== null && (info.uid !== owner || (info.mode & 0o077) !== 0))
    )
      malformed();
    value = JSON.parse(readFileSync(paths.stateFile, 'utf8'));
  } catch (error) {
    if (error instanceof InstallRefusal) throw error;
    malformed();
  }
  const ring =
    typeof value?.releaseChannel === 'string' &&
    Object.hasOwn(RINGS, value.releaseChannel)
      ? RINGS[value.releaseChannel]
      : undefined;
  if (
    ![3, 4].includes(value?.schemaVersion as number) ||
    (value.schemaVersion === 4 &&
      value.manifestUrl !== null &&
      typeof value.manifestUrl !== 'string') ||
    !ring ||
    value.channel !== ring.runtimeChannel ||
    typeof value.installRoot !== 'string' ||
    typeof value.stationHome !== 'string' ||
    typeof value.stationRoot !== 'string'
  )
    malformed();
  if (
    value.channel !== paths.channel ||
    value.releaseChannel !== paths.ring ||
    value.installRoot !== paths.installRoot ||
    value.stationRoot !== paths.stationRoot ||
    value.stationHome !== paths.stationHome
  )
    fail(
      'existing install state does not match this verified channel root; remove the explicit root override or reinstall into a new scoped root',
    );
  if (value.serverPort === undefined && value.uiPort === undefined) return null;
  const port = (candidate: unknown) =>
    Number.isInteger(candidate) &&
    (candidate as number) >= 1 &&
    (candidate as number) <= 65_535;
  if (!port(value.serverPort) || !port(value.uiPort)) malformed();
  return { server: value.serverPort as number, ui: value.uiPort as number };
}

/**
 * An explicit STATION_INSTALL_*_PORT wins, then the recorded port (a custom
 * port survives an upgrade that does not repeat it), then the channel's.
 * The bootstrap's STATION_SERVER_PORT / STATION_UI_PORT are never read
 * (decision D8, #2954): the CLI sets them to channel defaults.
 */
export function resolvePorts(
  env: InstallerEnv,
  channel: string,
  recorded: Ports | null,
): Ports {
  const defaults =
    STATION_CHANNEL_PORTS_DATA[
      channel as keyof typeof STATION_CHANNEL_PORTS_DATA
    ];
  return {
    server: env.STATION_INSTALL_SERVER_PORT
      ? parsePort(env.STATION_INSTALL_SERVER_PORT)
      : (recorded?.server ?? defaults.serverPort),
    ui: env.STATION_INSTALL_UI_PORT
      ? parsePort(env.STATION_INSTALL_UI_PORT)
      : (recorded?.ui ?? defaults.uiPort),
  };
}

type ArchiveService = { id: string; launcher: boolean };

/**
 * Station services whose manifest says they run this install root's
 * `current` (the rule of install.sh's list_archive_services). A manifest
 * that cannot be read might be one of them, so it stops the run. `launcher`:
 * the service runs the fixed launcher with the node.exe frozen beside it
 * (`service install` since slice W3), not a version directly.
 */
function archiveServicesOf(paths: Paths): ArchiveService[] {
  const directory = join(paths.stationHome, 'service');
  if (!existsSync(directory)) return [];
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const services: ArchiveService[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.json')) continue;
    const file = join(directory, name);
    let manifest: Record<string, unknown> | null;
    try {
      manifest = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      manifest = null;
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
      fail(
        `unreadable Station service manifest: ${file}; cannot tell which Station services run this install, so nothing was changed`,
      );
    if (
      manifest.platform !== process.platform ||
      manifest.kind !== 'archive' ||
      typeof manifest.installRoot !== 'string' ||
      !same(real(manifest.installRoot), real(paths.installRoot))
    )
      continue;
    const id = manifest.instanceId;
    if (typeof id !== 'string' || !/^[a-z0-9._][a-z0-9._-]*$/.test(id))
      fail(
        `Station service manifest names an invalid instance: ${file}; nothing was changed`,
      );
    services.push({
      id,
      launcher:
        typeof manifest.nodePath === 'string' &&
        same(
          manifest.nodePath,
          join(manifest.installRoot, 'runtime', LAUNCHER_NODE),
        ),
    });
  }
  return services;
}

/** The node.exe `service install` freezes beside the launcher (W3, D4 a). */
const LAUNCHER_NODE = 'node.exe';

/**
 * Whether a service is running, through the active version's own CLI, as
 * install.sh's service_unit_state reads it: `active`, `registered` (the task
 * exists but is not running) or `absent`. A backend that cannot say stops
 * the run.
 */
function serviceUnitState(
  context: Context,
  dir: string,
  paths: Paths,
  id: string,
): 'active' | 'registered' | 'absent' {
  const { output } = runInstalledCliCapture(
    context,
    dir,
    [
      'service',
      'status',
      `--instance=${id}`,
      `--base=${paths.stationHome}`,
      '--json',
    ],
    paths,
  );
  let unit: Record<string, unknown> | undefined;
  try {
    unit = JSON.parse(output)?.unit;
  } catch {
    unit = undefined;
  }
  if (unit?.active === true) return 'active';
  if (unit?.active === false) {
    if (unit.present === true || unit.enabled === true) return 'registered';
    if (unit.present === false) return 'absent';
  }
  return fail(
    `could not determine whether Station service ${id} is running; nothing was changed (inspect it with: ${paths.launcher} service status --instance=${id})`,
  );
}

/**
 * The launcher's record (`runtime\service-state.json`), checked as install.sh
 * checks it: an update the launcher left unfinished is finished by starting
 * the service, never overwritten from here.
 */
function assertLauncherStateSettled(paths: Paths): boolean {
  const file = join(paths.installRoot, 'runtime', 'service-state.json');
  if (!existsSync(file)) return false;
  let state: { update?: { status?: unknown } };
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fail(
      `the Station service launcher state is unreadable: ${file}; nothing was changed`,
    );
  }
  if (state?.update?.status === 'pending')
    fail(
      `a supervised Station update is unfinished in ${paths.installRoot}; start the Station service to let its launcher finish or roll it back, then retry. Nothing was changed`,
    );
  if (state?.update?.status === 'needs-operator')
    fail(
      `a supervised Station update could not be rolled back in ${paths.installRoot}: the Station service could not restore its home and is stopped (see its log). Fix the cause, then retry the restore with: station service stop --instance=<name> && station service start --instance=<name>; retry this install once the service runs. Nothing was changed`,
    );
  return true;
}

/**
 * Queues an update of the running service to the staged version and waits
 * for the launcher's verdict (install.sh's hand_off_to_launcher): 0 when the
 * service committed it, 1 when it rolled it back or refused it.
 */
async function handOffToLauncher(
  context: Context,
  paths: Paths,
  version: string,
): Promise<number> {
  const { env, io } = context;
  const updatePaths = serviceUpdatePaths(paths.installRoot);
  let id: string;
  try {
    id = writeServiceUpdateRequest(paths.installRoot, version).id;
  } catch (error) {
    if (error instanceof ServiceUpdateAlreadyRequestedError)
      fail('another Station update is already requested for this service');
    throw error;
  }
  io.out(
    `Asked the Station service to switch to ${version}; it trials the new version and keeps the current one if the trial fails.`,
  );
  const timeoutSeconds = Number(
    env.STATION_INSTALL_HANDOFF_TIMEOUT_SECONDS || 1200,
  );
  const deadline = Date.now() + timeoutSeconds * 1000;
  const read = (file: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  for (;;) {
    const result = read(updatePaths.result);
    if (result?.requestId === id) {
      if (result.status === 'up-to-date') {
        io.out(`The Station service already runs ${result.version}.`);
        return 0;
      }
      io.err(
        `The Station service did not update (${result.status}): ${result.reason}`,
      );
      return 1;
    }
    const update = read(updatePaths.state)?.update as
      | Record<string, unknown>
      | undefined;
    if (update?.requestId === id && update.status !== 'pending') {
      if (update.status === 'committed') {
        io.out(`The Station service now runs ${update.targetVersion}.`);
        return 0;
      }
      io.err(
        `The Station service kept ${update.fromVersion}: the update to ${update.targetVersion} ${update.status} (${update.reason}).`,
      );
      return 1;
    }
    if (Date.now() > deadline) {
      io.err(
        `The Station service has not finished the update after ${timeoutSeconds}s; it continues on its own (see station service status).`,
      );
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * After this install switched `current` for a launcher service that is not
 * running, its launcher state must name the same version, or its next start
 * would move `current` back. Written by the service's own fixed launcher
 * code, under its lock (install.sh's record_launcher_active_version).
 */
function recordLauncherActiveVersion(
  context: Context,
  paths: Paths,
  version: string,
): boolean {
  const launcher = join(paths.installRoot, 'runtime', 'station-launcher.mjs');
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        "import { pathToFileURL } from 'node:url';",
        'const { STATION_RECORD_LAUNCHER: launcher, STATION_RECORD_ROOT: root, STATION_RECORD_VERSION: version } = process.env;',
        'const { recordServiceActiveVersion } = await import(pathToFileURL(launcher).href);',
        'try { recordServiceActiveVersion(root, version); } catch (error) { console.error(error.message); process.exit(1); }',
      ].join('\n'),
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      // Through the environment, not argv: the launcher runs itself as a
      // program when argv[1] names it.
      env: {
        ...context.env,
        STATION_RECORD_LAUNCHER: launcher,
        STATION_RECORD_ROOT: paths.installRoot,
        STATION_RECORD_VERSION: version,
      },
    },
  );
  if (result.status !== 0 && result.stderr)
    context.io.err(result.stderr.trim());
  return result.status === 0;
}

/** Whether anything accepts connections on a loopback port. */
function probePort(port: number): Promise<'free' | 'used' | 'unknown'> {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(2000);
    socket.on('connect', () => {
      socket.destroy();
      done('used');
    });
    socket.on('timeout', () => {
      socket.destroy();
      done('unknown');
    });
    socket.on('error', (error: NodeJS.ErrnoException) =>
      done(error.code === 'ECONNREFUSED' ? 'free' : 'unknown'),
    );
  });
}

/**
 * Nightly coexistence (install.sh's assert_nightly_coexistence, decision
 * D7): the Station Nightly desktop app defaults to the same home and ports.
 * Only the default home is guarded, and only a port probed while no
 * portable nightly is installed can belong to someone else.
 */
async function assertNightlyCoexistence(
  env: InstallerEnv,
  paths: Paths,
  ports: Ports,
): Promise<void> {
  if (paths.channel !== 'nightly') return;
  if (!paths.homeRequested) {
    let entries: string[] = [];
    try {
      entries = readdirSync(paths.stationHome);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (entries.length > 0 && !entries.includes(DATA_ROOT_MARKER))
      fail(
        `${paths.stationHome} already holds Station data this installer does not own (usually the Station Nightly desktop app's home). Refusing to share it silently: set STATION_HOME to that path to share it deliberately, or to another directory under ${paths.stationRoot}\\instances to keep separate data`,
      );
  }
  if (env.STATION_INSTALL_NO_START === '1' || isLink(paths.current)) return;
  for (const port of [ports.server, ports.ui]) {
    const state = await probePort(port);
    if (state === 'used')
      fail(
        `port ${port} is already in use on this host, and no portable nightly Station is installed to own it. The Station Nightly desktop app uses the same ports; quit it before installing, or install with STATION_INSTALL_NO_START=1 and start Station once the port is free`,
      );
    if (state === 'unknown')
      fail(`could not determine whether port ${port} is free`);
  }
}

let cliRuns = 0;

/**
 * Runs a version's own CLI the way its bin\station.cmd says a supervisor
 * must: its runtime\node.exe with bin\station.mjs, from the version
 * directory itself (not through `current`), with the install's identity.
 *
 * Its output goes to a file in the private temporary directory, relayed
 * afterwards, never to this process's own stdout: `start` leaves Station
 * running detached, and on Windows a detached Station that held install.ps1's
 * output pipe kept PowerShell's `| Out-Host` (and any caller reading the
 * installer's output) waiting until Station stopped (seen on the Windows
 * smoke).
 */
function runInstalledCli(
  context: Context,
  dir: string,
  args: string[],
  paths: Paths,
): boolean {
  const { status, output } = runInstalledCliCapture(context, dir, args, paths);
  if (output !== '')
    for (const line of output.split(/\r?\n/)) context.io.out(line);
  return status === 0;
}

/** runInstalledCli without the relay: its status and output. */
function runInstalledCliCapture(
  context: Context,
  dir: string,
  args: string[],
  paths: Paths,
): { status: number | null; output: string } {
  const { node, entry } = versionPaths(dir);
  cliRuns += 1;
  const log = join(context.tmp, `station-cli-${process.pid}-${cliRuns}.log`);
  const fd = openSync(log, 'wx', 0o600);
  let status: number | null;
  try {
    status = spawnSync(node, [entry, ...args], {
      cwd: dir,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: {
        ...context.env,
        STATION_CHANNEL: paths.channel,
        STATION_ROOT: paths.stationRoot,
        STATION_HOME: paths.stationHome,
        STATION_INSTALL_ROOT: paths.installRoot,
        STATION_INVOKED_CWD: process.cwd(),
      },
    }).status;
  } finally {
    closeSync(fd);
  }
  return { status, output: readFileSync(log, 'utf8').trimEnd() };
}

function stopStation(context: Context, dir: string | null, paths: Paths) {
  return (
    dir === null ||
    runInstalledCli(
      context,
      dir,
      ['stop', `--base=${paths.stationHome}`],
      paths,
    )
  );
}

function startStation(
  context: Context,
  dir: string,
  paths: Paths,
  ports: Ports,
): boolean {
  return runInstalledCli(
    context,
    dir,
    [
      'start',
      `--base=${paths.stationHome}`,
      `--port=${ports.server}`,
      `--ui-port=${ports.ui}`,
    ],
    paths,
  );
}

function onPath(env: InstallerEnv, directory: string): boolean {
  const value = env.PATH ?? env.Path ?? '';
  return value
    .split(delimiter)
    .some(
      (entry) => entry !== '' && same(entry.replace(/[\\/]+$/, ''), directory),
    );
}

/** install.sh's uninstall refusal: services first, then the install. */
function refuseArchiveServices(paths: Paths): void {
  const services = archiveServicesOf(paths);
  if (services.length === 0) return;
  fail(
    `Station service(s) ${services.map((service) => service.id).join(' ')} run this install; remove each first with: ${paths.launcher} service uninstall --instance=<name>. Nothing was changed`,
  );
}

/**
 * The bin directory holds a launcher the user runs from PATH, so on Windows
 * nobody but the user, SYSTEM and Administrators may write it (the trust
 * module's execution-safe rule, which a default `%USERPROFILE%\.local\bin`
 * meets by inheriting the profile's ACL).
 */
function assertBinDirTrusted(binDir: string): void {
  if (process.platform !== 'win32') return;
  try {
    assertWindowsPathsTrusted(runWindowsTrustCommand, [
      { kind: 'directory', path: binDir, policy: 'execution-safe' },
    ]);
  } catch (error) {
    fail(
      `the launcher directory ${binDir} is writable by another account (${plainPowerShellMessage((error as Error).message)}); choose another with STATION_BIN_DIR`,
    );
  }
}

/** `install.ps1 install`: install, upgrade or reinstall the channel. */
export async function installArchive(context: Context): Promise<number> {
  const { env, io } = context;
  const request = readStageRequest(env, 'install');
  const paths = resolvePaths(env, request.requested, request.ring);
  assertExistingInstallRoot(paths, env);
  recoverCurrent(paths.installRoot);
  activeInstalledVersion(paths);
  const ports = resolvePorts(env, paths.channel, readRecordedPorts(paths));
  const services = archiveServicesOf(paths);
  const legacy = services.filter((service) => !service.launcher);
  if (legacy.length > 0)
    fail(
      // The installed version's own CLI cannot install a launcher service
      // on Windows (it predates W3), so reinstalling the service before
      // upgrading would register the same kind again; the new version's
      // CLI must do it, once the install has switched with no service.
      `Station service(s) ${legacy.map((service) => service.id).join(' ')} run this install's version directly, not through the service launcher that updates it, and that version cannot install one. Migrate each in this order: 1) ${paths.launcher} service uninstall --instance=<name>; 2) rerun this installer with STATION_INSTALL_NO_START=1; 3) ${paths.launcher} service install --instance=<name> (now the new version's). Nothing was changed`,
    );
  const launcherState = assertLauncherStateSettled(paths);
  const active: string[] = [];
  const registered: string[] = [];
  const running = activeInstalledVersion(paths);
  for (const { id } of services) {
    if (running === null)
      fail(
        `Station service ${id} runs this install, but ${paths.current} names no installed version; nothing was changed`,
      );
    const unit = serviceUnitState(context, running, paths, id);
    if (unit === 'active') active.push(id);
    else if (unit === 'registered') registered.push(id);
  }

  // A running launcher service owns its switch: stage the version and hand
  // it the update, which it trials and keeps or rolls back.
  if (active.length > 0) {
    const release = await prepareRelease(
      context,
      request,
      paths,
      'stage',
      () => {
        prepareOwnedInstallRoot(paths.installRoot, env);
        prepareSafeDirectory(paths.versions);
      },
    );
    if (release.outcome === 'nothing-to-do') return 0;
    return handOffToLauncher(context, paths, release.payload.version);
  }
  await assertNightlyCoexistence(env, paths, ports);

  const release = await prepareRelease(
    context,
    request,
    paths,
    'install',
    () => {
      prepareOwnedInstallRoot(paths.installRoot, env);
      const home = prepareOwnedRoot(
        paths.stationHome,
        DATA_ROOT_MARKER,
        DATA_ROOT_SIGNATURE,
        'preserve',
      );
      if (home === null)
        fail(
          `STATION_HOME is not a safe Station data directory: ${paths.stationHome}`,
        );
      if (home === 'preserved')
        io.out(
          `Using existing Station data without claiming purge ownership: ${paths.stationHome}`,
        );
      prepareSafeDirectory(paths.versions);
      prepareSafeDirectory(paths.binDir);
      assertBinDirTrusted(paths.binDir);
      launcherText(paths);
      if (
        (existsSync(paths.launcher) || isLink(paths.launcher)) &&
        !launcherIsOwned(paths)
      )
        fail(
          `refusing to replace a launcher not owned by the ${paths.channel} install: ${paths.launcher}`,
        );
    },
  );
  if (release.outcome === 'nothing-to-do') return 0;
  switchToRelease(context, paths, ports, release, {
    registered,
    launcherState,
  });
  return 0;
}

/**
 * Stop, switch `current`, the launcher and the state, start; on any failure
 * put the previous release (or nothing, for a first install) back.
 */
function switchToRelease(
  context: Context,
  paths: Paths,
  ports: Ports,
  release: PreparedRelease,
  services: { registered: string[]; launcherState: boolean },
): void {
  const { env, io } = context;
  const { payload, releaseDir } = release;
  const noStart = env.STATION_INSTALL_NO_START === '1';
  // A registered service may start at any time; a second Station beside it
  // would share its home and ports, so nothing is started and it stays
  // stopped (install.sh does the same).
  const startStationAfter = !noStart && services.registered.length === 0;
  const previousState = readIfPresent(paths.stateFile);
  const previousLauncher = readIfPresent(paths.launcher);
  const stagedLauncher = join(
    paths.binDir,
    `.station-launcher-${paths.channel}.${process.pid}`,
  );
  const stagedState = join(
    paths.installRoot,
    `.station-release-state.${process.pid}`,
  );
  for (const stale of [stagedLauncher, stagedState])
    if (existsSync(stale)) unlinkSync(stale);
  writeExclusive(stagedLauncher, launcherText(paths), 0o755);
  writeExclusive(
    stagedState,
    `${JSON.stringify({
      schemaVersion: 4,
      channel: paths.channel,
      releaseChannel: paths.ring,
      installRoot: paths.installRoot,
      stationRoot: paths.stationRoot,
      stationHome: paths.stationHome,
      manifestUrl: env.STATION_INSTALL_PUBLIC_MANIFEST_URL,
      serverPort: ports.server,
      uiPort: ports.ui,
    })}\n`,
    0o600,
  );
  const discardStaged = () => {
    for (const staged of [stagedLauncher, stagedState])
      if (existsSync(staged)) unlinkSync(staged);
  };

  let previous = release.previous;
  let displaced: string | null = null;
  // Stopped through its manager, which also ends a launcher that is still
  // on its way out.
  for (const id of services.registered)
    if (
      previous === null ||
      !runInstalledCli(
        context,
        previous,
        ['service', 'stop', `--instance=${id}`, `--base=${paths.stationHome}`],
        paths,
      )
    ) {
      discardStaged();
      fail(
        `could not stop Station service ${id}; the running release was not changed`,
      );
    }
  if (!stopStation(context, previous, paths)) {
    discardStaged();
    fail(
      'could not stop the installed Station; the running release was not changed',
    );
  }

  const rollback = (reason: string): never => {
    try {
      // Best effort: a new release that half started must not hold the
      // ports or files the restored one needs.
      if (existsSync(releaseDir)) stopStation(context, releaseDir, paths);
      if (displaced !== null) {
        if (existsSync(releaseDir) || isLink(releaseDir))
          removeTree(releaseDir);
        renamePathSyncRetrying(displaced, releaseDir);
        previous = releaseDir;
      }
      if (previous !== null) {
        pointCurrentAt(paths.installRoot, previous);
        restoreFile(paths.launcher, previousLauncher, 0o755);
        restoreFile(paths.stateFile, previousState, 0o600);
        // The previous release comes back on the ports its restored state
        // records, not on ports this run was asked for (install.sh's
        // restart_previous_station uses the new ones).
        if (
          startStationAfter &&
          !startStation(
            context,
            previous,
            paths,
            portsOf(previousState) ?? ports,
          )
        )
          throw new Error('the previous release did not start');
      } else {
        removeCurrent(paths.installRoot);
        restoreFile(paths.launcher, null, 0o755);
        restoreFile(paths.stateFile, previousState, 0o600);
      }
    } catch (error) {
      discardStaged();
      io.err(`${(error as Error).message}`);
      fail(`${reason}; automatic recovery also failed`);
    }
    discardStaged();
    fail(
      previous !== null
        ? `${reason}; the previous release was restored`
        : `${reason}; the incomplete install was removed`,
    );
  };

  try {
    if (release.outcome === 'replacement' && release.incoming) {
      // Same version, new bytes, explicitly requested: the running version
      // moves aside (it stays the rollback target) and the verified one
      // takes its name, which `current` already names.
      displaced = `${releaseDir}.replaced.${process.pid}`;
      renamePathSyncRetrying(releaseDir, displaced);
      previous = displaced;
      renamePathSyncRetrying(release.incoming, releaseDir);
      sealTree(releaseDir);
      pointCurrentAt(paths.installRoot, releaseDir);
    } else if (previous === null || !same(previous, releaseDir)) {
      pointCurrentAt(paths.installRoot, releaseDir);
    }
    renamePathSyncRetrying(stagedLauncher, paths.launcher);
    renamePathSyncRetrying(stagedState, paths.stateFile);
  } catch (error) {
    io.err(`${(error as Error).message}`);
    rollback('could not publish the new release');
  }

  if (!noStart) {
    if (startStationAfter && !startStation(context, releaseDir, paths, ports))
      rollback('the new release did not start');
    // Keep the active release and the one it replaced (the rollback
    // target); remove every other one, including stages a crashed install
    // left behind. On Windows a version a process still runs cannot be
    // removed; the next install tries again.
    for (const name of readdirSync(paths.versions)) {
      const dir = join(paths.versions, name);
      if (same(dir, releaseDir) || (previous !== null && same(dir, previous)))
        continue;
      try {
        if (!lstatSync(dir).isDirectory() || isLink(dir)) continue;
        removeTree(dir);
      } catch (error) {
        io.err(
          `Warning: could not remove ${dir} (${(error as Error).message}); the next install tries again.`,
        );
      }
    }
  }

  if (
    services.launcherState &&
    !recordLauncherActiveVersion(context, paths, payload.version)
  )
    rollback(
      'could not record the new version for the Station service launcher',
    );

  io.out('');
  io.out(`Station ${payload.releaseTag} is installed at ${paths.current}`);
  io.out(`Launcher: ${paths.launcher}`);
  if (!onPath(env, paths.binDir))
    io.out(
      `Add ${paths.binDir} to PATH to run ${RINGS[paths.ring].launcher} from any directory.`,
    );
  if (services.registered.length > 0)
    for (const id of services.registered)
      io.out(
        `Station service ${id} was not running and was left stopped; start it with: ${paths.launcher} service start --instance=${id}`,
      );
  else
    io.out(
      noStart
        ? `Start it with: ${paths.launcher} start`
        : `Open http://localhost:${ports.ui}`,
    );
}

function assertOwnedRoot(root: string, markerName: string, signature: string) {
  const owned = (() => {
    try {
      const rootInfo = lstatSync(root);
      const marker = lstatSync(join(root, markerName));
      return (
        rootInfo.isDirectory() &&
        !rootInfo.isSymbolicLink() &&
        marker.isFile() &&
        !marker.isSymbolicLink() &&
        (owner === null || (rootInfo.uid === owner && marker.uid === owner)) &&
        readFileSync(join(root, markerName), 'utf8') === signature
      );
    } catch {
      return false;
    }
  })();
  if (!owned)
    fail(`refusing to remove a root not owned by this installer: ${root}`);
}

/** `install.ps1 uninstall [-PurgeData]` (install.sh's uninstall_station). */
export async function uninstallArchive(
  context: Context,
  args: string[],
): Promise<number> {
  const { env, io } = context;
  if (args.length > 1) fail(`unexpected argument: ${args[1]}`);
  const option = args[0];
  if (
    option !== undefined &&
    option !== '-PurgeData' &&
    option !== '--purge-data'
  )
    fail(`unknown uninstall option: ${option}`);
  const purge = option !== undefined;
  const { requested, ring } = readChannel(env);
  const paths = resolvePaths(env, requested, ring);
  const present = (path: string) => existsSync(path) || isLink(path);
  let trustProblem: string | null = null;

  if (present(paths.installRoot)) {
    assertOwnedRoot(
      paths.installRoot,
      INSTALL_ROOT_MARKER,
      INSTALL_ROOT_SIGNATURE,
    );
    trustProblem = installRootTrustProblem(paths.installRoot, env);
    if (trustProblem === null) recoverCurrent(paths.installRoot);
    else
      io.err(
        `Warning: ${paths.installRoot} is not restricted to your account (${trustProblem}); it is removed without running anything from it.`,
      );
  }
  if (purge && present(paths.stationHome)) {
    assertSafeRemoveTarget(paths.stationHome);
    assertOwnedRoot(paths.stationHome, DATA_ROOT_MARKER, DATA_ROOT_SIGNATURE);
  }
  refuseArchiveServices(paths);
  const active = activeInstalledVersion(paths);
  if (trustProblem === null) {
    if (!stopStation(context, active, paths))
      fail('could not stop the installed Station; no files were removed');
  } else if (active !== null) {
    // Nothing from an untrusted root runs, its `station stop` included. A
    // Station it may have started is detected on the ports the install
    // recorded (or the channel's), and the uninstall waits for the user to
    // stop it rather than killing a process it cannot vouch for.
    const ports =
      portsOf(readIfPresent(paths.stateFile)) ??
      resolvePorts({}, paths.channel, null);
    for (const port of [ports.server, ports.ui]) {
      const state = await probePort(port);
      if (state !== 'free')
        fail(
          `a Station may be running from ${paths.installRoot} (port ${port} is ${state === 'used' ? 'in use' : 'not answering'}), and nothing from that root is run to stop it. Stop it first (station stop, or end its node.exe), then rerun the uninstall. Nothing was removed`,
        );
    }
  }
  if (present(paths.launcher)) {
    if (!launcherIsOwned(paths))
      fail(
        `refusing to remove a launcher not owned by the ${paths.channel} install: ${paths.launcher}`,
      );
    unlinkSync(paths.launcher);
  }
  if (present(paths.installRoot)) removeInstallRoot(paths.installRoot, env);
  if (purge && present(paths.stationHome)) removeTree(paths.stationHome);
  io.out('Station uninstalled.');
  if (!purge) io.out(`Data preserved at ${paths.stationHome}`);
  return 0;
}
