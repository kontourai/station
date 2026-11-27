import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
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
import { GitReviewWorkspaceSource } from '../../../services/evidence/git-review-workspace-source.js';
import { ReviewEvidenceModule } from '../../../services/evidence/review-evidence-module.js';
import { FileReviewReceiptStore } from '../../../services/evidence/review-receipt-store.js';
import { FeaturePreviewRegistry } from '../../../services/feature-previews/feature-preview-registry.js';
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
import { execGit } from '../../../utils/git-exec.js';
import { createLogger } from '../../../utils/logger.js';
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

async function fixture(
  options: {
    codeReviewCheckout?: boolean;
    legacyConversationRead?: () => Promise<unknown[]>;
  } = {},
) {
  const root = realpathSync(makeTempDir('task-room-members-'));
  const home = join(root, 'data');
  mkdirSync(join(home, 'security'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'home'));
  mkdirSync(join(root, 'root'));
  vi.stubEnv('STATION_HOME', join(root, 'home'));
  vi.stubEnv('STATION_ROOT', join(root, 'root'));
  vi.stubEnv('ALLOWED_ORIGINS', origin);
  const security = new EnvironmentSecurityService({ homeDir: home });
  const { credential: operatorCredential } = await security.initialize();
  const logger = createLogger({
    name: 'task-room-members-test',
    level: 'error',
  });
  const featurePreviews = new FeaturePreviewRegistry(home, logger);
  await featurePreviews.setEnabled('task-review', true);
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  const git = async (...args: string[]) =>
    (await execGit(args, { cwd: checkout, timeout: 5000 })).stdout.trim();
  await git('init', '-b', 'main');
  let base: string | undefined;
  let head: string | undefined;
  if (options.codeReviewCheckout) {
    await git('config', 'user.name', 'Room fixture');
    await git('config', 'user.email', 'room@example.test');
    writeFileSync(join(checkout, 'work.txt'), 'Task source\n');
    await git('add', 'work.txt');
    await git('commit', '-m', 'Task source');
    base = await git('rev-parse', 'HEAD');
    writeFileSync(join(checkout, 'work.txt'), 'Task review change\n');
    await git('commit', '-am', 'Task review change');
    head = await git('rev-parse', 'HEAD');
  }
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
    resolveProjectWorkspace: () => checkout,
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
    logger,
    featurePreviews,
    agentService: deepStub({ listAgents: async () => [] }),
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
    memoryAdapters: new Map(
      options.legacyConversationRead
        ? [['legacy', { queryConversations: options.legacyConversationRead }]]
        : [],
    ),
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
    workingDirectory: checkout,
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
  const publication = membership.sharedTasks.share({
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
    project,
    checkout,
    base,
    head,
    operatorCredential,
    home,
    scope,
    task,
    privateTask,
    publication,
    people,
    request,
    graph,
    featurePreviews,
  };
}

test('an account contributor with current shared Task access cannot resume it (#4554)', async () => {
  const f = await fixture();
  await f.featurePreviews.setEnabled('task-resume', true);
  const { task } = await f.graph.createTaskForWorkItem(
    {
      projectId: f.task.projectId,
      title: 'Ended tracker Task',
      workItemRef: 'github:example/widgets#42',
    },
    '2026-11-01T00:00:00.000Z',
  );
  await f.graph.updateTaskStatus(task.id, 'in_progress');
  await f.graph.updateTaskStatus(task.id, 'done');
  const done = f.graph.readTask(task.id)!;
  f.membership.sharedTasks.share({
    scope: f.scope,
    taskId: done.id,
    taskCreatedAt: done.createdAt,
    sharedBy: operator.id,
  });
  const member = f.people[0]!;
  const read = await f.request(member, `/api/tasks/${done.id}/room`);
  expect(read.status, await read.clone().text()).toBe(200);
  for (const method of ['GET', 'POST']) {
    const response = await f.request(member, `/api/tasks/${done.id}/resume`, {
      method,
      ...(method === 'POST'
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              resumeId: 'member-resume',
              expectedCreatedAt: done.createdAt,
              expectedEndedAt: done.endedAt,
              reason: 'A contributor asks for more work',
            }),
          }
        : {}),
    });
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'account_bound_device_route_forbidden' },
    });
  }
  expect(f.graph.readTask(done.id)).toEqual(done);
});

