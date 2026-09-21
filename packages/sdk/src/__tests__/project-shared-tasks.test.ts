import { afterEach, expect, test, vi } from 'vitest';
import {
  readProjectSharedTaskHistory,
  shareProjectTask,
  unshareProjectTask,
} from '../client/project-shared-tasks.js';

afterEach(() => vi.unstubAllGlobals());
const record = {
  actor: { kind: 'human', label: 'Member' },
  sequence: 1,
  body: { kind: 'human-message', text: 'shared' },
  digests: { proposal: 'a'.repeat(64), checkpoint: 'b'.repeat(64) },
  integrity: 'L0',
};
const page = {
  kind: 'available',
  records: [record],
  checkpoint: {
    throughSeq: 1,
    checkpointDigest: 'b'.repeat(64),
    retainedAnchorSeq: 0,
    retainedAnchorDigest: 'c'.repeat(64),
  },
  hasMore: false,
};
test('accepts the closed human-message projection', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ success: true, data: page })),
  );
  await expect(
    readProjectSharedTaskHistory(
      'https://station.example',
      'example',
      'task-1',
    ),
  ).resolves.toEqual(page);
});
test.each([
  { ...record, sessionId: 'private-session' },
  { ...record, provider: 'private-provider' },
  { ...record, workspace: '/private/path' },
  {
    ...record,
    body: { kind: 'live-work-started', sessionId: 'private-session' },
  },
])('rejects private or unknown history fields', async (unsafe) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ success: true, data: { ...page, records: [unsafe] } }),
    ),
  );
  await expect(
    readProjectSharedTaskHistory(
      'https://station.example',
      'example',
      'task-1',
    ),
  ).rejects.toThrow('incompatible');
});

test('publishes and revokes the exact reviewed Project and Task incarnation', async () => {
  const expected = {
    project: {
      stationId: 'station-1',
      localProjectId: 'project-1',
      localProjectSlug: 'example',
      portableProjectId: 'portable-1',
    },
    task: { id: 'task-1', createdAt: '2026-09-20T00:00:00.000Z' },
  };
  const publication = {
    kind: 'shared',
    publication: {
      version: 'station.shared-project-task/v1',
      project: expected.project,
      task: { ...expected.task, title: 'Task', status: 'ready' },
      shareId: '11111111-1111-4111-8111-111111111111',
      sharedAt: '2026-09-20T01:00:00.000Z',
    },
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ success: true, data: publication }))
    .mockResolvedValueOnce(
      Response.json({ success: true, data: { unshared: true } }),
    );
  vi.stubGlobal('fetch', fetch);
  await expect(
    shareProjectTask('https://station.example', 'example', expected),
  ).resolves.toEqual(publication);
  await expect(
    unshareProjectTask(
      'https://station.example',
      'example',
      publication.publication.shareId,
      expected,
    ),
  ).resolves.toEqual({ unshared: true });
  expect(fetch.mock.calls[0]![1]).toMatchObject({
    method: 'PUT',
    body: JSON.stringify(expected),
  });
  expect(fetch.mock.calls[1]![1]).toMatchObject({
    method: 'DELETE',
    body: JSON.stringify({
      shareId: publication.publication.shareId,
      expected,
    }),
  });
});
