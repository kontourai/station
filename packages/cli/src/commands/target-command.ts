import type { StationProfileLocalService } from '@kontourai/station-contracts';
import { parseCoreArgs, resolveApiBaseDetailed } from './core-api.js';
import { getProfileCredentialStore } from './profile-credentials.js';
import { findProfile } from './profile-store.js';
import { inspectServiceInstallation } from './service.js';

export interface TargetCommandDependencies {
  fetch?: typeof fetch;
  localServiceStatus?: (
    endpoint: URL,
    binding?: StationProfileLocalService,
  ) => Promise<unknown>;
  stdout?: (value: string) => void;
}

function isLocalEndpoint(endpoint: URL): boolean {
  return (
    endpoint.hostname === '127.0.0.1' ||
    endpoint.hostname === '::1' ||
    endpoint.hostname === 'localhost'
  );
}

async function probeReachability(
  endpoint: string,
  request: typeof fetch,
): Promise<{ reachable: boolean; reason?: string }> {
  try {
    const response = await request(`${endpoint}/.well-known/station/v1`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok
      ? { reachable: true }
      : { reachable: false, reason: `HTTP ${response.status}` };
  } catch (error) {
    return {
      reachable: false,
      reason: error instanceof Error ? error.message : 'connection failed',
    };
  }
}

async function defaultLocalServiceStatus(
  endpoint: URL,
  binding?: StationProfileLocalService,
): Promise<unknown> {
  if (!binding) {
    return {
      state: 'not-configured',
      endpoint: endpoint.origin,
      configured: null,
    };
  }
  // Inspect the exact configured home and OS backend. This works from the
  // published CLI as well as a source checkout and never changes service state.
  const status = inspectServiceInstallation({
    baseDir: binding.baseDir,
    homeSource: '--base',
    host: endpoint.hostname,
    instanceName: binding.instanceId,
    serverPort: binding.serverPort,
    uiPort: binding.uiPort,
  });
  const unitError =
    typeof status.unit.error === 'string' ? status.unit.error : undefined;
  return {
    state: unitError
      ? 'unknown'
      : status.manifest === null
        ? 'not-installed'
        : status.unit.active === true
          ? 'running'
          : 'stopped',
    endpoint: endpoint.origin,
    configured: binding,
    installation: status.manifest
      ? {
          platform: status.manifest.platform,
          instanceId: status.manifest.instanceId,
          serverPort: status.manifest.serverPort,
          uiPort: status.manifest.uiPort,
        }
      : null,
    unit: status.unit,
  };
}

/**
 * Reports the one target selected by the shared resolver. This command does
 * not use active-local fallback after probing: a selected remote Station that
 * is unreachable remains the selected unreachable Station in its output.
 */
export async function runTargetCommand(
  args: string[],
  dependencies: TargetCommandDependencies = {},
): Promise<void> {
  const parsed = parseCoreArgs(args);
  const unknown = Object.keys(parsed.flags).filter(
    (flag) => !['api-base', 'station'].includes(flag),
  );
  if (unknown.length > 0 || parsed.positionals.length > 0) {
    throw new Error(
      'Usage: station target [--station=<name>|--api-base=<url>]',
    );
  }
  const resolved = resolveApiBaseDetailed(parsed);
  const endpoint = new URL(resolved.apiBase);
  const station = resolved.station ? findProfile(resolved.station) : undefined;
  const local = isLocalEndpoint(endpoint);
  const [reachability, localService] = await Promise.all([
    probeReachability(resolved.apiBase, dependencies.fetch ?? fetch),
    local
      ? (dependencies.localServiceStatus ?? defaultLocalServiceStatus)(
          endpoint,
          station?.localService,
        )
      : Promise.resolve({ state: 'not-applicable-remote' }),
  ]);
  const credentialState = station?.credentialRef
    ? getProfileCredentialStore().status(station.credentialRef)
    : 'not-configured';
  (dependencies.stdout ?? console.log)(
    JSON.stringify(
      {
        station: station?.name ?? null,
        resolutionSource: resolved.source,
        endpoint: resolved.apiBase,
        environmentId: station?.environmentId ?? null,
        credential: credentialState,
        reachability,
        localService,
      },
      null,
      2,
    ),
  );
}
