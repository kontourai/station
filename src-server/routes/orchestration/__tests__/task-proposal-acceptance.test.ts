import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { ProjectTaskRoomRevisionEvidenceBridge } from '../../../services/orchestration/project-task-room-revision-evidence-bridge.js';
import { ProjectTaskRoomRuntime } from '../../../services/orchestration/project-task-room-runtime.js';
import type { SessionAssistantTurnQueryOutcome } from '../../../services/orchestration/session-query-module.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { createTaskRoutes } from '../tasks.js';

const temp = trackTempDirs();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const proposal = {
  title: 'Installer progress',
  goal: 'Show progress.',
  doneWhen: ['Steps have counts.'],
  firstStep: 'Find the installer.',
};
const proposalAnswer =
  '```station-task-proposal\n' + JSON.stringify(proposal) + '\n```';
const brief =
  '## Goal\n\nShow progress.\n\n## Done when\n\n- [ ] Steps have counts.\n\n## Suggested first step\n\nFind the installer.';
const input = {
  projectId: 'alpha',
  title: 'Installer progress',
  description: 'Show progress.',
  proposalBrief: brief,
  shapingSource: { sessionId: 'shaping-session', turnId: 'shaping-turn' },
};
async function fixture(
  outcome: SessionAssistantTurnQueryOutcome = {
    status: 'found',
    sessionId: 'shaping-session',
    turnId: 'shaping-turn',
    projectSlug: 'alpha',
    message: {
      id: 'answer',
      role: 'assistant',
      parts: [{ type: 'text', text: proposalAnswer }],
    },
  },
) {
  const directory = temp('station-proposal-');
  const service = new TaskGraphService(directory, {
    projectService: {
      getProject: () => ({
        id: 'alpha',
        slug: 'alpha',
        name: 'Alpha',
        workingDirectory: directory,
        createdAt: '2026-10-15T00:00:00Z',
        updatedAt: '2026-10-15T00:00:00Z',
      }),
    },
  });
  const store = new EventStore(join(directory, 'events.sqlite'));
  const backing = store.createProjectTaskRoomWorkingState();
  const working = { ...backing, settle: vi.fn(backing.settle) };
  let current = true;
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
    working,
    requestAuthority: {
      resolve: async () =>
        current
          ? {
              kind: 'granted',
              operatorId: 'owner',
              deviceId: 'device',
              policyRevision: 'v1',
            }
          : { kind: 'revoked' },
    },
  });
  cleanups.push(async () => {
    await room.close();
    store.close();
  });
  const read = vi.fn(async () => outcome);
  const app = createTaskRoutes(service, {
    taskDispatcher: { dispatch: vi.fn() },
    readAuthorityForRequest: () =>
      sessionReadAuthorityFromRequest('owner', undefined, undefined),
    canReadSession: () => true,
    readAssistantTurn: read,
    seedProposalBrief: (input) => room.seedProposalBrief(input),
  });
  const accept = (changes: Partial<typeof input> & { agentId?: string } = {}) =>
    app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, ...changes }),
    });
  return {
    directory,
    service,
    read,
    accept,
    room,
    working,
    revoke: () => {
      current = false;
    },
  };
}

test('acceptance durably commits the brief and first Session link, and retries keep one Task', async () => {
  const { directory, service, accept, read, room, working } = await fixture();
  expect(service.listTasks()).toEqual([]);
  const response = await accept();
  expect(response.status, await response.text()).toBe(201);
  expect(read).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'shaping-session',
      turnId: 'shaping-turn',
    }),
  );
  const reopened = new TaskGraphService(directory);
  const [task] = reopened.listTasks();
  expect(task).toMatchObject({
    title: 'Installer progress',
    description: 'Show progress.',
  });
  expect(task.sessionId).toBeUndefined();
  expect(task.agentId).toBeUndefined();
  expect(reopened.readSessionRelations('shaping-session').links).toEqual([
    expect.objectContaining({
      sourceId: task.id,
      targetId: 'shaping-session',
      relationType: 'spawned_session',
      source: 'user',
      metadata: { shapingTurnId: 'shaping-turn', proposalBriefSaved: true },
    }),
  ]);
  const request = new Request('http://station.test');
  expect(await room.document({ taskId: task.id, request })).toMatchObject({
    text: brief,
  });
  expect(working.settle.mock.calls[0][0].operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        actor: {
          actorId: `human:${createHash('sha256').update('owner\0device').digest('hex')}`,
          kind: 'human',
        },
      }),
    ]),
  );
  const edit = await room.editPlan({
    taskId: task.id,
    request,
    intentId: 'later-edit',
    desiredText: 'A later human edit',
    selection: { anchor: 0, focus: 0 },
  });
  if (edit.kind !== 'planned') throw new Error('Expected a plan');
  expect(
    await room.submitBatch({
      taskId: task.id,
      request,
      intentId: edit.intentId,
      intentDigest: edit.digest,
    }),
  ).toMatchObject({ kind: 'committed' });
  expect((await accept()).status).toBe(201);
  expect(await room.document({ taskId: task.id, request })).toMatchObject({
    text: 'A later human edit',
  });
  expect(reopened.listTasks()).toHaveLength(1);
});

