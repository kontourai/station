import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEPLOYMENT_AUTHENTICATION_BASE_PATH } from '@kontourai/station-contracts/deployment-authentication';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { afterEach, describe, expect, test } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { createDeploymentAuthenticationRoutes } from '../../../routes/system/deployment-authentication-routes.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { createLogger } from '../../../utils/logger.js';
import { EventBus } from '../../orchestration/event-bus.js';
import {
  loadDeploymentAuthentication,
  readDeploymentAuthenticationConfiguration,
} from '../deployment-authentication-loader.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const origin = 'https://station.example.test';

async function harness(enabled = true) {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'station-auth-contract-'));
  roots.push(homeDirectory);
  const modulePath = join(homeDirectory, 'fixture-provider.mjs');
  // Test-only external implementer: only the public factory/Fetch contract,
  // loaded by the same operator-module loader the real Station uses.
  await writeFile(
    modulePath,
    `
export async function createStationAuthenticationProvider(host) {
  let revoked = false;
  return {
    version: 'station.authentication/v1',
    issuer: 'urn:station:' + host.stationId,
    displayName: 'Disposable test account provider',
    sessionCookies: ['fixture_account'],
    endpoints: [
      {path:'/login',methods:['POST'],operation:'begin-login'},
      {path:'/logout',methods:['POST'],operation:'logout'}
    ],
    async authenticate(request) {
      if ('body' in request || 'json' in request) throw new Error('Verifier received a destination body');
      const cookie = request.headers.get('cookie');
      if (!cookie) return {kind:'absent'};
      if (cookie === 'fixture_account=outage') throw new Error('PRIVATE_PROVIDER_FAILURE');
      if (cookie !== 'fixture_account=valid' || revoked) return {kind:'invalid',reason:'revoked'};
      return {kind:'authenticated',session:{
        subject:'person-opaque',displayName:'Fixture Person',sessionId:'non-secret-record',
        authenticatedAt:new Date(Date.now()-1000).toISOString(),
        expiresAt:new Date(Date.now()+60000).toISOString(),contacts:[]
      }};
    },
    async handle(request) {
      if (new URL(request.url).pathname.endsWith('/logout')) revoked = true;
      return Response.json({accepted:true},{headers:{'Set-Cookie':'fixture_account=valid; Secure; HttpOnly; SameSite=Lax; Path=/'}});
    }
  };
}
`,
  );
  const authentication = await loadDeploymentAuthentication(
    enabled ? { modulePath, publicOrigin: origin } : undefined,
    { stationId: 'fixture-station', homeDirectory },
  );
  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: createLogger({
      name: 'deployment-authentication-test',
      level: 'error',
    }),
    eventBus: new EventBus(),
    security: {
      deploymentAuthentication: authentication?.service,
      allowedOrigins: [origin],
      verifyCredential: (value) => value === 'fixture-operator',
      resolveCredentialAuthority: () => 'operator-credential',
      resolveGrantedScope: () => DEFAULT_GRANT_PAIRING_SCOPE,
    },
  });
  app.route(
    DEPLOYMENT_AUTHENTICATION_BASE_PATH,
    createDeploymentAuthenticationRoutes(authentication),
  );
  app.get('/api/projects', (c) => c.json({ privateProjects: true }));
  app.post('/api/projects', async (c) =>
    c.json({ received: await c.req.json() }),
  );
  return { app, authentication, modulePath, homeDirectory };
}

describe('operator authentication module through production HTTP composition', () => {
  test('bounds invalid account attempts before provider verification on protected routes', async () => {
    const { app, authentication } = await harness();
    const responses = await Promise.all(
      Array.from({ length: 11 }, () =>
        app.request(`${origin}/api/projects`, {
          headers: { Cookie: 'fixture_account=invalid' },
        }),
      ),
    );
    expect(
      responses.filter((response) => response.status === 401),
    ).toHaveLength(10);
    const limited = responses.filter((response) => response.status === 429);
    expect(limited).toHaveLength(1);
    expect(limited[0]!.headers.get('Retry-After')).toBeTruthy();
    expect(
      authentication?.service.hasCredential(
        new Request(origin, { headers: { Cookie: 'station-device=personal' } }),
      ),
    ).toBe(false);
  });

  test('logs in and resolves its own principal without issuing personal/operator access', async () => {
    const { app } = await harness();
    const login = await app.request(`${origin}/api/account-auth/login`, {
      method: 'POST',
      headers: { Origin: origin },
    });
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toContain('HttpOnly');
    const headers = { Cookie: 'fixture_account=valid' };
    const self = await app.request(`${origin}/api/account-auth/session`, {
      headers,
    });
    expect(self.status).toBe(200);
    const body = await readJson<{
      data: { principal: { id: string; kind: string } };
    }>(self);
    expect(body.data.principal.kind).toBe('human');
    expect(body.data.principal.id).toMatch(/^human:deployment:/);
    expect(body.data).not.toHaveProperty('credential');
    expect(body.data).not.toHaveProperty('sessionId');
    expect(self.headers.get('cache-control')).toBe('no-store');
    const privateProjects = await app.request(`${origin}/api/projects`, {
      headers,
    });
    expect(privateProjects.status).toBe(401);
  });

  test('invalid, revoked and unavailable accounts never fall through to an operator credential', async () => {
    const { app } = await harness();
    for (const [cookie, status, code] of [
      ['fixture_account=invalid', 401, 'account_authentication_invalid'],
      ['fixture_account=outage', 503, 'authentication_unavailable'],
    ] as const) {
      const response = await app.request(`${origin}/api/projects`, {
        headers: { Cookie: cookie, Authorization: 'Bearer fixture-operator' },
      });
      expect(response.status).toBe(status);
      expect(
        (await readJson<{ error: { code: string } }>(response)).error.code,
      ).toBe(code);
    }
    await app.request(`${origin}/api/account-auth/logout`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: 'fixture_account=valid' },
    });
    const after = await app.request(`${origin}/api/account-auth/session`, {
      headers: { Cookie: 'fixture_account=valid' },
    });
    expect(after.status).toBe(401);
  });

  test('requires origin and declared operation while preserving ordinary local/no-provider use', async () => {
    const { app } = await harness();
    expect(
      (
        await app.request(`${origin}/api/account-auth/login`, {
          method: 'POST',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`${origin}/api/account-auth/login`, {
          method: 'POST',
          headers: { Origin: 'https://untrusted.example.test' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`${origin}/api/account-auth/undeclared`, {
          method: 'POST',
          headers: { Origin: origin },
        })
      ).status,
    ).toBe(404);
    const solo = await harness(false);
    expect(
      (await solo.app.request(`${origin}/api/account-auth/session`)).status,
    ).toBe(501);
    expect(
      (
        await solo.app.request(`${origin}/api/projects`, {
          headers: { Authorization: 'Bearer fixture-operator' },
        })
      ).status,
    ).toBe(200);
    expect(readDeploymentAuthenticationConfiguration({})).toBeUndefined();
    expect(() =>
      readDeploymentAuthenticationConfiguration({
        STATION_AUTHENTICATION_MODULE: '/fixture.mjs',
      }),
    ).toThrow('both');
  });

  test('does not consume a destination request body during session verification', async () => {
    const { app } = await harness();
    const response = await app.request(`${origin}/api/projects`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer fixture-operator',
        Cookie: 'fixture_account=valid',
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Preserved' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: { name: 'Preserved' } });
  });
});
