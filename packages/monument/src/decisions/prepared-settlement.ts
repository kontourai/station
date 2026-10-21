import { type OwnerIdentity, parseOwnerIdentity } from '../owner.js';
import type {
  PreparedDedupSnapshot,
  PreparedTurnSettlement,
  TurnBoundarySnapshot,
} from '../records.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function owner(value: unknown): value is OwnerIdentity {
  try {
    parseOwnerIdentity(value);
    return true;
  } catch {
    return false;
  }
}

function boundary(value: unknown): value is TurnBoundarySnapshot {
  return (
    record(value) &&
    owner(value.owner) &&
    nonempty(value.createdAt) &&
    nonempty(value.updatedAt) &&
    Object.keys(value).every((field) =>
      ['owner', 'createdAt', 'updatedAt'].includes(field),
    )
  );
}

function dedup(value: unknown): value is PreparedDedupSnapshot {
  return (
    record(value) &&
    owner(value.owner) &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    nonempty(value.updatedAt) &&
    Object.keys(value).every((field) =>
      ['owner', 'createdAt', 'updatedAt'].includes(field),
    )
  );
}

/** Shared storage/decision validation: unknown or partial audits never grant permission. */
export function isPreparedTurnSettlement(
  value: unknown,
): value is PreparedTurnSettlement {
  return (
    record(value) &&
    nonempty(value.id) &&
    nonempty(value.at) &&
    nonempty(value.boundaryId) &&
    (value.disposition === 'cancelled' ||
      value.disposition === 'definitively-refused') &&
    boundary(value.boundary) &&
    (value.dedup === undefined || dedup(value.dedup)) &&
    Object.keys(value).every((field) =>
      ['id', 'at', 'boundaryId', 'disposition', 'boundary', 'dedup'].includes(
        field,
      ),
    )
  );
}

export function sameSettlementOwner(
  a: OwnerIdentity,
  b: OwnerIdentity,
): boolean {
  return (
    a.id === b.id &&
    a.pid === b.pid &&
    a.identityKind === b.identityKind &&
    (a.identityKind !== 'exact' ||
      (b.identityKind === 'exact' && a.birth === b.birth))
  );
}

export function samePreparedSettlement(
  a: unknown,
  b: PreparedTurnSettlement,
): boolean {
  return (
    isPreparedTurnSettlement(a) &&
    isPreparedTurnSettlement(b) &&
    a.id === b.id &&
    a.disposition === b.disposition &&
    a.at === b.at &&
    a.boundaryId === b.boundaryId &&
    sameSettlementOwner(a.boundary.owner, b.boundary.owner) &&
    a.boundary.createdAt === b.boundary.createdAt &&
    a.boundary.updatedAt === b.boundary.updatedAt &&
    (a.dedup === undefined
      ? b.dedup === undefined
      : b.dedup !== undefined &&
        sameSettlementOwner(a.dedup.owner, b.dedup.owner) &&
        a.dedup.createdAt === b.dedup.createdAt &&
        a.dedup.updatedAt === b.dedup.updatedAt)
  );
}
