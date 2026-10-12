import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import {
  installerInheritedEnv,
  packagedInstallerCommand,
} from '@kontourai/station-shared/prebuilt-archive';
import {
  parseServiceUpdateRequest,
  readServiceLauncherContext,
  type ServiceLauncherContext,
  type ServiceUpdateRequest,
  type ServiceUpdateRequestResult,
  serviceUpdatePaths,
  writeJsonAtomically,
} from '@kontourai/station-shared/service-launcher-protocol';
import type { ServiceFs } from './service.js';

/**
 * The versioned child's half of the fixed launcher's protocol (#2675 slice
 * D; the launcher is packaging/portable-server/bin/station-launcher.mjs).
 *
 * `service run` under the launcher learns so from STATION_SERVICE_LAUNCHER
 * and talks to it over the IPC channel the launcher opened:
 *
 *   active child: picks up `runtime/update-request.json` (written by the
 *     server, which is a detached grandchild and has no channel of its own),
 *     stages the requested version with its OWN install.sh (download and
 *     verification stay out of the frozen launcher), and asks the launcher
 *     for a trial. When the launcher accepts, it re-points the service's
 *     liveness entry at the launcher before it is stopped.
 *   trial child: reports `prepared` once its server has proven its identity.
 *
 * Requests the launcher never sees (nothing newer, staging failed, rejected)
 * are answered in `runtime/update-request-result.json`; the launcher records
 * everything after acceptance in `runtime/service-state.json`. The file and
 * environment formats both sides share live in
 * `@kontourai/station-shared/service-launcher-protocol`, which the server,
 * the request's writer, reads too.
 */
export {
  readServiceLauncherContext,
  SERVICE_LAUNCHER_ENV,
  type ServiceLauncherContext,
  serviceUpdatePaths,
  writeServiceUpdateRequest,
} from '@kontourai/station-shared/service-launcher-protocol';

/**
 * install.sh's test-only verifier override, which install.sh itself honors
 * only beside STATION_INSTALL_ALLOW_INSECURE_TEST_URLS=1; carried through
 * only in that combination, which no production service sets.
 */
const INSTALL_TEST_OVERRIDES = new Set([
  'STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL',
  'STATION_INSTALL_ALLOW_INSECURE_TEST_URLS',
]);

/**
 * The service's environment without the installer's switches (#2675 D
 * review F8): a unit can carry STATION_INSTALL_* from the shell that
 * installed it (NO_START, ALLOW_ROLLBACK, ASSET_URL, ports...), and each one
 * changes what an install does. Staging sets the few it needs itself. Nor
 * the service CLI's own bootstrap launch facts, which are not install ports.
 */
function stagingInheritedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const testMode = env.STATION_INSTALL_ALLOW_INSECURE_TEST_URLS === '1';
  return Object.fromEntries(
    Object.entries(installerInheritedEnv(env)).filter(
      ([key]) =>
        !key.startsWith('STATION_INSTALL_') ||
        (testMode && INSTALL_TEST_OVERRIDES.has(key)),
    ),
  );
}

/**
 * Stages a version with this version's own installer in stage-only mode
 * (install.sh, or install.ps1 on Windows, #2675 W3; the choice is
 * `packagedInstallerCommand`'s, the one `station upgrade` makes): the
 * installer downloads, verifies, extracts, self-checks and seals it into
 * `versions/<v>` exactly as an install would, and changes nothing else.
 * Resolves the version it staged (the running one when nothing is newer).
 */
export function stageServiceUpdate(input: {
  installRoot: string;
  version: string;
  targetVersion?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<string> {
  const versionDir = join(input.installRoot, 'versions', input.version);
  const env = input.env ?? process.env;
  const installer = packagedInstallerCommand(
    versionDir,
    input.platform ?? process.platform,
    env,
  );
  let state: {
    channel?: unknown;
    stationRoot?: unknown;
    stationHome?: unknown;
    manifestUrl?: unknown;
  };
  try {
    state = JSON.parse(
      readFileSync(
        join(input.installRoot, '.station-release-state.json'),
        'utf8',
      ),
    );
  } catch (error) {
    return Promise.reject(
      new Error(`cannot read the install state: ${(error as Error).message}`),
    );
  }
  const manifestUrl =
    env.STATION_INSTALL_PUBLIC_MANIFEST_URL ||
    (typeof state.manifestUrl === 'string' ? state.manifestUrl : undefined);
  const childEnv: NodeJS.ProcessEnv = {
    ...stagingInheritedEnv(env),
    STATION_INSTALL_STAGE_ONLY: '1',
    STATION_INSTALL_ROOT: input.installRoot,
  };
  // install.sh verifies with the Node.js this version bundles, found on
  // PATH. install.ps1 finds the installed Station's Node.js itself, and
  // only in an install root it has verified.
  if ((input.platform ?? process.platform) !== 'win32')
    childEnv.PATH = `${join(versionDir, 'runtime', 'bin')}${delimiter}${env.PATH ?? ''}`;
  for (const [key, value] of [
    ['STATION_CHANNEL', state.channel],
    ['STATION_ROOT', state.stationRoot],
    ['STATION_HOME', state.stationHome],
  ] as const) {
    if (typeof value === 'string') childEnv[key] = value;
  }
  if (manifestUrl) childEnv.STATION_INSTALL_PUBLIC_MANIFEST_URL = manifestUrl;
  if (input.targetVersion) childEnv.STATION_VERSION = `v${input.targetVersion}`;
  else delete childEnv.STATION_VERSION;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(installer.command, installer.args, {
      cwd: versionDir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const staged = /^STATION_STAGED_VERSION=(\S+)$/m.exec(stdout)?.[1];
      if (code === 0 && staged) resolvePromise(staged);
      else
        reject(
          new Error(
            stderr.trim().split('\n').at(-1) ||
              `${basename(installer.file)} exited ${code ?? 'abnormally'}`,
          ),
        );
    });
  });
}

