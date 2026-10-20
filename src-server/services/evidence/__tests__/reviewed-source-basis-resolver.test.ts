import { parseReviewedWebSourceDescriptor } from '@kontourai/fieldwork/reviewed-web-source-contract';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { projectReviewedExtractionEvidence } from '@kontourai/surface';
import { afterEach, describe, expect, test, vi } from 'vitest';

const owner = vi.hoisted(() => ({
  currentness: undefined as unknown,
  artifactAvailable: true,
  artifactCurrent: true,
  retireOnCurrentness: false,
  acquisitions: 0,
  descriptor: undefined as unknown,
  descriptorResult: undefined as unknown,
}));

vi.mock('../../plugins/plugin-public-server.js', () => ({
  readPluginPublicManifest: async () => ({ serverModule: 'owner.mjs' }),
  acquirePluginReviewedSourcesModule: async () => {
    owner.acquisitions += 1;
    return {
      read: async (input: { operation: 'describe' | 'currentness' }) => {
        if (input.operation === 'currentness' && owner.retireOnCurrentness)
          owner.artifactCurrent = false;
        return input.operation === 'describe'
          ? (owner.descriptorResult ?? {
              status: 'available',
              payload: owner.descriptor,
            })
          : { status: 'available', payload: owner.currentness };
      },
      release: () => undefined,
    };
  },
}));
vi.mock('../../plugins/plugin-permissions.js', () => ({
  readPluginGrantState: () => ({ granted: ['plugin.server'] }),
}));

vi.mock('../../plugins/plugin-runtime-artifact.js', () => ({
  capturePluginRuntimeArtifact: () =>
    owner.artifactAvailable
      ? {
          manifest: { serverModule: 'owner.mjs' },
          isCurrent: () => owner.artifactCurrent,
        }
      : null,
}));

import { composeAuthorizedSessionAnswerBasis } from '../../projects/task-basis-module.js';
import { ReviewedSourceBasisResolver } from '../reviewed-source-basis-resolver.js';
import { reviewedSourceSessionInventoryRow } from '../reviewed-source-session-inventory-adapter.js';

const exactRef = `fieldwork-reviewed-source:v1:${'a'.repeat(64)}`;
const sourceEvidence = projectReviewedExtractionEvidence({
  evidenceId: 'source-evidence',
  claimId: 'source-claim',
  proposalIndex: 0,
  collectedBy: 'station-test',
  structuralTrust: 'validated',
  importRecord: {
    apiVersion: 'survey.kontourai.io/v1alpha1',
    kind: 'ExtractionEnvelopeImport',
    metadata: { name: 'import-a', producerNamespace: 'fieldwork' },
    spec: {
      sourceKind: 'web',
      claimTargets: [],
      envelope: {
        format: 'traverse-extraction-result',
        version: 1,
        source: { ref: 'https://example.test', snapshotRef: 'snapshot-a' },
        result: {
          proposals: [
            {
              fieldPath: 'record.status',
              candidateValue: 'active',
              confidence: 1,
              extractor: 'test',
              provenance: {
                excerpt: 'active',
                locator: 'chars:0-6',
                occurrence: {
                  resolverVersion: 'exact-occurrence-v1',
                  count: 1,
                  selected: { index: 0, start: 0, end: 6 },
                  selection: 'source-order',
                  hintUsed: false,
                  ambiguous: false,
                },
              },
            },
          ],
          provider: 'test',
          runId: 'run-a',
          raw: {},
          outcome: { status: 'ok' },
          extractedAt: '2026-08-26T00:00:00.000Z',
          providerCalls: 1,
          totalTokensUsed: 1,
        },
      },
    },
    status: { state: 'grounded', diagnostics: [] },
  },
  reviewItem: {
    apiVersion: 'survey.kontourai.io/v1alpha1',
    kind: 'ReviewItem',
    metadata: { name: 'item-a' },
    spec: {
      target: 'record.status',
      editable: false,
      candidates: [
        {
          id: 'candidate-a',
          value: 'active',
          confidence: 1,
          source: {
            sourceRef: 'https://example.test',
            sourceId: 'snapshot-a',
            observedAt: '2026-08-26T00:00:00.000Z',
          },
          locator: { scheme: 'exact', locator: 'chars:0-6', excerpt: 'active' },
          extraction: { target: 'record.status', extractor: 'test' },
          claimTarget: {},
        },
      ],
    },
  },
  reviewDecision: {
    apiVersion: 'survey.kontourai.io/v1alpha1',
    kind: 'ReviewDecision',
    metadata: { name: 'decision-a' },
    spec: {
      reviewItemName: 'item-a',
      candidateId: 'candidate-a',
      status: 'verified',
      resolution: 'accepted',
      actor: { id: 'reviewer-a' },
      reviewedAt: '2026-08-26T00:00:00.000Z',
    },
  },
}).evidence;

