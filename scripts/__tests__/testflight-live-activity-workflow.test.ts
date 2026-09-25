import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

// The TestFlight delivery builds the Live Activity (#2513 slice D) for the
// channels whose table entry names a widget extension. These pin how the
// workflow threads that one answer through signing, the spec, the build and
// the IPA audit; the scripts it calls are tested on their own.

type Step = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  'working-directory'?: string;
};
type Job = { env?: Record<string, string>; steps: Step[] };

const source = readFileSync(
  resolve(
    import.meta.dirname,
    '../../.github/workflows/testflight-delivery.yml',
  ),
  'utf8',
);
const workflow = load(source) as { jobs: Record<string, Job> };
const deliver = workflow.jobs.deliver;
const upload = workflow.jobs.upload;

function stepIndex(name: string) {
  const index = deliver.steps.findIndex((step) => step.name === name);
  expect(index, `missing step ${name}`).toBeGreaterThanOrEqual(0);
  return index;
}
function run(name: string) {
  const step = deliver.steps[stepIndex(name)];
  expect(step.run, `${name} has no run`).toBeTypeOf('string');
  return step.run as string;
}
function indexOf(text: string, needle: string, from = 0) {
  const index = text.indexOf(needle, from);
  expect(index, `missing ${needle}`).toBeGreaterThanOrEqual(0);
  return index;
}

const RESOLVE = 'Resolve whether this channel builds the Live Activity';
const SECRETS = 'Fail closed on channel-owned secrets and exact iOS identity';
const IMPORT = 'Import protected signing material bound to this channel';
const IMPORT_EXTENSION =
  'Import the Live Activity extension profile bound to this channel';
const REGENERATE =
  'Regenerate the Xcode project with the manual signing template';
const BUILD = 'Build signed and channel-audited iOS package';
const VERIFY = 'Verify IPA identity, profile and package contents';
const LIVE = "steps.live_activity.outputs.enabled == 'true'";

