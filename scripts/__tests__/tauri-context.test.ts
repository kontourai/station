import { describe, expect, test } from 'vitest';
import {
  cargoDependencyVersion,
  collectFindings,
  exactSemver,
  extractDocumentationSection,
  mergeJsonPatch,
  parseArgs,
  TAURI_CONTEXT_USAGE,
} from '../tauri-context.mjs';

describe('tauri context', () => {
  test('offers discoverable help without collecting host state', () => {
    expect(parseArgs(['--help'])).toEqual(
      expect.objectContaining({ help: true }),
    );
    expect(parseArgs(['-h'])).toEqual(expect.objectContaining({ help: true }));
    expect(TAURI_CONTEXT_USAGE).toContain(
      '--platform <all|macos|windows|linux|android|ios>',
    );
    expect(TAURI_CONTEXT_USAGE).toContain('--list-topics');
  });

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
