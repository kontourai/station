import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { OutsideAgentGrantStore } from '../../../services/outside-agent/oauth-store.js';
import { installStationEnvelopeMarker } from '../runtime-http.js';

const temp = trackTempDirs();
afterEach(() => vi.unstubAllEnvs());

const guardedPaths = [
  '/mcp',
  '/oauth',
  '/oauth/register',
  '/oauth/token',
  '/oauth/authorize',
  '/oauth/authorize/status',
  '/oauth/authorize/complete',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/api/outside-agent',
  '/api/outside-agent/clients',
  '/api/outside-agent/requests/id',
  '/api/outside-agent/requests/id/approval',
  '/api/outside-agent/host/confirm',
  '/api/outside-agent/host/deny',
  '/api/outside-agent/grants/id/change',
  '/api/outside-agent/grants/id/revoke',
  '/api/outside-agent/redirect-origins/change',
  '/api/outside-agent/cors-origins/change',
  '/api/outside-agent/future',
];
const encodedPaths = [
  '/%6dcp',
  '/%6Dcp',
  '/m%63p',
  '/%6fauth/token',
  '/%6Fauth/token',
  '/.well-known/oauth-authorization%2dserver',
  '/.well-known/oauth-authorization%2Dserver',
  '/%2ewell-known/oauth-authorization-server',
  '/%2Ewell-known/oauth-authorization-server',
  '/%2Ewell-known/oauth-protected-resource',
  '/.well-known/oauth-protected%2Dresource/mcp',
  '/api/outside%2dagent/requests/id/approval',
  '/api/outside%2Dagent/requests/id/approval',
  '/api/%6futside-agent/clients',
  '/api/%6Futside-agent/clients',
];

test('compiled release refusal blocks real outside routes before middleware or store writes, including encoded segments and trailing slashes', async () => {
  const home = temp('outside-oauth-release-');
  vi.stubEnv('STATION_HOME', home);
  vi.stubEnv('STATION_OUTSIDE_AGENT_OAUTH_ENABLED', 'true');
  vi.stubEnv('STATION_FEATURES', 'outside-agent-mcp');
  const app = new Hono();
  // The real runtime composition invokes this before the hosted tenant gate.
  installStationEnvelopeMarker(app);
  const downstream = vi.fn();
  app.use('*', async (_c, next) => {
    downstream();
    await next();
  });
  const handler = vi.fn(() => {
    const store = OutsideAgentGrantStore.open(home, {
      stationId: 'test',
      bootId: 'boot',
      issuer: 'https://station.test',
      validateReview: () => true,
    });
    try {
      store.register({
        application_type: 'native',
        redirect_uris: ['http://127.0.0.1:43198/callback'],
      });
    } finally {
      store.close();
    }
    return new Response('outside handler');
  });
  const control = new Hono();
  // Real literal routes make Hono's decoding observable without a catch-all.
  for (const path of guardedPaths) {
    for (const suffix of ['', '/']) {
      app.all(`${path}${suffix}`, handler);
      control.all(`${path}${suffix}`, (c) => c.text('outside handler'));
    }
  }
  for (const path of [...guardedPaths, ...encodedPaths]) {
    for (const suffix of ['', '/']) {
      for (const method of [
        'GET',
        'POST',
        'PUT',
        'DELETE',
        'OPTIONS',
        'PATCH',
        'HEAD',
      ]) {
        const url = `https://station.test${path}${suffix}`;
        expect(
          (await control.request(url, { method })).status,
          `${method} ${url} control`,
        ).toBe(200);
        const response = await app.request(url, {
          method,
          headers: {
            Authorization: 'Bearer host-proof',
            Origin: 'https://station.test',
          },
        });
        expect(response.status, `${method} ${url}`).toBe(404);
      }
    }
  }
  expect(downstream).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
  expect(
    existsSync(join(home, 'authentication/outside-agent-oauth.sqlite')),
  ).toBe(false);
});

test('guard follows strict Hono routing: no case folding, slash collapse or second decoding', async () => {
  const app = new Hono();
  installStationEnvelopeMarker(app);
  const downstream = vi.fn();
  app.use('*', async (_c, next) => {
    downstream();
    await next();
  });
  const handler = vi.fn(() => new Response('outside handler'));
  for (const path of guardedPaths) app.all(path, handler);
  const nonAliases = [
    '/MCP',
    '/OAuth/token',
    '/api/Outside-agent/clients',
    '/.well-known/OAuth-authorization-server',
    '//mcp',
    '/api//outside-agent/clients',
    '/.well-known//oauth-authorization-server',
    '/%256Fauth/token',
    '/%256fauth/token',
    '/%256Dcp',
    '/%252Ewell-known/oauth-authorization-server',
    '/api/outside%252Dagent/clients',
  ];
  for (const path of nonAliases) {
    const url = `https://station.test${path}`;
    expect((await app.request(url)).status, path).toBe(404);
  }
  expect(handler).not.toHaveBeenCalled();
  expect(downstream).toHaveBeenCalledTimes(nonAliases.length);
});

test('compiled refusal preserves internal MCP, engine proxy, nested resource handlers and other discovery', async () => {
  const app = new Hono();
  installStationEnvelopeMarker(app);
  const paths = [
    '/mcp/station-control',
    '/mcp/servers/id',
    '/mcp/id/mcp',
    '/mcp/oauth-proxy/id',
    '/.well-known/station/v1',
    '/api/pairing/devices',
  ];
  for (const path of paths) app.all(path, (c) => c.text('existing handler'));
  for (const path of paths) {
    const response = await app.request(`https://station.test${path}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('existing handler');
  }
});
