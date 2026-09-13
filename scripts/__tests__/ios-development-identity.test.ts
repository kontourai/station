import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import YAML from 'yaml';
import { normalizeDevPairingDeepLinkSuffix } from '../channel-platform-matrix.mjs';
import {
  prepareIosSimulator,
  readSimulatorEntitlementSection,
  simulatorEntitlements,
  verifyIosSimulator,
} from '../ios-simulator-build.mjs';

const config = JSON.parse(
  readFileSync('src-desktop/tauri.ios.dev.conf.json', 'utf8'),
);
const id = 'io.kontourai.station.dev.instance';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-ios-dev-'));
  roots.push(root);
  const apple = join(root, 'src-desktop/gen/apple');
  mkdirSync(join(apple, 'station_iOS'), { recursive: true });
  writeFileSync(
    join(root, 'src-desktop/tauri.ios.dev.conf.json'),
    JSON.stringify(config),
  );
  return { root, apple };
}

test('development configuration, native identity, and Info.plist agree on one scheme', () => {
  expect(config.identifier).toBe(id);
  const scheme = `station-dev-${normalizeDevPairingDeepLinkSuffix(config.identifier.slice('io.kontourai.station.dev.'.length))}`;
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

test('the simulator command prepares after generation and verifies the final build', () => {
  const script = JSON.parse(readFileSync('package.json', 'utf8')).scripts[
    'build:ios:simulator'
  ];
  expect(script.match(/--config tauri\.ios\.dev\.conf\.json/g)).toHaveLength(2);
  expect(script.indexOf('ios-simulator-build.mjs prepare')).toBeGreaterThan(
    script.indexOf('tauri ios init'),
  );
  expect(script.indexOf('tauri ios build')).toBeGreaterThan(
    script.indexOf('write-ios-build-manifest'),
  );
  expect(script).toContain(
    '--target aarch64-sim --debug --no-sign --archive-only',
  );
  expect(script.indexOf('ios-simulator-build.mjs verify')).toBeGreaterThan(
    script.indexOf('tauri ios build'),
  );
});

test('preparation is idempotent, preserves existing flags, and changes only simulator linking', () => {
  const { root, apple } = fixture();
  const target = {
    type: 'application',
    platform: 'iOS',
    settings: {
      base: {
        CUSTOM_SETTING: 'keep',
        'OTHER_LDFLAGS[sdk=iphonesimulator*]': ['$(inherited)', '-ObjC'],
      },
    },
  };
  writeFileSync(
    join(apple, 'project.yml'),
    YAML.stringify({ targets: { station_iOS: target } }),
  );
  const run = vi.fn(() => '');
  prepareIosSimulator({ root, run });
  const once = readFileSync(join(apple, 'project.yml'), 'utf8');
  prepareIosSimulator({ root, run });
  expect(readFileSync(join(apple, 'project.yml'), 'utf8')).toBe(once);
  const base = YAML.parse(once).targets.station_iOS.settings.base;
  expect(base.CUSTOM_SETTING).toBe('keep');
  expect(base['OTHER_LDFLAGS[sdk=iphonesimulator*]']).toContain('-ObjC');
  expect(
    base['OTHER_LDFLAGS[sdk=iphonesimulator*]'].filter(
      (value: string) => value === '__entitlements',
    ),
  ).toHaveLength(1);
  expect(base.OTHER_LDFLAGS).toBeUndefined();
  const xml = readFileSync(
    join(apple, 'station_iOS/StationSimulator.entitlements'),
    'utf8',
  );
  expect(xml).toContain(`<string>${id}</string>`);
  expect(xml).not.toContain('get-task-allow');
  expect(run).toHaveBeenCalledWith('xcodegen', [
    'generate',
    '--spec',
    join(apple, 'project.yml'),
    '--project',
    apple,
  ]);
});

test('a stable identifier cannot receive development simulator preparation', () => {
  expect(() => simulatorEntitlements('io.kontourai.station')).toThrow();
});

function archivedFixture() {
  const { root } = fixture();
  const archive = join(root, 'archive');
  const app = join(archive, 'Products/Applications/Station Dev.app');
  mkdirSync(app, { recursive: true });
  const executable = join(app, 'Station Dev');
  const xml = Buffer.from(
    `<plist><dict><key>application-identifier</key><string>${id}</string><key>keychain-access-groups</key><array><string>${id}</string></array></dict></plist>`,
  );
  writeFileSync(
    executable,
    Buffer.concat([Buffer.alloc(32), xml, Buffer.alloc(8)]),
  );
  const commands = `sectname __entitlements\nsegname __TEXT\naddr 0x1000\nsize 0x${xml.length.toString(16)}\noffset 32\n`;
  const info = {
    CFBundleIdentifier: id,
    CFBundleExecutable: 'Station Dev',
    CFBundleSupportedPlatforms: ['iPhoneSimulator'],
    CFBundleURLTypes: [{ CFBundleURLSchemes: ['station-dev-instance'] }],
  };
  let platform = 'platform IOSSIMULATOR';
  const run = vi.fn((command: string, args: string[]) => {
    if (command === 'plutil' && args[0] === '-extract')
      return JSON.stringify({
        ApplicationPath: 'Applications/Station Dev.app',
        CFBundleIdentifier: id,
      });
    if (command === 'plutil' && args.at(-1) === join(app, 'Info.plist'))
      return JSON.stringify(info);
    if (command === 'plutil') {
      expect(readFileSync(args.at(-1)!)).toEqual(xml);
      return JSON.stringify(simulatorEntitlements(id));
    }
    if (command === 'xcrun') return args[0] === 'vtool' ? platform : commands;
    return '';
  });
  return {
    root,
    archive,
    app,
    executable,
    xml,
    commands,
    run,
    setPlatform: (value: string) => {
      platform = value;
    },
  };
}

test('verification reads the actual section and seals resources without macOS iOS entitlements', () => {
  const f = archivedFixture();
  expect(verifyIosSimulator(f.archive, { root: f.root, run: f.run })).toBe(
    f.app,
  );
  expect(f.run).toHaveBeenCalledWith('codesign', [
    '--force',
    '--sign',
    '-',
    '--identifier',
    id,
    f.app,
  ]);
  expect(f.run).toHaveBeenLastCalledWith('codesign', [
    '--verify',
    '--strict',
    f.app,
  ]);
  expect(
    f.run.mock.calls
      .filter(([command]) => command === 'codesign')
      .every(([, args]) => !args.includes('--entitlements')),
  ).toBe(true);
});

test.each(['platform IOS', 'platform IOSSIMULATOR\nplatform IOS', ''])(
  'verification refuses device, mixed, and unproven platforms: %s',
  (platform) => {
    const f = archivedFixture();
    f.setPlatform(platform);
    expect(() =>
      verifyIosSimulator(f.archive, { root: f.root, run: f.run }),
    ).toThrow('non-simulator');
    expect(f.run.mock.calls.some(([command]) => command === 'codesign')).toBe(
      false,
    );
  },
);

test('section verification refuses missing, ambiguous, and out-of-file metadata', () => {
  const f = archivedFixture();
  expect(readSimulatorEntitlementSection(f.executable, f.commands)).toEqual(
    f.xml,
  );
  for (const commands of [
    '',
    f.commands + f.commands,
    f.commands.replace('offset 32', 'offset 99999'),
  ]) {
    expect(() =>
      readSimulatorEntitlementSection(f.executable, commands),
    ).toThrow();
  }
});
