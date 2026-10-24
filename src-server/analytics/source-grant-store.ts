import { createHash, randomBytes } from 'node:crypto';
import type {
  AnalyticsRecipientCandidate,
  AnalyticsSourceApproval,
  AnalyticsSourceEnrollmentIntent,
} from '@kontourai/station-contracts/usage-export';
import { z } from 'zod/v3';
import { AuthorityObservationRejected } from '../services/identity/authority-observation.js';
import { AnalyticsPrivateFile } from './private-analytics-file.js';
import {
  analyticsIntentDigest,
  recipientCandidateSchema,
  verifyRecipientCandidateSignature,
} from './recipient-candidate.js';
import {
  sealSourceCredential,
  sourceCredentialDeliverySchema,
  sourceCredentialHash,
} from './source-credential.js';
import {
  enrollmentIdentity,
  enrollmentIntentSchema,
  enrollmentOperationId,
  enrollmentOwnerSchema,
} from './source-enrollment-protocol.js';
import type { EnrollmentActor } from './source-enrollment-store.js';
import { UsageExportRejected } from './usage-export-reader.js';

export interface SourceApprovalActor extends EnrollmentActor {
  approvalCredentialId: string;
  approvalBindingSha256: string;
  assertApprovalCurrent(approvedAt: string): Promise<void>;
}
export const sourceApprovalInput = z
  .object({
    operationId: enrollmentOperationId,
    sourceOperationId: enrollmentOperationId,
    recipientCandidate: recipientCandidateSchema,
  })
  .strict();
type Input = z.infer<typeof sourceApprovalInput>;
const approvalSchema = z
  .object({
    protocol: z.literal('station-analytics-source-approval/v1'),
    operationId: enrollmentOperationId,
    sourceOperationId: enrollmentOperationId,
    sourceStationId: enrollmentIdentity,
    destinationStationId: enrollmentIdentity,
    recipientId: enrollmentOperationId,
    recipientPrincipalId: enrollmentIdentity,
    scope: z.enum(['individual', 'personal-account']),
    expiresAt: z.string().datetime(),
    retention: enrollmentIntentSchema.shape.retention,
    phase: z.enum(['approved', 'revoked']),
    approvedAt: z.string().datetime(),
    approvalTransactionId: enrollmentOperationId,
    sourceApproved: z.literal(true),
    exportAuthority: z.literal(false),
    recipientAssurance: z.literal('source-user-approved-key'),
  })
  .strict();
