/**
 * #2436: a Task dispatch that asks for full access (`runtimeConfig.
 * modelOptions.approvalMode: 'never'`) needs the operator in person or a
 * device holding `approval:full-access`, on every route that dispatches:
 * `POST /api/tasks/:taskId/dispatch` and Starter Work's `start-task` launch.
 *
 * Real pieces: the Station's security service pairs the devices and stores
 * the grant, the runtime auth boundary stamps principal and scope, both
 * routes decide, a real `StarterRegistry` launches, and a real
 * `TaskDispatcher` enforces the grant. Only the graph, the claim and the
 * engine start are fakes; the engine start records what it was asked for.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PAIRING_SCOPE_APPROVAL_FULL_ACCESS,
  PAIRING_SCOPE_PRESETS,
  type PairingScopePreset,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import type {
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
} from '../../../providers/adapter-shape.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { createOrchestrationRequestPrincipalResolver } from '../../../runtime/bootstrap/orchestration-request-principal.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { createAgentDispatchActorResolver } from '../../../runtime/mcp/station-control-caller.js';
import { configureDevicePairingHostRoutes } from '../../../runtime/routes/runtime-routes.js';
import { isFullAccessGrant } from '../../../security/coding-authority.js';
import { bindFullAccessRefusalIdentity } from '../../../security/full-access-refusal.js';
import { isRuntimeRequestPrincipalCurrent } from '../../../security/runtime-request-security.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventBus as RealEventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { sessionOwnerStampFor } from '../../../services/orchestration/session-owner-attribution.js';
import {
  createTaskDispatcher,
  type TaskDispatchRemoteSessions,
  type TaskDispatchReservation,
} from '../../../services/projects/task-dispatcher.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { StarterRegistry } from '../../../services/starter-work/starter-registry.js';
import { StarterWorkModule } from '../../../services/starter-work/starter-work-module.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import { createLogger } from '../../../utils/logger.js';
import { createStarterWorkRoutes } from '../../starter-work.js';
import { createTaskRoutes } from '../tasks.js';

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** #1796: the refusal names the paired device and the operator's grant path. */
function refusedFor(phone: { device: { id: string; name: string } }) {
  const short = phone.device.id.slice(0, 8);
  const cli = `station environment access scope ${short} --add approval:full-access`;
  return {
    success: false,
    code: 'approval-full-access-not-granted',
    error: `Full access was not applied. Only this Station's operator can allow full access, for this device (id ${short}). On the Station's host, the operator can run: ${cli}`,
    details: {
      requested: 'never',
      requester: {
        kind: 'device',
        deviceId: short,
        deviceName: phone.device.name,
      },
      station: { environmentId: expect.any(String) },
      grant: {
        by: 'operator',
        scope: 'approval:full-access',
        uiSteps: [
          "Open the Station desktop app on the Station's host.",
          'Select the Station name (top right), then Paired devices.',
          'Select the device by its name, then Change access.',
          'Turn on Allow full access, then Apply.',
        ],
        cli,
      },
    },
  };
}

const reservation: TaskDispatchReservation = {
  task: { id: 'task-1', projectId: 'project-1' } as never,
  sessionId: 'session-1',
  provider: 'claude',
  sourceSurface: 'api',
  modelId: undefined,
};

/**
 * #1796 H1: an engine that persists what it was started with, so the
 * session's start stamp and grantor are read back the way a turn reads them.
 */
