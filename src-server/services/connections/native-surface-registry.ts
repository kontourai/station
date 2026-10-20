import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isPrincipalRef } from '@kontourai/station-contracts/principal';
import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerNativeScopeV2,
} from '@kontourai/station-contracts/self-hosted-broker';
import { z } from 'zod';
import { RelayManagementApproval } from '../../security/relay-management-authority.js';
import { openPrivateSqlite } from '../../utils/private-sqlite.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../identity/principal-resolver.js';

const MAX_SURFACES = 16;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN = Symbol('native-surface-operator-approval');
const TABLE_SQL =
  'CREATE TABLE native_surfaces (approval_id TEXT PRIMARY KEY, surface_key TEXT NOT NULL UNIQUE, record TEXT NOT NULL) STRICT';
const META_SQL =
  'CREATE TABLE native_surface_owner (station_id TEXT PRIMARY KEY) STRICT';
const scopeSchema = z
  .object({
    stationId: z.string().regex(UUID),
    enrollmentId: z.string().regex(UUID),
    routingGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const surfaceSchema = z
  .object({
    kind: z.literal('station-native'),
    appIdentifier: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/u),
    channel: z.enum(['dev', 'stable', 'beta', 'nightly']),
    clientInstanceId: z.string().regex(UUID),
    keyThumbprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .strict();
const recordSchema = z
  .object({
    approvalId: z.string().uuid(),
    scope: scopeSchema,
    surface: surfaceSchema,
    state: z.enum(['approved', 'revoked']),
    approvedAt: z.number().int().positive(),
    approvedBy: z
      .string()
      .refine((id) =>
        isPrincipalRef({ kind: 'human', id, display: 'approver' }),
      )
      .optional(),
    revision: z.number().int().positive(),
  })
  .strict();
type SurfaceRecord = z.infer<typeof recordSchema>;
const tupleSchema = z
  .object({ scope: scopeSchema, surface: surfaceSchema })
  .strict();

export interface NativeSurfaceTuple {
  readonly scope: SelfHostedBrokerNativeScopeV2;
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
}

function tupleKey(value: NativeSurfaceTuple): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        value.scope.stationId,
        value.scope.enrollmentId,
        value.scope.routingGeneration,
        value.surface.kind,
        value.surface.appIdentifier,
        value.surface.channel,
        value.surface.clientInstanceId,
        value.surface.keyThumbprint,
      ]),
    )
    .digest('base64url');
}

/** An authenticated operator route must verify current credentials before minting this context. */
export class NativeSurfaceOperatorAuthority {
  approve(
    operatorPrincipalId: string,
    operation: 'approve' | 'revoke',
    tuple: unknown,
  ): NativeSurfaceApproval {
    if (operatorPrincipalId !== LOCAL_OPERATOR_PRINCIPAL_ID)
      throw new Error('native_surface_operator_required');
    const { scope, surface } = tupleSchema.parse(tuple);
    if (operation !== 'approve' && operation !== 'revoke')
      throw new Error('native_surface_operation_invalid');
    return new NativeSurfaceApproval(
      TOKEN,
      operation,
      { scope, surface },
      operatorPrincipalId,
    );
  }
}

export function approveNativeSurfaceAsManager(
  decision: RelayManagementApproval,
  operation: 'approve' | 'revoke',
  value: unknown,
): NativeSurfaceApproval {
  const tuple = tupleSchema.parse(value);
  if (
    !(decision instanceof RelayManagementApproval) ||
    !decision.isCurrent() ||
    decision.subjectId !== tuple.surface.clientInstanceId
  )
    throw new Error('native_surface_operator_required');
  return new NativeSurfaceApproval(
    TOKEN,
    operation,
    tuple,
    decision.actorPrincipalId,
  );
}

