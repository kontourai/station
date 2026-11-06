import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import * as Flow from '@kontourai/flow';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type {
  CliSessionGroupEventPage,
  CliSessionGroupView,
} from '@kontourai/station-contracts/delegation-group';
import type { EnsembleInspection } from '@kontourai/station-contracts/ensemble';
import type {
  InputRequestContent,
  InputRequestForm,
} from '@kontourai/station-contracts/input-request';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import {
  respondToRequest as answerSessionRequest,
  respondToDelegatedTaskRequest as answerTaskRequest,
  createCliSessionGroup,
  createEnsembleCliSessionGroup,
  parseCliSessionGroupInput,
  observeDelegatedTaskEvents as readTaskEvents,
  setClientCredentialResolver,
  subscribeCliSessionGroupEvents,
} from '@kontourai/station-sdk/client';
import { validateInputRequestContent } from '@kontourai/station-shared/input-request';
import {
  CallToolResultSchema,
  JSONRPCResponseSchema,
} from '@modelcontextprotocol/core';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { runCli } from '../../../../packages/cli/src/cli.js';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderExecutionAuthInput,
  ProviderExecutionAuthObservation,
} from '../../../providers/adapter-shape.js';
import {
  captureNativeAuthenticationLaunch,
  observeNativeAuthenticationLaunch,
  retainNativeAuthenticationContinuation,
} from '../../../providers/auth/native-authentication-context.js';
import { createOrchestrationRequestPrincipalResolver } from '../../../runtime/bootstrap/orchestration-request-principal.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { createSessionGroupRequestAuthority } from '../../../runtime/mcp/session-group-request-authority.js';
import { resolveStationControlCallerForRequest } from '../../../runtime/mcp/station-control-caller.js';
import { claudeInProcessStationControlOptions } from '../../../runtime/mcp/station-control-in-process.js';
import { revokeStationControlMcpToken } from '../../../runtime/mcp/station-control-mcp-token.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  isRuntimeRequestPrincipalCurrent,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { createStationControlAuthorityGuard } from '../../../security/station-control-authority-guard.js';
import { stationControlRequestAuthority } from '../../../security/station-control-request-authority.js';
import { runAsStationServer } from '../../../security/station-server-scope.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { createRuntimeResourcePostureController } from '../../../services/infra/resource-posture.js';
import { FileDelegationAttemptClaimStore } from '../../../services/orchestration/delegation-attempt-claim-store.js';
import { EnsembleCliSessionGroupPreparation } from '../../../services/orchestration/ensemble-cli-session-group.js';
import { createLocalEnsembleInventory } from '../../../services/orchestration/ensemble-execution-context.js';
import { EnsembleInspectionService } from '../../../services/orchestration/ensemble-inspection.js';
import { authenticateEnsembleSessionGroup } from '../../../services/orchestration/ensemble-session-group-authentication.js';
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

type StationControlReply = ReturnType<typeof JSONRPCResponseSchema.parse>;

vi.mock('@kontourai/flow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kontourai/flow')>();
  return { ...actual, loadRun: vi.fn(actual.loadRun) };
});

const temporary = trackTempDirs();
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  try {
    for (const close of cleanup.splice(0).reverse()) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setClientCredentialResolver(undefined);
  }
  if (failures.length)
    throw new AggregateError(failures, 'Group runtime fixture cleanup failed');
});

class MemberAdapter extends GateTestAdapter {
  authenticationExecutable = '';
  readonly authentications: ProviderExecutionAuthInput[] = [];
  onAuthentication?: (input: ProviderExecutionAuthInput) => Promise<void>;
  authenticationStates: ProviderExecutionAuthObservation['state'][] = [];
  async observeExecutionAuthentication(
    input: ProviderExecutionAuthInput,
  ): Promise<ProviderExecutionAuthObservation> {
    this.authentications.push(input);
    await this.onAuthentication?.(input);
    (await input.assertCurrent())();
    input.signal?.throwIfAborted();
    const finalize = await input.assertCurrent();
    const continuation = await observeNativeAuthenticationLaunch({
      engine: 'codex',
      profileRef: null,
      command: this.authenticationExecutable,
      cwd: input.cwd,
      env: { HOME: input.cwd, CODEX_HOME: join(input.cwd, '.codex') },
      assertCurrent: finalize,
    });
    return retainNativeAuthenticationContinuation(
      {
        state: this.authenticationStates.shift() ?? 'authenticated',
        contextHash: `sha256:${input.bindingHash}`,
        checkedAt: Date.now(),
        modelEntitlement: 'not-checked',
        outputTokenLimitFidelity: 'unavailable',
      },
      continuation,
    );
  }
  async assertContextSyncRuntime() {}
  syncOutputs: string[] = [];
  nativeSessionIdentity(cursor: unknown) {
    return typeof cursor === 'string' ? { sessionId: cursor } : undefined;
  }
  readonly starts: ProviderSessionStartInput[] = [];
  private readonly retainedNativeSessions = new Set<string>();
  startGate: Promise<void> = Promise.resolve();
  private readonly sessions = new Map<
    string,
    Awaited<ReturnType<GateTestAdapter['startSession']>>
  >();
  readonly turns: ProviderSendTurnInput[] = [];
  needsInputNext = false;
  formNext = false;
  responseAttempts = 0;
  readonly questions = new Map<
    string,
    {
      input: ProviderSendTurnInput;
      turnId: string;
      eventId: string;
      form?: InputRequestForm;
    }
  >();
  readonly answers: {
    threadId: string;
    requestId: string;
    decision: string;
    eventId?: string;
    content?: InputRequestContent;
  }[] = [];
  override async respondToRequest(
    threadId = '',
    requestId = '',
    decision = 'cancel',
    context?: {
      expectedRequestEventId?: string;
      inputContent?: InputRequestContent;
    },
  ) {
    this.responseAttempts += 1;
    const question = this.questions.get(requestId);
    if (
      !question ||
      question.input.threadId !== threadId ||
      decision !== 'accept'
    )
      throw new Error(
        'Request does not match the live controlled engine question',
      );
    if (question.form && context?.expectedRequestEventId !== question.eventId)
      throw new Error('Question event identity changed');
    const content = question.form
      ? validateInputRequestContent(question.form, context?.inputContent)
      : undefined;
    this.answers.push({
      threadId,
      requestId,
      decision,
      ...(question.form ? { eventId: question.eventId, content } : {}),
    });
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
      outputText: question.form
        ? 'Returned after input'
        : 'Returned after approval',
      finishReason: 'stop',
      createdAt: new Date().toISOString(),
      invocationId: question.input.invocationId,
    });
  }
  override async startSession(input: ProviderSessionStartInput) {
    this.starts.push(input);
    if (
      typeof input.resumeCursor === 'string' &&
      !this.retainedNativeSessions.has(input.resumeCursor)
    )
      throw new Error('Native transcript was not retained');
    await this.startGate;
    captureNativeAuthenticationLaunch(
      this,
      input.threadId,
    )?.({
      command: this.authenticationExecutable,
      args: ['app-server'],
      cwd: input.cwd,
      env: { HOME: input.cwd, CODEX_HOME: join(input.cwd ?? '', '.codex') },
    });
    const session = {
      ...(await super.startSession(input)),
      resumeCursor: `native-${input.threadId}`,
      persistSession: input.persistSession === true,
      cwd: input.cwd,
    };
    if (input.persistSession)
      this.retainedNativeSessions.add(session.resumeCursor);
    this.sessions.set(input.threadId, session);
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      method: 'session.started',
      createdAt: session.createdAt,
      metadata: {
        ...input.metadata,
        nativeResumeBindingKey: 'fixture-native-binding',
      },
    });
    return session;
  }
  override async hasSession(threadId?: string) {
    return threadId !== undefined && this.sessions.has(threadId);
  }
  override async stopSession(threadId = '') {
    this.sessions.delete(threadId);
    this.events.push({
      eventId: randomUUID(),
      provider: 'claude',
      threadId,
      sessionId: threadId,
      method: 'session.exited',
      reason: 'stopped',
      createdAt: new Date().toISOString(),
    });
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
      const form: InputRequestForm | undefined = this.formNext
        ? {
            schema: 'station.input-request/v1',
            source: 'mcp:controlled',
            requester: 'Controlled tool',
            message: 'Choose the controlled token',
            body: {
              kind: 'form',
              fields: [
                {
                  name: 'token',
                  kind: 'choice',
                  required: true,
                  options: [{ value: 'CONTROLLED_OK', label: 'CONTROLLED_OK' }],
                },
              ],
            },
          }
        : undefined;
      this.formNext = false;
      this.questions.set(requestId, {
        input,
        turnId,
        eventId,
        ...(form ? { form } : {}),
      });
      this.events.push({
        eventId,
        provider: this.provider,
        threadId: input.threadId,
        turnId,
        method: 'request.opened',
        requestId,
        requestType: 'approval',
        title: form?.message ?? 'Controlled member approval',
        ...(form ? { payload: { inputRequest: form } } : {}),
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
      finishReason: 'stop',
      outputText: input.clientTurnId?.startsWith('sync-')
        ? (this.syncOutputs.shift() ?? 'ACK SYNC run-one')
        : 'Returned member result',
      invocationId: input.invocationId,
    });
    return { threadId: input.threadId, turnId };
  }
}

