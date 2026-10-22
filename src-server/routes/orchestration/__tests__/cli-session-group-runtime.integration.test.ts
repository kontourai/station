import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type {
  CliSessionGroupEventPage,
  CliSessionGroupView,
} from '@kontourai/station-contracts/delegation-group';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import {
  respondToDelegatedTaskRequest as answerTaskRequest,
  createCliSessionGroup,
  createEnsembleCliSessionGroup,
  parseCliSessionGroupInput,
  observeDelegatedTaskEvents as readTaskEvents,
  setClientCredentialResolver,
  subscribeCliSessionGroupEvents,
} from '@kontourai/station-sdk/client';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { runCli } from '../../../../packages/cli/src/cli.js';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createOrchestrationRequestPrincipalResolver } from '../../../runtime/bootstrap/orchestration-request-principal.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  isRuntimeRequestPrincipalCurrent,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { createRuntimeResourcePostureController } from '../../../services/infra/resource-posture.js';
import { EnsembleCliSessionGroupPreparation } from '../../../services/orchestration/ensemble-cli-session-group.js';
import { createLocalEnsembleInventory } from '../../../services/orchestration/ensemble-execution-context.js';
import { EnsembleInspectionService } from '../../../services/orchestration/ensemble-inspection.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../../services/orchestration/session-agent-resolution.js';
import { createRemoteStationForwarder } from '../../../services/remote-stations/remote-station-forwarder.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import {
  delegateTask,
  interruptDelegatedTask,
  observeDelegatedTask,
  observeDelegatedTaskEvents,
  respondToDelegatedTaskRequest,
} from '../../../tools/station-control-delegation.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const temporary = trackTempDirs();
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setClientCredentialResolver(undefined);
});

class MemberAdapter extends GateTestAdapter {
  readonly starts: ProviderSessionStartInput[] = [];
  startGate: Promise<void> = Promise.resolve();
  private readonly sessions = new Map<
    string,
    Awaited<ReturnType<GateTestAdapter['startSession']>>
  >();
  readonly turns: ProviderSendTurnInput[] = [];
  needsInputNext = false;
  readonly questions = new Map<
    string,
    { input: ProviderSendTurnInput; turnId: string; eventId: string }
  >();
  readonly answers: {
    threadId: string;
    requestId: string;
    decision: string;
  }[] = [];
  override async respondToRequest(
    threadId = '',
    requestId = '',
    decision = 'cancel',
  ) {
    const question = this.questions.get(requestId);
    if (
      !question ||
      question.input.threadId !== threadId ||
      decision !== 'accept'
    )
      throw new Error(
        'Request does not match the live controlled engine question',
      );
    this.answers.push({ threadId, requestId, decision });
    this.questions.delete(requestId);
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId,
      turnId: question.turnId,
      method: 'request.resolved',
      requestId,
      status: 'approved',
      createdAt: new Date().toISOString(),
    });
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId,
      turnId: question.turnId,
      method: 'turn.completed',
      outputText: 'Returned after approval',
      finishReason: 'stop',
      createdAt: new Date().toISOString(),
      invocationId: question.input.invocationId,
    });
  }
  override async startSession(input: ProviderSessionStartInput) {
    this.starts.push(input);
    await this.startGate;
    const session = await super.startSession(input);
    this.sessions.set(input.threadId, session);
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      method: 'session.started',
      createdAt: session.createdAt,
      metadata: input.metadata,
    });
    return session;
  }
  override async hasSession(threadId?: string) {
    return threadId !== undefined && this.sessions.has(threadId);
  }
  override async listSessions() {
    return [...this.sessions.values()];
  }
  override async sendTurn(input: ProviderSendTurnInput) {
    this.turns.push(input);
    const turnId = randomUUID();
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      turnId,
      method: 'turn.started',
      createdAt: new Date().toISOString(),
      invocationId: input.invocationId,
    });
    if (this.needsInputNext) {
      this.needsInputNext = false;
      const requestId = randomUUID();
      const eventId = randomUUID();
      this.questions.set(requestId, { input, turnId, eventId });
      this.events.push({
        eventId,
        provider: this.provider,
        threadId: input.threadId,
        turnId,
        method: 'request.opened',
        requestId,
        requestType: 'approval',
        title: 'Controlled member approval',
        createdAt: new Date().toISOString(),
      });
      return { threadId: input.threadId, turnId };
    }
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      turnId,
      method: 'turn.completed',
      createdAt: new Date().toISOString(),
      outputText: 'Returned member result',
      invocationId: input.invocationId,
    });
    return { threadId: input.threadId, turnId };
  }
}

