/**
 * station#1398 — the routing-receipt contract's own invariants
 * (`docs/design/inference-fleet.md` §4.4, §4.5, §8; security review L-2/L-6).
 *
 * These are the properties the surfaces, the router, and the log all depend
 * on being true, so they are pinned here rather than re-derived three times.
 */

import { describe, expect, it } from 'vitest';
import {
  canonicalizeForDigest,
  capFleetEvidenceLevel,
  FLEET_LOCAL_EVIDENCE_LABEL,
  FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
  FLEET_ROUTING_EXCLUSION_CODES,
  type FleetRoutingExclusionCode,
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
