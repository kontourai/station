import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import packageJson from '../../package.json' with { type: 'json' };
import {
  STATION_DOCS_TOPICS,
  type StationDocsTopic,
} from './station-docs-content.js';

/**
 * station-docs — Station's credential-free documentation MCP server
 * (archive#1547).
 *
 * Deliberately NOT built on `StationControlToolRegistry`: importing that
 * module would pull `station-control-shared.ts` and the SDK HTTP client into
 * this bundle, and the whole point of this server is that its bundle
 * contains no way to reach the network, the filesystem, or Station's API.
 * The registration surface here is small enough that duplicating four lines
 * is cheaper than the coupling.
 *
 * Every tool below answers from `STATION_DOCS_TOPICS`, a static array
 * compiled into the bundle. There is no tool that reads this Station's live
 * or user state, and there must never be one: that requires authentication
 * and belongs to `station-control`, a different server with a different
 * review. `createStationDocsIntegration()`
 * (`src-server/runtime/agents/runtime-default-agent.ts`) therefore declares
 * NO `env`, which is what lets this server be delivered to every engine
 * including the ones that can never receive `station-control`.
 */

/**
 * Station's own package version, inlined at build time.
 *
 * Deliberately NOT described as a build identifier (archive#1547 review,
 * HIGH). It has read `0.1.0` since the founding commit and this repo does not
 * publish from it, so a claim that a served topic is "attributable to the
 * Station build that shipped it" attributed nothing — the same string is
 * returned by every build that has ever existed. It is reported because MCP's
 * server-info requires a version, and it identifies the package, not the
 * build. Wiring a real build stamp is archive#1635; until then this must not
 * be presented to a model as provenance.
 */
export const STATION_DOCS_VERSION: string = packageJson.version;

/** A topic without its `body` — the shape list/search results return. */
export interface StationDocsTopicSummary {
  id: string;
  title: string;
  summary: string;
  tags: string[];
}

function toSummary(topic: StationDocsTopic): StationDocsTopicSummary {
  return {
    id: topic.id,
    title: topic.title,
    summary: topic.summary,
    tags: [...topic.tags],
  };
}

export function findStationDocsTopic(id: string): StationDocsTopic | undefined {
  const wanted = id.trim().toLowerCase();
  return STATION_DOCS_TOPICS.find((topic) => topic.id === wanted);
}

export interface StationDocsSearchHit extends StationDocsTopicSummary {
  /** The matched line of the topic body, or `null` when only metadata matched. */
  excerpt: string | null;
}

/**
 * Plain case-insensitive substring search over id, title, summary, tags, and
 * body. No index, no scoring model, no stemming — the corpus is fifteen
 * topics, and a boring matcher is one nobody has to reverse-engineer.
 */
export function searchStationDocs(
  query: string,
  limit = 10,
): StationDocsSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: StationDocsSearchHit[] = [];
  for (const topic of STATION_DOCS_TOPICS) {
    const metadataMatch =
      topic.id.toLowerCase().includes(needle) ||
      topic.title.toLowerCase().includes(needle) ||
      topic.summary.toLowerCase().includes(needle) ||
      topic.tags.some((tag) => tag.toLowerCase().includes(needle));
    const excerpt =
      topic.body
        .split('\n')
        .find((line) => line.toLowerCase().includes(needle)) ?? null;
    if (!metadataMatch && !excerpt) continue;
    hits.push({ ...toSummary(topic), excerpt });
    if (hits.length >= limit) break;
  }
  return hits;
}

function jsonToolResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Every tool result carries this envelope so a model reading the output —
 * not just the tool description — is told what it is holding.
 */
const SHIPPED_SOURCE = {
  source: 'station-docs',
  kind: 'shipped-documentation',
  stationVersion: STATION_DOCS_VERSION,
  note: "Static documentation bundled with Station. This is not live state: it does not describe this Station's agents, runs, jobs, projects, or settings.",
} as const;

export function createStationDocsMcpServer(): McpServer {
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
    'list_station_docs_topics',
    {
      description:
        "List the topics in Station's SHIPPED DOCUMENTATION (what Station is, projects, agents, engines, connections, tasks, skills, scheduled jobs, tool servers, trust and receipts, fleet, plugins, vocabulary). Returns bundled documentation, never live state: it cannot tell you what exists on this Station.",
      inputSchema: z.object({}),
    },
    async () =>
      jsonToolResult({
        ...SHIPPED_SOURCE,
        topics: STATION_DOCS_TOPICS.map(toSummary),
      }),
  );

  server.registerTool(
    'get_station_docs_topic',
    {
      description:
        "Read one topic of Station's SHIPPED DOCUMENTATION by id (use list_station_docs_topics for the ids). Returns bundled documentation, never live state: it describes how Station works in general, not this Station's agents, runs, or settings.",
      inputSchema: z.object({
        id: z.string().describe('Topic id, e.g. "station-overview".'),
      }),
    },
    async ({ id }) => {
      const topic = findStationDocsTopic(id);
      if (!topic) {
        return jsonToolResult({
          ...SHIPPED_SOURCE,
          error: `Unknown documentation topic '${id}'.`,
          availableTopicIds: STATION_DOCS_TOPICS.map((entry) => entry.id),
        });
      }
      return jsonToolResult({ ...SHIPPED_SOURCE, topic });
    },
  );

  server.registerTool(
    'search_station_docs',
    {
      description:
        "Keyword search across Station's SHIPPED DOCUMENTATION. Returns matching bundled documentation topics, never live state: it searches Station's manual, not this Station's data.",
      inputSchema: z.object({
        query: z.string().describe('Words to look for, e.g. "gate evidence".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe('Maximum number of topics to return (default 10).'),
      }),
    },
    async ({ query, limit }) =>
      jsonToolResult({
        ...SHIPPED_SOURCE,
        query,
        results: searchStationDocs(query, limit ?? 10),
      }),
  );

  return server;
}
