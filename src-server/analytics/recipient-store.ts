import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import type {
  AnalyticsSourceCredentialDelivery,
  AnalyticsStoredSourceCredential,
} from '@kontourai/station-contracts/usage-export';
import {
  ANALYTICS_RECIPIENT_CANDIDATE_PROTOCOL,
  type AnalyticsRecipientCandidateView,
} from '@kontourai/station-contracts/usage-export';
import { z } from 'zod/v3';
import { AuthorityObservationRejected } from '../services/identity/authority-observation.js';
import { AnalyticsPrivateFile } from './private-analytics-file.js';
import {
  analyticsIntentDigest,
  recipientCandidateInput,
  recipientCandidateSchema,
  recipientConfirmationCode,
  recipientEncryptionKeySchema,
  recipientProofKeySchema,
  signRecipientCandidate,
  verifyRecipientCandidateSignature,
} from './recipient-candidate.js';
import {
  readRecipientSourcePage,
  recipientSourceReadInput,
} from './recipient-source-read.js';
import {
  openSourceCredential,
  sourceCredentialDeliverySchema,
  sourceCredentialHash,
  sourceCredentialPayloadSchema,
} from './source-credential.js';
import {
  enrollmentIdentity,
  enrollmentIntentSchema,
  enrollmentOperationId,
  enrollmentOwnerSchema,
} from './source-enrollment-protocol.js';
import type { EnrollmentActor } from './source-enrollment-store.js';
import {
  createSourceDeliveryProof,
  sourceDeliveryProofSchema,
} from './source-export-proof.js';
import { UsageExportRejected } from './usage-export-reader.js';

const recordSchema = z
  .object({
    owner: enrollmentOwnerSchema,
    sourceIntent: enrollmentIntentSchema,
    intentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    proposedSourceOrigin: z.string(),
    phase: z.enum(['candidate', 'cancelled']),
    encryptionPrivateKey: z.string().min(1).max(4096),
    proofPrivateKey: z.string().min(1).max(4096),
    candidate: recipientCandidateSchema,
    sourceConfirmation: z
      .object({
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        consentId: enrollmentOperationId,
        approvedAt: z.string().datetime(),
      })
      .strict()
      .optional(),
    sourceCredential: z
      .object({
        envelopeSha256: z.string().regex(/^[a-f0-9]{64}$/),
        payload: sourceCredentialPayloadSchema,
        proof: sourceDeliveryProofSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const fileSchema = z
  .object({
    version: z.literal(1),
    destinationStationId: enrollmentIdentity,
    records: z.array(recordSchema).max(1000),
  })
  .strict()
  .refine(
    (value) =>
      new Set(
        value.records.map((record) => record.candidate.claims.recipientId),
      ).size === value.records.length &&
      value.records.every(
        (record) =>
          record.candidate.claims.destinationStationId ===
            value.destinationStationId &&
          JSON.stringify(record.owner.ownerIds) ===
            JSON.stringify([record.owner.userId]),
      ),
  );
type File = z.infer<typeof fileSchema>;
type Record = z.infer<typeof recordSchema>;

export class RecipientCandidateRejected extends Error {
  constructor(
    readonly code:
      | 'recipient_source_https_required'
      | 'recipient_candidate_invalid'
      | 'recipient_candidate_conflict'
      | 'recipient_candidate_not_found'
      | 'recipient_candidate_unavailable',
    readonly status: 400 | 404 | 409 | 503,
  ) {
    super(code);
  }
}
function binding(
  owner: Record['owner'],
  destinationStationId: string,
  recipientId: string,
) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        destinationStationId,
        recipientId,
        owner.userId,
        owner.mode,
        owner.tenantId,
      ]),
    )
    .digest('hex');
}

