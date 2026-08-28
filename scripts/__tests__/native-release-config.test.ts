import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  assertRepositoryVersion,
  createNativeReleaseConfig,
  NATIVE_UPDATER_ARTIFACT_MODE,
  nativeIdentifierForChannel,
  nativeProductNameForChannel,
  nativeReleaseChannel,
  nativeVersionFromTag,
  repositoryVersionForTag,
  taggedStoreIdentity,
} from '../lib/native-release-config.mjs';

describe('native release configuration', () => {
  test.each([
    ['v1.2.3', '1.2.3'],
    ['v1.2.3-preview.4', '1.2.3-preview.4'],
    ['v0.0.0', '0.0.0'],
  ])('binds %s to the package version %s', (tag, version) => {
    expect(nativeVersionFromTag(tag)).toBe(version);
  });

  test.each(['1.2.3', 'v01.2.3', 'v1.2', 'v1.2.3-preview.0'])(
    'rejects malformed tag %s',
    (tag) => {
      expect(() => nativeVersionFromTag(tag)).toThrow(
        'Invalid native release configuration',
      );
    },
  );

  test('creates a version-only mobile overlay with store build numbers', () => {
    expect(createNativeReleaseConfig({ tag: 'v2.3.4' })).toEqual({
      version: '2.3.4',
      bundle: {
        android: { versionCode: 20_030_499 },
        iOS: { bundleVersion: '20030499' },
        macOS: { bundleVersion: '20030499' },
      },
    });
  });

  test('derives beta package identity only for desktop and Android overlays', () => {
    expect(nativeReleaseChannel('v2.3.4-preview.5')).toBe('beta');
    expect(nativeReleaseChannel('v2.3.4')).toBe('stable');
    expect(nativeIdentifierForChannel('beta')).toBe(
      'io.kontourai.station.beta',
    );
    expect(nativeProductNameForChannel('stable')).toBe('Station');
    expect(nativeProductNameForChannel('beta')).toBe('Station Beta');
    expect(
      createNativeReleaseConfig({
        tag: 'v2.3.4-preview.5',
        channelIdentity: true,
      }),
    ).toMatchObject({
      identifier: 'io.kontourai.station.beta',
      productName: 'Station Beta',
    });
    expect(
      createNativeReleaseConfig({ tag: 'v2.3.4-preview.5' }),
    ).not.toHaveProperty('identifier');
  });

  test('keeps Preview marketing SemVer while assigning its macOS numeric build number', () => {
    expect(
      createNativeReleaseConfig({
        tag: 'v2.3.4-preview.5',
        channelIdentity: true,
      }),
    ).toMatchObject({
      version: '2.3.4-preview.5',
      bundle: { macOS: { bundleVersion: '20030405' } },
    });
  });

  test.each([
    ['v0.1.0-preview.1', 10_001],
    ['v0.1.0-preview.2', 10_002],
    ['v0.1.0', 10_099],
    ['v0.1.1-preview.1', 10_101],
    ['v0.1.1', 10_199],
    ['v0.2.0', 20_099],
    ['v1.0.0', 10_000_099],
  ])('derives monotonic store identity for %s', (tag, versionCode) => {
    const identity = taggedStoreIdentity(tag);
    expect(identity.versionCode).toBe(versionCode);
    expect(identity.bundleVersion).toBe(String(versionCode));
  });

  test('store versionCodes increase across the preview-then-stable sequence', () => {
    const sequence = [
      'v0.1.2-preview.1',
      'v0.1.2-preview.2',
      'v0.1.2',
      'v0.1.3-preview.1',
      'v0.1.3',
      'v0.2.0',
    ];
    const codes = sequence.map((tag) => taggedStoreIdentity(tag).versionCode);
    for (let index = 1; index < codes.length; index += 1) {
      expect(codes[index]).toBeGreaterThan(codes[index - 1]);
    }
  });

  test('rejects a preview number that would overflow the versionCode slot', () => {
    expect(() => taggedStoreIdentity('v1.2.3-preview.99')).toThrow(
      'preview number must be 1-98',
    );
  });

  test('binds preview and stable tags to one repository base version', () => {
    expect(repositoryVersionForTag('v2.3.4-preview.5')).toBe('2.3.4');
    expect(repositoryVersionForTag('v2.3.4')).toBe('2.3.4');
    expect(
      assertRepositoryVersion({
        tag: 'v2.3.4-preview.5',
        packageVersion: '2.3.4',
      }),
    ).toBe('2.3.4-preview.5');
    expect(
      assertRepositoryVersion({
        tag: 'v2.3.4',
        packageVersion: '2.3.4',
      }),
    ).toBe('2.3.4');
  });

  test('fails closed when the release train differs from package.json', () => {
    expect(() =>
      assertRepositoryVersion({
        tag: 'v2.3.4-preview.5',
        packageVersion: '2.3.5',
      }),
    ).toThrow('does not match package version');
    expect(() =>
      assertRepositoryVersion({
        tag: 'v2.3.4-preview.5',
        packageVersion: '2.3.4-preview.5',
      }),
    ).toThrow('does not match package version');
  });

  test('creates a desktop updater overlay without exposing the key on argv', () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-native-release-'));
    const publicKey = join(directory, 'updater.pub');
    const output = join(directory, 'tauri.release.conf.json');
    writeFileSync(publicKey, 'trusted-public-key\n', { mode: 0o600 });

    execFileSync(
      process.execPath,
      [
        'scripts/lib/native-release-config.mjs',
        '--tag',
        'v2.3.4-preview.5',
        '--channel-identity',
        '--output',
        output,
        '--updater-public-key-file',
        publicKey,
      ],
      { cwd: join(import.meta.dirname, '../..') },
    );

    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
      version: '2.3.4-preview.5',
      identifier: 'io.kontourai.station.beta',
      productName: 'Station Beta',
      bundle: {
        android: { versionCode: 20_030_405 },
        iOS: { bundleVersion: '20030405' },
        macOS: { bundleVersion: '20030405' },
        createUpdaterArtifacts: NATIVE_UPDATER_ARTIFACT_MODE,
      },
      plugins: { updater: { pubkey: 'trusted-public-key' } },
    });
    expect(NATIVE_UPDATER_ARTIFACT_MODE).toBe('v1Compatible');
  });

  test('the pubkey path this file writes is the one the desktop Rust runtime reads (#575)', () => {
    // `createNativeReleaseConfig` writes the signing key at
    // `plugins.updater.pubkey`. `desktop_updater_plugin_configured` in
    // `src-desktop/src/lib.rs` reads that same path (plus `endpoints`,
    // supplied by a separate build-time overlay) to decide whether to
    // register the updater plugin at all — see that function's doc comment
    // for why an unconditional registration would crash every build without
    // it. A rename on either side must fail one of these two assertions.
    const config = createNativeReleaseConfig({
      tag: 'v1.2.3',
      updaterPublicKey: 'pin-check-key',
    });
    expect(config.plugins?.updater?.pubkey).toBe('pin-check-key');

    const rust = readFileSync('src-desktop/src/lib.rs', 'utf8');
    expect(rust).toContain('.get("updater")');
    expect(rust).toContain('.get("pubkey")');
    expect(rust).toContain('.get("endpoints")');
  });
});