const recordSchema = z
  .object({
    view: approvalSchema,
    owner: enrollmentOwnerSchema,
    approvalCredentialId: enrollmentIdentity,
    approvalBindingSha256: z.string().regex(/^[a-f0-9]{64}$/),
    targetSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceIntent: enrollmentIntentSchema,
    candidate: recipientCandidateSchema,
    delivery: z
      .object({
        view: sourceCredentialDeliverySchema,
        credentialSha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict();
const fileSchema = z
  .object({
    version: z.literal(1),
    sourceStationId: enrollmentIdentity,
    approvals: z.array(recordSchema).max(1000),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.approvals.map((item) => item.view.operationId)).size ===
        value.approvals.length &&
      value.approvals.every(
        (item) =>
          item.view.sourceStationId === value.sourceStationId &&
          item.sourceIntent.sourceStationId === value.sourceStationId,
      ),
  );
type File = z.infer<typeof fileSchema>;
export class SourceApprovalRejected extends Error {
  constructor(
    readonly code:
      | 'source_approval_invalid'
      | 'source_approval_conflict'
      | 'source_approval_not_found'
      | 'source_approval_unavailable',
    readonly status: 400 | 404 | 409 | 503,
  ) {
    super(code);
  }
}
function owner(actor: EnrollmentActor) {
  return enrollmentOwnerSchema.parse({
    userId: actor.userId,
    mode: actor.mode,
    tenantId: actor.tenantId,
    ownerIds: actor.ownerIds,
  });
}
/** Validates binding/freshness without promoting a self-signed candidate to remote identity. */
export function sourceApprovalTarget(
  actor: SourceApprovalActor,
  intent: AnalyticsSourceEnrollmentIntent,
  input: Input,
  now: number,
) {
  let candidate: AnalyticsRecipientCandidate;
  try {
    candidate = verifyRecipientCandidateSignature(input.recipientCandidate);
  } catch {
    throw new SourceApprovalRejected('source_approval_invalid', 400);
  }
  const claims = candidate.claims;
  if (
    intent.phase !== 'prepared' ||
    Date.parse(intent.expiresAt) <= now ||
    intent.operationId !== input.sourceOperationId ||
    intent.sourceStationId !== actor.sourceStationId ||
    claims.sourceOperationId !== intent.operationId ||
    claims.sourceStationId !== actor.sourceStationId ||
    claims.sourceIntentSha256 !== analyticsIntentDigest(intent) ||
    claims.destinationStationId !== intent.proposedDestination.stationId ||
    claims.proposedDestinationOrigin !== intent.proposedDestination.origin ||
    claims.recipientPrincipalId !== actor.userId ||
    claims.createdAt > now + 30_000 ||
    claims.expiresAt <= now
  )
    throw new SourceApprovalRejected('source_approval_conflict', 409);
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.operationId,
        owner(actor),
        actor.approvalCredentialId,
        actor.approvalBindingSha256,
        intent,
        candidate,
      ]),
    )
    .digest('hex');
}

/** Durable approval only; source credentials and export admission are separate owners. */
export class SourceGrantApprovalStore {
  private readonly file: AnalyticsPrivateFile<File>;
  constructor(
    home: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = new AnalyticsPrivateFile(
      home,
      'analytics-source-approvals.json',
      fileSchema,
      4 * 1024 * 1024,
    );
  }
  private initial(sourceStationId: string): File {
    return { version: 1, sourceStationId, approvals: [] };
  }
  private checked(file: File, actor: EnrollmentActor) {
    if (file.sourceStationId !== actor.sourceStationId)
      throw new SourceApprovalRejected('source_approval_unavailable', 503);
    try {
      for (const record of file.approvals.filter((item) =>
        this.owned(actor, item),
      )) {
        const candidate = verifyRecipientCandidateSignature(record.candidate);
        const view = record.view,
          intent = record.sourceIntent,
          claims = candidate.claims;
        const delivery = record.delivery?.view;
        if (
          delivery &&
          (delivery.sourceApprovalId !== view.operationId ||
            delivery.sourceOperationId !== view.sourceOperationId ||
            delivery.sourceStationId !== view.sourceStationId ||
            delivery.destinationStationId !== view.destinationStationId ||
            delivery.recipientId !== view.recipientId ||
            delivery.expiresAt !== view.expiresAt)
        )
          throw new Error('Delivery binding changed');
        const fingerprint = createHash('sha256')
          .update(
            JSON.stringify([
              view.operationId,
              record.owner,
              record.approvalCredentialId,
              record.approvalBindingSha256,
              intent,
              candidate,
            ]),
          )
          .digest('hex');
        if (
          fingerprint !== record.targetSha256 ||
          view.sourceOperationId !== intent.operationId ||
          view.scope !== intent.scope ||
          view.expiresAt !== intent.expiresAt ||
          JSON.stringify(view.retention) !== JSON.stringify(intent.retention) ||
          view.destinationStationId !== intent.proposedDestination.stationId ||
          view.recipientId !== claims.recipientId ||
          view.recipientPrincipalId !== claims.recipientPrincipalId ||
          claims.recipientPrincipalId !== record.owner.userId ||
          claims.sourceStationId !== file.sourceStationId ||
          claims.sourceOperationId !== intent.operationId ||
          claims.sourceIntentSha256 !== analyticsIntentDigest(intent) ||
          claims.destinationStationId !==
            intent.proposedDestination.stationId ||
          claims.proposedDestinationOrigin !==
            intent.proposedDestination.origin ||
          Date.parse(view.approvedAt) >= claims.expiresAt ||
          Date.parse(view.approvedAt) + 30_000 < claims.createdAt
        )
          throw new Error('Approval binding changed');
      }
    } catch {
      throw new SourceApprovalRejected('source_approval_unavailable', 503);
    }
    return file;
  }
  private owned(actor: EnrollmentActor, record: File['approvals'][number]) {
    return (
      record.owner.userId === actor.userId &&
      record.owner.mode === actor.mode &&
      record.owner.tenantId === actor.tenantId
    );
  }
  async get(
    actor: EnrollmentActor,
    operationId: string,
    expectedTarget?: string,
  ): Promise<AnalyticsSourceApproval | null> {
    await actor.assertCurrent();
    try {
      const record = this.checked(
        this.file.read(this.initial(actor.sourceStationId)),
        actor,
      ).approvals.find((item) => item.view.operationId === operationId);
      if (!record) return null;
      if (!this.owned(actor, record))
        throw new SourceApprovalRejected('source_approval_not_found', 404);
      if (
        expectedTarget !== undefined &&
        record.targetSha256 !== expectedTarget
      )
        throw new SourceApprovalRejected('source_approval_conflict', 409);
      await actor.assertCurrent();
      return record.view;
    } catch (error) {
      if (
        error instanceof SourceApprovalRejected ||
        error instanceof AuthorityObservationRejected ||
        error instanceof UsageExportRejected
      )
        throw error;
      throw new SourceApprovalRejected('source_approval_unavailable', 503);
    }
  }
  async prepareDelivery(actor: SourceApprovalActor, operationId: string) {
    if (!enrollmentOperationId.safeParse(operationId).success)
      throw new SourceApprovalRejected('source_approval_invalid', 400);
    try {
      return await this.file.update(
        this.initial(actor.sourceStationId),
        actor.assertCurrent,
        async (file) => {
          this.checked(file, actor);
          const record = file.approvals.find(
            (item) =>
              item.view.operationId === operationId && this.owned(actor, item),
          );
          if (!record)
            throw new SourceApprovalRejected('source_approval_not_found', 404);
          if (
            record.view.phase !== 'approved' ||
            Date.parse(record.view.expiresAt) <= this.now() ||
            JSON.stringify(record.owner) !== JSON.stringify(owner(actor)) ||
            record.approvalCredentialId !== actor.approvalCredentialId ||
            record.approvalBindingSha256 !== actor.approvalBindingSha256
          )
            throw new SourceApprovalRejected('source_approval_conflict', 409);
          await actor.assertApprovalCurrent(record.view.approvedAt);
          if (record.delivery) return record.delivery.view;
          const credential = `stax_${randomBytes(32).toString('base64url')}`;
          const view = await sealSourceCredential(
            {
              protocol: 'station-analytics-source-credential/v1',
              profile: 'canonical-usage-export/v1',
              sourceApprovalId: operationId,
              sourceOperationId: record.view.sourceOperationId,
              sourceStationId: actor.sourceStationId,
              destinationStationId: record.view.destinationStationId,
              sourceIntentSha256: analyticsIntentDigest(record.sourceIntent),
              recipientId: record.view.recipientId,
              recipientBindingSha256:
                record.candidate.claims.recipientBindingSha256,
              revision: 1,
              expiresAt: record.view.expiresAt,
              scope: record.view.scope,
              retention: record.view.retention,
              credential,
            },
            record.candidate.claims.encryptionKey,
          );
          await actor.assertCurrent();
          if (Date.parse(record.view.expiresAt) <= this.now())
            throw new SourceApprovalRejected('source_approval_conflict', 409);
          await actor.assertApprovalCurrent(record.view.approvedAt);
          record.delivery = {
            view,
            credentialSha256: sourceCredentialHash(credential),
          };
          return view;
        },
      );
    } catch (error) {
      if (
        error instanceof SourceApprovalRejected ||
        error instanceof AuthorityObservationRejected ||
        error instanceof UsageExportRejected
      )
        throw error;
      throw new SourceApprovalRejected('source_approval_unavailable', 503);
    }
  }

  async revoke(
    actor: EnrollmentActor,
    operationId: string,
  ): Promise<AnalyticsSourceApproval> {
    if (!enrollmentOperationId.safeParse(operationId).success)
      throw new SourceApprovalRejected('source_approval_invalid', 400);
    return this.file.update(
      this.initial(actor.sourceStationId),
      actor.assertCurrent,
      (file) => {
        this.checked(file, actor);
        const record = file.approvals.find(
          (item) =>
            item.view.operationId === operationId && this.owned(actor, item),
        );
        if (!record)
          throw new SourceApprovalRejected('source_approval_not_found', 404);
        record.view.phase = 'revoked';
        return record.view;
      },
    );
  }
  async approve(
    actor: SourceApprovalActor,
    intent: AnalyticsSourceEnrollmentIntent,
    input: Input,
    transactionId: string,
  ): Promise<AnalyticsSourceApproval> {
    const targetSha256 = sourceApprovalTarget(actor, intent, input, this.now());
    try {
      return await this.file.update(
        this.initial(actor.sourceStationId),
        actor.assertCurrent,
        (file) => {
          this.checked(file, actor);
          sourceApprovalTarget(actor, intent, input, this.now());
          const existing = file.approvals.find(
            (item) => item.view.operationId === input.operationId,
          );
          if (existing) {
            if (!this.owned(actor, existing))
              throw new SourceApprovalRejected(
                'source_approval_not_found',
                404,
              );
            if (existing.targetSha256 !== targetSha256)
              throw new SourceApprovalRejected('source_approval_conflict', 409);
            return existing.view;
          }
          if (file.approvals.length >= 1000)
            throw new SourceApprovalRejected('source_approval_conflict', 409);
          const view: AnalyticsSourceApproval = {
            protocol: 'station-analytics-source-approval/v1',
            operationId: input.operationId,
            sourceOperationId: intent.operationId,
            sourceStationId: actor.sourceStationId,
            destinationStationId: intent.proposedDestination.stationId,
            recipientId: input.recipientCandidate.claims.recipientId,
            recipientPrincipalId:
              input.recipientCandidate.claims.recipientPrincipalId,
            scope: intent.scope,
            expiresAt: intent.expiresAt,
            retention: intent.retention,
            phase: 'approved',
            approvedAt: new Date(this.now()).toISOString(),
            approvalTransactionId: transactionId,
            sourceApproved: true,
            exportAuthority: false,
            recipientAssurance: 'source-user-approved-key',
          };
          file.approvals.push({
            view,
            owner: owner(actor),
            approvalCredentialId: actor.approvalCredentialId,
            approvalBindingSha256: actor.approvalBindingSha256,
            targetSha256,
            sourceIntent: intent,
            candidate: input.recipientCandidate,
          });
          return view;
        },
      );
    } catch (error) {
      if (
        error instanceof SourceApprovalRejected ||
        error instanceof AuthorityObservationRejected ||
        error instanceof UsageExportRejected
      )
        throw error;
      throw new SourceApprovalRejected('source_approval_unavailable', 503);
    }
  }
}
