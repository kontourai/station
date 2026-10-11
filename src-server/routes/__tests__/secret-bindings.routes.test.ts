import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecretBindingView } from '@kontourai/station-contracts/secret-binding';
import { expect, test } from 'vitest';
import { withOperatorPrincipal } from '../../__test-utils__/operator-principal.js';
import { readJson } from '../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  FileSecretBindingAdministration,
  SecretBindingConflictError,
} from '../../services/secrets/secret-binding-administration.js';
import { createSecretBindingRoutes } from '../secret-bindings.js';

const makeTempDir = trackTempDirs();

const binding = {
  id: 'github',
  name: 'GitHub',
  authRef: { env: 'TOKEN' },
  revision: 1,
  grants: [],
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
  availability: { backend: 'env' as const, available: true },
};

test('telemetry bind/unbind persists only exact instance destination authority through the existing operator route', async () => {
  const root = makeTempDir('station-telemetry-grant-route-');
  const service = new FileSecretBindingAdministration(root, {
    environment: { PRODUCT_KEY: 'private-product-material' },
  });
  const grant = {
    kind: 'instance-telemetry-destination',
    transport: 'product',
    destination: 'https://receiver.test/v1/product/events',
  };
  await service.create({
    id: 'product-source',
    name: 'Product source',
    authRef: { env: 'PRODUCT_KEY' },
  });
  const app = withOperatorPrincipal(createSecretBindingRoutes(service));
  const send = (path: string, data: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
  const unknown = await send('/product-source/bind', {
    ...grant,
    expectedRevision: 1,
    integrationId: 'impersonated-mcp',
  });
  expect(unknown.status).toBe(400);
  expect((await service.get('product-source'))?.revision).toBe(1);
  const accepted = await send('/product-source/bind', {
    ...grant,
    expectedRevision: 1,
  });
  expect(accepted.status).toBe(200);
  const view = await readJson<{ success: boolean; data: SecretBindingView }>(
    accepted,
  );
  expect(view.data.telemetryDestinationGrants).toEqual([grant]);
  expect(view.data.grants).toEqual([]);
  expect(JSON.stringify(view)).not.toContain('private-product-material');
  expect(
    (await send('/product-source/unbind', { ...grant, expectedRevision: 1 }))
      .status,
  ).toBe(409);
  expect(
    (await send('/product-source/unbind', { ...grant, expectedRevision: 2 }))
      .status,
  ).toBe(200);
  expect(
    (await service.get('product-source'))?.telemetryDestinationGrants,
  ).toBeUndefined();
  expect(
    await readFile(join(root, 'security', 'secret-bindings.json'), 'utf8'),
  ).not.toContain('private-product-material');
});
test('secret binding routes pass service results through and map a missing binding to 404', async () => {
  // The route does no projection; the metadata-only shape is the service's.
  const revoked = { ...binding, revokedAt: binding.updatedAt };
  let revokeInput: unknown;
  const app = createSecretBindingRoutes({
    list: async () => [binding],
    get: async (id) => (id === 'github' ? binding : null),
    create: async () => binding,
    replace: async () => binding,
    grant: async () => binding,
    ungrant: async () => binding,
    revoke: async (input) => {
      revokeInput = input;
      return revoked;
    },
  });
  expect(await (await app.request('/')).json()).toEqual({
    success: true,
    data: [binding],
  });
  expect((await app.request('/missing')).status).toBe(404);
  const response = await app.request('/github/revoke', {
    method: 'POST',
    body: JSON.stringify({ expectedRevision: 1 }),
    headers: { 'content-type': 'application/json' },
  });
  expect(response.status).toBe(200);
  expect(revokeInput).toEqual({ id: 'github', expectedRevision: 1 });
  expect(await response.json()).toEqual({ success: true, data: revoked });
});

test('typed conflicts retain their stable public response without leaking a hostile Error message', async () => {
  const conflict = new SecretBindingConflictError();
  Object.defineProperty(conflict, 'message', {
    value: 'token=internal-secret /private/station/secrets.json',
  });
  const app = createSecretBindingRoutes({
    list: async () => [binding],
    get: async () => binding,
    create: async () => binding,
    replace: async () => {
      throw conflict;
    },
    grant: async () => binding,
    ungrant: async () => binding,
    revoke: async () => ({ ...binding, revokedAt: binding.updatedAt }),
  });

  const response = await app.request('/github', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 1 }),
  });

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual({
    success: false,
    error: 'The secret binding changed before this operation could commit.',
  });
});

