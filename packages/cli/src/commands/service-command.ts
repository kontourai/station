import { posix, win32 } from 'node:path';
import {
  type InstallerOwnedArchiveFs,
  type LifecycleCodeRoot,
  resolveInstallerOwnedArchiveInstallRoot,
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
 *   installer can prune old versions. Any other archive copy runs from its
 *   own physical path, which its owner manages.
 */
export type ServiceCodeKind = 'archive' | 'source';

/**
 * How long `service run` gives Station's detached server and UI to stop
 * before it forces its own exit.
 */
export const SERVICE_SHUTDOWN_DEADLINE_MS = 60_000;

/**
 * A service manager must wait out that deadline before it kills the unit:
 * systemd's KillMode=mixed SIGKILLs the whole cgroup, children included,
 * when TimeoutStopSec expires. The margin covers the supervisor's own exit
 * after its deadline. (launchd's ExitTimeOut is already 600 s; Task
 * Scheduler's /End only ends the cmd wrapper, and `service stop` stops the
 * Station children by record there.)
 */
export const SYSTEMD_STOP_TIMEOUT_SECONDS =
  Math.ceil(SERVICE_SHUTDOWN_DEADLINE_MS / 1_000) + 15;

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

function entryFiles(location: ServiceCodeLocation, path: PathApi): string[] {
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
    workingDirectory: location.repoPath,
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
  const installRoot = resolveInstallerOwnedArchiveInstallRoot(repoPath, fs);
  const root =
    installRoot === null ? repoPath : path.join(installRoot, 'current');
  return {
    kind: 'archive',
    ...(installRoot === null ? {} : { installRoot }),
    nodePath:
      input.platform === 'win32'
        ? path.join(root, 'runtime', 'node.exe')
        : path.join(root, 'runtime', 'bin', 'node'),
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
