import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import {
  PREBUILT_ARCHIVE_MARKER_CONTENT,
  PREBUILT_ARCHIVE_MARKER_FILENAME,
} from '../../packages/cli/src/commands/lifecycle.js';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  assertBuildSourceIsCheckout,
  bundleStationCli,
  obtainNodeDistribution,
  PORTABLE_SERVER_TARGETS,
  PREBUILT_ARCHIVE_MARKER,
  readPortableNodeRuntime,
  resolvePortableServerTarget,
  stationCliBundleOptions,
} from '../lib/portable-server-archive.mjs';
import { SUPPORTED_NODE_MAJOR } from '../node-runtime-contract.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const makeTempDir = trackTempDirs();
// Pinned independently of PORTABLE_SERVER_TARGETS so a dropped or renamed
// target fails here rather than silently shrinking every derived list.
const SUPPORTED_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
];

function sha256(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fakeTarget(expectedBytes: string) {
  return {
    node: {
      file: 'node-v24.0.0-fake.tar.gz',
      url: 'https://nodejs.invalid/dist/node-v24.0.0-fake.tar.gz',
      sha256: sha256(expectedBytes),
    },
  };
}

function responding(body: string, status = 200) {
  return vi.fn(async () => new Response(body, { status }));
}

describe('portable server Node.js pin', () => {
  it('pins an exact release of the Node.js major the repository supports', () => {
    expect(SUPPORTED_NODE_MAJOR).toBe(24);
    const runtime = readPortableNodeRuntime(repoRoot);
    expect(runtime.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Number(runtime.version.split('.')[0])).toBe(SUPPORTED_NODE_MAJOR);
    expect(runtime.origin).toBe(`https://nodejs.org/dist/v${runtime.version}/`);
  });

  it('resolves exactly the supported targets to their official distributions', () => {
    expect(Object.keys(PORTABLE_SERVER_TARGETS).sort()).toEqual(
      SUPPORTED_TARGETS,
    );
    const runtime = readPortableNodeRuntime(repoRoot);
    const official = {
      'darwin-arm64': 'darwin-arm64.tar.gz',
      'darwin-x64': 'darwin-x64.tar.gz',
      'linux-arm64': 'linux-arm64.tar.gz',
      'linux-x64': 'linux-x64.tar.gz',
      'win32-x64': 'win-x64.zip',
    };
    for (const id of SUPPORTED_TARGETS) {
      const [platform, arch] = id.split('-');
      const target = resolvePortableServerTarget(platform, arch, runtime);
      const windows = platform === 'win32';
      expect(target.archiveName).toBe(
        `station-server-${id}.${windows ? 'zip' : 'tar.gz'}`,
      );
      expect(target.node.file).toBe(
        `node-v${runtime.version}-${official[id as keyof typeof official]}`,
      );
      expect(target.node.url).toBe(
        `https://nodejs.org/dist/v${runtime.version}/${target.node.file}`,
      );
      expect(target.node.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(target.launcher.replaceAll('\\', '/')).toBe(
        windows ? 'bin/station.cmd' : 'bin/station',
      );
    }
    const digests = SUPPORTED_TARGETS.map(
      (id) => runtime.distributions[id].sha256,
    );
    expect(new Set(digests).size).toBe(digests.length);
  });

  it('refuses a host it has no archive definition or pinned runtime for', () => {
    const runtime = readPortableNodeRuntime(repoRoot);
    expect(() =>
      resolvePortableServerTarget('win32', 'arm64', runtime),
    ).toThrow(/No portable server archive is defined for win32-arm64/);
    const { 'linux-x64': _dropped, ...distributions } = runtime.distributions;
    expect(() =>
      resolvePortableServerTarget('linux', 'x64', {
        ...runtime,
        distributions,
      }),
    ).toThrow(/no pinned Node.js distribution for linux-x64/);
  });
});

describe('obtainNodeDistribution', () => {
  it('downloads the pinned distribution once and caches only verified bytes', async () => {
    const cacheDir = makeTempDir('portable-node-cache-');
    const fetchImpl = responding('official node bytes');
    const target = fakeTarget('official node bytes');
    const bytes = await obtainNodeDistribution(target, {
      cacheDir,
      fetchImpl,
    });
    expect(bytes.toString('utf8')).toBe('official node bytes');
    expect(readFileSync(join(cacheDir, target.node.file), 'utf8')).toBe(
      'official node bytes',
    );
    expect(fetchImpl).toHaveBeenCalledWith(target.node.url);
    const cached = await obtainNodeDistribution(target, {
      cacheDir,
      fetchImpl,
    });
    expect(cached.toString('utf8')).toBe('official node bytes');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects downloaded bytes that differ from the pin and caches nothing', async () => {
    const cacheDir = makeTempDir('portable-node-cache-');
    await expect(
      obtainNodeDistribution(fakeTarget('official node bytes'), {
        cacheDir,
        fetchImpl: responding('substituted bytes'),
      }),
    ).rejects.toThrow(/the pinned Node.js distribution is [0-9a-f]{64}/);
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  it('re-verifies a cached file instead of trusting the cache', async () => {
    const cacheDir = makeTempDir('portable-node-cache-');
    const target = fakeTarget('official node bytes');
    writeFileSync(join(cacheDir, target.node.file), 'tampered cache');
    const fetchImpl = responding('official node bytes');
    await expect(
      obtainNodeDistribution(target, { cacheDir, fetchImpl }),
    ).rejects.toThrow(/pinned Node.js distribution/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('verifies a caller-supplied distribution against the pin', async () => {
    const dir = makeTempDir('portable-node-supplied-');
    const supplied = join(dir, 'node.tar.gz');
    writeFileSync(supplied, 'some other node');
    const fetchImpl = responding('official node bytes');
    await expect(
      obtainNodeDistribution(fakeTarget('official node bytes'), {
        cacheDir: join(dir, 'cache'),
        nodeDistribution: supplied,
        fetchImpl,
      }),
    ).rejects.toThrow(/pinned Node.js distribution/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'cache'))).toBe(false);
  });

  it('fails on an HTTP error rather than caching a response body', async () => {
    const cacheDir = makeTempDir('portable-node-cache-');
    await expect(
      obtainNodeDistribution(fakeTarget('official node bytes'), {
        cacheDir,
        fetchImpl: responding('official node bytes', 404),
      }),
    ).rejects.toThrow(/failed with HTTP 404/);
    expect(readdirSync(cacheDir)).toEqual([]);
  });
});

describe('portable server archive workflow', () => {
  type Workflow = {
    on: Record<string, { branches?: string[]; paths?: string[] } | null>;
    permissions: Record<string, string>;
    jobs: {
      archive: {
        strategy: {
          matrix: {
            include: Array<{ runner: string; target: string; format: string }>;
          };
        };
      };
    };
  };
  const source = readFileSync(
    join(repoRoot, '.github/workflows/portable-server-archives.yml'),
    'utf8',
  );
  const workflow = load(source) as Workflow;

  it('builds and smokes every supported target in its archive format', () => {
    const include = workflow.jobs.archive.strategy.matrix.include;
    expect(include.map((entry) => entry.target).sort()).toEqual(
      SUPPORTED_TARGETS,
    );
    const runtime = readPortableNodeRuntime(repoRoot);
    for (const entry of include) {
      const [platform, arch] = entry.target.split('-');
      expect(entry.format).toBe(
        resolvePortableServerTarget(platform, arch, runtime).format,
      );
    }
  });

  it('stays a read-only packaging proof that publishes nothing', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(workflow.on).sort()).toEqual([
      'pull_request_target',
      'push',
      'workflow_dispatch',
    ]);
    expect(workflow.on.push).toMatchObject({ branches: ['main'] });
    expect(source).not.toMatch(
      /secrets\.|id-token|attest-build-provenance|gh release/,
    );
  });
});

describe('portable archive workflow paths filter', () => {
  const workflow = load(
    readFileSync(
      join(repoRoot, '.github/workflows/portable-server-archives.yml'),
      'utf8',
    ),
  ) as { on: Record<string, { paths?: string[] }> };
  const paths = workflow.on.pull_request_target?.paths ?? [];
  const covered = (file: string) =>
    paths.some((pattern) =>
      pattern.endsWith('/**')
        ? file.startsWith(pattern.slice(0, -2))
        : file === pattern,
    );

  /**
   * Repository files the builder and the smoke reach through relative
   * imports, followed transitively within scripts/ and the repository root
   * (esbuild.config.mjs runs as the server build; scripts/station-cli.ts is
   * the CLI the archive bundles). Imports into packages/ and src-server/ end
   * the walk: those trees are covered by prefix, or deliberately left to
   * ordinary CI (see the workflow's comment).
   */
  function localImportClosure(entries: string[]): string[] {
    const seen = new Set<string>();
    const visit = (file: string) => {
      const relativePath = relative(repoRoot, file).split(sep).join('/');
      if (seen.has(relativePath)) return;
      if (relativePath.includes('/') && !relativePath.startsWith('scripts/'))
        return;
      seen.add(relativePath);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(
        /(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g,
      )) {
        let target = resolve(dirname(file), match[1]);
        if (!existsSync(target) && target.endsWith('.js'))
          target = `${target.slice(0, -3)}.ts`;
        if (existsSync(target)) visit(target);
      }
    };
    for (const entry of entries) visit(join(repoRoot, entry));
    return [...seen].sort();
  }

  it('lists every local module the builder, the server build and the CLI bundle import', () => {
    const closure = localImportClosure([
      'scripts/build-portable-server-archive.mjs',
      'scripts/smoke-portable-server-archive.mjs',
      'esbuild.config.mjs',
      'scripts/station-cli.ts',
    ]);
    // Pinned so the walk itself cannot silently lose its reach.
    for (const known of [
      'esbuild.config.mjs',
      'scripts/lib/desktop-server-runtime.mjs',
      'scripts/lib/free-ports.mjs',
      'scripts/lib/portable-server-archive.mjs',
      'scripts/lib/server-build-config.mjs',
      'scripts/source-bootstrap.ts',
      'scripts/station-cli-implementation.ts',
    ]) {
      expect(closure).toContain(known);
    }
    expect(closure.filter((file) => !covered(file))).toEqual([]);
  });

  it('lists the inputs that shape an archive without being imported', () => {
    const required = [
      '.github/workflows/portable-server-archives.yml',
      '.nvmrc',
      'config/portable-server-node-runtime.json',
      'package.json',
      'packages/cli/src/cli.ts',
      'packaging/portable-server/bin/station.mjs',
      'patches/any.patch',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'schemas/app.schema.json',
    ];
    expect(required.filter((file) => !covered(file))).toEqual([]);
  });

  it('runs on main for exactly the paths it runs on for pull requests', () => {
    expect(workflow.on.push?.paths).toEqual(paths);
  });
});

describe('assertBuildSourceIsCheckout', () => {
  const HEAD = 'a'.repeat(40);
  const gitWith =
    (status: string) =>
    (args: string[]): string =>
      args[0] === 'rev-parse' ? `${HEAD}\n` : status;

  it('accepts the clean checked-out HEAD, in either case', () => {
    expect(() =>
      assertBuildSourceIsCheckout({
        sha: HEAD.toUpperCase(),
        git: gitWith(''),
      }),
    ).not.toThrow();
  });

  it('refuses a SHA other than HEAD', () => {
    expect(() =>
      assertBuildSourceIsCheckout({ sha: 'b'.repeat(40), git: gitWith('') }),
    ).toThrow(/is not the checked-out HEAD a{40}/);
  });

  it('refuses a working tree with uncommitted or untracked changes', () => {
    expect(() =>
      assertBuildSourceIsCheckout({
        sha: HEAD,
        git: gitWith(
          ' M scripts/lib/portable-server-archive.mjs\n?? new.txt\n',
        ),
      }),
    ).toThrow(/uncommitted changes[\s\S]*new\.txt/);
  });
});

describe('archive contract with the bundled CLI', () => {
  it('writes the prebuilt marker the CLI recognises', () => {
    expect(PREBUILT_ARCHIVE_MARKER).toEqual({
      name: PREBUILT_ARCHIVE_MARKER_FILENAME,
      content: PREBUILT_ARCHIVE_MARKER_CONTENT,
    });
  });

  it('bundles with exactly the reviewed options and drops the tsx shebang', async () => {
    const stageRoot = makeTempDir('portable-cli-bundle-');
    const outfile = join(stageRoot, 'lib', 'station-cli.mjs');
    const build = vi.fn(async (options: { outfile: string }) => {
      mkdirSync(dirname(options.outfile), { recursive: true });
      writeFileSync(
        options.outfile,
        '#!/usr/bin/env tsx\nexport const bundled = true;\n',
      );
    });
    await bundleStationCli(repoRoot, stageRoot, async () => ({ build }));
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0]?.[0]).toStrictEqual(
      stationCliBundleOptions(repoRoot, outfile),
    );
    expect(readFileSync(outfile, 'utf8')).toBe(
      'export const bundled = true;\n',
    );
  });

  it('never minifies the CLI bundle', () => {
    // lifecycle.ts runs `uiRequestHandler.toString()` in a separate `node -e`
    // UI server that shims only esbuild's unminified `__name` helper; a
    // minified bundle kills that server ("Timed out waiting for
    // .../__station/identity").
    const options = stationCliBundleOptions(repoRoot, '/tmp/station-cli.mjs');
    for (const flag of [
      'minify',
      'minifyIdentifiers',
      'minifySyntax',
      'minifyWhitespace',
    ]) {
      expect(options).not.toHaveProperty(flag);
    }
    expect(options.entryPoints).toEqual([
      join(repoRoot, 'scripts', 'station-cli.ts'),
    ]);
  });
});
