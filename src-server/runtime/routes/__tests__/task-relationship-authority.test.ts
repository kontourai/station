import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { createTaskRelationshipRoutes } from '../../../routes/orchestration/task-relationships.js';
import { DeploymentAuthenticationService } from '../../../services/identity/deployment-authentication-service.js';
import { createLocalAccountProvider } from '../../../services/identity/local-account-provider.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import { createTaskRelationshipAuthority } from '../task-relationship-authority.js';

const temp = trackTempDirs();
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
async function fixture(current: () => boolean = () => true) {
  const home = temp('relationship-authority-');
  const storage = new FileStorageAdapter(home);
  const project = {
    id: 'project-id',
    slug: 'project',
    name: 'Project',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
  await storage.createProject(project);
  await storage.createProject({
    ...project,
    id: 'foreign-id',
    slug: 'foreign',
  });
  const graph = new TaskGraphService(home, {
    resolveProjectWorkspace: () => undefined,
  });
  const task = await graph.createTask({
    projectId: project.id,
    title: 'Outcome',
  });
  const store = new EventStore(join(home, 'events.sqlite'));
  const sessions = new OrchestrationService({
    eventStore: store,
    eventBus: new EventBus(),
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    logger: { debug() {}, warn() {} },
  } as never);
  sessions.initialize();
  closers.push(async () => {
    await sessions.shutdown();
    store.close();
  });
  const seed = (id: string, owner = 'owner', slug = project.slug) => {
    store.upsertSession({
      provider: 'claude',
      threadId: id,
      status: 'closed',
      createdAt: project.createdAt,
      updatedAt: project.createdAt,
    });
    store.appendEvent({
      eventId: `${id}-start`,
      threadId: id,
      sessionId: id,
      provider: 'claude',
      method: 'session.started',
      createdAt: project.createdAt,
      metadata: { userId: owner, projectSlug: slug, agentSlug: 'station' },
    });
  };
  seed('chat');
  seed('private', 'other');
  seed('cross-project', 'owner', 'foreign');
  let live = true;
  const adapters = createTaskRelationshipAuthority({
    graph,
    projects: () =>
      storage.listProjects().map((p) => storage.getProject(p.slug)),
    sessions,
    events: store,
    readAuthority: (request) =>
      sessionReadAuthorityFromRequest(
        request.headers.get('principal') ?? 'owner',
        undefined,
        undefined,
      ),
    current: () => live && current(),
    mayRead: () => live,
    mayEdit: () => live,
  });
  const app = new Hono().route(
    '/api/tasks',
    createTaskRelationshipRoutes(graph, adapters),
  );
  const input = (id: string) => ({
    operationId: `link-${id}`,
    task: { taskId: task.id, taskCreatedAt: task.createdAt },
    conversationId: id,
    expectedRevision: 0,
  });
  const link = (id: string) =>
    app.request(`/api/tasks/${task.id}/work-chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input(id)),
    });
  const list = (principal = 'owner') =>
    app.request(
      `/api/tasks/${task.id}/work-chats?taskCreatedAt=${encodeURIComponent(task.createdAt)}`,
      { headers: { principal } },
    );
  return {
    home,
    storage,
    project,
    graph,
    task,
    store,
    sessions,
    seed,
    adapters,
    app,
    link,
    list,
    revoke: () => {
      live = false;
    },
  };
}

test('mounted composition uses real Conversation open/read authority, prepares linked targets, and hides another principal or Project', async () => {
  const h = await fixture();
  expect((await h.link('chat')).status).toBe(200);
  const before = readFileSync(join(h.home, 'task-graph.json'), 'utf8');
  expect((await h.link('private')).status).toBe(404);
  expect((await h.link('cross-project')).status).toBe(404);
  expect(readFileSync(join(h.home, 'task-graph.json'), 'utf8')).toBe(before);
  expect((await (await h.list()).json()).data.chats).toEqual([
    { conversationId: 'chat', revision: 1 },
  ]);
  expect((await (await h.list('other')).json()).data.chats).toEqual([]);
  h.store.reserveNextConversationSession({
    conversationId: 'chat',
    predecessorSessionId: 'chat',
    proposedSessionId: 'child',
    createdAt: '2026-10-02T00:00:00.000Z',
  });
  h.seed('child');
  expect((await h.link('child')).status).toBe(404);
});

test.each([
  'revocation',
  'lineage',
  'project replacement',
  'cross-project reconfiguration',
])(
  'mounted lock-wait %s denies without mutating the real graph',
  async (kind) => {
    const h = await fixture();
    const path = join(h.home, 'task-graph.json');
    const before = readFileSync(path, 'utf8');
    const release = await acquireFileMutationLockAsync(`${path}.mutation`);
    let prepared = false;
    const original = h.adapters.authorityForRequest;
    h.adapters.authorityForRequest = async (...args) => {
      const result = await original(...args);
      prepared = true;
      return result;
    };
    const pending = h.link('chat');
    try {
      await vi.waitFor(() => expect(prepared).toBe(true));
      if (kind === 'revocation') h.revoke();
      if (kind === 'lineage') {
        h.store.reserveNextConversationSession({
          conversationId: 'chat',
          predecessorSessionId: 'chat',
          proposedSessionId: 'changed',
          createdAt: '2026-10-02T00:00:00.000Z',
        });
        h.seed('changed');
      }
      if (kind === 'project replacement')
        await h.storage
          .projectRevision(h.project.slug)
          .replace({ ...h.project, createdAt: '2026-10-02T00:00:00.000Z' });
      if (kind === 'cross-project reconfiguration')
        h.store.appendEvent({
          eventId: 'reconfigure',
          threadId: 'chat',
          sessionId: 'chat',
          provider: 'claude',
          method: 'session.configured',
          createdAt: '2026-10-02T00:00:00.000Z',
          metadata: { projectSlug: 'foreign' },
        });
    } finally {
      await release();
    }
    expect((await pending).status).toBe(404);
    expect(readFileSync(path, 'utf8')).toBe(before);
  },
);

test.each([
  'session revoke',
  'account disable',
  'cookie switch',
  'account switch',
])(
  'real local-account %s during graph lock wait refuses the captured authority',
  async (change) => {
    const stateDirectory = temp('relationship-local-account-');
    const origin = 'https://relationship.example.test';
    const provider = await createLocalAccountProvider(
      {
        stationId: 'relationship-test',
        publicOrigin: origin,
        basePath: '/api/account-auth',
        stateDirectory,
      },
      'a'.repeat(64),
      { mayRegister: async () => true, deliver: async () => {} },
      'username-password',
    );
    const service = new DeploymentAuthenticationService(provider);
    closers.push(() => service.close());
    const credentials = [];
    for (const username of ['lockalice', 'lockbob']) {
      const post = (path: string) =>
        service.handle(
          new Request(`${origin}/api/account-auth${path}`, {
            method: 'POST',
            headers: {
              Origin: origin,
              'Content-Type': 'application/json',
              'x-station-invitation': 'valid-invitation',
            },
            body: JSON.stringify({
              username,
              password: 'Relationship password 12345',
            }),
          }),
          path,
        );
      expect((await post('/sign-up/username')).status).toBe(200);
      const login = await post('/sign-in/username');
      expect(login.status).toBe(200);
      credentials.push(
        login.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; '),
      );
    }
    const request = new Request(`${origin}/api/tasks/read`, {
      headers: { Cookie: credentials[0]! },
    });
    const authenticated = await service.authenticate(request);
    if (authenticated.kind !== 'authenticated')
      throw new Error('Missing real local account session');
    const current = service.captureCurrentSession(request);
    expect(current()).toBe(true);
    const h = await fixture(current);
    const path = join(h.home, 'task-graph.json');
    const before = readFileSync(path, 'utf8');
    const release = await acquireFileMutationLockAsync(`${path}.mutation`);
    let prepared = false;
    const original = h.adapters.authorityForRequest;
    h.adapters.authorityForRequest = async (...args) => {
      const result = await original(...args);
      prepared = true;
      return result;
    };
    const pending = h.link('chat');
    try {
      await vi.waitFor(() => expect(prepared).toBe(true));
      if (change === 'session revoke')
        await service.revokeSessionReference(
          authenticated.session.sessionId,
          request.signal,
        );
      if (change === 'account disable')
        provider.administration.setDisabled(
          authenticated.session.subject,
          true,
        );
      if (change === 'cookie switch' || change === 'account switch')
        request.headers.set('Cookie', credentials[1]!);
      if (change === 'account switch')
        expect((await service.authenticate(request)).kind).toBe(
          'authenticated',
        );
      expect(current()).toBe(false);
    } finally {
      await release();
    }
    expect((await pending).status).toBe(404);
    expect(readFileSync(path, 'utf8')).toBe(before);
  },
);