class NativeSurfaceApproval {
  readonly tuple: NativeSurfaceTuple;
  #used = false;
  constructor(
    token: symbol,
    readonly operation: 'approve' | 'revoke',
    tuple: NativeSurfaceTuple,
    readonly actorPrincipalId: string,
  ) {
    if (token !== TOKEN) throw new Error('native_surface_operator_required');
    this.tuple = Object.freeze({
      scope: Object.freeze({ ...tuple.scope }),
      surface: Object.freeze({ ...tuple.surface }),
    });
    Object.freeze(this);
  }
  consume(): void {
    if (this.#used) throw new Error('native_surface_approval_reused');
    this.#used = true;
  }
}

/** Transport admission only; this object grants no Device, account or Project authority. */
export interface ApprovedNativeSurface extends NativeSurfaceTuple {
  readonly approvalId: string;
  readonly revision: number;
  readonly approvedBy: string;
  isCurrent(): boolean;
}

/** Durable operator approvals. Revoked tuples cannot be resurrected by a new invitation. */
export class NativeSurfaceRegistry {
  readonly #db: DatabaseSync;
  #closed = false;
  constructor(
    homeDir: string,
    readonly stationId: string,
    private readonly now = Date.now,
  ) {
    if (!UUID.test(stationId))
      throw new Error('native_surface_station_invalid');
    this.#db = openPrivateSqlite(
      join(homeDir, 'security', 'native-surfaces.sqlite'),
      'NativeSurfaceRegistry',
    );
    try {
      const tables = this.#db
        .prepare(
          "SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      if (tables.length === 0) {
        this.#transaction(() => {
          this.#db.exec(`${TABLE_SQL}; ${META_SQL};`);
          this.#db
            .prepare('INSERT INTO native_surface_owner VALUES(?)')
            .run(stationId);
        });
      } else if (
        tables.length !== 2 ||
        tables[0]?.sql !== META_SQL ||
        tables[1]?.sql !== TABLE_SQL
      ) {
        throw new Error('native_surface_store_invalid');
      }
      const owners = this.#db
        .prepare('SELECT station_id FROM native_surface_owner')
        .all();
      if (owners.length !== 1 || owners[0]?.station_id !== stationId)
        throw new Error('native_surface_station_mismatch');
      if (this.#db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
        throw new Error('native_surface_store_invalid');
      this.#records();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #transaction<T>(operation: () => T): T {
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

  #records(): SurfaceRecord[] {
    if (this.#closed) throw new Error('native_surface_registry_closed');
    const rows = this.#db
      .prepare(
        'SELECT approval_id,surface_key,record FROM native_surfaces LIMIT 17',
      )
      .all();
    if (rows.length > MAX_SURFACES) throw new Error('native_surface_capacity');
    return rows.map((row) => {
      if (typeof row.record !== 'string')
        throw new Error('native_surface_store_invalid');
      const value = recordSchema.parse(JSON.parse(row.record));
      if (
        value.scope.stationId !== this.stationId ||
        value.approvalId !== row.approval_id ||
        tupleKey(value) !== row.surface_key
      )
        throw new Error('native_surface_store_invalid');
      return value;
    });
  }

  approve(context: NativeSurfaceApproval): ApprovedNativeSurface {
    if (
      !(context instanceof NativeSurfaceApproval) ||
      context.operation !== 'approve' ||
      context.tuple.scope.stationId !== this.stationId
    )
      throw new Error('native_surface_operator_required');
    const value = this.#transaction(() => {
      const records = this.#records();
      const key = tupleKey(context.tuple);
      const existing = records.find((entry) => tupleKey(entry) === key);
      if (existing?.state === 'revoked')
        throw new Error('native_surface_revoked');
      if (!existing && records.length >= MAX_SURFACES)
        throw new Error('native_surface_capacity');
      const next =
        existing ??
        recordSchema.parse({
          approvalId: randomUUID(),
          ...context.tuple,
          state: 'approved',
          approvedAt: this.now(),
          approvedBy: context.actorPrincipalId,
          revision: 1,
        });
      context.consume();
      if (!existing)
        this.#db
          .prepare('INSERT INTO native_surfaces VALUES(?,?,?)')
          .run(next.approvalId, key, JSON.stringify(next));
      return next;
    });
    return this.#admission(value);
  }

  revoke(context: NativeSurfaceApproval): void {
    if (
      !(context instanceof NativeSurfaceApproval) ||
      context.operation !== 'revoke' ||
      context.tuple.scope.stationId !== this.stationId
    )
      throw new Error('native_surface_operator_required');
    this.#transaction(() => {
      const existing = this.#records().find(
        (entry) => tupleKey(entry) === tupleKey(context.tuple),
      );
      if (!existing) throw new Error('native_surface_not_found');
      context.consume();
      if (existing.state === 'revoked') return;
      this.#db
        .prepare('UPDATE native_surfaces SET record=? WHERE approval_id=?')
        .run(
          JSON.stringify({
            ...existing,
            state: 'revoked',
            revision: existing.revision + 1,
          }),
          existing.approvalId,
        );
    });
  }

  approvedSurfaces(): readonly ApprovedNativeSurface[] {
    return this.#records()
      .filter((value) => value.state === 'approved')
      .map((value) => this.#admission(value));
  }

  #admission(value: SurfaceRecord): ApprovedNativeSurface {
    const captured = structuredClone(value);
    return Object.freeze({
      approvalId: captured.approvalId,
      revision: captured.revision,
      approvedBy: captured.approvedBy ?? LOCAL_OPERATOR_PRINCIPAL_ID,
      scope: Object.freeze(captured.scope),
      surface: Object.freeze(captured.surface),
      isCurrent: () => {
        if (this.#closed) return false;
        try {
          return this.#records().some(
            (entry) =>
              entry.approvalId === captured.approvalId &&
              entry.revision === captured.revision &&
              entry.state === 'approved' &&
              tupleKey(entry) === tupleKey(captured),
          );
        } catch {
          return false;
        }
      },
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
