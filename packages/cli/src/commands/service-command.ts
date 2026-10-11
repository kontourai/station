import { posix, win32 } from 'node:path';
import {
  type InstallerOwnedArchiveFs,
  type LifecycleCodeRoot,
  resolveInstallerOwnedArchiveVersion,
} from './lifecycle-code-root.js';
import type { ServiceLifecycleArgs } from './service.js';

/**
 * What a Station service unit runs (#2675 slice C). One decision, rendered
 * into the launchd plist, the systemd unit and the Windows task wrapper, so
 * the three backends cannot disagree about it.
 *
 * - `source`: a checkout (or a release tree built on this host) runs its
 *   own `scripts/station-cli.ts` through tsx with the host Node.js, from its
 *   physical path. Unchanged from before slice C.
 * - `archive`: a prebuilt archive runs `bin/station.mjs` with the Node.js it
 *   bundles. A version install.sh made active is run through
 *   `<installRoot>/current`, never the version directory, so an upgrade
 *   flips `current` and restarts the unit without rewriting it, and the
 *   installer can prune old versions. Installing from one of its inactive
 *   versions is refused, since the installer may prune it. Any other archive
 *   copy runs from its own physical path, which its owner manages.
 */
export type ServiceCodeKind = 'archive' | 'source';

/**
 * How long `service run` gives Station's detached server and UI to stop
 * before it forces its own exit.
 */
export const SERVICE_SHUTDOWN_DEADLINE_MS = 60_000;

/**
 * How long the fixed launcher (#2675 D; station-launcher.mjs DEFAULT_TIMINGS,
 * pinned by service-launcher.test.ts) may take to stop a version: it waits
 * `stopGraceMs` for `service run`, then kills it, waits up to 10 s for that,
 * and runs the version's own `station stop` for up to `ownStopTimeoutMs`.
 */
export const LAUNCHER_STOP_BUDGET_MS = 65_000 + 10_000 + 60_000;

/**
 * A service manager must wait out the longest stop before it kills the unit:
 * systemd's KillMode=mixed SIGKILLs the whole cgroup, children included,
 * when TimeoutStopSec expires. The margin covers the launcher's own exit and
 * the transition a stop waits behind (#2675 D review F6: a stop during the
 * liveness handoff ends that wait at once, so it adds nothing, but a margin
 * of exactly the handoff's 15 s left no room at all when it did). A stop
 * that lands during a home backup or restore waits for it, and SIGKILL
 * interrupts it: both are idempotent, and the next start sweeps the copy.
 * (launchd's ExitTimeOut is already 600 s. Task Scheduler's /End only ends
 * the cmd wrapper and has no timeout: a launcher notices its wrapper is gone
 * and stops on its own, and `service stop` waits this budget for it.)
 */
export const SYSTEMD_STOP_TIMEOUT_SECONDS =
  Math.ceil(
    Math.max(SERVICE_SHUTDOWN_DEADLINE_MS, LAUNCHER_STOP_BUDGET_MS) / 1_000,
  ) + 30;

export interface ServiceCodeLocation {
  /** Absent in manifests written before slice C, which were all `source`. */
  kind?: ServiceCodeKind;
  /** The install root whose `current` an installer-owned archive runs. */
  installRoot?: string;
  /** The Node.js executable the unit starts. */
  nodePath: string;
  /** The code root the unit runs from (its working directory). */
  repoPath: string;
}

export interface ServiceCommand {
  /** The program and every argument, unquoted. */
  argv: string[];
  workingDirectory: string;
}

type PathApi = Pick<typeof posix, 'dirname' | 'join'>;

/**
 * Where `service install` puts the fixed launcher (#2675 D) for an
 * installer-owned archive: beside `current`, outside every version, so it
 * outlives the updates it performs.
 */
function serviceLauncherPath(
  installRoot: string,
  path: PathApi = posix,
): string {
  return path.join(installRoot, 'runtime', 'station-launcher.mjs');
}

/**
 * The Node.js a Windows launcher service runs (#2675 W3, decision D4 option
 * a): `service install` copies the active version's `runtime\node.exe` beside
 * the fixed launcher and freezes it with it. Task Scheduler's trusted
 * execution path then holds no junction (the trust check refuses reparse
 * points), and the running launcher pins no version directory, which Windows
 * would otherwise refuse to prune while its node.exe runs. The launcher needs
 * only Node.js built-ins, and starts each version with that version's own
 * node.exe by its real path.
 */
function windowsServiceLauncherNode(installRoot: string): string {
  return win32.join(installRoot, 'runtime', 'node.exe');
}

/**
 * An installer-owned archive's unit runs the fixed launcher, which runs the
 * active version and swaps it: install.sh's on Linux and macOS, install.ps1's
 * on Windows (slice W3).
 */
function runsLauncher(location: ServiceCodeLocation): boolean {
  return location.kind === 'archive' && location.installRoot !== undefined;
}

