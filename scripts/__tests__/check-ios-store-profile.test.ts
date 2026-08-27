import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  assertAppStoreDistributionProfile,
  decodeProvisioningProfile,
  inspectAppStoreDistributionProfile,
  verifyAppStoreProvisioningProfile,
} from '../check-ios-store-profile.mjs';

const fixture = (name: string) =>
  readFileSync(
    resolve(import.meta.dirname, 'fixtures/ios-profiles', name),
    'utf8',
  );

describe('App Store iOS provisioning-profile gate', () => {
  test('binds an App Store profile to the expected team, bundle, and unexpired date', () => {
    expect(
      inspectAppStoreDistributionProfile(fixture('app-store-realistic.plist'), {
        expectedTeam: 'ABCDE12345',
        expectedBundleIdentifier: 'ai.kontour.station',
        now: new Date('2026-08-27T00:00:00Z'),
      }),
    ).toMatchObject({
      distribution: 'app-store-connect',
      team: 'ABCDE12345',
      applicationIdentifier: 'ABCDE12345.ai.kontour.station',
    });
  });

  test('rejects an expired, wrong-team, or wrong-bundle App Store profile', () => {
    const profile = fixture('app-store-realistic.plist');
    expect(() =>
      inspectAppStoreDistributionProfile(profile, {
        expectedTeam: 'ABCDE12345',
        expectedBundleIdentifier: 'ai.kontour.station',
        now: new Date('2028-01-01T00:00:00Z'),
      }),
    ).toThrow('expired or has an invalid ExpirationDate');
    expect(() =>
      inspectAppStoreDistributionProfile(profile, {
        expectedTeam: 'OTHERTEAM',
        expectedBundleIdentifier: 'ai.kontour.station',
        now: new Date('2026-08-27T00:00:00Z'),
      }),
    ).toThrow('does not match expected team OTHERTEAM');
    expect(() =>
      inspectAppStoreDistributionProfile(profile, {
        expectedTeam: 'ABCDE12345',
        expectedBundleIdentifier: 'io.kontourai.station',
        now: new Date('2026-08-27T00:00:00Z'),
      }),
    ).toThrow('does not match expected ABCDE12345.io.kontourai.station');
  });

  test('rejects missing, invalid, future, and post-expiry profile creation dates', () => {
    const profile = fixture('app-store-realistic.plist');
    const options = {
      expectedTeam: 'ABCDE12345',
      expectedBundleIdentifier: 'ai.kontour.station',
      now: new Date('2026-08-27T00:00:00Z'),
    };
    for (const replacement of [
      '<date>not-a-date</date>',
      '<date>2026-09-01T00:00:00Z</date>',
      '<date>2028-09-01T00:00:00Z</date>',
      '<false/>',
      '<true/>',
      '<integer>1</integer>',
      '<array><string>2026-08-01T10:00:00Z</string></array>',
      '<dict><key>x</key><string>y</string></dict>',
    ]) {
      expect(() =>
        inspectAppStoreDistributionProfile(
          profile.replace('<date>2026-08-01T10:00:00Z</date>', replacement),
          options,
        ),
      ).toThrow(/CreationDate|Unable to parse|required keys/);
    }
    expect(() =>
      inspectAppStoreDistributionProfile(
        profile.replace(
          /\s*<key>CreationDate<\/key>\s*<date>[^<]+<\/date>/,
          '',
        ),
        options,
      ),
    ).toThrow('invalid CreationDate');
  });

  test('rejects a profile whose entitlement team conflicts with its profile team', () => {
    expect(() =>
      inspectAppStoreDistributionProfile(
        fixture('app-store-realistic.plist').replace(
          '<string>ABCDE12345</string>\n\t\t<key>aps-environment</key>',
          '<string>OTHERTEAM</string>\n\t\t<key>aps-environment</key>',
        ),
        {
          expectedTeam: 'ABCDE12345',
          expectedBundleIdentifier: 'ai.kontour.station',
          now: new Date('2026-08-27T00:00:00Z'),
        },
      ),
    ).toThrow('entitlement team OTHERTEAM');
  });

  test('accepts an App Store profile with no ProvisionedDevices', () => {
    expect(
      assertAppStoreDistributionProfile(fixture('app-store.plist')),
    ).toEqual({
      distribution: 'app-store-connect',
    });
  });

  test('rejects an ad-hoc profile with ProvisionedDevices', () => {
    expect(() =>
      assertAppStoreDistributionProfile(
        fixture('ad-hoc.plist'),
        'exported IPA',
      ),
    ).toThrow(
      'exported IPA has ProvisionedDevices and is an ad-hoc/development provisioning profile, not an App Store distribution profile; APPLE_PROVISIONING_PROFILE_BASE64 must contain an App Store distribution provisioning profile.',
    );
  });

  test('rejects a development profile with get-task-allow', () => {
    expect(() =>
      assertAppStoreDistributionProfile(
        fixture('development.plist'),
        'APPLE_PROVISIONING_PROFILE_BASE64',
      ),
    ).toThrow(
      'APPLE_PROVISIONING_PROFILE_BASE64 is a development provisioning profile because get-task-allow is enabled; APPLE_PROVISIONING_PROFILE_BASE64 must contain an App Store distribution provisioning profile.',
    );
  });

  test('rejects a managed enterprise profile without ProvisionedDevices', () => {
    expect(() =>
      assertAppStoreDistributionProfile(
        fixture('enterprise.plist'),
        'exported IPA',
      ),
    ).toThrow(
      'exported IPA is a managed enterprise provisioning profile (ProvisionsAllDevices is enabled), not an App Store distribution profile; APPLE_PROVISIONING_PROFILE_BASE64 must contain an App Store distribution provisioning profile.',
    );
  });

  test('fails closed for an unparseable embedded.mobileprovision fixture', () => {
    expect(() =>
      assertAppStoreDistributionProfile(
        fixture('unparseable.plist'),
        'embedded.mobileprovision',
      ),
    ).toThrow(
      'Unable to parse embedded.mobileprovision as a decoded provisioning-profile plist; APPLE_PROVISIONING_PROFILE_BASE64 must contain an App Store distribution provisioning profile.',
    );
  });

  test('fails closed for malformed XML that contains a plist tag', () => {
    expect(() =>
      assertAppStoreDistributionProfile(
        '<plist><dict><key>UUID</key><string>truncated</dict></plist>',
        'malformed profile',
      ),
    ).toThrow(
      'Unable to parse malformed profile as a decoded provisioning-profile plist; APPLE_PROVISIONING_PROFILE_BASE64 must contain an App Store distribution provisioning profile.',
    );
  });

  test('fails closed for a well-formed plist that is not a provisioning profile', () => {
    expect(() =>
      assertAppStoreDistributionProfile(
        '<plist version="1.0"><dict><key>Title</key><string>unrelated</string></dict></plist>',
        'unrelated plist',
      ),
    ).toThrow(
      'unrelated plist is not a provisioning profile: missing required key(s) UUID, TeamIdentifier, ExpirationDate, Entitlements, AppIDName; APPLE_PROVISIONING_PROFILE_BASE64 must contain an App Store distribution provisioning profile.',
    );
  });

  test('fails closed for a binary plist', () => {
    expect(() =>
      assertAppStoreDistributionProfile('bplist00\0\x01\x02', 'binary profile'),
    ).toThrow(
      'Unable to parse binary profile as a decoded provisioning-profile plist; APPLE_PROVISIONING_PROFILE_BASE64 must contain an App Store distribution provisioning profile.',
    );
  });

  test('fails closed when the embedded.mobileprovision fixture is missing', () => {
    const absentProfile = resolve(
      import.meta.dirname,
      'fixtures/ios-profiles',
      fixture('missing-profile-path.txt').trim(),
    );
    expect(() =>
      verifyAppStoreProvisioningProfile(
        absentProfile,
        'embedded.mobileprovision',
      ),
    ).toThrow(
      `Missing embedded.mobileprovision at ${absentProfile}; cannot verify App Store distribution.`,
    );
  });

  test('fails closed when security is absent', () => {
    const profile = resolve(
      import.meta.dirname,
      'fixtures/ios-profiles',
      'app-store.plist',
    );
    expect(() =>
      decodeProvisioningProfile(profile, () => {
        throw new Error('spawn security ENOENT');
      }),
    ).toThrow(
      `Unable to decode embedded.mobileprovision at ${profile} with security cms; cannot verify App Store distribution.`,
    );
  });

  test('fails closed when security cms exits non-zero', () => {
    const profile = resolve(
      import.meta.dirname,
      'fixtures/ios-profiles',
      'app-store.plist',
    );
    expect(() =>
      decodeProvisioningProfile(profile, () => {
        throw new Error('security cms exited 1');
      }),
    ).toThrow(
      `Unable to decode embedded.mobileprovision at ${profile} with security cms; cannot verify App Store distribution.`,
    );
  });

  /**
   * The fixtures above are minimal. A real Apple profile also carries `<data>`
   * (DeveloperCertificates, DER-Encoded-Profile), `<integer>` (TimeToLive,
   * Version), `<date>`, and a nested Entitlements dictionary — so a parser that
   * only handled the minimal shape would pass every test above and then reject
   * a legitimate profile on a release tag, which is its own outage. These
   * fixtures are shaped like the real thing and pin both directions.
   */
  test('accepts a realistic App Store profile carrying data, integer, date and nested dict values', () => {
    expect(
      () =>
        assertAppStoreDistributionProfile(
          fixture('app-store-realistic.plist'),
          'realistic App Store profile',
        ),
      'a realistic App Store profile was rejected — the parser cannot read real Apple profile shapes, which would fail a release on a tag',
    ).not.toThrow();
  });

  test('rejects a realistic ad-hoc profile with a device list', () => {
    expect(
      () =>
        assertAppStoreDistributionProfile(
          fixture('ad-hoc-realistic.plist'),
          'realistic ad-hoc profile',
        ),
      'a realistic ad-hoc profile passed the App Store gate',
    ).toThrow(/ProvisionedDevices/);
  });

  test('rejects a realistic enterprise profile', () => {
    expect(
      () =>
        assertAppStoreDistributionProfile(
          fixture('enterprise-realistic.plist'),
          'realistic enterprise profile',
        ),
      'a realistic enterprise profile passed the App Store gate',
    ).toThrow(/ProvisionsAllDevices/);
  });
});
