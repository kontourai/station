import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Worker } from 'node:worker_threads';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
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
function source(directory: string, mode: string, marker?: string) {
  const fixture = mkdtempSync(join(directory, 'worker-'));
  writeFileSync(
    join(fixture, 'inputs.json'),
    JSON.stringify({
      mode,
      marker,
      empty,
      responseBytes: TASK_SEARCH_LIMITS.responseBytes,
    }),
  );
  const entry = join(fixture, 'worker.mjs');
  copyFileSync(
    new URL('./fixtures/task-search-worker.fixture.mjs', import.meta.url),
    entry,
  );
  return pathToFileURL(entry);
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
  test('fresh personal point opens share the search reader and refuse moved/deleted Tasks', async () => {
    const directory = root();
    const graph = new TaskGraphService(directory, {
      resolveProjectWorkspace: async () => '',
    });
    const task = await graph.createTask({
      projectId: 'alpha',
      title: 'Parser',
      createdBy: 'user',
    });
    const owned = graph.createPersonalSearchReader('station-a');
    readers.push(owned);
    const input = {
      taskId: task.id,
      projectId: 'alpha',
      authority: sessionReadAuthorityFromRequest('user', undefined, undefined),
      current: () => true,
    };
    const synchronous = vi.spyOn(graph, 'readTask').mockImplementation(() => {
      throw new Error('synchronous fallback');
    });
    expect(
      await owned.provider.search(request, new AbortController().signal),
    ).toMatchObject({ state: 'available' });
    expect(await owned.open(input)).toEqual({
      state: 'resolved',
      target: { kind: 'task', taskId: task.id, projectId: 'alpha' },
    });
    const path = join(directory, 'task-graph.json');
    const data = JSON.parse(readFileSync(path, 'utf8'));
    data.tasks[0].projectId = 'beta';
    writeFileSync(path, JSON.stringify(data));
    expect(await owned.open(input)).toEqual({ state: 'not-found' });
    expect(await owned.open({ ...input, projectId: 'beta' })).toMatchObject({
      state: 'resolved',
    });
    data.tasks = [];
    writeFileSync(path, JSON.stringify(data));
    expect(await owned.open({ ...input, projectId: 'beta' })).toEqual({
      state: 'not-found',
    });
    expect(synchronous).not.toHaveBeenCalled();
    expect(owned.inspect().phase).toBe('idle');
  });

  test('hosted Task open refuses before constructing a worker and late principal loss publishes nothing', async () => {
    const directory = root();
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [{ id: tenantId('alpha'), authority: 'alpha.test' }],
    });
    const authority = sessionReadAuthorityFromRequest(
      'user',
      { tenantId: tenantId('alpha') },
      registry,
    );
    const marker = join(directory, 'worker-constructed');
    const owned = reader(directory, {
      workerSourceUrl: source(directory, 'must-not-launch', marker),
    });
    expect(
      await owned.open({
        taskId: 'task',
        projectId: 'alpha',
        authority,
        current: () => true,
      }),
    ).toEqual({ state: 'not-found' });
    expect(owned.inspect().phase).toBe('idle');
    expect(existsSync(marker)).toBe(false);
    const delayed = reader(directory, {
      workerSourceUrl: source(directory, 'delayed-open'),
    });
    let current = true;
    const opening = delayed.open({
      taskId: 'task',
      projectId: 'alpha',
      authority: sessionReadAuthorityFromRequest('user', undefined, undefined),
      current: () => current,
    });
    current = false;
    expect(await opening).toEqual({ state: 'not-found' });
  });

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
      workerSourceUrl: source(directory, 'infinite', marker),
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
      workerSourceUrl: source(directory, 'late-success', marker),
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
      workerSourceUrl: source(directory, 'idle'),
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
      workerSourceUrl: source(directory, 'idle'),
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
      workerSourceUrl: source(directory, 'delayed-success'),
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
      const directory = root();
      const owned = reader(directory, {
        workerSourceUrl: source(directory, fault),
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
