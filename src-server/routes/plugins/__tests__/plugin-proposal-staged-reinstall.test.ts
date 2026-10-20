/**
 * #2719 follow-up: a folder installed without its git metadata because a
 * proposal named it stays stripped on every later preview and install of
 * that folder, after the proposal has resolved. An operator's own install
 * keeps its `.git` on reinstall (positive control).
 *
 * Drives the real `POST /preview` and `POST /install` (real staging, real
 * consent check, real installer, a real installation journal) over a real
 * proposal store, then reads the installed package back through `GET /`
 * (git info) and the update scan, for both manifest formats.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { withOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { resolveInstalledPluginRoot } from '../../../services/plugins/plugin-incarnation.js';
import { PluginLifecycleProposalService } from '../../../services/plugins/plugin-lifecycle-proposals.js';
import { PLUGIN_SOURCE_STAGING_FILE } from '../../../services/plugins/plugin-source-staging.js';
import { checkPluginUpdates } from '../../../services/plugins/plugin-update-check.js';
import { execGitSync } from '../../../utils/git-exec.js';
import { isGitMetadataName } from '../../../utils/git-metadata-name.js';
import { ownGitRepositoryArgs } from '../../../utils/own-git-repository.js';
import { registerPluginInstallRoutes } from '../plugin-install-routes.js';

const tempDir = trackTempDirs();
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const PLUGIN = 'reinstall-plugin';
const agent = { principal: 'agent' as const };

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

type Format = 'legacy' | 'agent-plugin-1.0';

function manifest(format: Format, version: string): string {
  return JSON.stringify({
    ...(format === 'agent-plugin-1.0'
      ? {
          $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        }
      : {}),
    name: PLUGIN,
    version,
  });
}

function harness(format: Format) {
  const root = realpathSync(tempDir('station-staged-reinstall-'));
  const home = join(root, 'home');
  const pluginsDir = join(home, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  const source = join(root, 'source');
  mkdirSync(join(source, 'lib'), { recursive: true });
  writeFileSync(join(source, 'plugin.json'), manifest(format, '1.0.0'));
  writeFileSync(join(source, 'lib', 'index.js'), 'export const v = 1;\n');
  const store = new EventStore(join(home, 'events.sqlite'));
  stores.push(store);
  const proposals = new PluginLifecycleProposalService(home);
  const log = logger();
  const routes = new Hono();
  registerPluginInstallRoutes(routes, {
    projectVisiblePlugins: () => (installed) => installed,
    agentsDir: join(home, 'agents'),
    logger: log,
    pluginsDir,
    projectHomeDir: home,
    packageMcpJournal: store.createPackageMcpAdmissionJournal(),
    proposals,
  });
  const app = withOperatorPrincipal(routes);
  const post = async (path: string, body: unknown) => {
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await readJson(response)) as any };
  };
  const preview = async () => (await post('/preview', { source })).body;
  /** Install from a preview, sending back what it showed, as the view does. */
  const installFrom = (basis: any, proposalId?: string) =>
    post('/install', {
      source,
      ...(proposalId ? { proposalId } : {}),
      skip: [],
      expectedInstallation: basis.installationRevision,
      consent: {
        permissions: basis.permissions.required,
        contentDigest: basis.contentDigest,
        ...(basis.gitMetadata ? { gitMetadata: basis.gitMetadata } : {}),
        ...(basis.grantRevision !== undefined
          ? { grantRevision: basis.grantRevision }
          : {}),
        dependencies: [],
      },
    });
  const previewAndInstall = async (proposalId?: string) => {
    const basis = await preview();
    expect(basis, JSON.stringify(basis)).toMatchObject({ valid: true });
    const installed = await installFrom(basis, proposalId);
    expect(installed.body, JSON.stringify(installed.body)).toMatchObject({
      success: true,
    });
    return { preview: basis, install: installed.body };
  };
  const installedRoot = () => {
    const resolved = resolveInstalledPluginRoot(pluginsDir, PLUGIN);
    expect(resolved).not.toBeNull();
    return resolved!.packageRoot;
  };
  const listedGit = async () => {
    const body = (await readJson(await app.request('/'))) as any;
    const plugins = Array.isArray(body) ? body : body.plugins;
    return plugins.find((plugin: any) => plugin.name === PLUGIN)?.git;
  };
  const updates = async () =>
    (await checkPluginUpdates({ pluginsDir, logger: log })).updates.filter(
      (update) => update.name === PLUGIN,
    );
  /**
   * After install: the folder becomes a checkout whose `origin` is a
   * repository one commit ahead, and a file changes, so the source reads
   * "changed" and a kept `.git` would have git info and an update.
   */
  const plantRepository = (version: string) => {
    const upstream = join(root, 'planted-upstream');
    mkdirSync(upstream);
    git(upstream, 'init', '-q', '-b', 'main');
    writeFileSync(join(upstream, 'plugin.json'), manifest(format, version));
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-q', '-m', 'base');
    git(source, 'init', '-q', '-b', 'main');
    git(source, 'remote', 'add', 'origin', upstream);
    git(source, 'fetch', '-q', 'origin');
    git(source, 'reset', '-q', 'origin/main');
    git(source, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
    writeFileSync(join(source, 'plugin.json'), manifest(format, version));
    writeFileSync(join(source, 'lib', 'index.js'), 'export const v = 2;\n');
    git(source, 'add', '.');
    git(source, 'commit', '-q', '-m', 'local');
    writeFileSync(join(upstream, 'plugin.json'), manifest(format, '9.0.0'));
    git(upstream, 'commit', '-q', '-am', 'ahead');
    expect(existsSync(join(source, '.git'))).toBe(true);
  };
  return {
    home,
    source,
    proposals,
    preview,
    installFrom,
    previewAndInstall,
    installedRoot,
    listedGit,
    updates,
    plantRepository,
  };
}