class StampRecordingEngine {
  readonly provider = 'claude' as const;
  readonly metadata = {
    displayName: 'claude',
    description: 'task dispatch grant test engine',
    capabilities: ['agent-runtime'],
  };
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly turns: ProviderSendTurnInput[] = [];
  private readonly sessions = new Map<string, ProviderSession>();
  async startSession(input: ProviderSessionStartInput) {
    const now = new Date().toISOString();
    this.events.push({
      eventId: `${input.threadId}:session.started`,
      provider: this.provider,
      threadId: input.threadId,
      createdAt: now,
      method: 'session.started',
      sessionId: input.threadId,
      metadata: { ...input.metadata },
    } as CanonicalRuntimeEvent);
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(input.threadId, session);
    return session;
  }
  async sendTurn(input: ProviderSendTurnInput) {
    this.turns.push(input);
    return { threadId: input.threadId, turnId: `turn-${this.turns.length}` };
  }
  async interruptTurn() {
    return { outcome: 'no-active-turn' } as const;
  }
  async respondToRequest(): Promise<void> {}
  async stopSession(threadId: string): Promise<void> {
    this.sessions.delete(threadId);
  }
  async listSessions() {
    return [...this.sessions.values()];
  }
  async hasSession(threadId: string) {
    return this.sessions.has(threadId);
  }
  async stopAll(): Promise<void> {}
  streamEvents(options?: { signal?: AbortSignal }) {
    return this.events.iterable(options);
  }
}

