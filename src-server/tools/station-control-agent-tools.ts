import {
  createAgentRaw,
  deleteAgentRaw,
  deleteConversation,
  fetchAgentsBare,
  getConversationMessages,
  listAgentConversations,
  updateAgentRaw,
} from '@kontourai/station-sdk/client';
import { z } from 'zod';

import {
  AUTHORED_ARTIFACT_MAX_CHARS,
  authoredArtifactBudgetMessage,
} from '../../src-shared/authored-artifact-limits.js';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import {
  api,
  controlRequestOptions,
  jsonToolResult,
  resolveControlApiBase,
  toToolEnvelope as toAgentEnvelope,
} from './station-control-shared.js';

/**
 * #167 Wave 2B: agent CRUD + conversation fetches now run through
 * `@kontourai/station-sdk/client`'s canonical fetchers instead of this
 * file's own inline `api()` calls (`station-control-shared.ts`). `apiBase`
 * is resolved once at module load — mirroring `station-control-shared.ts`'s
 * own `const API = resolveControlApiBase();` — because station-control runs
 * as a long-lived MCP server process where `STATION_API_BASE`/`STATION_PORT`
 * are expected to be stable for the process lifetime, not re-read per call
 * (#167 plan Risk 3).
 */
// station#1195: resolved fresh on every call (see station-control-shared.ts's
// `api()` doc comment) -- a module-load-time freeze here would be wrong once
// these same tool registrations are reachable from Station's own long-lived
// process (station-control-mcp-route.ts), not only a freshly-spawned stdio
// child whose env was already correct before the module ever loaded.
function controlApiBase(): string {
  return resolveControlApiBase();
}

export function buildAgentPayload(params: {
  name?: string;
  slug?: string;
  model?: string;
  systemPrompt?: string;
  skills?: string[];
  mcpServers?: string[];
}) {
  return {
    ...(typeof params.name === 'string' ? { name: params.name } : {}),
    ...(typeof params.slug === 'string' ? { slug: params.slug } : {}),
    ...(typeof params.model === 'string' ? { model: params.model } : {}),
    ...(typeof params.systemPrompt === 'string'
      ? { prompt: params.systemPrompt }
      : {}),
    ...(params.skills ? { skills: params.skills } : {}),
    ...(params.mcpServers ? { tools: { mcpServers: params.mcpServers } } : {}),
  };
}

export function registerAgentTools(server: StationControlToolRegistry) {
  server.tool('list_agents', 'List all configured agents', {}, async () =>
    jsonToolResult(
      await fetchAgentsBare(controlApiBase(), controlRequestOptions()),
    ),
  );

  server.tool(
    'get_agent',
    'Get agent details by slug',
    { slug: z.string() },
    // No canonical `@kontourai/station-sdk/client` fetcher exists for this
    // route: it targets bare `GET /agents/:slug`, distinct from
    // `client/agents.ts`'s `getAgent` (enriched `GET /api/agents/:slug`,
    // used only by the CLI's `agents get` verb). The #167 plan flagged this
    // as a Wave 2B gap ("the plan's Task text for the 'agents +
    // conversations' group does not name a canonical fetcher for
    // station-control's `get_agent` tool"); re-verified against
    // `src-server/routes/agents/agents.ts` (only `GET /` is registered on the bare
    // `/agents` mount — there is no `GET /:slug` handler at all), so this
    // tool already 404s pre-#167. Left on the `api()` passthrough rather
    // than silently rerouting it to a different endpoint, which would be an
    // out-of-scope server-route/behavior decision (AC4).
    async ({ slug }) => jsonToolResult(await api(`/agents/${slug}`)),
  );

  server.tool(
    'create_agent',
    'Create a new agent',
    {
      name: z.string().describe('Display name'),
      slug: z.string().describe('URL-safe identifier'),
      model: z.string().optional().describe('Model ID'),
      systemPrompt: z
        .string()
        .max(AUTHORED_ARTIFACT_MAX_CHARS, {
          message: authoredArtifactBudgetMessage('Agent system prompt'),
        })
        .optional()
        .describe('Agent system prompt'),
      skills: z.array(z.string()).optional(),
      mcpServers: z
        .array(z.string())
        .optional()
        .describe('Integration IDs to attach'),
    },
    async (params) =>
      jsonToolResult(
        await toAgentEnvelope(
          createAgentRaw(
            controlApiBase(),
            buildAgentPayload(params),
            controlRequestOptions(),
          ),
        ),
      ),
  );

  server.tool(
    'update_agent',
    'Update an existing agent',
    {
      slug: z.string(),
      name: z.string().optional(),
      model: z.string().optional(),
      systemPrompt: z
        .string()
        .max(AUTHORED_ARTIFACT_MAX_CHARS, {
          message: authoredArtifactBudgetMessage('Agent system prompt'),
        })
        .optional()
        .describe('Agent system prompt'),
      skills: z.array(z.string()).optional(),
      mcpServers: z.array(z.string()).optional(),
    },
    async ({ slug, ...updates }) =>
      jsonToolResult(
        await toAgentEnvelope(
          updateAgentRaw(
            controlApiBase(),
            slug,
            buildAgentPayload(updates),
            controlRequestOptions(),
          ),
        ),
      ),
  );

  server.tool(
    'delete_agent',
    'Delete an agent',
    { slug: z.string() },
    async ({ slug }) =>
      jsonToolResult(
        await toAgentEnvelope(
          deleteAgentRaw(controlApiBase(), slug, controlRequestOptions()),
        ),
      ),
  );

  server.tool(
    'list_conversations',
    'List conversations for an agent',
    { agent: z.string().describe('Agent slug') },
    async ({ agent }) =>
      jsonToolResult(
        await toAgentEnvelope(
          listAgentConversations(
            controlApiBase(),
            agent,
            controlRequestOptions(),
          ),
        ),
      ),
  );

  server.tool(
    'get_conversation_messages',
    'Get messages for a conversation',
    {
      agent: z.string().describe('Agent slug'),
      conversationId: z.string(),
    },
    async ({ agent, conversationId }) =>
      jsonToolResult(
        await toAgentEnvelope(
          getConversationMessages(
            controlApiBase(),
            agent,
            conversationId,
            controlRequestOptions(),
          ),
        ),
      ),
  );

  server.tool(
    'delete_conversation',
    'Delete a conversation',
    {
      agent: z.string().describe('Agent slug'),
      conversationId: z.string(),
    },
    async ({ agent, conversationId }) =>
      jsonToolResult(
        await toAgentEnvelope(
          deleteConversation(
            controlApiBase(),
            agent,
            conversationId,
            controlRequestOptions(),
          ),
        ),
      ),
  );
}
