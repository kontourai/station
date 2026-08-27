#!/usr/bin/env node
/**
 * station-control — Built-in MCP server exposing Station's API as tools.
 * Runs as a stdio MCP server. Any agent can use it by adding "station-control"
 * to their mcpServers list.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createStationControlMcpServer } from './station-control-mcp-server.js';

const inputClosed = new Promise<void>((resolve) => {
  process.stdin.once('end', resolve);
  process.stdin.once('close', resolve);
});

const handle = serveStdio(createStationControlMcpServer, {
  // Existing MCP clients remain supported at the external wire boundary.
  legacy: 'serve',
});

await inputClosed;
await handle.close();
