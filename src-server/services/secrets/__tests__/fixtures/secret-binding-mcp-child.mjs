#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

// This fixture intentionally never returns the environment value. It proves a
// real stdio child was given the binding without turning test output into a
// second secret-bearing channel.
const configured = process.env.BINDING_FIXTURE_TOKEN === 'fixture-sentinel';

function createServer() {
  const server = new McpServer({ name: 'binding-fixture', version: '1.0.0' });
  server.registerTool(
    'binding_ready',
    {
      description: 'Reports only that the binding was present.',
      inputSchema: { value: z.string().optional() },
      _meta: { ui: { visibility: ['app'] } },
    },
    async () => ({
      content: [{ type: 'text', text: 'binding-ready' }],
      structuredContent: { configured },
    }),
  );
  return server;
}

const inputClosed = new Promise((resolve) => {
  process.stdin.once('end', resolve);
  process.stdin.once('close', resolve);
});
const handle = serveStdio(createServer, {
  onerror: (error) => process.stderr.write(`binding fixture: ${error.name}\n`),
});
await inputClosed;
await handle.close();
