import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  claimInstanceEntry,
  entryOwnedByLiveProcess,
  readInstanceRegistry,
  removeInstance,
  replaceInstance,
} from '@kontourai/station-shared/instance-registry';
import { acquireFileMutationLock } from '@kontourai/station-shared/lifecycle-events';
import { assertSupportedNodeVersion } from '@kontourai/station-shared/node-runtime';
import { spawnedStationRoot } from '@kontourai/station-shared/runtime-path-resolver';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import {
  CWD,
  DEFAULT_INSTANCE_ID,
  type LifecycleHomeSource,
  resolveLifecycleInstanceId,
  resolveServiceInstanceId,
  sourceCheckoutDevInstanceId,
} from './helpers.js';
import {
  buildApplication,
  checkSourceBuildStamp,
  collectInstanceStatus,
  describeSourceBuildStampProblem,
  isBuildStale,
  resolveBuildPaths,
  sourceBuildStampNeedsRebuild,
  stop,
} from './lifecycle.js';
import {
  installLaunchd,
  launchdRegistration,
  launchdStatus,
  legacyLaunchdRegistrations,
  startLaunchd,
  stopLaunchd,
  uninstallLaunchd,
} from './service-launchd.js';
import {
  collectServicePathCandidates,
  inspectServicePathDrift,
  type ServicePathDrift,
} from './service-path.js';
import {
  resolveServiceInstallRemedy,
  type ServiceInstallRemedy,
} from './service-remedy.js';
import { superviseService } from './service-run.js';
import {
  inspectServiceSchedulingPolicy,
  isSchedulingPolicyHealthy,
  type ServiceSchedulingPolicy,
} from './service-scheduling.js';
import {
  installSystemd,
  startSystemd,
  stopSystemd,
  systemdRegistration,
  systemdStatus,
  uninstallSystemd,
} from './service-systemd.js';
import {
  assertWindowsServiceExecutionTrusted,
  installWindowsService,
  startWindowsService,
  stopWindowsService,
  uninstallWindowsService,
  windowsRegistration,
  windowsServiceStatus,
} from './service-windows.js';
import {
  createStationInstanceReconciler,
  type InstanceState,
  STATION_INSTANCE_STATE_VERSION,
  type StationInstancePlatformAdapter,
} from './station-instance-reconciler.js';
import {
  assertWindowsPathsTrusted,
  ensureWindowsDirectoriesTrusted,
  hardenWindowsPathsTrusted,
} from './windows-path-trust.js';

export interface ServiceLifecycleArgs {
  /**
   * Browser origins the pairing gate should trust (station#1672). Rendered
   * into the generated unit as repeated `--allowed-origin=` args so every
   * regeneration carries them; undefined at install time means "preserve
   * what the manifest already holds".
   */
  allowedOrigins?: string[];
  baseDir: string;
  clearAllowedOrigins?: boolean;
  features?: string;
  homeSource: LifecycleHomeSource;
  host?: string;
  instanceName?: string;
  serverPort: number;
  stationRoot?: string;
  uiPort: number;
}

export interface CommandResult {
  error?: Error;
  status: number | null;
  stderr?: string;
  stdout?: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: Record<string, unknown>,
) => CommandResult;

export interface ServiceFs {
  chmodSync: typeof nodeFs.chmodSync;
  existsSync: typeof nodeFs.existsSync;
  lstatSync: typeof nodeFs.lstatSync;
  mkdirSync: typeof nodeFs.mkdirSync;
  readFileSync: typeof nodeFs.readFileSync;
  readdirSync: typeof nodeFs.readdirSync;
  realpathSync: typeof nodeFs.realpathSync;
  renameSync: typeof nodeFs.renameSync;
  rmSync: typeof nodeFs.rmSync;
  writeFileSync: typeof nodeFs.writeFileSync;
}

export interface ServiceManifest {
  /** Persisted pairing-trust origins; reinstalls preserve these (#1672). */
  allowedOrigins?: string[];
  /** Complete config is persisted so drift guidance never resets a service. */
  baseDir?: string;
  /** null means this registration intentionally has no feature flags. */
  features?: string | null;
  host: string;
  installedAt: string;
  instanceId: string;
  label?: string;
  nodePath: string;
  platform: 'darwin' | 'linux' | 'win32';
  repoPath: string;
  serverPort: number;
  stationRoot?: string;
  uiPort: number;
  unitName?: string;
  unitPath: string;
  taskName?: string;
}

/** Runtime-only rollback hook. JSON persistence deliberately omits functions. */
export interface ServiceInstallResult extends ServiceManifest {
  rollback?: () => void | Promise<void>;
}

/**
 * A setup flow can compensate a completed service install if a later local
 * profile/default write fails. It is intentionally runtime-only.
 */
export interface ServiceInstallReceipt {
  /** The service this install registered; a caller records THIS id. */
  instanceId: string;
  rollback: () => Promise<void>;
}

export interface ServiceRegistration {
  label?: string;
  platform: 'darwin' | 'linux' | 'win32';
  taskName?: string;
  unitName?: string;
  unitPath: string;
}

export interface ServiceDependencies {
  /**
   * Builds stale service artifacts before replacing the supervisor. This keeps
   * a cold build outside the post-install identity readiness budget.
   */
  prepareServiceBuild?: (
    lifecycle: ServiceLifecycleArgs,
    instanceId: string,
  ) => Promise<void>;
  fs?: ServiceFs;
  /** Test seam for bounded service-install readiness polling. */
  installReadinessAttempts?: number;
  /** Overrides the one absolute readiness budget; primarily a test seam. */
  installReadinessTimeoutMs?: number;
  /** Monotonic clock used for readiness deadlines; primarily a test seam. */
  monotonicNow?: () => number;
  now?: () => Date;
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  /** Test seam for a post-rename Windows manifest ACL failure. */
  hardenWindowsPaths?: typeof hardenWindowsPathsTrusted;
  /** Test seam for bounded service-install readiness polling. */
  sleep?: (milliseconds: number) => void | Promise<void>;
}

export interface ServiceInspection {
  instanceId: string;
  manifest: ServiceManifest | null;
  registry: ReturnType<typeof readInstanceRegistry>['instances'][string] | null;
  unit: Record<string, boolean | string | null>;
}

/**
 * Fail-closed origin validation: the value lands in the pairing trust gate
 * and in generated unit files, so anything that is not exactly an http(s)
 * origin (a path, a credential, a trailing slash, another scheme, control
 * characters) is an error naming the offending value. Applied both to
 * `--allowed-origin` flags at parse time and to manifest-sourced values at
 * install time, so a hand-edited manifest cannot inject into a unit either.
 */