describe.each<Format>(['legacy', 'agent-plugin-1.0'])(
  'a proposal-staged install stays stripped on reinstall (%s)',
  (format) => {
    test('reinstalling the folder after its proposal completed keeps every .git out, and reports no git info or update', async () => {
      const h = harness(format);
      const { proposal } = await h.proposals.propose({
        kind: 'install',
        source: h.source,
        rationale: 'Adds the pane.',
        author: agent,
      });
      const first = await h.previewAndInstall(proposal.id);
      expect(first.preview.gitMetadata).toBe('excluded');
      expect(first.install.proposal).toEqual({
        id: proposal.id,
        status: 'completed',
      });
      expect(h.proposals.hasOpenInstallProposal(h.source)).toBe(false);

      h.plantRepository('1.0.1');
      const again = await h.previewAndInstall();

      expect(again.preview.gitMetadata).toBe('excluded');
      expect(again.preview.git).toBeUndefined();
      const installed = h.installedRoot();
      expect(
        JSON.parse(readFileSync(join(installed, 'plugin.json'), 'utf8')),
      ).toMatchObject({ version: '1.0.1' });
      expect(gitMetadataEntries(installed)).toEqual([]);
      expect(await h.listedGit()).toBeUndefined();
      // No repository of its own: the lifecycle update route has no source,
      // and the update scan reports nothing.
      expect(ownGitRepositoryArgs(installed)).toBeNull();
      expect(await h.updates()).toEqual([]);
    });

    test('an approval from a preview that kept git metadata is refused once the folder was staged stripped', async () => {
      const h = harness(format);
      const { proposal } = await h.proposals.propose({
        kind: 'install',
        source: h.source,
        rationale: 'Adds the pane.',
        author: agent,
      });
      await h.previewAndInstall(proposal.id);
      h.plantRepository('1.0.1');

      const basis = await h.preview();
      const { gitMetadata: _dropped, ...kept } = basis;
      const refused = await h.installFrom(kept);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        success: false,
        consent: { reason: 'git-metadata' },
      });
      expect(gitMetadataEntries(h.installedRoot())).toEqual([]);
    });

    test('positive control: an operator-origin install keeps its .git on reinstall', async () => {
      const h = harness(format);
      const first = await h.previewAndInstall();
      expect(first.preview.gitMetadata).toBeUndefined();

      h.plantRepository('1.0.1');
      const again = await h.previewAndInstall();

      expect(again.preview.gitMetadata).toBeUndefined();
      expect(again.preview.git).toMatchObject({ hash: expect.any(String) });
      const installed = h.installedRoot();
      expect(existsSync(join(installed, '.git'))).toBe(true);
      expect(await h.listedGit()).toMatchObject({ hash: expect.any(String) });
      expect(ownGitRepositoryArgs(installed)).not.toBeNull();
      // The scan walks `<plugins>/<name>` directories, which only the legacy
      // layout has; the agent-plugin layout updates through its own route.
      if (format === 'legacy')
        expect(await h.updates()).toEqual([
          expect.objectContaining({ source: 'git' }),
        ]);
      expect(existsSync(join(h.home, PLUGIN_SOURCE_STAGING_FILE))).toBe(false);
    });
  },
);

test('an unreadable staging record fails closed: preview and install refuse rather than keep git metadata', async () => {
  const h = harness('legacy');
  const basis = await h.preview();
  expect(basis.valid).toBe(true);
  writeFileSync(join(h.home, PLUGIN_SOURCE_STAGING_FILE), '{"version":2}');

  const previewed = await h.preview();
  expect(previewed.valid).toBe(false);
  expect(previewed.error).toMatch(/Plugin source staging is unreadable/);
  const installed = await h.installFrom(basis);
  expect(installed.body.success).toBe(false);
  expect(installed.body.error).toMatch(/Plugin source staging is unreadable/);
  expect(
    resolveInstalledPluginRoot(join(h.home, 'plugins'), PLUGIN),
  ).toBeNull();
});
