import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
}));

vi.mock('../client/http', () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));

/**
 * Passed in, not mocked. station#4011: these fetchers used to reach
 * `_getApiBase` from `../api`, which broke the `client/**` portability
 * contract — every fetcher there takes `apiBase` as an explicit parameter so
 * the entry runs in a CLI process and a browser alike. A test that mocks the
 * module-level resolver is a test that cannot notice it coming back.
 */
const API_BASE = 'http://station.test';

import {
  bindSecretBinding,
  createSecretBinding,
  getIntegrationSecretBindings,
  getSecretBinding,
  listSecretBindings,
  migrateStoredSecretEnv,
  replaceSecretBinding,
  revokeSecretBinding,
  unbindSecretBinding,
} from '../client/secret-bindings';

function response(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

describe('secret binding client', () => {
  beforeEach(() => mocks.authenticatedFetch.mockReset());

  test('lists operator metadata through the authenticated route', async () => {
    mocks.authenticatedFetch.mockResolvedValue(
      response({ success: true, data: [] }),
    );
    await expect(listSecretBindings(API_BASE)).resolves.toEqual([]);
    expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
      'http://station.test/api/secret-bindings',
      undefined,
    );
  });

  test('sends every secret-binding operation through the supplied API base', async () => {
    mocks.authenticatedFetch.mockResolvedValue(
      response({ success: true, data: {} }),
    );

    await listSecretBindings(API_BASE);
    await getSecretBinding(API_BASE, 'binding/name');
    await getIntegrationSecretBindings(API_BASE, 'github/enterprise');
    await createSecretBinding(API_BASE, {
      id: 'binding',
      name: 'GitHub token',
      authRef: { provider: 'github' },
    });
    await replaceSecretBinding(API_BASE, 'binding', {
      name: 'Renamed token',
      authRef: { provider: 'github' },
      expectedRevision: 2,
    });
    await revokeSecretBinding(API_BASE, 'binding', 3);
    await bindSecretBinding(API_BASE, 'binding', {
      integrationId: 'github',
      envName: 'TOKEN',
      expectedRevision: 4,
    });
    await unbindSecretBinding(API_BASE, 'binding', {
      integrationId: 'github',
      envName: 'TOKEN',
      expectedRevision: 5,
    });
    await migrateStoredSecretEnv(API_BASE, 'github', {
      bindings: { TOKEN: { bindingId: 'binding', expectedRevision: 6 } },
    });

    expect(mocks.authenticatedFetch.mock.calls).toEqual([
      [`${API_BASE}/api/secret-bindings`, undefined],
      [`${API_BASE}/api/secret-bindings/binding%2Fname`, undefined],
      [
        `${API_BASE}/api/secret-bindings/integrations/github%2Fenterprise`,
        undefined,
      ],
      [
        `${API_BASE}/api/secret-bindings`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'binding',
            name: 'GitHub token',
            authRef: { provider: 'github' },
          }),
        },
      ],
      [
        `${API_BASE}/api/secret-bindings/binding`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Renamed token',
            authRef: { provider: 'github' },
            expectedRevision: 2,
          }),
        },
      ],
      [
        `${API_BASE}/api/secret-bindings/binding/revoke`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedRevision: 3 }),
        },
      ],
      [
        `${API_BASE}/api/secret-bindings/binding/bind`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            integrationId: 'github',
            envName: 'TOKEN',
            expectedRevision: 4,
          }),
        },
      ],
      [
        `${API_BASE}/api/secret-bindings/binding/unbind`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            integrationId: 'github',
            envName: 'TOKEN',
            expectedRevision: 5,
          }),
        },
      ],
      [
        `${API_BASE}/api/secret-bindings/integrations/github/migrate-stored-env`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bindings: { TOKEN: { bindingId: 'binding', expectedRevision: 6 } },
          }),
        },
      ],
    ]);
  });

  test('preserves structured validation details on refusal', async () => {
    mocks.authenticatedFetch.mockResolvedValue(
      response(
        {
          success: false,
          error: 'Validation failed',
          details: {
            fieldErrors: {
              expectedRevision: ['Expected a non-negative integer.'],
            },
          },
        },
        400,
      ),
    );

    await expect(listSecretBindings(API_BASE)).rejects.toThrow(
      'Expected a non-negative integer.',
    );
  });

  test('reads integration binding projections and posts structured bind/migration bodies without a reveal surface', async () => {
    mocks.authenticatedFetch
      .mockResolvedValueOnce(
        response({
          success: true,
          data: {
            integrationId: 'github',
            secretEnvBindingIds: { TOKEN: 'binding' },
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          success: true,
          data: {
            outcome: 'complete',
            binding: {},
            integrationId: 'github',
            envName: 'TOKEN',
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          success: true,
          data: { outcome: 'migrated', migratedEnvNames: ['TOKEN'] },
        }),
      );

    await expect(
      getIntegrationSecretBindings(API_BASE, 'github'),
    ).resolves.toEqual({
      integrationId: 'github',
      secretEnvBindingIds: { TOKEN: 'binding' },
    });
    await bindSecretBinding(API_BASE, 'binding', {
      integrationId: 'github',
      envName: 'TOKEN',
      expectedRevision: 1,
    });
    await migrateStoredSecretEnv(API_BASE, 'github', {
      bindings: { TOKEN: { bindingId: 'binding', expectedRevision: 2 } },
    });

    expect(mocks.authenticatedFetch.mock.calls.map(([url]) => url)).toEqual([
      'http://station.test/api/secret-bindings/integrations/github',
      'http://station.test/api/secret-bindings/binding/bind',
      'http://station.test/api/secret-bindings/integrations/github/migrate-stored-env',
    ]);
    const migrationRequest = mocks.authenticatedFetch.mock.calls[2]?.[1] as
      | RequestInit
      | undefined;
    expect(migrationRequest).toBeDefined();
    expect(JSON.parse(migrationRequest?.body as string)).toEqual({
      bindings: { TOKEN: { bindingId: 'binding', expectedRevision: 2 } },
    });
  });
});