export function parseAllowedOriginFlag(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid --allowed-origin (not a URL): ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid --allowed-origin (must be http/https): ${value}`);
  }
  if (url.origin !== trimmed) {
    throw new Error(
      `Invalid --allowed-origin (must be a bare origin like ${url.origin}): ${value}`,
    );
  }
  return url.origin;
}

export function defaultRun(
  command: string,
  args: string[],
  options: Record<string, unknown> = {},
): CommandResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
    windowsHide: true,
  });
  return {
    error: result.error,
    status: result.status,
    stderr: typeof result.stderr === 'string' ? result.stderr : undefined,
    stdout: typeof result.stdout === 'string' ? result.stdout : undefined,
  };
}

const RESERVED_SYSTEMD_UNIT = 'station-dogfood.service';
/**
 * Every dogfood-supervisor label form, current and historical. A service
 * instance may never claim one of these, and a manifest may never reference
 * one — checked across all forms so an instance id cannot reach the dogfood
 * identity through an older naming generation.
 */
const RESERVED_LAUNCHD_LABELS = [
  'io.kontourai.station-dogfood',
  'ai.kontour.station-dogfood',
  'ai.kontour.command-station-dogfood',
] as const;
// 120s of outer supervision over an installed service's readiness. Since
// #2646 this is SHORTER than the boot it supervises can legitimately take:
// the unit runs `station service run` -> superviseService -> start(), whose
// identity waits supply `childAlive` and so extend to
// STARTUP_READINESS_MAX_TIMEOUT_MS (180s). A child still legitimately booting
// between 120s and 180s is therefore reported not-ready by `service install`
// while the inner wait is still tolerating it — the outer supervisor truncates
// the inner budget. Left as-is deliberately: `service install` owes the
// operator a bounded answer, and both callers can retry. Recorded here so the
// asymmetry is a known property rather than a surprise, and so no future
// reader assumes these two numbers are the same budget.
const INSTALL_READINESS_POLL_INTERVAL_MS = 1_000;
const INSTALL_READINESS_POLL_ATTEMPTS = 120;
const WINDOWS_STOP_POLL_ATTEMPTS = 7;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function prepareServiceBuild(
  lifecycle: ServiceLifecycleArgs,
  instanceId: string,
): Promise<void> {
  // instanceId is the ALREADY-RESOLVED service identity (which can be a
  // generated hash for custom home/ports) — never re-derived here, or the
  // preflight builds the wrong instance's artifacts and the cold build lands
  // back inside the readiness window.
  // station#2689: an mtime-current bundle is not enough. Without a stamp that
  // matches HEAD the supervised boot expects a different sha than the server
  // reports, and the install burns its whole readiness budget on "managed
  // boot identity mismatch" before rolling back. Rebuild through
  // buildApplication (which writes the stamp), exactly as for a stale bundle
  // and as the supervisor does, then refuse before any backend mutation if
  // the stamp still cannot back the boot.
  const before = checkSourceBuildStamp(instanceId);
  const build =
    isBuildStale(resolveBuildPaths(instanceId)) ||
    sourceBuildStampNeedsRebuild(before);
  if (build) {
    await buildApplication({
      baseDir: lifecycle.baseDir,
      instanceName: instanceId,
      serverPort: lifecycle.serverPort,
      uiPort: lifecycle.uiPort,
    });
  }
  const stampProblem = describeSourceBuildStampProblem(
    build ? checkSourceBuildStamp(instanceId) : before,
  );
  if (stampProblem) {
    const buildCommand =
      instanceId === DEFAULT_INSTANCE_ID
        ? 'station build'
        : `station build --instance=${instanceId}`;
    throw new Error(
      `Cannot install Station user service ${instanceId}: ${stampProblem}${build ? ' (after rebuilding)' : ''}. Run \`${buildCommand}\` in ${CWD}, then rerun \`station service install\`.`,
    );
  }
}

/**
 * A successful OS registration only means the supervisor accepted the unit.
 * Do not hand setup a success receipt until this exact Station instance has
 * answered both identity probes; otherwise its later default write could
 * commit an unusable local Station entry.
 */
async function waitForInstalledServiceIdentity(
  instanceId: string,
  dependencies: ServiceDependencies,
  replacedBootId?: string,
): Promise<void> {
  const attempts = Math.max(
    1,
    dependencies.installReadinessAttempts ?? INSTALL_READINESS_POLL_ATTEMPTS,
  );
  const timeoutMs = Math.max(
    1,
    dependencies.installReadinessTimeoutMs ??
      attempts * INSTALL_READINESS_POLL_INTERVAL_MS,
  );
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const deadline = monotonicNow() + timeoutMs;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const remainingBeforeProbe = deadline - monotonicNow();
    if (remainingBeforeProbe <= 0) break;
    const status = await collectInstanceStatus(instanceId, {
      probeTimeoutMs: Math.max(
        1,
        Math.floor(Math.min(3_000, remainingBeforeProbe)),
      ),
    });
    if (
      status.instanceId === instanceId &&
      status.healthy &&
      status.server.reachable &&
      status.ui.reachable &&
      (replacedBootId === undefined || status.bootId !== replacedBootId)
    ) {
      return;
    }
    if (attempt < attempts - 1) {
      const remainingBeforeSleep = deadline - monotonicNow();
      if (remainingBeforeSleep <= 0) break;
      await (dependencies.sleep ?? sleep)(
        Math.min(INSTALL_READINESS_POLL_INTERVAL_MS, remainingBeforeSleep),
      );
    }
  }
  throw new Error(
    `Station user service ${instanceId} did not become server-and-UI identity healthy with a newly started generation within ${timeoutMs}ms`,
  );
}

