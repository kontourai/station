import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assembleNightlyDesktopManifest,
  assertWindowsNightlyManifest,
  assertWindowsNightlyReceipt,
  createWindowsNightlyConfig,
} from '../lib/windows-nightly.mjs';

const sourceSha = 'a'.repeat(40);
const version = '0.1.11-nightly.2443.2';
const bytes = Buffer.from('a signed archive');
function build(platform: string) {
  return {
    platform,
    sourceSha,
    version,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    assetName: `station-${version}-${platform === 'darwin-aarch64' ? 'macos-aarch64.app.tar.gz' : 'windows-x86_64-setup.exe'}`,
    signature: 'signed',
    platformSigningState: 'VERIFIED',
    updaterSigningState: 'VERIFIED',
  };
}
const input = () => ({
  version,
  sourceSha,
  pubDate: '2026-09-09T00:00:00Z',
  builds: [build('darwin-aarch64'), build('windows-x86_64')],
});
describe('Windows Nightly', () => {
  it('uses the shared Nightly versions with Tauri NSIS and per-user installation', () => {
    const configs = [244302, 244303, 244400].map((bundleVersion) =>
      createWindowsNightlyConfig({ packageVersion: '0.1.11', bundleVersion }),
    );
    expect(configs.map((c) => c.version)).toEqual([
      '0.1.11-nightly.2443.2',
      '0.1.11-nightly.2443.3',
      '0.1.11-nightly.2444',
    ]);
    expect(configs[0].bundle.targets).toEqual(['nsis']);
    expect(configs[0].mainBinaryName).toBe('station-nightly');
    expect(configs[0].bundle.windows.nsis.installMode).toBe('currentUser');
    expect(configs[0].version).toBe(version);
    expect(configs[0].identifier).toBe('io.kontourai.station.nightly');
    expect(configs[0].bundle.createUpdaterArtifacts).toBe(false);
  });
  it.each([0, -1, 1.5, NaN, 2_100_000_001])(
    'rejects invalid reservation %s',
    (bundleVersion) => {
      expect(() =>
        createWindowsNightlyConfig({ packageVersion: '0.1.11', bundleVersion }),
      ).toThrow();
    },
  );
  it('assembles both platforms from the same verified source and version', () => {
    expect(
      Object.keys(assembleNightlyDesktopManifest(input()).platforms),
    ).toEqual(['darwin-aarch64', 'windows-x86_64']);
  });
  it('publishes Windows without Authenticode while still requiring updater and macOS signing', () => {
    const candidate = input();
    candidate.builds[1].platformSigningState = 'NOT_SIGNED';
    expect(
      Object.keys(assembleNightlyDesktopManifest(candidate).platforms),
    ).toEqual(['darwin-aarch64', 'windows-x86_64']);
    candidate.builds[1].updaterSigningState = 'NOT_VERIFIED';
    expect(() => assembleNightlyDesktopManifest(candidate)).toThrow();
    candidate.builds[1].updaterSigningState = 'VERIFIED';
    candidate.builds[0].platformSigningState = 'NOT_SIGNED';
    expect(() => assembleNightlyDesktopManifest(candidate)).toThrow();
  });
  it.each([
    'sourceSha',
    'version',
    'platformSigningState',
    'updaterSigningState',
    'sha256',
  ])('rejects a Windows %s mismatch', (field) => {
    const candidate = input();
    Object.assign(candidate.builds[1], { [field]: 'wrong' });
    expect(() => assembleNightlyDesktopManifest(candidate)).toThrow();
  });
  it('rejects missing, duplicate, or unversioned builds', () => {
    const candidate = input();
    expect(() =>
      assembleNightlyDesktopManifest({
        ...candidate,
        builds: [candidate.builds[0]],
      }),
    ).toThrow();
    expect(() =>
      assembleNightlyDesktopManifest({
        ...candidate,
        builds: [candidate.builds[0], candidate.builds[0]],
      }),
    ).toThrow();
    candidate.builds[1].assetName = 'station-nightly-windows-x86_64-setup.exe';
    expect(() => assembleNightlyDesktopManifest(candidate)).toThrow();
  });
});

it('requires attested Windows signature, payload and packaged provenance facts', () => {
  const identity = { sourceSha, version, bundleVersion: 244302 };
  const receipt = {
    kind: 'station.windows-nightly-build/v1',
    ...identity,
    platform: 'windows-x86_64',
    installerKind: 'nsis',
    updaterFormat: 'tauri-v2',
    platformSigningState: 'VERIFIED',
    updaterPayloadState: 'VERIFIED',
    packagedProvenanceSha256: 'b'.repeat(64),
    installerSha256: createHash('sha256').update(bytes).digest('hex'),
  };
  expect(() =>
    assertWindowsNightlyReceipt(receipt, identity, bytes),
  ).not.toThrow();
  const unsigned = { ...receipt, platformSigningState: 'NOT_SIGNED' };
  expect(() =>
    assertWindowsNightlyReceipt(unsigned, identity, bytes),
  ).not.toThrow();
  for (const patch of [
    { platformSigningState: 'NOT_VERIFIED' },
    { platformSigningState: 'INVALID' },
    { updaterPayloadState: 'NOT_VERIFIED' },
  ]) {
    expect(() =>
      assertWindowsNightlyReceipt({ ...unsigned, ...patch }, identity, bytes),
    ).toThrow();
  }
  expect(() =>
    assertWindowsNightlyReceipt(unsigned, identity, Buffer.from('tampered')),
  ).toThrow();
  for (const field of Object.keys(receipt)) {
    expect(() =>
      assertWindowsNightlyReceipt(
        { ...receipt, [field]: undefined },
        identity,
        bytes,
      ),
    ).toThrow();
  }
  expect(() =>
    assertWindowsNightlyReceipt(
      receipt,
      identity,
      Buffer.from('other installer'),
    ),
  ).toThrow();
});
it('binds the Windows feed entry to the same version and updater signature', () => {
  const manifest = assembleNightlyDesktopManifest(input());
  expect(() =>
    assertWindowsNightlyManifest(manifest, version, Buffer.from('signed')),
  ).not.toThrow();
  expect(() =>
    assertWindowsNightlyManifest(manifest, version, Buffer.from('wrong')),
  ).toThrow();
  Object.assign(manifest.platforms, {
    'windows-x86_64': {
      signature: 'signed',
      url: 'https://example.com/other-setup.exe',
    },
  });
  expect(() =>
    assertWindowsNightlyManifest(manifest, version, Buffer.from('signed')),
  ).toThrow();
});
