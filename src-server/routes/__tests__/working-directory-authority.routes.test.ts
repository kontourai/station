/**
 * Choosing a working folder takes the same authority as running commands
 * there (the Project routes' rule, `working-directory-not-granted`), applied
 * to the task dispatch, starter launch and Project identity routes.
 *
 * Real pairing service, real runtime auth boundary and real route modules;
 * the services behind them are recorders, so "nothing happened" is "the
 * recorder was never called".
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  PAIRING_SCOPE_CODING_EXEC,
  PAIRING_SCOPE_PRESETS,
  type PairingScopePreset,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { configureRuntimeHttp } from '../../runtime/bootstrap/runtime-http.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import { createLogger } from '../../utils/logger.js';
import { createTaskRoutes } from '../orchestration/tasks.js';
import { createProjectIdentityRoutes } from '../projects/project-identity-routes.js';
import { createStarterWorkRoutes } from '../starter-work.js';

const makeTempDir = trackTempDirs();
afterEach(() => vi.unstubAllEnvs());

// Under the home directory so the `~` spelling of it can be tested.
const PROJECT_DIR_NAME = 'station-wd-authority-project';
const PROJECT_FOLDER = join(homedir(), PROJECT_DIR_NAME);

async function fixture() {
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
  const root = makeTempDir('station-wd-authority-');
  const security = new EnvironmentSecurityService({
    homeDir: join(root, 'home'),
  });
  const operator = await security.initialize();
  const pair = (preset: PairingScopePreset, extra: string[] = []) => {
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

  const dispatch = vi.fn(async () => ({
    kind: 'dispatched' as const,
    result: { session: { threadId: 'thread-1' } },
  }));
  const launchStartTask = vi.fn(async () => ({ state: 'started' }));
  const attach = vi.fn(async () => ({ outcome: 'created' }));
  const updateExecutionRoot = vi.fn(async () => ({ identity: {} }));

  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: createLogger({ name: 'wd-authority-test', level: 'error' }),
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
    '/api/tasks',
    createTaskRoutes(
      { readTask: () => ({ id: 'task-1', projectId: 'p-1' }) } as never,
      {
        taskDispatcher: { dispatch } as never,
        readAuthorityForRequest: () => ({ userId: 'operator' }) as never,
        dispatchOwnerForRequest: () => ({ ownerUserId: 'operator' }),
        resolveProjectWorkspace: (projectId: string) =>
          projectId === 'p-1' ? PROJECT_FOLDER : undefined,
      } as never,
    ),
  );
  app.route(
    '/api/starter-work',
    createStarterWorkRoutes({ launchStartTask } as never, {
      ownerForRequest: () => ({ ownerUserId: 'operator' }) as never,
      projectFolder: (projectId) =>
        projectId === 'p-1' ? PROJECT_FOLDER : undefined,
    }),
  );
  app.route(
    '/api/projects',
    createProjectIdentityRoutes({ attach, updateExecutionRoot } as never),
  );

  const send = async (
    credential: string,
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: any }> => {
    const res = await app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return {
    operator,
    pair,
    send,
    recorders: { dispatch, launchStartTask, attach, updateExecutionRoot },
  };
}

const REFUSAL_CODE = 'working-directory-not-granted';

const ROUTES = [
  {
    name: 'POST /api/tasks/:taskId/dispatch',
    method: 'POST',
    path: '/api/tasks/task-1/dispatch',
    recorder: 'dispatch',
    withFolder: (cwd: string) => ({ runtimeConfig: { cwd } }),
    withoutFolder: () => ({ agentId: 'builder' }),
    projectFolder: (cwd: string) => ({ runtimeConfig: { cwd } }),
  },
  {
    name: 'POST /api/starter-work/launch (start-task)',
    method: 'POST',
    path: '/api/starter-work/launch',
    recorder: 'launchStartTask',
    withFolder: (cwd: string) => ({
      starterId: 'start-task',
      operationId: 'op-1',
      task: { projectId: 'p-1', title: 'T' },
      dispatch: { runtimeConfig: { cwd } },
    }),
    withoutFolder: () => ({
      starterId: 'start-task',
      operationId: 'op-1',
      task: { projectId: 'p-1', title: 'T' },
    }),
    projectFolder: (cwd: string) => ({
      starterId: 'start-task',
      operationId: 'op-1',
      task: { projectId: 'p-1', title: 'T' },
      dispatch: { runtimeConfig: { cwd } },
    }),
  },
  {
    name: 'POST /api/projects/attach',
    method: 'POST',
    path: '/api/projects/attach',
    recorder: 'attach',
    withFolder: (cwd: string) => ({
      name: 'N',
      slug: 'n',
      workingDirectory: cwd,
      identity: {},
    }),
    withoutFolder: () => ({ name: 'N', slug: 'n', identity: {} }),
    projectFolder: undefined,
  },
  {
    name: 'PUT /api/projects/:slug/identity/execution-root',
    method: 'PUT',
    path: '/api/projects/n/identity/execution-root',
    recorder: 'updateExecutionRoot',
    withFolder: (path: string) => ({
      expectedIdentity: {},
      expectedLocalProjectId: 'id-1',
      executionRoot: { repoId: 'r', path },
    }),
    withoutFolder: () => ({
      expectedIdentity: {},
      expectedLocalProjectId: 'id-1',
      executionRoot: null,
    }),
    projectFolder: undefined,
  },
] as const;

describe.each(ROUTES)('$name', (route) => {
  const calls = (f: Awaited<ReturnType<typeof fixture>>) =>
    f.recorders[route.recorder].mock.calls.length;

  test('refuses a delegation and a standard device naming a folder, doing nothing', async () => {
    const f = await fixture();
    for (const preset of ['delegation', 'standard'] as const) {
      const device = f.pair(preset);
      const res = await f.send(
        device,
        route.method,
        route.path,
        route.withFolder('/somewhere/else'),
      );
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(REFUSAL_CODE);
    }
    expect(calls(f)).toBe(0);
  });

  test('keeps a device that names no folder working', async () => {
    const f = await fixture();
    const device = f.pair('delegation');
    const res = await f.send(
      device,
      route.method,
      route.path,
      route.withoutFolder(),
    );
    expect(res.status).toBeLessThan(300);
    expect(calls(f)).toBe(1);
  });

  test('admits a folder from a device holding coding:exec and from the operator', async () => {
    const f = await fixture();
    const granted = f.pair('delegation', [PAIRING_SCOPE_CODING_EXEC]);
    const a = await f.send(
      granted,
      route.method,
      route.path,
      route.withFolder('/somewhere/else'),
    );
    expect(a.status).toBeLessThan(300);
    const b = await f.send(
      f.operator.credential,
      route.method,
      route.path,
      route.withFolder('/somewhere/else'),
    );
    expect(b.status).toBeLessThan(300);
    expect(calls(f)).toBe(2);
  });

  if (route.projectFolder) {
    const withCwd = route.projectFolder;
    // The Project's own folder, however it is spelled, is not a choice.
    test.each([
      ['exactly', PROJECT_FOLDER],
      ['with a trailing slash', `${PROJECT_FOLDER}/`],
      ['in its ~ form', `~/${PROJECT_DIR_NAME}`],
      ['through a redundant segment', `${PROJECT_FOLDER}/./`],
    ])(
      "admits the Task Project's own folder %s for a device without the grant",
      async (_label, cwd) => {
        const f = await fixture();
        const device = f.pair('standard');
        const res = await f.send(
          device,
          route.method,
          route.path,
          withCwd(cwd),
        );
        expect(res.status).toBeLessThan(300);
        expect(calls(f)).toBe(1);
      },
    );

    // A different folder, however close, is a choice. The dispatch does not
    // trim, so a padded spelling is another folder, not the Project's.
    test.each([
      ['a sibling reached through ..', `${PROJECT_FOLDER}/../elsewhere`],
      ['a child folder', `${PROJECT_FOLDER}/child`],
      ['a prefix match that is another folder', `${PROJECT_FOLDER}-other`],
      ['the folder with a trailing space', `${PROJECT_FOLDER} `],
      ['the folder with a leading space', ` ${PROJECT_FOLDER}`],
      ['blank padding only', '   '],
    ])('refuses %s for a device without the grant', async (_label, cwd) => {
      const f = await fixture();
      const device = f.pair('standard');
      const res = await f.send(device, route.method, route.path, withCwd(cwd));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(REFUSAL_CODE);
      expect(calls(f)).toBe(0);
    });
  }
});