async function fixture(options: { realStarts?: boolean } = {}) {
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
  const root = mkdtempSync(join(tmpdir(), 'station-task-dispatch-grant-'));
  roots.push(root);
  const security = new EnvironmentSecurityService({
    homeDir: join(root, 'security'),
  });
  const operator = await security.initialize();
  const pair = (name: string, preset: PairingScopePreset = 'standard') => {
    const offer = security.devicePairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: pairingScopePresetString(preset),
    });
    const requested = security.devicePairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: name,
    });
    security.devicePairing.confirmRequest(requested.requestId, {
      kind: 'presented-credential',
    });
    return security.devicePairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: requested.requestId,
    });
  };
  const grant = (deviceId: string, preset: PairingScopePreset = 'standard') =>
    security.devicePairing.setDeviceScope(
      deviceId,
      [...PAIRING_SCOPE_PRESETS[preset], PAIRING_SCOPE_APPROVAL_FULL_ACCESS],
      { kind: 'presented-credential' },
    );

  // The engine start: records the modelOptions each session starts with.
  const started: Array<Record<string, unknown> | undefined> = [];
  // And the principal each session is recorded as belonging to.
  const owners: Array<{ ownerUserId: string; ownerAttribution?: string }> = [];
  // #1796 H1: with `realStarts`, the start goes to a real orchestration
  // service the way `TaskGraphService`'s `startOrSeed` hands it: the Task
  // session's start input, and the grant as its context.
  const engine = new StampRecordingEngine();
  const store = options.realStarts
    ? new EventStore(join(root, 'orchestration.sqlite'))
    : undefined;
  const service = store
    ? new OrchestrationService({
        adapterRegistry: {
          register() {},
          get: (provider: string) =>
            provider === engine.provider ? engine : undefined,
          list: () => [engine],
        },
        eventBus: new RealEventBus(),
        eventStore: store,
        logger: { debug: vi.fn(), warn: vi.fn() },
        isFullAccessGrantorCurrent: (deviceId: string) =>
          security.deviceHoldsFullAccess(deviceId),
      } as never)
    : undefined;
  if (service && store)
    cleanups.push(async () => {
      await service.shutdown();
      store.close();
    });
  const startedThreads: string[] = [];
  const startOrSeed = vi.fn<TaskDispatchRemoteSessions['startOrSeed']>(
    async (_reservation, intent) => {
      started.push(intent.runtimeConfig?.modelOptions);
      if (service) {
        const threadId = `task-session-${startedThreads.length + 1}`;
        startedThreads.push(threadId);
        await service.dispatch(
          {
            type: 'startSession',
            input: {
              threadId,
              provider: 'claude',
              modelOptions: intent.runtimeConfig?.modelOptions,
              metadata: { userId: intent.ownerUserId },
            },
          },
          {
            // Deliberately the grant alone (the shape the delta review
            // probed): the grant names its own grantor.
            ...(intent.fullAccessGrant
              ? { fullAccessGrant: intent.fullAccessGrant }
              : {}),
          },
        );
      }
      owners.push({
        ownerUserId: intent.ownerUserId,
        ...(intent.ownerAttribution
          ? { ownerAttribution: intent.ownerAttribution }
          : {}),
      });
      return {
        session: { threadId: 'session-1', provider: 'claude' } as never,
        outcome: 'started',
      };
    },
  );
  const reserve = vi.fn(async () => ({
    kind: 'reserved' as const,
    reservation,
  }));
  const dispatcher = createTaskDispatcher(
    {
      reserve,
      markProviderStarting: async () => {},
      associate: async () =>
        ({
          task: {},
          dispatch: {},
          session: { threadId: 'session-1' },
          links: [],
        }) as never,
      markIndeterminate: async () => {},
      releaseReservation: async () => ({ kind: 'released' as const }),
    },
    {
      claim: async () => undefined,
      compensate: async () => ({ kind: 'released' as const }),
    },
    {
      readiness: () => ({ kind: 'ready' as const }),
      mayHaveStarted: () => false,
      startOrSeed,
    },
    { succeeded: () => {}, failed: () => {} },
  );

  // #2493: the continue-session owner records the grant it is handed.
  const continueSession = vi.fn(
    async (_input: {
      fullAccessGrant: unknown;
      owner: { ownerUserId: string; ownerAttribution?: string };
    }) => ({
      state: 'continued' as const,
      session: { threadId: 'adopted-child', controlMode: 'station-owned' },
    }),
  );
  const createTaskIdempotent = vi.fn(
    async () =>
      ({ id: 'task-1', projectId: 'project-1', agentId: 'station' }) as never,
  );
  const registry = new StarterRegistry(
    new StarterWorkModule(join(root, 'starter-work.json')),
    {
      readTaskForOpen: async (id: string) =>
        id === 'task-1' ? { id, projectId: 'project-1' } : null,
      createTaskIdempotent,
      readTaskGraph: async () => ({ links: [] }),
    } as never,
    dispatcher,
    {
      check: async () => ({ state: 'ready' as const }),
      checkScheduled: async () => ({ state: 'ready' as const }),
    },
    {
      read: async (sessionId: string) => ({
        threadId: sessionId,
        controlMode: 'read-only-attached' as const,
      }),
      continue: continueSession,
    } as never,
    () => ({ firstRun: { status: 'completed' } }) as never,
    {
      candidate: async () => ({ state: 'missing' as const }),
      resolve: async () => ({ state: 'missing' as const }),
    },
    { prepare: vi.fn() } as never,
  );

  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: createLogger({ name: 'task-dispatch-grant', level: 'error' }),
    eventBus: { emit() {} } as unknown as EventBus,
    security: {
      verifyCredential: (candidate, request) =>
        request !== undefined &&
        security.authorizeCredential(candidate, request),
      recognizeCredential: (candidate) => security.verifyCredential(candidate),
      resolveGrantedScope: (candidate) =>
        security.resolveGrantedScope(candidate),
      resolveCredentialAuthority: (candidate) =>
        security.verifyOperatorCredential(candidate)
          ? 'operator-credential'
          : security.identifyDevice(candidate)
            ? 'device-credential'
            : undefined,
      resolveCredentialDeviceId: (candidate) =>
        security.identifyDevice(candidate)?.id,
      resolveCredentialLocality: (candidate) =>
        security.credentialLocality(candidate),
      resolveCredentialMintKind: (candidate) =>
        security.credentialMintKind(candidate),
      allowedOrigins: [],
    },
  });
  app.use('*', async (c, next) => {
    bindFullAccessRefusalIdentity(c.req.raw, {
      environmentId: () => security.devicePairing.environmentId(),
      deviceName: (deviceId) =>
        security.devicePairing
          .listDevices()
          .find((device) => device.id === deviceId)?.name,
    });
    await next();
  });
  // Production's request principal: the same resolver the runtime routes
  // compose, over the runtime auth boundary's verified credential facts.
  const resolvePrincipal = createOrchestrationRequestPrincipalResolver({
    environmentSecurityService: security,
  });
  const principals = new WeakMap<Request, string>();
  app.use('/api/tasks/*', async (c, next) => {
    principals.set(c.req.raw, resolvePrincipal(c as never).id);
    await next();
  });
  // Production's agent verdict with no station-control caller registry:
  // every request carrying Station's internal token is an unverified agent.
  const agentActor = createAgentDispatchActorResolver();
  app.route(
    '/api/tasks',
    createTaskRoutes(
      {} as never,
      {
        taskDispatcher: dispatcher,
        readAuthorityForRequest: (request: Request) =>
          sessionReadAuthorityFromRequest(
            principals.get(request)!,
            undefined,
            undefined,
          ),
        dispatchOwnerForRequest: (request: Request) =>
          sessionOwnerStampFor(principals.get(request)!, agentActor(request)),
      } as never,
    ),
  );
  app.route(
    '/api/starter-work',
    createStarterWorkRoutes(registry, {
      ownerForRequest: (c) =>
        sessionOwnerStampFor(
          resolvePrincipal(c as never).id,
          agentActor(c.req.raw),
        ),
    }),
  );

  const post = async (credential: string, path: string, body: unknown) => {
    const res = await app.request(path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  /** Station's internal principal: per-boot token, `local`, loopback. */
  const postInternally = async (path: string, body: unknown) => {
    const res = await app.request(
      path,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_PROXY_CALLER_HEADER]: 'local',
        },
        body: JSON.stringify(body),
      },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never,
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  const dispatchTask = (credential: string, approvalMode: string) =>
    post(credential, '/api/tasks/task-1/dispatch', {
      runtimeConfig: { provider: 'claude', modelOptions: { approvalMode } },
    });
  let operation = 0;
  const launchStarter = (credential: string, approvalMode: string) =>
    post(credential, '/api/starter-work/launch', {
      starterId: 'start-task',
      operationId: `launch-${++operation}`,
      task: { projectId: 'project-1', title: 'First task' },
      dispatch: {
        runtimeConfig: { provider: 'claude', modelOptions: { approvalMode } },
      },
    });

  // #1796 H1: the operator's device-access routes, reset wired as the
  // runtime wires it.
  if (service)
    configureDevicePairingHostRoutes(app as never, security.devicePairing, {
      verifyOperatorCredential: (candidate) =>
        security.verifyOperatorCredential(candidate),
      isApprovalCurrent: (req) =>
        isRuntimeRequestPrincipalCurrent(req, security),
      isRequestPrincipalCurrent: (req) =>
        isRuntimeRequestPrincipalCurrent(req, security),
      resetFullAccessGrantedBy: (input) =>
        service.resetFullAccessGrantedBy(input),
    });

  return {
    operator,
    pair,
    grant,
    engine,
    store,
    service,
    startedThreads,
    security,
    post,
    postInternally,
    continueSession,
    dispatchTask,
    launchStarter,
    started,
    owners,
    reserve,
    createTaskIdempotent,
  };
}

