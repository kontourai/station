import { afterEach, expect, test, vi } from 'vitest';
import {
  attachAnswerSupport,
  getTaskAnswerSupportCards,
  listAnswerSupportBundles,
  listAnswerSupportClaims,
  removeAnswerSupport,
  replaceAnswerSupport,
} from '../client/answer-support.js';

afterEach(() => vi.unstubAllGlobals());

test('answer-support client uses only opaque selectors and exact encoded routes', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: [{ id: 'sb1.a' }] })),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: [
            {
              id: 'ref-1',
              state: 'available',
              support: { state: 'unassessed' },
            },
          ],
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, data: [{ id: 'claim-a' }] }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: { id: 'assoc-1' } })),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, data: { id: 'assoc-1', revision: 2 } }),
      ),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));
  vi.stubGlobal('fetch', fetch);

  await expect(
    listAnswerSupportBundles('http://station.test', 'task/a', 'reference/1'),
  ).resolves.toEqual([{ id: 'sb1.a' }]);
  await expect(
    getTaskAnswerSupportCards('http://station.test', 'task/a'),
  ).resolves.toEqual([
    { id: 'ref-1', state: 'available', support: { state: 'unassessed' } },
  ]);
  await expect(
    listAnswerSupportClaims(
      'http://station.test',
      'task/a',
      'reference/1',
      'sb1.a',
    ),
  ).resolves.toEqual([{ id: 'claim-a' }]);
  await attachAnswerSupport('http://station.test', 'task/a', 'reference/1', {
    bundleId: 'sb1.a',
    claimId: 'claim-a',
  });
  await replaceAnswerSupport('http://station.test', 'task/a', 'reference/1', {
    bundleId: 'sb1.a',
    claimId: 'claim-b',
    expectedRevision: 1,
  });
  await removeAnswerSupport('http://station.test', 'task/a', 'reference/1', {
    expectedRevision: 2,
  });

  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    'http://station.test/api/tasks/task%2Fa/turn-references/reference%2F1/support/bundles',
    'http://station.test/api/tasks/task%2Fa/turn-references',
    'http://station.test/api/tasks/task%2Fa/turn-references/reference%2F1/support/bundles/sb1.a/claims',
    'http://station.test/api/tasks/task%2Fa/turn-references/reference%2F1/support',
    'http://station.test/api/tasks/task%2Fa/turn-references/reference%2F1/support',
    'http://station.test/api/tasks/task%2Fa/turn-references/reference%2F1/support',
  ]);
  expect(fetch.mock.calls[3]?.[1]).toEqual(
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ bundleId: 'sb1.a', claimId: 'claim-a' }),
    }),
  );
  expect(fetch.mock.calls[4]?.[1]).toEqual(
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({
        bundleId: 'sb1.a',
        claimId: 'claim-b',
        expectedRevision: 1,
      }),
    }),
  );
  expect(fetch.mock.calls[5]?.[1]).toEqual(
    expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ expectedRevision: 2 }),
    }),
  );
});

test('answer-support client preserves the server generic protected not-found', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: 'Answer support unavailable',
        }),
        { status: 404 },
      ),
    ),
  );

  await expect(
    listAnswerSupportBundles('http://station.test', 'task', 'reference'),
  ).rejects.toThrow('Answer support unavailable');
});
