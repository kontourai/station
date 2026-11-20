import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  defaultManagedInstallDeps,
  ManagedInstallConsentRequiredError,
  type ManagedInstallDefinition,
  ManagedInstaller,
  managedInstallDir,
  parseTarListing,
  vetArchiveEntries,
  vetArchiveEntry,
} from '../managed-install.js';
import {
  KAS_PIN,
  KAS_PIN_MANIFEST_SHA256,
  parseKasManifest,
} from '../managed-install-pins.js';
import {
  type FixtureServer,
  sha256,
  startFixtureServer,
  type TarEntry,
  tarGz,
} from './fixtures/managed-install-fixture.js';

const makeTempDir = trackTempDirs();

const VERSION = '9.9.9';
const BASE = `https://kas.test/kas/${VERSION}`;
const HOST = `${process.platform}-${process.arch}`;
const ENGINE_KEY = process.platform === 'darwin' ? 'darwin-universal' : HOST;

const SERVER_JS = 'process.stdout.write("fake acp server\\n");\n';

function engineEntries(): TarEntry[] {
  return [
    { name: 'node_modules/', type: 'dir' },
    { name: 'node_modules/@kiro/', type: 'dir' },
    { name: 'node_modules/@kiro/agent/', type: 'dir' },
    {
      name: 'node_modules/@kiro/agent/package.json',
      body: '{"name":"@kiro/agent"}',
    },
    { name: 'node_modules/@kiro/agent/dist/', type: 'dir' },
    { name: 'node_modules/@kiro/agent/dist/server/', type: 'dir' },
    {
      name: 'node_modules/@kiro/agent/dist/server/acp-server.js',
      body: SERVER_JS,
    },
    // An in-tree relative link, as real bundles carry.
    {
      name: 'node_modules/@kiro/agent/dist/server/alias.js',
      type: 'symlink',
      linkTarget: 'acp-server.js',
    },
  ];
}

function runtimeEntries(): TarEntry[] {
  return [
    { name: 'node-v22.0.0/', type: 'dir' },
    { name: 'node-v22.0.0/bin/', type: 'dir' },
    {
      name: 'node-v22.0.0/bin/node',
      body: `#!/bin/sh\nexec "${process.execPath}" "$@"\n`,
      mode: 0o755,
    },
  ];
}

interface Fixture {
  server: FixtureServer;
  home: string;
  definition: ManagedInstallDefinition;
  manifest: Record<string, unknown>;
}

