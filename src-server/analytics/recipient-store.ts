import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
} from 'node:crypto';
import type {
  AnalyticsSourceCredentialDelivery,
  AnalyticsStoredSourceCredential,
} from '@kontourai/station-contracts/usage-export';
import {
  ANALYTICS_RECIPIENT_CANDIDATE_PROTOCOL,
  type AnalyticsRecipientCandidateView,
  type AnalyticsSourceSyncStatus,
  canonicalUsageExportJson,
  type PrivateUsageCommit,
  type PrivateUsageInvalidationCheckpoint,
  type PrivateUsageInvalidationCommit,
  parsePrivateUsageCommit,
  parsePrivateUsageInvalidations,
} from '@kontourai/station-contracts/usage-export';
import { z } from 'zod/v3';
import { AuthorityObservationRejected } from '../services/identity/authority-observation.js';
import { AnalyticsPrivateFile } from './private-analytics-file.js';
import {
  PrivateUsageClientRejected,
  type PrivateUsageTarget,
  privateInvalidationCheckpointSchema,
  privateInvalidationReceiptSchema,
  privateReceiptIntent,
  privateReceiptIntentSchema,
  privateReceiptSchema,
  validatePrivateReceiptIntent,
} from './private-usage-client.js';
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
  captureRecipientSourceAuthority,
  readRecipientSourceInvalidations,
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

const syncInput = z
  .object({
    operationId: enrollmentOperationId,
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    restart: z.boolean().optional(),
  })
  .strict();
export const recipientSyncInput = syncInput.refine(
  (value) =>
    Number.isFinite(Date.parse(value.from)) &&
    Number.isFinite(Date.parse(value.to)) &&
    new Date(value.from).toISOString().slice(0, 10) === value.from &&
    new Date(value.to).toISOString().slice(0, 10) === value.to &&
    value.from <= value.to &&
    Date.parse(value.to) - Date.parse(value.from) <= 365 * 86400000,
);
const pendingBody = z.custom<PrivateUsageCommit>((value) => {
  try {
    parsePrivateUsageCommit(value);
    return true;
  } catch {
    return false;
  }
});
const syncSchema = z
  .object({
    operationId: enrollmentOperationId,
    from: syncInput.shape.from,
    to: syncInput.shape.to,
    restart: z.boolean(),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    credentialRevision: z
      .number()
      .int()
      .positive()
      .refine(Number.isSafeInteger),
    target: z
      .object({
        installationId: z.string().regex(/^[a-f0-9]{64}$/),
        custody: z.string().regex(/^[a-f0-9]{64}$/),
        receiverEpoch: enrollmentOperationId,
      })
      .strict(),
    phase: z.enum([
      'prepared',
      'pending',
      'page-stored',
      'facts-captured',
      'invalidations-pending',
      'cancelled',
      'unconfirmed',
    ]),
    invalidationCheckpoint: privateInvalidationCheckpointSchema.optional(),
    pending: pendingBody.optional(),
    intent: privateReceiptIntentSchema.optional(),
    receipt: privateReceiptSchema.optional(),
  })
  .strict();
