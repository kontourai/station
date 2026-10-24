import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { OutsideAgentGrantStore } from '../../../services/outside-agent/oauth-store.js';
import { installStationEnvelopeMarker } from '../runtime-http.js';

const temp = trackTempDirs();
afterEach(() => vi.unstubAllEnvs());

test('compiled release refusal blocks every outside leaf before any auth/hosted middleware or store write, regardless of configuration', async () => {
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
  app.all('*', (c) => {
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
    return c.json({ reached: true });
  });
  const paths = [
    '/mcp',
    '/mcp/',
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
  for (const path of paths)
    for (const method of [
      'GET',
      'POST',
      'PUT',
      'DELETE',
      'OPTIONS',
      'PATCH',
      'HEAD',
    ]) {
      const response = await app.request(`https://station.test${path}`, {
        method,
        headers: {
          Authorization: 'Bearer host-proof',
          Origin: 'https://station.test',
        },
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  expect(downstream).not.toHaveBeenCalled();
  expect(
    existsSync(join(home, 'authentication/outside-agent-oauth.sqlite')),
  ).toBe(false);
});

test('compiled refusal preserves internal MCP, engine proxy, nested resource handlers and other discovery', async () => {
  const app = new Hono();
  installStationEnvelopeMarker(app);
  app.all('*', (c) => c.text('existing handler'));
  for (const path of [
    '/mcp/station-control',
    '/mcp/servers/id',
    '/mcp/id/mcp',
    '/mcp/oauth-proxy/id',
    '/.well-known/station/v1',
    '/api/pairing/devices',
  ]) {
    const response = await app.request(`https://station.test${path}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('existing handler');
  }
});
