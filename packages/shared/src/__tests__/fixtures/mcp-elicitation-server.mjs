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
// STATION_MCP_FIXTURE_HOLD_LIST=1 holds every `prompts/list` response until
// an eliciting tool has reported its result (or 10s pass), so a test can keep
// a catalog read in flight across a tool call's elicitation.
const holdList = process.env.STATION_MCP_FIXTURE_HOLD_LIST === '1';
let reported;
const toolReported = new Promise((resolve) => {
  reported = resolve;
});

const AGAIN_REQUEST = {
  message: 'Anything else for the report?',
  requestedSchema: {
    type: 'object',
    properties: { note: { type: 'string', title: 'Note' } },
  },
};

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
  reported();
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
        // A refused elicitation throws; it still ends this call.
        const result = await ctx.mcpReq
          .elicitInput({ mode: 'form', ...DETAILS_REQUEST })
          .finally(reported);
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

  // Asks twice in one call: once for details, then once more.
  server.registerTool(
    'ask_twice',
    {
      title: 'Ask twice',
      description: 'Ask for details, then for a note.',
      inputSchema: {},
    },
    async (_args, ctx) => {
      if (legacy) {
        const first = await ctx.mcpReq.elicitInput({
          mode: 'form',
          ...DETAILS_REQUEST,
        });
        const again = await ctx.mcpReq.elicitInput({
          mode: 'form',
          ...AGAIN_REQUEST,
        });
        return report(again.action, {
          first: first.content ?? null,
          again: again.content ?? null,
        });
      }
      const again = inputResponse(ctx.mcpReq.inputResponses, 'again');
      if (again.kind === 'elicit')
        return report(again.action, { again: again.content ?? null });
      const first = inputResponse(ctx.mcpReq.inputResponses, 'details');
      if (first.kind === 'missing')
        return inputRequired({
          inputRequests: { details: inputRequired.elicit(DETAILS_REQUEST) },
        });
      return inputRequired({
        inputRequests: { again: inputRequired.elicit(AGAIN_REQUEST) },
      });
    },
  );

  if (holdList) {
    // Same listing as the registered prompt; only its timing differs.
    server.server.setRequestHandler('prompts/list', async () => {
      await Promise.race([
        toolReported,
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
      return {
        prompts: [
          {
            name: 'summarize',
            title: 'Summarize',
            description: 'Summarize a topic in a chosen tone.',
            arguments: [
              {
                name: 'topic',
                description: 'What to summarize',
                required: true,
              },
              {
                name: 'tone',
                description: 'How it should sound',
                required: false,
              },
            ],
          },
        ],
      };
    });
  }

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