const replaySchema = z
  .object({
    operationId: enrollmentOperationId,
    restart: z.boolean(),
    from: syncInput.shape.from,
    to: syncInput.shape.to,
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    credentialRevision: z
      .number()
      .int()
      .positive()
      .refine(Number.isSafeInteger),
    sourceApprovalId: enrollmentOperationId,
    target: syncSchema.shape.target,
    expiresAt: z.string().datetime(),
    expected: privateInvalidationCheckpointSchema,
    pending: z
      .custom<PrivateUsageInvalidationCommit>((value) => {
        try {
          parsePrivateUsageInvalidations(value);
          return true;
        } catch {
          return false;
        }
      })
      .optional(),
    receipt: privateInvalidationReceiptSchema.optional(),
  })
  .strict();
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
    sync: syncSchema.optional(),
    replay: replaySchema.optional(),
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
      ...(record.sync ? { sync: this.syncView(record) } : {}),
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
  private async sourceReadContext(
    actor: EnrollmentActor,
    recipientId: string,
    signal: AbortSignal,
  ) {
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
    return {
      origin: record.proposedSourceOrigin,
      stationId: record.sourceIntent.sourceStationId,
      approvalId: credential.payload.sourceApprovalId,
      revision: credential.payload.revision,
      scope: credential.payload.scope,
      credential: credential.payload.credential,
      proof: credential.proof,
      assertLocalCurrent,
      signal,
      fetchImpl: this.fetchImpl,
    };
  }
  async readSourcePage(
    actor: EnrollmentActor,
    recipientId: string,
    query: z.infer<typeof recipientSourceReadInput>,
    signal: AbortSignal,
  ) {
    const parsed = recipientSourceReadInput.parse(query);
    return readRecipientSourcePage({
      ...(await this.sourceReadContext(actor, recipientId, signal)),
      query: parsed,
    });
  }
  private async replayInvalidations(
    actor: EnrollmentActor,
    recipientId: string,
    input: z.infer<typeof recipientSyncInput>,
    target: PrivateUsageTarget,
    signal: AbortSignal,
    checkpoint?: {
      receiverEpoch: string;
      journal: PrivateUsageInvalidationCheckpoint | null;
    },
  ) {
    let record = this.ownedRecord(actor, recipientId);
    let state = record.replay;
    const same = state?.operationId === input.operationId;
    if (
      state &&
      (same || !state.receipt) &&
      (!same ||
        state.from !== input.from ||
        state.to !== input.to ||
        state.restart !== (input.restart ?? false) ||
        state.target.installationId !== target.installationId ||
        state.target.custody !== target.custody)
    )
      throw new PrivateUsageClientRejected(409, 'private_usage_conflict');
    if (same && state?.receipt) return state.receipt;
    if (!same && state?.receipt) state = undefined;
    if (!state) {
      if (!checkpoint?.journal) return null;
      const credential = this.sourceRecord(this.read(actor), actor, recipientId)
        .sourceCredential?.payload;
      if (!credential)
        throw new AuthorityObservationRejected(403, 'authority_changed');
      const key = this.indexKey(
        record,
        target,
        credential.revision,
        credential.sourceApprovalId,
      );
      if (await target.invalidationReceipt(key, input.operationId))
        throw new PrivateUsageClientRejected(409, 'private_usage_conflict');
      const selected = await readRecipientSourceInvalidations({
        ...(await this.sourceReadContext(actor, recipientId, signal)),
        checkpoint: checkpoint.journal,
      });
      if (
        selected.page.nextAfter === checkpoint.journal.after &&
        !selected.page.nextCursor
      )
        return null;
      const body = parsePrivateUsageInvalidations({
        protocol: 'station-private-usage-invalidations/v1',
        operationId: input.operationId,
        expectedReceiverEpoch: checkpoint.receiverEpoch,
        expectedAfter: checkpoint.journal.after,
        page: selected.page,
      });
      const fingerprint = this.sourceFingerprint(record);
      await this.file.update(
        this.initial(actor),
        actor.assertCurrent,
        (file) => {
          this.checked(file, actor);
          const fresh = this.sourceRecord(file, actor, recipientId);
          if (
            this.sourceFingerprint(fresh) !== fingerprint ||
            (fresh.replay && !fresh.replay.receipt)
          )
            throw new PrivateUsageClientRejected(409, 'private_usage_conflict');
          fresh.replay = {
            operationId: input.operationId,
            restart: input.restart ?? false,
            from: input.from,
            to: input.to,
            sourceFingerprint: fingerprint,
            credentialRevision: credential.revision,
            sourceApprovalId: credential.sourceApprovalId,
            target: {
              installationId: target.installationId,
              custody: target.custody,
              receiverEpoch: checkpoint.receiverEpoch,
            },
            expiresAt: new Date(
              Math.min(Date.parse(credential.expiresAt), this.now() + 86400000),
            ).toISOString(),
            expected: {
              after: body.page.nextAfter,
              streamEpoch: body.page.streamEpoch,
              highWater: body.page.highWater,
              ...(body.page.nextCursor
                ? { nextCursor: body.page.nextCursor }
                : {}),
            },
            pending: body,
          };
        },
      );
      record = this.ownedRecord(actor, recipientId);
      state = record.replay;
    }
    if (!state)
      throw new PrivateUsageClientRejected(503, 'private_usage_unavailable');
    const captured = state;
    const key = this.indexKey(
      record,
      target,
      captured.credentialRevision,
      captured.sourceApprovalId,
    );
    const current = await target.checkpoint(key, {
      from: input.from,
      to: input.to,
    });
    if (!current || current.receiverEpoch !== captured.target.receiverEpoch)
      throw new PrivateUsageClientRejected(409, 'private_usage_conflict');
    let receipt = await target.invalidationReceipt(key, input.operationId);
    if (!receipt) {
      if (!captured.pending || Date.parse(captured.expiresAt) <= this.now())
        throw new PrivateUsageClientRejected(409, 'private_usage_conflict');
      if (this.sourceFingerprint(record) !== captured.sourceFingerprint)
        throw new AuthorityObservationRejected(403, 'authority_changed');
      // The saved body is historical append-only evidence. Current source permission still gates every send.
      const source = await this.sourceReadContext(actor, recipientId, signal);
      const assertSource = await captureRecipientSourceAuthority(
        source,
        captured.pending.page.highWater,
      );
      await target.assertCurrent();
      receipt = await target.applyInvalidations(
        key,
        captured.pending,
        assertSource,
      );
    }
    if (
      receipt.operationId !== input.operationId ||
      receipt.receiverEpoch !== captured.target.receiverEpoch ||
      canonicalUsageExportJson(receipt.checkpoint) !==
        canonicalUsageExportJson(captured.expected)
    )
      throw new PrivateUsageClientRejected(503, 'private_usage_unavailable');
    await this.file.update(this.initial(actor), actor.assertCurrent, (file) => {
      this.checked(file, actor);
      const fresh = file.records.find(
        (item) =>
          this.owned(actor, item) &&
          item.candidate.claims.recipientId === recipientId,
      );
      if (
        !fresh?.replay ||
        fresh.phase === 'cancelled' ||
        fresh.replay.operationId !== input.operationId ||
        canonicalUsageExportJson(fresh.replay.expected) !==
          canonicalUsageExportJson(captured.expected)
      )
        throw new PrivateUsageClientRejected(409, 'private_usage_conflict');
      fresh.replay.receipt = receipt;
      delete fresh.replay.pending;
    });
    return receipt;
  }
  private syncFlights = new Set<string>();
  private syncView(record: Record): AnalyticsSourceSyncStatus {
    const state = record.sync;
    if (!state)
      throw new RecipientCandidateRejected('recipient_candidate_conflict', 409);
    return {
      operationId: state.operationId,
      recipientId: record.candidate.claims.recipientId,
      installationId: state.target.installationId,
      from: state.from,
      to: state.to,
      credentialRevision: state.credentialRevision,
      phase: state.phase,
      ...(state.invalidationCheckpoint
        ? { invalidationCheckpoint: state.invalidationCheckpoint }
        : {}),
      ...(state.receipt
        ? {
            checkpoint: state.receipt.checkpoint,
            inserted: state.receipt.inserted,
            alreadyPresent: state.receipt.alreadyPresent,
            storedAt: state.receipt.storedAt,
          }
        : {}),
      sourceAuthority: 'not-established-by-status',
    };
  }
  private ownedRecord(actor: EnrollmentActor, recipientId: string) {
    if (!enrollmentOperationId.safeParse(recipientId).success)
      throw new RecipientCandidateRejected('recipient_candidate_invalid', 400);
    const record = this.read(actor).records.find(
      (item) =>
        this.owned(actor, item) &&
        item.candidate.claims.recipientId === recipientId,
    );
    if (!record)
      throw new RecipientCandidateRejected(
        'recipient_candidate_not_found',
        404,
      );
    return record;
  }
  private indexKey(
    record: Record,
    target: PrivateUsageTarget,
    revision: number,
    approvalId: string,
  ) {
    const material = createPrivateKey(record.proofPrivateKey).export({
      format: 'der',
      type: 'pkcs8',
    });
    const info = JSON.stringify([
      'station-private-usage-storage-key/v1',
      target.installationId,
      target.custody,
      approvalId,
      revision,
    ]);
    return `stai_${Buffer.from(hkdfSync('sha256', material, record.candidate.claims.recipientBindingSha256, info, 32)).toString('base64url')}`;
  }
  async syncPage(
    actor: EnrollmentActor,
    recipientId: string,
    raw: z.infer<typeof recipientSyncInput>,
    target: PrivateUsageTarget,
    signal: AbortSignal,
  ) {
    const input = recipientSyncInput.parse(raw);
    await actor.assertCurrent();
    const flight = JSON.stringify([
      actor.sourceStationId,
      actor.userId,
      actor.mode,
      actor.tenantId,
      recipientId,
    ]);
    if (this.syncFlights.has(flight))
      throw new RecipientCandidateRejected('recipient_candidate_conflict', 409);
    this.syncFlights.add(flight);
    try {
      await this.expireSyncOutboxes(actor.sourceStationId, actor.assertCurrent);
      let record = this.ownedRecord(actor, recipientId);
      let state = record.sync;
      let preparedHere = false;
      let capturedCheckpoint:
        | Awaited<ReturnType<PrivateUsageTarget['checkpoint']>>
        | undefined;
      if (
        state?.pending &&
        state.intent &&
        Date.parse(state.intent.expiresAt) <= this.now()
      ) {
        await this.file.update(
          this.initial(actor),
          actor.assertCurrent,
          (file) => {
            this.checked(file, actor);
            const fresh = file.records.find(
              (item) =>
                this.owned(actor, item) &&
                item.candidate.claims.recipientId === recipientId,
            );
            if (
              fresh?.sync?.pending &&
              fresh.sync.intent &&
              Date.parse(fresh.sync.intent.expiresAt) <= this.now()
            ) {
              delete fresh.sync.pending;
              fresh.sync.phase = 'unconfirmed';
            }
          },
        );
        record = this.ownedRecord(actor, recipientId);
        state = record.sync;
      }
      let replay =
        record.replay?.operationId === input.operationId ||
        (record.replay && !record.replay.receipt)
          ? await this.replayInvalidations(
              actor,
              recipientId,
              input,
              target,
              signal,
            )
          : null;
      const same = state?.operationId === input.operationId;
      if ((state?.pending || state?.intent) && !same)
        throw new RecipientCandidateRejected(
          'recipient_candidate_conflict',
          409,
        );
      if (
        same &&
        state &&
        (state.from !== input.from ||
          state.to !== input.to ||
          state.restart !== (input.restart ?? false) ||
          state.target.installationId !== target.installationId ||
          state.target.custody !== target.custody)
      )
        throw new PrivateUsageClientRejected(409, 'private_usage_conflict');
      if (same && state?.receipt) {
        await actor.assertCurrent();
        return this.syncView(record);
      }
      if (!state?.pending && !state?.intent) {
        const eligible = this.sourceRecord(
          this.read(actor),
          actor,
          recipientId,
        );
        const fingerprint = this.sourceFingerprint(eligible);
        if (
          !eligible.sourceConfirmation ||
          eligible.sourceConfirmation.fingerprint !== fingerprint ||
          !eligible.sourceCredential
        )
          throw new AuthorityObservationRejected(403, 'authority_changed');
        const credential = eligible.sourceCredential.payload;
        if (
          record.replay?.operationId === input.operationId &&
          (record.replay.sourceFingerprint !== fingerprint ||
            record.replay.credentialRevision !== credential.revision)
        )
          throw new PrivateUsageClientRejected(409, 'private_usage_conflict');
        const key = this.indexKey(
          eligible,
          target,
          credential.revision,
          credential.sourceApprovalId,
        );
        await actor.assertCurrent();
        await target.assertCurrent();
        let checkpoint = await target.checkpoint(key, {
          from: input.from,
          to: input.to,
        });
        if (
          record.replay?.operationId === input.operationId &&
          checkpoint?.receiverEpoch !== record.replay.target.receiverEpoch
        )
          throw new PrivateUsageClientRejected(409, 'private_usage_conflict');
        if (!checkpoint) {
          const provisioned = await target.provision(
            createHash('sha256').update(key).digest('hex'),
          );
          checkpoint = await target.checkpoint(key, {
            from: input.from,
            to: input.to,
          });
          if (
            !checkpoint ||
            checkpoint.receiverEpoch !== provisioned.receiverEpoch
          )
            throw new PrivateUsageClientRejected(
              503,
              'private_usage_unavailable',
            );
        }
        if (checkpoint.checkpoint && !checkpoint.journal)
          throw new PrivateUsageClientRejected(
            503,
            'private_usage_unavailable',
          );
        const receiverEpoch = checkpoint.receiverEpoch;
        if (
          state &&
          state.credentialRevision === credential.revision &&
          state.target.installationId === target.installationId &&
          state.target.custody === target.custody &&
          state.target.receiverEpoch !== receiverEpoch
        )
          throw new PrivateUsageClientRejected(409, 'private_usage_conflict');
        if (await target.receipt(key, input.operationId))
          throw new PrivateUsageClientRejected(409, 'private_usage_conflict');

        replay ??= await this.replayInvalidations(
          actor,
          recipientId,
          input,
          target,
          signal,
          checkpoint,
        );
        if (replay?.checkpoint.nextCursor) {
          const invalidationCheckpoint = replay.checkpoint;
          await this.file.update(
            this.initial(actor),
            actor.assertCurrent,
            (file) => {
              this.checked(file, actor);
              const fresh = this.sourceRecord(file, actor, recipientId);
              if (
                this.sourceFingerprint(fresh) !== fingerprint ||
                fresh.sync?.pending ||
                fresh.sync?.intent
              )
                throw new PrivateUsageClientRejected(
                  409,
                  'private_usage_conflict',
                );
              fresh.sync = {
                operationId: input.operationId,
                from: input.from,
                to: input.to,
                restart: input.restart ?? false,
                sourceFingerprint: fingerprint,
                credentialRevision: credential.revision,
                target: {
                  installationId: target.installationId,
                  custody: target.custody,
                  receiverEpoch,
                },
                phase: 'invalidations-pending',
                invalidationCheckpoint,
              };
            },
          );
          return this.syncView(this.ownedRecord(actor, recipientId));
        }
        const cp = checkpoint.checkpoint;
        const restartSnapshot =
          input.restart ||
          (replay?.refreshThreads.length ?? 0) > 0 ||
          (cp !== null &&
            (replay?.checkpoint.highWater ?? cp.sourceRevision) >
              cp.sourceRevision);
        const query = {
          from: input.from,
          to: input.to,
          pageSize: 100,
          ...(cp && !cp.completeThroughHighWater && !restartSnapshot
            ? {
                cursor: cp.nextCursor,
                snapshot: {
                  streamEpoch: cp.streamEpoch,
                  highWater: cp.highWater,
                  afterGlobalSequence: cp.afterGlobalSequence,
                },
              }
            : {}),
        };
        const selected = await this.readSourcePage(
          actor,
          recipientId,
          query,
          signal,
        );
        await selected.assertCurrent();
        await target.assertCurrent();
        const body = parsePrivateUsageCommit({
          protocol: 'station-private-usage-commit/v1',
          operationId: input.operationId,
          expectedReceiverEpoch: checkpoint.receiverEpoch,
          expectedCheckpoint: cp?.revision ?? 0,
          ...(restartSnapshot ? { restartSnapshot: true } : {}),
          binding: {
            sourceStationId: credential.sourceStationId,
            sourceApprovalId: credential.sourceApprovalId,
            recipientId,
            scope: credential.scope,
            expiresAt: credential.expiresAt,
            retention: credential.retention,
          },
          query: {
            ...query,
            scope: credential.scope,
            expectedStationId: credential.sourceStationId,
          },
          page: selected.page,
          sourceRevision: selected.sourceRevision,
        });
        await this.file.update(
          this.initial(actor),
          actor.assertCurrent,
          (file) => {
            this.checked(file, actor);
            const fresh = this.sourceRecord(file, actor, recipientId);
            if (
              !fresh ||
              this.sourceFingerprint(fresh) !== fingerprint ||
              !fresh.sourceConfirmation ||
              fresh.sourceConfirmation.fingerprint !== fingerprint ||
              fresh.sync?.pending
            )
              throw new RecipientCandidateRejected(
                'recipient_candidate_conflict',
                409,
              );
            fresh.sync = {
              operationId: input.operationId,
              from: input.from,
              to: input.to,
              restart: input.restart ?? false,
              sourceFingerprint: fingerprint,
              credentialRevision: credential.revision,
              target: {
                installationId: target.installationId,
                custody: target.custody,
                receiverEpoch,
              },
              phase: 'pending',
              pending: body,
              intent: privateReceiptIntent(
                body,
                new Date(
                  Math.min(
                    Date.parse(body.binding.expiresAt),
                    this.now() + 86400000,
                  ),
                ).toISOString(),
              ),
            };
          },
        );
        preparedHere = true;
        capturedCheckpoint = checkpoint;
        record = this.ownedRecord(actor, recipientId);
        state = record.sync;
      }
      if (!state?.intent)
        throw new PrivateUsageClientRejected(503, 'private_usage_unavailable');
      const intent = state.intent;
      const body = state.pending;
      const key = this.indexKey(
        record,
        target,
        state.credentialRevision,
        intent.sourceApprovalId,
      );
      const checkpoint =
        capturedCheckpoint ??
        (await target.checkpoint(key, {
          from: state.from,
          to: state.to,
        }));
      if (
        !checkpoint ||
        checkpoint.receiverEpoch !== state.target.receiverEpoch
      )
        throw new PrivateUsageClientRejected(409, 'private_usage_conflict');
      let receipt = preparedHere
        ? null
        : await target.receipt(key, state.operationId);
      if (!receipt) {
        if (!body)
          throw new PrivateUsageClientRejected(409, 'private_usage_conflict');
        if (
          this.sourceFingerprint(this.ownedRecord(actor, recipientId)) !==
          state.sourceFingerprint
        )
          throw new AuthorityObservationRejected(403, 'authority_changed');
        const query = {
          from: body.query.from,
          to: body.query.to,
          pageSize: body.query.pageSize,
          ...(body.query.cursor
            ? { cursor: body.query.cursor, snapshot: body.query.snapshot }
            : {}),
        };
        const selected = await this.readSourcePage(
          actor,
          recipientId,
          query,
          signal,
        );
        if (
          canonicalUsageExportJson({
            ...body,
            page: selected.page,
            sourceRevision: selected.sourceRevision,
          }) !== canonicalUsageExportJson(body)
        )
          throw new PrivateUsageClientRejected(409, 'private_usage_conflict');
        await selected.assertCurrent();
        await actor.assertCurrent();
        await target.assertCurrent();
        receipt = await target.commit(key, body, selected.assertCurrent);
      }
      validatePrivateReceiptIntent(receipt, state.operationId, intent);
      await this.file.update(
        this.initial(actor),
        actor.assertCurrent,
        (file) => {
          this.checked(file, actor);
          const fresh = file.records.find(
            (item) =>
              this.owned(actor, item) &&
              item.candidate.claims.recipientId === recipientId,
          );
          if (!fresh?.sync || fresh.sync.operationId !== input.operationId)
            throw new RecipientCandidateRejected(
              'recipient_candidate_conflict',
              409,
            );
          if (!fresh.sync.intent) {
            if (
              fresh.sync.receipt &&
              canonicalUsageExportJson(fresh.sync.receipt) ===
                canonicalUsageExportJson(receipt)
            )
              return;
            throw new RecipientCandidateRejected(
              'recipient_candidate_conflict',
              409,
            );
          }
          if (
            canonicalUsageExportJson(fresh.sync.intent) !==
            canonicalUsageExportJson(intent)
          )
            throw new RecipientCandidateRejected(
              'recipient_candidate_conflict',
              409,
            );
          fresh.sync.receipt = receipt;
          delete fresh.sync.pending;
          delete fresh.sync.intent;
          fresh.sync.phase = receipt.checkpoint.completeThroughHighWater
            ? 'facts-captured'
            : 'page-stored';
        },
      );
      await actor.assertCurrent();
      return this.syncView(this.ownedRecord(actor, recipientId));
    } finally {
      this.syncFlights.delete(flight);
    }
  }
  /** Deletion-only host housekeeping; no person/source authorization is created. */
  async expireSyncOutboxes(
    destinationStationId: string,
    assertHostCurrent: () => Promise<void>,
  ): Promise<number> {
    await assertHostCurrent();
    const initial: File = { version: 1, destinationStationId, records: [] };
    const current = this.file.read(initial);
    if (current.destinationStationId !== destinationStationId)
      throw new Error('Analytics destination changed');
    if (
      !current.records.some(
        (record) =>
          (record.sync?.pending &&
            record.sync.intent &&
            Date.parse(record.sync.intent.expiresAt) <= this.now()) ||
          (record.replay?.pending !== undefined &&
            Date.parse(record.replay.expiresAt) <= this.now()),
      )
    )
      return 0;
    return this.file.update(initial, assertHostCurrent, (file) => {
      if (file.destinationStationId !== destinationStationId)
        throw new Error('Analytics destination changed');
      let removed = 0;
      for (const record of file.records) {
        if (
          record.replay?.pending &&
          Date.parse(record.replay.expiresAt) <= this.now()
        ) {
          delete record.replay.pending;
          removed++;
        }
        if (
          record.sync?.pending &&
          record.sync.intent &&
          Date.parse(record.sync.intent.expiresAt) <= this.now()
        ) {
          delete record.sync.pending;
          record.sync.phase = 'unconfirmed';
          removed++;
        }
      }
      return removed;
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
      if (record.replay) delete record.replay.pending;
      if (record.sync) {
        delete record.sync.pending;
        delete record.sync.intent;
        record.sync.phase = 'cancelled';
      }
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
