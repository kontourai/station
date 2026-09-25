import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import YAML from 'yaml';
import { inspectAppStoreDistributionProfile } from '../check-ios-store-profile.mjs';
import {
  EXTENSION_TARGET,
  ensureIosAgentActivity,
} from '../ensure-ios-agent-activity-extension.mjs';
import { parseCredentialPreflightOptions } from '../ios-store-credential-preflight.mjs';
import {
  agentActivityBundleId,
  mobileCargoConfig,
  parseAgentActivityOptions,
  parseOptions,
  storeAgentActivitySigningSpec,
  storeExportOptions,
  storeSigningTemplate,
  writeIosAgentActivitySigning,
  writeIosStoreSigningConfig,
} from '../ios-store-signing-config.mjs';

type ProcessFailure = Error & { status?: number };
type DistributionProfile = ReturnType<
  typeof inspectAppStoreDistributionProfile
>;

function distributionProfile(): DistributionProfile {
  return {
    distribution: 'app-store-connect',
    name: 'Station App Store',
    uuid: 'profile-uuid',
    team: 'ABCDE12345',
    expiration: '2027-01-01T00:00:00.000Z',
    applicationIdentifier: 'ABCDE12345.io.kontourai.station',
    certificateFingerprints: [],
  };
}

describe('iOS App Store signing config', () => {
  test('derives manual Xcode signing inputs from validated public profile metadata', () => {
    const template = storeSigningTemplate({
      template:
        'settingGroups:\n  app:\n    base:\n      PRODUCT_BUNDLE_IDENTIFIER: io.kontourai.station\n',
      profile: {
        name: 'Station App Store',
        team: 'ABCDE12345',
        uuid: 'profile-uuid',
      },
      identity: 'Apple Distribution: Example (ABCDE12345)',
    });
    expect(template).toContain('CODE_SIGN_STYLE: Manual');
    expect(template).toContain('PROVISIONING_PROFILE: "profile-uuid"');
    expect(template).toContain(
      'PROVISIONING_PROFILE_SPECIFIER: "Station App Store"',
    );
  });

  test('rejects multiline identity injection', () => {
    expect(() =>
      storeSigningTemplate({
        template: '      PRODUCT_BUNDLE_IDENTIFIER: io.kontourai.station\n',
        profile: {
          name: 'Station App Store',
          team: 'ABCDE12345',
          uuid: 'profile-uuid',
        },
        identity: 'Apple Distribution\nOTHER = injected',
      }),
    ).toThrow(/single-line/);
    expect(() =>
      storeSigningTemplate({
        template: '      PRODUCT_BUNDLE_IDENTIFIER: io.kontourai.station\n',
        profile: {
          name: 'Station App Store',
          team: 'ABCDE12345',
          uuid: 'profile-uuid',
        },
        identity: 'Apple Development: Example (ABCDE12345)',
      }),
    ).toThrow(/does not bind/);
    expect(() =>
      storeSigningTemplate({
        template: '      PRODUCT_BUNDLE_IDENTIFIER: io.kontourai.station\n',
        profile: {
          name: 'Station App Store\nINJECTED',
          team: 'ABCDE12345',
          uuid: 'profile-uuid',
        },
        identity: 'Apple Distribution: Example (ABCDE12345)',
      }),
    ).toThrow(/name and UUID/);
  });
  test('rejects missing or duplicate CLI options before writes', () => {
    expect(() => parseOptions(['--profile', 'profile'])).toThrow(/Missing/);
    expect(() => parseOptions(['--profile', 'a', '--profile', 'b'])).toThrow(
      /exactly once/,
    );
  });
  test('uses Station vocabulary for the protected credential preflight path', () => {
    expect(
      parseCredentialPreflightOptions([
        '--station',
        '/tmp/station.mobileprovision',
        '--identity',
        'Apple Distribution: Example (ABCDE12345)',
        '--team',
        'ABCDE12345',
        '--bundle-id',
        'io.kontourai.station',
        '--template',
        '/tmp/project.yml',
        '--template-output',
        '/tmp/generated.yml',
        '--overlay-output',
        '/tmp/overlay.json',
      ]),
    ).toMatchObject({
      profile: '/tmp/station.mobileprovision',
      bundleId: 'io.kontourai.station',
    });
  });
  test('writes only a caller-supplied HTTPS endpoint into Cargo config', () => {
    expect(mobileCargoConfig()).toBe('');
    expect(mobileCargoConfig('https://station.example.test:8441')).toContain(
      'STATION_MOBILE_DEFAULT_ENDPOINT',
    );
    expect(() => mobileCargoConfig('http://station.example.test')).toThrow(
      /HTTPS/,
    );
    expect(() =>
      mobileCargoConfig('https://user:pass@station.example.test'),
    ).toThrow(/HTTPS origin/);
  });
  test('writes exclusive profile-bound template and overlay without mutating inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-signing-config-'));
    const input = join(root, 'project.yml');
    const templateOutput = join(root, 'generated.yml');
    const overlayOutput = join(root, 'overlay.json');
    const source = '      PRODUCT_BUNDLE_IDENTIFIER: io.kontourai.station\n';
    writeFileSync(input, source);
    const dependencies = {
      decode: () => '<profile/>',
      inspect: distributionProfile,
    };
    writeIosStoreSigningConfig(
      {
        profile: join(root, 'profile'),
        identity: 'Apple Distribution: Example "Quoted" (ABCDE12345)',
        team: 'ABCDE12345',
        bundleId: 'io.kontourai.station',
        template: input,
        templateOutput,
        overlayOutput,
      },
      dependencies,
    );
    expect(readFileSync(input, 'utf8')).toBe(source);
    expect(readFileSync(templateOutput, 'utf8')).toContain(
      'CODE_SIGN_IDENTITY: "Apple Distribution: Example \\"Quoted\\" (ABCDE12345)"',
    );
    expect(
      JSON.parse(readFileSync(overlayOutput, 'utf8')).bundle.iOS.template,
    ).toBe(templateOutput);
    expect(() =>
      writeIosStoreSigningConfig(
        {
          profile: join(root, 'profile'),
          identity: 'Apple Distribution: Example (ABCDE12345)',
          team: 'ABCDE12345',
          bundleId: 'io.kontourai.station',
          template: input,
          templateOutput,
          overlayOutput,
        },
        dependencies,
      ),
    ).toThrow();
    expect(readFileSync(templateOutput, 'utf8')).toContain('Quoted');
  });
  test('rejects unreviewed bundle IDs before profile inspection or writes', () => {
    const calls: string[] = [];
    expect(() =>
      writeIosStoreSigningConfig(
        {
          profile: '/profile',
          identity: 'Apple Distribution: Example (ABCDE12345)',
          team: 'ABCDE12345',
          bundleId: 'io.kontourai.station.unreviewed',
          template: '/template',
          templateOutput: '/output.yml',
          overlayOutput: '/overlay.json',
        },
        {
          decode: () => {
            calls.push('decode');
            throw new Error('decode');
          },
          inspect: () => {
            calls.push('inspect');
            throw new Error('inspect');
          },
          read: () => {
            calls.push('read');
            throw new Error('read');
          },
          write: () => {
            calls.push('write');
            throw new Error('write');
          },
        },
      ),
    ).toThrow(/reviewed Station bundle IDs/);
    expect(calls).toEqual([]);
  });
  test('canonicalizes relative input and output paths before reading or writing', () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-signing-relative-'));
    const input = join(root, 'project.yml');
    const templateOutput = join(root, 'generated.yml');
    const overlayOutput = join(root, 'overlay.json');
    writeFileSync(
      input,
      '      PRODUCT_BUNDLE_IDENTIFIER: io.kontourai.station\n',
    );
    const read = new Proxy(readFileSync, {
      apply(target, thisArg, args) {
        expect(args[0]).toBe(input);
        return Reflect.apply(target, thisArg, args);
      },
    });
    writeIosStoreSigningConfig(
      {
        profile: relative(process.cwd(), join(root, 'profile')),
        identity: 'Apple Distribution: Example (ABCDE12345)',
        team: 'ABCDE12345',
        bundleId: 'io.kontourai.station',
        template: relative(process.cwd(), input),
        templateOutput: relative(process.cwd(), templateOutput),
        overlayOutput: relative(process.cwd(), overlayOutput),
      },
      {
        decode: (profilePath) => {
          expect(profilePath).toBe(join(root, 'profile'));
          return '<profile/>';
        },
        inspect: distributionProfile,
        read,
      },
    );
    expect(readFileSync(templateOutput, 'utf8')).toContain('CODE_SIGN_STYLE');
    expect(
      JSON.parse(readFileSync(overlayOutput, 'utf8')).bundle.iOS.template,
    ).toBe(templateOutput);
  });
  test('rejects aliased outputs before decoder or writes', () => {
    const calls: string[] = [];
    expect(() =>
      writeIosStoreSigningConfig(
        {
          profile: '/profile',
          identity: 'Apple Distribution: Example (ABCDE12345)',
          team: 'ABCDE12345',
          bundleId: 'io.kontourai.station',
          template: '/template',
          templateOutput: '/template',
          overlayOutput: '/overlay',
        },
        {
          decode: () => {
            calls.push('decode');
            throw new Error('decode');
          },
          inspect: () => {
            calls.push('inspect');
            throw new Error('inspect');
          },
          read: () => {
            calls.push('read');
            throw new Error('read');
          },
          write: () => {
            calls.push('write');
            throw new Error('write');
          },
        },
      ),
    ).toThrow(/alias/);
    expect(calls).toEqual([]);
  });
  test('profile binding failure leaves outputs absent', () => {
    const writes: string[] = [];
    expect(() =>
      writeIosStoreSigningConfig(
        {
          profile: '/profile',
          identity: 'Apple Distribution: Example (ABCDE12345)',
          team: 'ABCDE12345',
          bundleId: 'io.kontourai.station',
          template: '/template',
          templateOutput: '/out.yml',
          overlayOutput: '/overlay.json',
        },
        {
          decode: () => '<profile/>',
          inspect: () => {
            throw new Error('profile team mismatch');
          },
          write: () => {
            writes.push('write');
            throw new Error('write');
          },
        },
      ),
    ).toThrow(/mismatch/);
    expect(writes).toEqual([]);
  });
  test.each([
    ['missing', ['--profile', 'profile']],
    ['unknown', ['--bogus', 'value']],
    ['duplicate', ['--profile', 'a', '--profile', 'b']],
  ])('CLI %s options fail before creating outputs', (_name, args) => {
    const root = mkdtempSync(join(tmpdir(), 'ios-signing-cli-'));
    const output = join(root, 'output.yml');
    let failure: ProcessFailure | undefined;
    try {
      execFileSync(
        process.execPath,
        [
          'scripts/ios-store-signing-config.mjs',
          ...args,
          '--template-output',
          output,
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          windowsHide: true,
          stdio: 'pipe',
        },
      );
    } catch (error) {
      if (error instanceof Error) failure = error as ProcessFailure;
    }
    expect(failure?.status).toBe(1);
    expect(() => readFileSync(output, 'utf8')).toThrow();
  });
});

