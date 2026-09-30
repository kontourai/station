import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { inspectAppStoreDistributionProfile } from '../check-ios-store-profile.mjs';
import { iosTestFlightReadiness } from '../ios-testflight-readiness.mjs';

const source = readFileSync(
  resolve(
    import.meta.dirname,
    'fixtures/ios-profiles/app-store-realistic.plist',
  ),
  'utf8',
);
// The production inspector, pinned to a date inside the fixture's validity
// window so the refusals below come from it and not from expiry.
const now = new Date('2026-08-27T00:00:00Z');
const inspect: typeof inspectAppStoreDistributionProfile = (xml, options) =>
  inspectAppStoreDistributionProfile(xml, { ...options, now });
describe('iOS TestFlight channel readiness', () => {
  test.each([
    ['stable', 'io.kontourai.station', 'Station by Kontour AI'],
    ['beta', 'io.kontourai.station.beta', 'Station Beta by Kontour AI'],
    [
      'nightly',
      'io.kontourai.station.nightly',
      'Station Nightly by Kontour AI',
    ],
  ])(
    'binds %s profile and listing authority',
    (channel, bundleId, appStoreName) => {
      const xml = source.replace(
        'ABCDE12345.ai.kontour.station',
        `ABCDE12345.${bundleId}`,
      );
      expect(
        iosTestFlightReadiness({
          channel,
          profilePath: '/profile',
          team: 'ABCDE12345',
          groupId: 'group-1',
          decode: () => xml,
          inspect,
        }),
      ).toMatchObject({ ready: true, bundleId, appStoreName });
    },
  );
  test('rejects malformed group identifiers and a mismatched profile', () => {
    expect(() =>
      iosTestFlightReadiness({
        channel: 'beta',
        profilePath: '/profile',
        team: 'ABCDE12345',
        groupId: 'bad group',
        decode: () => source,
        inspect,
      }),
    ).toThrow(/group ID/);
    expect(() =>
      iosTestFlightReadiness({
        channel: 'beta',
        profilePath: '/profile',
        team: 'ABCDE12345',
        groupId: 'group',
        decode: () => source,
        inspect,
      }),
    ).toThrow(/does not match expected/);
  });
});
