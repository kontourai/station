import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { TaskGraphService } from '../task-graph-service.js';

const makeTempDir = trackTempDirs();
const taskId = '11111111-1111-4111-8111-111111111111';
const faults = vi.hoisted(() => ({ failPrimaryRename: false }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (
        faults.failPrimaryRename &&
        String(args[1]).endsWith('task-graph.json')
      )
        throw new Error('injected primary rename failure');
      return fs.renameSync(...args);
    },
  };
});
afterEach(() => {
  faults.failPrimaryRename = false;
  vi.restoreAllMocks();
});
function fixture() {
  const home = makeTempDir('station-task-graph-cache-');
  const path = join(home, 'task-graph.json');
  const graph = {
    tasks: [
      {
        id: taskId,
        projectId: 'project-alpha',
        title: 'Task A',
        description: '',
        priority: 'normal',
        status: 'todo',
        createdBy: 'user',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        workspaceBinding: { availability: 'unavailable' },
      },
    ],
    links: [],
    dispatches: [],
  };
  writeFileSync(path, JSON.stringify(graph));
  return { home, path, graph, service: new TaskGraphService(home) };
}

describe('Task graph read snapshots', () => {
  test('reuses unchanged decoding through real task readers and returns detached records', () => {
    const { service, path } = fixture();
    const source = readFileSync(path, 'utf8');
    const parse = vi.spyOn(JSON, 'parse');
    const first = service.readTask(taskId)!;
    first.title = 'caller edit';
    first.workspaceBinding!.availability = 'available';
    const listed = service.listTasks();
    expect(listed[0]).toMatchObject({
      title: 'Task A',
      workspaceBinding: { availability: 'unavailable' },
    });
    listed[0].title = 'list edit';
    expect(service.readTaskView(taskId)?.title).toBe('Task A');
    expect(parse.mock.calls.filter(([text]) => text === source)).toHaveLength(
      1,
    );
    expect(readFileSync(path, 'utf8')).toBe(source);
  });

  test('keeps valid deep reference metadata readable without retaining caller mutations', async () => {
    const { service, path, graph } = fixture();
    const metadataText = `${'{"n":'.repeat(2500)}0${'}'.repeat(2500)}`;
    expect(Buffer.byteLength(metadataText)).toBe(15_001);
    const unrelatedId = '33333333-3333-4333-8333-333333333333';
    const source = JSON.stringify({
      ...graph,
      tasks: [
        ...graph.tasks,
        { ...graph.tasks[0], id: unrelatedId, title: 'Task B' },
      ],
      links: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          sourceType: 'task',
          sourceId: taskId,
          targetType: 'external',
          targetId: 'issue:1',
          relationType: 'references_external',
          confidence: 1,
          createdAt: '2026-10-01T00:00:00.000Z',
          source: 'user',
          metadata: JSON.parse(metadataText),
        },
      ],
    });
    writeFileSync(path, source);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(service.readTask(unrelatedId)?.title).toBe('Task B');
      expect(service.readTaskView(taskId)?.title).toBe('Task A');
      const read = await service.readTaskGraph(taskId);
      expect(read?.task.title).toBe('Task A');
      expect(read?.links).toHaveLength(1);
      expect(JSON.stringify(read!.links[0].metadata)).toBe(metadataText);
      read!.links[0].metadata!.n = 'caller edit';
      read!.task.title = 'caller edit';
    }
    expect(
      service
        .listTasks()
        .map((task) => task.title)
        .sort(),
    ).toEqual(['Task A', 'Task B']);
    expect(readFileSync(path, 'utf8')).toBe(source);
  });

  test('falls back to a fresh validated read when copying a retained snapshot fails', () => {
    const { service } = fixture();
    expect(service.readTask(taskId)?.title).toBe('Task A');
    vi.spyOn(globalThis, 'structuredClone').mockImplementationOnce(() => {
      throw new RangeError('injected cache-hit clone failure');
    });
    const read = service.readTask(taskId)!;
    expect(read.title).toBe('Task A');
    read.title = 'caller edit';
    expect(service.readTask(taskId)?.title).toBe('Task A');
  });

  test.each(['replace', 'in-place'] as const)(
    'observes a same-size %s writer even when mtime is restored',
    (kind) => {
      const { service, path, graph } = fixture();
      expect(service.readTask(taskId)?.title).toBe('Task A');
      const stat = statSync(path);
      graph.tasks[0].title = 'Task B';
      const changed = JSON.stringify(graph);
      expect(Buffer.byteLength(changed)).toBe(stat.size);
      if (kind === 'replace') {
        writeFileSync(`${path}.external`, changed);
        utimesSync(`${path}.external`, stat.atime, stat.mtime);
        renameSync(`${path}.external`, path);
      } else {
        writeFileSync(path, changed);
        utimesSync(path, stat.atime, stat.mtime);
      }
      expect(service.readTask(taskId)?.title).toBe('Task B');
    },
  );

  test('uses the retained previous value or empty default when primary disappears', () => {
    const { service, path, graph } = fixture();
    expect(service.readTask(taskId)?.title).toBe('Task A');
    graph.tasks[0].title = 'Task B';
    writeFileSync(`${path}.previous`, JSON.stringify(graph));
    rmSync(path);
    expect(service.readTask(taskId)?.title).toBe('Task B');
    rmSync(`${path}.previous`);
    expect(service.listTasks()).toEqual([]);
    writeFileSync(path, JSON.stringify(graph));
    expect(service.readTaskView(taskId)?.title).toBe('Task B');
  });

  test.each(['syntax', 'shape'] as const)(
    'refuses %s corruption after warming the cache without overwriting it',
    async (kind) => {
      const { service, path, graph } = fixture();
      expect(service.readTask(taskId)?.title).toBe('Task A');
      const corrupt =
        kind === 'syntax' ? '{' : JSON.stringify({ ...graph, extra: true });
      writeFileSync(path, corrupt);
      expect(() => service.readTask(taskId)).toThrow(
        kind === 'syntax'
          ? 'JSON store is corrupt'
          : 'Task graph store is unavailable',
      );
      await expect(service.updateTaskStatus(taskId, 'ready')).rejects.toThrow();
      expect(readFileSync(path, 'utf8')).toBe(corrupt);
      writeFileSync(path, JSON.stringify(graph));
      expect(service.readTask(taskId)?.title).toBe('Task A');
    },
  );

  test('refuses corrupt recovery and non-file primaries after a warm read', () => {
    const { service, path } = fixture();
    expect(service.readTask(taskId)?.title).toBe('Task A');
    writeFileSync(`${path}.previous`, '{');
    rmSync(path);
    expect(() => service.readTask(taskId)).toThrow('JSON store is corrupt');
    expect(readFileSync(`${path}.previous`, 'utf8')).toBe('{');
    mkdirSync(path);
    expect(() => service.readTask(taskId)).toThrow('JSON store is corrupt');
  });

  test('publishes own writes and keeps the prior durable value after a failed replacement', async () => {
    const { service, path } = fixture();
    expect(service.readTask(taskId)?.status).toBe('todo');
    await service.updateTaskStatus(taskId, 'ready');
    expect(service.readTask(taskId)?.status).toBe('ready');
    const before = readFileSync(path, 'utf8');
    faults.failPrimaryRename = true;
    await expect(service.updateTaskStatus(taskId, 'canceled')).rejects.toThrow(
      'injected primary rename failure',
    );
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(service.readTask(taskId)?.status).toBe('ready');
  });

  test('does not retain an oversized document', () => {
    const { service, path, graph } = fixture();
    graph.tasks[0].description = 'x'.repeat(2 * 1024 * 1024);
    const source = JSON.stringify(graph);
    writeFileSync(path, source);
    const parse = vi.spyOn(JSON, 'parse');
    expect(service.readTask(taskId)?.title).toBe('Task A');
    expect(service.readTask(taskId)?.title).toBe('Task A');
    expect(parse.mock.calls.filter(([text]) => text === source)).toHaveLength(
      2,
    );
  });
});