const descriptor = {
  apiVersion: 'fieldwork.kontourai.io/v1',
  kind: 'ReviewedWebSourceDescriptor',
  status: 'available',
  exactRef,
  runResource: 'run-a',
  captureRef: 'snapshot-a',
  preparedArtifact: {
    ref: 'prepared-a',
    digest: 'a'.repeat(64),
    contentLength: 6,
  },
  review: { revision: 1, state: 'reviewed' },
  evidence: {
    id: 'source-evidence',
    claimId: 'source-claim',
    proposalIndex: 0,
    import: { name: 'import-a' },
    candidate: { id: 'candidate-a' },
    reviewItem: { name: 'item-a' },
    reviewDecision: { name: 'decision-a' },
    locator: {
      scheme: 'traverse-exact-occurrence-v1',
      locator: 'chars:0-6',
      occurrence: { index: 0, count: 1, start: 0, end: 6 },
    },
  },
  integrity: { state: 'unchecked' },
  inspection: { pageChars: 16_384, maxPages: 8 },
};
owner.descriptor = descriptor;
afterEach(() => {
  owner.descriptor = descriptor;
  owner.descriptorResult = undefined;
  owner.artifactAvailable = true;
  owner.artifactCurrent = true;
  owner.retireOnCurrentness = false;
  owner.acquisitions = 0;
});

const answer = {
  status: 'found' as const,
  projectSlug: 'project-a',
  binding: {
    version: 'station-answer-binding/v1' as const,
    sessionId: 'session-a',
    turnId: 'turn-a',
    answer: {
      authority: '@kontourai/thread' as const,
      schemaVersion: '1.2.0',
      kind: 'assistant-message' as const,
      standing: 'observed' as const,
      threadId: 'session-a',
      messageId: 'message-a',
    },
  },
};
const authority = sessionReadAuthorityFromRequest(
  'owner',
  undefined,
  undefined,
);
const facts = {
  revision: 1,
  artifactSha: 'b'.repeat(64),
  association: {
    version: 'station.reviewed-source-association/v1' as const,
    pluginName: 'fieldwork-review',
    sourceClaimId: 'source-claim',
    sourceEvidenceId: 'source-evidence',
    answerClaimId: 'answer-claim',
    answerCitationEvidenceId: 'citation-a',
    owner: '@kontourai/fieldwork',
    runId: 'run-a',
    exactRef,
    assessmentRevision: 1,
    projectId: 'project-a',
    workspaceId: 'workspace-a',
    principalId: 'personal:owner',
  },
  assessment: {
    version: 'surface.answer-assessment/v2',
    found: true,
    ref: { bundleId: 'bundle-a', claimId: 'answer-claim' },
    claim: { id: 'answer-claim' },
    derivation: {
      directInputs: [{ claimId: 'source-claim', status: 'verified' }],
    },
    evidence: {
      cited: [
        {
          id: 'citation-a',
          result: 'passed',
          blocksClaim: false,
          supportStrength: 'cited',
          sourceRef: sourceEvidence.sourceRef,
          locator: sourceEvidence.sourceLocator ?? null,
        },
      ],
    },
  },
  evidence: sourceEvidence,
  current: () => true,
};

const captured = {
  assessment: {
    owner: { authority: '@kontourai/surface' as const },
    state: 'available' as const,
    observedAt: '2026-08-26T00:00:00.000Z',
    value: facts.assessment,
  },
  reviewedSource: facts,
};

