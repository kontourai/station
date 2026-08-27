/**
 * station#1484 slice 1 — assurance is derived, never asserted.
 *
 * The audit that preceded this slice found one defect class more often than
 * any other: a repo hand-rolling a **label** where the spec defines a
 * **derivation**. `hachure-org/spec`'s `assurance.md` defines L0/L1/L2 as a
 * function of (envelope present?, key class, verification outcome). These
 * tests exist to make it impossible for a later slice to reintroduce the
 * label — including by the most tempting route, which is a producer setting
 * its own level.
 */

import { describe, expect, test } from 'vitest';
import type {
  ChannelAssuranceVerifier,
  DsseEnvelopeShape,
} from '../channel-assurance.js';
import {
  assuranceSatisfies,
  deriveChannelRecordAssurance,
  isDsseEnvelopeShape,
} from '../channel-assurance.js';
import { readChannelFixture } from './helpers/channel-fixtures.js';

const WELL_FORMED_ENVELOPE: DsseEnvelopeShape = {
  payloadType: 'application/vnd.in-toto+json',
  payload: 'eyJfdHlwZSI6Imh0dHBzOi8vaW4tdG90by5pby9TdGF0ZW1lbnQvdjEifQ==',
  signatures: [{ keyid: 'key-home-epoch-3', sig: 'c2ln' }],
};

const acceptingVerifier = (
  keyClass: 'ephemeral-oidc' | 'held',
  keyId = 'key-home-epoch-3',
): ChannelAssuranceVerifier => ({
  verify: () => ({ verified: true, keyClass, keyId }),
});

const rejectingVerifier: ChannelAssuranceVerifier = {
  verify: () => ({ verified: false, reason: 'certificate expired' }),
};

describe('the L0 default is the spec rule, not a fallback', () => {
  test('a record with no envelope derives L0 with no annotation required', () => {
    expect(deriveChannelRecordAssurance({ schemaVersion: 'x' })).toEqual({
      kind: 'level',
      level: 'L0',
    });
  });

  test('every accepted fixture in the corpus derives L0 today', () => {
    // Slice 1 produces nothing signed. If this ever fails, either signing
    // arrived (and this test should be replaced deliberately) or a fixture
    // started claiming something it cannot back.
    for (const name of [
      'proposal-message.valid.json',
      'envelope-mid-chain.valid.json',
      'checkpoint.valid.json',
      'member-key.valid.json',
      'device-certificate.valid.json',
      'agent-grant.valid.json',
    ]) {
      expect(
        deriveChannelRecordAssurance(readChannelFixture(name)),
        name,
      ).toEqual({ kind: 'level', level: 'L0' });
    }
  });
});

describe('a producer cannot assert its own assurance', () => {
  test('a record carrying assuranceLevel/signature/verified still derives L0', () => {
    const hostile = readChannelFixture(
      'proposal-asserts-assurance-level.valid.json',
    ) as Record<string, unknown>;
    // The fixture really does carry the bait — if it stops, this test stops
    // proving anything.
    expect(hostile.assuranceLevel).toBe('L2');
    expect(hostile.signature).toBe('trust-me');
    expect(hostile.verified).toBe(true);

    expect(deriveChannelRecordAssurance({ record: hostile })).toEqual({
      kind: 'level',
      level: 'L0',
    });
  });

  test('the derivation reads only the carriage dsseEnvelope slot', () => {
    expect(
      deriveChannelRecordAssurance({
        record: {},
        assuranceLevel: 'L2',
        level: 'L2',
        assurance: { level: 'L2' },
        trusted: true,
      }),
    ).toEqual({ kind: 'level', level: 'L0' });
  });

  test('an envelope EMBEDDED in the record does not count — carriage only', () => {
    // `assurance.md`: the envelope "is carried alongside it, not embedded in
    // it". A record that smuggles a well-formed envelope into its own body
    // must not derive anything: the carriage slot is the only one a signer
    // populates, and an embedded one is a producer asserting about itself by
    // another route.
    expect(
      deriveChannelRecordAssurance({
        record: { dsseEnvelope: WELL_FORMED_ENVELOPE },
      }),
    ).toEqual({ kind: 'level', level: 'L0' });
  });
});

describe('an unchecked signature is a named gap, never a level', () => {
  test('an envelope with no verifier is verification-unavailable', () => {
    const outcome = deriveChannelRecordAssurance({
      record: {},
      dsseEnvelope: WELL_FORMED_ENVELOPE,
    });
    expect(outcome.kind).toBe('gap');
    if (outcome.kind !== 'gap') return;
    expect(outcome.code).toBe('verification-unavailable');
    expect(outcome.message).toMatch(/not L0 and not signed/);
  });

  test('an unchecked signature does NOT silently downgrade to L0', () => {
    // `assurance.md`, consumer policy: "A signed record with an unverifiable
    // or expired certificate does not silently downgrade to L0."
    const outcome = deriveChannelRecordAssurance({
      record: {},
      dsseEnvelope: WELL_FORMED_ENVELOPE,
    });
    expect(outcome).not.toEqual({ kind: 'level', level: 'L0' });
  });

  test('a failed verification is a gap, not a downgrade', () => {
    const outcome = deriveChannelRecordAssurance(
      { record: {}, dsseEnvelope: WELL_FORMED_ENVELOPE },
      rejectingVerifier,
    );
    expect(outcome).toEqual({
      kind: 'gap',
      code: 'verification-failed',
      message:
        'assurance: DSSE envelope verification failed (certificate expired)',
    });
  });

  test('a malformed envelope is a gap, not an absence', () => {
    for (const malformed of [
      {},
      { payloadType: '', payload: 'x', signatures: [{ keyid: 'k', sig: 's' }] },
      { payloadType: 'application/x', payload: 'x', signatures: [] },
      {
        payloadType: 'application/x',
        payload: 'x',
        signatures: [{ keyid: '', sig: 's' }],
      },
      'a string',
      null,
    ]) {
      const outcome = deriveChannelRecordAssurance({
        record: {},
        dsseEnvelope: malformed,
      });
      expect(outcome.kind, JSON.stringify(malformed)).toBe('gap');
      if (outcome.kind !== 'gap') continue;
      expect(outcome.code).toBe('envelope-malformed');
    }
  });

  test('a non-record is a named gap, not an L0', () => {
    for (const value of [null, undefined, 'record', 42, ['a']]) {
      const outcome = deriveChannelRecordAssurance(value);
      expect(outcome.kind).toBe('gap');
      if (outcome.kind !== 'gap') continue;
      expect(outcome.code).toBe('not-a-record');
    }
  });
});

