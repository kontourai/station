/**
 * Station tool servers for a native OpenCode session (PLAN B, MCP parity with
 * the ACP path).
 *
 * The servers are the ones the ACP adapter would pass on `session/new`:
 * the agent's authored tool servers (or the connection's
 * `provideToolServers`), resolved by the same `resolveAcpPassthroughMcpServers`
 * under the same rules (authored passthrough is stdio-only and never carries
 * an `env`; the built-in Station servers are reached over HTTP with a
 * per-session bearer token). OpenCode 2's server takes HTTP servers
 * natively (its verified schema's `Mcp.RemoteConfig`), so the ACP path's
 * live `mcpCapabilities.http` observation is a known fact here.
 *
 * Delivery is OpenCode's own client path: `PUT /api/experimental/mcp/{name}`
 * with `{config}`, which OpenCode's ACP layer uses for a client's servers
 * (`cli/src/acp/sessions.ts` registerMcp: local `{command, environment}`,
 * remote `{url, headers, oauth: false}`). A server added that way belongs to
 * the server's location, which every session on that server shares, so the
 * pool keys a server by {@link openCodeMcpDigest}: sessions whose tool
 * servers differ (Station's carry per-session credentials) never share one.
 *
 * The configs hold credentials (bearer tokens in headers). They are sent to
 * the loopback server and nowhere else: not logged, not put in an event,
 * and an error names only the server.
 */
import crypto from 'node:crypto';
import type { McpServer } from '@agentclientprotocol/sdk/unstable';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import type { CapabilityUndelivered } from '@kontourai/station-contracts/provider';
import type { ProviderSessionStartInput } from '../adapter-shape.js';
import type { AcpAdapterOptions } from './acp-adapter.js';
import { resolveAcpPassthroughMcpServers } from './acp-mcp-passthrough.js';
import { toPassthroughToolDef } from './agent-tool-server-mapping.js';

/** OpenCode's `Mcp.ServerConfig`, as Station sends it. */
export type OpenCodeMcpConfig =
  | {
      type: 'local';
      command: string[];
      environment?: Record<string, string>;
    }
  | {
      type: 'remote';
      url: string;
      headers?: Record<string, string>;
      oauth: false;
    };

export interface OpenCodeMcpServer {
  readonly name: string;
  readonly config: OpenCodeMcpConfig;
}

export interface OpenCodeNativeMcp {
  readonly servers: readonly OpenCodeMcpServer[];
  readonly undelivered: readonly CapabilityUndelivered[];
  /**
   * The servers carry a credential minted for this session (Station's
   * built-in servers), so no other session's set digests the same: the
   * server keyed by it is this session's alone.
   */
  readonly sessionScoped: boolean;
}

type MintOptions = Pick<
  AcpAdapterOptions,
  | 'resolveToolServer'
  | 'mintStationControlMcpAuth'
  | 'mintStationKnowledgeMcpAuth'
  | 'revokeStationControlMcpAuth'
>;

/** OpenCode's config for one ACP-shaped server (`cli/src/acp/sessions.ts` mcpConfig). */
function openCodeMcpConfig(server: McpServer): OpenCodeMcpServer {
  if ('type' in server && server.type === 'http')
    return {
      name: server.name,
      config: {
        type: 'remote',
        url: server.url,
        ...(server.headers.length > 0
          ? {
              headers: Object.fromEntries(
                server.headers.map((header) => [header.name, header.value]),
              ),
            }
          : {}),
        oauth: false,
      },
    };
  if ('type' in server && server.type === 'sse')
    throw new Error(
      `MCP server ${server.name} uses SSE, which OpenCode 2 does not add.`,
    );
  const stdio = server as Extract<McpServer, { command: string }>;
  return {
    name: stdio.name,
    config: {
      type: 'local',
      command: [stdio.command, ...stdio.args],
      ...(stdio.env.length > 0
        ? {
            environment: Object.fromEntries(
              stdio.env.map((entry) => [entry.name, entry.value]),
            ),
          }
        : {}),
    },
  };
}

/**
 * A digest of a session's server set, for the pool key: equal only for the
 * same servers with the same configs (credentials included), in any order.
 */
export function openCodeMcpDigest(
  servers: readonly OpenCodeMcpServer[],
): string {
  const canonical = [...servers]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((server) => [server.name, canonicalJson(server.config)]);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [
        key,
        canonicalJson((value as Record<string, unknown>)[key]),
      ]),
  );
}

/**
 * The tool servers this session gets, resolved as the ACP adapter resolves
 * them (`acp-adapter.ts` startSession, archive#895 / archive#1684), with
 * HTTP MCP known to be available. A credential minted for a built-in server
 * that is then not delivered is revoked at once; the receipts say what was
 * not delivered and why.
 */