async function fixture(operatorInspection = false) {
  const root = realpathSync(temporary('station-real-cli-group-'));
  const actor = humanPrincipal('test', 'group-owner', 'Group owner');
  const security = operatorInspection
    ? new EnvironmentSecurityService({ homeDir: root })
    : undefined;
  const operatorCredential = security
    ? (await security.initialize()).credential
    : undefined;
  const resolvePrincipal = security
    ? createOrchestrationRequestPrincipalResolver({
        environmentSecurityService: security,
      })
    : () => actor;
  const adapter = new MemberAdapter();
  Object.assign(adapter.metadata, {
    connectionId: 'claude',
    modelLaunch: {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'engine-selected',
      omissionPerTurn: 'engine-selected',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    },
  });
  const inventory = createLocalEnsembleInventory({
    environmentId: () => 'group-host',
    captureAgentConfigurationFence: () => () => {},
    getProjectRevision: () => ({ value: null, assertCurrent() {} }),
    getProviderRevision: () => 1,
    getAgent: async () => ({
      name: 'Reviewer',
      prompt: 'Review the supplied brief.',
      execution: { agentConnectionId: engineConnectionId('claude') },
    }),
    listEngineConnectionIdentities: async () => [
      { id: engineConnectionId('claude'), engineId: 'claude', type: 'claude' },
    ],
    loadAppConfig: async () => ({
      defaultModel: '',
      invokeModel: '',
      structureModel: '',
      systemPrompt: '',
    }),
    getProject: () => undefined,
    getProviderAdapter: () => adapter,
  });
  const ensembleGroups = security
    ? new EnsembleCliSessionGroupPreparation(
        new EnsembleInspectionService({
          security,
          inventory,
          readIntegration: () => undefined,
        }),
        inventory,
      )
    : undefined;
  const store = new EventStore(join(root, 'events.sqlite'));
  cleanup.push(async () => {
    store.close();
  });
  const bus = new EventBus();
  let prepare: () => Promise<void> = async () => {};
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    resourcePosture: createRuntimeResourcePostureController(),
    eventBus: bus,
    eventStore: store,
    logger: { debug() {}, warn() {} },
    resolveSessionAgent: createSessionAgentResolver({
      loadAgentSpec: async () => {
        await prepare();
        return { name: 'Reviewer', prompt: 'Review the supplied brief.' };
      },
      resolveToolServer: async () => null,
      resolveSkillDir: async () => null,
    }),
  });
  cleanup.push(() => service.shutdown());
  const remote = createRemoteStationForwarder({
    ssh: {
      list: () => [],
      connect: async () => {
        throw new Error('No remote fixture');
      },
    },
    peers: { get: () => null },
  });
  const pendingDispatches: Promise<unknown>[] = [];
  const app = new Hono();
  if (security)
    app.use('/api/orchestration/*', async (c, next) => {
      const credential =
        c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '';
      if (
        !security.authorizeCredential(credential, {
          method: c.req.method,
          path: c.req.path,
        })
      )
        return c.json({ success: false }, 403);
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        kind: 'credential',
        credential,
        authority: security.verifyOperatorCredential(credential)
          ? 'operator-credential'
          : 'device-credential',
        source: 'bearer',
        deviceId: security.identifyDevice(credential)?.id,
        locality: security.credentialLocality(credential),
        mintKind: security.credentialMintKind(credential),
      });
      bindRuntimeLocalOperator(c.req.raw);
      await next();
    });
  app.get('/.well-known/station/v1', (c) =>
    c.json({ environmentId: 'group-host' }),
  );
  app.get('/api/agents/reviewer', (c) =>
    c.json({
      success: true,
      data: {
        slug: 'reviewer',
        name: 'Reviewer',
        available: true,
        execution: { agentConnectionId: 'claude' },
      },
    }),
  );
  app.get('/api/connections/claude', (c) =>
    c.json({
      success: true,
      data: {
        id: 'claude',
        kind: 'agent',
        enabled: true,
        status: 'ready',
        capabilities: ['agent-runtime'],
        config: { provider: 'claude' },
      },
    }),
  );
  app.route(
    '/api/orchestration',
    createOrchestrationRoutes(service, {
      cliSessionGroupHome: root,
      ...(ensembleGroups
        ? {
            prepareEnsembleSessionGroup:
              ensembleGroups.compose.bind(ensembleGroups),
          }
        : {}),
      eventBus: bus,
      logger: { debug() {}, warn() {} },
      resolvePrincipal,
      callerBindingForRequest: (request) =>
        security
          ? getRuntimeAuthenticatedRequestPrincipal(request)?.credential
          : 'fixture-group-owner',
      isRequestPrincipalCurrent: (request) =>
        security ? isRuntimeRequestPrincipalCurrent(request, security) : true,
      delegateTask: (input) => {
        const pending = delegateTask(input, service, remote);
        pendingDispatches.push(pending);
        return pending;
      },
      observeDelegatedTask: (input) =>
        observeDelegatedTask(input, service, remote),
      observeDelegatedTaskEvents: (input) =>
        observeDelegatedTaskEvents(input, service, remote),
      respondToDelegatedTaskRequest: (input) =>
        respondToDelegatedTaskRequest(input, service, remote),
      interruptDelegatedTask: (input) =>
        interruptDelegatedTask(input, service, remote),
    }),
  );
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  if (!server.listening)
    await new Promise<void>((resolve) => server.once('listening', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv('STATION_API_BASE', apiBase);
  vi.stubEnv('STATION_INTERNAL_API_TOKEN', 'group-test');
  return {
    app,
    service,
    security,
    operatorCredential,
    apiBase,
    root,
    adapter,
    store,
    pendingDispatches,
    setPreparation: (work: typeof prepare) => {
      prepare = work;
    },
  };
}

function groupInput(seats = 3) {
  return {
    operationId: 'real-group',
    maxConcurrent: 2,
    deadlineAt: Date.now() + 60_000,
    members: Array.from({ length: seats }, (_, index) => ({
      seatId: `seat-${index}`,
      prompt: `Review part ${index}`,
      needs: index === 2 ? ['seat-0', 'seat-1'] : [],
      target: {
        agent: 'reviewer',
        expectedEngine: { kind: 'connection', connectionId: 'claude' },
      },
    })),
  };
}
async function create(f: Awaited<ReturnType<typeof fixture>>, seats = 3) {
  return createCliSessionGroup(
    f.apiBase,
    parseCliSessionGroupInput(groupInput(seats)),
    {
      credential: f.operatorCredential ?? 'group-test',
      credentialOrigin: f.apiBase,
    },
  );
}

test('registered CLI and SDK create three real orchestration sessions and initial turns joined to durable Flow completion', async () => {
  const f = await fixture();
  let releaseStart!: () => void;
  f.adapter.startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((value) => {
    output.push(String(value));
  });
  const file = join(f.root, 'group.json');
  writeFileSync(file, JSON.stringify(groupInput()));
  await runCli([
    'group',
    'session-create',
    `--file=${file}`,
    `--api-base=${f.apiBase}`,
    '--credential=group-test',
    '--json',
  ]);
  const group: CliSessionGroupView = JSON.parse(output.splice(0).join('\n'));
  await runCli([
    'group',
    'session-list',
    `--api-base=${f.apiBase}`,
    '--credential=group-test',
    '--json',
  ]);
  const inventory: { groups: CliSessionGroupView[] } = JSON.parse(
    output.splice(0).join('\n'),
  );
  expect(inventory.groups.map((value) => value.groupId)).toEqual([
    group.groupId,
  ]);
  const pages: CliSessionGroupEventPage[] = [];
  const streamErrors: unknown[] = [];
  const stream = subscribeCliSessionGroupEvents(
    f.apiBase,
    group.groupId,
    0,
    {
      onPage: (page) => pages.push(page),
      onTerminal: (error) => streamErrors.push(error),
    },
    { credential: 'group-test', credentialOrigin: f.apiBase },
  );
  cleanup.push(async () => {
    stream.close();
    await stream.completed;
  });
  const running = runCli([
    'group',
    'session-run',
    group.groupId,
    `--api-base=${f.apiBase}`,
    '--credential=group-test',
    '--json',
  ]);
  let completed = false;
  try {
    await vi.waitFor(() => expect(f.adapter.starts).toHaveLength(1), {
      timeout: 5000,
    });
    await vi.waitFor(
      async () => {
        const response = await f.app.request(
          `/api/orchestration/session-groups/${group.groupId}`,
        );
        const observed = (
          (await response.json()) as { data: CliSessionGroupView }
        ).data;
        expect(observed.dispatchCount).toBe(2);
      },
      { timeout: 5000 },
    );
    expect(f.adapter.starts).toHaveLength(1);
    releaseStart();
    await vi.waitFor(
      async () => {
        const observed = await f.app.request(
          `/api/orchestration/session-groups/${group.groupId}`,
        );
        const value = ((await observed.json()) as { data: CliSessionGroupView })
          .data;
        expect(
          value.flow?.status,
          JSON.stringify({
            value,
            events: f.adapter.turns.map((turn) =>
              f.store.listEvents(turn.threadId).map((event) => ({
                method: event.payload.method,
                turnId: event.payload.turnId,
              })),
            ),
          }),
        ).toBe('completed');
      },
      { timeout: 5000, interval: 100 },
    );
    completed = true;
  } finally {
    releaseStart();
    if (!completed) process.emit('SIGINT');
    await running;
  }
  const final: CliSessionGroupView = JSON.parse(output.join('\n'));
  await vi.waitFor(() =>
    expect(
      new Set(
        pages
          .flatMap((page) => page.events)
          .flatMap((event) => event.members)
          .filter((member) => member.outcome === 'completed')
          .map((member) => member.seatId),
      ).size,
    ).toBe(3),
  );
  expect(streamErrors).toEqual([]);
  stream.close();
  await stream.completed;
  const revisions = pages.flatMap((page) =>
    page.events.map((event) => event.revision),
  );
  expect(new Set(revisions).size).toBe(revisions.length);
  expect(JSON.stringify(pages)).not.toContain('Review part');
  output.length = 0;
  await runCli([
    'group',
    'session-events',
    group.groupId,
    `--api-base=${f.apiBase}`,
    '--credential=group-test',
    '--json',
  ]);
  const history: CliSessionGroupEventPage = JSON.parse(output.join('\n'));
  expect(
    history.events
      .flatMap((event) => event.members)
      .filter((member) => member.outcome === 'completed'),
  ).toHaveLength(3);
  expect(history.nextRevision).toBe(final.revision);
  expect(f.adapter.starts).toHaveLength(3);
  expect(f.adapter.turns).toHaveLength(3);
  expect(final.flow?.status).toBe('completed');
  for (const member of final.members) {
    expect(member.outcome).toBe('completed');
    const turn = f.adapter.turns.find(
      (input) => input.threadId === member.reservedSessionId,
    )!;
    expect(turn.clientTurnId).toBe(member.initialClientTurnId);
    const events = f.store.listEvents(member.handle!.sessionId);
    expect(
      events.some((event) => event.payload.method === 'session.started'),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.payload.method === 'turn.completed' &&
          event.payload.turnId === member.handle!.initialTurnId,
      ),
    ).toBe(true);
  }
}, 30_000);

