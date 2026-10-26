import { basename, dirname } from 'node:path';
import { STATION_RELEASE_RINGS } from '@kontourai/station-shared/ports';
import { readArchiveInstallState } from '@kontourai/station-shared/prebuilt-archive';
import {
  sameRuntimePath,
  spawnedStationRoot,
} from '@kontourai/station-shared/runtime-path-resolver';
import type {
  CommandRunner,
  ServiceFs,
  ServiceRegistration,
} from './service.js';
import {
  type InstalledServiceUnit,
  readInstalledServiceUnit,
} from './service-unit.js';

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

/**
 * The command a remedy runs: `launcher`, which exports `stationRoot` as
 * STATION_ROOT when it is a channel launcher.
 */
export interface ServiceInstallInvocation {
  launcher: string;
  stationRoot?: string;
}

const INCOMPLETE_REGISTRATION_REASON =
  'this registration does not record every setting. Inspect its manifest before reinstalling.';

/**
 * The install command that reproduces this registration, or why none can be
 * given. Install derives the unit's STATION_ROOT from the home and the
 * installing shell's STATION_ROOT (`spawnedStationRoot`), so the command is
 * rendered against a shell WITHOUT STATION_ROOT: a recorded root that such a
 * shell would not derive is prefixed explicitly, and a recorded absence that
 * such a shell would fill in cannot be expressed, so no command is given.
 *
 * A channel launcher exports its install's STATION_ROOT over anything the
 * operator's shell sets, so through one a recorded root must be exactly
 * that root: no prefix could supply another.
 */
