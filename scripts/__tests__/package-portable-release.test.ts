import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/package-portable-release.sh');
const CREATED_AT = '2026-07-22T12:34:56.000Z';
const roots: string[] = [];
const REPOSITORY_LOCAL_GIT_ENV_KEYS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function isolatedGitEnvironment(
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...inheritedEnvironment };
  for (const key of REPOSITORY_LOCAL_GIT_ENV_KEYS) {
    delete environment[key];
  }
  return environment;
}

function run(
  command: string,
  args: string[],
  cwd: string,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: isolatedGitEnvironment(inheritedEnvironment),
  }).trim();
}

function createFixture(
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): string {
  const root = mkdtempSync(join(tmpdir(), 'station-portable-release-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'));
  copyFileSync(SCRIPT, join(root, 'scripts/package-portable-release.sh'));
  chmodSync(join(root, 'scripts/package-portable-release.sh'), 0o755);
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(join(root, 'tracked.txt'), 'portable\n');
  writeFileSync(join(root, 'untracked-secret.txt'), 'do not ship\n');
  run('git', ['init', '-q'], root, inheritedEnvironment);
  run(
    'git',
    ['config', 'user.name', 'Station Tests'],
    root,
    inheritedEnvironment,
  );
  run(
    'git',
    ['config', 'user.email', 'station@example.invalid'],
    root,
    inheritedEnvironment,
  );
  run(
    'git',
    ['add', 'package.json', 'scripts', 'tracked.txt'],
    root,
    inheritedEnvironment,
  );
  run('git', ['commit', '-qm', 'fixture'], root, inheritedEnvironment);
  return root;
}

function packageFixture(
  root: string,
  outputName: string,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
  ref = 'v0.1.0',
): string {
  const output = join(root, outputName);
  execFileSync(
    'bash',
    [
      join(root, 'scripts/package-portable-release.sh'),
      '--output-dir',
      output,
      '--ref',
      ref,
      '--sha',
      run('git', ['rev-parse', 'HEAD'], root, inheritedEnvironment),
      '--created-at',
      CREATED_AT,
    ],
    {
      cwd: root,
      env: isolatedGitEnvironment(inheritedEnvironment),
    },
  );
  return output;
}

