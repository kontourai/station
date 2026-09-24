/**
 * #2436, owner decision (2026-09-23): putting a session, or an Agent's
 * default, at full access (approval posture `never`) needs the operator in
 * person or a device holding `approval:full-access`, which the operator
 * grants by promotion. Any operate device may still tighten to Ask or Auto,
 * or pick Default.
 *
 * Everything real except the engine: the Station's own security service
 * pairs the devices and stores the grant, the runtime auth boundary stamps
 * the principal and scope, the orchestration and Agent routes decide, and
 * the real `OrchestrationService` records (or does not record) the decision.
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
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import {
  STATION_CONTROL_ORIGIN_AGENT_TOOL,
  STATION_CONTROL_ORIGIN_HEADER,
} from '../../../tools/station-control-shared.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import { createLogger } from '../../../utils/logger.js';
import { createAgentRoutes } from '../../agents/agents.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const roots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const THREAD = 'full-access-thread';

async function fixture() {
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
  const root = mkdtempSync(join(tmpdir(), 'station-full-access-grant-'));
  roots.push(root);
  const security = new EnvironmentSecurityService({
    homeDir: join(root, 'home'),
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

  const store = new EventStore(join(root, 'orchestration.sqlite'));
  const eventBus = new EventBus();
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(new GateTestAdapter()),
    eventBus,
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
    ownerlessSessionAccess: 'single-user-compat',
  });
  cleanups.push(async () => {
    await service.shutdown();
    store.close();
  });
  await service.dispatch({
    type: 'startSession',
    input: { threadId: THREAD, provider: 'claude' },
  });

  // An Agent store whose `builder` Agent starts at `previousDefault`.
  let previousDefault: string | undefined;
  const agentService = {
    getAgent: vi.fn(async () => ({
      name: 'Builder',
      execution: previousDefault ? { approvalMode: previousDefault } : {},
    })),
    createAgent: vi.fn(async (body: Record<string, unknown>) => ({
      slug: 'builder',
      spec: body,
    })),
    updateAgent: vi.fn(
      async (_slug: string, body: Record<string, unknown>) => body,
    ),
  };

  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: createLogger({ name: 'full-access-grant-test', level: 'error' }),
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
  // A send that got past the gate would reach these; the refusals below
  // assert they never do.
  const executeForegroundMessage = vi.fn(async () => {
    throw new Error('the send was not refused');
  });
  const continueForegroundMessage = vi.fn(async () => {
    throw new Error('the continue was not refused');
  });
  app.route(
    '/api/orchestration',
    createOrchestrationRoutes(service, {
      eventBus,
      logger: { debug: vi.fn() },
      getUserId: () => 'operator',
      executeForegroundMessage,
      continueForegroundMessage,
    } as never),
  );
  app.route(
    '/api/agents',
    createAgentRoutes(
      agentService as never,
      { listSkills: () => [] } as never,
      (async (operation: (begin: () => void) => Promise<unknown>) =>
        operation(() => undefined)) as never,
      () => undefined,
    ),
  );

  const post = async (
    credential: string,
    path: string,
    body: unknown,
    method = 'POST',
  ) => {
    const res = await app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  // Each decision is made having seen every decision so far.
  const latestSequence = () => {
    const sequences = store
      .listEvents(THREAD)
      .filter((row) => row.payload.method === 'session.approval-mode-set')
      .map((row) => row.globalSequence);
    return sequences.length > 0 ? Math.max(...sequences) : null;
  };
  const internal = async (
    agent: boolean,
    path: string,
    body: unknown,
    method = 'POST',
  ) => {
    const [init, env] = internalRequestInit(agent, {
      method,
      body: JSON.stringify(body),
    });
    const res = await app.request(path, init, env as never);
    return { status: res.status, body: (await res.json()) as any };
  };
  const decide = (credential: string, approvalMode: string) =>
    post(credential, '/api/orchestration/commands', {
      type: 'setApprovalMode',
      threadId: THREAD,
      approvalMode,
      basedOnSequence: latestSequence(),
    });
  const recorded = () =>
    store
      .listEvents(THREAD)
      .filter((row) => row.payload.method === 'session.approval-mode-set')
      .map((row) => (row.payload as { approvalMode: string }).approvalMode);
  const grant = (deviceId: string, on: boolean, preset: PairingScopePreset) =>
    security.devicePairing.setDeviceScope(
      deviceId,
      [
        ...PAIRING_SCOPE_PRESETS[preset],
        ...(on ? [PAIRING_SCOPE_APPROVAL_FULL_ACCESS] : []),
      ],
      { kind: 'presented-credential' },
    );
  const setPreviousDefault = (mode: string | undefined) => {
    previousDefault = mode;
  };

  return {
    operator,
    pair,
    post,
    internal,
    latestSequence,
    decide,
    recorded,
    grant,
    agentService,
    setPreviousDefault,
    executeForegroundMessage,
    continueForegroundMessage,
  };
}

/**
 * Station's own internal principal: the per-boot token, the `local` caller
 * marker and a direct loopback socket. An agent's station-control tool calls
 * arrive this way, with the tool's origin marker; any holder of the token can
 * omit that marker, so it only ever restricts (#2436 review, #2493 review F1).
 * The operator's UI does not: its proxy hop is marked `remote` and carries
 * the browser's own credential.
 */