test('a device without the grant cannot dispatch a Task at full access', async () => {
  const f = await fixture();
  const phone = f.pair('Phone');
  expect(await f.dispatchTask(phone.credential, 'never')).toEqual({
    status: 403,
    body: refusedFor(phone),
  });
  expect(f.reserve).not.toHaveBeenCalled();
  expect(f.started).toEqual([]);
});

test('a device without the grant cannot launch Starter Work at full access, and no Task is left behind', async () => {
  const f = await fixture();
  const phone = f.pair('Phone');
  expect(await f.launchStarter(phone.credential, 'never')).toEqual({
    status: 403,
    body: refusedFor(phone),
  });
  expect(f.createTaskIdempotent).not.toHaveBeenCalled();
  expect(f.started).toEqual([]);
});

test('the same device may dispatch and launch at a stricter posture', async () => {
  const f = await fixture();
  const phone = f.pair('Phone');
  expect((await f.dispatchTask(phone.credential, 'ask')).status).toBe(200);
  const launched = await f.launchStarter(phone.credential, 'auto');
  expect(launched.status).toBe(201);
  expect(launched.body.data.dispatch.state).toBe('dispatched');
  expect(f.started).toEqual([
    { approvalMode: 'ask' },
    { approvalMode: 'auto' },
  ]);
});

