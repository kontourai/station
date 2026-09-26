import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  assertEnvironmentAdmissions,
  assertInternalTagRuleset,
} from '../ios-testflight-delivery-policy.mjs';

const environment = () => ({
  deployment_branch_policy: {
    protected_branches: false,
    custom_branch_policies: true,
  },
  branch_policies: [{ name: 'main', type: 'branch' }],
});
const ruleset = {
  id: 7,
  name: 'protect internal TestFlight authority',
  target: 'tag',
  enforcement: 'active',
  conditions: {
    ref_name: { include: ['refs/tags/ios-testflight/**'], exclude: [] },
  },
  rules: [{ type: 'non_fast_forward' }, { type: 'deletion' }],
  bypass_actors: [],
};

describe('internal iOS TestFlight delivery admission', () => {
  const workflow = readFileSync(
    resolve(
      import.meta.dirname,
      '../../.github/workflows/testflight-delivery.yml',
    ),
    'utf8',
  );
  test.each([
    [
      'protected secret binding',
      `APPLE_NOTIFICATION_SERVICE_PROVISIONING_PROFILE_BASE64: \${{ secrets.APPLE_NOTIFICATION_SERVICE_PROVISIONING_PROFILE_BASE64 }}`,
    ],
    ['channel identity', '.notificationServiceBundleId ?? ""'],
    [
      'widget and NSE channel parity',
      'test "$notification_enabled" = "$enabled"',
    ],
    [
      'conditional NSE secret requirement',
      `if [ '\${{ steps.live_activity.outputs.notification_enabled }}' = true ]; then\n            test -n "$APPLE_NOTIFICATION_SERVICE_PROVISIONING_PROFILE_BASE64"`,
    ],
    [
      'missing protected value refusal',
      'Missing required protected channel value: APPLE_NOTIFICATION_SERVICE_PROVISIONING_PROFILE_BASE64',
    ],
    ['profile import', 'base64 --decode > "$notification_profile"'],
    [
      'profile identity binding',
      `test "$notification_bundle_id" = '\${{ steps.app_store.outputs.bundle_id }}.NotificationService'`,
    ],
    [
      'expected bundle and team',
      '--expected-team "$APPLE_DEVELOPMENT_TEAM" --expected-bundle-id "$notification_bundle_id" --expected-certificate-sha1 "$signing_certificate_sha1"',
    ],
    [
      'profile UUID installation',
      'cp "$notification_profile" "$HOME/Library/MobileDevice/Provisioning Profiles/$notification_uuid.mobileprovision"',
    ],
    [
      'profile UUID validation',
      '[[ "$notification_uuid" =~ ^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$ ]]',
    ],
    ['XcodeGen switch', 'notification_args=(--notification-service)'],
    [
      'manual signing profile',
      'signing_args=(--notification-service-profile "$RUNNER_TEMP/station-ios-notification-service.mobileprovision")',
    ],
    [
      'generated target assertion',
      "grep -Fq 'StationNotificationService.appex' gen/apple/station.xcodeproj/project.pbxproj",
    ],
    [
      'unwanted target refusal',
      "echo 'A channel without a Notification Service extension generated one' >&2",
    ],
    [
      'ExportOptions entry',
      `grep -Fq '<key>\${{ steps.live_activity.outputs.notification_bundle_id }}</key>' gen/apple/ExportOptions.plist`,
    ],
    [
      'exact extension count',
      'if [ "$NOTIFICATION_SERVICE" = true ]; then expected_extension_count=2; else expected_extension_count=1; fi',
    ],
    [
      'exact extension set assertion',
      `test "$(find "$app/PlugIns" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')" = "$expected_extension_count"`,
    ],
    ['exported NSE path', 'test -d "$notification_appex"'],
    [
      'exported NSE bundle identifier',
      'test "$(/usr/libexec/PlistBuddy -c \'Print :CFBundleIdentifier\' "$notification_appex/Info.plist")" = "$NOTIFICATION_BUNDLE_ID"',
    ],
    [
      'exported NSE marketing version',
      `test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$notification_appex/Info.plist")" = '\${{ inputs.marketing_version }}'`,
    ],
    [
      'exported NSE build version',
      `test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$notification_appex/Info.plist")" = '\${{ inputs.bundle_version }}'`,
    ],
    [
      'exported NSE profile UUID',
      '"$notification_embedded" "$RUNNER_TEMP/station-ios-notification-service-profile.json"',
    ],
    [
      'exported NSE embedded profile check',
      'node scripts/check-ios-store-profile.mjs --station "$notification_appex/embedded.mobileprovision"',
    ],
    [
      'exported NSE signed entitlements extraction',
      'codesign -d --entitlements :- "$notification_appex"',
    ],
    [
      'exported NSE signed entitlements receipt',
      '--notification-service-extension > provider-receipts/exported-ios-notification-service-entitlements.json',
    ],
    [
      'stable extension absence',
      'test ! -e "$appex"\n            test ! -e "$notification_appex"',
    ],
  ])('pins the workflow %s guard', (_name, guard) => {
    expect(workflow).toContain(guard);
  });
  test('requires every channel environment to admit main', () => {
    expect(
      assertEnvironmentAdmissions({
        'native-release': environment(),
        'ios-beta': environment(),
        'ios-nightly': environment(),
      }),
    ).toHaveLength(3);
    expect(() =>
      assertEnvironmentAdmissions({
        'native-release': environment(),
        'ios-beta': {
          ...environment(),
          branch_policies: [{ name: 'v*-preview.*', type: 'tag' }],
        },
        'ios-nightly': environment(),
      }),
    ).toThrow(/ios-beta does not admit refs\/heads\/main/);
  });
  test('requires one immutable unbypassed tag ruleset', () => {
    expect(assertInternalTagRuleset([ruleset])).toMatchObject({ id: 7 });
    expect(() => assertInternalTagRuleset([])).toThrow(/exactly one active/);
    expect(() =>
      assertInternalTagRuleset([{ ...ruleset, rules: [{ type: 'deletion' }] }]),
    ).toThrow(/missing non_fast_forward/);
    expect(() =>
      assertInternalTagRuleset([
        { ...ruleset, bypass_actors: [{ actor_id: 1 }] },
      ]),
    ).toThrow(/unbypassed/);
  });
});
