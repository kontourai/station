#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { adoptStationCompileCache } from '../runtime/bootstrap/adopt-compile-cache.js';
import { installStationControlStdioEntry } from './station-control-shared.js';
import { createStationKnowledgeMcpServer } from './station-knowledge-mcp-server.js';

installStationControlStdioEntry();
// Keep Station's compile cache out of anything this child starts, and write
// it now: an engine may end this child with a signal.
adoptStationCompileCache();
const inputClosed = new Promise<void>((resolve) => {
  process.stdin.once('end', resolve);
  process.stdin.once('close', resolve);
});
const handle = serveStdio(() => createStationKnowledgeMcpServer(), {
  legacy: 'serve',
});
await inputClosed;
await handle.close();