const TEAM = 'U7KHF2QAC4';
const IDENTITY = `Apple Distribution: Example (${TEAM})`;
const APP_UUID = '11111111-2222-3333-4444-555555555555';
const EXTENSION_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function extensionProfile(
  appBundleId = 'io.kontourai.station.beta',
): DistributionProfile {
  return {
    distribution: 'app-store-connect',
    name: 'Station Beta Agent Activity App Store',
    uuid: EXTENSION_UUID,
    team: TEAM,
    expiration: '2027-01-01T00:00:00.000Z',
    applicationIdentifier: `${TEAM}.${appBundleId}.AgentActivity`,
    certificateFingerprints: [],
  };
}

/**
 * The spec the TestFlight job builds from for Beta: the committed
 * Tauri-rendered spec with the channel's identity, the app's signing
 * template applied, then the Live Activity extension added — the order the
 * workflow runs them in.
 */
function betaSpecWithExtension() {
  const committed = readFileSync('src-desktop/gen/apple/project.yml', 'utf8');
  const rendered = committed.replace(
    '      PRODUCT_BUNDLE_IDENTIFIER: io.kontourai.station\n',
    '      PRODUCT_BUNDLE_IDENTIFIER: io.kontourai.station.beta\n',
  );
  expect(rendered).not.toBe(committed);
  const signed = storeSigningTemplate({
    template: rendered,
    profile: { name: 'Station Beta App Store', uuid: APP_UUID, team: TEAM },
    identity: IDENTITY,
    bundleId: 'io.kontourai.station.beta',
  });
  return ensureIosAgentActivity(
    { project: signed, infoPlist: '<plist><dict>\n</dict>\n</plist>\n' },
    { appBundleId: 'io.kontourai.station.beta', apsEnvironment: 'production' },
  ).project;
}

