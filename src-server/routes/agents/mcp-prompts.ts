/**
 * #3284: an agent's MCP server prompts, as slash commands.
 *
 * GET  /agents/:slug/mcp-prompts      — the prompts this agent is offered
 * POST /agents/:slug/mcp-prompts/run  — read one with arguments; returns the
 *                                       text the composer sends as the turn
 */

import type { AgentSpec } from '@kontourai/station-contracts/agent';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import {
  listAgentMcpPrompts,
  McpPromptRefusal,
  type McpPromptSource,
  runAgentMcpPrompt,
} from '../../services/plugins/mcp-prompts.js';
import { errorMessage, getBody, param, validate } from '../schemas/schemas.js';

const runSchema = z
  .object({
    serverId: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    arguments: z.record(z.string().max(256), z.string()).optional(),
  })
  .strict();

export function createAgentMcpPromptRoutes(deps: {
  /** The active agent's spec, or undefined when it is not active here. */
  resolveAgentSpec: (slug: string) => AgentSpec | undefined;
  prompts: McpPromptSource;
  logger?: { warn?(message: string, context?: unknown): void };
}) {
  const app = new Hono();

  const spec = (slug: string) => {
    const resolved = deps.resolveAgentSpec(slug);
    if (!resolved)
      throw new McpPromptRefusal(`Agent '${slug}' is not active.`, 404);
    return resolved;
  };

  const refuse = (error: unknown) => {
    if (error instanceof McpPromptRefusal)
      return {
        body: { success: false, error: error.message },
        status: error.status,
      };
    deps.logger?.warn?.('MCP prompt request failed', { error });
    return {
      body: { success: false, error: errorMessage(error) },
      status: 502 as const,
    };
  };

  app.get('/:slug/mcp-prompts', async (c) => {
    try {
      const data = await listAgentMcpPrompts(
        spec(param(c, 'slug')),
        deps.prompts,
      );
      return c.json({ success: true, data });
    } catch (error) {
      const { body, status } = refuse(error);
      return c.json(body, status);
    }
  });

  app.post('/:slug/mcp-prompts/run', validate(runSchema), async (c) => {
    try {
      const body = getBody(c) as z.infer<typeof runSchema>;
      const data = await runAgentMcpPrompt(
        spec(param(c, 'slug')),
        deps.prompts,
        {
          serverId: body.serverId,
          name: body.name,
          arguments: body.arguments ?? {},
        },
      );
      return c.json({ success: true, data });
    } catch (error) {
      const { body, status } = refuse(error);
      return c.json(body, status);
    }
  });

  return app;
}
