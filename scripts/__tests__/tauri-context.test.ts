import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import {
  cargoDependencyVersion,
  collectFindings,
  exactSemver,
  extractDocumentationSection,
  mergeJsonPatch,
  TAURI_CONTEXT_USAGE,
} from '../tauri-context.mjs';

describe('tauri context', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const makeTempDir = trackTempDirs();
  function reportFor(contextRoot = root, env = process.env) {
    const result = spawnSyncBounded(
      process.execPath,
      [
        fileURLToPath(new URL('../tauri-context.mjs', import.meta.url)),
        '--json',
        '--platform',
        'windows',
        '--root',
        contextRoot,
      ],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true, env },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  }

  test.skipIf(process.platform !== 'win32')(
    'reports versions from the real installed npm and local Tauri CLIs on Windows',
    () => {
      const report = reportFor();
      const tauri = JSON.parse(
        readFileSync(
          join(root, 'node_modules/@tauri-apps/cli/package.json'),
          'utf8',
        ),
      );
      expect(report.checks.npm.status).toBe('checked');
      expect(report.checks.npm.value).toMatch(/^\d+\.\d+\.\d+$/);
      expect(report.checks.tauriCli.status).toBe('checked');
      expect(report.checks.tauriCli.value).toBe(`tauri-cli ${tauri.version}`);
    },
  );

  test.skipIf(process.platform !== 'win32')(
    'reports a failed npm probe when its configured JS entry is missing',
    () => {
      const directory = makeTempDir('station-tauri-npm-');
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === 'npm_execpath') delete env[key];
      }
      env.npm_execpath = join(directory, 'missing', 'npm-cli.js');
      const report = reportFor(root, env);
      expect(report.checks.npm.status).toBe('failed');
      expect(report.checks.npm.reason).toContain('cannot resolve npm CLI');
      expect(report.checks.npm.value).toBeUndefined();
      expect(report.findings).toContainEqual(
        expect.objectContaining({ code: 'check-failed-npm' }),
      );
    },
  );

  test.skipIf(process.platform !== 'win32')(
    'reports a missing local Tauri CLI even when Node is available',
    () => {
      const directory = makeTempDir('station-tauri-missing cli-');
      for (const path of [
        'package.json',
        'pnpm-lock.yaml',
        'src-desktop/Cargo.toml',
        'src-desktop/tauri.conf.json',
        'src-desktop/tauri.windows.conf.json',
      ]) {
        const destination = join(directory, path);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(join(root, path), destination);
      }
      mkdirSync(join(directory, 'src-desktop/capabilities'), {
        recursive: true,
      });
      const report = reportFor(directory);
      expect(report.checks.node.status).toBe('checked');
      expect(report.checks.tauriCli.status).toBe('skipped');
      expect(report.checks.tauriCli.reason).toBe('command-not-found');
      expect(report.checks.tauriCli.value).toBeUndefined();
    },
  );

  test.each(['--help', '-h'])(
    '%s prints usage and exits without a report',
    (flag) => {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('../tauri-context.mjs', import.meta.url)), flag],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      // Exactly the usage text: no host report was printed.
      expect(result.stdout).toBe(TAURI_CONTEXT_USAGE);
    },
  );

  test('applies RFC 7396 configuration overlays without mutating the base', () => {
    const base = {
      app: { windows: [{ title: 'Station' }], security: { csp: 'base' } },
      bundle: { active: true, targets: 'all' },
    };
    const merged = mergeJsonPatch(base, {
      app: { security: { csp: 'mobile' } },
      bundle: { targets: null },
    });

    expect(merged).toEqual({
      app: { windows: [{ title: 'Station' }], security: { csp: 'mobile' } },
      bundle: { active: true },
    });
    expect(base.bundle.targets).toBe('all');
  });

  test('reads exact and object Cargo dependency versions', () => {
    const cargo = [
      'tauri = { version = "=2.11.5", features = [] }',
      'tauri-build = "2.6.3"',
    ].join('\n');

    expect(cargoDependencyVersion(cargo, 'tauri')).toBe('=2.11.5');
    expect(cargoDependencyVersion(cargo, 'tauri-build')).toBe('2.6.3');
    expect(exactSemver(cargoDependencyVersion(cargo, 'tauri'))).toBe('2.11.5');
  });

  test('extracts one bounded model-readable documentation topic', () => {
    const source = [
      '<SYSTEM>Guides</SYSTEM>',
      '# Debug',
      'debug body',
      '# Tests',
      'test body',
    ].join('\n');

    expect(extractDocumentationSection(source, 'Debug', 1_000)).toEqual({
      content: '# Debug\ndebug body',
      truncated: false,
    });
    expect(extractDocumentationSection(source, 'Debug', 10)).toEqual({
      content: '# Debug\nde\n\n[TRUNCATED at 10 characters]',
      truncated: true,
    });
  });

  test('fails when an upstream documentation heading disappears', () => {
    expect(() => extractDocumentationSection('# Tests\nbody', 'Debug')).toThrow(
      'Documentation heading not found: Debug',
    );
  });

  test('accepts independent patch releases and reports an offline device', () => {
    const findings = collectFindings({
      versions: { rust: { tauri: '=2.11.5' } },
      checks: {
        tauriCli: {
          id: 'tauri-cli',
          status: 'checked',
          value: 'tauri-cli 2.11.4',
        },
        rustTargets: {
          id: 'rust-targets',
          status: 'checked',
          value: [
            'aarch64-apple-ios',
            'aarch64-apple-ios-sim',
            'aarch64-linux-android',
            'armv7-linux-androideabi',
            'i686-linux-android',
            'x86_64-linux-android',
          ],
        },
        adb: {
          id: 'adb',
          status: 'checked',
          value: [
            { serial: 'pixel-live', state: 'device', details: '' },
            { serial: 'pixel-stale', state: 'offline', details: '' },
          ],
        },
      },
      generated: {
        android: { path: 'src-desktop/gen/android', dirtyPaths: [] },
        ios: { path: 'src-desktop/gen/apple', dirtyPaths: [] },
      },
    });

    expect(findings.map((finding) => finding.code)).toEqual([
      'android-device-not-ready',
    ]);
  });

  test('reports Tauri CLI and core release-line skew', () => {
    const findings = collectFindings({
      versions: { rust: { tauri: '=2.11.5' } },
      checks: {
        tauriCli: {
          id: 'tauri-cli',
          status: 'checked',
          value: 'tauri-cli 2.10.9',
        },
        rustTargets: {
          id: 'rust-targets',
          status: 'checked',
          value: [
            'aarch64-apple-ios',
            'aarch64-apple-ios-sim',
            'aarch64-linux-android',
            'armv7-linux-androideabi',
            'i686-linux-android',
            'x86_64-linux-android',
          ],
        },
        adb: { id: 'adb', status: 'checked', value: [] },
      },
      generated: {
        android: { path: 'src-desktop/gen/android', dirtyPaths: [] },
        ios: { path: 'src-desktop/gen/apple', dirtyPaths: [] },
      },
    });

    expect(findings).toEqual([
      expect.objectContaining({ code: 'tauri-cli-core-release-line-skew' }),
    ]);
  });
});