export async function resolveOpenCodeNativeMcp(
  input: ProviderSessionStartInput,
  config: ACPConnectionConfig,
  options: MintOptions,
): Promise<OpenCodeNativeMcp> {
  const agentToolServers = input.agent?.toolServers;
  const requested =
    agentToolServers !== undefined
      ? [
          ...new Set([
            ...(input.agent?.toolServerMode === 'add'
              ? (config.provideToolServers ?? [])
              : []),
            ...agentToolServers.map((server) => server.id),
          ]),
        ]
      : config.provideToolServers;
  if (!requested?.length)
    return { servers: [], undelivered: [], sessionScoped: false };
  if (
    agentToolServers?.some(
      (server) =>
        server.coordinatorDerived && server.coordinatorGeneration === undefined,
    )
  )
    throw new Error('Coordinator generation is required.');
  const authored = (id: string) =>
    agentToolServers?.find((server) => server.id === id);
  const mint = (
    id: 'station-control' | 'station-knowledge',
    fn: MintOptions['mintStationControlMcpAuth'],
  ) => {
    if (!requested.includes(id) || !fn) return undefined;
    const derived = authored(id)?.coordinatorDerived === true;
    return derived
      ? fn(
          input.threadId,
          input.tenantExecutionContext,
          authored(id)?.coordinatorGeneration,
        )
      : input.tenantExecutionContext
        ? fn(input.threadId, input.tenantExecutionContext)
        : fn(input.threadId);
  };
  const revokeKind = (id: 'station-control' | 'station-knowledge') =>
    authored(id)?.coordinatorDerived
      ? id === 'station-control'
        ? ('coordinator-control' as const)
        : ('coordinator-knowledge' as const)
      : id;
  const stationControlAuth = mint(
    'station-control',
    options.mintStationControlMcpAuth,
  );
  const stationKnowledgeAuth = mint(
    'station-knowledge',
    options.mintStationKnowledgeMcpAuth,
  );
  const undelivered: CapabilityUndelivered[] = [];
  try {
    const resolved = await resolveAcpPassthroughMcpServers({
      toolServerIds: requested,
      ...(stationControlAuth ? { stationControlAuth } : {}),
      ...(stationKnowledgeAuth ? { stationKnowledgeAuth } : {}),
      stationKnowledgeUnavailable: {
        reason: 'delivery-failed',
        detail: 'Knowledge session auth could not be minted',
      },
      ...(requested.includes('station-control') && !stationControlAuth
        ? {
            stationControlUnavailable: {
              reason: 'delivery-failed' as const,
              detail:
                'no station-control MCP auth could be minted for this session',
            },
          }
        : {}),
      resolveToolServer:
        agentToolServers !== undefined
          ? async (id) => {
              const match = authored(id);
              return match
                ? toPassthroughToolDef(match)
                : input.agent?.toolServerMode === 'add'
                  ? (options.resolveToolServer?.(id) ?? null)
                  : null;
            }
          : (options.resolveToolServer ?? (async () => null)),
      // The resolver's own warnings name ids and reasons, never configs.
      logger: { warn: () => undefined, info: () => undefined },
    });
    for (const skip of resolved.skipped)
      undelivered.push({
        capability: 'toolServers',
        id: skip.id,
        // The ACP adapter's mapping (ACP_TOOL_SERVER_SKIP_REASON_MAP).
        reason:
          skip.reason === 'requires-env-secrets'
            ? 'secret-boundary-env'
            : skip.reason,
        ...(skip.detail ? { detail: skip.detail } : {}),
      });
    if (stationControlAuth && !resolved.stationControlDelivered)
      options.revokeStationControlMcpAuth?.(
        input.threadId,
        revokeKind('station-control'),
      );
    if (stationKnowledgeAuth && !resolved.stationKnowledgeDelivered)
      options.revokeStationControlMcpAuth?.(
        input.threadId,
        revokeKind('station-knowledge'),
      );
    const servers: OpenCodeMcpServer[] = [];
    for (const server of resolved.servers) {
      try {
        servers.push(openCodeMcpConfig(server));
      } catch {
        undelivered.push({
          capability: 'toolServers',
          id: server.name,
          reason: 'engine-unsupported',
          detail: 'OpenCode 2 does not add SSE MCP servers',
        });
      }
    }
    return {
      servers,
      undelivered,
      sessionScoped:
        (stationControlAuth !== undefined &&
          resolved.stationControlDelivered === true) ||
        (stationKnowledgeAuth !== undefined &&
          resolved.stationKnowledgeDelivered === true),
    };
  } catch (error) {
    // As on ACP: a failed resolution delivers nothing and says so; it does
    // not stop the session from starting.
    if (stationControlAuth)
      options.revokeStationControlMcpAuth?.(
        input.threadId,
        revokeKind('station-control'),
      );
    if (stationKnowledgeAuth)
      options.revokeStationControlMcpAuth?.(
        input.threadId,
        revokeKind('station-knowledge'),
      );
    return {
      servers: [],
      undelivered: [
        {
          capability: 'toolServers',
          reason: 'delivery-failed',
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
      sessionScoped: false,
    };
  }
}
