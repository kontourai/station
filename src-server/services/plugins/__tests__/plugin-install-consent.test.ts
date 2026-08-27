import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  assertPluginInstallConsent,
  derivePluginConsentBasis,
  isPluginConsentRefusedError,
  type PluginConsentBasis,
  PluginConsentRefusedError,
} from '../plugin-install-consent.js';

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs
      .splice(0, cleanupDirs.length)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function stage(manifest: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'station-consent-basis-'));
  cleanupDirs.push(root);
  const staged = join(root, '.preview-demo');
  mkdirSync(staged, { recursive: true });
  writeFileSync(join(staged, 'plugin.json'), JSON.stringify(manifest));
  return staged;
}

function basisOf(stagedDir: string, manifest: any): PluginConsentBasis {
  const basis = derivePluginConsentBasis(stagedDir, manifest);
  if (!basis) throw new Error('expected a consent basis');
  return basis;
}

function refusalOf(run: () => void): PluginConsentRefusedError {
  try {
    run();
  } catch (error) {
    if (isPluginConsentRefusedError(error)) return error;
    throw error;
  }
  throw new Error('expected the consent check to refuse');
}

describe('derivePluginConsentBasis', () => {
  test('derives the permission set, its tiers and the dependency ids from a staged copy', () => {
    const manifest = {
      name: 'demo',
      version: '1.0.0',
      permissions: ['navigation.dock', 'network.fetch'],
      serverModule: './server.js',
      dependencies: [{ id: 'shared-lib' }, { id: 'shared-ui' }],
    };
    const basis = basisOf(stage(manifest), manifest);

    expect(basis.required).toEqual([
      'navigation.dock',
      'network.fetch',
      'plugin.server',
    ]);
    expect(basis.autoGranted).toEqual(['navigation.dock']);
    expect(basis.pendingConsent).toEqual([
      { permission: 'network.fetch', tier: 'active' },
      { permission: 'plugin.server', tier: 'trusted' },
    ]);
    expect(basis.dependencies).toEqual(['shared-lib', 'shared-ui']);
    expect(basis.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  /**
   * The second axis (station#4288, review HIGH 1). Every field here derives
   * NOTHING from `requiredPermissionsForManifest`, which is exactly why the
   * basis has to name them separately: a caller asking "was there anything to
   * disclose?" through the permission set alone gets `no` for a plugin that
   * loads a script into Station's own document.
   */
  test('names the contributions the permission derivation emits nothing for', () => {
    const manifest = {
      name: 'demo',
      version: '1.0.0',
      entrypoint: './dist/bundle.js',
      layout: { slug: 'demo', source: './layout.js' },
      workspacePanes: [{ id: 'demo.pane' }],
      agents: [{ slug: 'demo-agent', source: 'agent.json' }],
      dependencies: [{ id: 'shared-lib' }],
    };
    const basis = basisOf(stage(manifest), manifest);

    expect(basis.required).toEqual([]);
    expect(basis.pendingConsent).toEqual([]);
    expect(basis.undisclosedContributions).toEqual([
      'entrypoint',
      'layout',
      'workspacePanes',
      'agents',
      'dependencies',
    ]);
  });

  test('names nothing for a plugin whose whole contribution the derivation can express', () => {
    const manifest = {
      name: 'demo',
      version: '1.0.0',
      permissions: ['navigation.dock'],
      serverModule: './server.js',
      // Present but empty: a declaration of nothing is not a contribution.
      workspacePanes: [],
      agents: [],
    };
    expect(basisOf(stage(manifest), manifest).undisclosedContributions).toEqual(
      [],
    );
  });

  test('a file the manifest never mentions still changes the digest', () => {
    // The reason the decision binds a DIGEST rather than the manifest
    // projection: `entrypoint`, panes and layouts derive no permission, so a
    // manifest-shaped fingerprint would report two different plugins as
    // identical.
    const manifest = { name: 'demo', version: '1.0.0' };
    const first = stage(manifest);
    const second = stage(manifest);
    expect(basisOf(second, manifest).contentDigest).toBe(
      basisOf(first, manifest).contentDigest,
    );

    writeFileSync(join(second, 'bundle.js'), 'globalThis.x = 1;\n');
    expect(basisOf(second, manifest).contentDigest).not.toBe(
      basisOf(first, manifest).contentDigest,
    );
  });

  test('reports no basis when the staged tree cannot be read', () => {
    expect(
      derivePluginConsentBasis(join(tmpdir(), 'station-absent-staging'), {
        name: 'demo',
      } as any),
    ).toBeNull();
  });
});

describe('assertPluginInstallConsent', () => {
  const manifest = {
    name: 'demo',
    version: '1.0.0',
    permissions: ['navigation.dock', 'network.fetch'],
  };

  function approved(basis: PluginConsentBasis) {
    return {
      kind: 'operator-decision' as const,
      permissions: [...basis.required],
      contentDigest: basis.contentDigest,
      dependencies: [...basis.dependencies],
    };
  }

  test('accepts a decision that names exactly what the staged copy derives', () => {
    const basis = basisOf(stage(manifest), manifest);
    expect(() =>
      assertPluginInstallConsent({
        pluginName: 'demo',
        consent: approved(basis),
        basis,
      }),
    ).not.toThrow();
  });

  test('accepts an unordered, duplicated decision — it is a set, not a transcript', () => {
    const basis = basisOf(stage(manifest), manifest);
    expect(() =>
      assertPluginInstallConsent({
        pluginName: 'demo',
        consent: {
          ...approved(basis),
          permissions: ['network.fetch', 'navigation.dock', 'network.fetch'],
        },
        basis,
      }),
    ).not.toThrow();
  });

  /**
   * The check the digest cannot make. The bytes are proven and the answer is
   * still empty — which is what a client with a bug, or one assembling the
   * request itself, produces.
   */
  test('refuses a decision that proves the bytes but covers no permissions', () => {
    const basis = basisOf(stage(manifest), manifest);
    const refusal = refusalOf(() =>
      assertPluginInstallConsent({
        pluginName: 'demo',
        consent: { ...approved(basis), permissions: [] },
        basis,
      }),
    );
    expect(refusal.reason).toBe('permissions');
    expect(refusal.message).toContain('the approval covered none');
    expect(refusal.required).toEqual(['navigation.dock', 'network.fetch']);
  });

  /** The check the permission set cannot make. */
  test('refuses a decision whose permissions match while the bytes do not', () => {
    const basis = basisOf(stage(manifest), manifest);
    const refusal = refusalOf(() =>
      assertPluginInstallConsent({
        pluginName: 'demo',
        consent: { ...approved(basis), contentDigest: 'sha256:stale' },
        basis,
      }),
    );
    expect(refusal.reason).toBe('content');
    expect(refusal.message).toContain(
      'its files changed after it was reviewed',
    );
  });

  test('refuses an install that would also install a plugin the decision never named', () => {
    const withDependency = {
      ...manifest,
      dependencies: [{ id: 'shared-lib' }, { id: 'shared-ui' }],
    };
    const basis = basisOf(stage(withDependency), withDependency);
    const refusal = refusalOf(() =>
      assertPluginInstallConsent({
        pluginName: 'demo',
        consent: { ...approved(basis), dependencies: ['shared-lib'] },
        basis,
      }),
    );
    expect(refusal.reason).toBe('dependencies');
    expect(refusal.message).toContain('shared-ui');
    expect(refusal.message).not.toContain('shared-lib,');
  });

  test('a caller holding no decision may install a plugin whose whole contribution the derivation expresses', () => {
    const passiveOnly = {
      name: 'demo',
      version: '1.0.0',
      permissions: ['navigation.dock'],
    };
    const basis = basisOf(stage(passiveOnly), passiveOnly);
    expect(() =>
      assertPluginInstallConsent({
        pluginName: 'demo',
        consent: { kind: 'no-operator-decision', caller: 'the test' },
        basis,
      }),
    ).not.toThrow();
  });

  /**
   * station#4288, review HIGH 1 — the case the first version of this branch
   * installed on one click.
   *
   * This plugin derives NO permissions at all, so `pendingConsent` is empty
   * and a check that consults only that arm returns "nothing to disclose".
   * What it actually contributes is a `<script>` in the shell's own document
   * and a Pane rendered by it: browser-resident code with Station's origin
   * and Station's session, for which no grant is ever asked because no grant
   * expresses it. It is reachable by pointing Station at a remote registry
   * manifest and clicking one row.
   */
  test('a caller holding no decision is refused a plugin whose only contribution is browser code', () => {
    const browserResident = {
      name: 'demo',
      version: '1.0.0',
      entrypoint: './dist/bundle.js',
      workspacePanes: [{ id: 'demo.pane' }],
    };
    const basis = basisOf(stage(browserResident), browserResident);
    expect(basis.pendingConsent).toEqual([]);

    const refusal = refusalOf(() =>
      assertPluginInstallConsent({
        pluginName: 'demo',
        consent: {
          kind: 'no-operator-decision',
          caller: 'the plugin registry',
        },
        basis,
      }),
    );
    expect(refusal.reason).toBe('undisclosed-contributions');
    expect(refusal.message).toContain('entrypoint, workspacePanes');
    expect(refusal.message).toContain('the plugin registry');
  });

  test('the same plugin, with a decision that names its bytes, installs', () => {
    const browserResident = {
      name: 'demo',
      version: '1.0.0',
      entrypoint: './dist/bundle.js',
      workspacePanes: [{ id: 'demo.pane' }],
    };
    const basis = basisOf(stage(browserResident), browserResident);
    expect(() =>
      assertPluginInstallConsent({
        pluginName: 'demo',
        consent: approved(basis),
        basis,
      }),
    ).not.toThrow();
  });

  test('a caller holding no decision is refused the moment there is something to disclose', () => {
    const basis = basisOf(stage(manifest), manifest);
    const refusal = refusalOf(() =>
      assertPluginInstallConsent({
        pluginName: 'demo',
        consent: {
          kind: 'no-operator-decision',
          caller: 'the plugin registry',
        },
        basis,
      }),
    );
    expect(refusal.reason).toBe('undisclosed-permissions');
    expect(refusal.message).toContain('network.fetch');
    expect(refusal.message).toContain('the plugin registry');
  });
});
