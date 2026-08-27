import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyConnectionFailure,
  classifyHttpFailureResponse,
  classifyNativeTransportRefusal,
  connectionFailureNeedsDecision,
} from '../core/connectionFailureClassification';
import { connectionFailureCopy } from '../core/environmentProfiles';
import type { SavedConnection } from '../core/types';
import { connectionNeedsAccessRequest } from '../react/connection-manager-modal-utils';

const NATIVE_PROFILE_AUTHORITY_SOURCE = readFileSync(
  fileURLToPath(new URL('../../../../src-desktop/src/lib.rs', import.meta.url)),
  'utf-8',
);

const RUNTIME_HTTP_SOURCE = readFileSync(
  fileURLToPath(
    new URL(
      '../../../../src-server/runtime/bootstrap/runtime-http.ts',
      import.meta.url,
    ),
  ),
  'utf-8',
);

describe('classifyConnectionFailure', () => {
  it('only classifies authentication-failed as terminal', () => {
    expect(classifyConnectionFailure('authentication-failed')).toBe('terminal');
  });

  it('classifies awaiting-approval as transient, never terminal (station#1713)', () => {
    expect(classifyConnectionFailure('awaiting-approval')).toBe('transient');
  });

  it('classifies every other known reason as transient', () => {
    for (const reason of [
      'offline',
      'mixed-content',
      'invalid-endpoint',
      'identity-mismatch',
      'access-method-mismatch',
      'unsupported-capability-version',
      'timeout',
      'unreachable',
      'server-restarted',
    ] as const) {
      expect(classifyConnectionFailure(reason)).toBe('transient');
    }
  });
});

/** Builds the exact shape `authenticatedTransport.ts` / `pairingTransport.ts`
 * attach a native refusal's `code` to: a real `Error` with a `.code` string
 * property, matching what a rejected Tauri `invoke()` of a
 * `NativeCommandError`-returning command becomes on this codebase's native
 * bridge. */
function nativeRefusal(code: string): Error {
  return Object.assign(new Error(`Native Station request failed: ${code}`), {
    code,
  });
}

/**
 * station#1713 (original) / station#1818 R2 (this rewrite) — the
 * miscategorization that cost hours of debugging: a desktop native
 * invoke-layer refusal used to collapse into 'unreachable' at every caller,
 * indistinguishable from a genuine transport failure. This classifier now
 * switches on the stable `code` every native refusal on this path carries
 * (`NativeCommandError` in `src-desktop/src/lib.rs`), not on message prose.
 */
describe('classifyNativeTransportRefusal', () => {
  it('classifies "no_active_profile" as authentication-failed, never unreachable', () => {
    expect(
      classifyNativeTransportRefusal(nativeRefusal('no_active_profile')),
    ).toBe('authentication-failed');
  });

  it('classifies an invalidated profile binding as authentication-failed', () => {
    expect(
      classifyNativeTransportRefusal(
        nativeRefusal('credential_binding_changed'),
      ),
    ).toBe('authentication-failed');
    expect(
      classifyNativeTransportRefusal(nativeRefusal('origin_changed')),
    ).toBe('authentication-failed');
    expect(
      classifyNativeTransportRefusal(nativeRefusal('binding_changed')),
    ).toBe('authentication-failed');
    expect(
      classifyNativeTransportRefusal(nativeRefusal('credential_not_observed')),
    ).toBe('authentication-failed');
  });

  it('classifies a profile mid-authorization as awaiting-approval, not a failure to explain', () => {
    expect(
      classifyNativeTransportRefusal(nativeRefusal('mid_authorization')),
    ).toBe('awaiting-approval');
  });

  it('classifies a profile that was never configured here as authentication-failed, not awaiting-approval', () => {
    expect(
      classifyNativeTransportRefusal(nativeRefusal('not_configured')),
    ).toBe('authentication-failed');
  });

  /**
   * station#1818 — the headline fix. Live evidence: `/api/system/identity`
   * answered 200 in 3ms while the desktop app could not authenticate a
   * single request, because the macOS keychain ACL bound to a previous
   * build's signature refused the rebuilt app's read of its own bearer.
   * Neither of these codes was recognized before this fix — both silently
   * fell through to `unreachable`, which is exactly what told the owner to
   * go check the network instead of re-pairing.
   */
  it('classifies an unreadable credential as authentication-failed, never unreachable (station#1818)', () => {
    expect(
      classifyNativeTransportRefusal(nativeRefusal('credential_missing')),
    ).toBe('authentication-failed');
    expect(
      classifyNativeTransportRefusal(
        nativeRefusal('credential_store_unreadable'),
      ),
    ).toBe('authentication-failed');
  });

  /**
   * This classifier's contract is now the `code` vocabulary, not prose —
   * pin every code it matches against the literal strings
   * `src-desktop/src/lib.rs` actually emits, so a renamed code on the Rust
   * side fails this test instead of silently degrading every one of these
   * cases to `unreachable`.
   */
  it('pins every code it matches against the literal strings in src-desktop/src/lib.rs', () => {
    const codesExpectedInRustSource = [
      'no_active_profile',
      'credential_binding_changed',
      'mid_authorization',
      'not_configured',
      'credential_not_observed',
      'origin_changed',
      'binding_changed',
      'credential_missing',
      'credential_store_unreadable',
    ];
    for (const code of codesExpectedInRustSource) {
      expect(NATIVE_PROFILE_AUTHORITY_SOURCE).toContain(`"${code}"`);
    }
  });

  it('returns null for a genuine transport failure so the caller keeps its own default', () => {
    expect(
      classifyNativeTransportRefusal(
        new Error('Native Station request failed: transport'),
      ),
    ).toBeNull();
    expect(
      classifyNativeTransportRefusal(new TypeError('Failed to fetch')),
    ).toBeNull();
    expect(
      classifyNativeTransportRefusal('some non-Error rejection'),
    ).toBeNull();
  });

  it.each([
    'transport_dns',
    'transport_timeout',
    'transport_tls',
    'transport_refused',
    'transport_reset',
    'transport_unreachable',
  ])(
    'treats %s as a genuine transport failure so callers keep their default',
    (code) => {
      expect(classifyNativeTransportRefusal(nativeRefusal(code))).toBeNull();
    },
  );

  it('returns null for an Error with no code property (a not-yet-converted native command)', () => {
    expect(
      classifyNativeTransportRefusal(
        new Error('some legacy string-only refusal'),
      ),
    ).toBeNull();
  });

  it('returns null for an unrecognized code rather than guessing a reason', () => {
    expect(
      classifyNativeTransportRefusal(nativeRefusal('some_future_code')),
    ).toBeNull();
  });
});

