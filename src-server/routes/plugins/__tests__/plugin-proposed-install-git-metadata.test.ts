/**
 * #2719: a local folder an install proposal names is staged without any git
 * metadata, in every spelling and at any depth, BEFORE the preview digests
 * it, so the approval and the install bind the same bytes. An operator's
 * own install of a folder no proposal names keeps its `.git`, which the
 * update route pulls through.
 *
 * Drives the real `POST /preview` and `POST /install` (real staging, real
 * consent check, real installer) over a real proposal store, then reads the
 * installed package back through `GET /` (git info) and the update scan.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { computePluginTreeDigest } from '@kontourai/station-shared/plugin-tree-digest';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { computePluginContentDigest } from '../../../services/plugins/plugin-content-integrity.js';
import { PluginLifecycleProposalService } from '../../../services/plugins/plugin-lifecycle-proposals.js';
import { checkPluginUpdates } from '../../../services/plugins/plugin-update-check.js';
import { execGitSync } from '../../../utils/git-exec.js';
import { isGitMetadataName } from '../../../utils/git-metadata-name.js';
import { registerPluginInstallRoutes } from '../plugin-install-routes.js';

const tempDir = trackTempDirs();

function logger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as any;
}

function git(cwd: string, ...args: string[]) {
  execGitSync(
    [
      '-c',
      'user.name=Station Test',
      '-c',
      'user.email=station@example.test',
      ...args,
    ],
    { cwd, stdio: 'ignore', hardening: { allowFileProtocol: true } },
  );
}

function commitManifest(dir: string, version: string) {
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({ name: 'checkout-plugin', version }),
  );
  git(dir, 'add', 'plugin.json');
  git(dir, 'commit', '-q', '-m', `v${version}`);
}

/**
 * A checkout of `upstream` at `<root>/source`, with `upstream` then moved
 * one commit ahead, so a kept `.git` has both git info and an update to
 * report. `gitfile` puts the checkout's repository elsewhere and leaves a
 * `.git` gitfile pointing at it in the folder.
 */
function checkout(root: string, options: { gitfile: boolean }) {
  const upstream = join(root, 'upstream');
  mkdirSync(upstream);
  git(upstream, 'init', '-q', '-b', 'main');
  commitManifest(upstream, '1.0.0');
  const source = join(root, 'source');
  git(
    root,
    'clone',
    '-q',
    ...(options.gitfile
      ? ['--separate-git-dir', join(root, 'elsewhere.git')]
      : []),
    upstream,
    source,
  );
  commitManifest(upstream, '1.1.0');
  return source;
}

function gitMetadataEntries(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isGitMetadataName(entry.name)) found.push(path);
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
    }
  };
  walk(root, '');
  return found.sort();
}

function harness(root: string) {
  const home = join(root, 'home');
  const pluginsDir = join(home, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  const proposals = new PluginLifecycleProposalService(home);
  const log = logger();
  const app = new Hono();
  registerPluginInstallRoutes(app, {
    projectVisiblePlugins: () => (installed) => installed,
    agentsDir: join(home, 'agents'),
    logger: log,
    pluginsDir,
    projectHomeDir: home,
    proposals,
  });
  const post = async (path: string, body: unknown) => {
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await readJson(response)) as any };
  };
  /** Preview, then install from that preview, as the Plugins view does. */
  const previewAndInstall = async (source: string, proposalId?: string) => {
    const preview = await post('/preview', { source });
    expect(preview.body, JSON.stringify(preview.body)).toMatchObject({
      valid: true,
    });
    const basis = preview.body;
    const install = await post('/install', {
      source,
      ...(proposalId ? { proposalId } : {}),
      skip: [],
      expectedInstallation: basis.installationRevision,
      consent: {
        registryTrustRevision: basis.registryTrustRevision,
        ...(basis.grantRevision !== undefined
          ? { grantRevision: basis.grantRevision }
          : {}),
        permissions: basis.permissions.required,
        contentDigest: basis.contentDigest,
        dependencies: [],
      },
    });
    expect(install.body, JSON.stringify(install.body)).toMatchObject({
      success: true,
    });
    return { preview: preview.body, install: install.body };
  };
  const listed = async () => {
    const response = await app.request('/');
    const body = (await readJson(response)) as any;
    const plugins = Array.isArray(body) ? body : body.plugins;
    return plugins.find((plugin: any) => plugin.name === 'checkout-plugin');
  };
  return { pluginsDir, proposals, log, previewAndInstall, listed };
}

describe('git metadata in a proposed local install (#2719)', () => {
  test('an agent-proposed folder installs with no git metadata, and nothing reports git info or updates', async () => {
    const root = tempDir('station-proposed-git-');
    const source = checkout(root, { gitfile: true });
    // A `.GIT` spelling (in a subfolder: a case-insensitive volume cannot
    // hold it beside `.git`) and a nested repository.
    mkdirSync(join(source, 'assets', '.GIT'), { recursive: true });
    writeFileSync(join(source, 'assets', '.GIT', 'config'), '[core]\n');
    mkdirSync(join(source, 'vendor'));
    git(join(source, 'vendor'), 'init', '-q');
    expect(lstatSync(join(source, '.git')).isFile()).toBe(true);
    expect(gitMetadataEntries(source)).toEqual([
      '.git',
      'assets/.GIT',
      'vendor/.git',
    ]);

    const { pluginsDir, proposals, log, previewAndInstall, listed } =
      harness(root);
    const { proposal } = await proposals.propose({
      kind: 'install',
      source,
      rationale: 'Adds the checkout pane.',
      author: { principal: 'agent' },
    });

    const { preview, install } = await previewAndInstall(source, proposal.id);
    expect(preview.git).toBeUndefined();
    expect(install.proposal).toEqual({ id: proposal.id, status: 'completed' });

    const installed = join(pluginsDir, 'checkout-plugin');
    expect(existsSync(join(installed, 'plugin.json'))).toBe(true);
    expect(gitMetadataEntries(installed)).toEqual([]);
    // The approval bound the installed bytes: the installed package digests
    // to what the preview showed, and differs from the folder read in place
    // (which still holds the nested git metadata).
    expect(preview.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computePluginContentDigest(pluginsDir, 'checkout-plugin')).toBe(
      preview.contentDigest,
    );
    expect(computePluginTreeDigest(source)).not.toBe(preview.contentDigest);
    expect((await listed())?.git).toBeUndefined();
    const { updates } = await checkPluginUpdates({ pluginsDir, logger: log });
    expect(updates.filter((u) => u.name === 'checkout-plugin')).toEqual([]);
  });

  test('an operator’s own install of a checkout keeps its .git (positive control)', async () => {
    const root = tempDir('station-operator-git-');
    const source = checkout(root, { gitfile: false });
    const { pluginsDir, log, previewAndInstall, listed } = harness(root);

    const { preview } = await previewAndInstall(source);
    expect(preview.git).toMatchObject({ hash: expect.any(String) });

    const installed = join(pluginsDir, 'checkout-plugin');
    expect(lstatSync(join(installed, '.git')).isDirectory()).toBe(true);
    expect((await listed())?.git).toMatchObject({ hash: expect.any(String) });
    const { updates } = await checkPluginUpdates({ pluginsDir, logger: log });
    expect(updates).toContainEqual(
      expect.objectContaining({ name: 'checkout-plugin', source: 'git' }),
    );
  });
});