async function waitForWindowsSupervisorExit(
  instanceId: string,
  registration: ServiceRegistration,
  dependencies: ServiceDependencies,
  fs: ServiceFs,
  run: CommandRunner,
): Promise<void> {
  for (let attempt = 0; attempt < WINDOWS_STOP_POLL_ATTEMPTS; attempt += 1) {
    const task = windowsServiceStatus(registration, { fs, run });
    if (typeof task.error === 'string') {
      throw new Error(
        `Cannot confirm Station Task Scheduler stop: ${task.error}`,
      );
    }
    const instance = await collectInstanceStatus(instanceId);
    // `/End` only terminates Task Scheduler's cmd wrapper. The managed Node
    // processes have their own lifecycle record, so both boundaries must be
    // gone before a wrapper can be deleted or restored for this instance.
    if (task.active !== true && instance.found !== true) return;
    if (attempt < WINDOWS_STOP_POLL_ATTEMPTS - 1) {
      await (dependencies.sleep ?? sleep)(INSTALL_READINESS_POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `Station Task Scheduler task or managed lifecycle instance ${instanceId} did not stop within ${WINDOWS_STOP_POLL_ATTEMPTS * INSTALL_READINESS_POLL_INTERVAL_MS}ms`,
  );
}

async function stopAndWaitForWindowsSupervisorExit(
  instanceId: string,
  registration: ServiceRegistration,
  dependencies: ServiceDependencies,
  fs: ServiceFs,
  run: CommandRunner,
): Promise<void> {
  // Stop only the resolved Station lifecycle instance; an unqualified process
  // sweep could terminate a different user service sharing this host.
  stop({ instanceName: instanceId });
  stopWindowsService(registration, { fs, run });
  await waitForWindowsSupervisorExit(
    instanceId,
    registration,
    dependencies,
    fs,
    run,
  );
}

function readManifest(
  fs: ServiceFs,
  path: string,
  instanceId: string,
  registration: ServiceRegistration,
  run: CommandRunner,
  legacyRegistrations?: ServiceRegistration[],
): ServiceManifest | null {
  if (!fs.existsSync(path)) return null;
  assertWindowsPathsTrusted(run, [
    { kind: 'directory', path: dirname(path) },
    { kind: 'file', path },
  ]);
  const info = fs.lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.getuid !== undefined && info.uid !== process.getuid()) ||
    // Windows reports synthetic POSIX mode bits; the user-scoped service
    // directory and ACL are the actual boundary there.
    (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600)
  ) {
    throw new Error(
      `Unsafe Station service manifest (expected owned mode 0600): ${path}`,
    );
  }
  let manifest: ServiceManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path, 'utf8')) as ServiceManifest;
  } catch (error) {
    throw new Error(
      `Invalid Station service manifest ${path}: ${(error as Error).message}`,
      { cause: error },
    );
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !['darwin', 'linux', 'win32'].includes(manifest.platform) ||
    !manifest.instanceId ||
    !manifest.unitPath ||
    (manifest.baseDir !== undefined && typeof manifest.baseDir !== 'string') ||
    (manifest.features !== undefined &&
      manifest.features !== null &&
      typeof manifest.features !== 'string') ||
    (manifest.allowedOrigins !== undefined &&
      (!Array.isArray(manifest.allowedOrigins) ||
        manifest.allowedOrigins.some(
          (origin) => typeof origin !== 'string' || origin.length === 0,
        )))
  ) {
    throw new Error(`Invalid Station service manifest: ${path}`);
  }
  const reservedReference =
    RESERVED_LAUNCHD_LABELS.some(
      (reserved) =>
        manifest.label === reserved ||
        basename(manifest.unitPath) === `${reserved}.plist`,
    ) ||
    manifest.unitName === RESERVED_SYSTEMD_UNIT ||
    basename(manifest.unitPath) === RESERVED_SYSTEMD_UNIT;
  if (reservedReference) {
    throw new Error(
      `Station service manifest conflict: ${path} references reserved dogfood identity ${manifest.label ?? manifest.unitName ?? basename(manifest.unitPath)}`,
    );
  }
  const registrationFields = [
    'platform',
    'label',
    'unitName',
    'unitPath',
    'taskName',
  ] as const;
  const matchesRegistration = (candidate: ServiceRegistration): boolean =>
    registrationFields.every((field) => manifest[field] === candidate[field]);
  // Accept a manifest that describes either the current (post-rename) identity
  // or ANY legacy identity awaiting migration (the launchd label renames,
  // station#1983). A legacy manifest is returned as-is so the install path can
  // boot out the old job and replace it with the io.kontourai label rather
  // than throwing a conflict before migration can run. The reserved-dogfood
  // rejection above already covers every label form.
  const legacyMatch = (legacyRegistrations ?? []).some(matchesRegistration);
  const conflicts: string[] = [];
  if (manifest.instanceId !== instanceId) {
    conflicts.push(
      `instanceId=${JSON.stringify(manifest.instanceId)} (expected ${JSON.stringify(instanceId)})`,
    );
  }
  if (!matchesRegistration(registration) && !legacyMatch) {
    for (const field of registrationFields) {
      if (manifest[field] !== registration[field]) {
        conflicts.push(
          `${field}=${JSON.stringify(manifest[field])} (expected ${JSON.stringify(registration[field])})`,
        );
      }
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      `Station service manifest conflict for ${instanceId}: ${conflicts.join('; ')}`,
    );
  }
  return manifest;
}

function writeManifest(
  fs: ServiceFs,
  path: string,
  manifest: ServiceManifest,
  run: CommandRunner,
  hardenPaths: typeof hardenWindowsPathsTrusted = hardenWindowsPathsTrusted,
): void {
  const serviceDir = dirname(path);
  const tempPath = join(
    serviceDir,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  ensureWindowsDirectoriesTrusted(run, [dirname(serviceDir), serviceDir]);
  fs.mkdirSync(serviceDir, { mode: 0o700, recursive: true });
  fs.chmodSync(serviceDir, 0o700);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, path);
    hardenPaths(run, [{ kind: 'file', path }]);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function restoreManifest(
  fs: ServiceFs,
  path: string,
  priorContent: string | null,
  run: CommandRunner,
  hardenPaths: typeof hardenWindowsPathsTrusted = hardenWindowsPathsTrusted,
): void {
  if (priorContent === null) {
    fs.rmSync(path, { force: true });
    return;
  }
  ensureWindowsDirectoriesTrusted(run, [dirname(path)]);
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.restore.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, priorContent, { mode: 0o600 });
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, path);
    hardenPaths(run, [{ kind: 'file', path }]);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

export function captureServicePath(run: CommandRunner, fs: ServiceFs): string {
  const { accepted, nodeDir } = collectServicePathCandidates(run, fs);
  if (!accepted.includes(nodeDir)) {
    throw new Error(
      `Unsafe Node executable directory for service PATH: ${nodeDir}`,
    );
  }
  return accepted.join(':');
}

/**
 * station#2689: the service a command addresses. A flagless command from a
 * source checkout resolves to the checkout's development instance id
 * (`resolveServiceInstanceId`) — but before that rule, the same commands (and
 * `setup local`) installed `default` into this very home, so a manifest may
 * already name a different service for this checkout. Manifests come first:
 * exactly one in the home whose `repoPath` is this checkout is the service,
 * whatever its name; several refuse; none falls back to the derived id.
 * Only the implicit development case consults them — an explicit
 * `--instance` or an explicit home is taken as stated, exactly as before.
 */
export function resolveServiceTarget(
  lifecycle: ServiceLifecycleArgs,
  fs: ServiceFs,
): string {
  const derived = resolveServiceInstanceId({
    cwd: CWD,
    homeSource: lifecycle.homeSource,
    instanceName: lifecycle.instanceName,
    projectHome: lifecycle.baseDir,
    serverPort: lifecycle.serverPort,
    uiPort: lifecycle.uiPort,
  });
  if (
    lifecycle.instanceName?.trim() ||
    lifecycle.homeSource !== 'default' ||
    derived !== sourceCheckoutDevInstanceId()
  ) {
    return derived;
  }
  const owned = checkoutServiceManifests(fs, lifecycle.baseDir);
  if (owned.length === 0) return derived;
  if (owned.length > 1) {
    throw new Error(
      [
        `Several Station user services in ${lifecycle.baseDir} belong to this checkout: ${owned.join(', ')}.`,
        'Pass --instance=<name> to choose one.',
      ].join('\n'),
    );
  }
  const [existing] = owned as [string];
  if (existing !== derived) {
    // stderr: `status --json` owns stdout.
    console.error(
      `Using Station user service ${existing}, already installed for this checkout in ${lifecycle.baseDir} (pass --instance to address another).`,
    );
  }
  return existing;
}

/**
 * Instance ids of the manifests in `<home>/service/` recorded for THIS
 * checkout (`repoPath` is what install writes: the checkout's realpath). A
 * manifest that does not parse refuses the command: it may be this checkout's
 * own service, and skipping it would install a second unit beside it. The
 * chosen manifest is still read with full validation by the caller.
 */