async function fixture(
  operatorInspection = false,
  stationControl = false,
  heterogeneous = false,
) {
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
  const codex = heterogeneous ? new MemberAdapter('codex') : undefined;
  const adapters = codex ? [adapter, codex] : [adapter];
  const providerFor = (id: string) =>
    codex && id === 'reviewer-codex' ? 'codex' : 'claude';
  adapter.authenticationExecutable = join(root, 'fixture-native');
  writeFileSync(adapter.authenticationExecutable, '');
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
  if (codex)
    Object.assign(codex.metadata, adapter.metadata, {
      connectionId: 'codex',
      displayName: 'Codex',
    });
  let inventoryRevision = 1;
  const inventory = createLocalEnsembleInventory({
    environmentId: () => 'group-host',
    captureAgentConfigurationFence: () => () => {},
    getProjectRevision: () => ({ value: null, assertCurrent() {} }),
    getProviderRevision: () => inventoryRevision,
    getAgent: async (id) => ({
      name: 'Reviewer',
      prompt: 'Review the supplied brief.',
      execution: { agentConnectionId: engineConnectionId(providerFor(id)) },
    }),
    listEngineConnectionIdentities: async () => [
      { id: engineConnectionId('claude'), engineId: 'claude', type: 'claude' },
      ...(codex
        ? [
            {
              id: engineConnectionId('codex'),
              engineId: 'codex' as const,
              type: 'codex',
            },
          ]
        : []),
    ],
    loadAppConfig: async () => ({
      defaultModel: '',
      invokeModel: '',
      structureModel: '',
      systemPrompt: '',
    }),
    getProject: () => undefined,
    getProviderAdapter: (provider) =>
      adapters.find((entry) => entry.provider === provider),
  });
  const ensembleInspection = security
    ? new EnsembleInspectionService({
        security,
        inventory,
        readIntegration: () => undefined,
      })
    : undefined;
  const ensembleGroups = ensembleInspection
    ? new EnsembleCliSessionGroupPreparation(ensembleInspection, inventory)
    : undefined;
  const store = new EventStore(join(root, 'events.sqlite'));
  cleanup.push(async () => {
    store.close();
  });
  const bus = new EventBus();
  let prepare: () => Promise<void> = async () => {};
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter, ...(codex ? [codex] : [])),
    resourcePosture: createRuntimeResourcePostureController(),
    eventBus: bus,
    eventStore: store,
    logger: { debug() {}, warn() {} },
    resolveSessionAgent: createSessionAgentResolver({
      loadAgentSpec: async (id) => {
        await prepare();
        if (id !== 'reviewer' && !(codex && id === 'reviewer-codex'))
          return null;
        return {
          name: 'Reviewer',
          prompt: 'Review the supplied brief.',
          execution: { agentConnectionId: engineConnectionId(providerFor(id)) },
        };
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
  const groupWarnings: unknown[] = [];
  const app = new Hono();
  const lifetime = new AbortController();
  const pendingRequests = new Set<Promise<Response>>();
  const fetch = app.fetch;
  app.fetch = (request, ...args) => {
    lifetime.signal.throwIfAborted();
    const work = Promise.resolve(
      fetch(
        new Request(request, {
          signal: AbortSignal.any([request.signal, lifetime.signal]),
        }),
        ...args,
      ),
    );
    pendingRequests.add(work);
    void work.then(
      () => pendingRequests.delete(work),
      () => pendingRequests.delete(work),
    );
    return work;
  };
  const resolveCallerRecord = (sessionId: string) => ({
    principal: {
      id: sessionId.startsWith('other')
        ? 'human:test:other'
        : LOCAL_OPERATOR_PRINCIPAL_ID,
      source: 'session-owner' as const,
    },
  });
  if (stationControl && security) {
    configureRuntimeHttp({
      app: app as never,
      logger: {
        debug() {},
        warn() {},
        info() {},
        error() {},
        child() {
          return this;
        },
      } as never,
      eventBus: bus,
      security: {
        verifyCredential: () => false,
        resolveGrantedScope: () => undefined,
        maxFailures: 100,
        windowMs: 60000,
        audit() {},
        allowedOrigins: [],
      },
    } as Parameters<typeof configureRuntimeHttp>[0]);
    app.use(
      '*',
      createStationControlAuthorityGuard({
        resolveCaller: (request) =>
          resolveStationControlCallerForRequest(request, resolveCallerRecord),
        isOperatorPrincipal: (id) => id === LOCAL_OPERATOR_PRINCIPAL_ID,
      }),
    );
  }
  if (security && !stationControl)
    app.use('/api/orchestration/*', async (c, next) => {
      const credential =
        c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '';
      const admitted = security.withCurrentAuthority(() => {
        if (
          !security.authorizeCredential(credential, {
            method: c.req.method,
            path: c.req.path,
          })
        )
          return false;
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
        return true;
      });
      if (!admitted) return c.json({ success: false }, 403);
      await next();
    });
  app.get('/.well-known/station/v1', (c) =>
    c.json({ environmentId: 'group-host' }),
  );
  app.get('/api/agents/:slug', (c) => {
    const slug = c.req.param('slug');
    if (slug !== 'reviewer' && !(codex && slug === 'reviewer-codex'))
      return c.notFound();
    return c.json({
      success: true,
      data: {
        slug: c.req.param('slug'),
        name: 'Reviewer',
        available: true,
        execution: { agentConnectionId: providerFor(c.req.param('slug')) },
      },
    });
  });
  app.get('/api/connections/:id', (c) => {
    const id = c.req.param('id');
    if (!adapters.some((entry) => entry.provider === id)) return c.notFound();
    return c.json({
      success: true,
      data: {
        id: c.req.param('id'),
        kind: 'agent',
        enabled: true,
        status: 'ready',
        capabilities: ['agent-runtime'],
        config: { provider: c.req.param('id') },
      },
    });
  });
  app.route(
    '/api/orchestration',
    createOrchestrationRoutes(service, {
      cliSessionGroupHome: root,
      ensembleInspection,
      delegationAttemptClaimStore: new FileDelegationAttemptClaimStore(root),
      ...(ensembleGroups && security
        ? {
            prepareEnsembleSessionGroup:
              ensembleGroups.compose.bind(ensembleGroups),
            authenticateEnsembleSessionGroup: (
              input,
              principal,
              assertCurrent,
            ) =>
              authenticateEnsembleSessionGroup(
                input,
                inventory,
                principal.id,
                () => security.withCurrentAuthority(assertCurrent),
              ),
          }
        : {}),
      eventBus: bus,
      logger: {
        debug() {},
        warn(message, meta) {
          groupWarnings.push({ message, meta });
        },
      },
      resolvePrincipal,
      ...(stationControl
        ? {
            ...createSessionGroupRequestAuthority(
              resolveCallerRecord,
              () => undefined,
            ),
            resolveAgentDispatchActor: (request: Request) => {
              const authority = stationControlRequestAuthority(request);
              return authority?.kind === 'caller' && authority.caller.principal
                ? {
                    kind: 'verified' as const,
                    principalId: authority.caller.principal.id,
                  }
                : { kind: 'unattributed' as const };
            },
          }
        : {}),
      callerBindingForRequest: (request) =>
        security
          ? getRuntimeAuthenticatedRequestPrincipal(request)?.credential
          : 'fixture-group-owner',
      isRequestPrincipalCurrent: (request) =>
        security ? isRuntimeRequestPrincipalCurrent(request, security) : true,
      delegateTask: (input) => {
        const pending = stationControl
          ? runAsStationServer(() => delegateTask(input, service, remote))
          : delegateTask(input, service, remote);
        pendingDispatches.push(pending);
        return pending;
      },
      observeDelegatedTask: (input) =>
        stationControl
          ? runAsStationServer(() =>
              observeDelegatedTask(input, service, remote),
            )
          : observeDelegatedTask(input, service, remote),
      observeDelegatedTaskEvents: (input) =>
        observeDelegatedTaskEvents(input, service, remote),
      respondToDelegatedTaskRequest: (input) =>
        respondToDelegatedTaskRequest(input, service, remote),
      interruptDelegatedTask: (input) =>
        stationControl
          ? runAsStationServer(() =>
              interruptDelegatedTask(input, service, remote),
            )
          : interruptDelegatedTask(input, service, remote),
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
  cleanup.push(async () => {
    lifetime.abort();
    while (pendingRequests.size) await Promise.allSettled([...pendingRequests]);
  });
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
    adapters,
    store,
    pendingDispatches,
    groupWarnings,
    resolveCallerRecord,
    inventory,
    changeInventory: () => {
      inventoryRevision++;
    },
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

test('registered CLI sync reaches the retained session through HTTP, durable reservations and canonical dispatch', async () => {
  const f = await fixture();
  const group = await create(f, 1);
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((value) =>
    output.push(String(value)),
  );
  await runCli([
    'group',
    'session-run',
    group.groupId,
    `--api-base=${f.apiBase}`,
    '--credential=group-test',
    '--json',
  ]);
  output.splice(0);
  const file = join(f.root, 'sync.json');
  writeFileSync(
    file,
    JSON.stringify({
      operationId: 'sync-one',
      runId: 'run-one',
      content: 'private complete folded result',
      deadlineAt: Date.now() + 60_000,
    }),
  );
  const spilledOutput = 'x'.repeat(32 * 1024);
  const syncResults = vi.spyOn(f.service, 'syncRetainedSession');
  f.adapter.syncOutputs.push(spilledOutput, 'ACK SYNC run-one');
  const argv = [
    'group',
    'session-sync',
    group.groupId,
    `--file=${file}`,
    `--api-base=${f.apiBase}`,
    '--credential=group-test',
    '--json',
  ];
  await runCli(argv);
  const result: CliSessionGroupView = JSON.parse(output.splice(0).join('\n'));
  expect(result.contextSync).toMatchObject({
    status: 'acknowledged',
    members: [{ seatId: 'seat-0', attempts: 2, status: 'acknowledged' }],
  });
  expect(f.adapter.turns).toHaveLength(3);
  const firstResult = await syncResults.mock.results[0]!.value;
  expect(firstResult.output).toBe(spilledOutput);
  const stored = f.store
    .listEvents(f.adapter.turns[1]!.threadId)
    .find(({ payload }) => payload.eventId === firstResult.terminalEventId);
  expect(stored?.payload.spilledContent).toBeDefined();
  expect(new Set(f.adapter.turns.map((turn) => turn.threadId)).size).toBe(1);
  expect(f.adapter.turns[1].input).toContain('private complete folded result');
  expect(JSON.stringify(result)).not.toContain(
    'private complete folded result',
  );
  await runCli(argv);
  expect(f.adapter.turns).toHaveLength(3);
}, 30_000);

test('registered CLI and SDK create three real orchestration sessions and initial turns joined to durable Flow completion', async () => {
  const f = await fixture(false, false, true);
  const starts = () => f.adapters.flatMap((entry) => entry.starts);
  const turns = () => f.adapters.flatMap((entry) => entry.turns);
  let releaseStart!: () => void;
  f.adapter.startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((value) => {
    output.push(String(value));
  });
  const file = join(f.root, 'group.json');
  const input = groupInput();
  input.members[1].target.agent = 'reviewer-codex';
  input.members[1].target.expectedEngine.connectionId = 'codex';
  writeFileSync(file, JSON.stringify(input));
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
            events: turns().map((turn) =>
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
  expect(starts()).toHaveLength(3);
  expect(
    f.adapters.map((entry) => [entry.provider, entry.starts.length]),
  ).toEqual([
    ['claude', 2],
    ['codex', 1],
  ]);
  expect(turns()).toHaveLength(3);
  expect(final.flow?.status).toBe('completed');
  for (const member of final.members) {
    expect(member.outcome).toBe('completed');
    const provider = member.seatId === 'seat-1' ? 'codex' : 'claude';
    const selected = f.adapters.find((entry) => entry.provider === provider);
    const turn = selected?.turns.find(
      (input) => input.threadId === member.reservedSessionId,
    );
    if (!turn)
      throw new Error('Selected adapter did not receive its member turn');
    expect(turn.clientTurnId).toBe(member.initialClientTurnId);
    const events = f.store.listEvents(member.handle!.sessionId);
    expect(
      events.some(
        (event) =>
          event.payload.method === 'session.started' &&
          event.payload.provider === provider,
      ),
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

test.each(['approval', 'form'] as const)(
  'a group member %s holds its seat until the authorized canonical reply reaches its exact engine request',
  async (kind) => {
    const f = await fixture(true);
    const credential = f.operatorCredential!;
    const headers = { Authorization: `Bearer ${credential}` };
    f.adapter.needsInputNext = true;
    f.adapter.formNext = kind === 'form';
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
      expect(JSON.stringify(waiting)).not.toContain(
        'Controlled member approval',
      );
      const request = member.attention!.request!;
      expect(f.adapter.turns).toHaveLength(1);
      expect(waiting!.members[1].state).toBe('pending');
      const question = f.adapter.questions.get(request.id)!;
      expect(request.eventId).toBe(question.eventId);
      const answer = (
        replyCredential: string,
        eventId = request.eventId,
        token = 'CONTROLLED_OK',
      ) =>
        kind === 'form'
          ? answerSessionRequest(
              f.apiBase,
              {
                threadId: member.handle!.sessionId,
                requestId: request.id,
                expectedRequestEventId: eventId,
                decision: 'accept',
                content: { token },
              },
              { credential: replyCredential, credentialOrigin: f.apiBase },
            )
          : answerTaskRequest(
              f.apiBase,
              member.handle!.taskId,
              { requestId: request.id, decision: 'accept' },
              { credential: replyCredential, credentialOrigin: f.apiBase },
            );
      if (kind === 'form') {
        const details = await f.app.request(
          `/api/orchestration/sessions/${encodeURIComponent(member.handle!.sessionId)}/events`,
          { headers },
        );
        expect(details.status).toBe(200);
        const body = (await details.json()) as {
          data: {
            method: string;
            eventId: string;
            payload?: { inputRequest?: InputRequestForm };
          }[];
        };
        expect(
          body.data.find((event) => event.eventId === request.eventId)?.payload
            ?.inputRequest,
        ).toMatchObject({ source: 'mcp:controlled', body: { kind: 'form' } });
        await expect(answer(credential, 'foreign-event')).rejects.toThrow();
        await expect(
          answer(credential, request.eventId, 'invalid-choice'),
        ).rejects.toThrow();
        expect(f.adapter.responseAttempts).toBe(0);
      }
      await expect(answer('invalid-fixture-credential')).rejects.toThrow();
      expect(f.adapter.answers).toEqual([]);
      await answer(credential);
      expect(f.adapter.answers).toEqual([
        {
          threadId: member.handle!.sessionId,
          requestId: request.id,
          decision: 'accept',
          ...(kind === 'form'
            ? { eventId: request.eventId, content: { token: 'CONTROLLED_OK' } }
            : {}),
        },
      ]);
      const response = await running;
      expect(response.status, await response.clone().text()).toBe(200);
      const final = ((await response.json()) as { data: CliSessionGroupView })
        .data;
      expect(final.flow?.status).toBe('completed');
      expect(final.members[0].attention).toBeUndefined();
      expect(f.adapter.turns).toHaveLength(2);
      await expect(answer(credential)).rejects.toThrow();
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
            event.kind === 'message' &&
            event.text ===
              (kind === 'form'
                ? 'Returned after input'
                : 'Returned after approval'),
        ),
      ).toBe(true);
      expect(JSON.stringify(final)).not.toContain(
        kind === 'form' ? 'Returned after input' : 'Returned after approval',
      );
      expect(JSON.stringify(final)).not.toContain('CONTROLLED_OK');
    } finally {
      stop.abort();
      await running;
    }
  },
  15_000,
);

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

test('registered CLI preserves a zero reserved-start allowance through run without starting an adapter', async () => {
  const f = await fixture();
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((value) =>
    output.push(String(value)),
  );
  const file = join(f.root, 'zero-starts.json');
  writeFileSync(
    file,
    JSON.stringify({ ...groupInput(1), maxConcurrent: 1, maxDispatches: 0 }),
  );
  await runCli([
    'group',
    'session-create',
    `--file=${file}`,
    `--api-base=${f.apiBase}`,
    '--credential=group-test',
    '--json',
  ]);
  const created: CliSessionGroupView = JSON.parse(output.splice(0).join('\n'));
  expect(created.maxDispatches).toBe(0);
  await runCli([
    'group',
    'session-run',
    created.groupId,
    `--api-base=${f.apiBase}`,
    '--credential=group-test',
    '--json',
  ]);
  const observed: CliSessionGroupView = JSON.parse(output.splice(0).join('\n'));
  expect(observed.admissionClosed).toBe('dispatch-limit-exhausted');
  expect(observed.dispatchCount).toBe(0);
  expect(observed.members[0]?.state).toBe('pending');
  expect(f.adapter.starts).toHaveLength(0);
  expect(f.adapter.turns).toHaveLength(0);
}, 30_000);

async function presetFixture() {
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
      codename: `Name_${id}`,
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
  setClientCredentialResolver(() => ({
    origin: f.apiBase,
    credential: local.credential,
  }));
  return { f, security, local, preset, path, bytes, input };
}

test('preset authentication fences unsupported and changed contexts and retains its roster', async () => {
  const { f, security, local, preset, path, bytes, input } =
    await presetFixture();
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
    maxDispatches: 0,
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
  expect(uploadedView.maxDispatches).toBe(0);
  expect(uploadedView.preset).toEqual({
    presetId: 'team',
    name: 'Delivery team',
    sha256: input.expectedPresetHash,
    stationmaster: 'lead',
    members: [
      {
        seatId: 'lead',
        codename: 'Name_lead',
        color: '#123ABC',
        role: 'Role for lead',
      },
      {
        seatId: 'check',
        codename: 'Name_check',
        color: '#123ABC',
        role: 'Role for check',
      },
      {
        seatId: 'join',
        codename: 'Name_join',
        color: '#123ABC',
        role: 'Role for join',
      },
    ],
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
  const group = await createEnsembleCliSessionGroup(f.apiBase, input);
  expect(f.adapter.starts).toHaveLength(0);
  expect(group.members.map((member) => member.seatId)).toEqual([
    'lead',
    'check',
    'join',
  ]);
  Object.defineProperty(f.adapter, 'observeExecutionAuthentication', {
    value: undefined,
    configurable: true,
  });
  const unsupported = await f.app.request(
    `/api/orchestration/session-groups/${group.groupId}/run`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${local.credential}` },
    },
  );
  expect(unsupported.status).toBe(409);
  expect(await unsupported.text()).toContain('ensemble_auth_unsupported');
  expect(f.adapter.authentications).toHaveLength(0);
  expect(f.adapter.starts).toHaveLength(0);
  Reflect.deleteProperty(f.adapter, 'observeExecutionAuthentication');
  const nativeObservation = f.adapter.observeExecutionAuthentication.bind(
    f.adapter,
  );
  Object.defineProperty(f.adapter, 'observeExecutionAuthentication', {
    configurable: true,
    value: async (input: ProviderExecutionAuthInput) => ({
      ...(await nativeObservation(input)),
    }),
  });
  const missingContinuation = await f.app.request(
    `/api/orchestration/session-groups/${group.groupId}/run`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${local.credential}` },
    },
  );
  expect(missingContinuation.status).toBe(409);
  expect(await missingContinuation.text()).toContain(
    'ensemble_auth_unsupported',
  );
  expect(f.adapter.starts).toHaveLength(0);
  expect(f.adapter.turns).toHaveLength(0);
  expect(f.adapter.authentications).toHaveLength(preset.members.length);
  f.adapter.authentications.length = 0;
  Reflect.deleteProperty(f.adapter, 'observeExecutionAuthentication');
  f.adapter.authenticationStates = [
    'authenticated',
    'authenticated',
    'unauthenticated',
  ];
  const refusedRun = await f.app.request(
    `/api/orchestration/session-groups/${group.groupId}/run`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${local.credential}` },
    },
  );
  expect(refusedRun.status, await refusedRun.clone().text()).toBe(409);
  expect(await refusedRun.text()).toContain('ensemble_auth_unverified');
  expect(f.adapter.starts).toHaveLength(0);
  expect(f.adapter.turns).toHaveLength(0);
  expect(f.adapter.authentications).toHaveLength(3);
  const refusedView = await f.app.request(
    `/api/orchestration/session-groups/${group.groupId}`,
    { headers: { Authorization: `Bearer ${local.credential}` } },
  );
  const unchanged = (
    (await refusedView.json()) as { data: CliSessionGroupView }
  ).data;
  expect(unchanged.dispatchCount).toBe(0);
  expect(unchanged.revision).toBe(group.revision);
  expect(unchanged.members.every((member) => member.state === 'pending')).toBe(
    true,
  );
  const beforeDriftProbes = f.adapter.authentications.length;
  let driftInjected = false;
  f.adapter.onAuthentication = async () => {
    if (!driftInjected) {
      driftInjected = true;
      f.changeInventory();
    }
  };
  const drifted = await f.app.request(
    `/api/orchestration/session-groups/${group.groupId}/run`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${local.credential}` },
    },
  );
  expect(drifted.status).toBe(409);
  expect(f.adapter.starts).toHaveLength(0);
  expect(driftInjected).toBe(true);
  expect(f.adapter.authentications.length).toBeGreaterThan(beforeDriftProbes);
  expect(
    f.adapter.authentications.length - beforeDriftProbes,
  ).toBeLessThanOrEqual(preset.members.length);
  f.adapter.onAuthentication = undefined;
  const beforeRunProbes = f.adapter.authentications.length;
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
  expect(final.preset).toEqual(uploadedView.preset);
  expect(JSON.stringify(final)).not.toContain('Private addition');
  expect(f.adapter.turns).toHaveLength(3);
  expect(f.adapter.authentications).toHaveLength(
    beforeRunProbes + preset.members.length * 2,
  );
  expect(
    f.adapter.authentications.every(
      (observation) =>
        observation.cwd === f.root &&
        observation.model === 'fixture-model' &&
        observation.signal instanceof AbortSignal,
    ),
  ).toBe(true);
  for (const member of preset.members) {
    const handle = final.members.find((entry) => entry.seatId === member.id)!
      .handle!;
    const turn = f.adapter.turns.find(
      (entry) => entry.threadId === handle.sessionId,
    )!;
    expect(turn.input).toContain('Review this work.');
    expect(turn.input).toContain(`Private addition for ${member.id}`);
    expect(turn.input).toContain(
      `Your Ensemble member assignment:\n${JSON.stringify({
        id: member.id,
        codename: member.codename,
        role: member.role,
        stationmaster: member.id === preset.stationmaster,
      })}`,
    );
    for (const id of ['lead', 'check', 'join'])
      expect(turn.input).toContain(`"id":"${id}"`);
    expect(
      f.adapter.starts.find((entry) => entry.threadId === handle.sessionId)
        ?.modelId,
    ).toBe('fixture-model');
  }
  const replayed = await f.app.request(
    `/api/orchestration/session-groups/${group.groupId}/run`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${local.credential}` },
    },
  );
  expect(replayed.status).toBe(200);
  expect(f.adapter.authentications).toHaveLength(
    beforeRunProbes + preset.members.length * 2,
  );
  expect(f.adapter.turns).toHaveLength(3);
  writeFileSync(path, `${bytes} `);
  await expect(
    createEnsembleCliSessionGroup(f.apiBase, {
      ...input,
      operationId: 'stale',
    }),
  ).rejects.toThrow();
  expect(f.adapter.turns).toHaveLength(3);
  const recordPath = join(
    f.root,
    'runtime',
    'cli-session-groups',
    `${group.groupId}.json`,
  );
  const originalRecord = readFileSync(recordPath);
  const stored: { preset: { members: { seatId: string }[] } } = JSON.parse(
    originalRecord.toString(),
  );
  stored.preset.members[0]!.seatId = 'foreign-seat';
  try {
    writeFileSync(recordPath, JSON.stringify(stored));
    const mismatched = await f.app.request(
      `/api/orchestration/session-groups/${group.groupId}`,
      {
        headers: { Authorization: `Bearer ${local.credential}` },
      },
    );
    expect(mismatched.status).toBe(409);
    expect(await mismatched.text()).toContain('group_storage_unavailable');
  } finally {
    writeFileSync(recordPath, originalRecord);
  }
}, 30_000);

test.each([11_000, 31_000])(
  'a pending seat refreshes login before a %ims dispatch preparation while keeping the 30s launch fence',
  async (preparationMs) => {
    const { f, local, input } = await presetFixture();
    const base = Date.now();
    let now = base;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const group = await createEnsembleCliSessionGroup(f.apiBase, {
      ...input,
      operationId: `fresh-before-dispatch-${preparationMs}`,
      maxConcurrent: 1,
    });
    f.adapter.onAuthentication = async () => {
      // Later roster observations consume time without expiring the first one yet.
      if (f.adapter.authentications.length === 2) now = base + 20_000;
    };
    let prepared = false;
    f.setPreparation(async () => {
      if (!prepared) {
        prepared = true;
        now += preparationMs;
      }
    });
    const stop = new AbortController();
    const headers = { Authorization: `Bearer ${local.credential}` };
    const running = Promise.resolve(
      f.app.request(`/api/orchestration/session-groups/${group.groupId}/run`, {
        method: 'POST',
        headers,
        signal: stop.signal,
      }),
    );
    void running.catch(() => {});
    try {
      const response = await running;
      expect(response.status, await response.clone().text()).toBe(200);
      const view = ((await response.json()) as { data: CliSessionGroupView })
        .data;
      const lead = view.members.find((member) => member.seatId === 'lead');
      expect(prepared).toBe(true);
      if (preparationMs === 11_000) {
        expect(
          lead?.handle,
          'fresh login must survive the 11s preparation',
        ).toBeDefined();
        expect(f.adapter.turns).toHaveLength(3);
      } else {
        expect(lead?.handle).toBeUndefined();
        expect(lead?.dispatchFailure).toBeDefined();
        expect(f.groupWarnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              message: 'CLI group member dispatch refused',
              meta: expect.objectContaining({
                reason: expect.stringContaining('ensemble_auth_stale'),
              }),
            }),
          ]),
        );
        expect(
          f.adapter.turns.some(
            (turn) => turn.threadId === lead?.reservedSessionId,
          ),
        ).toBe(false);
      }
    } finally {
      stop.abort();
      await Promise.allSettled([running]);
    }
  },
  30_000,
);

test('preset authentication cancellation and changed start context stop member effects', async () => {
  const { f, local, input } = await presetFixture();
  const cancelledGroup = await createEnsembleCliSessionGroup(f.apiBase, {
    ...input,
    operationId: 'cancel-during-auth',
  });
  let signalObserved: (() => void) | undefined;
  const authEntered = new Promise<void>((resolve) => {
    signalObserved = resolve;
  });
  f.adapter.onAuthentication = async (probe) => {
    signalObserved?.();
    await new Promise<void>((resolve) => {
      if (probe.signal?.aborted) resolve();
      else
        probe.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
    });
  };
  const cancellingRun = f.app.request(
    `/api/orchestration/session-groups/${cancelledGroup.groupId}/run`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${local.credential}` },
    },
  );
  await authEntered;
  const cancelled = await f.app.request(
    `/api/orchestration/session-groups/${cancelledGroup.groupId}/cancel`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${local.credential}` },
    },
  );
  expect(cancelled.status).toBe(200);
  expect((await cancellingRun).status).toBe(409);
  expect(f.adapter.authentications.length).toBeGreaterThanOrEqual(1);
  expect(f.adapter.authentications.length).toBeLessThanOrEqual(
    Object.keys(input.bindings).length,
  );
  expect(
    f.adapter.authentications.every((probe) => probe.signal?.aborted === true),
  ).toBe(true);
  expect(f.adapter.starts).toHaveLength(0);
  expect(f.adapter.turns).toHaveLength(0);
  f.adapter.onAuthentication = undefined;
  const changedBeforeStart = await createEnsembleCliSessionGroup(f.apiBase, {
    ...input,
    operationId: 'config-during-start',
  });
  f.setPreparation(async () => f.changeInventory());
  const changedRun = await f.app.request(
    `/api/orchestration/session-groups/${changedBeforeStart.groupId}/run`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${local.credential}` },
    },
  );
  expect(changedRun.status).toBe(200);
  const changedView = (
    (await changedRun.json()) as { data: CliSessionGroupView }
  ).data;
  expect(
    changedView.members.every((member) => member.handle === undefined),
  ).toBe(true);
  expect(f.adapter.starts).toHaveLength(0);
  expect(f.adapter.turns).toHaveLength(0);
  f.setPreparation(async () => {});
}, 30_000);

test('bound Station Control operates its real session group and cannot read another caller group', async () => {
  const f = await fixture(true, true);
  const open = async (sessionId: string) => {
    const instance = claudeInProcessStationControlOptions(
      () => f.resolveCallerRecord,
    ).createInProcessStationControl(sessionId);
    const replies = new Map<
      number,
      { resolve(reply: StationControlReply): void; reject(error: Error): void }
    >();
    const transport: {
      onmessage?: (message: unknown) => void;
      start(): Promise<void>;
      close(): Promise<void>;
      send(message: unknown): Promise<void>;
      [key: string]: unknown;
    } = {
      start: async () => {},
      close: async () => {
        for (const reply of replies.values())
          reply.reject(new Error('Station Control transport closed'));
        replies.clear();
      },
      send: async (message) => {
        const response = JSONRPCResponseSchema.safeParse(message);
        if (!response.success || typeof response.data.id !== 'number') return;
        const reply = replies.get(response.data.id);
        replies.delete(response.data.id);
        reply?.resolve(response.data);
      },
    };
    await instance.connect(transport);
    cleanup.push(() => instance.close());
    let id = 0;
    const request = async (method: string, params: unknown) => {
      const current = ++id;
      const deliver = transport.onmessage;
      if (!deliver) throw new Error('Station Control transport not connected');
      const response = new Promise<StationControlReply>((resolve, reject) => {
        replies.set(current, { resolve, reject });
      });
      setImmediate(() =>
        deliver({ jsonrpc: '2.0', id: current, method, params }),
      );
      const reply = await response;
      if ('error' in reply)
        throw new Error(`Station Control protocol error: ${reply.error.code}`);
      return reply;
    };
    await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'integration', version: '1' },
    });
    return async (name: string, args: unknown) => {
      const response = await request('tools/call', { name, arguments: args });
      const result = CallToolResultSchema.parse(response.result);
      const content = result.content[0];
      if (content?.type !== 'text')
        throw new Error('Station Control returned no text result');
      return {
        isError: result.isError,
        body: JSON.parse(content.text),
      };
    };
  };
  const owner = await open('op-group-integration');
  const other = await open('other-group-integration');
  const created = await owner('create_session_group', groupInput(1));
  expect(created.body.success, JSON.stringify(created)).toBe(true);
  const groupId = created.body.data.groupId;
  const listed = await owner('list_session_groups', {});
  expect(
    listed.body.data.groups.map((group: CliSessionGroupView) => group.groupId),
  ).toContain(groupId);
  expect(
    (await owner('get_session_group', { groupId })).body.data.groupId,
  ).toBe(groupId);
  const foreign = await other('get_session_group', { groupId });
  expect(foreign.isError).toBe(true);
  expect(foreign.body.code).toBe('group_not_found');
  const run = await owner('run_session_group', { groupId });
  expect(run.body.success, JSON.stringify(run)).toBe(true);
  expect(
    f.adapter.turns,
    JSON.stringify({ body: run.body, warnings: f.groupWarnings }),
  ).toHaveLength(1);
  const events = await owner('get_session_group_events', {
    groupId,
    afterRevision: 0,
  });
  expect(events.body.data.events.length).toBeGreaterThan(0);
  expect(events.body.data.groupId).toBe(groupId);
  f.adapter.syncOutputs.push('ACK SYNC run-one');
  const synced = await owner('sync_session_group', {
    groupId,
    operationId: 'sync-one',
    runId: 'run-one',
    content: 'retained context',
    deadlineAt: Date.now() + 60000,
  });
  expect(synced.body.data.contextSync?.status, JSON.stringify(synced)).toBe(
    'acknowledged',
  );
  const preset = JSON.stringify({
    version: 'station.ensemble/v1',
    id: 'team',
    name: 'Team',
    stationmaster: 'lead',
    members: [
      {
        id: 'lead',
        codename: 'Lead',
        color: '#123ABC',
        role: 'Review',
        engine: 'claude',
        model: 'fixture-model',
        reasoning: null,
        options: {},
        promptAppends: [],
      },
    ],
  });
  const ensemble = await owner('create_session_group_from_ensemble', {
    operationId: 'inline-one',
    maxConcurrent: 1,
    deadlineAt: Date.now() + 60000,
    presetJson: preset,
    expectedPresetHash: `sha256:${createHash('sha256').update(preset).digest('hex')}`,
    brief: 'Review',
    bindings: {
      lead: {
        target: {
          agent: 'reviewer',
          expectedEngine: { kind: 'connection', connectionId: 'claude' },
          workspace: { kind: 'directory', cwd: f.root },
        },
        needs: [],
      },
    },
  });
  expect(ensemble.body.success, JSON.stringify(ensemble)).toBe(true);
  const samePrincipalForeign = await open('op-foreign-session');
  const foreignSession = await samePrincipalForeign('get_session_group', {
    groupId,
  });
  expect(foreignSession.isError).toBe(true);
  expect(foreignSession.body.code).toBe('group_not_found');
  const rotated = await open('op-group-integration');
  const reopened = await rotated('get_session_group', { groupId });
  expect(reopened.body.data.groupId).toBe(groupId);
  const cancel = await rotated('cancel_session_group', { groupId });
  expect(cancel.body.success, JSON.stringify(cancel)).toBe(true);
  const revocable = await open('op-group-revoke');
  const second = await revocable('create_session_group', {
    ...groupInput(1),
    operationId: 'revoked-group',
  });
  expect(second.body.success).toBe(true);
  const startsBefore = f.adapter.starts.length;
  let revoked = false;
  f.setPreparation(async () => {
    revoked = true;
    revokeStationControlMcpToken('op-group-revoke', 'station-control');
  });
  const refusedRun = await revocable('run_session_group', {
    groupId: second.body.data.groupId,
  });
  expect(revoked).toBe(true);
  expect(refusedRun.isError).toBe(true);
  expect(refusedRun.body.code).toBe('group_authority_required');
  expect(f.adapter.starts).toHaveLength(startsBefore);
  const resumed = await open('op-group-revoke');
  const recovered = await resumed('get_session_group', {
    groupId: second.body.data.groupId,
  });
  expect(recovered.body.data.members[0].handle).toBeUndefined();
  expect(
    (
      await resumed('cancel_session_group', {
        groupId: second.body.data.groupId,
      })
    ).body.success,
  ).toBe(true);
}, 30_000);