describe.sequential('ReviewedSourceBasisResolver currentness table', () => {
  test.each([
    ['restricted', 'restricted'],
    ['missing', 'corrupt'],
    ['corrupt', 'corrupt'],
    ['unsupported', 'unsupported-version'],
  ])('maps a closed descriptor %s to %s', async (status, state) => {
    owner.descriptor = {
      apiVersion: 'fieldwork.kontourai.io/v1',
      kind: 'ReviewedWebSourceDescriptor',
      status,
    };
    expect(parseReviewedWebSourceDescriptor(owner.descriptor)).toMatchObject({
      status,
    });
    owner.descriptorResult = { status };
    const resolver = new ReviewedSourceBasisResolver({
      projectHomeDir: '/tmp/station-review-source-table',
      logger: {} as never,
    });
    const read = await resolver.read({
      answer: answer as never,
      assessment: captured as never,
      authority,
      current: () => true,
    });
    expect(read).toMatchObject({ state });
    expect(read).not.toHaveProperty('value');
  });

  test.each([
    ['current', 'a'.repeat(64)],
    ['drifted', 'b'.repeat(64)],
  ])(
    'preserves the canonical %s comparison',
    async (expected, observedDigest) => {
      owner.currentness = {
        apiVersion: 'fieldwork.kontourai.io/v1',
        kind: 'ReviewedWebSourceCurrentness',
        status: 'available',
        exactRef,
        evidenceId: 'source-evidence',
        reviewRevision: 1,
        checkedAt: '2026-08-26T01:00:00.000Z',
        observationRef: 'observation-a',
        scope: 'local-owner-heads-as-of',
        captureIntegrity: 'not-rechecked',
        sourceObservation: {
          version: 'surface.reviewed-source-observation/v1',
          owner: {
            authority: 'fieldwork-source-check-receipt/v2',
            observationRef: 'observation-a',
          },
          expected: {
            snapshotRef: 'snapshot-a',
            sourceId: 'source-a',
            resourceRef: 'https://example.test',
            capturedAt: '2026-08-26T00:00:00.000Z',
            envelopeDigest: { algorithm: 'sha256', value: 'c'.repeat(64) },
            contentDigest: { algorithm: 'sha256', value: 'a'.repeat(64) },
          },
          observed: {
            snapshotRef: expected === 'current' ? 'snapshot-a' : 'snapshot-b',
            sourceId: 'source-a',
            resourceRef: 'https://example.test',
            capturedAt:
              expected === 'current'
                ? '2026-08-26T00:00:00.000Z'
                : '2026-08-26T01:00:00.000Z',
            envelopeDigest: {
              algorithm: 'sha256',
              value: expected === 'current' ? 'c'.repeat(64) : 'd'.repeat(64),
            },
            contentDigest: { algorithm: 'sha256', value: observedDigest },
          },
        },
      };
      const resolver = new ReviewedSourceBasisResolver({
        projectHomeDir: '/tmp/station-review-source-table',
        logger: {} as never,
      });
      const read = await resolver.read({
        answer: answer as never,
        assessment: captured as never,
        authority,
        current: () => true,
      });
      expect(read).toMatchObject({
        state: 'available',
        value: [{ context: { currentness: expected } }],
      });
    },
  );

  test.each([
    'no-check',
    'check-pending',
    'check-failed',
    'legacy-receipt',
    'missing-digest',
    'head-changed',
    'receipt-superseded',
    'incompatible-source',
    'limits-exceeded',
    'storage-unavailable',
    'corrupt',
    'unavailable',
  ])(
    'makes %s a Surface unknown contribution without owner identifiers',
    async (status) => {
      owner.currentness = {
        apiVersion: 'fieldwork.kontourai.io/v1',
        kind: 'ReviewedWebSourceCurrentness',
        status,
      };
      const resolver = new ReviewedSourceBasisResolver({
        projectHomeDir: '/tmp/station-review-source-table',
        logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
      });
      const read = await resolver.read({
        answer: answer as never,
        assessment: captured as never,
        authority,
        current: () => true,
      });
      expect(read).toMatchObject({
        state: 'available',
        value: [
          {
            context: { currentness: 'unknown' },
            gaps: [{ code: 'reviewed-source-capture-comparison-unavailable' }],
          },
        ],
      });
      expect(JSON.stringify(read)).not.toContain('run-a');
    },
  );

  test('keeps a restricted currentness read descriptor-only', async () => {
    owner.currentness = {
      apiVersion: 'fieldwork.kontourai.io/v1',
      kind: 'ReviewedWebSourceCurrentness',
      status: 'restricted',
    };
    const resolver = new ReviewedSourceBasisResolver({
      projectHomeDir: '/tmp/station-review-source-table',
      logger: {} as never,
    });
    await expect(
      resolver.read({
        answer: answer as never,
        assessment: captured as never,
        authority,
        current: () => true,
      }),
    ).resolves.toMatchObject({ state: 'restricted' });
  });
});

test('does not acquire an owner module when its installation is unavailable', async () => {
  owner.artifactAvailable = false;
  const resolver = new ReviewedSourceBasisResolver({
    projectHomeDir: '/tmp/station-review-source-table',
    logger: {} as never,
  });
  const result = await resolver.read({
    answer: answer as never,
    assessment: captured as never,
    authority,
    current: () => true,
  });
  expect(result).toMatchObject({ state: 'unavailable' });
  expect(owner.acquisitions).toBe(0);
});

