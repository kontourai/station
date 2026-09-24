import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import YAML from 'yaml';
import {
  EXTENSION_TARGET,
  ensureIosAgentActivityExtension,
} from '../ensure-ios-agent-activity-extension.mjs';

// The shape `tauri ios init` renders (see the committed spec before #2513).
const renderedProject = `name: station
targets:
  station_iOS:
    type: application
    platform: iOS
    sources:
      - path: Sources
      - path: station_iOS
    entitlements:
      path: station_iOS/station_iOS.entitlements
    dependencies:
      - framework: libapp.a
        embed: false
      - sdk: UIKit.framework
`;

const committedSpec = 'src-desktop/gen/apple/project.yml';
const committedXcodeProject =
  'src-desktop/gen/apple/station.xcodeproj/project.pbxproj';

function ensure(project: string, options: Record<string, string> = {}) {
  return YAML.parse(
    ensureIosAgentActivityExtension(project, {
      appBundleId: 'io.kontourai.station.beta',
      ...options,
    }),
  );
}

describe('iOS agent-activity extension project spec', () => {
  test('adds the widget extension as an iOS 18 app extension of this app', () => {
    const extension = ensure(renderedProject).targets[EXTENSION_TARGET];
    expect(extension.type).toBe('app-extension');
    expect(extension.platform).toBe('iOS');
    expect(extension.deploymentTarget).toBe('18.0');
    expect(extension.settings.base.STATION_APP_BUNDLE_IDENTIFIER).toBe(
      'io.kontourai.station.beta',
    );
    expect(extension.settings.base.PRODUCT_BUNDLE_IDENTIFIER).toBe(
      '$(STATION_APP_BUNDLE_IDENTIFIER).AgentActivity',
    );
    expect(
      extension.sources.map((source: { path: string }) => source.path),
    ).toEqual([
      '../../ios/StationAgentActivity',
      '../../plugins/agent-activity/ios/Sources/StationAgentActivityShared',
    ]);
    expect(extension.settings.base.INFOPLIST_FILE).toBe(
      '../../ios/StationAgentActivity/Info.plist',
    );
  });

  test('embeds the extension in the app and links ActivityKit weakly', () => {
    const dependencies =
      ensure(renderedProject).targets.station_iOS.dependencies;
    expect(dependencies).toContainEqual({
      target: EXTENSION_TARGET,
      embed: true,
    });
    expect(dependencies).toContainEqual({
      sdk: 'ActivityKit.framework',
      weak: true,
    });
    // Tauri's own dependencies are preserved.
    expect(dependencies).toContainEqual({
      framework: 'libapp.a',
      embed: false,
    });
    expect(dependencies).toContainEqual({ sdk: 'UIKit.framework' });
  });

  test('lists the default keychain group before the shared one', () => {
    const entitlements =
      ensure(renderedProject).targets.station_iOS.entitlements;
    expect(entitlements.path).toBe('station_iOS/station_iOS.entitlements');
    expect(entitlements.properties['keychain-access-groups']).toEqual([
      '$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)',
      '$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER).agentactivity',
    ]);
    expect(entitlements.properties['aps-environment']).toBeUndefined();
  });

  test('names the APNs environment only when asked to', () => {
    const entitlements = ensure(renderedProject, {
      apsEnvironment: 'production',
    }).targets.station_iOS.entitlements;
    expect(entitlements.properties['aps-environment']).toBe('production');
    expect(() =>
      ensure(renderedProject, { apsEnvironment: 'sandbox' }),
    ).toThrow('aps-environment');
  });

  test('is idempotent', () => {
    const once = ensureIosAgentActivityExtension(renderedProject, {
      appBundleId: 'io.kontourai.station',
    });
    expect(
      ensureIosAgentActivityExtension(once, {
        appBundleId: 'io.kontourai.station',
      }),
    ).toBe(once);
  });

  test('fails closed on an unrecognized spec or identity', () => {
    expect(() => ensure('targets: {}\n')).toThrow(
      'station_iOS application target',
    );
    expect(() =>
      ensure(renderedProject.replace(/ {4}entitlements:\n.*\n/, '')),
    ).toThrow('entitlements path');
    expect(() =>
      ensure(renderedProject, { appBundleId: 'com.example.app' }),
    ).toThrow('bundle identifier');
  });

  test('the committed spec and Xcode project already carry the extension', () => {
    const committed = readFileSync(committedSpec, 'utf8');
    expect(
      ensureIosAgentActivityExtension(committed, {
        appBundleId: 'io.kontourai.station',
      }),
    ).toBe(committed);
    const xcodeProject = readFileSync(committedXcodeProject, 'utf8');
    expect(xcodeProject).toContain(
      '/* StationAgentActivity.appex in Embed Foundation Extensions */',
    );
    expect(xcodeProject).toMatch(
      /ActivityKit\.framework in Frameworks \*\/ = \{[^}]*settings = \{ATTRIBUTES = \(Weak, \); \}/,
    );
  });
});
