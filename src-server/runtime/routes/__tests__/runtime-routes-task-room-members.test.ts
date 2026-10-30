import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  humanPrincipal,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { KnowledgeStoreProvider } from '../../../knowledge-store/knowledge-store-provider.js';
import { createApplicationSessionRuntime } from '../../../services/identity/application-session-runtime.js';
import { deploymentAccountPrincipal } from '../../../services/identity/deployment-authentication-service.js';
import { loadLocalAccounts } from '../../../services/identity/local-account-runtime.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { ProjectManifestStore } from '../../../services/projects/project-manifest-store.js';
import { createProjectMembershipRuntime } from '../../../services/projects/project-membership-runtime.js';
import { ProjectService } from '../../../services/projects/project-service.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

vi.mock('../runtime-route-support.js', () => {
  const stub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: () => ({
      schedulerService: stub,
      notificationService: stub,
      attentionProjection: stub,
      webPushService: stub,
      webPushEnabled: false,
    }),
    createRuntimeSystemRouteDeps: () => stub,
  };
});

function deepCallable(): unknown {
  return new Proxy(() => undefined, {
    get: (_target, property) =>
      property === 'then' ? undefined : deepCallable(),
    apply: () => deepCallable(),
  });
}
function deepStub<T extends object>(overrides: T): T {
  return new Proxy(overrides, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : deepCallable(),
  });
}

const makeTempDir = trackTempDirs();
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const origin = 'https://station.example.test';
const stationId = 'room-members-fixture';
const operator = humanPrincipal('fixture', 'operator', 'Operator');
const authority = {
  current: async () => ({ principal: operator, verifiedEmails: [] }),
  operator: async () => {},
};

async function fixture() {
  const root = makeTempDir('task-room-members-');
  const home = join(root, 'data');
  mkdirSync(join(home, 'security'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'home'));
  mkdirSync(join(root, 'root'));
  vi.stubEnv('STATION_HOME', join(root, 'home'));
  vi.stubEnv('STATION_ROOT', join(root, 'root'));
  vi.stubEnv('ALLOWED_ORIGINS', origin);
  const security = new EnvironmentSecurityService({ homeDir: home });
  await security.initialize();
  const storage = new FileStorageAdapter(home);
  const manifests = new ProjectManifestStore(home, storage);
  const projects = new ProjectService(storage, manifests);
  const membership = createProjectMembershipRuntime(home, stationId, storage);
  closers.push(() => membership.close());
  const accounts = await loadLocalAccounts(
    { publicOrigin: origin },
    { stationId, homeDirectory: home },
    membership.service,
  );
  closers.push(() => accounts.service.close());
  const applicationSessions = createApplicationSessionRuntime(
    home,
    stationId,
    accounts,
    (value) => security.devicePairing.identifyDevice(value),
  );
  if (applicationSessions) closers.push(() => applicationSessions.close());
  const store = new EventStore(join(home, 'orchestration.sqlite'));
  closers.push(() => {
    store.close();
  });
  const graph = new TaskGraphService(home, {
    resolveProjectWorkspace: () => undefined,
  });
  const app = new Hono();
  const context = deepStub({
    app,
    port: 4321,
    host: '127.0.0.1',
    appConfig: {},
    configLoader: {
      getProjectHomeDir: () => home,
      loadAppConfig: async () => ({}),
      mutateAppConfig: async (mutate: (value: object) => object) => mutate({}),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    projectMembership: membership.service,
    projectSharedTasks: membership.sharedTasks,
    deploymentAuthentication: accounts,
    localAccounts: accounts,
    applicationSessions,
    storageAdapter: storage,
    knowledgeStoreProvider: new KnowledgeStoreProvider(storage),
    projectService: projects,
    taskGraphService: graph,
    orchestrationEventStore: store,
    environmentSecurityService: security,
    eventBus: new EventBus(),
    activeAgents: new Map(),
    agentMetadataMap: new Map(),
    agentFixedTokens: new Map(),
    agentTools: new Map(),
    agentStats: new Map(),
    agentStatus: new Map(),
    memoryAdapters: new Map(),
    metricsLog: [],
    monitoringEvents: [],
  });
  Reflect.set(context, 'buildRuntimeContext', () => context);
  const runtime = configureRuntimeRoutes(
    context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
  );
  await runtime.kitLifecycleReady;
  closers.push(async () => {
    await runtime.projectTaskRoomRuntime?.close();
    await runtime.projectRoomRuntime.close();
  });
  const project = await projects.createProject({
    name: 'Review Project',
    slug: 'review-project',
  });
  const { scope } = await membership.service.enable(
    project.slug,
    project.id,
    authority,
  );
  const task = await graph.createTask({
    projectId: project.id,
    title: 'Shared task',
  });
  const privateTask = await graph.createTask({
    projectId: project.id,
    title: 'Unshared task',
  });
  membership.sharedTasks.share({
    scope,
    taskId: task.id,
    taskCreatedAt: task.createdAt,
    sharedBy: operator.id,
  });
  const people: Array<{
    name: string;
    principal: PrincipalRef;
    cookie: string;
    credential: string;
  }> = [];
  for (const [username, name] of [
    ['roomalice', 'Alice'],
    ['roombob', 'Bob'],
  ] as const) {
    const invitation = await membership.service.invite(
      scope,
      {
        email: null,
        role: 'contributor',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      authority,
    );
    const credentials = { username, password: 'Room fixture password 12345' };
    const signup = await accounts.service.handle(
      new Request(`${origin}/api/account-auth/sign-up/username`, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'x-station-invitation': invitation.token,
        },
        body: JSON.stringify({ ...credentials, name }),
      }),
      '/sign-up/username',
    );
    expect(signup.status, await signup.clone().text()).toBe(200);
    const login = await accounts.service.handle(
      new Request(`${origin}/api/account-auth/sign-in/username`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      }),
      '/sign-in/username',
    );
    expect(login.status, await login.clone().text()).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const authenticated = await accounts.service.authenticate(
      new Request(origin, { headers: { Cookie: cookie } }),
    );
    if (authenticated.kind !== 'authenticated')
      throw new Error(`local login: ${authenticated.kind}`);
    await membership.service.accept(invitation.token, {
      current: async () => ({
        principal: authenticated.principal,
        verifiedEmails: [],
      }),
      operator: async () => {},
    });
    const pairing = security.devicePairing;
    const offer = pairing.createOffer({
      endpoint: origin,
      scope: 'orchestration:read orchestration:operate',
    });
    const pending = pairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: name,
      requesterPosition: 'unproven',
      source: 'same-origin',
      accountCandidate: {
        issuer: accounts.service.describe().issuer,
        subject: authenticated.session.subject,
        displayName: name,
      },
      accountCandidateSessionId: 'candidate-proof',
      requireAccountBinding: true,
    });
    pairing.confirmRequest(
      pending.requestId,
      { kind: 'presented-credential' },
      {
        principalId: deploymentAccountPrincipal(
          accounts.service.describe().issuer,
          authenticated.session.subject,
          name,
        ).id,
        kind: 'account',
      },
    );
    const paired = pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pending.requestId,
    });
    people.push({
      name,
      principal: authenticated.principal,
      cookie,
      credential: paired.credential,
    });
  }
  const request = (
    person: (typeof people)[number],
    path: string,
    init: RequestInit = {},
  ) =>
    app.request(`${origin}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${person.credential}`,
        Cookie: person.cookie,
        Origin: origin,
        ...(init.headers ?? {}),
      },
    });
  return {
    app,
    runtime,
    membership,
    security,
    scope,
    task,
    privateTask,
    people,
    request,
  };
}

