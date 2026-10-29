// @vitest-environment node
import { describe, expect, test } from 'vitest';
import {
  isLeafScopeDeclared,
  requiredPairingScope,
} from '../../../security/pairing-route-scopes.js';
import { createSystemStatusRoutes } from '../system-status-routes.js';

describe('GET /api/system/routes', () => {
  test('answers the Station routes when the deployment serves them', async () => {
    const routes = createSystemStatusRoutes({
      resolveStationRoutes: async () => ({
        environmentId: 'env-home',
        routes: [{ kind: 'lan', url: 'http://192.168.50.16:3774' }],
      }),
    } as never);
    const response = await routes.request('/routes');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      environmentId: 'env-home',
      routes: [{ kind: 'lan', url: 'http://192.168.50.16:3774' }],
    });
  });

  test('answers 404 where the deployment does not serve them', async () => {
    const routes = createSystemStatusRoutes({} as never);
    expect((await routes.request('/routes')).status).toBe(404);
  });

  test('is a declared read-tier leaf, like the identity read', () => {
    expect(isLeafScopeDeclared('GET', '/api/system/routes')).toBe(true);
    expect(requiredPairingScope('GET', '/api/system/routes')).toBeTruthy();
    expect(requiredPairingScope('GET', '/api/system/routes')).toBe(
      requiredPairingScope('GET', '/api/system/identity'),
    );
  });
});
