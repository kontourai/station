import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  exportedEntitlementsCli,
  inspectExportedIosAgentActivityEntitlements,
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

describe('exported entitlements of a Live Activity build (#2513)', () => {
  const sharedGroup = `${applicationIdentifier}.agentactivity`;
  const liveApp = {
    ...required,
    'aps-environment': 'production',
    'keychain-access-groups': [applicationIdentifier, sharedGroup],
  };
  const live = {
    team,
    bundleId,
    liveActivity: true,
    apsEnvironment: 'production',
  };

  test('accepts the app with its default group first, the shared group, and push', () => {
    expect(inspectExportedIosEntitlements(liveApp, live)).toEqual({
      applicationIdentifier,
      teamIdentifier: team,
      keychainAccessGroups: [applicationIdentifier, sharedGroup],
      sharedApplicationGroups: null,
      apsEnvironment: 'production',
    });
  });

  test('the same entitlements are refused outside a Live Activity build', () => {
    expect(() =>
      inspectExportedIosEntitlements(liveApp, { team, bundleId }),
    ).toThrow('must be absent or exactly');
  });

  test.each([
    ['without the shared group', [applicationIdentifier]],
    ['in the other order', [sharedGroup, applicationIdentifier]],
    ['with a wildcard', [applicationIdentifier, sharedGroup, `${team}.*`]],
    ['without groups', undefined],
  ])('refuses keychain groups %s', (_name, groups) => {
    expect(() =>
      inspectExportedIosEntitlements(
        { ...liveApp, 'keychain-access-groups': groups },
        live,
      ),
    ).toThrow('in a Live Activity build');
  });

  test.each([
    ['absent', undefined, '(absent)'],
    ['development', 'development', 'development'],
  ])('refuses push that is %s', (_name, aps, shown) => {
    expect(() =>
      inspectExportedIosEntitlements(
        { ...liveApp, 'aps-environment': aps },
        live,
      ),
    ).toThrow(`must be production, got ${shown}`);
  });

  test('a Live Activity check must name the environment it expects', () => {
    expect(() =>
      inspectExportedIosEntitlements(liveApp, {
        team,
        bundleId,
        liveActivity: true,
      }),
    ).toThrow('names the APNs environment');
  });

  const widget = {
    'application-identifier': `${applicationIdentifier}.AgentActivity`,
    'com.apple.developer.team-identifier': team,
    'keychain-access-groups': [sharedGroup],
  };

  test('accepts the widget with only the shared group', () => {
    expect(
      inspectExportedIosAgentActivityEntitlements(widget, {
        team,
        appBundleId: bundleId,
      }),
    ).toEqual({
      applicationIdentifier: `${applicationIdentifier}.AgentActivity`,
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
      'the app default group',
      { 'keychain-access-groups': [applicationIdentifier, sharedGroup] },
      'must be exactly',
    ],
    ['push', { 'aps-environment': 'production' }, 'must not carry push'],
    [
      'an app group',
      { 'com.apple.security.application-groups': ['group.x'] },
      'unexpected shared application group',
    ],
  ])('refuses a widget carrying %s', (_name, change, message) => {
    expect(() =>
      inspectExportedIosAgentActivityEntitlements(
        { ...widget, ...change },
        { team, appBundleId: bundleId },
      ),
    ).toThrow(message);
  });

  test('the CLI selects the check by mode and refuses anything else', () => {
    const read = (path: string) =>
      JSON.stringify(path === 'app.json' ? liveApp : widget);
    expect(
      exportedEntitlementsCli(
        ['app.json', team, bundleId, '--live-activity', 'production'],
        read,
      ),
    ).toMatchObject({ apsEnvironment: 'production' });
    expect(
      exportedEntitlementsCli(
        ['widget.json', team, bundleId, '--agent-activity-extension'],
        read,
      ),
    ).toMatchObject({ keychainAccessGroups: [sharedGroup] });
    // No mode: the pre-Live-Activity rule, which refuses the live app.
    expect(() =>
      exportedEntitlementsCli(['app.json', team, bundleId], read),
    ).toThrow('must be absent or exactly');
    for (const args of [
      ['app.json', team, bundleId, '--live-activity'],
      ['app.json', team, bundleId, '--bogus'],
      ['widget.json', team, bundleId, '--agent-activity-extension', 'x'],
      ['app.json', team, bundleId, '--live-activity', 'production', 'extra'],
    ])
      expect(() => exportedEntitlementsCli(args, read)).toThrow('Usage');
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
    // Nor does the widget's mode accept it.
    expect(() =>
      exportedEntitlementsCli(
        ['e.json', team, appBundleId, '--agent-activity-extension'],
        read,
      ),
    ).toThrow('Exported Live Activity application-identifier mismatch');
    for (const args of [
      ['e.json', team, appBundleId, '--notification-service'],
      ['e.json', team, appBundleId, '--notification-service-extension', 'x'],
    ])
      expect(() => exportedEntitlementsCli(args, read)).toThrow('Usage');
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
