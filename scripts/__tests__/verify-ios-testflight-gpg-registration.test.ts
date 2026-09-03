import { describe, expect, test } from 'vitest';
import {
  INTERNAL_TESTFLIGHT_GPG_SIGNER_EMAIL,
  verifyInternalTestFlightGpgRegistration,
} from '../verify-ios-testflight-gpg-registration.mjs';

const fingerprint = 'A'.repeat(40);
const colon = (
  key = fingerprint,
  uid = `Brian Anderson <${INTERNAL_TESTFLIGHT_GPG_SIGNER_EMAIL}>`,
) =>
  `pub:u:4096:1:${key.slice(-16)}:0::::::23::0:\nfpr:::::::::${key}:\nuid:u::::0::0::${uid}:\n`;

describe('internal TestFlight GPG registration verifier', () => {
  test('requires exact environment/GitHub public-key identity and signer UID', () => {
    expect(
      verifyInternalTestFlightGpgRegistration({
        expectedFingerprint: fingerprint,
        authorityColons: colon(),
        githubColons: colon(),
      }),
    ).toMatchObject({
      fingerprint,
      signerEmail: INTERNAL_TESTFLIGHT_GPG_SIGNER_EMAIL,
      status: 'registered-and-identity-matched',
    });
  });

  test.each([
    { githubColons: colon('B'.repeat(40)) },
    { authorityColons: colon(fingerprint, 'Brian <other@example.com>') },
    { githubColons: 'pub:u:4096:1:0000000000000000:0::::::23::0:\n' },
  ])('fails closed on unregistered or mismatched identity %o', (overrides) =>
    expect(() =>
      verifyInternalTestFlightGpgRegistration({
        expectedFingerprint: fingerprint,
        authorityColons: colon(),
        githubColons: colon(),
        ...overrides,
      }),
    ).toThrow(/GPG registration/),
  );
});