/** The same completion check the launcher makes before a trial. */
function stagedVersionIsComplete(
  installRoot: string,
  version: string,
): boolean {
  const dir = join(installRoot, 'versions', version);
  try {
    return (
      readFileSync(join(dir, '.station-install-complete'), 'utf8').trim() !==
        '' && existsSync(join(dir, 'bin', 'station.mjs'))
    );
  } catch {
    return false;
  }
}

/**
 * A claimed request (`update-request.processing.json`) that no child is
 * working on (#2675 D review F5): the child that claimed it was killed
 * before the launcher accepted it, and the file blocked every later request.
 * A new child runs this before anything else, when no other child of its
 * launcher exists. A request the launcher accepted is recorded in its state
 * and needs nothing more; any other is answered as failed, so whoever asked
 * (install.sh waits for the answer) is told to ask again.
 */
function settleOrphanedClaim(
  paths: ReturnType<typeof serviceUpdatePaths>,
  log: (message: string) => void,
): void {
  let text: string;
  try {
    text = readFileSync(paths.processing, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    text = '';
  }
  const request = parseServiceUpdateRequest(text);
  let accepted: unknown;
  try {
    accepted = (
      JSON.parse(readFileSync(paths.state, 'utf8')) as {
        update?: { requestId?: unknown };
      }
    ).update?.requestId;
  } catch {
    accepted = undefined;
  }
  try {
    if (request && accepted !== request.id)
      writeJsonAtomically(paths.result, {
        requestId: request.id,
        status: 'failed',
        reason:
          'The Station service restarted before it finished this update request; request the update again.',
        at: new Date().toISOString(),
      } satisfies ServiceUpdateRequestResult);
  } catch (error) {
    log(
      `Station could not record the interrupted update request: ${(error as Error).message}`,
    );
  }
  rmSync(paths.processing, { force: true });
}

type LauncherMessage =
  | { type: 'update-accepted'; updateId: string; launcherPid: number }
  | { type: 'update-rejected'; reason: string; requestId?: string }
  | { type: 'committed'; updateId: string };

export interface ServiceLauncherLinkDependencies {
  context: ServiceLauncherContext;
  send: (message: unknown) => void;
  onMessage: (listener: (message: unknown) => void) => void;
  /** Called when the launcher's channel closes: the launcher is gone. */
  onDisconnect: (listener: () => void) => void;
  /** Re-points this service's liveness entry at the launcher (correction 8). */
  handOffLiveness: (launcherPid: number) => void;
  stage?: typeof stageServiceUpdate;
  log?: (message: string) => void;
}

export interface ServiceLauncherLink {
  readonly context: ServiceLauncherContext;
  /** The server proved its identity. */
  onReady(): void;
  /** One supervisor check: picks up a queued update request. */
  tick(): void;
}

export function createServiceLauncherLink(
  dependencies: ServiceLauncherLinkDependencies,
  onLauncherGone: () => void,
): ServiceLauncherLink {
  const { context, send } = dependencies;
  const log = dependencies.log ?? ((message) => console.error(message));
  const stage = dependencies.stage ?? stageServiceUpdate;
  const paths = serviceUpdatePaths(context.installRoot);
  let role = context.role;
  let busy = false;
  let pendingRequestId: string | undefined;

  settleOrphanedClaim(paths, log);

  const finishRequest = (result: ServiceUpdateRequestResult): void => {
    try {
      writeJsonAtomically(paths.result, result);
    } catch (error) {
      log(
        `Station could not record the update request result: ${(error as Error).message}`,
      );
    }
    rmSync(paths.processing, { force: true });
    busy = false;
    pendingRequestId = undefined;
  };

  dependencies.onMessage((raw) => {
    const message = raw as LauncherMessage | null;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'update-accepted') {
      try {
        dependencies.handOffLiveness(message.launcherPid);
      } catch (error) {
        log(
          `Station could not hand its liveness to the launcher: ${(error as Error).message}`,
        );
      }
      // The launcher owns the request from here; its state records the rest.
      rmSync(paths.processing, { force: true });
      send({ type: 'handoff-ready', updateId: message.updateId });
      return;
    }
    if (message.type === 'update-rejected') {
      if (pendingRequestId)
        finishRequest({
          requestId: pendingRequestId,
          status: 'rejected',
          reason: message.reason,
          at: new Date().toISOString(),
        });
      return;
    }
    if (message.type === 'committed') role = 'active';
  });
  dependencies.onDisconnect(() => {
    log('Station service launcher went away; stopping');
    onLauncherGone();
  });

  return {
    context,
    onReady() {
      if (role === 'trial' && context.updateId)
        send({ type: 'prepared', updateId: context.updateId });
    },
    tick() {
      if (role !== 'active' || busy || !existsSync(paths.request)) return;
      busy = true;
      let request: ServiceUpdateRequest | null = null;
      try {
        // Claimed by rename, so one child stages it once.
        renameSync(paths.request, paths.processing);
        request = parseServiceUpdateRequest(
          readFileSync(paths.processing, 'utf8'),
        );
      } catch (error) {
        log(
          `Station could not claim the update request: ${(error as Error).message}`,
        );
      }
      if (!request) {
        rmSync(paths.processing, { force: true });
        busy = false;
        return;
      }
      const requestId = request.id;
      pendingRequestId = requestId;
      // A version install.sh already staged (a `station upgrade` handing the
      // switch to this service) needs no second download.
      const staging =
        request.targetVersion &&
        stagedVersionIsComplete(context.installRoot, request.targetVersion)
          ? Promise.resolve(request.targetVersion)
          : stage({
              installRoot: context.installRoot,
              version: context.version,
              targetVersion: request.targetVersion,
            });
      staging.then(
        (staged) => {
          if (staged === context.version) {
            finishRequest({
              requestId,
              status: 'up-to-date',
              version: staged,
              at: new Date().toISOString(),
            });
            return;
          }
          send({ type: 'request-update', targetVersion: staged, requestId });
        },
        (error: Error) =>
          finishRequest({
            requestId,
            status: 'failed',
            reason: error.message,
            at: new Date().toISOString(),
          }),
      );
    },
  };
}