function entryFiles(location: ServiceCodeLocation, path: PathApi): string[] {
  if (runsLauncher(location) && location.installRoot !== undefined)
    return [serviceLauncherPath(location.installRoot, path)];
  return location.kind === 'archive'
    ? [path.join(location.repoPath, 'bin', 'station.mjs')]
    : [
        path.join(location.repoPath, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(location.repoPath, 'scripts', 'station-cli.ts'),
      ];
}

/** The `service run` invocation for one instance, and where it runs. */
export function renderServiceCommand(
  location: ServiceCodeLocation,
  instanceId: string,
  lifecycle: ServiceLifecycleArgs,
  path: PathApi = posix,
): ServiceCommand {
  return {
    argv: [
      location.nodePath,
      ...entryFiles(location, path),
      'service',
      'run',
      `--instance=${instanceId}`,
      `--base=${lifecycle.baseDir}`,
      `--port=${lifecycle.serverPort}`,
      `--ui-port=${lifecycle.uiPort}`,
      `--host=${lifecycle.host ?? '127.0.0.1'}`,
      ...(lifecycle.features ? [`--features=${lifecycle.features}`] : []),
      ...(lifecycle.allowedOrigins ?? []).map(
        (origin) => `--allowed-origin=${origin}`,
      ),
    ],
    // A Windows launcher service runs from the launcher's own directory, not
    // `current`: the wrapper's cmd.exe would otherwise hold its working
    // directory on a version while the launcher switches `current` away from
    // it, and Windows cannot remove a directory a process is in.
    workingDirectory:
      path.join === win32.join &&
      runsLauncher(location) &&
      location.installRoot !== undefined
        ? win32.join(location.installRoot, 'runtime')
        : location.repoPath,
  };
}

/** The files whose trust decides what a Windows task executes. */
export function serviceExecutionFiles(
  location: ServiceCodeLocation,
  path: PathApi = posix,
): string[] {
  return [location.nodePath, ...entryFiles(location, path)];
}

/**
 * Where a service installed from `codeRoot` runs from. `realpathSync` and
 * `execPath` are the caller's; the source branch is exactly what service
 * install computed before slice C.
 */
export function resolveServiceCodeLocation(input: {
  /** The CLI's code root; its `root` is the CLI's working directory. */
  codeRoot: LifecycleCodeRoot;
  execPath: string;
  fs: InstallerOwnedArchiveFs;
  platform: 'darwin' | 'linux' | 'win32';
}): ServiceCodeLocation & { kind: ServiceCodeKind } {
  const { codeRoot, fs } = input;
  const repoPath = fs.realpathSync(codeRoot.root);
  if (codeRoot.kind === 'source') {
    return {
      kind: 'source',
      nodePath: fs.realpathSync(input.execPath),
      repoPath,
    };
  }
  const path = input.platform === 'win32' ? win32 : posix;
  const owned = resolveInstallerOwnedArchiveVersion(repoPath, fs);
  // An inactive version of an install.sh install is one its next upgrade
  // prunes, and install.sh restarts only services that run `current`: a unit
  // running it directly would be deleted from under itself.
  if (owned !== null && !owned.active) {
    throw new Error(
      `Cannot install a Station service from ${repoPath}: it is not the version ${path.join(owned.installRoot, 'current')} names, and the installer may remove it. Run \`station service install\` with the installed launcher (the active version) instead.`,
    );
  }
  const installRoot = owned?.installRoot ?? null;
  const root =
    installRoot === null ? repoPath : path.join(installRoot, 'current');
  return {
    kind: 'archive',
    ...(installRoot === null ? {} : { installRoot }),
    nodePath:
      input.platform !== 'win32'
        ? path.join(root, 'runtime', 'bin', 'node')
        : installRoot === null
          ? path.join(root, 'runtime', 'node.exe')
          : windowsServiceLauncherNode(installRoot),
    repoPath: root,
  };
}

/**
 * The directory the unit's PATH names for its Node.js, as the unit spells
 * it. Only an installer-owned archive differs from the resolved directory:
 * its PATH must follow `current`, not the version that was active at
 * install time.
 */
export function serviceNodeDirectory(
  location: ServiceCodeLocation,
): string | undefined {
  return location.kind === 'archive' && location.installRoot !== undefined
    ? posix.dirname(location.nodePath)
    : undefined;
}

/**
 * Exactly the location fields a service manifest records. Callers that
 * predate slice C pass no `kind`: they install from source.
 */
export function serviceCodeLocationOf(
  input: ServiceCodeLocation,
): ServiceCodeLocation & { kind: ServiceCodeKind } {
  return {
    kind: input.kind ?? 'source',
    ...(input.installRoot === undefined
      ? {}
      : { installRoot: input.installRoot }),
    nodePath: input.nodePath,
    repoPath: input.repoPath,
  };
}
