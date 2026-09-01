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
import { sanitizePath } from '@kontourai/station-shared/launch-path';
import { acquireFileMutationLock } from '@kontourai/station-shared/lifecycle-events';
import { assertSupportedNodeVersion } from '@kontourai/station-shared/node-runtime';
import { spawnedStationRoot } from '@kontourai/station-shared/runtime-path-resolver';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import {
  CWD,
  type LifecycleHomeSource,
  resolveLifecycleInstanceId,
} from './helpers.js';
import {
  buildApplication,
  collectInstanceStatus,
  isBuildStale,
  resolveBuildPaths,
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
import { renderServiceInstallRemedy } from './service-remedy.js';
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
  if (!isBuildStale(resolveBuildPaths(instanceId))) return;
  await buildApplication({
    baseDir: lifecycle.baseDir,
    instanceName: instanceId,
    serverPort: lifecycle.serverPort,
    uiPort: lifecycle.uiPort,
  });
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
  const shell = process.env.SHELL || '/bin/sh';
  const marker = '__STATION_SERVICE_PATH__';
  const result = run(
    shell,
    ['-l', '-c', `printf '${marker}%s${marker}\\n' "$PATH"`],
    { env: process.env },
  );
  const match =
    result.status === 0
      ? result.stdout?.match(new RegExp(`${marker}(.*)${marker}`))
      : null;
  const nodeDir = dirname(fs.realpathSync(process.execPath));
  const candidates = [
    nodeDir,
    ...(match?.[1] ?? process.env.PATH ?? '').split(':'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  const sanitized = sanitizePath(candidates.join(':'), {
    lstatSync: fs.lstatSync,
    realpathSync: fs.realpathSync,
  });
  if (!sanitized.accepted.includes(nodeDir)) {
    throw new Error(
      `Unsafe Node executable directory for service PATH: ${nodeDir}`,
    );
  }
  return sanitized.accepted.join(':');
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
  remedy: string | null,
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
  if (scheduling.status === 'stale') {
    console.log(
      `scheduling     stale (${scheduling.observed}, expected ${scheduling.expected})`,
    );
    if (remedy) console.log(`               run: ${remedy}`);
    else
      console.log(
        '               reinstall command unavailable: this registration does not record every setting. Inspect its manifest before reinstalling.',
      );
  } else if (scheduling.status === 'current') {
    console.log(`scheduling     current (${scheduling.observed})`);
  } else if (scheduling.status === 'operator-override') {
    console.log(`scheduling     operator override (${scheduling.observed})`);
  } else {
    console.log(
      `scheduling     unknown (${scheduling.reason ?? 'policy could not be read'})`,
    );
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
  const instanceId = resolveLifecycleInstanceId({
    cwd: CWD,
    instanceName: lifecycle.instanceName,
    projectHome: lifecycle.baseDir,
    serverPort: lifecycle.serverPort,
    uiPort: lifecycle.uiPort,
  });
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
      'Usage: station service <install|start|status|stop|uninstall> [flags]',
    );
  }
  if (lifecycle.homeSource === '--temp-home') {
    throw new Error('--temp-home cannot be used with service commands');
  }

  const fs = dependencies.fs ?? nodeFs;
  const run = dependencies.run ?? defaultRun;
  const hardenPaths =
    dependencies.hardenWindowsPaths ?? hardenWindowsPathsTrusted;
  const instanceId = resolveLifecycleInstanceId({
    cwd: CWD,
    instanceName: lifecycle.instanceName,
    projectHome: lifecycle.baseDir,
    serverPort: lifecycle.serverPort,
    uiPort: lifecycle.uiPort,
  });
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
    // (both surfaces resolve ids through resolveLifecycleInstanceId).
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
  const remedy = existing
    ? renderServiceInstallRemedy(existing, lifecycle.baseDir)
    : null;
  renderStatus(observed, scheduling, remedy, args.includes('--json'));
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
