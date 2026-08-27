import { afterEach, expect, test, vi } from 'vitest';
import {
  createTaskOutputClient,
  deleteTaskOutputClient,
  downloadTaskOutputContent,
  getTaskOutput,
  keepDeclaredTaskOutput,
  listTaskOutputs,
} from '../client/task-outputs.js';

afterEach(() => vi.unstubAllGlobals());

test('Task output client uses exact encoded paths, JSON bodies, and content headers', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: [] })),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: { id: 'out' } })),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: { id: 'out' } })),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: { deleted: true } })),
    )
    .mockResolvedValueOnce(
      new Response(Buffer.from('bytes'), {
        headers: {
          'content-type': 'text/plain',
          'content-disposition': 'attachment; filename="result.txt"',
          etag: 'sha256:abc',
          'x-station-safe-preview': 'image/png',
        },
      }),
    );
  vi.stubGlobal('fetch', fetch);
  await listTaskOutputs('http://station.test', 'task/a');
  await getTaskOutput('http://station.test', 'task/a', 'out/1');
  await createTaskOutputClient('http://station.test', 'task/a', {
    operationId: 'op',
    relativePath: 'x.txt',
    title: 'X',
  });
  await deleteTaskOutputClient('http://station.test', 'task/a', 'out/1');
  await expect(
    downloadTaskOutputContent('http://station.test', 'task/a', 'out/1'),
  ).resolves.toMatchObject({
    bytes: new Uint8Array(Buffer.from('bytes')),
    mediaType: 'text/plain',
    fileName: 'result.txt',
    etag: 'sha256:abc',
    safePreview: 'image/png',
  });
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    'http://station.test/api/tasks/task%2Fa/outputs',
    'http://station.test/api/tasks/task%2Fa/outputs/out%2F1',
    'http://station.test/api/tasks/task%2Fa/outputs',
    'http://station.test/api/tasks/task%2Fa/outputs/out%2F1',
    'http://station.test/api/tasks/task%2Fa/outputs/out%2F1/content',
  ]);
  expect(fetch.mock.calls[2]?.[1]).toEqual(
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        operationId: 'op',
        relativePath: 'x.txt',
        title: 'X',
      }),
    }),
  );
});

test('Task output client rejects non-success content responses', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('no', { status: 503 })),
  );
  await expect(
    downloadTaskOutputContent('http://station.test', 'task', 'out'),
  ).rejects.toThrow('HTTP 503');
});

test('declared Output Keep posts only the opaque operation to its exact tuple', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        success: true,
        data: {
          version: 'task-declared-output-keep/v1',
          status: 'kept',
          kind: 'workspace-file',
          outcome: 'kept',
          output: {
            schemaVersion: 1,
            id: 'out',
            taskId: 'task/a',
            projectId: 'project-a',
            title: 'Output',
            source: { kind: 'workspace-file', relativePath: 'report.txt' },
            materialization: {
              kind: 'snapshot',
              fileName: 'report.txt',
              mediaType: 'text/plain',
              byteLength: 1,
              digest: `sha256:${'a'.repeat(64)}`,
              contentAvailable: true,
            },
            createdAt: '2026-08-26T00:00:00.000Z',
          },
        },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  await keepDeclaredTaskOutput(
    'http://station.test',
    'task/a',
    'session/a',
    'event/a',
    { operationId: 'op-a' },
  );
  expect(fetch).toHaveBeenCalledWith(
    'http://station.test/api/tasks/task%2Fa/declared-outputs/session%2Fa/event%2Fa/keep',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ operationId: 'op-a' }),
    }),
  );
});

test('declared Output Keep rejects mixed or body-bearing transport variants', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            version: 'task-declared-output-keep/v1',
            status: 'kept',
            kind: 'pull-request',
            outcome: 'kept',
            output: {},
            reference: { body: 'must never cross the keep transport' },
          },
        }),
      ),
    ),
  );
  await expect(
    keepDeclaredTaskOutput('http://station.test', 'task', 'session', 'event', {
      operationId: 'op',
    }),
  ).rejects.toThrow();
});
