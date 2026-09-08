/**
 * Resolves one assessment-bound Fieldwork source through its owner plugin.
 *
 * Station retains the association but neither opens Fieldwork storage nor
 * interprets owner payloads.  Surface receives only its public, authenticated
 * source-state input and constructs the user-facing contribution.
 */
import { join } from 'node:path';
import {
  parseReviewedWebSourceCurrentness,
  parseReviewedWebSourceDescriptor,
} from '@kontourai/fieldwork/reviewed-web-source-contract';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import {
  buildReviewedExtractionSourceState,
  buildUnknownReviewedExtractionSourceState,
} from '@kontourai/surface';
import type {
  BasisContributionV2,
  ContributionReadV2,
  FieldworkReviewedSourceRef,
} from '@kontourai/surface/basis';
import { buildReviewedSourceBasisContribution } from '@kontourai/surface/basis';
import { acquirePluginReviewedSourcesModule } from '../../routes/plugins/plugin-public-server.js';
import type { Logger } from '../../utils/logger.js';
import type { SessionAnswerBasisQueryOutcome } from '../orchestration/session-query-module.js';
import type { PackageMcpAdmissionJournal } from '../plugins/package-mcp-admission.js';
import { readPluginGrantState } from '../plugins/plugin-permissions.js';
import {
  capturePluginRuntimeArtifact,
  type PluginRuntimeArtifact,
} from '../plugins/plugin-runtime-artifact.js';
import {
  type ExactAnswerAssessmentRead,
  type ReviewedSourceBasisFacts,
} from './answer-assessment-module.js';

type FoundAnswer = Extract<SessionAnswerBasisQueryOutcome, { status: 'found' }>;
type FieldworkRead = Extract<
  ContributionReadV2,
  { owner: { authority: '@kontourai/fieldwork' } }
>;

const FIELDWORK_OWNER = '@kontourai/fieldwork';

/**
 * One read is intentionally uncached. Currentness is an owner-head as-of
 * observation; caching it would need a separate owner invalidation protocol.
 */
export class ReviewedSourceBasisResolver {
  constructor(
    private readonly input: {
      projectHomeDir: string;
      logger: Logger;
      packageMcpJournal?: PackageMcpAdmissionJournal;
    },
  ) {}

