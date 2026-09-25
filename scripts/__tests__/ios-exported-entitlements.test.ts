import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  exportedEntitlementsCli,
  inspectExportedIosEntitlements,
  inspectExportedIosNotificationServiceEntitlements,
} from '../ios-exported-entitlements.mjs';

const makeTempDir = trackTempDirs();

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

describe('exported Notification Service Extension entitlements (#2590)', () => {
  const appBundleId = bundleId;
  const nseIdentifier = `${team}.${appBundleId}.NotificationService`;
  const sharedGroup = `${team}.${appBundleId}.agentactivity`;
  const exported = {
    'application-identifier': nseIdentifier,
    'com.apple.developer.team-identifier': team,
    'keychain-access-groups': [sharedGroup],
  };

  test('accepts its own identifier and only the shared keychain group', () => {
    expect(
      inspectExportedIosNotificationServiceEntitlements(exported, {
        team,
        appBundleId,
      }),
    ).toEqual({
      applicationIdentifier: nseIdentifier,
      teamIdentifier: team,
      keychainAccessGroups: [sharedGroup],
    });
  });

  test.each([
    [
      'the app identifier',
      { 'application-identifier': applicationIdentifier },
      'application-identifier mismatch',
    ],
    [
      "the widget's identifier",
      { 'application-identifier': `${applicationIdentifier}.AgentActivity` },
      'application-identifier mismatch',
    ],
    [
      'another team',
      { 'com.apple.developer.team-identifier': 'ABCDEFGHIJ' },
      'team identifier mismatch',
    ],
    [
      "the app's default keychain group too",
      { 'keychain-access-groups': [applicationIdentifier, sharedGroup] },
      'must be exactly',
    ],
    [
      'no keychain group',
      { 'keychain-access-groups': undefined },
      'must be exactly',
    ],
    ['push', { 'aps-environment': 'production' }, 'must not carry push'],
    [
      'an app group',
      {
        'com.apple.security.application-groups': ['group.io.kontourai.station'],
      },
      'unexpected shared application group',
    ],
  ])('refuses %s', (_name, change, message) => {
    expect(() =>
      inspectExportedIosNotificationServiceEntitlements(
        { ...exported, ...change },
        { team, appBundleId },
      ),
    ).toThrow(message);
  });

  test('the CLI checks the extension only when asked, and refuses an unknown mode', () => {
    const read = () => JSON.stringify(exported);
    expect(
      exportedEntitlementsCli(
        ['e.json', team, appBundleId, '--notification-service-extension'],
        read,
      ).applicationIdentifier,
    ).toBe(nseIdentifier);
    // Without the flag the same file is judged as the app's, and refused.
    expect(() =>
      exportedEntitlementsCli(['e.json', team, appBundleId], read),
    ).toThrow('application-identifier mismatch');
    expect(() =>
      exportedEntitlementsCli(
        ['e.json', team, appBundleId, '--notification-service'],
        read,
      ),
    ).toThrow('Usage');
  });

  test('the command exits non-zero on a refusal and zero on a pass', () => {
    const dir = makeTempDir('station-ios-exported-');
    const run = (value: object) => {
      const path = join(dir, 'entitlements.json');
      writeFileSync(path, JSON.stringify(value));
      return spawnSync(
        process.execPath,
        [
          'scripts/ios-exported-entitlements.mjs',
          path,
          team,
          appBundleId,
          '--notification-service-extension',
        ],
        { encoding: 'utf8', windowsHide: true },
      );
    };
    const passed = run(exported);
    expect(passed.status).toBe(0);
    expect(JSON.parse(passed.stdout).applicationIdentifier).toBe(nseIdentifier);
    const refused = run({ ...exported, 'aps-environment': 'production' });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('must not carry push');
  });
});
