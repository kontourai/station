import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { invokedDirectly } from '../lib/module-entry.mjs';

function createProbeServer() {
  const server = new McpServer({
    name: 'station-delivery-probe',
    version: '1.0.0',
  });
  server.registerTool(
    'ping',
    {
      description:
        'Harmless delivery probe; call this to prove this server is available.',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text', text: 'DELIVERY_PING_OK' }] }),
  );
  server.registerTool(
    'blocked',
    {
      description:
        'Harmless negative control; must be disabled by the delivery probe.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: 'DISABLED_TOOL_WAS_CALLED' }],
    }),
  );
  return server;
}

if (invokedDirectly(import.meta.url))
  await createProbeServer().connect(new StdioServerTransport());