async function fixture(
  options: {
    engine?: TarEntry[];
    engineBytes?: Buffer;
    engineSha?: (actual: string) => string;
    engineSize?: (actual: number) => number;
    engineFault?: 'truncate';
    node?: unknown;
    pinSha?: (actual: string) => string;
  } = {},
): Promise<Fixture> {
  const server = await startFixtureServer();
  const engine =
    options.engineBytes ?? tarGz(options.engine ?? engineEntries());
  const runtime = tarGz(runtimeEntries());
  server.put(`/kas/${VERSION}/kas-engine.tar.gz`, engine, options.engineFault);
  server.put(`/kas/${VERSION}/node-runtime.tar.gz`, runtime);
  const manifest: Record<string, unknown> = {
    version: VERSION,
    package: '@kiro/agent',
    platforms: {
      [ENGINE_KEY]: {
        file: 'kas-engine.tar.gz',
        sha256: (options.engineSha ?? ((s) => s))(sha256(engine)),
        size: (options.engineSize ?? ((n) => n))(engine.length),
      },
    },
    node:
      options.node !== undefined
        ? options.node
        : {
            version: '22.0.0',
            builds: {
              [HOST]: {
                file: 'node-runtime.tar.gz',
                sha256: sha256(runtime),
                size: runtime.length,
              },
            },
          },
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  server.put(`/kas/${VERSION}/manifest.json`, manifestBytes);
  const home = makeTempDir('managed-install-');
  const definition: ManagedInstallDefinition = {
    pin: {
      installId: 'kiro-kas',
      version: VERSION,
      manifestUrl: `${BASE}/manifest.json`,
      manifestSha256: (options.pinSha ?? ((s) => s))(sha256(manifestBytes)),
      platforms: ['darwin-universal', 'linux-x64', 'linux-arm64', 'win32-x64'],
    },
    displayName: 'Kiro (KAS, no CLI)',
    parseManifest: parseKasManifest,
  };
  return { server, home, definition, manifest };
}

function installer(
  f: Fixture,
  overrides: Partial<ReturnType<typeof defaultManagedInstallDeps>> = {},
) {
  return new ManagedInstaller(f.home, [f.definition], {
    ...defaultManagedInstallDeps(),
    fetch: f.server.fetch,
    ...overrides,
  });
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function run(f: Fixture, inst = installer(f)) {
  cleanups.push(() => f.server.close());
  cleanups.push(() => {
    try {
      execFileSync('chmod', ['-R', 'u+w', f.home], { windowsHide: true });
    } catch {}
    rmSync(f.home, { recursive: true, force: true });
  });
  const { completion } = inst.start('kiro-kas', { consent: true });
  await completion;
  return inst;
}

const artifactRequests = (f: Fixture) =>
  f.server.requests.filter((path) => !path.endsWith('/manifest.json'));

describe.skipIf(process.platform === 'win32')('ManagedInstaller', () => {
  test('installs the pinned engine and runtime, read-only, under engines/<installId>/<version>', async () => {
    const f = await fixture();
    const inst = await run(f);
    const state = inst.state('kiro-kas');
    expect(state).toMatchObject({ kind: 'installed', version: VERSION });
    if (state.kind !== 'installed') throw new Error('not installed');
    const dir = managedInstallDir(f.home, f.definition.pin);
    expect(dir).toBe(join(f.home, 'engines', 'kiro-kas', VERSION));
    expect(state.entry.script).toBe(
      join(dir, 'engine/node_modules/@kiro/agent/dist/server/acp-server.js'),
    );
    expect(state.entry.runtime).toBe(
      join(dir, 'runtime/node-v22.0.0/bin/node'),
    );
    // The installed runtime really runs the installed script.
    expect(
      execFileSync(state.entry.runtime, [state.entry.script], {
        encoding: 'utf8',
        windowsHide: true,
      }),
    ).toBe('fake acp server\n');
    // Read-only after install: neither a file nor the directory takes a write.
    expect(() => writeFileSync(state.entry.script, 'tampered')).toThrow(
      /EACCES|EPERM/,
    );
    expect(() => writeFileSync(join(dir, 'planted.js'), 'x')).toThrow(
      /EACCES|EPERM/,
    );
    expect(
      JSON.parse(readFileSync(join(dir, 'install.json'), 'utf8')),
    ).toMatchObject({ installId: 'kiro-kas', version: VERSION });
    // No staging directory is left behind.
    expect(
      execFileSync('ls', ['-a', join(f.home, 'engines', 'kiro-kas')], {
        encoding: 'utf8',
        windowsHide: true,
      })
        .split('\n')
        .filter((name) => name.startsWith('.staging')),
    ).toEqual([]);
  });

  test('installs an xz-compressed engine archive, as the published builds are', async (context) => {
    const source = makeTempDir('managed-install-xz-');
    cleanups.push(() => rmSync(source, { recursive: true, force: true }));
    const server = join(source, 'node_modules/@kiro/agent/dist/server');
    execFileSync('mkdir', ['-p', server], { windowsHide: true });
    writeFileSync(join(server, 'acp-server.js'), SERVER_JS);
    const archive = join(source, 'engine.tar.xz');
    try {
      execFileSync(
        process.platform === 'darwin' ? '/usr/bin/tar' : 'tar',
        ['-cJf', archive, '-C', source, 'node_modules'],
        { windowsHide: true },
      );
    } catch {
      // A host tar without xz support cannot build the fixture.
      context.skip();
    }
    const f = await fixture({ engineBytes: readFileSync(archive) });
    const inst = await run(f);
    const state = inst.state('kiro-kas');
    expect(state.kind).toBe('installed');
    if (state.kind !== 'installed') return;
    expect(
      execFileSync(state.entry.runtime, [state.entry.script], {
        encoding: 'utf8',
        windowsHide: true,
      }),
    ).toBe('fake acp server\n');
  });

  test('refuses without explicit consent, before any request', async () => {
    const f = await fixture();
    cleanups.push(() => f.server.close());
    const inst = installer(f);
    expect(() =>
      inst.start('kiro-kas', { consent: 'yes' } as unknown as {
        consent: true;
      }),
    ).toThrow(ManagedInstallConsentRequiredError);
    expect(f.server.requests).toEqual([]);
    expect(inst.state('kiro-kas')).toEqual({ kind: 'not-installed' });
  });

  test('a manifest whose bytes miss the pin is refused before any artifact is fetched', async () => {
    const f = await fixture({ pinSha: () => 'a'.repeat(64) });
    const inst = await run(f);
    expect(inst.state('kiro-kas')).toMatchObject({
      kind: 'failed',
      reason: 'manifest-digest-mismatch',
    });
    expect(f.server.requests).toEqual([`/kas/${VERSION}/manifest.json`]);
    expect(artifactRequests(f)).toEqual([]);
  });

  test('an electron-builtin manifest is refused before any artifact is fetched', async () => {
    const f = await fixture({ node: 'electron-builtin' });
    const inst = await run(f);
    expect(inst.state('kiro-kas')).toMatchObject({
      kind: 'failed',
      reason: 'runtime-refused',
    });
    expect(artifactRequests(f)).toEqual([]);
  });

  test('an artifact whose sha256 misses the manifest is refused and nothing is installed', async () => {
    const f = await fixture({
      engineSha: (actual) =>
        `${actual.slice(0, 63)}${actual[63] === '0' ? '1' : '0'}`,
    });
    const inst = await run(f);
    expect(inst.state('kiro-kas')).toMatchObject({
      kind: 'failed',
      reason: 'artifact-digest-mismatch',
    });
    expect(existsSync(managedInstallDir(f.home, f.definition.pin))).toBe(false);
  });

  test('an artifact whose size misses the manifest is refused', async () => {
    const f = await fixture({ engineSize: (actual) => actual + 1 });
    const inst = await run(f);
    expect(inst.state('kiro-kas')).toMatchObject({
      kind: 'failed',
      reason: 'artifact-size-mismatch',
    });
    expect(existsSync(managedInstallDir(f.home, f.definition.pin))).toBe(false);
  });

  test('a truncated download is refused', async () => {
    const f = await fixture({ engineFault: 'truncate' });
    const inst = await run(f);
    const state = inst.state('kiro-kas');
    expect(state.kind).toBe('failed');
    expect(['download-failed', 'artifact-size-mismatch']).toContain(
      state.kind === 'failed' ? state.reason : '',
    );
    expect(existsSync(managedInstallDir(f.home, f.definition.pin))).toBe(false);
  });

  test('an artifact that cannot be written fails the install and removes staging', async () => {
    const f = await fixture();
    const parent = join(f.home, 'engines', 'kiro-kas');
    // The staging directory exists by the time the artifact is fetched:
    // lock its downloads directory so the archive cannot be created.
    const lockingFetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (!String(url).endsWith('/manifest.json')) {
        for (const name of readdirSync(parent)) {
          if (name.startsWith('.staging'))
            chmodSync(join(parent, name, 'downloads'), 0o500);
        }
      }
      return f.server.fetch(url, init);
    }) as typeof fetch;
    const inst = await run(f, installer(f, { fetch: lockingFetch }));
    expect(inst.state('kiro-kas')).toMatchObject({
      kind: 'failed',
      reason: 'download-failed',
    });
    expect(existsSync(managedInstallDir(f.home, f.definition.pin))).toBe(false);
    expect(
      readdirSync(parent).filter((name) => name.startsWith('.staging')),
    ).toEqual([]);
  });

  test('a path-traversal entry is refused before extraction writes anything', async () => {
    const f = await fixture({
      engine: [...engineEntries(), { name: '../escaped.txt', body: 'owned' }],
    });
    const inst = await run(f);
    expect(inst.state('kiro-kas')).toMatchObject({
      kind: 'failed',
      reason: 'unsafe-entry-name',
    });
    expect(existsSync(join(f.home, 'engines', 'kiro-kas', 'escaped.txt'))).toBe(
      false,
    );
    expect(existsSync(join(f.home, 'engines', 'escaped.txt'))).toBe(false);
  });

  test('a symlink pointing out of the archive is refused before extraction', async () => {
    const f = await fixture({
      engine: [
        ...engineEntries(),
        { name: 'node_modules/out', type: 'symlink', linkTarget: '../../..' },
      ],
    });
    const inst = await run(f);
    expect(inst.state('kiro-kas')).toMatchObject({
      kind: 'failed',
      reason: 'unsafe-entry-name',
    });
  });

  // Each link resolves inside the archive on its own, judged lexically from
  // its own directory; chained, extraction walks up one level per link and
  // writes the payload into the Station home, outside every install root.
  const chainedLinks: TarEntry[] = [
    { name: 'd/', type: 'dir' },
    { name: 'd/s', type: 'symlink', linkTarget: '..' },
    { name: 'd/s/t', type: 'symlink', linkTarget: '..' },
    { name: 'd/s/t/u', type: 'symlink', linkTarget: '..' },
    { name: 'd/s/t/u/v', type: 'symlink', linkTarget: '..' },
    { name: 'd/s/t/u/v/w', type: 'symlink', linkTarget: '..' },
    { name: 'd/s/t/u/v/w/payload', body: 'owned' },
  ];

  test('chained links are refused before extraction writes through them', async () => {
    const f = await fixture({ engine: [...engineEntries(), ...chainedLinks] });
    const inst = await run(f);
    expect(inst.state('kiro-kas')).toMatchObject({
      kind: 'failed',
      reason: 'unsafe-entry-name',
    });
    for (const dir of [
      f.home,
      join(f.home, 'engines'),
      join(f.home, 'engines', 'kiro-kas'),
    ])
      expect(existsSync(join(dir, 'payload'))).toBe(false);
  });

  test("the pinned Node runtime's own '..' links still install", async () => {
    // bin/npm, bin/npx and bin/corepack in node-v22.23.3-*.tar.xz point at
    // ../lib/node_modules/...: a blanket '..' refusal would refuse every
    // managed install.
    const f = await fixture({
      engine: [
        ...engineEntries(),
        { name: 'node_modules/@kiro/agent/bin/', type: 'dir' },
        {
          name: 'node_modules/@kiro/agent/bin/acp',
          type: 'symlink',
          linkTarget: '../dist/server/acp-server.js',
        },
      ],
    });
    const inst = await run(f);
    expect(inst.state('kiro-kas')).toMatchObject({ kind: 'installed' });
  });

  test('a link that appears only after extraction fails the tree re-check', async () => {
    const f = await fixture();
    const base = defaultManagedInstallDeps();
    const inst = installer(f, {
      extract: async (archive, dest) => {
        await base.extract(archive, dest);
        symlinkSync('/etc', join(dest, 'planted'));
      },
    });
    await run(f, inst);
    expect(inst.state('kiro-kas')).toMatchObject({
      kind: 'failed',
      reason: 'tree-verification-failed',
    });
  });

  test('an unsupported host is reported without any request', async () => {
    const f = await fixture();
    cleanups.push(() => f.server.close());
    const inst = installer(f, { platform: 'freebsd', arch: 'x64' });
    expect(inst.state('kiro-kas')).toEqual({
      kind: 'unsupported-platform',
      platform: 'freebsd-x64',
    });
    expect(f.server.requests).toEqual([]);
  });
});

