import { describe, expect, test } from 'vitest';
import { inspectExportedIosEntitlements } from '../ios-exported-entitlements.mjs';

const team = 'U7KHF2QAC4';
const bundleId = 'io.kontourai.station.nightly';
const applicationIdentifier = `${team}.${bundleId}`;
const required = {
  'application-identifier': applicationIdentifier,
  'com.apple.developer.team-identifier': team,
};

describe('exported iOS entitlement verification', () => {
  test('accepts the platform default keychain group when no custom group is requested', () => {
    expect(
      inspectExportedIosEntitlements(required, { team, bundleId }),
    ).toEqual({
      applicationIdentifier,
      teamIdentifier: team,
      keychainAccessGroups: null,
      sharedApplicationGroups: null,
    });
  });

  test('accepts an explicit exact singleton keychain group', () => {
    expect(
      inspectExportedIosEntitlements(
        { ...required, 'keychain-access-groups': [applicationIdentifier] },
        { team, bundleId },
      ).keychainAccessGroups,
    ).toEqual([applicationIdentifier]);
  });

  test('rejects a foreign or shared keychain group', () => {
    expect(() =>
      inspectExportedIosEntitlements(
        { ...required, 'keychain-access-groups': [`${team}.*`] },
        { team, bundleId },
      ),
    ).toThrow('must be absent or exactly');
  });

  test('rejects a shared application group', () => {
    expect(() =>
      inspectExportedIosEntitlements(
        {
          ...required,
          'com.apple.security.application-groups': [
            'group.io.kontourai.station',
          ],
        },
        { team, bundleId },
      ),
    ).toThrow('unexpected shared application group');
  });
});
