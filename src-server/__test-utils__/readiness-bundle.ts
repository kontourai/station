export const PINNED_CONFIG = {
  schema_version: '0.1',
  trusted_producers: {
    'governance.merge-readiness': { producers: ['veritas'] },
  },
  gate_overrides: {},
};

/** Single readiness-gated step, same shape as station-delivery's last step. */
export const READINESS_DEFINITION = {
  id: 'pinned-readiness',
  version: '1',
  steps: [{ id: 'readiness', next: null }],
  gates: {
    'readiness-gate': {
      step: 'readiness',
      expects: [
        {
          id: 'merge-readiness',
          kind: 'trust.bundle',
          required: true,
          description: 'Veritas merge readiness for the working tree.',
          bundle_claim: {
            claimType: 'governance.merge-readiness',
            accepted_statuses: ['verified'],
          },
        },
      ],
      on_route_back: {
        missing_evidence: 'readiness',
        default: 'readiness',
      },
      route_back_policy: { max_attempts: 2, on_exceeded: 'block' },
    },
  },
};

export function readinessBundle(
  producerId: string,
  authorityRef = 'authority:readiness',
) {
  const now = '2026-08-25T00:00:00.000Z';
  return {
    schemaVersion: 7,
    source: 'fixture',
    producerId,
    claims: [
      {
        id: 'claim.readiness',
        subjectType: 'change',
        subjectId: 'r1',
        facet: 'governance',
        claimType: 'governance.merge-readiness',
        fieldOrBehavior: 'readiness',
        value: 'pass',
        createdAt: now,
        updatedAt: now,
        currentIntegrityRef: 'commit:fixture',
        verificationPolicyId: 'policy.readiness',
      },
    ],
    evidence: [
      {
        id: 'evidence.readiness',
        claimId: 'claim.readiness',
        evidenceType: 'test_output',
        method: 'validation',
        sourceRef: 'fixture:readiness',
        excerptOrSummary: 'Readiness checks passed for the fixture commit.',
        observedAt: now,
        collectedBy: producerId,
        integrityRef: 'commit:fixture',
        supportStrength: 'entails',
        passing: true,
      },
    ],
    policies: [
      {
        id: 'policy.readiness',
        claimType: 'governance.merge-readiness',
        requiredEvidence: ['test_output'],
        requiredMethods: ['validation'],
        requiresCorroboration: false,
        acceptanceCriteria: ['readiness checks pass for this commit'],
        reviewAuthority: 'veritas',
        validityRule: { kind: 'commit' },
        stalenessTriggers: ['commit changes'],
        conflictRules: [],
        impactLevel: 'high',
      },
    ],
    events: [
      {
        id: 'event.readiness',
        claimId: 'claim.readiness',
        status: 'verified',
        actor: 'veritas',
        method: 'review',
        evidenceIds: ['evidence.readiness'],
        createdAt: now,
        verifiedAt: now,
      },
    ],
    authorityTrace: [
      {
        id: 'trace.readiness',
        subject: { subjectType: 'change', subjectId: 'r1' },
        actorRef: 'veritas',
        authorityType: 'system',
        authorityRef,
        sourceRef: 'policy:readiness',
        observedAt: now,
        claimIds: ['claim.readiness'],
      },
    ],
  };
}
