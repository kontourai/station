import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type { CliSessionGroupView } from '@kontourai/station-contracts/delegation-group';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import {
  createCliSessionGroup,
  createEnsembleCliSessionGroup,
  parseCliSessionGroupInput,
  setClientCredentialResolver,
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
    app.use('/api/orchestration/session-groups*', async (c, next) => {
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
