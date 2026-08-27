/**
 * Record-carried freshness fields (store-contract.md Addendum J.2): optional
 * `expires_at` (ISO-8601) / `ttl_seconds` (positive number). Validated at the
 * mutation boundary so a malformed value never reaches disk. K2 stores and
 * round-trips these fields; deriving `stale`/`superseded` status from them is a
 * Knowledge Kit flow-runner concern, out of scope for the store adapter contract.
 */
import { MissingEvidenceError } from '../../errors.js';

export interface FreshnessInput {
  expires_at?: string | null;
  ttl_seconds?: number | null;
}

export interface FreshnessPatch {
  expires_at?: string;
  ttl_seconds?: number;
}

function validateExpiresAt(value: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MissingEvidenceError(
      `expires_at must be a non-empty ISO-8601 string; got: ${JSON.stringify(value)}`,
    );
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new MissingEvidenceError(
      `expires_at must be a valid ISO-8601 timestamp; got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function validateTtlSeconds(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new MissingEvidenceError(
      `ttl_seconds must be a positive number of seconds; got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Extract + validate freshness fields from a create/update input, returning a patch
 * containing only supplied keys. A key explicitly set to `null`/`""` maps to
 * `undefined` in the patch — the signal to CLEAR it on update. Absent keys are
 * omitted entirely, so an input with no freshness fields yields `{}`.
 */
export function freshnessPatch(input: FreshnessInput): FreshnessPatch {
  const patch: FreshnessPatch = {};
  // When the key is present at all (even as null/"" — the clear signal), the patch
  // gets an explicit own property (possibly `undefined`), so a later
  // `{ ...record, ...patch }` spread overrides — and clears — the prior value. A key
  // absent from `input` leaves `patch` without that own property, so the prior
  // value survives the spread untouched. This distinction is load-bearing.
  if (Object.hasOwn(input, 'expires_at')) {
    const raw = input.expires_at;
    patch.expires_at =
      raw === null || raw === '' || raw === undefined
        ? undefined
        : validateExpiresAt(raw);
  }
  if (Object.hasOwn(input, 'ttl_seconds')) {
    const raw = input.ttl_seconds;
    patch.ttl_seconds =
      raw === null || raw === undefined ? undefined : validateTtlSeconds(raw);
  }
  return patch;
}
