import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { derivePluginConsentBasis } from '../../../services/plugins/plugin-install-consent.js';
import { readPluginManifestFile } from '../../../services/plugins/plugin-manifest-loader.js';
import {
  getPluginGrants,
  readPluginGrantRevision,
  revokeGrants,
} from '../../../services/plugins/plugin-permissions.js';
import { installPluginFromSource } from '../plugin-install-shared.js';
import { fetchPluginSource } from '../plugin-source.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-install-grant-race-'));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  mkdirSync(join(root, 'plugins'));
  writeFileSync(
    join(source, 'plugin.json'),
    JSON.stringify({
      name: 'grant-race',
      version: '1.0.0',
      permissions: ['agents.invoke'],
    }),
  );
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
  const deps = {
    agentsDir: join(root, 'agents'),
    pluginsDir: join(root, 'plugins'),
    projectHomeDir: root,
    buildPlugin: vi.fn().mockResolvedValue(undefined),
    logger,
  };
  const staged = await fetchPluginSource(source, deps.pluginsDir, logger);
  if ('error' in staged) throw new Error(staged.error);
  const basis = derivePluginConsentBasis(
    staged.tempDir,
    await readPluginManifestFile(join(staged.tempDir, 'plugin.json')),
  )!;
  rmSync(staged.tempDir, { recursive: true, force: true });
  const consent = {
    kind: 'operator-decision' as const,
    permissions: basis.required,
    contentDigest: basis.contentDigest,
    dependencies: basis.dependencies,
    grantRevision: readPluginGrantRevision(root, 'grant-race'),
  };
  expect(basis.required).toContain('agents.invoke');
  return { root, source, deps, consent };
}
test('installer refuses a permission decision superseded during build and retains the revocation', async () => {
  const f = await fixture();
  f.deps.buildPlugin.mockImplementation(async () => {
    await revokeGrants(f.root, 'grant-race', ['agents.invoke']);
  });
  await expect(
    installPluginFromSource(f.source, undefined, f.deps, {
      consent: f.consent,
    }),
  ).rejects.toThrow('permissions changed');
  expect(getPluginGrants(f.root, 'grant-race')).not.toContain('agents.invoke');
});
test.each([false, true])(
  'an activation-time revoke survives installer completion (failure=%s)',
  async (fail) => {
    const f = await fixture();
    let reconciliations = 0;
    const run = installPluginFromSource(
      f.source,
      undefined,
      {
        ...f.deps,
        reconcileEngineConnections: async () => {
          if (++reconciliations > 1) return;
          expect(getPluginGrants(f.root, 'grant-race')).toContain(
            'agents.invoke',
          );
          await revokeGrants(f.root, 'grant-race', ['agents.invoke']);
          if (fail) throw new Error('activation failed after revoke');
        },
      },
      { consent: f.consent },
    );
    if (fail)
      await expect(run).rejects.toThrow('activation failed after revoke');
    else expect((await run).success).toBe(true);
    expect(getPluginGrants(f.root, 'grant-race')).not.toContain(
      'agents.invoke',
    );
  },
);
