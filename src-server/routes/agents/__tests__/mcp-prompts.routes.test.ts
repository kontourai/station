/**
 * #3284: an agent's MCP prompts as slash commands — listed and run through
 * the real route, the real MCPService and a live fixture MCP server.
 */
import { fileURLToPath } from 'node:url';
import { connectMCP, type MCPConnection } from '@kontourai/station-shared/mcp';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { MCPService } from '../../../services/plugins/mcp-service.js';
import { createAgentMcpPromptRoutes } from '../mcp-prompts.js';

const FIXTURE = fileURLToPath(
  new URL(
    '../../../../packages/shared/src/__tests__/fixtures/mcp-elicitation-server.mjs',
    import.meta.url,
  ),
);

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

let connection: MCPConnection;
let service: MCPService;

beforeAll(async () => {
  connection = await connectMCP({
    id: 'fixture',
    kind: 'mcp',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
  });
  const loader = {
    loadIntegration: async (id: string) => ({
      id,
      kind: 'mcp',
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
    }),
  };
  // The agent's live connection, as the runtime holds it after tool loading.
  service = new MCPService(
    loader as any,
    new Map([['fixture', connection]]),
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    logger,
  );
});

afterAll(async () => {
  await connection.close();
});

function app(available: string[] = ['*']) {
  return createAgentMcpPromptRoutes({
    resolveAgentSpec: (slug) =>
      slug === 'writer'
        ? ({
            name: 'Writer',
            tools: {
              // station-control is runtime-managed: never asked for prompts.
              mcpServers: ['fixture', 'station-control'],
              available,
            },
          } as any)
        : undefined,
    prompts: service,
    logger,
  });
}

async function run(body: unknown, available?: string[]) {
  const response = await app(available).request('/writer/mcp-prompts/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

describe('GET /agents/:slug/mcp-prompts', () => {
  test('lists the server prompt as a typed slash command', async () => {
    const response = await app().request('/writer/mcp-prompts');
    expect(response.status).toBe(200);
    expect((await response.json()) as any).toEqual({
      success: true,
      data: {
        prompts: [
          {
            command: 'fixture:summarize',
            serverId: 'fixture',
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
        unavailable: [],
      },
    });
  });

  test("respects the agent's tool restriction", async () => {
    const narrowed = await app(['fixture_ask_details']).request(
      '/writer/mcp-prompts',
    );
    expect(((await narrowed.json()) as any).data.prompts).toEqual([]);
    const admitted = await app(['fixture_*']).request('/writer/mcp-prompts');
    expect(((await admitted.json()) as any).data.prompts).toHaveLength(1);
  });

  test('an inactive agent is refused', async () => {
    const response = await app().request('/nobody/mcp-prompts');
    expect(response.status).toBe(404);
  });
});

describe('POST /agents/:slug/mcp-prompts/run', () => {
  test('returns the prompt text to insert into the turn', async () => {
    expect(
      await run({
        serverId: 'fixture',
        name: 'summarize',
        arguments: { topic: 'MCP', tone: 'brisk' },
      }),
    ).toEqual({
      status: 200,
      body: {
        success: true,
        data: {
          serverId: 'fixture',
          name: 'summarize',
          text: 'Summarize MCP in a brisk tone.',
        },
      },
    });
  });

  test.each([
    [{ arguments: {} }, 400, 'needs topic'],
    [{ arguments: { topic: '   ' } }, 400, 'needs topic'],
    [{ arguments: { topic: 'MCP', mood: 'x' } }, 400, 'no argument named mood'],
    [{ name: 'missing', arguments: {} }, 404, 'does not offer a prompt'],
  ])('refuses %j and sends nothing', async (override, status, reason) => {
    const result = await run({
      serverId: 'fixture',
      name: 'summarize',
      ...override,
    });
    expect(result.status).toBe(status);
    expect(result.body.error).toContain(reason);
  });

  test('a prompt outside the tool view is not offered', async () => {
    const result = await run(
      { serverId: 'fixture', name: 'summarize', arguments: { topic: 'x' } },
      ['fixture_ask_details'],
    );
    expect(result.status).toBe(404);
  });
});
