import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { afterEach, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { createProjectRoomAccess } from '../../runtime/routes/project-room-access.js';
import { createProjectRoomTaskContext } from '../../runtime/routes/project-room-task-context.js';
import { EventBus } from '../orchestration/event-bus.js';
import { ProjectManifestStore } from './project-manifest-store.js';
import { createProjectMembershipRuntime } from './project-membership-runtime.js';
import {
  createProjectRoomAgentRuntime,
  type ProjectRoomAgentAuthority,
  type ProjectRoomAgentCapture,
  type ProjectRoomAgentExecution,
} from './project-room-agent-module.js';
import { createProjectRoomAgentPublication } from './project-room-agent-publication.js';
import { createProjectRoomRuntime } from './project-room-store.js';
import { ProjectService } from './project-service.js';
import { ProjectSharedTaskService } from './project-shared-task-service.js';
import { TaskGraphService } from './task-graph-service.js';

const temp = trackTempDirs();
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});
async function fixture() {
  const home = realpathSync(temp('room-task-evidence-'));
  const storage = new FileStorageAdapter(home);
  const manifests = new ProjectManifestStore(home, storage);
  const projects = new ProjectService(storage, manifests);
  const project = await projects.createProject({
    name: 'Room evidence',
    slug: 'evidence',
  });
  const membership = createProjectMembershipRuntime(home, 'station', storage);
  cleanup.push(() => membership.close());
  const room = createProjectRoomRuntime(home);
  cleanup.push(() => room.close());
  const graph = new TaskGraphService(home, {
    resolveProjectWorkspace: () => undefined,
  });
  const shared = new ProjectSharedTaskService({
    store: membership.sharedTasks,
    readTask: (id) => graph.readTaskView(id),
    projectCandidates: (identity) =>
      projects
        .listProjects()
        .filter((p) => p.id === identity || p.slug === identity),
    withTaskReadFence: (operation) => graph.withTaskReadFence(operation),
  });
  const owner = humanPrincipal('fixture', 'operator', 'Operator');
  let principal = owner;
  let view = true;
  const memberAuthority = {
    current: async () => ({ principal, verifiedEmails: [] }),
    operator: async () => {},
  };
  const access = createProjectRoomAccess({
    stationId: 'station',
    storage,
    manifests,
    membership: membership.service,
    member: async () => undefined,
    authority: () => memberAuthority,
    current: () => true,
    allows: (_request, _slug, action) => action !== 'view' || view,
  });
  const scope = await access.withAction(
    new Request('http://isolated.invalid'),
    project.slug,
    'view',
    owner.id,
    (live) => live,
  );
  const authority: ProjectRoomAgentAuthority = {
    scope,
    requester: { kind: 'person', id: owner.id, displayName: 'Operator' },
    executionRoot: home,
    assertCurrent() {},
    refresh: async () => {},
  };
  const bind = () =>
    createProjectRoomTaskContext({
      request: new Request('http://isolated.invalid'),
      scope,
      requesterId: owner.id,
      requireView: () =>
        access.withAction(
          new Request('http://isolated.invalid'),
          project.slug,
          'view',
          owner.id,
          (_scope, _actor, _caps, current) => current,
        ),
      service: shared,
      principalId: async () => principal.id,
    });
  authority.taskContext = bind();
  room.store.ensureRoom(scope, () => {});
  const task = await graph.createTask({
    projectId: project.id,
    title: 'Shared “status” 😀',
    description: 'PRIVATE DESCRIPTION',
    createdBy: 'PRIVATE OWNER',
  });
  await graph.createChildTask(
    {
      parent: { taskId: task.id, taskCreatedAt: task.createdAt },
      operationId: randomUUID(),
      task: {
        projectId: project.id,
        title: 'PRIVATE TASK SENTINEL',
        description: 'PRIVATE GOAL',
      },
    },
    {
      expectedProject: project,
      canonicalProject: () => project,
      canMutateTask: () => true,
      canReadTask: () => true,
      canReadConversation: () => false,
    },
  );
  const admission = membership.sharedTasks.share({
    scope,
    taskId: task.id,
    taskCreatedAt: task.createdAt,
    sharedBy: owner.id,
  });
  let capture: ProjectRoomAgentCapture | undefined;
  const execution: ProjectRoomAgentExecution = {
    prepare: vi.fn(async () => ({ label: 'Agent' })),
    launch: vi.fn(async (value, recheck, refresh) => {
      await refresh?.();
      recheck();
      capture = value;
    }),
    answer: vi.fn(async () => ({
      turnId: 'turn',
      text: 'Observed shared status',
    })),
    cancel: vi.fn(async () => {}),
  };
  let runtime = createProjectRoomAgentRuntime(home, room.store, execution);
  cleanup.push(() => runtime.close());
  return {
    home,
    graph,
    task,
    shared,
    membership,
    admission,
    room,
    authority,
    execution,
    get module() {
      return runtime.module;
    },
    get capture() {
      return capture!;
    },
    request: (text = 'Recap shared work') =>
      runtime.module.request(authority, {
        intentId: randomUUID(),
        agentId: 'agent',
        text,
      }),
    revoke() {
      membership.sharedTasks.unshare(task.id, admission.shareId);
    },
    principal() {
      principal = humanPrincipal('fixture', 'other', 'Other');
    },
    revokeView() {
      view = false;
    },
    restart() {
      runtime.close();
      runtime = createProjectRoomAgentRuntime(home, room.store, execution);
      authority.taskContext = bind();
    },
  };
}

