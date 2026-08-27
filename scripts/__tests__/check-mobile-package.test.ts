import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { auditIosInventory } from '../check-mobile-package.mjs';

const info =
  '<key>NSCameraUsageDescription</key><key>NSLocalNetworkUsageDescription</key><key>NSMicrophoneUsageDescription</key>';
const privacy = '<key>NSPrivacyTracking</key><false/>';
const base = {
  info,
  privacyManifests: [
    { path: 'Station.app/PrivacyInfo.xcprivacy', contents: privacy },
    {
      path: 'Station.app/Resources/PrivacyInfo.xcprivacy',
      contents: privacy,
    },
  ],
  signedBundles: [
    { path: 'Station.app', entitlements: '<key>application-identifier</key>' },
  ],
  dependencies: [
    {
      binary: 'Station.app/Station',
      output:
        'Station:\n/System/Library/Frameworks/WebKit.framework/WebKit\n/usr/lib/libobjc.A.dylib',
    },
  ],
};

describe('packaged iOS capability audit', () => {
  test('keeps generated Rust archives out of XcodeGen resource scanning but links libapp.a', () => {
    const project = readFileSync(
      resolve(import.meta.dirname, '../../src-desktop/gen/apple/project.yml'),
      'utf8',
    );
    expect(project).toContain(
      'path: Externals\n        excludes:\n          - "**/*.a"',
    );
    expect(project).toContain('framework: libapp.a\n        embed: false');
  });
  test('enumerates every privacy manifest, signed bundle, framework, and Mach-O closure', () => {
    expect(auditIosInventory(base)).toEqual({
      privacyCount: 2,
      signedBundleCount: 1,
      binaryCount: 1,
    });
  });
  test('fails an unreviewed extension entitlement', () =>
    expect(() =>
      auditIosInventory({
        ...base,
        signedBundles: [
          ...base.signedBundles,
          {
            path: 'Station.app/PlugIns/Share.appex',
            entitlements: '<key>com.apple.developer.healthkit</key>',
          },
        ],
      }),
    ).toThrow(/checked-in allowlist/));
  test('rejects static build archives in the packaged app payload', () =>
    expect(() =>
      auditIosInventory({
        ...base,
        staticArchives: ['Station.app/libapp.a'],
      }),
    ).toThrow(/static build artifact/));
  test('accepts only the true TestFlight beta reports entitlement', () => {
    expect(
      auditIosInventory({
        ...base,
        signedBundles: [
          {
            path: 'Station.app',
            entitlements:
              '<key>application-identifier</key><key>beta-reports-active</key><true/>',
          },
        ],
      }),
    ).toMatchObject({ signedBundleCount: 1 });
    expect(() =>
      auditIosInventory({
        ...base,
        signedBundles: [
          {
            path: 'Station.app',
            entitlements:
              '<key>application-identifier</key><key>beta-reports-active</key><false/>',
          },
        ],
      }),
    ).toThrow(/must be true/);
    for (const value of ['<string>true</string>', '<integer>1</integer>', '']) {
      expect(() =>
        auditIosInventory({
          ...base,
          signedBundles: [
            {
              path: 'Station.app',
              entitlements: `<key>application-identifier</key><key>beta-reports-active</key>${value}`,
            },
          ],
        }),
      ).toThrow(/must be true/);
    }
    expect(() =>
      auditIosInventory({
        ...base,
        signedBundles: [
          {
            path: 'Station.app',
            entitlements:
              '<key>application-identifier</key><key>beta-reports-active</key><true/><key>com.apple.developer.healthkit</key><true/>',
          },
        ],
      }),
    ).toThrow(/unreviewed entitlements/);
  });
  test('fails an unreviewed embedded framework instead of allowing arbitrary rpath', () =>
    expect(() =>
      auditIosInventory({
        ...base,
        signedBundles: [
          ...base.signedBundles,
          { path: 'Station.app/Frameworks/Spy.framework', entitlements: '' },
        ],
        dependencies: [
          {
            binary: 'Station.app/Station',
            output: 'Station:\n@rpath/Spy.framework/Spy',
          },
        ],
      }),
    ).toThrow(/Spy/));
  test('fails when any discovered privacy manifest enables tracking', () =>
    expect(() =>
      auditIosInventory({
        ...base,
        privacyManifests: [
          ...base.privacyManifests,
          {
            path: 'Bad.framework/PrivacyInfo.xcprivacy',
            contents: '<key>NSPrivacyTracking</key><true/>',
          },
        ],
      }),
    ).toThrow(/Bad.framework/));
  test.each([
    [
      'nested same-name app',
      {
        signedBundles: [
          ...base.signedBundles,
          { path: 'Station.app/Watch/Station.app', entitlements: '' },
        ],
      },
    ],
    [
      'xpc service',
      {
        signedBundles: [
          ...base.signedBundles,
          { path: 'Station.app/XPCServices/Helper.xpc', entitlements: '' },
        ],
      },
    ],
    [
      'standalone dylib',
      {
        dependencies: [
          ...base.dependencies,
          {
            binary: 'Station.app/Frameworks/spy.dylib',
            output: 'spy:\n/usr/lib/libobjc.A.dylib',
          },
        ],
      },
    ],
    [
      'resource bundle privacy',
      {
        privacyManifests: [
          ...base.privacyManifests,
          {
            path: 'Station.app/Resources/Data.bundle/PrivacyInfo.xcprivacy',
            contents: privacy,
          },
        ],
      },
    ],
  ])('rejects unreviewed root-relative %s', (_name, override) => {
    expect(() => auditIosInventory({ ...base, ...override })).toThrow(
      /allowlist/,
    );
  });
});
