/**
 * #2412 review: a Project's working directory is what the coding routes are
 * confined to, so choosing it is reserved for whoever may run commands on
 * this computer: the operator in person, or a device holding the operator's
 * `coding:exec` grant. An operate-tier device (delegation) keeps every other
 * Project edit.
 *
 * Real pairing service, real runtime auth boundary, real project routes over
 * a real file store.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PAIRING_SCOPE_CODING_EXEC,
  PAIRING_SCOPE_PRESETS,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import { ProjectService } from '../../../services/projects/project-service.js';
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
import { createProjectRoutes } from '../projects.js';

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
  const root = mkdtempSync(join(tmpdir(), 'station-project-wd-authority-'));
  roots.push(root);
  const folderA = join(root, 'a');
  const folderB = join(root, 'b');
  mkdirSync(folderA);
  mkdirSync(folderB);
  const security = new EnvironmentSecurityService({
    homeDir: join(root, 'station-home'),
  });
  const operator = await security.initialize();
  const projectHome = join(root, 'project-home');
  mkdirSync(projectHome);
  const storage = new FileStorageAdapter(projectHome);
  const projects = new ProjectService(storage);

  const pair = (preset: 'delegation' | 'standard', extra: string[] = []) => {
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
    security.devicePairing.confirmRequest(requested.requestId, {
      kind: 'presented-credential',
    });
    const paired = security.devicePairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: requested.requestId,
    });
    if (extra.length > 0)
      security.devicePairing.setDeviceScope(
        paired.device.id,
        [...PAIRING_SCOPE_PRESETS[preset], ...(extra as never[])],
        { kind: 'presented-credential' },
      );
    return paired.credential;
  };

  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: createLogger({ name: 'project-wd-test', level: 'error' }),
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
    '/api/projects',
    createProjectRoutes(projects as never, storage as never, projectHome, {
      listAgents: async () => [],
    }),
  );

  const send = async (
    credential: string,
    method: 'POST' | 'PUT',
    path: string,
    body: Record<string, unknown>,
  ) => {
    const res = await app.request(`/api/projects${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const sendInternally = async (
    agent: boolean,
    method: 'POST' | 'PUT',
    path: string,
    body: Record<string, unknown>,
  ) => {
    const [init, env] = internalRequestInit(agent, {
      method,
      body: JSON.stringify(body),
    });
    const res = await app.request(`/api/projects${path}`, init, env as never);
    return { status: res.status, body: (await res.json()) as any };
  };
  const stored = (slug: string) => storage.getProject(slug);

  return {
    operator,
    pair,
    send,
    sendInternally,
    stored,
    folderA,
    folderB,
  };
}

const REFUSAL = {
  success: false,
  code: 'working-directory-not-granted',
  error:
    "Only this Station's operator, or a device the operator allowed to run commands, can choose a Project's folder. Nothing was saved.",
};

test('a delegation device cannot create a Project with a folder', async () => {
  const f = await fixture();
  const device = f.pair('delegation');

  const res = await f.send(device, 'POST', '', {
    name: 'Planted',
    slug: 'planted',
    workingDirectory: f.folderA,
  });

  expect(res).toEqual({ status: 403, body: REFUSAL });
  expect(() => f.stored('planted')).toThrow();
});

test("a delegation device cannot change a Project's folder, but still edits the rest", async () => {
  const f = await fixture();
  await f.send(f.operator.credential, 'POST', '', {
    name: 'Acme',
    slug: 'acme',
    workingDirectory: f.folderA,
  });
  const device = f.pair('delegation');

  const moved = await f.send(device, 'PUT', '/acme', {
    workingDirectory: f.folderB,
  });
  expect(moved).toEqual({ status: 403, body: REFUSAL });
  expect(f.stored('acme').workingDirectory).toBe(f.folderA);

  // A settings save that sends the folder it already has is not a change.
  const renamed = await f.send(device, 'PUT', '/acme', {
    name: 'Acme renamed',
    workingDirectory: f.folderA,
  });
  expect(renamed.status).toBe(200);
  expect(f.stored('acme')).toMatchObject({
    name: 'Acme renamed',
    workingDirectory: f.folderA,
  });
});

test('the operator in person chooses a folder on create and update', async () => {
  const f = await fixture();
  expect(
    (
      await f.send(f.operator.credential, 'POST', '', {
        name: 'Acme',
        slug: 'acme',
        workingDirectory: f.folderA,
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await f.send(f.operator.credential, 'PUT', '/acme', {
        workingDirectory: f.folderB,
      })
    ).status,
  ).toBe(200);
  expect(f.stored('acme').workingDirectory).toBe(f.folderB);
});

test('a device holding coding:exec chooses a folder on create and update', async () => {
  const f = await fixture();
  const device = f.pair('delegation', [PAIRING_SCOPE_CODING_EXEC]);
  expect(
    (
      await f.send(device, 'POST', '', {
        name: 'Acme',
        slug: 'acme',
        workingDirectory: f.folderA,
      })
    ).status,
  ).toBe(201);
  expect(
    (await f.send(device, 'PUT', '/acme', { workingDirectory: f.folderB }))
      .status,
  ).toBe(200);
  expect(f.stored('acme').workingDirectory).toBe(f.folderB);
});

test("an agent's station-control call, marked or not, cannot choose a Project's folder", async () => {
  const f = await fixture();
  const refused = await f.sendInternally(true, 'POST', '', {
    name: 'Planted',
    slug: 'planted',
    workingDirectory: f.folderA,
  });
  expect(refused).toEqual({ status: 403, body: REFUSAL });
  expect(() => f.stored('planted')).toThrow();

  // #2493 review F1: without the marker it is still the internal
  // principal any holder of the per-boot token can present.
  const unmarked = await f.sendInternally(false, 'POST', '', {
    name: 'Acme',
    slug: 'acme',
    workingDirectory: f.folderA,
  });
  expect(unmarked).toEqual({ status: 403, body: REFUSAL });
  expect(() => f.stored('acme')).toThrow();
});
