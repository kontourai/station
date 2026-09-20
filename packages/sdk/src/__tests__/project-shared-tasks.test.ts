import { afterEach, expect, test, vi } from 'vitest';
import { readProjectSharedTaskHistory } from '../client/project-shared-tasks.js';

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
