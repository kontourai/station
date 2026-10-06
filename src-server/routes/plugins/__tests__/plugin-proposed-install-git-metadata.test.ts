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
 * A proposed remote git URL is cloned, then staged without the clone's
 * `.git`; an operator's own remote install keeps it.
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
import { withOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { computePluginContentDigest } from '../../../services/plugins/plugin-content-integrity.js';
import { PluginLifecycleProposalService } from '../../../services/plugins/plugin-lifecycle-proposals.js';
import { checkPluginUpdates } from '../../../services/plugins/plugin-update-check.js';
import { execGitSync } from '../../../utils/git-exec.js';
import { isGitMetadataName } from '../../../utils/git-metadata-name.js';
import { registerPluginInstallRoutes } from '../plugin-install-routes.js';
import { createPluginProposalRoutes } from '../plugin-proposal-routes.js';

/**
 * A remote git source, simulated: `execGit` clones a local bare repository
 * when asked for this https URL, and is otherwise real.
 */
const REMOTE = 'https://git.example.test/acme/checkout-plugin.git';
const remote = vi.hoisted(() => ({ repository: '' }));
vi.mock('../../../utils/git-exec.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../utils/git-exec.js')>();
  return {
    ...original,
    execGit: (
      args: string[],
      options: Parameters<typeof original.execGit>[1],
    ) =>
      args.includes(REMOTE)
        ? original.execGit(
            args.map((arg) => (arg === REMOTE ? remote.repository : arg)),
            { ...options, hardening: { allowFileProtocol: true } },
          )
        : original.execGit(args, options),
  };
});

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
  // The real proposal route, read as the operator, for the digest it records.
  app.route(
    '/proposals',
    createPluginProposalRoutes({
      proposals,
      pluginsDir,
      logger: log,
      resolvePrincipal: () => ({
        id: LOCAL_OPERATOR_PRINCIPAL_ID,
        kind: 'human' as const,
        display: 'Operator',
      }),
    }),
  );
  // Installing takes the operator in person; a bare mount is refused.
  const operatorApp = withOperatorPrincipal(app);
  const post = async (path: string, body: unknown) => {
    const response = await operatorApp.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await readJson(response)) as any };
  };
  const preview = async (source: string) => {
    const previewed = await post('/preview', { source });
    return previewed.body;
  };
  /** Install from a preview, sending back what it showed, as the view does. */
  const installFrom = (basis: any, source: string, proposalId?: string) =>
    post('/install', {
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
        ...(basis.gitMetadata ? { gitMetadata: basis.gitMetadata } : {}),
        dependencies: [],
      },
    });
  const previewAndInstall = async (source: string, proposalId?: string) => {
    const basis = await preview(source);
    expect(basis, JSON.stringify(basis)).toMatchObject({ valid: true });
    const install = await installFrom(basis, source, proposalId);
    expect(install.body, JSON.stringify(install.body)).toMatchObject({
      success: true,
    });
    return { preview: basis, install: install.body };
  };
  const listed = async () => {
    const response = await operatorApp.request('/');
    const body = (await readJson(response)) as any;
    const plugins = Array.isArray(body) ? body : body.plugins;
    return plugins.find((plugin: any) => plugin.name === 'checkout-plugin');
  };
  return {
    pluginsDir,
    proposals,
    log,
    post,
    preview,
    installFrom,
    previewAndInstall,
    listed,
  };
}

/** The agent-proposed folder shape: a gitfile, a `.GIT`, a nested repo. */
function proposedCheckout(root: string) {
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
  return source;
}

/** A bare repository served as {@link REMOTE}. */
function remoteRepository(root: string) {
  const upstream = join(root, 'upstream');
  mkdirSync(upstream);
  git(upstream, 'init', '-q', '-b', 'main');
  commitManifest(upstream, '1.0.0');
  remote.repository = join(root, 'served.git');
  git(root, 'clone', '-q', '--bare', upstream, remote.repository);
}

/**
 * A bare repository served as {@link REMOTE} whose tree holds
 * `sub/.g<U+200C>it/config`: a folder HFS+ resolves as `.git`. Built with
 * plumbing, since git refuses to add such a path from a working tree.
 */
