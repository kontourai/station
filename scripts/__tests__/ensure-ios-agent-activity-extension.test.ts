import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import YAML from 'yaml';
import {
  EXTENSION_TARGET,
  ensureIosAgentActivity,
  ensureIosAgentActivityExtension,
} from '../ensure-ios-agent-activity-extension.mjs';

const appInfoPlist = readFileSync(
  'src-desktop/gen/apple/station_iOS/Info.plist',
  'utf8',
);

function plistString(plist: string, key: string) {
  return plist.match(
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`),
  )?.[1];
}

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
const committedAppEntitlements =
  'src-desktop/gen/apple/station_iOS/station_iOS.entitlements';

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

  test.each(['development', 'production'])(
    'writes the %s entitlement and its Info.plist copy from one argument',
    (apsEnvironment) => {
      const once = ensureIosAgentActivity(
        { project: renderedProject, infoPlist: appInfoPlist },
        { appBundleId: 'io.kontourai.station', apsEnvironment },
      );
      const entitlements = YAML.parse(once.project).targets.station_iOS
        .entitlements.properties;
      expect(entitlements['aps-environment']).toBe(apsEnvironment);
      expect(plistString(once.infoPlist, 'StationApsEnvironment')).toBe(
        apsEnvironment,
      );
      // Re-running with the other environment moves both together.
      const other =
        apsEnvironment === 'production' ? 'development' : 'production';
      const again = ensureIosAgentActivity(
        { project: once.project, infoPlist: once.infoPlist },
        { appBundleId: 'io.kontourai.station', apsEnvironment: other },
      );
      expect(
        YAML.parse(again.project).targets.station_iOS.entitlements.properties[
          'aps-environment'
        ],
      ).toBe(other);
      expect(plistString(again.infoPlist, 'StationApsEnvironment')).toBe(other);
      expect(again.infoPlist.match(/StationApsEnvironment/g)).toHaveLength(1);
      // The rest of the Info.plist is untouched.
      expect(plistString(again.infoPlist, 'NSCameraUsageDescription')).toBe(
        plistString(appInfoPlist, 'NSCameraUsageDescription'),
      );
    },
  );

  test('refuses an environment without its Info.plist copy, and the reverse', () => {
    expect(() =>
      ensureIosAgentActivity(
        { project: renderedProject },
        { appBundleId: 'io.kontourai.station', apsEnvironment: 'production' },
      ),
    ).toThrow('required together');
    expect(() =>
      ensureIosAgentActivity(
        { project: renderedProject, infoPlist: appInfoPlist },
        { appBundleId: 'io.kontourai.station' },
      ),
    ).toThrow('required together');
    expect(() =>
      ensureIosAgentActivity(
        { project: renderedProject, infoPlist: appInfoPlist },
        { appBundleId: 'io.kontourai.station', apsEnvironment: 'sandbox' },
      ),
    ).toThrow('aps-environment');
  });

  test('the extension takes its versions from the app at build time', () => {
    const extension = ensure(renderedProject).targets[EXTENSION_TARGET];
    expect(extension.settings.base.MARKETING_VERSION).toBeUndefined();
    expect(extension.settings.base.CURRENT_PROJECT_VERSION).toBeUndefined();
    const [script] = extension.postBuildScripts;
    expect(script.inputFiles).toEqual([
      '$(PROJECT_DIR)/station_iOS/Info.plist',
    ]);
    for (const key of ['CFBundleShortVersionString', 'CFBundleVersion'])
      expect(script.script).toContain(key);
    expect(script.script).toContain('"$TARGET_BUILD_DIR/$INFOPLIST_PATH"');
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

  test('a re-run without an APNs environment keeps the paired one, or is refused', () => {
    const withAps = ensureIosAgentActivity(
      { project: renderedProject, infoPlist: appInfoPlist },
      { appBundleId: 'io.kontourai.station', apsEnvironment: 'production' },
    );
    // The second, aps-less run would otherwise drop the entitlement while
    // Info.plist still says production, and the plugin would report push as
    // configured on a build that can never get a token.
    expect(() =>
      ensureIosAgentActivity(
        { project: withAps.project },
        { appBundleId: 'io.kontourai.station' },
      ),
    ).toThrow('stay paired');
    // Naming it again is the supported re-run and keeps both in place.
    const again = ensureIosAgentActivity(
      { project: withAps.project, infoPlist: withAps.infoPlist },
      { appBundleId: 'io.kontourai.station', apsEnvironment: 'production' },
    );
    expect(again).toEqual(withAps);
  });

  test('keeps entitlement properties it does not own', () => {
    const project = renderedProject.replace(
      '      path: station_iOS/station_iOS.entitlements\n',
      [
        '      path: station_iOS/station_iOS.entitlements',
        '      properties:',
        '        com.apple.developer.associated-domains:',
        '          - applinks:example.com',
        '        keychain-access-groups:',
        '          - $(AppIdentifierPrefix)com.example.shared',
        '',
      ].join('\n'),
    );
    const properties =
      ensure(project).targets.station_iOS.entitlements.properties;
    expect(properties['com.apple.developer.associated-domains']).toEqual([
      'applinks:example.com',
    ]);
    expect(properties['keychain-access-groups']).toEqual([
      '$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)',
      '$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER).agentactivity',
      '$(AppIdentifierPrefix)com.example.shared',
    ]);
  });

  test('the committed project does not carry the extension until a build enables it', () => {
    // Every build path that uses the committed gen/apple (CI simulator
    // builds, build:ios:simulator, tauri ios dev, a local App Store export)
    // must build exactly what it did before #2513: no embedded extension to
    // provision and no new app entitlements.
    const committed = readFileSync(committedSpec, 'utf8');
    const parsed = YAML.parse(committed);
    expect(parsed.targets[EXTENSION_TARGET]).toBeUndefined();
    expect(parsed.targets.station_iOS.entitlements).toEqual({
      path: 'station_iOS/station_iOS.entitlements',
    });
    expect(JSON.stringify(parsed.targets.station_iOS.dependencies)).not.toMatch(
      /StationAgentActivity|ActivityKit/,
    );
    expect(readFileSync(committedXcodeProject, 'utf8')).not.toMatch(
      /StationAgentActivity|ActivityKit/,
    );
    expect(readFileSync(committedAppEntitlements, 'utf8')).not.toContain(
      'keychain-access-groups',
    );
    // An enabled build applies it to this same spec, once.
    const enabled = ensureIosAgentActivityExtension(committed, {
      appBundleId: 'io.kontourai.station',
    });
    expect(YAML.parse(enabled).targets[EXTENSION_TARGET].type).toBe(
      'app-extension',
    );
    expect(
      ensureIosAgentActivityExtension(enabled, {
        appBundleId: 'io.kontourai.station',
      }),
    ).toBe(enabled);
  });
});