  async read(input: {
    answer: FoundAnswer;
    assessment: ExactAnswerAssessmentRead | undefined;
    authority: SessionReadAuthority;
    current: () => boolean;
  }): Promise<FieldworkRead | undefined> {
    if (!input.current() || input.authority.mode === 'hosted') return undefined;
    const facts = input.assessment?.reviewedSource;
    if (!input.current() || !facts || !factsCurrent(input.current, facts))
      return undefined;
    // A Task-local legacy assessment remains a complete independent owner
    // result. Never splice a producer source association into that reader.
    if (
      !matchesAssessment(input.answer, input.authority, input.assessment, facts)
    )
      return undefined;
    if (facts.association.owner !== FIELDWORK_OWNER) return owner('corrupt');

    let artifact: PluginRuntimeArtifact | null;
    try {
      artifact = capturePluginRuntimeArtifact(
        join(this.input.projectHomeDir, 'plugins'),
        facts.association.pluginName,
        this.input.packageMcpJournal,
      );
    } catch {
      return owner('corrupt');
    }
    if (!input.current() || !factsCurrent(input.current, facts))
      return undefined;
    if (!artifact?.manifest.serverModule) return owner('unavailable');
    const manifest = artifact.manifest;
    const authorized = () =>
      !!artifact?.isCurrent() &&
      readPluginGrantState(
        this.input.projectHomeDir,
        facts.association.pluginName,
        artifact,
      ).granted.includes('plugin.server');
    try {
      if (!authorized()) return owner('restricted');
    } catch {
      return owner('unavailable');
    }

    let lease: Awaited<ReturnType<typeof acquirePluginReviewedSourcesModule>>;
    try {
      lease = await acquirePluginReviewedSourcesModule({
        pluginsDir: join(this.input.projectHomeDir, 'plugins'),
        pluginName: facts.association.pluginName,
        manifest,
        logger: this.input.logger,
        projectHomeDir: this.input.projectHomeDir,
        journal: this.input.packageMcpJournal,
        artifact,
        authorize: authorized,
      });
    } catch {
      return owner('unavailable');
    }
    if (!input.current() || !factsCurrent(input.current, facts)) {
      lease?.release();
      return undefined;
    }
    if (!lease) return owner('unavailable');
    try {
      const invocation = invocationFor(facts);
      const described = await lease.read({
        ...invocation,
        operation: 'describe',
      });
      if (!input.current() || !factsCurrent(input.current, facts))
        return undefined;
      if (described.status !== 'available') return owner(described.status);
      let descriptor: ReturnType<typeof parseReviewedWebSourceDescriptor>;
      try {
        descriptor = parseReviewedWebSourceDescriptor(described.payload);
      } catch {
        return owner('corrupt');
      }
      if (!matchesDescriptor(descriptor, facts)) return owner('corrupt');

      const currentness = await lease.read({
        ...invocation,
        operation: 'currentness',
      });
      if (!input.current() || !factsCurrent(input.current, facts))
        return undefined;
      if (currentness.status !== 'available') return owner(currentness.status);
      let current: ReturnType<typeof parseReviewedWebSourceCurrentness>;
      try {
        current = parseReviewedWebSourceCurrentness(currentness.payload);
      } catch {
        return owner('corrupt');
      }
      // Authorization is deliberately descriptor-only: no evidence, run, or
      // exact-ref-bearing contribution can survive a closed owner denial.
      if (current.status === 'restricted') return owner('restricted');
      // A disappeared exact ref is not a currentness comparison.  Preserve the
      // owner's closed result instead of fabricating an unknown contribution.
      if (current.status === 'missing') return owner('missing');
      if (current.status === 'unsupported') return owner('unsupported');
      if (!matchesCurrentness(current, facts, descriptor))
        return owner('corrupt');
      let sourceState: Awaited<
        ReturnType<typeof buildUnknownReviewedExtractionSourceState>
      >;
      try {
        sourceState =
          current.status === 'available'
            ? buildReviewedExtractionSourceState(
                facts.evidence,
                current.sourceObservation as never,
                current.checkedAt,
              )
            : await buildUnknownReviewedExtractionSourceState(
                facts.evidence,
                new Date().toISOString(),
              );
      } catch {
        return owner('corrupt');
      }
      if (!input.current() || !factsCurrent(input.current, facts))
        return undefined;
      try {
        const contribution = await buildReviewedSourceBasisContribution({
          answer: input.answer.binding.answer,
          ref: {
            authority: FIELDWORK_OWNER,
            schemaVersion: 'fieldwork.kontourai.io/v1',
            kind: 'reviewed-web-source',
            exactRef: facts.association.exactRef,
            evidenceId: facts.association.sourceEvidenceId,
          },
          evidence: facts.evidence,
          sourceState,
          association: {
            version: 'surface.reviewed-source-basis-association/v1',
            sourceClaimId: facts.association.sourceClaimId,
            sourceEvidenceId: facts.association.sourceEvidenceId,
            answerClaimId: facts.association.answerClaimId,
            answerCitationEvidenceId:
              facts.association.answerCitationEvidenceId,
            assessmentRevision: facts.revision,
          },
          assessment: { revision: facts.revision, value: facts.assessment },
        });
        if (!input.current() || !factsCurrent(input.current, facts))
          return undefined;
        if (!authorized()) return owner('restricted');
        return available([contribution]);
      } catch {
        return owner('corrupt');
      }
    } finally {
      // release is synchronous so the final publication fence has no await.
      lease.release();
    }
  }
}