test.each([
  ['a granted device', true],
  ['the operator in person', false],
] as const)(
  '%s reaches the engine at full access through both routes',
  async (_name, device) => {
    // One fixture per actor: Starter Work correlates one Task per launch.
    const f = await fixture();
    let credential = f.operator.credential;
    if (device) {
      const phone = f.pair('Phone');
      f.grant(phone.device.id);
      credential = phone.credential;
    }
    expect((await f.dispatchTask(credential, 'never')).status).toBe(200);
    const launched = await f.launchStarter(credential, 'never');
    expect(launched.status).toBe(201);
    expect(launched.body.data.dispatch.state).toBe('dispatched');
    expect(f.started).toEqual([
      { approvalMode: 'never' },
      { approvalMode: 'never' },
    ]);
  },
);

test('each route records the requesting principal as the dispatched session owner', async () => {
  const f = await fixture();
  const phone = f.pair('Phone');
  expect((await f.dispatchTask(phone.credential, 'ask')).status).toBe(200);
  expect((await f.launchStarter(phone.credential, 'ask')).status).toBe(201);
  expect((await f.dispatchTask(f.operator.credential, 'ask')).status).toBe(200);
  // The device's own principal, never the operator's or an OS alias, and
  // each acts for its owner (no unattributed marker).
  const device = { ownerUserId: `human:device:${phone.device.id}` };
  expect(f.owners).toEqual([
    device,
    device,
    { ownerUserId: LOCAL_OPERATOR_PRINCIPAL_ID },
  ]);
});

