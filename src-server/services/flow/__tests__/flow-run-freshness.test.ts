import type { FlowRunState } from '@kontourai/flow';
import { describe, expect, test } from 'vitest';
import { deriveFlowRunFreshness } from '../flow-run-freshness.js';

/**
 * A run in the state the auto-attached `station-delivery` run has always
 * shipped in: created, never evaluated, sitting on a step with no gate — and
 * carrying an `updated_at` that is as recent as the attach that created it.
 */
function ungatedNeverEvaluatedState(
  overrides: Partial<FlowRunState> = {},
): FlowRunState {
  return {
    schema_version: '0.1',
    run_id: 'session-thread-1',
    definition_id: 'station-delivery',
    definition_version: '1',
    subject: 'session:thread-1',
    status: 'active',
    current_step: 'plan',
    gate_outcomes: [],
    transitions: [],
    exceptions: [],
    next_action: 'no open gate',
    updated_at: '2026-08-01T12:00:00.000Z',
    ...overrides,
  } as FlowRunState;
}

describe('deriveFlowRunFreshness', () => {
  test('reports never-evaluated and ungated for a run on a gateless step', () => {
    expect(
      deriveFlowRunFreshness({
        state: ungatedNeverEvaluatedState(),
        openGates: [],
        manifestEvidence: [],
      }),
    ).toEqual({
      lastEvaluatedAt: null,
      blockedReason: 'ungated-step',
      gateOutcomeCount: 0,
      evidenceCount: 0,
    });
  });

  test('never borrows freshness from updated_at', () => {
    // The load-bearing property. `updated_at` is written by attach, evidence
    // attach and projection sync alike, so it is always "fresh" and always
    // says nothing about evaluation. Moving it must not move freshness.
    const stale = deriveFlowRunFreshness({
      state: ungatedNeverEvaluatedState({
        updated_at: '2020-01-01T00:00:00.000Z',
      }),
      openGates: [],
      manifestEvidence: [],
    });
    const fresh = deriveFlowRunFreshness({
      state: ungatedNeverEvaluatedState({
        updated_at: new Date().toISOString(),
      }),
      openGates: [],
      manifestEvidence: [],
    });

    expect(stale.lastEvaluatedAt).toBeNull();
    expect(fresh.lastEvaluatedAt).toBeNull();
  });

  test('takes the latest transition timestamp as the evaluation time', () => {
    const freshness = deriveFlowRunFreshness({
      state: ungatedNeverEvaluatedState({
        status: 'active',
        current_step: 'verify',
        gate_outcomes: [
          { gate_id: 'implement-gate', status: 'pass', summary: 'satisfied' },
        ],
        transitions: [
          {
            from_step: 'implement',
            to_step: 'verify',
            at: '2026-07-30T09:00:00.000Z',
          },
          {
            from_step: 'plan',
            to_step: 'implement',
            at: '2026-07-29T09:00:00.000Z',
          },
        ],
      }),
      openGates: [{ id: 'verify-gate', step: 'verify' }],
      manifestEvidence: [{ id: 'ev.1' }, { id: 'ev.2' }],
    });

    expect(freshness).toEqual({
      lastEvaluatedAt: '2026-07-30T09:00:00.000Z',
      gateOutcomeCount: 1,
      evidenceCount: 2,
    });
  });

  test('an evaluated-but-waiting run is distinguishable from a never-evaluated one', () => {
    // The real shape Flow 1.3.0 leaves behind for a `wait`: the outcome is
    // merged into gate_outcomes and NO transition is appended, so there is no
    // timestamp anywhere. That is the disclosed gap — the honest reading is
    // "evaluated, time unrecorded", which is `gateOutcomeCount >= 1` with a
    // null timestamp, and must not collapse into "never evaluated" (count 0).
    const freshness = deriveFlowRunFreshness({
      state: ungatedNeverEvaluatedState({
        current_step: 'implement',
        gate_outcomes: [
          {
            gate_id: 'implement-gate',
            status: 'wait',
            summary: 'Implement gate waiting for evidence',
            evidence_refs: [],
          },
        ],
        transitions: [],
      }),
      openGates: [{ id: 'implement-gate', step: 'implement' }],
      manifestEvidence: [{ id: 'ev.1' }],
    });

    expect(freshness).toEqual({
      lastEvaluatedAt: null,
      gateOutcomeCount: 1,
      evidenceCount: 1,
    });
  });

  test('counts only evidence that has not been superseded', () => {
    // A superseded entry was replaced by a later attach in the fix-and-rerun
    // loop and is retained for audit only; counting it would overstate what
    // the run actually stands on.
    const freshness = deriveFlowRunFreshness({
      state: ungatedNeverEvaluatedState(),
      openGates: [],
      manifestEvidence: [
        { id: 'ev.1', superseded_by: 'ev.3' },
        { id: 'ev.2' },
        { id: 'ev.3' },
      ],
    });

    expect(freshness.evidenceCount).toBe(2);
  });

  test('ignores unparseable timestamps rather than reporting a bad one', () => {
    const freshness = deriveFlowRunFreshness({
      state: ungatedNeverEvaluatedState({
        gate_outcomes: [{ gate_id: 'g', status: 'wait', summary: 'waiting' }],
        transitions: [{ at: 'not-a-date' }, { at: 42 }],
      }),
      openGates: [{ id: 'g', step: 'plan' }],
      manifestEvidence: [],
    });

    expect(freshness.lastEvaluatedAt).toBeNull();
    expect(freshness.gateOutcomeCount).toBe(1);
  });

  test('does not call a completed run ungated when its last step has no open gate', () => {
    const freshness = deriveFlowRunFreshness({
      state: ungatedNeverEvaluatedState({
        status: 'completed',
        current_step: 'readiness',
        transitions: [{ at: '2026-07-31T10:00:00.000Z' }],
      }),
      openGates: [],
      manifestEvidence: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    });

    expect(freshness.blockedReason).toBeUndefined();
    expect(freshness.lastEvaluatedAt).toBe('2026-07-31T10:00:00.000Z');
  });
});
