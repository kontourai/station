import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  type AttachmentStagingPreparation,
  type AttachmentStagingStatus,
  type StagedAttachmentReference,
} from '@kontourai/station-contracts/attachment-staging';
import {
  type ChatAttachmentInput,
  type ChatAttachmentKind,
  type ChatAttachmentMimeType,
  parseChatAttachmentDataUrl,
  validateChatAttachment,
  validatePersistedChatAttachmentDescriptor,
} from '@kontourai/station-contracts/chat-attachment';

const STAGE_TTL_MS = 10 * 60 * 1000;
const STAGE_ID_PREFIX = 'stage_';
const STAGE_UPLOAD_METHOD = 'PUT';
const MAX_STAGES_PER_OWNER = 5;
const MAX_STAGED_BYTES_PER_OWNER = 15 * 1024 * 1024;
const ACCEPTED_TOMBSTONE_TTL_MS = 10 * 60 * 1000;

export interface AttachmentStageDescriptor {
  clientAttachmentId: string;
  kind: ChatAttachmentKind;
  name: string;
  mimeType: ChatAttachmentMimeType;
  size: number;
}

export interface AttachmentStageOwner {
  principalId: string;
  tenantId?: string;
}

interface StageRecord extends AttachmentStageDescriptor {
  owner: AttachmentStageOwner;
  /** SHA-256 of the sole bearer capability; plaintext never rests in memory. */
  grantDigest: string;
  expiresAt: number;
  state: 'pending' | 'complete' | 'accepted' | 'cancelled';
  bytes?: Buffer;
  digest?: `sha256-${string}`;
  binding?: { threadId: string; clientTurnId: string };
  bindingExpiresAt?: number;
  retainedUntil?: number;
}

export class AttachmentStageError extends Error {
  constructor(
    readonly code:
      | 'stage_not_found'
      | 'stage_expired'
      | 'stage_forbidden'
      | 'stage_grant_invalid'
      | 'stage_cancelled'
      | 'stage_incomplete'
      | 'stage_invalid_upload'
      | 'stage_capacity',
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentStageError';
  }
}

/**
 * Short-lived, owner-bound upload staging for the current Station only.
 *
 * This is intentionally an in-memory capability store: a restart invalidates
 * incomplete uploads instead of turning the composer into a durable blob queue.
 * The service projects references only; grants and bytes never leave its methods
 * except at the explicit upload/hydration boundaries.
 */
