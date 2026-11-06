/**
 * #4521 round 2 (verifier finding): under `limits.registries.allowedUrls`, a
 * plugin installed from a registry the policy now refuses must not have its
 * git origin (that registry's package host) fetched by the update check.
 *
 * The transport is real: each installed plugin is a clone of a local bare
 * repository over the file protocol, and its `remote.origin.uploadpack` is a
 * wrapper that logs one line per real `git-upload-pack` run (one per fetch
 * that reaches the remote) before handing over to git. Nothing stubs `git`
 * or `fetch`. A plugin installed from a Git URL (no registry provenance)
 * stays checked under the same policy, as documented.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { clearAll } from '../../../providers/registries/registry.js';
import { writeRegistryInstallAliases } from '../../../providers/registries/registry-install-aliases.js';
import { installManagedCapabilityLimits } from '../../../security/managed-capability-limits.js';
import { checkPluginUpdates } from '../plugin-update-check.js';

const tempDir = trackTempDirs();
const logger = { debug: vi.fn() };
const REFUSED_REGISTRY = 'https://registry-b.example/registry.json';

afterEach(() => {
  installManagedCapabilityLimits(null);
  clearAll();
});

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Station Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Station Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

/**
 * A home with two installed plugins, each a clone of its own bare upstream
 * that is one commit ahead: `b-pkg` recorded as installed from registry B,
 * `git-pkg` installed from a Git URL.
 */
function installedPlugins() {
  const home = tempDir('update-provenance-home-');
  const upstreams = tempDir('update-provenance-upstream-');
  const log = join(upstreams, 'upload-pack.log');
  const wrapper = join(upstreams, 'logging-upload-pack.sh');
  writeFileSync(
    wrapper,
    `#!/bin/sh\necho "$@" >> '${log}'\nexec git-upload-pack "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  for (const name of ['b-pkg', 'git-pkg']) {
    const work = join(upstreams, `${name}-work`);
    const bare = join(upstreams, `${name}.git`);
    git(upstreams, 'init', '--quiet', '-b', 'main', work);
    writeFileSync(
      join(work, 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0' }),
    );
    git(work, 'add', 'plugin.json');
    git(work, 'commit', '--quiet', '-m', 'v1');
    git(upstreams, 'clone', '--quiet', '--bare', work, bare);
    const installed = join(home, 'plugins', name);
    git(upstreams, 'clone', '--quiet', `file://${bare}`, installed);
    git(installed, 'config', 'remote.origin.uploadpack', wrapper);
    // The upstream moves ahead, so a fetch that runs finds an update.
    git(work, 'commit', '--quiet', '--allow-empty', '-m', 'v2');
    git(work, 'push', '--quiet', bare, 'main');
  }
  writeRegistryInstallAliases(home, {
    'b-pkg': { pluginName: 'b-pkg', registryKey: REFUSED_REGISTRY },
  });
  const fetchedRepositories = () =>
    existsSync(log)
      ? readFileSync(log, 'utf-8')
          .trim()
          .split('\n')
          .map((line) => (line.includes('b-pkg.git') ? 'b-pkg' : 'git-pkg'))
          .sort()
      : [];
  return { home, fetchedRepositories };
}

function allowOnly(allowedUrls: string[]) {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    limits: { registries: { allowedUrls } },
  });
  if (!parsed.ok) throw new Error('fixture policy refused');
  installManagedCapabilityLimits({
    summary: summarizeManagedPolicy(parsed.document),
  });
}

describe.skipIf(process.platform === 'win32')(
  'update checks and recorded registry provenance',
  () => {
    test('control: without a policy both git origins are fetched and both updates found', async () => {
      const { home, fetchedRepositories } = installedPlugins();
      const result = await checkPluginUpdates({
        pluginsDir: join(home, 'plugins'),
        logger,
      });
      expect(fetchedRepositories()).toEqual(['b-pkg', 'git-pkg']);
      expect(result.updates.map((update) => update.name).sort()).toEqual([
        'b-pkg',
        'git-pkg',
      ]);
      expect(result.managedByPolicy).toBeUndefined();
    });

    test('a refused registry provenance gets no git transport; a Git URL install is still checked', async () => {
      const { home, fetchedRepositories } = installedPlugins();
      allowOnly(['https://registry-a.example/registry.json']);
      const result = await checkPluginUpdates({
        pluginsDir: join(home, 'plugins'),
        logger,
      });
      expect(fetchedRepositories()).toEqual(['git-pkg']);
      expect(result.updates.map((update) => update.name)).toEqual(['git-pkg']);
      expect(result.managedByPolicy).toEqual([
        {
          name: 'b-pkg',
          message: expect.stringContaining(
            "Acme's policy manages updates for plugins from this marketplace",
          ),
        },
      ]);
    });

    test('a listed registry provenance is still checked', async () => {
      const { home, fetchedRepositories } = installedPlugins();
      allowOnly([REFUSED_REGISTRY]);
      await checkPluginUpdates({ pluginsDir: join(home, 'plugins'), logger });
      expect(fetchedRepositories()).toEqual(['b-pkg', 'git-pkg']);
    });
  },
);
