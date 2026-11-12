import { afterEach, expect, test, vi } from 'vitest';
import {
  ACCESS_AUDIENCE,
  ACCESS_TEAM,
  accessFixture,
} from './access-fixture.ts';
import { call, fakeReceiver, testEnv } from './helpers.ts';

afterEach(() => vi.unstubAllGlobals());

test('signed Access sessions admit only read-only insights for the configured application', async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  env.ACCESS_TEAM_DOMAIN = ACCESS_TEAM;
  env.ACCESS_AUDIENCE = ACCESS_AUDIENCE;
  const valid = await accessFixture();
  vi.stubGlobal('fetch', async () => Response.json(valid.jwks));
  const headers = { 'cf-access-jwt-assertion': valid.token };
  expect((await call(env, '/insights/data', { headers })).status).toBe(200);
  expect(
    (await call(env, '/insights/data', { method: 'POST', headers })).status,
  ).toBe(404);
  expect((await call(env, '/v1/operator/storage', { headers })).status).toBe(
    401,
  );
  for (const claims of [
    { iss: 'https://other.cloudflareaccess.com' },
    { aud: 'other-application' },
    { exp: Math.floor(Date.now() / 1000) - 1 },
    { nbf: Math.floor(Date.now() / 1000) + 600 },
    { email: undefined },
    { sub: undefined },
    { sub: '' },
  ]) {
    const refused = await accessFixture(claims);
    expect(
      (
        await call(env, '/insights/data', {
          headers: { 'cf-access-jwt-assertion': refused.token },
        })
      ).status,
    ).toBe(401);
  }
  const forged = valid.token.split('.');
  forged[1] = Buffer.from(
    JSON.stringify({ email: 'owner@example.test', exp: 9999999999 }),
  ).toString('base64url');
  expect(
    (
      await call(env, '/insights/data', {
        headers: { 'cf-access-jwt-assertion': forged.join('.') },
      })
    ).status,
  ).toBe(401);
  expect((await call(env, '/insights/data')).status).toBe(401);
  expect(
    (
      await call(env, '/insights/data', {
        headers: { 'cf-access-authenticated-user-email': 'owner@example.test' },
      })
    ).status,
  ).toBe(401);
  delete env.ACCESS_AUDIENCE;
  expect((await call(env, '/insights/data', { headers })).status).toBe(503);
});
