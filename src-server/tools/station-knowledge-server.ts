#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { installStationControlStdioEntry } from './station-control-shared.js';
import { createStationKnowledgeMcpServer } from './station-knowledge-mcp-server.js';

installStationControlStdioEntry();
const inputClosed = new Promise<void>((resolve) => {
  process.stdin.once('end', resolve);
  process.stdin.once('close', resolve);
});
const handle = serveStdio(() => createStationKnowledgeMcpServer(), {
  legacy: 'serve',
});
await inputClosed;
await handle.close();
