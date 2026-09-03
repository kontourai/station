import { describe, expect, test } from 'vitest';
import { verifyIosTestFlightAuthority } from '../verify-ios-testflight-authority.mjs';

const sha = 'a'.repeat(40);
describe('iOS TestFlight authority ref', () => {
  test.each([
    'refs/tags/v1.2.3',
    'refs/tags/v1.2.3-preview.4',
    'refs/tags/nightly-version-code/243201',
    'refs/tags/ios-testflight/stable/v0.1.10/11100',
    'refs/tags/ios-testflight/beta/v0.1.10/11100',
    'refs/tags/ios-testflight/nightly/v0.1.10/243201',
  ])('accepts exact authority %s', (sourceRef) =>
    expect(
      verifyIosTestFlightAuthority({
        sourceRef,
        sourceSha: sha,
        resolveRef: () => sha,
      }),
    ).toEqual({ sourceRef, sourceSha: sha }),
  );
  test('rejects a colliding internal release slot', () =>
    expect(() =>
      verifyIosTestFlightAuthority({
        sourceRef: 'refs/tags/ios-testflight/stable/v0.1.10/11199',
        sourceSha: sha,
        resolveRef: () => sha,
      }),
    ).toThrow(/reserved internal build/));
});
