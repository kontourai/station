/**
 * MCP Client Factory — creates MCP clients from tool definitions.
 *
 * Supports stdio, SSE, and Streamable HTTP transports.
 * Used by both the core server and CLI dev server.
 */

import {
  Client,
  type FetchLike,
  type OAuthClientProvider,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { ToolDef } from './index.js';
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
export async function connectMCP(
  def: ToolDef,
  opts?: MCPManagerOptions,
): Promise<MCPConnection> {
  const normalized = normalizeTransportConfig(def);
  const transport = createMCPTransport(normalized, opts?.authProvider);
  opts?.onTransport?.(transport);
  const client = new Client(
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

  try {
    await client.connect(transport);
    opts?.onStatus?.(def.id, 'connected');
  } catch (err: unknown) {
    opts?.onStatus?.(def.id, 'failed', 'Tool server connection failed');
    throw err;
  }

  const negotiation = describeNegotiation(client);
  opts?.onNegotiated?.(def.id, negotiation);

  // Discover tools
  const result = await client.listTools();
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

  return {
    client,
    serverId: def.id,
    tools,
    negotiation,
    close: async () => {
      await client.close();
    },
    disconnect: async () => {
      await client.close();
    },
  };
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
          const conn = await connectMCP(def, this.opts);
          this.connections.set(def.id, conn);
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
    return Array.from(this.connections.values()).flatMap((c) => c.tools);
  }

  /** Call a tool by its prefixed name (e.g., "my-server_list_items"). */
  async callTool(
    prefixedName: string,
    args: Record<string, unknown> = {},
  ): Promise<any> {
    // Find which connection owns this tool
    for (const conn of this.connections.values()) {
      const tool = conn.tools.find((t) => t.name === prefixedName);
      if (tool) return callTool(conn, prefixedName, args);
    }
    throw new Error(`Tool not found: ${prefixedName}`);
  }

  /** Get connection for a specific server. */
  getConnection(serverId: string): MCPConnection | undefined {
    return this.connections.get(serverId);
  }

  /** Shut down all connections. */
  async closeAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.connections.values()).map((c) => c.close()),
    );
    this.connections.clear();
  }
}

// ── Transport factory ──────────────────────────────────────────────

function originBoundLiteralHeaderFetch(
  endpoint: string,
  literals: Record<string, string>,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): FetchLike {
  const endpointOrigin = new URL(endpoint).origin;
  return async (input, init) => {
    const requestUrl = typeof input === 'string' ? new URL(input) : input;
    if (requestUrl.origin !== endpointOrigin) {
      return fetchImpl(input, { ...init, redirect: 'error' });
    }
    const headers = new Headers(literals);
    new Headers(init?.headers).forEach((value, name) => {
      // The SDK/client is always the final writer. This automatically covers
      // future generated HTTP or MCP headers without a driftable denylist.
      headers.set(name, value);
    });
    return fetchImpl(input, { ...init, headers, redirect: 'error' });
  };
}

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
        cwd: def.cwd,
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
        requestInit: { redirect: 'error' },
        ...(def.headers
          ? { fetch: originBoundLiteralHeaderFetch(def.endpoint, def.headers) }
          : {}),
      });

    default:
      if (def.command) {
        return new StdioClientTransport({
          command: def.command,
          args: def.args,
          env: { ...process.env, ...(def.env || {}) } as Record<string, string>,
          cwd: def.cwd,
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
    cwd: def.cwd,
    endpoint: normalized.endpoint,
    headers: def.headers,
    env: normalized.env as ClaudeDesktopConfig['mcpServers'][string]['env'],
    exposedTools: normalized.exposedTools,
    timeouts: normalized.timeouts,
  };
}
