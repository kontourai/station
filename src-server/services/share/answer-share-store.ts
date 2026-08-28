import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ANSWER_SHARE_CAPACITY_MESSAGE,
  ANSWER_SHARE_DEFAULT_TTL_MS,
  ANSWER_SHARE_LABEL_MAX_LENGTH,
  ANSWER_SHARE_MAX_RECORDS,
  ANSWER_SHARE_MAX_TTL_MS,
  ANSWER_SHARE_TOKEN_BYTES,
  ANSWER_SHARE_TOKEN_PATTERN,
  type AnswerShareChannelBinding,
  type AnswerShareSummary,
} from '@kontourai/station-contracts/answer-share';
import {
  ANSWER_SHARE_CHANNEL_BINDING_KEYS,
  ANSWER_SHARE_CHANNEL_COORDINATE_KEYS,
  validateAnswerShareChannelBinding,
} from '@kontourai/station-contracts/answer-share-channel';
import { isPlainJsonObject } from '@kontourai/station-contracts/channel-assurance';
import { findChannelForbiddenKeys } from '@kontourai/station-contracts/channel-log';
import { resolveAnswerShareState } from '@kontourai/station-shared/answer-share-projection';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';

/**
 * Answer-share store (archive#1423) — the durable half of Station's first
 * sharing primitive.
 *
 * Secret-bearing, so it takes the same hardening as `peer-credentials.json`
 * and `paired-devices.json`: private directory and file modes, symlink and
 * hardlink rejection on read, and an `O_EXCL|O_NOFOLLOW` temp file that is
 * fsynced and renamed into place with the containing directory fsynced after.
 *
 * Two properties this store exists to hold, both of which the tests pin:
 *
 * 1. **The token is never stored.** Only `tokenHash`, a SHA-256 hex digest,
 *    which is also the ONLY lookup key a viewer's request can reach. There is
 *    no id-plus-secret split to probe: a caller either presents a token that
 *    hashes to a stored record or they do not, and both outcomes cost the
 *    same single map lookup. `id` exists solely so the operator's own
 *    management surface can name a share without holding its capability.
 *
 * 2. **Revocation is a tombstone, not a delete** (`DevicePairingService`'s
 *    shape). A deleted record would make a revoked share indistinguishable
 *    from one that never existed, which is exactly the ambiguity archive#1423 asks
 *    the surface to remove for a holder who has proven possession.
 */

/**
 * The STORE DOCUMENT's version — distinct from `ANSWER_SHARE_SCHEMA_VERSION`,
 * which versions the viewer payload. Gated by exact equality below, so a
 * mismatch is a hard refusal.
 *
 * **archive#1598 added two fields and deliberately did NOT bump this.** Both
 * are optional and absent-tolerant, so every existing `answer-shares.json`
 * stays valid byte for byte. Bumping it would be actively harmful: an invalid
 * document throws from the constructor, which runs during route
 * configuration, so it fails the whole runtime boot (recorded residual L-5 in
 * `docs/design/answer-share-permalinks.md` §8). A required new field would
 * therefore take every existing home down on upgrade, to record something no
 * existing record could possibly have.
 */
const SCHEMA_VERSION = 1 as const;
const DIRECTORY = 'security';
const FILE = 'answer-shares.json';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_ID_LENGTH = 200;
/** SHA-256, lowercase hex. */
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Internal-only record. `tokenHash` never leaves this module. */
export interface StoredAnswerShare {
  id: string;
  tokenHash: string;
  sessionId: string;
  turnId: string;
  /**
   * The Station user who minted the share. Carried so the view path can
   * re-apply that user's own read authorization over the session: a share
   * must never outlive the sharer's own standing on the answer.
   */
  ownerUserId: string | null;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  /**
   * Where this answer sat in a channel log **when the share was minted**
   * (archive#1598).
   *
   * `undefined` is a THIRD state, not a missing value: the record was minted
   * before this Station recorded bindings, so nothing was observed. It is not
   * `{ binding: 'none' }`, which is the positive observation "this answer has
   * no channel coordinate". Nothing backfills it — a retroactive binding is a
   * derived claim wearing a recorded claim's name.
   */
  channel?: AnswerShareChannelBinding;
  /**
   * SHA-256 hex over the canonicalized blocks that were SERVED at mint time
   * (archive#1598), and the sole authority for the words a view may show.
   * `undefined` on a record minted before digests existed, which resolves
   * exactly as it did then.
   */
  contentDigest?: string;
}