export function resolveServiceInstallRemedy(
  configuration: ServiceInstallConfiguration,
  fallbackBaseDir?: string,
  invocation: ServiceInstallInvocation = { launcher: 'station' },
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
  const recordedRoot = configuration.stationRoot as string | undefined;
  const { launcher, stationRoot: launcherRoot } = invocation;
  if (launcherRoot !== undefined) {
    if (
      recordedRoot === undefined ||
      !sameRuntimePath(recordedRoot, launcherRoot)
    ) {
      return {
        command: null,
        reason: `this registration carries ${recordedRoot === undefined ? 'no STATION_ROOT' : `STATION_ROOT=${shellArgument(recordedRoot)}`}, but ${launcher} sets STATION_ROOT=${shellArgument(launcherRoot)}. Inspect it before reinstalling.`,
      };
    }
  }
  const bareRoot = spawnedStationRoot(baseDir, {});
  if (
    launcherRoot === undefined &&
    recordedRoot === undefined &&
    bareRoot !== undefined
  ) {
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
    launcherRoot === undefined &&
    recordedRoot !== undefined &&
    !sameRuntimePath(recordedRoot, bareEquivalent)
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
  return {
    command: `${envPrefix}${launcher} service install ${args.join(' ')}`,
  };
}

/**
 * The command that owns an installer-owned archive install: the channel
 * launcher install.sh / install.ps1 wrote for its ring (`station-nightly`
 * for nightly), not the generic `station` (#4189). Its STATION_HOME is the
 * channel home, so the reinstall command still names `--base` explicitly.
 * `station` for a source checkout or an archive copy no installer owns.
 */
function serviceInstallLauncher(
  installRoot: string | undefined,
): ServiceInstallInvocation | { reason: string } {
  if (installRoot === undefined) return { launcher: 'station' };
  const state = readArchiveInstallState(installRoot);
  if (state === null || state.stationRoot === null) {
    return {
      reason: `this service runs the launcher of ${shellArgument(installRoot)}, whose install state does not name its release ring and root, so the command that owns it is unknown. Inspect that install before reinstalling.`,
    };
  }
  return {
    launcher: STATION_RELEASE_RINGS[state.releaseChannel].launcher,
    stationRoot: state.stationRoot,
  };
}

/** The `service run` flags renderServiceCommand writes, and nothing else. */
function parseServiceRunArguments(
  args: string[],
): ServiceInstallConfiguration | { unknownArgument: string } {
  const configuration: ServiceInstallConfiguration & {
    allowedOrigins: string[];
  } = { allowedOrigins: [], features: null };
  const port = (value: string) =>
    /^[1-9][0-9]{0,4}$/u.test(value) ? Number(value) : value;
  for (const argument of args) {
    const separator = argument.indexOf('=');
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const value = separator === -1 ? undefined : argument.slice(separator + 1);
    if (value === undefined) return { unknownArgument: argument };
    if (flag === '--instance') configuration.instanceId = value;
    else if (flag === '--base') configuration.baseDir = value;
    else if (flag === '--port') configuration.serverPort = port(value);
    else if (flag === '--ui-port') configuration.uiPort = port(value);
    else if (flag === '--host') configuration.host = value;
    else if (flag === '--features') configuration.features = value;
    else if (flag === '--allowed-origin')
      configuration.allowedOrigins.push(value);
    else return { unknownArgument: argument };
  }
  return configuration;
}

/**
 * The reinstall command for what an installed launchd or systemd unit runs:
 * its own `service run` arguments and STATION_ROOT, under the launcher that
 * owns the code it runs.
 */
export function resolveInstalledUnitRemedy(
  unit: InstalledServiceUnit,
): ServiceInstallRemedy {
  const run = unit.argv?.findIndex(
    (argument, index) =>
      argument === 'service' && unit.argv?.[index + 1] === 'run',
  );
  if (unit.argv === null || run === undefined || run < 1) {
    return {
      command: null,
      reason:
        'the installed unit does not run `service run`. Inspect it before reinstalling.',
    };
  }
  const parsed = parseServiceRunArguments(unit.argv.slice(run + 2));
  if ('unknownArgument' in parsed) {
    return {
      command: null,
      reason: `the installed unit runs ${shellArgument(parsed.unknownArgument)}, which a reinstall command cannot reproduce. Inspect it before reinstalling.`,
    };
  }
  // renderServiceCommand: a launcher service runs exactly
  // `<node> <installRoot>/runtime/station-launcher.mjs`.
  const entries = unit.argv.slice(1, run);
  const installRoot =
    entries.length === 1 &&
    basename(entries[0]) === 'station-launcher.mjs' &&
    basename(dirname(entries[0])) === 'runtime'
      ? dirname(dirname(entries[0]))
      : undefined;
  const owner = serviceInstallLauncher(installRoot);
  if ('reason' in owner) return { command: null, reason: owner.reason };
  const stationRoot = unit.environment.STATION_ROOT;
  return resolveServiceInstallRemedy(
    // An empty STATION_ROOT= is how the unit records none.
    { ...parsed, stationRoot: stationRoot ? stationRoot : undefined },
    undefined,
    owner,
  );
}

/**
 * The reinstall command `service status` prints for an installed service.
 *
 * A launchd or systemd unit is named by instance id alone, so the unit may
 * have been installed from another home than the one whose manifest status
 * read: under a channel launcher with no `--base`, that is the channel's
 * default home (#4189). The command therefore comes from the unit itself.
 * A Windows wrapper lives in the manifest's own home and is written with
 * it, so the manifest describes it.
 */
export function resolveInstalledServiceRemedy(
  manifest: ServiceInstallConfiguration &
    ServiceRegistration & { installRoot?: unknown; kind?: unknown },
  fallbackBaseDir: string | undefined,
  dependencies: { fs: Pick<ServiceFs, 'readFileSync'>; run: CommandRunner },
): ServiceInstallRemedy {
  if (manifest.platform === 'win32') {
    const owner = serviceInstallLauncher(
      manifest.kind === 'archive' && typeof manifest.installRoot === 'string'
        ? manifest.installRoot
        : undefined,
    );
    if ('reason' in owner) return { command: null, reason: owner.reason };
    return resolveServiceInstallRemedy(manifest, fallbackBaseDir, owner);
  }
  let unit: InstalledServiceUnit;
  try {
    unit = readInstalledServiceUnit(manifest, dependencies);
  } catch (error) {
    return {
      command: null,
      reason: `the installed unit could not be read (${error instanceof Error ? error.message : String(error)}). Inspect it before reinstalling.`,
    };
  }
  return resolveInstalledUnitRemedy(unit);
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
