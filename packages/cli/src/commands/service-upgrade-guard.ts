import { join } from 'node:path';
import type {
  CommandRunner,
  ServiceFs,
  ServiceRegistration,
} from './service.js';
import { launchdStatus } from './service-launchd.js';
import { systemdStatus } from './service-systemd.js';
import { windowsServiceStatus } from './service-windows.js';

/**
 * An installed service that is (or may be) supervising a Station from the
 * tree `station upgrade` is about to replace (#2674).
 */
export interface SupervisingService {
  instanceId: string;
  /** `unknown`: the backend probe could not say, so it is not ruled out. */
  state: 'active' | 'unknown';
  detail: string | null;
}

interface SupervisingServiceDependencies {
  fs: Pick<
    ServiceFs,
    'existsSync' | 'readFileSync' | 'readdirSync' | 'realpathSync'
  >;
  platform: NodeJS.Platform;
  run: CommandRunner;
  /**
   * Only services installed from this checkout (the manifest's `repoPath`,
   * which `service install` records as the realpath of its cwd). Omitted for
   * a packaged install, whose installer replaces what every service in the
   * home runs.
   */
  repoPath?: string;
}

function realpathOrSelf(
  fs: SupervisingServiceDependencies['fs'],
  path: string,
): string {
  try {
    return fs.realpathSync(path);
  } catch {
    return path;
  }
}

type ServicePlatform = 'darwin' | 'linux' | 'win32';

function readManifestObject(
  fs: SupervisingServiceDependencies['fs'],
  path: string,
): Record<string, unknown> | string {
  try {
    const parsed = JSON.parse(String(fs.readFileSync(path, 'utf8'))) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return 'service manifest could not be read (not a JSON object)';
  } catch (error) {
    return `service manifest could not be read (${error instanceof Error ? error.message : String(error)})`;
  }
}

function registrationOf(
  platform: ServicePlatform,
  unitPath: string,
  manifest: Record<string, unknown>,
): ServiceRegistration {
  const text = (key: string) =>
    typeof manifest[key] === 'string' ? (manifest[key] as string) : undefined;
  const label = text('label');
  const unitName = text('unitName');
  const taskName = text('taskName');
  return {
    platform,
    unitPath,
    ...(label === undefined ? {} : { label }),
    ...(unitName === undefined ? {} : { unitName }),
    ...(taskName === undefined ? {} : { taskName }),
  };
}

function probeUnit(
  registration: ServiceRegistration,
  dependencies: SupervisingServiceDependencies,
): Record<string, boolean | string | null> {
  const probe = { fs: dependencies.fs as ServiceFs, run: dependencies.run };
  if (registration.platform === 'darwin') {
    return launchdStatus(registration, probe);
  }
  if (registration.platform === 'linux') {
    return systemdStatus(registration, probe);
  }
  return windowsServiceStatus(registration, probe);
}

/** One manifest's verdict: `null` when it rules itself out. */
function inspectManifest(
  path: string,
  fallbackId: string,
  platform: ServicePlatform,
  repoPath: string | undefined,
  dependencies: SupervisingServiceDependencies,
): SupervisingService | null {
  const manifest = readManifestObject(dependencies.fs, path);
  if (typeof manifest === 'string') {
    return { instanceId: fallbackId, state: 'unknown', detail: manifest };
  }
  // Another platform's registration (a synced home) supervises nothing here.
  if (manifest.platform !== platform) return null;
  const instanceId =
    typeof manifest.instanceId === 'string' ? manifest.instanceId : fallbackId;
  if (
    repoPath !== undefined &&
    typeof manifest.repoPath === 'string' &&
    realpathOrSelf(dependencies.fs, manifest.repoPath) !== repoPath
  ) {
    return null;
  }
  if (typeof manifest.unitPath !== 'string') {
    return {
      instanceId,
      state: 'unknown',
      detail: 'service manifest records no unit path',
    };
  }
  const unit = probeUnit(
    registrationOf(platform, manifest.unitPath, manifest),
    dependencies,
  );
  if (unit.active === false) return null;
  if (unit.active === true) {
    return { instanceId, state: 'active', detail: null };
  }
  return {
    instanceId,
    state: 'unknown',
    detail:
      typeof unit.error === 'string'
        ? unit.error
        : 'the service backend did not report whether it is running',
  };
}

/**
 * The installed services in `stationHome` that `station upgrade` must not
 * pull the rug from. Probed with the same platform status functions `station
 * service status` uses, reading only their `active` answer: `true` is running,
 * `false` is not, and `null` is the probe declining to say. That is narrower
 * than the status command's own `unknown`, which also counts an unrelated
 * probe error (e.g. a failed linger lookup beside a definite `is-active`).
 *
 * A manifest that cannot be read, or whose probe cannot answer, is reported
 * as `unknown` — a service nobody could rule out is not treated as stopped.
 */
export function findSupervisingServices(
  stationHome: string,
  dependencies: SupervisingServiceDependencies,
): SupervisingService[] {
  const { fs, platform } = dependencies;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    return [];
  }
  const serviceDirectory = join(stationHome, 'service');
  if (!fs.existsSync(serviceDirectory)) return [];
  const repoPath =
    dependencies.repoPath === undefined
      ? undefined
      : realpathOrSelf(fs, dependencies.repoPath);
  const findings: SupervisingService[] = [];
  for (const name of fs.readdirSync(serviceDirectory)) {
    const entry = String(name);
    if (!entry.endsWith('.json')) continue;
    const finding = inspectManifest(
      join(serviceDirectory, entry),
      entry.slice(0, -'.json'.length),
      platform,
      repoPath,
      dependencies,
    );
    if (finding) findings.push(finding);
  }
  return findings;
}

/** The refusal `station upgrade` raises instead of stopping a supervised child. */
export function renderSupervisingServiceRefusal(
  services: SupervisingService[],
): string {
  return [
    'station upgrade is blocked because an installed Station service supervises this Station.',
    "Upgrading now would stop the service-managed server, which the service restarts at once — racing this upgrade's own pull and rebuild in the same checkout.",
    ...services.map(
      (service) =>
        `  - ${service.instanceId}: ${service.state === 'active' ? 'running' : `state unknown${service.detail ? ` (${service.detail})` : ''}`}`,
    ),
    'Stop the service with "station service stop", run "station upgrade", then start it again with "station service start" (pass the same --instance/--base options the service was installed with).',
  ].join('\n');
}
