import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createStationDocsMcpServer } from '../station-docs-mcp-server.js';

/**
 * #4831: search_station_docs ranks Station's shipped Corpus bundle with
 * Corpus search instead of matching one substring. The question set is a
 * fixture written in a newcomer's words with the topic that answers each
 * question; it is not an unbiased benchmark. The removed substring search
 * ranked 1 of its 25 expected topics in the top 3.
 */

interface Question {
  question: string;
  expect: string;
  knownMiss?: string;
}

const { questions } = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('./fixtures/station-docs-questions.json', import.meta.url),
    ),
    'utf8',
  ),
) as { questions: Question[] };

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

async function callTool(name: string, args: unknown): Promise<any> {
  const tools = (
    createStationDocsMcpServer() as unknown as {
      _registeredTools: Record<
        string,
        { handler: (...a: any[]) => Promise<ToolResult> }
      >;
    }
  )._registeredTools;
  const result = await tools[name].handler(args, {} as any);
  return JSON.parse(result.content[0].text);
}

async function topThree(question: string): Promise<string[]> {
  const payload = await callTool('search_station_docs', {
    query: question,
    limit: 3,
  });
  return payload.results.map((hit: { id: string }) => hit.id);
}

describe('search_station_docs answers newcomer questions', () => {
  const asserted = questions.filter((entry) => !entry.knownMiss);

  test('the fixture keeps enough asserted questions to mean something', () => {
    // Marking questions as known misses must not hollow the set out.
    expect(asserted.length).toBeGreaterThanOrEqual(20);
  });

  test.each(asserted)(
    '"$question" ranks $expect in the top 3',
    async ({ question, expect: wanted }) => {
      expect(await topThree(question)).toContain(wanted);
    },
  );

  test('every expected topic exists, known misses included', async () => {
    const listed = await callTool('list_station_docs_topics', {});
    const ids = new Set(listed.topics.map((topic: { id: string }) => topic.id));
    for (const entry of questions)
      expect(ids.has(entry.expect), entry.expect).toBe(true);
  });

  test('results come best first, with a snippet from the topic', async () => {
    const payload = await callTool('search_station_docs', {
      query: 'set up a cron job',
    });
    expect(payload.query).toBe('set up a cron job');
    const [first] = payload.results;
    expect(first.id).toBe('scheduled-jobs');
    expect(first.sourcePath).toBe('docs/reference/station-docs.md');
    expect(first.sourceAnchor).toBe('scheduled-jobs-and-notifications');
    expect(first.excerpt.toLowerCase()).toContain('cron');
    expect(first.body).toBeUndefined();
  });
});

describe('station-docs works with the network unavailable', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('list, get, and search answer while fetch throws', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network unavailable');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const search = await callTool('search_station_docs', {
      query: 'borrow a GPU from another computer',
    });
    expect(search.results[0].id).toBe('fleet');
    const topic = await callTool('get_station_docs_topic', { id: 'fleet' });
    expect(topic.topic.body).toContain('Fleet inference');
    const listed = await callTool('list_station_docs_topics', {
      parentId: 'manual',
    });
    expect(listed.topics.length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