describe('archive entry vetting', () => {
  test('refuses an entry reached through a link entry, and a target walked through one', () => {
    const link = (name: string, linkTarget: string) => ({
      name,
      kind: 'symlink' as const,
      linkTarget,
    });
    const dir = { name: 'd/', kind: 'directory' as const };
    expect(
      vetArchiveEntries([dir, link('d/s', '..'), link('d/s/t', '..')]),
    ).toMatch(/d\/s\/t is reached through a link/);
    expect(
      vetArchiveEntries([
        dir,
        link('d/s', '..'),
        { name: 'd/s/payload', kind: 'file' },
      ]),
    ).toMatch(/reached through a link/);
    // Order does not matter: the link may be listed after the entry.
    expect(
      vetArchiveEntries([
        { name: 'd/s/payload', kind: 'file' },
        link('d/s', '..'),
      ]),
    ).toMatch(/reached through a link/);
    // x/b -> .. is the root; x/a -> b/../.. is lexically x, really the
    // root's parent.
    expect(
      vetArchiveEntries([
        { name: 'x/', kind: 'directory' },
        link('x/b', '..'),
        link('x/a', 'b/../..'),
      ]),
    ).toMatch(/x\/a links through another link/);
    expect(
      vetArchiveEntries([
        { name: 'h', kind: 'hardlink', linkTarget: 'a/../b' },
      ]),
    ).toMatch(/links outside/);
    // A case variant names the same directory on macOS and Windows.
    expect(
      vetArchiveEntries([
        dir,
        link('d/S', '..'),
        { name: 'd/s/payload', kind: 'file' },
      ]),
    ).toMatch(/d\/s\/payload is reached through a link/);
    // A hard link to a symlink re-homes the symlink's relative target.
    expect(
      vetArchiveEntries([
        { name: 'a/b/c/', kind: 'directory' },
        link('a/b/c/l', '../../../x'),
        { name: 'h', kind: 'hardlink', linkTarget: 'a/b/c/l' },
      ]),
    ).toMatch(/h hard-links a symbolic link/);
  });

  test("accepts the pinned Node runtime's '..' links and a link to a link", () => {
    expect(
      vetArchiveEntries([
        { name: 'node/bin/', kind: 'directory' },
        { name: 'node/bin/node', kind: 'file' },
        {
          name: 'node/bin/npm',
          kind: 'symlink',
          linkTarget: '../lib/node_modules/npm/bin/npm-cli.js',
        },
        { name: 'node/bin/npm2', kind: 'symlink', linkTarget: 'npm' },
        { name: 'node/lib/node_modules/npm/bin/npm-cli.js', kind: 'file' },
      ]),
    ).toBeUndefined();
  });

  test.each([
    [{ name: '/abs', kind: 'file' as const }],
    [{ name: 'a/../../b', kind: 'file' as const }],
    [{ name: 'C:\\x', kind: 'file' as const }],
    [{ name: 'dev', kind: 'other' as const }],
    [{ name: 'a/l', kind: 'symlink' as const, linkTarget: '/etc/passwd' }],
    [{ name: 'a/l', kind: 'symlink' as const, linkTarget: '../../x' }],
    [{ name: 'a/h', kind: 'hardlink' as const, linkTarget: '../x' }],
  ])('refuses %o', (entry) => {
    expect(vetArchiveEntry(entry)).toBeDefined();
  });

  test.each([
    [{ name: 'a/b.js', kind: 'file' as const }],
    [{ name: 'a/l', kind: 'symlink' as const, linkTarget: '../b' }],
    [{ name: 'a/h', kind: 'hardlink' as const, linkTarget: 'a/b.js' }],
  ])('accepts %o', (entry) => {
    expect(vetArchiveEntry(entry)).toBeUndefined();
  });

  test('reads names from -tf and types and targets from -tvf, a name holding " -> " included', () => {
    expect(
      parseTarListing(
        ['./a -> b', './a/hard', './x'],
        [
          'lrwxr-xr-x  0 u g 0 Nov 13 00:25 ./a -> b -> ../../out',
          'hrw-r--r--  0 u g 0 Nov 13 00:25 ./a/hard link to ./x',
          '-rw-r--r--  0 u g 3 Nov 13 00:25 ./x',
        ],
      ),
    ).toEqual([
      { name: './a -> b', kind: 'symlink', linkTarget: '../../out' },
      { name: './a/hard', kind: 'hardlink', linkTarget: './x' },
      { name: './x', kind: 'file' },
    ]);
  });
});

