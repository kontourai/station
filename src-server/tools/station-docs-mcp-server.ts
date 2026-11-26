/// <reference path="../corpus-search.d.ts" />
import { searchBundles } from '@kontourai/corpus/search';
import type { McpServer } from '@modelcontextprotocol/server';

import {
  STATION_DOCS_BUNDLE,
  type StationDocsBundleTopic,
} from './station-docs-content.js';
import {
  createStationDocsToolServer,
  STATION_DOCS_VERSION,
} from './station-docs-tools.js';

/**
 * station-docs — Station's credential-free documentation MCP server
 * (archive#1547).
 *
 * Deliberately NOT built on `StationControlToolRegistry`: importing that
 * module would pull `station-control-shared.ts` and the SDK HTTP client into
 * this bundle. Documentation handlers use only bundled data; importing the
 * control registry would couple them to operational capabilities.
 * The registration surface here is small enough that duplicating four lines
 * is cheaper than the coupling.
 *
 * Every tool below answers from `STATION_DOCS_BUNDLE`, a static Corpus docs
 * bundle compiled into this server's bundle (#4831). Search ranks it with
 * `@kontourai/corpus/search`, the Corpus entry that is guaranteed free of file,
 * network, process, and timer access. Never import the root
 * `@kontourai/corpus` entry here: it reads files when it loads. There is no
 * tool that reads this Station's live or user state, and there must never be
 * one: that requires authentication and belongs to `station-control`, a
 * different server with a different review. `createRuntimeDocsIntegration()`
 * (`src-server/runtime/agents/runtime-default-agent.ts`) therefore declares
 * NO `env`, removing credential custody as a delivery prerequisite. An engine
 * still needs a supported tool-server channel and the genuine runtime server;
 * credential-free documentation does not create a transport for engines such
 * as Muse, whose tool-server capability is unsupported.
 */

/**
 * A topic without its `body` — the shape list/search results return. These
 * are the field names the tools returned before the bundle existed, kept so
 * agents written against them keep working. Only the two root topics
 * (`manual`, `architecture`) have no `parentId`.
 */
interface StationDocsTopicSummary {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  parentId?: string;
  sourcePath: string;
  sourceAnchor: string;
}

/** A whole topic, as get_station_docs_topic returns it. */
export interface StationDocsTopic extends StationDocsTopicSummary {
  body: string;
}

function toSummary(topic: StationDocsBundleTopic): StationDocsTopicSummary {
  const anchorAt = topic.source.indexOf('#');
  return {
    id: topic.id,
    title: topic.title,
    summary: topic.summary,
    tags: [...topic.tags],
    ...(topic.parentId !== undefined ? { parentId: topic.parentId } : {}),
    sourcePath:
      anchorAt === -1 ? topic.source : topic.source.slice(0, anchorAt),
    sourceAnchor: anchorAt === -1 ? '' : topic.source.slice(anchorAt + 1),
  };
}

const TOPICS_BY_ID: ReadonlyMap<string, StationDocsBundleTopic> = new Map(
  STATION_DOCS_BUNDLE.topics.map((topic) => [topic.id, topic]),
);

export function findStationDocsTopic(id: string): StationDocsTopic | undefined {
  const topic = TOPICS_BY_ID.get(id.trim().toLowerCase());
  return topic ? { ...toSummary(topic), body: topic.markdown } : undefined;
}

export function listStationDocsTopics(
  parentId?: string,
): StationDocsTopicSummary[] {
  return STATION_DOCS_BUNDLE.topics
    .filter((topic) => parentId === undefined || topic.parentId === parentId)
    .map(toSummary);
}

interface StationDocsSearchHit extends StationDocsTopicSummary {
  /** Corpus's snippet: plain text around the first matched query word. */
  excerpt: string;
}

/**
 * Corpus ranked search over the shipped bundle, best match first: BM25 over
 * each topic's title, id, tags, summary, headings, code, and text, with
 * stemming and synonyms (Corpus's suite list and corpus.json's own).
 */
export function searchStationDocs(
  query: string,
  limit = 10,
): StationDocsSearchHit[] {
  const hits: StationDocsSearchHit[] = [];
  for (const result of searchBundles([STATION_DOCS_BUNDLE], query, limit)) {
    // The bundle has topics and no documents, so every result is a topic.
    const topic = result.kind === 'topic' && TOPICS_BY_ID.get(result.id);
    if (topic) hits.push({ ...toSummary(topic), excerpt: result.snippet });
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
let shippedSource: Promise<Readonly<Record<string, string>>> | undefined;

/**
 * `documentationDigest` is SHA-256 over the compiled bundle, the same value
 * `stationDocsDigest()` in scripts/generate-station-docs.mjs reports. It is
 * computed here rather than committed to the generated content file because a
 * committed digest line changed with every docs edit, so every pair of
 * docs-touching branches conflicted on it. Global Web Crypto keeps this module
 * inside the station-docs import allowlist.
 */
function shippedSourceEnvelope(): Promise<Readonly<Record<string, string>>> {
  shippedSource ??= globalThis.crypto.subtle
    .digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(STATION_DOCS_BUNDLE)),
    )
    .then((hash) => ({
      source: 'station-docs',
      kind: 'shipped-documentation',
      stationVersion: STATION_DOCS_VERSION,
      documentationDigest: Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join(''),
      note: "Static documentation bundled with Station. This is not live state: it does not describe this Station's agents, runs, jobs, projects, or settings.",
    }));
  return shippedSource;
}

export function createStationDocsMcpServer(): McpServer {
  return createStationDocsToolServer(async (request) => {
    const source = await shippedSourceEnvelope();
    switch (request.name) {
      case 'list_station_docs_topics':
        return jsonToolResult({
          ...source,
          topics: listStationDocsTopics(request.args.parentId),
        });
      case 'get_station_docs_topic': {
        const topic = findStationDocsTopic(request.args.id);
        return jsonToolResult(
          topic
            ? { ...source, topic }
            : {
                ...source,
                error: `Unknown documentation topic '${request.args.id}'.`,
                availableTopicIds: [...TOPICS_BY_ID.keys()],
              },
        );
      }
      case 'search_station_docs':
        return jsonToolResult({
          ...source,
          query: request.args.query,
          results: searchStationDocs(request.args.query, request.args.limit),
        });
    }
  });
}