/** The link for this process, when a launcher started it with a channel. */
export function processServiceLauncherLink(
  handOffLiveness: (launcherPid: number) => void,
  onLauncherGone: () => void,
): ServiceLauncherLink | null {
  const context = readServiceLauncherContext();
  if (!context || typeof process.send !== 'function') return null;
  return createServiceLauncherLink(
    {
      context,
      send: (message) => {
        try {
          process.send?.(message);
        } catch {
          // The launcher is gone; `disconnect` handles it.
        }
      },
      onMessage: (listener) => process.on('message', listener),
      onDisconnect: (listener) => process.once('disconnect', listener),
      handOffLiveness,
    },
    onLauncherGone,
  );
}

/**
 * Places the fixed launcher an installer-owned archive's unit runs (#2675 D),
 * copied from the version being installed. `service install` is the only
 * writer: an update never replaces it, which is what makes it fixed. On
 * Windows the version's node.exe is frozen beside it too (#2675 W3, decision
 * D4 option a; see `windowsServiceLauncherNode`), so the caller must have
 * stopped a service that runs them: Windows cannot replace a running
 * program's file.
 */
export function installServiceLauncher(
  fs: Pick<
    ServiceFs,
    'existsSync' | 'mkdirSync' | 'readFileSync' | 'renameSync' | 'writeFileSync'
  >,
  installRoot: string,
  versionRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const source = join(versionRoot, 'bin', 'station-launcher.mjs');
  if (!fs.existsSync(source)) {
    throw new Error(
      `${versionRoot} has no service launcher (bin/station-launcher.mjs); install a newer Station before installing its service`,
    );
  }
  // This host's paths: the unit names the same files in its platform's
  // (serviceLauncherPath, windowsServiceLauncherNode).
  const target = join(installRoot, 'runtime', 'station-launcher.mjs');
  fs.mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (platform === 'win32')
    placeFrozenFile(
      fs,
      join(versionRoot, 'runtime', 'node.exe'),
      join(installRoot, 'runtime', 'node.exe'),
      0o755,
    );
  placeFrozenFile(fs, source, target, 0o644);
  return target;
}

/** Copies `source` to `target` unless it already holds the same bytes. */
function placeFrozenFile(
  fs: Pick<
    ServiceFs,
    'existsSync' | 'readFileSync' | 'renameSync' | 'writeFileSync'
  >,
  source: string,
  target: string,
  mode: number,
): void {
  const bytes = fs.readFileSync(source);
  if (fs.existsSync(target) && fs.readFileSync(target).equals(bytes)) return;
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, bytes, { mode });
  fs.renameSync(temp, target);
}
