import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { UNIFIED_SEARCH_V1 } from '@kontourai/station-contracts/unified-search';
import { describe, expect, test, vi } from 'vitest';
import {
  createPersonalTaskSearchProvider,
  createStationMessageSearchProvider,
} from '../station-search-providers.js';
import { UnifiedSearchService } from '../unified-search-service.js';

const now = () => '2026-09-03T00:00:00.000Z';

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    projectId: 'alpha',
    title: 'Repair parser receipts',
    description: 'Keep exact failure evidence.',
    priority: 'normal',
    status: 'in_progress',
    createdBy: 'user-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('Station unified-search providers', () => {
  test('normalizes multiline display text and keeps valid sibling results', async () => {
    const service = new UnifiedSearchService([
      createPersonalTaskSearchProvider({
        stationId: 's',
        source: {
          listAuthorizedTasks: () => [
            task({ description: ' First line\r\nSecond\tline ' }),
            task({ id: 't2', description: '\n\t' }),
          ],
        },
      }),
      createStationMessageSearchProvider({
        authority: { mode: 'personal', stationId: 's' },
        source: {
          searchAuthorizedMessages: () => [
            {
              conversationId: 's1',
              messageId: 'm1',
              role: 'user',
              excerpt: ' parser\nmessage\ttext ',
            },
          ],
        },
      }),
    ]);
    const result = await service.search({
      version: UNIFIED_SEARCH_V1,
      query: 'parser',
    });
    expect(result.state).toBe('complete');
    if (result.state === 'invalid') throw new Error('invalid result');
    expect(result.results).toHaveLength(3);
    expect(
      result.results.find((result) => result.id === 'task-1')?.snippet,
    ).toBe('First line Second line');
    expect(
      result.results.find((result) => result.id === 't2')?.snippet,
    ).toBeUndefined();
    expect(
      result.results.find((result) => result.kind === 'message')?.snippet,
    ).toBe('parser message text');
  });
  test('maps only authority-filtered message matches into typed open intents', async () => {
    const searchAuthorizedMessages = vi.fn(() => [
      {
        conversationId: 'session-1',
        messageId: 'message-1',
        role: 'assistant' as const,
        excerpt: 'The parser receipt is ready.',
        projectSlug: 'alpha',
        agentSlug: 'station',
      },
    ]);
    const service = new UnifiedSearchService([
      createStationMessageSearchProvider({
        authority: { mode: 'personal', stationId: 'station-home-a' },
        source: { searchAuthorizedMessages },
        now,
      }),
    ]);

    const result = await service.search({
      version: UNIFIED_SEARCH_V1,
      query: 'parser',
    });

    expect(searchAuthorizedMessages).toHaveBeenCalledWith({
      query: 'parser',
      limit: 9,
    });
    if (result.state === 'invalid')
      throw new Error('unexpected invalid result');
    expect(result.results).toEqual([
      expect.objectContaining({
        id: JSON.stringify(['session-1', 'message-1']),
        kind: 'message',
        owner: { kind: 'station', stationId: 'station-home-a' },
        scope: { projectId: 'alpha', sessionId: 'session-1' },
        openIntent: {
          kind: 'session-message',
          sessionId: 'session-1',
          messageId: 'message-1',
        },
      }),
    ]);
  });

  test('binds hosted message ownership and source scope to exact tenant authority', async () => {
    const searchAuthorizedMessages = vi.fn(() =>
      Array.from({ length: 9 }, (_, index) => ({
        conversationId: 'session-1',
        messageId: `message-${index}`,
        role: 'assistant' as const,
        excerpt: `Parser result ${index}`,
        projectSlug: 'alpha',
      })),
    );
    const service = new UnifiedSearchService([
      createStationMessageSearchProvider({
        authority: {
          mode: 'hosted',
          stationId: 'station-home-a',
          tenantId: 'tenant-a',
        },
        source: { searchAuthorizedMessages },
        now,
      }),
    ]);

    const result = await service.search({
      version: UNIFIED_SEARCH_V1,
      query: 'parser',
      filters: { projectId: 'alpha' },
    });

    expect(searchAuthorizedMessages).toHaveBeenCalledWith({
      query: 'parser',
      limit: 9,
      projectId: 'alpha',
    });
    if (result.state === 'invalid')
      throw new Error('unexpected invalid result');
    expect(result.state).toBe('partial');
    expect(result.results).toHaveLength(8);
    expect(result.results[0]?.owner).toEqual({
      kind: 'station',
      stationId: 'station-home-a',
      tenantId: 'tenant-a',
    });
    expect(result.sources[0]).toMatchObject({
      state: 'partial',
      reason: 'result-window',
    });
  });

  test('refuses hosted message composition without tenant authority', () => {
    expect(() =>
      createStationMessageSearchProvider({
        authority: { mode: 'hosted', stationId: 'station-home-a' } as never,
        source: { searchAuthorizedMessages: () => [] },
      }),
    ).toThrow('Hosted message search requires tenant authority');
  });

  test('fails closed when a Project-scoped message source returns another Project', async () => {
    const provider = createStationMessageSearchProvider({
      authority: { mode: 'personal', stationId: 'station-home-a' },
      source: {
        searchAuthorizedMessages: () => [
          {
            conversationId: 'session-1',
            messageId: 'message-1',
            role: 'user',
            excerpt: 'Parser result from the wrong Project',
            projectSlug: 'beta',
          },
        ],
      },
      now,
    });

    await expect(
      provider.search(
        {
          version: UNIFIED_SEARCH_V1,
          query: 'parser',
          limit: 8,
          filters: { projectId: 'alpha' },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      version: UNIFIED_SEARCH_V1,
      state: 'unavailable',
      reason: 'source-unavailable',
    });
  });

  test('searches the personal Task authority with exact Project and Task filters', async () => {
    const listAuthorizedTasks = vi.fn(() => [
      task(),
      task({ id: 'task-2', projectId: 'beta', title: 'Parser elsewhere' }),
    ]);
    const service = new UnifiedSearchService([
      createPersonalTaskSearchProvider({
        stationId: 'station-home-a',
        source: { listAuthorizedTasks },
        now,
      }),
    ]);

    const result = await service.search({
      version: UNIFIED_SEARCH_V1,
      query: 'parser',
      filters: { kinds: ['task'], projectId: 'alpha', taskId: 'task-1' },
    });

    if (result.state === 'invalid')
      throw new Error('unexpected invalid result');
    expect(result.results).toEqual([
      expect.objectContaining({
        id: 'task-1',
        matchedFields: ['title'],
        openIntent: { kind: 'task', projectId: 'alpha', taskId: 'task-1' },
      }),
    ]);
  });

  test('reports a bounded partial Task window instead of implying completeness', async () => {
    const tasks = Array.from({ length: 12 }, (_, index) =>
      task({ id: `task-${index}`, title: `Parser task ${index}` }),
    );
    const provider = createPersonalTaskSearchProvider({
      stationId: 'station-home-a',
      source: { listAuthorizedTasks: () => tasks },
      now,
    });

    const page = await provider.search(
      { version: UNIFIED_SEARCH_V1, query: 'parser', limit: 8 },
      new AbortController().signal,
    );

    expect(page).toMatchObject({
      state: 'partial',
      reason: 'result-window',
    });
    if (!('results' in page)) throw new Error('expected results');
    expect(page.results).toHaveLength(8);
  });

  test('does not call a source excluded by an explicit kind filter', async () => {
    const listAuthorizedTasks = vi.fn(() => [task()]);
    const service = new UnifiedSearchService([
      createPersonalTaskSearchProvider({
        stationId: 'station-home-a',
        source: { listAuthorizedTasks },
        now,
      }),
    ]);

    const result = await service.search({
      version: UNIFIED_SEARCH_V1,
      query: 'parser',
      filters: { kinds: ['message'] },
    });

    expect(result).toEqual({
      version: UNIFIED_SEARCH_V1,
      state: 'complete',
      results: [],
      sources: [],
    });
    expect(listAuthorizedTasks).not.toHaveBeenCalled();
  });
});