test('bind/unbind are structured consumer operations and surface a non-atomic safe partial', async () => {
  let migrationInput: unknown;
  // Attaching a value to a command's environment takes the operator in
  // person (or coding:exec); a request no auth boundary saw is refused.
  const app = withOperatorPrincipal(
    createSecretBindingRoutes(
      {
        list: async () => [binding],
        get: async () => binding,
        create: async () => binding,
        replace: async () => binding,
        grant: async () => binding,
        ungrant: async () => binding,
        revoke: async () => binding,
      },
      {
        getIntegrationBindings: async ({ integrationId }) => ({
          integrationId,
          secretEnvBindingIds: { TOKEN: 'github-token' },
        }),
        bind: async () => ({
          outcome: 'safe-partial' as const,
          binding,
          integrationId: 'github',
          envName: 'TOKEN',
          configurationError: 'retry',
        }),
        unbind: async () => ({
          outcome: 'complete' as const,
          binding,
          integrationId: 'github',
          envName: 'TOKEN',
        }),
      },
      {
        migrateStoredEnv: async (input) => {
          migrationInput = input;
          return { outcome: 'migrated' as const, migratedEnvNames: ['TOKEN'] };
        },
      },
    ),
  );
  const response = await app.request('/github/bind', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      integrationId: 'github',
      envName: 'TOKEN',
      expectedRevision: 1,
    }),
  });
  expect(response.status).toBe(202);
  const bindBody = (await response.json()) as { data: unknown };
  expect(bindBody.data).toMatchObject({
    outcome: 'safe-partial',
  });
  const migration = await app.request(
    '/integrations/github/migrate-stored-env',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bindings: { TOKEN: { bindingId: 'github', expectedRevision: 1 } },
      }),
    },
  );
  expect(migration.status).toBe(200);
  const migrationBody = (await migration.json()) as { data: unknown };
  expect(migrationBody.data).toEqual({
    outcome: 'migrated',
    migratedEnvNames: ['TOKEN'],
  });
  expect(migrationInput).toEqual({
    integrationId: 'github',
    bindings: { TOKEN: { bindingId: 'github', expectedRevision: 1 } },
  });
  expect(await (await app.request('/integrations/github')).json()).toEqual({
    success: true,
    data: {
      integrationId: 'github',
      secretEnvBindingIds: { TOKEN: 'github-token' },
    },
  });
  // The unqualified segment was previously ambiguous; retain it only as a
  // compatible route while callers use the integration-qualified endpoint.
  expect(
    (
      await app.request('/github/migrate-stored-env', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bindings: {} }),
      })
    ).status,
  ).toBe(200);
  expect((await app.request('/github/grants', { method: 'POST' })).status).toBe(
    404,
  );
});

test('management integration binding projection keeps an explicit empty map', async () => {
  const app = createSecretBindingRoutes(
    {
      list: async () => [binding],
      get: async () => binding,
      create: async () => binding,
      replace: async () => binding,
      grant: async () => binding,
      ungrant: async () => binding,
      revoke: async () => binding,
    },
    {
      getIntegrationBindings: async ({ integrationId }) => ({
        integrationId,
        secretEnvBindingIds: {},
      }),
      bind: async () => ({
        outcome: 'complete' as const,
        binding,
        integrationId: 'github',
        envName: 'TOKEN',
      }),
      unbind: async () => ({
        outcome: 'complete' as const,
        binding,
        integrationId: 'github',
        envName: 'TOKEN',
      }),
    },
  );
  expect(await (await app.request('/integrations/unbound')).json()).toEqual({
    success: true,
    data: { integrationId: 'unbound', secretEnvBindingIds: {} },
  });
});