test('bound inspection joins only the authorized recorded preset group and preserves pending and completed references', async () => {
  const { f, security, local, bytes, input } = await presetFixture();
  const group = await createEnsembleCliSessionGroup(f.apiBase, {
    ...input,
    maxConcurrent: 1,
  });
  const inspect = (
    overrides: Record<string, unknown> = {},
    credential = local.credential,
  ) =>
    f.app.request('/api/orchestration/ensembles/inspect', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        presetJson: bytes,
        expectedPresetHash: input.expectedPresetHash,
        bindings: {},
        groupId: group.groupId,
        ...overrides,
      }),
    });
  const pending = await inspect();
  expect(pending.status, await pending.clone().text()).toBe(200);
  const pendingData = ((await pending.json()) as { data: EnsembleInspection })
    .data;
  expect(pendingData.groupInspection).toEqual({
    state: 'bound',
    groupId: group.groupId,
    revision: group.revision,
  });
  expect(
    pendingData.facts.find((fact) => fact.id === 'needs:join')?.needs,
  ).toEqual(['lead', 'check']);
  expect(
    pendingData.facts.find((fact) => fact.id === 'outputs:lead'),
  ).toMatchObject({ state: 'unknown', origin: 'runtime-derived' });
  expect(f.adapter.authentications).toHaveLength(0);
  expect(f.adapter.starts).toHaveLength(0);
  for (const overrides of [
    { verifyAuthentication: true },
    { groupBindings: {} },
    { bindings: { lead: { agent: 'reviewer', projectSlug: 'project' } } },
  ])
    expect((await inspect(overrides)).status).toBe(400);
  const changed = bytes.replace('Delivery team', 'Different team');
  const mismatch = await inspect({
    presetJson: changed,
    expectedPresetHash: `sha256:${createHash('sha256').update(changed).digest('hex')}`,
  });
  expect(mismatch.status).toBe(409);
  expect(await mismatch.text()).not.toContain(group.groupId);
  const unauthorized = await inspect({}, 'not-authorized');
  expect(unauthorized.status).toBe(403);
  expect(await unauthorized.text()).not.toContain(group.groupId);
  const recordPath = join(
    f.root,
    'runtime',
    'cli-session-groups',
    `${group.groupId}.json`,
  );
  const savedRecord = readFileSync(recordPath, 'utf8');
  const recorded = JSON.parse(savedRecord);
  for (const [preset, expectedStatus] of [
    [{ ...recorded.preset, members: undefined }, 422],
    [{ ...recorded.preset, stationmaster: 'check' }, 409],
    [
      {
        ...recorded.preset,
        members: recorded.preset.members.map((member: { seatId: string }) => ({
          ...member,
          seatId: `${member.seatId}_other`,
        })),
      },
      422,
    ],
  ] as const) {
    writeFileSync(recordPath, JSON.stringify({ ...recorded, preset }));
    try {
      const refused = await inspect();
      expect(refused.status, await refused.clone().text()).toBe(expectedStatus);
      expect(await refused.text()).not.toContain(group.groupId);
    } finally {
      writeFileSync(recordPath, savedRecord);
    }
  }
  let releaseStart!: () => void;
  f.adapter.startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let startsReached!: () => void;
  const startsReady = new Promise<void>((resolve) => {
    startsReached = resolve;
  });
  const nativeStart = f.adapter.startSession.bind(f.adapter);
  const startObservation = vi
    .spyOn(f.adapter, 'startSession')
    .mockImplementation((target) => {
      const pending = nativeStart(target);
      if (f.adapter.starts.length === 1) startsReached();
      return pending;
    });
  const running = f.app.request(
    `/api/orchestration/session-groups/${group.groupId}/run`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${local.credential}` },
    },
  );
  try {
    await Promise.race([
      startsReady,
      Promise.resolve(running).then(async (response) => {
        throw new Error(
          `Group run settled before the held starts: ${response.status}`,
        );
      }),
    ]);
    const reserved = await inspect();
    expect(reserved.status, await reserved.clone().text()).toBe(200);
    const reservedData = (
      (await reserved.json()) as { data: EnsembleInspection }
    ).data;
    const unconfirmed = reservedData.facts.filter(
      (fact) =>
        fact.category === 'output destinations' &&
        JSON.parse(fact.value).state === 'launch-intent',
    );
    expect(unconfirmed.length).toBeGreaterThan(0);
    for (const fact of unconfirmed) {
      expect(fact.state).toBe('unknown');
      expect(JSON.parse(fact.value)).toMatchObject({
        reservedSessionId: expect.any(String),
        observation:
          'Launch outcome indeterminate; reservation is not a confirmed Session.',
      });
      expect(fact.owner.href).toBeUndefined();
    }
  } finally {
    startObservation.mockRestore();
    releaseStart();
  }
  const ran = await running;
  expect(ran.status, await ran.clone().text()).toBe(200);
  const final = ((await ran.json()) as { data: CliSessionGroupView }).data;
  f.adapter.syncOutputs.push(
    'ACK SYNC run-one',
    'ACK SYNC run-one',
    'ACK SYNC run-one',
  );
  const synced = await f.app.request(
    `/api/orchestration/session-groups/${group.groupId}/sync`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${local.credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        operationId: 'inspection-sync',
        runId: 'run-one',
        content: 'Private synced context',
        deadlineAt: Date.now() + 60_000,
      }),
    },
  );
  expect(synced.status, await synced.clone().text()).toBe(200);
  const retainedSync = await f.app.request(
    `/api/orchestration/session-groups/${group.groupId}`,
    { headers: { Authorization: `Bearer ${local.credential}` } },
  );
  expect(retainedSync.status).toBe(200);
  const synchronized = (
    (await retainedSync.json()) as { data: CliSessionGroupView }
  ).data;
  const authCount = f.adapter.authentications.length;
  const result = await inspect();
  expect(result.status, await result.clone().text()).toBe(200);
  const data = ((await result.json()) as { data: EnsembleInspection }).data;
  expect(data.groupInspection).toEqual({
    state: 'bound',
    groupId: group.groupId,
    revision: synchronized.revision,
  });
  for (const member of final.members) {
    const fact = data.facts.find(
      (entry) => entry.id === `outputs:${member.seatId}`,
    )!;
    expect(JSON.parse(fact.value)).toMatchObject({
      state: member.state,
      handle: member.handle,
      terminalEvent: member.terminalEvent,
    });
    expect(fact.owner.href).toBe(
      `/?surface=activity&session=${encodeURIComponent(member.handle!.sessionId)}`,
    );
  }
  expect(
    JSON.parse(data.facts.find((fact) => fact.id === 'group-flow')!.value),
  ).toEqual(final.flow);
  expect(f.adapter.authentications).toHaveLength(authCount);
  for (const receipt of synchronized.contextSync!.members) {
    const memory = data.facts.find(
      (fact) => fact.id === `memory:${receipt.seatId}`,
    )!;
    expect(JSON.parse(memory.value)).toMatchObject({
      contentHash: synchronized.contextSync!.contentHash,
      member: receipt,
    });
    expect(memory.value).toContain(
      'native/shared memory, acceptance and grants unverified',
    );
  }
  const syncedRecord = readFileSync(recordPath, 'utf8');
  const storedSync = JSON.parse(syncedRecord);
  for (const [status, expectedState] of [
    ['pending', 'unknown'],
    ['unknown', 'unknown'],
    ['failed', 'unavailable'],
  ] as const) {
    const altered = structuredClone(storedSync);
    altered.syncs.at(-1).status = 'incomplete';
    altered.syncs.at(-1).members[0].status = status;
    writeFileSync(recordPath, JSON.stringify(altered));
    try {
      const observed = await inspect();
      expect(observed.status, await observed.clone().text()).toBe(200);
      const incomplete = (
        (await observed.json()) as { data: EnsembleInspection }
      ).data;
      expect(
        incomplete.facts.find(
          (fact) =>
            fact.id === `memory:${altered.syncs.at(-1).members[0].seatId}`,
        )?.state,
      ).toBe(expectedState);
    } finally {
      writeFileSync(recordPath, syncedRecord);
    }
  }
  expect(JSON.stringify(data)).not.toContain('Private synced context');
  expect(f.adapter.turns).toHaveLength(6);
  const actualFlow =
    await vi.importActual<typeof import('@kontourai/flow')>('@kontourai/flow');
  let groupReads = 0;
  vi.mocked(Flow.loadRun).mockImplementation(async (...args) => {
    const run = await actualFlow.loadRun(...args);
    if (++groupReads === 2) {
      const cancelled = await f.app.request(
        `/api/orchestration/session-groups/${group.groupId}/cancel`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${local.credential}` },
        },
      );
      expect(cancelled.status).toBe(200);
    }
    return run;
  });
  try {
    const raced = await inspect();
    expect(groupReads).toBeGreaterThanOrEqual(2);
    expect(raced.status, await raced.clone().text()).toBe(409);
    expect(await raced.json()).toMatchObject({
      code: 'ensemble_inspection_stale',
    });
  } finally {
    vi.mocked(Flow.loadRun).mockImplementation(actualFlow.loadRun);
  }
  const canRead = vi
    .spyOn(f.service, 'canUserReadSession')
    .mockReturnValue(false);
  const unreadable = await inspect();
  expect(unreadable.status).toBe(422);
  expect(await unreadable.text()).not.toContain(
    final.members[0]!.handle!.sessionId,
  );
  canRead.mockRestore();
  const access = f.inventory.resolveEnvironmentAccess.bind(f.inventory);
  let reads = 0;
  vi.spyOn(f.inventory, 'resolveEnvironmentAccess').mockImplementation(
    async (target) => {
      const result = await access(target);
      if (++reads === 2) {
        const cancelled = await f.app.request(
          `/api/orchestration/session-groups/${group.groupId}/cancel`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${local.credential}` },
          },
        );
        expect(cancelled.status).toBe(200);
      }
      return result;
    },
  );
  const stale = await inspect();
  expect(reads).toBe(2);
  expect(stale.status).toBe(409);
  expect(await stale.text()).not.toContain(final.members[0]!.handle!.sessionId);
  reads = 0;
  vi.mocked(f.inventory.resolveEnvironmentAccess).mockImplementation(
    async (target) => {
      const result = await access(target);
      if (++reads === 2)
        security.devicePairing.revokeDevice(
          local.device.id,
          'operator-credential',
        );
      return result;
    },
  );
  const revoked = await inspect();
  expect(reads).toBe(2);
  expect(revoked.status).toBe(403);
  expect(await revoked.text()).not.toContain(
    final.members[0]!.handle!.sessionId,
  );
}, 30_000);
