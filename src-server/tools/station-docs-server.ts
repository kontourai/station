#!/usr/bin/env node
/**
 * station-docs — Built-in MCP server exposing Station's own shipped
 * documentation as tools (station#1547). Runs as a stdio MCP server, mirroring
 * `station-control-server.ts`.
 *
 * Unlike station-control this server needs no credential and no environment
 * at all: everything it serves is compiled into its own bundle. That is what
 * lets Station deliver it to every engine, including the engines that can
 * never be handed `station-control`.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createStationDocsMcpServer } from './station-docs-mcp-server.js';

const inputClosed = new Promise<void>((resolve) => {
  process.stdin.once('end', resolve);
  process.stdin.once('close', resolve);
});

const handle = serveStdio(createStationDocsMcpServer, {
  // Existing MCP clients remain supported at the external wire boundary.
  legacy: 'serve',
});

await inputClosed;
await handle.close();
