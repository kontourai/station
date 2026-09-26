/**
 * #2342 review: backups and post-build copies of a plugin's OWN tree skip
 * special files (a FIFO, a unix socket its server created) rather than
 * refusing them, so such a plugin can still be updated, reinstalled over
 * and uninstalled. Ingress keeps refusing them (see
 * plugin-preview-untrusted-manifest.test.ts).
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { JsonManifestRegistryProvider } from '../../../providers/registries/json-manifest-registry.js';
import {
  installPluginFromSource,
  uninstallInstalledPlugin,
} from '../../../services/plugins/plugin-install-transaction.js';
import type { Logger } from '../../../utils/logger.js';
import { createPluginRoutes } from '../plugins.js';

const cleanup: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
  await Promise.all(
    cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    setLevel: vi.fn(),
    getLevel: vi.fn(() => 'info' as const),
  } as unknown as Logger;
}

function makeHome() {
  // Short root: a unix socket path is limited to ~104 bytes on macOS. Build
  // it under the real OS temp dir, not vitest.setup.ts's run-root redirect
  // (#2534) — that redirect alone already spends most of the budget.
  const home = mkdtempSync(
    join(process.env.STATION_VITEST_HOST_TMPDIR ?? tmpdir(), 'st-sf-'),
  );
  cleanup.push(home);
  mkdirSync(join(home, 'plugins'), { recursive: true });
  mkdirSync(join(home, 'agents'), { recursive: true });
  return home;
}

function deps(home: string) {
  return {
    agentsDir: join(home, 'agents'),
    buildPlugin: vi.fn().mockResolvedValue(undefined),
    logger: makeLogger(),
    pluginsDir: join(home, 'plugins'),
    projectHomeDir: home,
  } as any;
}

function git(cwd: string, ...args: string[]) {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
    { cwd, stdio: 'ignore', windowsHide: true },
  );
}

/** The special files a running plugin can leave in its own directory. */
async function addSpecialFiles(dir: string) {
  execFileSync('mkfifo', [join(dir, 'events.fifo')]);
  const server = createServer();
  servers.push(server);
  await new Promise<void>((listening) =>
    server.listen(join(dir, 'run.sock'), () => listening()),
  );
  expect(lstatSync(join(dir, 'run.sock')).isSocket()).toBe(true);
  expect(lstatSync(join(dir, 'events.fifo')).isFIFO()).toBe(true);
}

describe('a plugin with special files in its own directory (#2342 review)', () => {
  test('can be installed over and then uninstalled', async () => {
    const home = makeHome();
    const source = join(home, 'src');
    mkdirSync(source);
    writeFileSync(
      join(source, 'plugin.json'),
      JSON.stringify({ name: 'sock-plugin', version: '1.0.0' }),
    );
    await installPluginFromSource(source, [], deps(home));
    const pluginDir = join(home, 'plugins', 'sock-plugin');
    await addSpecialFiles(pluginDir);

    // Install over: backs up the existing tree first.
    writeFileSync(
      join(source, 'plugin.json'),
      JSON.stringify({ name: 'sock-plugin', version: '1.1.0' }),
    );
    await installPluginFromSource(source, [], deps(home));
    expect(
      JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8')).version,
    ).toBe('1.1.0');

    await addSpecialFiles(pluginDir);
    // Uninstall: backs up the tree before removing it.
    await uninstallInstalledPlugin('sock-plugin', deps(home));
    expect(existsSync(pluginDir)).toBe(false);
  });

  test('a git-backed plugin can be updated through POST /:name/update', async () => {
    const home = makeHome();
    const origin = join(home, 'origin.git');
    mkdirSync(origin);
    git(origin, 'init', '-q');
    writeFileSync(
      join(origin, 'plugin.json'),
      JSON.stringify({ name: 'sock-git', version: '1.0.0' }),
    );
    git(origin, 'add', 'plugin.json');
    git(origin, 'commit', '-q', '-m', 'v1');
    await installPluginFromSource(origin, [], deps(home));
    const pluginDir = join(home, 'plugins', 'sock-git');
    expect(existsSync(join(pluginDir, '.git'))).toBe(true);
    await addSpecialFiles(pluginDir);

    writeFileSync(
      join(origin, 'plugin.json'),
      JSON.stringify({ name: 'sock-git', version: '1.1.0' }),
    );
    git(origin, 'commit', '-q', '-am', 'v2');

    const app = createPluginRoutes(home, makeLogger());
    const response = await app.request('/sock-git/update', { method: 'POST' });
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ success: true });
    expect(
      JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8')).version,
    ).toBe('1.1.0');
  });
});

describe('a registry install from a local source keeps relative symlinks (#2342 review)', () => {
  test('the installed link still resolves after staging is removed', async () => {
    const home = makeHome();
    const source = join(home, 'registry-src');
    mkdirSync(join(source, 'assets'), { recursive: true });
    writeFileSync(
      join(source, 'plugin.json'),
      JSON.stringify({ name: 'linked-assets', version: '1.0.0' }),
    );
    writeFileSync(join(source, 'assets', 'logo.txt'), 'logo');
    symlinkSync('assets/logo.txt', join(source, 'logo-link.txt'));
    const manifestPath = join(home, 'registry.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'linked-assets',
            displayName: 'Linked Assets',
            description: 'Relative symlink fixture',
            version: '1.0.0',
            source: './registry-src',
          },
        ],
        tools: [],
      }),
    );

    const result = await new JsonManifestRegistryProvider(
      manifestPath,
      home,
    ).install('linked-assets');

    expect(result).toMatchObject({ success: true });
    const link = join(home, 'plugins', 'linked-assets', 'logo-link.txt');
    expect(readlinkSync(link)).toBe('assets/logo.txt');
    expect(readFileSync(link, 'utf8')).toBe('logo');
  });
});
