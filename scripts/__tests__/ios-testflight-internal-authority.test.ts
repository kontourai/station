import { describe, expect, test } from 'vitest';
import {
  internalTestFlightAuthorityRef,
  internalTestFlightBuild,
  parseInternalTestFlightAuthorityRef,
} from '../ios-testflight-internal-authority.mjs';

describe('internal iOS TestFlight authority', () => {
  test('uses a dedicated slot without consuming normal release slots', () => {
    expect(
      internalTestFlightBuild({ channel: 'stable', version: '0.1.10' }),
    ).toBe('11100');
    expect(
      internalTestFlightBuild({ channel: 'beta', version: '0.1.10' }),
    ).toBe('11100');
    expect(
      internalTestFlightAuthorityRef({
        channel: 'stable',
        version: '0.1.10',
        bundleVersion: '11100',
      }),
    ).toBe('refs/tags/ios-testflight/stable/v0.1.10/11100');
    expect(() =>
      internalTestFlightAuthorityRef({
        channel: 'beta',
        version: '0.1.10',
        bundleVersion: '11101',
      }),
    ).toThrow(/reserved internal build/);
  });

  test('leaves Nightly on the globally monotonic allocator', () => {
    expect(
      internalTestFlightBuild({ channel: 'nightly', version: '0.1.10' }),
    ).toBeNull();
    expect(
      parseInternalTestFlightAuthorityRef(
        'refs/tags/ios-testflight/nightly/v0.1.10/243201',
      ),
    ).toEqual({
      channel: 'nightly',
      version: '0.1.10',
      bundleVersion: '243201',
    });
    expect(() =>
      parseInternalTestFlightAuthorityRef(
        'refs/tags/ios-testflight/nightly/v0.1.10/0243201',
      ),
    ).toThrow(/not an internal/);
  });
});
