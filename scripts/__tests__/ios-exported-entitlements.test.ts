import { describe, expect, test } from 'vitest';
import {
  exportedEntitlementsCli,
  inspectExportedIosAgentActivityEntitlements,
  inspectExportedIosEntitlements,
} from '../ios-exported-entitlements.mjs';

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