function invocationFor(facts: ReviewedSourceBasisFacts) {
  return {
    version: 'station.reviewed-sources/v1' as const,
    pluginName: facts.association.pluginName,
    projectId: facts.association.projectId,
    exactRef: facts.association.exactRef,
    assessment: {
      revision: facts.revision,
      sourceClaimId: facts.association.sourceClaimId,
      sourceEvidenceId: facts.association.sourceEvidenceId,
      answerClaimId: facts.association.answerClaimId,
      answerCitationEvidenceId: facts.association.answerCitationEvidenceId,
    },
  };
}

function matchesAssessment(
  answer: FoundAnswer,
  authority: SessionReadAuthority,
  captured: ExactAnswerAssessmentRead | undefined,
  facts: ReviewedSourceBasisFacts,
): boolean {
  const assessment = captured?.assessment;
  const association = facts.association;
  return (
    assessment?.state === 'available' &&
    captured?.reviewedSource === facts &&
    facts.revision === association.assessmentRevision &&
    facts.artifactSha.length === 64 &&
    assessment.value.version === 'surface.answer-assessment/v2' &&
    assessment.value.ref.bundleId === facts.assessment.ref.bundleId &&
    assessment.value.ref.claimId === association.answerClaimId &&
    assessment.value.claim?.id === association.answerClaimId &&
    facts.evidence.id === association.sourceEvidenceId &&
    facts.evidence.claimId === association.sourceClaimId &&
    association.answerCitationEvidenceId ===
      facts.assessment.evidence.cited.find(
        (item) => item.id === association.answerCitationEvidenceId,
      )?.id &&
    association.owner === FIELDWORK_OWNER &&
    association.pluginName.length > 0 &&
    association.runId.length > 0 &&
    association.exactRef.length > 0 &&
    association.projectId === answer.projectSlug &&
    association.workspaceId.length > 0 &&
    association.principalId === `${authority.mode}:${authority.userId}`
  );
}

function factsCurrent(
  current: () => boolean,
  facts: ReviewedSourceBasisFacts,
): boolean {
  return current() && facts.current();
}

function matchesDescriptor(
  value: ReturnType<typeof parseReviewedWebSourceDescriptor>,
  facts: ReviewedSourceBasisFacts,
): boolean {
  return (
    value.status === 'available' &&
    value.exactRef === facts.association.exactRef &&
    value.evidence.id === facts.association.sourceEvidenceId &&
    value.evidence.claimId === facts.association.sourceClaimId
  );
}

function matchesCurrentness(
  value: ReturnType<typeof parseReviewedWebSourceCurrentness>,
  facts: ReviewedSourceBasisFacts,
  descriptor: ReturnType<typeof parseReviewedWebSourceDescriptor>,
): boolean {
  // Every remaining Fieldwork 0.10 closed currentness arm is a coherent
  // no-comparison fact. Surface alone derives the unknown contribution/gap.
  if (value.status !== 'available') return true;
  return (
    descriptor.status === 'available' &&
    value.exactRef === facts.association.exactRef &&
    value.evidenceId === facts.association.sourceEvidenceId &&
    value.reviewRevision === descriptor.review.revision
  );
}

function available(
  value: readonly BasisContributionV2<FieldworkReviewedSourceRef>[],
): FieldworkRead {
  return {
    owner: { authority: FIELDWORK_OWNER },
    state: 'available',
    observedAt: new Date().toISOString(),
    value,
  } as FieldworkRead;
}

function owner(status: string): FieldworkRead {
  const state =
    status === 'restricted'
      ? 'restricted'
      : status === 'corrupt' || status === 'missing'
        ? 'corrupt'
        : status === 'unsupported'
          ? 'unsupported-version'
          : 'unavailable';
  return {
    owner: { authority: FIELDWORK_OWNER },
    state,
    observedAt: new Date().toISOString(),
  } as FieldworkRead;
}