function checkoutServiceManifests(fs: ServiceFs, baseDir: string): string[] {
  const serviceDir = join(baseDir, 'service');
  if (!fs.existsSync(serviceDir)) return [];
  const repoPath = fs.realpathSync(CWD);
  const owned: string[] = [];
  for (const entry of fs.readdirSync(serviceDir)) {
    const name = String(entry);
    if (!name.endsWith('.json')) continue;
    let manifest: Partial<ServiceManifest> | null = null;
    try {
      manifest = JSON.parse(
        fs.readFileSync(join(serviceDir, name), 'utf8'),
      ) as Partial<ServiceManifest>;
    } catch (error) {
      throw new Error(
        `Cannot tell which Station user service in ${serviceDir} belongs to this checkout: ${name} is not a readable service manifest (${error instanceof Error ? error.message : String(error)}).\nRepair or remove it, or pass --instance=<name> to choose a service explicitly.`,
      );
    }
    if (
      manifest &&
      typeof manifest === 'object' &&
      manifest.instanceId === name.slice(0, -'.json'.length) &&
      manifest.repoPath === repoPath
    ) {
      owned.push(manifest.instanceId);
    }
  }
  return owned.sort();
}

/**
 * station#2689: from a source checkout the launcher selects the development
 * channel and exports this checkout's derived instance id (see
 * `sourceCheckoutDevInstanceId`), so with no --home/--base/STATION_HOME the
 * home is `<STATION_ROOT>/instances/dev/<that id>`. With no --instance the
 * service simply takes that id (`resolveServiceInstanceId`). An EXPLICIT
 * --instance naming anything else contradicts that home — it would bind a
 * machine-wide unit name such as `default` to one worktree's development
 * home — so the install refuses and says how to state what was meant.
 */
function assertInstallDoesNotBorrowDevHome(
  instanceId: string,
  lifecycle: ServiceLifecycleArgs,
): void {
  if (!lifecycle.instanceName?.trim()) return;
  if (lifecycle.homeSource !== 'default') return;
  const devInstanceId = sourceCheckoutDevInstanceId();
  if (!devInstanceId || instanceId === devInstanceId) return;
  throw new Error(
    [
      `Refusing to install Station user service ${instanceId} into this source checkout's development home ${lifecycle.baseDir}.`,
      `That home belongs to the development instance ${devInstanceId}; it was chosen because no --home, --base, or STATION_HOME was given.`,
      `  --instance=${devInstanceId}  names the service after the home it runs in.`,
      `  --instance=${instanceId} --base=${lifecycle.baseDir}  keeps an existing ${instanceId} service where it is.`,
      `  --instance=${instanceId} --home=<dir>  moves the ${instanceId} service to its own durable home (data in the current home is not copied).`,
    ].join('\n'),
  );
}

export function assertServiceIdentityAvailable(instanceId: string): void {
  const unitName = `station-${instanceId}.service`;
  const labels = [
    `io.kontourai.station.${instanceId}`,
    `io.kontourai.station-${instanceId}`,
    `ai.kontour.station.${instanceId}`,
    `ai.kontour.station-${instanceId}`,
    `ai.kontour.command-station.${instanceId}`,
  ];
  if (
    unitName === RESERVED_SYSTEMD_UNIT ||
    labels.some((label) =>
      (RESERVED_LAUNCHD_LABELS as readonly string[]).includes(label),
    )
  ) {
    throw new Error(
      `Service instance "${instanceId}" is reserved for Station dogfood infrastructure`,
    );
  }
}

/**
 * The registry entry's `env` can carry arbitrary operator secrets (e.g.
 * `API_TOKEN`), so status output must never serialize it. Project the entry to
 * its non-secret identity fields plus a safe `allowedOrigins` derived from
 * `env.ALLOWED_ORIGINS`; drop `env` entirely. Dropping the whole `env` map
 * (rather than allowlisting keys) keeps this safe as future operator env is
 * added.
 */
function redactRegistryForStatus(
  registry: ReturnType<typeof readInstanceRegistry>['instances'][string] | null,
): InstanceState['registry'] {
  if (registry === null) return null;
  return {
    port: registry.port,
    ...(registry.uiPort === undefined ? {} : { uiPort: registry.uiPort }),
    type: registry.type,
    ...(registry.checkout === undefined ? {} : { checkout: registry.checkout }),
    ...(registry.channel === undefined ? {} : { channel: registry.channel }),
    ...(registry.buildSha === undefined ? {} : { buildSha: registry.buildSha }),
    ...(registry.builtAt === undefined ? {} : { builtAt: registry.builtAt }),
    ...(registry.status === undefined ? {} : { status: registry.status }),
    ...(registry.pid === undefined ? {} : { pid: registry.pid }),
    ...(registry.startedAt === undefined
      ? {}
      : { startedAt: registry.startedAt }),
    allowedOrigins:
      registry.env?.ALLOWED_ORIGINS?.split(',').filter(Boolean) ?? [],
  };
}

function renderStatus(
  state: InstanceState,
  scheduling: ServiceSchedulingPolicy,
  servicePath: ServicePathDrift | null,
  remedy: ServiceInstallRemedy | null,
  json: boolean,
): void {
  const installed = state.installation !== 'absent';
  const schedulingHealthy = isSchedulingPolicyHealthy(scheduling);
  const healthy =
    installed &&
    state.manifest === 'present' &&
    state.supervisor.state === 'active' &&
    state.supervisor.enabled !== false &&
    state.supervisor.linger !== false &&
    state.ready &&
    schedulingHealthy;
  const { state: _identityState, ...instance } = state.identity;
  const result = {
    healthy,
    installed,
    instance,
    manifest: state.manifestDetails,
    registry: state.registry,
    scheduling,
    ...(servicePath === null ? {} : { servicePath }),
    unit: state.unit,
  };
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log('LAYER          STATUS');
  console.log(`installation   ${installed ? 'installed' : 'not installed'}`);
  console.log(
    `service unit   ${state.supervisor.error !== null ? 'unknown' : state.supervisor.state}`,
  );
  console.log(
    `instance       ${state.identity.found ? 'running' : 'not running'}`,
  );
  console.log(
    `reachability   ${state.ready ? 'identity verified' : 'unhealthy'}`,
  );
  if (state.allowedOrigins.length) {
    console.log(`origins        ${state.allowedOrigins.join(', ')}`);
  }
  // Scheduling and PATH drift share one remedy; print it once, under the
  // first layer that needs it.
  let remedyPrinted = false;
  const printRemedy = () => {
    if (remedyPrinted) return;
    remedyPrinted = true;
    console.log(
      remedy?.command
        ? `               run: ${remedy.command}`
        : `               reinstall command unavailable: ${remedy?.reason ?? 'this registration does not record every setting. Inspect its manifest before reinstalling.'}`,
    );
  };
  if (scheduling.status === 'stale') {
    console.log(
      `scheduling     stale (${scheduling.observed}, expected ${scheduling.expected})`,
    );
    printRemedy();
  } else if (scheduling.status === 'current') {
    console.log(`scheduling     current (${scheduling.observed})`);
  } else if (scheduling.status === 'operator-override') {
    console.log(`scheduling     operator override (${scheduling.observed})`);
  } else {
    console.log(
      `scheduling     unknown (${scheduling.reason ?? 'policy could not be read'})`,
    );
  }
  if (servicePath?.status === 'current') {
    console.log('service PATH   current (matches your login-shell PATH)');
  } else if (servicePath?.status === 'drifted') {
    console.log(
      'service PATH   drifted (captured at install; a reinstall would capture a different PATH now)',
    );
    if (servicePath.missing.length > 0) {
      console.log(
        `               missing from the unit: ${servicePath.missing.join(', ')}`,
      );
    }
    if (servicePath.stale.length > 0) {
      console.log(
        `               no longer captured: ${servicePath.stale.join(', ')}`,
      );
    }
    if (servicePath.reordered) {
      const { position, unit, current } = servicePath.reordered;
      console.log(
        `               same directories in a different order (first difference at shared position ${position + 1}: the unit has ${unit}, a reinstall would put ${current})`,
      );
    }
    console.log(
      servicePath.missing.length > 0
        ? '               engines installed only in a missing directory can go undetected by the service; reinstall to recapture PATH'
        : '               reinstall to recapture PATH',
    );
    printRemedy();
  } else if (servicePath?.status === 'unknown') {
    console.log(`service PATH   unknown (${servicePath.reason})`);
  }
  if (state.supervisor.error !== null) {
    console.log(`backend probe  unknown (${state.supervisor.error})`);
  }
}

