import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import {
  AUTHORED_ARTIFACT_MAX_CHARS,
  authoredArtifactBudgetMessage,
} from '../../../src-shared/authored-artifact-limits.js';

const { buildAgentPayload } = await import('../station-control-agent-tools.js');

describe('station-control agent tools', () => {
  test('maps systemPrompt and mcpServers into the agent route shape', () => {
    expect(
      buildAgentPayload({
        name: 'Smoke Writer',
        slug: 'smoke-writer',
        model: 'llama3.2:latest',
        systemPrompt: 'Reply with exactly: SMOKE_WRITER_OK',
        skills: ['review'],
        mcpServers: ['station-control'],
      }),
    ).toEqual({
      name: 'Smoke Writer',
      slug: 'smoke-writer',
      model: 'llama3.2:latest',
      prompt: 'Reply with exactly: SMOKE_WRITER_OK',
      skills: ['review'],
      tools: { mcpServers: ['station-control'] },
    });
  });

  test('create and update tool schemas declare the system-prompt budget themselves', async () => {
    const { registerAgentTools } = await import(
      '../station-control-agent-tools.js'
    );
    const shapes = new Map<
      string,
      Record<string, { safeParse(value: unknown): unknown }>
    >();
    registerAgentTools({
      tool: (
        name: string,
        _description: string,
        shape: Record<string, { safeParse(value: unknown): unknown }>,
      ) => {
        shapes.set(name, shape);
      },
    } as any);

    for (const name of ['create_agent', 'update_agent']) {
      const result = shapes
        .get(name)
        ?.systemPrompt.safeParse(
          'x'.repeat(AUTHORED_ARTIFACT_MAX_CHARS + 1),
        ) as {
        success: boolean;
        error?: { issues: Array<{ message: string }> };
      };
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe(
        authoredArtifactBudgetMessage('Agent system prompt'),
      );
      const exact = shapes
        .get(name)
        ?.systemPrompt.safeParse('x'.repeat(AUTHORED_ARTIFACT_MAX_CHARS)) as {
        success: boolean;
      };
      expect(exact.success).toBe(true);
    }
  });

  // `get_agent` used to call bare `GET /agents/:slug`, which no route
  // registers, so the tool always failed. It now reads the bare listing that
  // `list_agents` reads and picks the agent out of it.
  test('get_agent returns one agent from GET /agents and refuses an unknown slug', async () => {
    const requested: string[] = [];
    const app = new Hono();
    app.get('/agents', (c) => {
      requested.push(new URL(c.req.url).pathname);
      return c.json({
        success: true,
        data: [{ slug: 'reviewer' }, { slug: 'writer', name: 'Writer' }],
      });
    });
    app.all('*', (c) => {
      requested.push(new URL(c.req.url).pathname);
      return c.text('404 Not Found', 404);
    });
    let resolvePort!: (port: number) => void;
    const listening = new Promise<number>((resolve) => {
      resolvePort = resolve;
    });
    const server = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
      (info) => resolvePort((info as AddressInfo).port),
    );
    const previousBase = process.env.STATION_API_BASE;
    process.env.STATION_API_BASE = `http://127.0.0.1:${await listening}`;
    try {
      const { registerAgentTools } = await import(
        '../station-control-agent-tools.js'
      );
      const handlers = new Map<
        string,
        (args: Record<string, unknown>) => Promise<unknown>
      >();
      registerAgentTools({
        tool: (
          name: string,
          _description: string,
          _shape: unknown,
          handler: (args: Record<string, unknown>) => Promise<unknown>,
        ) => {
          handlers.set(name, handler);
        },
      } as any);
      type ToolResult = { content: Array<{ text: string }>; isError?: true };

      const found = (await handlers.get('get_agent')!({
        slug: 'writer',
      })) as ToolResult;
      expect(found.isError).toBeUndefined();
      expect(JSON.parse(found.content[0]!.text)).toEqual({
        success: true,
        data: { slug: 'writer', name: 'Writer' },
      });

      const missing = (await handlers.get('get_agent')!({
        slug: 'nobody',
      })) as ToolResult;
      expect(missing.isError).toBe(true);
      expect(requested).toEqual(['/agents', '/agents']);
    } finally {
      if (previousBase === undefined) delete process.env.STATION_API_BASE;
      else process.env.STATION_API_BASE = previousBase;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
