#!/usr/bin/env node
/**
 * See README.md for stdio wiring and #2785 for the unqualified session reader.
 * Route/authentication failures currently look like an empty collection.
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