test('legacy Project conversations stay unavailable without reading unbound records', async () => {
  const legacyRead = vi.fn(async () => [
    { id: 'unbound-conversation', title: 'Private legacy conversation' },
  ]);
  const f = await fixture({ legacyConversationRead: legacyRead });
  const member = f.people[0]!;
  const base = `/api/projects/${f.project.slug}`;
  expect((await f.request(member, base)).status).toBe(200);
  const path = `${base}/conversations`;
  const accountBoundDevice = await f.request(member, path);
  expect(accountBoundDevice.status).toBe(403);

  const operatorHeaders = {
    Authorization: `Bearer ${f.operatorCredential}`,
  };
  expect(
    (await f.app.request(`${origin}${base}`, { headers: operatorHeaders }))
      .status,
  ).toBe(200);
  const response = await f.app.request(`${origin}${path}`, {
    headers: operatorHeaders,
  });
  expect(response.status, await response.clone().text()).toBe(503);
  expect(await response.json()).toMatchObject({
    success: false,
    code: 'project_conversations_unavailable',
    error: 'Project conversation history is unavailable',
  });
  expect(legacyRead).not.toHaveBeenCalled();
});

test('Project readers hide Task reviews from members while preserving ordinary Project evidence', async () => {
  const f = await fixture({ codeReviewCheckout: true });
  if (!f.checkout || !f.base || !f.head)
    throw new Error('Missing real review checkout');
  const store = new FileReviewReceiptStore(
    { workspace: () => f.checkout },
    { coordinationDirectory: join(f.home, '.review-evidence-coordination') },
  );
  const execute = vi.fn(async () => ({
    kind: 'completed' as const,
    workspaceRelease: 'safe' as const,
    output: {
      findings: [
        {
          location: { file: 'work.txt', line: 1 },
          scenario: {
            stateOrInput: 'Task-only review source',
            wrongOutcome: 'Private Task findings reach a Project member',
          },
          severity: 'high',
          confidence: 'high',
          basis: 'reasoned-from-code',
          summary: 'Task-only finding sentinel.',
        },
      ],
      deltaAssessments: [],
    },
  }));
  const reviews = new ReviewEvidenceModule({
    source: new GitReviewWorkspaceSource(
      { workspace: () => f.checkout },
      join(f.home, 'controlled-review-workspaces'),
    ),
    receipts: store,
    submissions: store,
    executor: {
      workspaceAccess: 'read-only',
      execute,
    },
    principals: {
      resolveAgent: async (slug) => ({ actorId: `agent:${slug}` }),
    },
    observer: { record() {}, diagnostic() {} },
  });
  const receipts = [];
  for (const kind of ['task', 'project']) {
    const result = await reviews.run(
      {
        requestId: `${kind}-review`,
        mode: 'initial',
        target: {
          kind: 'git-range',
          projectSlug: f.project.slug,
          baseRevision: f.base,
          headRevision: f.head,
        },
        implementerAgentSlug: 'implementer',
        reviewers: [
          {
            reviewerId: 'reviewer',
            executorAgentSlug: 'reviewer',
            lens: {
              id: 'correctness',
              instructions: 'Inspect controlled fixture source.',
            },
          },
        ],
      },
      {
        requestedBy: { actorId: operator.id },
        ...(kind === 'task'
          ? {
              taskBinding: {
                projectId: f.project.id,
                projectCreatedAt: f.project.createdAt,
                taskId: f.task.id,
                taskCreatedAt: f.task.createdAt,
              },
            }
          : {}),
      },
    );
    expect(result.state).toBe('completed');
    if (!result.result) throw new Error('Controlled reviewer did not publish');
    receipts.push(result.result.receipt);
  }
  const request = (path: string, member: boolean) =>
    f.app.request(`${origin}${path}`, {
      headers: {
        Authorization: `Bearer ${f.operatorCredential}`,
        Origin: origin,
        ...(member ? { Cookie: f.people[0]!.cookie } : {}),
      },
    });
  const base = `/api/projects/${f.project.slug}/reviews`;
  const operatorList = await request(base, false);
  expect(operatorList.status, await operatorList.clone().text()).toBe(200);
  const operatorPayload = (await operatorList.json()) as {
    data: Array<{ requestId: string }>;
  };
  expect(operatorPayload.data).toHaveLength(2);
  const memberList = await request(base, true);
  expect(memberList.status, await memberList.clone().text()).toBe(200);
  const memberPayload = (await memberList.json()) as {
    data: Array<{ requestId: string }>;
  };
  expect(
    memberPayload.data.map((entry: { requestId: string }) => entry.requestId),
  ).toEqual(['project-review']);
  for (const receipt of receipts) {
    for (const path of [
      `${base}/${receipt.receiptId}`,
      `${base}/requests/${receipt.requestId}`,
    ]) {
      const response = await request(path, true);
      expect(response.status, await response.clone().text()).toBe(
        receipt.requestId === 'task-review' ? 404 : 200,
      );
    }
  }
  const aggregate = await request('/api/review-evidence', true);
  expect(aggregate.status, await aggregate.clone().text()).toBe(200);
  const aggregatePayload = (await aggregate.json()) as {
    data: { receipts: Array<{ requestId: string }> };
  };
  expect(
    aggregatePayload.data.receipts.map(
      (entry: { requestId: string }) => entry.requestId,
    ),
  ).toEqual(['project-review']);
  writeFileSync(join(f.checkout, 'work.txt'), 'Next review change\n');
  await execGit(['commit', '-am', 'Next review change'], {
    cwd: f.checkout,
    timeout: 5000,
  });
  const head = (
    await execGit(['rev-parse', 'HEAD'], { cwd: f.checkout, timeout: 5000 })
  ).stdout.trim();
  const taskReceipt = receipts.find(
    (receipt) => receipt.requestId === 'task-review',
  )!;
  await reviews.run(
    {
      requestId: 'member-delta',
      mode: 'delta',
      target: {
        kind: 'git-range',
        projectSlug: f.project.slug,
        baseRevision: f.head,
        headRevision: head,
      },
      implementerAgentSlug: 'implementer',
      reviewers: [
        {
          reviewerId: 'reviewer',
          executorAgentSlug: 'reviewer',
          lens: {
            id: 'correctness',
            instructions: 'Inspect controlled fixture source.',
          },
        },
      ],
      delta: {
        priorReceiptId: taskReceipt.receiptId,
        claimedFindingIds: taskReceipt.findings.map(
          (finding) => finding.findingId,
        ),
      },
    },
    {
      requestedBy: { actorId: f.people[0]!.principal.id },
      includeTaskReviews: false,
    },
  );
  expect(execute).toHaveBeenCalledTimes(2);
}, 60000);

