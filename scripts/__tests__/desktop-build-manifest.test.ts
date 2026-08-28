import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { npmBuildInvocation } from '../lib/desktop-build-command.mjs';
import {
  BUILD_MANIFEST_FILENAME,
  deriveBuildManifest,
  deriveServerBuildIdentity,
  readPackagedReleaseManifest,
  writeDesktopBuildManifest,
} from '../lib/desktop-build-manifest.mjs';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'station-desktop-manifest-'));
  roots.push(root);
  mkdirSync(join(root, 'dist-server'), { recursive: true });
  return root;
}

function makeGitCheckout(root: string): void {
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Station Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Station Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
      } as NodeJS.ProcessEnv,
    });
  git('init', '--initial-branch=release-lane');
  writeFileSync(join(root, 'README.md'), 'station');
  git('add', 'README.md');
  git('commit', '-m', 'initial');
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

const RELEASE_SHA = 'abcdef0123456789abcdef0123456789abcdef01';

describe('desktop build manifest', () => {
  test('derives sha and branch from the checkout the desktop app is built from', () => {
    const root = makeRoot();
    makeGitCheckout(root);

    const manifest = deriveBuildManifest(root, {
      builtAt: '2026-07-10T18:00:00.000Z',
      env: {},
    });

    expect(manifest?.branch).toBe('release-lane');
    expect(manifest?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest?.builtAt).toBe('2026-07-10T18:00:00.000Z');
  });

  test('STATION_BUILD_BRANCH names the source branch of a detached checkout', () => {
    const root = makeRoot();
    makeGitCheckout(root);

    expect(
      deriveBuildManifest(root, {
        env: { STATION_BUILD_BRANCH: 'main' },
      })?.branch,
    ).toBe('main');
  });

  test('falls back to a packaged release manifest when there is no checkout', () => {
    const root = makeRoot();
    writeFileSync(
      join(root, '.station-release.json'),
      JSON.stringify({
        schemaVersion: 1,
        sha: RELEASE_SHA,
        ref: 'v1.2.3',
        createdAt: '2026-07-10T18:00:00.000Z',
        channel: 'stable',
        prerelease: false,
      }),
    );

    expect(
      deriveBuildManifest(root, {
        builtAt: '2026-07-11T00:00:00.000Z',
        env: {},
      }),
    ).toEqual({
      sha: RELEASE_SHA,
      branch: 'v1.2.3',
      builtAt: '2026-07-11T00:00:00.000Z',
    });
  });

  test('an unusable release manifest is absent rather than trusted', () => {
    const root = makeRoot();
    const path = join(root, '.station-release.json');

    writeFileSync(path, 'not json');
    expect(readPackagedReleaseManifest(root)).toBeNull();

    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 2, sha: RELEASE_SHA, ref: 'v1.2.3' }),
    );
    expect(readPackagedReleaseManifest(root)).toBeNull();

    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 1, sha: 'not-a-sha', ref: 'v1.2.3' }),
    );
    expect(readPackagedReleaseManifest(root)).toBeNull();

    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 1, sha: RELEASE_SHA, ref: '  ' }),
    );
    expect(readPackagedReleaseManifest(root)).toBeNull();
  });

  test('no checkout and no release manifest degrades instead of failing the build', () => {
    const root = makeRoot();

    expect(deriveBuildManifest(root, { env: {} })).toBeNull();
    expect(writeDesktopBuildManifest(root, { env: {} })).toBeNull();
  });

  test('writes the manifest beside the bundled server in the CLI shape', () => {
    const root = makeRoot();
    makeGitCheckout(root);

    const manifestPath = writeDesktopBuildManifest(root, {
      builtAt: '2026-07-10T18:00:00.000Z',
      env: {},
    });

    expect(manifestPath).toBe(
      join(root, 'dist-server', BUILD_MANIFEST_FILENAME),
    );
    const written = JSON.parse(
      readFileSync(manifestPath as string, 'utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(['branch', 'builtAt', 'sha']);
    expect(written.branch).toBe('release-lane');
    expect(written.builtAt).toBe('2026-07-10T18:00:00.000Z');
  });

  test('refuses to write when the server bundle it should describe is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-desktop-manifest-'));
    roots.push(root);

    expect(() => writeDesktopBuildManifest(root, { env: {} })).toThrow(
      /does not exist/,
    );
  });

  test('the desktop resource step writes the manifest before staging', () => {
    // The whole fix is inert if nothing runs the writer: Tauri's
    // beforeBuildCommand for every desktop target is this npm script.
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    const step = pkg.scripts['build:desktop:resources'];

    expect(step).toContain('node scripts/write-desktop-build-manifest.mjs');
    expect(step.indexOf('npm run build')).toBeLessThan(
      step.indexOf('write-desktop-build-manifest'),
    );

    for (const platform of ['macos', 'linux', 'windows']) {
      const config = JSON.parse(
        readFileSync(
          new URL(
            `../../src-desktop/tauri.${platform}.conf.json`,
            import.meta.url,
          ),
          'utf8',
        ),
      ) as {
        build: { beforeBuildCommand: string };
        bundle: { resources: Record<string, string> };
      };
      expect(config.build.beforeBuildCommand).toBe(
        'npm run build:desktop:resources',
      );
      // The manifest ships only because dist-server itself is a bundled
      // resource; drop that mapping and the packaged app loses provenance.
      expect(config.bundle.resources['../dist-server']).toBe('dist-server');
    }
  });

  test('the desktop package command enters src-desktop before invoking Tauri', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(pkg.scripts.tauri).toBe('cd src-desktop && tauri');
    expect(pkg.scripts['build:desktop']).toBe(
      'npm run product-version:check && node scripts/build-desktop.mjs',
    );
    const wrapper = readFileSync(
      new URL('../build-desktop.mjs', import.meta.url),
      'utf8',
    );
    expect(wrapper).toContain('...process.argv.slice(2)');
    expect(wrapper.match(/run\(tauriBuildArgs\)/g)).toHaveLength(1);
    // The Windows branch hands the staged resource config to the CLI as a
    // --config argument. The Tauri v2 CLI never reads TAURI_CONFIG as input
    // (it only sets it for tauri-build/codegen), so an env-var assignment
    // here would silently ship the deep runtime paths again (station#2424).
    expect(wrapper).toContain(
      "run([...tauriBuildArgs, '--config', configPath])",
    );
    expect(wrapper).not.toMatch(/TAURI_CONFIG:/);
    expect(wrapper).toContain('build:desktop:resources');
    expect(wrapper).toContain('shell: false');
    expect(wrapper).toContain('windowsHide: true');
  });

  test('forwards desktop build arguments to Tauri unchanged outside Windows', () => {
    const bin = mkdtempSync(join(tmpdir(), 'station-fake-npm-'));
    roots.push(bin);
    const capturedArgs = join(bin, 'tauri-args.json');
    const fakeNpm = join(bin, 'npm');
    writeFileSync(
      fakeNpm,
      `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.STATION_CAPTURED_TAURI_ARGS, JSON.stringify(process.argv.slice(2)));\n`,
    );
    chmodSync(fakeNpm, 0o755);

    const requestedArgs = [
      '--bundles',
      'app',
      '--target',
      'aarch64-apple-darwin',
    ];
    const result = spawnSync(
      process.execPath,
      [
        new URL('../build-desktop.mjs', import.meta.url).pathname,
        ...requestedArgs,
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
          STATION_CAPTURED_TAURI_ARGS: capturedArgs,
        },
      },
    );

    expect(result.status, result.stderr.toString()).toBe(0);
    expect(JSON.parse(readFileSync(capturedArgs, 'utf8'))).toEqual([
      'run',
      'tauri',
      '--',
      'build',
      ...requestedArgs,
    ]);
  });

  test('forwards Windows arguments through npm-cli as inert argv elements', () => {
    const root = makeRoot();
    const npmCli = join(root, 'npm-cli.js');
    writeFileSync(npmCli, 'console.log("fake npm");');
    const requestedArgs = [
      '--bundles',
      'app&whoami',
      '--target',
      'x86_64-pc-windows-msvc & echo injected',
    ];

    const invocation = npmBuildInvocation(
      ['run', 'tauri', '--', 'build', ...requestedArgs],
      {
        platform: 'win32',
        npmExecPath: npmCli,
        nodeExecutable: '/fake/node.exe',
      },
    );

    expect(invocation).toEqual({
      command: '/fake/node.exe',
      args: [npmCli, 'run', 'tauri', '--', 'build', ...requestedArgs],
    });
  });

  test('fails Windows command selection closed without an absolute npm-cli file', () => {
    const root = makeRoot();
    const directory = join(root, 'npm-cli.js');
    mkdirSync(directory);

    for (const npmExecPath of ['', 'npm-cli.js', directory]) {
      expect(() =>
        npmBuildInvocation(['run', 'tauri'], {
          platform: 'win32',
          npmExecPath,
        }),
      ).toThrow(/absolute npm-cli\.js file/);
    }
  });
});