it('captures only explicit shared projections for an operator, alongside reviewed note/history, and replays frozen status', async () => {
  const f = await fixture();
  const source = f.room.store.append(
    f.authority.scope,
    f.authority.requester,
    { intentId: randomUUID(), text: 'Room evidence' },
    () => {},
  );
  f.room.store.updateNote(
    f.authority.scope,
    f.authority.requester,
    {
      expectedRevision: 0,
      markdown: 'Reviewed note',
      sourceMessageIds: [source.messageId],
    },
    () => {},
  );
  const handle = await f.request();
  const frame = JSON.parse(f.capture.context.split('\n')[0]!);
  expect(frame.note.markdown).toBe('Reviewed note');
  expect(JSON.parse(f.capture.context.split('\n')[1]!)[0].text).toBe(
    'Room evidence',
  );
  expect(frame.tasks).toEqual(f.capture.taskSnapshot);
  expect(frame.tasks).toMatchObject({
    version: 1,
    coverage: 'shared_subset',
    project: f.authority.scope,
    items: [
      {
        shareId: f.admission.shareId,
        taskId: f.task.id,
        taskCreatedAt: f.task.createdAt,
        title: f.task.title,
        status: 'todo',
      },
    ],
  });
  expect(Date.parse(frame.tasks.observedAt)).toBeGreaterThan(0);
  expect(JSON.stringify(f.capture)).not.toMatch(
    /PRIVATE|children|childCount|goal/,
  );
  const frozen = JSON.stringify(f.capture);
  await f.graph.updateTaskStatus(f.task.id, 'ready');
  f.restart();
  await f.module.reconcile(f.authority, handle.requestId);
  expect(JSON.stringify(vi.mocked(f.execution.answer).mock.calls[0][0])).toBe(
    frozen,
  );
  expect(
    f.room.store.history(f.authority.scope).messages.map((m) => m.text),
  ).toEqual(['Room evidence', 'Observed shared status']);
});

