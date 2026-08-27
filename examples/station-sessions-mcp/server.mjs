#!/usr/bin/env node
/**
 * Station sessions MCP-UI server — roadmap direction-(a): Station's own session
 * data, served as a compliant MCP-UI panel that renders inside any MCP-UI host
 * (Station itself, or an external host).
 *
 * It exposes one tool (`sessions_panel`) whose `_meta.ui.resourceUri` points at
 * a `ui://` HTML resource, built with the official
 * `@modelcontextprotocol/ext-apps/server` helpers on the MCP TypeScript SDK —
 * the same pattern as `examples/mcp-ui-demo`. At resource-read time it fetches
 * Station's open localhost REST API (`GET /orchestration/sessions`) and
 * server-side-renders a self-contained HTML snapshot, so the panel needs no
 * network access of its own and renders under the host's deny-all CSP.
 *
 * Run (from the Station repo root, deps installed):
 *   node examples/station-sessions-mcp/server.mjs        # speaks MCP over stdio
 *   STATION_API_BASE=http://localhost:3242 node examples/station-sessions-mcp/server.mjs
 *
 * See README.md to wire it into Station as an `mcp-tool-ui` layout component.
 */
import {
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { renderSessionsPanel } from './panel.mjs';

const RESOURCE_URI = 'ui://station-sessions/panel';
const API_BASE = process.env.STATION_API_BASE ?? 'http://localhost:3141';

/**
 * Read the current sessions from Station's REST API. Fail-soft: any error
 * (Station not running, network, bad JSON) yields an empty list so the panel
 * renders an empty state rather than throwing inside the host.
 */
async function fetchSessions() {
  try {
    const res = await fetch(`${API_BASE}/orchestration/sessions`);
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.data) ? body.data : [];
  } catch {
    return [];
  }
}

const server = new McpServer({ name: 'station-sessions', version: '1.0.0' });

registerAppTool(
  server,
  'sessions_panel',
  {
    description:
      'Render a live panel of Station orchestration sessions (state, provider, project, last activity).',
    _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ['model', 'app'] } },
    inputSchema: {},
  },
  async () => {
    const sessions = await fetchSessions();
    return {
      content: [{ type: 'text', text: `${sessions.length} session(s)` }],
      structuredContent: { count: sessions.length },
    };
  },
);

registerAppResource(server, 'Sessions Panel', RESOURCE_URI, {}, async () => ({
  contents: [
    {
      uri: RESOURCE_URI,
      mimeType: 'text/html;profile=mcp-app',
      text: renderSessionsPanel(await fetchSessions()),
    },
  ],
}));

await server.connect(new StdioServerTransport());
