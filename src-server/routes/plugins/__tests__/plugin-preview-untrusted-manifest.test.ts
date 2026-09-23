/**
 * #2342: `POST /api/plugins/preview` (and the install behind it) read a
 * staged `plugin.json` through the bounded reader, so a source cannot make
 * Station follow a symlink out of the tree, block on a FIFO, or stream an
 * oversized file. Every case drives the real route, stages through the real
 * `fetchPluginSource`, and checks the staging tree is gone afterwards.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { installPluginFromSource } from '../../../services/plugins/plugin-install-transaction.js';
import {
  PLUGIN_MANIFEST_MAX_BYTES,
  PluginManifestReadRefusedError,
  readPluginManifestBytesBounded,
} from '../../../services/plugins/plugin-manifest-bounded-read.js';
import { registerPluginInstallRoutes } from '../plugin-install-routes.js';

const SECRET = 'AKIASECRET0123456789';

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map(async (dir) => {
      // A test may leave a directory unreadable; restore it so rm can work.
      try {
        chmodSync(join(dir, 'unreadable-source', 'locked.txt'), 0o644);
      } catch {}
      await rm(dir, { recursive: true, force: true });
    }),
  );
});

function logger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as any;
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'station-preview-untrusted-'));
  cleanupDirs.push(root);
  mkdirSync(join(root, 'plugins'), { recursive: true });
  return root;
}

function createApp(root: string) {
  const app = new Hono();
  registerPluginInstallRoutes(app, {
    projectVisiblePlugins: () => (installed) => installed,
    agentsDir: join(root, 'agents'),
    logger: logger(),
    pluginsDir: join(root, 'plugins'),
    projectHomeDir: root,
  });
  return app;
}

function stagingLeftovers(root: string): string[] {
  return readdirSync(join(root, 'plugins')).filter((entry) =>
    entry.startsWith('.preview-'),
  );
}

async function preview(root: string, source: string) {
  const outcome = await Promise.race([
    Promise.resolve(
      createApp(root).request('/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      }),
    ).then(async (response) => ({
      status: response.status,
      body: await readJson(response),
    })),
    new Promise<'timed out'>((resolve) =>
      setTimeout(() => resolve('timed out'), 5_000),
    ),
  ]);
  expect(outcome, 'preview blocked on plugin.json').not.toBe('timed out');
  return outcome as { status: number; body: any };
}

function writeSecrets(root: string) {
  writeFileSync(join(root, 'secret.txt'), `${SECRET} not json`);
  writeFileSync(
    join(root, 'secret.json'),
    JSON.stringify({
      name: 'leaked-name',
      version: '9.9.9',
      description: SECRET,
    }),
  );
}

describe('POST /preview reads the staged plugin.json through the bounded reader (#2342)', () => {
  test('a normal manifest still previews', async () => {
    const root = makeRoot();
    const source = join(root, 'normal');
    mkdirSync(source);
    writeFileSync(
      join(source, 'plugin.json'),
      JSON.stringify({ name: 'normal-plugin', version: '1.0.0' }),
    );
    const { status, body } = await preview(root, source);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      valid: true,
      manifest: { name: 'normal-plugin', version: '1.0.0' },
    });
    expect(stagingLeftovers(root)).toEqual([]);
  });

  test.each([
    ['a text file', 'secret.txt'],
    ['a JSON file', 'secret.json'],
  ])(
    'refuses a plugin.json symlinked to %s without echoing it',
    async (_label, target) => {
      const root = makeRoot();
      writeSecrets(root);
      const source = join(root, `sym-${target}`);
      mkdirSync(source);
      symlinkSync(join(root, target), join(source, 'plugin.json'));

      const { status, body } = await preview(root, source);

      expect(status).toBe(400);
      expect(body).toMatchObject({
        valid: false,
        code: 'manifest-not-regular-file',
      });
      expect(body.manifest).toBeUndefined();
      const text = JSON.stringify(body);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('leaked-name');
      expect(text).not.toContain('9.9.9');
      expect(stagingLeftovers(root)).toEqual([]);
    },
  );

  test('refuses a plugin.json symlinked to /dev/zero promptly', async () => {
    const root = makeRoot();
    const source = join(root, 'sym-zero');
    mkdirSync(source);
    symlinkSync('/dev/zero', join(source, 'plugin.json'));
    const { status, body } = await preview(root, source);
    expect(status).toBe(400);
    expect(body.code).toBe('manifest-not-regular-file');
    expect(stagingLeftovers(root)).toEqual([]);
  });

  test('returns promptly for a FIFO plugin.json and a symlink to a FIFO', async () => {
    const root = makeRoot();
    const fifo = join(root, 'fifo');
    execFileSync('mkfifo', [fifo]);
    const inPlace = join(root, 'fifo-in-place');
    mkdirSync(inPlace);
    execFileSync('mkfifo', [join(inPlace, 'plugin.json')]);
    const linked = join(root, 'fifo-linked');
    mkdirSync(linked);
    symlinkSync(fifo, join(linked, 'plugin.json'));

    // Node's tree copy skips a FIFO, so the staged tree has no manifest.
    const direct = await preview(root, inPlace);
    expect(direct.body.valid).toBe(false);
    expect(direct.body.error).toContain('plugin.json not found');
    // The symlink is copied verbatim and refused by the reader.
    const viaLink = await preview(root, linked);
    expect(viaLink.status).toBe(400);
    expect(viaLink.body.code).toBe('manifest-not-regular-file');
    expect(stagingLeftovers(root)).toEqual([]);
  });

  test('refuses a manifest over the byte cap without parsing it', async () => {
    const root = makeRoot();
    const source = join(root, 'oversize');
    mkdirSync(source);
    const manifest = join(source, 'plugin.json');
    writeFileSync(manifest, `{"name":"${SECRET}"`);
    // Sparse: the size is over the cap without writing a megabyte.
    truncateSync(manifest, PLUGIN_MANIFEST_MAX_BYTES + 1);

    const { status, body } = await preview(root, source);

    expect(status).toBe(400);
    expect(body).toMatchObject({ valid: false, code: 'manifest-too-large' });
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(stagingLeftovers(root)).toEqual([]);
  });

  test('refuses a symlinked plugin.json committed to a git source', async () => {
    const root = makeRoot();
    writeSecrets(root);
    // A path ending in `.git` is a git source: preview clones it.
    const repo = join(root, 'linked-plugin.git');
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
        { cwd: repo, stdio: 'ignore', windowsHide: true },
      );
    git('init', '-q');
    symlinkSync(join(root, 'secret.json'), join(repo, 'plugin.json'));
    git('add', 'plugin.json');
    git('commit', '-q', '-m', 'linked manifest');

    const { status, body } = await preview(root, repo);

    expect(status).toBe(400);
    expect(body.code).toBe('manifest-not-regular-file');
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(body)).not.toContain('leaked-name');
    expect(stagingLeftovers(root)).toEqual([]);
  });

  test('removes the staging tree when the source copy fails part-way', async () => {
    const root = makeRoot();
    const source = join(root, 'unreadable-source');
    mkdirSync(source);
    writeFileSync(
      join(source, 'plugin.json'),
      JSON.stringify({ name: 'unreadable', version: '1.0.0' }),
    );
    // An unreadable FILE: the copy throws EACCES. (An unreadable DIRECTORY
    // aborts the Node process inside cpSync instead, which no catch can
    // handle; that is reported separately rather than exercised here.)
    writeFileSync(join(source, 'locked.txt'), 'x');
    chmodSync(join(source, 'locked.txt'), 0o000);

    const { body } = await preview(root, source);

    expect(body.valid).toBe(false);
    expect(body.error).toContain('Failed to stage plugin source');
    expect(stagingLeftovers(root)).toEqual([]);
  });
});

describe('preview reads a fetched dependency manifest through the bounded reader (#2342)', () => {
  test('a dependency whose plugin.json is a symlink contributes no manifest-derived consent', async () => {
    const root = makeRoot();
    const outside = join(root, 'outside.json');
    writeFileSync(
      outside,
      JSON.stringify({
        name: 'linked-dep',
        version: '1.0.0',
        description: SECRET,
        providers: [{ type: 'auth', module: './provider.js' }],
      }),
    );
    const parent = join(root, 'parent');
    const dependency = join(root, 'linked-dep');
    mkdirSync(parent);
    mkdirSync(dependency);
    writeFileSync(
      join(parent, 'plugin.json'),
      JSON.stringify({
        name: 'parent',
        version: '1.0.0',
        dependencies: [{ id: 'linked-dep', source: '../linked-dep' }],
      }),
    );
    writeFileSync(join(dependency, 'provider.js'), 'export default {};\n');
    symlinkSync(outside, join(dependency, 'plugin.json'));

    const { body } = await preview(root, parent);

    // Followed, the link would have yielded a consent basis with the
    // outside file's `providers.register` permission.
    expect(body.dependencies).toEqual([
      expect.objectContaining({ id: 'linked-dep', status: 'will-install' }),
    ]);
    expect(body.dependencies[0].consent).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(stagingLeftovers(root)).toEqual([]);
  });
});

describe('install refuses what preview refuses (#2342)', () => {
  test('installPluginFromSource rejects a symlinked plugin.json and cleans up', async () => {
    const root = makeRoot();
    writeSecrets(root);
    const source = join(root, 'sym-install');
    mkdirSync(source);
    symlinkSync(join(root, 'secret.json'), join(source, 'plugin.json'));

    const install = installPluginFromSource(source, [], {
      agentsDir: join(root, 'agents'),
      buildPlugin: vi.fn().mockResolvedValue(undefined),
      logger: logger(),
      pluginsDir: join(root, 'plugins'),
      projectHomeDir: root,
    } as any);

    await expect(install).rejects.toBeInstanceOf(
      PluginManifestReadRefusedError,
    );
    expect(existsSync(join(root, 'plugins', 'leaked-name'))).toBe(false);
    expect(stagingLeftovers(root)).toEqual([]);
  });
});

describe('readPluginManifestBytesBounded', () => {
  test('refuses a FIFO in place without blocking', () => {
    const root = makeRoot();
    const path = join(root, 'plugin.json');
    execFileSync('mkfifo', [path]);
    // A blocking open would hang this synchronous call, and the test with it.
    expect(readPluginManifestBytesBounded(path)).toEqual({
      ok: false,
      code: 'manifest-not-regular-file',
      message: 'plugin.json is not a regular file.',
    });
  });

  test('accepts a manifest exactly at the cap', () => {
    const root = makeRoot();
    const path = join(root, 'plugin.json');
    writeFileSync(path, '');
    truncateSync(path, PLUGIN_MANIFEST_MAX_BYTES);
    const read = readPluginManifestBytesBounded(path);
    expect(read.ok).toBe(true);
    expect(read.ok && read.raw.length).toBe(PLUGIN_MANIFEST_MAX_BYTES);
  });
});
