import {
  sameRuntimePath,
  spawnedStationRoot,
} from '@kontourai/station-shared/runtime-path-resolver';

/**
 * Render a service reinstall command only when the installed manifest carries
 * every setting that `service install` would otherwise replace.  A partial
 * command is dangerous: it may select another Station home or reset a
 * user-selected feature configuration.
 */
export interface ServiceInstallConfiguration {
  allowedOrigins?: unknown;
  baseDir?: unknown;
  features?: unknown;
  host?: unknown;
  instanceId?: unknown;
  serverPort?: unknown;
  stationRoot?: unknown;
  uiPort?: unknown;
}

function shellArgument(value: string): string {
  // Comma included: feature lists are comma-separated and a comma is not a
  // shell metacharacter outside brace expansion, so quoting them adds noise
  // to a command the operator is meant to read and paste.
  if (/^[A-Za-z0-9_./:@,=-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export type ServiceInstallRemedy =
  | { command: string; reason?: undefined }
  | { command: null; reason: string };

const INCOMPLETE_REGISTRATION_REASON =
  'this registration does not record every setting. Inspect its manifest before reinstalling.';

/**
 * The install command that reproduces this registration, or why none can be
 * given. Install derives the unit's STATION_ROOT from the home and the
 * installing shell's STATION_ROOT (`spawnedStationRoot`), so the command is
 * rendered against a shell WITHOUT STATION_ROOT: a recorded root that such a
 * shell would not derive is prefixed explicitly, and a recorded absence that
 * such a shell would fill in cannot be expressed, so no command is given.
 */
export function resolveServiceInstallRemedy(
  configuration: ServiceInstallConfiguration,
  fallbackBaseDir?: string,
): ServiceInstallRemedy {
  const baseDir = configuration.baseDir ?? fallbackBaseDir;
  if (
    typeof configuration.instanceId !== 'string' ||
    typeof baseDir !== 'string' ||
    typeof configuration.serverPort !== 'number' ||
    typeof configuration.uiPort !== 'number' ||
    typeof configuration.host !== 'string' ||
    (configuration.features !== null &&
      typeof configuration.features !== 'string') ||
    !Array.isArray(configuration.allowedOrigins) ||
    configuration.allowedOrigins.some((origin) => typeof origin !== 'string') ||
    (configuration.stationRoot !== undefined &&
      typeof configuration.stationRoot !== 'string')
  ) {
    return { command: null, reason: INCOMPLETE_REGISTRATION_REASON };
  }
  const bareRoot = spawnedStationRoot(baseDir, {});
  const recordedRoot = configuration.stationRoot as string | undefined;
  if (recordedRoot === undefined && bareRoot !== undefined) {
    return {
      command: null,
      reason: `this registration carries no STATION_ROOT, but a reinstall of this home would set STATION_ROOT=${shellArgument(bareRoot)}. Inspect its manifest before reinstalling.`,
    };
  }
  // A recorded root is prefixed only when a bare reinstall would derive a
  // different one. Manifests written before #1102 record a self-rooted home
  // as STATION_ROOT === STATION_HOME; spelling that out is exactly the
  // configuration admitStationRuntimeHome refuses, while a bare reinstall
  // derives the same root implicitly, so it must not be prefixed.
  const bareEquivalent = bareRoot ?? baseDir;
  const envPrefix =
    recordedRoot !== undefined && !sameRuntimePath(recordedRoot, bareEquivalent)
      ? `STATION_ROOT=${shellArgument(recordedRoot)} `
      : '';

  const args = [
    `--instance=${shellArgument(configuration.instanceId)}`,
    `--base=${shellArgument(baseDir)}`,
    `--port=${configuration.serverPort}`,
    `--ui-port=${configuration.uiPort}`,
    `--host=${shellArgument(configuration.host)}`,
    ...(configuration.features === null
      ? []
      : [`--features=${shellArgument(configuration.features)}`]),
    ...configuration.allowedOrigins.map(
      (origin) => `--allowed-origin=${shellArgument(origin)}`,
    ),
  ];
  return { command: `${envPrefix}station service install ${args.join(' ')}` };
}

/**
 * Returns null for registrations written before the complete configuration
 * was persisted, or whose STATION_ROOT a pasted command cannot reproduce.
 * Those registrations must be inspected by the operator; guessing an omitted
 * setting would silently change the service.
 */
export function renderServiceInstallRemedy(
  configuration: ServiceInstallConfiguration,
  fallbackBaseDir?: string,
): string | null {
  return resolveServiceInstallRemedy(configuration, fallbackBaseDir).command;
}

/** Render a read-only follow-up against the same Station home, when known. */
export function renderServiceStatusCommand(
  configuration: ServiceInstallConfiguration,
  fallbackBaseDir?: string,
): string | null {
  const baseDir = configuration.baseDir ?? fallbackBaseDir;
  if (
    typeof configuration.instanceId !== 'string' ||
    typeof baseDir !== 'string'
  ) {
    return null;
  }
  return `station service status --instance=${shellArgument(configuration.instanceId)} --base=${shellArgument(baseDir)}`;
}
