import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  assertRepositoryVersion,
  createNativeReleaseConfig,
  desktopUpdaterTagForReleaseTag,
  NATIVE_UPDATER_ARTIFACT_MODE,
  nativeIdentifierForChannel,
  nativeProductNameForChannel,
  nativeReleaseChannel,
  repositoryVersionForTag,
  taggedStoreIdentity,
  updaterPluginConfig,
} from '../lib/native-release-config.mjs';
import { createNightlyDesktopConfig } from '../lib/nightly-build-identity.mjs';

describe('native release configuration', () => {
  test.each([
    ['v1.2.3', '1.2.3'],
    ['v1.2.3-rc.4', '1.2.3'],
    ['v0.0.0', '0.0.0'],
  ])('binds %s to the package version %s', (tag, version) => {
    expect(repositoryVersionForTag(tag)).toBe(version);
  });

  test.each([
    '1.2.3',
    'v01.2.3',
    'v1.2',
    'v1.2.3-rc.0',
    'v1.2.3-rc.01',
    'v1.2.3-preview.1',
    'v1.2.3-beta.1',
  ])('rejects malformed or retired tag %s', (tag) => {
    expect(() => repositoryVersionForTag(tag)).toThrow(
      'Invalid native release configuration',
    );
    expect(() => taggedStoreIdentity(tag)).toThrow(
      'Invalid native release configuration',
    );
  });

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

  // #4929: a release candidate is the Stable app with the bare base version,
  // so its exact bytes can later be promoted unchanged.
  test('builds v0.2.0-rc.3 as the Stable app at version 0.2.0 in store slot 3', () => {
    expect(taggedStoreIdentity('v0.2.0-rc.3')).toEqual({
      releaseKind: 'rc',
      marketingVersion: '0.2.0',
      versionCode: 20_003,
      bundleVersion: '20003',
    });
    expect(nativeReleaseChannel('v0.2.0-rc.3')).toBe('stable');
    expect(desktopUpdaterTagForReleaseTag('v0.2.0-rc.3')).toBe(
      'stable-desktop',
    );
    expect(
      createNativeReleaseConfig({ tag: 'v0.2.0-rc.3', channelIdentity: true }),
    ).toEqual({
      version: '0.2.0',
      identifier: 'io.kontourai.station',
      productName: 'Station',
      bundle: {
        android: { versionCode: 20_003 },
        iOS: { bundleVersion: '20003' },
        macOS: { bundleVersion: '20003' },
      },
    });
  });

  test('reserves store slot 99 for the final v0.2.0 tag', () => {
    expect(taggedStoreIdentity('v0.2.0')).toEqual({
      releaseKind: 'final',
      marketingVersion: '0.2.0',
      versionCode: 20_099,
      bundleVersion: '20099',
    });
    expect(
      createNativeReleaseConfig({ tag: 'v0.2.0', channelIdentity: true }),
    ).toMatchObject({
      version: '0.2.0',
      identifier: 'io.kontourai.station',
      productName: 'Station',
    });
  });

  test('has no Beta identity to select', () => {
    expect(nativeIdentifierForChannel('stable')).toBe('io.kontourai.station');
    expect(nativeProductNameForChannel('stable')).toBe('Station');
    expect(() => nativeIdentifierForChannel('beta')).toThrow(
      'unsupported native release channel',
    );
    expect(() => nativeProductNameForChannel('beta')).toThrow(
      'unsupported native release channel',
    );
    expect(
      createNativeReleaseConfig({ tag: 'v2.3.4-rc.5' }),
    ).not.toHaveProperty('identifier');
  });

  test('maps every release tag to the Stable rolling desktop channel', () => {
    expect(desktopUpdaterTagForReleaseTag('v2.3.4-rc.5')).toBe(
      'stable-desktop',
    );
    expect(desktopUpdaterTagForReleaseTag('v2.3.4')).toBe('stable-desktop');
  });

  test.each([
    ['v0.1.0-rc.1', 10_001],
    ['v0.1.0-rc.2', 10_002],
    ['v0.1.0-rc.98', 10_098],
    ['v0.1.0', 10_099],
    ['v0.1.1-rc.1', 10_101],
    ['v0.1.1', 10_199],
    ['v0.2.0', 20_099],
    ['v1.0.0', 10_000_099],
  ])('derives monotonic store identity for %s', (tag, versionCode) => {
    const identity = taggedStoreIdentity(tag);
    expect(identity.versionCode).toBe(versionCode);
    expect(identity.bundleVersion).toBe(String(versionCode));
  });

  test('store versionCodes increase across the candidate-then-final sequence', () => {
    const sequence = [
      'v0.1.2-rc.1',
      'v0.1.2-rc.2',
      'v0.1.2',
      'v0.1.3-rc.1',
      'v0.1.3',
      'v0.2.0-rc.1',
      'v0.2.0',
    ];
    const codes = sequence.map((tag) => taggedStoreIdentity(tag).versionCode);
    for (let index = 1; index < codes.length; index += 1) {
      expect(codes[index]).toBeGreaterThan(codes[index - 1]);
    }
  });

  test('refuses version components that would overflow their store number band', () => {
    // Without bounds, v0.1.100-rc.1 and v0.2.0-rc.1 both derive 20001, and
    // v0.1.100 (20099) would outrank the later v0.2.0-rc.98 (20098).
    expect(() => taggedStoreIdentity('v0.1.100-rc.1')).toThrow('patch 0-99');
    expect(() => taggedStoreIdentity('v0.1.100')).toThrow('patch 0-99');
    expect(() => taggedStoreIdentity('v0.1000.0')).toThrow(
      'minor must be 0-999',
    );
    expect(taggedStoreIdentity('v0.1.99').versionCode).toBe(19_999);
    expect(taggedStoreIdentity('v0.999.99').versionCode).toBe(9_999_999);
    expect(taggedStoreIdentity('v0.2.0-rc.1').versionCode).toBe(20_001);
  });

  test('rejects a candidate number that would take the final tag slot', () => {
    expect(() => taggedStoreIdentity('v1.2.3-rc.99')).toThrow(
      'a release candidate is numbered 1-98',
    );
  });

  test('binds candidate and final tags to one repository base version', () => {
    expect(
      assertRepositoryVersion({
        tag: 'v2.3.4-rc.5',
        packageVersion: '2.3.4',
      }),
    ).toBe('2.3.4');
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
        tag: 'v2.3.4-rc.5',
        packageVersion: '2.3.5',
      }),
    ).toThrow('does not match package version');
    expect(() =>
      assertRepositoryVersion({
        tag: 'v2.3.4-rc.5',
        packageVersion: '2.3.4-rc.5',
      }),
    ).toThrow('does not match package version');
  });

  test('refuses a desktop updater key without its endpoint at the library and CLI boundaries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-native-release-'));
    const publicKey = join(directory, 'updater.pub');
    const output = join(directory, 'tauri.release.conf.json');
    writeFileSync(publicKey, 'trusted-public-key\n', { mode: 0o600 });

    expect(() =>
      createNativeReleaseConfig({
        tag: 'v2.3.4-rc.5',
        updaterPublicKey: 'trusted-public-key',
      }),
    ).toThrow('updater public key requires an updater endpoint');
    expect(() =>
      execFileSync(
        process.execPath,
        [
          'scripts/lib/native-release-config.mjs',
          '--tag',
          'v2.3.4-rc.5',
          '--channel-identity',
          '--output',
          output,
          '--updater-public-key-file',
          publicKey,
        ],
        { cwd: join(import.meta.dirname, '../..'), stdio: 'pipe' },
      ),
    ).toThrow(/updater public key requires an updater endpoint/);
  });

  test('the CLI embeds the selected rolling updater endpoint', () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-native-endpoint-'));
    const publicKey = join(directory, 'updater.pub');
    const output = join(directory, 'tauri.release.conf.json');
    const endpoint =
      'https://github.com/kontourai/station/releases/download/stable-desktop/latest.json';
    writeFileSync(publicKey, 'trusted-public-key\n', { mode: 0o600 });

    execFileSync(
      process.execPath,
      [
        'scripts/lib/native-release-config.mjs',
        '--tag',
        'v2.3.4',
        '--updater-public-key-file',
        publicKey,
        '--updater-endpoint',
        endpoint,
        '--output',
        output,
      ],
      { cwd: join(import.meta.dirname, '../..') },
    );

    expect(
      JSON.parse(readFileSync(output, 'utf8')).plugins.updater.endpoints,
    ).toEqual([endpoint]);
  });

  test('rejects a tagged build whose updater endpoint names the other channel', () => {
    expect(() =>
      createNativeReleaseConfig({
        tag: 'v2.3.4',
        updaterPublicKey: 'trusted-public-key',
        updaterEndpoint:
          'https://github.com/kontourai/station/releases/download/beta-desktop/latest.json',
      }),
    ).toThrow(/must be exactly.*stable-desktop/);
    expect(() =>
      createNativeReleaseConfig({
        tag: 'v2.3.4-rc.5',
        updaterPublicKey: 'trusted-public-key',
        updaterEndpoint:
          'https://github.com/kontourai/station/releases/download/beta-desktop/latest.json',
      }),
    ).toThrow(/must be exactly.*stable-desktop/);
  });

  test.each([
    'https://github.com/kontourai/station/releases/download/beta-desktop/latest.json?x=/download/stable-desktop/',
    'https://github.com/kontourai/station/releases/download/beta-desktop/latest.json#/download/stable-desktop/',
    'https://github.com/kontourai/station/releases/download/stable-desktop/../beta-desktop/latest.json',
    'https://attacker.tld/kontourai/station/releases/download/stable-desktop/latest.json',
    'https://github.com/kontourai/station/releases/download/stable-desktop/subdir/latest.json',
    'https://github.com/kontourai/station/releases/download/stable-desktop/subdir/anything.txt',
  ])('rejects non-identical stable updater endpoint %s', (updaterEndpoint) => {
    expect(() =>
      createNativeReleaseConfig({
        tag: 'v2.3.4',
        updaterPublicKey: 'trusted-public-key',
        updaterEndpoint,
      }),
    ).toThrow(/updater endpoint must be exactly/);
  });

  test('the CLI rejects unknown flags instead of silently ignoring them', () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [
          'scripts/lib/native-release-config.mjs',
          '--tag',
          'v2.3.4',
          '--updater-endpont',
          'https://example.com/latest.json',
          '--output',
          'unused.json',
        ],
        { cwd: join(import.meta.dirname, '../..'), stdio: 'pipe' },
      ),
    ).toThrow(/unknown argument/);
  });

  test('the CLI exposes the shared release-tag to updater-channel mapping', () => {
    expect(
      execFileSync(
        process.execPath,
        [
          'scripts/lib/native-release-config.mjs',
          '--tag',
          'v2.3.4-rc.5',
          '--print-desktop-updater-tag',
        ],
        {
          cwd: join(import.meta.dirname, '../..'),
          encoding: 'utf8',
        },
      ),
    ).toBe('stable-desktop');
  });

  test('the shared updater plugin overlay adds an endpoint only when one is given (station#575)', () => {
    expect(updaterPluginConfig('trusted-public-key')).toEqual({
      createUpdaterArtifacts: NATIVE_UPDATER_ARTIFACT_MODE,
      plugins: { updater: { pubkey: 'trusted-public-key' } },
    });
    expect(
      updaterPluginConfig(
        '  trusted-public-key  ',
        'https://github.com/kontourai/station/releases/download/nightly-desktop/latest.json',
      ),
    ).toEqual({
      createUpdaterArtifacts: NATIVE_UPDATER_ARTIFACT_MODE,
      plugins: {
        updater: {
          pubkey: 'trusted-public-key',
          endpoints: [
            'https://github.com/kontourai/station/releases/download/nightly-desktop/latest.json',
          ],
        },
      },
    });
  });

  test('the shared updater plugin overlay fails closed on an empty key or a non-https endpoint', () => {
    expect(() => updaterPluginConfig('')).toThrow(
      'updater public key must be non-empty',
    );
    expect(() => updaterPluginConfig('   ')).toThrow(
      'updater public key must be non-empty',
    );
    expect(() =>
      updaterPluginConfig(
        'trusted-public-key',
        'http://insecure.example/latest.json',
      ),
    ).toThrow('updater endpoint must be a non-empty https URL');
  });

  test('the pubkey and endpoints paths this file writes are the ones the desktop Rust runtime reads (#575)', () => {
    // `updaterPluginConfig` (shared by `createNativeReleaseConfig` and
    // nightly's `createNightlyDesktopConfig`) writes the signing key and
    // endpoint at `plugins.updater.pubkey` / `plugins.updater.endpoints`.
    // `desktop_updater_plugin_configured` in `src-desktop/src/lib.rs` reads
    // exactly those two paths to decide whether to register the updater
    // plugin at all — see that function's doc comment for why an
    // unconditional registration can crash the app. A rename on either side
    // must fail one of these assertions.
    const config = createNativeReleaseConfig({
      tag: 'v1.2.3',
      updaterPublicKey: 'pin-check-key',
      updaterEndpoint:
        'https://github.com/kontourai/station/releases/download/stable-desktop/latest.json',
    });
    expect(config.plugins?.updater?.pubkey).toBe('pin-check-key');
    expect(config.plugins?.updater?.endpoints).toEqual([
      'https://github.com/kontourai/station/releases/download/stable-desktop/latest.json',
    ]);

    // Nightly is the one channel shipping BOTH fields today — pin its
    // emitter against the predicate's actual contract (non-empty pubkey,
    // non-empty array of non-empty endpoint strings), not just the key
    // names, since a value-shape drift here would silently leave a
    // "nightly-configured" build inert too.
    const nightlyConfig = createNightlyDesktopConfig({
      packageVersion: '1.2.3',
      productionIdentifier: 'io.kontourai.station',
      date: new Date('2026-08-28T00:00:00Z'),
      updaterPublicKey: 'pin-check-key',
      updaterEndpoint:
        'https://github.com/kontourai/station/releases/download/nightly-desktop/latest.json',
    });
    expect(typeof nightlyConfig.plugins.updater.pubkey).toBe('string');
    expect(nightlyConfig.plugins.updater.pubkey.length).toBeGreaterThan(0);
    expect(Array.isArray(nightlyConfig.plugins.updater.endpoints)).toBe(true);
    expect(nightlyConfig.plugins.updater.endpoints.length).toBeGreaterThan(0);
    for (const endpoint of nightlyConfig.plugins.updater.endpoints) {
      expect(typeof endpoint).toBe('string');
      expect(endpoint.length).toBeGreaterThan(0);
    }

    const rust = readFileSync('src-desktop/src/lib.rs', 'utf8');
    expect(rust).toContain('.get("updater")');
    expect(rust).toContain('.get("pubkey")');
    expect(rust).toContain('.get("endpoints")');
  });
});