export class AttachmentStagingService {
  readonly #stages = new Map<string, StageRecord>();
  /** Reconnect can honestly distinguish expiry from an unknown id without retaining bytes or grants. */
  readonly #expired = new Map<
    string,
    { owner: AttachmentStageOwner; until: number }
  >();
  readonly #sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = STAGE_TTL_MS,
    sweepIntervalMs = 60_000,
  ) {
    // Startup performs the same deterministic sweep as the timer. In-memory
    // pending bytes never survive a process restart; retained records do not
    // rely on a later prepare/reconcile call to release capacity.
    this.cleanup();
    this.#sweepTimer = setInterval(() => this.cleanup(), sweepIntervalMs);
    this.#sweepTimer.unref?.();
  }

  dispose(): void {
    clearInterval(this.#sweepTimer);
  }

  prepare(
    owner: AttachmentStageOwner,
    descriptor: AttachmentStageDescriptor,
  ): AttachmentStagingPreparation {
    this.cleanup();
    const existing = [...this.#stages.entries()].find(
      ([, stage]) =>
        sameOwner(stage.owner, owner) &&
        stage.clientAttachmentId === descriptor.clientAttachmentId &&
        stage.state !== 'cancelled',
    );
    if (existing) {
      const [stageId, record] = existing;
      if (!sameDescriptor(record, descriptor)) {
        throw new AttachmentStageError(
          'stage_invalid_upload',
          'Attachment identity was reused for different data.',
        );
      }
      if (record.state !== 'pending') {
        throw new AttachmentStageError(
          'stage_incomplete',
          'Attachment staging is already complete.',
        );
      }
      return preparationOf(stageId, record, this.issueGrant(stageId, record));
    }
    if (
      [...this.#stages.values()].filter(
        (stage) =>
          sameOwner(stage.owner, owner) &&
          (stage.state === 'pending' || stage.state === 'complete'),
      ).length >= MAX_STAGES_PER_OWNER
    ) {
      throw new AttachmentStageError(
        'stage_capacity',
        'Too many attachment uploads are pending.',
      );
    }
    const error = validatePersistedChatAttachmentDescriptor(descriptor);
    if (error) throw new AttachmentStageError('stage_invalid_upload', error);
    const stageId = `${STAGE_ID_PREFIX}${randomUUID()}`;
    const expiresAt = this.now() + this.ttlMs;
    const record: StageRecord = {
      ...descriptor,
      owner,
      grantDigest: '',
      expiresAt,
      state: 'pending',
    };
    this.#stages.set(stageId, record);
    return preparationOf(stageId, record, this.issueGrant(stageId, record));
  }

  upload(
    stageId: string,
    grant: string,
    dataUrl: string,
  ): StagedAttachmentReference {
    const record = this.requireGrant(stageId, grant);
    if (record.state !== 'pending') {
      throw new AttachmentStageError(
        record.state === 'cancelled' ? 'stage_cancelled' : 'stage_incomplete',
        'Attachment staging is not accepting another upload.',
      );
    }
    const attachment: ChatAttachmentInput = {
      ...descriptorOf(record),
      dataUrl,
    };
    const error = validateChatAttachment(attachment);
    if (error) throw new AttachmentStageError('stage_invalid_upload', error);
    const parsed = parseChatAttachmentDataUrl(dataUrl);
    if (!parsed) {
      throw new AttachmentStageError(
        'stage_invalid_upload',
        'Attachment data is invalid.',
      );
    }
    const occupied = [...this.#stages.values()]
      .filter(
        (stage) =>
          sameOwner(stage.owner, record.owner) && stage.state === 'complete',
      )
      .reduce((total, stage) => total + (stage.bytes?.byteLength ?? 0), 0);
    if (occupied + record.size > MAX_STAGED_BYTES_PER_OWNER) {
      throw new AttachmentStageError(
        'stage_capacity',
        'Attachment staging capacity is full.',
      );
    }
    record.bytes = Buffer.from(parsed.base64, 'base64');
    record.digest = `sha256-${createHash('sha256').update(record.bytes).digest('hex')}`;
    record.state = 'complete';
    // The grant is one-use. A retry asks for a fresh stage rather than granting
    // a second body write after the caller has received a completed receipt.
    record.grantDigest = '';
    return referenceOf(stageId, record);
  }

  reconcile(
    owner: AttachmentStageOwner,
    stageIds: readonly string[],
  ): AttachmentStagingStatus[] {
    this.cleanup();
    return stageIds.map((stageId) => {
      const record = this.#stages.get(stageId);
      if (!record) {
        const expired = this.#expired.get(stageId);
        return expired && sameOwner(expired.owner, owner)
          ? { stageId, state: 'expired' }
          : { stageId, state: 'missing' };
      }
      if (!sameOwner(record.owner, owner)) return { stageId, state: 'missing' };
      if (record.state === 'cancelled') return { stageId, state: 'cancelled' };
      if (record.state === 'pending') {
        return {
          stageId,
          state: 'pending',
          expiresAt: new Date(record.expiresAt).toISOString(),
        };
      }
      if (record.state === 'complete') {
        return {
          stageId,
          state: 'complete',
          reference: referenceOf(stageId, record),
        };
      }
      return {
        stageId,
        state: 'accepted',
        expiresAt: new Date(
          record.retainedUntil ?? record.expiresAt,
        ).toISOString(),
      };
    });
  }

  /**
   * Called only after the provider accepted the exact bound turn. The raw
   * bytes are no longer active staging capacity; the bounded tombstone keeps
   * the binding visible for idempotency/reconnect without retaining content.
   */
  acceptBinding(
    owner: AttachmentStageOwner,
    references: readonly StagedAttachmentReference[],
    binding: { threadId: string; clientTurnId: string },
  ): void {
    this.cleanup();
    const records = references.map((reference) => {
      const record = this.require(owner, reference.stageId);
      if (
        record.state !== 'complete' ||
        !record.binding ||
        record.binding.threadId !== binding.threadId ||
        record.binding.clientTurnId !== binding.clientTurnId ||
        !sameReference(reference, referenceOf(reference.stageId, record))
      ) {
        throw new AttachmentStageError(
          'stage_forbidden',
          'Attachment reference is not valid for this accepted turn.',
        );
      }
      return record;
    });
    const retainedUntil = this.now() + ACCEPTED_TOMBSTONE_TTL_MS;
    for (const record of records) {
      record.bytes = undefined;
      record.grantDigest = '';
      record.state = 'accepted';
      record.retainedUntil = retainedUntil;
    }
  }

  cancel(owner: AttachmentStageOwner, stageId: string): void {
    const record = this.require(owner, stageId);
    record.state = 'cancelled';
    record.grantDigest = '';
    record.bytes = undefined;
    record.digest = undefined;
  }

  /**
   * Atomically bind completed references to the resolved foreground turn, then
   * hydrate them. A reference may never move to another turn, including a
   * retry whose client turn identity changed.
   */
  bindAndHydrate(
    owner: AttachmentStageOwner,
    references: readonly StagedAttachmentReference[],
    binding: { threadId: string; clientTurnId: string },
  ): ChatAttachmentInput[] {
    this.cleanup();
    const records = references.map((reference) => {
      const record = this.require(owner, reference.stageId);
      if (record.state !== 'complete' || !record.bytes || !record.digest) {
        throw new AttachmentStageError(
          'stage_incomplete',
          'Attachment staging is not complete.',
        );
      }
      const expected = referenceOf(reference.stageId, record);
      if (
        expected.clientAttachmentId !== reference.clientAttachmentId ||
        expected.source !== reference.source ||
        expected.digest !== reference.digest ||
        expected.kind !== reference.kind ||
        expected.name !== reference.name ||
        expected.mimeType !== reference.mimeType ||
        expected.size !== reference.size
      ) {
        throw new AttachmentStageError(
          'stage_forbidden',
          'Attachment reference is not valid for this upload.',
        );
      }
      if (
        record.binding &&
        (record.binding.threadId !== binding.threadId ||
          record.binding.clientTurnId !== binding.clientTurnId)
      ) {
        throw new AttachmentStageError(
          'stage_forbidden',
          'Attachment reference is already bound to another turn.',
        );
      }
      return record;
    });
    // All references are validated before any binding changes, so a bad
    // sibling cannot leave a legal partial batch attached to a turn.
    for (const record of records) {
      record.binding = { ...binding };
      record.bindingExpiresAt = this.now() + this.ttlMs;
    }
    return records.map((record) => {
      return {
        ...descriptorOf(record),
        dataUrl: `data:${record.mimeType};base64,${record.bytes!.toString('base64')}`,
      };
    });
  }

  cleanup(): void {
    const now = this.now();
    for (const [stageId, record] of this.#stages) {
      if (
        ((record.state === 'pending' ||
          (record.state === 'complete' &&
            (!record.binding ||
              (record.bindingExpiresAt !== undefined &&
                record.bindingExpiresAt <= now)))) &&
          record.expiresAt <= now) ||
        (record.state === 'accepted' &&
          (record.retainedUntil ?? record.expiresAt) <= now)
      ) {
        this.#stages.delete(stageId);
        this.#expired.set(stageId, {
          owner: record.owner,
          until: now + this.ttlMs,
        });
      }
    }
    for (const [stageId, expired] of this.#expired) {
      if (expired.until <= now) this.#expired.delete(stageId);
    }
  }

  private require(owner: AttachmentStageOwner, stageId: string): StageRecord {
    const record = this.#stages.get(stageId);
    if (!record)
      throw new AttachmentStageError(
        'stage_not_found',
        'Attachment staging is unavailable.',
      );
    if (
      (record.state === 'pending' ||
        (record.state === 'complete' &&
          (!record.binding ||
            (record.bindingExpiresAt !== undefined &&
              record.bindingExpiresAt <= this.now())))) &&
      record.expiresAt <= this.now()
    ) {
      this.#stages.delete(stageId);
      this.#expired.set(stageId, {
        owner: record.owner,
        until: this.now() + this.ttlMs,
      });
      throw new AttachmentStageError(
        'stage_expired',
        'Attachment staging expired.',
      );
    }
    if (!sameOwner(record.owner, owner))
      throw new AttachmentStageError(
        'stage_forbidden',
        'Attachment staging is unavailable.',
      );
    return record;
  }

  private requireGrant(stageId: string, grant: string): StageRecord {
    const record = this.#stages.get(stageId);
    if (!record || record.expiresAt <= this.now()) {
      throw new AttachmentStageError(
        'stage_expired',
        'Attachment staging expired.',
      );
    }
    if (
      !grantsEqual(
        record.grantDigest,
        grantDigest(stageId, record.expiresAt, grant),
      )
    ) {
      throw new AttachmentStageError(
        'stage_grant_invalid',
        'Attachment upload authority is invalid.',
      );
    }
    return record;
  }

  private issueGrant(stageId: string, record: StageRecord): string {
    const grant = randomBytes(32).toString('base64url');
    record.grantDigest = grantDigest(stageId, record.expiresAt, grant);
    return grant;
  }
}

