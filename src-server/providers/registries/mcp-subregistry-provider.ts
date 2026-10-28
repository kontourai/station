/**
 * MCP subregistry sources as integration catalogue providers (#3483). An
 * entry becomes an ordinary remote tool server through the existing
 * integration install route; this module decides only which entries can be
 * added and what Station knows about each.
 *
 * Two sources exist. Station's curation ships in this repository and is the
 * only source whose `ai.kontour.station/curation` records count. An operator
 * can add one network subregistry with `STATION_MCP_SUBREGISTRY_URL`; its
 * entries are always unqualified.
 */

import { BlockList, isIP } from 'node:net';
import { join } from 'node:path';
import type {
  InstallResult,
  RegistryItem,
  RegistryMcpAuthMode,
  RegistryMcpServerListing,
  RegistryMcpSourceStatus,
} from '@kontourai/station-contracts/catalog';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { hasToolServerOAuthCapability } from '../../services/plugins/tool-server-oauth-capabilities.js';
import { resolveHomeDir } from '../../utils/paths.js';
import type { IIntegrationRegistryProvider } from '../provider-interfaces.js';
import curatedSubregistry from './curated/station-mcp-subregistry.json' with {
  type: 'json',
};
import {
  type McpSubregistryServer,
  McpSubregistrySource,
  mcpServerIntegrationId,
  parseHttpsUrl,
} from './mcp-subregistry.js';

export const UNAVAILABLE = {
  deprecated: 'The source marks this server deprecated.',
  deleted: 'The source marks this server deleted.',
  // Shown as-is in the Registry, so each stays under 100 characters.
  stale: 'This source is offline and showing a saved copy. Refresh it first.',
  packagesOnly:
    'Only local packages are listed. Station never runs a package from a catalog.',
  sseOnly: 'Only an SSE endpoint is listed. Station adds streamable HTTP ones.',
  noRemote: 'No endpoint is listed.',
  variables:
    'The endpoint URL has values to fill in, which Station does not do yet.',
  secretHeader:
    'Needs a secret token header, which Station cannot store for a remote server yet.',
  literalHeader:
    'Declares request headers that Station does not send from a catalog.',
  preRegistered:
    'Sign-in needs an OAuth client you register with the provider. Station cannot use one yet.',
  privateAddress:
    'The endpoint is a local or private network address, which catalogs cannot add by default.',
} as const;

/**
 * Loopback, private, link-local, shared, reserved and multicast ranges. A
 * catalog names an endpoint Station will connect to on the person's behalf,
 * so a catalog cannot point it at this host or its network unless the
 * operator opts in. A public name that resolves to such an address is not
 * caught here.
 */
const PRIVATE_RANGES = (() => {
  const list = new BlockList();
  for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const)
    list.addSubnet(network, prefix, 'ipv4');
  for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const)
    list.addSubnet(network, prefix, 'ipv6');
  return list;
})();