function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  timeoutMs: number,
) {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`SSE did not reach ${needle} within ${timeoutMs}ms`)),
      timeoutMs,
    );
    const decoder = new TextDecoder();
    let output = '';
    const read = async () => {
      try {
        while (!output.includes(needle)) {
          const next = await reader.read();
          if (next.done)
            throw new Error(`SSE ended before ${needle}: ${output}`);
          output += decoder.decode(next.value, { stream: true });
        }
        clearTimeout(timer);
        resolve(output);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    };
    void read();
  });
}

async function openStream(
  f: Awaited<ReturnType<typeof fixture>>,
  person: Awaited<ReturnType<typeof fixture>>['people'][number],
) {
  const abort = new AbortController();
  const response = await f.request(
    person,
    `/api/tasks/${f.task.id}/room/events`,
    { signal: abort.signal },
  );
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  await readUntil(reader, 'event: snapshot', 5000);
  return { reader, abort };
}

test('shared room names both accounts, refuses a viewer post and closes on revocation', async () => {
  const f = await fixture();
  const [alice, bob] = f.people;
  const base = `/api/tasks/${f.task.id}/room`;
  const opened = await f.request(alice!, base);
  expect(opened.status, await opened.clone().text()).toBe(200);
  for (const person of [alice!, bob!]) {
    const result = await f.request(person, `${base}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId: `message-${person.name}`,
        text: `From ${person.name}`,
      }),
    });
    expect(result.status, await result.clone().text()).toBe(200);
    for (const command of ['join', 'announce']) {
      const live = await f.request(person, `${base}/live`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      expect(live.status, await live.clone().text()).toBe(200);
      const payload = (await live.json()) as {
        data: {
          result: { outcome: string };
          snapshot: { participants: unknown[] };
        };
      };
      expect(payload.data.result.outcome).toBe(
        command === 'join' ? 'joined' : 'updated',
      );
      if (command === 'announce')
        expect(payload.data.snapshot.participants).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              actor: expect.objectContaining({
                label: person.name,
                standing: 'member',
              }),
              publication: 'published',
            }),
          ]),
        );
    }
  }
  const planDocument = (person: (typeof f.people)[number]) =>
    f.request(person, `${base}/edit-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intentId: `large-plan-${person.name}`,
        desiredText: 'a'.repeat(12_000),
        selection: { anchor: 0, focus: 0 },
      }),
    });
  const contributorPlan = await planDocument(bob!);
  expect(contributorPlan.status, await contributorPlan.clone().text()).toBe(
    200,
  );
  const planned = (await contributorPlan.json()) as {
    data: {
      kind: string;
      intentId: string;
      digest: string;
      operationCount: number;
    };
  };
  expect(planned.data).toMatchObject({
    kind: 'planned',
    intentId: expect.any(String),
    digest: expect.any(String),
  });
  expect(planned.data.operationCount).toBeGreaterThan(0);
  const settlement = await f.request(bob!, `${base}/batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intentId: planned.data.intentId,
      intentDigest: planned.data.digest,
    }),
  });
  expect(settlement.status).toBe(403);
  const stream = await openStream(f, bob!);
  try {
    await readUntil(stream.reader, 'event: ping', 20000);
    await f.membership.service.changeMember(
      f.scope,
      bob!.principal.id,
      1,
      { role: 'viewer', status: 'active' },
      authority,
    );
    expect(await readUntil(stream.reader, 'event: terminal', 5000)).toContain(
      'event: terminal',
    );
  } finally {
    stream.abort.abort();
    await stream.reader.cancel();
  }
  for (const person of [alice!, bob!]) {
    const history = await f.request(person, `${base}/history`);
    expect(history.status, await history.clone().text()).toBe(200);
    const body = (await history.json()) as {
      data: {
        records: Array<{ actor: { label: string }; body: { text?: string } }>;
      };
    };
    expect(
      body.data.records
        .filter((record) => record.body.text?.startsWith('From '))
        .map((record) => record.actor.label),
    ).toEqual(['Alice', 'Bob']);
  }
  const refused = await f.request(bob!, `${base}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposalId: 'viewer-post', text: 'Not allowed' }),
  });
  expect(refused.status).toBe(404);
  expect((await planDocument(bob!)).status).toBe(404);
  const viewerRoom = await f.request(bob!, base);
  const viewerPayload = (await viewerRoom.json()) as {
    data: { capabilities: Record<string, boolean> };
  };
  expect(viewerPayload.data.capabilities).toMatchObject({
    messageWrite: false,
    documentWrite: false,
  });
  expect(
    (await f.request(bob!, `/api/tasks/${f.privateTask.id}/room`)).status,
  ).toBe(404);
  const revokedStream = await openStream(f, bob!);
  try {
    await f.membership.service.changeMember(
      f.scope,
      bob!.principal.id,
      2,
      { role: 'viewer', status: 'revoked' },
      authority,
    );
    expect(
      await readUntil(revokedStream.reader, 'event: terminal', 5000),
    ).toContain('event: terminal');
  } finally {
    revokedStream.abort.abort();
    await revokedStream.reader.cancel();
  }
  expect((await planDocument(bob!)).status).toBe(404);
  const aliceDevice = f.security.identifyDevice(alice!.credential);
  if (!aliceDevice) throw new Error('expected paired Alice device');
  f.security.devicePairing.setDeviceScope(
    aliceDevice.id,
    ['orchestration:read'],
    { kind: 'presented-credential' },
  );
  const readOnlyRoom = await f.request(alice!, base);
  const readOnlyPayload = (await readOnlyRoom.json()) as {
    data: { capabilities: Record<string, boolean> };
  };
  expect(readOnlyPayload.data.capabilities).toMatchObject({
    messageWrite: false,
    documentWrite: false,
  });
}, 60000);

test('idle room recheck closes a revoked reader when membership subscription is absent', async () => {
  const f = await fixture();
  const bob = f.people[1]!;
  const opened = await f.request(bob, `/api/tasks/${f.task.id}/room`);
  expect(opened.status, await opened.clone().text()).toBe(200);
  vi.spyOn(f.membership.service, 'subscribe').mockImplementation(
    () => () => {},
  );
  const stream = await openStream(f, bob);
  try {
    await readUntil(stream.reader, 'event: ping', 20000);
    const started = performance.now();
    await f.membership.service.changeMember(
      f.scope,
      bob.principal.id,
      1,
      { role: 'contributor', status: 'revoked' },
      authority,
    );
    expect(await readUntil(stream.reader, 'event: terminal', 20000)).toContain(
      'event: terminal',
    );
    expect(performance.now() - started).toBeGreaterThan(5000);
  } finally {
    stream.abort.abort();
    await stream.reader.cancel();
  }
}, 60000);