function sameOwner(left: AttachmentStageOwner, right: AttachmentStageOwner) {
  return (
    left.principalId === right.principalId && left.tenantId === right.tenantId
  );
}

function grantsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function grantDigest(
  stageId: string,
  expiresAt: number,
  grant: string,
): string {
  // Field delimiters make stage, method, and expiry distinct inputs; comparison
  // remains timing-safe in grantsEqual().
  return createHash('sha256')
    .update(
      `${STAGE_UPLOAD_METHOD}\u0000${stageId}\u0000${expiresAt}\u0000${grant}`,
    )
    .digest('hex');
}

function sameDescriptor(
  left: AttachmentStageDescriptor,
  right: AttachmentStageDescriptor,
): boolean {
  return (
    left.kind === right.kind &&
    left.name === right.name &&
    left.mimeType === right.mimeType &&
    left.size === right.size
  );
}

function sameReference(
  left: StagedAttachmentReference,
  right: StagedAttachmentReference,
): boolean {
  return (
    left.stageId === right.stageId &&
    left.clientAttachmentId === right.clientAttachmentId &&
    left.source === right.source &&
    left.digest === right.digest &&
    left.kind === right.kind &&
    left.name === right.name &&
    left.mimeType === right.mimeType &&
    left.size === right.size
  );
}

function preparationOf(
  stageId: string,
  record: StageRecord,
  uploadGrant: string,
): AttachmentStagingPreparation {
  return {
    stageId,
    uploadGrant,
    expiresAt: new Date(record.expiresAt).toISOString(),
    ...descriptorOf(record),
  };
}

function descriptorOf(
  record: AttachmentStageDescriptor,
): AttachmentStageDescriptor {
  return {
    clientAttachmentId: record.clientAttachmentId,
    kind: record.kind,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
  };
}

function referenceOf(
  stageId: string,
  record: StageRecord,
): StagedAttachmentReference {
  if (!record.digest)
    throw new AttachmentStageError(
      'stage_incomplete',
      'Attachment staging is not complete.',
    );
  return {
    stageId,
    source: 'current-composer',
    ...descriptorOf(record),
    digest: record.digest,
    expiresAt: new Date(record.expiresAt).toISOString(),
  };
}