interface AnswerShareDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  shares: StoredAnswerShare[];
}

export class AnswerShareStoreError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'share_not_found' | 'capacity_reached',
    message: string,
  ) {
    super(message);
    this.name = 'AnswerShareStoreError';
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function safeId(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new AnswerShareStoreError('invalid_request', `${field} is invalid`);
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_ID_LENGTH ||
    hasControlCharacters(trimmed)
  ) {
    throw new AnswerShareStoreError('invalid_request', `${field} is invalid`);
  }
  return trimmed;
}

function safeLabel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new AnswerShareStoreError('invalid_request', 'label is invalid');
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (
    trimmed.length > ANSWER_SHARE_LABEL_MAX_LENGTH ||
    hasControlCharacters(trimmed)
  ) {
    throw new AnswerShareStoreError('invalid_request', 'label is invalid');
  }
  return trimmed;
}

function safeTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new AnswerShareStoreError('invalid_request', `${field} is invalid`);
  }
  return value;
}

function safeTokenHash(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN_HASH_PATTERN.test(value)) {
    throw new AnswerShareStoreError('invalid_request', 'tokenHash is invalid');
  }
  return value;
}

/** SHA-256, lowercase hex — the same shape `TOKEN_HASH_PATTERN` asserts. */
const CONTENT_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Drops every key this build does not recognise, at the binding root and
 * inside the coordinate.
 *
 * The key vocabulary is imported from the contract rather than restated, so
 * a field added there is recognised here on the same commit.
 *
 * `ref` is deliberately NOT pruned. Its keys are slice 1's contract, and the
 * one extra key that matters there — a `seq` — is a semantic violation with
 * its own coded refusal (`parent-position-not-identity`), not a field from a
 * newer build. Pruning it would delete a real refusal.
 */
function prunedChannelBinding(value: unknown): unknown {
  if (!isPlainJsonObject(value)) return value;
  const pruned: Record<string, unknown> = {};
  for (const key of ANSWER_SHARE_CHANNEL_BINDING_KEYS) {
    if (Object.hasOwn(value, key)) pruned[key] = value[key];
  }
  const coordinate = pruned.coordinate;
  if (isPlainJsonObject(coordinate)) {
    const prunedCoordinate: Record<string, unknown> = {};
    for (const key of ANSWER_SHARE_CHANNEL_COORDINATE_KEYS) {
      if (Object.hasOwn(coordinate, key)) {
        prunedCoordinate[key] = coordinate[key];
      }
    }
    pruned.coordinate = prunedCoordinate;
  }
  return pruned;
}

