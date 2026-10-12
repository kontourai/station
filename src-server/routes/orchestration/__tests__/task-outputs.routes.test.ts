import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { TASK_DECLARED_OUTPUT_KEEP_V1 } from '@kontourai/station-contracts/task-graph';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { SessionOutputsModule } from '../../../services/orchestration/session-outputs-module.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import {
  TaskOutputModule,
  TaskOutputNotFoundError,
} from '../../../services/projects/task-output-module.js';
import { createTaskOutputRoutes } from '../task-outputs.js';

const paths: string[] = [];
const makeTempDir = trackTempDirs();

function app() {
  const home = mkdtempSync(join(tmpdir(), 'station-task-output-route-home-'));
  const workspace = mkdtempSync(
    join(tmpdir(), 'station-task-output-route-workspace-'),
  );
  paths.push(home, workspace);
  writeFileSync(join(workspace, 'report.txt'), 'route snapshot');
  const tasks = {
    readTask: (id: string) =>
      id === 'task-a'
        ? { id, projectId: 'project-a', createdAt: '2026-10-01T00:00:00.000Z' }
        : null,
    readTaskForOpen: async (id: string) =>
      id === 'task-a'
        ? {
            id,
            projectId: 'project-a',
            createdAt: '2026-10-01T00:00:00.000Z',
            workspaceBinding: {
              availability: 'available' as const,
              workingDirectory: workspace,
            },
          }
        : null,
  };
  return {
    workspace,
    routes: createTaskOutputRoutes(
      new TaskOutputModule({ homeDir: home, taskGraphService: tasks }),
    ),
  };
}

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function structuralPng(
  width: number,
  height: number,
  extraChunks: readonly Buffer[] = [],
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    ...extraChunks,
    pngChunk('IDAT'),
    pngChunk('IEND'),
  ]);
}

async function promote(
  routes: ReturnType<typeof createTaskOutputRoutes>,
  input: {
    operationId: string;
    relativePath: string;
    title: string;
    declaredMediaType?: string;
  },
) {
  const response = await routes.request('/task-a/outputs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (
    (await response.json()) as {
      data: { id: string; materialization: { digest: string } };
    }
  ).data;
}

