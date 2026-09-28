/**
 * station#1398 — the routing-receipt contract's own invariants
 * (`docs/design/inference-fleet.md` §4.4, §4.5, §8; security review L-2/L-6).
 *
 * These are the properties the surfaces, the router, and the log all depend
 * on being true, so they are pinned here rather than re-derived three times.
 */

import { describe, expect, it } from 'vitest';
import {
  type ConsumerProbeObservation,
  canonicalizeForDigest,
  capFleetEvidenceLevel,
  describeConsumerProbe,
  FLEET_LOCAL_EVIDENCE_LABEL,
  FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
  FLEET_PROBE_VERIFIED_EVIDENCE_LABEL,
  FLEET_ROUTING_EXCLUSION_CODES,
  type FleetRoutingExclusionCode,
  fleetEvidenceLevelWithProbe,
} from '../fleet-routing-receipt.js';

describe('a peer-attested claim can never grade as confirmed', () => {
  it('caps peer-attested evidence at declared, and leaves local evidence alone', () => {
    expect(capFleetEvidenceLevel('confirmed', 'peer-attested')).toBe(
      'declared',
    );
    expect(capFleetEvidenceLevel('declared', 'peer-attested')).toBe('declared');
    expect(capFleetEvidenceLevel('unavailable', 'peer-attested')).toBe(
      'unavailable',
    );
    // `confirmed` means a bounded completion was OBSERVED. This Station can
    // observe its own; slice 5's smoke is the first thing that will observe a
    // peer's.
    expect(capFleetEvidenceLevel('confirmed', 'local-observation')).toBe(
      'confirmed',
    );
  });

  it('keeps the two honesty labels distinct and non-empty', () => {
    expect(FLEET_PEER_ATTESTED_EVIDENCE_LABEL).toBe(
      'attested by peer, not verified',
    );
    expect(FLEET_LOCAL_EVIDENCE_LABEL).not.toBe(
      FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
    );
  });
});

describe('the exclusion vocabulary cannot grow without a decision (L-2)', () => {
  it('maps every code to a recorded origin', () => {
    // The tripwire itself is the `Record<FleetRoutingExclusionCode, ...>`
    // type in the contract: adding a union member stops that file
    // typechecking until somebody classifies it. This test guards the
    // runtime half — that the map is actually populated and not, say,
    // widened to `Record<string, ...>` by a later edit.
    const codes = Object.keys(
      FLEET_ROUTING_EXCLUSION_CODES,
    ) as FleetRoutingExclusionCode[];
    expect(codes.length).toBeGreaterThanOrEqual(12);
    for (const code of codes) {
      expect(['design', 'station']).toContain(
        FLEET_ROUTING_EXCLUSION_CODES[code],
      );
    }
  });

  it('carries §4.5’s seven named codes as design-origin', () => {
    for (const code of [
      'peer-unreachable',
      'peer-scope-denied',
      'evidence-stale',
      'probe-failed',
      'capability-withdrawn',
      'reference-unresolvable',
      'below-minimum-evidence',
    ] as const) {
      expect(FLEET_ROUTING_EXCLUSION_CODES[code]).toBe('design');
    }
  });

  it('names resolution-failed as a Station-side fact, distinct from peer-unreachable', () => {
    // They are different sentences: one says a peer did not answer, the other
    // says this Station could not ask. Collapsing them would attribute a
    // local failure to a peer.
    expect(FLEET_ROUTING_EXCLUSION_CODES['resolution-failed']).toBe('station');
    expect(FLEET_ROUTING_EXCLUSION_CODES['peer-unreachable']).toBe('design');
  });
});