function remoteRepositoryWithHfsDotGit(root: string) {
  const upstream = join(root, 'upstream');
  mkdirSync(upstream);
  git(upstream, 'init', '-q', '-b', 'main');
  const plumb = (args: string[], input: string) =>
    String(
      execGitSync(args, { cwd: upstream, input, encoding: 'utf-8' }),
    ).trim();
  const manifest = plumb(
    ['hash-object', '-w', '--stdin'],
    JSON.stringify({ name: 'checkout-plugin', version: '1.0.0' }),
  );
  const config = plumb(['hash-object', '-w', '--stdin'], '[core]\n');
  const inner = plumb(['mktree'], `100644 blob ${config}\tconfig\n`);
  const dotGit = plumb(['mktree'], `040000 tree ${inner}\t.g\u200cit\n`);
  const tree = plumb(
    ['mktree'],
    `100644 blob ${manifest}\tplugin.json\n040000 tree ${dotGit}\tsub\n`,
  );
  const commit = plumb(
    [
      '-c',
      'user.name=Station Test',
      '-c',
      'user.email=station@example.test',
      'commit-tree',
      tree,
      '-m',
      'v1.0.0',
    ],
    '',
  );
  git(upstream, 'update-ref', 'refs/heads/main', commit);
  remote.repository = join(root, 'served.git');
  git(root, 'clone', '-q', '--bare', upstream, remote.repository);
}

const agent = { principal: 'agent' as const };

