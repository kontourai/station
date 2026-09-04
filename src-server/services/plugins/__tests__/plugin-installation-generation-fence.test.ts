import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  capturePluginProviderGeneration,
  publishPluginProviderGeneration,
} from '../../../providers/plugin-provider-loader.js';
import {
  getProvider,
  pluginProviderSourceGeneration,
  registerProvider,
  registerProviderAdapter,
  replacePluginProvidersForSource,
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

test('an empty whole reload cannot erase a source granted after its candidate snapshot', async () => {
  const name = 'new-grant-empty-reload';
  const root = grantFixture(name);
  const old = { retained: true };
  await replacePluginProvidersForSource(name, [
    { type: 'settings', source: name, provider: old },
  ]);
  const { basis } = await capturePluginProviderGeneration(
    root,
    () => undefined,
  );
  const generation = pluginProviderSourceGeneration(name);
  try {
    await grantPermissions(root, name, ['providers.register']);
    await expect(publishPluginProviderGeneration(basis, [])).rejects.toThrow(
      'grant snapshot was superseded',
    );
    expect(pluginProviderSourceGeneration(name)).toBe(generation);
    expect(getProvider('settings')).toBe(old);
  } finally {
    await replacePluginProvidersForSource(name, []);
  }
});

test('a full reload grant snapshot cannot be replayed for a different home', async () => {
  const root = grantFixture('first-home');
  const other = grantFixture('second-home');
  const { basis } = await capturePluginProviderGeneration(
    root,
    () => undefined,
  );
  await expect(
    publishPluginProviderGeneration({ ...basis, projectHomeDir: other }, []),
  ).rejects.toThrow('grant snapshot was superseded');
});

test('a missing whole-reload grant snapshot refuses and disposes staged adapters', async () => {
  const root = grantFixture('missing-basis');
  const { basis } = await capturePluginProviderGeneration(
    root,
    () => undefined,
  );
  const stopAll = vi.fn(async () => {});
  await expect(
    publishPluginProviderGeneration(
      { ...basis, grantSnapshot: undefined } as any,
      [
        {
          type: 'providerAdapter',
          source: 'missing-basis',
          provider: { provider: 'probe', stopAll },
        },
      ],
    ),
  ).rejects.toThrow('requires a captured grant snapshot');
  expect(stopAll).toHaveBeenCalledOnce();
});

test('a stale full reload cannot overwrite a newer provider publication', async () => {
  const name = 'full-reload-generation';
  const root = grantFixture(name);
  await grantPermissions(root, name, ['providers.register']);
  const { basis: expected } = await capturePluginProviderGeneration(
    root,
    () => undefined,
  );
  const newer = { current: true };
  await replacePluginProvidersForSource(name, [
    { type: 'settings', source: name, provider: newer },
  ]);
  const stopAll = vi.fn(async () => undefined);
  try {
    await expect(
      publishPluginProviderGeneration(expected, [
        {
          type: 'providerAdapter',
          source: name,
          provider: { provider: 'probe', stopAll },
        },
      ]),
    ).rejects.toThrow('superseded before publication');
    expect(getProvider('settings')).toBe(newer);
    expect(stopAll).toHaveBeenCalledOnce();
  } finally {
    await replacePluginProvidersForSource(name, []);
  }
});

test.each(['provider', 'adapter'] as const)(
  'direct plugin %s registration invalidates a prepared full reload',
  async (kind) => {
    const name = `direct-${kind}-generation`;
    const root = grantFixture(name);
    await grantPermissions(root, name, ['providers.register']);
    const { basis: expected } = await capturePluginProviderGeneration(
      root,
      () => undefined,
    );
    const expectedSource = pluginProviderSourceGeneration(name);
    if (kind === 'provider') {
      registerProvider('settings', {}, { plugin: true, source: name });
    } else {
      registerProviderAdapter({ provider: name } as never, { source: name });
    }
    expect(pluginProviderSourceGeneration(name)).toBe(expectedSource + 1);
    const stopAll = vi.fn(async () => undefined);
    try {
      await expect(
        publishPluginProviderGeneration(expected, [
          {
            type: 'providerAdapter',
            source: name,
            provider: { provider: 'stale', stopAll },
          },
        ]),
      ).rejects.toThrow('superseded before publication');
      expect(stopAll).toHaveBeenCalledOnce();
    } finally {
      await replacePluginProvidersForSource(name, []);
    }
  },
);

test('refusing one source does not dispose an adapter shared by an accepted source', async () => {
  const name = 'shared-accepted-generation';
  const root = grantFixture(name);
  await grantPermissions(root, name, ['providers.register']);
  const stopAll = vi.fn(async () => undefined);
  const provider = { provider: 'shared', stopAll };
  const { basis } = await capturePluginProviderGeneration(
    root,
    () => undefined,
  );
  try {
    const published = await publishPluginProviderGeneration(basis, [
      { type: 'providerAdapter', source: name, provider },
      { type: 'providerAdapter', source: 'ungranted', provider },
    ]);
    expect(published).toEqual([
      { type: 'providerAdapter', source: name, provider },
    ]);
    expect(stopAll).not.toHaveBeenCalled();
  } finally {
    await replacePluginProvidersForSource(name, []);
  }
});

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
