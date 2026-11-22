import { type CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import packageJson from '../../package.json' with { type: 'json' };

export const STATION_DOCS_VERSION: string = packageJson.version;

const STATION_DOCS_TOOLS = [
  {
    name: 'list_station_docs_topics',
    title: 'Browse documentation',
    description:
      "List topics in Station's SHIPPED DOCUMENTATION, including the architecture learning tree. Filter parentId to manual, architecture, or a branch id returned by this tool. Returns bundled documentation, never live state: it cannot tell you what exists on this Station.",
    group: 'Documentation',
    readOnly: true,
  },
  {
    name: 'get_station_docs_topic',
    title: 'Read documentation',
    description:
      "Read one topic of Station's SHIPPED DOCUMENTATION by id (use list_station_docs_topics for the ids). Returns bundled documentation, never live state: it describes how Station works in general, not this Station's agents, runs, or settings.",
    group: 'Documentation',
    readOnly: true,
  },
  {
    name: 'search_station_docs',
    title: 'Search documentation',
    description:
      "Ranked search across Station's SHIPPED DOCUMENTATION, best match first. Returns bundled documentation topics, never live state: it searches Station's manual, not this Station's data.",
    group: 'Documentation',
    readOnly: true,
  },
] as const;

export function stationDocsToolCatalog() {
  return [...STATION_DOCS_TOOLS];
}

type StationDocsRequest =
  | { name: 'list_station_docs_topics'; args: { parentId?: string } }
  | { name: 'get_station_docs_topic'; args: { id: string } }
  | { name: 'search_station_docs'; args: { query: string; limit?: number } };

export function createStationDocsToolServer(
  call: (
    request: StationDocsRequest,
    signal: AbortSignal,
  ) => Promise<CallToolResult>,
): McpServer {
  const server = new McpServer(
    {
      name: 'station-docs',
      version: STATION_DOCS_VERSION,
    },
    {
      // The content cannot change while the process lives — it is compiled in
      // — so discovery and listing are safely cacheable.
      cacheHints: {
        'server/discover': { ttlMs: 300_000, cacheScope: 'private' },
        'tools/list': { ttlMs: 300_000, cacheScope: 'private' },
      },
    },
  );

  server.registerTool(
    STATION_DOCS_TOOLS[0].name,
    {
      ...STATION_DOCS_TOOLS[0],
      annotations: { readOnlyHint: true },
      _meta: { 'ai.kontour/tool-group': 'Documentation' },
      inputSchema: z.object({
        parentId: z
          .string()
          .optional()
          .describe(
            'Optional parent topic id, such as architecture or architecture-execution.',
          ),
      }),
    },
    (args, context) =>
      call({ name: STATION_DOCS_TOOLS[0].name, args }, context.mcpReq.signal),
  );

  server.registerTool(
    STATION_DOCS_TOOLS[1].name,
    {
      ...STATION_DOCS_TOOLS[1],
      annotations: { readOnlyHint: true },
      _meta: { 'ai.kontour/tool-group': 'Documentation' },
      inputSchema: z.object({
        id: z.string().describe('Topic id, e.g. "station-overview".'),
      }),
    },
    (args, context) =>
      call({ name: STATION_DOCS_TOOLS[1].name, args }, context.mcpReq.signal),
  );

  server.registerTool(
    STATION_DOCS_TOOLS[2].name,
    {
      ...STATION_DOCS_TOOLS[2],
      annotations: { readOnlyHint: true },
      _meta: { 'ai.kontour/tool-group': 'Documentation' },
      inputSchema: z.object({
        query: z.string().describe('Words to look for, e.g. "cron job".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe('Maximum number of topics to return (default 10).'),
      }),
    },
    (args, context) =>
      call({ name: STATION_DOCS_TOOLS[2].name, args }, context.mcpReq.signal),
  );

  return server;
}