describe('git metadata in a proposed local install (#2719)', () => {
  test('an agent-proposed folder installs with no git metadata, and nothing reports git info or updates', async () => {
    const root = tempDir('station-proposed-git-');
    const source = proposedCheckout(root);
    const { pluginsDir, proposals, log, previewAndInstall, listed } =
      harness(root);
    const { proposal } = await proposals.propose({
      kind: 'install',
      source,
      rationale: 'Adds the checkout pane.',
      author: agent,
    });

    const { preview, install } = await previewAndInstall(source, proposal.id);
    expect(preview.git).toBeUndefined();
    expect(preview.gitMetadata).toBe('excluded');
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

  test('a proposal dismissed between preview and install still installs as previewed, without git metadata', async () => {
    const root = tempDir('station-proposed-dismissed-');
    // Only a top-level `.git`: the digest never reads it, so only the
    // staging mode the preview recorded can keep it out.
    const source = checkout(root, { gitfile: true });
    expect(gitMetadataEntries(source)).toEqual(['.git']);
    const { pluginsDir, proposals, preview, installFrom } = harness(root);
    const { proposal } = await proposals.propose({
      kind: 'install',
      source,
      rationale: 'Adds the checkout pane.',
      author: agent,
    });

    const basis = await preview(source);
    expect(basis).toMatchObject({ valid: true, gitMetadata: 'excluded' });
    await proposals.dismiss(proposal.id);
    const install = await installFrom(basis, source);
    expect(install.body, JSON.stringify(install.body)).toMatchObject({
      success: true,
    });

    expect(gitMetadataEntries(join(pluginsDir, 'checkout-plugin'))).toEqual([]);
    expect(existsSync(join(pluginsDir, 'checkout-plugin', '.git'))).toBe(false);
  });

  test('a source proposed after an ordinary preview is refused until previewed again', async () => {
    const root = tempDir('station-proposed-late-');
    const source = proposedCheckout(root);
    const { pluginsDir, proposals, preview, installFrom } = harness(root);

    const basis = await preview(source);
    expect(basis.valid).toBe(true);
    expect(basis.gitMetadata).toBeUndefined();
    await proposals.propose({
      kind: 'install',
      source,
      rationale: 'Adds the checkout pane.',
      author: agent,
    });
    const refused = await installFrom(basis, source);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      success: false,
      consent: { reason: 'git-metadata' },
    });
    expect(existsSync(join(pluginsDir, 'checkout-plugin'))).toBe(false);

    const again = await preview(source);
    expect(again.gitMetadata).toBe('excluded');
    const installed = await installFrom(again, source);
    expect(installed.body, JSON.stringify(installed.body)).toMatchObject({
      success: true,
    });
    expect(gitMetadataEntries(join(pluginsDir, 'checkout-plugin'))).toEqual([]);
  });

  test('a proposed local git repository is refused, not cloned; the operator may still install it', async () => {
    const root = tempDir('station-proposed-local-git-');
    const upstream = join(root, 'upstream');
    mkdirSync(upstream);
    git(upstream, 'init', '-q', '-b', 'main');
    commitManifest(upstream, '1.0.0');
    const repository = join(root, 'checkout-plugin.git');
    git(root, 'clone', '-q', '--bare', upstream, repository);
    const { pluginsDir, proposals, preview } = harness(root);

    // Positive control: the operator's own preview of it clones.
    const ordinary = await preview(repository);
    expect(ordinary, JSON.stringify(ordinary)).toMatchObject({ valid: true });

    await proposals.propose({
      kind: 'install',
      source: repository,
      rationale: 'Adds the checkout pane.',
      author: agent,
    });
    const refused = await preview(repository);
    expect(refused.valid).toBe(false);
    expect(refused.error).toMatch(/cannot be a local git repository/);
    expect(
      readdirSync(pluginsDir).filter((name) => name.startsWith('.preview-')),
    ).toEqual([]);
  });

  test('the digest a proposal records matches the preview for a folder with nested git metadata', async () => {
    const root = tempDir('station-proposed-digest-');
    const source = proposedCheckout(root);
    const { post, preview } = harness(root);

    const created = await post('/proposals', {
      kind: 'install',
      source,
      rationale: 'Adds the checkout pane.',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const recorded = created.body.proposal.proposedContentDigest;
    expect(recorded).toMatch(/^sha256:[0-9a-f]{64}$/);

    const basis = await preview(source);
    expect(basis.gitMetadata).toBe('excluded');
    expect(basis.contentDigest).toBe(recorded);
  });

  test('an agent-proposed remote git source installs without its clone’s .git', async () => {
    const root = tempDir('station-proposed-remote-');
    remoteRepository(root);
    const { pluginsDir, proposals, log, previewAndInstall, listed } =
      harness(root);
    const { proposal } = await proposals.propose({
      kind: 'install',
      source: REMOTE,
      rationale: 'Adds the checkout pane.',
      author: agent,
    });

    const { preview, install } = await previewAndInstall(REMOTE, proposal.id);
    expect(preview.gitMetadata).toBe('excluded');
    expect(install.proposal).toEqual({ id: proposal.id, status: 'completed' });

    const installed = join(pluginsDir, 'checkout-plugin');
    expect(existsSync(join(installed, 'plugin.json'))).toBe(true);
    expect(gitMetadataEntries(installed)).toEqual([]);
    expect(preview.git).toBeUndefined();
    expect(preview.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computePluginContentDigest(pluginsDir, 'checkout-plugin')).toBe(
      preview.contentDigest,
    );
    // No git-backed updates: it updates by previewing its URL again.
    expect((await listed())?.git).toBeUndefined();
    const { updates } = await checkPluginUpdates({ pluginsDir, logger: log });
    expect(updates.filter((u) => u.name === 'checkout-plugin')).toEqual([]);
    expect(
      readdirSync(pluginsDir).filter((name) => name.startsWith('.preview-')),
    ).toEqual([]);
  });

  test('an agent-proposed remote tree holding a path HFS+ reads as .git is refused on every platform', async () => {
    const root = tempDir('station-proposed-remote-hfs-');
    remoteRepositoryWithHfsDotGit(root);
    // Where git's own defaults would check the path out (Linux), as the
    // operator's global config may also say anywhere.
    const globalConfig = join(root, 'gitconfig');
    writeFileSync(
      globalConfig,
      '[core]\n\tprotectHFS = false\n\tprotectNTFS = false\n',
    );
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    try {
      const { pluginsDir, proposals, preview } = harness(root);

      // Positive control: the operator's own preview checks it out.
      const ordinary = await preview(REMOTE);
      expect(ordinary, JSON.stringify(ordinary)).toMatchObject({
        valid: true,
      });

      await proposals.propose({
        kind: 'install',
        source: REMOTE,
        rationale: 'Adds the checkout pane.',
        author: agent,
      });
      const refused = await preview(REMOTE);
      expect(refused.valid, JSON.stringify(refused)).toBe(false);
      expect(refused.error).toMatch(/^Failed to clone: .*invalid path/s);
      expect(
        readdirSync(pluginsDir).filter((name) => name.startsWith('.preview-')),
      ).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('an operator’s own install of a remote git source keeps its .git (positive control)', async () => {
    const root = tempDir('station-operator-remote-');
    remoteRepository(root);
    const { pluginsDir, previewAndInstall, listed } = harness(root);

    const { preview } = await previewAndInstall(REMOTE);
    expect(preview.gitMetadata).toBeUndefined();
    expect(preview.git).toMatchObject({ hash: expect.any(String) });

    const installed = join(pluginsDir, 'checkout-plugin');
    expect(lstatSync(join(installed, '.git')).isDirectory()).toBe(true);
    expect(computePluginContentDigest(pluginsDir, 'checkout-plugin')).toBe(
      preview.contentDigest,
    );
    expect((await listed())?.git).toMatchObject({ hash: expect.any(String) });
  });

  test('an operator’s own install of a checkout keeps its .git (positive control)', async () => {
    const root = tempDir('station-operator-git-');
    const source = checkout(root, { gitfile: false });
    const { pluginsDir, log, previewAndInstall, listed } = harness(root);

    const { preview } = await previewAndInstall(source);
    expect(preview.git).toMatchObject({ hash: expect.any(String) });
    expect(preview.gitMetadata).toBeUndefined();

    const installed = join(pluginsDir, 'checkout-plugin');
    expect(lstatSync(join(installed, '.git')).isDirectory()).toBe(true);
    expect((await listed())?.git).toMatchObject({ hash: expect.any(String) });
    const { updates } = await checkPluginUpdates({ pluginsDir, logger: log });
    expect(updates).toContainEqual(
      expect.objectContaining({ name: 'checkout-plugin', source: 'git' }),
    );
  });
});
