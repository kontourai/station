#!/usr/bin/env node
/**
 * Example MCP-UI server — the smallest real server that exercises Station's
 * MCP-UI host. It exposes one tool whose `_meta.ui.resourceUri` points at a
 * `ui://` HTML resource, built with the official MCP Apps server helpers
 * (`@modelcontextprotocol/ext-apps/server`) on the MCP TypeScript SDK.
 *
 * Run (from the Station repo root, which has the deps installed):
 *   node examples/mcp-ui-demo/server.mjs
 *
 * Register it in Station as a stdio MCP integration, then reference
 * `<serverId>/status_panel` as an `mcp-tool-ui` layout component and enable the
 * `mcpUiHost` config flag. See README.md.
 */
import {
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v3';

const RESOURCE_URI = 'ui://mcp-ui-demo/status-panel';

// Static, self-contained HTML — no external assets, so it renders cleanly under
// Station's hardened sandbox (opaque origin, deny-all CSP). Inline styles only.
const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Station MCP-UI demo</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0d1117;
      color: #e6edf3;
      padding: 20px;
    }
    .card {
      border: 1px solid #30363d;
      border-radius: 10px;
      padding: 18px 20px;
      background: #161b22;
      max-width: 420px;
    }
    h1 { font-size: 16px; margin: 0 0 4px; }
    .sub { color: #8b949e; margin: 0 0 14px; font-size: 12.5px; }
    .ok { color: #3fb950; font-weight: 600; }
    code { background: #0d1117; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Station MCP-UI demo <span class="ok">●</span></h1>
    <p class="sub">Rendered natively by Station's MCP-UI host in a sandboxed iframe.</p>
    <p>This panel is a <code>ui://</code> resource served by an MCP server and
       resolved through <code>&lt;serverId&gt;/status_panel</code>.</p>
  </div>
</body>
</html>`;

const server = new McpServer({ name: 'mcp-ui-demo', version: '1.0.0' });

registerAppTool(
  server,
  'status_panel',
  {
    description: 'Render the Station MCP-UI demo status panel.',
    _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ['model', 'app'] } },
    inputSchema: { label: z.string().optional() },
  },
  async ({ label }) => ({
    content: [
      { type: 'text', text: `status_panel rendered (${label ?? 'ok'})` },
    ],
    structuredContent: { label: label ?? 'ok' },
  }),
);

registerAppResource(server, 'Status Panel', RESOURCE_URI, {}, async () => ({
  contents: [
    {
      uri: RESOURCE_URI,
      mimeType: 'text/html;profile=mcp-app',
      text: PANEL_HTML,
    },
  ],
}));

await server.connect(new StdioServerTransport());