/** Read-only OS-service inspection for `station target` and other clients. */
export function inspectServiceInstallation(
  lifecycle: ServiceLifecycleArgs,
  dependencies: ServiceDependencies = {},
): ServiceInspection {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    throw new Error(`Station user services are unsupported on ${platform}`);
  }
  const fs = dependencies.fs ?? nodeFs;
  const run = dependencies.run ?? defaultRun;
  const instanceId = resolveServiceTarget(lifecycle, fs);
  assertServiceIdentityAvailable(instanceId);
  const registration =
    platform === 'darwin'
      ? launchdRegistration(instanceId, lifecycle)
      : platform === 'linux'
        ? systemdRegistration(instanceId, lifecycle)
        : windowsRegistration(instanceId, lifecycle);
  const legacyRegistrations =
    platform === 'darwin'
      ? legacyLaunchdRegistrations(instanceId, lifecycle)
      : undefined;
  const manifest = readManifest(
    fs,
    join(lifecycle.baseDir, 'service', `${instanceId}.json`),
    instanceId,
    registration,
    run,
    legacyRegistrations,
  );
  const registry =
    readInstanceRegistry(lifecycle.baseDir).instances[instanceId] ?? null;
  const target = manifest ?? registration;
  const unit =
    platform === 'darwin'
      ? launchdStatus(target, { fs, run })
      : platform === 'linux'
        ? systemdStatus(target, { fs, run })
        : windowsServiceStatus(target, { fs, run });
  return { instanceId, manifest, registry, unit };
}

