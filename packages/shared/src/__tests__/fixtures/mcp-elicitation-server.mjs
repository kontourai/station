#!/usr/bin/env node

// Fixture MCP server for #3284: one prompt and one tool that elicits.
// STATION_MCP_FIXTURE_ERA=legacy hand-wires a 2025-era server that sends a
// push-style `elicitation/create` request; the default serves the 2026-07-28
// era, which asks through an `input_required` result instead.

import {
  inputRequired,
  inputResponse,
  McpServer,
} from '@modelcontextprotocol/server';
import {
  StdioServerTransport,
  serveStdio,
} from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const legacy = process.env.STATION_MCP_FIXTURE_ERA === 'legacy';

const DETAILS_REQUEST = {
  message: 'Who should the report be addressed to?',
  requestedSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Name', minLength: 1, maxLength: 40 },
      age: { type: 'integer', title: 'Age', minimum: 0, maximum: 150 },
      subscribe: { type: 'boolean', title: 'Subscribe' },
      color: {
        type: 'string',
        title: 'Color',
        oneOf: [
          { const: 'red', title: 'Red' },
          { const: 'blue', title: 'Blue' },
        ],
      },
    },
    required: ['name'],
  },
};

function report(action, content) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ action, content: content ?? null }),
      },
    ],
  };
}

function createServer() {
  const server = new McpServer({
    name: 'station-elicitation-fixture',
    version: '1.0.0',
  });

  server.registerPrompt(
    'summarize',
    {
      title: 'Summarize',
      description: 'Summarize a topic in a chosen tone.',
      argsSchema: {
        topic: z.string().describe('What to summarize'),
        tone: z.string().optional().describe('How it should sound'),
      },
    },
    async ({ topic, tone }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Summarize ${topic} in a ${tone ?? 'neutral'} tone.`,
          },
        },
      ],
    }),
  );

  server.registerTool(
    'ask_details',
    {
      title: 'Ask details',
      description: 'Ask the person for report details.',
      inputSchema: {},
    },
    async (_args, ctx) => {
      if (legacy) {
        const result = await ctx.mcpReq.elicitInput({
          mode: 'form',
          ...DETAILS_REQUEST,
        });
        return report(result.action, result.content);
      }
      const view = inputResponse(ctx.mcpReq.inputResponses, 'details');
      if (view.kind === 'missing')
        return inputRequired({
          inputRequests: { details: inputRequired.elicit(DETAILS_REQUEST) },
        });
      if (view.kind !== 'elicit') return report('unexpected');
      return report(view.action, view.content);
    },
  );

  return server;
}

const inputClosed = new Promise((resolve) => {
  process.stdin.once('end', resolve);
  process.stdin.once('close', resolve);
});

if (legacy) {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  await inputClosed;
  await server.close();
} else {
  const handle = serveStdio(createServer, {
    legacy: 'serve',
    onerror: (error) => {
      process.stderr.write(`elicitation fixture: ${error.name}\n`);
    },
  });
  await inputClosed;
  await handle.close();
}
