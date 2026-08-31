import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';

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
            options.birthFingerprint ?? ((pid) => `mcp-child-test:${pid}`),
        }),
    };
  },
);

import { MCPService } from '../../plugins/mcp-service.js';
import { FileSecretBindingAdministration } from '../secret-binding-administration.js';

const homes: string[] = [];
const fixture = fileURLToPath(
  new URL('./fixtures/secret-binding-mcp-child.mjs', import.meta.url),
);

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

describe('Datum secret binding stdio establishment', () => {
  test('a real fresh probe starts the child with a binding and exposes no material', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-binding-child-'));
    homes.push(home);
    const info = vi.fn();
    const admin = new FileSecretBindingAdministration(home, {
      environment: { BINDING_FIXTURE_TOKEN: 'fixture-sentinel' },
      logger: { info },
    });
    const created = await admin.create({
      id: 'fixture-token',
      name: 'Fixture token',
      authRef: { env: 'BINDING_FIXTURE_TOKEN' },
    });
    await admin.grant({
      id: created.id,
      expectedRevision: created.revision,
      grant: {
        kind: 'mcp-integration-env',
        integrationId: 'fixture',
        envName: 'BINDING_FIXTURE_TOKEN',
      },
    });
    const def: any = {
      id: 'fixture',
      kind: 'mcp',
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      secretEnvRefs: { BINDING_FIXTURE_TOKEN: created.id },
    };
    const saved: unknown[] = [];
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const service = new MCPService(
      {
        loadIntegration: vi.fn().mockResolvedValue(def),
        saveIntegration: vi.fn(async (_id, next) => saved.push(next)),
        getProjectHomeDir: () => home,
      } as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      logger,
      undefined,
      undefined,
      admin,
      admin,
    );

    const result = await service.probeIntegration('fixture');
    expect(result.probe).toMatchObject({
      ok: true,
      toolCount: 1,
      toolNames: ['fixture_binding_ready'],
    });
    await expect(
      service.callMCPUITool('fixture', 'binding_ready'),
    ).resolves.toMatchObject({ structuredContent: { configured: true } });
    const observed = JSON.stringify({
      saved,
      logs: [
        ...info.mock.calls,
        ...logger.info.mock.calls,
        ...logger.warn.mock.calls,
      ],
    });
    expect(observed).not.toContain('fixture-sentinel');
    expect(observed).not.toContain('authRef');
  });
});
