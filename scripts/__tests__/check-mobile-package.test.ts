import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  auditIosInventory,
  parseIosClientBuildProvenance,
} from '../check-mobile-package.mjs';

const info =
  '<key>DTSDKName</key><string>iphoneos26.6</string><key>NSCameraUsageDescription</key><key>NSLocalNetworkUsageDescription</key><key>NSMicrophoneUsageDescription</key>';
const privacy = '<key>NSPrivacyTracking</key><false/>';
// Every path is relative to the application bundle (the bundle itself is
// `.`), and the main executable is whatever the bundle's CFBundleExecutable
// names, so one allowlist reviews Stable, Beta, and Nightly alike.
const base = {
  info,
  executable: 'Station',
  privacyManifests: [
    { path: 'PrivacyInfo.xcprivacy', contents: privacy },
    {
      path: 'Resources/PrivacyInfo.xcprivacy',
      contents: privacy,
    },
  ],
  signedBundles: [
    { path: '.', entitlements: '<key>application-identifier</key>' },
  ],
  dependencies: [
    {
      binary: 'Station',
      output:
        'Station:\n/System/Library/Frameworks/WebKit.framework/WebKit\n/usr/lib/libobjc.A.dylib',
    },
  ],
};

describe('packaged iOS capability audit', () => {
  test.each(['18.5', '25.9'])(
    'rejects the packaged SDK %s before store upload',
    (sdk) => {
      expect(() =>
        auditIosInventory({
          ...base,
          info: info.replace('iphoneos26.6', `iphoneos${sdk}`),
        }),
      ).toThrow(/require iOS SDK 26/);
    },
  );
  test.each(['', '<key>DTSDKName</key><string>iphonesimulator26.6</string>'])(
    'rejects missing or simulator SDK provenance',
    (sdk) => {
      expect(() =>
        auditIosInventory({
          ...base,
          info: info.replace(
            '<key>DTSDKName</key><string>iphoneos26.6</string>',
            sdk,
          ),
        }),
      ).toThrow(/DTSDKName/);
    },
  );

  test('accepts only canonical, source-derived iOS client build provenance', () => {
    expect(
      parseIosClientBuildProvenance(
        JSON.stringify({
          sha: 'a'.repeat(40),
          branch: 'main',
          builtAt: '2026-08-30T12:00:00.000Z',
        }),
      ),
    ).toEqual({
      sha: 'a'.repeat(40),
      branch: 'main',
      builtAt: '2026-08-30T12:00:00.000Z',
    });
    expect(() =>
      parseIosClientBuildProvenance(
        JSON.stringify({
          sha: 'a'.repeat(40),
          branch: 'main',
          builtAt: '2026-02-31T12:00:00.000Z',
        }),
      ),
    ).toThrow(/invalid station-build/);
  });
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
  test('reviews a channel bundle by its own executable name, not a product name in the allowlist', () => {
    // Nightly 33916485728 packaged "Station Nightly.app" and the audit
    // refused its manifest because the allowlist named "Station.app".
    const nightly = {
      ...base,
      executable: 'Station Nightly',
      dependencies: [
        {
          binary: 'Station Nightly',
          output:
            'Station Nightly:\n/System/Library/Frameworks/WebKit.framework/WebKit',
        },
      ],
    };
    expect(auditIosInventory(nightly)).toEqual({
      privacyCount: 2,
      signedBundleCount: 1,
      binaryCount: 1,
    });
    // A binary that is not the declared executable is still refused.
    expect(() =>
      auditIosInventory({ ...nightly, executable: 'Station' }),
    ).toThrow(
      /Mach-O Station Nightly is not in the checked-in bundle-relative allowlist/,
    );
    // The token cannot resolve against a bundle that names no executable.
    expect(() => auditIosInventory({ ...nightly, executable: '' })).toThrow(
      /names no CFBundleExecutable/,
    );
    // A manifest outside the bundle-relative allowlist is still refused.
    expect(() =>
      auditIosInventory({
        ...nightly,
        privacyManifests: [
          {
            path: 'Frameworks/Other.framework/PrivacyInfo.xcprivacy',
            contents: privacy,
          },
        ],
      }),
    ).toThrow(/not in the bundle-relative allowlist/);
  });
  test('fails an unreviewed extension entitlement', () =>
    expect(() =>
      auditIosInventory({
        ...base,
        signedBundles: [
          ...base.signedBundles,
          {
            path: 'PlugIns/Share.appex',
            entitlements: '<key>com.apple.developer.healthkit</key>',
          },
        ],
      }),
    ).toThrow(/checked-in allowlist/));
  test('rejects static build archives in the packaged app payload', () =>
    expect(() =>
      auditIosInventory({
        ...base,
        staticArchives: ['libapp.a'],
      }),
    ).toThrow(/static build artifact/));
  test('accepts only the true TestFlight beta reports entitlement', () => {
    expect(
      auditIosInventory({
        ...base,
        signedBundles: [
          {
            path: '.',
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
            path: '.',
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
              path: '.',
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
            path: '.',
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
          { path: 'Watch/Station.app', entitlements: '' },
        ],
      },
    ],
    [
      'xpc service',
      {
        signedBundles: [
          ...base.signedBundles,
          { path: 'XPCServices/Helper.xpc', entitlements: '' },
        ],
      },
    ],
    [
      'standalone dylib',
      {
        dependencies: [
          ...base.dependencies,
          {
            binary: 'Frameworks/spy.dylib',
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
            path: 'Resources/Data.bundle/PrivacyInfo.xcprivacy',
            contents: privacy,
          },
        ],
      },
    ],
  ])('rejects unreviewed bundle-relative %s', (_name, override) => {
    expect(() => auditIosInventory({ ...base, ...override })).toThrow(
      /allowlist/,
    );
  });
});