/**
 * Re-maps a stored channel binding field by field after validating it.
 *
 * Three steps, and each is a different kind of refusal:
 *
 *  1. **Prototype-affecting keys are refused outright**, through slice 1's
 *     own sweep so this store cannot carry a second copy of the list. A
 *     `__proto__` member in `answer-shares.json` is tampering, not a field
 *     from a newer build, and the forward-compatibility argument below does
 *     not cover it.
 *  2. **Unrecognised keys are DROPPED**, which is this module's allowlist
 *     discipline applied to the binding exactly as `validateDocument` applies
 *     it to every other field of a stored share. Refusing them instead would
 *     invert that discipline in one place with an outsized blast radius: this
 *     function is reached from `#read()`, which runs in the
 *     `AnswerShareStore` constructor during route configuration, so a share
 *     minted by a newer Station carrying one extra binding field would stop
 *     an older Station from BOOTING — over a field that only affects sharing.
 *     A downgrade, or one older build pointed at the same `~/.station`, is
 *     the ordinary way to reach that. The strict contract still refuses the
 *     same key everywhere strictness is free: `validateAnswerShareChannelBinding`
 *     is unchanged and the fixture corpus keeps asserting deny-by-default.
 *  3. **Recognised fields keep their strict validation.** A bad TYPE still
 *     throws, a positional `ref` still throws, and a `none` binding carrying
 *     a `coordinate` still throws — that key is recognised, merely in the
 *     wrong place, and dropping it would turn a self-contradictory record
 *     into the affirmative claim "this answer is in no channel". Nothing here
 *     degrades a malformed binding into `{ binding: 'none' }`, and nothing
 *     here invents a new unavailable reason: a binding this store cannot read
 *     fails closed.
 *
 * The explicit re-map that follows is the outbound half of the same rule:
 * anything not named there does not survive a read, so nothing can ride back
 * out through `#write`.
 */
function safeChannelBinding(value: unknown): AnswerShareChannelBinding {
  if (isPlainJsonObject(value)) {
    const forbidden = findChannelForbiddenKeys(value, 'channel');
    if (forbidden.length > 0) {
      throw new AnswerShareStoreError(
        'invalid_request',
        `channel is invalid: ${forbidden.map((d) => d.message).join('; ')}`,
      );
    }
  }
  const result = validateAnswerShareChannelBinding(prunedChannelBinding(value));
  if (!result.ok) {
    throw new AnswerShareStoreError(
      'invalid_request',
      `channel is invalid: ${result.errors.join('; ')}`,
    );
  }
  const binding = result.record;
  if (binding.binding === 'none') return { binding: 'none' };
  return {
    binding: 'committed',
    ref: { refKind: binding.ref.refKind, id: binding.ref.id },
    coordinate: {
      channelId: binding.coordinate.channelId,
      epoch: binding.coordinate.epoch,
      seq: binding.coordinate.seq,
    },
    checkpointDigest: binding.checkpointDigest,
  };
}

function safeContentDigest(value: unknown): string {
  if (typeof value !== 'string' || !CONTENT_DIGEST_PATTERN.test(value)) {
    throw new AnswerShareStoreError(
      'invalid_request',
      'contentDigest is invalid',
    );
  }
  return value;
}

function validateDocument(value: unknown): AnswerShareDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AnswerShareStoreError(
      'invalid_request',
      'Invalid answer-share store',
    );
  }
  const record = value as Partial<AnswerShareDocument>;
  if (
    record.schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray(record.shares)
  ) {
    throw new AnswerShareStoreError(
      'invalid_request',
      'Invalid answer-share store schema',
    );
  }
  const shares = record.shares.map(
    (share): StoredAnswerShare => ({
      id: safeId(share.id, 'id'),
      tokenHash: safeTokenHash(share.tokenHash),
      sessionId: safeId(share.sessionId, 'sessionId'),
      turnId: safeId(share.turnId, 'turnId'),
      ownerUserId:
        share.ownerUserId === null || share.ownerUserId === undefined
          ? null
          : safeId(share.ownerUserId, 'ownerUserId'),
      label: safeLabel(share.label),
      createdAt: safeTimestamp(share.createdAt, 'createdAt'),
      expiresAt: safeTimestamp(share.expiresAt, 'expiresAt'),
      revokedAt:
        share.revokedAt === null || share.revokedAt === undefined
          ? null
          : safeTimestamp(share.revokedAt, 'revokedAt'),
      // ABSENT-TOLERANT, and the spread is conditional for a reason: this
      // mapper is an allowlist RE-MAPPER, so a field it does not name is
      // silently dropped on every read AND on every write-back (`#write`
      // re-validates on the way out). A `channel` that were not mapped here
      // would survive until the first revoke and then vanish, which is the
      // worst shape a persistence bug can take. `undefined` must stay
      // ABSENT rather than become a key with an undefined value: an absent
      // field is "minted before bindings existed", and JSON.stringify would
      // drop the key anyway, so writing one would make the in-memory record
      // and the bytes on disk disagree.
      ...(share.channel === undefined
        ? {}
        : { channel: safeChannelBinding(share.channel) }),
      ...(share.contentDigest === undefined
        ? {}
        : { contentDigest: safeContentDigest(share.contentDigest) }),
    }),
  );
  if (new Set(shares.map((share) => share.tokenHash)).size !== shares.length) {
    throw new AnswerShareStoreError(
      'invalid_request',
      'Duplicate answer-share token hash',
    );
  }
  return { schemaVersion: SCHEMA_VERSION, shares };
}

