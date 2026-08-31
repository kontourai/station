import { describe, expect, test } from 'vitest';
import {
  createIosTestFlightConfig,
  IOS_TESTFLIGHT_CHANNELS,
} from '../ios-testflight-channel.mjs';

describe('iOS TestFlight channel config', () => {
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
