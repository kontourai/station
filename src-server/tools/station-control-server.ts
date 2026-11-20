#!/usr/bin/env node
/**
 * station-control — Built-in MCP server exposing Station's API as tools.
 * Runs as a stdio MCP server. Any agent can use it by adding "station-control"
 * to their mcpServers list.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { adoptStationCompileCache } from '../runtime/bootstrap/adopt-compile-cache.js';
import { createStationControlMcpServer } from './station-control-mcp-server.js';
import { installStationControlStdioEntry } from './station-control-shared.js';

// A stdio child carries no caller (and, since #2377 slice D, no internal
// token): mark it so nothing it sends carries the server-self attestation.
installStationControlStdioEntry();
// Keep Station's compile cache out of anything this child starts, and write
// it now: an engine may end this child with a signal.
adoptStationCompileCache();

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