/** SHA-256 hex of a presented token. The only key a viewer request resolves. */
export function answerShareTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

type AnswerShareWriteOperations = {
  closeSync: typeof closeSync;
  fsyncDirectorySync: typeof fsyncDirectorySync;
  fsyncSync: typeof fsyncSync;
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
  writeFileSync: typeof writeFileSync;
};

const answerShareWriteOperations: AnswerShareWriteOperations = {
  closeSync,
  fsyncDirectorySync,
  fsyncSync,
  renameSync,
  rmSync,
  writeFileSync,
};

export interface AnswerShareStoreOptions {
  homeDir: string;
  now?: () => number;
  maxRecords?: number;
  /** Injectable only for deterministic cross-process mutation tests. */
  acquireMutationLock?: AnswerShareMutationLock;
  /** Injectable only for durable-write fault-injection tests. */
  writeOperations?: Partial<AnswerShareWriteOperations>;
}

// Async-compatible seam (archive#2646): the default is the ASYNC cross-process lock
// so a contended acquisition yields the event loop; sync test fakes remain
// assignable (awaiting a non-promise is a no-op).
type AnswerShareMutationLock = (
  lockPath: string,
) => (() => void | Promise<void>) | Promise<() => void | Promise<void>>;

export class AnswerShareStore {
  readonly #directory: string;
  readonly #file: string;
  readonly #now: () => number;
  readonly #maxRecords: number;
  readonly #acquireMutationLock: AnswerShareMutationLock;
  readonly #writeOperations: AnswerShareWriteOperations;