// B2: Station's internal token resolves to the operator, and any agent
// holding a stdio child's env can present it. Both routes must record such a
// session as the operator's (so the operator's account reads it) but acting
// for no one, exactly as `/api/orchestration` does.
test("an internal-token caller's dispatch and Starter launch are the operator's to read but act for no one", async () => {
  const f = await fixture();
  expect(
    (
      await f.postInternally('/api/tasks/task-1/dispatch', {
        runtimeConfig: {
          provider: 'claude',
          modelOptions: { approvalMode: 'ask' },
        },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await f.postInternally('/api/starter-work/launch', {
        starterId: 'start-task',
        operationId: 'launch-internal',
        task: { projectId: 'project-1', title: 'Agent task' },
        dispatch: {
          runtimeConfig: {
            provider: 'claude',
            modelOptions: { approvalMode: 'ask' },
          },
        },
      })
    ).status,
  ).toBe(201);
  const unattributed = {
    ownerUserId: LOCAL_OPERATOR_PRINCIPAL_ID,
    ownerAttribution: 'unattributed-agent',
  };
  expect(f.owners).toEqual([unattributed, unattributed]);
});

test("#2569: a device without the grant cannot dispatch a Task in an ACP agent's full-access mode", async () => {
  const f = await fixture();
  const phone = f.pair('Phone');
  for (const mode of ['bypassPermissions', 'full-access', 'yolo']) {
    expect(
      await f.post(phone.credential, '/api/tasks/task-1/dispatch', {
        runtimeConfig: { provider: 'acp', modelOptions: { mode } },
      }),
    ).toEqual({ status: 403, body: refusedFor(phone) });
  }
  expect(f.reserve).not.toHaveBeenCalled();
  expect(f.started).toEqual([]);
});

test.each([
  ['the operator in person', 'operator', true],
  ['a device without approval:full-access', 'device', false],
  ['a granted device', 'granted', true],
  ["Station's internal principal (an agent's tool)", 'internal', false],
] as const)(
  "#2493: Starter Work's continue-session hands the adoption %s's grant",
  async (_label, caller, granted) => {
    const f = await fixture();
    const body = {
      starterId: 'continue-session',
      operationId: `continue-${caller}`,
      sourceSessionId: 'attached-source',
    };
    let response: { status: number; body: any };
    // The operator in person acts as the operator and a device as itself.
    // Station's internal principal is an unverified agent: the child is the
    // operator's to read but acts for no one.
    let owner: { ownerUserId: string; ownerAttribution?: string } = {
      ownerUserId: LOCAL_OPERATOR_PRINCIPAL_ID,
    };
    if (caller === 'internal') {
      owner = {
        ownerUserId: LOCAL_OPERATOR_PRINCIPAL_ID,
        ownerAttribution: 'unattributed-agent',
      };
      response = await f.postInternally('/api/starter-work/launch', body);
    } else {
      let credential = f.operator.credential;
      if (caller !== 'operator') {
        const phone = f.pair('Phone');
        if (caller === 'granted') f.grant(phone.device.id);
        credential = phone.credential;
        owner = { ownerUserId: `human:device:${phone.device.id}` };
      }
      response = await f.post(credential, '/api/starter-work/launch', body);
    }
    expect(response.status).toBeLessThan(300);
    expect(f.continueSession).toHaveBeenCalledTimes(1);
    expect(
      isFullAccessGrant(f.continueSession.mock.calls[0]![0].fullAccessGrant),
    ).toBe(granted);
    // The adopted child belongs to the launching principal.
    expect(f.continueSession.mock.calls[0]![0].owner).toEqual(owner);
  },
);

/**
 * #1796 H1 (delta review): a Task dispatched at `never` by a granted device
 * starts `host`, and revoking the device must reset and re-confine it. The
 * grant names its grantor, so the start records it whatever path carried
 * the grant: `POST /api/tasks/:id/dispatch` and Starter Work `start-task`.
 */
test.each([
  ['POST /api/tasks/:id/dispatch', 'task'],
  ['Starter Work start-task', 'starter'],
] as const)(
  '%s at never by a granted device is reset and re-confined after revoke',
  async (_label, route) => {
    const f = await fixture({ realStarts: true });
    const phone = f.pair('Phone');
    f.grant(phone.device.id);
    const response =
      route === 'task'
        ? await f.dispatchTask(phone.credential, 'never')
        : await f.launchStarter(phone.credential, 'never');
    expect(response.status, JSON.stringify(response.body)).toBe(
      route === 'task' ? 200 : 201,
    );
    const threadId = f.startedThreads.at(-1)!;
    await vi.waitFor(() =>
      expect(
        f.store!.latestEventByMethod(threadId, 'session.started')?.payload,
      ).toMatchObject({
        metadata: {
          stationConfinement: 'host',
          stationConfinementGrantor: {
            kind: 'device',
            deviceId: phone.device.id,
          },
        },
      }),
    );

    const revoked = await f.post(
      f.operator.credential,
      `/api/pairing/devices/${encodeURIComponent(phone.device.id)}/scope`,
      { scope: [...PAIRING_SCOPE_PRESETS.standard] },
    );

    expect(revoked.status).toBe(200);
    expect(revoked.body.fullAccessRevocation).toMatchObject({
      reset: [{ conversationId: threadId, was: 'host-start' }],
      // #3242: the session's engine is still running, so it stays listed as
      // unconfined until its next turn, which runs confined (asserted below).
      reconfined: [],
      stillUnconfined: [{ conversationId: threadId, until: 'next-turn' }],
      unattributedHostStarts: { sessions: [], total: 0 },
    });
    await f.service!.dispatch({
      type: 'sendTurn',
      input: { threadId, input: 'after revoke' },
    });
    expect(f.engine.turns.at(-1)).toMatchObject({
      confinement: 'workspace',
      modelOptions: { approvalMode: 'ask' },
    });
  },
);
