import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  createIosTestFlightConfig,
  IOS_TESTFLIGHT_CHANNELS,
} from '../ios-testflight-channel.mjs';

describe('iOS TestFlight channel config', () => {
  test('binds TestFlight package, receipt, and What-to-Test to one artifact timestamp', () => {
    const workflow = readFileSync(
      resolve(
        import.meta.dirname,
        '../../.github/workflows/testflight-delivery.yml',
      ),
      'utf8',
    );
    expect(workflow).toContain('node scripts/write-ios-build-manifest.mjs');
    expect(workflow).toContain(
      'STATION_BUILD_BRANCH="$AUTHORITY_REF" STATION_CLIENT_BUILD_REUSE=1 npx tauri ios build',
    );
    expect(workflow).toContain(
      '--artifact-manifest src-desktop/station-client-build.json',
    );
    expect(workflow).toContain('cmp "src-desktop/station-client-build.json"');
    expect(workflow).toContain('artifact_built_at=$(node -p');
    expect(workflow).toContain(
      `whats_new="Built \${artifact_built_at:0:10} UTC`,
    );
    expect(workflow).toContain('if [ "$delivery_mode" = uploaded ]');
    expect(workflow).toContain('provider-artifact-provenance-unverified');
    expect(workflow).toContain('status:"skipped"');
    expect(workflow).not.toContain('workflow_date=$(node -e');
    expect(workflow).toContain(
      'iosTestFlightChannel(process.argv[1]).internalGroup',
    );
    expect(workflow).not.toContain('Station Stable Internal');
  });

  test('owns every TestFlight group name with the channel identity', () => {
    expect(IOS_TESTFLIGHT_CHANNELS.stable.internalGroup).toBe(
      'Internal Testers',
    );
    expect(IOS_TESTFLIGHT_CHANNELS.beta.internalGroup).toBe(
      'Station Beta Internal',
    );
    expect(IOS_TESTFLIGHT_CHANNELS.nightly.internalGroup).toBe(
      'Station Nightly Internal',
    );
  });
  test.each(['stable', 'beta', 'nightly'] as const)(
    'creates an isolated %s identity with numeric store versions',
    (channel) => {
      const config = createIosTestFlightConfig({
        channel,
        marketingVersion: '0.1.4',
        bundleVersion: '243201',
      });
      const expected = IOS_TESTFLIGHT_CHANNELS[channel];
      expect(config).toMatchObject({
        identifier: expected.bundleId,
        productName: expected.productName,
        version: '0.1.4',
        bundle: {
          iOS: { minimumSystemVersion: '15.0', bundleVersion: '243201' },
          icon: [expected.icon],
        },
        plugins: { 'deep-link': { mobile: [{ scheme: [expected.scheme] }] } },
      });
      expect(expected.appStoreName).toBe(
        `Station${channel === 'stable' ? '' : ` ${channel[0].toUpperCase()}${channel.slice(1)}`} by Kontour AI`,
      );
    },
  );

  test('rejects nonnumeric marketing and unsafe build versions', () => {
    expect(() =>
      createIosTestFlightConfig({
        channel: 'beta',
        marketingVersion: '0.1.4-preview.1',
        bundleVersion: '1',
      }),
    ).toThrow(/numeric X.Y.Z/);
    expect(() =>
      createIosTestFlightConfig({
        channel: 'nightly',
        marketingVersion: '0.1.4',
        bundleVersion: '9007199254740992',
      }),
    ).toThrow(/supported integer/);
  });
});