/** Whether a URL's host is a local or private network address. */
function isPrivateNetworkHost(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  )
    return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)?.[1];
  if (mapped) return PRIVATE_RANGES.check(mapped, 'ipv4');
  const family = isIP(host);
  if (family === 4) return PRIVATE_RANGES.check(host, 'ipv4');
  if (family === 6) {
    // `::ffff:7f00:1` is the hex spelling of an IPv4-mapped address.
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (hex) {
      const high = Number.parseInt(hex[1], 16);
      const low = Number.parseInt(hex[2], 16);
      return PRIVATE_RANGES.check(
        `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
        'ipv4',
      );
    }
    return PRIVATE_RANGES.check(host, 'ipv6');
  }
  return false;
}

/** Host-side facts a listing depends on, read at listing time. */
export interface McpListingPolicy {
  /** The tool-server OAuth flow can use a client the person registered. */
  preRegisteredClients: boolean;
  /** The operator allows catalog endpoints on local or private networks. */
  allowPrivateAddresses: boolean;
}

function chosenRemote(server: McpSubregistryServer) {
  if (server.curation)
    return server.remotes.find(
      (remote) => remote.url === server.curation!.remote,
    );
  return (
    server.remotes.find(
      (remote) =>
        remote.type === 'streamable-http' && remote.url && !remote.hasVariables,
    ) ??
    server.remotes.find((remote) => remote.type === 'streamable-http') ??
    server.remotes[0]
  );
}

/** What Station shows and enforces for one entry. Pure. */
function mcpServerListing(
  server: McpSubregistryServer,
  options: { stale: boolean } & McpListingPolicy,
): RegistryMcpServerListing {
  const unavailable: string[] = [];
  if (server.status !== 'active') unavailable.push(UNAVAILABLE[server.status]);
  if (options.stale) unavailable.push(UNAVAILABLE.stale);
  const remote = chosenRemote(server);
  let authMode: RegistryMcpAuthMode = server.curation?.authMode ?? 'unknown';
  let usable: { transport: 'streamable-http'; url: string } | undefined;
  if (!remote) {
    unavailable.push(
      server.packageTypes.length > 0
        ? UNAVAILABLE.packagesOnly
        : UNAVAILABLE.noRemote,
    );
  } else if (remote.type !== 'streamable-http') {
    unavailable.push(
      remote.type === 'sse' ? UNAVAILABLE.sseOnly : UNAVAILABLE.noRemote,
    );
  } else if (remote.hasVariables || !remote.url) {
    unavailable.push(UNAVAILABLE.variables);
  } else {
    // Re-checked here, not trusted from the parser, because this URL is what
    // becomes the stored endpoint.
    const url = parseHttpsUrl(remote.url, 'remote', []);
    if (!url) unavailable.push(UNAVAILABLE.noRemote);
    else if (!options.allowPrivateAddresses && isPrivateNetworkHost(url))
      unavailable.push(UNAVAILABLE.privateAddress);
    else usable = { transport: 'streamable-http', url };
    if (remote.headers.some((header) => header.secret || header.required)) {
      if (!server.curation) authMode = 'token';
      unavailable.push(UNAVAILABLE.secretHeader);
    } else if (remote.headers.length > 0) {
      unavailable.push(UNAVAILABLE.literalHeader);
    }
  }
  if (authMode === 'pre-registered-required' && !options.preRegisteredClients)
    unavailable.push(UNAVAILABLE.preRegistered);
  if (authMode === 'token' && !unavailable.includes(UNAVAILABLE.secretHeader))
    unavailable.push(UNAVAILABLE.secretHeader);
  return {
    name: server.name,
    version: server.version,
    schema: server.schema,
    ...(usable ? { remote: usable } : {}),
    authMode,
    qualification: server.curation
      ? {
          state:
            unavailable.length > 0
              ? 'blocked'
              : // Station's check completed dynamic registration only.
                authMode === 'pre-registered-required'
                ? 'setup-required'
                : 'qualified',
          summary: server.curation.summary,
          checkedAt: server.curation.checkedAt,
        }
      : { state: 'unqualified' },
    ...(server.curation?.launchStage
      ? { launchStage: server.curation.launchStage }
      : {}),
    ...(server.curation?.contentTrust
      ? { contentTrust: server.curation.contentTrust }
      : {}),
    ...(server.curation?.trustReadOnlyHints
      ? { trustReadOnlyHints: true }
      : {}),
    ...(server.websiteUrl ? { websiteUrl: server.websiteUrl } : {}),
    unavailable,
  };
}

export class McpSubregistryIntegrationProvider
  implements IIntegrationRegistryProvider
{
  readonly registryKey: string;
  readonly displayName: string;

  constructor(
    readonly source: McpSubregistrySource,
    private readonly policy: () => McpListingPolicy = () => ({
      preRegisteredClients: false,
      allowPrivateAddresses: false,
    }),
  ) {
    this.registryKey = `mcp-subregistry:${source.id}`;
    this.displayName = source.displayName;
  }

  status(): RegistryMcpSourceStatus {
    return this.source.status();
  }

  private async entries() {
    await this.source.ready();
    this.source.refreshIfStale();
    const stale = this.source.isStale();
    const policy = this.policy();
    return this.source.servers().map((server) => ({
      id: mcpServerIntegrationId(server.name),
      server,
      listing: mcpServerListing(server, { stale, ...policy }),
      stale,
    }));
  }

  private async find(id: string) {
    return (await this.entries()).find((entry) => entry.id === id);
  }

  async listAvailable(): Promise<RegistryItem[]> {
    return (await this.entries()).map(({ id, server, listing, stale }) => ({
      id,
      displayName: server.title ?? server.name,
      description: server.description,
      version: server.version,
      ...(listing.remote ? { source: listing.remote.url } : {}),
      catalogSourceName: this.displayName,
      ...(stale ? { catalogFreshness: 'stale' as const } : {}),
      installed: false,
      tags: ['mcp', 'remote'],
      mcpServer: listing,
    }));
  }

  async listInstalled(): Promise<RegistryItem[]> {
    return [];
  }

  async install(id: string): Promise<InstallResult> {
    const entry = await this.find(id);
    if (!entry)
      return { success: false, message: `Integration '${id}' not found` };
    if (entry.listing.unavailable.length > 0)
      return { success: false, message: entry.listing.unavailable.join(' ') };
    return {
      success: true,
      message: `Integration '${id}' is available for install`,
    };
  }

  async uninstall(id: string): Promise<InstallResult> {
    return (await this.find(id))
      ? { success: true, message: `Integration '${id}' removed` }
      : { success: false, message: `Integration '${id}' not found` };
  }

  async getToolDef(id: string): Promise<ToolDef | null> {
    const entry = await this.find(id);
    const remote = entry?.listing.remote;
    if (!entry || !remote || entry.listing.unavailable.length > 0) return null;
    return {
      id,
      kind: 'mcp',
      displayName: entry.server.title ?? entry.server.name,
      description: entry.server.description,
      transport: remote.transport,
      endpoint: remote.url,
      // Each person signs in to their own account; a catalog entry never
      // borrows the operator's credential.
      credentialOwnership: { owner: 'principal' },
      // The catalog's classification is the default; the person can change it.
      ...(entry.listing.contentTrust
        ? { contentTrust: entry.listing.contentTrust }
        : {}),
      ...(entry.listing.trustReadOnlyHints ? { trustReadOnlyHints: true } : {}),
      timeouts: { startupMs: 15_000, requestMs: 60_000 },
    };
  }

  async sync(): Promise<void> {
    await this.source.refresh();
  }
}

/**
 * The configured MCP subregistry URL, or `undefined` when unset. A value
 * that is not an https URL is refused rather than ignored.
 */
function configuredMcpSubregistryUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env.STATION_MCP_SUBREGISTRY_URL?.trim();
  if (!raw) return undefined;
  const reasons: string[] = [];
  const url = parseHttpsUrl(raw, 'STATION_MCP_SUBREGISTRY_URL', reasons);
  if (!url) throw new Error(reasons.join('; '));
  return url;
}

const hostHasPreRegisteredClients = () =>
  hasToolServerOAuthCapability('pre-registered-clients');

let cached:
  | {
      key: string;
      providers: McpSubregistryIntegrationProvider[];
      hasPreRegisteredClients: () => boolean;
    }
  | undefined;

/**
 * Station's curated source, plus the operator's configured source when one
 * is set. `STATION_MCP_CURATED_REGISTRY=off` withdraws the curated source.
 * Instances are kept per home and setting so caches and backoff survive
 * between listings.
 */
export function mcpSubregistryIntegrationProviders(
  homeDir = resolveHomeDir(),
  env: NodeJS.ProcessEnv = process.env,
  hasPreRegisteredClients: () => boolean = hostHasPreRegisteredClients,
): McpSubregistryIntegrationProvider[] {
  const allowPrivateAddresses = ['on', '1', 'true', 'yes'].includes(
    env.STATION_MCP_SUBREGISTRY_ALLOW_PRIVATE_ADDRESSES?.trim().toLowerCase() ??
      '',
  );
  // Read per listing, so a capability registered after startup applies.
  const policy = () => ({
    preRegisteredClients: hasPreRegisteredClients(),
    allowPrivateAddresses,
  });
  const curatedOff = ['off', '0', 'false', 'no'].includes(
    env.STATION_MCP_CURATED_REGISTRY?.trim().toLowerCase() ?? '',
  );
  let url: string | undefined;
  let urlError: string | undefined;
  try {
    url = configuredMcpSubregistryUrl(env);
  } catch (error) {
    urlError = (error as Error).message;
  }
  const key = JSON.stringify([
    homeDir,
    curatedOff,
    url,
    urlError,
    allowPrivateAddresses,
  ]);
  if (
    cached?.key === key &&
    cached.hasPreRegisteredClients === hasPreRegisteredClients
  )
    return cached.providers;
  const providers: McpSubregistryIntegrationProvider[] = [];
  if (!curatedOff)
    providers.push(
      new McpSubregistryIntegrationProvider(
        new McpSubregistrySource({
          id: 'station-curated',
          displayName: 'Station curated',
          origin: 'station',
          bundled: [JSON.stringify(curatedSubregistry)],
        }),
        policy,
      ),
    );
  if (url || urlError)
    providers.push(
      new McpSubregistryIntegrationProvider(
        new McpSubregistrySource({
          id: 'configured',
          displayName: 'Configured MCP subregistry',
          origin: 'configured',
          // A refused setting stays visible as a source with that error.
          ...(url ? { url } : { refusal: urlError }),
          cacheDir: join(homeDir, 'cache', 'mcp-subregistry'),
        }),
        policy,
      ),
    );
  cached = { key, providers, hasPreRegisteredClients };
  return providers;
}
