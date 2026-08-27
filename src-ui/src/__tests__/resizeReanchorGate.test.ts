// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';
import { createResizeReanchorGate } from '../components/chat/chatScrollAnchor';

describe('createResizeReanchorGate', () => {
  test('does not reanchor on a single sub-threshold delta', () => {
    const gate = createResizeReanchorGate(100, 4);
    expect(gate.shouldReanchor(102)).toBe(false); // +2px, below the 4px threshold
  });

  test('reanchors and rebases the baseline only when a delta is accepted', () => {
    const gate = createResizeReanchorGate(100, 4);

    expect(gate.shouldReanchor(104)).toBe(true); // +4px from 100 -> accepted, baseline -> 104
    expect(gate.shouldReanchor(106)).toBe(false); // +2px from the NEW baseline (104) -> below threshold
    expect(gate.shouldReanchor(108)).toBe(true); // +4px from 104 -> accepted, baseline -> 108
  });

  test('regression: several sub-threshold deltas accumulate against a stable baseline instead of resetting every callback', () => {
    // Pre-fix bug: the baseline was rebased on every ResizeObserver callback
    // regardless of whether a reanchor was accepted, so N consecutive
    // below-threshold deltas (e.g. mobile visualViewport keyboard-animation
    // ticks, see useMobileVisualViewport.ts) could sum well past the
    // threshold without ever firing — the anchor then goes stale and
    // restoreChatScrollAnchor misapplies by the missed cumulative sum.
    const gate = createResizeReanchorGate(100, 8);

    const accepted = [102, 104, 106, 108].map((height) =>
      gate.shouldReanchor(height),
    );

    // Four +2px steps (cumulative +8) trigger exactly one reanchor, at the
    // point the cumulative delta from the held baseline first reaches the
    // threshold — not zero (the pre-fix "rebase every callback" bug) and
    // not four (naive per-callback threshold checks against a moving
    // baseline would still fire at most once here too, but only because
    // this threshold is chosen above each individual step).
    expect(accepted).toEqual([false, false, false, true]);
    expect(accepted.filter(Boolean)).toHaveLength(1);
  });

  test('a run of sub-threshold deltas followed by nothing further triggers no reanchor', () => {
    const gate = createResizeReanchorGate(100, 8);

    expect(gate.shouldReanchor(102)).toBe(false);
    expect(gate.shouldReanchor(104)).toBe(false);
    expect(gate.shouldReanchor(106)).toBe(false);
    // No further calls — never crossed the threshold, so it never reanchors.
  });

  test('at the production threshold (4px), accumulated deltas still eventually reanchor', () => {
    // Mirrors ChatMessageList's actual RESIZE_REANCHOR_THRESHOLD_PX=4 to
    // demonstrate the fix holds at the real production configuration, not
    // just a convenient test threshold.
    const gate = createResizeReanchorGate(100, 4);

    const accepted = [101, 102, 103, 104, 105].map((height) =>
      gate.shouldReanchor(height),
    );

    // +1px steps: baseline moves to 104 the first time the cumulative delta
    // reaches 4, then the run continues accumulating from that new baseline.
    expect(accepted).toEqual([false, false, false, true, false]);
  });
});
