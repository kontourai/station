import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { NativeSurfaceRegistry } from '../../../services/connections/native-surface-registry.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { createNativeRelaySurfaceRoutes } from '../native-relay-surface-routes.js';

const makeTempDir = trackTempDirs();
test('only a current real operator credential can approve and revoke a native transport surface', async () => {
  const home = makeTempDir('native-relay-surface-route-');
  const security = new EnvironmentSecurityService({ homeDir: home });
  const { credential, environmentId } = await security.initialize();
  const registry = new NativeSurfaceRegistry(home, environmentId);
  const app = new Hono();
  app.use('*', async (context, next) => {
    const candidate = context.req
      .header('Authorization')
      ?.replace(/^Bearer /u, '');
    if (candidate && security.verifyOperatorCredential(candidate))
      setRuntimeAuthenticatedRequestPrincipal(context.req.raw, {
        kind: 'credential',
        credential: candidate,
        authority: 'operator-credential',
        source: 'bearer',
      });
    await next();
  });
  app.route(
    '/api/pairing/native-relay-surfaces',
    createNativeRelaySurfaceRoutes({ registry, security }),
  );
  const tuple = {
    scope: {
      stationId: environmentId,
      enrollmentId: randomUUID(),
      routingGeneration: 1,
    },
    surface: {
      kind: 'station-native',
      appIdentifier: 'io.kontourai.station',
      channel: 'nightly',
      clientInstanceId: randomUUID(),
      keyThumbprint: 'T'.repeat(43),
    },
  };
  const send = (operation: string, bearer?: string) =>
    app.request('/api/pairing/native-relay-surfaces', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ operation, tuple }),
    });
  try {
    expect((await send('approve')).status).toBe(403);
    expect(
      (await send('approve', 'routing-grant-is-not-operator')).status,
    ).toBe(403);
    expect(registry.approvedSurfaces()).toEqual([]);
    expect((await send('approve', credential)).status).toBe(200);
    const captured = registry.approvedSurfaces()[0]!;
    expect(captured.isCurrent()).toBe(true);
    expect((await send('revoke', credential)).status).toBe(200);
    expect(captured.isCurrent()).toBe(false);
    expect((await send('approve', credential)).status).toBe(409);
  } finally {
    registry.close();
  }
});
