import { describe, expect, test } from 'vitest';
import {
  INTERNAL_TESTFLIGHT_GPG_SIGNER_EMAIL,
  INTERNAL_TESTFLIGHT_GPG_TAGGER_NAME,
} from '../ios-testflight-internal-authority.mjs';
import {
  verifiedGpgFingerprint,
  verifyInternalTestFlightTag,
} from '../verify-ios-testflight-internal-tag.mjs';

const fingerprint = 'B'.repeat(40);
const sourceSha = 'a'.repeat(40);
const sourceRef = 'refs/tags/ios-testflight/beta/v0.1.10/11100';
const tagObject = 'c'.repeat(40);
function exactTag(overrides = {}) {
  return {
    sourceRef,
    sourceSha,
    channel: 'beta',
    marketingVersion: '0.1.10',
    bundleVersion: '11100',
    expectedFingerprint: fingerprint,
    localTagObjectSha: tagObject,
    githubRef: { ref: sourceRef, object: { type: 'tag', sha: tagObject } },
    githubTag: {
      tag: 'ios-testflight/beta/v0.1.10/11100',
      object: { type: 'commit', sha: sourceSha },
      tagger: {
        name: INTERNAL_TESTFLIGHT_GPG_TAGGER_NAME,
        email: INTERNAL_TESTFLIGHT_GPG_SIGNER_EMAIL,
      },
      verification: {
        verified: true,
        reason: 'valid',
        verified_at: '2026-09-02T00:00:00Z',
      },
    },
    gpgStatus: `[GNUPG:] VALIDSIG ${fingerprint} 2026-09-02 0 4 0 1 10 00`,
    ...overrides,
  };
}
describe('internal iOS TestFlight annotated tag verifier', () => {
  test('permits an exact signed tag', () =>
    expect(verifyInternalTestFlightTag(exactTag())).toMatchObject({
      channel: 'beta',
    }));
  test.each([
    [
      {
        githubRef: {
          ref: sourceRef,
          object: { type: 'commit', sha: sourceSha },
        },
      },
      /lightweight/,
    ],
    [{ localTagObjectSha: 'd'.repeat(40) }, /differs/],
    [
      {
        githubTag: {
          ...exactTag().githubTag,
          verification: { verified: false, reason: 'unsigned' },
        },
      },
      /GitHub-verified/,
    ],
    [
      { gpgStatus: `[GNUPG:] VALIDSIG ${'C'.repeat(40)} 2026-09-02` },
      /fingerprint/,
    ],
    [{ channel: 'nightly' }, /channel, version, or build/],
    [
      { githubTag: { ...exactTag().githubTag, tagger: undefined } },
      /tagger identity/,
    ],
    [
      {
        githubTag: {
          ...exactTag().githubTag,
          tagger: { name: 'Mallory', email: 'mallory@example.com' },
        },
      },
      /tagger identity/,
    ],
  ])('fails closed for forged authority %o', (overrides, message) =>
    expect(() => verifyInternalTestFlightTag(exactTag(overrides))).toThrow(
      message,
    ),
  );
  test('rejects absent or ambiguous signature evidence', () => {
    expect(() => verifiedGpgFingerprint('')).toThrow(/exactly one/);
    expect(() =>
      verifiedGpgFingerprint(
        `[GNUPG:] VALIDSIG ${fingerprint}\n[GNUPG:] VALIDSIG ${fingerprint}`,
      ),
    ).toThrow(/exactly one/);
  });
});
