/**
 * station#1484 slice 1 — the trip-wire between this package's structural
 * DSSE shape and the one `@kontourai/surface` publishes.
 *
 * The #1484 decision is explicit: "Do not invent the envelope. The Hachure
 * spec's `assurance.md` already defines DSSE envelopes over otherwise-valid
 * records." Surface already re-exports the in-toto/DSSE surface
 * (`DsseEnvelope`, `Signer`, `InTotoStatement`, `buildPaeBytes`,
 * `toDsseEnvelope`, `parseDssePayload`), and slices 3+ MUST sign through
 * those functions rather than hand-rolling PAE encoding — surface's own
 * `signing/sigstore.ts` header records what double-PAE encoding cost the
 * last time somebody layered it themselves.
 *
 * `@kontourai/station-contracts` still cannot *depend* on surface: the same
 * rule that keeps `EmbeddedDispatchReceipt` structural applies ("a contracts
 * package that pins a sibling's version makes every consumer inherit that
 * pin", `fleet-routing-receipt.ts`), and `src-ui` imports this package.
 *
 * So the shape is declared structurally and this file is the trip-wire that
 * keeps the declaration honest: it asserts **mutual assignability** in both
 * directions. If surface's `DsseEnvelope` gains, loses, or retypes a field,
 * this test goes red here — in slice 1, cheaply — rather than in slice 3 at
 * the moment somebody tries to hand a real envelope across the boundary.
 * Optional additions are covered too, by comparing the key sets directly.
 *
 * The dependency is TYPE-ONLY and lives in a test file, which is excluded
 * from the published package (`packages/contracts/package.json` `files`).
 */

import type { DsseEnvelope } from '@kontourai/surface';
import { buildPaeBytes } from '@kontourai/surface';
import { describe, expect, test } from 'vitest';
import type { DsseEnvelopeShape } from '../channel-assurance.js';
import { isDsseEnvelopeShape } from '../channel-assurance.js';

// Compile-time assertions. A drift in either direction fails `tsc`.
type _SurfaceEnvelopeFitsOurSlot = DsseEnvelope extends DsseEnvelopeShape
  ? true
  : never;
const _surfaceEnvelopeFitsOurSlot: _SurfaceEnvelopeFitsOurSlot = true;
void _surfaceEnvelopeFitsOurSlot;

/**
 * The other direction has exactly two deliberate divergences, and asserting
 * it with both normalised is how they stay *exactly two*:
 *
 * 1. **`payloadType` is widened to `string`** here, so a reader can hold an
 *    envelope whose payload type it does not accept and refuse it with a
 *    named reason instead of failing to parse it.
 * 2. **`signatures` is `readonly`** here. A contract that hands back a
 *    mutable array of a record it received invites a caller to edit
 *    somebody's signature list in place.
 *
 * The practical consequence for slice 3, recorded so it is not rediscovered:
 * passing a stored envelope back into a surface function that wants
 * `DsseEnvelope` needs `{ ...envelope, signatures: [...envelope.signatures] }`.
 * Any *third* divergence fails this assertion.
 */
type SurfaceCompatible<T> = Omit<T, 'payloadType' | 'signatures'> & {
  payloadType: 'application/vnd.in-toto+json';
  signatures: { keyid: string; sig: string }[];
};
type _OurSlotFitsSurfaceEnvelope =
  SurfaceCompatible<DsseEnvelopeShape> extends DsseEnvelope ? true : never;
const _ourSlotFitsSurfaceEnvelope: _OurSlotFitsSurfaceEnvelope = true;
void _ourSlotFitsSurfaceEnvelope;

/**
 * Mutual assignability alone does NOT catch an **optional** field added
 * upstream — `A extends B` stays true in both directions when B gains `x?:`
 * (slice-1 review, LOW 16, which caught the original doc claiming otherwise).
 * The key sets are therefore compared directly, which does catch it.
 */
type _KeySetsMatch = [keyof DsseEnvelope] extends [keyof DsseEnvelopeShape]
  ? [keyof DsseEnvelopeShape] extends [keyof DsseEnvelope]
    ? true
    : never
  : never;
const _keySetsMatch: _KeySetsMatch = true;
void _keySetsMatch;

describe('the DSSE shape stays byte-compatible with @kontourai/surface', () => {
  test('a surface-shaped envelope satisfies our structural guard', () => {
    const fromSurface: DsseEnvelope = {
      payloadType: 'application/vnd.in-toto+json',
      payload: 'eyJfdHlwZSI6Imh0dHBzOi8vaW4tdG90by5pby9TdGF0ZW1lbnQvdjEifQ==',
      signatures: [{ keyid: 'key-home-epoch-3', sig: 'c2ln' }],
    };
    expect(isDsseEnvelopeShape(fromSurface)).toBe(true);
  });

  test('surface owns the PAE encoding, and slices 3+ must call it rather than reimplement it', () => {
    // Asserted here so the dependency is a live fact rather than a comment:
    // PAE(type, body) = "DSSEv1" SP LEN(type) SP type SP LEN(body) SP body.
    const pae = new TextDecoder().decode(buildPaeBytes('t', 'body'));
    expect(pae).toBe('DSSEv1 1 t 4 body');
  });
});
