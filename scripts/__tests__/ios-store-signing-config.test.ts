import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { inspectAppStoreDistributionProfile } from '../check-ios-store-profile.mjs';
import { parseCredentialPreflightOptions } from '../ios-store-credential-preflight.mjs';
import {
  mobileCargoConfig,
  parseOptions,
  storeSigningTemplate,
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