/** Per-person analytics keys only. It does not borrow Station/F1 keys or issue a source grant. */
export class RecipientStore {
  private readonly file: AnalyticsPrivateFile<File>;
  constructor(
    home: string,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.file = new AnalyticsPrivateFile(
      home,
      'analytics-recipients.json',
      fileSchema,
      4 * 1024 * 1024,
    );
  }
  private initial(actor: EnrollmentActor): File {
    return {
      version: 1,
      destinationStationId: actor.sourceStationId,
      records: [],
    };
  }
  private checked(file: File, actor: EnrollmentActor) {
    try {
      if (file.destinationStationId !== actor.sourceStationId)
        throw new Error('Destination changed');
      for (const record of file.records.filter((record) =>
        this.owned(actor, record),
      )) {
        const candidate = verifyRecipientCandidateSignature(record.candidate),
          claims = candidate.claims;
        if (
          claims.recipientPrincipalId !== record.owner.userId ||
          claims.recipientBindingSha256 !==
            binding(
              record.owner,
              file.destinationStationId,
              claims.recipientId,
            ) ||
          claims.sourceIntentSha256 !== record.intentSha256 ||
          analyticsIntentDigest(record.sourceIntent) !== record.intentSha256 ||
          claims.proposedSourceOrigin !== record.proposedSourceOrigin
        )
          throw new Error('Binding changed');
        if (record.sourceCredential)
          this.checkCredential(record, record.sourceCredential.payload);
        if (
          record.sourceConfirmation &&
          record.sourceConfirmation.fingerprint !==
            this.sourceFingerprint(record)
        )
          throw new Error('Source confirmation changed');
        const encryptionKey = recipientEncryptionKeySchema.parse(
          createPublicKey(createPrivateKey(record.encryptionPrivateKey)).export(
            { format: 'jwk' },
          ),
        );
        const proofKey = recipientProofKeySchema.parse(
          createPublicKey(createPrivateKey(record.proofPrivateKey)).export({
            format: 'jwk',
          }),
        );
        if (
          JSON.stringify(encryptionKey) !==
            JSON.stringify(claims.encryptionKey) ||
          JSON.stringify(proofKey) !== JSON.stringify(claims.proofKey)
        )
          throw new Error('Key changed');
      }
      return file;
    } catch {
      throw new RecipientCandidateRejected(
        'recipient_candidate_unavailable',
        503,
      );
    }
  }
  private owned(actor: EnrollmentActor, record: Record) {
    return (
      record.owner.userId === actor.userId &&
      record.owner.mode === actor.mode &&
      record.owner.tenantId === actor.tenantId
    );
  }
  private view(record: Record): AnalyticsRecipientCandidateView {
    return {
      observedAt: new Date(this.now()).toISOString(),
      sourceIntent: record.sourceIntent,
      phase:
        record.phase === 'cancelled'
          ? 'cancelled'
          : record.sourceCredential
            ? 'credential-stored'
            : record.candidate.claims.expiresAt <= this.now()
              ? 'expired'
              : 'candidate',
      verification: 'key-possession-only',
      sourceVerified: false,
      exportAuthority: false,
      confirmationCode: recipientConfirmationCode(record.candidate),
      candidate: record.candidate,
      ...(record.sourceConfirmation && record.sourceCredential
        ? {
            sourceConfirmation: {
              assurance: 'person-approved-https-origin' as const,
              origin: record.proposedSourceOrigin,
              stationId: record.sourceIntent.sourceStationId,
              revision: record.sourceCredential.payload.revision,
              approvedAt: record.sourceConfirmation.approvedAt,
            },
          }
        : {}),
      ...(record.sourceCredential
        ? { storedCredential: this.credentialView(record) }
        : {}),
    };
  }
  private credentialView(record: Record): AnalyticsStoredSourceCredential {
    const value = record.sourceCredential?.payload;
    if (!value)
      throw new RecipientCandidateRejected(
        'recipient_candidate_unavailable',
        503,
      );
    return {
      sourceApprovalId: value.sourceApprovalId,
      sourceStationId: value.sourceStationId,
      recipientId: value.recipientId,
      revision: value.revision,
      expiresAt: value.expiresAt,
      credentialStored: true,
      ...(record.sourceCredential?.proof
        ? { deliveryProof: record.sourceCredential.proof }
        : {}),
      sourceVerified: false,
      exportAuthority: false,
    };
  }
  private checkCredential(
    record: Record,
    value: z.infer<typeof sourceCredentialPayloadSchema>,
  ) {
    const claims = record.candidate.claims;
    if (
      value.sourceIntentSha256 !== record.intentSha256 ||
      value.sourceOperationId !== record.sourceIntent.operationId ||
      value.sourceStationId !== record.sourceIntent.sourceStationId ||
      value.destinationStationId !== claims.destinationStationId ||
      value.recipientId !== claims.recipientId ||
      value.recipientBindingSha256 !== claims.recipientBindingSha256 ||
      value.expiresAt !== record.sourceIntent.expiresAt ||
      value.scope !== record.sourceIntent.scope ||
      JSON.stringify(value.retention) !==
        JSON.stringify(record.sourceIntent.retention)
    )
      throw new RecipientCandidateRejected('recipient_candidate_conflict', 409);
  }
  private read(actor: EnrollmentActor) {
    try {
      return this.checked(this.file.read(this.initial(actor)), actor);
    } catch {
      throw new RecipientCandidateRejected(
        'recipient_candidate_unavailable',
        503,
      );
    }
  }
  private sourceRecord(
    file: File,
    actor: EnrollmentActor,
    recipientId: string,
  ) {
    if (!enrollmentOperationId.safeParse(recipientId).success)
      throw new RecipientCandidateRejected('recipient_candidate_invalid', 400);
    const record = file.records.find(
      (item) =>
        item.candidate.claims.recipientId === recipientId &&
        this.owned(actor, item),
    );
    if (!record)
      throw new RecipientCandidateRejected(
        'recipient_candidate_not_found',
        404,
      );
    if (
      record.phase === 'cancelled' ||
      !record.sourceCredential?.proof ||
      Date.parse(record.sourceCredential.payload.expiresAt) <= this.now()
    )
      throw new RecipientCandidateRejected('recipient_candidate_conflict', 409);
    if (new URL(record.proposedSourceOrigin).protocol !== 'https:')
      throw new RecipientCandidateRejected(
        'recipient_source_https_required',
        409,
      );
    return record;
  }
  private sourceFingerprint(record: Record) {
    const credential = record.sourceCredential;
    if (!credential)
      throw new RecipientCandidateRejected('recipient_candidate_conflict', 409);
    return createHash('sha256')
      .update(
        JSON.stringify([
          record.owner,
          record.sourceIntent,
          record.candidate,
          credential.payload.sourceApprovalId,
          credential.payload.revision,
          sourceCredentialHash(credential.payload.credential),
        ]),
      )
      .digest('hex');
  }
  async reviewSource(actor: EnrollmentActor, recipientId: string) {
    await actor.assertCurrent();
    const record = this.sourceRecord(this.read(actor), actor, recipientId);
    const fingerprint = this.sourceFingerprint(record);
    await actor.assertCurrent();
    return {
      fingerprint,
      recipientId,
      origin: record.proposedSourceOrigin,
      sourceStationId: record.sourceIntent.sourceStationId,
      scope: record.sourceIntent.scope,
      expiresAt: record.sourceIntent.expiresAt,
    };
  }
  async confirmSource(
    actor: EnrollmentActor,
    recipientId: string,
    fingerprint: string,
    consentId: string,
  ) {
    if (!enrollmentOperationId.safeParse(consentId).success)
      throw new RecipientCandidateRejected('recipient_candidate_invalid', 400);
    return this.file.update(
      this.initial(actor),
      actor.assertCurrent,
      (file) => {
        this.checked(file, actor);
        const record = this.sourceRecord(file, actor, recipientId);
        if (this.sourceFingerprint(record) !== fingerprint)
          throw new RecipientCandidateRejected(
            'recipient_candidate_conflict',
            409,
          );
        record.sourceConfirmation = {
          fingerprint,
          consentId,
          approvedAt: new Date(this.now()).toISOString(),
        };
        return this.view(record);
      },
    );
  }
  async readSourcePage(
    actor: EnrollmentActor,
    recipientId: string,
    query: z.infer<typeof recipientSourceReadInput>,
    signal: AbortSignal,
  ) {
    const parsed = recipientSourceReadInput.parse(query);
    await actor.assertCurrent();
    const record = this.sourceRecord(this.read(actor), actor, recipientId);
    const fingerprint = this.sourceFingerprint(record);
    const confirmation = record.sourceConfirmation;
    const credential = record.sourceCredential;
    if (
      !confirmation ||
      confirmation.fingerprint !== fingerprint ||
      !credential?.proof
    )
      throw new AuthorityObservationRejected(403, 'authority_changed');
    const assertLocalCurrent = async () => {
      await actor.assertCurrent();
      let fresh: Record;
      try {
        fresh = this.sourceRecord(this.read(actor), actor, recipientId);
      } catch (error) {
        if (
          error instanceof RecipientCandidateRejected &&
          [404, 409].includes(error.status)
        )
          throw new AuthorityObservationRejected(403, 'authority_changed');
        throw error;
      }
      if (
        this.sourceFingerprint(fresh) !== fingerprint ||
        JSON.stringify(fresh.sourceConfirmation) !==
          JSON.stringify(confirmation)
      )
        throw new AuthorityObservationRejected(403, 'authority_changed');
    };
    return readRecipientSourcePage({
      origin: record.proposedSourceOrigin,
      stationId: record.sourceIntent.sourceStationId,
      approvalId: credential.payload.sourceApprovalId,
      revision: credential.payload.revision,
      scope: credential.payload.scope,
      credential: credential.payload.credential,
      proof: credential.proof,
      query: parsed,
      assertLocalCurrent,
      signal,
      fetchImpl: this.fetchImpl,
    });
  }
  async list(actor: EnrollmentActor) {
    await actor.assertCurrent();
    const result = this.read(actor)
      .records.filter((record) => this.owned(actor, record))
      .slice(-20)
      .reverse()
      .map((record) => this.view(record));
    await actor.assertCurrent();
    return result;
  }
  async get(actor: EnrollmentActor, recipientId: string) {
    if (!enrollmentOperationId.safeParse(recipientId).success)
      throw new RecipientCandidateRejected('recipient_candidate_invalid', 400);
    await actor.assertCurrent();
    const record = this.read(actor).records.find(
      (record) =>
        record.candidate.claims.recipientId === recipientId &&
        this.owned(actor, record),
    );
    if (!record)
      throw new RecipientCandidateRejected(
        'recipient_candidate_not_found',
        404,
      );
    await actor.assertCurrent();
    return this.view(record);
  }
  async prepare(
    actor: EnrollmentActor,
    input: z.infer<typeof recipientCandidateInput>,
  ) {
    return this.update(actor, (file) => {
      const intentSha256 = analyticsIntentDigest(input.sourceIntent);
      const existing = file.records.find(
        (record) => record.candidate.claims.recipientId === input.operationId,
      );
      if (existing) {
        if (!this.owned(actor, existing))
          throw new RecipientCandidateRejected(
            'recipient_candidate_not_found',
            404,
          );
        if (
          existing.intentSha256 !== intentSha256 ||
          existing.proposedSourceOrigin !== input.proposedSourceOrigin
        )
          throw new RecipientCandidateRejected(
            'recipient_candidate_conflict',
            409,
          );
        return this.view(existing);
      }
      if (
        input.sourceIntent.proposedDestination.stationId !==
        actor.sourceStationId
      )
        throw new RecipientCandidateRejected(
          'recipient_candidate_conflict',
          409,
        );
      const now = this.now(),
        expiresAt = Math.min(
          now + 300_000,
          Date.parse(input.sourceIntent.expiresAt),
        );
      if (expiresAt <= now)
        throw new RecipientCandidateRejected(
          'recipient_candidate_invalid',
          400,
        );
      if (
        file.records.length >= 1000 ||
        file.records.filter(
          (record) =>
            this.owned(actor, record) &&
            record.phase === 'candidate' &&
            record.candidate.claims.expiresAt > now,
        ).length >= 20
      )
        throw new RecipientCandidateRejected(
          'recipient_candidate_conflict',
          409,
        );
      const owner = enrollmentOwnerSchema.parse({
        userId: actor.userId,
        mode: actor.mode,
        tenantId: actor.tenantId,
        ownerIds: [actor.userId],
      });
      const encryption = generateKeyPairSync('x25519'),
        proof = generateKeyPairSync('ed25519');
      const candidate = signRecipientCandidate(
        {
          protocol: ANALYTICS_RECIPIENT_CANDIDATE_PROTOCOL,
          recipientId: input.operationId,
          sourceOperationId: input.sourceIntent.operationId,
          sourceStationId: input.sourceIntent.sourceStationId,
          sourceIntentSha256: intentSha256,
          proposedSourceOrigin: input.proposedSourceOrigin,
          destinationStationId: actor.sourceStationId,
          proposedDestinationOrigin:
            input.sourceIntent.proposedDestination.origin,
          recipientPrincipalId: actor.userId,
          recipientBindingSha256: binding(
            owner,
            actor.sourceStationId,
            input.operationId,
          ),
          encryptionKey: recipientEncryptionKeySchema.parse(
            encryption.publicKey.export({ format: 'jwk' }),
          ),
          proofKey: recipientProofKeySchema.parse(
            proof.publicKey.export({ format: 'jwk' }),
          ),
          createdAt: now,
          expiresAt,
        },
        proof.privateKey,
      );
      const record: Record = {
        owner,
        sourceIntent: input.sourceIntent,
        intentSha256,
        proposedSourceOrigin: input.proposedSourceOrigin,
        phase: 'candidate',
        encryptionPrivateKey: encryption.privateKey
          .export({ format: 'pem', type: 'pkcs8' })
          .toString(),
        proofPrivateKey: proof.privateKey
          .export({ format: 'pem', type: 'pkcs8' })
          .toString(),
        candidate,
      };
      file.records.push(record);
      return this.view(record);
    });
  }
  async materialize(
    actor: EnrollmentActor,
    recipientId: string,
    delivery: AnalyticsSourceCredentialDelivery,
  ): Promise<AnalyticsStoredSourceCredential> {
    if (!enrollmentOperationId.safeParse(recipientId).success)
      throw new RecipientCandidateRejected('recipient_candidate_invalid', 400);
    try {
      return await this.file.update(
        this.initial(actor),
        actor.assertCurrent,
        async (file) => {
          this.checked(file, actor);
          const record = file.records.find(
            (item) =>
              item.candidate.claims.recipientId === recipientId &&
              this.owned(actor, item),
          );
          if (!record)
            throw new RecipientCandidateRejected(
              'recipient_candidate_not_found',
              404,
            );
          if (
            record.phase === 'cancelled' ||
            delivery.recipientId !== recipientId
          )
            throw new RecipientCandidateRejected(
              'recipient_candidate_conflict',
              409,
            );
          const wire = sourceCredentialDeliverySchema.parse(delivery);
          const envelopeSha256 = createHash('sha256')
            .update(wire.envelope)
            .digest('hex');
          const old = record.sourceCredential;
          if (
            old &&
            (old.payload.sourceApprovalId !== wire.sourceApprovalId ||
              old.payload.revision > wire.revision ||
              (old.payload.revision === wire.revision &&
                old.envelopeSha256 !== envelopeSha256))
          )
            throw new RecipientCandidateRejected(
              'recipient_candidate_conflict',
              409,
            );
          if (old?.envelopeSha256 === envelopeSha256) {
            if (!old.proof)
              old.proof = createSourceDeliveryProof(
                old.payload,
                record.proofPrivateKey,
              );
            return this.credentialView(record);
          }
          let value: z.infer<typeof sourceCredentialPayloadSchema>;
          try {
            value = await openSourceCredential(
              wire,
              record.encryptionPrivateKey,
            );
          } catch {
            throw new RecipientCandidateRejected(
              'recipient_candidate_invalid',
              400,
            );
          }
          this.checkCredential(record, value);
          if (Date.parse(value.expiresAt) <= this.now())
            throw new RecipientCandidateRejected(
              'recipient_candidate_conflict',
              409,
            );
          await actor.assertCurrent();
          delete record.sourceConfirmation;
          record.sourceCredential = {
            envelopeSha256,
            payload: value,
            proof: createSourceDeliveryProof(value, record.proofPrivateKey),
          };
          return this.credentialView(record);
        },
      );
    } catch (error) {
      if (
        error instanceof RecipientCandidateRejected ||
        error instanceof AuthorityObservationRejected ||
        error instanceof UsageExportRejected
      )
        throw error;
      throw new RecipientCandidateRejected(
        'recipient_candidate_unavailable',
        503,
      );
    }
  }

  async cancel(actor: EnrollmentActor, recipientId: string) {
    if (!enrollmentOperationId.safeParse(recipientId).success)
      throw new RecipientCandidateRejected('recipient_candidate_invalid', 400);
    return this.update(actor, (file) => {
      const record = file.records.find(
        (record) =>
          record.candidate.claims.recipientId === recipientId &&
          this.owned(actor, record),
      );
      if (!record)
        throw new RecipientCandidateRejected(
          'recipient_candidate_not_found',
          404,
        );
      record.phase = 'cancelled';
      return this.view(record);
    });
  }
  private async update<R>(
    actor: EnrollmentActor,
    apply: (file: File) => R,
  ): Promise<R> {
    try {
      return await this.file.update(
        this.initial(actor),
        actor.assertCurrent,
        (file) => apply(this.checked(file, actor)),
      );
    } catch (error) {
      if (
        error instanceof RecipientCandidateRejected ||
        error instanceof AuthorityObservationRejected ||
        error instanceof UsageExportRejected
      )
        throw error;
      throw new RecipientCandidateRejected(
        'recipient_candidate_unavailable',
        503,
      );
    }
  }
}
