/**
 * MCP Client Factory — creates MCP clients from tool definitions.
 *
 * Supports stdio, SSE, and Streamable HTTP transports.
 * Used by both the core server and CLI dev server.
 */

import {
  Client,
  type OAuthClientProvider,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { ToolDef } from './index.js';
import {
  MCPLocalConnectionCustody,
  MCPLocalCustodyError,
} from './mcp-local-custody.js';

export {
  type MCPLocalClaim,
  type MCPLocalCleanup,
  MCPLocalConnectionCustody,
  MCPLocalCustodyError,
  type MCPLocalPurpose,
} from './mcp-local-custody.js';

import {
  type ClaudeDesktopConfig,
  normalizeMcpToolDef,
} from './portability.js';

export type { MCPToolUICsp } from './mcp-ui-csp.js';
// The CSP builder lives in a node-free module so the browser UI can import it as
// a value without dragging this file's MCP SDK transports into the web bundle.
export { buildMcpUiCsp, safeCspDomains } from './mcp-ui-csp.js';

export interface MCPToolInfo {
  name: string; // prefixed: "{serverId}_{toolName}"
  originalName: string; // raw name from MCP server
  serverId: string;
  description?: string;
  inputSchema?: any;
  _meta?: Record<string, unknown>;
  ui?: MCPToolUIMetadata;
}

/** Declared permission-policy requests from resource-content metadata. */
export interface MCPToolUIPermissions {
  camera?: unknown;
  microphone?: unknown;
  geolocation?: unknown;
  clipboardWrite?: unknown;
}

export interface MCPToolUIMetadata {
  resourceUri: string;
}

export type MCPToolUIResolutionStatus =
  | 'invalid_ref'
  | 'missing_server'
  | 'missing_tool'
  | 'missing_resource'
  | 'render_revoked'
  | 'unsupported'
  | 'success';

export interface MCPToolUIResolution {
  status: MCPToolUIResolutionStatus;
  ref: string;
  serverId?: string;
  toolName?: string;
  resourceUri?: string;
  reason?: string;
}

export interface MCPConnection {
  client: Client;
  serverId: string;
  tools: MCPToolInfo[];
  negotiation: MCPNegotiation;
  close: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Present on owned connections; false after a local retirement fence. */
  isUsable?: () => boolean;
  localState?: () => ReturnType<MCPPreparedConnection['inspect']>;
}

/** Local SDK resources only. Never a child-process or remote-effect drain receipt. */
export interface MCPPreparedConnection {
  connect(): Promise<MCPConnection>;
  retainForOAuth(): void;
  finishAuth(params: URLSearchParams): Promise<void>;
  close(): Promise<void>;
  inspect(): {
    phase:
      | 'prepared'
      | 'connecting'
      | 'connected'
      | 'failed'
      | 'oauth'
      | 'closing'
      | 'close-failed'
      | 'closed';
    pendingOperations: number;
  };
}

export interface MCPNegotiation {
  era: 'modern' | 'legacy';
  protocolVersion?: string;
  serverInfo?: { name: string; version: string };
  serverCapabilities?: Record<string, unknown>;
  extensionIds: string[];
  fellBackToLegacy: boolean;
  discoverResult?: Record<string, unknown>;
}

export interface MCPManagerOptions {
  /** OAuth provider for remote HTTP transports. */
  authProvider?: OAuthClientProvider;
  /** Internal OAuth seam used to complete a browser redirect round trip. */
  onTransport?: (transport: Transport) => void;
  /** Called when a server connects or fails */
  onStatus?: (
    serverId: string,
    status: 'connected' | 'failed',
    error?: string,
  ) => void;
  /** Called after version negotiation and before tool discovery. */
  onNegotiated?: (serverId: string, negotiation: MCPNegotiation) => void;
}

const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';
const MCP_APPS_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * Create an MCP client from a tool definition.
 * Returns the connected client with its tool catalog.
 */
export function prepareMCPConnection(
  def: ToolDef,
  opts?: MCPManagerOptions,
  isCurrent: () => boolean = () => true,
): MCPPreparedConnection {
  const normalized = normalizeTransportConfig(def);
  // Normalization is effect-free. The caller owns this handle before either
  // constructor runs, including a partial constructor/observer failure.
  let transport: Transport | undefined;
  let client: Client | undefined;
  let phase: ReturnType<MCPPreparedConnection['inspect']>['phase'] = 'prepared';
  let retired = false;
  let activity = 0;
  const pending = new Set<Promise<void>>();
  let connecting: Promise<MCPConnection> | undefined;
  let closing: Promise<void> | undefined;
  const current = () => !retired && isCurrent() === true;
  const assertCurrent = () => {
    if (!current())
      throw new Error('MCP local connection is no longer current');
  };
  function track<T>(operation: () => T): T {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    pending.add(settled);
    activity++;
    const finish = () => {
      activity++;
      pending.delete(settled);
      settle();
    };
    try {
      const value = operation();
      if (value && typeof (value as { then?: unknown }).then === 'function')
        return Promise.resolve(value).finally(finish) as T;
      finish();
      return value;
    } catch (error) {
      finish();
      throw error;
    }
  }
  // SDK-internal close calls and our close use the same exact in-flight
  // promise. Later activity requires another close; rejection is retryable
  // only after that close actually settled, never by overlapping it.
  function closeOnce(operation: () => Promise<void>) {
    let flight: Promise<void> | undefined;
    let unsettled = false;
    let successful = false;
    let closedActivity = -1;
    return () => {
      if (flight && (unsettled || (successful && closedActivity === activity)))
        return flight;
      unsettled = true;
      successful = false;
      closedActivity = activity;
      flight = Promise.resolve()
        .then(operation)
        .then(
          () => {
            successful = true;
          },
          (error) => {
            throw error;
          },
        )
        .finally(() => {
          unsettled = false;
        });
      return flight;
    };
  }
  let closeTransport = async () => {};
  let closeClient = async () => {};
  async function closePair() {
    const results = await Promise.allSettled([closeClient(), closeTransport()]);
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('MCP local SDK cleanup did not settle successfully');
  }
  const handle: MCPPreparedConnection = {
    inspect: () => ({ phase, pendingOperations: pending.size }),
    connect() {
      assertCurrent();
      if (connecting) return connecting;
      phase = 'connecting';
      connecting = track(() =>
        Promise.resolve().then(async () => {
          try {
            assertCurrent();
            transport = createMCPTransport(normalized, opts?.authProvider);
            const rawTransport = transport;
            const originalTransportClose =
              rawTransport.close.bind(rawTransport);
            const physicalClose = closeOnce(originalTransportClose);
            rawTransport.close = physicalClose;
            // SDK stdio negotiation temporarily wraps close to cancel its probe.
            // Preserve that hook without making the wrapper recurse into itself.
            let currentTransportClose = physicalClose;
            closeTransport = () => currentTransportClose();
            const guardedTransport = new Proxy(rawTransport, {
              get(target, property) {
                if (property === 'close') return currentTransportClose;
                if (property === 'constructor') return target.constructor;
                const value = Reflect.get(target, property, target);
                if (typeof value !== 'function') return value;
                return (...args: unknown[]) => {
                  // SDK negotiation may close/restart a transport. Once retired,
                  // no later start/send may resurrect that local handle.
                  assertCurrent();
                  return track(() => {
                    const result = Reflect.apply(value, target, args);
                    if (
                      result &&
                      typeof (result as { then?: unknown }).then === 'function'
                    )
                      return Promise.resolve(result).then((settled) => {
                        assertCurrent();
                        return settled;
                      });
                    assertCurrent();
                    return result;
                  });
                };
              },
              set(target, property, value) {
                if (property === 'close') {
                  currentTransportClose = value;
                  return true;
                }
                return Reflect.set(target, property, value, target);
              },
            });
            client = new Client(
              { name: 'station', version: '0.1.0' },
              {
                capabilities: {
                  extensions: {
                    [MCP_APPS_EXTENSION_ID]: {
                      mimeTypes: [MCP_APPS_MIME_TYPE],
                    },
                  },
                },
                versionNegotiation: {
                  mode: 'auto',
                  ...(def.timeouts?.startupMs
                    ? { probe: { timeoutMs: def.timeouts.startupMs } }
                    : {}),
                },
              },
            );
            const rawClient = client;
            const originalClose = rawClient.close.bind(rawClient);
            closeClient = closeOnce(originalClose);
            rawClient.close = closeClient;
            opts?.onTransport?.(guardedTransport);
            assertCurrent();
            await rawClient.connect(guardedTransport);
            assertCurrent();
            opts?.onStatus?.(def.id, 'connected');
            const negotiation = describeNegotiation(rawClient);
            opts?.onNegotiated?.(def.id, negotiation);

            // Discover tools
            assertCurrent();
            const result = await rawClient.listTools();
            assertCurrent();
            const tools: MCPToolInfo[] = (result.tools || []).map((t) => ({
              name: `${def.id}_${t.name}`,
              originalName: t.name,
              serverId: def.id,
              description: t.description,
              inputSchema: t.inputSchema,
              _meta: isRecord((t as { _meta?: unknown })._meta)
                ? (t as { _meta: Record<string, unknown> })._meta
                : undefined,
              ui: extractMCPToolUIMetadata(t),
            }));

            const guardedClient = new Proxy(rawClient, {
              get(target, property) {
                if (property === 'close') return handle.close;
                if (property === 'constructor') return target.constructor;
                const value = Reflect.get(target, property, target);
                if (typeof value !== 'function') return value;
                return (...args: unknown[]) => {
                  assertCurrent();
                  if (phase !== 'connected')
                    throw new Error('MCP local connection is unavailable');
                  return track(() => Reflect.apply(value, target, args));
                };
              },
              set: (target, property, value) =>
                Reflect.set(target, property, value, target),
            });
            phase = 'connected';
            return {
              client: guardedClient,
              serverId: def.id,
              tools,
              negotiation,
              close: handle.close,
              disconnect: handle.close,
              isUsable: () => current() && phase === 'connected',
              localState: handle.inspect,
            };
          } catch (error) {
            if (!retired) phase = 'failed';
            opts?.onStatus?.(def.id, 'failed', 'Tool server connection failed');
            throw error;
          }
        }),
      );
      return connecting;
    },
    retainForOAuth() {
      assertCurrent();
      if (phase !== 'failed' || !transport || !('finishAuth' in transport))
        throw new Error('MCP OAuth continuation is unavailable');
      phase = 'oauth';
    },
    async finishAuth(params) {
      assertCurrent();
      if (phase !== 'oauth' || !transport || !('finishAuth' in transport))
        throw new Error('MCP OAuth continuation is unavailable');
      await track(() =>
        (
          transport as Transport & {
            finishAuth(value: URLSearchParams): Promise<void>;
          }
        ).finishAuth(params),
      );
      assertCurrent();
    },
    close() {
      retired = true;
      if (phase === 'closed') return Promise.resolve();
      if (closing) return closing;
      phase = 'closing';
      closing = (async () => {
        const before = activity;
        await closePair();
        // A timeout outside this promise does not release custody. In
        // particular late connect/discovery must finish before the final close.
        while (pending.size) await Promise.all([...pending]);
        if (activity !== before) await closePair();
        phase = 'closed';
      })().catch((error) => {
        phase = 'close-failed';
        closing = undefined;
        throw error;
      });
      return closing;
    },
  };
  return handle;
}

/** Compatibility helper; supported owners use prepareMCPConnection before awaiting. */
export async function connectMCP(
  def: ToolDef,
  opts?: MCPManagerOptions,
): Promise<MCPConnection> {
  const prepared = prepareMCPConnection(def, opts);
  try {
    return await prepared.connect();
  } catch (error) {
    // Keep the failed call pending while cleanup is pending. A rejected cleanup
    // carries the prepared handle non-enumerably for explicit caller recovery.
    try {
      await prepared.close();
    } catch {
      const failure = new Error('MCP local SDK cleanup failed');
      Object.defineProperty(failure, 'localConnection', { value: prepared });
      throw failure;
    }
    throw error;
  }
}

function describeNegotiation(client: Client): MCPNegotiation {
  const era = client.getProtocolEra() ?? 'legacy';
  const serverInfo = client.getServerVersion();
  const capabilities = client.getServerCapabilities();
  const discover = client.getDiscoverResult();
  const extensions = isRecord(capabilities?.extensions)
    ? capabilities.extensions
    : undefined;

  return {
    era,
    protocolVersion: client.getNegotiatedProtocolVersion(),
    serverInfo: serverInfo
      ? { name: serverInfo.name, version: serverInfo.version }
      : undefined,
    serverCapabilities: isRecord(capabilities)
      ? (capabilities as Record<string, unknown>)
      : undefined,
    extensionIds: extensions ? Object.keys(extensions).sort() : [],
    fellBackToLegacy: era === 'legacy',
    discoverResult: isRecord(discover)
      ? (discover as Record<string, unknown>)
      : undefined,
  };
}

function extractMCPToolUIMetadata(
  tool: unknown,
): MCPToolUIMetadata | undefined {
  if (!isRecord(tool)) return undefined;

  const meta = isRecord(tool._meta) ? tool._meta : undefined;
  const ui = isRecord(meta?.ui) ? meta.ui : undefined;
  const resourceUri =
    typeof ui?.resourceUri === 'string'
      ? ui.resourceUri
      : typeof meta?.['ui/resourceUri'] === 'string'
        ? meta['ui/resourceUri']
        : undefined;
  return resourceUri ? { resourceUri } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Call a tool on an MCP connection.
 */
export async function callTool(
  conn: MCPConnection,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  // Accept both prefixed ("server_tool") and raw ("tool") names
  const originalName = toolName.startsWith(`${conn.serverId}_`)
    ? toolName.slice(conn.serverId.length + 1)
    : toolName;

  const result = await conn.client.callTool({
    name: originalName,
    arguments: args,
  });
  return result;
}

/**
 * Manage multiple MCP connections for a set of tool definitions.
 */
export class MCPManager {
  private connections = new Map<string, MCPConnection>();
  private readonly custody = new MCPLocalConnectionCustody();
  private opts: MCPManagerOptions;

  constructor(opts: MCPManagerOptions = {}) {
    this.opts = opts;
  }

  /** Connect to all provided tool definitions. Failures are logged, not thrown. */
  async connectAll(defs: ToolDef[]): Promise<void> {
    const results = await Promise.allSettled(
      defs
        .filter((d) => d.kind === 'mcp')
        .map(async (def) => {
          const claim = this.custody.acquire(def.id, 'managed');
          try {
            const conn = await claim.connect(def, this.opts);
            if (!claim.isCurrent()) throw new MCPLocalCustodyError('stale');
            this.connections.set(def.id, conn);
          } catch (error) {
            await claim.close().catch(() => undefined);
            throw error;
          }
        }),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        // Already reported via onStatus callback
      }
    }
  }

  /** Get all discovered tools across all connections. */
  listTools(): MCPToolInfo[] {
    return Array.from(this.connections.values())
      .filter((c) => c.isUsable?.() !== false)
      .flatMap((c) => c.tools);
  }

  /** Call a tool by its prefixed name (e.g., "my-server_list_items"). */
  async callTool(
    prefixedName: string,
    args: Record<string, unknown> = {},
  ): Promise<any> {
    // Find which connection owns this tool
    for (const conn of this.connections.values()) {
      if (conn.isUsable?.() === false) continue;
      const tool = conn.tools.find((t) => t.name === prefixedName);
      if (tool) return callTool(conn, prefixedName, args);
    }
    throw new Error(`Tool not found: ${prefixedName}`);
  }

  /** Get connection for a specific server. */
  getConnection(serverId: string): MCPConnection | undefined {
    const connection = this.connections.get(serverId);
    return connection?.isUsable?.() === false ? undefined : connection;
  }

  /** Shut down all connections. */
  async closeAll(): Promise<void> {
    const result = await this.custody.reset();
    if (result.state !== 'settled')
      throw new MCPLocalCustodyError(result.state);
    this.connections.clear();
  }
}

// ── Transport factory ──────────────────────────────────────────────

export function createMCPTransport(
  def: ToolDef,
  authProvider?: OAuthClientProvider,
): Transport {
  const transport = def.transport || (def.command ? 'stdio' : undefined);

  switch (transport) {
    case 'stdio':
      if (!def.command)
        throw new Error(`Tool '${def.id}': stdio transport requires 'command'`);
      return new StdioClientTransport({
        command: def.command,
        args: def.args,
        env: { ...process.env, ...(def.env || {}) } as Record<string, string>,
      });

    case 'sse':
      if (!def.endpoint)
        throw new Error(`Tool '${def.id}': sse transport requires 'endpoint'`);
      return new SSEClientTransport(new URL(def.endpoint), { authProvider });

    case 'streamable-http':
      if (!def.endpoint)
        throw new Error(
          `Tool '${def.id}': streamable-http transport requires 'endpoint'`,
        );
      return new StreamableHTTPClientTransport(new URL(def.endpoint), {
        authProvider,
      });

    default:
      if (def.command) {
        return new StdioClientTransport({
          command: def.command,
          args: def.args,
          env: { ...process.env, ...(def.env || {}) } as Record<string, string>,
        });
      }
      throw new Error(
        `Tool '${def.id}': cannot determine transport (set 'transport' or 'command')`,
      );
  }
}

function normalizeTransportConfig(def: ToolDef): ToolDef {
  const result = normalizeMcpToolDef(def);
  if (!result.normalized) {
    throw new Error(
      result.losses[0]?.message ||
        `Tool '${def.id}': unsupported MCP configuration for transport`,
    );
  }

  const normalized = result.normalized;
  return {
    id: normalized.id,
    kind: 'mcp',
    displayName: normalized.displayName,
    description: normalized.description,
    transport: normalized.transport,
    command: normalized.command,
    args: normalized.args,
    endpoint: normalized.endpoint,
    env: normalized.env as ClaudeDesktopConfig['mcpServers'][string]['env'],
    exposedTools: normalized.exposedTools,
    timeouts: normalized.timeouts,
  };
}