test('cancellation after Agent preparation starts prevents the actual adapter spawn', async () => {
  const f = await fixture();
  let prepared!: () => void;
  let release!: () => void;
  const preparing = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setPreparation(async () => {
    prepared();
    await held;
  });
  const group = await create(f, 1);
  const run = f.app.request(
    `/api/orchestration/session-groups/${group.groupId}/run`,
    { method: 'POST' },
  );
  await preparing;
  try {
    const cancelled = await f.app.request(
      `/api/orchestration/session-groups/${group.groupId}/cancel`,
      { method: 'POST' },
    );
    expect(cancelled.status).toBe(200);
  } finally {
    release();
  }
  await run;
  await Promise.allSettled(f.pendingDispatches);
  expect(f.adapter.starts).toHaveLength(0);
  expect(f.adapter.turns).toHaveLength(0);
}, 30_000);

test('a group member approval stays visible and occupies its seat until the canonical response reaches that engine and raw output returns', async () => {
  const f = await fixture(true);
  const credential = f.operatorCredential!;
  const headers = { Authorization: `Bearer ${credential}` };
  f.adapter.needsInputNext = true;
  const input = groupInput(2);
  input.maxConcurrent = 1;
  input.members[1].needs = ['seat-0'];
  const group = await createCliSessionGroup(
    f.apiBase,
    parseCliSessionGroupInput(input),
    { credential, credentialOrigin: f.apiBase },
  );
  const stop = new AbortController();
  const running = f.app.request(
    `/api/orchestration/session-groups/${group.groupId}/run`,
    { method: 'POST', headers, signal: stop.signal },
  );
  try {
    let waiting: CliSessionGroupView | undefined;
    await vi.waitFor(
      async () => {
        const response = await f.app.request(
          `/api/orchestration/session-groups/${group.groupId}`,
          { headers },
        );
        waiting = ((await response.json()) as { data: CliSessionGroupView })
          .data;
        expect(waiting.members[0].attention?.kind).toBe('review-pending');
      },
      { timeout: 5000 },
    );
    const member = waiting!.members[0];
    expect(JSON.stringify(waiting)).not.toContain('Controlled member approval');
    const request = member.attention!.request!;
    expect(f.adapter.turns).toHaveLength(1);
    expect(waiting!.members[1].state).toBe('pending');
    const question = f.adapter.questions.get(request.id)!;
    expect(request.eventId).toBe(question.eventId);
    await expect(
      answerTaskRequest(
        f.apiBase,
        member.handle!.taskId,
        { requestId: request.id, decision: 'accept' },
        {
          credential: 'invalid-fixture-credential',
          credentialOrigin: f.apiBase,
        },
      ),
    ).rejects.toThrow();
    expect(f.adapter.answers).toEqual([]);
    const answer = await answerTaskRequest(
      f.apiBase,
      member.handle!.taskId,
      { requestId: request.id, decision: 'accept' },
      { credential, credentialOrigin: f.apiBase },
    );
    expect(answer.requestId).toBe(request.id);
    expect(f.adapter.answers).toEqual([
      {
        threadId: member.handle!.sessionId,
        requestId: request.id,
        decision: 'accept',
      },
    ]);
    const response = await running;
    expect(response.status, await response.clone().text()).toBe(200);
    const final = ((await response.json()) as { data: CliSessionGroupView })
      .data;
    expect(final.flow?.status).toBe('completed');
    expect(final.members[0].attention).toBeUndefined();
    expect(f.adapter.turns).toHaveLength(2);
    await expect(
      answerTaskRequest(
        f.apiBase,
        member.handle!.taskId,
        { requestId: request.id, decision: 'accept' },
        { credential, credentialOrigin: f.apiBase },
      ),
    ).rejects.toThrow();
    expect(f.adapter.answers).toHaveLength(1);
    const events = await readTaskEvents(
      f.apiBase,
      member.handle!.taskId,
      {},
      { credential, credentialOrigin: f.apiBase },
    );
    expect(
      events.events.some(
        (event) =>
          event.kind === 'message' && event.text === 'Returned after approval',
      ),
    ).toBe(true);
    expect(JSON.stringify(final)).not.toContain('Returned after approval');
  } finally {
    stop.abort();
    await running;
  }
}, 15_000);