afterEach(() => {
  for (const path of paths.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe('Task Output routes', () => {
  test.each([false, true])(
    'declared-file keep fences Task recreation=%s before durable publication',
    async (recreated) => {
      const home = makeTempDir('station-output-keep-route-');
      const workspace = makeTempDir('station-output-keep-source-');
      const bytes = 'declared route bytes';
      writeFileSync(join(workspace, 'report.txt'), bytes);
      const graph = new TaskGraphService(home, {
        resolveProjectWorkspace: async () => workspace,
      });
      const task = await graph.createTask({
        projectId: 'project-a',
        title: 'Report',
      });
      const outputs = new TaskOutputModule({
        homeDir: home,
        taskGraphService: graph,
      });
      let incarnation = task.createdAt;
      const sessions: SessionOutputsModule = {
        list: async () => {
          throw new Error('Unexpected listing');
        },
        inspect: async () => {
          throw new Error('Unexpected inspection');
        },
        keep: async (input) => {
          await Promise.resolve();
          if (recreated) incarnation = '2099-01-01T00:00:00.000Z';
          try {
            const kept = await input.outputs.createDeclared(input.taskId, {
              operationId: input.operationId,
              title: 'Report',
              sourceWorkspace: workspace,
              relativePath: 'report.txt',
              digest: createHash('sha256').update(bytes).digest('hex'),
              length: Buffer.byteLength(bytes),
              fingerprintContext: 'session-a:event-a',
              isAuthorized: () => input.current() && input.canKeepForTask(),
            });
            return {
              status: 'kept',
              version: TASK_DECLARED_OUTPUT_KEEP_V1,
              kind: 'workspace-file',
              ...kept,
            };
          } catch (error) {
            if (error instanceof TaskOutputNotFoundError)
              return { status: 'not-found' };
            throw error;
          }
        },
      };
      const routes = createTaskOutputRoutes(outputs, {
        taskGraph: {
          readTask: (id) => {
            const value = graph.readTask(id);
            return value
              ? {
                  ...value,
                  createdAt: incarnation,
                  workspaceBinding: { workingDirectory: workspace },
                }
              : null;
          },
          keepDeclaredPullRequest: graph.keepDeclaredPullRequest.bind(graph),
        },
        sessionOutputs: sessions,
        readAuthorityForRequest: () =>
          sessionReadAuthorityFromRequest('owner', undefined, undefined),
        canReadSession: () => true,
        isRequestPrincipalCurrent: () => true,
        resolveProjectWorkspace: () => workspace,
      });
      const response = await routes.request(
        `/${task.id}/declared-outputs/session-a/event-a/keep`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operationId: 'keep-a' }),
        },
      );
      expect(response.status).toBe(recreated ? 404 : 201);
      const records = await outputs.list(task.id);
      expect(records).toHaveLength(recreated ? 0 : 1);
      if (!recreated)
        expect(
          (await outputs.readContent(task.id, records[0].id)).bytes.toString(),
        ).toBe(bytes);
    },
  );

  test('promotes, lists, serves safe headers, and deletes one Task snapshot', async () => {
    const { routes } = app();
    const output = await promote(routes, {
      operationId: 'route-1',
      relativePath: 'report.txt',
      title: 'Route report',
    });
    expect((await routes.request('/task-a/outputs')).status).toBe(200);
    const content = await routes.request(
      `/task-a/outputs/${output.id}/content`,
    );
    expect(content.headers.get('x-content-type-options')).toBe('nosniff');
    expect(content.headers.get('etag')).toBe(
      `"${output.materialization.digest}"`,
    );
    expect(content.headers.get('cache-control')).toBe('private, no-store');
    expect(await content.text()).toBe('route snapshot');
    expect(
      (
        await routes.request(`/task-a/outputs/${output.id}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
    expect((await routes.request(`/task-a/outputs/${output.id}`)).status).toBe(
      404,
    );
  });

  test('collapses missing Task and unsafe source paths to non-leaking not found', async () => {
    const { routes } = app();
    for (const path of ['/missing/outputs', '/task-a/outputs']) {
      const response = await routes.request(
        path,
        path === '/task-a/outputs'
          ? {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                operationId: 'unsafe',
                relativePath: '../secret',
                title: 'secret',
              }),
            }
          : undefined,
      );
      expect(response.status).toBe(404);
      expect(JSON.stringify(await response.json())).not.toMatch(
        /secret|path|digest|count/i,
      );
    }
  });

  test('safe PNG receipt is earned by exact bytes, never declared MIME', async () => {
    const { routes, workspace } = app();
    const safe = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    writeFileSync(join(workspace, 'safe.png'), safe);
    const output = await promote(routes, {
      operationId: 'safe-png',
      relativePath: 'safe.png',
      title: 'Safe PNG',
    });
    const content = await routes.request(
      `/task-a/outputs/${output.id}/content`,
    );
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toContain('image/png');
    expect(content.headers.get('x-station-safe-preview')).toBe('image/png');
    expect(content.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(content.headers.get('etag')).toBe(
      `"${output.materialization.digest}"`,
    );
    expect(content.headers.get('cache-control')).toBe('private, no-store');
    expect(content.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await content.arrayBuffer())).toEqual(safe);

    writeFileSync(
      join(workspace, 'spoof.png'),
      '<svg><script>x</script></svg>',
    );
    const spoof = await promote(routes, {
      operationId: 'spoof-png',
      relativePath: 'spoof.png',
      title: 'Spoof PNG',
      declaredMediaType: 'image/png',
    });
    const spoofContent = await routes.request(
      `/task-a/outputs/${spoof.id}/content`,
    );
    expect(spoofContent.headers.get('x-station-safe-preview')).toBeNull();
    expect(spoofContent.headers.get('content-type')).toContain(
      'application/octet-stream',
    );
    expect(spoofContent.headers.get('content-disposition')).toMatch(
      /^attachment;/,
    );
  });

  test.each([
    [
      'bad CRC',
      (() => {
        const bytes = structuralPng(1, 1);
        bytes[bytes.length - 1] ^= 0xff;
        return bytes;
      })(),
    ],
    [
      'animated PNG',
      structuralPng(16, 16, [pngChunk('acTL', Buffer.alloc(8))]),
    ],
    ['oversized PNG', structuralPng(8_192, 8_192)],
    ['JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
    ['GIF', Buffer.from('GIF89a', 'ascii')],
    ['WebP', Buffer.from('RIFF0000WEBP', 'ascii')],
  ])(
    'keeps %s bytes download-only despite a PNG declaration',
    async (label, bytes) => {
      const { routes, workspace } = app();
      writeFileSync(join(workspace, 'hostile.png'), bytes);
      const output = await promote(routes, {
        operationId: `hostile-${label.replaceAll(' ', '-').toLowerCase()}`,
        relativePath: 'hostile.png',
        title: label,
        declaredMediaType: 'image/png',
      });
      const content = await routes.request(
        `/task-a/outputs/${output.id}/content`,
      );
      expect(content.headers.get('x-station-safe-preview')).toBeNull();
      expect(content.headers.get('content-type')).toContain(
        'application/octet-stream',
      );
      expect(content.headers.get('content-disposition')).toMatch(
        /^attachment;/,
      );
    },
  );

  test('sanitizes hostile output names in content headers', async () => {
    const { routes, workspace } = app();
    const fileName = 'odd name (1).txt';
    writeFileSync(join(workspace, fileName), 'safe text');
    const output = await promote(routes, {
      operationId: 'hostile-name',
      relativePath: fileName,
      title: 'Hostile name',
    });
    const content = await routes.request(
      `/task-a/outputs/${output.id}/content`,
    );
    const disposition = content.headers.get('content-disposition') ?? '';
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toContain('filename="odd_name__1_.txt"');
    expect(disposition).toContain("filename*=UTF-8''odd_name__1_.txt");
  });
});