it.each(['unshare', 'ABA', 'replacement', 'view', 'principal'] as const)(
  'withholds the complete answer after %s; fresh recovery does not change evidence and inspect/cancel stay usable',
  async (reason) => {
    const f = await fixture();
    const handle = await f.request();
    vi.mocked(f.execution.answer).mockImplementationOnce(async () => {
      if (reason === 'unshare' || reason === 'ABA') f.revoke();
      if (reason === 'ABA')
        f.membership.sharedTasks.share({
          scope: f.authority.scope,
          taskId: f.task.id,
          taskCreatedAt: f.task.createdAt,
          sharedBy: 'owner',
        });
      if (reason === 'replacement') {
        // An independently persisted replacement incarnation, read by the real graph owner.
        const path = join(f.home, 'task-graph.json');
        const data = JSON.parse(readFileSync(path, 'utf8'));
        data.tasks.find((t: { id: string }) => t.id === f.task.id).createdAt =
          '2026-01-01T00:00:00.000Z';
        writeFileSync(path, JSON.stringify(data));
      }
      if (reason === 'view') f.revokeView();
      if (reason === 'principal') f.principal();
      return { turnId: 'turn', text: 'Must withhold whole answer' };
    });
    await expect(
      f.module.reconcile(f.authority, handle.requestId),
    ).rejects.toThrow();
    expect(f.room.store.history(f.authority.scope).messages).toEqual([]);
    f.restart();
    await expect(
      f.module.reconcile(f.authority, handle.requestId),
    ).rejects.toThrow();
    expect(f.module.inspect(f.authority, handle.requestId).state).toBe(
      'started',
    );
    expect((await f.module.cancel(f.authority, handle.requestId)).state).toBe(
      'cancelled',
    );
    expect(f.execution.launch).toHaveBeenCalledTimes(1);
  },
);

it('refuses revocation at capture insertion and inside the actual Room append guard', async () => {
  const beforeCapture = await fixture();
  const fence = beforeCapture.shared.withCurrentSummaries.bind(
    beforeCapture.shared,
  );
  vi.spyOn(beforeCapture.shared, 'withCurrentSummaries').mockImplementationOnce(
    (summaries, operation) => {
      beforeCapture.revoke();
      return fence(summaries, operation);
    },
  );
  await expect(beforeCapture.request()).rejects.toThrow();
  expect(beforeCapture.execution.launch).not.toHaveBeenCalled();
  const db = new DatabaseSync(
    join(beforeCapture.home, 'security', 'project-room-agent.sqlite'),
  );
  expect(
    db
      .prepare('SELECT COUNT(*) AS count FROM project_room_agent_captures')
      .get()?.count,
  ).toBe(0);
  db.close();

  const f = await fixture();
  const handle = await f.request();
  const append = f.room.store.append.bind(f.room.store);
  vi.spyOn(f.room.store, 'append').mockImplementation(
    (scope, actor, input, current) =>
      append(scope, actor, input, () => {
        f.revoke();
        current();
      }),
  );
  await expect(
    f.module.reconcile(f.authority, handle.requestId),
  ).rejects.toThrow();
  expect(f.room.store.history(f.authority.scope).messages).toEqual([]);
});

it('keeps cancellation usable when revocation arrives while releasing the capture fence', async () => {
  const f = await fixture();
  const fence = f.shared.withCurrentSummaries.bind(f.shared);
  vi.spyOn(f.shared, 'withCurrentSummaries').mockImplementationOnce(
    async (summaries, operation) => {
      const result = await fence(summaries, operation);
      f.revoke();
      return result;
    },
  );
  const handle = await f.request();
  expect(handle).toMatchObject({
    state: 'uncertain',
    failure: 'launch_uncertain',
  });
  expect(f.execution.launch).not.toHaveBeenCalled();
  expect((await f.module.cancel(f.authority, handle.requestId)).state).toBe(
    'cancelled',
  );
});

it('rechecks captured refs in the dispatch callbacks after a late unshare', async () => {
  const f = await fixture();
  vi.mocked(f.execution.launch).mockImplementationOnce(
    async (_capture, recheck, refresh) => {
      f.revoke();
      await refresh?.();
      recheck();
      throw new Error('dispatch reached revoked context');
    },
  );
  const handle = await f.request();
  expect(handle).toMatchObject({
    state: 'uncertain',
    failure: 'launch_uncertain',
  });
  expect(f.room.store.history(f.authority.scope).messages).toEqual([]);
});

it('completion observation uses the original shared evidence and drops revoked publication', async () => {
  const f = await fixture();
  const handle = await f.request();
  f.revoke();
  const observer = createProjectRoomAgentPublication({
    eventBus: new EventBus(),
    module: f.module,
  });
  observer.watch(f.authority, handle.requestId);
  await vi.waitFor(() => expect(f.execution.answer).toHaveBeenCalledTimes(1));
  await observer.close();
  await expect(
    f.module.reconcile(f.authority, handle.requestId),
  ).rejects.toThrow();
  expect(f.room.store.history(f.authority.scope).messages).toEqual([]);
});

