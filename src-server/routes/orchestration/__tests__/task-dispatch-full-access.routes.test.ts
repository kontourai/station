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
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { isFullAccessGrant } from '../../../security/coding-authority.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
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
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const REFUSAL = {
  success: false,
  code: 'approval-full-access-not-granted',
  error:
    "This device is not allowed to give an agent full access. The Station's operator can allow it: Devices, this device's access, Allow full access.",
};

const reservation: TaskDispatchReservation = {
  task: { id: 'task-1', projectId: 'project-1' } as never,
  sessionId: 'session-1',
  provider: 'claude',
  sourceSurface: 'api',
  modelId: undefined,
};

async function fixture() {
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
  const startOrSeed = vi.fn<TaskDispatchRemoteSessions['startOrSeed']>(
    async (_reservation, intent) => {
      started.push(intent.runtimeConfig?.modelOptions);
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
    async (_input: { fullAccessGrant: unknown }) => ({
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
  app.route(
    '/api/tasks',
    createTaskRoutes({} as never, { taskDispatcher: dispatcher } as never),
  );
  app.route('/api/starter-work', createStarterWorkRoutes(registry));

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

  return {
    operator,
    pair,
    grant,
    post,
    postInternally,
    continueSession,
    dispatchTask,
    launchStarter,
    started,
    reserve,
    createTaskIdempotent,
  };
}

test('a device without the grant cannot dispatch a Task at full access', async () => {
  const f = await fixture();
  const phone = f.pair('Phone');
  expect(await f.dispatchTask(phone.credential, 'never')).toEqual({
    status: 403,
    body: REFUSAL,
  });
  expect(f.reserve).not.toHaveBeenCalled();
  expect(f.started).toEqual([]);
});

test('a device without the grant cannot launch Starter Work at full access, and no Task is left behind', async () => {
  const f = await fixture();
  const phone = f.pair('Phone');
  expect(await f.launchStarter(phone.credential, 'never')).toEqual({
    status: 403,
    body: REFUSAL,
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

test("#2569: a device without the grant cannot dispatch a Task in an ACP agent's full-access mode", async () => {
  const f = await fixture();
  const phone = f.pair('Phone');
  for (const mode of ['bypassPermissions', 'full-access', 'yolo']) {
    expect(
      await f.post(phone.credential, '/api/tasks/task-1/dispatch', {
        runtimeConfig: { provider: 'acp', modelOptions: { mode } },
      }),
    ).toEqual({ status: 403, body: REFUSAL });
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
    if (caller === 'internal') {
      response = await f.postInternally('/api/starter-work/launch', body);
    } else {
      let credential = f.operator.credential;
      if (caller !== 'operator') {
        const phone = f.pair('Phone');
        if (caller === 'granted') f.grant(phone.device.id);
        credential = phone.credential;
      }
      response = await f.post(credential, '/api/starter-work/launch', body);
    }
    expect(response.status).toBeLessThan(300);
    expect(f.continueSession).toHaveBeenCalledTimes(1);
    expect(
      isFullAccessGrant(f.continueSession.mock.calls[0]![0].fullAccessGrant),
    ).toBe(granted);
  },
);
