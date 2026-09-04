import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import {
  UNIFIED_SEARCH_V1,
  type UnifiedSearchProviderRequest,
} from '@kontourai/station-contracts/unified-search';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TaskGraphService } from '../../projects/task-graph-service.js';
import {
  createIsolatedTaskSearch,
  type IsolatedTaskSearch,
} from '../isolated-task-search.js';
import { TASK_SEARCH_LIMITS } from '../task-search-protocol.js';
import { UnifiedSearchService } from '../unified-search-service.js';

const request: UnifiedSearchProviderRequest = {
  version: UNIFIED_SEARCH_V1,
  query: 'parser',
  limit: 8,
};
const unavailable = {
  version: UNIFIED_SEARCH_V1,
  state: 'unavailable',
  reason: 'source-unavailable',
};
const empty = { version: UNIFIED_SEARCH_V1, state: 'available', results: [] };
const roots: string[] = [];
const readers: IsolatedTaskSearch[] = [];
function root() {
  const directory = mkdtempSync(join(tmpdir(), 'station-isolated-task-'));
  roots.push(directory);
  return directory;
}
function reader(
  directory: string,
  options: Parameters<typeof createIsolatedTaskSearch>[1] = {},
) {
  const value = createIsolatedTaskSearch(
    { storePath: join(directory, 'task-graph.json'), stationId: 'station-a' },
    options,
  );
  readers.push(value);
  return value;
}
function source(body: string) {
  return new URL(`data:text/javascript,${encodeURIComponent(body)}`);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(async () => {
  for (const value of readers.splice(0)) {
    await value.close();
    await expect.poll(() => value.inspect().phase).toBe('closed');
  }
  for (const directory of roots.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('owned isolated Task search', () => {
  test('real TaskGraph owner reads canonical files and projects through the search aggregate', async () => {
    const directory = root();
    const graph = new TaskGraphService(directory, {
      resolveProjectWorkspace: async () => '',
    });
    const task = await graph.createTask({
      projectId: 'alpha',
      title: 'Parser repair',
      description: 'First line\nsecond line',
      createdBy: 'user',
    });
    await graph.createTask({
      projectId: 'beta',
      title: 'Parser elsewhere',
      createdBy: 'user',
    });
    const owned = graph.createPersonalSearchReader('station-a');
    readers.push(owned);
    const search = new UnifiedSearchService([owned.provider]);
    const result = await search.search({
      version: UNIFIED_SEARCH_V1,
      query: 'parser',
      filters: { projectId: 'alpha' },
    });
    expect(result.state).toBe('complete');
    if (result.state === 'invalid') throw new Error('invalid query');
    expect(result.results).toEqual([
      expect.objectContaining({
        id: task.id,
        title: 'Parser repair',
        snippet: 'First line second line',
        owner: { kind: 'station', stationId: 'station-a' },
        openIntent: { kind: 'task', projectId: 'alpha', taskId: task.id },
      }),
    ]);
    expect(owned.inspect()).toEqual({ phase: 'idle' });
    // A later canonical write is read afresh; no copied search index.
    await graph.createTask({
      projectId: 'alpha',
      title: 'Parser newer',
      createdBy: 'user',
    });
    const fresh = await owned.provider.search(
      request,
      new AbortController().signal,
    );
    expect('results' in fresh && fresh.results.length).toBe(3);
  }, 15_000);

  test('preserves missing-primary recovery, strict corruption and canonical shape validation', async () => {
    const directory = root();
    const graph = new TaskGraphService(directory, {
      resolveProjectWorkspace: async () => '',
    });
    const task = await graph.createTask({
      projectId: 'alpha',
      title: 'Parser repair',
      createdBy: 'user',
    });
    const path = join(directory, 'task-graph.json');
    const bytes = readFileSync(path, 'utf8');
    renameSync(path, `${path}.previous`);
    const owned = reader(directory);
    expect(
      await owned.provider.search(request, new AbortController().signal),
    ).toMatchObject({ state: 'available', results: [{ id: task.id }] });
    expect(existsSync(path)).toBe(false); // A read does not repair/mutate the home.
    writeFileSync(path, '{broken');
    expect(
      await owned.provider.search(request, new AbortController().signal),
    ).toEqual(unavailable);
    const invalid = JSON.parse(bytes);
    invalid.tasks[0].id = 'not-a-canonical-task-id';
    writeFileSync(path, JSON.stringify(invalid));
    expect(
      await owned.provider.search(request, new AbortController().signal),
    ).toEqual(unavailable);
    writeFileSync(path, bytes);
    expect(
      await owned.provider.search(request, new AbortController().signal),
    ).toMatchObject({ state: 'available', results: [{ id: task.id }] });
  }, 15_000);

  test('refuses oversized primary and fallback without converting them to empty success', async () => {
    const directory = root();
    const path = join(directory, 'task-graph.json');
    writeFileSync(path, ' '.repeat(TASK_SEARCH_LIMITS.fileBytes + 1));
    const owned = reader(directory);
    expect(
      await owned.provider.search(request, new AbortController().signal),
    ).toEqual(unavailable);
    renameSync(path, `${path}.previous`);
    expect(
      await owned.provider.search(request, new AbortController().signal),
    ).toEqual(unavailable);
  }, 15_000);

  test('real infinite worker work cannot stall the parent heartbeat and is terminated at deadline', async () => {
    const directory = root();
    const marker = join(directory, 'entered');
    const terminated = vi.fn((worker: Worker) => worker.terminate());
    const owned = reader(directory, {
      deadlineMs: 1500,
      terminate: terminated,
      workerSourceUrl: source(
        `import { parentPort } from 'node:worker_threads'; import { writeFileSync } from 'node:fs'; parentPort.on('message', () => { writeFileSync(${JSON.stringify(marker)}, 'entered'); while (true) {} });`,
      ),
    });
    const pending = owned.provider.search(
      request,
      new AbortController().signal,
    );
    await expect.poll(() => existsSync(marker)).toBe(true);
    let heartbeats = 0;
    const heartbeat = setInterval(() => {
      heartbeats++;
    }, 10);
    try {
      expect(await pending).toEqual(unavailable);
    } finally {
      clearInterval(heartbeat);
    }
    expect(heartbeats).toBeGreaterThan(2);
    expect(terminated).toHaveBeenCalledTimes(1);
    await expect.poll(() => owned.inspect().phase).toBe('idle');
  });

  test('large canonical Task file is validated and searched off-main with bounded partial projection', async () => {
    const directory = root();
    const graph = new TaskGraphService(directory, {
      resolveProjectWorkspace: async () => '',
    });
    await graph.createTask({
      projectId: 'alpha',
      title: 'Parser repair',
      createdBy: 'user',
    });
    const path = join(directory, 'task-graph.json');
    const content = JSON.parse(readFileSync(path, 'utf8'));
    const template = content.tasks[0];
    content.tasks = Array.from({ length: 2500 }, () => ({
      ...template,
      id: randomUUID(),
      description: 'x'.repeat(1800),
    }));
    const original = JSON.stringify(content);
    writeFileSync(path, original);
    const owned = graph.createPersonalSearchReader('station-a');
    readers.push(owned);
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks++;
    }, 5);
    let page: Awaited<ReturnType<typeof owned.provider.search>>;
    try {
      page = await owned.provider.search(request, new AbortController().signal);
    } finally {
      clearInterval(heartbeat);
    }
    expect(page).toMatchObject({ state: 'partial', reason: 'result-window' });
    expect('results' in page && page.results).toHaveLength(8);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(
      TASK_SEARCH_LIMITS.responseBytes,
    );
    expect(ticks).toBeGreaterThan(0);
    expect(readFileSync(path, 'utf8')).toBe(original);
  }, 15_000);

  test('a late successful reply after abort cannot release retiring custody or seed a newer request', async () => {
    const directory = root();
    const marker = join(directory, 'reply-sent');
    const cleanup = deferred<number>();
    let worker: Worker | undefined;
    const owned = reader(directory, {
      terminate: (value) => {
        worker = value;
        return cleanup.promise;
      },
      workerSourceUrl: source(
        `import { parentPort } from 'node:worker_threads'; import { writeFileSync } from 'node:fs'; parentPort.on('message', wire => { const {id} = JSON.parse(wire); setTimeout(() => { parentPort.postMessage(JSON.stringify({id,page:${JSON.stringify(empty)}})); writeFileSync(${JSON.stringify(marker)}, 'sent'); }, 30); });`,
      ),
    });
    const controller = new AbortController();
    const pending = owned.provider.search(request, controller.signal);
    controller.abort();
    expect(await pending).toEqual(unavailable);
    await expect.poll(() => existsSync(marker)).toBe(true);
    expect(owned.inspect()).toEqual({ phase: 'retiring' });
    expect(
      await owned.provider.search(request, new AbortController().signal),
    ).toEqual(unavailable);
    cleanup.resolve(await worker!.terminate());
    await expect.poll(() => owned.inspect().phase).toBe('idle');
  });

  test('abort retains exact outstanding termination and no replacement or overlapping cleanup', async () => {
    const directory = root();
    const cleanup = deferred<number>();
    let worker: Worker | undefined;
    const terminate = vi.fn((value: Worker) => {
      worker = value;
      return cleanup.promise;
    });
    const owned = reader(directory, {
      terminate,
      workerSourceUrl: source(
        `import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => {});`,
      ),
    });
    const controller = new AbortController();
    const pending = owned.provider.search(request, controller.signal);
    controller.abort();
    expect(await pending).toEqual(unavailable);
    expect(
      await owned.provider.search(request, new AbortController().signal),
    ).toEqual(unavailable);
    expect(await owned.close()).toEqual({ state: 'winding-down' });
    expect(await owned.close()).toEqual({ state: 'winding-down' });
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(owned.inspect()).toEqual({ phase: 'retiring' });
    cleanup.resolve(await worker!.terminate());
    await expect.poll(() => owned.inspect().phase).toBe('closed');
  });

  test('only settled cleanup rejection may retry and uncertain custody blocks admission', async () => {
    const directory = root();
    const cleanup = deferred<number>();
    const terminate = vi
      .fn<(worker: Worker) => Promise<number>>()
      .mockImplementationOnce(() => cleanup.promise)
      .mockImplementation((worker) => worker.terminate());
    const owned = reader(directory, {
      terminate,
      workerSourceUrl: source(
        `import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => {});`,
      ),
    });
    const controller = new AbortController();
    const pending = owned.provider.search(request, controller.signal);
    controller.abort();
    expect(await pending).toEqual(unavailable);
    cleanup.reject(new Error('termination not confirmed'));
    await expect.poll(() => owned.inspect().phase).toBe('incomplete');
    expect(
      await owned.provider.search(request, new AbortController().signal),
    ).toEqual(unavailable);
    expect(terminate).toHaveBeenCalledTimes(1);
    await owned.close();
    await expect.poll(() => owned.inspect().phase).toBe('closed');
    expect(terminate).toHaveBeenCalledTimes(2);
  });

  test('saturation has no queue; the admitted request alone receives its result', async () => {
    const directory = root();
    const owned = reader(directory, {
      workerSourceUrl: source(
        `import { parentPort } from 'node:worker_threads'; parentPort.on('message', wire => { const request = JSON.parse(wire); setTimeout(() => parentPort.postMessage(JSON.stringify({id:request.id,page:${JSON.stringify(empty)}})), 80); });`,
      ),
    });
    const admitted = owned.provider.search(
      request,
      new AbortController().signal,
    );
    expect(
      await owned.provider.search(request, new AbortController().signal),
    ).toEqual(unavailable);
    expect(await admitted).toEqual(empty);
    expect(owned.inspect()).toEqual({ phase: 'idle' });
  });

  test.each(['wrong-id', 'oversized', 'bad-page', 'crash'])(
    'retires a worker with %s output and settles its caller',
    async (fault) => {
      const body =
        fault === 'crash'
          ? `throw new Error('crash')`
          : fault === 'oversized'
            ? `parentPort.postMessage('x'.repeat(${TASK_SEARCH_LIMITS.responseBytes + 1}))`
            : fault === 'bad-page'
              ? `parentPort.postMessage(JSON.stringify({id:request.id,page:{invalid:true}}))`
              : `parentPort.postMessage(JSON.stringify({id:request.id+1,page:${JSON.stringify(empty)}}))`;
      const owned = reader(root(), {
        workerSourceUrl: source(
          `import { parentPort } from 'node:worker_threads'; parentPort.on('message', wire => { const request = JSON.parse(wire); ${body}; });`,
        ),
      });
      expect(
        await owned.provider.search(request, new AbortController().signal),
      ).toEqual(unavailable);
      await expect.poll(() => owned.inspect().phase).toBe('idle');
    },
  );

  test('already aborted, malformed, accessor and oversized requests never launch a worker', async () => {
    const owned = reader(root(), {
      workerSourceUrl: new URL('file:///does-not-exist/task-worker.js'),
    });
    const abort = new AbortController();
    abort.abort();
    expect(await owned.provider.search(request, abort.signal)).toEqual(
      unavailable,
    );
    const getter = vi.fn(() => 'parser');
    const hostile = { ...request };
    Object.defineProperty(hostile, 'query', { get: getter });
    expect(
      await owned.provider.search(hostile, new AbortController().signal),
    ).toEqual(unavailable);
    expect(getter).not.toHaveBeenCalled();
    expect(
      await owned.provider.search(
        { ...request, query: 'x'.repeat(257) },
        new AbortController().signal,
      ),
    ).toEqual(unavailable);
    expect(
      await owned.provider.search(
        { ...request, filters: { kinds: new Array(2) } },
        new AbortController().signal,
      ),
    ).toEqual(unavailable);
    expect(owned.inspect()).toEqual({ phase: 'idle' });
    expect(await owned.close()).toEqual({ state: 'closed' });
  });
});
