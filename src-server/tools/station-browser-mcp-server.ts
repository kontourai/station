/**
 * `station-browser` (#90 D14): the browser tools as their OWN built-in MCP
 * server — a narrow grant (browser tools only), not a slice of
 * station-control. Station delivers it in-process (credential `bound`) to
 * Claude agents by default; an operator switches it off per agent in the
 * agent editor. Engines without bound delivery do not get it (the tools
 * would refuse them anyway).
 */
import { McpServer } from '@modelcontextprotocol/server';
import { STATION_BROWSER_MCP_SERVER_ID } from './station-browser-policy.js';
import { registerBrowserTools } from './station-control-browser-tools.js';
import { StationControlToolRegistry } from './station-control-mcp-server.js';

export function createStationBrowserMcpServer(): McpServer {
  const server = new McpServer(
    { name: STATION_BROWSER_MCP_SERVER_ID, version: '1.0.0' },
    {
      cacheHints: {
        'server/discover': { ttlMs: 300_000, cacheScope: 'private' },
        'tools/list': { ttlMs: 300_000, cacheScope: 'private' },
      },
    },
  );
  registerBrowserTools(new StationControlToolRegistry(server));
  return server;
}
