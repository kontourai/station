import { join } from 'node:path';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import {
  type ProviderWorkItem,
  type WorkItemObservation,
  type WorkItemObservationResult,
  workItemRefKey,
} from '@kontourai/station-contracts/work-item-provider';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { ProjectTaskRoomRevisionEvidenceBridge } from '../../../services/orchestration/project-task-room-revision-evidence-bridge.js';
import { ProjectTaskRoomRuntime } from '../../../services/orchestration/project-task-room-runtime.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import type { WorkItemObserver } from '../../../services/work-item-providers/github-work-item-observer.js';
import { authorizeStationControlRequest } from '../../../tools/station-control-policy.js';
import { createTaskRoutes } from '../tasks.js';

const temp = trackTempDirs();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

/** The route's JSON envelope, read loosely: each test asserts its fields. */
type Body = {
  success: boolean;
  data?: any;
  error?: string;
  observation?: string;
};
const json = (response: Response) => response.json() as Promise<Body>;

const REF = 'github:acme/widgets#42';
const boardItem: ProviderWorkItem = {
  id: REF,
  title: 'Widgets jam (board title)',
  status: 'ready',
  provider: {
    kind: 'flow-agents-github',
    id: 'flow-agents-github:acme/widgets',
    label: 'GitHub (acme/widgets)',
  },
  workItemRef: REF,
  url: 'https://github.com/acme/widgets/issues/42',
};
const observation: WorkItemObservation = {
  workItemRef: REF,
  url: 'https://github.com/acme/widgets/issues/42',
  title: 'Widgets jam on Tuesdays',
  state: 'open',
  labels: ['bug'],
  updatedAt: '2026-10-20T12:00:00Z',
  observedAt: '2026-10-21T10:00:00.000Z',
  body: 'Steps to reproduce.\n\n## Done\nA heading inside the issue.',
  comments: [1, 2, 3, 4].map((index) => ({
    author: `commenter${index}`,
    createdAt: `2026-10-0${index}T00:00:00Z`,
    excerpt: `comment ${index}`,
  })),
};

async function fixture(
  observe: (
    ref: string,
    options?: { commentsSince?: string },
  ) => Promise<WorkItemObservationResult> = async () => ({
    status: 'observed',
    observation,
  }),
  board: ProviderWorkItem[] = [boardItem],
  hosted = false,
  /** Each Project's board; defaults to `board` for every Project. */
  boardFor?: (projectId: string) => ProviderWorkItem[],
) {
  const directory = temp('station-from-work-item-');
  const service = new TaskGraphService(directory, {
    // Each Project by its slug or its opaque id, as `localProjectIdFor`
    // resolves the runtime's Projects.
    localProjectIdFor: (identity: string) =>
      ({
        alpha: 'id-alpha',
        'id-alpha': 'id-alpha',
        beta: 'id-beta',
        'id-beta': 'id-beta',
      })[identity],
    projectService: {
      getProject: (id: string) => ({
        id,
        slug: id,
        name: id,
        workingDirectory: directory,
        createdAt: '2026-10-15T00:00:00Z',
        updatedAt: '2026-10-15T00:00:00Z',
      }),
    },
  });
  const store = new EventStore(join(directory, 'events.sqlite'));
  const security = new EnvironmentSecurityService({ homeDir: directory });
  await security.initialize();
  const room = new ProjectTaskRoomRuntime({
    taskGraph: service,
    revisionEvidence: new ProjectTaskRoomRevisionEvidenceBridge({
      eventStore: store,
      security,
    }),
    projectForId: (id) => ({ id, slug: id }),
    history: (authority) => store.createProjectTaskRoomHistory(authority),
    working: store.createProjectTaskRoomWorkingState(),
    requestAuthority: {
      resolve: async () => ({
        kind: 'granted',
        operatorId: 'owner',
        deviceId: 'device',
        policyRevision: 'v1',
      }),
    },
  });
  cleanups.push(async () => {
    await room.close();
    store.close();
  });
  const observer: WorkItemObserver = { observeWorkItem: vi.fn(observe) };
  // As the runtime's resolver: the Project's board, refs compared by key.
  const resolveProviderWorkItem = vi.fn(
    async ({
      projectId,
      workItemRef,
    }: {
      projectId: string;
      workItemRef: string;
    }) =>
      (boardFor?.(projectId) ?? board).find(
        (item) =>
          item.workItemRef !== undefined &&
          workItemRefKey(item.workItemRef) === workItemRefKey(workItemRef),
      ),
  );
  const app = createTaskRoutes(service, {
    taskDispatcher: { dispatch: vi.fn() },
    readAuthorityForRequest: () =>
      hosted
        ? ({ mode: 'hosted' } as never)
        : sessionReadAuthorityFromRequest('owner', undefined, undefined),
    canReadSession: () => true,
    seedProposalBrief: (input) => room.seedProposalBrief(input),
    workItemObserver: observer,
    resolveProviderWorkItem,
  });
  const start = (workItemRef = REF, projectId = 'alpha') =>
    app.request('/from-work-item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, workItemRef }),
    });
  const create = (body: Record<string, unknown>) =>
    app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'alpha', title: 'Typed', ...body }),
    });
  const document = async (taskId: string) =>
    room.document({ taskId, request: new Request('http://station.test') });
  return {
    app,
    service,
    start,
    create,
    document,
    observer,
    resolveProviderWorkItem,
  };
}