/**
 * station#3297 — the derivation behind an HTTP failure response.
 *
 * Every case here starts from a response having arrived, so `unreachable`
 * must never be the answer: something at that address answered.
 */
describe('classifyHttpFailureResponse', () => {
  it('reads 401 as a rejected device, never as unreachable', () => {
    expect(classifyHttpFailureResponse(401, 'authentication_required')).toBe(
      'authentication-failed',
    );
    // The code is a courtesy, not a requirement: 401 alone is unambiguous.
    expect(classifyHttpFailureResponse(401, undefined)).toBe(
      'authentication-failed',
    );
  });

  it('separates the two meanings of 403 by its coded body, not its number', () => {
    // Origin policy: no credential this device can obtain changes the answer.
    expect(classifyHttpFailureResponse(403, 'origin_forbidden')).toBe(
      'origin-not-allowed',
    );
    expect(classifyHttpFailureResponse(403, 'origin_required')).toBe(
      'origin-not-allowed',
    );
    // A credential the server recognized and will not accept. The comment
    // this replaces claimed this server "never" answers 403 for a credential
    // problem; runtime-http.ts answers `insufficient_scope` at four sites.
    expect(classifyHttpFailureResponse(403, 'insufficient_scope')).toBe(
      'authentication-failed',
    );
  });

  it('refuses to guess which 403 it is when the body carries no code', () => {
    // An intermediary's own 403, or a Station older than the coded
    // vocabulary. Both plausible readings have a different remedy, and
    // picking one would send half the readers at a fix that cannot work.
    expect(classifyHttpFailureResponse(403, undefined)).toBe(
      'unexpected-response',
    );
    expect(classifyHttpFailureResponse(403, 'some_future_code')).toBe(
      'unexpected-response',
    );
  });

  /**
   * station#3903. The auth-failure limiter is reachable only after this
   * device's credential has been refused ten times in a minute, so its answer
   * is the same authentication outcome as the 401s that fed it. Before this
   * branch existed a revoked phone settled here within seconds and its row
   * read "answered, but not as a Station. Something else may be answering at
   * that address."
   */
  it('reads a throttled auth refusal as the access outcome it is', () => {
    expect(
      classifyHttpFailureResponse(429, 'authentication_rate_limited'),
    ).toBe('authentication-failed');
  });

  it('leaves the mutation budget out of it: a 429 is not by itself about access', () => {
    // `RuntimeMutationBudget` throttles an ALREADY-AUTHORISED principal. It
    // keeps `rate_limited`, and claiming an access problem for it would be
    // the same invented fact pointed the other way.
    expect(classifyHttpFailureResponse(429, 'rate_limited')).toBe(
      'unexpected-response',
    );
    expect(classifyHttpFailureResponse(429, undefined)).toBe(
      'unexpected-response',
    );
  });

  /**
   * The literal in `connectionFailureClassification.ts` and the constant in
   * the server's HTTP boundary are the same string on purpose, and this
   * package cannot import the server tree to say so. Reading the source is
   * how `classifyNativeTransportRefusal`'s code vocabulary is pinned against
   * `src-desktop/src/lib.rs` above; this is the same instrument.
   */
  it('pins the throttled-auth code against the server that emits it', () => {
    expect(RUNTIME_HTTP_SOURCE).toContain(
      "export const AUTH_RATE_LIMITED_ERROR_CODE = 'authentication_rate_limited';",
    );
    // And the auth middleware answers with the constant, not a bare literal
    // that could drift away from it.
    expect(RUNTIME_HTTP_SOURCE).toContain(
      '{ error: { code: AUTH_RATE_LIMITED_ERROR_CODE } }',
    );
  });

  it.each([404, 500, 502, 418])(
    'reads %i as an address that answered and is not a Station',
    (status) => {
      expect(classifyHttpFailureResponse(status, undefined)).toBe(
        'unexpected-response',
      );
    },
  );

  it('never returns a network reason from an HTTP response', () => {
    for (const status of [401, 403, 404, 429, 500, 503]) {
      for (const code of [
        undefined,
        'origin_forbidden',
        'insufficient_scope',
        'authentication_required',
        'unknown',
      ]) {
        expect(['unreachable', 'timeout', 'offline']).not.toContain(
          classifyHttpFailureResponse(status, code),
        );
      }
    }
  });
});