describe('iOS App Store signing for the Live Activity extension (#2513)', () => {
  test('names the extension only for channels that embed one', () => {
    expect(agentActivityBundleId('io.kontourai.station.beta')).toBe(
      'io.kontourai.station.beta.AgentActivity',
    );
    expect(agentActivityBundleId('io.kontourai.station.nightly')).toBe(
      'io.kontourai.station.nightly.AgentActivity',
    );
    expect(() => agentActivityBundleId('io.kontourai.station')).toThrow(
      /No reviewed Live Activity extension/,
    );
  });

  test('signs the extension target manually with its own profile, beside the app', () => {
    const project = YAML.parse(
      storeAgentActivitySigningSpec({
        project: betaSpecWithExtension(),
        profile: extensionProfile(),
        identity: IDENTITY,
        appBundleId: 'io.kontourai.station.beta',
      }),
    );
    expect(project.targets[EXTENSION_TARGET].settings.base).toMatchObject({
      STATION_APP_BUNDLE_IDENTIFIER: 'io.kontourai.station.beta',
      PRODUCT_BUNDLE_IDENTIFIER:
        '$(STATION_APP_BUNDLE_IDENTIFIER).AgentActivity',
      CODE_SIGN_STYLE: 'Manual',
      CODE_SIGN_IDENTITY: IDENTITY,
      DEVELOPMENT_TEAM: TEAM,
      PROVISIONING_PROFILE: EXTENSION_UUID,
      PROVISIONING_PROFILE_SPECIFIER: 'Station Beta Agent Activity App Store',
    });
    // The app keeps the template's signing and gains push and the groups.
    expect(project.settingGroups.app.base).toMatchObject({
      PRODUCT_BUNDLE_IDENTIFIER: 'io.kontourai.station.beta',
      CODE_SIGN_STYLE: 'Manual',
      PROVISIONING_PROFILE: APP_UUID,
    });
    expect(project.targets.station_iOS.entitlements.properties).toMatchObject({
      'aps-environment': 'production',
      'keychain-access-groups': [
        '$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)',
        '$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER).agentactivity',
      ],
    });
  });

  test('refuses a spec without the extension, for another app, or a foreign profile', () => {
    const committed = readFileSync('src-desktop/gen/apple/project.yml', 'utf8');
    expect(() =>
      storeAgentActivitySigningSpec({
        project: committed,
        profile: extensionProfile(),
        identity: IDENTITY,
        appBundleId: 'io.kontourai.station.beta',
      }),
    ).toThrow(/no StationAgentActivity app-extension target/);
    expect(() =>
      storeAgentActivitySigningSpec({
        project: betaSpecWithExtension(),
        profile: extensionProfile('io.kontourai.station.nightly'),
        identity: IDENTITY,
        appBundleId: 'io.kontourai.station.nightly',
      }),
    ).toThrow(/belongs to io.kontourai.station.beta/);
    expect(() =>
      storeAgentActivitySigningSpec({
        project: betaSpecWithExtension(),
        // The APP's profile handed in as the extension's.
        profile: {
          ...extensionProfile(),
          applicationIdentifier: `${TEAM}.io.kontourai.station.beta`,
        },
        identity: IDENTITY,
        appBundleId: 'io.kontourai.station.beta',
      }),
    ).toThrow(/profile is for/);
    expect(() =>
      storeAgentActivitySigningSpec({
        project: betaSpecWithExtension(),
        profile: extensionProfile(),
        identity: 'Apple Distribution: Example (OTHERTEAM1)',
        appBundleId: 'io.kontourai.station.beta',
      }),
    ).toThrow(/does not bind/);
  });

  test('export options name both bundles, so a manual export can sign the extension', () => {
    const plist = storeExportOptions({
      identity: `Apple Distribution: A & B (${TEAM})`,
      team: TEAM,
      profiles: {
        'io.kontourai.station.beta': APP_UUID,
        'io.kontourai.station.beta.AgentActivity': EXTENSION_UUID,
      },
    });
    expect(plist).toMatch(
      /<key>method<\/key>\s*<string>app-store-connect<\/string>/,
    );
    expect(plist).toMatch(
      /<key>signingStyle<\/key>\s*<string>manual<\/string>/,
    );
    expect(plist).toMatch(
      new RegExp(
        `<key>io\\.kontourai\\.station\\.beta</key>\\s*<string>${APP_UUID}</string>`,
      ),
    );
    expect(plist).toMatch(
      new RegExp(
        `<key>io\\.kontourai\\.station\\.beta\\.AgentActivity</key>\\s*<string>${EXTENSION_UUID}</string>`,
      ),
    );
    expect(plist).toContain(`A &amp; B (${TEAM})`);
    expect(() =>
      storeExportOptions({
        identity: IDENTITY,
        team: TEAM,
        profiles: { 'io.kontourai.station.beta': 'not-a-uuid' },
      }),
    ).toThrow(/Invalid provisioning-profile UUID/);
    expect(() =>
      storeExportOptions({
        identity: IDENTITY,
        team: TEAM,
        profiles: { 'com.example.other': APP_UUID },
      }),
    ).toThrow(/Unreviewed bundle id/);
  });

  test('replacing the committed export options drops nothing Tauri does not replace', () => {
    // The TestFlight job overwrites gen/apple/ExportOptions.plist for a Live
    // Activity build; that is safe only while the committed file holds
    // nothing but `method`, which --export-method replaces anyway.
    const committed = readFileSync(
      'src-desktop/gen/apple/ExportOptions.plist',
      'utf8',
    );
    expect(
      [...committed.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]),
    ).toEqual(['method']);
  });

  test('validates both profiles, requiring push on the app, before writing', () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-agent-activity-signing-'));
    const project = join(root, 'project.yml');
    const exportOptions = join(root, 'ExportOptions.plist');
    writeFileSync(project, betaSpecWithExtension());
    const inspections: Array<Record<string, unknown>> = [];
    const result = writeIosAgentActivitySigning(
      {
        profile: join(root, 'extension.mobileprovision'),
        appProfile: join(root, 'app.mobileprovision'),
        identity: IDENTITY,
        team: TEAM,
        appBundleId: 'io.kontourai.station.beta',
        apsEnvironment: 'production',
        project,
        exportOptionsOutput: exportOptions,
      },
      {
        decode: (path: string) => path,
        inspect: (path: string, options: Record<string, unknown>) => {
          inspections.push({ path, ...options });
          return path.endsWith('extension.mobileprovision')
            ? extensionProfile()
            : {
                ...extensionProfile(),
                name: 'Station Beta App Store',
                uuid: APP_UUID,
                applicationIdentifier: `${TEAM}.io.kontourai.station.beta`,
              };
        },
      },
    );
    expect(inspections).toEqual([
      expect.objectContaining({
        path: join(root, 'extension.mobileprovision'),
        expectedTeam: TEAM,
        expectedBundleIdentifier: 'io.kontourai.station.beta.AgentActivity',
      }),
      expect.objectContaining({
        path: join(root, 'app.mobileprovision'),
        expectedTeam: TEAM,
        expectedBundleIdentifier: 'io.kontourai.station.beta',
        expectedApsEnvironment: 'production',
      }),
    ]);
    expect(result).toMatchObject({
      app: { uuid: APP_UUID },
      extension: { uuid: EXTENSION_UUID },
    });
    expect(
      YAML.parse(readFileSync(project, 'utf8')).targets[EXTENSION_TARGET]
        .settings.base.PROVISIONING_PROFILE,
    ).toBe(EXTENSION_UUID);
    expect(readFileSync(exportOptions, 'utf8')).toContain(
      `<string>${EXTENSION_UUID}</string>`,
    );
  });

  test('a refused app profile leaves the project and export options untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-agent-activity-refusal-'));
    const project = join(root, 'project.yml');
    const exportOptions = join(root, 'ExportOptions.plist');
    const spec = betaSpecWithExtension();
    writeFileSync(project, spec);
    expect(() =>
      writeIosAgentActivitySigning(
        {
          profile: join(root, 'extension.mobileprovision'),
          appProfile: join(root, 'app.mobileprovision'),
          identity: IDENTITY,
          team: TEAM,
          appBundleId: 'io.kontourai.station.beta',
          apsEnvironment: 'production',
          project,
          exportOptionsOutput: exportOptions,
        },
        {
          decode: (path: string) => path,
          inspect: (path: string) => {
            if (path.endsWith('app.mobileprovision'))
              throw new Error('aps-environment (absent) does not match');
            return extensionProfile();
          },
        },
      ),
    ).toThrow(/aps-environment/);
    expect(readFileSync(project, 'utf8')).toBe(spec);
    expect(() => readFileSync(exportOptions, 'utf8')).toThrow();
  });

  test('refuses Stable before reading any profile', () => {
    const calls: string[] = [];
    expect(() =>
      writeIosAgentActivitySigning(
        {
          profile: '/extension',
          appProfile: '/app',
          identity: IDENTITY,
          team: TEAM,
          appBundleId: 'io.kontourai.station',
          apsEnvironment: 'production',
          project: '/project.yml',
          exportOptionsOutput: '/ExportOptions.plist',
        },
        {
          decode: () => {
            calls.push('decode');
            return '';
          },
        },
      ),
    ).toThrow(/No reviewed Live Activity extension/);
    expect(calls).toEqual([]);
  });

  test('requires every agent-activity option exactly once', () => {
    const args = [
      '--profile',
      'e',
      '--app-profile',
      'a',
      '--identity',
      IDENTITY,
      '--team',
      TEAM,
      '--app-bundle-id',
      'io.kontourai.station.beta',
      '--aps-environment',
      'production',
      '--project',
      'p',
      '--export-options-output',
      'o',
    ];
    expect(parseAgentActivityOptions(args)).toMatchObject({
      'app-profile': 'a',
      'aps-environment': 'production',
    });
    expect(() => parseAgentActivityOptions(args.slice(0, -2))).toThrow(
      /Missing/,
    );
    expect(() =>
      parseAgentActivityOptions([...args.slice(0, -2), '--profile', 'x']),
    ).toThrow(/exactly once/);
  });

  test('carries the plugin half of the switch as cargo config', () => {
    expect(mobileCargoConfig(undefined, { liveActivity: true })).toBe(
      '[env]\nSTATION_IOS_LIVE_ACTIVITY = { value = "1", force = true }\n',
    );
    const both = mobileCargoConfig('https://station.example.test', {
      liveActivity: true,
    });
    expect(both).toContain('STATION_MOBILE_DEFAULT_ENDPOINT');
    expect(both).toContain(
      'STATION_IOS_LIVE_ACTIVITY = { value = "1", force = true }',
    );
    expect(both.match(/\[env\]/g)).toHaveLength(1);
    expect(mobileCargoConfig('https://station.example.test')).not.toContain(
      'STATION_IOS_LIVE_ACTIVITY',
    );
  });
});
