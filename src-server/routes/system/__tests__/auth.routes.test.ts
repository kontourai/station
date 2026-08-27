import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import {
  bindRuntimeLocalOperator,
  type RuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  authOps: { add: vi.fn() },
}));
vi.mock('../../../providers/registries/registry.js', () => ({
  getAuthProvider: () => ({
    getStatus: async () => ({ authenticated: true, method: 'sso' }),
    renew: async () => ({ success: true, message: 'Renewed' }),
  }),
  getUserIdentityProvider: () => ({
    getIdentity: async () => ({ alias: 'testuser', name: 'Test User' }),
  }),
  getUserDirectoryProvider: () => ({
    searchPeople: async (q: string) => [{ alias: q, name: q }],
    lookupPerson: async (alias: string) => ({ alias, name: alias }),
  }),
}));

const { createAuthRoutes, createUserRoutes } = await import('../auth.js');

describe('Auth Routes', () => {
  test('GET /status returns auth status', async () => {
    const app = createAuthRoutes();
    const body = await json(await app.request('/status'));
    expect(body.authenticated).toBe(true);
    expect(body.user).toBeDefined();
  });

  test('POST /renew returns success', async () => {
    const app = createAuthRoutes();
    const body = await json(await app.request('/renew', { method: 'POST' }));
    expect(body.success).toBe(true);
  });

  test('GET /local-grant-eligibility exposes only the auth-bound owner-secret mint fact', async () => {
    const app = createAuthRoutes();
    const probe = async (
      principal: RuntimeAuthenticatedRequestPrincipal | undefined,
    ) => {
      const request = new Request(
        'http://station.test/local-grant-eligibility',
      );
      if (principal) bindRuntimeLocalOperator(request, principal);
      return json(await app.request(request));
    };

    // The sole accepted shape: both mint-time possession and the owner-only
    // local-grant mint kind. This is a server-bound fact, never a loopback or
    // pairing-source inference.
    await expect(
      probe({
        credential: 'desktop-local-grant',
        authority: 'device-credential',
        source: 'bearer',
        pairingSource: 'same-origin',
        locality: 'home-possession',
        mintKind: 'local-grant',
      }),
    ).resolves.toEqual({ eligible: true });

    // The physically observed legacy desktop record: accepted as a paired
    // bearer, but created before the mint-time fields existed.
    await expect(
      probe({
        credential: 'legacy-desktop',
        authority: 'device-credential',
        source: 'bearer',
        pairingSource: 'same-origin',
      }),
    ).resolves.toEqual({ eligible: false });

    // Same home-possession, but browser-held custody: never eligible for the
    // desktop-only exchange decision.
    await expect(
      probe({
        credential: 'host-browser',
        authority: 'device-credential',
        source: 'session',
        pairingSource: 'same-origin',
        locality: 'home-possession',
        mintKind: 'ui-bootstrap',
      }),
    ).resolves.toEqual({ eligible: false });

    // A remote/mobile pairing never acquires eligibility from sharing an
    // origin or using a bearer credential.
    await expect(
      probe({
        credential: 'paired-pixel',
        authority: 'device-credential',
        source: 'bearer',
        pairingSource: 'tailnet',
      }),
    ).resolves.toEqual({ eligible: false });
  });
});

describe('User Routes', () => {
  test('GET /search returns results', async () => {
    const app = createUserRoutes();
    const body = await json(await app.request('/search?q=test'));
    expect(body).toHaveLength(1);
  });

  test('GET /search returns empty for no query', async () => {
    const app = createUserRoutes();
    const body = await json(await app.request('/search'));
    expect(body).toEqual([]);
  });

  test('GET /:alias returns person', async () => {
    const app = createUserRoutes();
    const body = await json(await app.request('/testuser'));
    expect(body.alias).toBe('testuser');
  });
});
