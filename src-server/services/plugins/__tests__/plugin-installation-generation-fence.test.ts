import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  pluginProviderSourceGeneration,
  replacePluginProvidersForSourceGeneration,
  retirePluginProvidersForSourceGeneration,
} from '../../../providers/registries/registry.js';
import {
  computePluginContentDigest,
  withPluginContentLock,
} from '../plugin-content-integrity.js';
import {
  publishGrantedPluginProviderGeneration,
  withPluginInstallationGeneration,
} from '../plugin-installation-generation-fence.js';
import {
  getPluginGrants,
  grantPermissions,
  rebindGrantsAfterContentChange,
  restorePluginGrantEntry,
  revokeGrants,
  withPluginProviderGrantPublication,
} from '../plugin-permissions.js';

const cleanup: string[] = [];

function grantFixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), 'station-plugin-publication-grant-'));
  cleanup.push(root);
  mkdirSync(join(root, 'plugins', name), { recursive: true });
  writeFileSync(
    join(root, 'plugins', name, 'plugin.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
    }),
  );
  return root;
}

test.each(['revoke', 'rebind', 'reconsent'] as const)(
  'refuses prepared publication after durable %s without a newer reconciliation call',
  async (mutation) => {
    const name = `durable-${mutation}-gap`;
    const root = grantFixture(name);
    await grantPermissions(root, name, ['providers.register']);
    const generation = pluginProviderSourceGeneration(name);
    let finishPreparation!: () => void;
    const prepared = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    const stopAll = vi.fn(async () => undefined);
    let started!: () => void;
    const starting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const activation = withPluginInstallationGeneration({
      pluginsDir: join(root, 'plugins'),
      pluginName: name,
      expected: {
        installed: true,
        installationGeneration: computePluginContentDigest(
          join(root, 'plugins'),
          name,
        ),
      },
      effect: async () => {
        started();
        await prepared;
        return publishGrantedPluginProviderGeneration({
          projectHomeDir: root,
          pluginName: name,
          expectedProviderGeneration: generation,
          prepared: [
            {
              type: 'providerAdapter',
              source: name,
              provider: { provider: 'probe', stopAll },
            },
          ],
          isCurrent: () => true, // No newer reconciliation generation has run.
        });
      },
    });
    await starting;
    if (mutation === 'revoke') {
      await revokeGrants(root, name, ['providers.register']);
    } else if (mutation === 'rebind') {
      await rebindGrantsAfterContentChange(root, name, {});
    } else {
      await restorePluginGrantEntry(root, name, {
        permissions: ['providers.register'],
        contentDigest: 'sha256:prior-content',
      });
      const outcome = await grantPermissions(root, name, ['ui.confirm']);
      expect(outcome.withdrawn).toContain('providers.register');
    }
    expect(getPluginGrants(root, name)).not.toContain('providers.register');
    finishPreparation();
    await expect(activation).resolves.toEqual({
      kind: 'applied',
      value: 'superseded',
    });
    expect(stopAll).toHaveBeenCalledOnce();
    expect(pluginProviderSourceGeneration(name)).toBe(generation);
  },
);

test('serializes durable revocation behind the exact publication lease', async () => {
  const name = 'publication-lease';
  const root = grantFixture(name);
  await grantPermissions(root, name, ['providers.register']);
  let finishPublication!: () => void;
  let entered!: () => void;
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finishPublication = resolve;
  });
  const generation = pluginProviderSourceGeneration(name);
  const publishing = withPluginProviderGrantPublication(
    root,
    name,
    async () => {
      entered();
      await gate;
      return replacePluginProvidersForSourceGeneration(
        name,
        generation,
        [{ type: 'settings', source: name, provider: {} }],
        () => true,
      );
    },
  );
  await entry;
  let revoked = false;
  const revoking = revokeGrants(root, name, ['providers.register']).then(() => {
    revoked = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(revoked).toBe(false);
    expect(getPluginGrants(root, name)).toContain('providers.register');
  } finally {
    finishPublication();
    await publishing;
    await revoking;
    await retirePluginProvidersForSourceGeneration(
      name,
      pluginProviderSourceGeneration(name),
    );
  }
  expect(getPluginGrants(root, name)).toEqual([]);
});

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

test('holds exact installed content through activation and refuses that generation after update', async () => {
  const root = mkdtempSync(join(tmpdir(), 'station-plugin-generation-fence-'));
  cleanup.push(root);
  const pluginsDir = join(root, 'plugins');
  const pluginName = 'provider-plugin';
  const pluginDir = join(pluginsDir, pluginName);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.json'), '{"name":"provider-plugin"}');
  writeFileSync(join(pluginDir, 'provider.mjs'), 'export const version = 1;');
  const generation = computePluginContentDigest(pluginsDir, pluginName);
  let releaseActivation!: () => void;
  const activationGate = new Promise<void>((resolve) => {
    releaseActivation = resolve;
  });
  const order: string[] = [];
  const activating = withPluginInstallationGeneration({
    pluginsDir,
    pluginName,
    expected: { installed: true, installationGeneration: generation },
    effect: async () => {
      order.push('activation-start');
      await activationGate;
      order.push('activation-end');
    },
  });
  await vi.waitFor(() => expect(order).toEqual(['activation-start']));
  const updating = withPluginContentLock(pluginsDir, pluginName, async () => {
    order.push('update');
    writeFileSync(join(pluginDir, 'provider.mjs'), 'export const version = 2;');
  });
  await Promise.resolve();
  expect(order).toEqual(['activation-start']);

  releaseActivation();
  await expect(activating).resolves.toMatchObject({ kind: 'applied' });
  await updating;
  expect(order).toEqual(['activation-start', 'activation-end', 'update']);

  const staleEffect = vi.fn(async () => undefined);
  await expect(
    withPluginInstallationGeneration({
      pluginsDir,
      pluginName,
      expected: { installed: true, installationGeneration: generation },
      effect: staleEffect,
    }),
  ).resolves.toEqual({ kind: 'superseded' });
  expect(staleEffect).not.toHaveBeenCalled();
});