test('a separately minted local operator can inspect CLI-owned groups through real session read authority but cannot inherit mutation ownership', async () => {
  const f = await fixture(true);
  const security = f.security!;
  const group = await create(f, 1);
  const headers = {
    Authorization: `Bearer ${f.operatorCredential}`,
    'Content-Type': 'application/json',
  };
  const ran = await f.app.request(
    `/api/orchestration/session-groups/${group.groupId}/run`,
    { method: 'POST', headers },
  );
  expect(ran.status).toBe(200);
  const offer = security.devicePairing.createOffer({ endpoint: f.apiBase });
  const request = security.devicePairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'Group inspector',
  });
  security.devicePairing.confirmRequest(request.requestId, {
    kind: 'local-grant',
  });
  const local = security.devicePairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
    locality: 'home-possession',
    mintKind: 'local-grant',
  });
  const localHeaders = { Authorization: `Bearer ${local.credential}` };
  const observed = await f.app.request(
    `/api/orchestration/session-groups/${group.groupId}`,
    { headers: localHeaders },
  );
  expect(observed.status, await observed.clone().text()).toBe(200);
  expect(
    ((await observed.json()) as { data: CliSessionGroupView }).data.members[0]
      ?.outcome,
  ).toBe('completed');
  const listed = await f.app.request('/api/orchestration/session-groups', {
    headers: localHeaders,
  });
  expect(
    (
      (await listed.json()) as { data: { groups: CliSessionGroupView[] } }
    ).data.groups.map((value) => value.groupId),
  ).toEqual([group.groupId]);
  const cancelled = await f.app.request(
    `/api/orchestration/session-groups/${group.groupId}/cancel`,
    { method: 'POST', headers: localHeaders },
  );
  expect(cancelled.status).toBe(404);
  const permission = vi
    .spyOn(f.service, 'canUserReadSession')
    .mockReturnValue(false);
  const denied = await f.app.request(
    `/api/orchestration/session-groups/${group.groupId}`,
    { headers: localHeaders },
  );
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain(
    group.members[0]?.handle?.sessionId ?? 'task:',
  );
  permission.mockRestore();
  const deviceOffer = security.devicePairing.createOffer({
    endpoint: f.apiBase,
  });
  const deviceRequest = security.devicePairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: deviceOffer.offerId,
    proof: deviceOffer.challenge,
    deviceName: 'Ordinary device',
  });
  security.devicePairing.confirmRequest(deviceRequest.requestId, {
    kind: 'presented-credential',
  });
  const device = security.devicePairing.exchange({
    offerId: deviceOffer.offerId,
    proof: deviceOffer.challenge,
    requestId: deviceRequest.requestId,
  });
  const foreign = await f.app.request(
    `/api/orchestration/session-groups/${group.groupId}`,
    { headers: { Authorization: `Bearer ${device.credential}` } },
  );
  expect(foreign.status).toBe(404);
}, 30_000);