describe('the L1/L2 boundary is the key class, per the spec', () => {
  test('an ephemeral OIDC-bound key derives L1', () => {
    expect(
      deriveChannelRecordAssurance(
        { record: {}, dsseEnvelope: WELL_FORMED_ENVELOPE },
        acceptingVerifier('ephemeral-oidc'),
      ),
    ).toEqual({
      kind: 'level',
      level: 'L1',
      verifiedKeyId: 'key-home-epoch-3',
    });
  });

  test('a long-lived held key derives L2', () => {
    expect(
      deriveChannelRecordAssurance(
        { record: {}, dsseEnvelope: WELL_FORMED_ENVELOPE },
        acceptingVerifier('held'),
      ),
    ).toEqual({
      kind: 'level',
      level: 'L2',
      verifiedKeyId: 'key-home-epoch-3',
    });
  });
});

describe('assuranceSatisfies is fail-closed', () => {
  test('higher levels satisfy lower requirements (strict superset)', () => {
    expect(assuranceSatisfies({ kind: 'level', level: 'L2' }, 'L0')).toBe(true);
    expect(assuranceSatisfies({ kind: 'level', level: 'L2' }, 'L1')).toBe(true);
    expect(assuranceSatisfies({ kind: 'level', level: 'L1' }, 'L1')).toBe(true);
  });

  test('lower levels do not satisfy higher requirements', () => {
    expect(assuranceSatisfies({ kind: 'level', level: 'L0' }, 'L1')).toBe(
      false,
    );
    expect(assuranceSatisfies({ kind: 'level', level: 'L1' }, 'L2')).toBe(
      false,
    );
  });

  test('an unreadable requirement satisfies nothing either', () => {
    // Fail-closed in BOTH arguments. A requirement this contract cannot read
    // is a requirement it cannot claim to have met.
    for (const required of ['', 'L3', 'l1', undefined, null, 1]) {
      expect(
        assuranceSatisfies({ kind: 'level', level: 'L2' }, required as never),
        JSON.stringify(required),
      ).toBe(false);
    }
  });

  test('a gap satisfies NOTHING — not even L0', () => {
    for (const code of [
      'not-a-record',
      'envelope-malformed',
      'verification-unavailable',
      'verification-failed',
      'unknown-key-class',
    ] as const) {
      expect(
        assuranceSatisfies({ kind: 'gap', code, message: 'm' }, 'L0'),
        code,
      ).toBe(false);
    }
  });
});

describe('an unknown key class is a gap, never the highest level', () => {
  test('a key class this contract cannot map does NOT derive L2', () => {
    // The earlier shape was `keyClass === 'ephemeral-oidc' ? 'L1' : 'L2'` — a
    // ternary whose fallback is the STRONGEST assurance, i.e. a default that
    // decides, deciding upward. Reachable the moment a third key class exists.
    const outcome = deriveChannelRecordAssurance(
      { record: {}, dsseEnvelope: WELL_FORMED_ENVELOPE },
      {
        verify: () => ({
          verified: true,
          keyClass: 'pgp-web-of-trust-2019' as never,
          keyId: 'key-x',
        }),
      },
    );
    expect(outcome.kind).toBe('gap');
    if (outcome.kind !== 'gap') return;
    expect(outcome.code).toBe('unknown-key-class');
  });

  test('a verifier that verifies without naming a key establishes nothing', () => {
    const outcome = deriveChannelRecordAssurance(
      { record: {}, dsseEnvelope: WELL_FORMED_ENVELOPE },
      {
        verify: () => ({ verified: true, keyClass: 'held', keyId: '' }),
      },
    );
    expect(outcome.kind).toBe('gap');
    if (outcome.kind !== 'gap') return;
    expect(outcome.code).toBe('verification-failed');
  });
});

describe('isDsseEnvelopeShape is structural and says nothing about validity', () => {
  test('accepts a well-formed envelope', () => {
    expect(isDsseEnvelopeShape(WELL_FORMED_ENVELOPE)).toBe(true);
  });

  test('accepts an envelope whose signature is total garbage', () => {
    // This is the point: a structural guard that started rejecting bad
    // signatures would be a verifier wearing a type guard's name, and
    // callers would read `true` as assurance.
    expect(
      isDsseEnvelopeShape({
        ...WELL_FORMED_ENVELOPE,
        signatures: [{ keyid: 'k', sig: 'not-a-signature' }],
      }),
    ).toBe(true);
  });
});
