import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, vi } from 'vitest';
import { normalizeDevPairingDeepLinkSuffix } from '../channel-platform-matrix.mjs';
import {
  signIosSimulator,
  simulatorSigningEntitlements,
} from '../sign-ios-simulator.mjs';

const config = JSON.parse(
  readFileSync('src-desktop/tauri.ios.dev.conf.json', 'utf8'),
);
const id = 'io.kontourai.station.dev.instance';
const appInfo = {
  CFBundleIdentifier: id,
  CFBundleExecutable: 'Station Dev',
  CFBundleSupportedPlatforms: ['iPhoneSimulator'],
  CFBundleURLTypes: [{ CFBundleURLSchemes: ['station-dev-instance'] }],
};

test('development config, native identity, and regenerated Info.plist register one scheme', () => {
  expect(config.identifier).toBe(id);
  const suffix = normalizeDevPairingDeepLinkSuffix(
    config.identifier.slice('io.kontourai.station.dev.'.length),
  );
  const scheme = `station-dev-${suffix}`;
  expect(config.plugins['deep-link'].mobile).toEqual([
    { scheme: [scheme], appLink: false },
  ]);
  const plist = readFileSync(
    `src-desktop/${config.bundle.iOS.infoPlist}`,
    'utf8',
  );
  expect(plist).toContain(
    `<key>CFBundleURLSchemes</key><array><string>${scheme}</string></array>`,
  );
  expect(plist).not.toContain('station-stable');
  for (const key of [
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription',
    'NSLocalNetworkUsageDescription',
    'ITSAppUsesNonExemptEncryption',
  ])
    expect(plist).toContain(`<key>${key}</key>`);
});

test('the simulator entry point carries the identity through generation, provenance, build, and signing', () => {
  const script = JSON.parse(readFileSync('package.json', 'utf8')).scripts[
    'build:ios:simulator'
  ];
  expect(script.match(/--config tauri\.ios\.dev\.conf\.json/g)).toHaveLength(2);
  expect(script).toContain('(cd src-desktop && tauri ios init');
  expect(script.indexOf('write-ios-build-manifest')).toBeGreaterThan(
    script.indexOf('tauri ios init'),
  );
  expect(script.indexOf('tauri ios build')).toBeGreaterThan(
    script.indexOf('write-ios-build-manifest'),
  );
  expect(script).toContain(
    '--target aarch64-sim --debug --no-sign --archive-only',
  );
  expect(script.indexOf('sign-ios-simulator')).toBeGreaterThan(
    script.indexOf('tauri ios build'),
  );
});

test('simulator entitlements give only this development app its own keychain group', () => {
  expect(
    simulatorSigningEntitlements(appInfo, 'platform IOSSIMULATOR'),
  ).toEqual({
    'application-identifier': id,
    'keychain-access-groups': [id],
    'get-task-allow': true,
  });
});

test.each([
  [
    { ...appInfo, CFBundleIdentifier: 'io.kontourai.station' },
    'platform IOSSIMULATOR',
  ],
  [{ ...appInfo, CFBundleSupportedPlatforms: ['iPhoneOS'] }, 'platform IOS'],
  [appInfo, 'platform IOSSIMULATOR\nplatform IOS'],
  [appInfo, ''],
])(
  'refuses non-development, device, mixed, or unproven signing targets',
  (info, build) => {
    expect(() => simulatorSigningEntitlements(info, build)).toThrow();
  },
);

test('signing validates the final app and passes only app-scoped entitlements to codesign', () => {
  const archive = resolve('fixture-simulator-archive');
  let written: unknown;
  const run = vi.fn((command: string, args: string[]) => {
    if (command === 'plutil' && args[1] === 'json')
      return JSON.stringify(
        args.at(-1) === join(archive, 'Info.plist')
          ? {
              ApplicationProperties: {
                ApplicationPath: 'Applications/Station Dev.app',
                CFBundleIdentifier: id,
              },
            }
          : appInfo,
      );
    if (command === 'xcrun') return 'platform IOSSIMULATOR';
    if (command === 'plutil' && args[1] === 'xml1')
      written = JSON.parse(readFileSync(args[2]!, 'utf8'));
    return '';
  });
  const app = signIosSimulator(archive, run);
  expect(written).toEqual({
    'application-identifier': id,
    'keychain-access-groups': [id],
    'get-task-allow': true,
  });
  expect(run).toHaveBeenCalledWith('codesign', [
    '--force',
    '--sign',
    '-',
    '--identifier',
    id,
    '--entitlements',
    expect.any(String),
    app,
  ]);
  expect(run).toHaveBeenLastCalledWith('codesign', [
    '--verify',
    '--strict',
    app,
  ]);
});