test('Start Task creates the Task from the observed item and seeds its brief', async () => {
  const { service, start, document, observer } = await fixture();
  const response = await start();
  expect(response.status, await response.clone().text()).toBe(201);
  const { data } = await json(response);
  expect(data).toMatchObject({ existing: false, briefSaved: true });
  expect(observer.observeWorkItem).toHaveBeenCalledWith(REF, {});
  const [task] = service.listTasks();
  expect(task).toMatchObject({
    id: data.task.id,
    projectId: 'alpha',
    title: 'Widgets jam on Tuesdays',
    status: 'todo',
    sourceProvider: 'github',
    workItemRef: REF,
    workItemObservedAt: '2026-10-21T10:00:00.000Z',
  });
  const seeded = await document(task.id);
  if (seeded.kind !== 'snapshot')
    throw new Error(`no document: ${seeded.kind}`);
  const link =
    '[github:acme/widgets#42](<https://github.com/acme/widgets/issues/42>)';
  expect(seeded.text).toBe(
    [
      `Started from ${link}.`,
      '> Steps to reproduce.\n>\n> ## Done\n> A heading inside the issue.',
      'Latest 2 comments on the item:',
      '**@commenter3**, 2026-10-03T00:00:00Z:\n> comment 3',
      '**@commenter4**, 2026-10-04T00:00:00Z:\n> comment 4',
      'Read the whole item, with every comment, on the tracker.',
    ].join('\n\n'),
  );
  // The issue's own `## Done` stays quoted, never a document heading, and
  // the seed is the brief only: no Task-memory headings.
  expect(seeded.text).not.toMatch(/^## /m);
});

test('a second Start Task on the same item opens the open Task instead of creating one', async () => {
  const { service, start, observer } = await fixture();
  const first = await json(await start());
  const second = await start();
  expect(second.status).toBe(200);
  expect((await json(second)).data).toMatchObject({
    existing: true,
    task: { id: first.data.task.id },
  });
  expect(service.listTasks()).toHaveLength(1);
  // The open Task answers before the tracker is read again.
  expect(observer.observeWorkItem).toHaveBeenCalledTimes(1);
});

test('concurrent Start Task requests for one item create one Task', async () => {
  const { service, start } = await fixture();
  const responses = await Promise.all([start(), start(), start()]);
  const bodies = await Promise.all(responses.map(json));
  expect(service.listTasks()).toHaveLength(1);
  const ids = new Set(bodies.map((body) => body.data.task.id));
  expect(ids.size).toBe(1);
  expect(bodies.filter((body) => body.data.existing === false)).toHaveLength(1);
});

test.each(['done', 'canceled'] as const)(
  'a %s Task does not hold the item: Start Task creates a new one',
  async (status) => {
    const { service, start } = await fixture();
    const first = (await json(await start())).data.task;
    // done is reached through in_progress; canceled directly.
    if (status === 'done')
      await service.updateTaskStatus(first.id, 'in_progress');
    await service.updateTaskStatus(first.id, status);
    const response = await start();
    expect(response.status).toBe(201);
    const second = (await json(response)).data;
    expect(second).toMatchObject({ existing: false });
    expect(second.task.id).not.toBe(first.id);
    expect(service.listTasks()).toHaveLength(2);
  },
);

test('refuses an item the Project board does not list, without reading the tracker', async () => {
  const { service, start, observer } = await fixture(undefined, []);
  const response = await start();
  expect(response.status).toBe(404);
  expect(observer.observeWorkItem).not.toHaveBeenCalled();
  expect(service.listTasks()).toEqual([]);
});

test.each([
  'acme/widgets#42',
  'https://github.com/acme/widgets/issues/42',
  'github:ghe.example.com/acme/widgets#42',
])('refuses the unsupported ref %j before any lookup', async (ref) => {
  const { service, start, observer, resolveProviderWorkItem } = await fixture(
    undefined,
    [{ ...boardItem, workItemRef: ref }],
  );
  expect((await start(ref)).status).toBe(422);
  expect(resolveProviderWorkItem).not.toHaveBeenCalled();
  expect(observer.observeWorkItem).not.toHaveBeenCalled();
  expect(service.listTasks()).toEqual([]);
});

test.each([
  ['unauthenticated', 503, 'Run `gh auth login` on the Station host.'],
  [
    'unsupported',
    422,
    'github:acme/widgets#42 is a pull request, not an issue.',
  ],
  ['not-found', 404, 'GitHub has no such issue.'],
  ['unavailable', 503, 'GitHub did not answer.'],
] as const)(
  'an observation that is %s creates no Task',
  async (status, http, reason) => {
    const { service, start } = await fixture(async () => ({ status, reason }));
    const response = await start();
    expect(response.status).toBe(http);
    expect(await json(response)).toEqual({
      success: false,
      error: reason,
      observation: status,
    });
    expect(service.listTasks()).toEqual([]);
  },
);

test('hosted requests never reach the host tracker login', async () => {
  const { service, start, observer } = await fixture(
    undefined,
    undefined,
    true,
  );
  expect((await start()).status).toBe(404);
  expect(observer.observeWorkItem).not.toHaveBeenCalled();
  expect(service.listTasks()).toEqual([]);
});

test('the Task header re-reads its item for comments since the Task last recorded it', async () => {
  const { app, start, observer } = await fixture();
  const { data } = await json(await start());
  const response = await app.request(`/${data.task.id}/work-item`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(observer.observeWorkItem).toHaveBeenLastCalledWith(REF, {
    commentsSince: '2026-10-21T10:00:00.000Z',
  });
  expect((await json(response)).data).toMatchObject({
    status: 'observed',
    commentsSince: '2026-10-21T10:00:00.000Z',
  });
});

test('a Task without a linked item has no work-item header', async () => {
  const { app, service, observer } = await fixture();
  const task = await service.createTask({ projectId: 'alpha', title: 'Local' });
  expect((await app.request(`/${task.id}/work-item`)).status).toBe(404);
  expect(observer.observeWorkItem).not.toHaveBeenCalled();
});

test('Start Task is a person action: no station-control caller may reach it, as with Task creation', () => {
  const operator = {
    assurance: 'bound' as const,
    principal: {
      id: 'human:local:operator',
      elevationEligible: true,
    },
  };
  const context = { caller: operator, isOperatorPrincipal: () => true };
  expect(
    authorizeStationControlRequest('POST', '/api/tasks', context)?.code,
  ).toBe('station_control_route_unmapped');
  expect(
    authorizeStationControlRequest('POST', '/api/tasks/from-work-item', context)
      ?.code,
  ).toBe('station_control_route_unmapped');
});

test('POST / accepts a github: ref only when it parses and the Project board offers it, and records that (review F4)', async () => {
  const { service, create, observer, resolveProviderWorkItem } =
    await fixture();
  // Not on the board: refused, nothing created, the tracker never read.
  const off = await create({ workItemRef: 'github:someorg/private-repo#7' });
  expect(off.status).toBe(404);
  // Not a github.com issue ref: refused before any lookup.
  resolveProviderWorkItem.mockClear();
  const bad = await create({ workItemRef: 'github:someorg/private-repo' });
  expect(bad.status).toBe(422);
  expect(resolveProviderWorkItem).not.toHaveBeenCalled();
  expect(service.listTasks()).toEqual([]);
  // On the board, in any spelling: stored canonical and board-checked.
  const on = await create({ workItemRef: 'github:ACME/Widgets#42' });
  expect(on.status, await on.clone().text()).toBe(201);
  expect(service.listTasks()).toMatchObject([
    { workItemRef: REF, workItemProvenance: 'project-board' },
  ]);
  // A ref outside the github: namespace is stored as before, unchecked.
  await service.updateTaskStatus(service.listTasks()[0]!.id, 'canceled');
  const slug = await create({ workItemRef: 'flow-slug' });
  expect(slug.status).toBe(201);
  expect(
    service.listTasks().find((task) => task.workItemRef === 'flow-slug'),
  ).not.toHaveProperty('workItemProvenance');
  expect(observer.observeWorkItem).not.toHaveBeenCalled();
});

test('the Task header never reads a ref that did not enter through a board check (review F4)', async () => {
  const { app, service, observer } = await fixture();
  // As any create without the board check (an older Task, a service caller).
  const task = await service.createTask({
    projectId: 'alpha',
    title: 'Typed ref',
    workItemRef: 'github:someorg/private-repo#7',
  });
  const response = await app.request(`/${task.id}/work-item`);
  expect(response.status).toBe(200);
  expect((await json(response)).data).toEqual({
    status: 'unsupported',
    reason:
      "This Task's work item was not checked against the Project's board, so Station does not read it from the tracker.",
  });
  expect(observer.observeWorkItem).not.toHaveBeenCalled();
});

test('every ref-bearing create keeps one open Task per item, comparing GitHub owner and repo case-insensitively (review F5)', async () => {
  const { service, create, start } = await fixture();
  const first = await create({ workItemRef: REF });
  expect(first.status).toBe(201);
  const firstId = (await json(first)).data.id;
  // POST / again, in another spelling, and concurrently: refused with the
  // open Task's id.
  const again = await Promise.all([
    create({ workItemRef: 'github:Acme/WIDGETS#42' }),
    create({ workItemRef: REF }),
  ]);
  for (const response of again) {
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({
      success: false,
      data: { taskId: firstId, projectId: 'alpha' },
    });
  }
  // Start Task in another spelling opens it.
  const started = await json(await start('github:ACME/widgets#42'));
  expect(started.data).toMatchObject({ existing: true, task: { id: firstId } });
  // A board-checked ref is unique across Projects: beta's board-checked
  // create is refused with alpha's Task id and Project only.
  const beta = await create({ projectId: 'beta', workItemRef: REF });
  expect(beta.status).toBe(409);
  expect((await json(beta)).data).toEqual({
    taskId: firstId,
    projectId: 'alpha',
  });
  // A service create is held to the same rule under the store lock, in its
  // own Project (by slug or by id).
  await expect(
    Promise.all([
      service.createTask({ projectId: 'alpha', title: 'x', workItemRef: REF }),
      service.createTask({
        projectId: 'id-alpha',
        title: 'y',
        workItemRef: REF,
      }),
    ]),
  ).rejects.toThrow('This work item already has an open Task.');
  expect(service.listTasks()).toHaveLength(1);
  // A bare slug is unique within its Project only.
  expect(
    await service.createTask({
      projectId: 'alpha',
      title: 's',
      workItemRef: 'slug',
    }),
  ).toMatchObject({ workItemRef: 'slug' });
  await expect(
    service.createTask({ projectId: 'alpha', title: 't', workItemRef: 'slug' }),
  ).rejects.toThrow('This work item already has an open Task.');
  expect(
    await service.createTask({
      projectId: 'beta',
      title: 'u',
      workItemRef: 'slug',
    }),
  ).toMatchObject({ projectId: 'beta' });
});

test("a ref Station did not board-check is unique only within its Project, and a 409 never names another Project's Task for it (review round 2, P2-1)", async () => {
  const { service, create } = await fixture();
  // A non-GitHub namespaced ref in alpha.
  const alpha = await create({ workItemRef: 'linear:ENG-1' });
  expect(alpha.status).toBe(201);
  const alphaId = (await json(alpha)).data.id;
  // Beta naming the same text creates its own Task: no probe, no squat.
  const beta = await create({ projectId: 'beta', workItemRef: 'linear:ENG-1' });
  expect(beta.status, await beta.clone().text()).toBe(201);
  expect(JSON.stringify(await json(beta))).not.toContain(alphaId);
  // Within alpha, by slug or by id, it is one open Task.
  for (const projectId of ['alpha', 'id-alpha']) {
    const again = await create({ projectId, workItemRef: 'linear:ENG-1' });
    expect(again.status).toBe(409);
    expect((await json(again)).data).toEqual({
      taskId: alphaId,
      projectId: 'alpha',
    });
  }
  // An unchecked github: ref (a service create) does not reach across
  // Projects either, in either direction.
  const unchecked = await service.createTask({
    projectId: 'beta',
    title: 'typed',
    workItemRef: 'github:acme/widgets#7',
  });
  expect(unchecked.workItemProvenance).toBeUndefined();
  expect(
    await service.createTask({
      projectId: 'alpha',
      title: 'typed too',
      workItemRef: 'github:acme/widgets#7',
    }),
  ).toMatchObject({ projectId: 'alpha' });
});

test("Start Task names its own Project's open Task in full whether the Task recorded the Project's slug or id (review round 2, P3-1)", async () => {
  const { service, start } = await fixture();
  const task = await service.createTask({
    projectId: 'id-alpha',
    title: 'By id',
    workItemRef: REF,
  });
  const started = await json(await start(REF, 'alpha'));
  expect(started.data).toMatchObject({
    existing: true,
    task: { id: task.id, title: 'By id' },
  });
  expect(started.data).not.toHaveProperty('elsewhere');
});

test("Start Task checks this Project's board before the open-Task lookup, and names another Project's Task by id only (review F6)", async () => {
  let betaBoard: ProviderWorkItem[] = [];
  const { start, observer } = await fixture(
    undefined,
    [boardItem],
    false,
    (id) => (id === 'beta' ? betaBoard : [boardItem]),
  );
  const alpha = (await json(await start())).data.task;
  expect(alpha.projectId).toBe('alpha');
  // Beta's board does not offer it: beta learns nothing about alpha's Task.
  const hidden = await start(REF, 'beta');
  expect(hidden.status).toBe(404);
  expect(JSON.stringify(await json(hidden))).not.toContain(alpha.id);
  // Beta's board offers it: the open Task in alpha, by id and Project only.
  betaBoard = [boardItem];
  const shown = await start(REF, 'beta');
  expect(shown.status).toBe(200);
  expect((await json(shown)).data).toEqual({
    task: { id: alpha.id, projectId: 'alpha' },
    existing: true,
    elsewhere: true,
    briefSaved: false,
  });
  expect(observer.observeWorkItem).toHaveBeenCalledTimes(1);
});
