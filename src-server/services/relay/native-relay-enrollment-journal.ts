import type { DatabaseSync } from 'node:sqlite';
import { isPrincipalRef } from '@kontourai/station-contracts/principal';
import { z } from 'zod';
import { openPrivateSqlite } from '../../utils/private-sqlite.js';
import {
  nativeEnrollmentBindingSchema,
  nativeEnrollmentCandidateSchema,
  nativeEnrollmentOpaque,
} from '../identity/native-relay-enrollment-schema.js';

const states = [
  'challenge',
  'provider-creating',
  'provider-pending',
  'requested',
  'approved',
  'device-pending',
  'awaiting-ack',
  'activating',
  'committed',
  'cleaning',
  'cancelled',
  'expired',
  'failed',
] as const;
const recordSchema = z
  .object({
    binding: nativeEnrollmentBindingSchema,
    clientAttemptId: nativeEnrollmentOpaque,
    recipientExpiresAt: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    nonce: nativeEnrollmentOpaque,
    state: z.enum(states),
    createdAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    candidate: nativeEnrollmentCandidateSchema.optional(),
    loginIdentity: z.string().min(1).max(512).optional(),
    providerSessionId: z.string().min(1).max(512).optional(),
    issuer: z.string().min(1).max(2048).optional(),
    subject: z.string().min(1).max(512).optional(),
    displayName: z.string().max(512).optional(),
    offerId: z.string().min(1).max(512).optional(),
    offerProof: z.string().min(1).max(2048).optional(),
    requestId: z.string().min(1).max(512).optional(),
    approvalId: z.string().max(512).optional(),
    approvedBy: z
      .string()
      .min(1)
      .max(512)
      .refine((id) =>
        isPrincipalRef({ kind: 'human', id, display: 'approver' }),
      )
      .optional(),
    activationNonce: nativeEnrollmentOpaque.optional(),
    bundleDigest: nativeEnrollmentOpaque.optional(),
    ackDigest: nativeEnrollmentOpaque.optional(),
    receiptExpiresAt: z.number().int().positive().optional(),
  })
  .strict();
export type NativeEnrollmentRecord = z.infer<typeof recordSchema>;
export type NativeEnrollmentState = NativeEnrollmentRecord['state'];
type NativeEnrollmentPatch = Partial<
  Omit<
    NativeEnrollmentRecord,
    | 'binding'
    | 'clientAttemptId'
    | 'recipientExpiresAt'
    | 'nonce'
    | 'state'
    | 'createdAt'
    | 'expiresAt'
  >
>;
const TABLE =
  'CREATE TABLE native_enrollments (enrollment_id TEXT PRIMARY KEY, client_attempt_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL) STRICT';
const PROOFS =
  'CREATE TABLE native_enrollment_proofs (jti TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, expires_at INTEGER NOT NULL) STRICT';
const OWNER =
  'CREATE TABLE native_enrollment_owner (station_id TEXT PRIMARY KEY) STRICT';

