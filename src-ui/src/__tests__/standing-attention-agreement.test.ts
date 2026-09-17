/**
 * #1536 D8 delta review DM3.
 *
 * "A standing notice" has two consequences on two sides of the wire — it sorts
 * below live attention and it cannot be acknowledged — and they were declared
 * separately: a `STANDING_ATTENTION_KINDS` set inside the server projection,
 * and `item.kind !== 'setup-incomplete'` inside the client predicate. Two lists
 * that agreed on the day they were written. The membership now lives in the
 * contract and both sides read it, so this asserts the READING rather than
 * re-listing the kinds a third time.
 */

import {
  isStandingAttentionKind,
  STANDING_ATTENTION_KINDS,
} from '@kontourai/station-contracts/attention';
import { describe, expect, it } from 'vitest';
import { isAcknowledgeableAttentionItem } from '../utils/attention';

const KINDS = [
  'approval',
  'needs_input',
  'review_pending',
  'session-failed',
  'gate-route-back',
  'gate-blocked',
  'gate-exception',
  'device-pairing',
  'setup-incomplete',
] as const;

describe('the standing-notice declaration governs both sides', () => {
  it('is the contract that decides, for every kind there is', () => {
    // Not "setup-incomplete is standing" — that is the CURRENT membership and
    // asserting it here would be a second list. What must hold is that the
    // client predicate is the contract's answer, whatever it says.
    for (const kind of KINDS) {
      expect(
        isAcknowledgeableAttentionItem({ kind } as never),
        `dismissibility of ${kind}`,
      ).toBe(!isStandingAttentionKind(kind));
    }
  });

  it('declares at least one standing kind, so the agreement above is not vacuous', () => {
    // With an empty set every kind is acknowledgeable and the loop passes
    // without exercising the branch it exists for.
    expect(STANDING_ATTENTION_KINDS.size).toBeGreaterThan(0);
    expect(
      [...STANDING_ATTENTION_KINDS].some((kind) =>
        KINDS.includes(kind as never),
      ),
    ).toBe(true);
  });

  it('covers every kind the union declares, so a new kind cannot slip past this file', () => {
    for (const kind of STANDING_ATTENTION_KINDS) {
      expect(KINDS).toContain(kind);
    }
  });
});
