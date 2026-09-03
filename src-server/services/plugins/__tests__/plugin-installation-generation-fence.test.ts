import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  computePluginContentDigest,
  withPluginContentLock,
} from '../plugin-content-integrity.js';
import { withPluginInstallationGeneration } from '../plugin-installation-generation-fence.js';

const cleanup: string[] = [];

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