function createServiceInstancePlatformAdapter(input: {
  existing: ServiceManifest | null;
  registration: ServiceRegistration;
  fs: ServiceFs;
  lifecycle: ServiceLifecycleArgs;
  run: CommandRunner;
  dependencies: ServiceDependencies;
}): StationInstancePlatformAdapter {
  const { existing, registration, fs, lifecycle, run, dependencies } = input;
  const target = existing ?? registration;
  const unitStatus = () =>
    target.platform === 'darwin'
      ? launchdStatus(target, { fs, run })
      : target.platform === 'linux'
        ? systemdStatus(target, { fs, run })
        : windowsServiceStatus(target, { fs, run });
  const supervisorState = (
    unit: Record<string, boolean | string | null>,
  ): InstanceState['supervisor'] => ({
    state:
      typeof unit.error === 'string' || unit.active === null
        ? 'unknown'
        : unit.active === true
          ? 'active'
          : 'inactive',
    present: unit.present === true,
    enabled: typeof unit.enabled === 'boolean' ? unit.enabled : null,
    linger: typeof unit.linger === 'boolean' ? unit.linger : null,
    error: typeof unit.error === 'string' ? unit.error : null,
  });
  return {
    acquireInstanceLock: (ref, options) => {
      const serviceDirectory = join(lifecycle.baseDir, 'service');
      // The lock is intentionally one contained, owner-only file per
      // normalized instance. It neither serializes unrelated instances nor
      // follows a caller-controlled path outside Station's service directory.
      ensureWindowsDirectoriesTrusted(run, [
        dirname(serviceDirectory),
        serviceDirectory,
      ]);
      fs.mkdirSync(serviceDirectory, { mode: 0o700, recursive: true });
      fs.chmodSync(serviceDirectory, 0o700);
      return acquireFileMutationLock(
        join(serviceDirectory, `${ref.instanceId}.reconcile`),
        { timeoutMs: options.timeoutMs },
      );
    },
    async inspect(ref) {
      const unit = unitStatus();
      const status = await collectInstanceStatus(ref.instanceId);
      const supervisor = supervisorState(unit);
      const registry =
        readInstanceRegistry(lifecycle.baseDir).instances[ref.instanceId] ??
        null;
      return {
        version: STATION_INSTANCE_STATE_VERSION,
        instance: ref,
        manifest: existing === null ? 'absent' : 'present',
        manifestDetails: existing,
        allowedOrigins: existing?.allowedOrigins ?? [],
        registry: redactRegistryForStatus(registry),
        installation:
          existing !== null
            ? 'managed'
            : supervisor.present ||
                supervisor.state === 'active' ||
                supervisor.enabled === true
              ? 'orphaned'
              : 'absent',
        supervisor,
        unit: unit as InstanceState['unit'],
        identity: {
          state: status.healthy
            ? 'healthy'
            : status.found
              ? 'unhealthy'
              : 'absent',
          healthy: status.healthy,
          found: status.found,
          instanceId: status.instanceId,
          ...(status.bootId === undefined ? {} : { bootId: status.bootId }),
          ...(status.sha === undefined ? {} : { sha: status.sha }),
          server: status.server,
          ui: status.ui,
        },
        ready: status.healthy,
        ports: {
          server: existing?.serverPort ?? null,
          ui: existing?.uiPort ?? null,
        },
      };
    },
    async start() {
      if (!existing) throw new Error('Station service is not installed');
      if (existing.platform === 'darwin') startLaunchd(existing, { fs, run });
      else if (existing.platform === 'linux')
        startSystemd(existing, { fs, run });
      else {
        assertWindowsServiceExecutionTrusted(existing, lifecycle, run);
        startWindowsService(existing, { fs, run });
      }
    },
    async stop() {
      if (!existing) throw new Error('Station service is not installed');
      if (existing.platform === 'darwin') stopLaunchd(existing, { fs, run });
      else if (existing.platform === 'linux')
        stopSystemd(existing, { fs, run });
      else
        await stopAndWaitForWindowsSupervisorExit(
          existing.instanceId,
          existing,
          dependencies,
          fs,
          run,
        );
      if (existing.platform !== 'win32')
        stop({ instanceName: existing.instanceId });
    },
    async waitForRunning(ref) {
      try {
        await waitForInstalledServiceIdentity(ref.instanceId, dependencies);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export async function runServiceCommand(
  args: string[],
  lifecycle: ServiceLifecycleArgs,
  dependencies: ServiceDependencies = {},
): Promise<ServiceInstallReceipt | undefined> {
  const [action] = args;
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    throw new Error(`Station user services are unsupported on ${platform}`);
  }
  if (
    !['install', 'start', 'status', 'stop', 'uninstall', 'run'].includes(
      action ?? '',
    )
  ) {
    throw new Error(
      'Usage: station service <install|start|status|stop|uninstall|run> [flags]',
    );
  }
  if (lifecycle.homeSource === '--temp-home') {
    throw new Error('--temp-home cannot be used with service commands');
  }

  const fs = dependencies.fs ?? nodeFs;
  const run = dependencies.run ?? defaultRun;
  const hardenPaths =
    dependencies.hardenWindowsPaths ?? hardenWindowsPathsTrusted;
  const instanceId = resolveServiceTarget(lifecycle, fs);
  assertServiceIdentityAvailable(instanceId);
  const manifestPath = join(lifecycle.baseDir, 'service', `${instanceId}.json`);
  const registration =
    platform === 'darwin'
      ? launchdRegistration(instanceId, lifecycle)
      : platform === 'linux'
        ? systemdRegistration(instanceId, lifecycle)
        : windowsRegistration(instanceId, lifecycle);
  const legacyRegistrations =
    platform === 'darwin'
      ? legacyLaunchdRegistrations(instanceId, lifecycle)
      : undefined;
  const existing = readManifest(
    fs,
    manifestPath,
    instanceId,
    registration,
    run,
    legacyRegistrations,
  );
  const priorManifestContent = existing
    ? fs.readFileSync(manifestPath, 'utf8')
    : null;
  const priorRegistryEntry =
    readInstanceRegistry(lifecycle.baseDir).instances[instanceId] ?? null;

  if (action === 'run') {
    await superviseService({ ...lifecycle, instanceName: instanceId });
    return;
  }

  if (action === 'install') {
    assertSupportedNodeVersion();
    assertInstallDoesNotBorrowDevHome(instanceId, lifecycle);
    // Establish the home identity FIRST, while the home is still fresh — before
    // the registry write below makes it non-empty. Writing instances.json into
    // an unestablished home would otherwise trip the fresh-home schema guard
    // (STATION_HOME_RESET_REQUIRED) on the subsequent sync.
    ensureStationHomeSchemaSync(lifecycle.baseDir);
    const registryEntry =
      readInstanceRegistry(lifecycle.baseDir).instances[instanceId] ?? null;
    // Origin policy derives only from a prior SERVICE entry. A foreign-typed
    // (CLI) entry at this id must neither seed ALLOWED_ORIGINS nor have its
    // env carried into the service record — the same inheritance class as
    // #3047's pid/birth chimera, through env instead — and its presence must
    // not suppress the manifest migration bridge below.
    const priorServiceEntry =
      registryEntry?.type === 'service' ? registryEntry : null;
    // The registry is the durable authority. The manifest only seeds an
    // absent registry entry during the one-time migration bridge.
    const effectiveAllowedOrigins = (
      lifecycle.clearAllowedOrigins
        ? []
        : (lifecycle.allowedOrigins ??
          priorServiceEntry?.env?.ALLOWED_ORIGINS?.split(',').filter(Boolean) ??
          (priorServiceEntry === null ? existing?.allowedOrigins : undefined) ??
          [])
    ).map(parseAllowedOriginFlag);
    lifecycle = {
      ...lifecycle,
      allowedOrigins: effectiveAllowedOrigins,
      // Same derivation as the CLI spawn path: `--base` selects baseDir but
      // never reaches process.env, so a bare call would pin the shared
      // ~/.station root against an isolated home.
      //
      // Undefined for a self-rooted base, and the generated unit then carries
      // no root: spelling out `STATION_ROOT === STATION_HOME` is what the
      // runtime home guard reads as a home swallowing a root it does not own,
      // so the installed service would refuse to boot. The runtime derives the
      // same root from STATION_HOME alone.
      stationRoot: spawnedStationRoot(lifecycle.baseDir, process.env),
    };
    // ONE-OWNER PRE-CHECK (station#3047): refuse before any backend mutation
    // when the registry id is held by a LIVE process this install does not
    // own — ordinarily a CLI `station start` under the shared default id
    // (both surfaces resolve ids through resolveLifecycleInstanceId, except
    // the development-checkout case handled just below).
    // Proceeding used to upsert-merge over that entry, inheriting the CLI
    // process's pid/birth into a `type: 'service'` chimera that flipped
    // Desktop's home-ownership decision. Dead entries do not refuse — the
    // authoritative claim below replaces them cleanly. The claim re-checks
    // this under the mutation lock; this early copy only exists so the
    // common case fails in milliseconds with nothing to roll back (#1983
    // keeps the registry write itself after the fallible backend ops).
    // Type-aware (station#3064): a live SERVICE entry at this id is THIS
    // unit's own supervisor — the backend install protocol stops and
    // replaces that generation itself, so reinstall must not refuse on it.
    // A live entry of any other type is a foreign writer and still refuses.
    if (
      registryEntry &&
      registryEntry.type !== 'service' &&
      entryOwnedByLiveProcess(registryEntry)
    ) {
      throw new Error(
        `Instance id '${instanceId}' is owned by a live process (pid ${registryEntry.pid}, type '${registryEntry.type}'${registryEntry.checkout ? `, from ${registryEntry.checkout}` : ''}). Stop it first (\`station stop --instance=${instanceId}\` from its checkout) or install under a distinct --instance name.`,
      );
    }
    // station#2689: a source-checkout service without --instance takes the
    // development instance id (resolveServiceInstanceId), but `station start`
    // from the same checkout — or another checkout's service in a shared dev
    // home — still holds this very home under the lifecycle id (`default`).
    // The check above no longer sees that entry, so look it up too.
    const lifecycleInstanceId = resolveLifecycleInstanceId({
      cwd: CWD,
      instanceName: lifecycle.instanceName,
      projectHome: lifecycle.baseDir,
      serverPort: lifecycle.serverPort,
      uiPort: lifecycle.uiPort,
    });
    const lifecycleEntry =
      lifecycleInstanceId === instanceId
        ? null
        : (readInstanceRegistry(lifecycle.baseDir).instances[
            lifecycleInstanceId
          ] ?? null);
    // Unlike the check above, a live SERVICE entry refuses too: it is not this
    // unit's own supervisor (manifest-first resolution already chose that
    // service when it belongs to this checkout), so it is a second writer.
    if (lifecycleEntry && entryOwnedByLiveProcess(lifecycleEntry)) {
      throw new Error(
        `Station home ${lifecycle.baseDir} is in use by instance '${lifecycleInstanceId}' (pid ${lifecycleEntry.pid}, type '${lifecycleEntry.type}'${lifecycleEntry.checkout ? `, from ${lifecycleEntry.checkout}` : ''}), which service '${instanceId}' would share. Stop it first (\`station stop --instance=${lifecycleInstanceId}\` from its checkout).`,
      );
    }
    // service run builds stale artifacts before it can publish an identity.
    // Do that before replacing the old supervisor so the bounded readiness
    // poll observes only the new generation's boot, not its cold UI build.
    await (dependencies.prepareServiceBuild ?? prepareServiceBuild)(
      lifecycle,
      instanceId,
    );
    const repoPath = fs.realpathSync(CWD);
    const nodePath = fs.realpathSync(process.execPath);
    // A backend reinstall has an owned prior supervisor. Retain its verified
    // boot identity and require readiness to observe a different one after
    // the backend has stopped and replaced it.
    const priorInstance = existing
      ? await collectInstanceStatus(instanceId)
      : undefined;
    const replacedBootId = priorInstance?.healthy
      ? priorInstance.bootId
      : undefined;
    const priorWindowsTask =
      existing?.platform === 'win32'
        ? windowsServiceStatus(existing, { fs, run })
        : undefined;
    if (typeof priorWindowsTask?.error === 'string') {
      throw new Error(
        `Cannot reinstall Station Task Scheduler service while backend status is unknown: ${priorWindowsTask.error}`,
      );
    }
    if (existing?.platform === 'win32') {
      // Task Scheduler's /End can leave the Node child alive after its cmd
      // wrapper exits. Converge both the exact lifecycle instance and task
      // before the backend can replace its wrapper.
      await stopAndWaitForWindowsSupervisorExit(
        instanceId,
        existing,
        dependencies,
        fs,
        run,
      );
    }
    const common = {
      fs,
      lifecycle,
      nodePath,
      repoPath,
      run,
    };
    const manifest =
      platform === 'darwin'
        ? installLaunchd(instanceId, {
            ...common,
            servicePath: captureServicePath(run, fs),
            ...(priorInstance?.found
              ? {
                  stopOwnedInstance: () => stop({ instanceName: instanceId }),
                }
              : {}),
          })
        : platform === 'linux'
          ? installSystemd(instanceId, {
              ...common,
              servicePath: captureServicePath(run, fs),
            })
          : installWindowsService(instanceId, common);
    manifest.installedAt = (
      dependencies.now ?? (() => new Date())
    )().toISOString();
    manifest.baseDir = lifecycle.baseDir;
    manifest.stationRoot = lifecycle.stationRoot;
    manifest.features = lifecycle.features ?? null;
    manifest.allowedOrigins = effectiveAllowedOrigins;
    let rolledBack = false;
    const compensate = async (
      options: { restoreRegistry?: boolean } = {},
    ): Promise<void> => {
      let replacementBootId: string | undefined;
      if (manifest.platform === 'win32') {
        const replacement = await collectInstanceStatus(instanceId);
        replacementBootId = replacement.found ? replacement.bootId : undefined;
        await stopAndWaitForWindowsSupervisorExit(
          instanceId,
          manifest,
          dependencies,
          fs,
          run,
        );
      }
      if (manifest.rollback) {
        await manifest.rollback();
      } else if (manifest.platform === 'darwin') {
        uninstallLaunchd(manifest, { fs, run });
      } else if (manifest.platform === 'linux') {
        uninstallSystemd(manifest, { fs, run });
      } else {
        uninstallWindowsService(manifest, { fs, run });
      }
      restoreManifest(fs, manifestPath, priorManifestContent, run, hardenPaths);
      if (options.restoreRegistry !== false) {
        if (priorRegistryEntry === null) {
          removeInstance(instanceId, lifecycle.baseDir);
        } else {
          // Exact restore of the captured prior entry — replace, not merge,
          // so no field of the failed install's entry survives into it.
          replaceInstance(instanceId, priorRegistryEntry, lifecycle.baseDir);
        }
      }
      if (manifest.platform === 'win32' && priorWindowsTask?.active === true) {
        // The restored active task must start a new managed identity, not
        // merely inherit the replacement generation that rollback stopped.
        await waitForInstalledServiceIdentity(
          instanceId,
          dependencies,
          replacementBootId,
        );
      }
    };
    // Persist the registry (the durable origin-policy authority) only AFTER
    // the fallible backend operations above have succeeded. Writing it
    // earlier let a failed install durably change ALLOWED_ORIGINS that a
    // later flagless reinstall would activate (station#1983). compensate()
    // restores the prior entry if manifest publication or readiness fails
    // after this point.
    //
    // claimInstanceEntry REPLACES rather than merges (station#3047): the old
    // upsert kept every field its partial omitted, so installing over a CLI
    // entry produced a `type: 'service'` record still carrying the CLI
    // process's pid/birth — which Desktop's home-ownership decision then
    // read as a live service. The claim also refuses (under the mutation
    // lock) if a live foreign owner appeared since the pre-check above; in
    // that race the registry was NOT written, so roll back the backend but
    // leave the registry alone — restoring `priorRegistryEntry` would
    // clobber the entry the live owner just wrote.
    let claim: ReturnType<typeof claimInstanceEntry>;
    try {
      claim = claimInstanceEntry(
        instanceId,
        {
          port: lifecycle.serverPort,
          uiPort: lifecycle.uiPort,
          type: 'service',
          env: {
            ...priorServiceEntry?.env,
            ALLOWED_ORIGINS: effectiveAllowedOrigins.join(','),
          },
        },
        { home: lifecycle.baseDir, adoptTypes: ['service'] },
      );
    } catch (error) {
      // A registry read/publish I/O failure here would otherwise strand a
      // fully installed backend with no manifest and no compensation
      // (#3047 review LOW-2). In the common failure modes the registry was
      // not durably written (publish can throw after its rename only in a
      // narrow post-rename verify race), so roll back the backend without
      // touching the registry — and never let a failed rollback mask the
      // original error (the file's combined-message pattern).
      try {
        await compensate({ restoreRegistry: false });
      } catch (rollbackError) {
        throw new Error(
          `Service registry claim failed (${(error as Error).message}); backend rollback also failed (${(rollbackError as Error).message})`,
        );
      }
      throw error;
    }
    if (!claim.written) {
      const refusal = `Instance id '${instanceId}' was claimed by a live process (pid ${claim.existing.pid}, type '${claim.existing.type}') during installation. Stop that process or install under a distinct --instance name.`;
      try {
        await compensate({ restoreRegistry: false });
      } catch (rollbackError) {
        throw new Error(
          `${refusal} The backend install could not be rolled back (${(rollbackError as Error).message}).`,
        );
      }
      throw new Error(`${refusal} The backend install was rolled back.`);
    }
    let rollbackPromise: Promise<void> | undefined;
    const receipt: ServiceInstallReceipt = {
      instanceId,
      rollback: () => {
        if (rolledBack) return Promise.resolve();
        if (rollbackPromise) return rollbackPromise;
        rollbackPromise = (async () => {
          try {
            await compensate();
            rolledBack = true;
          } catch (error) {
            throw new Error(
              `Failed to compensate Station user service ${instanceId}: ${(error as Error).message}`,
            );
          }
        })();
        return rollbackPromise;
      },
    };
    try {
      writeManifest(fs, manifestPath, manifest, run, hardenPaths);
    } catch (error) {
      try {
        await receipt.rollback();
      } catch (rollbackError) {
        throw new Error(
          `Service manifest write failed (${(error as Error).message}); backend rollback also failed (${(rollbackError as Error).message})`,
        );
      }
      throw error;
    }
    try {
      await waitForInstalledServiceIdentity(
        instanceId,
        dependencies,
        replacedBootId,
      );
    } catch (error) {
      try {
        await receipt.rollback();
      } catch (rollbackError) {
        let recoveryDetail: string;
        try {
          // Compensation has already failed to restore the old generation.
          // Reinstall without the replacement stop hook: its prior drain is
          // the failed operation, while this bounded attempt must leave one
          // startable generation on the machine if the backend still can.
          const recovered =
            manifest.platform === 'darwin'
              ? installLaunchd(instanceId, {
                  ...common,
                  servicePath: captureServicePath(run, fs),
                })
              : manifest.platform === 'linux'
                ? installSystemd(instanceId, {
                    ...common,
                    servicePath: captureServicePath(run, fs),
                  })
                : installWindowsService(instanceId, common);
          recovered.installedAt = (
            dependencies.now ?? (() => new Date())
          )().toISOString();
          recovered.allowedOrigins = effectiveAllowedOrigins;
          writeManifest(fs, manifestPath, recovered, run, hardenPaths);
          // Same replace-not-merge claim as the primary path (station#3047).
          // Emergency recovery is best-effort: a live-owner refusal here is
          // recorded in the recovery detail rather than unwinding the one
          // startable generation this path exists to leave behind.
          const recoveryClaim = claimInstanceEntry(
            instanceId,
            {
              port: lifecycle.serverPort,
              uiPort: lifecycle.uiPort,
              type: 'service',
              env: {
                ...priorServiceEntry?.env,
                ALLOWED_ORIGINS: effectiveAllowedOrigins.join(','),
              },
            },
            { home: lifecycle.baseDir, adoptTypes: ['service'] },
          );
          const recoveryRegistryNote = recoveryClaim.written
            ? ''
            : ` Its registry entry could not be recorded: instance id '${instanceId}' is held by a live process (pid ${recoveryClaim.existing.pid}).`;
          await waitForInstalledServiceIdentity(instanceId, dependencies);
          const status = await collectInstanceStatus(instanceId);
          recoveryDetail = `A replacement Station generation is running${status.bootId ? ` (boot ID ${status.bootId})` : ''}.${recoveryRegistryNote}`;
        } catch (recoveryError) {
          try {
            const status = await collectInstanceStatus(instanceId);
            recoveryDetail = status.healthy
              ? `A Station generation remains running${status.bootId ? ` (boot ID ${status.bootId})` : ''}, but emergency recovery failed: ${(recoveryError as Error).message}`
              : `No healthy Station generation could be confirmed running after emergency recovery failed: ${(recoveryError as Error).message}`;
          } catch (statusError) {
            recoveryDetail = `No Station generation could be confirmed running after emergency recovery failed: ${(recoveryError as Error).message}; status check failed: ${(statusError as Error).message}`;
          }
        }
        throw new Error(
          `Station user service ${instanceId} failed readiness (${(error as Error).message}); compensation also failed (${(rollbackError as Error).message}). Emergency recovery attempted. ${recoveryDetail}`,
        );
      }
      throw error;
    }
    console.log(`✓ Installed Station user service ${instanceId}`);
    return receipt;
  }

  if (action === 'uninstall') {
    const target = existing ?? registration;
    if (target.platform === 'darwin') uninstallLaunchd(target, { fs, run });
    else if (target.platform === 'linux') uninstallSystemd(target, { fs, run });
    else uninstallWindowsService(target, { fs, run });
    stop({ instanceName: instanceId });
    fs.rmSync(manifestPath, { force: true });
    console.log(
      existing
        ? `✓ Uninstalled Station user service ${instanceId}`
        : `✓ Reconciled absent Station user service ${instanceId}`,
    );
    return;
  }

  let observed: InstanceState | undefined;
  if (action === 'start' || action === 'stop') {
    const reconciler = createStationInstanceReconciler(
      createServiceInstancePlatformAdapter({
        existing,
        registration,
        fs,
        lifecycle,
        run,
        dependencies,
      }),
    );
    const outcome = await reconciler.reconcile({
      instance: { version: STATION_INSTANCE_STATE_VERSION, instanceId },
      desired: {
        version: STATION_INSTANCE_STATE_VERSION,
        kind: action === 'start' ? 'running' : 'stopped',
      },
      deadlineMs: dependencies.installReadinessTimeoutMs,
    });
    switch (outcome.kind) {
      case 'converged':
      case 'already-converged':
        observed = outcome.observed;
        break;
      case 'not-installed':
        console.error(
          `Cannot ${action} Station user service ${instanceId}: no service manifest found at ${manifestPath}. Run \`station service install\` first.`,
        );
        process.exitCode = 1;
        return;
      case 'timed-out':
      case 'contended':
      case 'partial':
      case 'failed':
        console.error(
          `${action} reconciliation ${outcome.kind}: ${outcome.reason}`,
        );
        process.exitCode = 1;
        return;
    }
  }

  observed ??= await createStationInstanceReconciler(
    createServiceInstancePlatformAdapter({
      existing,
      registration,
      fs,
      lifecycle,
      run,
      dependencies,
    }),
  ).inspect({ version: STATION_INSTANCE_STATE_VERSION, instanceId });
  const scheduling = inspectServiceSchedulingPolicy(existing ?? registration, {
    run,
  });
  // Compared only for a managed install: without a manifest there is no unit
  // Station wrote, so no captured PATH to speak about.
  const servicePath = existing
    ? inspectServicePathDrift(existing, { fs, run })
    : null;
  const remedy = existing
    ? resolveServiceInstallRemedy(existing, lifecycle.baseDir)
    : null;
  renderStatus(
    observed,
    scheduling,
    servicePath,
    remedy,
    args.includes('--json'),
  );
  if (action === 'start' || action === 'stop') {
    if (observed.supervisor.error !== null) {
      process.exitCode = 1;
    } else if (
      (action === 'start' && observed.supervisor.state !== 'active') ||
      (action === 'stop' && observed.supervisor.state !== 'inactive')
    ) {
      process.exitCode = 1;
    }
    return;
  }
  const healthy =
    observed.installation !== 'absent' &&
    observed.manifest === 'present' &&
    observed.supervisor.state === 'active' &&
    observed.supervisor.enabled !== false &&
    observed.supervisor.linger !== false &&
    observed.ready &&
    isSchedulingPolicyHealthy(scheduling);
  if (!healthy) {
    process.exitCode = 1;
  }
}