/** Private crash-safe lifecycle and replay state. Device credentials are never persisted here. */
export class NativeRelayEnrollmentJournal {
  readonly #db: DatabaseSync;
  #closed = false;
  constructor(
    path: string,
    readonly stationId: string,
  ) {
    this.#db = openPrivateSqlite(path, 'NativeRelayEnrollmentJournal');
    try {
      const schema = this.#db
        .prepare(
          "SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      if (!schema.length) {
        this.#db.exec(`${TABLE};${PROOFS};${OWNER};`);
        this.#db
          .prepare('INSERT INTO native_enrollment_owner VALUES(?)')
          .run(stationId);
      } else if (
        schema.length !== 3 ||
        schema[0]?.sql !== OWNER ||
        schema[1]?.sql !== PROOFS ||
        schema[2]?.sql !== TABLE
      )
        throw new Error('native_enrollment_journal_invalid');
      const owners = this.#db
        .prepare('SELECT station_id FROM native_enrollment_owner')
        .all();
      if (owners.length !== 1 || owners[0]?.station_id !== stationId)
        throw new Error('native_enrollment_journal_owner_invalid');
      if (this.#db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
        throw new Error('native_enrollment_journal_invalid');
      this.list();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  #transaction<T>(operation: () => T): T {
    if (this.#closed) throw new Error('native_enrollment_journal_closed');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  #parse(
    row: Record<string, unknown> | undefined,
  ): NativeEnrollmentRecord | undefined {
    if (!row) return undefined;
    if (typeof row.record !== 'string' || row.record.length > 16384)
      throw new Error('native_enrollment_journal_invalid');
    const record = recordSchema.parse(JSON.parse(row.record));
    if (
      record.binding.stationId !== this.stationId ||
      record.binding.enrollmentId !== row.enrollment_id ||
      record.clientAttemptId !== row.client_attempt_id
    )
      throw new Error('native_enrollment_journal_invalid');
    return record;
  }
  get(id: string): NativeEnrollmentRecord | undefined {
    if (this.#closed) throw new Error('native_enrollment_journal_closed');
    return this.#parse(
      this.#db
        .prepare('SELECT * FROM native_enrollments WHERE enrollment_id=?')
        .get(id),
    );
  }
  byClientAttempt(id: string): NativeEnrollmentRecord | undefined {
    if (this.#closed) throw new Error('native_enrollment_journal_closed');
    return this.#parse(
      this.#db
        .prepare('SELECT * FROM native_enrollments WHERE client_attempt_id=?')
        .get(id),
    );
  }
  list(): NativeEnrollmentRecord[] {
    if (this.#closed) throw new Error('native_enrollment_journal_closed');
    const rows = this.#db
      .prepare('SELECT * FROM native_enrollments LIMIT 4097')
      .all();
    if (rows.length > 4096) throw new Error('native_enrollment_capacity');
    return rows
      .map((row) => this.#parse(row))
      .filter((value): value is NativeEnrollmentRecord => value !== undefined);
  }
  reserve(value: NativeEnrollmentRecord): void {
    const record = recordSchema.parse(value);
    if (record.binding.stationId !== this.stationId)
      throw new Error('native_enrollment_journal_invalid');
    this.#transaction(() => {
      const all = this.list();
      if (
        all.length >= 4096 ||
        all.filter(
          (v) =>
            !['committed', 'cancelled', 'expired', 'failed'].includes(v.state),
        ).length >= 32
      )
        throw new Error('native_enrollment_capacity');
      this.#db
        .prepare('INSERT INTO native_enrollments VALUES(?,?,?)')
        .run(
          record.binding.enrollmentId,
          record.clientAttemptId,
          JSON.stringify(record),
        );
    });
  }
  transition(
    id: string,
    expected: readonly NativeEnrollmentState[],
    state: NativeEnrollmentState,
    patch: NativeEnrollmentPatch = {},
  ): NativeEnrollmentRecord {
    return this.#transaction(() => {
      const old = this.get(id);
      if (!old || !expected.includes(old.state))
        throw new Error('native_enrollment_state_conflict');
      const next = recordSchema.parse({ ...old, ...patch, state });
      this.#db
        .prepare('UPDATE native_enrollments SET record=? WHERE enrollment_id=?')
        .run(JSON.stringify(next), id);
      return next;
    });
  }
  consumeProof(
    enrollmentId: string,
    jti: string,
    expiresAt: number,
    now: number,
  ): void {
    nativeEnrollmentOpaque.parse(jti);
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt - now > 35000
    )
      throw new Error('native_enrollment_proof_invalid');
    this.#transaction(() => {
      this.#db
        .prepare('DELETE FROM native_enrollment_proofs WHERE expires_at<=?')
        .run(now);
      const count = this.#db
        .prepare('SELECT count(*) AS count FROM native_enrollment_proofs')
        .get()?.count;
      if (typeof count !== 'number' || count >= 4096)
        throw new Error('native_enrollment_capacity');
      if (
        this.#db
          .prepare('SELECT jti FROM native_enrollment_proofs WHERE jti=?')
          .get(jti)
      )
        throw new Error('native_enrollment_proof_replayed');
      this.#db
        .prepare('INSERT INTO native_enrollment_proofs VALUES(?,?,?)')
        .run(jti, enrollmentId, expiresAt);
    });
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