it.each(['count', 'bytes', 'global'] as const)(
  'bounds %s after JSON escaping and UTF-8 without exposing omitted rows',
  async (bound) => {
    const f = await fixture();
    if (bound !== 'global')
      for (let n = 0; n < 18; n++) {
        const task = await f.graph.createTask({
          projectId: f.task.projectId,
          title: bound === 'bytes' ? '\u0001😀'.repeat(70) : `shared ${n}`,
        });
        f.membership.sharedTasks.share({
          scope: f.authority.scope,
          taskId: task.id,
          taskCreatedAt: task.createdAt,
          sharedBy: 'owner',
        });
      }
    let text: string | undefined;
    if (bound === 'global') {
      await f.request('x');
      text = 'x'.repeat(16384 - Buffer.byteLength(f.capture.context) + 2);
    }
    await f.request(text);
    const snapshot = f.capture.taskSnapshot!;
    expect(snapshot.items.length).toBeLessThanOrEqual(16);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(
      4096,
    );
    expect(Buffer.byteLength(f.capture.context)).toBeLessThanOrEqual(16384);
    expect(snapshot.coverage).toBe(
      bound === 'global' ? 'omitted_budget' : 'bounded_subset',
    );
    expect(JSON.stringify(f.capture)).not.toContain('PRIVATE');
  },
);

it('reports unavailable backing Task state without leaking a previously read row', async () => {
  const f = await fixture();
  writeFileSync(join(f.home, 'task-graph.json'), '{corrupt');
  await f.request();
  expect(f.capture.taskSnapshot).toMatchObject({
    coverage: 'unavailable',
    items: [],
  });
  expect(f.capture.context).not.toContain(f.task.title);
});

it('distinguishes no shared summaries, missing reader and legacy captures without retrofilling', async () => {
  const f = await fixture();
  f.revoke();
  await f.request();
  expect(f.capture.taskSnapshot).toMatchObject({
    coverage: 'shared_subset',
    items: [],
  });
  delete f.authority.taskContext;
  const handle = await f.request();
  expect(f.capture.taskSnapshot).toMatchObject({
    coverage: 'unavailable',
    items: [],
  });
  const legacy = { ...f.capture };
  delete legacy.taskSnapshot;
  const [frame, history] = legacy.context.split('\n');
  const parsed = JSON.parse(frame!);
  delete parsed.tasks;
  legacy.context = `${JSON.stringify(parsed)}\n${history}`;
  const { digest: _, ...payload } = legacy;
  legacy.digest = createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
  const db = new DatabaseSync(
    join(f.home, 'security', 'project-room-agent.sqlite'),
  );
  db.prepare(
    'UPDATE project_room_agent_captures SET record=? WHERE request_id=?',
  ).run(JSON.stringify(legacy), handle.requestId);
  db.close();
  f.restart();
  const capture = vi.spyOn(f.authority.taskContext!, 'capture');
  await f.module.reconcile(f.authority, handle.requestId);
  expect(capture).not.toHaveBeenCalled();
  expect(
    vi.mocked(f.execution.answer).mock.calls.at(-1)![0].taskSnapshot,
  ).toBeUndefined();
});

it.each(['scope', 'status', 'extra', 'context', 'bytes'] as const)(
  'refuses corrupt Task evidence %s even with a recomputed digest',
  async (field) => {
    const f = await fixture();
    const handle = await f.request();
    const record = JSON.parse(JSON.stringify(f.capture));
    if (field === 'scope') record.taskSnapshot.project.localProjectId = 'other';
    if (field === 'status') record.taskSnapshot.items[0].status = 'invented';
    if (field === 'extra') record.taskSnapshot.items[0].privateGoal = 'private';
    if (field === 'bytes')
      record.taskSnapshot.items = Array.from({ length: 16 }, (_, index) => ({
        ...record.taskSnapshot.items[0],
        taskId: `item-${index}`,
        title: '\u0001'.repeat(200),
      }));
    if (field === 'context')
      record.taskSnapshot.items[0].title = 'substitution';
    else {
      const [frame, history] = record.context.split('\n');
      record.context = `${JSON.stringify({ ...JSON.parse(frame), tasks: record.taskSnapshot })}\n${history}`;
    }
    const { digest: _, ...payload } = record;
    record.digest = createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');
    const db = new DatabaseSync(
      join(f.home, 'security', 'project-room-agent.sqlite'),
    );
    db.prepare(
      'UPDATE project_room_agent_captures SET record=? WHERE request_id=?',
    ).run(JSON.stringify(record), handle.requestId);
    db.close();
    await expect(
      f.module.reconcile(f.authority, handle.requestId),
    ).rejects.toThrow();
    expect(f.execution.answer).not.toHaveBeenCalled();
  },
);

