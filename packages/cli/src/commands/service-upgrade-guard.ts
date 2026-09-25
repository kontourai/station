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
  const { fs, platform, run } = dependencies;
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
    const fallbackId = entry.slice(0, -'.json'.length);
    let manifest: Record<string, unknown>;
    try {
      const parsed = JSON.parse(
        String(fs.readFileSync(join(serviceDirectory, entry), 'utf8')),
      ) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('not a JSON object');
      }
      manifest = parsed as Record<string, unknown>;
    } catch (error) {
      findings.push({
        instanceId: fallbackId,
        state: 'unknown',
        detail: `service manifest could not be read (${error instanceof Error ? error.message : String(error)})`,
      });
      continue;
    }
    // Another platform's registration (a synced home) supervises nothing here.
    if (manifest.platform !== platform) continue;
    const instanceId =
      typeof manifest.instanceId === 'string'
        ? manifest.instanceId
        : fallbackId;
    if (
      repoPath !== undefined &&
      typeof manifest.repoPath === 'string' &&
      realpathOrSelf(fs, manifest.repoPath) !== repoPath
    ) {
      continue;
    }
    if (typeof manifest.unitPath !== 'string') {
      findings.push({
        instanceId,
        state: 'unknown',
        detail: 'service manifest records no unit path',
      });
      continue;
    }
    const registration: ServiceRegistration = {
      platform,
      unitPath: manifest.unitPath,
      ...(typeof manifest.label === 'string' ? { label: manifest.label } : {}),
      ...(typeof manifest.unitName === 'string'
        ? { unitName: manifest.unitName }
        : {}),
      ...(typeof manifest.taskName === 'string'
        ? { taskName: manifest.taskName }
        : {}),
    };
    const probeFs = fs as ServiceFs;
    const unit =
      platform === 'darwin'
        ? launchdStatus(registration, { fs: probeFs, run })
        : platform === 'linux'
          ? systemdStatus(registration, { fs: probeFs, run })
          : windowsServiceStatus(registration, { fs: probeFs, run });
    if (unit.active === false) continue;
    findings.push({
      instanceId,
      state: unit.active === true ? 'active' : 'unknown',
      detail:
        typeof unit.error === 'string'
          ? unit.error
          : unit.active === true
            ? null
            : 'the service backend did not report whether it is running',
    });
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
