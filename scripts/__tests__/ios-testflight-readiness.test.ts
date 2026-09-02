import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { iosTestFlightReadiness } from '../ios-testflight-readiness.mjs';

const source = readFileSync(
  resolve(
    import.meta.dirname,
    'fixtures/ios-profiles/app-store-realistic.plist',
  ),
  'utf8',
);
const certificate =
  /<key>DeveloperCertificates<\/key>\s*<array>\s*<data>([^<]+)/
    .exec(source)?.[1]
    .trim() ?? '';
const fingerprint = createHash('sha1')
  .update(Buffer.from(certificate, 'base64'))
  .digest('hex')
  .toUpperCase();
function inspect(
  xml: unknown,
  expected: { expectedTeam?: string; expectedBundleIdentifier?: string } = {},
) {
  const id = /<string>(ABCDE12345\.[^<]+)<\/string>/.exec(String(xml))?.[1];
  if (id !== `${expected.expectedTeam}.${expected.expectedBundleIdentifier}`)
    throw new Error('bundle mismatch');
  return {
    distribution: 'app-store-connect',
    name: 'Station App Store',
    uuid: 'profile-uuid',
    team: expected.expectedTeam,
    expiration: '2027-01-01T00:00:00.000Z',
    applicationIdentifier: id,
    certificateFingerprints: [fingerprint],
  };
}
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
    ).toThrow(/bundle mismatch/);
  });
});