test('a locally authorized preset produces actual member turns with authored models, additions and the same complete roster', async () => {
  const f = await fixture(true);
  const security = f.security!;
  const offer = security.devicePairing.createOffer({ endpoint: f.apiBase });
  const requested = security.devicePairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'Preset operator',
  });
  security.devicePairing.confirmRequest(requested.requestId, {
    kind: 'local-grant',
  });
  const local = security.devicePairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: requested.requestId,
    locality: 'home-possession',
    mintKind: 'local-grant',
  });
  const preset = {
    version: 'station.ensemble/v1',
    id: 'team',
    name: 'Delivery team',
    stationmaster: 'lead',
    members: ['lead', 'check', 'join'].map((id) => ({
      id,
      codename: id,
      color: '#123ABC',
      role: `Role for ${id}`,
      engine: 'claude',
      model: 'fixture-model',
      reasoning: null,
      options: {},
      promptAppends: [`Private addition for ${id}`],
    })),
  };
  const path = join(f.root, 'team.json');
  const bytes = `${JSON.stringify(preset)}\n`;
  writeFileSync(path, bytes);
  const input = {
    path,
    expectedPresetHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    brief: 'Review this work.',
    operationId: 'preset-group',
    maxConcurrent: 2,
    deadlineAt: Date.now() + 60_000,
    bindings: Object.fromEntries(
      preset.members.map(({ id }) => [
        id,
        {
          target: {
            agent: agentId('reviewer'),
            expectedEngine: {
              kind: 'connection' as const,
              connectionId: engineConnectionId('claude'),
            },
            workspace: { kind: 'directory' as const, cwd: f.root },
          },
          needs: id === 'join' ? ['lead', 'check'] : [],
        },
      ]),
    ),
  };
  const denied = await f.app.request(
    '/api/orchestration/session-groups/from-ensemble',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${f.operatorCredential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  );
  expect(denied.status).toBe(403);
  const browserOffer = security.devicePairing.createOffer({
    endpoint: f.apiBase,
  });
  const browserRequest = security.devicePairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: browserOffer.offerId,
    proof: browserOffer.challenge,
    deviceName: 'Browser preset upload',
  });
  security.devicePairing.confirmRequest(browserRequest.requestId, {
    kind: 'ui-bootstrap',
  });
  const browser = security.devicePairing.exchange({
    offerId: browserOffer.offerId,
    proof: browserOffer.challenge,
    requestId: browserRequest.requestId,
    locality: 'home-possession',
    mintKind: 'ui-bootstrap',
  });
  const { path: _path, ...inline } = input;
  const upload = {
    ...inline,
    presetJson: bytes,
    operationId: 'uploaded-preset',
  };
  const submitUpload = (value: unknown) =>
    f.app.request('/api/orchestration/session-groups/from-ensemble', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${browser.credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(value),
    });
  const uploaded = await submitUpload(upload);
  expect(uploaded.status, await uploaded.clone().text()).toBe(200);
  const uploadedView = (
    (await uploaded.clone().json()) as { data: CliSessionGroupView }
  ).data;
  expect(uploadedView.preset).toEqual({
    presetId: 'team',
    name: 'Delivery team',
    sha256: input.expectedPresetHash,
    stationmaster: 'lead',
  });
  const spaced = `${bytes} `;
  const changedSourceReplay = await submitUpload({
    ...upload,
    presetJson: spaced,
    expectedPresetHash: `sha256:${createHash('sha256').update(spaced).digest('hex')}`,
  });
  expect(changedSourceReplay.status).toBe(409);
  expect(await changedSourceReplay.text()).toContain('group_conflict');
  expect(
    ((await uploaded.json()) as { data: CliSessionGroupView }).data.members.map(
      (member) => member.seatId,
    ),
  ).toEqual(['lead', 'check', 'join']);
  expect(f.adapter.starts).toHaveLength(0);
  const substituted = await submitUpload({
    ...upload,
    operationId: 'substituted-preset',
    presetJson: `${bytes} `,
  });
  expect(substituted.status).toBe(409);
  expect(await substituted.text()).toContain('ensemble_preset_stale');
  const bothSources = await submitUpload({ ...upload, path });
  expect(bothSources.status).toBe(409);
  const browserHostRead = await submitUpload(input);
  expect(browserHostRead.status).toBe(403);
  setClientCredentialResolver(() => ({
    origin: f.apiBase,
    credential: local.credential,
  }));
  const group = await createEnsembleCliSessionGroup(f.apiBase, input);
  expect(f.adapter.starts).toHaveLength(0);
  expect(group.members.map((member) => member.seatId)).toEqual([
    'lead',
    'check',
    'join',
  ]);
  const ran = await f.app.request(
    `/api/orchestration/session-groups/${group.groupId}/run`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${local.credential}` },
    },
  );
  expect(ran.status, await ran.clone().text()).toBe(200);
  const final = ((await ran.json()) as { data: CliSessionGroupView }).data;
  expect(final.flow?.status).toBe('completed');
  const retained = await f.app.request(
    `/api/orchestration/session-groups/${group.groupId}`,
    { headers: { Authorization: `Bearer ${local.credential}` } },
  );
  expect(
    ((await retained.json()) as { data: CliSessionGroupView }).data.preset,
  ).toEqual(group.preset);
  expect(group.preset?.sha256).toBe(input.expectedPresetHash);
  expect(f.adapter.turns).toHaveLength(3);
  for (const member of preset.members) {
    const handle = final.members.find((entry) => entry.seatId === member.id)!
      .handle!;
    const turn = f.adapter.turns.find(
      (entry) => entry.threadId === handle.sessionId,
    )!;
    expect(turn.input).toContain('Review this work.');
    expect(turn.input).toContain(`Private addition for ${member.id}`);
    for (const id of ['lead', 'check', 'join'])
      expect(turn.input).toContain(`"id":"${id}"`);
    expect(
      f.adapter.starts.find((entry) => entry.threadId === handle.sessionId)
        ?.modelId,
    ).toBe('fixture-model');
  }
  writeFileSync(path, `${bytes} `);
  await expect(
    createEnsembleCliSessionGroup(f.apiBase, {
      ...input,
      operationId: 'stale',
    }),
  ).rejects.toThrow();
  expect(f.adapter.turns).toHaveLength(3);
}, 30_000);