describe('TestFlight delivery builds the Live Activity where the channel names one', () => {
  it('derives the switch from the channel table before anything checks or signs', () => {
    const resolveStep = deliver.steps[stepIndex(RESOLVE)];
    expect(resolveStep.id).toBe('live_activity');
    expect(resolveStep.run).toContain(
      'iosTestFlightChannel(process.argv[1]).agentActivityBundleId',
    );
    expect(resolveStep.run).toContain('echo "aps_environment=production"');
    expect(stepIndex(RESOLVE)).toBeLessThan(stepIndex(SECRETS));
    // Every consumer reads the resolved answer; nothing re-derives it from
    // the channel name.
    expect(source).not.toContain("inputs.channel != 'stable'");
  });

  it('requires the extension profile secret exactly when the channel builds the extension', () => {
    expect(deliver.env?.APPLE_AGENT_ACTIVITY_PROVISIONING_PROFILE_BASE64).toBe(
      `\${{ secrets.APPLE_AGENT_ACTIVITY_PROVISIONING_PROFILE_BASE64 }}`,
    );
    // The upload job never signs; it has no use for the profile.
    expect(upload.env).not.toHaveProperty(
      'APPLE_AGENT_ACTIVITY_PROVISIONING_PROFILE_BASE64',
    );
    const secrets = run(SECRETS);
    const guard = indexOf(
      secrets,
      `if [ '\${{ steps.live_activity.outputs.enabled }}' = true ]; then`,
    );
    expect(
      indexOf(
        secrets,
        'test -n "$APPLE_AGENT_ACTIVITY_PROVISIONING_PROFILE_BASE64"',
        guard,
      ),
    ).toBeGreaterThan(guard);
  });

  it('validates and installs the extension profile, and push on the app profile, before the build', () => {
    const step = deliver.steps[stepIndex(IMPORT_EXTENSION)];
    expect(step.if).toBe(LIVE);
    expect(stepIndex(IMPORT_EXTENSION)).toBeGreaterThan(stepIndex(IMPORT));
    expect(stepIndex(IMPORT_EXTENSION)).toBeLessThan(stepIndex(REGENERATE));
    const text = step.run as string;
    expect(text).toContain(
      `test "$extension_bundle_id" = '\${{ steps.app_store.outputs.bundle_id }}.AgentActivity'`,
    );
    expect(text).toContain(
      'node scripts/check-ios-store-profile.mjs --station "$extension_profile" --label APPLE_AGENT_ACTIVITY_PROVISIONING_PROFILE_BASE64 --expected-team "$APPLE_DEVELOPMENT_TEAM" --expected-bundle-id "$extension_bundle_id"',
    );
    expect(text).toContain(
      `--expected-aps-environment '\${{ steps.live_activity.outputs.aps_environment }}'`,
    );
    expect(text).toContain(
      'MobileDevice/Provisioning Profiles/$extension_uuid.mobileprovision',
    );
  });

  it('adds and signs the extension after the last re-render and before xcodegen, keeping the preserved-file proof', () => {
    const step = deliver.steps[stepIndex(REGENERATE)];
    expect(step.env).toMatchObject({
      LIVE_ACTIVITY: `\${{ steps.live_activity.outputs.enabled }}`,
      APP_BUNDLE_ID: `\${{ steps.app_store.outputs.bundle_id }}`,
      APS_ENVIRONMENT: `\${{ steps.live_activity.outputs.aps_environment }}`,
    });
    const text = step.run as string;
    const secondInit = indexOf(text, 'npx tauri ios init');
    const restage = indexOf(text, 'node scripts/write-ios-build-manifest.mjs');
    const ensure = indexOf(
      text,
      'node ../scripts/ensure-ios-agent-activity-extension.mjs gen/apple/project.yml --app-bundle-id "$APP_BUNDLE_ID" --aps-environment "$APS_ENVIRONMENT" --info-plist "$live_info_plist"',
    );
    const sign = indexOf(
      text,
      'node ../scripts/ios-store-signing-config.mjs agent-activity --profile "$RUNNER_TEMP/station-ios-agent-activity.mobileprovision" --app-profile "$RUNNER_TEMP/station-ios.mobileprovision"',
    );
    const xcodegen = indexOf(
      text,
      'xcodegen generate --spec gen/apple/project.yml --project gen/apple',
    );
    expect(secondInit).toBeLessThan(ensure);
    expect(restage).toBeLessThan(ensure);
    expect(ensure).toBeLessThan(sign);
    expect(sign).toBeLessThan(xcodegen);
    // The Info.plist half goes to a scratch copy, never the preserved file.
    expect(
      indexOf(
        text,
        'ditto "$preserved/station_iOS/Info.plist" "$live_info_plist"',
      ),
    ).toBeLessThan(ensure);
    expect(
      indexOf(text, "grep -Fq 'StationAgentActivity.appex'", xcodegen),
    ).toBeGreaterThan(xcodegen);
    // Only after the preserved files are proven unchanged do the live
    // Info.plist and export options replace them; the usage-description
    // checks then run on the plist that ships.
    const lastDiff = text.lastIndexOf('git diff --exit-code');
    const livePlist = indexOf(
      text,
      'ditto "$live_info_plist" gen/apple/station_iOS/Info.plist',
    );
    const exportOptions = indexOf(
      text,
      'ditto "$live_export_options" gen/apple/ExportOptions.plist',
    );
    expect(livePlist).toBeGreaterThan(lastDiff);
    expect(exportOptions).toBeGreaterThan(lastDiff);
    expect(
      indexOf(
        text,
        'grep -Fq "<key>$key</key>" gen/apple/station_iOS/Info.plist',
      ),
    ).toBeGreaterThan(livePlist);
    // A channel without the extension must not generate one.
    expect(text).toContain(
      "elif grep -Fq 'StationAgentActivity' gen/apple/station.xcodeproj/project.pbxproj; then",
    );
  });

  it('builds with the plugin half and without the env profile that would drop the extension from the export', () => {
    const step = deliver.steps[stepIndex(BUILD)];
    expect(step.env?.LIVE_ACTIVITY).toBe(
      `\${{ steps.live_activity.outputs.enabled }}`,
    );
    const lines = (step.run as string).split('\n').map((line) => line.trim());
    const provision = lines.findIndex((line) =>
      line.startsWith('IOS_MOBILE_PROVISION='),
    );
    expect(provision).toBeGreaterThan(0);
    expect(lines[provision - 1]).toBe('else');
    expect(lines.slice(0, provision)).toContain(
      'if [ "$LIVE_ACTIVITY" = true ]; then',
    );
    expect(step.run).toContain(
      'mobileCargoConfig(process.env.STATION_MOBILE_DEFAULT_ENDPOINT, { liveActivity: process.env.LIVE_ACTIVITY === "true" })',
    );
    expect(step.run).toContain(
      'grep -Fq \'STATION_IOS_LIVE_ACTIVITY\' "$RUNNER_TEMP/station-ios-mobile-env.toml"',
    );
    expect(step.run).toContain(
      `grep -Fq '<key>\${{ steps.live_activity.outputs.extension_bundle_id }}</key>' gen/apple/ExportOptions.plist`,
    );
  });

  it('audits the embedded widget, its profile and both entitlement sets in the IPA', () => {
    const step = deliver.steps[stepIndex(VERIFY)];
    expect(step.env).toMatchObject({
      LIVE_ACTIVITY: `\${{ steps.live_activity.outputs.enabled }}`,
      EXTENSION_BUNDLE_ID: `\${{ steps.live_activity.outputs.extension_bundle_id }}`,
      APS_ENVIRONMENT: `\${{ steps.live_activity.outputs.aps_environment }}`,
    });
    const text = step.run as string;
    for (const needle of [
      'appex="$app/PlugIns/StationAgentActivity.appex"',
      'test "$(find "$app/PlugIns" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d \' \')" = 1',
      'test "$(/usr/libexec/PlistBuddy -c \'Print :CFBundleIdentifier\' "$appex/Info.plist")" = "$EXTENSION_BUNDLE_ID"',
      'test "$(/usr/libexec/PlistBuddy -c \'Print :StationApsEnvironment\' "$app/Info.plist")" = "$APS_ENVIRONMENT"',
      `--expected-bundle-id '\${{ steps.app_store.outputs.bundle_id }}' --expected-aps-environment "$APS_ENVIRONMENT"`,
      'node scripts/check-ios-store-profile.mjs --station "$appex/embedded.mobileprovision"',
      '"$extension_embedded" "$RUNNER_TEMP/station-ios-agent-activity-profile.json"',
      '--live-activity "$APS_ENVIRONMENT" > provider-receipts/exported-ios-entitlements.json',
      '--agent-activity-extension > provider-receipts/exported-ios-agent-activity-entitlements.json',
      'test ! -e "$appex"',
    ])
      expect(text).toContain(needle);
    // The audit of the whole package still runs after these checks.
    expect(
      indexOf(text, 'node scripts/check-mobile-package.mjs ios'),
    ).toBeGreaterThan(indexOf(text, '--agent-activity-extension'));
  });

  it('keeps the live-activity answer inside the job that resolved it', () => {
    expect(JSON.stringify(upload)).not.toContain('live_activity');
  });
});
