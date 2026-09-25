/**
 * #2436: the Station's default approval posture applies to every session
 * start, the unattended ones included (owner decision 2026-09-23). Raising it
 * to full access therefore needs the operator in person or a device holding
 * `approval:full-access`, like every other way to start a session there.
 *
 * Real pieces: the Station's security service pairs the devices and stores
 * the grant, the runtime auth boundary stamps principal and scope, the config
 * route decides, and a real `ConfigLoader` writes a temp home.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PAIRING_SCOPE_APPROVAL_FULL_ACCESS,
  PAIRING_SCOPE_PRESETS,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
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
import { createConfigRoutes } from '../config.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

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

async function fixture() {
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
  const root = mkdtempSync(join(tmpdir(), 'station-default-posture-grant-'));
  roots.push(root);
  const security = new EnvironmentSecurityService({
    homeDir: join(root, 'security'),
  });
  const operator = await security.initialize();
  const pairPhone = () => {
    const offer = security.devicePairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: pairingScopePresetString('standard'),
    });
    const requested = security.devicePairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Phone',
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
  const grant = (deviceId: string) =>
    security.devicePairing.setDeviceScope(
      deviceId,
      [...PAIRING_SCOPE_PRESETS.standard, PAIRING_SCOPE_APPROVAL_FULL_ACCESS],
      { kind: 'presented-credential' },
    );

  const logger = createLogger({
    name: 'default-posture-grant',
    level: 'error',
  });
  const configLoader = new ConfigLoader({
    projectHomeDir: join(root, 'station'),
  });
  // The race window: a mutation that lands after this route read the config
  // and before its own serialized mutation runs.
  let concurrentLowering: string | undefined;
  const mutate = configLoader.mutateAppConfig.bind(configLoader);
  configLoader.mutateAppConfig = (async (fn: never) => {
    const lowering = concurrentLowering;
    concurrentLowering = undefined;
    if (lowering)
      await mutate((() => ({ defaultApprovalMode: lowering })) as never);
    return mutate(fn);
  }) as typeof configLoader.mutateAppConfig;
  const lowerConcurrently = (mode: string) => {
    concurrentLowering = mode;
  };

  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger,
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
  app.route('/config', createConfigRoutes(configLoader, logger));

  const setDefault = async (
    credential: string,
    defaultApprovalMode: string,
  ) => {
    const res = await app.request('/config/app', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ defaultApprovalMode }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const setDefaultInternally = async (
    agent: boolean,
    defaultApprovalMode: string,
  ) => {
    const [init, env] = internalRequestInit(agent, {
      method: 'PUT',
      body: JSON.stringify({ defaultApprovalMode }),
    });
    const res = await app.request('/config/app', init, env as never);
    return { status: res.status, body: (await res.json()) as any };
  };
  const stored = async () =>
    (await configLoader.loadAppConfig()).defaultApprovalMode;

  return {
    operator,
    pairPhone,
    grant,
    setDefault,
    setDefaultInternally,
    stored,
    lowerConcurrently,
  };
}

test('a device without the grant cannot raise the Station default to full access', async () => {
  const f = await fixture();
  const phone = f.pairPhone();
  const refused = await f.setDefault(phone.credential, 'never');
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe('approval-full-access-not-granted');
  expect(await f.stored()).toBeUndefined();
  // Anything stricter is open.
  expect((await f.setDefault(phone.credential, 'auto')).status).toBe(200);
  expect(await f.stored()).toBe('auto');
});

test('the operator, or a granted device, may; resending a standing never needs no grant', async () => {
  const f = await fixture();
  expect((await f.setDefault(f.operator.credential, 'never')).status).toBe(200);
  expect(await f.stored()).toBe('never');
  // Settings round-trips the whole config: a standing never is not a raise.
  const phone = f.pairPhone();
  expect((await f.setDefault(phone.credential, 'never')).status).toBe(200);

  expect((await f.setDefault(f.operator.credential, 'ask')).status).toBe(200);
  f.grant(phone.device.id);
  expect((await f.setDefault(phone.credential, 'never')).status).toBe(200);
  expect(await f.stored()).toBe('never');
});

test("an agent's station-control call, marked or not, cannot raise the Station default to full access", async () => {
  const f = await fixture();
  const refused = await f.setDefaultInternally(true, 'never');
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe('approval-full-access-not-granted');
  expect(await f.stored()).toBeUndefined();

  // #2493 review F1: without the marker it is still the internal
  // principal any holder of the per-boot token can present.
  const unmarked = await f.setDefaultInternally(false, 'never');
  expect(unmarked.status).toBe(403);
  expect(unmarked.body.code).toBe('approval-full-access-not-granted');
  expect(await f.stored()).toBeUndefined();
});

test('a save that read a standing never cannot land it after the operator lowered the default', async () => {
  const f = await fixture();
  expect((await f.setDefault(f.operator.credential, 'never')).status).toBe(200);
  const phone = f.pairPhone();
  // The phone's whole-config save resends `never`; the operator's lowering
  // to Ask lands between the route's read and the phone's mutation.
  f.lowerConcurrently('ask');
  const raced = await f.setDefault(phone.credential, 'never');
  expect(raced.status).toBe(403);
  expect(raced.body.code).toBe('approval-full-access-not-granted');
  expect(await f.stored()).toBe('ask');
});
