import { describe, expect, test } from 'vitest';
import { verifyIosTestFlightAuthority } from '../verify-ios-testflight-authority.mjs';

const sha = 'a'.repeat(40);
describe('iOS TestFlight authority ref', () => {
  test.each([
    'refs/tags/v1.2.3',
    'refs/tags/v1.2.3-preview.4',
    'refs/tags/nightly-version-code/243201',
  ])('accepts exact authority %s', (sourceRef) =>
    expect(
      verifyIosTestFlightAuthority({
        sourceRef,
        sourceSha: sha,
        resolveRef: () => sha,
      }),
    ).toEqual({ sourceRef, sourceSha: sha }),
  );
  test('fails closed for missing and mismatched refs', () => {
    expect(() =>
      verifyIosTestFlightAuthority({
        sourceRef: 'refs/tags/v1.2.3',
        sourceSha: sha,
        resolveRef: () => {
          throw new Error('missing');
        },
      }),
    ).toThrow(/missing/);
    expect(() =>
      verifyIosTestFlightAuthority({
        sourceRef: 'refs/tags/v1.2.3',
        sourceSha: sha,
        resolveRef: () => 'b'.repeat(40),
      }),
    ).toThrow(/not/);
  });
});
