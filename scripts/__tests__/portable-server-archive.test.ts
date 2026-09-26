import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  obtainNodeDistribution,
  PORTABLE_SERVER_TARGETS,
  readPortableNodeRuntime,
  resolvePortableServerTarget,
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
    const path = await obtainNodeDistribution(target, { cacheDir, fetchImpl });
    expect(path).toBe(join(cacheDir, target.node.file));
    expect(readFileSync(path, 'utf8')).toBe('official node bytes');
    expect(fetchImpl).toHaveBeenCalledWith(target.node.url);
    await obtainNodeDistribution(target, { cacheDir, fetchImpl });
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
    on: Record<string, unknown>;
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
      'workflow_dispatch',
    ]);
    expect(source).not.toMatch(
      /secrets\.|id-token|attest-build-provenance|gh release/,
    );
  });
});
