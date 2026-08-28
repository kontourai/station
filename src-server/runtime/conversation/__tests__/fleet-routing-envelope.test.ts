/**
 * archive#1398 — the envelope fold. These tests exist because the
 * fold is where the two behaviors §4.5 bans outright would land if they
 * landed anywhere: a silent fallback, and a dropped exclusion.
 */

import type {
  EmbeddedDispatchReceipt,
  FleetRoutingCandidate,
  FleetRoutingExclusion,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import {
  FLEET_LOCAL_EVIDENCE_LABEL,
  FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
  FLEET_ROUTING_FAILURE_CODES,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import { describe, expect, it } from 'vitest';
import { buildFleetRoutingEnvelope } from '../fleet-routing-envelope.js';

const LOCAL: FleetRoutingCandidate = {
  candidateId: 'candidate-0',
  runtimeId: 'runtime-0',
  origin: 'local',
  environmentId: null,
  environmentLabel: null,
  modelId: 'claude-sonnet',
  evidence: {
    level: 'confirmed',
    provenance: 'local-observation',
    label: FLEET_LOCAL_EVIDENCE_LABEL,
    peerAttested: null,
    probe: null,
  },
  admitted: true,
};

const FLEET: FleetRoutingCandidate = {
  candidateId: 'fleet-candidate-0',
  runtimeId: 'fleet-runtime-0',
  origin: 'fleet',
  environmentId: 'env-workstation',
  environmentLabel: 'Workstation',
  modelId: 'ollama/qwen3',
  evidence: {
    level: 'declared',
    provenance: 'peer-attested',
    label: FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
    peerAttested: {
      availability: 'available',
      freshness: 'live',
      observedAt: '2026-08-01T00:00:00.000Z',
      manifestSourceObservedAt: '2026-08-01T00:00:00.000Z',
      fetchedAt: '2026-08-01T12:00:00.000Z',
      digest: 'a'.repeat(64),
    },
    probe: null,
  },
  admitted: true,
};

function receipt(
  overrides: Partial<EmbeddedDispatchReceipt> = {},
): EmbeddedDispatchReceipt {
  return {
    schemaVersion: 1,
    planDigest: 'plan',
    requestDigest: 'request',
    role: 'station-agent',
    outcome: 'succeeded',
    attempts: [],
    totalElapsedMs: 10,
    totalTokens: 0,
    estimatedCostUsd: 0,
    ...overrides,
  };
}

const context = {
  environmentId: 'env-laptop',
  agentName: 'researcher',
  candidates: [FLEET, LOCAL],
  exclusions: [],
};

describe('the envelope names where a turn ran, and on what kind of evidence', () => {
  it('attributes a fleet-served turn to the peer, keeping peer-attested provenance', () => {
    const envelope = buildFleetRoutingEnvelope(
      context,
      receipt({
        attempts: [
          {
            candidateId: 'fleet-candidate-0',
            runtimeId: 'fleet-runtime-0',
            outcome: 'succeeded',
            elapsedMs: 10,
          },
        ],
      }),
      '2026-08-01T12:00:01.000Z',
    );
    expect(envelope.selection).toMatchObject({
      origin: 'fleet',
      environmentId: 'env-workstation',
      environmentLabel: 'Workstation',
    });
    expect(envelope.selection?.evidence.provenance).toBe('peer-attested');
    expect(envelope.selection?.evidence.label).toBe(
      FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
    );
    // Ran on the fleet as intended: no failure state.
    expect(envelope.failure).toBeNull();
  });

  it('records a local success after a failed fleet attempt as fell-back-to-local', () => {
    // The §4.5 banned behavior this test exists for: the turn SUCCEEDED, and
    // a receipt that reported only that would hide that the work silently
    // changed machines.
    const envelope = buildFleetRoutingEnvelope(
      context,
      receipt({
        attempts: [
          {
            candidateId: 'fleet-candidate-0',
            runtimeId: 'fleet-runtime-0',
            outcome: 'failed',
            elapsedMs: 5,
            errorCode: 'peer-unreachable',
          },
          {
            candidateId: 'candidate-0',
            runtimeId: 'runtime-0',
            outcome: 'succeeded',
            elapsedMs: 8,
          },
        ],
      }),
      '2026-08-01T12:00:01.000Z',
    );
    expect(envelope.selection?.origin).toBe('local');
    expect(envelope.failure).toMatchObject({ code: 'fell-back-to-local' });
    expect(envelope.failure?.message).toContain('Workstation');
    expect(envelope.failure?.message).toContain('peer-unreachable');
  });

  it('does not invent a fallback when no fleet candidate was ever attempted', () => {
    const envelope = buildFleetRoutingEnvelope(
      context,
      receipt({
        attempts: [
          {
            candidateId: 'candidate-0',
            runtimeId: 'runtime-0',
            outcome: 'succeeded',
            elapsedMs: 8,
          },
        ],
      }),
      '2026-08-01T12:00:01.000Z',
    );
    expect(envelope.failure).toBeNull();
  });

  it('names no-eligible-candidates rather than reporting an empty success', () => {
    const envelope = buildFleetRoutingEnvelope(
      {
        ...context,
        candidates: [{ ...FLEET, admitted: false }],
        exclusions: [
          {
            candidateId: 'fleet-candidate-0',
            environmentId: 'env-workstation',
            environmentLabel: 'Workstation',
            modelId: 'ollama/qwen3',
            code: 'below-minimum-evidence',
            message: 'policy requires confirmed',
            source: 'station',
          },
        ],
      },
      receipt({ outcome: 'no-eligible-candidates' }),
      '2026-08-01T12:00:01.000Z',
    );
    expect(envelope.selection).toBeNull();
    expect(envelope.failure?.code).toBe('no-eligible-candidates');
    expect(envelope.exclusions).toHaveLength(1);
  });

  it('records the stream capability and the non-interactive scope on every envelope', () => {
    const envelope = buildFleetRoutingEnvelope(
      context,
      receipt(),
      '2026-08-01T12:00:01.000Z',
    );
    expect(envelope.stream.capable).toBe(false);
    expect(envelope.interactivity).toBe('non-interactive');
  });

  it('embeds the Dispatch receipt unchanged', () => {
    const source = receipt({ planDigest: 'plan-digest-value' });
    const envelope = buildFleetRoutingEnvelope(
      context,
      source,
      '2026-08-01T12:00:01.000Z',
    );
    expect(envelope.dispatch).toBe(source);
  });
});

/**
 * archive#1556. `no-eligible-candidates` used to be the fallthrough for every
 * non-succeeded outcome without a fleet attempt, so Dispatch's `exhausted`
 * — "candidates were tried and none succeeded" — rendered as "nothing was
 * eligible to try". A single non-retryable local model failure produces that
 * outcome, so this was the ordinary error path telling every operator to go
 * read routing policy that had never excluded anything.
 */
describe('a failure code states what actually happened (station#1556)', () => {
  const BELOW_EVIDENCE: FleetRoutingExclusion = {
    candidateId: 'fleet-candidate-0',
    environmentId: 'env-workstation',
    environmentLabel: 'Workstation',
    modelId: 'ollama/qwen3',
    code: 'below-minimum-evidence',
    message: 'policy requires confirmed',
    source: 'station',
  };

  it('reports an attempted-and-failed local candidate as attempts-failed, not as an exclusion', () => {
    const envelope = buildFleetRoutingEnvelope(
      { ...context, candidates: [LOCAL], exclusions: [] },
      receipt({
        outcome: 'exhausted',
        attempts: [
          {
            candidateId: 'candidate-0',
            runtimeId: 'runtime-0',
            outcome: 'failed',
            elapsedMs: 5,
            errorCode: 'RUNTIME_FAILURE',
          },
        ],
      }),
      '2026-08-01T12:00:01.000Z',
    );
    expect(envelope.candidates[0]?.admitted).toBe(true);
    expect(envelope.failure?.code).toBe('attempts-failed');
    expect(envelope.failure?.code).not.toBe('no-eligible-candidates');
    // The operator's actual question: was anything dispatched?
    expect(
      FLEET_ROUTING_FAILURE_CODES[envelope.failure?.code ?? 'aborted']
        .attemptsMade,
    ).toBe(true);
    expect(envelope.failure?.message).toContain('attempted');
    // archive#1556 review (M5): the message must not assert that NO fleet
    // candidate was attempted. `fleetAttempted` is matched against this
    // Station's REPLICA of the candidate list, which the design explicitly
    // allows to diverge from Dispatch's own set — so a Dispatch attempt on a
    // candidate missing from the replica would make that negative false. The
    // code name already carries the distinction; the sentence must not
    // over-reach past what the receipt can see.
    expect(envelope.failure?.message).not.toMatch(/no fleet candidate/i);
  });

  it('does not claim an exclusion when the exclusion list is empty', () => {
    // Dispatch's own eligibility predicate said nothing was eligible, but this
    // Station's replica recorded no exclusion — the receipt cannot name a
    // reason, so it says that rather than pointing at an empty list.
    const envelope = buildFleetRoutingEnvelope(
      {
        ...context,
        candidates: [{ ...FLEET, admitted: false }],
        exclusions: [],
      },
      receipt({ outcome: 'no-eligible-candidates' }),
      '2026-08-01T12:00:01.000Z',
    );
    expect(envelope.failure?.code).toBe('unexplained-no-attempt');
    expect(envelope.exclusions).toHaveLength(0);
  });

  it('still names no-eligible-candidates when there is an exclusion to point at', () => {
    const envelope = buildFleetRoutingEnvelope(
      {
        ...context,
        candidates: [{ ...FLEET, admitted: false }],
        exclusions: [BELOW_EVIDENCE],
      },
      receipt({ outcome: 'no-eligible-candidates' }),
      '2026-08-01T12:00:01.000Z',
    );
    expect(envelope.failure?.code).toBe('no-eligible-candidates');
  });

  it('never emits an exclusion-claiming code with an empty exclusion list', () => {
    // The invariant asserted directly, over every ending the builder can
    // produce rather than over one hand-picked case. An empty exclusions list
    // and a failure code claiming exclusion cannot co-occur.
    const outcomes = [
      'succeeded',
      'exhausted',
      'aborted',
      'budget-exceeded',
      'no-eligible-candidates',
    ];
    const attemptSets = [
      [],
      [
        {
          candidateId: 'candidate-0',
          runtimeId: 'runtime-0',
          outcome: 'failed' as const,
          elapsedMs: 5,
        },
      ],
      [
        {
          candidateId: 'fleet-candidate-0',
          runtimeId: 'fleet-runtime-0',
          outcome: 'failed' as const,
          elapsedMs: 5,
        },
      ],
      [
        {
          candidateId: 'fleet-candidate-0',
          runtimeId: 'fleet-runtime-0',
          outcome: 'failed' as const,
          elapsedMs: 5,
        },
        {
          candidateId: 'candidate-0',
          runtimeId: 'runtime-0',
          outcome: 'succeeded' as const,
          elapsedMs: 8,
        },
      ],
    ];

    let checked = 0;
    for (const outcome of outcomes) {
      for (const attempts of attemptSets) {
        for (const exclusions of [[], [BELOW_EVIDENCE]]) {
          const envelope = buildFleetRoutingEnvelope(
            { ...context, exclusions },
            receipt({ outcome, attempts }),
            '2026-08-01T12:00:01.000Z',
          );
          checked += 1;
          const code = envelope.failure?.code;
          if (!code) continue;
          if (FLEET_ROUTING_FAILURE_CODES[code].claimsExclusion) {
            expect(envelope.exclusions.length).toBeGreaterThan(0);
          }
        }
      }
    }
    // Guard against the matrix silently collapsing to nothing.
    expect(checked).toBe(outcomes.length * attemptSets.length * 2);
  });

  it('classifies every failure code, so a new one cannot arrive unclassified', () => {
    const codes = Object.keys(FLEET_ROUTING_FAILURE_CODES);
    expect(codes).toContain('attempts-failed');
    expect(codes).toContain('unexplained-no-attempt');
    // Exactly one code may claim an exclusion; that is what makes the
    // invariant above checkable rather than a per-code convention.
    const claiming = codes.filter(
      (code) =>
        FLEET_ROUTING_FAILURE_CODES[
          code as keyof typeof FLEET_ROUTING_FAILURE_CODES
        ].claimsExclusion,
    );
    expect(claiming).toEqual(['no-eligible-candidates']);
  });
});