describe('connectionFailureNeedsDecision', () => {
  it.each([
    'timeout',
    'unreachable',
    'offline',
    'server-restarted',
    'undetermined',
    'awaiting-approval',
  ] as const)('leaves %s to the indicator, with no banner', (reason) => {
    expect(connectionFailureNeedsDecision(reason)).toBe(false);
  });

  it.each([
    'authentication-failed',
    'identity-mismatch',
    'unsupported-capability-version',
    'mixed-content',
    'invalid-endpoint',
    'access-method-mismatch',
    'origin-not-allowed',
    'unexpected-response',
  ] as const)('requires a person to decide about %s', (reason) => {
    expect(connectionFailureNeedsDecision(reason)).toBe(true);
  });
});

/**
 * station#3903 end to end, at the seam the reader meets: a status becomes a
 * reason, a reason becomes a sentence, and the sentence has to agree with the
 * control rendered beside it.
 */
describe('what a refused device is told', () => {
  const revoked = (reason: SavedConnection['lastError']) =>
    ({
      profileVersion: 4,
      id: 'revoked',
      name: 'Revoked Station',
      url: 'http://localhost:5634',
      endpoints: [],
      accessMethods: [],
      credentialState: 'device-session',
      lastError: reason,
    }) as unknown as SavedConnection;

  it.each([
    ['a Station refusing this device', 401, 'authentication_required'],
    [
      'the same Station, throttling that refusal',
      429,
      'authentication_rate_limited',
    ],
  ])('%s names the access, and offers the request', (_label, status, code) => {
    const reason = classifyHttpFailureResponse(status, code as string);
    // Stated rather than cast: `awaiting-approval` has no copy entry by
    // design, so the copy map's parameter excludes it. Pinning the reason
    // here is what makes the lookup below well-typed AND says what the
    // status derived.
    expect(reason).toBe('authentication-failed');
    const copy = connectionFailureCopy(
      'authentication-failed',
      'Revoked Station',
    );
    const sentence = `${copy.summary} ${copy.action}`;
    expect(sentence).toContain("Revoked Station isn't accepting this device.");
    expect(sentence).toMatch(/isn't authorised there/i);
    expect(sentence).toMatch(/request access to Revoked Station/i);
    // The wrong-server diagnosis this issue was filed about must be gone.
    expect(sentence).not.toMatch(/not as a Station|something else/i);
    // And the row's own affordance is derived from the same reason.
    expect(
      connectionNeedsAccessRequest(revoked({ reason, endpointId: 'e', at: 0 })),
    ).toBe(true);
  });

  it('keeps the ambiguous sentence for something that did not answer as a Station', () => {
    expect(classifyHttpFailureResponse(404, undefined)).toBe(
      'unexpected-response',
    );
    const copy = connectionFailureCopy(
      'unexpected-response',
      'Revoked Station',
    );
    const sentence = `${copy.summary} ${copy.action}`;
    expect(sentence).toContain(
      'Revoked Station answered, but not as a Station',
    );
    expect(sentence).toMatch(/something else may be answering/i);
    // Nothing here says this device's access is the problem, because nothing
    // observed said so.
    expect(sentence).not.toMatch(/authorised|request access/i);
  });
});