function internalRequestInit(agent: boolean, init: RequestInit) {
  return [
    {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
        [INTERNAL_PROXY_CALLER_HEADER]: 'local',
        ...(agent
          ? {
              [STATION_CONTROL_ORIGIN_HEADER]:
                STATION_CONTROL_ORIGIN_AGENT_TOOL,
            }
          : {}),
      },
    },
    { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
  ] as const;
}

const REFUSAL = {
  success: false,
  code: 'approval-full-access-not-granted',
  error:
    "This device is not allowed to give an agent full access. The Station's operator can allow it: Devices, this device's access, Allow full access.",
};

test('an operate device is refused full access with a stable code, and nothing is recorded', async () => {
  const f = await fixture();
  const phone = f.pair('Phone');

  const refused = await f.decide(phone.credential, 'never');

  expect(refused).toEqual({ status: 403, body: REFUSAL });
  expect(f.recorded()).toEqual([]);
});

test('the same device may tighten to Ask or Auto, and pick Default', async () => {
  const f = await fixture();
  const phone = f.pair('Phone');

  for (const mode of ['ask', 'auto', 'connection-default']) {
    expect((await f.decide(phone.credential, mode)).status).toBe(200);
  }
  expect(f.recorded()).toEqual(['ask', 'auto', 'connection-default']);
});

test('a pick without its compare-and-set basis is refused, never recorded unconditionally', async () => {
  const f = await fixture();
  const bare = await f.post(
    f.operator.credential,
    '/api/orchestration/commands',
    {
      type: 'setApprovalMode',
      threadId: THREAD,
      approvalMode: 'ask',
    },
  );
  expect(bare.status).toBe(400);
  const carried = await f.post(
    f.operator.credential,
    '/api/orchestration/chat',
    {
      message: 'go',
      target: { agent: 'claude' },
      setApprovalMode: 'ask',
    },
  );
  expect(carried.status).toBe(400);
  const continued = await f.post(
    f.operator.credential,
    `/api/orchestration/chat/${THREAD}/continue`,
    { message: 'go', setApprovalMode: 'ask' },
  );
  expect(continued.status).toBe(400);
  expect(f.recorded()).toEqual([]);
  expect(f.executeForegroundMessage).not.toHaveBeenCalled();
  expect(f.continueForegroundMessage).not.toHaveBeenCalled();
});

test.each(['bypassPermissions', 'full-access', 'yolo'])(
  "#2569: an ACP agent's own full-access mode %s needs the same grant as never",
  async (mode) => {
    const f = await fixture();
    const phone = f.pair('Phone');
    const chat = await f.post(phone.credential, '/api/orchestration/chat', {
      message: 'go',
      target: { agent: 'opencode', model: { options: { mode } } },
    });
    expect(chat).toEqual({ status: 403, body: REFUSAL });
    const continued = await f.post(
      phone.credential,
      `/api/orchestration/chat/${THREAD}/continue`,
      { message: 'go', model: { options: { mode } } },
    );
    expect(continued).toEqual({ status: 403, body: REFUSAL });
    expect(f.executeForegroundMessage).not.toHaveBeenCalled();
    expect(f.continueForegroundMessage).not.toHaveBeenCalled();

    // An ordinary advertised mode needs nothing, and the operator is not
    // refused a full-access one (the fixture's executor then throws).
    await f.post(phone.credential, '/api/orchestration/chat', {
      message: 'go',
      target: { agent: 'opencode', model: { options: { mode: 'plan' } } },
    });
    await f.post(f.operator.credential, '/api/orchestration/chat', {
      message: 'go',
      target: { agent: 'opencode', model: { options: { mode } } },
    });
    expect(f.executeForegroundMessage).toHaveBeenCalledTimes(2);
  },
);

test('the operator in person needs no grant', async () => {
  const f = await fixture();
  expect((await f.decide(f.operator.credential, 'never')).status).toBe(200);
  expect(f.recorded()).toEqual(['never']);
});

test('the operator grants it once per device, and revoking takes it away', async () => {
  const f = await fixture();
  const phone = f.pair('Phone');
  const tablet = f.pair('Tablet');

  f.grant(phone.device.id, true, 'standard');
  expect((await f.decide(phone.credential, 'never')).status).toBe(200);
  // One device's grant is not another's.
  expect((await f.decide(tablet.credential, 'never')).status).toBe(403);

  f.grant(phone.device.id, false, 'standard');
  expect((await f.decide(phone.credential, 'never')).body.code).toBe(
    'approval-full-access-not-granted',
  );
  expect(f.recorded()).toEqual(['never']);
});