it('holds both owner locks through the actual append against a second process, then releases them', async () => {
  const f = await fixture();
  const handle = await f.request();
  const marker = join(f.home, 'writer');
  const graphUrl = pathToFileURL(
    join(process.cwd(), 'src-server/services/projects/task-graph-service.ts'),
  ).href;
  const storeUrl = pathToFileURL(
    join(
      process.cwd(),
      'src-server/services/projects/project-shared-task-store.ts',
    ),
  ).href;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { existsSync, writeFileSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    import { setTimeout } from 'node:timers/promises';
    import { TaskGraphService } from ${JSON.stringify(graphUrl)};
    import { ProjectSharedTaskStore } from ${JSON.stringify(storeUrl)};
    import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
    const [home, marker, id, shareId] = process.argv.slice(1);
    const db = new DatabaseSync(home + '/security/project-membership.sqlite');
    db.exec('PRAGMA busy_timeout=0');
    const shares = new ProjectSharedTaskStore(db);
    const graph = new TaskGraphService(home, { acquireMutationLock: path => acquireFileMutationLockAsync(path, { timeoutMs: 150 }) });
    writeFileSync(marker + '.ready', 'ready');
    while (!existsSync(marker + '.start')) await setTimeout(5);
    try { shares.unshare(id, shareId); writeFileSync(marker + '.share', 'UNFENCED'); }
    catch (error) { writeFileSync(marker + '.share', /locked|busy/i.test(String(error)) ? 'blocked' : String(error)); }
    try { await graph.updateTaskStatus(id, 'ready'); writeFileSync(marker + '.graph', 'UNFENCED'); }
    catch (error) { writeFileSync(marker + '.graph', /lock/i.test(String(error)) ? 'blocked' : String(error)); }
    while (!existsSync(marker + '.finish')) await setTimeout(5);
    shares.unshare(id, shareId);
    await graph.updateTaskStatus(id, 'ready');
    db.close();
  `,
      f.home,
      marker,
      f.task.id,
      f.admission.shareId,
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  cleanup.push(() => {
    if (child.exitCode === null) child.kill();
  });
  await vi.waitFor(
    () => expect(existsSync(`${marker}.ready`), stderr).toBe(true),
    { timeout: 10000 },
  );
  const append = f.room.store.append.bind(f.room.store);
  vi.spyOn(f.room.store, 'append').mockImplementation(
    (scope, actor, input, current) =>
      append(scope, actor, input, () => {
        current();
        writeFileSync(`${marker}.start`, 'go');
        const deadline = Date.now() + 4000;
        while (
          (!existsSync(`${marker}.share`) || !existsSync(`${marker}.graph`)) &&
          Date.now() < deadline
        )
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        expect(readFileSync(`${marker}.share`, 'utf8')).toBe('blocked');
        expect(readFileSync(`${marker}.graph`, 'utf8')).toBe('blocked');
        current();
      }),
  );
  expect((await f.module.reconcile(f.authority, handle.requestId)).state).toBe(
    'published',
  );
  writeFileSync(`${marker}.finish`, 'go');
  expect(await exited, stderr).toBe(0);
  expect(f.membership.sharedTasks.admission(f.task.id)).toBeUndefined();
  expect(f.graph.readTaskView(f.task.id)?.status).toBe('ready');
  // Revocation fences pending publication; already published Room text remains.
  expect(
    f.room.store.history(f.authority.scope).messages.map((m) => m.text),
  ).toEqual(['Observed shared status']);
}, 20000);
