import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import packageJson from '../../../package.json' with { type: 'json' };
import { STATION_DOCS_TOPICS } from '../station-docs-content.js';
import {
  createStationDocsMcpServer,
  findStationDocsTopic,
  STATION_DOCS_VERSION,
  searchStationDocs,
} from '../station-docs-mcp-server.js';

/**
 * station#1547. Two things are being proven here, and they are different:
 *
 *  1. the docs server serves the shipped content correctly, and
 *  2. the properties that let it be delivered with no security exemption —
 *     bundled-not-fetched content, no live/user state, versioned with Station.
 *
 * The `env`-emptiness guard (AC3) deliberately lives next to the factory that
 * could break it, in
 * `src-server/runtime/agents/__tests__/runtime-default-agent.test.ts`.
 */

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type RegisteredTool = {
  handler: (...args: any[]) => Promise<ToolResult>;
  description?: string;
};

function registeredTools(): Record<string, RegisteredTool> {
  const server = createStationDocsMcpServer();
  return (
    server as unknown as { _registeredTools: Record<string, RegisteredTool> }
  )._registeredTools;
}

async function callTool(name: string, args: unknown): Promise<any> {
  const tool = registeredTools()[name];
  expect(tool, `tool '${name}' is not registered`).toBeDefined();
  const result = await tool.handler(args, {} as any);
  return JSON.parse(result.content[0].text);
}

const SOURCE_FILES = [
  'station-docs-content.ts',
  'station-docs-mcp-server.ts',
  'station-docs-server.ts',
] as const;