test('a send that carries full access, or asks for it on the options, is refused before anything runs', async () => {
  const f = await fixture();
  const phone = f.pair('Phone');

  const carried = await f.post(phone.credential, '/api/orchestration/chat', {
    message: 'go',
    target: { agent: 'claude' },
    setApprovalMode: 'never',
    setApprovalModeBasedOn: null,
  });
  expect(carried).toEqual({ status: 403, body: REFUSAL });

  const onOptions = await f.post(phone.credential, '/api/orchestration/chat', {
    message: 'go',
    target: { agent: 'claude', model: { options: { approvalMode: 'never' } } },
  });
  expect(onOptions).toEqual({ status: 403, body: REFUSAL });

  const continued = await f.post(
    phone.credential,
    `/api/orchestration/chat/${THREAD}/continue`,
    { message: 'go', model: { options: { approvalMode: 'never' } } },
  );
  expect(continued).toEqual({ status: 403, body: REFUSAL });
  expect(f.executeForegroundMessage).not.toHaveBeenCalled();
  expect(f.continueForegroundMessage).not.toHaveBeenCalled();
});

test("a delegation device cannot set an Agent's default to full access; the operator can", async () => {
  const f = await fixture();
  const delegate = f.pair('Delegate', 'delegation');
  const body = {
    name: 'Builder',
    prompt: 'Build.',
    execution: { approvalMode: 'never' },
  };

  expect(await f.post(delegate.credential, '/api/agents', body)).toEqual({
    status: 403,
    body: REFUSAL,
  });
  expect(
    await f.post(delegate.credential, '/api/agents/builder', body, 'PUT'),
  ).toEqual({ status: 403, body: REFUSAL });
  expect(f.agentService.createAgent).not.toHaveBeenCalled();
  expect(f.agentService.updateAgent).not.toHaveBeenCalled();

  expect(
    (await f.post(f.operator.credential, '/api/agents', body)).status,
  ).toBeLessThan(300);
  expect(f.agentService.createAgent).toHaveBeenCalledTimes(1);
});

test('a delegation device may set a stricter default, and may edit an Agent whose full-access default already stands', async () => {
  const f = await fixture();
  const delegate = f.pair('Delegate', 'delegation');

  expect(
    (
      await f.post(delegate.credential, '/api/agents', {
        name: 'Careful',
        prompt: 'Care.',
        execution: { approvalMode: 'ask' },
      })
    ).status,
  ).toBeLessThan(300);

  // The operator already set it; resending the whole execution block with
  // another edit does not raise anything.
  f.setPreviousDefault('never');
  expect(
    (
      await f.post(
        delegate.credential,
        '/api/agents/builder',
        { description: 'Now documented', execution: { approvalMode: 'never' } },
        'PUT',
      )
    ).status,
  ).toBeLessThan(300);
});

test('a device the operator granted may set an Agent default to full access', async () => {
  const f = await fixture();
  const delegate = f.pair('Delegate', 'delegation');
  f.grant(delegate.device.id, true, 'delegation');
  expect(
    (
      await f.post(delegate.credential, '/api/agents', {
        name: 'Builder',
        prompt: 'Build.',
        execution: { approvalMode: 'never' },
      })
    ).status,
  ).toBeLessThan(300);
});

test("an agent's station-control call, marked or not, cannot record full access or save it as an Agent default", async () => {
  const f = await fixture();
  const command = () => ({
    type: 'setApprovalMode',
    threadId: THREAD,
    approvalMode: 'never',
    basedOnSequence: f.latestSequence(),
  });

  expect(
    await f.internal(true, '/api/orchestration/commands', command()),
  ).toEqual({ status: 403, body: REFUSAL });
  expect(
    await f.internal(
      true,
      '/api/agents/builder',
      { execution: { approvalMode: 'never' } },
      'PUT',
    ),
  ).toEqual({ status: 403, body: REFUSAL });
  expect(f.recorded()).toEqual([]);
  expect(f.agentService.updateAgent).not.toHaveBeenCalled();

  // #2493 review F1: the marker only restricts. Without it the request is
  // still Station's internal principal, which any holder of the per-boot
  // token (an agent's tool among them) can present; the operator's UI
  // reaches Station through the proxy with its own credential instead.
  expect(
    await f.internal(false, '/api/orchestration/commands', command()),
  ).toEqual({ status: 403, body: REFUSAL });
  expect(
    await f.internal(
      false,
      '/api/agents/builder',
      { execution: { approvalMode: 'never' } },
      'PUT',
    ),
  ).toEqual({ status: 403, body: REFUSAL });
  expect(f.recorded()).toEqual([]);
  expect(f.agentService.updateAgent).not.toHaveBeenCalled();
});