// #1019: these cases spawn real git/node subprocesses; under parallel
// workers or a sibling session the 5s default budget starves. Cap, not
// expectation.
describe('portable release packager', { timeout: 30_000 }, () => {
  it('isolates nested repositories from inherited Git hook state', () => {
    const outerRoot = mkdtempSync(join(tmpdir(), 'station-outer-repository-'));
    roots.push(outerRoot);
    writeFileSync(join(outerRoot, 'outer.txt'), 'unchanged\n');
    run('git', ['init', '-q'], outerRoot);
    run('git', ['config', 'user.name', 'Station Tests'], outerRoot);
    run('git', ['config', 'user.email', 'station@example.invalid'], outerRoot);
    run('git', ['add', 'outer.txt'], outerRoot);
    run('git', ['commit', '-qm', 'outer'], outerRoot);
    const outerHead = run('git', ['rev-parse', 'HEAD'], outerRoot);

    const inheritedEnvironment = {
      ...process.env,
      GIT_DIR: join(outerRoot, '.git'),
      GIT_WORK_TREE: outerRoot,
      GIT_INDEX_FILE: join(outerRoot, '.git', 'index'),
    };
    const fixtureRoot = createFixture(inheritedEnvironment);
    packageFixture(fixtureRoot, 'release', inheritedEnvironment);

    expect(run('git', ['rev-parse', '--show-toplevel'], fixtureRoot)).toBe(
      realpathSync(fixtureRoot),
    );
    expect(run('git', ['rev-parse', 'HEAD'], outerRoot)).toBe(outerHead);
    expect(run('git', ['status', '--porcelain'], outerRoot)).toBe('');
  });

  it('creates a deterministic preview manifest and embedded preview provenance', () => {
    const root = createFixture();
    const output = packageFixture(
      root,
      'release-preview',
      process.env,
      'v0.2.0-preview.3',
    );
    const ring = JSON.parse(
      readFileSync(join(output, 'station-release-ring-preview.json'), 'utf8'),
    );
    expect(ring).toMatchObject({
      schemaVersion: 1,
      channel: 'preview',
      prerelease: true,
      ref: 'v0.2.0-preview.3',
      sha: run('git', ['rev-parse', 'HEAD'], root),
      createdAt: CREATED_AT,
    });
    const embedded = JSON.parse(
      execFileSync(
        'tar',
        [
          '-xOzf',
          join(output, 'station-portable.tar.gz'),
          'station/.station-release.json',
        ],
        { encoding: 'utf8' },
      ),
    );
    expect(embedded).toMatchObject({
      schemaVersion: 2,
      channel: 'beta',
      releaseChannel: 'preview',
      prerelease: true,
      ref: 'v0.2.0-preview.3',
    });
  });

  it('creates deterministic tracked-only bytes with exact provenance and checksum', () => {
    const root = createFixture();
    const first = packageFixture(root, 'release-a');
    const second = packageFixture(root, 'release-b');
    const firstArchive = join(first, 'station-portable.tar.gz');
    const secondArchive = join(second, 'station-portable.tar.gz');
    const firstBytes = readFileSync(firstArchive);

    expect(firstBytes.equals(readFileSync(secondArchive))).toBe(true);
    const entries = run('tar', ['-tzf', firstArchive], root).split('\n');
    expect(entries).toContain('station/.station-release.json');
    expect(entries).toContain('station/tracked.txt');
    expect(entries).not.toContain('station/untracked-secret.txt');
    expect(entries.every((entry) => entry.startsWith('station/'))).toBe(true);

    const manifest = JSON.parse(
      execFileSync(
        'tar',
        ['-xOzf', firstArchive, 'station/.station-release.json'],
        {
          cwd: root,
          encoding: 'utf8',
        },
      ),
    );
    expect(manifest).toEqual({
      schemaVersion: 2,
      sha: run('git', ['rev-parse', 'HEAD'], root),
      ref: 'v0.1.0',
      createdAt: CREATED_AT,
      channel: 'stable',
      releaseChannel: 'stable',
      prerelease: false,
    });
    expect(Object.keys(manifest)).toEqual([
      'schemaVersion',
      'sha',
      'ref',
      'createdAt',
      'channel',
      'releaseChannel',
      'prerelease',
    ]);

    const checksum = createHash('sha256').update(firstBytes).digest('hex');
    expect(readFileSync(`${firstArchive}.sha256`, 'utf8').trim()).toBe(
      `${checksum}  ${basename(firstArchive)}`,
    );

    const ring = JSON.parse(
      readFileSync(join(first, 'station-release-ring-stable.json'), 'utf8'),
    );
    expect(Object.keys(ring)).toEqual([
      'schemaVersion',
      'channel',
      'prerelease',
      'ref',
      'sha',
      'createdAt',
      'archive',
      'checksum',
    ]);
    expect(ring).toMatchObject({
      schemaVersion: 1,
      channel: 'stable',
      prerelease: false,
      ref: 'v0.1.0',
      sha: manifest.sha,
      createdAt: CREATED_AT,
      archive: { name: 'station-portable.tar.gz', sha256: checksum },
    });
    expect(ring.checksum).toEqual({
      name: 'station-portable.tar.gz.sha256',
      sha256: createHash('sha256')
        .update(readFileSync(`${firstArchive}.sha256`))
        .digest('hex'),
    });
  });

  it('creates a staging-only portable manifest without a release-ring claim', () => {
    const root = createFixture();
    const output = packageFixture(
      root,
      'nightly-stage',
      process.env,
      'nightly-2026-08-30-1',
    );
    expect(() =>
      readFileSync(join(output, 'station-release-ring-stable.json')),
    ).toThrow();
    const manifest = JSON.parse(
      readFileSync(
        join(output, 'station-nightly-portable-manifest.json'),
        'utf8',
      ),
    );
    expect(manifest).toMatchObject({
      channel: 'nightly-staging',
      prerelease: true,
      ref: 'nightly-2026-08-30-1',
      sha: run('git', ['rev-parse', 'HEAD'], root),
    });
    expect(manifest).not.toHaveProperty('available');
    const embedded = JSON.parse(
      execFileSync(
        'tar',
        [
          '-xOzf',
          join(output, 'station-nightly-portable.tar.gz'),
          'station/.station-release.json',
        ],
        { encoding: 'utf8' },
      ),
    );
    expect(embedded).toMatchObject({
      channel: 'nightly-staging',
      releaseChannel: 'nightly-staging',
      sha: manifest.sha,
    });
  });

  it('resolves a relative output directory before entering its temp directory', () => {
    const root = createFixture();
    execFileSync(
      'bash',
      [
        join(root, 'scripts/package-portable-release.sh'),
        '--output-dir',
        'fleet-assets',
        '--ref',
        'nightly-2026-08-30-1',
        '--sha',
        run('git', ['rev-parse', 'HEAD'], root),
        '--created-at',
        CREATED_AT,
      ],
      { cwd: root, env: isolatedGitEnvironment(process.env) },
    );
    expect(
      readFileSync(
        join(root, 'fleet-assets', 'station-nightly-portable.tar.gz'),
      ).length,
    ).toBeGreaterThan(0);
  });

  it('rejects tracked symlinks before publishing an installer-incompatible archive', () => {
    const root = createFixture();
    symlinkSync('tracked.txt', join(root, 'tracked-link'));
    run('git', ['add', 'tracked-link'], root);
    run('git', ['commit', '-qm', 'add tracked symlink'], root);

    expect(() => packageFixture(root, 'release-with-link')).toThrow();
  });

  it.each(['v01.2.3', 'v1.02.3', 'v1.2.03', 'v1.2.3-preview.0', 'main'])(
    'rejects non-ring tag %s',
    (ref) => {
      const root = createFixture();
      expect(() =>
        execFileSync('bash', [
          join(root, 'scripts/package-portable-release.sh'),
          '--output-dir',
          join(root, 'release'),
          '--ref',
          ref,
          '--sha',
          run('git', ['rev-parse', 'HEAD'], root),
        ]),
      ).toThrow();
    },
  );
});