// station#1985: the server's build-time baked identity fallback
// (`deriveServerBuildIdentity`), read at runtime as an esbuild banner
// global. Reuses `deriveBuildManifest`'s git plumbing/fixtures above
// for sha/builtAt; `channel` and `dirty` are new independent fields.
describe('deriveServerBuildIdentity', () => {
  test('dirty is false for a clean git checkout', () => {
    const root = makeRoot();
    makeGitCheckout(root);

    const identity = deriveServerBuildIdentity(root, {
      builtAt: '2026-07-10T18:00:00.000Z',
      env: {},
    });

    expect(identity?.dirty).toBe(false);
    expect(identity?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(identity?.builtAt).toBe('2026-07-10T18:00:00.000Z');
  });

  test('dirty is true when the checkout has an uncommitted change', () => {
    const root = makeRoot();
    makeGitCheckout(root);
    writeFileSync(join(root, 'README.md'), 'station (modified)');

    const identity = deriveServerBuildIdentity(root, { env: {} });

    expect(identity?.dirty).toBe(true);
  });

  test('channel is baked from STATION_CHANNEL when set at build time', () => {
    const root = makeRoot();
    makeGitCheckout(root);

    const identity = deriveServerBuildIdentity(root, {
      env: { STATION_CHANNEL: 'preview' },
    });

    expect(identity?.channel).toBe('preview');
  });

  test('channel is source-checkout when STATION_CHANNEL is unset at build time', () => {
    const root = makeRoot();
    makeGitCheckout(root);

    const identity = deriveServerBuildIdentity(root, { env: {} });

    expect(identity?.channel).toBe('source-checkout');
  });

  test('no checkout and no release manifest still computes channel/dirty independently of sha/builtAt', () => {
    const root = makeRoot();

    const identity = deriveServerBuildIdentity(root, {
      env: { STATION_CHANNEL: 'stable' },
    });

    expect(identity?.sha).toBeUndefined();
    expect(identity?.builtAt).toBeUndefined();
    expect(identity?.dirty).toBeUndefined();
    expect(identity?.channel).toBe('stable');
  });

  test('every field undetermined returns null rather than an empty object', () => {
    const root = makeRoot();

    expect(deriveServerBuildIdentity(root, { env: {} })).toBeNull();
  });
});