function readSource(file: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${file}`, import.meta.url)),
    'utf8',
  );
}

describe('station-docs content', () => {
  test('every topic is complete and its id is a stable kebab-case key', () => {
    expect(STATION_DOCS_TOPICS.length).toBeGreaterThanOrEqual(8);
    for (const topic of STATION_DOCS_TOPICS) {
      expect(topic.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(topic.title.trim().length).toBeGreaterThan(0);
      expect(topic.summary.trim().length).toBeGreaterThan(0);
      expect(topic.body.trim().length).toBeGreaterThan(80);
      expect(topic.tags.length).toBeGreaterThan(0);
    }
    const ids = STATION_DOCS_TOPICS.map((topic) => topic.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the shipped set covers the surfaces a user actually asks about', () => {
    const ids = new Set(STATION_DOCS_TOPICS.map((topic) => topic.id));
    for (const required of [
      'station-overview',
      'station-docs',
      'projects',
      'agents-and-engines',
      'connections',
      'builtin-assistant',
      'trust-and-receipts',
      'tool-servers',
      'vocabulary',
    ]) {
      expect(ids.has(required), `missing topic '${required}'`).toBe(true);
    }
  });

  test('the station-docs topic states the capability split honestly (AC6)', () => {
    const topic = findStationDocsTopic('station-docs');
    expect(topic).toBeDefined();
    const body = topic?.body ?? '';
    // An engine may be given these docs and still be unable to operate
    // Station. If this topic ever stops saying so, an engine reading it will
    // answer about Station as if it could act on it.
    expect(body).toContain('station-control');
    expect(body.toLowerCase()).toContain('cannot');
    expect(body.toLowerCase()).toMatch(/explain/);
  });

  test('no topic claims to describe the reader’s own Station', () => {
    // A content-level check on the same boundary the tool descriptions state:
    // shipped prose must never present itself as live state.
    for (const topic of STATION_DOCS_TOPICS) {
      expect(topic.body.toLowerCase()).not.toMatch(
        /your (agents|runs|jobs|sessions) (are|is) currently/,
      );
    }
  });
});

describe('station-docs lookup and search', () => {
  test('findStationDocsTopic resolves a known id and is honest about an unknown one', () => {
    expect(findStationDocsTopic('projects')?.id).toBe('projects');
    expect(findStationDocsTopic('  PROJECTS  ')?.id).toBe('projects');
    expect(findStationDocsTopic('what-is-running-right-now')).toBeUndefined();
  });

  test('search matches tags and body text, and bounds its result count', () => {
    const gateHits = searchStationDocs('evidence');
    expect(gateHits.length).toBeGreaterThan(0);
    expect(gateHits.map((hit) => hit.id)).toContain('trust-and-receipts');

    const tagHit = searchStationDocs('cron');
    expect(tagHit.map((hit) => hit.id)).toContain('scheduled-jobs');

    expect(searchStationDocs('station', 2).length).toBeLessThanOrEqual(2);
    expect(searchStationDocs('   ')).toEqual([]);
    expect(searchStationDocs('a-string-that-appears-in-no-topic')).toEqual([]);
  });
});

describe('station-docs MCP server', () => {
  test('registers exactly the three read-only documentation tools', () => {
    expect(Object.keys(registeredTools()).sort()).toEqual([
      'get_station_docs_topic',
      'list_station_docs_topics',
      'search_station_docs',
    ]);
  });

  test('every tool description says it returns shipped documentation, not live state', () => {
    for (const [name, tool] of Object.entries(registeredTools())) {
      const description = tool.description ?? '';
      expect(
        description,
        `tool '${name}' must say it returns SHIPPED DOCUMENTATION`,
      ).toContain('SHIPPED DOCUMENTATION');
      expect(
        description.toLowerCase(),
        `tool '${name}' must say it is never live state`,
      ).toContain('never live state');
    }
  });

  test('list returns every topic as a summary, with the shipped-source envelope', () => {
    // Bodies are intentionally absent from the list result: listing is for
    // choosing a topic, not for dumping the whole manual into a context.
    return callTool('list_station_docs_topics', {}).then((payload) => {
      expect(payload.kind).toBe('shipped-documentation');
      expect(payload.stationVersion).toBe(packageJson.version);
      expect(payload.note.toLowerCase()).toContain('not live state');
      expect(payload.topics).toHaveLength(STATION_DOCS_TOPICS.length);
      expect(payload.topics[0].body).toBeUndefined();
    });
  });

  test('get returns the full topic, and names the real ids when asked for a bad one', async () => {
    const found = await callTool('get_station_docs_topic', {
      id: 'station-overview',
    });
    expect(found.topic.id).toBe('station-overview');
    expect(found.topic.body.length).toBeGreaterThan(0);

    const missing = await callTool('get_station_docs_topic', {
      id: 'my-current-agents',
    });
    expect(missing.topic).toBeUndefined();
    expect(missing.error).toContain('my-current-agents');
    expect(missing.availableTopicIds).toContain('station-overview');
  });

  test('search returns hits with the query echoed back', async () => {
    const payload = await callTool('search_station_docs', {
      query: 'engine',
    });
    expect(payload.query).toBe('engine');
    expect(payload.results.length).toBeGreaterThan(0);
    expect(payload.kind).toBe('shipped-documentation');
  });
});

describe('station-docs structural properties (AC2)', () => {
  test('the docs are versioned with Station itself', () => {
    expect(STATION_DOCS_VERSION).toBe(packageJson.version);
    // The exported constant is the contract; `_serverInfo` is what an MCP
    // client actually reads on initialize, so assert the version a client
    // sees — not only the constant this module happens to export.
    const server = createStationDocsMcpServer() as unknown as {
      server: { _serverInfo: { name: string; version: string } };
    };
    expect(server.server._serverInfo).toEqual({
      name: 'station-docs',
      version: packageJson.version,
    });
  });

  test('GUARD: the docs modules cannot fetch, read the disk, or spawn anything at runtime', () => {
    // "Content is bundled and versioned with Station — never fetched at
    // runtime" has to be structural, not a convention. If this fails, the
    // docs server has gained a way to reach outside its own bundle, and the
    // credential-free / no-live-state claim it makes to every engine is no
    // longer true by construction.
    const forbidden = [
      'node:fs',
      'node:http',
      'node:https',
      'node:net',
      'node:dgram',
      'node:child_process',
      'fetch(',
      'XMLHttpRequest',
      'readFileSync',
      'readFile(',
      'execFile',
      'spawn(',
    ];
    for (const file of SOURCE_FILES) {
      const source = readSource(file);
      for (const token of forbidden) {
        expect(
          source.includes(token),
          `${file} must not reference '${token}' — station-docs serves only content compiled into its own bundle.`,
        ).toBe(false);
      }
    }
  });

  test('GUARD: the docs modules import nothing that could reach Station’s API', () => {
    // The tightest form of the property above: an allowlist, so importing
    // `station-control-shared.js` (which owns the API client and the internal
    // token) fails here rather than being caught by a token scan someone can
    // route around.
    const allowed = new Set([
      '@modelcontextprotocol/server',
      '@modelcontextprotocol/server/stdio',
      'zod',
      '../../package.json',
      './station-docs-content.js',
      './station-docs-mcp-server.js',
    ]);
    for (const file of SOURCE_FILES) {
      const source = readSource(file);
      const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map(
        (match) => match[1],
      );
      for (const specifier of specifiers) {
        expect(
          allowed.has(specifier),
          `${file} imports '${specifier}', which is not on the station-docs allowlist. The docs server must stay unable to reach Station's API, filesystem, or network.`,
        ).toBe(true);
      }
    }
  });
});
