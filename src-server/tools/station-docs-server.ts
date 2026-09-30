#!/usr/bin/env node
/**
 * station-docs — Built-in MCP server exposing Station's own shipped
 * documentation as tools (archive#1547). Runs as a stdio MCP server, mirroring
 * `station-control-server.ts`.
 *
 * Unlike station-control this server needs no credential and no environment
 * at all: everything it serves is compiled into its own bundle. Delivery still
 * requires an engine with a supported tool-server transport; being credential
 * free does not establish that channel or Station-control authority.
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
