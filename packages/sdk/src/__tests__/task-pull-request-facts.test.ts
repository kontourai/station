import { afterEach, expect, test, vi } from 'vitest';
import { fetchTaskPullRequestFacts } from '../query-domains/taskGraph.js';

afterEach(() => vi.unstubAllGlobals());

const respond = (status: number, body: unknown) =>
  vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

test('reads the Project board facts at the exact route', async () => {
  const fetch = respond(200, {
    success: true,
    data: { observedAt: '2026-11-16T00:00:00.000Z', tasks: {} },
  });
  vi.stubGlobal('fetch', fetch);
  await expect(
    fetchTaskPullRequestFacts('lanes demo', 'http://station.test'),
  ).resolves.toEqual({ observedAt: '2026-11-16T00:00:00.000Z', tasks: {} });
  expect(String(fetch.mock.calls[0]?.[0])).toBe(
    'http://station.test/api/tasks/pull-request-facts?projectId=lanes+demo',
  );
});

test('a plain 404 (a Station without the route) reads as unsupported', async () => {
  // An older host routes the path to `GET /api/tasks/:taskId`.
  vi.stubGlobal(
    'fetch',
    respond(404, { success: false, error: 'Task not found' }),
  );
  await expect(
    fetchTaskPullRequestFacts('demo', 'http://station.test'),
  ).resolves.toBeNull();
});

test('a 404 for lost standing is an error, never "older Station"', async () => {
  vi.stubGlobal(
    'fetch',
    respond(404, {
      success: false,
      code: 'request_principal_changed',
      error: 'Task not found',
    }),
  );
  await expect(
    fetchTaskPullRequestFacts('demo', 'http://station.test'),
  ).rejects.toThrow('Task not found');
});
