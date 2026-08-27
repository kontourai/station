import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecretRunner } from '@kontourai/station-contracts/datum-secret-reference';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConfigLoader } from '../../../domain/config-loader.js';

const { secretBindingOperations } = vi.hoisted(() => ({
  secretBindingOperations: { add: vi.fn() },
}));

vi.mock('../../../telemetry/metrics.js', () => ({ secretBindingOperations }));

import {
  FileSecretBindingAdministration,
  SecretBindingConflictError,
  SecretBindingIntegrationService,
  SecretBindingResolutionError,
} from '../secret-binding-administration.js';

const homes: string[] = [];
const runner: SecretRunner = {
  keychainAvailable: () => true,
  opAvailable: () => true,
  readKeychain: () => 'keychain-value',
  readOp: () => 'op-value',
};

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'station-secret-bindings-'));
  homes.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('SecretBindingIntegrationService', () => {
  test('converges bind and unbind retries after an interrupted second half', async () => {
    const root = await home();
    const bindings = new FileSecretBindingAdministration(root, {
      environment: { TOKEN: 'value' },
      secretRunner: runner,
    });
    await bindings.create({
      id: 'token',
      name: 'Token',
      authRef: { env: 'TOKEN' },
    });
    let def: any = {
      id: 'github',
      kind: 'mcp',
      transport: 'stdio',
      env: { TOKEN: '' },
    };
    let failConfig = true;
    const audit = vi.fn();
    const config = {
      isBuiltinIntegration: () => false,
      loadIntegration: async () => def,
      updateIntegration: async (_id: string, update: (current: any) => any) => {
        if (failConfig) {
          failConfig = false;
          throw new Error('interrupted config write');
        }
        def = update(def);
        return def;
      },
    } as any;
    const service = new SecretBindingIntegrationService(bindings, config, {
      info: audit,
    });
    const partial = await service.bind({
      id: 'token',
      integrationId: 'github',
      envName: 'TOKEN',
      expectedRevision: 1,
    });
    expect(partial.outcome).toBe('safe-partial');
    expect(partial.binding.revision).toBe(2);
    const bound = await service.bind({
      id: 'token',
      integrationId: 'github',
      envName: 'TOKEN',
      expectedRevision: 2,
    });
    expect(bound.outcome).toBe('complete');
    expect(bound.binding.revision).toBe(2);
    expect(def.secretEnvRefs).toEqual({ TOKEN: 'token' });

    failConfig = false;
    let failUngrant = true;
    const originalUngrant = bindings.ungrant.bind(bindings);
    bindings.ungrant = async (input) => {
      if (failUngrant) {
        failUngrant = false;
        throw new Error('interrupted grant write');
      }
      return originalUngrant(input);
    };
    const unbindPartial = await service.unbind({
      id: 'token',
      integrationId: 'github',
      envName: 'TOKEN',
      expectedRevision: 2,
    });
    expect(unbindPartial.outcome).toBe('safe-partial');
    expect(def.secretEnvRefs).toBeUndefined();
    const unbound = await service.unbind({
      id: 'token',
      integrationId: 'github',
      envName: 'TOKEN',
      expectedRevision: 2,
    });
    expect(unbound.outcome).toBe('complete');
    expect(unbound.binding.grants).toEqual([]);
    expect(audit.mock.calls).toEqual(
      expect.arrayContaining([
        [
          'Secret binding audit',
          expect.objectContaining({
            operation: 'bind',
            outcome: 'safe-partial',
            reason: 'configuration_update_failed',
          }),
        ],
        [
          'Secret binding audit',
          expect.objectContaining({
            operation: 'unbind',
            outcome: 'safe-partial',
            reason: 'grant_update_failed',
          }),
        ],
      ]),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain('value');
  });

  test('rejects a different binding before it changes either side', async () => {
    const root = await home();
    const bindings = new FileSecretBindingAdministration(root, {
      environment: { TOKEN: 'value' },
    });
    await bindings.create({
      id: 'one',
      name: 'One',
      authRef: { env: 'TOKEN' },
    });
    await bindings.create({
      id: 'two',
      name: 'Two',
      authRef: { env: 'TOKEN' },
    });
    const def: any = {
      id: 'github',
      kind: 'mcp',
      transport: 'stdio',
      env: { TOKEN: '' },
      secretEnvRefs: { TOKEN: 'one' },
    };
    const service = new SecretBindingIntegrationService(bindings, {
      isBuiltinIntegration: () => false,
      loadIntegration: async () => def,
      updateIntegration: async () => def,
    } as any);
    await expect(
      service.bind({
        id: 'two',
        integrationId: 'github',
        envName: 'TOKEN',
        expectedRevision: 1,
      }),
    ).rejects.toThrow('different secret binding');
    expect((await bindings.get('two'))?.grants).toEqual([]);
  });

  test('converges bind and unbind through a real ConfigLoader persistence boundary', async () => {
    const root = await home();
    const loader = new ConfigLoader({ projectHomeDir: root });
    await loader.saveIntegration('github', {
      id: 'github',
      kind: 'mcp',
      transport: 'stdio',
      command: 'github-mcp',
      env: { TOKEN: 'declared' },
    });
    const bindings = new FileSecretBindingAdministration(root, {
      environment: { TOKEN: 'value' },
      secretRunner: runner,
    });
    const created = await bindings.create({
      id: 'github-token',
      name: 'GitHub token',
      authRef: { env: 'TOKEN' },
    });
    const service = new SecretBindingIntegrationService(bindings, loader);

    const bound = await service.bind({
      id: created.id,
      integrationId: 'github',
      envName: 'TOKEN',
      expectedRevision: created.revision,
    });
    expect(bound.outcome).toBe('complete');
    expect((await loader.loadIntegration('github')).secretEnvRefs).toEqual({
      TOKEN: 'github-token',
    });

    const unbound = await service.unbind({
      id: created.id,
      integrationId: 'github',
      envName: 'TOKEN',
      expectedRevision: bound.binding.revision,
    });
    expect(unbound.outcome).toBe('complete');
    expect(
      (await loader.loadIntegration('github')).secretEnvRefs,
    ).toBeUndefined();
    expect((await bindings.get(created.id))?.grants).toEqual([]);
    expect(
      JSON.parse(
        await readFile(
          join(root, 'integrations', 'github', 'integration.json'),
          'utf8',
        ),
      ),
    ).not.toHaveProperty('secretEnvRefs');
  });

  test('revocation keeps historical grants while config-first unbind allows a replacement binding', async () => {
    const root = await home();
    const loader = new ConfigLoader({ projectHomeDir: root });
    await loader.saveIntegration('github', {
      id: 'github',
      kind: 'mcp',
      transport: 'stdio',
      command: 'github-mcp',
      env: { TOKEN: 'declared' },
    });
    const bindings = new FileSecretBindingAdministration(root, {
      environment: { TOKEN: 'value' },
      secretRunner: runner,
    });
    const old = await bindings.create({
      id: 'old-token',
      name: 'Old token',
      authRef: { env: 'TOKEN' },
    });
    const replacement = await bindings.create({
      id: 'new-token',
      name: 'New token',
      authRef: { env: 'TOKEN' },
    });
    const consumers = new SecretBindingIntegrationService(bindings, loader);
    const bound = await consumers.bind({
      id: old.id,
      integrationId: 'github',
      envName: 'TOKEN',
      expectedRevision: old.revision,
    });
    const revoked = await bindings.revoke({
      id: old.id,
      expectedRevision: bound.binding.revision,
    });

    await expect(
      consumers.unbind({
        id: old.id,
        integrationId: 'github',
        envName: 'TOKEN',
        expectedRevision: revoked.revision,
      }),
    ).resolves.toMatchObject({
      outcome: 'complete',
      binding: { revokedAt: expect.any(String) },
    });
    expect((await bindings.get(old.id))?.grants).toHaveLength(1);
    await expect(
      consumers.bind({
        id: replacement.id,
        integrationId: 'github',
        envName: 'TOKEN',
        expectedRevision: replacement.revision,
      }),
    ).resolves.toMatchObject({ outcome: 'complete' });
    expect((await loader.loadIntegration('github')).secretEnvRefs).toEqual({
      TOKEN: replacement.id,
    });
  });
});

describe('FileSecretBindingAdministration', () => {
  test('persists parsed metadata only, applies CAS revisions, and resolves once per establishment', async () => {
    const root = await home();
    let reads = 0;
    const service = new FileSecretBindingAdministration(root, {
      now: () => new Date('2026-08-24T00:00:00.000Z'),
      environment: { TOKEN: 'env-value' },
      secretRunner: {
        ...runner,
        readKeychain: () => {
          reads += 1;
          return 'keychain-value';
        },
      },
    });
    const created = await service.create({
      id: 'github-token',
      name: 'GitHub',
      authRef: { keychain: { service: 'github' } },
    });
    expect(created.revision).toBe(1);
    expect(created.availability).toEqual({
      backend: 'keychain',
      available: true,
    });
    expect(
      JSON.parse(
        await (await import('node:fs/promises')).readFile(
          join(root, 'security', 'secret-bindings.json'),
          'utf8',
        ),
      ),
    ).toEqual(expect.objectContaining({ schemaVersion: 1 }));
    await expect(
      service.grant({
        id: created.id,
        expectedRevision: 1,
        grant: {
          kind: 'mcp-integration-env',
          integrationId: 'github',
          envName: 'TOKEN',
        },
      }),
    ).resolves.toMatchObject({ revision: 2 });
    await expect(
      service.grant({
        id: created.id,
        expectedRevision: 1,
        grant: {
          kind: 'mcp-integration-env',
          integrationId: 'github',
          envName: 'OTHER',
        },
      }),
    ).rejects.toBeInstanceOf(SecretBindingConflictError);
    const resolution = await service.resolveForIntegration({
      integrationId: 'github',
      secretEnvRefs: { TOKEN: 'github-token' },
    });
    expect(resolution.environment).toEqual({ TOKEN: 'keychain-value' });
    expect(reads).toBe(1);
  });

  test('refuses revoked, ungranted, corrupt, and unsafe-link stores before materialization', async () => {
    const root = await home();
    const service = new FileSecretBindingAdministration(root, {
      secretRunner: runner,
      environment: { TOKEN: 'env-value' },
    });
    const created = await service.create({
      id: 'token',
      name: 'Token',
      authRef: { env: 'TOKEN' },
    });
    await expect(
      service.resolveForIntegration({
        integrationId: 'github',
        secretEnvRefs: { TOKEN: created.id },
      }),
    ).rejects.toMatchObject({
      reason: 'grant_missing',
    } satisfies Partial<SecretBindingResolutionError>);
    const granted = await service.grant({
      id: created.id,
      expectedRevision: 1,
      grant: {
        kind: 'mcp-integration-env',
        integrationId: 'github',
        envName: 'TOKEN',
      },
    });
    await service.revoke({
      id: created.id,
      expectedRevision: granted.revision,
    });
    await expect(
      service.resolveForIntegration({
        integrationId: 'github',
        secretEnvRefs: { TOKEN: created.id },
      }),
    ).rejects.toMatchObject({ reason: 'binding_revoked' });
    await writeFile(join(root, 'security', 'secret-bindings.json'), '{broken');
    await expect(service.list()).rejects.toThrow(
      'Secret binding store is invalid.',
    );

    const unsafe = await home();
    await writeFile(join(unsafe, 'target'), '{}');
    await symlink(join(unsafe, 'target'), join(unsafe, 'security'));
    await expect(
      new FileSecretBindingAdministration(unsafe).list(),
    ).rejects.toThrow('Unsafe secret binding directory.');
    await chmod(join(root, 'security'), 0o700);
  });

  test('rejects surplus store keys and reads only within the fixed byte cap', async () => {
    const root = await home();
    const service = new FileSecretBindingAdministration(root, {
      environment: { TOKEN: 'value' },
      secretRunner: runner,
    });
    await service.create({
      id: 'token',
      name: 'Token',
      authRef: { env: 'TOKEN' },
    });
    const store = join(root, 'security', 'secret-bindings.json');
    const validBinding = {
      id: 'token',
      name: 'Token',
      authRef: { env: 'TOKEN' },
      revision: 1,
      grants: [
        {
          kind: 'mcp-integration-env',
          integrationId: 'github',
          envName: 'TOKEN',
        },
      ],
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    };
    for (const document of [
      { schemaVersion: 1, bindings: { token: validBinding }, unexpected: true },
      {
        schemaVersion: 1,
        bindings: { token: { ...validBinding, unexpected: true } },
      },
      {
        schemaVersion: 1,
        bindings: {
          token: {
            ...validBinding,
            grants: [{ ...validBinding.grants[0], unexpected: true }],
          },
        },
      },
    ]) {
      await writeFile(store, JSON.stringify(document), { mode: 0o600 });
      await expect(service.list()).rejects.toThrow(
        'Secret binding store is invalid.',
      );
    }

    await writeFile(
      store,
      JSON.stringify({ schemaVersion: 1, bindings: { token: validBinding } }),
      { mode: 0o600 },
    );
    expect((await service.list())[0]?.grants).toEqual([
      {
        kind: 'mcp-integration-env',
        integrationId: 'github',
        envName: 'TOKEN',
      },
    ]);

    await writeFile(store, 'x'.repeat(256 * 1024 + 1), { mode: 0o600 });
    await expect(service.list()).rejects.toThrow(
      'Secret binding store exceeds the byte limit.',
    );
  });

  test('audits binding operations and establishment with metadata only', async () => {
    const root = await home();
    const info = vi.fn();
    const service = new FileSecretBindingAdministration(root, {
      environment: { TOKEN: 'materialized-secret-sentinel' },
      logger: { info },
    });
    const created = await service.create({
      id: 'github-token',
      name: 'GitHub',
      authRef: { env: 'TOKEN' },
    });
    const bound = await service.grant({
      id: created.id,
      expectedRevision: created.revision,
      grant: {
        kind: 'mcp-integration-env',
        integrationId: 'github',
        envName: 'TOKEN',
      },
    });
    const resolution = await service.resolveForIntegration({
      integrationId: 'github',
      secretEnvRefs: { TOKEN: created.id },
    });
    resolution.settlement.settle({
      outcome: 'failure',
      reason: 'child_establishment_failed',
    });
    resolution.settlement.settle({ outcome: 'success' });
    const replaced = await service.replace({
      id: created.id,
      name: 'GitHub replacement',
      authRef: { env: 'TOKEN' },
      expectedRevision: bound.revision,
    });
    const unbound = await service.ungrant({
      id: created.id,
      integrationId: 'github',
      envName: 'TOKEN',
      expectedRevision: replaced.revision,
    });
    const rebound = await service.grant({
      id: created.id,
      expectedRevision: unbound.revision,
      grant: {
        kind: 'mcp-integration-env',
        integrationId: 'github',
        envName: 'TOKEN',
      },
    });
    await service.revoke({
      id: created.id,
      expectedRevision: rebound.revision,
    });
    await expect(
      service.resolveForIntegration({
        integrationId: 'github',
        secretEnvRefs: { TOKEN: created.id },
      }),
    ).rejects.toMatchObject({ reason: 'binding_revoked' });

    const calls = JSON.stringify(info.mock.calls);
    expect(calls).toContain('create');
    expect(calls).toContain('replace');
    expect(calls).toContain('bind');
    expect(calls).toContain('unbind');
    expect(calls).toContain('revoke');
    expect(calls).toContain('materialize');
    expect(calls).toContain('resolve');
    expect(calls).toContain('establish');
    expect(calls).toContain('child_establishment_failed');
    expect(
      info.mock.calls.filter(
        ([, attributes]) => attributes?.operation === 'establish',
      ),
    ).toHaveLength(1);
    expect(info).toHaveBeenCalledWith(
      'Secret binding audit',
      expect.objectContaining({
        operation: 'establish',
        bindingId: created.id,
        integrationId: 'github',
        envName: 'TOKEN',
        revision: bound.revision,
        backend: 'env',
        outcome: 'failure',
        reason: 'child_establishment_failed',
      }),
    );
    expect(calls).toContain('auth-refusal');
    expect(calls).toContain('binding_revoked');
    expect(calls).not.toContain('materialized-secret-sentinel');
    expect(calls).not.toContain('"authRef"');
    const attributes = info.mock.calls.map(([, value]) => value);
    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'create',
          bindingId: 'github-token',
          revision: 1,
          backend: 'env',
          outcome: 'success',
        }),
        expect.objectContaining({
          operation: 'materialize',
          bindingId: 'github-token',
          integrationId: 'github',
          envName: 'TOKEN',
          revision: 2,
          backend: 'env',
        }),
        expect.objectContaining({
          operation: 'auth-refusal',
          integrationId: 'github',
          outcome: 'refused',
          reason: 'binding_revoked',
        }),
      ]),
    );
    expect(secretBindingOperations.add).toHaveBeenCalledWith(1, {
      operation: 'resolve',
      outcome: 'success',
    });
    expect(secretBindingOperations.add).toHaveBeenCalledWith(1, {
      operation: 'resolve',
      outcome: 'refused',
    });
    expect(secretBindingOperations.add).toHaveBeenCalledWith(1, {
      operation: 'establish',
      outcome: 'failure',
    });
  });
});
