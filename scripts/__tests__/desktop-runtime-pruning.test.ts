import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { stageDesktopServerRuntime } from '../lib/desktop-server-runtime.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const makeTempDir = trackTempDirs();
const execFileAsync = promisify(execFile);

function writeFixturePackage(
  path: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify(manifest));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), content);
  }
}

describe('desktop runtime pruning', () => {
  it('stages the installed RxJS Node exports without browser builds or TypeScript sources', async () => {
    const output = join(makeTempDir('station-runtime-rxjs-'), 'release');
    stageDesktopServerRuntime({
      projectRoot: repoRoot,
      outputRoot: output,
      packages: ['rxjs'],
    });
    const probe = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { createRequire } from 'node:module';
import { of, lastValueFrom } from 'rxjs';
import { map, toArray } from 'rxjs/operators';
const require = createRequire(import.meta.url);
const { TestScheduler } = require('rxjs/testing');
const { Observable } = require('rxjs/internal/Observable');
const scheduler = new TestScheduler((actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('marbles differ');
});
scheduler.run(({cold, expectObservable}) => {
  expectObservable(cold('-a|', {a: 3}).pipe(map(x => x * 2))).toBe('-b|', {b: 6});
});
console.log(JSON.stringify({values: await lastValueFrom(of(1, 2, 3).pipe(map(x => x * 2), toArray())), sharedIdentity: Observable === require('rxjs').Observable}));`,
      ],
      { cwd: output, windowsHide: true, timeout: 10_000 },
    );
    expect(JSON.parse(probe.stdout)).toEqual({
      values: [2, 4, 6],
      sharedIdentity: true,
    });
    const rxjs = join(output, 'node_modules/rxjs');
    expect(readFileSync(join(rxjs, 'LICENSE.txt'), 'utf8')).toContain(
      'Apache License',
    );
    for (const omitted of ['src', 'dist/esm', 'dist/esm5', 'dist/bundles'])
      expect(existsSync(join(rxjs, omitted))).toBe(false);
  });

  it('stages only the pinned Node target node-pty prebuilds (node-pty-foreign-prebuilds)', () => {
    const root = makeTempDir('station-runtime-pty-');
    const project = join(root, 'project');
    const files: Record<string, string> = {
      'lib/utils.js': 'module.exports = {};',
      'build/Release/pty.node': 'source build',
      LICENSE: 'MIT',
    };
    for (const prebuild of [
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'win32-arm64',
      'win32-x64',
    ]) {
      files[`prebuilds/${prebuild}/pty.node`] = prebuild;
    }
    writeFixturePackage(
      join(project, 'node_modules/node-pty'),
      { name: 'node-pty', version: '1.1.0' },
      files,
    );
    // A different package with the same layout is not node-pty's to prune.
    writeFixturePackage(
      join(project, 'node_modules/other-native'),
      { name: 'other-native', version: '1.0.0' },
      { 'prebuilds/darwin-x64/addon.node': 'other' },
    );
    for (const [platform, arch] of [
      ['win32', 'x64'],
      ['linux', 'x64'],
      ['darwin', 'arm64'],
    ] as const) {
      const output = join(root, `release-${platform}-${arch}`);
      stageDesktopServerRuntime({
        projectRoot: project,
        outputRoot: output,
        packages: ['node-pty', 'other-native'],
        platform,
        arch,
      });
      const pty = join(output, 'node_modules/node-pty');
      const kept = readdirSync(join(pty, 'prebuilds'));
      expect(kept).toEqual([`${platform}-${arch}`]);
      expect(existsSync(join(pty, 'build/Release/pty.node'))).toBe(true);
      expect(existsSync(join(pty, 'lib/utils.js'))).toBe(true);
      expect(existsSync(join(pty, 'LICENSE'))).toBe(true);
      expect(
        existsSync(
          join(
            output,
            'node_modules/other-native/prebuilds/darwin-x64/addon.node',
          ),
        ),
      ).toBe(true);
    }
  });
});
