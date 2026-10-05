/**
 * Choosing a working folder takes the same authority as running commands
 * there. A session start that names a plain folder
 * (`target.workspace: { kind: 'directory' }`) is refused for a paired device
 * that lacks `coding:exec`, with the code the Project routes use
 * (`working-directory-not-granted`), on every route that reads the workspace
 * from the body: foreground send, engine handoff and task delegation.
 *
 * Real pairing service, real runtime auth boundary and real orchestration
 * routes; the dispatch seams are recorders, so "no session is created" is
 * "the recorder was never called".
 */
import { join } from 'node:path';
import {
  PAIRING_SCOPE_CODING_EXEC,
  PAIRING_SCOPE_PRESETS,
  type PairingScopePreset,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { createLogger } from '../../../utils/logger.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const makeTempDir = trackTempDirs();

afterEach(() => {
  vi.unstubAllEnvs();
});

const REFUSAL = {
  success: false,
  code: 'working-directory-not-granted',
  error:
    "Only this Station's operator, or a device the operator allowed to run commands, can choose a working folder. Nothing was started.",
};

const HANDLE = { conversationId: 'c-1', providerTurnId: 'turn-1' };

async function fixture() {
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
  const root = makeTempDir('station-directory-authority-');
  const folder = join(root, 'a-folder');
  const security = new EnvironmentSecurityService({
    homeDir: join(root, 'home'),
  });
  const operator = await security.initialize();

  const pair = (
    preset: PairingScopePreset,
    extra: string[] = [],
    homePossession = false,
  ) => {
    const offer = security.devicePairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: pairingScopePresetString(preset),
    });
    const requested = security.devicePairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: preset,
    });
    security.devicePairing.confirmRequest(
      requested.requestId,
      homePossession
        ? { kind: 'local-grant' }
        : { kind: 'presented-credential' },
    );
    const paired = security.devicePairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: requested.requestId,
      ...(homePossession
        ? {
            locality: 'home-possession' as const,
            mintKind: 'local-grant' as const,
          }
        : {}),
    });
    if (extra.length > 0)
      security.devicePairing.setDeviceScope(
        paired.device.id,
        [...PAIRING_SCOPE_PRESETS[preset], ...(extra as never[])],
        { kind: 'presented-credential' },
      );
    return paired.credential;
  };

  const executeForegroundMessage = vi.fn(async () => HANDLE);
  const handoffConversation = vi.fn(async () => HANDLE);
  const delegateTask = vi.fn(async () => ({ taskId: 'task-1' }));

  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: createLogger({ name: 'directory-authority-test', level: 'error' }),
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
  app.route(
    '/api/orchestration',
    createOrchestrationRoutes(
      {} as never,
      {
        eventBus: { emit() {} },
        logger: { debug: vi.fn() },
        getUserId: () => 'operator',
        executeForegroundMessage,
        handoffConversation,
        delegateTask,
      } as never,
    ),
  );

  const send = async (
    credential: string,
    path: string,
    body: unknown,
    loopback = false,
  ): Promise<{ status: number; body: any }> => {
    const res = await app.request(
      path,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      // A home-possession credential is honoured only from this computer.
      loopback
        ? ({ incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never)
        : undefined,
    );
    return { status: res.status, body: await res.json() };
  };
  return {
    operator,
    pair,
    send,
    folder,
    recorders: { executeForegroundMessage, handoffConversation, delegateTask },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const ROUTES = [
  {
    name: 'POST /chat',
    path: '/api/orchestration/chat',
    recorder: 'executeForegroundMessage',
    body: (workspace: unknown) => ({
      message: 'hello',
      target: { agent: 'builder', workspace },
    }),
  },
  {
    name: 'POST /chat/delegated',
    path: '/api/orchestration/chat/delegated',
    recorder: 'executeForegroundMessage',
    body: (workspace: unknown) => ({
      message: 'hello',
      target: { agent: 'builder', workspace },
      delegation: {
        mode: 'isolated-child',
        depth: 1,
        maxDepth: 2,
        parentAgentSlug: 'parent',
        rootAgentSlug: 'parent',
      },
    }),
  },
  {
    name: 'POST /chat/background',
    path: '/api/orchestration/chat/background',
    recorder: 'executeForegroundMessage',
    body: (workspace: unknown) => ({
      message: 'hello',
      target: { agent: 'builder', workspace },
    }),
  },
  {
    name: 'POST /conversations/:id/handoff',
    path: '/api/orchestration/conversations/c-1/handoff',
    recorder: 'handoffConversation',
    body: (workspace: unknown) => ({
      message: 'hello',
      idempotencyKey: 'handoff-1',
      target: { agent: 'builder', workspace },
    }),
  },
  {
    name: 'POST /delegations',
    path: '/api/orchestration/delegations',
    recorder: 'delegateTask',
    body: (workspace: unknown) => ({
      prompt: 'do the thing',
      target: { agent: 'builder', workspace },
    }),
  },
] as const;

const project = { kind: 'project', projectSlug: 'a-project' };

describe.each(ROUTES)('$name', (route) => {
  const directory = (f: Fixture) => ({ kind: 'directory', cwd: f.folder });
  const calls = (f: Fixture) => f.recorders[route.recorder].mock.calls.length;

  test('refuses a delegation device naming a folder and starts nothing', async () => {
    const f = await fixture();
    const device = f.pair('delegation');
    const res = await f.send(device, route.path, route.body(directory(f)));
    expect(res.status).toBe(403);
    expect(res.body).toEqual(REFUSAL);
    expect(calls(f)).toBe(0);
  });

  test('refuses a standard device (terminal is not the authority)', async () => {
    const f = await fixture();
    const device = f.pair('standard');
    const res = await f.send(device, route.path, route.body(directory(f)));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('working-directory-not-granted');
    expect(calls(f)).toBe(0);
  });

  test('still starts a Project target for the same delegation device', async () => {
    const f = await fixture();
    const device = f.pair('delegation');
    const res = await f.send(device, route.path, route.body(project));
    expect(res.status).toBeLessThan(300);
    expect(calls(f)).toBe(1);
  });

  test('admits a folder from a device holding coding:exec', async () => {
    const f = await fixture();
    for (const preset of ['delegation', 'standard'] as const) {
      const device = f.pair(preset, [PAIRING_SCOPE_CODING_EXEC]);
      const before = calls(f);
      const res = await f.send(device, route.path, route.body(directory(f)));
      expect(res.status).toBeLessThan(300);
      expect(calls(f)).toBe(before + 1);
    }
  });

  test('leaves the operator and the desktop app on this computer unchanged', async () => {
    const f = await fixture();
    const operator = await f.send(
      f.operator.credential,
      route.path,
      route.body(directory(f)),
    );
    expect(operator.status).toBeLessThan(300);
    // A device whose credential was minted by proving possession of this
    // Station's home is the operator in person (the desktop app).
    const desktop = f.pair('standard', [], true);
    const local = await f.send(
      desktop,
      route.path,
      route.body(directory(f)),
      true,
    );
    expect(local.status).toBeLessThan(300);
    expect(calls(f)).toBe(2);
  });
});