describe('the KAS pin', () => {
  let manifestBytes: Buffer;
  beforeEach(() => {
    manifestBytes = readFileSync(
      join(import.meta.dirname, 'fixtures', 'kas-0.66.104-manifest.json'),
    );
  });

  test('the published manifest (fetched once on 2026-11-13) hashes to the pin', () => {
    expect(sha256(manifestBytes)).toBe(KAS_PIN_MANIFEST_SHA256);
    expect(KAS_PIN.manifestSha256).toBe(
      '263d3d1e59c2d32987d2a09cb066f650b6455cc9de94473693bd0a07aec151f4',
    );
  });

  test('the parser reads the published shape: four engine builds and five Node builds', () => {
    const manifest = parseKasManifest(
      JSON.parse(manifestBytes.toString('utf8')),
      KAS_PIN.manifestUrl,
    );
    expect(manifest.version).toBe('0.66.104');
    expect(Object.keys(manifest.artifacts).sort()).toEqual([
      'darwin-universal',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]);
    expect(manifest.artifacts['darwin-universal']).toEqual({
      url: 'https://kas.crew.kiro.dev/kas/0.66.104/kas-darwin-universal.tar.xz',
      sha256:
        'a9a5856881c660c71efcf0c76e96768c3ec951751a2d6ad35924dd263ba85999',
      size: 28739596,
    });
    expect(
      manifest.runtimeBuilds?.map((build) => [build.platform, build.runtime]),
    ).toEqual([
      ['linux-x64', 'node'],
      ['linux-arm64', 'node'],
      ['darwin-x64', 'node'],
      ['darwin-arm64', 'node'],
      ['win32-x64', 'node'],
    ]);
    expect(manifest.entry).toBe(
      'node_modules/@kiro/agent/dist/server/acp-server.js',
    );
  });

  test('a file name with a path in it is refused', () => {
    expect(() =>
      parseKasManifest(
        {
          version: '1.0.0',
          platforms: {
            'linux-x64': {
              file: '../x.tar.xz',
              sha256: 'a'.repeat(64),
              size: 1,
            },
          },
          node: { version: '22.0.0', builds: {} },
        },
        KAS_PIN.manifestUrl,
      ),
    ).toThrow(/bare object name/);
  });
});
