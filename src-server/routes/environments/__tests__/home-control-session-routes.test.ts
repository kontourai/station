import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HomeControlSessionOpenObservation } from '@kontourai/station-contracts/cloud-move';
import {
  PAIRING_SCOPE_HOME_CONTROL,
  PAIRING_SCOPE_HOME_TRANSFER,
} from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { createPersonalHomeAuthorityDatabase } from '../../../runtime/bootstrap/personal-home-authority-database.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { createLogger } from '../../../utils/logger.js';
import { createHomeAuthorityRoutes } from '../home-authority-routes.js';

const roots: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
  const root = mkdtempSync(join(tmpdir(), 'station-home-control-http-'));
  roots.push(root);
  const homeDir = join(root, 'controller-home');
  const authorityDir = join(root, 'authority');
  mkdirSync(authorityDir, { mode: 0o700 });
  const security = new EnvironmentSecurityService({ homeDir });
  const controller = await security.initialize();
  const baseOpen = createPersonalHomeAuthorityDatabase(
    homeDir,
    join(authorityDir, 'authority.sqlite'),
  )!;
  const openDatabase = () => {
    const database = baseOpen();
    databases.push(database);
    return database;
  };
  const pair = (scope?: string) => {
    const offer = security.devicePairing.createOffer({
      endpoint: 'https://controller.example.test',
      scope,
    });
    const requested = security.devicePairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Personal home',
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
  const promoteControl = <T extends ReturnType<typeof pair>>(paired: T) => {
    security.devicePairing.setDeviceScope(
      paired.device.id,
      [PAIRING_SCOPE_HOME_TRANSFER, PAIRING_SCOPE_HOME_CONTROL],
      { kind: 'presented-credential' },
    );
    return paired;
  };
  const createApp = (
    databaseFactory: (() => DatabaseSync) | null = openDatabase,
    getPublicHandshake = () => security.getPublicHandshake(),
  ) => {
    const app = new Hono();
    configureRuntimeHttp({
      app: app as never,
      logger: createLogger({ name: 'home-control-http-test', level: 'error' }),
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
        allowedOrigins: [],
      },
    });
    app.route(
      '/api/home-authority',
      createHomeAuthorityRoutes(
        {
          identifyDevice: (candidate) => security.identifyDevice(candidate),
          verifyOperatorCredential: (candidate) =>
            security.verifyOperatorCredential(candidate),
          devicePairing: security.devicePairing,
          getPublicHandshake,
        },
        databaseFactory ?? undefined,
      ),
    );
    return app;
  };
  const post = (app: Hono, path: string, credential: string, body: unknown) =>
    app.request(`/api/home-authority${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  return {
    root,
    security,
    controller,
    databases,
    openDatabase,
    pair,
    promoteControl,
    createApp,
    post,
  };
}

function expectClosed(database: DatabaseSync): void {
  expect(() => database.prepare('SELECT 1')).toThrow();
}

test.skipIf(process.platform === 'win32')(
  'only home-control participants open and retry through closed database connections',
  async () => {
    const f = await fixture();
    const transferOnly = f.pair(PAIRING_SCOPE_HOME_TRANSFER);
    const home = f.promoteControl(f.pair(PAIRING_SCOPE_HOME_TRANSFER));
    const app = f.createApp();
    const replaySecret = 'a'.repeat(64);

    expect(
      (
        await f.post(app, '/control-sessions/open', transferOnly.credential, {
          openId: 'open-a',
          replaySecret,
        })
      ).status,
    ).toBe(403);
    expect(f.databases).toHaveLength(0);
    expect(
      (
        await f.post(app, '/control-sessions/open', f.controller.credential, {
          openId: 'open-a',
          replaySecret,
        })
      ).status,
    ).toBe(403);
    expect(f.databases).toHaveLength(0);
    const inheritedManager = f.pair();
    expect(
      (
        await f.post(
          app,
          `/control-sessions/${home.device.id}/inspect`,
          inheritedManager.credential,
          {},
        )
      ).status,
    ).toBe(403);
    expect(f.databases).toHaveLength(0);

    const openedResponse = await f.post(
      app,
      '/control-sessions/open',
      home.credential,
      { openId: 'open-a', replaySecret },
    );
    expect(openedResponse.status).toBe(200);
    expect(openedResponse.headers.get('cache-control')).toBe('no-store');
    const opened =
      (await openedResponse.json()) as HomeControlSessionOpenObservation;
    expect(opened).toMatchObject({
      schemaVersion: 'station.home-control-session-open/v1',
      replayed: false,
      executionAuthorityTransferred: false,
      executionResumeAvailable: false,
      capability: {
        homeRef: `paired:${home.device.id}`,
        openId: 'open-a',
        generation: 1,
      },
    });
    expect(opened.capability.token).toMatch(/^[a-f0-9]{64}$/);
    expectClosed(f.databases.at(-1)!);

    const retry = await f.post(app, '/control-sessions/open', home.credential, {
      openId: 'open-a',
      replaySecret,
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ...opened, replayed: true });
    expect(f.databases).toHaveLength(2);
    for (const database of f.databases) expectClosed(database);
  },
);

test.skipIf(process.platform === 'win32')(
  'missing or wrong replay proof never exposes the cached capability',
  async () => {
    const f = await fixture();
    const home = f.promoteControl(f.pair(PAIRING_SCOPE_HOME_TRANSFER));
    const app = f.createApp();
    const replaySecret = 'a'.repeat(64);
    const opened = await f.post(
      app,
      '/control-sessions/open',
      home.credential,
      { openId: 'open-a', replaySecret },
    );
    expect(opened.status).toBe(200);

    const missing = await f.post(
      app,
      '/control-sessions/open',
      home.credential,
      { openId: 'open-a' },
    );
    expect(missing.status).toBe(400);
    const wrongSecret = 'b'.repeat(64);
    const wrong = await f.post(app, '/control-sessions/open', home.credential, {
      openId: 'open-a',
      replaySecret: wrongSecret,
    });
    expect(wrong.status).toBe(409);
    const text = await wrong.text();
    expect(text).not.toContain(replaySecret);
    expect(text).not.toContain(wrongSecret);
    expect(text).not.toContain('token');
  },
);

test.skipIf(process.platform === 'win32')(
  'route cache loss requires the exact retained capability',
  async () => {
    const f = await fixture();
    const home = f.promoteControl(f.pair(PAIRING_SCOPE_HOME_TRANSFER));
    const replaySecret = 'a'.repeat(64);
    const firstApp = f.createApp();
    const first = await f.post(
      firstApp,
      '/control-sessions/open',
      home.credential,
      { openId: 'open-a', replaySecret },
    );
    const opened = (await first.json()) as HomeControlSessionOpenObservation;

    const recreated = f.createApp();
    const lost = await f.post(
      recreated,
      '/control-sessions/open',
      home.credential,
      { openId: 'open-a', replaySecret },
    );
    expect(lost.status).toBe(409);
    expect(await lost.json()).toEqual({ kind: 'recovery-required' });
    const resumed = await f.post(
      recreated,
      '/control-sessions/open',
      home.credential,
      { openId: 'open-a', existingCapability: opened.capability },
    );
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({ ...opened, replayed: true });
  },
);

test.skipIf(process.platform === 'win32')(
  'only the current operator inspects and retires an exact generation',
  async () => {
    const f = await fixture();
    const home = f.promoteControl(f.pair(PAIRING_SCOPE_HOME_TRANSFER));
    const inheritedManager = f.pair();
    const app = f.createApp();
    const opened = (await (
      await f.post(app, '/control-sessions/open', home.credential, {
        openId: 'open-a',
        replaySecret: 'a'.repeat(64),
      })
    ).json()) as HomeControlSessionOpenObservation;
    const inspectPath = `/control-sessions/${home.device.id}/inspect`;
    expect((await f.post(app, inspectPath, home.credential, {})).status).toBe(
      403,
    );
    expect(
      (await f.post(app, inspectPath, inheritedManager.credential, {})).status,
    ).toBe(403);
    const inspected = await f.post(
      app,
      inspectPath,
      f.controller.credential,
      {},
    );
    expect(inspected.status).toBe(200);
    expect(inspected.headers.get('cache-control')).toBe('no-store');
    const inspection = await inspected.json();
    expect(inspection).toEqual({
      schemaVersion: 'station.home-control-session-inspection/v1',
      homeRef: `paired:${home.device.id}`,
      openId: 'open-a',
      generation: 1,
      state: 'active',
      unresolvedAdmissionCount: 0,
      executionAuthorityTransferred: false,
      executionResumeAvailable: false,
    });
    expect(inspection).not.toHaveProperty('token');
    expect(inspection).not.toHaveProperty('capabilityDigest');

    const retirePath = `/control-sessions/${home.device.id}/retire`;
    expect(
      (
        await f.post(app, retirePath, f.controller.credential, {
          expectedGeneration: opened.capability.generation + 1,
        })
      ).status,
    ).toBe(409);
    const retired = await f.post(app, retirePath, f.controller.credential, {
      expectedGeneration: opened.capability.generation,
    });
    expect(retired.status).toBe(200);
    expect(await retired.json()).toEqual({
      schemaVersion: 'station.home-control-session-retirement/v1',
      homeRef: `paired:${home.device.id}`,
      generation: 1,
      state: 'retired',
      executionAuthorityTransferred: false,
      executionResumeAvailable: false,
    });
    for (const database of f.databases) expectClosed(database);
  },
);

test.skipIf(process.platform === 'win32')(
  'scope removal during the handshake refuses before opening the database',
  async () => {
    const f = await fixture();
    const home = f.promoteControl(f.pair(PAIRING_SCOPE_HOME_TRANSFER));
    const app = f.createApp(f.openDatabase, async () => {
      const handshake = await f.security.getPublicHandshake();
      f.security.devicePairing.setDeviceScope(
        home.device.id,
        [PAIRING_SCOPE_HOME_TRANSFER],
        { kind: 'presented-credential' },
      );
      return handshake;
    });
    const response = await f.post(
      app,
      '/control-sessions/open',
      home.credential,
      { openId: 'open-a', replaySecret: 'a'.repeat(64) },
    );
    expect(response.status).toBe(403);
    expect(f.databases).toHaveLength(0);
  },
);

test.skipIf(process.platform === 'win32')(
  'hosted, missing configuration, and late revocation fail closed without database mutation',
  async () => {
    const f = await fixture();
    const home = f.promoteControl(f.pair(PAIRING_SCOPE_HOME_TRANSFER));
    const input = { openId: 'open-a', replaySecret: 'a'.repeat(64) };
    expect(
      (
        await f.post(
          f.createApp(null),
          '/control-sessions/open',
          home.credential,
          input,
        )
      ).status,
    ).toBe(503);
    expect(f.databases).toHaveLength(0);

    vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', '/unused/hosted.json');
    expect(
      (
        await f.post(
          f.createApp(),
          '/control-sessions/open',
          home.credential,
          input,
        )
      ).status,
    ).toBe(403);
    expect(f.databases).toHaveLength(0);
    vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);

    const late = f.createApp(f.openDatabase, async () => {
      const handshake = await f.security.getPublicHandshake();
      f.security.devicePairing.revokeDevice(
        home.device.id,
        'operator-credential',
      );
      return handshake;
    });
    expect(
      (await f.post(late, '/control-sessions/open', home.credential, input))
        .status,
    ).toBe(403);
    expect(f.databases).toHaveLength(0);
  },
);