test('withholds the final reviewed-source contribution if its captured installation retires during the owner read', async () => {
  owner.currentness = {
    apiVersion: 'fieldwork.kontourai.io/v1',
    kind: 'ReviewedWebSourceCurrentness',
    status: 'unavailable',
  };
  owner.retireOnCurrentness = true;
  const resolver = new ReviewedSourceBasisResolver({
    projectHomeDir: '/tmp/station-review-source-table',
    logger: {} as never,
  });
  const result = await resolver.read({
    answer: answer as never,
    assessment: captured as never,
    authority,
    current: () => true,
  });
  expect(result).toMatchObject({ state: 'restricted' });
  expect(result).not.toHaveProperty('value');
  expect(owner.acquisitions).toBe(1);
});

describe.sequential('Fieldwork owner review state (#2949)', () => {
  const unknownCurrentness = {
    apiVersion: 'fieldwork.kontourai.io/v1',
    kind: 'ReviewedWebSourceCurrentness',
    status: 'no-check',
  };
  const basisAnswer = {
    ...answer,
    sessionId: 'session-a',
    turnId: 'turn-a',
    observedAt: '2026-08-26T00:00:00.000Z',
    inputs: [],
    results: [],
  };

  async function resolve(state: string) {
    owner.descriptor = { ...descriptor, review: { revision: 1, state } };
    owner.currentness = unknownCurrentness;
    return new ReviewedSourceBasisResolver({
      projectHomeDir: '/tmp/station-review-source-table',
      logger: {} as never,
    }).read({
      answer: basisAnswer as never,
      assessment: captured as never,
      authority,
      current: () => true,
    });
  }

  function sourceItem(projection: unknown) {
    const { regions } = projection as {
      regions: { sources: readonly unknown[] };
    };
    expect(regions.sources).toHaveLength(1);
    return regions.sources[0];
  }

  test('counts an owner-reviewed source with an accepted decision as accepted', async () => {
    const read = await resolve('reviewed');
    expect(read).toMatchObject({
      state: 'available',
      value: [{ context: { review: 'accepted' } }],
    });
    const gaps = read?.state === 'available' ? read.value[0]?.gaps : undefined;
    expect((gaps ?? []).map((gap) => gap.code)).not.toContain(
      'reviewed-source-review-not-accepted',
    );
  });

  test('never presents a grounding-refused source as accepted support, even with an accepted decision', async () => {
    // The fixture's Survey decision is verified/accepted, so Surface alone
    // would derive `accepted`; only Fieldwork's review.state says otherwise.
    expect(
      parseReviewedWebSourceDescriptor({
        ...descriptor,
        review: { revision: 1, state: 'grounding-refused' },
      }),
    ).toMatchObject({ review: { state: 'grounding-refused' } });
    const read = await resolve('grounding-refused');
    expect(read).toMatchObject({
      state: 'available',
      value: [
        {
          role: 'source',
          context: { review: 'not-accepted', reviewedAt: null },
          gaps: expect.arrayContaining([
            expect.objectContaining({
              code: 'reviewed-source-review-not-accepted',
            }),
          ]),
        },
      ],
    });

    // The Basis the product publishes (Surface re-parses every Fieldwork
    // item) keeps the source visible as a not-accepted gap. The fixture's
    // assessment is a partial shape, so compose with a not-captured one.
    const projection = composeAuthorizedSessionAnswerBasis(
      basisAnswer as never,
      undefined,
      undefined,
      read,
    );
    expect(sourceItem(projection)).toMatchObject({
      context: { review: 'not-accepted' },
      gaps: expect.arrayContaining([
        expect.objectContaining({
          code: 'reviewed-source-review-not-accepted',
        }),
      ]),
    });
    expect(
      reviewedSourceSessionInventoryRow({
        sessionId: 'session-a',
        turnId: 'turn-a',
        answerReferenceId: 'message-a',
        contribution: read,
        basis: projection as never,
      }),
    ).toMatchObject({
      reviewedSource: { review: 'not-accepted' },
      contributionGaps: expect.arrayContaining([
        'reviewed-source-review-not-accepted',
      ]),
    });
  });

  test('fails closed on a review state the pinned contract does not define', async () => {
    const read = await resolve('superseded');
    expect(read).toMatchObject({ state: 'corrupt' });
    expect(read).not.toHaveProperty('value');
  });
});
