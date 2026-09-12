export * from './mcp-connection.js';
export {
  bindMCPDefinitionAdmission,
  type MCPLocalClaim,
  type MCPLocalCleanup,
  MCPLocalConnectionCustody,
  MCPLocalCustodyError,
  type MCPLocalPurpose,
} from './mcp-local-custody.js';

import {
  callTool,
  type MCPConnection,
  type MCPManagerOptions,
  type MCPToolInfo,
} from './mcp-connection.js';
import {
  MCPLocalConnectionCustody,
  MCPLocalCustodyError,
} from './mcp-local-custody.js';
import type { ToolDef } from './types.js';

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
    await Promise.allSettled(
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