  constructor(options: AnswerShareStoreOptions) {
    this.#directory = join(options.homeDir, DIRECTORY);
    this.#file = join(this.#directory, FILE);
    this.#now = options.now ?? Date.now;
    this.#maxRecords = options.maxRecords ?? ANSWER_SHARE_MAX_RECORDS;
    this.#acquireMutationLock =
      options.acquireMutationLock ?? acquireFileMutationLockAsync;
    this.#writeOperations = {
      ...answerShareWriteOperations,
      ...options.writeOperations,
    };
    this.#ensureDirectory();
    if (existsSync(this.#file)) this.#read();
  }

  /**
   * Mints a share and returns it together with the token, which is the only
   * time the token exists outside the caller's response. A lost permalink is
   * re-minted, never recovered.
   */
  async mint(input: {
    sessionId: string;
    turnId: string;
    ownerUserId?: string | null;
    label?: string;
    ttlMs?: number;
    /**
     * The mint-time channel observation (archive#1598). Absent means the
     * caller made no observation, and the record then reads as "predates
     * channel addressing" forever — so a caller that CAN observe must pass
     * one, including `{ binding: 'none' }`.
     */
    channel?: AnswerShareChannelBinding;
    /** SHA-256 hex over the canonicalized served blocks. */
    contentDigest?: string;
  }): Promise<{ record: StoredAnswerShare; token: string }> {
    const sessionId = safeId(input.sessionId, 'sessionId');
    const turnId = safeId(input.turnId, 'turnId');
    const label = safeLabel(input.label);
    // Validated at the door, not just on the way back in: a caller handing
    // this store a malformed binding must fail its own mint rather than
    // discover it on the next read of the whole file.
    const channel =
      input.channel === undefined
        ? undefined
        : safeChannelBinding(input.channel);
    const contentDigest =
      input.contentDigest === undefined
        ? undefined
        : safeContentDigest(input.contentDigest);
    const ownerUserId =
      input.ownerUserId === undefined || input.ownerUserId === null
        ? null
        : safeId(input.ownerUserId, 'ownerUserId');
    // A non-finite or non-positive ttl is a caller bug, not a request for the
    // default: silently substituting one would mint a share whose lifetime is
    // not the one that was asked for.
    if (
      input.ttlMs !== undefined &&
      (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0)
    ) {
      throw new AnswerShareStoreError('invalid_request', 'ttlMs is invalid');
    }
    const ttlMs = Math.min(
      input.ttlMs ?? ANSWER_SHARE_DEFAULT_TTL_MS,
      ANSWER_SHARE_MAX_TTL_MS,
    );

    return this.#mutate((document) => {
      if (document.shares.length >= this.#maxRecords) {
        throw new AnswerShareStoreError(
          'capacity_reached',
          ANSWER_SHARE_CAPACITY_MESSAGE,
        );
      }

      const now = this.#now();
      const token = randomBytes(ANSWER_SHARE_TOKEN_BYTES).toString('base64url');
      /* c8 ignore next 6 -- a 256-bit token cannot collide in practice; the
         guard exists so a future shorter token or a broken RNG fails loudly
         rather than overwriting a live capability. */
      if (!ANSWER_SHARE_TOKEN_PATTERN.test(token)) {
        throw new AnswerShareStoreError(
          'invalid_request',
          'Minted token did not match the declared token shape',
        );
      }
      const record: StoredAnswerShare = {
        id: randomUUID(),
        tokenHash: answerShareTokenHash(token),
        sessionId,
        turnId,
        ownerUserId,
        label,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
        revokedAt: null,
        ...(channel === undefined ? {} : { channel }),
        ...(contentDigest === undefined ? {} : { contentDigest }),
      };
      return {
        result: { record, token },
        next: {
          schemaVersion: SCHEMA_VERSION,
          shares: [...document.shares, record],
        },
      };
    });
  }

  /** Operator-facing list, newest first. Never carries a token or its hash. */
  list(): AnswerShareSummary[] {
    const now = this.#now();
    return this.#read()
      .shares.map((share) => toSummary(share, now))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /**
   * Resolves a presented token to its record, or `undefined`.
   *
   * A single hash-keyed lookup: an unknown token, a mistyped one, and a
   * malformed one all take the same path and cost the same work, so nothing
   * here distinguishes "no such share" from "wrong token for a real share".
   * Revoked and expired records ARE returned — deciding what to say about
   * them is the caller's job, and it can only say it to someone who proved
   * possession by getting here at all.
   */
  resolveByToken(token: string): StoredAnswerShare | undefined {
    if (typeof token !== 'string' || !ANSWER_SHARE_TOKEN_PATTERN.test(token)) {
      return undefined;
    }
    const hash = answerShareTokenHash(token);
    return this.#read().shares.find((share) => share.tokenHash === hash);
  }

  /**
   * Revokes by the operator-facing id. Idempotent — re-revoking returns the
   * existing tombstone rather than moving `revokedAt`, so the record keeps
   * saying when access actually ended.
   */
  async revoke(id: string): Promise<AnswerShareSummary> {
    return this.#mutate((document) => {
      const existing = document.shares.find((share) => share.id === id);
      if (!existing) {
        throw new AnswerShareStoreError('share_not_found', 'Share not found');
      }
      const now = this.#now();
      if (existing.revokedAt !== null) {
        return { result: toSummary(existing, now) };
      }
      const revoked: StoredAnswerShare = {
        ...existing,
        revokedAt: new Date(now).toISOString(),
      };
      return {
        result: toSummary(revoked, now),
        next: {
          schemaVersion: SCHEMA_VERSION,
          shares: document.shares.map((share) =>
            share.id === id ? revoked : share,
          ),
        },
      };
    });
  }

  /**
   * Serializes each complete state transition across Station processes. The
   * fresh read deliberately belongs inside this critical section: reading
   * before acquiring it would let a later mint overwrite a completed
   * revocation tombstone or admit past the record ceiling.
   */
  async #mutate<T>(
    mutation: (document: AnswerShareDocument) => {
      result: T;
      next?: AnswerShareDocument;
    },
  ): Promise<T> {
    const release = await this.#acquireMutationLock(`${this.#file}.mutation`);
    try {
      const outcome = mutation(this.#read());
      if (outcome.next) this.#write(outcome.next);
      return outcome.result;
    } finally {
      await release();
    }
  }

  #ensureDirectory(): void {
    mkdirSync(this.#directory, { recursive: true, mode: DIRECTORY_MODE });
    const status = lstatSync(this.#directory);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error('Invalid answer-share directory');
    }
    if (process.platform !== 'win32' && (status.mode & 0o077) !== 0) {
      throw new Error('Unsafe answer-share directory permissions');
    }
  }

  #read(): AnswerShareDocument {
    if (!existsSync(this.#file)) {
      return { schemaVersion: SCHEMA_VERSION, shares: [] };
    }
    const status = lstatSync(this.#file);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1 ||
      (process.platform !== 'win32' && (status.mode & 0o777) !== FILE_MODE)
    ) {
      throw new Error('Unsafe answer-share store');
    }
    return validateDocument(JSON.parse(readFileSync(this.#file, 'utf8')));
  }

  #write(document: AnswerShareDocument): void {
    const payload = `${JSON.stringify(validateDocument(document))}\n`;
    const temporary = join(
      dirname(this.#file),
      `.${FILE}.${process.pid}.${randomUUID()}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        FILE_MODE,
      );
      if (process.platform !== 'win32') fchmodSync(descriptor, FILE_MODE);
      this.#writeOperations.writeFileSync(descriptor, payload, 'utf8');
      this.#writeOperations.fsyncSync(descriptor);
      this.#writeOperations.closeSync(descriptor);
      descriptor = undefined;
      this.#writeOperations.renameSync(temporary, this.#file);
      // The atomic rename is the commit point. Once it succeeds the caller
      // must receive its minted token/revocation result: a later directory
      // sync or cleanup error cannot roll the visible document back, and
      // reporting failure would strand an unreturned live capability.
      try {
        this.#writeOperations.fsyncDirectorySync(this.#directory);
      } catch {
        // The replacement is committed; retain its truthful success result.
      }
    } finally {
      // Cleanup is deliberately independent: a close failure must not skip
      // temp removal, and neither cleanup failure may mask a pre-commit
      // write/fsync/close/rename exception. After commit they are likewise
      // unable to turn a successful mutation into a false failure.
      if (descriptor !== undefined) {
        try {
          this.#writeOperations.closeSync(descriptor);
        } catch {
          // Preserve an earlier primary failure or the committed result.
        }
      }
      try {
        this.#writeOperations.rmSync(temporary, { force: true });
      } catch {
        // See the commit-point contract above.
      }
    }
  }
}

/**
 * The operator-facing projection. Drops `tokenHash` as well as the token: a
 * digest in a list response is an offline-guessable handle to a live
 * capability, and the operator never needs it to name or revoke a share.
 */
export function toSummary(
  record: StoredAnswerShare,
  now: number,
): AnswerShareSummary {
  return {
    id: record.id,
    sessionId: record.sessionId,
    turnId: record.turnId,
    ...(record.label === null ? {} : { label: record.label }),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.revokedAt === null ? {} : { revokedAt: record.revokedAt }),
    state: resolveAnswerShareState(record, now),
  };
}