test('Task code review refuses account identity even with valid operator or unbound Device transport', async () => {
  const f = await fixture({ codeReviewCheckout: true });
  const pairing = f.security.devicePairing;
  const offer = pairing.createOffer({
    endpoint: origin,
    scope: 'orchestration:read orchestration:operate',
  });
  const pending = pairing.requestPairing({
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'Personal review browser',
    requesterPosition: 'unproven',
    source: 'same-origin',
  });
  pairing.confirmRequest(pending.requestId, { kind: 'presented-credential' });
  const paired = pairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: pending.requestId,
  });
  expect(
    f.security.identifyDevice(paired.credential)?.principalBinding,
  ).toBeUndefined();
  const path = `/api/tasks/${f.task.id}/review/code`;
  const readPath = `${path}?projectId=${f.project.id}&taskCreatedAt=${encodeURIComponent(f.task.createdAt)}`;
  for (const credential of [f.operatorCredential, paired.credential]) {
    const operatorRead = await f.app.request(`${origin}${readPath}`, {
      headers: { Authorization: `Bearer ${credential}`, Origin: origin },
    });
    expect(operatorRead.status, await operatorRead.clone().text()).toBe(200);
    expect(await operatorRead.json()).toMatchObject({
      success: true,
      data: {
        canRequest: true,
        requestsUnavailable: false,
        workspace: { state: 'available', path: f.checkout, headSha: f.head },
      },
    });
    const account = f.people[0]!;
    for (const method of ['GET', 'POST']) {
      const refused = await f.request(
        account,
        method === 'GET' ? readPath : path,
        {
          method,
          headers: {
            Authorization: `Bearer ${credential}`,
            'Content-Type': 'application/json',
          },
          ...(method === 'POST'
            ? {
                body: JSON.stringify({
                  requestId: 'member-code-review',
                  projectId: f.project.id,
                  projectCreatedAt: f.project.createdAt,
                  taskCreatedAt: f.task.createdAt,
                  baseSha: f.head,
                  headSha: f.head,
                  reviewerAgentSlug: 'reviewer',
                }),
              }
            : {}),
        },
      );
      expect(refused.status, await refused.clone().text()).toBe(403);
      expect(await refused.json()).toMatchObject({
        success: false,
        code: 'forbidden',
      });
    }
  }
  pairing.setDeviceScope(paired.device.id, ['orchestration:read'], {
    kind: 'presented-credential',
  });
  const readOnly = await f.app.request(`${origin}${readPath}`, {
    headers: { Authorization: `Bearer ${paired.credential}`, Origin: origin },
  });
  expect(readOnly.status, await readOnly.clone().text()).toBe(200);
  expect(await readOnly.json()).toMatchObject({
    data: {
      canRequest: false,
      requestUnavailableReason: 'execution-not-authorized',
      workspace: { state: 'available', path: f.checkout, headSha: f.head },
    },
  });
}, 60000);

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
  for (const expectedMember of [
    { principalId: bob!.principal.id, shareId: f.publication.shareId },
    {
      principalId: alice!.principal.id,
      shareId: 'eeeeeeee-1111-4111-8111-000000000000',
    },
  ]) {
    const result = await f.request(alice!, `${base}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId: 'stale-reply',
        text: 'From the wrong account or publication',
        expectedMember,
      }),
    });
    expect(result.status).toBe(404);
  }
  for (const person of [alice!, bob!]) {
    const result = await f.request(person, `${base}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId: `message-${person.name}`,
        expectedMember: {
          principalId: person.principal.id,
          shareId: f.publication.shareId,
        },
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
