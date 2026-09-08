#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const RESOURCE_URI = 'ui://station-modern-fixture/panel';

if (process.env.STATION_MCP_TEST_RECEIPT) {
  writeFileSync(
    process.env.STATION_MCP_TEST_RECEIPT,
    JSON.stringify({
      cwd: process.cwd(),
      root: process.env.PLUGIN_ROOT,
      data: process.env.PLUGIN_DATA,
      literal: process.env.STATION_MCP_TEST_LITERAL,
    }),
  );
}

function createServer() {
  const server = new McpServer(
    {
      name: 'station-modern-fixture',
      version: '2.0.0',
    },
    {
      capabilities: {
        extensions: {
          'io.modelcontextprotocol/ui': {},
        },
      },
      cacheHints: {
        'server/discover': { ttlMs: 0, cacheScope: 'private' },
        'tools/list': { ttlMs: 0, cacheScope: 'private' },
        'resources/read': { ttlMs: 0, cacheScope: 'private' },
      },
    },
  );

  server.registerTool(
    'echo',
    {
      title: 'Echo',
      description: 'Echo a value with structured content.',
      inputSchema: { value: z.string().optional() },
      _meta: {
        ui: {
          resourceUri: RESOURCE_URI,
          visibility: ['model', 'app'],
        },
      },
    },
    async ({ value }) => ({
      content: [{ type: 'text', text: value ?? 'modern' }],
      structuredContent: { value: value ?? 'modern', era: 'modern' },
      _meta: { fixture: 'modern' },
    }),
  );

  server.registerResource(
    'modern-panel',
    RESOURCE_URI,
    {
      title: 'Modern fixture panel',
      mimeType: 'text/html;profile=mcp-app',
      cacheHint: { ttlMs: 0, cacheScope: 'private' },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/html;profile=mcp-app',
          text: '<!doctype html><title>Modern fixture</title>',
        },
      ],
    }),
  );

  return server;
}

const inputClosed = new Promise((resolve) => {
  process.stdin.once('end', resolve);
  process.stdin.once('close', resolve);
});

const handle = serveStdio(createServer, {
  legacy: 'serve',
  onerror: (error) => {
    process.stderr.write(`modern fixture: ${error.name}\n`);
  },
});

await inputClosed;
await handle.close();
