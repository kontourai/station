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

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { execGitSync } from '../../../utils/git-exec.js';
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
    '/api/projects',
    createProjectRoutes(projects as never, storage as never, projectHome, {
      listAgents: async () => [],
    }),
  );

  const send = async (
    credential: string,
    method: 'POST' | 'PUT' | 'GET',
    path: string,
    body: Record<string, unknown>,
  ) => {
    const res = await app.request(`/api/projects${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const sendInternally = async (
    agent: boolean,
    method: 'POST' | 'PUT' | 'GET',
    path: string,
    body: Record<string, unknown>,
  ) => {
    const [init, env] = internalRequestInit(agent, {
      method,
      body: method === 'GET' ? undefined : JSON.stringify(body),
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

test('repository acquisition uses operator Git authority and returns one durable verified checkout', async () => {
  const f = await fixture();
  execGitSync(['init', '--initial-branch=main'], { cwd: f.folderA });
  writeFileSync(join(f.folderA, 'README.md'), 'operator repository');
  execGitSync(['add', '.'], { cwd: f.folderA });
  execGitSync(
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'seed',
    ],
    { cwd: f.folderA },
  );
  const request = {
    requestId: randomUUID(),
    sourceUrl: f.folderA,
    sourceRef: 'main',
  };
  const delegated = await f.send(
    f.pair('delegation'),
    'POST',
    '/repository-acquisitions',
    request,
  );
  expect(delegated.status).toBe(403);
  const deviceWithExec = await f.send(
    f.pair('standard', [PAIRING_SCOPE_CODING_EXEC]),
    'POST',
    '/repository-acquisitions',
    request,
  );
  expect(deviceWithExec.status).toBe(403);
  for (const agentMarker of [false, true]) {
    const internal = await f.sendInternally(
      agentMarker,
      'POST',
      '/repository-acquisitions',
      request,
    );
    expect(internal.status).toBe(403);
  }
  const acquired = await f.send(
    f.operator.credential,
    'POST',
    '/repository-acquisitions',
    request,
  );
  expect(acquired.status, JSON.stringify(acquired.body)).toBe(200);
  expect(acquired.body.data.phase).toBe('ready');
  expect(acquired.body.data.attempt).toBe(1);
  expect(acquired.body.data.resolvedCommit).toBe(
    execGitSync(['rev-parse', 'HEAD'], {
      cwd: f.folderA,
      encoding: 'utf8',
    })
      .toString()
      .trim(),
  );
  const repeated = await f.send(
    f.operator.credential,
    'POST',
    '/repository-acquisitions',
    request,
  );
  expect(repeated.body.data).toEqual(acquired.body.data);
  const inspected = await f.send(
    f.operator.credential,
    'GET',
    `/repository-acquisitions/${request.requestId}`,
    {},
  );
  expect(inspected.status).toBe(200);
  expect(inspected.body.data).toEqual(acquired.body.data);
  const refusedRead = await f.send(
    f.pair('delegation'),
    'GET',
    `/repository-acquisitions/${request.requestId}`,
    {},
  );
  expect(refusedRead.status).toBe(403);
  expect(JSON.stringify(refusedRead.body)).not.toContain(
    acquired.body.data.checkoutPath,
  );

  const changed = await f.send(
    f.operator.credential,
    'POST',
    '/repository-acquisitions',
    { ...request, sourceRef: 'other' },
  );
  expect(changed.status).toBe(409);
  const invalid = await f.send(
    f.operator.credential,
    'POST',
    '/repository-acquisitions',
    {
      requestId: randomUUID(),
      sourceUrl: 'https://token@example.test/repo.git',
    },
  );
  expect(invalid.status).toBe(400);
});

test('Project creation revalidates the acquisition and persists server-owned provenance', async () => {
  const f = await fixture();
  execGitSync(['init', '--initial-branch=main', f.folderA]);
  writeFileSync(join(f.folderA, 'README.md'), 'repository bytes');
  execGitSync(['add', '.'], { cwd: f.folderA });
  execGitSync(
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'seed',
    ],
    { cwd: f.folderA },
  );
  const request = {
    requestId: randomUUID(),
    sourceUrl: f.folderA,
    sourceRef: 'main',
  };
  const acquired = await f.send(
    f.operator.credential,
    'POST',
    '/repository-acquisitions',
    request,
  );
  expect(acquired.status).toBe(200);
  expect(acquired.body.data.phase).toBe('ready');
  const draft = {
    name: 'Acquired',
    slug: 'acquired',
    repositoryAcquisitionId: request.requestId,
  };
  const device = await f.send(
    f.pair('standard', [PAIRING_SCOPE_CODING_EXEC]),
    'POST',
    '',
    draft,
  );
  expect(device.status).toBe(403);
  const mismatched = await f.send(f.operator.credential, 'POST', '', {
    ...draft,
    workingDirectory: f.folderB,
  });
  expect(mismatched.status).toBe(409);
  const forged = await f.send(f.operator.credential, 'POST', '', {
    ...draft,
    repositorySource: { resolvedCommit: 'fabricated' },
  });
  expect(forged.status).toBe(400);
  const created = await f.send(f.operator.credential, 'POST', '', draft);
  expect(created.status).toBe(201);
  expect(created.body.data.workingDirectory).toBe(
    acquired.body.data.checkoutPath,
  );
  expect(f.stored('acquired').repositorySource).toEqual({
    acquisitionId: request.requestId,
    attempt: 1,
    sourceUrl: request.sourceUrl,
    sourceRef: 'main',
    canonicalRemote: acquired.body.data.canonicalRemote,
    resolvedCommit: acquired.body.data.resolvedCommit,
    acquiredAt: acquired.body.data.updatedAt,
  });
  expect(f.stored('acquired')).not.toHaveProperty('repositoryAcquisitionId');
  const forgedUpdate = await f.send(f.operator.credential, 'PUT', '/acquired', {
    repositorySource: undefined,
    repositoryAcquisitionId: request.requestId,
  });
  expect(forgedUpdate.status).toBe(400);
  writeFileSync(
    join(acquired.body.data.checkoutPath, 'README.md'),
    'edits after acquisition',
  );
  const changed = await f.send(f.operator.credential, 'POST', '', {
    ...draft,
    name: 'Changed',
    slug: 'changed',
  });
  expect(changed.status).toBe(409);
  expect(changed.body.error).toContain('Existing files were preserved');
  execGitSync(['update-index', '--assume-unchanged', 'README.md'], {
    cwd: acquired.body.data.checkoutPath,
  });
  const hiddenEdit = await f.send(f.operator.credential, 'POST', '', {
    ...draft,
    slug: 'hidden-edit',
  });
  expect(hiddenEdit.status).toBe(409);
  execGitSync(['update-index', '--no-assume-unchanged', 'README.md'], {
    cwd: acquired.body.data.checkoutPath,
  });

  expect(() => f.stored('changed')).toThrow();
  writeFileSync(
    join(acquired.body.data.checkoutPath, 'README.md'),
    'repository bytes',
  );
  execGitSync(['remote', 'set-url', 'origin', f.folderB], {
    cwd: acquired.body.data.checkoutPath,
  });
  const remoteChanged = await f.send(f.operator.credential, 'POST', '', {
    ...draft,
    slug: 'remote-changed',
  });
  expect(remoteChanged.status).toBe(409);
  execGitSync(['remote', 'set-url', 'origin', f.folderA], {
    cwd: acquired.body.data.checkoutPath,
  });
  writeFileSync(
    join(acquired.body.data.checkoutPath, 'README.md'),
    'new committed revision',
  );
  execGitSync(['add', '.'], { cwd: acquired.body.data.checkoutPath });
  execGitSync(
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'move checkout HEAD',
    ],
    { cwd: acquired.body.data.checkoutPath },
  );
  const commitChanged = await f.send(f.operator.credential, 'POST', '', {
    ...draft,
    slug: 'commit-changed',
  });
  expect(commitChanged.status).toBe(409);
  expect(() => f.stored('remote-changed')).toThrow();
  expect(() => f.stored('commit-changed')).toThrow();
});

test('durable creation requests recover exactly one Project through real authenticated routes', async () => {
  const f = await fixture();
  const requestId = randomUUID();
  const draft = {
    name: 'Durable',
    slug: 'durable',
    workingDirectory: f.folderA,
    creationRequestId: requestId,
  };
  const first = await f.send(f.operator.credential, 'POST', '', draft);
  expect(first.status).toBe(201);
  expect(first.body.data).not.toHaveProperty('creationRequestId');
  const repeated = await f.send(f.operator.credential, 'POST', '', draft);
  expect(repeated.status).toBe(201);
  expect(repeated.body.data.id).toBe(first.body.data.id);
  const inspected = await f.send(
    f.operator.credential,
    'GET',
    `/creation-requests/${requestId}`,
    {},
  );
  expect(inspected.status).toBe(200);
  expect(inspected.body.data.phase).toBe('created');
  expect(inspected.body.data.project.id).toBe(first.body.data.id);
  const changed = await f.send(f.operator.credential, 'POST', '', {
    ...draft,
    name: 'Different intent',
  });
  expect(changed.status).toBe(409);
  const device = f.pair('standard', [PAIRING_SCOPE_CODING_EXEC]);
  expect(
    (
      await f.send(device, 'POST', '', {
        ...draft,
        slug: 'device-project',
        creationRequestId: randomUUID(),
      })
    ).status,
  ).toBe(403);
  expect(
    (await f.send(device, 'GET', `/creation-requests/${requestId}`, {})).status,
  ).toBe(403);
});

test('the canonical layout apply route joins a retained starter rather than creating a duplicate', async () => {
  const f = await fixture();
  const id = randomUUID();
  const draft = {
    name: 'Starter',
    slug: 'starter',
    workingDirectory: f.folderA,
    creationRequestId: id,
    starterLayoutId: 'builtin:coding',
  };
  expect(
    (await f.send(f.operator.credential, 'GET', '/creation-requests', {})).body
      .data.available,
  ).toBe(true);
  expect(
    (await f.send(f.pair('standard'), 'GET', '/creation-requests', {})).body
      .data.available,
  ).toBe(false);
  const created = await f.send(f.operator.credential, 'POST', '', draft);
  expect(created.status).toBe(201);
  expect(created.body.data).not.toHaveProperty('starterLayoutId');
  const body = { layoutId: 'builtin:coding', creationRequestId: id };
  const first = await f.send(
    f.operator.credential,
    'POST',
    '/starter/layouts/apply',
    body,
  );
  expect(first.status).toBe(201);
  const repeated = await f.send(
    f.operator.credential,
    'POST',
    '/starter/layouts/apply',
    body,
  );
  expect(repeated.status).toBe(201);
  expect(repeated.body.data.id).toBe(first.body.data.id);
  const inspected = await f.send(
    f.operator.credential,
    'GET',
    `/creation-requests/${id}`,
    {},
  );
  expect(inspected.body.data.starter).toMatchObject({
    phase: 'applied',
    layoutId: first.body.data.id,
    layoutSlug: first.body.data.slug,
  });
  expect(
    (
      await f.send(f.operator.credential, 'POST', '/starter/layouts/apply', {
        ...body,
        layoutId: 'builtin:review',
      })
    ).status,
  ).toBe(409);
});
