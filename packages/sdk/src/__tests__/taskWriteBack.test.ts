import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fetchTaskWriteBack } from '../query-domains/taskWriteBack';

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());
test('reads the selected Task and rejects another Task or an unsupported host', async () => {
  const entry = {
    id: 'attempt',
    taskId: 'task one',
    taskCreatedAt: '2026-10-24T00:00:00.000Z',
    ordinal: 1,
    target: {
      kind: 'chat',
      system: 'discord',
      destination: 'channel',
      action: 'message',
    },
    initiatedBy: { kind: 'person', id: 'owner' },
    attemptedAt: '2026-10-24T00:00:00.000Z',
    retryOf: null,
    state: 'failed',
    failureReason: 'Unavailable',
    settledAt: '2026-10-24T00:00:01.000Z',
  };
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ success: true, data: { entries: [entry] } })),
  );
  expect(
    await fetchTaskWriteBack('https://station.example', 'task one'),
  ).toEqual({ entries: [entry] });
  expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
    'https://station.example/api/tasks/task%20one/write-back',
  );
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ success: true, data: { entries: [entry] } })),
  );
  await expect(
    fetchTaskWriteBack('https://station.example', 'another'),
  ).rejects.toThrow('invalid');
  vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }));
  await expect(
    fetchTaskWriteBack('https://station.example', 'task one'),
  ).rejects.toThrow('not supported');
});
