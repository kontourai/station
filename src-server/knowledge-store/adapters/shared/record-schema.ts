/**
 * Record type / status-transition vocabulary (store-contract.md §1.1/§8, Addendum A.2
 * `snapshot`, Addendum C.1 `person`, Addendum B.2 status transitions). Shared by both
 * Station-owned Kit-format adapters so type/status enforcement is identical regardless
 * of which adapter backs a root.
 */
import type {
  KitLink,
  KitRecord,
  KitRecordType,
} from '@kontourai/station-contracts/knowledge-store';
import { KnowledgeStoreCorruptionError } from '../../errors.js';

export const VALID_TYPES: ReadonlySet<KitRecordType> = new Set([
  'raw',
  'compiled',
  'concept',
  'snapshot',
  'person',
]);

/** Status transition table (Addendum B.2): from → allowed targets. */
export const VALID_STATUS_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  active: new Set(['implemented', 'retired']),
  implemented: new Set(['retired']),
  retired: new Set(), // terminal — no further transitions
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isLink(value: unknown): value is KitLink {
  return (
    isRecord(value) &&
    isNonemptyString(value.target_id) &&
    isNonemptyString(value.kind) &&
    (value.label === undefined || typeof value.label === 'string')
  );
}

/** Strict runtime validation for authoritative record bytes read from disk. */
export function assertKitRecord(
  value: unknown,
  body: string,
  source: string,
): KitRecord {
  const invalid = (detail: string): never => {
    throw new KnowledgeStoreCorruptionError(`${source}: ${detail}`);
  };
  if (!isRecord(value)) invalid('frontmatter must be an object');
  const record = value as Record<string, unknown>;
  if (!isNonemptyString(record.id)) invalid('id is required');
  // Reads are forward-compatible with a newer Kit vocabulary. Station only
  // creates the current VALID_TYPES, but an external conforming writer may add
  // a future nonempty type and Station must preserve it on an unrelated update.
  if (!isNonemptyString(record.type)) invalid('type is required');
  if (!isNonemptyString(record.title)) invalid('title is required');
  if (!isNonemptyString(record.category)) {
    invalid('category is required');
  }
  if (
    !isRecord(record.provenance) ||
    !isNonemptyString(record.provenance.agent) ||
    (record.provenance.source_ids !== undefined &&
      !isStringArray(record.provenance.source_ids)) ||
    (record.provenance.session_id !== undefined &&
      typeof record.provenance.session_id !== 'string') ||
    (record.provenance.note !== undefined &&
      typeof record.provenance.note !== 'string')
  ) {
    invalid('provenance.agent is required');
  }
  if (
    !isNonemptyString(record.created_at) ||
    !Number.isFinite(Date.parse(record.created_at))
  ) {
    invalid('created_at must be an ISO timestamp');
  }
  if (
    !isNonemptyString(record.updated_at) ||
    !Number.isFinite(Date.parse(record.updated_at))
  ) {
    invalid('updated_at must be an ISO timestamp');
  }
  if (record.tags !== undefined && !isStringArray(record.tags)) {
    invalid('tags must be strings');
  }
  if (record.aliases !== undefined && !isStringArray(record.aliases)) {
    invalid('aliases must be strings');
  }
  if (
    record.links !== undefined &&
    (!Array.isArray(record.links) || !record.links.every(isLink))
  ) {
    invalid('links have an invalid shape');
  }
  if (
    record.status !== undefined &&
    !['active', 'implemented', 'retired'].includes(String(record.status))
  ) {
    invalid('invalid lifecycle status');
  }
  if (
    record.mutation_log !== undefined &&
    (!Array.isArray(record.mutation_log) ||
      record.mutation_log.some(
        (entry) =>
          !isRecord(entry) ||
          !isNonemptyString(entry.op) ||
          !isNonemptyString(entry.agent) ||
          !isNonemptyString(entry.at) ||
          !Number.isFinite(Date.parse(entry.at)) ||
          (entry.note !== undefined && typeof entry.note !== 'string') ||
          (entry.evidence !== undefined && !isRecord(entry.evidence)),
      ))
  ) {
    invalid('mutation_log entries have an invalid shape');
  }
  if (
    record.expires_at !== undefined &&
    !Number.isFinite(Date.parse(String(record.expires_at)))
  ) {
    invalid('expires_at must be an ISO timestamp');
  }
  if (
    record.ttl_seconds !== undefined &&
    (!Number.isFinite(record.ttl_seconds) || Number(record.ttl_seconds) < 0)
  ) {
    invalid('ttl_seconds must be non-negative');
  }
  return { ...record, body } as unknown as KitRecord;
}