test.each([
  { status: 'not-found' },
  { status: 'unavailable' },
  {
    status: 'found',
    sessionId: 'shaping-session',
    turnId: 'shaping-turn',
    projectSlug: 'other-project',
    message: { id: 'answer', role: 'assistant', parts: [] },
  },
] satisfies SessionAssistantTurnQueryOutcome[])(
  'refuses an unreadable or out-of-project shaping source: $status',
  async (outcome) => {
    const { service, accept } = await fixture(outcome);
    expect((await accept()).status).toBe(
      outcome.status === 'unavailable' ? 503 : 404,
    );
    expect(service.listTasks()).toEqual([]);
    expect(service.readSessionRelations('shaping-session').links).toEqual([]);
  },
);

test('revoking source access during workspace capture commits neither Task nor link', async () => {
  const directory = temp('station-proposal-revoked-');
  let current = true;
  const service = new TaskGraphService(directory, {
    projectService: {
      getProject: () => {
        current = false;
        return {
          id: 'alpha',
          slug: 'alpha',
          name: 'Alpha',
          workingDirectory: directory,
          createdAt: '2026-10-15T00:00:00Z',
          updatedAt: '2026-10-15T00:00:00Z',
        };
      },
    },
  });
  await expect(
    service.createTask(input, undefined, undefined, () => current),
  ).rejects.toThrow('Shaping source is no longer available');
  expect(new TaskGraphService(directory).listTasks()).toEqual([]);
  expect(service.readSessionRelations('shaping-session').links).toEqual([]);
});

test('a failed document write reports recoverable creation and retry seeds the same Task', async () => {
  const { working, service, accept, room } = await fixture();
  const fault = vi
    .spyOn(working, 'settle')
    .mockResolvedValueOnce({ kind: 'unavailable' });
  const failed = await accept();
  expect(failed.status).toBe(503);
  expect(await failed.json()).toMatchObject({
    error: expect.stringContaining(
      'Task created, but its brief could not be saved',
    ),
  });
  const [task] = service.listTasks();
  expect(task.description).toBe('Show progress.');
  expect(
    service.readSessionRelations('shaping-session').links[0].metadata
      ?.proposalBriefSaved,
  ).toBeUndefined();
  fault.mockRestore();
  expect((await accept()).status).toBe(201);
  expect(service.listTasks().map((task) => task.id)).toEqual([task.id]);
  expect(
    await room.document({
      taskId: task.id,
      request: new Request('http://station.test'),
    }),
  ).toMatchObject({ text: brief });
});
test('document authority loss reports a recoverable failure without writing under another principal', async () => {
  const { revoke, service, accept, working } = await fixture();
  revoke();
  const settle = vi.spyOn(working, 'settle');
  expect((await accept()).status).toBe(503);
  expect(service.listTasks()).toHaveLength(1);
  expect(settle).not.toHaveBeenCalled();
});

test('accepted proposals remain unassigned work and reconciliation publishes no agent activity', async () => {
  const { service, accept, room } = await fixture();
  expect((await accept()).status).toBe(201);
  const [task] = service.listTasks();
  expect(task.sessionId).toBeUndefined();
  expect(task.agentId).toBeUndefined();
  await room.reconcileAgentLifecycles([task.id]);
  const history = await room.history({
    taskId: task.id,
    request: new Request('http://station.test'),
  });
  expect(history.kind).toBe('available');
  if (history.kind !== 'available')
    throw new Error('Expected readable history');
  expect(
    history.records.filter(
      (record) => record.body.kind === 'live-work-started',
    ),
  ).toEqual([]);
});

test('concurrent acceptance saves one brief and both callers succeed', async () => {
  const { accept, room, service } = await fixture();
  // Both plans observe the empty document before either submission commits.
  const submit = room.submitBatch.bind(room);
  let release!: () => void;
  const bothPlanned = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrivals = 0;
  vi.spyOn(room, 'submitBatch').mockImplementation(async (input) => {
    if (++arrivals === 2) release();
    await bothPlanned;
    return submit(input);
  });
  const responses = await Promise.all([accept(), accept()]);
  expect(responses.map((response) => response.status)).toEqual([201, 201]);
  expect(service.listTasks()).toHaveLength(1);
  expect(
    await room.document({
      taskId: service.listTasks()[0].id,
      request: new Request('http://station.test'),
    }),
  ).toMatchObject({ text: brief });
});

test.each([
  { title: 'Invented title' },
  { description: 'Invented goal' },
  { proposalBrief: 'Invented brief' },
])(
  'rejects client proposal edits before creating any Task: %j',
  async (changes) => {
    const { accept, service } = await fixture();
    expect((await accept(changes)).status).toBe(409);
    expect(service.listTasks()).toEqual([]);
  },
);

test('a readable ordinary answer cannot attest a proposal', async () => {
  const { read, accept, service } = await fixture();
  read.mockResolvedValue({
    status: 'found',
    sessionId: 'shaping-session',
    turnId: 'shaping-turn',
    projectSlug: 'alpha',
    message: {
      id: 'ordinary',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Plain answer' }],
    },
  });
  expect((await accept()).status).toBe(409);
  expect(service.listTasks()).toEqual([]);
});

test('rejects an assigned agent on proposal acceptance without creating a Task', async () => {
  const { accept, service } = await fixture();
  const response = await accept({ agentId: 'station' });
  expect(response.status).toBe(409);
  expect(service.listTasks()).toEqual([]);
  expect(service.readSessionRelations('shaping-session').links).toEqual([]);
});