describe('canonicalization makes a digest key-order independent (L-6)', () => {
  it('produces identical JSON for the same content built in a different order', () => {
    const a = {
      availability: 'available',
      freshness: 'live',
      observedAt: null,
    };
    const b = {
      observedAt: null,
      freshness: 'live',
      availability: 'available',
    };
    expect(JSON.stringify(canonicalizeForDigest(a))).toBe(
      JSON.stringify(canonicalizeForDigest(b)),
    );
    // Sanity: the naive serialization these two would otherwise get really
    // does differ, so the assertion above is not vacuous.
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('sorts nested keys too, and leaves array order alone', () => {
    const value = { z: [{ b: 1, a: 2 }], a: { d: 1, c: 2 } };
    expect(JSON.stringify(canonicalizeForDigest(value))).toBe(
      '{"a":{"c":2,"d":1},"z":[{"a":2,"b":1}]}',
    );
    // Array ORDER is content, not incidental ordering — reordering candidates
    // or exclusions is a real change and must change the digest.
    expect(JSON.stringify(canonicalizeForDigest([1, 2]))).not.toBe(
      JSON.stringify(canonicalizeForDigest([2, 1])),
    );
  });
});

describe('canonicalizeForDigest copies __proto__ instead of assigning it', () => {
  // station#1484 slice-1 review, BLOCKER. `result[key] = ...` hits
  // Object.prototype's `__proto__` ACCESSOR for that one key name: the
  // property is not created, the result's prototype is reassigned, and the
  // key disappears from JSON.stringify. Two documents differing only in a
  // `__proto__` member therefore canonicalized to identical bytes and so to
  // an identical digest — which is exactly the collision a receipt exists to
  // make impossible.
  const withProto = JSON.parse(
    '{"a":1,"__proto__":{"role":"admin"}}',
  ) as Record<string, unknown>;
  const withoutProto = JSON.parse('{"a":1}') as Record<string, unknown>;

  it('JSON.parse really does deliver __proto__ as data', () => {
    expect(Object.keys(withProto)).toContain('__proto__');
  });

  it('the two documents no longer share one canonical form', () => {
    expect(JSON.stringify(canonicalizeForDigest(withProto))).not.toBe(
      JSON.stringify(canonicalizeForDigest(withoutProto)),
    );
  });

  it('the canonical form keeps an ordinary prototype', () => {
    const canonical = canonicalizeForDigest(withProto) as object;
    expect(Object.getPrototypeOf(canonical)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).role).toBeUndefined();
  });

  it('nested objects are covered too', () => {
    const nested = JSON.parse('{"body":{"__proto__":{"role":"admin"}}}');
    const clean = JSON.parse('{"body":{}}');
    expect(JSON.stringify(canonicalizeForDigest(nested))).not.toBe(
      JSON.stringify(canonicalizeForDigest(clean)),
    );
  });

  it('key ordering and ordinary documents are unchanged', () => {
    expect(
      JSON.stringify(canonicalizeForDigest({ b: 1, a: { d: 2, c: 3 } })),
    ).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe('the cap still binds every unverified claim', () => {
  function probe(status: ConsumerProbeObservation['status']) {
    return {
      status,
      observedAt: '2026-08-01T12:00:00.000Z',
      expiresAt: '2026-08-01T12:15:00.000Z',
      elapsedMs: 12,
      servedProviderModel: 'qwen3:32b',
      failureCode: null,
    } satisfies ConsumerProbeObservation;
  }

  // Asked AT a fixed instant inside the fixture's own window, never against
  // the wall clock. A fixture with a hardcoded `expiresAt` evaluated against
  // `Date.now()` asserts the pass path right up until that timestamp goes by
  // and then reds spontaneously on pristine main — the time-bomb shape.
  const WITHIN_WINDOW = Date.parse('2026-08-01T12:05:00.000Z');

  it('raises a probed candidate to confirmed, with probe-verified provenance and its own label', () => {
    expect(
      fleetEvidenceLevelWithProbe('confirmed', probe('passed'), WITHIN_WINDOW),
    ).toEqual({
      level: 'confirmed',
      provenance: 'probe-verified',
      label: FLEET_PROBE_VERIFIED_EVIDENCE_LABEL,
    });
  });

  it('the probe-verified label is DISTINCT from the peer-attested one', () => {
    expect(FLEET_PROBE_VERIFIED_EVIDENCE_LABEL).not.toBe(
      FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
    );
    expect(FLEET_PROBE_VERIFIED_EVIDENCE_LABEL).toContain('bounded completion');
  });

  it('an UNVERIFIED claim is still capped at declared, however healthy the peer says it is', () => {
    // The fault this whole design exists to prevent: a peer asserting
    // available/live must not reach `confirmed` by any path that does not
    // include an observation.
    for (const probeState of [null, probe('failed'), probe('stale')] as const) {
      expect(
        fleetEvidenceLevelWithProbe('confirmed', probeState, WITHIN_WINDOW),
      ).toEqual({
        level: 'declared',
        provenance: 'peer-attested',
        label: FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
      });
    }
    // And the underlying cap is untouched, not deleted.
    expect(capFleetEvidenceLevel('confirmed', 'peer-attested')).toBe(
      'declared',
    );
  });

  it("a 'passed' record whose expiresAt has gone by does NOT reach confirmed, even when the caller forgot to re-stamp it", () => {
    // The replay case. `FleetProbeService.observe` stamps `status: 'stale'`
    // on an expired record, so the LIVE path never reaches this function with
    // an expired `passed`. But this function is exported from contracts, and
    // `ConsumerProbeObservation` is stored verbatim in the receipt — anything
    // that reads one back (receipt replay, a cross-process cache)
    // hands it over exactly as stored, with `status: 'passed'` intact.
    // Enforcing expiry only in the caller made the docblock's "and has not
    // expired" a promise the function did not keep.
    const expiredPass: ConsumerProbeObservation = {
      status: 'passed',
      observedAt: '2026-08-01T11:00:00.000Z',
      expiresAt: '2026-08-01T11:15:00.000Z',
      elapsedMs: 12,
      servedProviderModel: 'qwen3:32b',
      failureCode: null,
    };
    const wellAfterExpiry = Date.parse('2026-08-01T12:00:00.000Z');

    expect(
      fleetEvidenceLevelWithProbe('confirmed', expiredPass, wellAfterExpiry),
    ).toEqual({
      level: 'declared',
      provenance: 'peer-attested',
      label: FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
    });

    // ... and the identical record, asked BEFORE its expiry, still verifies.
    // Without this half the test would also pass if the function simply
    // stopped honoring probes at all.
    const beforeExpiry = Date.parse('2026-08-01T11:14:00.000Z');
    expect(
      fleetEvidenceLevelWithProbe('confirmed', expiredPass, beforeExpiry),
    ).toEqual({
      level: 'confirmed',
      provenance: 'probe-verified',
      label: FLEET_PROBE_VERIFIED_EVIDENCE_LABEL,
    });
  });

  it('a passing probe outranks the manifest, even for a model the peer called unavailable', () => {
    // `unavailable` in means `unavailable` out is NOT the rule — a probe is a
    // genuine observation and outranks the manifest. But the peer's
    // unavailable models never reach the probe at all (they are excluded as
    // `evidence-stale` first), so this pins the function's honest behavior
    // rather than the pipeline's: given an observation, the observation wins.
    expect(
      fleetEvidenceLevelWithProbe(
        'unavailable',
        probe('passed'),
        WITHIN_WINDOW,
      ),
    ).toEqual({
      level: 'confirmed',
      provenance: 'probe-verified',
      label: FLEET_PROBE_VERIFIED_EVIDENCE_LABEL,
    });
  });
});

describe('describeConsumerProbe is the one wording both surfaces render', () => {
  it('says nothing when there is nothing to say', () => {
    expect(describeConsumerProbe(null)).toBeNull();
  });

  it('names the expiry on a stale observation, so it cannot read as current', () => {
    const phrase = describeConsumerProbe({
      status: 'stale',
      observedAt: '2026-08-01T12:00:00.000Z',
      expiresAt: '2026-08-01T12:15:00.000Z',
      elapsedMs: 12,
      servedProviderModel: 'qwen3:32b',
      failureCode: null,
    });
    expect(phrase).toContain('expired');
    expect(phrase).toContain('not evidence about now');
  });

  it('names the failure code on a failed observation', () => {
    expect(
      describeConsumerProbe({
        status: 'failed',
        observedAt: '2026-08-01T12:00:00.000Z',
        expiresAt: '2026-08-01T12:02:00.000Z',
        elapsedMs: null,
        servedProviderModel: null,
        failureCode: 'peer-unreachable',
      }),
    ).toContain('peer-unreachable');
  });
});
