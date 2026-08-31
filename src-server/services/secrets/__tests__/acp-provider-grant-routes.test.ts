import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  secretBindingOperations: { add: vi.fn() },
}));
vi.mock(
  '@kontourai/station-shared/lifecycle-events',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/lifecycle-events')
      >();
    return {
      ...actual,
      acquireFileMutationLockAsync: (
        path: string,
        options: import('@kontourai/station-shared/lifecycle-events').FileMutationLockOptions = {},
      ) =>
        actual.acquireFileMutationLockAsync(path, {
          ...options,
          birthFingerprint:
            options.birthFingerprint ?? ((pid) => `acp-grant-test:${pid}`),
        }),
    };
  },
);

import { createSecretBindingRoutes } from '../../../routes/secret-bindings.js';
import { FileSecretBindingAdministration } from '../secret-binding-administration.js';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

describe('ACP provider grant administration (#944)', () => {
  test('creates and individually removes an ACP header grant through the production HTTP surface', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-acp-provider-grant-'));
    homes.push(home);
    const service = new FileSecretBindingAdministration(home, {
      environment: { OPENROUTER_KEY: 'Bearer test-key' },
    });
    await service.create({
      id: 'openrouter-key',
      name: 'OpenRouter key',
      authRef: { env: 'OPENROUTER_KEY' },
    });
    const app = createSecretBindingRoutes(service);
    const grant = {
      kind: 'acp-provider-header',
      connectionId: 'opencode',
      providerId: 'main',
      headerName: 'Authorization',
    } as const;

    const bound = await app.request('/openrouter-key/bind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...grant, expectedRevision: 1 }),
    });
    expect(bound.status).toBe(200);
    await expect(
      service.resolveForAcpProvider({
        connectionId: 'opencode',
        providerId: 'main',
        secretHeaderRefs: { Authorization: 'openrouter-key' },
      }),
    ).resolves.toMatchObject({
      environment: { Authorization: 'Bearer test-key' },
    });

    const unbound = await app.request('/openrouter-key/unbind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...grant, expectedRevision: 2 }),
    });
    expect(unbound.status).toBe(200);
    await expect(
      service.resolveForAcpProvider({
        connectionId: 'opencode',
        providerId: 'main',
        secretHeaderRefs: { Authorization: 'openrouter-key' },
      }),
    ).rejects.toMatchObject({ reason: 'grant_missing' });
    const retained = await service.get('openrouter-key');
    expect(retained).toMatchObject({ revision: 3 });
    expect(retained).not.toHaveProperty('revokedAt');
  });
});
